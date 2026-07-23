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

  // Master identity map (QALO SKU ↔ Amazon SKU ↔ ASIN). The catalog/engine key by the Amazon
  // SKU (what the FBA export uses); the map supplies the QALO SKU (team-facing) and the
  // authoritative ASIN, and lets us translate the NetSuite warehouse (keyed by QALO SKU).
  const mapRows = db.prepare('SELECT qalo_sku, amazon_sku, asin FROM sku_map').all() as
    { qalo_sku: string; amazon_sku: string | null; asin: string | null }[];
  const byAmazon = new Map<string, { qalo_sku: string; asin: string | null }>();
  const qaloToAmazon = new Map<string, string>();
  for (const m of mapRows) {
    if (m.amazon_sku) { byAmazon.set(m.amazon_sku, { qalo_sku: m.qalo_sku, asin: m.asin }); qaloToAmazon.set(m.qalo_sku, m.amazon_sku); }
  }
  const qaloOf = (amazonSku: string) => byAmazon.get(amazonSku)?.qalo_sku ?? amazonSku;
  const asinOf = (amazonSku: string, fallback: string | null) => byAmazon.get(amazonSku)?.asin ?? fallback;

  const skuRows = db.prepare('SELECT * FROM skus').all() as any[];
  const skuSettings: Record<string, SkuSettings> = {};
  for (const r of skuRows) {
    let templateOverride: { name: string; params: TemplateParams } | null = null;
    if (r.template_override_id) templateOverride = templateParamsById(db, r.template_override_id);
    skuSettings[r.sku] = {
      classification: r.classification,
      fulfillment_channel: r.fulfillment_channel === 'fbm' ? 'fbm' : 'fba',
      qalo_sku: qaloOf(r.sku),
      asin: asinOf(r.sku, r.asin ?? null),
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
    skuRows.filter(r => asinOf(r.sku, r.asin ?? null) && r.fulfillment_channel !== 'fbm')
      .map(r => ({ sku: r.sku, asin: String(asinOf(r.sku, r.asin ?? null)) })),
  );

  // Warehouse on-hand comes straight from the latest NetSuite import — the source of truth.
  // The tool does NOT track transfers on its own: when a shipment is created in Amazon,
  // NetSuite already decrements on-hand AND Amazon reports the units as inbound, so any
  // tool-side netting here would double-count. In-transit-to-FBA therefore comes entirely
  // from Amazon's inbound fields (see computePositions) — never from tool transfers.
  // NetSuite is keyed by the QALO SKU; translate each row to the Amazon SKU the engine uses so
  // warehouse stock lands on the right FBA listing (fixes the ~33 products whose Amazon SKU
  // differs from the QALO SKU). SKUs with no map entry pass through unchanged (QALO == Amazon).
  const whRows = db.prepare('SELECT sku, qty_on_hand FROM warehouse_inventory').all() as any[];
  const warehouse: Record<string, number> = {};
  for (const r of whRows) {
    const amazon = qaloToAmazon.get(r.sku) ?? r.sku;
    warehouse[amazon] = (warehouse[amazon] ?? 0) + r.qty_on_hand;
  }
  const inTransitToFba: Record<string, number> = {};

  const openPoLines = (db.prepare(`SELECT pl.sku, pl.qty_ordered - pl.qty_received AS qty_outstanding,
      po.expected_arrival, po.po_number
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
    WHERE po.status IN ('ordered','in_transit') AND pl.qty_ordered > pl.qty_received`).all() as any[])
    // PO lines may be entered with the QALO SKU; translate to the Amazon SKU for consistency.
    .map(r => ({ sku: qaloToAmazon.get(r.sku) ?? r.sku, qty_outstanding: r.qty_outstanding, expected_arrival: r.expected_arrival, po_number: r.po_number }));

  // ── ASIN consolidation ──────────────────────────────────────────────────────
  // Amazon can carry several merchant SKUs on ONE ASIN (a re-listing, or a `.s`/`.1`/`NP`
  // variant). They're the same physical product: sales split across the SKUs and FBA inventory
  // is often a single shared pool reported once per SKU. Plan them as ONE unit — the MAPPED SKU
  // is primary; each duplicate folds its demand, warehouse and open POs onto it, FBA pools are
  // summed but DEDUPED (an identical position tuple = the same physical pool, counted once), and
  // the duplicate is suspended (engine reads `consolidated_into`). Fixes both the split demand
  // and the double-counted shared FBA pool that mis-ordered these products.
  const directlyMapped = new Set(mapRows.filter(m => m.amazon_sku).map(m => m.amazon_sku as string));
  const lineBySku = new Map(lines.map(l => [l.sku, l]));
  const groupByAsin = new Map<string, string[]>();
  for (const r of skuRows) {
    if (r.classification !== 'replenishable' && r.classification !== 'watch') continue;
    const asin = asinOf(r.sku, r.asin ?? null);
    if (!asin) continue;
    (groupByAsin.get(asin) ?? groupByAsin.set(asin, []).get(asin)!).push(r.sku);
  }
  const poolKey = (l: SnapshotLine) =>
    `${l.available}|${l.reserved}|${l.inbound_working}|${l.inbound_shipped}|${l.inbound_received}`;
  const consolidated: Record<string, string> = {};
  for (const [, groupSkus] of groupByAsin) {
    if (groupSkus.length < 2) continue;
    const primary = groupSkus.find(s => directlyMapped.has(s)) ?? groupSkus[0];
    const pLine = lineBySku.get(primary);
    if (!pLine) continue;   // mapped primary absent from this snapshot → leave the group as-is (safe)
    const seenPools = new Set<string>([poolKey(pLine)]);
    for (const sib of groupSkus) {
      if (sib === primary) continue;
      const sd = externalDemand[sib];
      if (sd) {   // demand: sum the sales streams onto the primary
        const pd = externalDemand[primary];
        externalDemand[primary] = { units: (pd?.units ?? 0) + sd.units, days: pd?.days ?? sd.days };
        delete externalDemand[sib];
      }
      const sLine = lineBySku.get(sib);
      if (sLine) {
        const k = poolKey(sLine);
        if (!seenPools.has(k)) {   // FBA: add only a DISTINCT physical pool (different tuple)
          seenPools.add(k);
          pLine.available += sLine.available;
          pLine.reserved += sLine.reserved;
          pLine.inbound_working += sLine.inbound_working;
          pLine.inbound_shipped += sLine.inbound_shipped;
          pLine.inbound_received += sLine.inbound_received;
          pLine.unfulfillable = (pLine.unfulfillable ?? 0) + (sLine.unfulfillable ?? 0);
        }
        for (const w of ['units_shipped_t7', 'units_shipped_t30', 'units_shipped_t60', 'units_shipped_t90'] as const) {
          if (sLine[w] != null) pLine[w] = (pLine[w] ?? 0) + (sLine[w] as number);   // separate sales streams → sum
        }
      }
      if (warehouse[sib]) { warehouse[primary] = (warehouse[primary] ?? 0) + warehouse[sib]; delete warehouse[sib]; }
      consolidated[sib] = primary;
    }
  }
  for (const pl of openPoLines) { const into = consolidated[pl.sku]; if (into) pl.sku = into; }
  for (const [sib, primary] of Object.entries(consolidated)) {
    if (skuSettings[sib]) skuSettings[sib].consolidated_into = primary;
  }

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
