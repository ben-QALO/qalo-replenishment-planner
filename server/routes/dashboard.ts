import type { FastifyInstance } from 'fastify';
import { getDb, today } from '../db/connection.ts';
import { currentRecommendations, latestSnapshot, getSetting, templateParamsById } from '../assemble.ts';
import { diffDays } from '../../engine/dates.ts';

/**
 * The "Needs attention" worklist — the countable, human-owned tasks the tool surfaces
 * but never actions itself. Everything here is a click-through to the exact items.
 */
function buildWorklist(db: Database.Database, output: ReturnType<typeof currentRecommendations>) {
  const todayStr = today();

  // Transfers awaiting reconciliation (submitted, not yet confirmed inbound).
  const openTransfers = db.prepare(
    "SELECT id, sku, qty, submitted_at FROM transfers WHERE status = 'submitted'").all() as any[];
  const toReconcile = openTransfers.filter(t => diffDays(todayStr, (t.submitted_at ?? todayStr).slice(0, 10)) >= 10);

  // Of those, which ones Amazon now appears to show inbound (nudge to reconcile).
  const inboundBySku = new Map((output?.results ?? []).map(r => [r.sku, r.fba_inbound]));
  const lookInbound = openTransfers.filter(t => (inboundBySku.get(t.sku) ?? 0) >= t.qty * 0.5);

  // POs that need a human touch: draft to send, ordered/in-transit past ETA, or receivable.
  const pos = db.prepare("SELECT id, po_number, status, expected_arrival FROM purchase_orders WHERE status IN ('draft','ordered','in_transit')").all() as any[];
  const posToAction = pos.filter(p =>
    p.status === 'draft' ||
    (p.expected_arrival && p.expected_arrival < todayStr));

  // New products awaiting a keep/ignore decision.
  const unclassified = (db.prepare("SELECT COUNT(*) c FROM skus WHERE classification = 'unclassified'").get() as any).c;

  // Replenishable SKUs with no velocity the tool can use.
  const noVelocity = (output?.results ?? []).filter(r => r.classification === 'replenishable' && r.velocity === null).length;

  return {
    transfers_to_reconcile: toReconcile.length,
    transfers_look_inbound: lookInbound.length,
    transfers_open_total: openTransfers.length,
    pos_to_action: posToAction.length,
    new_products: unclassified,
    no_velocity: noVelocity,
    total: toReconcile.length + posToAction.length + unclassified + noVelocity,
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
      worklist: buildWorklist(db, output),
      activity,
    };
  });
}
