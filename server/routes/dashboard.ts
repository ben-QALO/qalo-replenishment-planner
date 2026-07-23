import type { FastifyInstance } from 'fastify';
import { getDb, today } from '../db/connection.ts';
import { currentRecommendations, latestSnapshot, getSetting, templateParamsById } from '../assemble.ts';
import { diffDays } from '../../engine/dates.ts';

/**
 * The "Needs attention" worklist — the countable, human-owned tasks the tool surfaces
 * but never actions itself. Everything here is a click-through to the exact items.
 */
function buildWorklist(db: Database.Database, output: ReturnType<typeof currentRecommendations>, snapshotDate: string | null) {
  const todayStr = today();

  // Review workflow: proposed requests awaiting the inventory team, reviewed requests
  // awaiting the Amazon team to export & hand to the warehouse.
  const toReview = (db.prepare("SELECT COUNT(*) c FROM transfers WHERE status='proposed'").get() as any).c;
  const toExport = (db.prepare("SELECT COUNT(*) c FROM transfers WHERE status='reviewed'").get() as any).c;

  // POs that need a human touch: draft to send, ordered/in-transit past ETA, or receivable.
  const pos = db.prepare("SELECT id, po_number, status, expected_arrival FROM purchase_orders WHERE status IN ('draft','ordered','in_transit')").all() as any[];
  const posToAction = pos.filter(p =>
    p.status === 'draft' ||
    (p.expected_arrival && p.expected_arrival < todayStr));

  // New products awaiting a keep/ignore decision.
  const unclassified = (db.prepare("SELECT COUNT(*) c FROM skus WHERE classification = 'unclassified'").get() as any).c;

  // Replenishable SKUs with no velocity the tool can use.
  const noVelocity = (output?.results ?? []).filter(r => r.classification === 'replenishable' && r.velocity === null).length;

  // Active products with no QALO↔Amazon mapping — warehouse stock and orders can't be trusted for
  // these until they're mapped (the tool can't tie NetSuite stock to the Amazon listing).
  // Covered = SKU directly mapped OR its ASIN already mapped (auto-consolidates into the sibling).
  const unmapped = (db.prepare(`SELECT COUNT(*) c FROM skus s
    WHERE s.classification IN ('replenishable','watch','unclassified')
      AND NOT EXISTS (SELECT 1 FROM sku_map m WHERE m.amazon_sku = s.sku)
      AND NOT EXISTS (SELECT 1 FROM sku_map m WHERE m.asin = s.asin AND s.asin IS NOT NULL AND s.asin <> '')`).get() as any).c;

  return {
    transfers_to_review: toReview,
    transfers_to_export: toExport,
    pos_to_action: posToAction.length,
    new_products: unclassified,
    no_velocity: noVelocity,
    unmapped_skus: unmapped,
    total: toReview + toExport + posToAction.length + unclassified + noVelocity + unmapped,
  };
}

// (kept as a plain import type)
type Database = import('better-sqlite3').Database;

export function dashboardRoutes(app: FastifyInstance): void {
  app.get('/api/dashboard', () => {
    const db = getDb();
    const snapshot = latestSnapshot(db);
    const todayStr = today();
    const output = snapshot ? currentRecommendations(db, todayStr) : null;

    const activeTemplateId = Number(getSetting(db, 'active_template_id') ?? 1);
    const activeTemplate = templateParamsById(db, activeTemplateId);

    const warehouseMeta = db.prepare('SELECT MAX(updated_at) AS latest, COUNT(*) AS rows FROM warehouse_inventory').get() as any;
    const activity = db.prepare('SELECT kind, filename, imported_at, status, rows_ok, new_skus FROM import_log ORDER BY id DESC LIMIT 6').all();

    return {
      today: todayStr,
      snapshot: snapshot
        ? { ...snapshot, age_days: diffDays(todayStr, snapshot.snapshot_date) }
        : null,
      active_template: activeTemplate ? { id: activeTemplateId, name: activeTemplate.name } : null,
      warehouse: { last_updated: warehouseMeta?.latest ?? null, sku_count: warehouseMeta?.rows ?? 0 },
      summary: output?.summary ?? null,
      worklist: buildWorklist(db, output, snapshot?.snapshot_date ?? null),
      activity,
    };
  });
}
