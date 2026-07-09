import type { FastifyInstance } from 'fastify';
import { getDb, today } from '../db/connection.ts';
import { currentRecommendations, latestSnapshot, getSetting, templateParamsById } from '../assemble.ts';
import { diffDays } from '../../engine/dates.ts';

export function dashboardRoutes(app: FastifyInstance): void {
  app.get('/api/dashboard', () => {
    const db = getDb();
    const snapshot = latestSnapshot(db);
    const todayStr = today();
    const output = snapshot ? currentRecommendations(db, todayStr) : null;

    const activeTemplateId = Number(getSetting(db, 'active_template_id') ?? 1);
    const activeTemplate = templateParamsById(db, activeTemplateId);

    const warehouseMeta = db.prepare('SELECT MAX(updated_at) AS latest, COUNT(*) AS rows FROM warehouse_inventory').get() as any;
    const activity = db.prepare('SELECT kind, filename, imported_at, status, rows_ok, new_skus FROM import_log ORDER BY id DESC LIMIT 5').all();

    return {
      today: todayStr,
      snapshot: snapshot
        ? { ...snapshot, age_days: diffDays(todayStr, snapshot.snapshot_date) }
        : null,
      active_template: activeTemplate ? { id: activeTemplateId, name: activeTemplate.name } : null,
      warehouse: { last_updated: warehouseMeta?.latest ?? null, sku_count: warehouseMeta?.rows ?? 0 },
      summary: output?.summary ?? null,
      activity,
    };
  });
}
