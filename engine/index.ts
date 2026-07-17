import type {
  EngineInput, EngineOutput, EngineSummary, SkuResult, SkuSettings, SnapshotLine, TemplateParams,
} from './types.ts';
import { resolveVelocity } from './velocity.ts';
import {
  computePositions, daysOfCover, earliestArrival,
  fbaRopDays, poRopDays, fbaTargetDays, poTargetDays, chinaLeadDays, COVER_CAP,
} from './replenishment.ts';
import { recommendTransfer, recommendPo, projectDoNothing } from './projection.ts';
import { assignStatus } from './status.ts';
import { addDays, diffDays } from './dates.ts';

const PROJECTION_HORIZON_DAYS = 180;

const TIER_ORDER: Record<string, number> = {
  STOCKOUT: 0, CRITICAL: 1, ORDER_NOW: 2, ORDER_SOON: 3, AT_RISK: 4,
  OVERSTOCK: 5, OK: 6, UNCLASSIFIED: 7, NOT_REPLENISHABLE: 8,
};

function resolveTemplate(
  settings: SkuSettings | undefined,
  global: TemplateParams,
  globalName: string,
): { template: TemplateParams; label: string } {
  let base = global;
  let label = `Global: ${globalName}`;
  if (settings?.template_override) {
    base = settings.template_override;
    label = `SKU: ${settings.template_override_name ?? 'custom'}`;
  }
  const overrides = settings?.param_overrides;
  if (overrides && Object.keys(overrides).length > 0) {
    base = { ...base, ...overrides };
    label += ' + overrides';
  }
  return { template: base, label };
}

export function computeRecommendations(input: EngineInput, today: string): EngineOutput {
  const bySku = new Map<string, SnapshotLine>();
  for (const line of input.lines) bySku.set(line.sku, line);

  const poBySku = new Map<string, typeof input.openPoLines>();
  for (const po of input.openPoLines) {
    if (!poBySku.has(po.sku)) poBySku.set(po.sku, []);
    poBySku.get(po.sku)!.push(po);
  }

  // Every SKU that exists anywhere: in the snapshot or already known to the app.
  const allSkus = new Set<string>([...bySku.keys(), ...Object.keys(input.skuSettings)]);
  const results: SkuResult[] = [];

  for (const sku of allSkus) {
    const line = bySku.get(sku) ?? null;
    const settings = input.skuSettings[sku];
    const classification = settings?.classification ?? 'unclassified';
    const flags: string[] = [...(line?.parse_flags ?? [])];

    if (!line && settings) flags.push('MISSING_FROM_IMPORT');
    if (!settings && line) flags.push('NEW_UNCLASSIFIED');
    if (flags.some(f => f === 'NEGATIVE_QTY_ZEROED' || f === 'BLANK_QTY_ZEROED' || f === 'DUPLICATE_ROW_MERGED')) {
      flags.push('DATA_SUSPECT');
    }

    const { template, label } = resolveTemplate(settings, input.globalTemplate, input.globalTemplateName);
    const vel = resolveVelocity(
      line, settings, input.weights, input.globalGrowthMultiplier,
      input.stockoutCorrection, input.stockoutDays?.[sku],
      input.externalDemand?.[sku],
    );
    flags.push(...vel.flags);
    if (vel.velocity === null && (classification === 'replenishable' || classification === 'watch')) {
      flags.push('NO_VELOCITY');
    }

    const positions = computePositions(
      line, input.warehouse[sku] ?? 0, poBySku.get(sku) ?? [], input.inTransitToFba?.[sku] ?? 0,
    );
    if (positions.unfulfillable >= 5 && line && positions.unfulfillable / Math.max(1, positions.fba_position + positions.unfulfillable) > 0.05) {
      flags.push('UNSELLABLE_HIGH');
    }

    const missingFromImport = flags.includes('MISSING_FROM_IMPORT');
    // A SKU absent from the FBA export but with a Business-Report sales signal is the FBM-tested /
    // out-of-stock-on-FBA case: the Business Report proves the ASIN is actively selling across
    // channels (FBM + FBA), and absence from the FBA export means its FBA stock is genuinely 0. So
    // plan it — ship warehouse stock in, order from China — instead of parking it as stale. A SKU
    // that merely dropped out of the import with no such signal stays suspended (→ AT_RISK).
    const sellingWhileMissing = missingFromImport && flags.includes('BUSINESS_REPORT')
      && vel.velocity !== null && vel.velocity > 0;
    const canPlan = !missingFromImport || sellingWhileMissing;
    const planning = (classification === 'replenishable' || classification === 'watch') && canPlan;

    const fbaCover = daysOfCover(positions.fba_position, vel.velocity);
    const pipelineCover = daysOfCover(positions.total_pipeline, vel.velocity);

    // Open-PO arrival schedule (days from today) for the forward projection.
    const poArrivals = (poBySku.get(sku) ?? [])
      .filter(l => l.qty_outstanding > 0)
      .map(l => ({ day: Math.max(0, l.expected_arrival ? diffDays(l.expected_arrival, today) : chinaLeadDays(template)), qty: l.qty_outstanding }));

    // Overstocked = far more total cover than the plan calls for (same test the OVERSTOCK
    // status uses). When overstocked, don't feed the glut forward: never order from China,
    // and don't ship to FBA either — UNLESS FBA would otherwise run dry before a shipment
    // could arrive (cover below the ship leg + safety), where capturing sales still wins.
    const overstocked = vel.velocity !== null && vel.velocity > 0
      && pipelineCover !== null && pipelineCover > input.overstockFactor * poTargetDays(template);
    const urgentFloorDays = template.fba_ship_checkin_days + template.safety_days;
    const suppressShip = overstocked && fbaCover !== null && fbaCover >= urgentFloorDays;

    // FBM (merchant-fulfilled) SKUs are shipped to customers from the warehouse directly —
    // they must NEVER get a warehouse→FBA transfer. Their demand still folds onto the FBA SKU
    // of the same ASIN (see import/attribute-demand.ts), so the product is planned there.
    const isFbm = settings?.fulfillment_channel === 'fbm';
    const transfer = planning && !isFbm && vel.velocity !== null && vel.velocity > 0 && !suppressShip
      ? recommendTransfer(vel.velocity, positions.fba_available, positions.fba_coming, positions.warehouse_on_hand, template, settings)
      : { required: 0, safe: 0, shortage: 0, recommended_ship_qty: 0 };
    const po = planning && vel.velocity !== null && vel.velocity > 0 && !overstocked
      ? recommendPo(vel.velocity, positions.total_pipeline, positions.fba_position, template, settings, today)
      : { recommended_po_qty: 0, need_by_arrival: null, place_by_date: null, flags: [] };
    if (transfer.shortage > 0) flags.push('WAREHOUSE_SHORT');
    flags.push(...po.flags);

    // Forward runway "if you do nothing new": first day FBA hits zero vs earliest arrival.
    let projectedStockout: string | null = null;
    let gapDays = 0;
    let airSaves: number | null = null;
    let stockoutDay = -1;
    const arrival = earliestArrival(positions, poBySku.get(sku) ?? [], template, input.airTemplate, today);
    const earliestArrivalDays = arrival.earliest_fba_arrival ? Math.max(0, diffDays(arrival.earliest_fba_arrival, today)) : COVER_CAP;
    if (planning && vel.velocity !== null && vel.velocity > 0) {
      const proj = projectDoNothing(
        vel.velocity, positions.fba_available, positions.fba_coming, positions.warehouse_on_hand,
        poArrivals, template, PROJECTION_HORIZON_DAYS,
      );
      stockoutDay = proj.stockoutDay;
      if (stockoutDay >= 0) {
        projectedStockout = addDays(today, stockoutDay);
        if (earliestArrivalDays > stockoutDay) {
          gapDays = earliestArrivalDays - stockoutDay;
          if (arrival.air_earliest) {
            const airGap = Math.max(0, diffDays(arrival.air_earliest, projectedStockout));
            airSaves = gapDays - airGap;
          }
        }
      }
    }

    const price = line?.your_price ?? null;
    const dailyRevenue = (vel.velocity ?? 0) * (price ?? 0);

    const { status, why: whyBase } = assignStatus({
      classification,
      velocity: vel.velocity,
      fba_available: positions.fba_available,
      fba_inbound: positions.fba_inbound,
      fba_position: positions.fba_position,
      warehouse_on_hand: positions.warehouse_on_hand,
      total_pipeline: positions.total_pipeline,
      fba_days_cover: fbaCover,
      pipeline_days_cover: pipelineCover,
      recommended_ship_qty: transfer.recommended_ship_qty,
      transfer_required: transfer.required,
      transfer_safe: transfer.safe,
      transfer_shortage: transfer.shortage,
      recommended_po_qty: po.recommended_po_qty,
      place_by_date: po.place_by_date,
      stockout_day: stockoutDay,
      earliest_arrival_days: earliestArrivalDays,
      air_saves_days: airSaves,
      orderSoonDays: input.orderSoonDays,
      overstockFactor: input.overstockFactor,
      po_target_days: poTargetDays(template),
      template,
      flags,
      case_pack: settings?.case_pack,
    });

    // Make the correction visible in the audit sentence so it's never a black box.
    const why = flags.includes('STOCKOUT_CORRECTED')
      ? `${whyBase} (Velocity uses this item's in-stock sales rate, not the stocked-out average, so it isn't under-ordered.)`
      : whyBase;

    // Revenue-at-risk proxy: daily velocity × price × how deep the problem is.
    const depth = status === 'STOCKOUT' ? 30 : status === 'CRITICAL' ? Math.max(gapDays, 7)
      : status === 'ORDER_NOW' ? 7 : 1;
    const riskScore = (vel.velocity ?? 0.01) * Math.max(price ?? 1, 1) * depth;

    results.push({
      sku,
      title: line?.title ?? settings?.title ?? '',
      classification,
      fulfillment_channel: isFbm ? 'fbm' : 'fba',
      velocity: vel.velocity === null ? null : round2(vel.velocity),
      base_velocity: vel.base_velocity === null ? null : round2(vel.base_velocity),
      velocity_source: vel.source,
      velocity_confidence: vel.confidence,
      growth_multiplier: vel.growth_multiplier,
      window_rates: {
        r7: roundOrNull(vel.window_rates.r7), r30: roundOrNull(vel.window_rates.r30),
        r60: roundOrNull(vel.window_rates.r60), r90: roundOrNull(vel.window_rates.r90),
      },
      fba_available: positions.fba_available,
      fba_reserved: positions.fba_reserved,
      fba_inbound: positions.fba_inbound,
      in_transit_to_fba: positions.in_transit_to_fba,
      fba_coming: positions.fba_coming,
      fba_position: positions.fba_position,
      warehouse_on_hand: positions.warehouse_on_hand,
      open_po_units: positions.open_po_units,
      total_pipeline: positions.total_pipeline,
      unfulfillable: positions.unfulfillable,
      your_price: price,
      fba_days_cover: roundOrNull(fbaCover),
      pipeline_days_cover: roundOrNull(pipelineCover),
      projected_stockout_date: projectedStockout,
      fba_rop_days: fbaRopDays(template),
      po_rop_days: poRopDays(template),
      fba_target_days: fbaTargetDays(template),
      po_target_days: poTargetDays(template),
      china_lead_days: chinaLeadDays(template),
      recommended_ship_qty: transfer.recommended_ship_qty,
      transfer_required: transfer.required,
      transfer_safe: transfer.safe,
      transfer_shortage: transfer.shortage,
      recommended_po_qty: po.recommended_po_qty,
      need_by_arrival: po.need_by_arrival,
      place_by_date: po.place_by_date,
      earliest_fba_arrival: arrival.earliest_fba_arrival,
      stockout_gap_days: Math.round(gapDays),
      air_saves_days: airSaves === null ? null : Math.round(airSaves),
      status,
      flags: [...new Set(flags)],
      why,
      risk_score: round2(riskScore),
      daily_revenue: round2(dailyRevenue),
      template_label: label,
      template,
      include_in_plans: classification === 'replenishable' && canPlan,
      amazon_days_of_supply: line?.amazon_days_of_supply ?? null,
      amazon_min_inventory_level: line?.amazon_min_inventory_level ?? null,
    });
  }

  results.sort((a, b) =>
    (TIER_ORDER[a.status] - TIER_ORDER[b.status]) || (b.risk_score - a.risk_score) || a.sku.localeCompare(b.sku));

  const summary: EngineSummary = {
    stockout: 0, critical: 0, order_now: 0, order_soon: 0, at_risk: 0,
    overstock: 0, ok: 0, unclassified: 0, not_replenishable: 0,
    ship_units_total: 0, ship_skus: 0, po_units_total: 0, po_skus: 0,
  };
  for (const r of results) {
    if (r.status === 'STOCKOUT') summary.stockout++;
    else if (r.status === 'CRITICAL') summary.critical++;
    else if (r.status === 'ORDER_NOW') summary.order_now++;
    else if (r.status === 'ORDER_SOON') summary.order_soon++;
    else if (r.status === 'AT_RISK') summary.at_risk++;
    else if (r.status === 'OVERSTOCK') summary.overstock++;
    else if (r.status === 'OK') summary.ok++;
    else if (r.status === 'UNCLASSIFIED') summary.unclassified++;
    else if (r.status === 'NOT_REPLENISHABLE') summary.not_replenishable++;
    if (r.include_in_plans && r.recommended_ship_qty > 0) {
      summary.ship_units_total += r.recommended_ship_qty;
      summary.ship_skus++;
    }
    if (r.include_in_plans && r.recommended_po_qty > 0) {
      summary.po_units_total += r.recommended_po_qty;
      summary.po_skus++;
    }
  }

  return { snapshotDate: input.snapshotDate, today, results, summary };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const roundOrNull = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

export type { EngineInput, EngineOutput, SkuResult } from './types.ts';
