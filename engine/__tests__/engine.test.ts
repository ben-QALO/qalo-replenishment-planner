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
    skuSettings: { 'RING-1': settings({ case_pack: 6, moq: 150, order_multiple: 25 }) },
    warehouse: { 'RING-1': 100 },
  }), TODAY);
  const r = one(out, 'RING-1');
  assert.equal(r.velocity, 2);
  assert.equal(r.fba_position, 60);
  assert.equal(r.fba_days_cover, 30);
  // Transfer: 2×38 − (50 sellable + 10 coming − 2×10 leg-sales) = 36 → cases of 6.
  assert.equal(r.recommended_ship_qty, 36);
  assert.equal(r.total_pipeline, 160);
  // PO: warehouse target 60, projected 100 − 2×70 lead-outflow = −40 → raw 100 → MOQ 150.
  assert.equal(r.recommended_po_qty, 150);
  assert.equal(r.status, 'ORDER_NOW');
  assert.ok(r.flags.includes('MOQ_PADDED'));
  assert.ok(r.why.includes('/day'), `plain-language why: ${r.why}`);
  assert.equal(out.summary.order_now, 1);
  assert.equal(out.summary.ship_units_total, 36);
  assert.equal(out.summary.po_units_total, 150);
});

test('integration: 20/day SKU with real QALO lead times — projection-based recommendations', () => {
  // Real Ocean defaults: 45+14+1 = 60d China lead, 35d FBA leg, 14d safety, 120d FBA
  // target, 30d warehouse buffer.
  const QALO = {
    production_days: 45, transit_days: 14, customs_receiving_days: 1,
    fba_ship_checkin_days: 35, safety_days: 14,
    fba_target_cover_days: 120, warehouse_buffer_days: 30, target_cover_days: 225,
    review_period_fba_days: 14, review_period_po_days: 30,
  };
  const out = computeRecommendations(input({
    globalTemplate: QALO,
    lines: [line({ sku: 'Q-1', available: 2000, ...steady(20) })],
    skuSettings: { 'Q-1': settings() },
    warehouse: { 'Q-1': 2000 },
    openPoLines: [{ sku: 'Q-1', qty_outstanding: 600, expected_arrival: '2026-08-15' }],
  }), TODAY);
  const r = one(out, 'Q-1');
  // Transfer: refill FBA to 2400 as it lands. Projected on arrival = 2000 − 20×35 = 1300 →
  // required 1100. Warehouse spare above the 600-unit reserve = 1400 → ships the full 1100.
  assert.equal(r.transfer_required, 1100);
  assert.equal(r.recommended_ship_qty, 1100);
  assert.equal(r.transfer_shortage, 0);
  // PO: system target = 20 × (120 goal + 35 FBA leg + 30 reserve + 60 lead + 15 half-cycle)
  // = 20 × 260 = 5,200. Total pipeline = 2000 FBA + 2000 warehouse + 600 on order = 4,600.
  // FBA (2000) is below its 2,400 goal → deficit → order the gap 5,200 − 4,600 = 600 today.
  assert.equal(r.recommended_po_qty, 600);
  assert.equal(r.place_by_date, TODAY);
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
  assert.ok(r.why.includes('warehouse'));
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
  // Do-nothing runway drains 58 sellable at 2/day → out in 29 days; earliest ocean arrival 80.
  assert.equal(r.stockout_gap_days, 51);          // 80 − 29
  assert.equal(r.earliest_fba_arrival, '2026-09-27');
  // air: 51 days out vs stockout at 29 days → air gap 22 → saves 29
  assert.equal(r.air_saves_days, 29);
  assert.ok(r.why.includes('Air freight'));
});

test('integration: ORDER_SOON inside the pre-warning window', () => {
  // 2/day, 56 sellable = 28 days cover. Urgent floor = leg 10 + safety 14 = 24; order-soon
  // window 24..31 → 28 lands in ORDER_SOON. Warehouse 200 → pipeline 256 = 128 days: above the
  // PO-urgent line (84) and below overstock (1.5×123) so neither lane escalates or overstocks.
  const out = computeRecommendations(input({
    lines: [line({ sku: 'SOON-1', available: 56, ...steady(2) })],
    skuSettings: { 'SOON-1': settings() },
    warehouse: { 'SOON-1': 200 },
  }), TODAY);
  const r = one(out, 'SOON-1');
  assert.equal(r.status, 'ORDER_SOON');
  // Projection still lists a routine top-up: 2×38 − (56 − 2×10) = 40.
  assert.equal(r.recommended_ship_qty, 40);
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

test('missing from FBA export BUT selling per Business Report → planned (STOCKOUT, ships warehouse stock)', () => {
  // FBM-tested / out-of-stock-on-FBA: no FBA line at all, but the Business Report shows the
  // ASIN actively selling. The tool should treat FBA as empty and still plan a transfer in.
  const out = computeRecommendations(input({
    skuSettings: { 'FBM-1': settings() },
    warehouse: { 'FBM-1': 300 },
    externalDemand: { 'FBM-1': { units: 40, days: 30 } },
  }), TODAY);
  const r = one(out, 'FBM-1');
  assert.equal(r.velocity_source, 'business_report');
  assert.ok(r.flags.includes('MISSING_FROM_IMPORT'));
  assert.equal(r.status, 'STOCKOUT', 'FBA is empty and it is selling → stockout, not "stale"');
  assert.equal(r.include_in_plans, true);
  assert.ok(r.recommended_ship_qty > 0, 'should ship warehouse stock to FBA');
});

test('FBM SKU is never shipped to FBA (transfer forced to 0)', () => {
  // Selling 3/day, 500 in the warehouse — an FBA SKU would ship a big transfer. FBM must not.
  const out = computeRecommendations(input({
    lines: [line({ sku: 'FBM-X', available: 0, ...steady(3) })],
    skuSettings: { 'FBM-X': settings({ fulfillment_channel: 'fbm' }) },
    warehouse: { 'FBM-X': 500 },
  }), TODAY);
  const r = one(out, 'FBM-X');
  assert.equal(r.fulfillment_channel, 'fbm');
  assert.equal(r.recommended_ship_qty, 0, 'FBM SKU must never get a warehouse→FBA transfer');
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
  // Faster sales → bigger transfer to hold the same day-target.
  // base: 2×38 − (100 − 2×10) = -4 → 0.   grown: 3×38 − (100 − 3×10) = 44.
  assert.equal(b.recommended_ship_qty, 0);
  assert.equal(g.recommended_ship_qty, 44);
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
