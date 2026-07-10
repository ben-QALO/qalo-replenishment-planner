import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../../db/migrate.ts';
import { commitSnapshot } from '../commit.ts';
import type { NormalizedLine } from '../fba.ts';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function mkLine(sku: string, available: number): NormalizedLine {
  return {
    sku, fnsku: null, asin: `ASIN-${sku}`, title: `Ring ${sku}`, condition: 'New',
    available, inbound_working: 0, inbound_shipped: 0, inbound_received: 0,
    reserved: 0, unfulfillable: 0,
    units_shipped_t7: 1, units_shipped_t30: 5, units_shipped_t60: 10, units_shipped_t90: 15,
    amazon_days_of_supply: null, amazon_min_inventory_level: null, your_price: 20,
    raw: {}, flags: [],
  };
}

const base = {
  snapshotDate: '2026-07-09', filename: 'test.csv', warnings: [],
  rowsTotal: 2, rowsSkipped: 0, nowIso: '2026-07-09T12:00:00Z',
};

test('first commit creates snapshot, SKUs as unclassified, log row, revision bump', () => {
  const db = freshDb();
  const rev0 = (db.prepare('SELECT rev FROM state_revision').get() as any).rev;
  const r = commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 10), mkLine('B', 0)] });
  assert.equal(r.replacedPrevious, false);
  assert.deepEqual(r.newSkus.sort(), ['A', 'B']);
  assert.equal(r.revision, 1);

  const skus = db.prepare('SELECT sku, classification FROM skus ORDER BY sku').all() as any[];
  assert.deepEqual(skus, [
    { sku: 'A', classification: 'unclassified' },
    { sku: 'B', classification: 'unclassified' },
  ]);
  const log = db.prepare('SELECT status, new_skus FROM import_log').get() as any;
  assert.equal(log.status, 'committed');
  assert.equal(log.new_skus, 2);
  const rev = db.prepare('SELECT rev FROM state_revision').get() as any;
  assert.equal(rev.rev, rev0 + 1);
});

test('same-day re-import with a different file replaces lines and bumps snapshot revision', () => {
  const db = freshDb();
  commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 10)] });
  const r2 = commitSnapshot(db, { ...base, fileHash: 'h2', lines: [mkLine('A', 8), mkLine('C', 3)] });
  assert.equal(r2.replacedPrevious, true);
  assert.equal(r2.revision, 2);
  assert.deepEqual(r2.newSkus, ['C']);

  const snapshots = db.prepare('SELECT COUNT(*) c FROM snapshots').get() as any;
  assert.equal(snapshots.c, 1, 'still one snapshot for the date');
  const lines = db.prepare('SELECT sku, available FROM snapshot_lines ORDER BY sku').all() as any[];
  assert.deepEqual(lines, [{ sku: 'A', available: 8 }, { sku: 'C', available: 3 }]);
  const log = db.prepare("SELECT COUNT(*) c FROM import_log WHERE status = 'replaced_previous'").get() as any;
  assert.equal(log.c, 1);
});

test('identical file dropped twice short-circuits without changes', () => {
  const db = freshDb();
  commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 10)] });
  const revBefore = (db.prepare('SELECT rev FROM state_revision').get() as any).rev;
  const r2 = commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 10)] });
  assert.equal(r2.alreadyImported, true);
  const revAfter = (db.prepare('SELECT rev FROM state_revision').get() as any).rev;
  assert.equal(revBefore, revAfter, 'no revision bump on a no-op');
});

test('existing SKU metadata refreshes but classification is preserved', () => {
  const db = freshDb();
  commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 10)] });
  db.prepare("UPDATE skus SET classification = 'replenishable' WHERE sku = 'A'").run();
  const updated = { ...mkLine('A', 12), title: 'Ring A (new title)' };
  commitSnapshot(db, { ...base, snapshotDate: '2026-07-10', fileHash: 'h2', lines: [updated] });
  const sku = db.prepare('SELECT classification, title FROM skus WHERE sku = ?').get('A') as any;
  assert.equal(sku.classification, 'replenishable');
  assert.equal(sku.title, 'Ring A (new title)');
});

test('two dates coexist as separate snapshots (history accumulates)', () => {
  const db = freshDb();
  commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 10)] });
  commitSnapshot(db, { ...base, snapshotDate: '2026-07-16', fileHash: 'h2', lines: [mkLine('A', 4)] });
  const count = (db.prepare('SELECT COUNT(*) c FROM snapshots').get() as any).c;
  assert.equal(count, 2);
});
