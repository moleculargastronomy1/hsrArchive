import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  chineseSearchEnabled,
  matchesBilingualTerms,
  parseChineseSearch,
} from '../src/lib/chinese-search.ts';
import { textMatches } from '../src/lib/search-text.ts';
import { buildChineseSearch, chineseSearchFile } from '../scripts/build-chinese-search.mjs';

test('Chinese lookup is opt-in, skips empty/Korean searches, and supports mixed queries', () => {
  assert.equal(chineseSearchEnabled([], '开拓'), false);
  assert.equal(chineseSearchEnabled(['en', 'ja'], '开拓'), false);
  assert.equal(chineseSearchEnabled(['zh-CN'], ''), false);
  assert.equal(chineseSearchEnabled(['zh-CN'], '개척'), false);
  assert.equal(chineseSearchEnabled(['zh-CN'], '카프카 开拓'), true);
  assert.equal(matchesBilingualTerms('카프카 원문', ['카프카', '开拓']), false);
  assert.equal(matchesBilingualTerms('카프카 원문', ['카프카', '开拓'], new Set(['开拓'])), true);
  assert.equal(
    matchesBilingualTerms('카프카 원문', ['카프카', '开拓', '없는말'], new Set(['开拓'])),
    false,
  );
});

test('supplemental search matches only opted-in official Chinese, never internal wiki titles', () => {
  const row: [string, string, number[]] = ['18446744073709551615', '카프카의 원문', [0]];
  const sources = [
    { pageTitle: '开拓', kind: 'NPC 대사', label: '카프카', pageId: 1, revision: 2 },
  ];
  assert.equal(textMatches(row, ['开拓'], sources), false);
  assert.equal(textMatches(row, ['开拓'], [{ ...sources[0], label: '开拓' }]), false);
  assert.equal(textMatches(row, ['카프카', '开拓'], sources, '开拓的原文'), true);
  assert.equal(textMatches(row, ['开拓'], sources, '{RUBY_B#开拓}原文{RUBY_E#}'), true);
});

test('packaging reuses exact localized IDs and rejects mixed revisions and stale Korean corpora', async () => {
  await fs.mkdir('.cache/tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/tests/chinese-search-'));
  const write = async (file: string, value: unknown) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify(value));
  };
  const commit = 'a'.repeat(40);
  const identity = { entryId: 'station', chapterId: 'arrival' };
  const corpus = {
    schema: 'hsr-dialogue.v1',
    textReferenceCommit: commit,
    rows: [
      { ...identity, id: 'line-2', text: '개척' },
      { ...identity, id: 'line-1', text: '개척' },
      { ...identity, id: 'missing', text: '개척' },
    ],
  };
  const locale = {
    schema: 'hsr-localizations.v1',
    language: 'zh-CN',
    ...identity,
    referenceCommit: commit,
    rows: [
      { id: 'line-1', speaker: '卡芙卡', text: '{RUBY_B#开拓}原文{RUBY_E#}' },
      { id: 'line-2', speaker: '', text: '另一句话' },
      { id: 'unrelated', speaker: '', text: '开拓' },
    ],
  };
  try {
    await write('public/content/search-index.json', corpus);
    await write('public/content/locales/manifest.json', {
      schema: 'hsr-localization-manifest.v1',
      commit,
    });
    await write('public/content/locales/zh-CN/station--arrival.json', locale);
    const index = await buildChineseSearch(root);
    const digest = createHash('sha256')
      .update(await fs.readFile(path.join(root, 'public/content/search-index.json')))
      .digest('hex');
    const parsed = parseChineseSearch(index, digest);
    assert.deepEqual([...parsed.keys()], ['line-2', 'line-1']);
    assert.ok(parsed.get('line-1')?.includes('开拓'));
    assert.ok(parsed.get('line-1')?.includes('卡芙卡'));
    assert.throws(() => parseChineseSearch(index, 'b'.repeat(64)));
    assert.throws(() =>
      parseChineseSearch({ ...index, rows: [index.rows[0], index.rows[0]] }, digest),
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, chineseSearchFile), 'utf8')),
      index,
    );
    await write('public/content/locales/zh-CN/station--arrival.json', {
      ...locale,
      referenceCommit: 'b'.repeat(40),
    });
    await assert.rejects(buildChineseSearch(root), /Mismatched/);
  } finally {
    assert.ok(root.startsWith(path.resolve('.cache/tests') + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});
