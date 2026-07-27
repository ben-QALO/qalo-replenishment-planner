// Engine contract. The engine is pure: no I/O, no DB, no Date.now() — `today` is injected.

export type Classification = 'unclassified' | 'replenishable' | 'watch' | 'discontinued' | 'ignore';

export interface TemplateParams {
  production_days: number;
  transit_days: number;
  customs_receiving_days: number;
  fba_ship_checkin_days: number;
  safety_days: number;
  fba_target_cover_days: number;  // FBA goal — days to hold at Amazon (refill to this as a shipment lands)
  warehouse_buffer_days: number;  // reserve to hold at the own warehouse; also sizes China POs
  target_cover_days: number;      // overstock ceiling for the whole pipeline; floored at the derived minimum (does not drive ordering)
  review_period_fba_days: number;
  review_period_po_days: number;
}

export interface VelocityWeights {
  w7: number;
  w30: number;
  w60: number;
  w90: number;
}

/** One row of the latest FBA inventory snapshot, already normalized by the importer. */
export interface SnapshotLine {
  sku: string;
  title?: string;
  available: number;
  inbound_working: number;
  inbound_shipped: number;
  inbound_received: number;
  reserved: number;
  unfulfillable: number;
  units_shipped_t7: number | null;
  units_shipped_t30: number | null;
  units_shipped_t60: number | null;
  units_shipped_t90: number | null;
  amazon_days_of_supply?: number | null;
  amazon_min_inventory_level?: number | null;
  your_price?: number | null;
  parse_flags?: string[];
}

export type ProductCategory = 'core' | 'wearable';
export type WearableRole = 'smart_ring' | 'sizing_kit';

export interface SkuSettings {
  classification: Classification;
  /** 'fba' (ship warehouse stock to Amazon) or 'fbm' (merchant-fulfilled — never ship to FBA). */
  fulfillment_channel?: 'fba' | 'fbm';
  /** 'core' (silicone — planned exactly as today) or 'wearable' (smart rings + sizing kit —
   *  warehouse ignored, China PO becomes an informative forecast report). Defaults to 'core'. */
  category?: ProductCategory;
  /** For WEARABLE only: 'smart_ring' (a SLIM/OG variant the aggregate forecast splits across)
   *  or 'sizing_kit' (R-RNGSZ-03, planned as an attach product). */
  wearable_role?: WearableRole | null;
  /** Pin the sizing kit's attach rate (kit units per smart-ring unit) instead of learning it. */
  attach_rate_override?: number | null;
  /** QALO internal SKU (team-facing). Falls back to the Amazon SKU when unmapped. */
  qalo_sku?: string;
  /** Authoritative ASIN from the SKU map (falls back to the catalog's ASIN). */
  asin?: string | null;
  /** When this SKU is a duplicate Amazon listing of another SKU on the same ASIN, the primary
   *  (mapped) SKU it was folded into. Set by assemble's ASIN-consolidation. The engine then
   *  suspends this SKU (no transfer/PO of its own — the primary carries the whole product). */
  consolidated_into?: string | null;
  title?: string;
  case_pack?: number | null;
  moq?: number | null;
  order_multiple?: number | null;
  velocity_override?: number | null;
  growth_multiplier?: number | null;
  /** Full template selected as a per-SKU override (already resolved by the server), else null. */
  template_override?: TemplateParams | null;
  template_override_name?: string | null;
  /** Sparse per-SKU parameter overrides, merged on top of whichever template applies. */
  param_overrides?: Partial<TemplateParams> | null;
}

export interface OpenPoLine {
  sku: string;
  qty_outstanding: number;
  expected_arrival: string | null; // YYYY-MM-DD
  po_number?: string | null;
}

/**
 * Days a SKU was out of stock within each trailing window, derived from snapshot
 * history. `samples` is how many snapshots fell inside the 90-day lookback, so the
 * engine can tell "no history" from "history says zero stockout days".
 */
export interface StockoutDays {
  d7: number; d30: number; d60: number; d90: number;
  samples: number;
}

export interface EngineInput {
  snapshotDate: string; // YYYY-MM-DD
  lines: SnapshotLine[];
  /** Settings for every known SKU (may include SKUs missing from the snapshot). */
  skuSettings: Record<string, SkuSettings>;
  /** US warehouse on-hand units by SKU. */
  warehouse: Record<string, number>;
  openPoLines: OpenPoLine[];
  globalTemplate: TemplateParams;
  globalTemplateName: string;
  /** The air template, used to compute "air freight saves N days" on CRITICAL SKUs. */
  airTemplate?: TemplateParams | null;
  weights: VelocityWeights;
  globalGrowthMultiplier: number;
  orderSoonDays: number;
  overstockFactor: number;
  /** When true, correct velocity for stockout periods so OOS SKUs aren't under-ordered. */
  stockoutCorrection: boolean;
  /** Per-SKU stockout days by window, from snapshot history (optional). */
  stockoutDays?: Record<string, StockoutDays>;
  /**
   * Units on an open (submitted, not-yet-reconciled) warehouse→FBA transfer, by SKU.
   * These are "coming to FBA" but may not yet show in Amazon's inbound (the prep gap).
   */
  inTransitToFba?: Record<string, number>;
  /**
   * True total demand from the Amazon Business Report (FBM + FBA), by SKU: units sold over
   * a window. Preferred over the FBA-only "units shipped" windows when present, so OOS and
   * FBM-tested items show their real sales rate.
   */
  externalDemand?: Record<string, { units: number; days: number }>;
  /**
   * Board-approved yearly forecast for smart rings, in AGGREGATE and in Amazon-basis units.
   * `monthlyUnits` is 12 numbers (Jan..Dec of `year`). The engine splits each month across
   * `smartRingSkus` by trailing velocity share and derives the sizing kit as an attach product.
   */
  wearableForecast?: {
    year: number;
    monthlyUnits: number[];      // length 12, Jan..Dec
    smartRingSkus: string[];     // the variant SKUs the aggregate splits across
    sizingKitSku?: string | null;
  } | null;
}

export type StatusTier =
  | 'STOCKOUT'
  | 'CRITICAL'
  | 'ORDER_NOW'
  | 'ORDER_SOON'
  | 'AT_RISK'
  | 'OVERSTOCK'
  | 'OK'
  | 'UNCLASSIFIED'
  | 'NOT_REPLENISHABLE';

export type VelocitySource = 'manual' | 'business_report' | 'report' | 'none';
export type VelocityConfidence = 'high' | 'medium' | 'low' | 'none';

export interface SkuResult {
  sku: string;              // Amazon SKU (the listing inventory is sent to; the catalog key)
  qalo_sku: string;         // QALO internal SKU (team-facing); falls back to the Amazon SKU
  asin: string | null;      // authoritative ASIN from the map
  title: string;
  classification: Classification;
  fulfillment_channel: 'fba' | 'fbm';

  velocity: number | null;        // units/day, after growth multiplier
  base_velocity: number | null;   // before growth multiplier
  velocity_source: VelocitySource;
  velocity_confidence: VelocityConfidence;
  growth_multiplier: number;
  window_rates: { r7: number | null; r30: number | null; r60: number | null; r90: number | null };

  fba_available: number;
  fba_reserved: number;
  fba_inbound: number;
  in_transit_to_fba: number;
  fba_coming: number;
  fba_position: number;
  warehouse_on_hand: number;
  open_po_units: number;
  total_pipeline: number;
  unfulfillable: number;
  your_price: number | null;

  fba_days_cover: number | null;       // null = unknown velocity; capped at 9999
  pipeline_days_cover: number | null;
  projected_stockout_date: string | null;

  fba_rop_days: number;
  po_rop_days: number;
  fba_target_days: number;
  po_target_days: number;
  china_lead_days: number;
  recommended_ship_qty: number;
  /** Units it would take to hit the FBA target when the shipment lands (before the buffer cap). */
  transfer_required: number;
  /** Units the warehouse can spare above its reserve. */
  transfer_safe: number;
  /** required − safe: how many units short the warehouse is (0 when it can cover). */
  transfer_shortage: number;
  recommended_po_qty: number;
  need_by_arrival: string | null;
  place_by_date: string | null;
  earliest_fba_arrival: string | null;
  stockout_gap_days: number;
  air_saves_days: number | null;

  status: StatusTier;
  flags: string[];
  why: string;
  risk_score: number;          // for sorting within tiers (revenue-at-risk proxy)
  daily_revenue: number;

  template_label: string;      // e.g. 'GLOBAL: Ocean – standard', 'SKU: Air – expedited', '+ overrides'
  template: TemplateParams;
  include_in_plans: boolean;   // only replenishable SKUs feed plan exports
  consolidated_into?: string | null;  // primary SKU this duplicate-listing was folded into (ASIN consolidation)

  amazon_days_of_supply: number | null;
  amazon_min_inventory_level: number | null;

  /** 'core' (default) or 'wearable'. Drives the CORE/WEARABLE toggle and the different PO logic. */
  category: ProductCategory;
  /** WEARABLE only: the informative rolling-12-month plan for this SKU. null for CORE. */
  wearable_report: WearableReport | null;
}

/** One forecast month for a WEARABLE SKU. All unit figures are Amazon-basis. */
export interface WearableMonth {
  month: string;               // 'YYYY-MM'
  forecast_demand: number;     // this SKU's split of the aggregate forecast that month
  fba_target_units: number;    // the shelf goal at FBA that month
  expected_transfer: number;   // units Amazon PULLS from the warehouse that month (= its demand on the warehouse)
  cumulative_transfer: number; // running total of expected_transfer from the start of the window
  recommended_order: number;   // China order to PLACE that month (whole cases)
  order_lands_month: string;   // 'YYYY-MM' the placed order lands (month + lead months)
  must_be_at_warehouse_by: string;  // date the month's pull must already be at the warehouse
  ideal_wh_for_amazon: number; // ideal units to hold at the warehouse for Amazon that month
  flags?: string[];            // e.g. FORECAST_EXTRAPOLATED
}

/** One warehouse→FBA transfer on the review cadence (every `review_period_fba_days`). */
export interface WearableTransferEvent {
  day: number;          // days from today the transfer ships (i.e. is pulled from the warehouse)
  date: string;         // YYYY-MM-DD
  qty: number;
  arrives_day: number;  // lands sellable at Amazon after the ship + check-in leg
  arrives_date: string;
}

/** One day of the WEARABLE forward projection. */
export interface WearablePlanPoint {
  day: number;
  fba: number;         // sellable at Amazon
  in_transit: number;  // on the warehouse→FBA leg
  goal: number;        // the seasonal FBA goal that day (forecast rate × goal days)
}

/**
 * Day-by-day "if you follow this plan" projection for one WEARABLE SKU. Demand comes from the
 * forecast (seasonal), transfers are decided on the real review cadence by the SAME function the
 * Action Center uses, and the warehouse is treated as unlimited (the team always ships what Amazon
 * needs). So this chart and the Ship-to-FBA queue cannot disagree.
 */
export interface WearablePlan {
  series: WearablePlanPoint[];
  transfers: WearableTransferEvent[];
  stockout_day: number;        // first day FBA hits zero, or -1 if it never does
  horizon_days: number;
  review_period_days: number; // transfer cadence (e.g. 14 = every 2 weeks)
  ship_leg_days: number;      // warehouse→FBA transit + check-in
  lead_days: number;          // China → warehouse
}

/** The informative WEARABLE plan for one SKU. */
export interface WearableReport {
  is_attach_product: boolean;  // true for the sizing kit
  variant_share: number;       // this SKU's share of smart-ring velocity (0..1); attach ratio for the kit
  attach_rate: number | null;  // sizing kit only: learned/pinned attach rate, else null
  lead_days: number;           // chinaLeadDays for this SKU (~90)
  lead_months: number;         // lead in whole months (round)
  ideal_wh_days: number;       // days of Amazon demand the ideal WH level covers
  ideal_wh_days_breakdown: { china_lead: number; review_period_po: number; safety: number };
  actual_run_rate_month: number;   // trailing actual, units/month (velocity × 30)
  forecast_run_rate_month: number; // near-term forecast, units/month (next 3 months mean)
  multiplier: number | null;       // forecast ÷ actual run rate (null when no actual signal)
  months: WearableMonth[];         // rolling 12 months from today
}

export interface WearableRollup {
  months: WearableMonth[];     // element-wise sums across all smart-ring + kit SKUs
  total_multiplier: number | null;
  skus: string[];              // the SKUs included in the rollup
}

export interface EngineSummary {
  stockout: number;
  critical: number;
  order_now: number;
  order_soon: number;
  at_risk: number;
  overstock: number;
  ok: number;
  unclassified: number;
  not_replenishable: number;
  ship_units_total: number;
  ship_skus: number;
  po_units_total: number;
  po_skus: number;
}

export interface EngineOutput {
  snapshotDate: string;
  today: string;
  results: SkuResult[];
  summary: EngineSummary;
  /** Aggregate WEARABLE plan (all smart-ring + kit SKUs summed). null when no forecast is set. */
  wearableRollup?: WearableRollup | null;
}
