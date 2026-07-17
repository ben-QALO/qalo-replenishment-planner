// The only bridge between the database and the pure engine.
import type Database from 'better-sqlite3';
import type { EngineInput, EngineOutput, SkuSettings, SnapshotLine, TemplateParams, StockoutDays } from '../engine/types.ts';
import { computeRecommendations } from '../engine/index.ts';
import { attributeDemand } from './import/attribute-demand.ts';
import { getRevision } from './db/connection.ts';

export interface SnapshotMeta {
  id: number;
  snapshot_date: string;
  imported_at: string;
  revision: number;
  row_count: number;
  source_filename: string | null;
}

export function latestSnapshot(db: Database.Database): SnapshotMeta | null {
  return (db.prepare('SELECT id, snapshot_date, imported_at, revision, row_count, source_filename FROM snapshots ORDER BY snapshot_date DESC LIMIT 1')
    .get() as SnapshotMeta | undefined) ?? null;
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

interface TemplateRow { id: number; name: string; params: string; }

export function templateParamsById(db: Database.Database, id: number): { name: string; params: TemplateParams } | null {
  const row = db.prepare('SELECT id, name, params FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  return row ? { name: row.name, params: JSON.parse(row.params) } : null;
}

function airTemplate(db: Database.Database): TemplateParams | null {
  // Prefer a template named like "air"; fall back to the shortest China lead.
  const rows = db.prepare('SELECT id, name, params FROM templates').all() as TemplateRow[];
  const named = rows.find(r => /air/i.test(r.name));
  if (named) return JSON.parse(named.params);
  let best: TemplateParams | null = null;
  for (const r of rows) {
    const p = JSON.parse(r.params) as TemplateParams;
    const lead = p.production_days + p.transit_days + p.customs_receiving_days;
    const bestLead = best ? best.production_days + best.transit_days + best.customs_receiving_days : Infinity;
    if (lead < bestLead) best = p;
  }
  return best;
}

/**
 * Estimate out-of-stock days per trailing window from snapshot history. Snapshots are
 * ~weekly, so each is treated as representative of the span until the next one (a step
 * function). Returns days a SKU showed available==0 within each window ending at the
 * latest snapshot date. Only SKUs with usable history appear in the map.
 */
export function computeStockoutDays(db: Database.Database, latestDate: string): Record<string, StockoutDays> {
  const rows = db.prepare(`SELECT sl.sku, s.snapshot_date AS date, sl.available
    FROM snapshot_lines sl JOIN snapshots s ON s.id = sl.snapshot_id
    WHERE s.snapshot_date > date(?, '-90 days') AND s.snapshot_date <= ?
    ORDER BY sl.sku, s.snapshot_date`).all(latestDate, latestDate) as { sku: string; date: string; available: number }[];

  const bySku = new Map<string, { date: string; available: number }[]>();
  for (const r of rows) {
    if (!bySku.has(r.sku)) bySku.set(r.sku, []);
    bySku.get(r.sku)!.push({ date: r.date, available: r.available });
  }

  const dayMs = 86_400_000;
  const latest = new Date(`${latestDate}T00:00:00Z`).getTime();
  const daysAgo = (d: string) => Math.round((latest - new Date(`${d}T00:00:00Z`).getTime()) / dayMs);

  const out: Record<string, StockoutDays> = {};
  for (const [sku, snaps] of bySku) {
    if (snaps.length < 3) continue; // not enough history to estimate reliably
    const acc: StockoutDays = { d7: 0, d30: 0, d60: 0, d90: 0, samples: snaps.length };
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].available > 0) continue;
      // This snapshot was OOS; it represents [this snapshot, next snapshot) days ago.
      const start = daysAgo(snaps[i].date);
      const end = i + 1 < snaps.length ? daysAgo(snaps[i + 1].date) : 0; // toward today
      for (const [key, win] of [['d7', 7], ['d30', 30], ['d60', 60], ['d90', 90]] as const) {
        // Overlap of the OOS span (end..start days ago) with the window (0..win days ago).
        const lo = Math.max(end, 0);
        const hi = Math.min(start, win);
        if (hi > lo) acc[key] += hi - lo;
      }
    }
    out[sku] = acc;
  }
  return out;
}

export function assembleEngineInput(db: Database.Database, overrideTemplateId?: number): EngineInput | null {
  const snapshot = latestSnapshot(db);
  if (!snapshot) return null;

  const lineRows = db.prepare(`SELECT sl.*, s.title AS sku_title FROM snapshot_lines sl
    LEFT JOIN skus s ON s.sku = sl.sku WHERE sl.snapshot_id = ?`).all(snapshot.id) as any[];
  const lines: SnapshotLine[] = lineRows.map(r => ({
    sku: r.sku,
    title: r.sku_title ?? undefined,
    available: r.available,
    inbound_working: r.inbound_working,
    inbound_shipped: r.inbound_shipped,
    inbound_received: r.inbound_received,
    reserved: r.reserved,
    unfulfillable: r.unfulfillable,
    units_shipped_t7: r.units_shipped_t7,
    units_shipped_t30: r.units_shipped_t30,
    units_shipped_t60: r.units_shipped_t60,
    units_shipped_t90: r.units_shipped_t90,
    amazon_days_of_supply: r.amazon_days_of_supply,
    amazon_min_inventory_level: r.amazon_min_inventory_level,
    your_price: r.your_price,
    parse_flags: r.flags ? JSON.parse(r.flags) : [],
  }));

  const skuRows = db.prepare('SELECT * FROM skus').all() as any[];
  const skuSettings: Record<string, SkuSettings> = {};
  for (const r of skuRows) {
    let templateOverride: { name: string; params: TemplateParams } | null = null;
    if (r.template_override_id) templateOverride = templateParamsById(db, r.template_override_id);
    skuSettings[r.sku] = {
      classification: r.classification,
      fulfillment_channel: r.fulfillment_channel === 'fbm' ? 'fbm' : 'fba',
      title: r.title ?? undefined,
      case_pack: r.case_pack,
      moq: r.moq,
      order_multiple: r.order_multiple,
      velocity_override: r.velocity_override,
      growth_multiplier: r.growth_multiplier,
      template_override: templateOverride?.params ?? null,
      template_override_name: templateOverride?.name ?? null,
      param_overrides: r.param_overrides ? JSON.parse(r.param_overrides) : null,
    };
  }

  // Business Report demand (FBM + FBA) → per SKU. Handles both report shapes (by-ASIN and
  // by-SKU) and folds each ASIN's FBM/untracked sales onto its tracked FBA SKU, so an ASIN
  // sold through several SKUs isn't double-counted. See import/attribute-demand.ts. A SKU with
  // no ASIN or no matching report row simply falls back to the FBA-only velocity path.
  const externalRows = db.prepare('SELECT asin, sku, units, window_days FROM external_sales').all() as
    { asin: string; sku: string | null; units: number; window_days: number }[];
  const windowDays = externalRows[0]?.window_days ?? 30;
  const externalDemand = attributeDemand(
    externalRows.map(r => ({ asin: String(r.asin), sku: r.sku, units: r.units })),
    windowDays,
    // Only FBA SKUs are demand-attribution targets. An FBM SKU's sales fold onto the FBA SKU
    // of the same ASIN, so FBM demand is planned once (on the FBA SKU) and the FBM SKU itself
    // is never sized for a transfer.
    skuRows.filter(r => r.asin && r.fulfillment_channel !== 'fbm').map(r => ({ sku: r.sku, asin: String(r.asin) })),
  );

  // Warehouse on-hand comes straight from the latest NetSuite import — the source of truth.
  // The tool does NOT track transfers on its own: when a shipment is created in Amazon,
  // NetSuite already decrements on-hand AND Amazon reports the units as inbound, so any
  // tool-side netting here would double-count. In-transit-to-FBA therefore comes entirely
  // from Amazon's inbound fields (see computePositions) — never from tool transfers.
  const whRows = db.prepare('SELECT sku, qty_on_hand FROM warehouse_inventory').all() as any[];
  const warehouse: Record<string, number> = {};
  for (const r of whRows) warehouse[r.sku] = r.qty_on_hand;
  const inTransitToFba: Record<string, number> = {};

  const openPoLines = (db.prepare(`SELECT pl.sku, pl.qty_ordered - pl.qty_received AS qty_outstanding,
      po.expected_arrival, po.po_number
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
    WHERE po.status IN ('ordered','in_transit') AND pl.qty_ordered > pl.qty_received`).all() as any[])
    .map(r => ({ sku: r.sku, qty_outstanding: r.qty_outstanding, expected_arrival: r.expected_arrival, po_number: r.po_number }));

  const activeId = overrideTemplateId ?? Number(getSetting(db, 'active_template_id') ?? 1);
  const active = templateParamsById(db, activeId);
  if (!active) return null;

  return {
    snapshotDate: snapshot.snapshot_date,
    lines,
    skuSettings,
    warehouse,
    openPoLines,
    globalTemplate: active.params,
    globalTemplateName: active.name,
    airTemplate: airTemplate(db),
    weights: JSON.parse(getSetting(db, 'velocity_weights') ?? '{"w7":0.25,"w30":0.45,"w60":0.20,"w90":0.10}'),
    globalGrowthMultiplier: Number(getSetting(db, 'global_growth_multiplier') ?? '1'),
    orderSoonDays: Number(getSetting(db, 'order_soon_days') ?? '7'),
    overstockFactor: Number(getSetting(db, 'overstock_factor') ?? '1.5'),
    stockoutCorrection: (getSetting(db, 'stockout_correction') ?? '1') === '1',
    stockoutDays: computeStockoutDays(db, snapshot.snapshot_date),
    inTransitToFba,
    externalDemand,
  };
}

let cache: { rev: number; day: string; output: EngineOutput } | null = null;

/** Engine output for the current DB state, memoized on (state revision, calendar day). */
export function currentRecommendations(db: Database.Database, todayStr: string): EngineOutput | null {
  const rev = getRevision();
  if (cache && cache.rev === rev && cache.day === todayStr) return cache.output;
  const input = assembleEngineInput(db);
  if (!input) return null;
  const output = computeRecommendations(input, todayStr);
  cache = { rev, day: todayStr, output };
  return output;
}

/** Uncached run with a different active template — used for switch previews. */
export function previewRecommendations(db: Database.Database, todayStr: string, templateId: number): EngineOutput | null {
  const input = assembleEngineInput(db, templateId);
  if (!input) return null;
  return computeRecommendations(input, todayStr);
}
