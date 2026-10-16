import fs from 'node:fs/promises';
import path from 'node:path';
import { gitBlob, REPOSITORY } from './upstream-content.mjs';

export const flowSourcePath = (value) =>
  /^(?:Config\/Level\/Mission|Story\/(?:Discussion\/)?Mission)\/[1-9]\d*\/[A-Za-z0-9_./-]+\.json$/.test(
    value,
  ) && !value.split('/').some((part) => part === '..' || part === '.');

// Download only structures explicitly referenced by an already published mission.
// An absent structure is review work, never a reason to guess a scene or delete text.
export async function prepareDialogueFlow(root, stage, commit, api, blobs) {
  const files = new Set();
  const metadata = JSON.parse(
    await fs.readFile(path.join(stage, 'src/data/imported-content.json')),
  );
  const simulation = JSON.parse(await fs.readFile(path.join(stage, 'src/data/simulation.json')));
  const specs = [
    ...Object.values(metadata),
    ...simulation.flatMap((entry) => entry.chapters.map((chapter) => chapter.content)),
  ];
  for (const spec of specs) {
    const payload = JSON.parse(await fs.readFile(path.join(stage, 'public', spec.file)));
    for (const row of payload.rows)
      if (row.missionId?.startsWith('quest-') && flowSourcePath(row.source ?? ''))
        files.add(row.source);
  }
  const cache = new Map();
  const tree = async (sha, recursive = false) => {
    const endpoint = `git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
    if (!cache.has(endpoint)) cache.set(endpoint, api(endpoint));
    return cache.get(endpoint);
  };
  const descriptors = [];
  for (const prefix of ['Config/Level/Mission', 'Story/Mission', 'Story/Discussion/Mission']) {
    const wanted = [...files].filter((file) => file.startsWith(prefix + '/'));
    if (!wanted.length) continue;
    let sha = commit;
    for (const part of prefix.split('/')) {
      const listing = await tree(sha);
      if (listing.truncated || !Array.isArray(listing.tree))
        throw new Error('Incomplete flow directory');
      sha = listing.tree.find((item) => item.type === 'tree' && item.path === part)?.sha;
      if (!sha) break;
    }
    if (!sha) continue;
    const listing = await tree(sha, true);
    if (!Array.isArray(listing.tree)) throw new Error('Invalid flow tree');
    if (listing.truncated) throw new Error('Incomplete flow tree; retain the previous deployment');
    const wantedSet = new Set(wanted);
    for (const item of listing.tree) {
      const file = prefix + '/' + item.path;
      if (item.type === 'blob' && wantedSet.has(file)) {
        if (!/^[a-f0-9]{40}$/.test(item.sha)) throw new Error('Invalid flow blob identity');
        descriptors.push({ path: file, sha: item.sha });
      }
    }
  }
  const directory = path.join(stage, '.cache/dialogue-flow');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(blobs, { recursive: true });
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < descriptors.length) {
        const file = descriptors[cursor++];
        const target = path.join(blobs, file.sha);
        let bytes = await fs.readFile(target).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (!bytes || gitBlob(bytes) !== file.sha) {
          const response = await fetch(
            `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file.path}`,
            { signal: AbortSignal.timeout(60000) },
          );
          if (!response.ok) throw new Error(`Flow source HTTP ${response.status}: ${file.path}`);
          bytes = Buffer.from(await response.arrayBuffer());
          if (gitBlob(bytes) !== file.sha) throw new Error('Flow source Git blob mismatch');
          await fs.writeFile(target, bytes);
        }
      }
    }),
  );
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      schema: 'hsr-dialogue-flow-input.v1',
      commit,
      blobs: path.resolve(blobs),
      files: descriptors,
    }),
  );
  console.log(`Verified ${descriptors.length}/${files.size} dialogue scene structures`);
}
