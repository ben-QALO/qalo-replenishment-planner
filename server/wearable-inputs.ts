// The one place that turns DB rows + engine results into the WEARABLE projection's inputs.
//
// Three callers need exactly this: the SKU detail chart, the 12-month report, and the inventory-team
// Excel export. They MUST agree number for number — if the export said "order 4,000" while the chart
// showed 3,200, neither would be trusted again. Sharing this builder is what makes that structural
// rather than a thing we remember to keep in sync.

import type Database from 'better-sqlite3';
import type { EngineOutput } from '../engine/types.ts';
import type { WearableSkuInput, WearableForecast } from '../engine/wearable.ts';

export interface WearableInputs {
  inputs: WearableSkuInput[];
  forecast: WearableForecast;
}

/**
 * Build the WEARABLE projection inputs from the current engine output.
 * Returns null when there's nothing to plan: no forecast entered, or no SKU tagged as a smart ring.
 */
export function wearableInputs(db: Database.Database, output: EngineOutput, todayStr: string): WearableInputs | null {
  const fc = db.prepare('SELECT year, month, units FROM wearable_forecast ORDER BY year DESC, month ASC')
    .all() as { year: number; month: number; units: number }[];
  if (fc.length === 0) return null;

  // Same multi-year resolution as assemble.ts: prefer the current calendar year's own forecast, and
  // fall back to the most recent year on file as the anchor.
  const byYear: Record<number, number[]> = {};
  for (const f of fc) (byYear[f.year] ??= Array(12).fill(0))[f.month - 1] = f.units;
  const thisYear = Number(todayStr.slice(0, 4));
  const year = byYear[thisYear] ? thisYear : fc[0].year;
  const monthlyUnits = byYear[year] ?? Array(12).fill(0);

  const meta = new Map((db.prepare(
    'SELECT sku, wearable_role, case_pack, moq, attach_rate_override FROM skus WHERE category = ?',
  ).all('wearable') as any[]).map(r => [r.sku, r]));

  const inputs: WearableSkuInput[] = output.results
    .filter(r => r.category === 'wearable'
      && (meta.get(r.sku)?.wearable_role === 'smart_ring' || meta.get(r.sku)?.wearable_role === 'sizing_kit'))
    .map(r => ({
      sku: r.sku, role: meta.get(r.sku)!.wearable_role as 'smart_ring' | 'sizing_kit',
      // velocity_exact, not the 2dp display value — see SkuResult.velocity_exact. The export, the
      // detail chart and the Ship-to-FBA queue all size off this, so they must share the precision.
      velocity: r.velocity_exact ?? r.velocity, fba_available: r.fba_available, fba_coming: r.fba_coming,
      template: r.template, case_pack: meta.get(r.sku)?.case_pack ?? null,
      moq: meta.get(r.sku)?.moq ?? null, attach_rate_override: meta.get(r.sku)?.attach_rate_override ?? null,
    }));

  if (!inputs.some(i => i.role === 'smart_ring')) return null;
  return { inputs, forecast: { year, monthlyUnits, byYear } };
}
