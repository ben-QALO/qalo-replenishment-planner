import type { StatusTier, TemplateParams } from './types.ts';
import { inWords, daysCoverWords } from './projection.ts';

const fmt = (n: number | null, digits = 1): string =>
  n === null ? '—' : n >= 100 ? String(Math.round(n)) : n.toFixed(digits).replace(/\.0$/, '');
const units = (n: number): string => Math.round(n).toLocaleString('en-US');

export interface StatusInput {
  classification: string;
  velocity: number | null;
  fba_available: number;
  fba_inbound: number;
  fba_position: number;
  warehouse_on_hand: number;
  total_pipeline: number;
  fba_days_cover: number | null;
  pipeline_days_cover: number | null;
  // Recommendations already computed by the projection engine.
  recommended_ship_qty: number;
  transfer_required: number;
  transfer_safe: number;
  transfer_shortage: number;
  recommended_po_qty: number;
  place_by_date: string | null;
  // Forward projection ("if you do nothing new").
  stockout_day: number;            // days from today FBA hits 0 (−1 = not within horizon)
  earliest_arrival_days: number;   // soonest new stock can land sellable if you act today
  air_saves_days: number | null;
  orderSoonDays: number;
  overstockFactor: number;
  po_target_days: number;          // effective total target (floored)
  template: TemplateParams;
  flags: string[];
  case_pack?: number | null;
}

export function assignStatus(s: StatusInput): { status: StatusTier; why: string } {
  const t = s.template;
  const v = s.velocity;

  if (s.classification === 'unclassified') {
    return {
      status: 'UNCLASSIFIED',
      why: 'New product from the last import — mark it “replenish” or “ignore” before the tool will plan it.',
    };
  }
  if (s.classification === 'ignore' || s.classification === 'discontinued') {
    return { status: 'NOT_REPLENISHABLE', why: 'Not being replenished — no recommendations are generated.' };
  }
  if (s.flags.includes('MISSING_FROM_IMPORT')) {
    return {
      status: 'AT_RISK',
      why: 'This product wasn’t in the latest Amazon import, so its numbers are stale. Confirm it’s still active or mark it discontinued.',
    };
  }

  // Out of stock at Amazon right now.
  if (s.fba_available === 0 && (v === null || v > 0)) {
    const rate = v === null ? 'an unknown number' : `about ${fmt(v)}`;
    const help = s.warehouse_on_hand > 0
      ? ` You have ${units(s.warehouse_on_hand)} in your warehouse — ship some now.`
      : s.fba_inbound > 0 ? ` ${units(s.fba_inbound)} units are already on the way to Amazon.`
      : ' Nothing is on the way — order from China and consider air freight.';
    return {
      status: 'STOCKOUT',
      why: `Out of stock at Amazon while selling ${rate} a day — you’re losing sales right now.${help}`,
    };
  }

  if (v === null) {
    return { status: 'AT_RISK', why: 'No sales rate yet — set an expected units/day so the tool can plan this product.' };
  }

  const leg = t.fba_ship_checkin_days;
  const rate = `about ${fmt(v)}/day`;
  const have = `Amazon has ${daysCoverWords(s.fba_days_cover)} of stock`;

  // Can't prevent it: FBA runs dry before any new stock can physically land.
  if (s.stockout_day >= 0 && s.earliest_arrival_days > s.stockout_day) {
    const gap = s.earliest_arrival_days - s.stockout_day;
    const air = s.air_saves_days && s.air_saves_days > 0 ? ` Air freight would save ${Math.round(s.air_saves_days)} of those days.` : '';
    return {
      status: 'CRITICAL',
      why: `Selling ${rate}, ${have} and runs out in ${inWords(s.stockout_day)}. The soonest new stock can arrive is ${inWords(s.earliest_arrival_days)}, so you’ll be out ~${Math.round(gap)} days even if you act today.${air}`,
    };
  }

  const cp = s.case_pack && s.case_pack > 1 ? s.case_pack : 0;
  const caseNote = cp ? (s.recommended_ship_qty % cp === 0 ? ` (cases of ${cp})` : ` (partial case of ${cp})`) : '';
  const shipNote = s.recommended_ship_qty > 0
    ? ` Ship ${units(s.recommended_ship_qty)}${caseNote} now so it’s back to your ${t.fba_target_cover_days}-day goal when it lands in ${inWords(leg)}.`
    : '';
  const poNote = s.recommended_po_qty > 0
    ? ` Order ${units(s.recommended_po_qty)} from China${s.place_by_date ? ` (place by ${s.place_by_date})` : ''} — about ${Math.round(s.recommended_po_qty / Math.max(v, 0.01) / 7)} weeks of sales — to refill the warehouse.`
    : '';

  // Warehouse can't cover the shipment FBA needs — a real supply gap, surface it loudly.
  // (The reserve is already dipped in a rescue, so "can give" is the whole warehouse.)
  if (s.transfer_shortage > 0) {
    return {
      status: 'ORDER_NOW',
      why: `Selling ${rate}, ${have}. To hit your goal you'd ship ${units(s.transfer_required)}, but the warehouse only has ${units(s.transfer_safe)} to give — you’re ${units(s.transfer_shortage)} short. Ship what you can and expedite a China order (air freight if needed).${poNote}`,
    };
  }

  // Urgent: a shipment takes `leg` days to land, so cover below that (plus a cushion) means ship today.
  const urgentFloor = leg + t.safety_days;
  const poUrgent = s.pipeline_days_cover !== null && s.pipeline_days_cover < t.production_days + t.transit_days + t.customs_receiving_days + t.safety_days;
  if ((s.fba_days_cover !== null && s.fba_days_cover < urgentFloor) || (poUrgent && s.recommended_po_qty > 0)) {
    return {
      status: 'ORDER_NOW',
      why: `Selling ${rate}, ${have}. A shipment takes ${inWords(leg)} to arrive, so act this cycle.${shipNote}${poNote}`,
    };
  }

  // OVERSTOCK — well above the total target: capital tied up and aged-stock fees ahead.
  const overstockDays = s.overstockFactor * s.po_target_days;
  if (v > 0 && s.pipeline_days_cover !== null && s.pipeline_days_cover > overstockDays) {
    return {
      status: 'OVERSTOCK',
      why: `${daysCoverWords(s.pipeline_days_cover)} of total stock — well past your ${Math.round(s.po_target_days)}-day plan. Capital is tied up and aged-stock fees loom; pause ordering.`,
    };
  }
  if (v === 0 && s.total_pipeline > 0) {
    return { status: 'OVERSTOCK', why: `No sales in 90 days but ${units(s.total_pipeline)} units in the pipeline — consider clearing this stock.` };
  }

  // Approaching the point where a shipment must go — plan it into the next cycle.
  if (s.fba_days_cover !== null && s.fba_days_cover < urgentFloor + s.orderSoonDays) {
    return {
      status: 'ORDER_SOON',
      why: `Selling ${rate}, ${have} — enough for now, but you’ll need to ship within ${s.orderSoonDays} days.${shipNote}`,
    };
  }

  // Healthy. A routine top-up may still be listed to keep FBA at its goal.
  const routine = (shipNote || poNote)
    ? ` Routine top-up:${shipNote}${poNote}`
    : '';
  return {
    status: 'OK',
    why: `Selling ${rate}, ${have} and ${daysCoverWords(s.pipeline_days_cover)} across the whole pipeline — healthy.${routine}`,
  };
}
