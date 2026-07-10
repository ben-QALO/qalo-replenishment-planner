import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, today, DATA_DIR } from '../db/connection.ts';
import { currentRecommendations, latestSnapshot } from '../assemble.ts';
import { toCsv } from '../export/csv.ts';

interface SubmitLine { sku: string; qty: number; }

export function transferRoutes(app: FastifyInstance): void {
  app.get('/api/transfers', () => {
    const db = getDb();
    const rows = db.prepare(`SELECT t.*, s.title FROM transfers t LEFT JOIN skus s ON s.sku = t.sku
      WHERE t.status IN ('submitted','draft') OR t.reconciled_at > date('now','-30 days')
      ORDER BY (t.status='submitted') DESC, t.submitted_at DESC, t.id DESC`).all();
    return { transfers: rows };
  });

  /**
   * Submit a transfer request: creates one transfer per line (status 'submitted'),
   * which immediately nets down usable warehouse, and returns the request CSV for the
   * inventory team. This replaces the old "export + deduct warehouse" flow.
   */
  app.post('/api/transfers/submit', (req, reply) => {
    const b = (req.body ?? {}) as { lines?: SubmitLine[] };
    const lines = (b.lines ?? [])
      .map(l => ({ sku: String(l.sku), qty: Math.round(Number(l.qty)) }))
      .filter(l => l.sku && Number.isFinite(l.qty) && l.qty > 0);
    if (lines.length === 0) return reply.code(400).send({ error: 'no lines with a positive quantity' });

    const db = getDb();
    const now = nowIso();
    const batchId = `T-${now.replace(/[-:T.Z]/g, '').slice(0, 14)}`;
    const snapshot = latestSnapshot(db);
    const output = currentRecommendations(db, today());
    const byResult = new Map((output?.results ?? []).map(r => [r.sku, r]));
    const titleOf = new Map((output?.results ?? []).map(r => [r.sku, r.title]));

    const run = db.transaction(() => {
      const ins = db.prepare(`INSERT INTO transfers (sku, qty, status, created_at, submitted_at, batch_id, snapshot_id, baseline_fba)
        VALUES (?, ?, 'submitted', ?, ?, ?, ?, ?)`);
      for (const l of lines) {
        const r = byResult.get(l.sku);
        // Amazon-side units for this SKU right now; later arrivals above this are "landed".
        const baseline = r ? r.fba_available + r.fba_inbound : 0;
        ins.run(l.sku, l.qty, now, now, batchId, snapshot?.id ?? null, baseline);
      }
    });
    run();
    bumpRevision();

    const csv = toCsv([['Merchant SKU', 'Quantity'], ...lines.map(l => [l.sku, l.qty])]);
    const detailed = toCsv([
      ['Merchant SKU', 'Product Name', 'Quantity'],
      ...lines.map(l => [l.sku, titleOf.get(l.sku) ?? '', l.qty]),
    ]);
    const filename = `transfer-request-${today()}-${batchId}.csv`;
    writeFileSync(join(DATA_DIR, 'exports', filename), detailed);

    return {
      ok: true, batch_id: batchId, filename, csv,
      line_count: lines.length, total_units: lines.reduce((s, l) => s + l.qty, 0),
    };
  });

  // Reconcile (next session): the Amazon team confirms the shipment was created and is
  // inbound in Amazon. Closes the transfer; the tool now relies on Amazon's numbers.
  app.post('/api/transfers/:id/reconcile', (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const t = db.prepare("SELECT id FROM transfers WHERE id = ? AND status = 'submitted'").get(id);
    if (!t) return reply.code(404).send({ error: 'open transfer not found' });
    db.prepare("UPDATE transfers SET status = 'reconciled', reconciled_at = ? WHERE id = ?").run(nowIso(), id);
    bumpRevision();
    return { ok: true };
  });

  app.post('/api/transfers/reconcile-bulk', (req, reply) => {
    const ids = ((req.body ?? {}) as { ids?: number[] }).ids ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids[] required' });
    const db = getDb();
    const now = nowIso();
    const stmt = db.prepare("UPDATE transfers SET status = 'reconciled', reconciled_at = ? WHERE id = ? AND status = 'submitted'");
    let n = 0;
    const run = db.transaction(() => { for (const id of ids) n += stmt.run(now, Number(id)).changes; });
    run();
    if (n > 0) bumpRevision();
    return { ok: true, reconciled: n };
  });

  app.patch('/api/transfers/:id', (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as { qty?: number; notes?: string };
    const db = getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.qty !== undefined) {
      const q = Math.round(Number(b.qty));
      if (!Number.isFinite(q) || q <= 0) return reply.code(400).send({ error: 'qty must be positive' });
      sets.push('qty = ?'); vals.push(q);
    }
    if ('notes' in b) { sets.push('notes = ?'); vals.push(b.notes || null); }
    if (sets.length === 0) return reply.code(400).send({ error: 'nothing to update' });
    vals.push(id);
    const res = db.prepare(`UPDATE transfers SET ${sets.join(', ')} WHERE id = ? AND status = 'submitted'`).run(...vals);
    if (res.changes === 0) return reply.code(404).send({ error: 'open transfer not found' });
    bumpRevision();
    return { ok: true };
  });

  app.post('/api/transfers/:id/cancel', (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const res = db.prepare("UPDATE transfers SET status = 'cancelled' WHERE id = ? AND status = 'submitted'").run(id);
    if (res.changes === 0) return reply.code(404).send({ error: 'open transfer not found' });
    bumpRevision();
    return { ok: true };
  });
}
