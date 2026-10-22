import fs from 'node:fs/promises';
const base = 'https://moleculargastronomy1.github.io/hsrArchive/';
const paths = ['', 'content/search-index.json', 'content/station-departure--arrival.json',
  'content/locales/en/station-departure--arrival.json', 'bwiki-provenance.json', 'verification-state.json',
  'content/locales/manifest.json', 'sw.js', 'service-worker.js'];
const checks = [];
for (const file of paths) {
  const response = await fetch(base + file, { method: 'HEAD', signal: AbortSignal.timeout(30000), cache: 'no-store' });
  checks.push({ path: file || '/', status: response.status, type: response.headers.get('content-type'),
    bytes: response.headers.get('content-length'), cache: response.headers.get('cache-control') });
}
const descriptor = await fetch(base + 'verification-state.json', { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
if (/^verification-state-[a-f0-9]{64}\.json\.gz$/.test(descriptor.file)) {
  const response = await fetch(base + descriptor.file, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  checks.push({ path: descriptor.file, status: response.status, bytes: response.headers.get('content-length') });
}
const html = await fetch(base, { signal: AbortSignal.timeout(30000) }).then((r) => r.text());
const scripts = [...html.matchAll(/src="([^\"]+\.js)"/g)].map((m) => m[1]);
for (const file of scripts) {
  const bundle = await fetch(new URL(file, base), { signal: AbortSignal.timeout(30000) }).then((r) => r.text());
  checks.push({ path: file, bytes: Buffer.byteLength(bundle), serviceWorkerRegistration: /serviceWorker\.register/.test(bundle), sourceMapReference: /sourceMappingURL=/.test(bundle) });
  const map = await fetch(new URL(file + '.map', base), { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  checks.push({ path: file + '.map', status: map.status });
}
const result = { checkedAt: new Date().toISOString(), mode: 'read-only-head-and-small-metadata', base, checks };
await fs.mkdir('docs/reports', { recursive: true });
await fs.writeFile('docs/reports/data-exposure-before-2026-10-22.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
