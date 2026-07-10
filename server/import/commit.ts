// Transactional snapshot commit: upsert SKUs, replace-or-insert the day's snapshot,
// log the import, bump the state revision. All-or-nothing.
import type Database from 'better-sqlite3';
import type { NormalizedLine } from './fba.ts';
import { autoClassifyNewSkus } from '../keeplist.ts';

export interface CommitInput {
  snapshotDate: string; // YYYY-MM-DD
  filename: string;
  fileHash: string;
  lines: NormalizedLine[];
  warnings: string[];
  rowsTotal: number;
  rowsSkipped: number;
  nowIso: string;
}

export interface CommitResult {
  snapshotId: number;
  revision: number;
  replacedPrevious: boolean;
  newSkus: string[];
  alreadyImported: boolean;
}

export function commitSnapshot(db: Database.Database, input: CommitInput): CommitResult {
  // Identical file already imported for this date → no-op.
  const dupe = db.prepare(
    'SELECT id, revision FROM snapshots WHERE snapshot_date = ? AND file_hash = ?',
  ).get(input.snapshotDate, input.fileHash) as { id: number; revision: number } | undefined;
  if (dupe) {
    return { snapshotId: dupe.id, revision: dupe.revision, replacedPrevious: false, newSkus: [], alreadyImported: true };
  }

  const run = db.transaction((): CommitResult => {
    const existing = db.prepare('SELECT id, revision FROM snapshots WHERE snapshot_date = ?')
      .get(input.snapshotDate) as { id: number; revision: number } | undefined;

    let snapshotId: number;
    let revision: number;
    if (existing) {
      snapshotId = existing.id;
      revision = existing.revision + 1;
      db.prepare('DELETE FROM snapshot_lines WHERE snapshot_id = ?').run(snapshotId);
      db.prepare(`UPDATE snapshots SET source_filename = ?, file_hash = ?, imported_at = ?, revision = ?, row_count = ? WHERE id = ?`)
        .run(input.filename, input.fileHash, input.nowIso, revision, input.lines.length, snapshotId);
    } else {
      revision = 1;
      const res = db.prepare(`INSERT INTO snapshots (snapshot_date, source_filename, file_hash, imported_at, revision, row_count)
        VALUES (?, ?, ?, ?, 1, ?)`)
        .run(input.snapshotDate, input.filename, input.fileHash, input.nowIso, input.lines.length);
      snapshotId = Number(res.lastInsertRowid);
    }

    const insertLine = db.prepare(`INSERT INTO snapshot_lines
      (snapshot_id, sku, fnsku, asin, condition, available, inbound_working, inbound_shipped, inbound_received,
       reserved, unfulfillable, units_shipped_t7, units_shipped_t30, units_shipped_t60, units_shipped_t90,
       amazon_days_of_supply, amazon_min_inventory_level, your_price, raw, flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const skuExists = db.prepare('SELECT sku FROM skus WHERE sku = ?');
    const insertSku = db.prepare(`INSERT INTO skus (sku, asin, fnsku, title, classification, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, 'unclassified', ?, ?)`);
    const refreshSku = db.prepare('UPDATE skus SET asin = COALESCE(?, asin), fnsku = COALESCE(?, fnsku), title = COALESCE(?, title), updated_at = ? WHERE sku = ?');

    const newSkus: string[] = [];
    for (const l of input.lines) {
      if (!skuExists.get(l.sku)) {
        insertSku.run(l.sku, l.asin, l.fnsku, l.title, input.nowIso, input.nowIso);
        newSkus.push(l.sku);
      } else {
        refreshSku.run(l.asin, l.fnsku, l.title, input.nowIso, l.sku);
      }
      insertLine.run(
        snapshotId, l.sku, l.fnsku, l.asin, l.condition,
        l.available, l.inbound_working, l.inbound_shipped, l.inbound_received,
        l.reserved, l.unfulfillable,
        l.units_shipped_t7, l.units_shipped_t30, l.units_shipped_t60, l.units_shipped_t90,
        l.amazon_days_of_supply, l.amazon_min_inventory_level, l.your_price,
        JSON.stringify(l.raw), JSON.stringify(l.flags),
      );
    }

    db.prepare(`INSERT INTO import_log (kind, filename, file_hash, imported_at, status, rows_total, rows_ok, rows_skipped, new_skus, warnings, snapshot_id)
      VALUES ('fba_inventory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.filename, input.fileHash, input.nowIso,
        existing ? 'replaced_previous' : 'committed',
        input.rowsTotal, input.lines.length, input.rowsSkipped,
        newSkus.length, JSON.stringify(input.warnings), snapshotId,
      );

    // Freshly-seen SKUs that are on the keep list become replenishable immediately;
    // the rest stay unclassified for triage.
    autoClassifyNewSkus(db, newSkus);

    db.prepare('UPDATE state_revision SET rev = rev + 1 WHERE id = 1').run();

    return { snapshotId, revision, replacedPrevious: !!existing, newSkus, alreadyImported: false };
  });

  return run();
}
