import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendTransfer } from '../projection.ts';
import {
  buildWearablePlans, simulateWearableSku, wearableDemandFractions, wearableDemandCurve,
  wearableTransferQty, projectWearableSku, type WearableSkuInput, type WearableRateInput,
} from '../wearable.ts';
import { computeRecommendations } from '../index.ts';
import { diffDays } from '../dates.ts';
import { settings, input, line, TODAY } from './helpers.ts';
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
  return { sku, role: 'smart_ring', velocity, fba_available: 0, fba_coming: 0, template: WEARABLE, case_pack: 20, ...extra };
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
    ({ sku: 'KIT', role: 'sizing_kit', velocity: v, fba_available: 0, fba_coming: 0, template: WEARABLE, case_pack: 50, ...extra });

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

test('monthly plan: month figures, lead offset and multiplier line up', () => {
  // velocity 5/day sits below the ~9.7/day forecast, so the actual-sales floor stays out of the way.
  const { reports } = buildWearablePlans([ring('R', 5)], { year: 2026, monthlyUnits: flat(300) }, '2026-01-15');
  const r = reports['R'];
  const m0 = r.months[0];

  assert.equal(m0.month, '2026-01');
  assert.equal(m0.forecast_demand, 300);
  assert.equal(r.ideal_wh_days, IDEAL_WH_DAYS);
  assert.equal(r.lead_months, 3);
  // An order placed in month 0 lands 3 months later (one China lead).
  assert.equal(m0.order_lands_month, '2026-04');
  assert.equal(m0.order_lands_month, r.months[3].month);
  // Multiplier: actual run-rate 5×30 = 150/mo against a 300/mo forecast → 2.0.
  assert.equal(r.actual_run_rate_month, 150);
  assert.equal(r.multiplier, 2);
});

test('ONE SOURCE OF TRUTH: the monthly report equals the projection it is read from', () => {
  // The report used to re-derive orders, the FBA goal and the warehouse level from its own separate
  // formulas, so the table and the chart showed different numbers for the same month. Everything is
  // now looked up out of the projection — this test is the guard that keeps it that way.
  const inputs = [ring('SLIM-G', 3), ring('SLIM-S', 1), ring('OG-S', 1)];
  const forecast = { year: 2026, monthlyUnits: SEASONAL };
  const today = '2026-01-15';
  const { reports } = buildWearablePlans(inputs, forecast, today);

  const r = reports['SLIM-G'];
  // Rebuild the SAME projection the report read from (share 0.6 of the aggregate).
  const plan = simulateWearableSku({
    demandFrac: 0.6, forecast, fbaAvailable: 0, fbaComing: 0,
    template: WEARABLE, casePack: 20, moq: null, today, horizonDays: 500,
  });

  assert.equal(r.warehouse_prefill_needed, plan.warehouse_prefill_needed, 'opening commitment must match');
  // Guard against a vacuous pass: a mis-wired input once made every quantity silently 0, so these
  // equality checks compared 0 to 0 and told us nothing.
  assert.ok(plan.transfers.length > 0 && plan.orders.length > 0, 'projection must actually produce a plan');
  assert.ok(r.months.some(m => m.expected_transfer > 0), 'report must actually contain quantities');

  for (const m of r.months.slice(0, 6)) {
    const pull = plan.transfers.filter(t => t.date.slice(0, 7) === m.month).reduce((s, t) => s + t.qty, 0);
    const order = plan.orders.filter(o => o.date.slice(0, 7) === m.month).reduce((s, o) => s + o.qty, 0);
    assert.equal(m.expected_transfer, pull, `${m.month}: warehouse pull must match the transfer schedule`);
    assert.equal(m.recommended_order, order, `${m.month}: China order must match the ordering plan`);
  }

  // Cumulative is a running total of the same pulls, not an independent figure.
  let running = 0;
  for (const m of r.months) { running += m.expected_transfer; assert.equal(m.cumulative_transfer, running, `${m.month}: cumulative drift`); }
});

test('ONE SOURCE OF TRUTH: the rollup is the sum of the per-SKU plans', () => {
  const inputs = [ring('SLIM-G', 3), ring('SLIM-S', 1)];
  const { reports, rollup } = buildWearablePlans(inputs, { year: 2026, monthlyUnits: SEASONAL }, '2026-01-15');
  for (let m = 0; m < 12; m++) {
    const sumPull = inputs.reduce((s, i) => s + reports[i.sku].months[m].expected_transfer, 0);
    const sumOrder = inputs.reduce((s, i) => s + reports[i.sku].months[m].recommended_order, 0);
    assert.equal(rollup.months[m].expected_transfer, sumPull, `month ${m}: pull rollup`);
    assert.equal(rollup.months[m].recommended_order, sumOrder, `month ${m}: order rollup`);
  }
  assert.equal(rollup.total_prefill_needed,
    inputs.reduce((s, i) => s + reports[i.sku].warehouse_prefill_needed, 0), 'prefill rollup');
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

// ── forecast-sized FBA transfers ──────────────────────────────────────────────

const rateInput = (sku: string, velocity: number | null, role: 'smart_ring' | 'sizing_kit' = 'smart_ring',
  extra: Partial<WearableRateInput> = {}): WearableRateInput =>
  ({ sku, role, velocity, template: WEARABLE, ...extra });

const qtyOn = (today: string, monthlyUnits: number[], fba: number, frac = 1, tmpl = WEARABLE) =>
  wearableTransferQty({
    demand: wearableDemandCurve(frac, { year: 2026, monthlyUnits }, today),
    day: 0, fbaAvailable: fba, fbaComing: 0, template: tmpl, casePack: 20,
  });

test('transfer sizing: driven by the forecast, not by recent sales', () => {
  // Flat 930/mo. Starting empty, the shipment must cover the 60-day goal window after it lands
  // (~2 months of demand ≈ 1,860) plus the demand that accrues during the 35-day leg.
  const c = qtyOn('2026-01-15', flat(930), 0);
  assert.ok(c.target_units > 1700 && c.target_units < 2000, `goal window ≈2 months of demand, got ${c.target_units}`);
  assert.ok(c.qty >= c.target_units, 'starting empty, the shipment must at least fill the goal window');
  assert.equal(c.qty % 20, 0, 'whole cases only');
});

test('transfer sizing: counts demand DURING transit separately from demand after landing', () => {
  // This is the fix for the post-peak stockout: heading out of a peak, the 35-day leg still carries
  // heavy demand even though the months after it are quiet. Both terms must be counted.
  const seasonal = [300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 3000, 3000];
  const dec = qtyOn('2026-12-05', seasonal, 2000);
  // December sells ~97/day, so ~2,700 drains away over the 35-day leg (which tails into a quiet
  // January). A blended average across the months AFTER landing would have seen only ~10/day.
  assert.ok(dec.sales_over_leg > 2500, `December leg demand should be heavy, got ${dec.sales_over_leg}`);
  assert.ok(dec.sales_over_leg > dec.target_units * 3, 'leg demand must dwarf the quiet window ahead');
  // 2,000 on hand can't absorb that, so what's left on arrival is negative — and the shipment
  // must make up the whole hole plus the (quiet) goal window ahead.
  assert.ok(dec.projected_on_arrival < 0, `expected a deficit on arrival, got ${dec.projected_on_arrival}`);
  assert.ok(dec.qty > dec.target_units, 'must cover the transit shortfall on top of the goal window');
});

test('transfer sizing: builds ahead of a peak and eases off once it passes', () => {
  const seasonal = [300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 3000, 3000];
  // Late September: the leg lands in early November, so it must already be buying peak volume.
  const sept = qtyOn('2026-09-25', seasonal, 500);
  // Mid-February: quiet ahead and quiet behind.
  const feb = qtyOn('2026-02-15', seasonal, 500);
  assert.ok(sept.qty > feb.qty * 3, `pre-peak ${sept.qty} should dwarf quiet-season ${feb.qty}`);
});

test('demand fractions: split by variant share, kit by attach rate', () => {
  const fracs = wearableDemandFractions([
    rateInput('SLIM-G', 3), rateInput('SLIM-S', 1),      // shares .75 / .25
    rateInput('KIT', 0.4, 'sizing_kit'),                 // attach 0.4/4 = 0.10
  ]);
  assert.equal(fracs['SLIM-G'], 0.75);
  assert.equal(fracs['SLIM-S'], 0.25);
  assert.ok(Math.abs(fracs['KIT'] - 0.1) < 1e-9);
});

test('demand fractions: no smart rings means no forecast claim (caller falls back)', () => {
  assert.deepEqual(wearableDemandFractions([rateInput('KIT', 5, 'sizing_kit')]), {});
});

// ── the forward projection (chart + every-2-weeks schedule) ───────────────────

const SEASONAL = [300, 300, 400, 500, 600, 600, 700, 800, 900, 1000, 3000, 2500];

function sim(overrides: Partial<Parameters<typeof simulateWearableSku>[0]> = {}) {
  return simulateWearableSku({
    demandFrac: 1, forecast: { year: 2026, monthlyUnits: SEASONAL },
    fbaAvailable: 200, fbaComing: 0, template: WEARABLE, casePack: 20, moq: 100,
    today: '2026-01-15', horizonDays: 365, ...overrides,
  });
}

test('projection: FBA never runs dry — the whole point of the plan', () => {
  // Start at a healthy shelf (≈60 days of January demand) and follow the plan for over a year,
  // straight through a 10× seasonal peak. This is the invariant that matters most: it is the
  // regression guard for the post-peak stockout the blended-rate sizing used to cause.
  for (const goal of [60, 90]) {
    const p = sim({ template: { ...WEARABLE, fba_target_cover_days: goal }, fbaAvailable: 600, horizonDays: 500 });
    assert.equal(p.stockout_day, -1, `goal=${goal}d: expected no stockout, got day ${p.stockout_day}`);
    assert.ok(p.series.every(s => s.fba > 0), `goal=${goal}d: no day may sit at zero sellable stock`);
  }
});

test('projection: keeps reviewing every 2 weeks all year (never goes quiet for months)', () => {
  // The old blended-rate sizing silently skipped most review cycles because it thought FBA was
  // already "at goal", then ran dry. Over 500 days on a 14-day cadence there are ~36 reviews, and
  // a healthy plan should be acting on most of them.
  const p = sim({ horizonDays: 500, fbaAvailable: 600 });
  assert.ok(p.transfers.length >= 30, `expected a steady cadence, only got ${p.transfers.length} transfers`);
});

test('projection: survives even starting from an empty shelf', () => {
  // Cold start: nothing at Amazon, nothing inbound. The first transfer still takes the ship leg to
  // land, so a brief dip is unavoidable — but the plan must recover and hold from then on.
  const p = sim({ fbaAvailable: 0, fbaComing: 0 });
  const afterFirstArrival = p.series.filter(s => s.day > WEARABLE.fba_ship_checkin_days + 1);
  assert.ok(afterFirstArrival.every(s => s.fba > 0), 'must stay in stock once the first shipment lands');
});

test('projection: transfers land on the every-2-weeks review cadence', () => {
  const p = sim();
  assert.equal(p.review_period_days, 14);
  assert.ok(p.transfers.length > 0, 'expected a transfer schedule');
  for (const t of p.transfers) {
    assert.equal(t.day % 14, 0, `transfer on day ${t.day} is off-cadence`);
    assert.equal(t.arrives_day, t.day + WEARABLE.fba_ship_checkin_days);
    assert.equal(t.qty % 20, 0, `transfer of ${t.qty} is not whole cases`);
  }
});

test('projection: ramps up into the Nov peak, then eases off', () => {
  const p = sim();
  const inMonth = (mk: string) => p.transfers.filter(t => t.date.slice(0, 7) === mk).reduce((s, t) => s + t.qty, 0);
  // Shipments must be BUILT during Sep/Oct to be on the shelf for the Nov/Dec peak...
  const prePeak = inMonth('2026-09') + inMonth('2026-10');
  const quiet = inMonth('2026-02') + inMonth('2026-03');
  assert.ok(prePeak > quiet * 2, `pre-peak shipping (${prePeak}) should dwarf the quiet season (${quiet})`);
  // ...and the shelf goal itself must rise into the peak.
  const goalNov = p.series.find(s => s.day === diffDays('2026-11-15', '2026-01-15'))!.goal;
  const goalFeb = p.series.find(s => s.day === diffDays('2026-02-15', '2026-01-15'))!.goal;
  assert.ok(goalNov > goalFeb * 3, `Nov goal (${goalNov}) should far exceed Feb (${goalFeb})`);
});

test('projection: day-0 transfer equals what the Ship-to-FBA queue shows', () => {
  // The queue and the chart must be the same model. Both size today's shipment with
  // wearableTransferQty on day 0, so the chart can never contradict the number the team acts on.
  const today = '2026-09-25';
  const fbaAvailable = 300, fbaComing = 40;
  const expected = wearableTransferQty({
    demand: wearableDemandCurve(1, { year: 2026, monthlyUnits: SEASONAL }, today),
    day: 0, fbaAvailable, fbaComing, template: WEARABLE, casePack: 20,
  }).qty;

  const p = sim({ today, fbaAvailable, fbaComing, horizonDays: 60 });
  assert.equal(p.transfers.find(t => t.day === 0)?.qty ?? 0, expected, 'projection day 0 must match the queue exactly');
});

test('projection: reports Amazon’s demand on the warehouse, ignoring the shared pool', () => {
  // Warehouse stock is never an input — the same plan results no matter what NetSuite says, because
  // the physical pool is shared with retail/Shopify. What the plan yields is the PULL requirement.
  const p = sim();
  const totalPull = p.transfers.reduce((s, t) => s + t.qty, 0);
  const yearDemand = SEASONAL.reduce((a, c) => a + c, 0);
  // Over a year the pull should be within a sane band of annual demand (plus the shelf it must hold).
  assert.ok(totalPull > yearDemand * 0.8, `pull ${totalPull} too low vs demand ${yearDemand}`);
  assert.ok(totalPull < yearDemand * 1.8, `pull ${totalPull} implausibly high vs demand ${yearDemand}`);
});

test('multi-year forecast: each month reads its OWN year, not just the newest one', () => {
  // Real data had BOTH a 2026 and a 2027 forecast on file. Picking the newest year planned 2026
  // off the 2027 numbers and flagged every single month as an estimate, silently ignoring the
  // forecast that actually applied.
  const y2026 = Array(12).fill(100);
  const y2027 = Array(12).fill(900);
  const { reports } = buildWearablePlans(
    [ring('R', 0)],   // no sales, so the actual-sales floor can't mask the year lookup
    { year: 2026, monthlyUnits: y2026, byYear: { 2026: y2026, 2027: y2027 } },
    '2026-11-15',
  );
  const m = reports['R'].months;
  // Nov + Dec 2026 come from the 2026 forecast...
  assert.equal(m[0].month, '2026-11');
  assert.equal(m[0].forecast_demand, 100, 'Nov 2026 must use the 2026 forecast');
  assert.equal(m[1].forecast_demand, 100);
  // ...and Jan 2027 onward from the 2027 one, with neither marked as an estimate.
  assert.equal(m[2].month, '2027-01');
  assert.equal(m[2].forecast_demand, 900, 'Jan 2027 must use the 2027 forecast');
  for (const mm of m.slice(0, 12)) {
    assert.ok(!(mm.flags ?? []).includes('FORECAST_EXTRAPOLATED'), `${mm.month} wrongly flagged as an estimate`);
  }
});

test('multi-year forecast: a year with nothing entered still reuses last year and says so', () => {
  const y2026 = Array(12).fill(100);
  const { reports } = buildWearablePlans(
    [ring('R', 0)],   // no sales, so the actual-sales floor can't mask the year lookup
    { year: 2026, monthlyUnits: y2026, byYear: { 2026: y2026 } },   // no 2027 on file
    '2026-11-15',
  );
  const m = reports['R'].months;
  assert.ok(!(m[0].flags ?? []).includes('FORECAST_EXTRAPOLATED'), 'Nov 2026 is real');
  assert.equal(m[2].month, '2027-01');
  assert.ok((m[2].flags ?? []).includes('FORECAST_EXTRAPOLATED'), 'Jan 2027 has no forecast — must be flagged');
  assert.equal(m[2].forecast_demand, 100, 'and falls back to the same month last year');
});

test('actual-sales floor: never plan below what a SKU is demonstrably selling', () => {
  // Real data: every one of 25 wearables was forecast BELOW its actual sales rate, so the ring sizer
  // got a "60-day" shelf goal that covered only 42 real days. Planning under proven demand is the one
  // error you discover by stocking out, so the demand curve floors at the observed rate.
  const quiet = flat(150);           // 150/mo ≈ 4.9/day forecast
  const sellingFaster = 10;          // but actually selling 10/day
  const { reports } = buildWearablePlans([ring('R', sellingFaster)], { year: 2026, monthlyUnits: quiet }, '2026-01-15');
  const m0 = reports['R'].months[0];
  assert.ok(m0.forecast_demand >= 10 * 30, `planned demand ${m0.forecast_demand} must reach the ~300/mo actually selling`);
  assert.ok((m0.flags ?? []).includes('PLANNED_AT_ACTUAL'), 'and must say it was lifted to actual sales');

  // The floor must NOT flatten a genuine seasonal peak — a forecast above actual still wins.
  const peaky = [150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 3000, 3000];
  const peak = buildWearablePlans([ring('R', sellingFaster)], { year: 2026, monthlyUnits: peaky }, '2026-01-15');
  const nov = peak.reports['R'].months.find(m => m.month === '2026-11')!;
  assert.ok(nov.forecast_demand > 2500, `Nov must still follow the forecast, got ${nov.forecast_demand}`);
  assert.ok(!(nov.flags ?? []).includes('PLANNED_AT_ACTUAL'), 'the forecast wins in a peak month');
});

// ── the closed loop: China orders ↔ warehouse ↔ transfers ↔ FBA ───────────────

test('closed loop: the ordering plan actually supports every transfer it promises', () => {
  // The point of showing orders on the chart: prove the chain holds. Once the opening commitment
  // (warehouse_prefill_needed) is in place, the Amazon-earmarked pool must never go under water —
  // otherwise a transfer the plan promises would be physically impossible.
  for (const goal of [60, 90]) {
    const p = sim({ template: { ...WEARABLE, fba_target_cover_days: goal }, fbaAvailable: 600, horizonDays: 240 });
    // The series value is NOT clamped at zero, so this genuinely tests the ordering policy rather
    // than a display floor. A negative day means the plan promised a transfer it couldn't fund.
    const under = p.series.filter(s => s.warehouse < 0);
    assert.equal(under.length, 0,
      `goal=${goal}: warehouse pool went negative on ${under.length} days (first: day ${under[0]?.day}, ${under[0]?.warehouse})`);
    assert.ok(p.orders.length > 0, `goal=${goal}: expected a China ordering plan`);
  }
});

test('closed loop: orders sit on the monthly cadence and land a full lead time later', () => {
  const p = sim({ horizonDays: 240 });
  assert.equal(p.po_review_period_days, 30);
  for (const o of p.orders) {
    assert.equal(o.day % 30, 0, `order on day ${o.day} is off the monthly cadence`);
    assert.equal(o.arrives_day, o.day + p.lead_days, 'orders must land exactly one China lead later');
    assert.ok(o.qty > 0);
  }
});

test('closed loop: names the opening commitment nothing ordered today can cover', () => {
  // Nothing ordered now lands for 90 days, so the opening stretch is served only by stock that
  // already exists. That figure is the ask for the inventory team, and it must be enough to bridge
  // the whole pre-arrival window on its own.
  const p = sim({ horizonDays: 240 });
  const pulledBeforeFirstArrival = p.transfers
    .filter(t => t.day < p.lead_days)
    .reduce((s, t) => s + t.qty, 0);
  assert.ok(p.warehouse_prefill_needed > 0, 'a cold-start plan must state its opening commitment');
  assert.ok(
    p.warehouse_prefill_needed >= pulledBeforeFirstArrival,
    `prefill ${p.warehouse_prefill_needed} must cover the ${pulledBeforeFirstArrival} pulled before any order lands`,
  );
});

test('closed loop: total supply covers total demand on the warehouse', () => {
  const p = sim({ horizonDays: 240 });
  const pulled = p.transfers.filter(t => t.day <= 240).reduce((s, t) => s + t.qty, 0);
  const supplied = p.warehouse_prefill_needed
    + p.orders.filter(o => o.arrives_day <= 240).reduce((s, o) => s + o.qty, 0);
  assert.ok(supplied >= pulled, `supply ${supplied} must cover the ${pulled} pulled from the warehouse`);
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

// ── the report and the Ship-to-FBA queue must size identically ───────────────
//
// These are two different code paths over the same product: `computeRecommendations` sizes the queue
// inline at full precision, while the rolling-12-month report is built afterwards from the SkuResult
// list. When that hand-off passed the DISPLAY-ROUNDED velocity, a SKU selling 0.8333/day was split off
// the forecast as if it sold 0.83 — enough to move its transfer by a unit, so the ordering report (and
// the Excel export built from it) told the team to ship 19 while the queue said 20.
//
// Velocities below are deliberately non-terminating (5/7/25 units over the windows) so rounding to 2dp
// actually loses information — with tidy numbers this test would pass either way and guard nothing.

const wearSettings = (role: 'smart_ring' | 'sizing_kit') =>
  settings({ category: 'wearable', wearable_role: role, case_pack: 1, moq: 1 });

/** A wearable engine input whose velocities do not survive 2dp rounding. */
function wearableEngineInput() {
  const win = (perWeek: number) => ({
    units_shipped_t7: perWeek, units_shipped_t30: perWeek * 4,
    units_shipped_t60: perWeek * 8, units_shipped_t90: perWeek * 12,
  });
  return input({
    snapshotDate: TODAY,
    lines: [
      line({ sku: 'W-06', available: 60, inbound_shipped: 1, ...win(5) }),   // 0.714…/day
      line({ sku: 'W-09', available: 60, ...win(25) }),                      // 3.571…/day
      line({ sku: 'W-13', available: 20, ...win(7) }),                       // 1.0/day
      line({ sku: 'W-KIT', available: 40, ...win(11) }),
    ],
    skuSettings: {
      'W-06': wearSettings('smart_ring'), 'W-09': wearSettings('smart_ring'),
      'W-13': wearSettings('smart_ring'), 'W-KIT': wearSettings('sizing_kit'),
    },
    wearableForecast: {
      year: 2026,
      monthlyUnits: [800, 800, 900, 900, 1000, 1000, 1100, 1100, 1200, 1400, 2200, 1800],
      smartRingSkus: ['W-06', 'W-09', 'W-13'],
      sizingKitSku: 'W-KIT',
    },
  });
}

test('report vs queue: the report is built from velocity_exact, not the rounded display value', () => {
  const out = computeRecommendations(wearableEngineInput(), TODAY);
  const wear = out.results.filter(r => r.wearable_report);
  assert.equal(wear.length, 4, 'every wearable SKU should carry a report');
  const rings = wear.filter(r => !r.wearable_report!.is_attach_product);
  const kit = wear.find(r => r.wearable_report!.is_attach_product)!;
  // The fixture is only meaningful if 2dp actually loses information.
  assert.ok(wear.some(r => r.velocity_exact !== r.velocity), 'fixture velocities must not survive 2dp');

  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  const shareFrom = (pick: (r: typeof wear[number]) => number) => {
    const total = rings.reduce((a, r) => a + pick(r), 0);
    return new Map(rings.map(r => [r.sku, round4(pick(r) / total)]));
  };
  const exactShares = shareFrom(r => r.velocity_exact!);
  const roundedShares = shareFrom(r => r.velocity!);

  // THE GUARD: each variant's share of the forecast must come from the full-precision rate. Pass the
  // display-rounded value into buildWearablePlans instead and these drift, taking the transfers, the
  // China orders and the warehouse earmark with them — which is how the report came to disagree with
  // the Ship-to-FBA queue on the same SKU.
  for (const r of rings) {
    assert.equal(r.wearable_report!.variant_share, exactShares.get(r.sku),
      `${r.sku}: variant_share must be derived from velocity_exact`);
  }
  const ringTotalExact = rings.reduce((a, r) => a + r.velocity_exact!, 0);
  assert.equal(kit.wearable_report!.attach_rate, round4(kit.velocity_exact! / ringTotalExact),
    'the attach rate must be derived from velocity_exact too');

  // And the two derivations really are distinguishable, so the assertions above have teeth. If this
  // ever fails, strengthen the fixture rather than dropping the checks.
  assert.ok(rings.some(r => roundedShares.get(r.sku) !== exactShares.get(r.sku)),
    'fixture must be sensitive to 2dp rounding, or it cannot catch the regression');

  // Belt and braces: rebuilt the way server/wearable-inputs.ts does it, the projection's first
  // transfer is the queue's quantity — the two screens the team compares.
  const inputs: WearableSkuInput[] = wear.map(r => ({
    sku: r.sku, role: r.wearable_report!.is_attach_product ? 'sizing_kit' as const : 'smart_ring' as const,
    velocity: r.velocity_exact, fba_available: r.fba_available, fba_coming: r.fba_coming,
    template: r.template, case_pack: 1, moq: 1,
  }));
  const forecast = { year: 2026, monthlyUnits: [800, 800, 900, 900, 1000, 1000, 1100, 1100, 1200, 1400, 2200, 1800] };
  for (const r of wear) {
    const plan = projectWearableSku(inputs, forecast, TODAY, r.sku, 120);
    assert.equal(plan?.transfers.find(t => t.day === 0)?.qty ?? 0, r.recommended_ship_qty,
      `${r.sku}: the plan's first transfer must equal the Ship-to-FBA queue`);
  }
});
