import type { SnapshotLine, TemplateParams, OpenPoLine } from './types.ts';
import { addDays } from './dates.ts';

export const COVER_CAP = 9999;

export interface Positions {
  fba_available: number;
  fba_reserved: number;
  fba_inbound: number;      // Amazon's reported inbound (working+shipped+received)
  in_transit_to_fba: number; // open warehouse→FBA transfers not yet reconciled
  fba_coming: number;       // max(amazon inbound, in-transit) — each unit counted once
  fba_position: number;     // available + reserved + fba_coming
  warehouse_on_hand: number; // already netted of unreflected transfers
  open_po_units: number;
  total_pipeline: number;
  unfulfillable: number;
}

export function computePositions(
  line: SnapshotLine | null,
  warehouseOnHand: number,
  poLines: OpenPoLine[],
  inTransitToFba = 0,
): Positions {
  const available = line?.available ?? 0;
  const reserved = line?.reserved ?? 0;
  const amazonInbound = (line?.inbound_working ?? 0) + (line?.inbound_shipped ?? 0) + (line?.inbound_received ?? 0);
  // inTransitToFba is already netted upstream (engine/transfers.ts) to the units Amazon has
  // NOT yet taken in since the transfer submitted — so it's disjoint from amazonInbound and
  // from available. Summing therefore counts each in-flight unit exactly once.
  const fba_coming = amazonInbound + inTransitToFba;
  const fba_position = available + reserved + fba_coming;
  const open_po_units = poLines.reduce((s, l) => s + Math.max(0, l.qty_outstanding), 0);
  return {
    fba_available: available,
    fba_reserved: reserved,
    fba_inbound: amazonInbound,
    in_transit_to_fba: inTransitToFba,
    fba_coming,
    fba_position,
    warehouse_on_hand: warehouseOnHand,
    open_po_units,
    total_pipeline: fba_position + warehouseOnHand + open_po_units,
    unfulfillable: line?.unfulfillable ?? 0,
  };
}

/** Units ÷ velocity, capped for JSON safety. null velocity → null (unknown). */
export function daysOfCover(units: number, velocity: number | null): number | null {
  if (velocity === null) return null;
  if (velocity <= 0) return COVER_CAP;
  return Math.min(COVER_CAP, units / velocity);
}

export function chinaLeadDays(t: TemplateParams): number {
  return t.production_days + t.transit_days + t.customs_receiving_days;
}

// Reorder POINT = the floor you must never drop below before a replenishment can land
// (lead + one review cycle + safety). Crossing it triggers a shipment/order.
export function fbaRopDays(t: TemplateParams): number {
  return t.fba_ship_checkin_days + t.review_period_fba_days + t.safety_days;
}

export function poRopDays(t: TemplateParams): number {
  return chinaLeadDays(t) + t.review_period_po_days + t.safety_days;
}

// Order-up-to TARGET = the level each lane tops up TO every review cycle (never below
// the reorder point, so a target set too low can't cause a stockout).
export function fbaTargetDays(t: TemplateParams): number {
  return Math.max(t.fba_target_cover_days, fbaRopDays(t));
}

/**
 * The total-system inventory target, derived from ONE conservation identity rather than
 * assembled by intuition. To hold the FBA goal *on the shelf* while stock flows through
 * the whole chain, the system must fund, all at once, every place a unit can be:
 *
 *   fbaTargetDays              — the shelf goal at Amazon
 * + fba_ship_checkin_days      — units always in transit ON the warehouse→FBA leg
 * + warehouse_buffer_days      — the reserve held at the warehouse
 * + chinaLeadDays              — units always in transit ON the China→warehouse leg
 * + review_period_po_days / 2  — working stock between POs
 *
 * Every term is "v-days of demand that must exist somewhere to keep the shelf full."
 * Omitting any one term structurally starves FBA (the warehouse→FBA leg was the term
 * that, when missing, made FBA settle ~1 month below goal). The invariant test suite
 * (engine/__tests__/plan-invariants) is the guard: if this identity is ever wrong, a
 * SKU's steady-state FBA peak drops below goal and the build fails — no silent drift.
 */
export function derivedPoTargetDays(t: TemplateParams): number {
  return Math.round(
    fbaTargetDays(t)
      + t.fba_ship_checkin_days
      + (t.warehouse_buffer_days ?? 0)
      + chinaLeadDays(t)
      + t.review_period_po_days / 2,
  );
}

export function poTargetDays(t: TemplateParams): number {
  return Math.max(t.target_cover_days, derivedPoTargetDays(t), poRopDays(t));
}

// Note: the warehouse→FBA and China→warehouse *recommendation* math lives in
// engine/projection.ts (the day-by-day model). This file keeps the position/cover
// primitives, the reorder-point/target reference numbers, and the arrival estimate.

export interface ArrivalEstimate {
  earliest_fba_arrival: string | null;
  via: 'warehouse' | 'open_po' | 'new_po' | 'none';
  air_earliest: string | null;
}

/**
 * Earliest date replenishment could land sellable at FBA if the team acts today.
 * Warehouse stock → just the FBA leg; else an open PO's ETA + FBA leg; else a brand-new PO.
 */
export function earliestArrival(
  positions: Positions,
  poLines: OpenPoLine[],
  t: TemplateParams,
  airTemplate: TemplateParams | null | undefined,
  today: string,
): ArrivalEstimate {
  const fbaLeg = t.fba_ship_checkin_days;
  if (positions.warehouse_on_hand > 0) {
    return { earliest_fba_arrival: addDays(today, fbaLeg), via: 'warehouse', air_earliest: null };
  }
  const etas = poLines.filter(l => l.expected_arrival).map(l => l.expected_arrival as string).sort();
  if (etas.length > 0) {
    const eta = etas[0] < today ? today : etas[0]; // overdue PO could land any day
    return { earliest_fba_arrival: addDays(eta, fbaLeg), via: 'open_po', air_earliest: null };
  }
  const oceanArrival = addDays(today, chinaLeadDays(t) + fbaLeg);
  const airArrival = airTemplate
    ? addDays(today, chinaLeadDays(airTemplate) + airTemplate.fba_ship_checkin_days)
    : null;
  return { earliest_fba_arrival: oceanArrival, via: 'new_po', air_earliest: airArrival };
}
