import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { Miniflare } from 'miniflare';
export async function bundledWorker(output = '.cache/protected/worker') {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      target: 'es2022',
      outDir: output,
      lib: { entry: path.resolve('worker/index.ts'), formats: ['es'], fileName: () => 'worker.js' },
      minify: false,
    },
  });
  return path.resolve(output, 'worker.js');
}
export async function localWorker(options = {}) {
  return new Miniflare({
    modules: true,
    scriptPath: await bundledWorker(),
    compatibilityDate: '2026-07-30',
    cf: false,
    host: '127.0.0.1',
    r2Buckets: ['DATA'],
    d1Databases: ['SEARCH'],
    durableObjects: {
      GUARD: { className: 'RequestGuard', useSQLite: true },
      RELEASES: { className: 'ReleaseCoordinator', useSQLite: true },
    },
    bindings: {
      SESSION_SECRET: 'local-only-test-secret-32-characters',
      INTERNAL_TOKEN: 'local-only-internal-token',
      DATA_RELEASE: 'fixture',
      ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
    },
    ...options,
  });
}
