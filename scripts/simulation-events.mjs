import fs from 'node:fs/promises';
import path from 'node:path';
import { gitBlob, REPOSITORY } from './upstream-content.mjs';

export function eventPath(value) {
  return (
    typeof value === 'string' &&
    /^Config\/Level\/Rogue\/(?:RogueNPC|RogueDialogue)\/[\w/-]+\.json$/.test(value) &&
    !value.split('/').some((part) => part === '..' || part === '.')
  );
}

// Follow explicit handbook -> NPC -> dialogue paths. Numeric prefixes never
// establish mode or event ownership. Only complete, pinned subtree listings count.
export async function prepareSimulationEvents(
  stage,
  raw,
  planFile,
  api,
  blobs,
  run,
  fetcher = fetch,
) {
  const plan = JSON.parse(await fs.readFile(planFile));
  const cache = new Map();
  async function tree(sha, recursive = false) {
    const key = `git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
    if (!cache.has(key)) cache.set(key, api(key));
    const result = await cache.get(key);
    if (result.truncated || !Array.isArray(result.tree))
      throw new Error('Incomplete event source tree');
    return result.tree;
  }
  let sha = plan.commit;
  for (const part of ['Config', 'Level', 'Rogue']) {
    const entry = (await tree(sha)).find((item) => item.path === part && item.type === 'tree');
    if (!entry) throw new Error('Missing official event directory: ' + part);
    sha = entry.sha;
  }
  const index = new Map(
    (await tree(sha, true))
      .filter((item) => item.type === 'blob')
      .map((item) => ['Config/Level/Rogue/' + item.path, item.sha]),
  );
  const records = new Map();
  const review = [];
  async function download(file) {
    if (records.has(file)) return records.get(file).json;
    const expected = index.get(file);
    if (!eventPath(file)) throw new Error('Unsafe event path: ' + file);
    if (!expected) {
      review.push({ path: file, reason: '공식 참조 파일이 해당 릴리스 트리에 없음' });
      return;
    }
    if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error('Unverified event blob: ' + file);
    let bytes = await fs.readFile(path.join(blobs, expected)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!bytes || gitBlob(bytes) !== expected) {
      const response = await fetcher(
        `https://raw.githubusercontent.com/${REPOSITORY}/${plan.commit}/${file}`,
        { signal: AbortSignal.timeout(60000) },
      );
      if (!response.ok) throw new Error(`Event source HTTP ${response.status}: ${file}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (gitBlob(bytes) !== expected) throw new Error('Event Git blob mismatch: ' + file);
    const target = path.join(stage, '.cache/simulation-events/raw', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    await fs.writeFile(path.join(blobs, expected), bytes);
    const json = JSON.parse(bytes);
    records.set(file, { path: file, sha: expected, json });
    return json;
  }
  const ids = new Set();
  for (const name of ['RogueHandBookEvent.json', 'RogueTournHandBookEvent.json'])
    for (const event of JSON.parse(await fs.readFile(path.join(raw, name))))
      for (const progress of event.UnlockNPCProgressIDList ?? []) {
        // The pinned release uses an obfuscated key; extract only a unique
        // value that actually resolves in the official NPC table below.
        for (const value of Object.values(progress))
          if (Number.isSafeInteger(value)) ids.add(value);
      }
  const npcs = (
    await Promise.all(
      ['RogueNPC.json', 'RogueTournNPC.json', 'RogueMagicNPC.json'].map(async (name) =>
        JSON.parse(await fs.readFile(path.join(raw, name))),
      ),
    )
  ).flat();
  const paths = [
    ...new Set(
      npcs.filter((item) => ids.has(item.RogueNPCID)).map((item) => item.NPCJsonPath.trim()),
    ),
  ];
  async function bounded(items, task) {
    let position = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (position < items.length) await task(items[position++]);
      }),
    );
  }
  await bounded(paths, download);
  const dialogues = [
    ...new Set(
      [...records.values()].flatMap(({ json }) =>
        (json.DialogueList ?? [])
          .flatMap((item) => [item.DialoguePath?.trim(), item.OptionPath?.trim()])
          .filter(Boolean),
      ),
    ),
  ];
  await bounded(dialogues, download);
  await fs.mkdir(path.join(stage, '.cache/simulation-events'), { recursive: true });
  await fs.writeFile(
    path.join(stage, '.cache/simulation-events/manifest.json'),
    JSON.stringify({
      commit: plan.commit,
      files: [...records.values()].map(({ path, sha }) => ({ path, sha })),
      review,
    }),
  );
  run('import-simulation-events.py', [stage, raw, planFile, '--catalog']);
}
