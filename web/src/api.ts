// Typed-ish fetch helpers for the local API.

export interface SkuResult {
  sku: string; qalo_sku: string; asin: string | null; title: string; classification: string; fulfillment_channel: 'fba' | 'fbm';
  velocity: number | null; base_velocity: number | null;
  velocity_source: string; velocity_confidence: string; growth_multiplier: number;
  window_rates: { r7: number | null; r30: number | null; r60: number | null; r90: number | null };
  fba_available: number; fba_reserved: number; fba_inbound: number;
  in_transit_to_fba: number; fba_coming: number; fba_position: number;
  warehouse_on_hand: number; open_po_units: number; total_pipeline: number; unfulfillable: number;
  your_price: number | null;
  fba_days_cover: number | null; pipeline_days_cover: number | null;
  projected_stockout_date: string | null;
  fba_rop_days: number; po_rop_days: number; fba_target_days: number; po_target_days: number; china_lead_days: number;
  recommended_ship_qty: number; transfer_required: number; transfer_safe: number; transfer_shortage: number;
  recommended_po_qty: number;
  need_by_arrival: string | null; place_by_date: string | null;
  earliest_fba_arrival: string | null; stockout_gap_days: number; air_saves_days: number | null;
  status: string; flags: string[]; why: string; risk_score: number; daily_revenue: number;
  template_label: string; template: Record<string, number>; include_in_plans: boolean;
  amazon_days_of_supply: number | null; amazon_min_inventory_level: number | null;
}

export interface Summary {
  stockout: number; critical: number; order_now: number; order_soon: number; at_risk: number;
  overstock: number; ok: number; unclassified: number; not_replenishable: number;
  ship_units_total: number; ship_skus: number; po_units_total: number; po_skus: number;
}

export interface SkusResponse {
  results: SkuResult[]; summary: Summary | null; snapshotDate: string | null; today?: string;
  settings?: Record<string, SkuSettingsRow>;
}

export interface SkuSettingsRow {
  sku: string; classification: string;
  case_pack: number | null; moq: number | null; order_multiple: number | null;
  velocity_override: number | null; growth_multiplier: number | null;
  template_override_id: number | null; param_overrides: Record<string, number> | null; notes: string | null;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = ((await res.json()) as any).error ?? detail; } catch { /* keep statusText */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => fetch(path).then(r => handle<T>(r)),
  post: <T>(path: string, body?: unknown) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => handle<T>(r)),
  patch: <T>(path: string, body: unknown) =>
    fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => handle<T>(r)),
  put: <T>(path: string, body: unknown) =>
    fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => handle<T>(r)),
  del: <T>(path: string) => fetch(path, { method: 'DELETE' }).then(r => handle<T>(r)),
  upload: <T>(path: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch(path, { method: 'POST', body: fd }).then(r => handle<T>(r));
  },
};

/**
 * THE SINGLE SOURCE OF TRUTH for status vocabulary. One entry per status the engine emits.
 * Every label, one-line definition, colour, and catalog-map grouping in the whole app is
 * read from here — nothing else may invent a status word or a synonym. `tone` groups the
 * nine states into the five families the catalog map and legend show.
 *
 * The ladder (worst → best for a stocked product): Out of stock → Will run out → Act now →
 * Act soon → Healthy → Overstocked. Plus three non-plan states: Needs info, New, Not stocked.
 */
export type StatusTone = 'danger' | 'act' | 'healthy' | 'over' | 'info' | 'neutral';
export const STATUS_META: Record<string, { label: string; tone: StatusTone; c: string; bg: string; help: string }> = {
  STOCKOUT:          { label: 'Out of stock', tone: 'danger', c: 'var(--stockout)', bg: 'var(--stockout-bg)', help: 'Selling, but zero at Amazon right now — losing sales today.' },
  CRITICAL:          { label: 'Will run out', tone: 'danger', c: 'var(--critical)', bg: 'var(--critical-bg)', help: 'Will run dry before any restock can arrive, even if you act today — air-freight to close the gap.' },
  ORDER_NOW:         { label: 'Act now',      tone: 'act',    c: 'var(--ship)', bg: 'var(--ship-bg)', help: 'Ship and/or order this cycle to stay in stock.' },
  ORDER_SOON:        { label: 'Act soon',     tone: 'act',    c: 'var(--po)', bg: 'var(--po-bg)', help: 'Fine for now — plan to ship or order within the next cycle.' },
  OK:                { label: 'Healthy',      tone: 'healthy', c: 'var(--ok)', bg: 'var(--ok-bg)', help: 'In stock and on plan. Any quantity shown is a routine top-up.' },
  OVERSTOCK:         { label: 'Overstocked',  tone: 'over',   c: 'var(--overstock)', bg: 'var(--overstock-bg)', help: 'Far more than you’ll need for a long time — pause ordering.' },
  AT_RISK:           { label: 'Needs info',   tone: 'info',   c: 'var(--atrisk)', bg: 'var(--atrisk-bg)', help: 'Missing a sales rate or a recent import — can’t be planned until you fix it.' },
  UNCLASSIFIED:      { label: 'New',          tone: 'info',   c: 'var(--atrisk)', bg: 'var(--atrisk-bg)', help: 'New product from the last import — mark it replenish or ignore.' },
  NOT_REPLENISHABLE: { label: 'Not stocked',  tone: 'neutral', c: 'var(--neutral)', bg: 'var(--neutral-bg)', help: 'Set to ignore or discontinued — no recommendations.' },
};

/** Order the states are listed in the on-screen status key. */
export const STATUS_TIERS = ['STOCKOUT', 'CRITICAL', 'ORDER_NOW', 'ORDER_SOON', 'OK', 'OVERSTOCK', 'AT_RISK', 'UNCLASSIFIED', 'NOT_REPLENISHABLE'] as const;

/** The five catalog-map families (a grouping of the tiers by tone), in display order.
 *  Names reuse the ladder's own words — no second vocabulary. `cls` is the dot-map colour. */
export const TONE_FAMILY: { tone: StatusTone; label: string; cls: string; tiers: string[] }[] = [
  { tone: 'danger',  label: 'Out / will run out', cls: 'tone-danger', tiers: ['STOCKOUT', 'CRITICAL'] },
  { tone: 'act',     label: 'Act now / soon',     cls: 'tone-ink',    tiers: ['ORDER_NOW', 'ORDER_SOON'] },
  { tone: 'info',    label: 'Needs info',         cls: 'tone-ring',   tiers: ['AT_RISK', 'UNCLASSIFIED'] },
  { tone: 'healthy', label: 'Healthy',            cls: 'tone-mid',    tiers: ['OK'] },
  { tone: 'over',    label: 'Overstocked',        cls: 'tone-faint',  tiers: ['OVERSTOCK'] },
];

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—';
  if (n >= 9999) return '∞';
  return n % 1 === 0 ? String(n) : n.toFixed(digits);
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}
