import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.ts';
import { applyKeepList, parseTokens } from '../keeplist.ts';

export function keepListRoutes(app: FastifyInstance): void {
  app.get('/api/keep-list', () => {
    const db = getDb();
    const rows = db.prepare('SELECT kind, value FROM keep_list ORDER BY kind, value').all() as { kind: string; value: string }[];
    const kept = db.prepare("SELECT COUNT(*) c FROM skus WHERE classification = 'replenishable'").get() as any;
    const ignored = db.prepare("SELECT COUNT(*) c FROM skus WHERE classification = 'ignore'").get() as any;
    return { entries: rows, count: rows.length, kept_skus: kept.c, ignored_skus: ignored.c };
  });

  // Replace the keep list from pasted text or an uploaded 1-column file.
  app.post('/api/keep-list', async (req, reply) => {
    let text = '';
    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('multipart/form-data')) {
      const file = await (req as any).file();
      if (file) text = (await file.toBuffer()).toString('utf8');
    } else {
      const body = (req.body ?? {}) as { text?: string; values?: string[] };
      text = body.text ?? (Array.isArray(body.values) ? body.values.join('\n') : '');
    }
    const tokens = parseTokens(text);
    if (tokens.length === 0) return reply.code(400).send({ error: 'no ASINs or SKUs found in the input' });
    const result = applyKeepList(getDb(), tokens);
    return { ok: true, ...result };
  });
}
