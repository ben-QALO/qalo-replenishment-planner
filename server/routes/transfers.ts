import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, today, DATA_DIR } from '../db/connection.ts';
import { latestSnapshot } from '../assemble.ts';
import { toCsv } from '../export/csv.ts';

interface SubmitLine { sku: string; qty: number; }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Readable default name, e.g. "Transfer · Jul 14". Editable afterward. */
function defaultTransferName(dateIso: string): string {
  const [, m, d] = dateIso.slice(0, 10).split('-');
  return `Transfer · ${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

export function transferRoutes(app: FastifyInstance): void {
  app.get('/api/transfers', () => {
    const db = getDb();
    // Active worksheet (proposed → reviewed) plus recently closed (exported / cancelled).
    // Attach the QALO SKU (team-facing) alongside the Amazon SKU the transfer is keyed by.
    const rows = db.prepare(`SELECT t.*, s.title, COALESCE(m.qalo_sku, t.sku) AS qalo_sku
      FROM transfers t LEFT JOIN skus s ON s.sku = t.sku LEFT JOIN sku_map m ON m.amazon_sku = t.sku
      WHERE t.status IN ('proposed','reviewed','draft')
         OR t.reconciled_at > date('now','-30 days')
         OR (t.status='cancelled' AND t.created_at > date('now','-14 days'))
      ORDER BY
        CASE t.status WHEN 'proposed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
        t.reconciled_at DESC, t.reviewed_at DESC, t.created_at DESC, t.id DESC`).all();
    return { transfers: rows };
  });

  // Download every transfer as CSV (all stages, one row per SKU line).
  app.get('/api/transfers/export.csv', (_req, reply) => {
    const db = getDb();
    const rows = db.prepare(`SELECT t.*, s.title, COALESCE(m.qalo_sku, t.sku) AS qalo_sku
      FROM transfers t LEFT JOIN skus s ON s.sku = t.sku LEFT JOIN sku_map m ON m.amazon_sku = t.sku
      ORDER BY t.created_at DESC, t.id DESC`).all() as any[];
    const stageLabel: Record<string, string> = {
      proposed: 'proposed', reviewed: 'reviewed', reconciled: 'exported', cancelled: 'cancelled', submitted: 'exported', draft: 'draft',
    };
    const day = (s: string | null) => (s ?? '').slice(0, 10);
    const out: unknown[][] = [[
      'QALO SKU', 'Amazon SKU', 'Shipment', 'Batch ID', 'Product', 'Quantity', 'Originally Requested',
      'Status', 'Created', 'Reviewed', 'Exported/Closed', 'Note',
    ]];
    for (const t of rows) {
      out.push([
        t.qalo_sku, t.sku, t.batch_name ?? '', t.batch_id ?? '', t.title ?? '', t.qty, t.requested_qty ?? '',
        stageLabel[t.status] ?? t.status, day(t.created_at), day(t.reviewed_at), day(t.reconciled_at), t.review_note ?? '',
      ]);
    }
    const csv = toCsv(out);
    const filename = `transfers-${today()}.csv`;
    writeFileSync(join(DATA_DIR, 'exports', filename), csv);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });

  /**
   * STEP 1 — Amazon team's initial request. Creates one transfer per line as 'proposed'.
   * Proposed transfers do NOT touch warehouse stock and are NOT counted as in transit —
   * that only happens once they're sent to the warehouse (see /send-bulk). requested_qty
   * records the original ask so later adjustments are auditable.
   */
  app.post('/api/transfers/propose', (req, reply) => {
    const b = (req.body ?? {}) as { lines?: SubmitLine[] };
    const lines = (b.lines ?? [])
      .map(l => ({ sku: String(l.sku), qty: Math.round(Number(l.qty)) }))
      .filter(l => l.sku && Number.isFinite(l.qty) && l.qty > 0);
    if (lines.length === 0) return reply.code(400).send({ error: 'no lines with a positive quantity' });

    const b2 = (req.body ?? {}) as { name?: string };
    const db = getDb();
    const now = nowIso();
    const batchId = `T-${now.replace(/[-:T.Z]/g, '').slice(0, 14)}`;
    const batchName = b2.name?.trim() || defaultTransferName(now);
    const snapshot = latestSnapshot(db);

    const run = db.transaction(() => {
      const ins = db.prepare(`INSERT INTO transfers (sku, qty, requested_qty, status, created_at, batch_id, batch_name, snapshot_id)
        VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?)`);
      for (const l of lines) ins.run(l.sku, l.qty, l.qty, now, batchId, batchName, snapshot?.id ?? null);
    });
    run();
    bumpRevision();
    return {
      ok: true, batch_id: batchId, batch_name: batchName,
      line_count: lines.length, total_units: lines.reduce((s, l) => s + l.qty, 0),
    };
  });

  // STEP 2 — inventory team finishes its review (quantities already adjusted via PATCH).
  // proposed → reviewed. Optional shared note.
  app.post('/api/transfers/review-bulk', (req, reply) => {
    const b = (req.body ?? {}) as { ids?: number[]; note?: string };
    const ids = b.ids ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids[] required' });
    const db = getDb();
    const now = nowIso();
    const stmt = db.prepare(
      "UPDATE transfers SET status='reviewed', reviewed_at=?, review_note=COALESCE(?, review_note) WHERE id=? AND status IN ('proposed','reviewed')");
    let n = 0;
    const run = db.transaction(() => { for (const id of ids) n += stmt.run(now, b.note || null, Number(id)).changes; });
    run();
    if (n > 0) bumpRevision();
    return { ok: true, reviewed: n };
  });

  // Send a reviewed request back to the inventory team (reviewed → proposed).
  app.post('/api/transfers/reopen-bulk', (req, reply) => {
    const ids = ((req.body ?? {}) as { ids?: number[] }).ids ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids[] required' });
    const db = getDb();
    const stmt = db.prepare("UPDATE transfers SET status='proposed', reviewed_at=NULL WHERE id=? AND status='reviewed'");
    let n = 0;
    const run = db.transaction(() => { for (const id of ids) n += stmt.run(Number(id)).changes; });
    run();
    if (n > 0) bumpRevision();
    return { ok: true, reopened: n };
  });

  /**
   * STEP 3 — Amazon team exports the finalized request to hand to the warehouse (and to
   * create the real shipment in Amazon). This is a worksheet hand-off: it downloads the
   * request CSV and closes the batch. It does NOT touch warehouse stock or count anything
   * as in transit — NetSuite + Amazon are the source of truth and reflect the real shipment
   * on your next upload. Closed batches use status='reconciled' (i.e. "done for this cycle").
   */
  app.post('/api/transfers/export-bulk', (req, reply) => {
    const ids = ((req.body ?? {}) as { ids?: number[] }).ids ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids[] required' });

    const db = getDb();
    const now = nowIso();
    const metaBySku = new Map((db.prepare(`SELECT s.sku, s.title, COALESCE(m.qalo_sku, s.sku) AS qalo_sku
      FROM skus s LEFT JOIN sku_map m ON m.amazon_sku = s.sku`).all() as any[]).map(r => [r.sku, r]));

    const exported: { sku: string; qalo_sku: string; qty: number; title: string }[] = [];
    const run = db.transaction(() => {
      const rowStmt = db.prepare("SELECT id, sku, qty FROM transfers WHERE id=? AND status='reviewed'");
      const upd = db.prepare("UPDATE transfers SET status='reconciled', reconciled_at=? WHERE id=?");
      for (const id of ids) {
        const row = rowStmt.get(Number(id)) as { id: number; sku: string; qty: number } | undefined;
        if (!row) continue;
        upd.run(now, row.id);
        const meta = metaBySku.get(row.sku);
        exported.push({ sku: row.sku, qalo_sku: meta?.qalo_sku ?? row.sku, qty: row.qty, title: meta?.title ?? '' });
      }
    });
    run();
    if (exported.length === 0) return reply.code(409).send({ error: 'nothing to export — select reviewed requests' });
    bumpRevision();

    // The warehouse team picks by QALO SKU; the Amazon shipment plan needs the Amazon (Merchant) SKU.
    const csv = toCsv([['QALO SKU', 'Amazon SKU', 'Quantity'], ...exported.map(l => [l.qalo_sku, l.sku, l.qty])]);
    const detailed = toCsv([['QALO SKU', 'Amazon SKU', 'Product Name', 'Quantity'], ...exported.map(l => [l.qalo_sku, l.sku, l.title, l.qty])]);
    const filename = `transfer-request-${today()}.csv`;
    writeFileSync(join(DATA_DIR, 'exports', filename), detailed);

    return { ok: true, filename, csv, line_count: exported.length, total_units: exported.reduce((s, l) => s + l.qty, 0) };
  });

  // Cancel a proposed/reviewed request (drops it from the worksheet). Nothing to undo in the
  // warehouse — the tool never deducted anything.
  app.post('/api/transfers/cancel-bulk', (req, reply) => {
    const ids = ((req.body ?? {}) as { ids?: number[] }).ids ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids[] required' });
    const db = getDb();
    const stmt = db.prepare("UPDATE transfers SET status = 'cancelled' WHERE id = ? AND status IN ('proposed','reviewed')");
    let n = 0;
    const run = db.transaction(() => { for (const id of ids) n += stmt.run(Number(id)).changes; });
    run();
    if (n > 0) bumpRevision();
    return { ok: true, cancelled: n };
  });

  // Quantities are editable while a request is still in review (proposed or reviewed);
  // requested_qty is never touched, preserving the original ask for the audit trail.
  app.patch('/api/transfers/:id', (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as { qty?: number; notes?: string; review_note?: string };
    const db = getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.qty !== undefined) {
      const q = Math.round(Number(b.qty));
      if (!Number.isFinite(q) || q <= 0) return reply.code(400).send({ error: 'qty must be positive' });
      sets.push('qty = ?'); vals.push(q);
    }
    if ('notes' in b) { sets.push('notes = ?'); vals.push(b.notes || null); }
    if ('review_note' in b) { sets.push('review_note = ?'); vals.push(b.review_note || null); }
    if (sets.length === 0) return reply.code(400).send({ error: 'nothing to update' });
    vals.push(id);
    const res = db.prepare(`UPDATE transfers SET ${sets.join(', ')} WHERE id = ? AND status IN ('proposed','reviewed')`).run(...vals);
    if (res.changes === 0) return reply.code(404).send({ error: 'open transfer not found' });
    bumpRevision();
    return { ok: true };
  });

  // Rename a whole shipment (batch). Applies to every line sharing the batch_id.
  app.post('/api/transfers/batch/rename', (req, reply) => {
    const b = (req.body ?? {}) as { batch_id?: string; name?: string };
    const name = (b.name ?? '').trim();
    if (!b.batch_id || !name) return reply.code(400).send({ error: 'batch_id and name required' });
    const res = getDb().prepare('UPDATE transfers SET batch_name = ? WHERE batch_id = ?').run(name, b.batch_id);
    if (res.changes === 0) return reply.code(404).send({ error: 'batch not found' });
    bumpRevision();
    return { ok: true, updated: res.changes };
  });
}
