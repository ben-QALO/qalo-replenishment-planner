import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, today, DATA_DIR } from '../db/connection.ts';
import { toCsv } from '../export/csv.ts';

const STATUSES = ['draft', 'ordered', 'in_transit', 'received', 'cancelled'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Readable default name, e.g. "China PO · Jul 14". Editable afterward. */
function defaultPoName(dateIso: string): string {
  const [, m, d] = dateIso.slice(0, 10).split('-');
  return `China PO · ${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

export function poRoutes(app: FastifyInstance): void {
  app.get('/api/pos', () => {
    const db = getDb();
    const pos = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all() as any[];
    const lines = db.prepare('SELECT * FROM po_lines').all() as any[];
    for (const po of pos) po.lines = lines.filter(l => l.po_id === po.id);
    return { pos };
  });

  // Download every PO as CSV (one row per SKU line; PO header repeated on each line).
  app.get('/api/pos/export.csv', (_req, reply) => {
    const db = getDb();
    const pos = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all() as any[];
    const lines = db.prepare('SELECT * FROM po_lines').all() as any[];
    const out: unknown[][] = [[
      'PO Name', 'PO Number', 'Supplier', 'Status', 'Review State',
      'Ordered Date', 'Expected Arrival', 'Received Date',
      'SKU', 'Qty Ordered', 'Qty Received', 'Outstanding',
    ]];
    for (const po of pos) {
      const head = [po.name ?? '', po.po_number ?? '', po.supplier ?? '', po.status, po.review_state ?? '',
        po.ordered_date ?? '', po.expected_arrival ?? '', po.received_date ?? ''];
      const pol = lines.filter(l => l.po_id === po.id);
      if (pol.length === 0) { out.push([...head, '', '', '', '']); continue; }
      for (const l of pol) out.push([...head, l.sku, l.qty_ordered, l.qty_received, l.qty_ordered - l.qty_received]);
    }
    const csv = toCsv(out);
    const filename = `purchase-orders-${today()}.csv`;
    writeFileSync(join(DATA_DIR, 'exports', filename), csv);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });

  /**
   * Create a PO "for review" — the China-side mirror of a transfer proposal. Lands as
   * status='draft' + review_state='proposed', touching no pipeline math until it's placed.
   * qty_ordered and requested_qty both start at the ask so adjustments are auditable.
   */
  app.post('/api/pos/propose', (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; supplier?: string; lines?: { sku: string; qty: number }[] };
    const lines = (b.lines ?? [])
      .map(l => ({ sku: String(l.sku), qty: Math.round(Number(l.qty)) }))
      .filter(l => l.sku && Number.isFinite(l.qty) && l.qty > 0);
    if (lines.length === 0) return reply.code(400).send({ error: 'no lines with a positive quantity' });

    const db = getDb();
    const now = nowIso();
    let id = 0;
    const run = db.transaction(() => {
      const res = db.prepare(`INSERT INTO purchase_orders (name, supplier, status, review_state, notes, created_at, updated_at)
        VALUES (?, ?, 'draft', 'proposed', ?, ?, ?)`)
        .run(b.name?.trim() || defaultPoName(now), b.supplier || null, null, now, now);
      id = Number(res.lastInsertRowid);
      const stmt = db.prepare('INSERT INTO po_lines (po_id, sku, qty_ordered, requested_qty, qty_received) VALUES (?, ?, ?, ?, 0)');
      for (const l of lines) stmt.run(id, l.sku, l.qty, l.qty);
    });
    run();
    bumpRevision();
    return { ok: true, id, line_count: lines.length, total_units: lines.reduce((s, l) => s + l.qty, 0) };
  });

  app.post('/api/pos', (req, reply) => {
    const b = (req.body ?? {}) as any;
    const status = STATUSES.includes(b.status) ? b.status : 'draft';
    const db = getDb();
    const now = nowIso();
    let id = 0;
    const run = db.transaction(() => {
      const res = db.prepare(`INSERT INTO purchase_orders (name, po_number, supplier, status, ordered_date, expected_arrival, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(b.name?.trim() || defaultPoName(now), b.po_number || null, b.supplier || null, status, b.ordered_date || null, b.expected_arrival || null, b.notes || null, now, now);
      id = Number(res.lastInsertRowid);
      const stmt = db.prepare('INSERT INTO po_lines (po_id, sku, qty_ordered, requested_qty, qty_received) VALUES (?, ?, ?, ?, 0)');
      for (const l of b.lines ?? []) {
        const qty = Math.round(Number(l.qty_ordered));
        if (l.sku && Number.isFinite(qty) && qty > 0) stmt.run(id, l.sku, qty, qty);
      }
    });
    try {
      run();
    } catch (err: any) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
    bumpRevision();
    return { ok: true, id };
  });

  // Review-flow transitions (mirror transfers): proposed → reviewed → ordered, with reopen.
  app.post('/api/pos/:id/review', (req, reply) => {
    const id = Number((req.params as any).id);
    const note = ((req.body ?? {}) as { note?: string }).note;
    const db = getDb();
    const sets = note ? 'review_state = \'reviewed\', notes = COALESCE(?, notes), updated_at = ?' : 'review_state = \'reviewed\', updated_at = ?';
    const args = note ? [note, nowIso(), id] : [nowIso(), id];
    const res = db.prepare(`UPDATE purchase_orders SET ${sets} WHERE id = ? AND review_state IN ('proposed','reviewed')`).run(...args);
    if (res.changes === 0) return reply.code(404).send({ error: 'PO not in review' });
    bumpRevision();
    return { ok: true };
  });

  app.post('/api/pos/:id/reopen', (req, reply) => {
    const id = Number((req.params as any).id);
    const res = getDb().prepare("UPDATE purchase_orders SET review_state = 'proposed', updated_at = ? WHERE id = ? AND review_state = 'reviewed'").run(nowIso(), id);
    if (res.changes === 0) return reply.code(404).send({ error: 'PO not reviewed' });
    bumpRevision();
    return { ok: true };
  });

  // Place the order: reviewed (or proposed) → ordered. Clears review_state, stamps the date.
  app.post('/api/pos/:id/place-order', (req, reply) => {
    const id = Number((req.params as any).id);
    const res = getDb().prepare(`UPDATE purchase_orders SET status = 'ordered', review_state = NULL,
      ordered_date = COALESCE(ordered_date, ?), updated_at = ? WHERE id = ? AND review_state IN ('proposed','reviewed')`)
      .run(today(), nowIso(), id);
    if (res.changes === 0) return reply.code(404).send({ error: 'PO not in review' });
    bumpRevision();
    return { ok: true };
  });

  // Edit a single line's quantity while the PO is still in review — preserves requested_qty.
  app.patch('/api/pos/:id/line', (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as { sku?: string; qty?: number };
    const qty = Math.round(Number(b.qty));
    if (!b.sku || !Number.isFinite(qty) || qty <= 0) return reply.code(400).send({ error: 'sku and positive qty required' });
    const db = getDb();
    const po = db.prepare('SELECT review_state FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po || !['proposed', 'reviewed'].includes(po.review_state)) return reply.code(409).send({ error: 'PO is not in review' });
    const res = db.prepare('UPDATE po_lines SET qty_ordered = ? WHERE po_id = ? AND sku = ?').run(qty, id, b.sku);
    if (res.changes === 0) return reply.code(404).send({ error: 'line not found' });
    bumpRevision();
    return { ok: true };
  });

  app.patch('/api/pos/:id', (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as any;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'PO not found' });
    const run = db.transaction(() => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const f of ['name', 'po_number', 'supplier', 'ordered_date', 'expected_arrival', 'received_date', 'notes']) {
        if (f in b) { sets.push(`${f} = ?`); vals.push(b[f] || null); }
      }
      if ('status' in b && STATUSES.includes(b.status)) {
        sets.push('status = ?'); vals.push(b.status);
        // Any move out of the draft/review stage ends the review — keep (status, review_state) consistent.
        if (b.status !== 'draft') sets.push('review_state = NULL');
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        vals.push(nowIso(), id);
        db.prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      if (Array.isArray(b.lines)) {
        // Preserve each line's original ask (requested_qty) across a full-line replace so the
        // audit trail survives, even when the caller doesn't echo requested_qty back.
        const prevAsk = new Map<string, number>(
          (db.prepare('SELECT sku, requested_qty FROM po_lines WHERE po_id = ?').all(id) as any[])
            .map(r => [r.sku, r.requested_qty]));
        db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(id);
        const stmt = db.prepare('INSERT INTO po_lines (po_id, sku, qty_ordered, requested_qty, qty_received) VALUES (?, ?, ?, ?, ?)');
        for (const l of b.lines) {
          const qty = Math.round(Number(l.qty_ordered));
          if (!l.sku || !Number.isFinite(qty) || qty <= 0) continue;
          const asked = l.requested_qty != null ? Math.round(Number(l.requested_qty)) : (prevAsk.get(l.sku) ?? qty);
          stmt.run(id, l.sku, qty, asked, Math.round(Number(l.qty_received) || 0));
        }
      }
    });
    run();
    bumpRevision();
    return { ok: true };
  });

  // Receive flow: record received quantities, optionally add them to warehouse on-hand.
  app.post('/api/pos/:id/receive', (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as { lines?: { sku: string; qty_received: number }[]; add_to_warehouse?: boolean };
    const db = getDb();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return reply.code(404).send({ error: 'PO not found' });
    const now = nowIso();
    const run = db.transaction(() => {
      const upd = db.prepare('UPDATE po_lines SET qty_received = ? WHERE po_id = ? AND sku = ?');
      const wh = db.prepare(`INSERT INTO warehouse_inventory (sku, qty_on_hand, updated_at, updated_via)
        VALUES (?, ?, ?, 'po_receipt')
        ON CONFLICT(sku) DO UPDATE SET qty_on_hand = warehouse_inventory.qty_on_hand + excluded.qty_on_hand, updated_at = excluded.updated_at, updated_via = 'po_receipt'`);
      for (const l of b.lines ?? []) {
        const qty = Math.round(Number(l.qty_received));
        if (!l.sku || !Number.isFinite(qty) || qty < 0) continue;
        upd.run(qty, id, l.sku);
        if (b.add_to_warehouse) wh.run(l.sku, qty, now);
      }
      db.prepare(`UPDATE purchase_orders SET status = 'received', review_state = NULL, received_date = ?, updated_at = ? WHERE id = ?`)
        .run(now.slice(0, 10), now, id);
    });
    run();
    bumpRevision();
    return { ok: true };
  });

  app.delete('/api/pos/:id', (req) => {
    const id = Number((req.params as any).id);
    getDb().prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
    bumpRevision();
    return { ok: true };
  });
}
