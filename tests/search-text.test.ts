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
  searchSourceLabel,
  type SearchTextSource,
} from '../src/lib/search-text.ts';
import { searchRetryDue, refreshSearchText } from '../scripts/search-text.mjs';
import { gitBlob } from '../scripts/upstream-content.mjs';
import {
  collectSearchSources,
  selectSearchRequests,
} from '../scripts/search-source-collection.mjs';

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
  const collector = fs.readFileSync('scripts/search-source-collection.mjs', 'utf8');
  assert.match(collector, /limit = 40/);
  assert.match(collector, /maxDownloads: 20/);
  assert.doesNotMatch(collector, /saveRetry|readRetry/);
});

test('limited search collection gives all Other kinds a turn and excludes unrelated queues', () => {
  const now = Date.now();
  const requests = Array.from({ length: 100 }, (_, i) => ({
    title: 'npc' + i,
    searchKind: 'NPC 대사',
  }));
  requests.unshift({ title: 'mission', searchKind: '관련 문서' });
  for (const kind of ['상호작용', '메시지', '우편', '로딩 화면'])
    requests.push({ title: kind, searchKind: kind });
  const selected = selectSearchRequests(requests, { pages: {} }, now);
  assert.equal(selected.length, 40);
  assert.deepEqual(
    new Set(selected.slice(0, 5).map((p) => p.searchKind)),
    new Set(['NPC 대사', '상호작용', '메시지', '우편', '로딩 화면']),
  );
  assert.ok(!selected.some((p) => p.title === 'mission'));
  assert.ok(
    !selectSearchRequests(
      requests,
      { pages: { npc0: { nextRetryAt: new Date(now + 1).toISOString() } } },
      now,
    ).some((p) => p.title === 'npc0'),
  );
  for (const label of ['互动文本/空间站', '帕姆', '로딩 过场提示', 'English'])
    assert.equal(searchSourceLabel({ kind: 'NPC 대사', label } as SearchTextSource), '');
  assert.equal(searchSourceLabel({ kind: 'NPC 대사', label: '폼폼' } as SearchTextSource), '폼폼');
});

test('known bodies survive failed discovery and cache replay never issues network requests', async () => {
  const fixture = await fsp.mkdtemp(path.resolve('.cache/tests/search-discovery-'));
  try {
    await fsp.mkdir(path.join(fixture, 'public/search'), { recursive: true });
    await fsp.writeFile(
      path.join(fixture, 'public/search/manifest.json'),
      JSON.stringify({
        pendingPages: [{ title: 'NPC-example', searchKind: 'NPC 대사' }],
        sources: [],
      }),
    );
    const planFile = path.join(fixture, 'plan.json');
    await fsp.writeFile(
      planFile,
      JSON.stringify({ schema: 'hsr-upstream-plan.v1', commit: 'a'.repeat(40) }),
    );
    const calls: string[] = [];
    const fetcher = async (url: URL) => {
      const p = new URL(url).searchParams;
      calls.push(p.get('list') ?? p.get('rvprop')!);
      if (p.has('list')) return new Response('', { status: 567 });
      return Response.json({
        query: {
          pages: p
            .get('titles')!
            .split('|')
            .map((title, i) => ({
              title,
              pageid: i + 1,
              ns: 0,
              revisions: [
                {
                  revid: 100 + i,
                  timestamp: '2026-10-24T00:00:00Z',
                  ...(p.get('rvprop')!.includes('content')
                    ? {
                        slots: { main: { content: '{{NPC|对话内容=这是一条经过验证的中文原文}}' } },
                      }
                    : {}),
                },
              ],
            })),
        },
      });
    };
    const manifest = await collectSearchSources(fixture, fixture, planFile, {
      fetcher,
      pause: async () => {},
    });
    assert.equal(calls[0], 'ids|timestamp');
    assert.equal(calls[1], 'ids|timestamp|content');
    assert.equal(calls[2], 'embeddedin');
    assert.equal(calls.length, 3);
    assert.ok(manifest.pages.some((p) => p.title === 'NPC-example' && p.status === 'available'));
    assert.match(manifest.review[0].reason, /567/);
    const replayed = await collectSearchSources(fixture, fixture, planFile, {
      cacheOnly: true,
      fetcher: async () => {
        throw Error('Cache replay must not query BWIKI');
      },
      pause: async () => {},
    });
    assert.ok(
      replayed.pages.some(
        (p) => p.title === 'NPC-example' && p.status === 'available' && p.searchKind === 'NPC 대사',
      ),
    );
    assert.equal(calls.length, 3);
  } finally {
    assert.ok(fixture.startsWith(path.resolve('.cache/tests') + path.sep));
    await fsp.rm(fixture, { recursive: true, force: true });
  }
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
