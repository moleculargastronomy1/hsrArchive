import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { publishedFetch } from './private-state-fetch.mjs';
import { SITE } from './verification-state.mjs';

// Read-only against publication. Restore only into this isolated checkout.
const descriptor = async () => {
  const response = await publishedFetch(SITE + 'verification-state.json', {
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Last successful snapshot unavailable');
  return response.text();
};
const before = await descriptor();
execFileSync(process.execPath, ['scripts/prepare-verification.mjs', '--restore'], {
  stdio: 'inherit',
  env: process.env,
});
const metadata = new Map();
for (const file of ['content-watch.json', 'verification-progress.json', 'site-update.json']) {
  const response = await publishedFetch(SITE + file, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Successful publication metadata unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  JSON.parse(bytes);
  metadata.set(file, bytes);
}
if (before !== (await descriptor()))
  throw new Error(
    'Publication changed during baseline capture; preserve this checkout and retry in a fresh isolation',
  );
for (const [file, bytes] of metadata) await fs.writeFile('public/' + file, bytes);
console.log('Prepared checksummed successful baseline and matching private publication metadata');
