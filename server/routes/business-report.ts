import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, DATA_DIR } from '../db/connection.ts';
import { parseBusinessReport } from '../import/business-report.ts';

export function businessReportRoutes(app: FastifyInstance): void {
  // Amazon Business Report import (Sales & Traffic by Child ASIN) → true FBM+FBA demand.
  app.post('/api/business-report/import', async (req, reply) => {
    const file = await (req as any).file({ limits: { fileSize: 50 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });
    const buf = await file.toBuffer();
    const original = (file.filename ?? 'business-report.csv').replace(/[^A-Za-z0-9._ -]/g, '_');
    writeFileSync(join(DATA_DIR, 'imports', `business-report-${Date.now()}-${original}`), buf);

    let parsed;
    try {
      parsed = parseBusinessReport(buf);
    } catch (err: any) {
      return reply.code(422).send({ error: `Could not read the Business Report: ${err?.message ?? err}` });
    }
    if (!parsed.headerFound) {
      return reply.code(422).send({
        error: 'Could not find a Child ASIN column and a demand column (Units Ordered or Total Order Items) — is this the Sales & Traffic by Child Item report?',
      });
    }

    const db = getDb();
    // Which ASINs do we actually track? (for the "matched" count)
    const trackedAsins = new Set(
      (db.prepare("SELECT DISTINCT asin FROM skus WHERE asin IS NOT NULL AND asin <> ''").all() as { asin: string }[])
        .map(r => r.asin.trim().toUpperCase()));

    const now = nowIso();
    let matched = 0, withSales = 0;
    const run = db.transaction(() => {
      db.prepare('DELETE FROM external_sales').run(); // one current report
      const ins = db.prepare(`INSERT INTO external_sales (asin, units, window_days, title, source_file, imported_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(asin) DO UPDATE SET units = excluded.units, window_days = excluded.window_days,
          title = excluded.title, source_file = excluded.source_file, imported_at = excluded.imported_at`);
      for (const row of parsed.rows) {
        ins.run(row.asin, row.units, parsed.windowDays, row.title, original, now);
        if (trackedAsins.has(row.asin)) { matched++; if (row.units > 0) withSales++; }
      }
      db.prepare(`INSERT INTO import_log (kind, filename, imported_at, status, rows_total, rows_ok, new_skus, warnings)
        VALUES ('business_report', ?, ?, 'committed', ?, ?, 0, ?)`)
        .run(original, now, parsed.rows.length, matched,
          JSON.stringify([`${matched} tracked ASINs matched from "${parsed.unitsColumn}"`]));
    });
    run();
    bumpRevision();

    return {
      ok: true,
      rows_in_file: parsed.rows.length,
      matched, with_sales: withSales,
      units_column: parsed.unitsColumn,
      window_days: parsed.windowDays,
    };
  });

  // Freshness + coverage for the context strip / imports page.
  app.get('/api/business-report', () => {
    const db = getDb();
    const meta = db.prepare('SELECT COUNT(*) AS n, MAX(imported_at) AS imported_at, MAX(window_days) AS window_days FROM external_sales').get() as any;
    const matched = (db.prepare(`SELECT COUNT(DISTINCT es.asin) AS n FROM external_sales es
      JOIN skus s ON UPPER(TRIM(s.asin)) = es.asin`).get() as any).n;
    return {
      rows: meta.n ?? 0,
      matched,
      imported_at: meta.imported_at ?? null,
      window_days: meta.window_days ?? null,
    };
  });
}
