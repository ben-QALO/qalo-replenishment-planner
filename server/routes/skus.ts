import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision, nowIso, today } from '../db/connection.ts';
import { currentRecommendations, getSetting } from '../assemble.ts';
import { projectPlan } from '../../engine/projection.ts';
import { chinaLeadDays } from '../../engine/replenishment.ts';
import { diffDays, addMonths, firstOfMonth } from '../../engine/dates.ts';
import { projectWearableSku } from '../../engine/wearable.ts';
import { wearableInputs } from '../wearable-inputs.ts';

const PATCHABLE = [
  'classification', 'case_pack', 'moq', 'order_multiple',
  'velocity_override', 'growth_multiplier', 'template_override_id', 'notes',
  'asin', 'fulfillment_channel',
  'category', 'wearable_role', 'attach_rate_override',
] as const;

const CLASSIFICATIONS = ['unclassified', 'replenishable', 'watch', 'discontinued', 'ignore'];
const CHANNELS = ['fba', 'fbm'];
const CATEGORIES = ['core', 'wearable'];
const WEARABLE_ROLES = ['smart_ring', 'sizing_kit'];

function applyPatch(sku: string, patch: Record<string, unknown>): boolean {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const field of PATCHABLE) {
    if (!(field in patch)) continue;
    let v = patch[field];
    if (field === 'classification' && !CLASSIFICATIONS.includes(String(v))) continue;
    // Fulfillment channel is constrained; blank is not allowed (defaults to 'fba').
    if (field === 'fulfillment_channel') { const c = String(v).toLowerCase(); if (!CHANNELS.includes(c)) continue; v = c; }
    // Category is constrained; blank defaults to 'core'. wearable_role is optional (blank → null).
    if (field === 'category') { const c = String(v).toLowerCase(); v = CATEGORIES.includes(c) ? c : 'core'; }
    if (field === 'wearable_role') { const c = String(v).toLowerCase(); if (v !== '' && v != null && !WEARABLE_ROLES.includes(c)) continue; v = WEARABLE_ROLES.includes(c) ? c : null; }
    if (field === 'attach_rate_override') { if (v === '' || v == null) v = null; else { const n = Number(v); if (!Number.isFinite(n) || n < 0) continue; v = n; } }
    if (field === 'asin' && typeof v === 'string') v = v.trim().toUpperCase() || null;
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

// The QALO SKU does NOT live on the skus table — it lives in the master identity map
// (sku_map), the spine that joins the NetSuite warehouse report (keyed by QALO SKU) to the
// Amazon listing (keyed by Amazon SKU). Editing it here upserts that map and marks the row
// 'manual', so re-importing the mapping CSV keeps the hand-made mapping instead of wiping it.
function applyQaloSku(amazonSku: string, raw: unknown): { changed: boolean; error?: string } {
  const db = getDb();
  const qalo = typeof raw === 'string' ? raw.trim() : '';
  const existing = db.prepare('SELECT qalo_sku, asin FROM sku_map WHERE amazon_sku = ?').get(amazonSku) as any;
  if ((existing?.qalo_sku ?? '') === qalo) return { changed: false };

  if (!qalo) {
    db.prepare('DELETE FROM sku_map WHERE amazon_sku = ?').run(amazonSku);
    return { changed: true };
  }
  // One QALO SKU ↔ one Amazon SKU. Refuse a mapping that would steal another listing's QALO SKU.
  const taken = db.prepare('SELECT amazon_sku FROM sku_map WHERE qalo_sku = ?').get(qalo) as any;
  if (taken?.amazon_sku && taken.amazon_sku !== amazonSku) {
    return { changed: false, error: `QALO SKU ${qalo} is already mapped to Amazon SKU ${taken.amazon_sku}. Clear that mapping first.` };
  }
  const asin = existing?.asin ?? (db.prepare('SELECT asin FROM skus WHERE sku = ?').get(amazonSku) as any)?.asin ?? null;
  db.transaction(() => {
    db.prepare('DELETE FROM sku_map WHERE amazon_sku = ?').run(amazonSku);
    db.prepare(`INSERT INTO sku_map (qalo_sku, amazon_sku, asin, source_file, updated_at)
      VALUES (?, ?, ?, 'manual', ?) ON CONFLICT(qalo_sku) DO UPDATE SET
        amazon_sku = excluded.amazon_sku, asin = COALESCE(excluded.asin, sku_map.asin),
        source_file = 'manual', updated_at = excluded.updated_at`).run(qalo, amazonSku, asin, nowIso());
  })();
  return { changed: true };
}

// The map's ASIN outranks skus.asin everywhere (see assemble.ts), so a hand-edited ASIN has to
// land on the map row too or the edit would look ignored.
function syncMapAsin(amazonSku: string, raw: unknown): void {
  const asin = typeof raw === 'string' ? (raw.trim().toUpperCase() || null) : null;
  getDb().prepare('UPDATE sku_map SET asin = ?, updated_at = ? WHERE amazon_sku = ?').run(asin, nowIso(), amazonSku);
}

export function skuRoutes(app: FastifyInstance): void {
  // Full computed results — the All SKUs table and the dashboard queues read this.
  app.get('/api/skus', () => {
    const output = currentRecommendations(getDb(), today());
    if (!output) return { results: [], summary: null, snapshotDate: null };
    // Attach editable settings so the table can render current values.
    const db = getDb();
    const settingsRows = db.prepare('SELECT sku, classification, case_pack, moq, order_multiple, velocity_override, growth_multiplier, template_override_id, param_overrides, notes, category, wearable_role, attach_rate_override FROM skus').all() as any[];
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
    // Identity map values are what the rest of the tool uses, so the editor must show those.
    if (row) {
      const m = db.prepare('SELECT qalo_sku, asin FROM sku_map WHERE amazon_sku = ?').get(sku) as any;
      row.qalo_sku = m?.qalo_sku ?? null;
      row.asin = m?.asin ?? row.asin;
    }

    const history = db.prepare(`SELECT s.snapshot_date, sl.available, sl.reserved,
        sl.inbound_working + sl.inbound_shipped + sl.inbound_received AS inbound,
        sl.units_shipped_t7, sl.units_shipped_t30
      FROM snapshot_lines sl JOIN snapshots s ON s.id = sl.snapshot_id
      WHERE sl.sku = ? ORDER BY s.snapshot_date`).all(sku);

    const poLines = db.prepare(`SELECT po.id, po.po_number, po.status, po.expected_arrival,
        po.ordered_date, po.created_at, pl.qty_ordered, pl.qty_received
      FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE pl.sku = ? ORDER BY po.created_at DESC`).all(sku);

    const planLines = db.prepare(`SELECT p.id, p.kind, p.created_at, pl.qty_recommended, pl.qty_final
      FROM plan_lines pl JOIN plans p ON p.id = pl.plan_id WHERE pl.sku = ? ORDER BY p.created_at DESC LIMIT 10`).all(sku);

    const warehouse = db.prepare('SELECT qty_on_hand, updated_at, updated_via FROM warehouse_inventory WHERE sku = ?').get(sku) ?? null;

    // "If you follow the plan" projection — computed with the same engine functions that
    // produce the recommendations, from this SKU's current netted positions.
    let plan = null;
    if (result && result.category !== 'wearable' && result.velocity !== null && result.velocity > 0 && result.include_in_plans) {
      const todayStr = today();
      const arrivals = (poLines as any[])
        .filter(p => (p.status === 'ordered' || p.status === 'in_transit') && p.qty_ordered > p.qty_received)
        .map(p => {
          const placedAt = p.ordered_date || p.created_at?.slice(0, 10);
          return {
            day: p.expected_arrival ? Math.max(0, diffDays(p.expected_arrival, todayStr)) : chinaLeadDays(result.template),
            qty: p.qty_ordered - p.qty_received,
            // negative = placed before today, so the chart can point back to the real order date
            placedDay: placedAt ? diffDays(placedAt, todayStr) : undefined,
          };
        });
      plan = projectPlan(
        result.velocity, result.fba_available, result.fba_coming, result.warehouse_on_hand,
        arrivals, result.template,
        row ? { classification: row.classification, case_pack: row.case_pack, moq: row.moq, order_multiple: row.order_multiple } : undefined,
        180, Number(getSetting(db, 'overstock_factor') ?? '1.5'),
      );
    }

    // WEARABLE (smart rings): the CORE day-by-day plan above doesn't apply — it sizes off trailing
    // sales, caps against the shared warehouse pool, and replays China POs this product doesn't use.
    // Build the forecast-driven projection instead: seasonal demand, transfers every review cycle,
    // and the warehouse treated as unlimited (what it reports is Amazon's DEMAND on the warehouse).
    let wearablePlan = null;
    if (result?.category === 'wearable' && output) {
      const w = wearableInputs(db, output, today());
      if (w) {
        // 6 months out — two China lead times, enough to see the next seasonal turn being built for.
        const horizon = Math.max(0, diffDays(addMonths(firstOfMonth(today()), 6), today()));
        wearablePlan = projectWearableSku(w.inputs, w.forecast, today(), sku, horizon);
      }
    }

    return { result, settings: row ?? null, history, poLines, planLines, warehouse, plan, wearablePlan };
  });

  app.patch('/api/skus/:sku', (req, reply) => {
    const { sku } = req.params as { sku: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    let changed = applyPatch(sku, body);
    if ('asin' in body) syncMapAsin(sku, body.asin);
    if ('qalo_sku' in body) {
      const res = applyQaloSku(sku, body.qalo_sku);
      if (res.error) return reply.code(409).send({ error: res.error });
      changed = changed || res.changed;
    }
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
