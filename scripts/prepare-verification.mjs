import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE, restoreState, packState, statePath, stateFiles, writeDerived } from './verification-state.mjs';
import { baselineChoice, verificationRows } from './verification-retry.mjs';

if (process.argv[2] === '--pack') {
  const result = await packState(process.cwd());
  console.log(`Saved validated derived snapshot: ${result.files} files`);
} else if (process.argv[2] === '--restore') {
  const beforeRows = await verificationRows(process.cwd());
  const beforeCommit = JSON.parse(await fs.readFile('public/content-update.json')).commit;
  const repositoryBytes = new Map();
  for (const file of await stateFiles(process.cwd()))
    repositoryBytes.set(file, await fs.readFile(file));
  if (!(await restoreState(process.cwd()))) {
    // One-time migration from deployments predating durable snapshots. Fetch
    // actual published derived payloads; raw game/wiki input is never published.
    const get = async (file) => {
      const response = await fetch(SITE + file, {
        cache: 'no-store',
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error('Published migration input unavailable: ' + file);
      return Buffer.from(await response.arrayBuffer());
    };
    const siteBefore = await get('site-update.json');
    const wikiBytes = await get('bwiki-provenance.json'),
      wiki = JSON.parse(wikiBytes);
    const update = await get('content-update.json');
    if (JSON.parse(update).commit !== wiki.commit)
      throw new Error('Mixed migration input versions');
    const files = [
      ...new Set([
        ...Object.keys(wiki.chapters).map((file) => 'public/' + file),
        'public/content/search-index.json',
        'public/content-update.json',
        'public/trailblaze-provenance.json',
        'public/dialogue-flow-provenance.json',
        'public/video-order-provenance.json',
        'public/video-review-summary.json',
      ]),
    ];
    const entries = [{ path: 'public/bwiki-provenance.json', bytes: wikiBytes }];
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < files.length) {
          const file = files[next++];
          if (!statePath(file)) throw new Error('Invalid migration path');
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
      throw new Error('Deployment changed during migration');
    for (const item of entries) {
      await writeDerived(process.cwd(), item.path, item.bytes);
    }
    console.log(`Migrated ${entries.length} actual deployed derived files`);
  } else console.log('Restored last successfully deployed verification state');
  const afterCommit = JSON.parse(await fs.readFile('public/content-update.json')).commit;
  if (beforeCommit === afterCommit) {
    const choice = baselineChoice(beforeRows, await verificationRows(process.cwd()));
    if (choice === 'conflict')
      throw new Error(
        'Repository and deployed verification each contain unique evidence; refusing to discard either',
      );
    if (choice === 'repository') {
      for (const [file, bytes] of repositoryBytes) await writeDerived(process.cwd(), file, bytes);
      console.log(
        'Preserved repository improvements containing every deployed row and verified ID',
      );
    }
  }
} else throw new Error('Expected --restore or --pack');
