import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision, nowIso, today } from '../db/connection.ts';
import { currentRecommendations, previewRecommendations, getSetting, setSetting } from '../assemble.ts';

const PARAM_KEYS = [
  'production_days', 'transit_days', 'customs_receiving_days', 'fba_ship_checkin_days',
  'safety_days', 'target_cover_days', 'review_period_fba_days', 'review_period_po_days',
];

function validParams(p: any): boolean {
  return p && typeof p === 'object'
    && PARAM_KEYS.every(k => Number.isFinite(Number(p[k])) && Number(p[k]) >= 0);
}

function cleanParams(p: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of PARAM_KEYS) out[k] = Math.round(Number(p[k]));
  return out;
}

export function templateRoutes(app: FastifyInstance): void {
  app.get('/api/templates', () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM templates ORDER BY name').all() as any[];
    for (const r of rows) r.params = JSON.parse(r.params);
    return { templates: rows, active_template_id: Number(getSetting(db, 'active_template_id') ?? 1) };
  });

  app.post('/api/templates', (req, reply) => {
    const b = (req.body ?? {}) as any;
    if (!b.name || !validParams(b.params)) return reply.code(400).send({ error: 'name and complete numeric params required' });
    const db = getDb();
    try {
      const res = db.prepare('INSERT INTO templates (name, notes, params, is_builtin, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run(String(b.name), b.notes || null, JSON.stringify(cleanParams(b.params)), nowIso(), nowIso());
      return { ok: true, id: Number(res.lastInsertRowid) };
    } catch (err: any) {
      return reply.code(400).send({ error: String(err?.message ?? err) });
    }
  });

  app.patch('/api/templates/:id', (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as any;
    const db = getDb();
    const row = db.prepare('SELECT id, params FROM templates WHERE id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'template not found' });
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (b.name) { sets.push('name = ?'); vals.push(String(b.name)); }
    if ('notes' in b) { sets.push('notes = ?'); vals.push(b.notes || null); }
    if (b.params) {
      if (!validParams(b.params)) return reply.code(400).send({ error: 'params must include all eight numeric fields' });
      sets.push('params = ?');
      vals.push(JSON.stringify(cleanParams(b.params)));
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'nothing to update' });
    sets.push('updated_at = ?');
    vals.push(nowIso(), id);
    db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    bumpRevision(); // params affect recommendations if this template is active or overridden onto SKUs
    return { ok: true };
  });

  app.delete('/api/templates/:id', (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const activeId = Number(getSetting(db, 'active_template_id') ?? 1);
    if (id === activeId) return reply.code(400).send({ error: 'cannot delete the active template' });
    const row = db.prepare('SELECT is_builtin FROM templates WHERE id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'template not found' });
    if (row.is_builtin) return reply.code(400).send({ error: 'built-in templates cannot be deleted (edit or duplicate them instead)' });
    const run = db.transaction(() => {
      db.prepare('UPDATE skus SET template_override_id = NULL WHERE template_override_id = ?').run(id);
      db.prepare('DELETE FROM templates WHERE id = ?').run(id);
    });
    run();
    bumpRevision();
    return { ok: true };
  });

  /** Diff preview: what changes if this template becomes the global default? */
  app.get('/api/templates/:id/preview', (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM templates WHERE id = ?').get(id)) return reply.code(404).send({ error: 'template not found' });
    const todayStr = today();
    const before = currentRecommendations(db, todayStr);
    const after = previewRecommendations(db, todayStr, id);
    if (!before || !after) return reply.code(409).send({ error: 'no snapshot imported yet' });
    return { before: before.summary, after: after.summary };
  });

  app.post('/api/templates/:id/activate', (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM templates WHERE id = ?').get(id)) return reply.code(404).send({ error: 'template not found' });
    const todayStr = today();
    const before = currentRecommendations(db, todayStr)?.summary ?? null;
    setSetting(db, 'active_template_id', String(id));
    bumpRevision();
    const after = currentRecommendations(db, todayStr)?.summary ?? null;
    return { ok: true, before, after };
  });
}
