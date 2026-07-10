// Typed-ish fetch helpers for the local API.

export interface SkuResult {
  sku: string; title: string; classification: string;
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
  recommended_ship_qty: number; recommended_po_qty: number;
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

export const STATUS_META: Record<string, { label: string; c: string; bg: string }> = {
  STOCKOUT: { label: 'Stocked out', c: 'var(--stockout)', bg: 'var(--stockout-bg)' },
  CRITICAL: { label: 'Critical', c: 'var(--critical)', bg: 'var(--critical-bg)' },
  ORDER_NOW: { label: 'Order now', c: 'var(--ship)', bg: 'var(--ship-bg)' },
  ORDER_SOON: { label: 'Order soon', c: 'var(--po)', bg: 'var(--po-bg)' },
  AT_RISK: { label: 'At risk', c: 'var(--atrisk)', bg: 'var(--atrisk-bg)' },
  OVERSTOCK: { label: 'Overstock', c: 'var(--overstock)', bg: 'var(--overstock-bg)' },
  OK: { label: 'OK', c: 'var(--ok)', bg: 'var(--ok-bg)' },
  UNCLASSIFIED: { label: 'New — classify', c: 'var(--atrisk)', bg: 'var(--atrisk-bg)' },
  NOT_REPLENISHABLE: { label: 'Not replenished', c: 'var(--neutral)', bg: 'var(--neutral-bg)' },
};

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined) return '—';
  if (n >= 9999) return '∞';
  return n % 1 === 0 ? String(n) : n.toFixed(digits);
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}
