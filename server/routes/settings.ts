import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision } from '../db/connection.ts';
import { getSetting, setSetting } from '../assemble.ts';

export function settingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings', () => {
    const db = getDb();
    return {
      velocity_weights: JSON.parse(getSetting(db, 'velocity_weights') ?? '{}'),
      global_growth_multiplier: Number(getSetting(db, 'global_growth_multiplier') ?? '1'),
      order_soon_days: Number(getSetting(db, 'order_soon_days') ?? '7'),
      overstock_factor: Number(getSetting(db, 'overstock_factor') ?? '1.5'),
      stockout_correction: (getSetting(db, 'stockout_correction') ?? '1') === '1',
      active_template_id: Number(getSetting(db, 'active_template_id') ?? 1),
    };
  });

  app.patch('/api/settings', (req, reply) => {
    const b = (req.body ?? {}) as any;
    const db = getDb();
    let changed = false;

    if (b.velocity_weights) {
      const w = b.velocity_weights;
      const vals = [w.w7, w.w30, w.w60, w.w90].map(Number);
      if (vals.some(v => !Number.isFinite(v) || v < 0)) {
        return reply.code(400).send({ error: 'weights must be non-negative numbers' });
      }
      const sum = vals.reduce((a, c) => a + c, 0);
      if (Math.abs(sum - 1) > 0.001) {
        return reply.code(400).send({ error: `weights must sum to 1 (got ${sum.toFixed(3)})` });
      }
      setSetting(db, 'velocity_weights', JSON.stringify({ w7: vals[0], w30: vals[1], w60: vals[2], w90: vals[3] }));
      changed = true;
    }
    if ('global_growth_multiplier' in b) {
      const g = Number(b.global_growth_multiplier);
      if (!Number.isFinite(g) || g <= 0 || g > 10) return reply.code(400).send({ error: 'growth multiplier must be between 0 and 10' });
      setSetting(db, 'global_growth_multiplier', String(g));
      changed = true;
    }
    if ('order_soon_days' in b) {
      const d = Number(b.order_soon_days);
      if (!Number.isFinite(d) || d < 0 || d > 90) return reply.code(400).send({ error: 'order_soon_days must be 0–90' });
      setSetting(db, 'order_soon_days', String(Math.round(d)));
      changed = true;
    }
    if ('overstock_factor' in b) {
      const f = Number(b.overstock_factor);
      if (!Number.isFinite(f) || f < 1) return reply.code(400).send({ error: 'overstock_factor must be ≥ 1' });
      setSetting(db, 'overstock_factor', String(f));
      changed = true;
    }
    if ('stockout_correction' in b) {
      setSetting(db, 'stockout_correction', b.stockout_correction ? '1' : '0');
      changed = true;
    }
    if (changed) bumpRevision();
    return { ok: true };
  });
}
