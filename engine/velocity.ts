import type { SnapshotLine, SkuSettings, VelocityWeights, VelocitySource, VelocityConfidence, StockoutDays } from './types.ts';

export interface VelocityResult {
  velocity: number | null;       // after growth multiplier
  base_velocity: number | null;  // corrected blend before multiplier
  source: VelocitySource;
  confidence: VelocityConfidence;
  growth_multiplier: number;
  window_rates: { r7: number | null; r30: number | null; r60: number | null; r90: number | null };
  flags: string[];
}

const WINDOWS = [7, 30, 60, 90] as const;

/**
 * Resolve a SKU's daily sales velocity.
 * Waterfall: manual override → corrected blend of report windows → none.
 *
 * Stockout correction (the core accuracy fix): Amazon's units-shipped-tN divided by
 * N understates true demand whenever the SKU was out of stock during that window —
 * it sold less because it *couldn't* sell. Left uncorrected, a stocked-out SKU looks
 * slow, gets under-ordered, and stocks out again (the death spiral). Two corrections,
 * best-available first:
 *   1. History (effective days): rate = units / (N − stockout_days_in_window), when
 *      enough snapshots exist to know the stockout days.
 *   2. Single snapshot: when the SKU is out of stock *now*, every window's rate is a
 *      lower bound on true demand, so use the best (highest) in-stock window rate
 *      instead of the suppression-dragged blend. Bounded by observed sales — never
 *      invents demand — and biased safely toward keeping the item in stock.
 */
export function resolveVelocity(
  line: SnapshotLine | null,
  settings: SkuSettings | undefined,
  weights: VelocityWeights,
  globalGrowthMultiplier: number,
  stockoutCorrection: boolean,
  stockoutDays: StockoutDays | undefined,
): VelocityResult {
  const flags: string[] = [];
  const growth = settings?.growth_multiplier ?? globalGrowthMultiplier;

  // Manual override wins over everything.
  if (settings?.velocity_override !== null && settings?.velocity_override !== undefined) {
    flags.push('MANUAL_VELOCITY');
    const base = settings.velocity_override;
    return {
      velocity: base * growth, base_velocity: base, source: 'manual', confidence: 'medium',
      growth_multiplier: growth, window_rates: emptyRates(line), flags,
    };
  }

  if (!line) {
    return { velocity: null, base_velocity: null, source: 'none', confidence: 'none',
      growth_multiplier: growth, window_rates: emptyRates(null), flags };
  }

  // Raw rate = units / window length. Corrected rate divides by in-stock days when known.
  const rawRates: Record<number, number | null> = { 7: null, 30: null, 60: null, 90: null };
  const corrected: Record<number, number | null> = { 7: null, 30: null, 60: null, 90: null };
  const stockoutDayByWindow: Record<number, number> = {
    7: stockoutDays?.d7 ?? 0, 30: stockoutDays?.d30 ?? 0, 60: stockoutDays?.d60 ?? 0, 90: stockoutDays?.d90 ?? 0,
  };
  const haveHistory = stockoutCorrection && (stockoutDays?.samples ?? 0) >= 3;

  for (const n of WINDOWS) {
    const units = line[`units_shipped_t${n}` as const];
    if (units === null || units === undefined) continue;
    rawRates[n] = units / n;
    if (haveHistory) {
      const effective = n - Math.min(stockoutDayByWindow[n], n);
      // Don't extrapolate from a sliver of in-stock days — drop the window instead.
      corrected[n] = effective >= 0.25 * n ? units / effective : null;
    } else {
      corrected[n] = units / n;
    }
  }

  const usable = WINDOWS.filter(n => corrected[n] !== null);
  if (usable.length === 0) {
    return { velocity: null, base_velocity: null, source: 'none', confidence: 'none',
      growth_multiplier: growth, window_rates: toRates(rawRates), flags };
  }

  const weightByWindow: Record<number, number> = { 7: weights.w7, 30: weights.w30, 60: weights.w60, 90: weights.w90 };
  const totalWeight = usable.reduce((s, n) => s + weightByWindow[n], 0) || 1;
  const blend = usable.reduce((s, n) => s + (corrected[n] as number) * (weightByWindow[n] / totalWeight), 0);

  let base = blend;
  let corrApplied = false;

  // Single-snapshot correction: currently out of stock → the blend is dragged down by
  // suppressed recent windows. Lift to the best in-stock window rate.
  if (stockoutCorrection && line.available === 0) {
    const bestRate = Math.max(...usable.map(n => corrected[n] as number));
    if (bestRate > blend * 1.05) { base = bestRate; corrApplied = true; }
  }
  // History correction changed the number materially.
  if (haveHistory && !corrApplied) {
    const rawBlend = usable.reduce((s, n) => s + ((rawRates[n] ?? 0)) * (weightByWindow[n] / totalWeight), 0);
    if (base > rawBlend * 1.05) corrApplied = true;
  }
  if (corrApplied) flags.push('STOCKOUT_CORRECTED');

  // Demand anomalies (informational flags only — no automatic removal).
  const t7 = line.units_shipped_t7 ?? 0, t30 = line.units_shipped_t30 ?? 0, t90 = line.units_shipped_t90 ?? 0;
  const r7 = rawRates[7] ?? 0, r30 = rawRates[30] ?? 0, r90 = rawRates[90] ?? 0;
  if (t7 >= 10 && r7 > 2 * r30 && r30 > 0) flags.push('VELOCITY_SPIKE');
  if (line.available > 0 && r30 >= 1 && r7 < 0.5 * r30) flags.push('VELOCITY_CRASH');

  let confidence: VelocityConfidence;
  if (t30 >= 10) confidence = 'high';
  else if (t90 >= 5) confidence = 'medium';
  else confidence = 'low';
  // An uncorrected stockout still means the number is shaky.
  if (line.available === 0 && !corrApplied && confidence === 'high') confidence = 'medium';

  return {
    velocity: base * growth, base_velocity: base, source: 'report', confidence,
    growth_multiplier: growth, window_rates: toRates(rawRates), flags,
  };
}

function emptyRates(line: SnapshotLine | null): VelocityResult['window_rates'] {
  if (!line) return { r7: null, r30: null, r60: null, r90: null };
  const rate = (n: number) => {
    const u = line[`units_shipped_t${n}` as const];
    return u === null || u === undefined ? null : u / n;
  };
  return { r7: rate(7), r30: rate(30), r60: rate(60), r90: rate(90) };
}

function toRates(raw: Record<number, number | null>): VelocityResult['window_rates'] {
  return { r7: raw[7], r30: raw[30], r60: raw[60], r90: raw[90] };
}
