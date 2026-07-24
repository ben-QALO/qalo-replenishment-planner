import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendTransfer, recommendPo, projectDoNothing, projectPlan, inWords } from '../projection.ts';
import { settings, OCEAN, TODAY } from './helpers.ts';

// A realistic QALO-shaped template: 60d China lead, 35d transfer leg, 120d FBA target,
// 30d warehouse buffer, biweekly transfers, monthly POs.
const QALO = {
  production_days: 45, transit_days: 14, customs_receiving_days: 1,
  fba_ship_checkin_days: 35, safety_days: 14,
  fba_target_cover_days: 120, warehouse_buffer_days: 30, target_cover_days: 225,
  review_period_fba_days: 14, review_period_po_days: 30,
};

test('transfer: refill FBA to target as the shipment lands (accounts for lead-time sales)', () => {
  // v=20, target=2400. FBA 1800 today, nothing coming. Over the 35-day leg it sells 700,
  // so it would land at 1100 → ship 2400 − 1100 = 1300 to be back at target on arrival.
  const r = recommendTransfer(20, 1800, 0, 100_000, QALO, settings());
  assert.equal(r.required, 1300);
  assert.equal(r.recommended_ship_qty, 1300);
  assert.equal(r.shortage, 0);
});

test('transfer: never ships when FBA is already at/above its goal (no case-pack overshoot)', () => {
  const T90 = { ...QALO, fba_target_cover_days: 90 };
  // The reported bug: a ~0.03/day SKU with 3 units ≈ 93 days cover (above the 90-day goal)
  // and a 50-unit case pack was being told to ship a whole case. Must recommend 0.
  const slow = recommendTransfer(0.032, 3, 0, 67, T90, settings({ case_pack: 50 }));
  assert.equal(slow.required, 0);
  assert.equal(slow.recommended_ship_qty, 0);
  // A normal SKU exactly at goal holds too.
  const atGoal = recommendTransfer(20, 20 * 90, 0, 100_000, T90, settings());
  assert.equal(atGoal.recommended_ship_qty, 0);
  // Sanity: still ships when genuinely below goal.
  const below = recommendTransfer(20, 20 * 40, 0, 100_000, T90, settings());
  assert.ok(below.recommended_ship_qty > 0);
});

test('transfer: prefer whole cases; ship up to 6 months for slow movers, never skip', () => {
  const T = { ...QALO, fba_target_cover_days: 90 };
  // Case pack 50. v=1/day, FBA 55 (below the 90-day goal): need = 90 − (55 − 35) = 70 →
  // round UP to whole cases → 100 (lands at ~120 units ≈ 4 months, well under the 6-month cap).
  const under = recommendTransfer(1, 55, 0, 100_000, T, settings({ case_pack: 50 }));
  assert.equal(under.recommended_ship_qty, 100);
  // FBA 33: need = 90 − (33 − 35) = 92 → 2 cases = 100.
  const over = recommendTransfer(1, 33, 0, 100_000, T, settings({ case_pack: 50 }));
  assert.equal(over.recommended_ship_qty, 100);
  // A slow seller is NOT skipped: here a full 50-case is ~6 months of cover, so ship it —
  // rather slightly too much than out of stock. v=0.3/day, FBA 15 → need 22.5 → one case = 50.
  const lowSeller = recommendTransfer(0.3, 15, 0, 100_000, T, settings({ case_pack: 50 }));
  assert.equal(lowSeller.recommended_ship_qty, 50);
});

test('transfer: too slow for FBA (one case > 6 months of cover) → ship nothing, keep it FBM', () => {
  const T = { ...QALO, fba_target_cover_days: 90 };
  // Trickle SKU: v=0.1/day, case pack 50 → one 50-case ≈ 500 days of cover. Even with FBA nearly
  // empty (2 units — which would be a "rescue" for a normal mover), it ships 0: it's fulfilled by
  // merchant from the warehouse, so an empty FBA shelf is fine. The China PO still keeps a case
  // in the warehouse.
  const r = recommendTransfer(0.1, 2, 0, 100_000, T, settings({ case_pack: 50 }));
  assert.equal(r.recommended_ship_qty, 0);
  assert.equal(r.too_slow_for_fba, true);
});

test('transfer: RESCUE ships a partial case rather than let FBA go dark (43 of 50 → 43)', () => {
  const T = { ...QALO, fba_target_cover_days: 90 };
  // v=1, FBA 20 units < the 35+14-day rescue floor → FBA would go dark before the next cycle.
  // Whole-case-only is the normal rule, but a rescue is the one exception: ship the loose 43
  // the warehouse has rather than nothing.
  const r = recommendTransfer(1, 20, 0, 43, T, settings({ case_pack: 50 }));
  assert.equal(r.recommended_ship_qty, 43);
});

test('transfer: about to run dry → round up to a case even if under ¾', () => {
  const T = { ...QALO, fba_target_cover_days: 90 };
  // v=1/day, FBA 20 units < the 35-day ship leg → runs dry before a shipment lands →
  // ship a case to keep it in stock, regardless of the ¾ rule.
  const r = recommendTransfer(1, 20, 0, 100_000, T, settings({ case_pack: 50 }));
  assert.ok(r.recommended_ship_qty >= 50);
});

test('transfer: units already on the way are credited (not re-shipped)', () => {
  // Same as above but 1300 already in transit → projected on arrival = 1800+1300−700 = 2400 → ship 0.
  const r = recommendTransfer(20, 1800, 1300, 100_000, QALO, settings());
  assert.equal(r.required, 0);
  assert.equal(r.recommended_ship_qty, 0);
});

test('transfer: warehouse reserve is protected and the shortfall is reported, not hidden', () => {
  // Needs 1300, warehouse has 700, buffer = 20×30 = 600 → safe = 100 → ship 100, shortage 1200.
  const r = recommendTransfer(20, 1800, 0, 700, QALO, settings());
  assert.equal(r.required, 1300);
  assert.equal(r.safe, 100);
  assert.equal(r.recommended_ship_qty, 100);
  assert.equal(r.shortage, 1200);
});

test('transfer: whole cases only — a sub-case spare waits (not a rescue)', () => {
  // required 1300 (whole cases). Warehouse 725, buffer 600 → spare 125. Loose picks to FBA are
  // too costly, and this isn't a rescue (FBA has ~90 days), so ship WHOLE cases only:
  // floor(125/50) = 2 cases = 100. The loose 25 waits for a full case.
  const r = recommendTransfer(20, 1800, 0, 725, QALO, settings({ case_pack: 50 }));
  assert.equal(r.required, 1300);
  assert.equal(r.safe, 125);
  assert.equal(r.recommended_ship_qty, 100);
});

test('po: a deficit is closed in ONE order, placed TODAY', () => {
  // System target = v × (120 goal + 35 FBA leg + 30 reserve + 60 lead + 15 half-cycle)
  // = 20×260 = 5,200. FBA position 1,000 (1,400 below goal) + warehouse 800 = pipeline 1,800
  // → order the WHOLE hole: 5,200 − 1,800 = 3,400, placed today.
  const r = recommendPo(20, 1800, 1000, QALO, settings(), TODAY);
  assert.equal(r.recommended_po_qty, 3400);
  assert.equal(r.place_by_date, TODAY);
  assert.equal(r.need_by_arrival, '2026-09-07');   // today + 60-day lead: realistic landing
});

test('po: steady state ≈ one month of demand; small gaps wait (deadband)', () => {
  // Healthy (FBA at goal). Position 4,600 vs target 5,200 → 600 ≈ one review cycle → order.
  const monthly = recommendPo(20, 4600, 2400, QALO, settings(), TODAY);
  assert.equal(monthly.recommended_po_qty, 600);
  // Position 5,000 → gap 200 < half a PO cycle (300) → wait, don't nag.
  const tiny = recommendPo(20, 5000, 2400, QALO, settings(), TODAY);
  assert.equal(tiny.recommended_po_qty, 0);
});

test('po: MOQ and order multiple applied on a healthy top-up', () => {
  const r = recommendPo(20, 4600, 2400, QALO, settings({ moq: 1000, order_multiple: 100 }), TODAY);
  assert.equal(r.recommended_po_qty, 1000);           // 600 → padded to MOQ 1000
  assert.ok(r.flags.includes('MOQ_PADDED'));
  // Healthy (no deficit) → date derived from cover, so the order is due in the future.
  assert.ok(r.place_by_date! > TODAY && r.place_by_date! < r.need_by_arrival!);
});

test('transfer: soft reserve — a rescue may ship the whole warehouse', () => {
  // v=20, FBA 500 = 25 days < leg (35) + review (14) → rescue: the 600-unit reserve is
  // NOT held back while Amazon goes dark. The whole 700 in the warehouse is shippable.
  const rescue = recommendTransfer(20, 500, 0, 700, QALO, settings());
  assert.equal(rescue.safe, 700, 'reserve dipped in a rescue');
  assert.equal(rescue.recommended_ship_qty, 700);
  assert.ok(rescue.shortage > 0, 'the remaining gap is still reported');
  // Routine (FBA at 75 days): the reserve throttles as designed → only 100 to give.
  const routine = recommendTransfer(20, 1500, 0, 700, QALO, settings());
  assert.equal(routine.safe, 100);
});

test('projectPlan: MFL10 exact numbers — deficit recovered, goal reached, no avoidable dark days', () => {
  // The reported failure: 21.01/day, 726 at FBA, 2,099 in the warehouse, nothing inbound,
  // cases of 50. Old logic: PO 450 "for September", FBA never reaches goal in 6 months.
  const T90 = { ...QALO, fba_target_cover_days: 90 };
  const p = projectPlan(21.01, 726, 0, 2099, [], T90, settings({ case_pack: 50, order_multiple: 50 }), 180, 1.5);
  const firstShip = p.events.find(e => e.kind === 'ship');
  assert.ok(firstShip && firstShip.day === 0 && firstShip.qty === 1950,
    `rescue ships 1,950 on day 0 (reserve dipped): ${JSON.stringify(firstShip)}`);
  const firstPo = p.events.find(e => e.kind === 'po_placed');
  assert.ok(firstPo && firstPo.day === 0 && firstPo.qty >= 1250,
    `the system-wide hole is ordered on day 0: ${JSON.stringify(firstPo)}`);
  // FBA reaches the goal line, and after the first landing it never goes dark again.
  assert.ok(Math.max(...p.series.map(pt => pt.fba)) >= p.goalUnits * 0.98, 'goal reached');
  assert.ok(p.series.filter(pt => pt.day > 36).every(pt => pt.fba > 0), 'no dark days after the first landing');
  // Every point carries all four inventory buckets for the stacked total-inventory chart.
  const pt = p.series[20];
  for (const k of ['fba', 'inTransit', 'warehouse', 'onOrder'] as const) {
    assert.ok(typeof pt[k] === 'number' && pt[k]! >= 0, `series point has ${k}`);
  }
});

test('projectDoNothing: FBA drains at velocity, flags the stockout day', () => {
  const p = projectDoNothing(20, 1000, 0, 0, [], QALO, 180);
  assert.equal(p.stockoutDay, 50);       // 1000 / 20
  assert.equal(p.belowTargetDay, 0);     // already below the 2400 target line
});

test('projectDoNothing: an open PO refills the warehouse on its ETA day', () => {
  const p = projectDoNothing(20, 400, 0, 100, [{ day: 30, qty: 500 }], QALO, 90);
  assert.equal(p.stockoutDay, 20);                       // FBA: 400 / 20
  assert.equal(p.series[30].warehouse, 600);             // 100 + 500 landed
});

test('projectPlan: following the plan keeps FBA stocked and lands back on goal', () => {
  const T90 = { ...QALO, fba_target_cover_days: 90 };
  // 20/day, FBA at 1000 (50d, below the 90d goal), warehouse 3000, no POs yet.
  const p = projectPlan(20, 1000, 0, 3000, [], T90, settings(), 180, 1.5);
  // Day 0 ships today's recommendation: 20×90 − (1000 − 20×35) = 1500.
  const firstShip = p.events.find(e => e.kind === 'ship');
  assert.ok(firstShip && firstShip.day === 0 && firstShip.qty === 1500, JSON.stringify(firstShip));
  // It lands on day 35 and brings FBA back to the goal line (2×velocity tolerance).
  const landing = p.series[35];
  assert.ok(Math.abs(landing.fba - p.goalUnits) <= 40, `landed at ${landing.fba} vs goal ${p.goalUnits}`);
  // Following the plan, FBA never hits zero.
  assert.ok(p.series.every(pt => pt.fba > 0), 'no stockout when following the plan');
  // And POs get placed to keep the warehouse fed.
  assert.ok(p.events.some(e => e.kind === 'po_placed'));
});

test('projectPlan: an overstocked SKU is left alone (no ship, no PO)', () => {
  const T90 = { ...QALO, fba_target_cover_days: 90 };
  // 1/day with 2000 units at FBA = 2000 days of cover — deep overstock.
  const p = projectPlan(1, 2000, 0, 500, [], T90, settings(), 180, 1.5);
  assert.equal(p.events.filter(e => e.kind === 'ship').length, 0);
  assert.equal(p.events.filter(e => e.kind === 'po_placed').length, 0);
});

test('inWords speaks in weeks and months, not raw day counts', () => {
  assert.equal(inWords(35), 'about 5 weeks');
  assert.equal(inWords(60), 'about 2 months');
  assert.equal(inWords(14), '2 weeks');
});
