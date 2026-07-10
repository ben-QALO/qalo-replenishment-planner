import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRecommendations } from '../index.ts';
import { line, settings, input, TODAY, AIR } from './helpers.ts';

const steady = (perDay: number) => ({
  units_shipped_t7: perDay * 7, units_shipped_t30: perDay * 30,
  units_shipped_t60: perDay * 60, units_shipped_t90: perDay * 90,
});

function one(out: ReturnType<typeof computeRecommendations>, sku: string) {
  const r = out.results.find(r => r.sku === sku);
  assert.ok(r, `result for ${sku} missing`);
  return r!;
}

test('integration: ORDER_NOW on both lanes with hand-computed quantities', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'RING-1', available: 50, inbound_shipped: 10, ...steady(2) })],
    skuSettings: { 'RING-1': settings({ case_pack: 6, moq: 100, order_multiple: 25 }) },
    warehouse: { 'RING-1': 100 },
  }), TODAY);
  const r = one(out, 'RING-1');
  assert.equal(r.velocity, 2);
  assert.equal(r.fba_position, 60);
  assert.equal(r.fba_days_cover, 30);
  assert.equal(r.recommended_ship_qty, 18);      // (2×38 − 60) → cases of 6
  assert.equal(r.total_pipeline, 160);
  assert.equal(r.recommended_po_qty, 100);       // 68 → MOQ 100
  assert.equal(r.status, 'ORDER_NOW');
  assert.ok(r.flags.includes('MOQ_PADDED'));
  assert.ok(r.why.includes('38-day reorder point'));
  assert.equal(out.summary.order_now, 1);
  assert.equal(out.summary.ship_units_total, 18);
  assert.equal(out.summary.po_units_total, 100);
});

test('integration: STOCKOUT beats everything; suppressed velocity flagged', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'OOS-1', available: 0, units_shipped_t7: 0, units_shipped_t30: 5, units_shipped_t60: 30, units_shipped_t90: 60 })],
    skuSettings: { 'OOS-1': settings() },
    warehouse: { 'OOS-1': 200 },
  }), TODAY);
  const r = one(out, 'OOS-1');
  assert.equal(r.status, 'STOCKOUT');
  assert.ok(r.flags.includes('STOCKOUT_CORRECTED'));
  assert.ok(r.why.includes('ship now'));
  assert.ok(r.recommended_ship_qty > 0, 'stockout with warehouse stock must recommend a shipment');
});

test('integration: CRITICAL when stockout lands before any replenishment can, with air savings', () => {
  // 2/day, 60 at FBA = 30 days cover; no warehouse, no POs → earliest ocean arrival is 80 days out.
  const out = computeRecommendations(input({
    lines: [line({ sku: 'CRIT-1', available: 58, reserved: 2, ...steady(2) })],
    skuSettings: { 'CRIT-1': settings() },
  }), TODAY);
  const r = one(out, 'CRIT-1');
  assert.equal(r.status, 'CRITICAL');
  assert.equal(r.stockout_gap_days, 50);          // 80 − 30
  assert.equal(r.earliest_fba_arrival, '2026-09-27');
  // air: 51 days out vs stockout at 30 days → air gap 21 → saves 29
  assert.equal(r.air_saves_days, 29);
  assert.ok(r.why.includes('Air freight'));
});

test('integration: ORDER_SOON inside the pre-warning window', () => {
  // 2/day, fba position 80 → 40 days: above rop 38, inside 38+7 → ORDER_SOON.
  // Give plenty of pipeline so the PO lane stays quiet: warehouse 400 → pipeline 480 → 240 days > 121.
  const out = computeRecommendations(input({
    lines: [line({ sku: 'SOON-1', available: 80, ...steady(2) })],
    skuSettings: { 'SOON-1': settings() },
    warehouse: { 'SOON-1': 400 },
  }), TODAY);
  const r = one(out, 'SOON-1');
  assert.equal(r.status, 'ORDER_SOON');
  assert.equal(r.recommended_ship_qty, 0);
});

test('integration: OVERSTOCK on excessive cover and on dormant stock', () => {
  // 1/day with 300 units pipeline → 300 days > 1.5×120 = 180
  const heavy = computeRecommendations(input({
    lines: [line({ sku: 'OVER-1', available: 300, ...steady(1) })],
    skuSettings: { 'OVER-1': settings() },
  }), TODAY);
  assert.equal(one(heavy, 'OVER-1').status, 'OVERSTOCK');

  // zero-seller with stock
  const dormant = computeRecommendations(input({
    lines: [line({ sku: 'DORM-1', available: 40 })],
    skuSettings: { 'DORM-1': settings() },
  }), TODAY);
  assert.equal(one(dormant, 'DORM-1').status, 'OVERSTOCK');
  assert.ok(one(dormant, 'DORM-1').why.includes('No sales'));
});

test('integration: healthy SKU is OK', () => {
  // 2/day, 100 at FBA = 50 days (> 45); warehouse 200 → pipeline 300 = 150 days:
  // above the 121-day order-soon line, below the 180-day overstock line.
  const out = computeRecommendations(input({
    lines: [line({ sku: 'OK-1', available: 100, ...steady(2) })],
    skuSettings: { 'OK-1': settings() },
    warehouse: { 'OK-1': 200 },
  }), TODAY);
  assert.equal(one(out, 'OK-1').status, 'OK');
});

test('new SKU in snapshot without settings → UNCLASSIFIED, no recommendations', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'NEW-1', available: 3, ...steady(1) })],
  }), TODAY);
  const r = one(out, 'NEW-1');
  assert.equal(r.status, 'UNCLASSIFIED');
  assert.ok(r.flags.includes('NEW_UNCLASSIFIED'));
  assert.equal(r.recommended_ship_qty, 0);
  assert.equal(r.recommended_po_qty, 0);
  assert.equal(r.include_in_plans, false);
});

test('classified SKU missing from snapshot → AT_RISK (stale), never STOCKOUT, recs suspended', () => {
  const out = computeRecommendations(input({
    skuSettings: { 'GONE-1': settings({ velocity_override: 5 }) },
    warehouse: { 'GONE-1': 500 },
  }), TODAY);
  const r = one(out, 'GONE-1');
  assert.equal(r.status, 'AT_RISK');
  assert.ok(r.flags.includes('MISSING_FROM_IMPORT'));
  assert.equal(r.recommended_ship_qty, 0);
  assert.equal(r.include_in_plans, false);
});

test('replenishable SKU with no velocity data → AT_RISK with NO_VELOCITY', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'NOVEL-1', available: 12, units_shipped_t7: null, units_shipped_t30: null, units_shipped_t60: null, units_shipped_t90: null })],
    skuSettings: { 'NOVEL-1': settings() },
  }), TODAY);
  const r = one(out, 'NOVEL-1');
  assert.equal(r.status, 'AT_RISK');
  assert.ok(r.flags.includes('NO_VELOCITY'));
  assert.equal(r.recommended_po_qty, 0);
});

test('ignored / discontinued SKUs get NOT_REPLENISHABLE and no quantities', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'IGN-1', available: 0, ...steady(3) })],
    skuSettings: { 'IGN-1': settings({ classification: 'ignore' }) },
  }), TODAY);
  const r = one(out, 'IGN-1');
  assert.equal(r.status, 'NOT_REPLENISHABLE');
  assert.equal(r.recommended_ship_qty, 0);
  assert.equal(r.include_in_plans, false);
});

test('watch SKUs compute recommendations but are excluded from plans', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'WATCH-1', available: 50, inbound_shipped: 10, ...steady(2) })],
    skuSettings: { 'WATCH-1': settings({ classification: 'watch' }) },
    warehouse: { 'WATCH-1': 100 },
  }), TODAY);
  const r = one(out, 'WATCH-1');
  assert.equal(r.status, 'ORDER_NOW');
  assert.ok(r.recommended_ship_qty > 0);
  assert.equal(r.include_in_plans, false);
  assert.equal(out.summary.ship_units_total, 0, 'watch SKUs must not count into plan totals');
});

test('per-SKU template override and param overrides change the math and the label', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'AIR-1', available: 80, ...steady(2) })],
    skuSettings: {
      'AIR-1': settings({
        template_override: AIR, template_override_name: 'Air – expedited',
        param_overrides: { safety_days: 3 },
      }),
    },
    warehouse: { 'AIR-1': 120 },
  }), TODAY);
  const r = one(out, 'AIR-1');
  // air + safety 3: fba_rop = 10+14+3 = 27; 40 days cover > 27+7.
  // pipeline 200 units = 100 days: above po_rop 74+7, below overstock 1.5×75 → OK
  assert.equal(r.fba_rop_days, 27);
  assert.equal(r.po_rop_days, 74); // 41 + 30 + 3
  assert.equal(r.status, 'OK');
  assert.ok(r.template_label.includes('Air – expedited'));
  assert.ok(r.template_label.includes('overrides'));
});

test('growth multiplier changes recommendations end to end', () => {
  const base = computeRecommendations(input({
    lines: [line({ sku: 'G-1', available: 100, ...steady(2) })],
    skuSettings: { 'G-1': settings() },
    warehouse: { 'G-1': 200 },
  }), TODAY);
  const grown = computeRecommendations(input({
    lines: [line({ sku: 'G-1', available: 100, ...steady(2) })],
    skuSettings: { 'G-1': settings() },
    warehouse: { 'G-1': 200 },
    globalGrowthMultiplier: 1.5,
  }), TODAY);
  const b = one(base, 'G-1');
  const g = one(grown, 'G-1');
  assert.equal(b.velocity, 2);
  assert.equal(g.velocity, 3);
  assert.equal(b.status, 'OK');               // 50 days cover
  assert.equal(g.status, 'ORDER_NOW');        // 33 days cover < 38
  assert.equal(g.recommended_ship_qty, 14);   // 3×38 − 100 = 14
});

test('results are sorted worst-tier first, then by risk score', () => {
  const out = computeRecommendations(input({
    lines: [
      line({ sku: 'OK-A', available: 100, ...steady(2) }),
      line({ sku: 'OOS-CHEAP', available: 0, ...steady(1), your_price: 10 }),
      line({ sku: 'OOS-DEAR', available: 0, ...steady(1), your_price: 60 }),
    ],
    skuSettings: {
      'OK-A': settings(), 'OOS-CHEAP': settings(), 'OOS-DEAR': settings(),
    },
    warehouse: { 'OK-A': 400, 'OOS-CHEAP': 50, 'OOS-DEAR': 50 },
  }), TODAY);
  assert.deepEqual(out.results.map(r => r.sku), ['OOS-DEAR', 'OOS-CHEAP', 'OK-A']);
});

test('open transfer suppresses re-recommending the same units, and total pipeline is unchanged', () => {
  // Low-but-in-stock SKU, 2/day. Warehouse already netted to 300 (500 committed), 500 in transit.
  const withTransfer = computeRecommendations(input({
    lines: [line({ sku: 'T-1', available: 40, ...steady(2) })],
    skuSettings: { 'T-1': settings() },
    warehouse: { 'T-1': 100 },
    inTransitToFba: { 'T-1': 200 },
  }), TODAY);
  const r = one(withTransfer, 'T-1');
  // 40 available + 200 coming = 120 days FBA cover; pipeline 340 = 170 days → OK, no re-ship.
  assert.equal(r.fba_coming, 200);
  assert.equal(r.recommended_ship_qty, 0, 'should not re-transfer units already in flight');
  assert.equal(r.status, 'OK');

  // Baseline (same units, but all still at warehouse, no transfer): same total pipeline, WOULD ship.
  const baseline = computeRecommendations(input({
    lines: [line({ sku: 'T-1', available: 40, ...steady(2) })],
    skuSettings: { 'T-1': settings() },
    warehouse: { 'T-1': 300 },
  }), TODAY);
  const b = one(baseline, 'T-1');
  assert.equal(b.total_pipeline, r.total_pipeline, 'submitting a transfer must not change total pipeline');
  assert.ok(b.recommended_ship_qty > 0, 'without the transfer it should recommend shipping');
});

test('parse flags propagate to DATA_SUSPECT', () => {
  const out = computeRecommendations(input({
    lines: [line({ sku: 'SUS-1', available: 10, ...steady(1), parse_flags: ['NEGATIVE_QTY_ZEROED'] })],
    skuSettings: { 'SUS-1': settings() },
  }), TODAY);
  assert.ok(one(out, 'SUS-1').flags.includes('DATA_SUSPECT'));
});
