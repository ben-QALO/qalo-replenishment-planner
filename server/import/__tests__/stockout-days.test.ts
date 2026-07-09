import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../../db/migrate.ts';
import { commitSnapshot } from '../commit.ts';
import { computeStockoutDays } from '../../assemble.ts';
import type { NormalizedLine } from '../fba.ts';

function db() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  migrate(d);
  return d;
}
function ln(sku: string, available: number): NormalizedLine {
  return {
    sku, fnsku: null, asin: null, title: sku, condition: 'New',
    available, inbound_working: 0, inbound_shipped: 0, inbound_received: 0, reserved: 0, unfulfillable: 0,
    units_shipped_t7: 1, units_shipped_t30: 5, units_shipped_t60: 10, units_shipped_t90: 15,
    amazon_days_of_supply: null, amazon_min_inventory_level: null, your_price: 10, raw: {}, flags: [],
  };
}

test('computeStockoutDays: needs ≥3 snapshots, else SKU is absent (no false history)', () => {
  const d = db();
  commitSnapshot(d, { snapshotDate: '2026-07-01', filename: 'a', fileHash: 'a', lines: [ln('A', 0)], warnings: [], rowsTotal: 1, rowsSkipped: 0, nowIso: 'x' });
  commitSnapshot(d, { snapshotDate: '2026-07-08', filename: 'b', fileHash: 'b', lines: [ln('A', 0)], warnings: [], rowsTotal: 1, rowsSkipped: 0, nowIso: 'x' });
  const two = computeStockoutDays(d, '2026-07-08');
  assert.equal(two['A'], undefined, 'two snapshots is not enough history');
});

test('computeStockoutDays: counts OOS span between weekly snapshots within each window', () => {
  const d = db();
  // Weekly snapshots; A is OOS on Jun 15 & Jun 22, back in stock Jun 29 & Jul 06.
  const dates = ['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06'];
  const avail = [10, 0, 0, 12, 12];
  dates.forEach((dt, i) =>
    commitSnapshot(d, { snapshotDate: dt, filename: dt, fileHash: dt, lines: [ln('A', avail[i])], warnings: [], rowsTotal: 1, rowsSkipped: 0, nowIso: 'x' }));
  const so = computeStockoutDays(d, '2026-07-06');
  assert.ok(so['A'], 'SKU A should have history');
  assert.equal(so['A'].samples, 5);
  // OOS from Jun 15 (21 days ago) to Jun 29 (7 days ago) = 14 days, all inside the 30/60/90 windows.
  assert.equal(so['A'].d30, 14);
  assert.equal(so['A'].d60, 14);
  assert.equal(so['A'].d90, 14);
  // The 7-day window (Jun 29–Jul 6) had stock → 0 stockout days.
  assert.equal(so['A'].d7, 0);
});

test('computeStockoutDays: an always-in-stock SKU reports zero stockout days', () => {
  const d = db();
  ['2026-06-15', '2026-06-22', '2026-06-29'].forEach(dt =>
    commitSnapshot(d, { snapshotDate: dt, filename: dt, fileHash: dt, lines: [ln('A', 50)], warnings: [], rowsTotal: 1, rowsSkipped: 0, nowIso: 'x' }));
  const so = computeStockoutDays(d, '2026-06-29');
  assert.deepEqual([so['A'].d7, so['A'].d30, so['A'].d60, so['A'].d90], [0, 0, 0, 0]);
});
