import type { SnapshotLine, SkuSettings, TemplateParams, OpenPoLine } from './types.ts';
import { addDays } from './dates.ts';

export const COVER_CAP = 9999;

export interface Positions {
  fba_available: number;
  fba_reserved: number;
  fba_inbound: number;
  fba_position: number;
  warehouse_on_hand: number;
  open_po_units: number;
  total_pipeline: number;
  unfulfillable: number;
}

export function computePositions(
  line: SnapshotLine | null,
  warehouseOnHand: number,
  poLines: OpenPoLine[],
): Positions {
  const available = line?.available ?? 0;
  const reserved = line?.reserved ?? 0;
  const inbound = (line?.inbound_working ?? 0) + (line?.inbound_shipped ?? 0) + (line?.inbound_received ?? 0);
  const fba_position = available + reserved + inbound;
  const open_po_units = poLines.reduce((s, l) => s + Math.max(0, l.qty_outstanding), 0);
  return {
    fba_available: available,
    fba_reserved: reserved,
    fba_inbound: inbound,
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

export function fbaRopDays(t: TemplateParams): number {
  return t.fba_ship_checkin_days + t.review_period_fba_days + t.safety_days;
}

export function poRopDays(t: TemplateParams): number {
  return chinaLeadDays(t) + t.review_period_po_days + t.safety_days;
}

// The 1e-9 epsilon keeps float noise (e.g. 14.000000000000014) from inflating a
// quantity by a whole case.
function roundUpTo(qty: number, multiple: number | null | undefined): number {
  const m = multiple && multiple > 1 ? multiple : 1;
  return Math.ceil(qty / m - 1e-9) * m;
}

function roundDownTo(qty: number, multiple: number | null | undefined): number {
  const m = multiple && multiple > 1 ? multiple : 1;
  return Math.floor(qty / m + 1e-9) * m;
}

export interface FbaLaneResult {
  triggered: boolean;
  recommended_ship_qty: number;
  flags: string[];
}

/** Lane 1 — warehouse → FBA. Order-up-to velocity × fba_rop_days, capped by warehouse stock. */
export function fbaLane(
  velocity: number | null,
  fbaDaysCover: number | null,
  fbaPosition: number,
  warehouseOnHand: number,
  t: TemplateParams,
  settings: SkuSettings | undefined,
): FbaLaneResult {
  const flags: string[] = [];
  if (velocity === null || velocity <= 0 || fbaDaysCover === null) {
    return { triggered: false, recommended_ship_qty: 0, flags };
  }
  const rop = fbaRopDays(t);
  if (fbaDaysCover >= rop) return { triggered: false, recommended_ship_qty: 0, flags };

  const raw = Math.max(0, velocity * rop - fbaPosition);
  let qty = roundUpTo(raw, settings?.case_pack);
  if (qty > warehouseOnHand) {
    qty = roundDownTo(warehouseOnHand, settings?.case_pack);
    flags.push('WAREHOUSE_SHORT');
  }
  return { triggered: true, recommended_ship_qty: qty, flags };
}

export interface PoLaneResult {
  triggered: boolean;
  recommended_po_qty: number;
  need_by_arrival: string | null;
  place_by_date: string | null;
  flags: string[];
}

/** Lane 2 — China PO. Order-up-to velocity × po_rop_days against the whole pipeline. */
export function poLane(
  velocity: number | null,
  pipelineDaysCover: number | null,
  totalPipeline: number,
  t: TemplateParams,
  settings: SkuSettings | undefined,
  today: string,
): PoLaneResult {
  const flags: string[] = [];
  if (velocity === null || velocity <= 0 || pipelineDaysCover === null) {
    return { triggered: false, recommended_po_qty: 0, need_by_arrival: null, place_by_date: null, flags };
  }
  const rop = poRopDays(t);
  const lead = chinaLeadDays(t);
  const need_by_arrival = addDays(today, Math.max(0, pipelineDaysCover - t.safety_days));
  const place_by_date = addDays(need_by_arrival, -lead);

  if (pipelineDaysCover >= rop) {
    return { triggered: false, recommended_po_qty: 0, need_by_arrival, place_by_date, flags };
  }

  let qty = Math.max(0, velocity * rop - totalPipeline);
  const moq = settings?.moq ?? 0;
  if (qty > 0 && moq > 0 && qty < moq) {
    qty = moq;
    flags.push('MOQ_PADDED');
  }
  const preRound = qty;
  qty = roundUpTo(qty, settings?.order_multiple ?? settings?.case_pack);
  // Rounding that adds more than 30 days of cover needs a human eye.
  if (qty - preRound > velocity * 30) flags.push('ROUNDING_HEAVY');

  return { triggered: true, recommended_po_qty: Math.round(qty), need_by_arrival, place_by_date, flags };
}

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
