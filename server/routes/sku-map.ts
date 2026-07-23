import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, DATA_DIR } from '../db/connection.ts';
import { parseSkuMap } from '../import/sku-map.ts';
import { toCsv } from '../export/csv.ts';

// Coverage is measured over the products the tool actually plans for — not ignored/discontinued ones.
const ACTIVE = "('replenishable','watch','unclassified')";

export function skuMapRoutes(app: FastifyInstance): void {
  // Import the master QALO ↔ Amazon ↔ ASIN mapping (replaces the whole map each time).
  app.post('/api/sku-map/import', async (req, reply) => {
    const file = await (req as any).file({ limits: { fileSize: 20 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });
    const buf = await file.toBuffer();
    const original = (file.filename ?? 'sku-map.csv').replace(/[^A-Za-z0-9._ -]/g, '_');
    writeFileSync(join(DATA_DIR, 'imports', `sku-map-${Date.now()}-${original}`), buf);

    let parsed;
    try {
      parsed = parseSkuMap(buf);
    } catch (err: any) {
      return reply.code(422).send({ error: `Could not read the mapping file: ${err?.message ?? err}` });
    }
    if (!parsed.headerFound) {
      return reply.code(422).send({ error: 'Could not find "QALO SKU" and "Amazon SKU" columns — is this the SKU mapping export?' });
    }

    const db = getDb();
    // Which Amazon SKUs does the tool actually see in the FBA catalog? (for a "matched" count)
    const catalogSkus = new Set((db.prepare('SELECT sku FROM skus').all() as { sku: string }[]).map(r => r.sku));

    const now = nowIso();
    let matched = 0, withAsin = 0, differ = 0;
    const run = db.transaction(() => {
      db.prepare('DELETE FROM sku_map').run();
      const ins = db.prepare(`INSERT INTO sku_map (qalo_sku, amazon_sku, asin, source_file, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(qalo_sku) DO UPDATE SET
          amazon_sku = excluded.amazon_sku, asin = excluded.asin, source_file = excluded.source_file, updated_at = excluded.updated_at`);
      for (const r of parsed.rows) {
        ins.run(r.qalo_sku, r.amazon_sku, r.asin, original, now);
        if (r.amazon_sku && catalogSkus.has(r.amazon_sku)) matched++;
        if (r.asin) withAsin++;
        if (r.amazon_sku && r.amazon_sku !== r.qalo_sku) differ++;
      }
    });
    run();
    bumpRevision();

    return {
      ok: true,
      rows_in_file: parsed.rows.length,
      skipped: parsed.skipped,
      matched_to_catalog: matched,
      with_asin: withAsin,
      amazon_differs_from_qalo: differ,
    };
  });

  // Freshness + coverage for the Imports page. Coverage = active catalog SKUs that have a QALO SKU
  // in the map. Unmapped products are the ones whose warehouse stock / orders can't be trusted.
  app.get('/api/sku-map', () => {
    const db = getDb();
    const meta = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS updated_at FROM sku_map').get() as any;
    const differ = (db.prepare('SELECT COUNT(*) AS n FROM sku_map WHERE amazon_sku IS NOT NULL AND amazon_sku <> qalo_sku').get() as any).n;
    const catalogTotal = (db.prepare(`SELECT COUNT(*) AS n FROM skus WHERE classification IN ${ACTIVE}`).get() as any).n;
    // A product is covered if the SKU is directly mapped OR its ASIN already has a mapping (a
    // sibling SKU on the same ASIN is mapped → this one auto-consolidates into it). Only a SKU
    // whose ASIN is entirely unknown to the map is a genuine gap.
    const unmapped = (db.prepare(`SELECT s.sku FROM skus s
      WHERE s.classification IN ${ACTIVE}
        AND NOT EXISTS (SELECT 1 FROM sku_map m WHERE m.amazon_sku = s.sku)
        AND NOT EXISTS (SELECT 1 FROM sku_map m WHERE m.asin = s.asin AND s.asin IS NOT NULL AND s.asin <> '')
      ORDER BY s.sku`).all() as { sku: string }[]).map(r => r.sku);
    // Map rows that point at an Amazon SKU the catalog doesn't have (stale/typo'd mapping).
    const stale = (db.prepare(`SELECT COUNT(*) AS n FROM sku_map m WHERE m.amazon_sku IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.sku = m.amazon_sku)`).get() as any).n;
    return {
      rows: meta.n ?? 0, updated_at: meta.updated_at ?? null, amazon_differs_from_qalo: differ,
      catalog_total: catalogTotal, mapped: catalogTotal - unmapped.length,
      unmapped_count: unmapped.length, unmapped_sample: unmapped.slice(0, 50),
      stale_mappings: stale,
    };
  });

  // Validation export: every active product in the tool with its QALO SKU, Amazon SKU, ASIN,
  // mapped status and current warehouse qty — so the team can audit and complete the mapping.
  app.get('/api/sku-map/export.csv', (_req, reply) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT s.sku AS amazon_sku, s.classification, s.title,
             m.qalo_sku AS direct_qalo, COALESCE(m.asin, s.asin) AS asin,
             (SELECT mm.qalo_sku FROM sku_map mm WHERE mm.asin = s.asin AND s.asin IS NOT NULL AND s.asin <> '' LIMIT 1) AS asin_qalo,
             COALESCE(w.qty_on_hand, 0) AS warehouse
      FROM skus s
      LEFT JOIN sku_map m ON m.amazon_sku = s.sku
      LEFT JOIN warehouse_inventory w ON w.sku = s.sku
      WHERE s.classification IN ${ACTIVE}
      ORDER BY (m.qalo_sku IS NULL AND (SELECT 1 FROM sku_map mm WHERE mm.asin = s.asin) IS NULL) DESC, s.asin, s.sku`).all() as any[];
    const out: unknown[][] = [['Amazon SKU', 'QALO SKU', 'ASIN', 'Mapped?', 'Warehouse On Hand', 'Classification', 'Title']];
    for (const r of rows) {
      const qalo = r.direct_qalo ?? r.asin_qalo ?? '';
      const status = r.direct_qalo ? 'yes'
        : r.asin_qalo ? `via ASIN → ${r.asin_qalo} (consolidated)`
        : 'NO — missing QALO SKU';
      out.push([r.amazon_sku, qalo, r.asin ?? '', status, r.warehouse, r.classification, r.title ?? '']);
    }
    // Stale map rows: an Amazon SKU in the mapping that the catalog doesn't have.
    const orphans = db.prepare(`SELECT qalo_sku, amazon_sku, asin FROM sku_map m WHERE m.amazon_sku IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.sku = m.amazon_sku) ORDER BY qalo_sku`).all() as any[];
    for (const r of orphans) out.push([r.amazon_sku ?? '', r.qalo_sku, r.asin ?? '', 'STALE — Amazon SKU not in catalog', '', '', '']);

    const csv = toCsv(out);
    const filename = `sku-mapping-${nowIso().slice(0, 10)}.csv`;
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });
}
