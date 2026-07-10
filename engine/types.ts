// Engine contract. The engine is pure: no I/O, no DB, no Date.now() — `today` is injected.

export type Classification = 'unclassified' | 'replenishable' | 'watch' | 'discontinued' | 'ignore';

export interface TemplateParams {
  production_days: number;
  transit_days: number;
  customs_receiving_days: number;
  fba_ship_checkin_days: number;
  safety_days: number;
  fba_target_cover_days: number;  // order-up-to level for FBA (how much to KEEP at Amazon)
  target_cover_days: number;      // order-up-to level for the whole pipeline (China PO)
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

export interface SkuSettings {
  classification: Classification;
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

export type VelocitySource = 'manual' | 'report' | 'none';
export type VelocityConfidence = 'high' | 'medium' | 'low' | 'none';

export interface SkuResult {
  sku: string;
  title: string;
  classification: Classification;

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

  amazon_days_of_supply: number | null;
  amazon_min_inventory_level: number | null;
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
}
