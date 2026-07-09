import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision, nowIso } from '../db/connection.ts';

export function warehouseRoutes(app: FastifyInstance): void {
  app.get('/api/warehouse', () => {
    const db = getDb();
    const rows = db.prepare(`SELECT w.sku, w.qty_on_hand, w.updated_at, w.updated_via, s.title, s.classification
      FROM warehouse_inventory w LEFT JOIN skus s ON s.sku = w.sku ORDER BY w.sku`).all();
    return { rows };
  });

  app.put('/api/warehouse/:sku', (req, reply) => {
    const { sku } = req.params as { sku: string };
    const body = (req.body ?? {}) as { qty?: number };
    const qty = Number(body.qty);
    if (!Number.isFinite(qty) || qty < 0) return reply.code(400).send({ error: 'qty must be a non-negative number' });
    const db = getDb();
    db.prepare(`INSERT INTO warehouse_inventory (sku, qty_on_hand, updated_at, updated_via)
      VALUES (?, ?, ?, 'manual')
      ON CONFLICT(sku) DO UPDATE SET qty_on_hand = excluded.qty_on_hand, updated_at = excluded.updated_at, updated_via = 'manual'`)
      .run(sku, Math.round(qty), nowIso());
    bumpRevision();
    return { ok: true };
  });

  app.post('/api/warehouse/bulk', (req, reply) => {
    const body = (req.body ?? {}) as { rows?: { sku: string; qty: number }[]; via?: string };
    if (!Array.isArray(body.rows) || body.rows.length === 0) return reply.code(400).send({ error: 'rows[] required' });
    const via = body.via === 'shipment' || body.via === 'po_receipt' || body.via === 'csv' ? body.via : 'manual';
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO warehouse_inventory (sku, qty_on_hand, updated_at, updated_via)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET qty_on_hand = excluded.qty_on_hand, updated_at = excluded.updated_at, updated_via = excluded.updated_via`);
    const now = nowIso();
    let ok = 0;
    const run = db.transaction(() => {
      for (const r of body.rows!) {
        const qty = Number(r.qty);
        if (!r.sku || !Number.isFinite(qty) || qty < 0) continue;
        stmt.run(r.sku, Math.round(qty), now, via);
        ok++;
      }
    });
    run();
    if (ok > 0) bumpRevision();
    return { ok: true, updated: ok };
  });

  app.delete('/api/warehouse/:sku', (req) => {
    const { sku } = req.params as { sku: string };
    getDb().prepare('DELETE FROM warehouse_inventory WHERE sku = ?').run(sku);
    bumpRevision();
    return { ok: true };
  });
}
