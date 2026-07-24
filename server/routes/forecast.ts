import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision, nowIso, today } from '../db/connection.ts';

// The board-approved yearly forecast for smart rings, in AGGREGATE Amazon-basis units: 12 monthly
// numbers for a given year. The engine splits each month across the smart-ring variants by velocity
// share and derives the sizing kit as an attach product (see engine/wearable.ts).
export function forecastRoutes(app: FastifyInstance): void {
  // Latest year on file (or the current calendar year when empty), as 12 Jan..Dec numbers.
  app.get('/api/forecast', () => {
    const db = getDb();
    const rows = db.prepare('SELECT year, month, units FROM wearable_forecast ORDER BY year DESC, month ASC')
      .all() as { year: number; month: number; units: number }[];
    const years = [...new Set(rows.map(r => r.year))].sort((a, b) => b - a);
    const year = years[0] ?? Number(today().slice(0, 4));
    const monthlyUnits = Array(12).fill(0);
    for (const r of rows) if (r.year === year) monthlyUnits[r.month - 1] = r.units;
    return { year, monthlyUnits, years };
  });

  // Replace all 12 months for a year in one shot.
  app.put('/api/forecast', (req, reply) => {
    const b = (req.body ?? {}) as { year?: number; monthlyUnits?: unknown[] };
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return reply.code(400).send({ error: 'year must be a 4-digit year' });
    }
    if (!Array.isArray(b.monthlyUnits) || b.monthlyUnits.length !== 12) {
      return reply.code(400).send({ error: 'monthlyUnits must be an array of 12 numbers' });
    }
    const units = b.monthlyUnits.map(Number);
    if (units.some(u => !Number.isFinite(u) || u < 0)) {
      return reply.code(400).send({ error: 'each month must be a non-negative number' });
    }
    const db = getDb();
    const now = nowIso();
    const upsert = db.prepare(`INSERT INTO wearable_forecast (year, month, units, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(year, month) DO UPDATE SET units = excluded.units, updated_at = excluded.updated_at`);
    db.transaction(() => {
      for (let m = 1; m <= 12; m++) upsert.run(year, m, Math.round(units[m - 1]), now);
    })();
    bumpRevision();
    return { ok: true, year };
  });
}
