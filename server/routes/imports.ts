import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, DATA_DIR, nowIso, today } from '../db/connection.ts';
import { parseFile } from '../import/parse.ts';
import { autoMapHeaders } from '../import/mapping.ts';
import { normalizeFbaRecords, sanityWarnings } from '../import/fba.ts';
import { commitSnapshot } from '../import/commit.ts';
import { latestSnapshot } from '../assemble.ts';

const IMPORT_DIR = () => join(DATA_DIR, 'imports');

function safeFileId(id: string): boolean {
  return /^upload-[A-Za-z0-9._ -]+$/.test(id) && !id.includes('..');
}

function analyze(fileId: string) {
  const path = join(IMPORT_DIR(), fileId);
  if (!existsSync(path)) throw Object.assign(new Error('uploaded file not found — re-upload'), { statusCode: 410 });
  const buf = readFileSync(path);
  const fileHash = createHash('sha256').update(buf).digest('hex');
  const parsed = parseFile(buf);
  const mapping = autoMapHeaders(parsed.headers);
  const normalized = normalizeFbaRecords(parsed.records, mapping);
  return { path, buf, fileHash, parsed, mapping, normalized };
}

export function importRoutes(app: FastifyInstance): void {
  app.post('/api/imports/preview', async (req, reply) => {
    const file = await (req as any).file({ limits: { fileSize: 50 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });
    const buf = await file.toBuffer();
    const original = (file.filename ?? 'inventory.csv').replace(/[^A-Za-z0-9._ -]/g, '_');
    const fileId = `upload-${Date.now()}-${original}`;
    writeFileSync(join(IMPORT_DIR(), fileId), buf);

    let analysis;
    try {
      analysis = analyze(fileId);
    } catch (err: any) {
      return reply.code(422).send({
        error: `That file couldn't be read as an FBA Inventory export — check it's the "Manage Inventory Health" CSV (not an Excel file or a different report). ${err?.message ?? ''}`.trim(),
        file_id: fileId,
      });
    }
    const { fileHash, parsed, mapping, normalized } = analysis;
    const db = getDb();

    if (mapping.missingRequired.length > 0) {
      return reply.code(422).send({
        error: `Could not recognize required column(s): ${mapping.missingRequired.join(', ')}`,
        headers: parsed.headers,
        mapped: mapping.fields,
        file_id: fileId,
      });
    }

    const newSkus = normalized.lines
      .filter(l => !db.prepare('SELECT 1 FROM skus WHERE sku = ?').get(l.sku))
      .map(l => ({ sku: l.sku, title: l.title, units_shipped_t30: l.units_shipped_t30 }));

    const prev = latestSnapshot(db);
    let sanity: string[] = [];
    if (prev) {
      const prevLines = db.prepare('SELECT sku, available FROM snapshot_lines WHERE snapshot_id = ?').all(prev.id) as any[];
      sanity = sanityWarnings(normalized.lines, prevLines);
    }

    const snapshotDate = normalized.snapshotDate ?? today();
    const existing = db.prepare('SELECT revision, imported_at FROM snapshots WHERE snapshot_date = ?').get(snapshotDate) as any;
    const identical = db.prepare('SELECT 1 FROM snapshots WHERE snapshot_date = ? AND file_hash = ?').get(snapshotDate, fileHash);

    return {
      file_id: fileId,
      filename: original,
      snapshot_date: snapshotDate,
      rows_total: normalized.rowsTotal,
      rows_ok: normalized.lines.length,
      rows_skipped: normalized.rowsSkipped,
      new_skus: newSkus,
      warnings: [...normalized.warnings, ...sanity],
      replaces_existing: existing ? { revision: existing.revision, imported_at: existing.imported_at } : null,
      already_imported: !!identical,
      mapped_fields: mapping.fields,
      unmapped_headers: mapping.unmappedHeaders,
    };
  });

  app.post('/api/imports/commit', (req, reply) => {
    const body = (req.body ?? {}) as { file_id?: string; snapshot_date?: string };
    if (!body.file_id || !safeFileId(body.file_id)) return reply.code(400).send({ error: 'valid file_id required' });

    try {
      const { fileHash, normalized } = analyze(body.file_id);
      const db = getDb();
      const snapshotDate = body.snapshot_date ?? normalized.snapshotDate ?? today();
      const result = commitSnapshot(db, {
        snapshotDate,
        filename: body.file_id.replace(/^upload-\d+-/, ''),
        fileHash,
        lines: normalized.lines,
        warnings: normalized.warnings,
        rowsTotal: normalized.rowsTotal,
        rowsSkipped: normalized.rowsSkipped.length,
        nowIso: nowIso(),
      });
      return { ok: true, ...result };
    } catch (err: any) {
      const db = getDb();
      db.prepare(`INSERT INTO import_log (kind, filename, imported_at, status, error) VALUES ('fba_inventory', ?, ?, 'failed', ?)`)
        .run(body.file_id, nowIso(), String(err?.message ?? err));
      return reply.code(err?.statusCode ?? 500).send({ error: String(err?.message ?? err) });
    }
  });

  app.get('/api/imports', () => {
    const db = getDb();
    const log = db.prepare('SELECT * FROM import_log ORDER BY id DESC LIMIT 50').all() as any[];
    for (const l of log) if (l.warnings) l.warnings = JSON.parse(l.warnings);
    return { imports: log };
  });
}
