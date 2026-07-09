// The only bridge between the database and the pure engine.
import type Database from 'better-sqlite3';
import type { EngineInput, EngineOutput, SkuSettings, SnapshotLine, TemplateParams } from '../engine/types.ts';
import { computeRecommendations } from '../engine/index.ts';
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

  const warehouse: Record<string, number> = {};
  for (const r of db.prepare('SELECT sku, qty_on_hand FROM warehouse_inventory').all() as any[]) {
    warehouse[r.sku] = r.qty_on_hand;
  }

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
