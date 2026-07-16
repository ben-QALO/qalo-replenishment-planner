import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVelocity } from '../velocity.ts';
import type { StockoutDays } from '../types.ts';
import { line, settings, WEIGHTS } from './helpers.ts';

// Convenience: resolveVelocity(line, settings, weights, growth, correction, stockoutDays)
const V = (l: any, s: any = settings(), growth = 1.0, correction = true, sd?: StockoutDays) =>
  resolveVelocity(l, s, WEIGHTS, growth, correction, sd);

test('weighted blend across all four windows (in stock, no correction needed)', () => {
  const l = line({
    sku: 'MXG09', available: 112, reserved: 3,
    units_shipped_t7: 11, units_shipped_t30: 69, units_shipped_t60: 113, units_shipped_t90: 154,
  });
  const v = V(l);
  // 0.25·(11/7) + 0.45·(69/30) + 0.20·(113/60) + 0.10·(154/90) = 1.97563...
  assert.ok(Math.abs((v.base_velocity ?? 0) - 1.97563) < 0.001, `got ${v.base_velocity}`);
  assert.equal(v.source, 'report');
  assert.equal(v.confidence, 'high');
  assert.ok(!v.flags.includes('STOCKOUT_CORRECTED'));
});

test('missing windows are dropped and weights renormalized', () => {
  const l = line({
    sku: 'A', available: 5,
    units_shipped_t7: 14, units_shipped_t30: 60,
    units_shipped_t60: null, units_shipped_t90: null,
  });
  assert.ok(Math.abs((V(l).base_velocity ?? 0) - 2) < 1e-9);
});

test('growth multiplier scales velocity, per-SKU beats global', () => {
  const l = line({ sku: 'A', available: 5, units_shipped_t7: 7, units_shipped_t30: 30, units_shipped_t60: 60, units_shipped_t90: 90 });
  assert.ok(Math.abs((V(l, settings(), 1.3).velocity ?? 0) - 1.3) < 1e-9);
  assert.ok(Math.abs((V(l, settings({ growth_multiplier: 2 }), 1.3).velocity ?? 0) - 2) < 1e-9);
});

test('manual override wins over report data and is flagged', () => {
  const l = line({ sku: 'A', available: 5, units_shipped_t30: 300 });
  const v = V(l, settings({ velocity_override: 4 }));
  assert.equal(v.source, 'manual');
  assert.equal(v.velocity, 4);
  assert.ok(v.flags.includes('MANUAL_VELOCITY'));
});

test('no line and no override → velocity unknown (null), never zero', () => {
  const v = V(null);
  assert.equal(v.velocity, null);
  assert.equal(v.source, 'none');
});

// ── Stockout correction ─────────────────────────────────────────────────────

test('CORRECTION: out of stock now → uses best in-stock window rate, not the dragged blend', () => {
  // Just went OOS: t7 collapsed, longer windows show true demand ~1.5/day.
  const l = line({
    sku: 'A', available: 0,
    units_shipped_t7: 2, units_shipped_t30: 40, units_shipped_t60: 90, units_shipped_t90: 140,
  });
  const uncorrected = V(l, settings(), 1.0, false);
  const corrected = V(l, settings(), 1.0, true);
  // Uncorrected blend is dragged down by r7=0.29; corrected lifts to best rate (r90≈1.56).
  assert.ok((uncorrected.base_velocity ?? 0) < 1.2, `blend was ${uncorrected.base_velocity}`);
  assert.ok(Math.abs((corrected.base_velocity ?? 0) - 140 / 90) < 0.01, `corrected was ${corrected.base_velocity}`);
  assert.ok(corrected.velocity! > uncorrected.velocity!);
  assert.ok(corrected.flags.includes('STOCKOUT_CORRECTED'));
});

test('CORRECTION: never lowers velocity — a genuine decline in stock is untouched', () => {
  // In stock, declining: correction must not apply (available > 0).
  const l = line({ sku: 'A', available: 50, units_shipped_t7: 7, units_shipped_t30: 60, units_shipped_t60: 150, units_shipped_t90: 270 });
  const v = V(l);
  assert.ok(!v.flags.includes('STOCKOUT_CORRECTED'));
});

test('CORRECTION: bounded by observed sales — never invents demand above the max window rate', () => {
  const l = line({ sku: 'A', available: 0, units_shipped_t7: 0, units_shipped_t30: 30, units_shipped_t60: 60, units_shipped_t90: 90 });
  const v = V(l);
  // best observed rate = 1/day across all windows → corrected velocity is exactly 1.
  assert.ok(Math.abs((v.base_velocity ?? 0) - 1) < 1e-9);
});

test('CORRECTION: can be turned off (setting), leaving the raw blend', () => {
  const l = line({ sku: 'A', available: 0, units_shipped_t7: 0, units_shipped_t30: 40, units_shipped_t60: 90, units_shipped_t90: 140 });
  const off = V(l, settings(), 1.0, false);
  assert.ok(!off.flags.includes('STOCKOUT_CORRECTED'));
});

test('CORRECTION (history): effective-days lifts velocity when stockout days are known', () => {
  // In stock now, but was OOS 20 of the last 30 days per history → t30 rate should divide by 10, not 30.
  const l = line({ sku: 'A', available: 25, units_shipped_t7: 7, units_shipped_t30: 30, units_shipped_t60: 60, units_shipped_t90: 90 });
  const sd: StockoutDays = { d7: 0, d30: 20, d60: 20, d90: 20, samples: 8 };
  const v = V(l, settings(), 1.0, true, sd);
  // t30 corrected rate = 30/(30-20) = 3.0 vs raw 1.0 → blend rises well above 1.
  assert.ok((v.base_velocity ?? 0) > 1.5, `got ${v.base_velocity}`);
  assert.ok(v.flags.includes('STOCKOUT_CORRECTED'));
});

test('CORRECTION (history): a window with too few in-stock days is dropped, not extrapolated', () => {
  // OOS 28 of last 30 days: only 2 in-stock days < 25% of 30 → drop t30 window.
  const l = line({ sku: 'A', available: 5, units_shipped_t7: 1, units_shipped_t30: 4, units_shipped_t60: 60, units_shipped_t90: 90 });
  const sd: StockoutDays = { d7: 5, d30: 28, d60: 28, d90: 28, samples: 8 };
  const v = V(l, settings(), 1.0, true, sd);
  // t7 also fully OOS (5 of 7 → 2 in-stock ≥ 25% of 7? 1.75 floor → 2>=1.75 keeps t7).
  // Key assertion: it produced a finite sane velocity without a divide-by-tiny blowup.
  assert.ok(v.velocity !== null && v.velocity! < 5, `got ${v.velocity}`);
});

test('velocity spike and crash flags respect volume floors (informational only)', () => {
  const spike = V(line({ sku: 'A', available: 10, units_shipped_t7: 50, units_shipped_t30: 60, units_shipped_t60: 70, units_shipped_t90: 80 }));
  assert.ok(spike.flags.includes('VELOCITY_SPIKE'));
  const crash = V(line({ sku: 'B', available: 10, units_shipped_t7: 1, units_shipped_t30: 60, units_shipped_t60: 120, units_shipped_t90: 180 }));
  assert.ok(crash.flags.includes('VELOCITY_CRASH'));
  const noise = V(line({ sku: 'C', available: 10, units_shipped_t7: 2, units_shipped_t30: 2, units_shipped_t60: 2, units_shipped_t90: 3 }));
  assert.ok(!noise.flags.includes('VELOCITY_SPIKE'));
});

test('zero sales across all windows → velocity 0 (true zero-seller, not unknown)', () => {
  const v = V(line({ sku: 'A', available: 40 }));
  assert.equal(v.velocity, 0);
  assert.equal(v.source, 'report');
});

// ── Business Report demand (FBM + FBA) ────────────────────────────────────────
// The truest signal: it must beat the FBA-only windows, cover FBM-tested / OOS-on-FBA
// items, and never zero out a real seller when the report lacks the row.

test('business report: overrides the FBA-only windows', () => {
  // FBA shipped implies ~1/day; the Business Report says 300 over 30 days = 10/day (FBM too).
  const l = line({ sku: 'X', available: 100, units_shipped_t7: 7, units_shipped_t30: 30, units_shipped_t60: 60, units_shipped_t90: 90 });
  const v = resolveVelocity(l, settings(), WEIGHTS, 1, true, undefined, { units: 300, days: 30 });
  assert.equal(v.source, 'business_report');
  assert.equal(v.velocity, 10);
});

test('business report: a brand-new FBM item with no FBA line still gets a rate', () => {
  const v = resolveVelocity(null, settings(), WEIGHTS, 1, true, undefined, { units: 60, days: 30 });
  assert.equal(v.source, 'business_report');
  assert.equal(v.velocity, 2);
});

test('business report: an empty row falls back to FBA windows (never zeroes a seller)', () => {
  const l = line({ sku: 'X', available: 100, units_shipped_t7: 7, units_shipped_t30: 30, units_shipped_t60: 60, units_shipped_t90: 90 });
  const v = resolveVelocity(l, settings(), WEIGHTS, 1, true, undefined, { units: 0, days: 30 });
  assert.equal(v.source, 'report');
  assert.ok(v.velocity !== null && v.velocity > 0);
});

test('business report: manual override still wins; growth multiplier applies', () => {
  const manual = resolveVelocity(null, settings({ velocity_override: 5 }), WEIGHTS, 1, true, undefined, { units: 300, days: 30 });
  assert.equal(manual.source, 'manual');
  assert.equal(manual.velocity, 5);
  const grown = resolveVelocity(null, settings({ growth_multiplier: 2 }), WEIGHTS, 1, true, undefined, { units: 300, days: 30 });
  assert.equal(grown.velocity, 20);
});
