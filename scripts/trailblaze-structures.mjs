// Resolve exact mission directories. Never use a whole-repository recursive tree,
// which GitHub truncates for this source.
export function isMissionStructurePath(value) {
  return (
    /^(?:Story\/Mission|Config\/Level\/Mission)\/[1-9]\d*\/[A-Za-z0-9_./-]+\.json$/.test(value) &&
    !value.split('/').some((part) => part === '..' || part === '.') &&
    !value.endsWith('.layout.json')
  );
}

export async function resolveMissionStructures(api, commit, missionIds) {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    missionIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw new Error('Invalid mission structure request');
  if (!missionIds.length) return [];
  const cache = new Map();
  async function tree(sha, recursive = false) {
    const endpoint = `git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
    if (!cache.has(endpoint)) cache.set(endpoint, api(endpoint));
    const result = await cache.get(endpoint);
    if (result.truncated || !Array.isArray(result.tree)) throw new Error('Incomplete mission tree');
    if (result.tree.some((row) => !/^[a-f0-9]{40}$/.test(row.sha)))
      throw new Error('Invalid mission tree identity');
    return result.tree;
  }
  async function directory(parts) {
    let sha = commit;
    for (const part of parts) {
      const entry = (await tree(sha)).find((row) => row.type === 'tree' && row.path === part);
      if (!entry) return [];
      sha = entry.sha;
    }
    return tree(sha);
  }
  const files = [];
  for (const prefix of ['Story/Mission', 'Config/Level/Mission']) {
    const directories = await directory(prefix.split('/'));
    for (const missionId of [...new Set(missionIds)].sort((a, b) => a - b)) {
      const entry = directories.find(
        (row) => row.type === 'tree' && row.path === String(missionId),
      );
      if (!entry) continue;
      for (const row of await tree(entry.sha, true)) {
        if (row.type !== 'blob' || !row.path.endsWith('.json') || row.path.endsWith('.layout.json'))
          continue;
        const path = `${prefix}/${missionId}/${row.path}`;
        if (!isMissionStructurePath(path)) throw new Error('Unsafe mission structure path');
        files.push({ path, sha: row.sha, missionId });
      }
    }
  }
  return files;
}
