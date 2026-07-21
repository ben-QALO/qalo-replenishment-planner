import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, backupDaily, ensureDataDirs } from './db/connection.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { skuRoutes } from './routes/skus.ts';
import { importRoutes } from './routes/imports.ts';
import { warehouseRoutes } from './routes/warehouse.ts';
import { poRoutes } from './routes/pos.ts';
import { templateRoutes } from './routes/templates.ts';
import { settingsRoutes } from './routes/settings.ts';
import { planRoutes } from './routes/plans.ts';
import { transferRoutes } from './routes/transfers.ts';
import { keepListRoutes } from './routes/keeplist.ts';
import { businessReportRoutes } from './routes/business-report.ts';
import { skuMapRoutes } from './routes/sku-map.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.PORT ?? 8787);
// Bind to localhost by default (safe for local dev); the container sets HOST=0.0.0.0 to be reachable.
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({ logger: { level: 'warn' } });

await app.register(fastifyMultipart);

app.get('/health', () => ({ ok: true }));

// Shared-password login (HTTP Basic). Enabled whenever AUTH_USER + AUTH_PASS are set — which they
// are in the cloud. When unset (local dev) the tool stays open, exactly as before. /health is left
// public so the host's uptime checks don't need credentials.
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};
if (AUTH_USER && AUTH_PASS) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const hdr = req.headers.authorization ?? '';
    const [scheme, encoded] = hdr.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
      const p = rest.join(':');
      if (safeEqual(u, AUTH_USER) && safeEqual(p, AUTH_PASS)) return;
    }
    reply.header('WWW-Authenticate', 'Basic realm="QALO Replenishment Planner"').code(401).send({ error: 'authentication required' });
  });
  console.log('Auth enabled — shared login required.');
}

dashboardRoutes(app);
skuRoutes(app);
importRoutes(app);
warehouseRoutes(app);
poRoutes(app);
templateRoutes(app);
settingsRoutes(app);
planRoutes(app);
transferRoutes(app);
keepListRoutes(app);
businessReportRoutes(app);
skuMapRoutes(app);

if (existsSync(join(WEB_DIST, 'index.html'))) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  // SPA fallback: any non-API GET serves the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) return (reply as any).sendFile('index.html');
    reply.code(404).send({ error: 'not found' });
  });
} else {
  app.get('/', () => ({ status: 'API running — frontend build missing (web/dist). Run: npm run build:web' }));
}

ensureDataDirs(); // create data/imports + data/exports before any upload can be written
getDb(); // open + migrate before accepting traffic
await backupDaily();
await app.listen({ port: PORT, host: HOST });
console.log(`QALO Replenishment Planner listening on http://${HOST}:${PORT}`);
