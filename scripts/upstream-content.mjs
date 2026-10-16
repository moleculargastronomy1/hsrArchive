import crypto from 'node:crypto';

export const REPOSITORY = 'DimbreathBot/TurnBasedGameData';
export const REQUIRED_TABLES = [
  'NounAtlas.json',
  'NounAtlasChangeInfo.json',
  'TalkSentenceConfig.json',
  'MissionChapterConfig.json',
];

export function gitBlob(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function localizedFiles(entries, language = 'KR') {
  if (!['KR', 'EN', 'CHS', 'JP'].includes(language))
    throw new Error('Unsupported TextMap language');
  if (!Array.isArray(entries)) throw new Error('Invalid TextMap directory');
  const pattern = new RegExp(`^TextMap${language}(?:_\\d+)?\\.json$`);
  const files = entries.filter((entry) => entry.type === 'file' && pattern.test(entry.name));
  if (!files.length || files.some((file) => !/^[a-f0-9]{40}$/.test(file.sha)))
    throw new Error(`Missing or invalid ${language} TextMap files`);
  if (files.some((file) => file.name === `TextMap${language}.json`) && files.length > 1)
    throw new Error(`Ambiguous combined and split ${language} TextMap`);
  const numbered = files
    .map((file) => Number(file.name.match(/_(\d+)/)?.[1] ?? 0))
    .sort((a, b) => a - b);
  if (numbered.some((part, index) => part !== index))
    throw new Error(`Incomplete ${language} TextMap parts`);
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

export const koreanFiles = (entries) => localizedFiles(entries, 'KR');

export async function resolveUpstream(api) {
  const latest = await api('commits/main');
  if (
    !/^[a-f0-9]{40}$/.test(latest.sha) ||
    !/^OSPRODWin\d+\.\d+\.\d+/.test(latest.commit?.message ?? '')
  )
    throw new Error('Upstream main is not an identified release snapshot');
  const commit = latest.sha;
  const [textmap, root] = await Promise.all([
    api(`contents/TextMap?ref=${commit}`),
    api(`git/trees/${commit}`),
  ]);
  const excel = root.tree?.find((entry) => entry.path === 'ExcelOutput' && entry.type === 'tree');
  if (root.truncated || !excel) throw new Error('Missing ExcelOutput tree');
  const tableTree = await api(`git/trees/${excel.sha}`);
  if (tableTree.truncated || !Array.isArray(tableTree.tree))
    throw new Error('Incomplete table tree');
  const tables = REQUIRED_TABLES.map((name) => {
    const entry = tableTree.tree.find((row) => row.path === name && row.type === 'blob');
    if (!entry || !/^[a-f0-9]{40}$/.test(entry.sha)) throw new Error(`Missing table: ${name}`);
    return { path: `ExcelOutput/${name}`, sha: entry.sha };
  });
  return {
    schema: 'hsr-upstream-plan.v1',
    repository: REPOSITORY,
    commit,
    version: latest.commit.message.split('\n')[0],
    checkedAt: new Date().toISOString(),
    files: [
      ...['KR', 'EN', 'CHS', 'JP'].flatMap((language) =>
        localizedFiles(textmap, language).map((file) => ({
          path: `TextMap/${file.name}`,
          sha: file.sha,
        })),
      ),
      ...tables,
    ],
  };
}
