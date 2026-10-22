import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { localWorker } from './local-worker.mjs';

const base = path.resolve('.cache/protected');
const candidate = JSON.parse(await fs.readFile(path.join(base, 'candidate.json'), 'utf8'));
// Miniflare's pinned D1 adapter migrates this legacy SQLite layout on startup.
// Seed before starting workerd, so large batches never traverse its JS proxy.
const d1Persist = await fs.mkdtemp(path.join(base, 'preview-d1-'));
await fs.mkdir(path.join(d1Persist, 'SEARCH'));
await fs.copyFile(path.join(base, 'search.sqlite'), path.join(d1Persist, 'SEARCH/db.sqlite'));
const mf = await localWorker({
  port: 0,
  d1Persist,
  bindings: {
    SESSION_SECRET: 'local-only-test-secret-32-characters',
    INTERNAL_TOKEN: 'local-only-internal-token',
    DATA_RELEASE: candidate.release,
    ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
  },
});
const r2 = await mf.getR2Bucket('DATA');
// UI exercises chapters/localizations. Recovery snapshots are verified separately;
// sending a 54MB gzip through Miniflare's JavaScript proxy can stall the bridge.
const uiObjects = candidate.objects.filter(
  (o: { key: string }) =>
    o.key.includes('/public/content/') && !o.key.endsWith('/search-index.json'),
);
let done = 0;
let cursor = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (cursor < uiObjects.length) {
      const object = uiObjects[cursor++];
      await r2.put(object.key, await fs.readFile(path.join(base, 'r2', object.key)));
      if (++done % 2000 === 0) console.log(`Loaded ${done} private objects locally`);
    }
  }),
);
console.log(`Loaded ${done} chapter/localization objects; checking full local search`);
const db = await mf.getD1Database('SEARCH');
const count = await db.prepare('SELECT count(*) AS total FROM search_rows').first<number>('total');
if (count !== candidate.summary.searchRows)
  throw new Error('Local search seed differs from candidate');
// Cloudflare supplies this header at its edge. This loopback-only proxy supplies
// the test address for Miniflare, which does not inject it in its HTTP listener.
const apiServer = createServer(async (request, response) => {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers))
      if (typeof value === 'string') headers.set(key, value);
    headers.set('CF-Connecting-IP', '127.0.0.1');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) throw new Error('Preview request too large');
      chunks.push(chunk);
    }
    const result = await mf.dispatchFetch('https://local-api' + request.url, {
      method: request.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(503);
    response.end('Local preview unavailable');
  }
});
apiServer.listen(8787, '127.0.0.1');
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const file = path.resolve(base, 'dist', pathname === '/' ? 'index.html' : '.' + pathname);
    if (!file.startsWith(path.join(base, 'dist') + path.sep)) throw new Error('Unsafe path');
    const body = await fs.readFile(file);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
server.listen(4173, '127.0.0.1', () =>
  console.log('Protected frontend: http://127.0.0.1:4173/; local Worker: http://127.0.0.1:8787/'),
);
process.on('SIGINT', async () => {
  server.close();
  apiServer.close();
  await mf.dispose();
  process.exit(0);
});
