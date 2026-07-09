import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision, nowIso, today } from '../db/connection.ts';
import { currentRecommendations } from '../assemble.ts';

const PATCHABLE = [
  'classification', 'case_pack', 'moq', 'order_multiple',
  'velocity_override', 'growth_multiplier', 'template_override_id', 'notes',
] as const;

const CLASSIFICATIONS = ['unclassified', 'replenishable', 'watch', 'discontinued', 'ignore'];

function applyPatch(sku: string, patch: Record<string, unknown>): boolean {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const field of PATCHABLE) {
    if (!(field in patch)) continue;
    let v = patch[field];
    if (field === 'classification' && !CLASSIFICATIONS.includes(String(v))) continue;
    if (v === '' || v === undefined) v = null;
    sets.push(`${field} = ?`);
    values.push(v);
  }
  if ('param_overrides' in patch) {
    sets.push('param_overrides = ?');
    const po = patch.param_overrides;
    values.push(po && Object.keys(po as object).length > 0 ? JSON.stringify(po) : null);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  values.push(nowIso(), sku);
  const res = db.prepare(`UPDATE skus SET ${sets.join(', ')} WHERE sku = ?`).run(...values);
  return res.changes > 0;
}

export function skuRoutes(app: FastifyInstance): void {
  // Full computed results — the All SKUs table and the dashboard queues read this.
  app.get('/api/skus', () => {
    const output = currentRecommendations(getDb(), today());
    if (!output) return { results: [], summary: null, snapshotDate: null };
    // Attach editable settings so the table can render current values.
    const db = getDb();
    const settingsRows = db.prepare('SELECT sku, classification, case_pack, moq, order_multiple, velocity_override, growth_multiplier, template_override_id, param_overrides, notes FROM skus').all() as any[];
    const settings: Record<string, any> = {};
    for (const r of settingsRows) {
      settings[r.sku] = { ...r, param_overrides: r.param_overrides ? JSON.parse(r.param_overrides) : null };
    }
    return { ...output, settings };
  });

  app.get('/api/skus/:sku', (req) => {
    const { sku } = req.params as { sku: string };
    const db = getDb();
    const output = currentRecommendations(db, today());
    const result = output?.results.find(r => r.sku === sku) ?? null;
    const row = db.prepare('SELECT * FROM skus WHERE sku = ?').get(sku) as any;
    if (row?.param_overrides) row.param_overrides = JSON.parse(row.param_overrides);

    const history = db.prepare(`SELECT s.snapshot_date, sl.available, sl.reserved,
        sl.inbound_working + sl.inbound_shipped + sl.inbound_received AS inbound,
        sl.units_shipped_t7, sl.units_shipped_t30
      FROM snapshot_lines sl JOIN snapshots s ON s.id = sl.snapshot_id
      WHERE sl.sku = ? ORDER BY s.snapshot_date`).all(sku);

    const poLines = db.prepare(`SELECT po.id, po.po_number, po.status, po.expected_arrival, pl.qty_ordered, pl.qty_received
      FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE pl.sku = ? ORDER BY po.created_at DESC`).all(sku);

    const planLines = db.prepare(`SELECT p.id, p.kind, p.created_at, pl.qty_recommended, pl.qty_final
      FROM plan_lines pl JOIN plans p ON p.id = pl.plan_id WHERE pl.sku = ? ORDER BY p.created_at DESC LIMIT 10`).all(sku);

    const warehouse = db.prepare('SELECT qty_on_hand, updated_at, updated_via FROM warehouse_inventory WHERE sku = ?').get(sku) ?? null;

    return { result, settings: row ?? null, history, poLines, planLines, warehouse };
  });

  app.patch('/api/skus/:sku', (req, reply) => {
    const { sku } = req.params as { sku: string };
    const changed = applyPatch(sku, (req.body ?? {}) as Record<string, unknown>);
    if (!changed) return reply.code(400).send({ error: 'nothing to update or unknown SKU' });
    bumpRevision();
    return { ok: true };
  });

  app.post('/api/skus/bulk', (req, reply) => {
    const body = (req.body ?? {}) as { skus?: string[]; patch?: Record<string, unknown> };
    if (!Array.isArray(body.skus) || body.skus.length === 0 || !body.patch) {
      return reply.code(400).send({ error: 'skus[] and patch required' });
    }
    const db = getDb();
    let changed = 0;
    const run = db.transaction(() => {
      for (const sku of body.skus!) if (applyPatch(sku, body.patch!)) changed++;
    });
    run();
    if (changed > 0) bumpRevision();
    return { ok: true, changed };
  });
}
