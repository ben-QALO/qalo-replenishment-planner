// The informative WEARABLE plan (smart rings + the sizing kit). Pure, like the rest of the engine.
//
// CORE (silicone) is planned prescriptively by projection.ts. WEARABLE is different: the physical
// warehouse number is shared across retail/Shopify/Amazon and untrusted, and the team plans against
// a board-approved yearly forecast. So instead of one "order N now" integer, this produces a
// rolling-12-month report the team can read and act on:
//
//   • forecast_demand      — the aggregate smart-ring forecast, split to this SKU by velocity share
//   • fba_target_units     — the FBA shelf goal that month (rises/falls with the run rate)
//   • expected_transfer    — the warehouse→FBA top-up they'll likely make that month (whole cases)
//   • recommended_order    — the China order to PLACE that month so it lands ~lead months later
//   • ideal_wh_for_amazon  — the ideal units to hold at the warehouse *for Amazon* at that time
//
// The sizing kit rides along as an attach product: its demand = (attach rate) × aggregate forecast,
// where the attach rate is learned from trailing sales (kit velocity ÷ smart-ring velocity) unless pinned.

import type {
  TemplateParams, WearableMonth, WearableReport, WearableRollup, WearableRole,
  WearablePlan, WearablePlanPoint, WearableTransferEvent,
} from './types.ts';
import { chinaLeadDays } from './replenishment.ts';
import { ceilTo, roundTo, recommendTransfer } from './projection.ts';
import { firstOfMonth, addMonths, monthKey, daysInMonth, addDays, diffDays } from './dates.ts';

const ATTACH_CAP = 2;      // a buyer may take >1 sizing kit, but rarely many — clamp runaway ratios
const HORIZON = 12;        // rolling months shown

export interface WearableSkuInput {
  sku: string;
  role: WearableRole;
  velocity: number | null;       // resolved units/day (after growth); null = unknown
  // Split exactly as the Action Center passes them to recommendTransfer, so the projection's
  // day-0 transfer is the same number the Ship-to-FBA queue shows.
  fba_available: number;         // sellable now at Amazon
  fba_coming: number;            // already on the way to Amazon
  template: TemplateParams;
  case_pack?: number | null;
  moq?: number | null;
  attach_rate_override?: number | null;  // sizing kit only
}

export interface WearablePlanResult {
  reports: Record<string, WearableReport>;
  rollup: WearableRollup;
  /** True when no smart-ring has a sales signal, so the split fell back to equal shares. */
  noSplitSignal: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const posVel = (v: number | null): number => (v !== null && v > 0 ? v : 0);

/** Each smart ring's share of trailing sales; equal split when nothing is selling yet. */
function splitShares<T extends { velocity: number | null }>(smartRings: T[]): { shareOf: (i: T) => number; noSplitSignal: boolean } {
  const totalV = smartRings.reduce((s, i) => s + posVel(i.velocity), 0);
  const noSplitSignal = totalV <= 0;
  return {
    noSplitSignal,
    shareOf: (i: T) => (noSplitSignal ? (smartRings.length ? 1 / smartRings.length : 0) : posVel(i.velocity) / totalV),
  };
}

/** The sizing kit's attach rate: kits sold per smart ring, learned from trailing sales unless pinned. */
function attachRateOf(kit: { velocity: number | null; attach_rate_override?: number | null }, totalRingVelocity: number): number {
  if (kit.attach_rate_override != null && kit.attach_rate_override >= 0) return kit.attach_rate_override;
  if (totalRingVelocity > 0) return clamp(posVel(kit.velocity) / totalRingVelocity, 0, ATTACH_CAP);
  return 0;
}

export interface WearableRateInput {
  sku: string;
  role: WearableRole;
  velocity: number | null;
  template: TemplateParams;
  attach_rate_override?: number | null;
}

/**
 * What fraction of the AGGREGATE smart-ring forecast each WEARABLE SKU carries: a variant's share
 * of trailing sales, or the sizing kit's attach rate. Multiply the aggregate monthly numbers by this
 * to get one SKU's own demand. SKUs with no forecast claim are omitted.
 */
export function wearableDemandFractions(inputs: WearableRateInput[]): Record<string, number> {
  const smartRings = inputs.filter(i => i.role === 'smart_ring');
  const kits = inputs.filter(i => i.role === 'sizing_kit');
  if (smartRings.length === 0) return {};
  const { shareOf } = splitShares(smartRings);
  const totalRingVelocity = smartRings.reduce((s, i) => s + posVel(i.velocity), 0);

  const fracs: Record<string, number> = {};
  for (const ring of smartRings) { const f = shareOf(ring); if (f > 0) fracs[ring.sku] = f; }
  for (const kit of kits) { const f = attachRateOf(kit, totalRingVelocity); if (f > 0) fracs[kit.sku] = f; }
  return fracs;
}

/** Forecast demand for this SKU on a given day-offset from `today`, in units/day. */
export function wearableDemandCurve(
  demandFrac: number,
  forecast: { year: number; monthlyUnits: number[] },
  today: string,
): (dayOffset: number) => number {
  return (dayOffset: number) => {
    const d = addDays(today, dayOffset);
    const y = Number(d.slice(0, 4));
    const mo = Number(d.slice(5, 7));
    const units = (forecast.monthlyUnits[mo - 1] ?? 0) * demandFrac;
    return units / daysInMonth(y, mo);
  };
}

const sumDemand = (demand: (d: number) => number, from: number, days: number): number => {
  let total = 0;
  for (let i = 0; i < days; i++) total += demand(from + i);
  return total;
};

export interface WearableTransferCalc {
  qty: number;
  target_units: number;        // forecast demand across the goal window after arrival
  sales_over_leg: number;      // forecast demand while the shipment is in transit
  projected_on_arrival: number;
  display_rate: number;        // avg units/day over the covered window (for the plain-language "why")
}

/**
 * Size ONE warehouse→FBA transfer for a WEARABLE SKU, decided on day `day`.
 *
 * This deliberately does NOT reuse a single blended velocity. A smart ring's demand can triple
 * between one month and the next, and a shipment spends ~5 weeks in transit — so the demand DURING
 * the leg and the demand AFTER it lands are different numbers. Blending them into one rate
 * under-ships coming out of a peak (December's heavy drawdown gets averaged against a quiet
 * January) and left a real 2–5 week stockout every year. Instead, both terms are summed straight
 * off the forecast curve:
 *
 *   ship = (demand over the goal window after arrival) − (what's left when it lands)
 *   what's left when it lands = on hand + already coming − (demand during the leg)
 *
 * Exact in both directions: it builds ahead of a ramp and stops early into a decline.
 */
export function wearableTransferQty(opts: {
  demand: (dayOffset: number) => number;
  day: number;
  fbaAvailable: number;
  fbaComing: number;
  template: TemplateParams;
  casePack?: number | null;
}): WearableTransferCalc {
  const t = opts.template;
  const leg = Math.max(0, Math.round(t.fba_ship_checkin_days));
  const goalDays = Math.max(1, Math.round(t.fba_target_cover_days));
  const salesOverLeg = sumDemand(opts.demand, opts.day, leg);
  const targetUnits = sumDemand(opts.demand, opts.day + leg, goalDays);
  const projectedOnArrival = opts.fbaAvailable + opts.fbaComing - salesOverLeg;
  const qty = ceilTo(Math.max(0, targetUnits - projectedOnArrival), opts.casePack ?? null);
  return {
    qty,
    target_units: Math.round(targetUnits),
    sales_over_leg: Math.round(salesOverLeg),
    projected_on_arrival: Math.round(projectedOnArrival),
    display_rate: targetUnits / goalDays,
  };
}

/**
 * Day-by-day forward projection for ONE WEARABLE SKU — the single source of truth behind the
 * chart, the every-2-weeks transfer schedule, and the monthly ordering report.
 *
 * Three things make it trustworthy:
 *   • Demand is the FORECAST, day by day, so seasonality is real (Nov ≠ Jan).
 *   • Transfers are decided on the actual review cadence (every review_period_fba_days) by the
 *     SAME `recommendTransfer` the Action Center calls — so the chart cannot disagree with the
 *     Ship-to-FBA queue. Day 0's transfer IS the number shown in the queue today.
 *   • The warehouse is treated as UNLIMITED (the team always ships what Amazon needs), because the
 *     physical NetSuite pool is shared with retail/Shopify and can't be attributed to Amazon.
 *     What the projection reports instead is Amazon's DEMAND on the warehouse.
 */
export function simulateWearableSku(opts: {
  demandFrac: number;                  // share of the aggregate forecast this SKU carries
  forecast: { year: number; monthlyUnits: number[] };
  fbaAvailable: number;                // real, from Amazon
  fbaComing: number;                   // real inbound, from Amazon
  template: TemplateParams;
  casePack?: number | null;
  moq?: number | null;
  today: string;
  horizonDays: number;
}): WearablePlan {
  const { demandFrac, forecast, template: t, today, horizonDays } = opts;
  const leg = Math.max(0, Math.round(t.fba_ship_checkin_days));
  const review = Math.max(1, Math.round(t.review_period_fba_days));
  const settings = { classification: 'replenishable' as const, case_pack: opts.casePack ?? null, moq: opts.moq ?? null };

  const demand = wearableDemandCurve(demandFrac, forecast, today);

  const series: WearablePlanPoint[] = [];
  const transfers: WearableTransferEvent[] = [];
  const inFlight: { arrivesDay: number; qty: number }[] = [];
  let fba = Math.max(0, opts.fbaAvailable);
  let stockoutDay = -1;

  // Units already on the way from Amazon's inbound, treated as landing at the midpoint of the leg
  // (the same convention projectDoNothing uses for CORE).
  if (opts.fbaComing > 0) inFlight.push({ arrivesDay: Math.max(0, Math.round(leg / 2)), qty: opts.fbaComing });

  for (let day = 0; day <= horizonDays; day++) {
    // 1. Arrivals land sellable.
    for (let k = inFlight.length - 1; k >= 0; k--) {
      if (inFlight[k].arrivesDay === day) { fba += inFlight[k].qty; inFlight.splice(k, 1); }
    }
    // 2. Review day → decide a transfer, sized straight off the forecast curve.
    if (day % review === 0) {
      const inTransit = inFlight.reduce((s, f) => s + f.qty, 0);
      const calc = wearableTransferQty({
        demand, day, fbaAvailable: fba, fbaComing: inTransit, template: t, casePack: opts.casePack ?? null,
      });
      if (calc.qty > 0) {
        const arrivesDay = day + leg;
        transfers.push({
          day, date: addDays(today, day), qty: calc.qty,
          arrives_day: arrivesDay, arrives_date: addDays(today, arrivesDay),
        });
        inFlight.push({ arrivesDay, qty: calc.qty });
      }
    }
    // 3. Record the day, then sell through it.
    const dayRate = demand(day);
    series.push({
      day,
      fba: Math.round(fba),
      in_transit: Math.round(inFlight.reduce((s, f) => s + f.qty, 0)),
      // The goal is the units needed to cover the NEXT `fba_target_cover_days` of forecast demand —
      // the same forward-looking quantity the transfer sizing targets. (Using "today's rate × goal
      // days" instead would draw a line the plan never aims at: coming out of a peak it stays high
      // while real demand collapses, making a correctly-drawn-down shelf look like it's failing.)
      goal: Math.round(sumDemand(demand, day, Math.max(1, Math.round(t.fba_target_cover_days)))),
    });
    if (fba <= 0 && stockoutDay < 0 && dayRate > 0) stockoutDay = day;
    fba = Math.max(0, fba - dayRate);
  }

  return {
    series, transfers, stockout_day: stockoutDay, horizon_days: horizonDays,
    review_period_days: review, ship_leg_days: leg, lead_days: chinaLeadDays(t),
  };
}

/**
 * Build the rolling-12-month plan for every WEARABLE SKU.
 * @param inputs   the smart-ring variants + (optionally) the sizing kit
 * @param forecast the aggregate smart-ring forecast: 12 Amazon-basis monthly numbers for `year`
 * @param today    injected YYYY-MM-DD
 */
export function buildWearablePlans(
  inputs: WearableSkuInput[],
  forecast: { year: number; monthlyUnits: number[] },
  today: string,
): WearablePlanResult {
  const smartRings = inputs.filter(i => i.role === 'smart_ring');
  const kits = inputs.filter(i => i.role === 'sizing_kit');

  const totalV = smartRings.reduce((s, i) => s + posVel(i.velocity), 0);
  const { shareOf, noSplitSignal } = splitShares(smartRings);

  const monthStart = firstOfMonth(today);
  // Resolve the aggregate forecast for report-month index `idx`, reusing the same calendar month
  // when the window runs past the forecast year (seasonal reuse), flagged for honesty.
  const forecastAt = (idx: number) => {
    const mDate = addMonths(monthStart, idx);
    const y = Number(mDate.slice(0, 4));
    const calMonth = Number(mDate.slice(5, 7));   // 1..12
    const units = forecast.monthlyUnits[calMonth - 1] ?? 0;
    return { mDate, y, calMonth, units, extrapolated: y !== forecast.year };
  };

  const reports: Record<string, WearableReport> = {};

  // Build one SKU's report. `demandFrac` is the fraction of the aggregate forecast this SKU carries
  // (velocity share for a variant; attach rate for the kit).
  const buildFor = (i: WearableSkuInput, demandFrac: number, isAttach: boolean, attachRate: number | null) => {
    const t = i.template;
    const lead = chinaLeadDays(t);
    const L = Math.max(1, Math.round(lead / 30));      // lead in whole months
    const idealWhDays = lead + t.review_period_po_days + t.safety_days;
    const cp = i.case_pack ?? null;

    // Month-level reference figures out to HORIZON + L, so month M's order (which covers the pull
    // L months later) is defined for every displayed month.
    const N = HORIZON + L;
    const d: number[] = [], fbaTarget: number[] = [], idealWh: number[] = [];
    const extrap: boolean[] = [], mDates: string[] = [];
    for (let m = 0; m < N; m++) {
      const f = forecastAt(m);
      const dm = f.units * demandFrac;
      const dim = daysInMonth(f.y, f.calMonth);
      const rm = dim > 0 ? dm / dim : 0;
      d.push(dm); fbaTarget.push(rm * t.fba_target_cover_days); idealWh.push(rm * idealWhDays);
      extrap.push(f.extrapolated); mDates.push(f.mDate);
    }

    // Amazon's real demand on the warehouse: simulate the actual transfer cadence and total up what
    // each month pulls. Derived from the same projection the chart draws, so the report, the chart
    // and the Ship-to-FBA queue are one model — not three formulas that drift apart.
    const simDays = Math.max(0, diffDays(addMonths(monthStart, N), today));
    const plan = simulateWearableSku({
      demandFrac, forecast, fbaAvailable: i.fba_available, fbaComing: i.fba_coming,
      template: t, casePack: cp, moq: i.moq ?? null, today, horizonDays: simDays,
    });
    const pullByMonth = new Map<string, number>();
    for (const tr of plan.transfers) {
      const k = monthKey(tr.date);
      pullByMonth.set(k, (pullByMonth.get(k) ?? 0) + tr.qty);
    }
    const pull = (m: number): number => pullByMonth.get(monthKey(mDates[m])) ?? 0;

    const months: WearableMonth[] = [];
    let cumulative = 0;
    for (let m = 0; m < HORIZON; m++) {
      const landIdx = m + L;
      // An order placed in month m lands in month m+L, so it must cover the units Amazon pulls that
      // month, plus any growth in the ideal warehouse buffer as the season ramps up.
      const bufferRamp = Math.max(0, idealWh[landIdx] - idealWh[landIdx - 1]);
      const orderRaw = pull(landIdx) + bufferRamp;
      // Flag a month whose own forecast is a seasonal reuse of last year's number (past the forecast year).
      const flags: string[] = extrap[m] ? ['FORECAST_EXTRAPOLATED'] : [];
      cumulative += pull(m);
      months.push({
        month: monthKey(mDates[m]),
        forecast_demand: Math.round(d[m]),
        fba_target_units: Math.round(fbaTarget[m]),
        expected_transfer: pull(m),
        cumulative_transfer: cumulative,
        recommended_order: roundTo(orderRaw, cp),
        order_lands_month: monthKey(mDates[landIdx]),
        must_be_at_warehouse_by: mDates[m],
        ideal_wh_for_amazon: Math.round(idealWh[m]),
        flags: flags.length ? flags : undefined,
      });
    }

    const actualRunRate = posVel(i.velocity) * 30;
    const forecastRunRate = (d[0] + d[1] + d[2]) / 3;
    reports[i.sku] = {
      is_attach_product: isAttach,
      variant_share: round4(isAttach ? (attachRate ?? 0) : demandFrac),
      attach_rate: isAttach ? (attachRate === null ? null : round4(attachRate)) : null,
      lead_days: lead,
      lead_months: L,
      ideal_wh_days: idealWhDays,
      ideal_wh_days_breakdown: { china_lead: lead, review_period_po: t.review_period_po_days, safety: t.safety_days },
      actual_run_rate_month: Math.round(actualRunRate),
      forecast_run_rate_month: Math.round(forecastRunRate),
      multiplier: actualRunRate > 0 ? round2(forecastRunRate / actualRunRate) : null,
      months,
    };
  };

  for (const i of smartRings) buildFor(i, shareOf(i), false, null);

  for (const kit of kits) {
    const attachRate = attachRateOf(kit, totalV);
    buildFor(kit, attachRate, true, attachRate);
  }

  return { reports, rollup: buildRollup(reports, inputs.map(i => i.sku)), noSplitSignal };
}

/**
 * The forward projection for ONE WEARABLE SKU, for the chart + every-2-weeks schedule on its detail
 * page. Takes the whole WEARABLE set because the forecast split depends on the other variants'
 * sales share (and the sizing kit's attach rate). Returns null when `sku` isn't a planned WEARABLE.
 */
export function projectWearableSku(
  inputs: WearableSkuInput[],
  forecast: { year: number; monthlyUnits: number[] },
  today: string,
  sku: string,
  horizonDays: number,
): WearablePlan | null {
  const target = inputs.find(i => i.sku === sku);
  if (!target) return null;
  const smartRings = inputs.filter(i => i.role === 'smart_ring');
  if (smartRings.length === 0) return null;
  const { shareOf } = splitShares(smartRings);
  const totalRingVelocity = smartRings.reduce((s, i) => s + posVel(i.velocity), 0);
  const demandFrac = target.role === 'sizing_kit'
    ? attachRateOf(target, totalRingVelocity)
    : shareOf(target);
  if (demandFrac <= 0) return null;
  return simulateWearableSku({
    demandFrac, forecast,
    fbaAvailable: target.fba_available, fbaComing: target.fba_coming,
    template: target.template, casePack: target.case_pack ?? null, moq: target.moq ?? null,
    today, horizonDays,
  });
}

/** Element-wise sum of the per-SKU months into a single portfolio view. */
function buildRollup(reports: Record<string, WearableReport>, order: string[]): WearableRollup {
  const skus = order.filter(s => reports[s]);
  const list = skus.map(s => reports[s]);
  if (!list.length) return { months: [], total_multiplier: null, skus: [] };

  const H = list[0].months.length;
  const months: WearableMonth[] = [];
  for (let m = 0; m < H; m++) {
    let fd = 0, ft = 0, et = 0, ct = 0, ro = 0, iw = 0;
    const flags = new Set<string>();
    for (const r of list) {
      const mm = r.months[m];
      fd += mm.forecast_demand; ft += mm.fba_target_units; et += mm.expected_transfer;
      ct += mm.cumulative_transfer; ro += mm.recommended_order; iw += mm.ideal_wh_for_amazon;
      (mm.flags ?? []).forEach(f => flags.add(f));
    }
    months.push({
      month: list[0].months[m].month,
      forecast_demand: fd, fba_target_units: ft, expected_transfer: et,
      cumulative_transfer: ct,
      recommended_order: ro, order_lands_month: list[0].months[m].order_lands_month,
      must_be_at_warehouse_by: list[0].months[m].must_be_at_warehouse_by,
      ideal_wh_for_amazon: iw, flags: flags.size ? [...flags] : undefined,
    });
  }
  const totalActual = list.reduce((s, r) => s + r.actual_run_rate_month, 0);
  const totalForecast = list.reduce((s, r) => s + r.forecast_run_rate_month, 0);
  return { months, total_multiplier: totalActual > 0 ? round2(totalForecast / totalActual) : null, skus };
}
