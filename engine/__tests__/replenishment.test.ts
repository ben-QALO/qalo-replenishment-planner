import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePositions, daysOfCover, fbaLane, poLane, earliestArrival,
  fbaRopDays, poRopDays, chinaLeadDays, COVER_CAP,
} from '../replenishment.ts';
import { line, settings, OCEAN, AIR, TODAY } from './helpers.ts';

test('rop day math matches the template arithmetic', () => {
  assert.equal(chinaLeadDays(OCEAN), 70);   // 30 + 30 + 10
  assert.equal(fbaRopDays(OCEAN), 38);      // 10 + 14 + 14
  assert.equal(poRopDays(OCEAN), 114);      // 70 + 30 + 14
});

test('positions: fba_position counts available + reserved + all inbound stages', () => {
  const p = computePositions(
    line({ sku: 'A', available: 100, reserved: 5, inbound_working: 10, inbound_shipped: 20, inbound_received: 3, unfulfillable: 2 }),
    40,
    [{ sku: 'A', qty_outstanding: 500, expected_arrival: '2026-08-01' }],
  );
  assert.equal(p.fba_position, 138);
  assert.equal(p.warehouse_on_hand, 40);
  assert.equal(p.open_po_units, 500);
  assert.equal(p.total_pipeline, 678);
  assert.equal(p.unfulfillable, 2);
});

test('days of cover: null velocity → null; zero velocity → capped; normal division', () => {
  assert.equal(daysOfCover(100, null), null);
  assert.equal(daysOfCover(100, 0), COVER_CAP);
  assert.equal(daysOfCover(76, 2), 38);
});

test('FBA lane: triggers below rop, order-up-to with case-pack round-up', () => {
  // velocity 2/day, position 60 → 30 days < 38 → raw = 2×38−60 = 16 → cases of 6 → 18
  const r = fbaLane(2, 30, 60, 100, OCEAN, settings({ case_pack: 6 }));
  assert.equal(r.triggered, true);
  assert.equal(r.recommended_ship_qty, 18);
  assert.deepEqual(r.flags, []);
});

test('FBA lane: does not trigger at/above rop', () => {
  const r = fbaLane(2, 38, 76, 100, OCEAN, settings());
  assert.equal(r.triggered, false);
  assert.equal(r.recommended_ship_qty, 0);
});

test('FBA lane: capped by warehouse stock, floored to case pack, flagged', () => {
  // raw need 16 → cases of 6 → 18, but warehouse has 10 → floor to 6, WAREHOUSE_SHORT
  const r = fbaLane(2, 30, 60, 10, OCEAN, settings({ case_pack: 6 }));
  assert.equal(r.recommended_ship_qty, 6);
  assert.ok(r.flags.includes('WAREHOUSE_SHORT'));
});

test('PO lane: order-up-to, MOQ padding, order-multiple rounding, dates', () => {
  // velocity 2, pipeline 160 → 80 days < 114 → raw = 2×114−160 = 68 → MOQ 100 → multiple 25 → 100
  const r = poLane(2, 80, 160, OCEAN, settings({ moq: 100, order_multiple: 25 }), TODAY);
  assert.equal(r.triggered, true);
  assert.equal(r.recommended_po_qty, 100);
  assert.ok(r.flags.includes('MOQ_PADDED'));
  // need_by = today + (80 − 14) = 2026-09-13 ; place_by = need_by − 70 = 2026-07-05
  assert.equal(r.need_by_arrival, '2026-09-13');
  assert.equal(r.place_by_date, '2026-07-05');
});

test('PO lane: heavy rounding is flagged for human review', () => {
  // velocity 1, pipeline 100 → raw = 114−100 = 14 → multiple 100 → 100 (adds 86 days > 30 days) → flag
  const r = poLane(1, 100, 100, OCEAN, settings({ order_multiple: 100 }), TODAY);
  assert.equal(r.recommended_po_qty, 100);
  assert.ok(r.flags.includes('ROUNDING_HEAVY'));
});

test('PO lane: no trigger when pipeline covers the horizon', () => {
  const r = poLane(2, 120, 240, OCEAN, settings(), TODAY);
  assert.equal(r.triggered, false);
  assert.equal(r.recommended_po_qty, 0);
});

test('earliest arrival: warehouse stock → just the FBA leg', () => {
  const p = computePositions(line({ sku: 'A', available: 10 }), 50, []);
  const a = earliestArrival(p, [], OCEAN, AIR, TODAY);
  assert.equal(a.via, 'warehouse');
  assert.equal(a.earliest_fba_arrival, '2026-07-19'); // +10
});

test('earliest arrival: open PO ETA + FBA leg; overdue ETA treated as today', () => {
  const p = computePositions(line({ sku: 'A', available: 10 }), 0, []);
  const a = earliestArrival(p, [{ sku: 'A', qty_outstanding: 100, expected_arrival: '2026-08-01' }], OCEAN, AIR, TODAY);
  assert.equal(a.via, 'open_po');
  assert.equal(a.earliest_fba_arrival, '2026-08-11'); // ETA + 10

  const overdue = earliestArrival(p, [{ sku: 'A', qty_outstanding: 100, expected_arrival: '2026-06-01' }], OCEAN, AIR, TODAY);
  assert.equal(overdue.earliest_fba_arrival, '2026-07-19'); // today + 10
});

test('earliest arrival: nothing anywhere → new PO lead, with air alternative', () => {
  const p = computePositions(line({ sku: 'A', available: 10 }), 0, []);
  const a = earliestArrival(p, [], OCEAN, AIR, TODAY);
  assert.equal(a.via, 'new_po');
  assert.equal(a.earliest_fba_arrival, '2026-09-27'); // +70+10 = 80 days
  assert.equal(a.air_earliest, '2026-08-29');         // +41+10 = 51 days
});
