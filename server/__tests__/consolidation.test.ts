import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.ts';
import { commitSnapshot } from '../import/commit.ts';
import { assembleEngineInput } from '../assemble.ts';
import type { NormalizedLine } from '../import/fba.ts';

// Two FBA SKUs on ONE ASIN — Benoit's real case: B07PLPZ757 carries both MFL12 (the listing that
// sells) and MFL12_FNSKU (a relabelled duplicate holding ~1,000 units and no sales history). They
// are the same physical product, so the plan must see one product with all of the stock.
const ASIN = 'B07PLPZ757';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function line(sku: string, fnsku: string, o: Partial<NormalizedLine>): NormalizedLine {
  return {
    sku, fnsku, asin: ASIN, title: `Silicone ${sku}`, condition: 'New',
    available: 0, inbound_working: 0, inbound_shipped: 0, inbound_received: 0, fc_transfer: 0,
    reserved: 0, unfulfillable: 0,
    units_shipped_t7: null, units_shipped_t30: null, units_shipped_t60: null, units_shipped_t90: null,
    amazon_days_of_supply: null, amazon_min_inventory_level: null, your_price: 30,
    raw: {}, flags: [], ...o,
  } as NormalizedLine;
}

/** The real figures from the export, so the numbers here are the ones the team sees. */
function seed(db: Database.Database, primaryClass: string, duplicateClass: string) {
  commitSnapshot(db, {
    snapshotDate: '2026-07-27', filename: 'fba.csv', warnings: [],
    rowsTotal: 2, rowsSkipped: 0, nowIso: '2026-07-27T12:00:00Z',
    lines: [
      // The selling listing: 265 available, 7 reserved, 326 moving between Amazon FCs.
      line('MFL12', ASIN, { available: 265, reserved: 7, fc_transfer: 326, units_shipped_t30: 230, units_shipped_t90: 690 }),
      // The relabelled duplicate: 1,000 units, no sales of its own.
      line('MFL12_FNSKU', 'X0057756K1', { available: 10, reserved: 101, fc_transfer: 889 }),
    ],
  } as any);
  db.prepare('UPDATE skus SET classification = ? WHERE sku = ?').run(primaryClass, 'MFL12');
  db.prepare('UPDATE skus SET classification = ? WHERE sku = ?').run(duplicateClass, 'MFL12_FNSKU');
}

test('consolidation: a duplicate listing left unclassified still contributes its stock', () => {
  // THE BUG: grouping was gated on classification. A duplicate with no sales is naturally left
  // unclassified, so it never joined the group — and 1,000 real units went missing. The tool then
  // warned the primary was running out while the warehouse shelf at Amazon was full.
  const db = freshDb();
  seed(db, 'replenishable', 'unclassified');
  const input = assembleEngineInput(db)!;

  const primary = input.lines.find(l => l.sku === 'MFL12')!;
  assert.equal(primary.available, 275, '265 + the duplicate\'s 10');
  assert.equal(primary.reserved, 108, '7 + 101');
  assert.equal(primary.fc_transfer, 1215, '326 + 889 — both FC-transfer pools');
  assert.equal(input.skuSettings['MFL12_FNSKU'].consolidated_into, 'MFL12', 'duplicate is suspended');
  assert.equal(input.skuSettings['MFL12'].consolidated_into ?? null, null, 'primary is never suspended');
  db.close();
});

test('consolidation: the selling listing stays primary, never the relabelled duplicate', () => {
  // If the duplicate became primary the plan would move onto a SKU with no sales history, and the
  // real listing would be suspended — silently stopping replenishment of a live product.
  const db = freshDb();
  seed(db, 'replenishable', 'unclassified');
  const input = assembleEngineInput(db)!;
  assert.equal(input.skuSettings['MFL12'].consolidated_into ?? null, null);
  assert.equal(input.skuSettings['MFL12_FNSKU'].consolidated_into, 'MFL12');
  // Sales history must survive on the primary.
  assert.equal(input.lines.find(l => l.sku === 'MFL12')!.units_shipped_t30, 230);
  db.close();
});

test('consolidation: skipped entirely when nothing in the group is planned', () => {
  // Two unclassified duplicates are not a product being replenished — leave them alone so the
  // new-product triage list still shows both.
  const db = freshDb();
  seed(db, 'unclassified', 'unclassified');
  const input = assembleEngineInput(db)!;
  assert.equal(input.skuSettings['MFL12'].consolidated_into ?? null, null);
  assert.equal(input.skuSettings['MFL12_FNSKU'].consolidated_into ?? null, null);
  assert.equal(input.lines.find(l => l.sku === 'MFL12')!.available, 265, 'untouched');
  db.close();
});

test('consolidation: an identical position tuple is counted once, not doubled', () => {
  // Amazon sometimes reports ONE shared physical pool against both SKUs. Summing that would invent
  // stock, so an identical tuple is treated as the same pool and deduped.
  const db = freshDb();
  commitSnapshot(db, {
    snapshotDate: '2026-07-27', filename: 'fba.csv', warnings: [],
    rowsTotal: 2, rowsSkipped: 0, nowIso: '2026-07-27T12:00:00Z',
    lines: [
      line('MFL12', ASIN, { available: 265, reserved: 7, fc_transfer: 326, units_shipped_t30: 230 }),
      line('MFL12_DUP', 'X1', { available: 265, reserved: 7, fc_transfer: 326 }),   // same pool, reported twice
    ],
  } as any);
  db.prepare('UPDATE skus SET classification = ? WHERE sku = ?').run('replenishable', 'MFL12');
  const input = assembleEngineInput(db)!;
  const primary = input.lines.find(l => l.sku === 'MFL12')!;
  assert.equal(primary.available, 265, 'shared pool must not be doubled');
  assert.equal(primary.fc_transfer, 326);
  db.close();
});
