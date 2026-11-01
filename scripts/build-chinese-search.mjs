import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const chineseSearchFile = 'public/content/locales/chinese-search.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Package already verified comparisons; never collect, translate or realign text.
export async function buildChineseSearch(root) {
  const corpusBytes = await fs.readFile(path.join(root, 'public/content/search-index.json'));
  const corpus = JSON.parse(corpusBytes);
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'public/content/locales/manifest.json')),
  );
  if (
    corpus.schema !== 'hsr-dialogue.v1' ||
    !Array.isArray(corpus.rows) ||
    manifest.schema !== 'hsr-localization-manifest.v1' ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    (corpus.textReferenceCommit ?? corpus.referenceCommit) !== manifest.commit
  )
    throw Error('Chinese search requires matching Korean and comparison revisions');
  const groups = new Map();
  for (const row of corpus.rows) {
    if (![row.entryId, row.chapterId].every((id) => /^[A-Za-z0-9_-]+$/.test(id)))
      throw Error('Unsafe Chinese comparison identity');
    const key = `${row.entryId}--${row.chapterId}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(row.id);
  }
  const texts = new Map();
  for (const [key, ids] of groups) {
    const data = JSON.parse(
      await fs.readFile(path.join(root, `public/content/locales/zh-CN/${key}.json`)),
    );
    if (
      data.schema !== 'hsr-localizations.v1' ||
      data.language !== 'zh-CN' ||
      `${data.entryId}--${data.chapterId}` !== key ||
      data.referenceCommit !== manifest.commit ||
      !Array.isArray(data.rows)
    )
      throw Error('Mismatched Chinese comparison: ' + key);
    const seen = new Set();
    for (const row of data.rows) {
      if (
        typeof row.id !== 'string' ||
        typeof row.speaker !== 'string' ||
        typeof row.text !== 'string' ||
        !row.text.trim() ||
        seen.has(row.id)
      )
        throw Error('Invalid Chinese comparison row: ' + key);
      seen.add(row.id);
      if (ids.has(row.id)) texts.set(row.id, `${row.speaker}\n${row.text}`);
    }
  }
  const rows = corpus.rows
    .filter((row) => texts.has(row.id))
    .map((row) => [row.id, texts.get(row.id)]);
  if (new Set(rows.map((row) => row[0])).size !== rows.length)
    throw Error('Duplicate Korean search IDs');
  const data = {
    schema: 'hsr-chinese-search.v1',
    language: 'zh-CN',
    referenceCommit: manifest.commit,
    corpusSha256: sha256(corpusBytes),
    rows,
    copyright: 'Game text © HoYoverse and respective rights holders.',
  };
  const target = path.join(root, chineseSearchFile);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target + '.tmp', JSON.stringify(data) + '\n');
  await fs.rename(target + '.tmp', target);
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const data = await buildChineseSearch(path.resolve(process.argv[2] ?? '.'));
  console.log(`Chinese search: ${data.rows.length} verified comparisons packaged`);
}
