import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVelocity } from '../velocity.ts';
import { line, settings, WEIGHTS } from './helpers.ts';

test('weighted blend across all four windows (hand-computed, real MXG09 numbers)', () => {
  const l = line({
    sku: 'MXG09', available: 112, reserved: 3,
    units_shipped_t7: 11, units_shipped_t30: 69, units_shipped_t60: 113, units_shipped_t90: 154,
  });
  const v = resolveVelocity(l, settings(), WEIGHTS, 1.0);
  // 0.25·(11/7) + 0.45·(69/30) + 0.20·(113/60) + 0.10·(154/90) = 1.97563...
  assert.ok(Math.abs((v.base_velocity ?? 0) - 1.97563) < 0.001, `got ${v.base_velocity}`);
  assert.equal(v.source, 'report');
  assert.equal(v.confidence, 'high'); // t30 = 69 ≥ 10
});

test('missing windows are dropped and weights renormalized', () => {
  const l = line({
    sku: 'A', available: 5,
    units_shipped_t7: 14, units_shipped_t30: 60,
    units_shipped_t60: null, units_shipped_t90: null,
  });
  const v = resolveVelocity(l, settings(), WEIGHTS, 1.0);
  // usable: w7=0.25, w30=0.45 → renorm to 0.357/0.643; r7=2, r30=2 → blend 2.
  assert.ok(Math.abs((v.base_velocity ?? 0) - 2) < 1e-9);
});

test('growth multiplier scales velocity, per-SKU beats global', () => {
  const l = line({ sku: 'A', available: 5, units_shipped_t7: 7, units_shipped_t30: 30, units_shipped_t60: 60, units_shipped_t90: 90 });
  // all rates = 1
  const global = resolveVelocity(l, settings(), WEIGHTS, 1.3);
  assert.ok(Math.abs((global.velocity ?? 0) - 1.3) < 1e-9);
  assert.ok(Math.abs((global.base_velocity ?? 0) - 1) < 1e-9);
  const perSku = resolveVelocity(l, settings({ growth_multiplier: 2 }), WEIGHTS, 1.3);
  assert.ok(Math.abs((perSku.velocity ?? 0) - 2) < 1e-9);
});

test('manual override wins over report data and is flagged', () => {
  const l = line({ sku: 'A', available: 5, units_shipped_t30: 300 });
  const v = resolveVelocity(l, settings({ velocity_override: 4 }), WEIGHTS, 1.0);
  assert.equal(v.source, 'manual');
  assert.equal(v.velocity, 4);
  assert.ok(v.flags.includes('MANUAL_VELOCITY'));
});

test('no line and no override → velocity unknown (null), never zero', () => {
  const v = resolveVelocity(null, settings(), WEIGHTS, 1.0);
  assert.equal(v.velocity, null);
  assert.equal(v.source, 'none');
  assert.equal(v.confidence, 'none');
});

test('stockout-suppressed velocity is flagged low-confidence (OOS death-spiral guard)', () => {
  const l = line({
    sku: 'A', available: 0,
    units_shipped_t7: 0, units_shipped_t30: 5, units_shipped_t60: 30, units_shipped_t90: 60,
  });
  const v = resolveVelocity(l, settings(), WEIGHTS, 1.0);
  assert.ok(v.flags.includes('VELOCITY_SUPPRESSED'));
  assert.equal(v.confidence, 'low');
});

test('velocity spike and crash flags respect volume floors', () => {
  const spike = resolveVelocity(
    line({ sku: 'A', available: 10, units_shipped_t7: 50, units_shipped_t30: 60, units_shipped_t60: 70, units_shipped_t90: 80 }),
    settings(), WEIGHTS, 1.0);
  assert.ok(spike.flags.includes('VELOCITY_SPIKE'));

  const crash = resolveVelocity(
    line({ sku: 'B', available: 10, units_shipped_t7: 1, units_shipped_t30: 60, units_shipped_t60: 120, units_shipped_t90: 180 }),
    settings(), WEIGHTS, 1.0);
  assert.ok(crash.flags.includes('VELOCITY_CRASH'));

  // tiny numbers: 2 sold this week vs 1/month before — no spike flag (volume floor)
  const noise = resolveVelocity(
    line({ sku: 'C', available: 10, units_shipped_t7: 2, units_shipped_t30: 2, units_shipped_t60: 2, units_shipped_t90: 3 }),
    settings(), WEIGHTS, 1.0);
  assert.ok(!noise.flags.includes('VELOCITY_SPIKE'));
});

test('zero sales across all windows → velocity 0 (true zero-seller, not unknown)', () => {
  const v = resolveVelocity(line({ sku: 'A', available: 40 }), settings(), WEIGHTS, 1.0);
  assert.equal(v.velocity, 0);
  assert.equal(v.source, 'report');
});
