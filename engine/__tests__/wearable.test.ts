import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendTransfer } from '../projection.ts';
import {
  buildWearablePlans, simulateWearableSku, wearableDemandFractions, wearableDemandCurve,
  wearableTransferQty, type WearableSkuInput, type WearableRateInput,
} from '../wearable.ts';
import { diffDays } from '../dates.ts';
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

// ── the closed loop: China orders ↔ warehouse ↔ transfers ↔ FBA ───────────────

test('closed loop: the ordering plan actually supports every transfer it promises', () => {
  // The point of showing orders on the chart: prove the chain holds. Once the opening commitment
  // (warehouse_prefill_needed) is in place, the Amazon-earmarked pool must never go under water —
  // otherwise a transfer the plan promises would be physically impossible.
  for (const goal of [60, 90]) {
    const p = sim({ template: { ...WEARABLE, fba_target_cover_days: goal }, fbaAvailable: 600, horizonDays: 240 });
    assert.ok(p.series.every(s => s.warehouse >= 0), `goal=${goal}: warehouse pool must never go negative`);
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
