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

test('force re-reads a file already imported (needed when the importer itself changes)', () => {
  const db = freshDb();
  const first = commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 5)] });
  assert.equal(first.alreadyImported, false);

  // Same file again → correctly a no-op, so an accidental double-drop is harmless.
  const again = commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 5)] });
  assert.equal(again.alreadyImported, true);
  assert.equal(again.revision, first.revision, 'no-op must not bump the revision');

  // But when a fix teaches the importer a column it used to ignore, the SAME file has to be re-read
  // or the stored snapshot keeps the old, wrong numbers forever. `force` is that escape hatch.
  const forced = commitSnapshot(db, { ...base, fileHash: 'h1', lines: [mkLine('A', 99)] , force: true });
  assert.equal(forced.alreadyImported, false, 'force must not short-circuit');
  assert.equal(forced.revision, first.revision + 1, 'a real re-import bumps the revision');
  const row = db.prepare('SELECT available FROM snapshot_lines WHERE sku = ?').get('A') as { available: number };
  assert.equal(row.available, 99, 'the re-read values must actually replace the old ones');
  db.close();
});

test('a new SKU arrives with the CORE family standard: 50-unit carton, 50 MOQ', () => {
  // Silicone ships in cartons of 50. A blank case pack sizes transfers and POs to the unit instead
  // of the carton, so the tool asks for quantities the factory and warehouse cannot pick. New SKUs
  // land as CORE (the column default), so they start with the standard rather than blank.
  const db = freshDb();
  commitSnapshot(db, { ...base, lines: [mkLine('NEW-RING-1', 10), mkLine('NEW-RING-2', 0)] });

  const rows = db.prepare('SELECT sku, category, case_pack, moq FROM skus ORDER BY sku').all() as
    { sku: string; category: string; case_pack: number; moq: number }[];
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.category, 'core', 'a new SKU is CORE until someone says otherwise');
    assert.equal(r.case_pack, 50, `${r.sku} should start with a 50-unit carton`);
    assert.equal(r.moq, 50, `${r.sku} should start with a 50 MOQ`);
  }
});

test('re-importing does not stamp over a case pack someone deliberately changed', () => {
  // The 50/50 is the family standard, not a lock — a bulk multipack with a different carton must
  // survive the next Amazon import.
  const db = freshDb();
  commitSnapshot(db, { ...base, lines: [mkLine('BULK-24', 10)] });
  db.prepare('UPDATE skus SET case_pack = 24, moq = 240 WHERE sku = ?').run('BULK-24');

  commitSnapshot(db, { ...base, snapshotDate: '2026-07-16', lines: [mkLine('BULK-24', 8)] });
  const r = db.prepare('SELECT case_pack, moq FROM skus WHERE sku = ?').get('BULK-24') as
    { case_pack: number; moq: number };
  assert.equal(r.case_pack, 24, 'a deliberate exception must not be overwritten');
  assert.equal(r.moq, 240);
});
