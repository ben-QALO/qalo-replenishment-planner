import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, backupDaily } from './db/connection.ts';
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIST = join(ROOT, 'web', 'dist');
const PORT = 8787;

const app = Fastify({ logger: { level: 'warn' } });

await app.register(fastifyMultipart);

app.get('/health', () => ({ ok: true }));

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

getDb(); // open + migrate before accepting traffic
await backupDaily();
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`QALO Replenishment Planner listening on http://localhost:${PORT}`);
