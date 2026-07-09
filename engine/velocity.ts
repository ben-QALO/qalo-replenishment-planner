import type { SnapshotLine, SkuSettings, VelocityWeights, VelocitySource, VelocityConfidence } from './types.ts';

export interface VelocityResult {
  velocity: number | null;       // after growth multiplier
  base_velocity: number | null;  // weighted blend before multiplier
  source: VelocitySource;
  confidence: VelocityConfidence;
  growth_multiplier: number;
  window_rates: { r7: number | null; r30: number | null; r60: number | null; r90: number | null };
  flags: string[];
}

const WINDOWS = [7, 30, 60, 90] as const;

/**
 * Resolve a SKU's daily sales velocity.
 * Waterfall: manual override → weighted blend of report windows → none.
 * Weights over unusable (null) windows are renormalized across the usable ones.
 */
export function resolveVelocity(
  line: SnapshotLine | null,
  settings: SkuSettings | undefined,
  weights: VelocityWeights,
  globalGrowthMultiplier: number,
): VelocityResult {
  const flags: string[] = [];
  const growth = settings?.growth_multiplier ?? globalGrowthMultiplier;

  const rates: { r7: number | null; r30: number | null; r60: number | null; r90: number | null } = {
    r7: null, r30: null, r60: null, r90: null,
  };
  if (line) {
    for (const n of WINDOWS) {
      const units = line[`units_shipped_t${n}` as const];
      if (units !== null && units !== undefined) rates[`r${n}` as const] = units / n;
    }
  }

  // Manual override wins.
  if (settings?.velocity_override !== null && settings?.velocity_override !== undefined) {
    flags.push('MANUAL_VELOCITY');
    const base = settings.velocity_override;
    return {
      velocity: base * growth,
      base_velocity: base,
      source: 'manual',
      confidence: 'medium',
      growth_multiplier: growth,
      window_rates: rates,
      flags,
    };
  }

  const usable = WINDOWS.filter(n => rates[`r${n}` as const] !== null);
  if (!line || usable.length === 0) {
    return {
      velocity: null, base_velocity: null, source: 'none', confidence: 'none',
      growth_multiplier: growth, window_rates: rates, flags,
    };
  }

  const weightByWindow: Record<number, number> = { 7: weights.w7, 30: weights.w30, 60: weights.w60, 90: weights.w90 };
  const totalWeight = usable.reduce((s, n) => s + weightByWindow[n], 0);
  const base = usable.reduce((s, n) => s + (rates[`r${n}` as const] as number) * (weightByWindow[n] / totalWeight), 0);

  const t7 = line.units_shipped_t7 ?? 0;
  const t30 = line.units_shipped_t30 ?? 0;
  const t90 = line.units_shipped_t90 ?? 0;
  const r7 = rates.r7 ?? 0;
  const r30 = rates.r30 ?? 0;
  const r90 = rates.r90 ?? 0;

  // Stockout-suppressed velocity: currently OOS and recent rate collapsed vs 90-day rate.
  // Without correction the tool under-orders exactly the SKUs that just stocked out.
  let suppressed = false;
  if (line.available === 0 && t90 >= 10 && r7 < 0.5 * r90) {
    suppressed = true;
    flags.push('VELOCITY_SUPPRESSED');
  }

  // Demand anomalies (volume floors keep small-number noise out).
  if (t7 >= 10 && r7 > 2 * r30 && r30 > 0) flags.push('VELOCITY_SPIKE');
  if (line.available > 0 && r30 >= 1 && r7 < 0.5 * r30) flags.push('VELOCITY_CRASH');

  let confidence: VelocityConfidence;
  if (suppressed) confidence = 'low';
  else if (t30 >= 10) confidence = 'high';
  else if (t90 >= 5) confidence = 'medium';
  else confidence = 'low';

  return {
    velocity: base * growth,
    base_velocity: base,
    source: 'report',
    confidence,
    growth_multiplier: growth,
    window_rates: rates,
    flags,
  };
}
