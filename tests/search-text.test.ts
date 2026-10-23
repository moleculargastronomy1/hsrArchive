import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  parseSearchManifest,
  parseSearchPart,
  searchTextWindow,
  textMatches,
  otherTextCategories,
  otherTextFilter,
  searchScopePath,
  matchesOtherText,
  searchTextRow,
  type SearchTextSource,
} from '../src/lib/search-text.ts';
import { searchRetryDue, refreshSearchText } from '../scripts/search-text.mjs';
import { gitBlob } from '../scripts/upstream-content.mjs';

test('supplemental comparison identity keeps full 64-bit hashes and titles are searchable', () => {
  const row: [string, string, number[], string] = [
    '8635891183804058996',
    '본문',
    [],
    '허수의 나무',
  ];
  assert.equal(searchTextRow(row).id, row[0]);
  assert.equal(searchTextRow(row).chapterId, 'part-20');
  assert.equal(textMatches(row, ['허수의', '나무']), true);
});

test('supplemental search shares pagination across the curated result boundary', () => {
  assert.deepEqual(searchTextWindow(51, 2), { offset: 0, limit: 49 });
  assert.deepEqual(searchTextWindow(51, 3), { offset: 49, limit: 50 });
  assert.deepEqual(searchTextWindow(0, 1), { offset: 0, limit: 50 });
  assert.deepEqual(searchTextWindow(100, 2), { offset: 0, limit: 0 });
  assert.ok(
    textMatches(
      ['18446744073709551615', '{RUBY_B#주석}본문{RUBY_E#} 문자열', []],
      ['본문', '주석'],
    ),
  );
  assert.ok(textMatches(['18446744073709551615', '원문', []], ['18446744073709551615']));
});

test('search data validates safe paths, counts, exact string IDs and source references', () => {
  const data = JSON.parse(fs.readFileSync('public/search/manifest.json', 'utf8'));
  const manifest = parseSearchManifest(data);
  const part = manifest.parts[0];
  const rows = parseSearchPart(
    JSON.parse(fs.readFileSync('public/search/' + part.file, 'utf8')),
    manifest.commit,
    part.rows,
    manifest.sources.length,
  );
  assert.ok(rows.length > 0);
  assert.throws(() => parseSearchManifest({ ...data, parts: [{ ...part, file: '../secret' }] }));
  assert.throws(() =>
    parseSearchPart(
      { schema: 'hsr-search-text-part.v1', commit: manifest.commit, rows: [['1', '원문', [100]]] },
      manifest.commit,
      1,
      1,
    ),
  );
  assert.throws(() =>
    parseSearchPart(
      {
        schema: 'hsr-search-text-part.v1',
        commit: manifest.commit,
        rows: [[18446744073709551615, '원문', []]],
      },
      manifest.commit,
      1,
    ),
  );
});

test('search backoff is independent and waits for both review and request deadlines', () => {
  const now = Date.now();
  assert.equal(searchRetryDue({}, now), true);
  assert.equal(searchRetryDue({ nextRequestAt: new Date(now + 1).toISOString() }, now), false);
  assert.equal(searchRetryDue({ nextReviewAt: new Date(now + 1).toISOString() }, now), false);
  assert.equal(searchRetryDue({ nextRequestAt: new Date(now - 1).toISOString() }, now), true);
  const collector = fs.readFileSync('scripts/collect-search-sources.mjs', 'utf8');
  assert.match(collector, /slice\(0, 40\)/);
  assert.match(collector, /maxDownloads: 20/);
  assert.doesNotMatch(collector, /saveRetry|readRetry/);
});

test('the Other menu contains exactly five confirmed source types and excludes unrelated or unknown rows', () => {
  assert.deepEqual(
    otherTextCategories.map((category) => category.label),
    ['로딩 화면', 'NPC 대사', '상호작용', '메시지', '우편'],
  );
  const sources = [
    '로딩 화면',
    'NPC 대사',
    '상호작용',
    '메시지',
    '우편',
    '광추',
    '유물',
    '서적',
    '관련 문서',
  ].map(
    (kind, index): SearchTextSource => ({
      kind,
      label: kind,
      pageTitle: kind,
      pageId: index + 1,
      revision: 1,
    }),
  );
  for (let index = 0; index < sources.length; index++)
    assert.equal(matchesOtherText(['1', '원문', [index]], sources, 'all'), index < 5);
  assert.equal(matchesOtherText(['1', '원문', []], sources, 'all'), false);
  assert.equal(matchesOtherText(['1', '원문', [0]], sources, 'loading'), true);
  assert.equal(matchesOtherText(['1', '원문', [0]], sources, 'npc'), false);
  assert.equal(matchesOtherText(['1', '원문', [1, 5]], sources, 'npc'), true);
  assert.equal(otherTextFilter('loading'), 'loading');
  assert.equal(otherTextFilter('books'), 'all');
  assert.equal(otherTextFilter(null), 'all');
});

test('Other navigation links preserve the query and subcategory without adding an archive category', () => {
  assert.equal(searchScopePath(), '/search');
  assert.equal(searchScopePath('', 'other'), '/search?scope=other');
  const route = searchScopePath('허수의 나무 & 대사', 'other', 'loading');
  const params = new URLSearchParams(route.split('?')[1]);
  assert.equal(params.get('scope'), 'other');
  assert.equal(params.get('kind'), 'loading');
  assert.equal(params.get('q'), '허수의 나무 & 대사');
  assert.equal(searchScopePath('', 'books', 'npc'), '/search?scope=books');
  assert.equal(searchScopePath('', 'unknown'), '/search');
});

test('search conversion preserves coverage and exact wiki section boundaries', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_search_text.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});

test('failed BWIKI collection still updates TextMap and leaves canonical content byte-identical', async () => {
  const fixture = await fsp.mkdtemp(path.resolve('.cache/tests/search-isolation-'));
  try {
    for (const folder of ['scripts', 'public/content', '.cache/upstream-content/raw'])
      await fsp.mkdir(path.join(fixture, folder), { recursive: true });
    for (const name of [
      'import-search-text.py',
      'bwiki-dialogue.py',
      'import-localizations.py',
      'import-search-localizations.py',
    ])
      await fsp.copyFile(path.resolve('scripts', name), path.join(fixture, 'scripts', name));
    await fsp.writeFile(
      path.join(fixture, 'scripts/collect-search-sources.mjs'),
      'process.exit(1)',
    );
    const original = JSON.stringify({ rows: [{ id: 'existing', text: '기존 본문' }] });
    await fsp.writeFile(path.join(fixture, 'public/content/search-index.json'), original);
    await fsp.writeFile(
      path.join(fixture, 'public/content-update.json'),
      '{"commit":"older-canonical"}',
    );
    const files = [];
    for (const [name, texts] of Object.entries({
      'TextMapKR.json': { '1': '기존 본문', '18446744073709551615': '새 로딩 안내' },
      'TextMapCHS.json': { '1': '已有原文', '18446744073709551615': '这是新的加载提示原文' },
      'TextMapEN.json': { '18446744073709551615': 'New loading text' },
      'TextMapJP.json': { '18446744073709551615': '新しいロード中のテキスト' },
    })) {
      const bytes = Buffer.from(JSON.stringify(texts));
      await fsp.writeFile(path.join(fixture, '.cache/upstream-content/raw', name), bytes);
      files.push({ path: 'TextMap/' + name, sha: gitBlob(bytes) });
    }
    await fsp.writeFile(
      path.join(fixture, '.cache/upstream-content/plan.json'),
      JSON.stringify({
        schema: 'hsr-upstream-plan.v1',
        repository: 'DimbreathBot/TurnBasedGameData',
        commit: 'a'.repeat(40),
        files,
      }),
    );
    assert.equal((await refreshSearchText(fixture)).changed, true);
    assert.equal(
      await fsp.readFile(path.join(fixture, 'public/content/search-index.json'), 'utf8'),
      original,
    );
    assert.equal(
      await fsp.readFile(path.join(fixture, 'public/content-update.json'), 'utf8'),
      '{"commit":"older-canonical"}',
    );
    const manifest = JSON.parse(
      await fsp.readFile(path.join(fixture, 'public/search/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.rows, 1);
    assert.equal(manifest.classifiedRows, 0);
    assert.match(manifest.review[0].reason, /조회 실패/);
  } finally {
    assert.ok(fixture.startsWith(path.resolve('.cache/tests') + path.sep));
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});
