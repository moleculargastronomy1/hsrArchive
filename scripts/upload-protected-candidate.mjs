// Explicit post-approval command. Never called by the current Pages workflow.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkCandidate } from './check-protected-candidate.mjs';
import { hash } from './verification-state.mjs';
const folder = path.resolve('.cache/protected');
const candidate = await checkCandidate(process.cwd(), folder);
const {
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_API_TOKEN: token,
  HSR_D1_DATABASE: database,
  HSR_PRIVATE_STATE_URL: api,
  HSR_PRIVATE_STATE_TOKEN: internalToken,
} = process.env;
if (
  !account ||
  !token ||
  !api?.startsWith('https://') ||
  !internalToken ||
  !/^[A-Za-z0-9_-]+$/.test(database ?? '')
)
  throw new Error(
    'Approved Cloudflare account, upload Worker credentials and isolated search database are required',
  );
if (process.argv[2] !== '--upload')
  throw new Error('Use --upload only after service/transition approval');
for (const object of candidate.objects) {
  const url = new URL('/internal/object/' + object.key.slice('releases/'.length), api);
  const response = await fetch(url, {
    method: 'PUT',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${internalToken}`,
      'X-Content-SHA256': object.sha256,
      'Content-Length': String(object.size),
    },
    body: await fs.readFile(path.join(folder, 'r2', object.key)),
  });
  if (!response.ok) throw new Error('Candidate R2 upload failed; successful release is unchanged');
}
// Use a fresh database per release. A partial import must never alter the live database.
execFileSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'execute',
    database,
    '--remote',
    '--file',
    path.join(folder, 'search.sql'),
    '--config',
    'worker/wrangler.jsonc',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
const ready = new URL(`/internal/object/${candidate.release}/ready.json`, api);
const readyBytes = JSON.stringify({
  release: candidate.release,
  searchRows: candidate.summary.searchRows,
  snapshot: candidate.snapshot,
  hashes: candidate.hashes,
});
const response = await fetch(ready, {
  method: 'PUT',
  redirect: 'error',
  headers: {
    Authorization: `Bearer ${internalToken}`,
    'Content-Type': 'application/json',
    'X-Content-SHA256': hash(readyBytes),
    'Content-Length': String(Buffer.byteLength(readyBytes)),
  },
  body: readyBytes,
});
if (!response.ok)
  throw new Error('Candidate ready receipt failed; successful release is unchanged');
console.log(
  'Uploaded isolated candidate. Public deployment and successful-release promotion remain separate steps.',
);
