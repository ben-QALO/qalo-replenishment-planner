import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, DATA_DIR } from '../db/connection.ts';
import { parseSkuMap } from '../import/sku-map.ts';

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

  // Freshness + coverage for the Imports page.
  app.get('/api/sku-map', () => {
    const db = getDb();
    const meta = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS updated_at FROM sku_map').get() as any;
    const differ = (db.prepare('SELECT COUNT(*) AS n FROM sku_map WHERE amazon_sku IS NOT NULL AND amazon_sku <> qalo_sku').get() as any).n;
    return { rows: meta.n ?? 0, updated_at: meta.updated_at ?? null, amazon_differs_from_qalo: differ };
  });
}
