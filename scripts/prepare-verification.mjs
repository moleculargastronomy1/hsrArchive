import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SITE,
  fetchState,
  packState,
  statePath,
  stateFiles,
  writeDerived,
  applyDerivedChanges,
  PublishedStateUnavailable,
} from './verification-state.mjs';
import {
  baselineChoice,
  verificationRows,
  compareVerification,
} from './verification-integration.mjs';
import { readRetry, recoverVerificationProgress } from './verification-retry.mjs';

async function migratePublishedEntries(fetcher) {
  // Compatibility with deployments predating durable snapshots. Finish every
  // download and generation check before touching the working content tree.
  const get = async (file) => {
    const response = await fetcher(SITE + file, {
      cache: 'no-store',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw Error('Published migration input unavailable: ' + file);
    return Buffer.from(await response.arrayBuffer());
  };
  const siteBefore = await get('site-update.json'),
    wikiBytes = await get('bwiki-provenance.json');
  const wiki = JSON.parse(wikiBytes),
    update = await get('content-update.json');
  if (JSON.parse(update).commit !== wiki.commit) throw Error('Mixed migration input versions');
  const files = [
    ...new Set([
      ...Object.keys(wiki.chapters).map((f) => 'public/' + f),
      'public/content/search-index.json',
      'public/content-update.json',
      'public/trailblaze-provenance.json',
      'public/dialogue-flow-provenance.json',
      'public/video-order-provenance.json',
      'public/video-review-summary.json',
    ]),
  ];
  const entries = [{ path: 'public/bwiki-provenance.json', bytes: wikiBytes }];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        if (!statePath(file)) throw Error('Invalid migration path');
        const bytes = await get(file.slice(7));
        JSON.parse(bytes);
        entries.push({ path: file, bytes });
      }
    }),
  );
  if (
    !siteBefore.equals(await get('site-update.json')) ||
    !wikiBytes.equals(await get('bwiki-provenance.json'))
  )
    throw Error('Deployment changed during migration');
  return entries;
}

export async function restoreVerification(root, { fetcher = fetch, write = writeDerived } = {}) {
  const before = await verificationRows(root, { referencedOnly: true });
  const repository = new Map();
  for (const file of await stateFiles(root))
    repository.set(file, await fs.readFile(path.join(root, file)));
  const published = await fetchState(fetcher);
  const entries = published?.entries ?? (await migratePublishedEntries(fetcher));
  const cache = path.resolve(root, '.cache');
  await fs.mkdir(cache, { recursive: true });
  const candidate = await fs.mkdtemp(path.join(cache, 'verification-restore-'));
  try {
    // Evaluate the two baselines in isolation. An incomparable snapshot must
    // leave the repository's unique evidence and metadata completely untouched.
    const bundle = published ? new Map() : new Map(repository);
    for (const item of entries) bundle.set(item.path, item.bytes);
    await applyDerivedChanges(
      candidate,
      [...bundle].map(([path, bytes]) => ({ path, bytes })),
    );
    const beforeCommit = JSON.parse(repository.get('public/content-update.json')).commit;
    const afterCommit = JSON.parse(bundle.get('public/content-update.json')).commit;
    const choice =
      beforeCommit === afterCommit
        ? baselineChoice(before, await verificationRows(candidate, { referencedOnly: true }))
        : 'published';
    if (choice === 'conflict') {
      const file = path.join(root, '.cache/verification-retry/restore-conflict.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        JSON.stringify({
          repositoryCommit: beforeCommit,
          publishedCommit: afterCommit,
          descriptor: published?.descriptor,
          comparison: compareVerification(
            before,
            await verificationRows(candidate, { referencedOnly: true }),
          ),
        }),
      );
      throw Error(
        'Repository and deployed verification each contain unique evidence; refusing to discard either',
      );
    }
    const selected = choice === 'repository' ? repository : bundle;
    // Search proof is independent of canonical dialogue coverage. Keep the
    // repository's verified search candidate for exact-input replay after a
    // newer deployed dialogue baseline replaces the public search files.
    const searchCandidate = path.join(root, '.cache/search-text/repository');
    for (const [file, bytes] of repository) {
      if (
        !/^public\/search\/(?:(?:manifest|other-catalog|part-\d{2})|(?:other|locales\/(?:en|zh-CN|ja))\/other-(?:npc|interaction|message|mail|loading)-p\d+--s[a-f0-9]{16})\.json$/.test(
          file,
        )
      )
        continue;
      const target = path.join(searchCandidate, file.slice('public/search/'.length));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    if (!selected.has('public/verification-progress.json')) {
      const rows =
        choice === 'repository' ? await verificationRows(root) : await verificationRows(candidate);
      const progress = recoverVerificationProgress(
        await readRetry(root),
        compareVerification(rows, rows).digest,
      );
      if (progress)
        selected.set('public/verification-progress.json', Buffer.from(JSON.stringify(progress)));
    }
    await applyDerivedChanges(
      root,
      [...selected].map(([path, bytes]) => ({ path, bytes })),
      { write },
    );
    console.log(
      choice === 'repository'
        ? 'Preserved repository improvements containing every deployed row and verified ID'
        : 'Restored last successfully deployed verification state',
    );
    return { choice, files: selected.size, migrated: !published };
  } finally {
    // Only the scratch directory created above is removable, never the checkout.
    if (
      path.dirname(candidate) !== cache ||
      !path.basename(candidate).startsWith('verification-restore-')
    )
      throw Error('Unsafe verification restore scratch path');
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

export async function prepareVerification(
  root,
  { fetcher = fetch, output = process.env.GITHUB_OUTPUT } = {},
) {
  try {
    const result = await restoreVerification(root, { fetcher });
    if (output) await fs.appendFile(output, 'ready=true\n');
    return { status: 'ready', ...result };
  } catch (error) {
    if (!(error instanceof PublishedStateUnavailable)) throw error;
    const file = path.join(root, '.cache/verification-retry/run.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const journal = {
      schema: 'hsr-verification-run.v1',
      checkedAt: new Date().toISOString(),
      mode: 'restore',
      status: 'deferred',
      reason: error.code,
      changed: false,
      newlyVerified: 0,
      publish: false,
    };
    await fs.writeFile(file, JSON.stringify(journal));
    if (output) await fs.appendFile(output, 'ready=false\n');
    console.log(
      'Published baseline temporarily unavailable; update deferred, deployed content retained',
    );
    return journal;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--pack') {
    const result = await packState(process.cwd());
    console.log(`Saved validated derived snapshot: ${result.files} files`);
  } else if (process.argv[2] === '--restore') await prepareVerification(process.cwd());
  else throw Error('Expected --restore or --pack');
}
