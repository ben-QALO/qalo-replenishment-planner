import type { StatusTier, TemplateParams } from './types.ts';

const fmt = (n: number | null, digits = 1): string =>
  n === null ? '—' : n >= 100 ? String(Math.round(n)) : n.toFixed(digits).replace(/\.0$/, '');

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
  fba_rop_days: number;
  po_rop_days: number;
  fba_target_days: number;
  po_target_days: number;
  fbaTriggered: boolean;
  poTriggered: boolean;
  recommended_ship_qty: number;
  recommended_po_qty: number;
  stockout_gap_days: number;
  air_saves_days: number | null;
  orderSoonDays: number;
  overstockFactor: number;
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
      why: 'New SKU from the last import — classify it as replenishable or ignore before it can be planned.',
    };
  }
  if (s.classification === 'ignore' || s.classification === 'discontinued') {
    return { status: 'NOT_REPLENISHABLE', why: 'Marked as not replenished — no recommendations are generated.' };
  }

  const fbaRopExplain = `${t.fba_ship_checkin_days} ship + ${t.review_period_fba_days} review + ${t.safety_days} safety`;
  const poRopExplain = `${t.production_days + t.transit_days + t.customs_receiving_days} China lead + ${t.review_period_po_days} review + ${t.safety_days} safety`;

  // Missing from the latest import: all Amazon quantities are unknown, not zero —
  // this must NOT read as a stockout.
  if (s.flags.includes('MISSING_FROM_IMPORT')) {
    return {
      status: 'AT_RISK',
      why: 'This SKU did not appear in the latest Amazon import — its numbers are stale. Confirm it is still active or mark it discontinued.',
    };
  }

  // STOCKOUT — selling (or unknown) but nothing available right now.
  if (s.fba_available === 0 && (v === null || v > 0)) {
    const inboundNote = s.fba_inbound > 0 ? ` ${s.fba_inbound} units are inbound to Amazon.` : '';
    const whNote = s.warehouse_on_hand > 0
      ? ` ${s.warehouse_on_hand} units are in your warehouse — ship now.`
      : s.total_pipeline - s.fba_position > 0 ? '' : ' Nothing anywhere in the pipeline — order from China.';
    return {
      status: 'STOCKOUT',
      why: `0 units available at Amazon while selling ${v === null ? 'an unknown rate' : `${fmt(v)}/day`} — losing sales right now.${inboundNote}${whNote}`,
    };
  }

  // Data problems that block planning.
  if (v === null) {
    return {
      status: 'AT_RISK',
      why: 'No sales velocity available — set an expected daily rate so this SKU can be planned.',
    };
  }

  // CRITICAL — even acting today leaves a stockout gap.
  if (s.stockout_gap_days > 0) {
    const air = s.air_saves_days && s.air_saves_days > 0
      ? ` Air freight would save ${Math.round(s.air_saves_days)} of those days.`
      : '';
    return {
      status: 'CRITICAL',
      why: `At ${fmt(v)}/day, Amazon stock runs out ~${Math.round(s.stockout_gap_days)} days before the earliest possible replenishment can land, even if you act today.${air}`,
    };
  }

  if (s.fbaTriggered || s.poTriggered) {
    const parts: string[] = [];
    if (s.fbaTriggered) {
      parts.push(
        `${s.fba_position} at/heading to Amazon = ${fmt(s.fba_days_cover)} days of cover, below the ${Math.round(s.fba_rop_days)}-day reorder point (${fbaRopExplain}) → ship ${s.recommended_ship_qty}${s.case_pack && s.case_pack > 1 ? ` (cases of ${s.case_pack})` : ''} to reach your ${Math.round(s.fba_target_days)}-day FBA target`,
      );
    }
    if (s.poTriggered) {
      parts.push(
        `total pipeline ${s.total_pipeline} = ${fmt(s.pipeline_days_cover)} days, below the ${Math.round(s.po_rop_days)}-day PO point (${poRopExplain}) → order ${s.recommended_po_qty} to reach your ${Math.round(s.po_target_days)}-day total target`,
      );
    }
    return { status: 'ORDER_NOW', why: `At ${fmt(v)}/day: ${parts.join('; ')}.` };
  }

  // ORDER_SOON — inside the pre-warning window on either lane.
  const fbaSoon = s.fba_days_cover !== null && s.fba_days_cover < s.fba_rop_days + s.orderSoonDays;
  const poSoon = s.pipeline_days_cover !== null && s.pipeline_days_cover < s.po_rop_days + s.orderSoonDays;
  if (fbaSoon || poSoon) {
    const lane = fbaSoon
      ? `FBA cover (${fmt(s.fba_days_cover)} days) reaches its ${Math.round(s.fba_rop_days)}-day reorder point`
      : `pipeline cover (${fmt(s.pipeline_days_cover)} days) reaches its ${Math.round(s.po_rop_days)}-day PO point`;
    return { status: 'ORDER_SOON', why: `Within ${s.orderSoonDays} days, ${lane} — plan it into the next cycle.` };
  }

  // OVERSTOCK — capital and FBA storage fees.
  const overstockDays = s.overstockFactor * t.target_cover_days;
  if (v > 0 && s.pipeline_days_cover !== null && s.pipeline_days_cover > overstockDays) {
    return {
      status: 'OVERSTOCK',
      why: `${fmt(s.pipeline_days_cover)} days of total cover vs a ${Math.round(t.target_cover_days)}-day target — capital tied up and aged-inventory fees ahead. Pause replenishment.`,
    };
  }
  if (v === 0 && s.total_pipeline > 0) {
    return {
      status: 'OVERSTOCK',
      why: `No sales in 90 days but ${s.total_pipeline} units in the pipeline — consider clearing or removing this stock.`,
    };
  }

  return {
    status: 'OK',
    why: `${fmt(s.fba_days_cover)} days of FBA cover and ${fmt(s.pipeline_days_cover)} days of pipeline cover — both above their reorder points.`,
  };
}
