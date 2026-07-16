import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePositions, daysOfCover, earliestArrival,
  fbaRopDays, poRopDays, chinaLeadDays, derivedPoTargetDays, poTargetDays, COVER_CAP,
} from '../replenishment.ts';
import { line, OCEAN, AIR, TODAY } from './helpers.ts';

test('rop day math matches the template arithmetic', () => {
  assert.equal(chinaLeadDays(OCEAN), 70);   // 30 + 30 + 10
  assert.equal(fbaRopDays(OCEAN), 38);      // 10 + 14 + 14
  assert.equal(poRopDays(OCEAN), 114);      // 70 + 30 + 14
});

test('derived PO target = FBA target + warehouse buffer + China lead + half a PO cycle', () => {
  const t = { ...OCEAN, fba_target_cover_days: 120, warehouse_buffer_days: 30 };
  assert.equal(derivedPoTargetDays(t), 245);  // 120 goal + 10 FBA leg + 30 reserve + 70 lead + 15 half-cycle
  // A hand-set total (114) below the floor cannot hold the FBA target — it is raised.
  assert.equal(poTargetDays(t), 245);
  // A hand-set total ABOVE the floor is respected.
  assert.equal(poTargetDays({ ...t, target_cover_days: 300 }), 300);
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

test('fba_coming = amazon inbound + in-transit (in-transit is already netted upstream)', () => {
  // inTransitToFba here is the netted "not yet at Amazon" figure; summing counts once.
  const gap = computePositions(line({ sku: 'A', available: 20, inbound_shipped: 0 }), 100, [], 500);
  assert.equal(gap.fba_coming, 500);
  assert.equal(gap.fba_position, 520);

  // Amazon shows 60 inbound (already-landed units) plus 40 still genuinely in flight.
  const mixed = computePositions(line({ sku: 'A', available: 20, inbound_shipped: 60 }), 100, [], 40);
  assert.equal(mixed.fba_coming, 100);
  assert.equal(mixed.fba_position, 120);

  const plain = computePositions(line({ sku: 'A', available: 20, inbound_shipped: 60 }), 100, [], 0);
  assert.equal(plain.fba_coming, 60);
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
