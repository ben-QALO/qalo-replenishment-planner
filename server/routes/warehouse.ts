import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, DATA_DIR } from '../db/connection.ts';
import { parseNetsuiteWarehouse } from '../import/netsuite.ts';

export function warehouseRoutes(app: FastifyInstance): void {
  // NetSuite warehouse import (Excel-XML). Scoped to SKUs already in the catalog
  // (i.e. seen in an Amazon export) so the ~7,600 non-Amazon NetSuite items are ignored.
  app.post('/api/warehouse/import', async (req, reply) => {
    const file = await (req as any).file({ limits: { fileSize: 50 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });
    const buf = await file.toBuffer();
    const original = (file.filename ?? 'warehouse.xls').replace(/[^A-Za-z0-9._ -]/g, '_');
    writeFileSync(join(DATA_DIR, 'imports', `warehouse-${Date.now()}-${original}`), buf);

    let parsed;
    try {
      parsed = parseNetsuiteWarehouse(buf);
    } catch (err: any) {
      return reply.code(422).send({ error: `Could not read the NetSuite file: ${err?.message ?? err}` });
    }
    if (!parsed.headerRowFound) {
      return reply.code(422).send({ error: 'Could not find the Item / Qalo Main WH columns — is this the Qalo Amazon Inventory Report?' });
    }

    const db = getDb();
    const known = new Set((db.prepare('SELECT sku FROM skus').all() as { sku: string }[]).map(r => r.sku));
    // The NetSuite report is keyed by the QALO SKU; the catalog/engine key by the Amazon SKU.
    // Translate each row through the QALO↔Amazon map so warehouse stock lands on the right Amazon
    // listing (e.g. NetSuite "MBK09-O" → catalog "MBK09-O.s"). Rows whose SKU is already a catalog
    // key pass through unchanged. Two QALO SKUs mapping to one Amazon SKU are summed, not overwritten.
    const qaloToAmazon = new Map((db.prepare('SELECT qalo_sku, amazon_sku FROM sku_map WHERE amazon_sku IS NOT NULL')
      .all() as { qalo_sku: string; amazon_sku: string }[]).map(r => [r.qalo_sku, r.amazon_sku] as const));
    const now = nowIso();
    const upsert = db.prepare(`INSERT INTO warehouse_inventory (sku, qty_on_hand, updated_at, updated_via)
      VALUES (?, ?, ?, 'csv')
      ON CONFLICT(sku) DO UPDATE SET qty_on_hand = excluded.qty_on_hand, updated_at = excluded.updated_at, updated_via = 'csv'`);

    // Fold NetSuite rows onto their catalog (Amazon) SKU first so 1→many maps sum correctly.
    const byCatalog = new Map<string, number>();
    const skippedWithStock: { sku: string; qty: number }[] = [];
    for (const row of parsed.rows) {
      const catalogSku = qaloToAmazon.get(row.sku) ?? row.sku;
      if (!known.has(catalogSku)) {
        if (row.onHand > 0) skippedWithStock.push({ sku: row.sku, qty: row.onHand });
        continue; // NetSuite item not in the Amazon catalog and no mapping to one
      }
      byCatalog.set(catalogSku, (byCatalog.get(catalogSku) ?? 0) + row.onHand);
    }

    let matched = 0, withStock = 0;
    const run = db.transaction(() => {
      for (const [sku, qty] of byCatalog) {
        upsert.run(sku, qty, now);
        matched++;
        if (qty > 0) withStock++;
      }
      const warn = [`${matched} SKUs matched, ${withStock} with stock`];
      if (skippedWithStock.length) warn.push(`${skippedWithStock.length} NetSuite SKUs had stock but no catalog match — SKU mapping gap`);
      db.prepare(`INSERT INTO import_log (kind, filename, imported_at, status, rows_total, rows_ok, new_skus, warnings)
        VALUES ('warehouse', ?, ?, 'committed', ?, ?, 0, ?)`)
        .run(original, now, parsed.rows.length, matched, JSON.stringify(warn));
    });
    run();
    bumpRevision();

    // SKUs we track but that were absent from the NetSuite file.
    const trackedMissing = (db.prepare(
      "SELECT sku FROM skus WHERE classification IN ('replenishable','watch') AND sku NOT IN (SELECT sku FROM warehouse_inventory WHERE updated_at = ?)").all(now) as { sku: string }[]).map(r => r.sku);

    return {
      ok: true,
      rows_in_file: parsed.rows.length,
      matched, with_stock: withStock,
      qty_column: parsed.qtyColumnLabel,
      skipped_with_stock: skippedWithStock.length,
      skipped_with_stock_sample: skippedWithStock.sort((a, b) => b.qty - a.qty).slice(0, 20),
      tracked_missing_count: trackedMissing.length,
      tracked_missing_sample: trackedMissing.slice(0, 20),
    };
  });

  app.get('/api/warehouse', () => {
    const db = getDb();
    const rows = db.prepare(`SELECT w.sku, w.qty_on_hand, w.updated_at, w.updated_via, s.title, s.classification
      FROM warehouse_inventory w LEFT JOIN skus s ON s.sku = w.sku ORDER BY w.sku`).all();
    return { rows };
  });

  app.put('/api/warehouse/:sku', (req, reply) => {
    const { sku } = req.params as { sku: string };
    const body = (req.body ?? {}) as { qty?: number };
    const qty = Number(body.qty);
    if (!Number.isFinite(qty) || qty < 0) return reply.code(400).send({ error: 'qty must be a non-negative number' });
    const db = getDb();
    db.prepare(`INSERT INTO warehouse_inventory (sku, qty_on_hand, updated_at, updated_via)
      VALUES (?, ?, ?, 'manual')
      ON CONFLICT(sku) DO UPDATE SET qty_on_hand = excluded.qty_on_hand, updated_at = excluded.updated_at, updated_via = 'manual'`)
      .run(sku, Math.round(qty), nowIso());
    bumpRevision();
    return { ok: true };
  });

  app.post('/api/warehouse/bulk', (req, reply) => {
    const body = (req.body ?? {}) as { rows?: { sku: string; qty: number }[]; via?: string };
    if (!Array.isArray(body.rows) || body.rows.length === 0) return reply.code(400).send({ error: 'rows[] required' });
    const via = body.via === 'shipment' || body.via === 'po_receipt' || body.via === 'csv' ? body.via : 'manual';
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO warehouse_inventory (sku, qty_on_hand, updated_at, updated_via)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET qty_on_hand = excluded.qty_on_hand, updated_at = excluded.updated_at, updated_via = excluded.updated_via`);
    const now = nowIso();
    let ok = 0;
    const run = db.transaction(() => {
      for (const r of body.rows!) {
        const qty = Number(r.qty);
        if (!r.sku || !Number.isFinite(qty) || qty < 0) continue;
        stmt.run(r.sku, Math.round(qty), now, via);
        ok++;
      }
    });
    run();
    if (ok > 0) bumpRevision();
    return { ok: true, updated: ok };
  });

  app.delete('/api/warehouse/:sku', (req) => {
    const { sku } = req.params as { sku: string };
    getDb().prepare('DELETE FROM warehouse_inventory WHERE sku = ?').run(sku);
    bumpRevision();
    return { ok: true };
  });
}
