import type { FastifyInstance } from 'fastify';
import { getDb, bumpRevision, nowIso, today } from '../db/connection.ts';
import { getSetting, templateParamsById } from '../assemble.ts';
import { chinaLeadDays } from '../../engine/replenishment.ts';
import { addMonths, firstOfMonth, monthKey } from '../../engine/dates.ts';

// The board-approved smart-ring forecast, in AGGREGATE Amazon-basis units per calendar month. The
// engine splits each month across the smart-ring variants by velocity share and derives the sizing
// kit as an attach product (see engine/wearable.ts).
//
// Addressed BY MONTH, not by year, because the plan runs a rolling 12 months from today and so
// straddles two calendar years. The old year-at-a-time editor made that the user's problem: it always
// loaded whichever year was highest on file (so it opened on next year, never the one you were
// editing), changing the year did not reload that year's figures, and saving then wrote the previous
// year's numbers over the year you had typed — silently. Addressing real months removes the whole
// class of mistake, because there is no year left to get wrong.

/**
 * The months the planner actually consumes: the 12-month window, plus the China lead ahead of it (an
 * order placed in the last month of the window is sized from the pull a lead-time later), plus one
 * month of slack so the final month is never a reused estimate.
 */
function horizonMonths(db: ReturnType<typeof getDb>): { plan: number; lead: number; total: number } {
  const id = Number(getSetting(db, 'wearable_template_id') ?? 0) || null;
  const t = id ? templateParamsById(db, id) : null;
  const lead = t ? Math.max(1, Math.round(chinaLeadDays(t.params) / 30)) : 3;
  const plan = 12;
  return { plan, lead, total: plan + lead + 1 };
}

export function forecastRoutes(app: FastifyInstance): void {
  /**
   * The forecast as a rolling list of real months starting this month — exactly the window the plan
   * reads. `entered: false` means nothing is on file for that month, so the engine falls back to
   * reusing the same month of another year (flagged "est." in the report and the export).
   */
  app.get('/api/forecast', () => {
    const db = getDb();
    const rows = db.prepare('SELECT year, month, units FROM wearable_forecast').all() as
      { year: number; month: number; units: number }[];
    const onFile = new Map(rows.map(r => [`${r.year}-${String(r.month).padStart(2, '0')}`, r.units]));

    const { plan, lead, total } = horizonMonths(db);
    const start = firstOfMonth(today());
    const months = Array.from({ length: total }, (_, i) => {
      const key = monthKey(addMonths(start, i));
      return { month: key, units: onFile.get(key) ?? 0, entered: onFile.has(key), in_plan_window: i < plan };
    });
    return { months, plan_months: plan, lead_months: lead, months_on_file: rows.length };
  });

  /**
   * Save the months the editor sends: `{ months: [{ month: 'YYYY-MM', units: n }, ...] }`.
   * Only the supplied months are touched, so a save can never blank a month it didn't show.
   */
  app.put('/api/forecast', (req, reply) => {
    const b = (req.body ?? {}) as { months?: unknown; year?: number; monthlyUnits?: unknown[] };
    let entries: { year: number; month: number; units: number }[] = [];

    if (Array.isArray(b.months)) {
      for (const raw of b.months) {
        const m = (raw ?? {}) as { month?: unknown; units?: unknown };
        const key = String(m.month ?? '');
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
          return reply.code(400).send({ error: `month must look like 2026-07, got "${key}"` });
        }
        const units = Number(m.units);
        if (!Number.isFinite(units) || units < 0) {
          return reply.code(400).send({ error: `the figure for ${key} must be 0 or more` });
        }
        const year = Number(key.slice(0, 4));
        if (year < 2000 || year > 2100) return reply.code(400).send({ error: `${year} is not a sensible year` });
        entries.push({ year, month: Number(key.slice(5, 7)), units: Math.round(units) });
      }
    } else if (Array.isArray(b.monthlyUnits) && b.monthlyUnits.length === 12) {
      // The retired year-at-a-time shape, still accepted so a browser tab left open on the previous
      // build keeps saving instead of failing with an error the user cannot interpret.
      const year = Number(b.year);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return reply.code(400).send({ error: 'year must be a 4-digit year' });
      }
      const units = b.monthlyUnits.map(Number);
      if (units.some(u => !Number.isFinite(u) || u < 0)) {
        return reply.code(400).send({ error: 'each month must be a non-negative number' });
      }
      entries = units.map((u, i) => ({ year, month: i + 1, units: Math.round(u) }));
    } else {
      return reply.code(400).send({ error: 'send { months: [{ month: "2026-07", units: 365 }] }' });
    }

    if (entries.length === 0) return reply.code(400).send({ error: 'no months to save' });

    const db = getDb();
    const now = nowIso();
    const upsert = db.prepare(`INSERT INTO wearable_forecast (year, month, units, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(year, month) DO UPDATE SET units = excluded.units, updated_at = excluded.updated_at`);
    db.transaction(() => {
      for (const e of entries) upsert.run(e.year, e.month, e.units, now);
    })();
    bumpRevision();
    // Echo back what was stored, so the caller can confirm from the response rather than assume.
    return {
      ok: true,
      saved: entries.map(e => ({ month: `${e.year}-${String(e.month).padStart(2, '0')}`, units: e.units })),
    };
  });
}
