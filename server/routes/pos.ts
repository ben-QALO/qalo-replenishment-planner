import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision, nowIso } from '../db/connection.ts';

const STATUSES = ['draft', 'ordered', 'in_transit', 'received', 'cancelled'];

export function poRoutes(app: FastifyInstance): void {
  app.get('/api/pos', () => {
    const db = getDb();
    const pos = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all() as any[];
    const lines = db.prepare('SELECT * FROM po_lines').all() as any[];
    for (const po of pos) po.lines = lines.filter(l => l.po_id === po.id);
    return { pos };
  });

  app.post('/api/pos', (req, reply) => {
    const b = (req.body ?? {}) as any;
    const status = STATUSES.includes(b.status) ? b.status : 'draft';
    const db = getDb();
    const now = nowIso();
    let id = 0;
    const run = db.transaction(() => {
      const res = db.prepare(`INSERT INTO purchase_orders (po_number, supplier, status, ordered_date, expected_arrival, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(b.po_number || null, b.supplier || null, status, b.ordered_date || null, b.expected_arrival || null, b.notes || null, now, now);
      id = Number(res.lastInsertRowid);
      const stmt = db.prepare('INSERT INTO po_lines (po_id, sku, qty_ordered, qty_received) VALUES (?, ?, ?, 0)');
      for (const l of b.lines ?? []) {
        const qty = Math.round(Number(l.qty_ordered));
        if (l.sku && Number.isFinite(qty) && qty > 0) stmt.run(id, l.sku, qty);
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

  app.patch('/api/pos/:id', (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as any;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'PO not found' });
    const run = db.transaction(() => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const f of ['po_number', 'supplier', 'ordered_date', 'expected_arrival', 'received_date', 'notes']) {
        if (f in b) { sets.push(`${f} = ?`); vals.push(b[f] || null); }
      }
      if ('status' in b && STATUSES.includes(b.status)) { sets.push('status = ?'); vals.push(b.status); }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        vals.push(nowIso(), id);
        db.prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      if (Array.isArray(b.lines)) {
        db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(id);
        const stmt = db.prepare('INSERT INTO po_lines (po_id, sku, qty_ordered, qty_received) VALUES (?, ?, ?, ?)');
        for (const l of b.lines) {
          const qty = Math.round(Number(l.qty_ordered));
          if (l.sku && Number.isFinite(qty) && qty > 0) stmt.run(id, l.sku, qty, Math.round(Number(l.qty_received) || 0));
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
      db.prepare(`UPDATE purchase_orders SET status = 'received', received_date = ?, updated_at = ? WHERE id = ?`)
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
