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
} from './types.ts';
import { chinaLeadDays } from './replenishment.ts';
import { ceilTo, roundTo } from './projection.ts';
import { firstOfMonth, addMonths, monthKey, daysInMonth, addDays } from './dates.ts';

const ATTACH_CAP = 2;      // a buyer may take >1 sizing kit, but rarely many — clamp runaway ratios
const HORIZON = 12;        // rolling months shown

export interface WearableSkuInput {
  sku: string;
  role: WearableRole;
  velocity: number | null;       // resolved units/day (after growth); null = unknown
  fba_position: number;          // sellable + coming, used to seed month-0's transfer
  template: TemplateParams;
  case_pack?: number | null;
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
 * Forecast-derived daily sales rate to SIZE THE FBA TRANSFER for each WEARABLE SKU.
 *
 * Trailing sales are the wrong basis for a seasonal product: a transfer takes ~5 weeks to land, so
 * sizing it on last month's sales ships for the season you're leaving, not the one you're entering
 * (the Oct→Nov peak is exactly where that under-ships). Instead, rate the shipment against the
 * forecast demand for the window it will actually cover: from the day it lands, through the FBA
 * goal it's meant to hold. Returns units/day per SKU; SKUs with no forecast signal are omitted so
 * the caller falls back to trailing velocity.
 */
export function wearableTransferRates(
  inputs: WearableRateInput[],
  forecast: { year: number; monthlyUnits: number[] },
  today: string,
): Record<string, number> {
  const smartRings = inputs.filter(i => i.role === 'smart_ring');
  const kits = inputs.filter(i => i.role === 'sizing_kit');
  if (smartRings.length === 0) return {};
  const { shareOf } = splitShares(smartRings);
  const totalRingVelocity = smartRings.reduce((s, i) => s + posVel(i.velocity), 0);

  // Average daily forecast demand over [start, start + days), walking real calendar months so a
  // window that straddles a seasonal step (e.g. Oct→Nov) is weighted by actual day counts.
  const avgDailyRate = (demandFrac: number, start: string, days: number): number => {
    if (days <= 0 || demandFrac <= 0) return 0;
    let total = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      const y = Number(d.slice(0, 4));
      const mo = Number(d.slice(5, 7));
      const units = (forecast.monthlyUnits[mo - 1] ?? 0) * demandFrac;
      total += units / daysInMonth(y, mo);
    }
    return total / days;
  };

  const rates: Record<string, number> = {};
  const rateFor = (i: WearableRateInput, demandFrac: number) => {
    const t = i.template;
    const arrival = addDays(today, Math.round(t.fba_ship_checkin_days));
    const rate = avgDailyRate(demandFrac, arrival, Math.round(t.fba_target_cover_days));
    if (rate > 0) rates[i.sku] = rate;
  };

  for (const ring of smartRings) rateFor(ring, shareOf(ring));
  for (const kit of kits) rateFor(kit, attachRateOf(kit, totalRingVelocity));
  return rates;
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

    // Compute the extended series out to HORIZON + L so month M's order (driven by demand L months
    // ahead) is defined for all displayed months.
    const N = HORIZON + L;
    const d: number[] = [], rate: number[] = [], fbaTarget: number[] = [], idealWh: number[] = [];
    const expTrans: number[] = [], extrap: boolean[] = [], mDates: string[] = [];
    let prevFbaTarget = i.fba_position;   // seed: where FBA sits now (month -1)
    for (let m = 0; m < N; m++) {
      const f = forecastAt(m);
      const dm = f.units * demandFrac;
      const dim = daysInMonth(f.y, f.calMonth);
      const rm = dim > 0 ? dm / dim : 0;
      const ft = rm * t.fba_target_cover_days;
      d.push(dm); rate.push(rm); fbaTarget.push(ft); idealWh.push(rm * idealWhDays);
      // Replace the month's throughput and re-level the shelf goal as the run rate ramps.
      expTrans.push(ceilTo(Math.max(0, dm + (ft - prevFbaTarget)), cp));
      extrap.push(f.extrapolated); mDates.push(f.mDate);
      prevFbaTarget = ft;
    }

    const months: WearableMonth[] = [];
    for (let m = 0; m < HORIZON; m++) {
      const landIdx = m + L;
      // An order placed in month m lands in month m+L and must fund that month's warehouse outflow
      // (its transfers) plus re-level the ideal warehouse-for-Amazon target as demand ramps.
      const orderRaw = Math.max(0, expTrans[landIdx] + (idealWh[landIdx] - idealWh[landIdx - 1]));
      // Flag a month whose own forecast is a seasonal reuse of last year's number (past the forecast year).
      const flags: string[] = extrap[m] ? ['FORECAST_EXTRAPOLATED'] : [];
      months.push({
        month: monthKey(mDates[m]),
        forecast_demand: Math.round(d[m]),
        fba_target_units: Math.round(fbaTarget[m]),
        expected_transfer: expTrans[m],
        recommended_order: roundTo(orderRaw, cp),
        order_lands_month: monthKey(mDates[landIdx]),
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

/** Element-wise sum of the per-SKU months into a single portfolio view. */
function buildRollup(reports: Record<string, WearableReport>, order: string[]): WearableRollup {
  const skus = order.filter(s => reports[s]);
  const list = skus.map(s => reports[s]);
  if (!list.length) return { months: [], total_multiplier: null, skus: [] };

  const H = list[0].months.length;
  const months: WearableMonth[] = [];
  for (let m = 0; m < H; m++) {
    let fd = 0, ft = 0, et = 0, ro = 0, iw = 0;
    const flags = new Set<string>();
    for (const r of list) {
      const mm = r.months[m];
      fd += mm.forecast_demand; ft += mm.fba_target_units; et += mm.expected_transfer;
      ro += mm.recommended_order; iw += mm.ideal_wh_for_amazon;
      (mm.flags ?? []).forEach(f => flags.add(f));
    }
    months.push({
      month: list[0].months[m].month,
      forecast_demand: fd, fba_target_units: ft, expected_transfer: et,
      recommended_order: ro, order_lands_month: list[0].months[m].order_lands_month,
      ideal_wh_for_amazon: iw, flags: flags.size ? [...flags] : undefined,
    });
  }
  const totalActual = list.reduce((s, r) => s + r.actual_run_rate_month, 0);
  const totalForecast = list.reduce((s, r) => s + r.forecast_run_rate_month, 0);
  return { months, total_multiplier: totalActual > 0 ? round2(totalForecast / totalActual) : null, skus };
}
