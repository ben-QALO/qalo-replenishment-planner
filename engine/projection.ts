// The decision core: a day-by-day forward projection of a single SKU's inventory.
//
// Instead of comparing today's total against abstract "reorder points" and "targets",
// this plays the SKU's real sales and real lead times forward through time and asks the
// only question that matters: *will FBA or the warehouse drop below its required level
// before the next replenishment can arrive?* Every recommended number is the amount that
// prevents the first shortfall — and traces to a date you can see on the runway chart.
//
// Two locations move through time:
//   • a China PO lands at the WAREHOUSE  after china_lead days
//   • a warehouse transfer lands sellable at FBA after fba_ship_checkin days (~5 weeks)
//   • sales draw down FBA every day
//
// FBA target semantics = "refill on arrival, draw down between" (Option 1): each transfer
// brings FBA back up to the target *as it lands*, then it declines until the next one.
// Validated by simulation across cold-start / at-target / overstocked states: zero
// stockouts, warehouse buffer never breached, steady state ≈ one cycle of demand per order.

import type { TemplateParams, SkuSettings } from './types.ts';
import { addDays } from './dates.ts';
import { chinaLeadDays, poTargetDays, derivedPoTargetDays, fbaTargetDays } from './replenishment.ts';

const ceilTo = (qty: number, m: number | null | undefined): number => {
  const mult = m && m > 1 ? m : 1;
  return (Math.ceil(qty / mult - 1e-9) * mult) || 0;   // `|| 0` normalizes -0 → 0
};

// Round to the NEAREST whole case (half up), not always up. Used for China POs so a need of 53
// settles to one 50-case (not 100) while 75 still rounds up to 100 — avoids burying slow movers in
// a spare case for being barely over a line. The MOQ floor still applies before this, so the result
// is never below one case. Transfers keep ceilTo (whole cases; too-slow SKUs ship nothing to FBA).
const roundTo = (qty: number, m: number | null | undefined): number => {
  const mult = m && m > 1 ? m : 1;
  return (Math.floor(qty / mult + 0.5) * mult) || 0;   // `|| 0` normalizes -0 → 0
};

export interface TransferRec {
  /** Units it would take to hit the FBA target when this shipment lands. */
  required: number;
  /** Units the warehouse can spare without dipping into its reserve. */
  safe: number;
  /** How much the warehouse is short of the requirement (0 when it can cover). */
  shortage: number;
  /** What to actually ship this cycle. Whole cases only, except a rescue may ship a loose partial
   *  to keep FBA from going dark. */
  recommended_ship_qty: number;
  /** True when the SKU is too slow to justify stocking at FBA (one case > 6 months of cover) and
   *  no rescue is needed — the tool ships nothing and leaves it merchant-fulfilled. */
  too_slow_for_fba?: boolean;
}

/**
 * Warehouse → FBA. Bring FBA back to its target *as the shipment lands* (Option 1):
 *   ship = FBA_target − (sellable_now + already_coming − sales_over_the_transfer_leg)
 * Capped at what the warehouse can spare above its reserve; the shortfall is reported,
 * never silently hidden.
 */
export function recommendTransfer(
  velocity: number,
  fbaAvailable: number,
  fbaComing: number,
  warehouseOnHand: number,
  t: TemplateParams,
  settings: SkuSettings | undefined,
): TransferRec {
  const fbaTargetUnits = Math.round(velocity * t.fba_target_cover_days);
  // Never ship to FBA when it already holds its goal (in days) or more. Without this,
  // the lead-time top-up plus case-pack rounding can push an at-goal slow mover far past
  // its goal — e.g. a 0.03/day item at 93 days getting a full 50-unit case.
  if (fbaAvailable + fbaComing >= fbaTargetUnits) {
    return { required: 0, safe: 0, shortage: 0, recommended_ship_qty: 0 };
  }
  const salesOverLeg = velocity * t.fba_ship_checkin_days;
  const projectedOnArrival = fbaAvailable + fbaComing - salesOverLeg;
  const rawNeed = Math.max(0, fbaTargetUnits - projectedOnArrival);

  // "Rescue" = FBA won't survive the ship leg PLUS one more review cycle, so a shipment
  // decided now must go or FBA goes dark before the next chance. (Leg + review, not just
  // leg — reviews are periodic, so the trigger must give a full cycle of headroom, or a
  // trickle-seller fires a cycle too late and grazes zero.)
  const rescue = fbaAvailable + fbaComing < velocity * (t.fba_ship_checkin_days + t.review_period_fba_days);

  // WHOLE CASES ONLY — a loose (sub-case) pick to FBA is too costly to be worth it.
  //   • Too slow for FBA: if even ONE case would be more than 6 months of FBA cover, the demand
  //     isn't there to justify stocking it at Amazon — ship nothing and leave it merchant-fulfilled
  //     (the China PO still keeps a case in the warehouse). Flagged, not force-switched.
  //   • Otherwise ship whole cases toward the 90-day goal.
  // The ONE exception is a rescue (FBA would go dark before the next cycle): a loose partial is
  // then allowed, because staying in stock beats saving the loose-pick cost.
  const cp = settings?.case_pack && settings.case_pack > 1 ? settings.case_pack : 1;
  const SIX_MONTHS_DAYS = 183;
  // Too slow for FBA: never ship it there (even if FBA is low) — it's fulfilled by merchant from
  // the warehouse, so an empty FBA shelf is fine. The rescue exception below is for real movers
  // whose warehouse is momentarily short, not for SKUs we've decided not to stock at Amazon.
  const tooSlowForFba = cp > velocity * SIX_MONTHS_DAYS;   // one whole case > 6 months of cover
  if (tooSlowForFba) {
    return { required: 0, safe: 0, shortage: 0, recommended_ship_qty: 0, too_slow_for_fba: true };
  }
  const required = ceilTo(rawNeed, cp);

  // Warehouse spare. The reserve is a SOFT floor a rescue may ship into so Amazon never goes dark.
  const bufferUnits = Math.round(velocity * t.warehouse_buffer_days);
  const safe = rescue ? Math.max(0, warehouseOnHand) : Math.max(0, warehouseOnHand - bufferUnits);

  // Normal: ship WHOLE cases only (round the shippable amount down to a case). The one exception is
  // a true stockout rescue — FBA would hit ZERO before this shipment can land (won't survive the
  // ship leg): then ship whatever the warehouse can spare, loose partial included, rather than let
  // Amazon go dark. (This is a tighter bar than the reserve-dip `rescue`, so partials stay rare.)
  const stockoutImminent = fbaAvailable + fbaComing < velocity * t.fba_ship_checkin_days;
  const recommended = stockoutImminent
    ? Math.min(required, safe)
    : Math.min(required, Math.floor(safe / cp) * cp);
  return { required, safe, shortage: Math.max(0, required - recommended), recommended_ship_qty: recommended };
}

export interface PoRec {
  recommended_po_qty: number;
  need_by_arrival: string | null;
  place_by_date: string | null;
  flags: string[];
}

/**
 * China → warehouse, sized against the WHOLE SYSTEM's need, not the warehouse's local
 * refill. The system must hold, across all locations at once:
 *   FBA goal + warehouse reserve + goods perpetually in transit (China lead) + ½ PO cycle
 * so the order is simply:
 *   po = system_target − everything you have or have ordered (total pipeline position)
 * One formula covers both modes: in a deficit it closes the ENTIRE hole in one PO —
 * placed TODAY, because the missing units are needed at Amazon now, not when aggregate
 * cover runs out. In steady state the position drains by one review-cycle of demand
 * between POs, so it settles to ~one month of demand per monthly PO. (Validated from
 * day 0 on deficit-recovery scenarios, MFL10's exact numbers included.)
 */
export function recommendPo(
  velocity: number,
  pipelinePosition: number,   // FBA position + warehouse + all open POs
  fbaPosition: number,        // sellable + on the way to Amazon (deficit ⇒ order today)
  t: TemplateParams,
  settings: SkuSettings | undefined,
  today: string,
): PoRec {
  const flags: string[] = [];
  const lead = chinaLeadDays(t);
  const systemTargetUnits = velocity * derivedPoTargetDays(t);
  const fbaDeficit = Math.max(0, Math.round(velocity * fbaTargetDays(t)) - fbaPosition);

  let qty = Math.max(0, systemTargetUnits - pipelinePosition);
  // Deadband when healthy: don't nag for less than half a PO cycle. A deficit always shows.
  if (fbaDeficit <= 0 && qty < velocity * (t.review_period_po_days / 2)) qty = 0;

  const moq = settings?.moq ?? 0;
  if (qty > 0 && moq > 0 && qty < moq) { qty = moq; flags.push('MOQ_PADDED'); }
  const preRound = qty;
  qty = roundTo(qty, settings?.order_multiple ?? settings?.case_pack);   // nearest case, not always up
  if (qty > 0 && qty - preRound > velocity * 30) flags.push('ROUNDING_HEAVY');

  // Dates. Deficit: place TODAY — every day of delay extends the gap at Amazon.
  // Healthy: the day the pipeline runs to its safety level, minus the lead.
  let need_by_arrival: string;
  let place_by_date: string;
  if (fbaDeficit > 0 && qty > 0) {
    place_by_date = today;
    need_by_arrival = addDays(today, lead);   // realistic landing if placed today
  } else {
    const cover = velocity > 0 ? pipelinePosition / velocity : 0;
    need_by_arrival = addDays(today, Math.max(0, cover - t.safety_days));
    place_by_date = addDays(need_by_arrival, -lead);
  }

  return { recommended_po_qty: Math.round(qty), need_by_arrival, place_by_date, flags };
}

export interface DayPoint {
  day: number;
  fba: number;              // sellable at Amazon
  warehouse: number;        // physical in your warehouse
  inTransit?: number;       // heading to Amazon (warehouse→FBA leg)
  onOrder?: number;         // on the water from China
}

export interface Projection {
  /** First day FBA hits zero if nothing new is shipped (−1 if it never does in horizon). */
  stockoutDay: number;
  /** First day FBA drops below the target line, do-nothing (−1 if never). */
  belowTargetDay: number;
  series: DayPoint[];
}

/**
 * Forward runway "if you do nothing new": current sellable FBA + already-coming units
 * (spread across the transfer leg) − daily sales; warehouse only receives open POs.
 * Used for the stockout date, the CRITICAL check, and the runway chart baseline.
 */
export function projectDoNothing(
  velocity: number,
  fbaAvailable: number,
  fbaComing: number,
  warehouseOnHand: number,
  openPoArrivals: { day: number; qty: number }[],
  t: TemplateParams,
  horizonDays: number,
): Projection {
  const fbaTargetUnits = velocity * t.fba_target_cover_days;
  // Approximate the arrival of already-in-flight units: no per-unit ETA exists, so land
  // them at the midpoint of the transfer leg — a central estimate, not a cliff.
  const comingDay = Math.max(1, Math.round(t.fba_ship_checkin_days / 2));
  const series: DayPoint[] = [];
  let fba = fbaAvailable, wh = warehouseOnHand;
  let stockoutDay = -1, belowTargetDay = -1;
  const posByDay = new Map<number, number>();
  for (const a of openPoArrivals) posByDay.set(a.day, (posByDay.get(a.day) ?? 0) + a.qty);

  for (let d = 0; d <= horizonDays; d++) {
    if (d === comingDay) fba += fbaComing;
    if (posByDay.has(d)) wh += posByDay.get(d)!;
    if (belowTargetDay < 0 && fba < fbaTargetUnits) belowTargetDay = d;
    if (stockoutDay < 0 && fba <= 0 && velocity > 0) stockoutDay = d;
    series.push({ day: d, fba: Math.max(0, fba), warehouse: Math.max(0, wh) });
    fba = Math.max(0, fba - velocity);
  }
  return { stockoutDay, belowTargetDay, series };
}

export interface PlanEvent {
  day: number;
  kind: 'ship' | 'transfer_arrives' | 'po_placed' | 'po_arrives';
  qty: number;
  /** For ARRIVAL events only: the day the order/shipment that's landing was initiated —
   *  i.e. `day − lead time`. Negative means it was placed before today (an order already in
   *  flight). Lets the chart trace a warehouse/FBA rise back to its true cause in time. */
  fromDay?: number;
}

export interface PlanProjection {
  series: DayPoint[];
  events: PlanEvent[];
  /** Units at the FBA goal line (velocity × goal days), for the chart's reference line. */
  goalUnits: number;
}

/**
 * Forward projection "if you follow the plan": replays the SAME recommendation functions
 * the queues use — a transfer every FBA review cycle (landing after the ship leg), a PO
 * every PO review cycle (landing after the China lead), overstock suppression included —
 * so the chart is the plan itself, not an approximation of it. Day 0 executes today's
 * on-screen recommendation; later cycles re-decide from the simulated state, exactly as
 * the tool would on those future dates.
 */
export function projectPlan(
  velocity: number,
  fbaAvailable: number,
  fbaComing: number,
  warehouseOnHand: number,
  openPoArrivals: { day: number; qty: number; placedDay?: number }[],
  t: TemplateParams,
  settings: SkuSettings | undefined,
  horizonDays: number,
  overstockFactor: number,
): PlanProjection {
  const goalUnits = Math.round(velocity * t.fba_target_cover_days);
  const comingDay = Math.max(1, Math.round(t.fba_ship_checkin_days / 2));
  const lead = chinaLeadDays(t);
  const urgentFloorDays = t.fba_ship_checkin_days + t.safety_days;

  const series: DayPoint[] = [];
  const events: PlanEvent[] = [];
  let fba = fbaAvailable, wh = warehouseOnHand;
  let comingLeft = fbaComing;                       // in-flight units, land mid-leg
  // `placed` = the day this shipment/order was initiated, so an arrival can name its cause.
  let transfers: { arrive: number; qty: number; placed: number }[] = [];
  let pos: { arrive: number; qty: number; placed: number }[] = openPoArrivals
    .filter(a => a.qty > 0)
    .map(a => ({ arrive: Math.max(0, a.day), qty: a.qty, placed: a.placedDay ?? Math.max(0, a.day) - lead }));

  for (let d = 0; d <= horizonDays; d++) {
    // Arrivals land at the start of the day. `fromDay` traces each one back to when its
    // order/shipment left — for the in-flight units, one ship-leg before they land.
    if (d === comingDay && comingLeft > 0) { fba += comingLeft; events.push({ day: d, kind: 'transfer_arrives', qty: comingLeft, fromDay: d - t.fba_ship_checkin_days }); comingLeft = 0; }
    transfers = transfers.filter(x => {
      if (x.arrive === d) { fba += x.qty; events.push({ day: d, kind: 'transfer_arrives', qty: x.qty, fromDay: x.placed }); return false; }
      return true;
    });
    pos = pos.filter(x => {
      if (x.arrive <= d) { wh += x.qty; events.push({ day: d, kind: 'po_arrives', qty: x.qty, fromDay: x.placed }); return false; }
      return true;
    });

    // Review days: act exactly as the tool would, from the simulated state.
    const inTransit = comingLeft + transfers.reduce((s, x) => s + x.qty, 0);
    const openPo = pos.reduce((s, x) => s + x.qty, 0);
    const pipelineCover = velocity > 0 ? (fba + inTransit + wh + openPo) / velocity : Infinity;
    const overstocked = pipelineCover > overstockFactor * poTargetDays(t);

    if (d % t.review_period_fba_days === 0) {
      const fbaCover = velocity > 0 ? (fba + inTransit) / velocity : Infinity;
      const suppressShip = overstocked && fbaCover >= urgentFloorDays;
      if (!suppressShip) {
        const rec = recommendTransfer(velocity, fba, inTransit, wh, t, settings);
        if (rec.recommended_ship_qty > 0) {
          wh -= rec.recommended_ship_qty;
          transfers.push({ arrive: d + t.fba_ship_checkin_days, qty: rec.recommended_ship_qty, placed: d });
          events.push({ day: d, kind: 'ship', qty: rec.recommended_ship_qty });
        }
      }
    }
    if (d % t.review_period_po_days === 0 && !overstocked) {
      // Recompute the position: the transfer decision above moved units into transit —
      // still in the pipeline (a transfer never changes the total).
      const inTransit2 = comingLeft + transfers.reduce((s, x) => s + x.qty, 0);
      const openPo2 = pos.reduce((s, x) => s + x.qty, 0);
      const rec = recommendPo(velocity, fba + inTransit2 + wh + openPo2, fba + inTransit2, t, settings, '2026-01-01');
      if (rec.recommended_po_qty > 0) {
        pos.push({ arrive: d + lead, qty: rec.recommended_po_qty, placed: d });
        events.push({ day: d, kind: 'po_placed', qty: rec.recommended_po_qty });
      }
    }

    series.push({
      day: d,
      fba: Math.max(0, Math.round(fba)),
      inTransit: Math.max(0, Math.round(comingLeft + transfers.reduce((s, x) => s + x.qty, 0))),
      warehouse: Math.max(0, Math.round(wh)),
      onOrder: Math.max(0, Math.round(pos.reduce((s, x) => s + x.qty, 0))),
    });
    fba = Math.max(0, fba - velocity);
  }
  return { series, events, goalUnits };
}

export interface PlanHealth {
  steadyPeakFrac: number;      // steady-state max FBA ÷ goal (should be ≥ 1.0)
  steadyTroughFrac: number;    // steady-state min FBA ÷ goal
  totalDarkDays: number;
  darkDaysAfterSettle: number; // dark days once the chain has had time to respond
  ok: boolean;
  violations: string[];
}

/**
 * The invariant gate. Runs against a projectPlan() result and answers the only questions
 * that matter for trust: does following the plan hold Amazon at its goal, and does Amazon
 * ever go dark once the supply chain has had time to respond? This is what turns "trust
 * the formula" into "prove it on every SKU" — the test suite runs this across archetypes,
 * and a violation fails the build instead of surfacing as a lost-sales surprise weeks later.
 *
 *  - steadyPeakFrac < peakTolerance  → the system is under-provisioned (the class of bug
 *    where FBA settles below goal because a target term was missing).
 *  - darkDaysAfterSettle > 0         → the plan lets Amazon go dark when it shouldn't.
 * Dark days before `settleDay` are treated as physics (you can't out-run the boat) and
 * are reported but not a violation.
 */
export function planHealth(
  plan: PlanProjection,
  opts: { velocity: number; settleDay: number; peakTolerance?: number },
): PlanHealth {
  // 0.90 default: case packs mean the sawtooth peak lands within ~one case of goal, so
  // 100% isn't reachable; 90% still decisively separates "holding goal" from the old
  // ~70% under-provisioning bug. Steady window starts once the chain has fully responded.
  const { velocity, settleDay, peakTolerance = 0.9 } = opts;
  const S = plan.series;
  const goal = plan.goalUnits || 1;
  const steady = S.slice(Math.floor(S.length * 0.66));
  const steadyPeakFrac = Math.max(...steady.map(p => p.fba)) / goal;
  const steadyTroughFrac = Math.min(...steady.map(p => p.fba)) / goal;
  let totalDarkDays = 0, darkDaysAfterSettle = 0;
  if (velocity > 0) {
    for (const p of S) {
      if (p.fba <= 0) { totalDarkDays++; if (p.day > settleDay) darkDaysAfterSettle++; }
    }
  }
  const violations: string[] = [];
  if (steadyPeakFrac < peakTolerance) violations.push(`steady-state FBA peaks at ${Math.round(steadyPeakFrac * 100)}% of goal (need ≥ ${Math.round(peakTolerance * 100)}%)`);
  if (darkDaysAfterSettle > 0) violations.push(`${darkDaysAfterSettle} dark day(s) after the chain could respond`);
  return { steadyPeakFrac, steadyTroughFrac, totalDarkDays, darkDaysAfterSettle, ok: violations.length === 0, violations };
}

/* ── Plain-language helpers ──────────────────────────────────────────────────
   No jargon. Days are also expressed in the cadence the user thinks in.        */

/** e.g. 35 → "about 5 weeks", 60 → "about 2 months", 14 → "2 weeks". */
export function inWords(days: number): string {
  if (days <= 0) return 'now';
  if (days < 21) return `${Math.round(days / 7)} week${Math.round(days / 7) === 1 ? '' : 's'}`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks`;
  return `about ${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'}`;
}

export function daysCoverWords(days: number | null): string {
  if (days === null) return 'an unknown amount';
  if (days >= 9999) return 'effectively unlimited';
  if (days < 21) return `about ${Math.round(days)} days`;
  return `about ${Math.round(days / 7)} weeks`;
}
