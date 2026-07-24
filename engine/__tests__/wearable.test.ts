import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendTransfer } from '../projection.ts';
import { buildWearablePlans, type WearableSkuInput } from '../wearable.ts';
import { settings } from './helpers.ts';
import type { TemplateParams } from '../types.ts';

// A smart-ring supply chain: 90-day China lead (60+25+5), 35-day transfer leg, 60-day FBA goal,
// monthly POs. idealWhDays = 90 + 30 + 14 = 134; lead in months L = round(90/30) = 3.
const WEARABLE: TemplateParams = {
  production_days: 60, transit_days: 25, customs_receiving_days: 5,
  fba_ship_checkin_days: 35, safety_days: 14,
  fba_target_cover_days: 60, warehouse_buffer_days: 0, target_cover_days: 200,
  review_period_fba_days: 14, review_period_po_days: 30,
};
const IDEAL_WH_DAYS = 90 + 30 + 14;

const flat = (n: number): number[] => Array(12).fill(n);

function ring(sku: string, velocity: number | null, extra: Partial<WearableSkuInput> = {}): WearableSkuInput {
  return { sku, role: 'smart_ring', velocity, fba_position: 0, template: WEARABLE, case_pack: null, ...extra };
}

// ── recommendTransfer: WEARABLE uncapped path ───────────────────────────────

test('transfer (WEARABLE): ignoreWarehouseCap ships the full need with no shortage', () => {
  // v=20, 60-day goal → target 1200. FBA 300, nothing coming; over the 35-day leg it sells 700,
  // landing at −400, so the full top-up is 1600. Warehouse physically 0 — but untrusted, so ship 1600.
  const capped = recommendTransfer(20, 300, 0, 0, WEARABLE, settings());
  assert.equal(capped.recommended_ship_qty, 0);
  assert.equal(capped.shortage, 1600);

  const uncapped = recommendTransfer(20, 300, 0, 0, WEARABLE, settings(), { ignoreWarehouseCap: true });
  assert.equal(uncapped.required, 1600);
  assert.equal(uncapped.recommended_ship_qty, 1600);
  assert.equal(uncapped.shortage, 0);
});

test('transfer (CORE regression): omitting opts equals ignoreWarehouseCap:false', () => {
  const a = recommendTransfer(20, 1800, 0, 100_000, WEARABLE, settings());
  const b = recommendTransfer(20, 1800, 0, 100_000, WEARABLE, settings(), { ignoreWarehouseCap: false });
  assert.deepEqual(a, b);
});

// ── variant split ───────────────────────────────────────────────────────────

test('split: aggregate forecast divides by velocity share and sums back to the aggregate', () => {
  const inputs = [ring('SLIM-G', 3), ring('SLIM-S', 1), ring('OG-S', 1)];  // shares .6 / .2 / .2
  const { reports } = buildWearablePlans(inputs, { year: 2026, monthlyUnits: flat(1000) }, '2026-07-09');
  const m0 = (s: string) => reports[s].months[0].forecast_demand;
  assert.equal(m0('SLIM-G'), 600);
  assert.equal(m0('SLIM-S'), 200);
  assert.equal(m0('OG-S'), 200);
  assert.equal(m0('SLIM-G') + m0('SLIM-S') + m0('OG-S'), 1000);
  assert.equal(reports['SLIM-G'].variant_share, 0.6);
});

test('split: no sales signal falls back to an equal split with noSplitSignal', () => {
  const inputs = [ring('A', 0), ring('B', null), ring('C', 0)];
  const { reports, noSplitSignal } = buildWearablePlans(inputs, { year: 2026, monthlyUnits: flat(900) }, '2026-07-09');
  assert.equal(noSplitSignal, true);
  assert.equal(reports['A'].months[0].forecast_demand, 300);   // 900 / 3
  assert.equal(reports['B'].months[0].forecast_demand, 300);
});

// ── attach-rate sizing kit ────────────────────────────────────────────────────

test('attach: kit demand = learned attach rate × aggregate, clamped to [0,2]', () => {
  const kit = (v: number, extra = {}): WearableSkuInput =>
    ({ sku: 'KIT', role: 'sizing_kit', velocity: v, fba_position: 0, template: WEARABLE, case_pack: null, ...extra });

  // rings total velocity 5; kit 0.5 → attach 0.1 → 0.1 × 1000 = 100/mo.
  let out = buildWearablePlans([ring('R1', 3), ring('R2', 2), kit(0.5)], { year: 2026, monthlyUnits: flat(1000) }, '2026-07-09');
  assert.equal(out.reports['KIT'].attach_rate, 0.1);
  assert.equal(out.reports['KIT'].months[0].forecast_demand, 100);
  assert.equal(out.reports['KIT'].is_attach_product, true);

  // Runaway kit velocity clamps at 2.
  out = buildWearablePlans([ring('R1', 3), ring('R2', 2), kit(50)], { year: 2026, monthlyUnits: flat(1000) }, '2026-07-09');
  assert.equal(out.reports['KIT'].attach_rate, 2);

  // Manual override wins.
  out = buildWearablePlans([ring('R1', 3), ring('R2', 2), kit(0.5, { attach_rate_override: 0.25 })], { year: 2026, monthlyUnits: flat(1000) }, '2026-07-09');
  assert.equal(out.reports['KIT'].attach_rate, 0.25);
  assert.equal(out.reports['KIT'].months[0].forecast_demand, 250);
});

// ── monthly ordering + ideal warehouse ────────────────────────────────────────

test('monthly plan: ideal-WH, FBA target, lead offset and multiplier follow the documented formulas', () => {
  // Single ring, velocity 10, flat 300/mo, from Jan so month 0 = Jan 2026 (31 days).
  const { reports } = buildWearablePlans([ring('R', 10)], { year: 2026, monthlyUnits: flat(300) }, '2026-01-15');
  const r = reports['R'];
  const m0 = r.months[0];
  const rate0 = 300 / 31;

  assert.equal(m0.month, '2026-01');
  assert.equal(m0.forecast_demand, 300);
  assert.equal(m0.fba_target_units, Math.round(rate0 * 60));
  assert.equal(m0.ideal_wh_for_amazon, Math.round(rate0 * IDEAL_WH_DAYS));
  assert.equal(r.ideal_wh_days, IDEAL_WH_DAYS);
  assert.equal(r.lead_months, 3);

  // An order placed in month 0 lands 3 months later.
  assert.equal(m0.order_lands_month, r.months[3].month);
  assert.equal(m0.order_lands_month, '2026-04');

  // Multiplier: actual run-rate 10×30 = 300/mo, forecast run-rate 300/mo → 1.0.
  assert.equal(r.actual_run_rate_month, 300);
  assert.equal(r.multiplier, 1);
});

test('monthly plan: doubling the forecast vs actual yields a ~2× multiplier', () => {
  const { reports } = buildWearablePlans([ring('R', 10)], { year: 2026, monthlyUnits: flat(600) }, '2026-01-15');
  assert.equal(reports['R'].multiplier, 2);   // 600 forecast ÷ 300 actual
});

test('monthly plan: no actual sales → null multiplier, and forecast months past the year are flagged', () => {
  // From Nov 2026: months 0,1 = Nov,Dec 2026; month 2 = Jan 2027 → extrapolated (reuses Jan value).
  const { reports } = buildWearablePlans([ring('R', 0)], { year: 2026, monthlyUnits: flat(300) }, '2026-11-10');
  const r = reports['R'];
  assert.equal(r.multiplier, null);                          // no actual signal
  assert.equal(r.months[0].flags, undefined);                // Nov 2026, within the year
  assert.ok(r.months[2].flags?.includes('FORECAST_EXTRAPOLATED'));  // Jan 2027
});

// ── rollup ────────────────────────────────────────────────────────────────────

test('rollup: months are element-wise sums of the per-SKU months', () => {
  const inputs = [ring('R1', 3), ring('R2', 1)];
  const { reports, rollup } = buildWearablePlans(inputs, { year: 2026, monthlyUnits: flat(1000) }, '2026-07-09');
  for (let m = 0; m < 12; m++) {
    assert.equal(
      rollup.months[m].expected_transfer,
      reports['R1'].months[m].expected_transfer + reports['R2'].months[m].expected_transfer,
    );
    assert.equal(
      rollup.months[m].forecast_demand,
      reports['R1'].months[m].forecast_demand + reports['R2'].months[m].forecast_demand,
    );
  }
  assert.deepEqual(rollup.skus, ['R1', 'R2']);
});
