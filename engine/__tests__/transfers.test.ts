import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netTransfers, type OpenTransfer, type WarehouseRow } from '../transfers.ts';

const wh = (onHand: number, updatedAt: string): WarehouseRow => ({ onHand, updatedAt });
const T = (sku: string, qty: number, submitted_at: string, baseline_fba = 0): OpenTransfer =>
  ({ sku, qty, submitted_at, baseline_fba });

test('same-session submit: transfer submitted after this SKU import is netted from warehouse', () => {
  const r = netTransfers(
    [T('A', 50, '2026-07-05T10:00:00Z', 0)],
    { A: wh(200, '2026-07-01T00:00:00Z') },
    { A: 0 }, // Amazon shows nothing yet
  );
  assert.equal(r.warehouseUsable.A, 150); // 200 − 50
  assert.equal(r.inTransit.A, 50);        // nothing landed
});

test('HIGH regression: a partial import of OTHER SKUs must not un-net this transfer', () => {
  // B's transfer submitted 07-05. B's own warehouse row still dates 07-01 (B absent from the
  // 07-09 import). An unrelated SKU C was updated 07-09. Per-SKU cutoff must still net B.
  const r = netTransfers(
    [T('B', 50, '2026-07-05T10:00:00Z', 0)],
    { B: wh(200, '2026-07-01T00:00:00Z'), C: wh(10, '2026-07-09T00:00:00Z') },
    { B: 0 },
  );
  assert.equal(r.warehouseUsable.B, 150, 'B must stay netted despite C being newer');
  assert.equal(r.inTransit.B, 50);
});

test('next session: fresh import reflects the drop → transfer no longer subtracted', () => {
  // Warehouse now shows the dropped figure (150) with a newer updated_at than the submit.
  const r = netTransfers(
    [T('A', 50, '2026-07-05T10:00:00Z', 0)],
    { A: wh(150, '2026-07-08T00:00:00Z') },
    { A: 0 }, // still in the prep gap, Amazon shows nothing
  );
  assert.equal(r.warehouseUsable.A, 150, 'not double-subtracted');
  assert.equal(r.inTransit.A, 50, 'still counted as in-flight until Amazon shows it');
});

test('landed: Amazon has taken in the units → in-transit shrinks, no double count', () => {
  // baseline at submit was 0; Amazon now shows 50 (available+inbound) → fully landed.
  const r = netTransfers(
    [T('A', 50, '2026-07-05T10:00:00Z', 0)],
    { A: wh(150, '2026-07-08T00:00:00Z') },
    { A: 50 },
  );
  assert.equal(r.inTransit.A, 0, 'Amazon shows them, so nothing is still in flight');
});

test('MEDIUM regression: residual Amazon inbound from a different cohort is in the baseline', () => {
  // A already had 100 units inbound (a prior/direct shipment) when the new 40 transfer was
  // submitted → baseline 100. Amazon still shows 100 (new one not arrived) → 40 still in flight.
  const r = netTransfers(
    [T('A', 40, '2026-07-05T10:00:00Z', 100)],
    { A: wh(160, '2026-07-05T09:00:00Z') },
    { A: 100 },
  );
  assert.equal(r.inTransit.A, 40, 'new transfer not swallowed by pre-existing inbound');
});

test('MEDIUM regression: reconcile lag — units moved to available while transfer still open', () => {
  // baseline 0 at submit; units now sit in available so Amazon (available+inbound)=50.
  // landed=50 → in-flight 0, so it will NOT be double-counted on top of available.
  const r = netTransfers(
    [T('A', 50, '2026-07-05T10:00:00Z', 0)],
    { A: wh(150, '2026-07-08T00:00:00Z') },
    { A: 50 },
  );
  assert.equal(r.inTransit.A, 0);
});

test('overlapping transfers on one SKU: FIFO landed attribution', () => {
  // Two transfers (50 + 30), earliest baseline 0. Amazon shows 50 → first landed, second in flight.
  const r = netTransfers(
    [T('A', 50, '2026-07-01T00:00:00Z', 0), T('A', 30, '2026-07-08T00:00:00Z', 50)],
    { A: wh(200, '2026-07-08T12:00:00Z') },
    { A: 50 },
  );
  assert.equal(r.inTransit.A, 30, '80 total − 50 landed');
});

test('SKU with a warehouse row but no transfers passes through unchanged', () => {
  const r = netTransfers([], { A: wh(120, '2026-07-08T00:00:00Z') }, { A: 5 });
  assert.equal(r.warehouseUsable.A, 120);
  assert.equal(r.inTransit.A, undefined);
});

test('transfer on a SKU with no warehouse row nets from zero', () => {
  const r = netTransfers([T('X', 25, '2026-07-05T00:00:00Z', 0)], {}, { X: 0 });
  assert.equal(r.warehouseUsable.X, 0);
  assert.equal(r.inTransit.X, 25);
});
