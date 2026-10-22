import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serveData, rendered, searchText } from '../worker/service.ts';
import { consume, defaultPolicy } from '../worker/policy.ts';
import { sessionToken, verifySession, ipGroup, makeStore } from '../worker/index.ts';
import { choiceDialogue, nearbyDialogue } from '../src/lib/dialogue.ts';
import { publishedFetch } from '../scripts/private-state-fetch.mjs';
import { sanitizeMetadata } from '../scripts/protected-public.mjs';
import { verifyTurnstile } from '../worker/turnstile.ts';
import { archive } from '../src/data/archive.ts';

test('shared limiter permits ordinary reading, isolates sessions and limits sweeps/rotation across a shared IP', () => {
  let state: any;
  for (let i = 0; i < 90; i++) {
    const result = consume(
      state,
      'reader',
      i % 3 === 0 ? 'search' : 'page',
      'chapter',
      1000,
      defaultPolicy,
    );
    assert.equal(result.allowed, true);
    state = result.usage;
  }
  const search = consume(state, 'reader', 'search', '', 1000, defaultPolicy);
  assert.equal(search.reason, 'search-volume');
  assert.equal(
    consume(state, 'other-reader', 'page', 'chapter', 1000, defaultPolicy).allowed,
    true,
  );
  let sweep: any;
  for (let i = 0; i < 41; i++)
    sweep = consume(sweep?.usage, 'crawler', 'page', 'chapter-' + i, 1000, defaultPolicy);
  assert.equal(sweep.reason, 'chapter-sweep');
  assert.equal(
    consume(sweep.usage, 'crawler', 'page', 'chapter', 62000, defaultPolicy).allowed,
    true,
  );
  const rotated = consume(
    { start: 1000, total: 1200, pages: 0, searches: 0, chapters: [], sessions: {} },
    'new-id',
    'page',
    'x',
    1000,
    defaultPolicy,
  );
  assert.equal(rotated.reason, 'ip-volume');
});
test('sessions are signed, expire and cannot be moved to another IP/agent group', async () => {
  const key = 'a sufficiently long test-only secret';
  const token = await sessionToken(key, 'reader', 1000000000000);
  assert.equal(await verifySession(token, key, 'reader', 1000000000001), true);
  assert.equal(await verifySession(token, key, 'different', 1000000000001), false);
  assert.equal(await verifySession(token, key, 'reader', 1000004000000), false);
  assert.equal(await verifySession(token + 'x', key, 'reader', 1000000000001), false);
  assert.equal(ipGroup('2001:db8:abcd:1::1234'), ipGroup('2001:0db8:abcd:0001::ffff'));
});
test('optional bot verification validates the server response, hostname and action; IP ceilings stay enforced', async () => {
  const verify = (value: any) =>
    verifyTurnstile(
      'test-secret',
      'test-token',
      ['reader.example'],
      async () => new Response(JSON.stringify(value)),
    );
  assert.equal(
    await verify({ success: true, hostname: 'reader.example', action: 'archive-read' }),
    true,
  );
  assert.equal(
    await verify({ success: true, hostname: 'attacker.example', action: 'archive-read' }),
    false,
  );
  assert.equal(
    await verify({ success: false, hostname: 'reader.example', action: 'archive-read' }),
    false,
  );
  assert.equal(await verify({ success: true, hostname: 'reader.example', action: 'other' }), false);
  const denied = consume(
    { start: 1000, total: 1200, pages: 0, searches: 0, chapters: [], sessions: {} },
    'verified-user',
    'page',
    'x',
    1000,
    defaultPolicy,
    true,
  );
  assert.equal(denied.reason, 'ip-volume');
});
test('all referenced chapter page windows keep IDs, occurrence order, text and graph data exactly', async () => {
  const search = JSON.parse(await fs.readFile('public/content/search-index.json', 'utf8'));
  let count = 0;
  for (const file of await fs.readdir('public/content')) {
    if (file === 'search-index.json' || !file.endsWith('.json')) continue;
    const data = JSON.parse(await fs.readFile('public/content/' + file, 'utf8'));
    const expected = rendered(data);
    const store: any = { chapter: async () => data };
    const collected: any[] = [];
    for (let page = 1; page <= Math.max(1, Math.ceil(expected.length / 50)); page++) {
      const response: any = await serveData(
        '/v1/page',
        new URLSearchParams({ file: 'content/' + file, page: String(page) }),
        store,
      );
      assert.ok(response.rows.length <= 50);
      assert.equal(response.total, expected.length);
      collected.push(...response.rows);
    }
    assert.deepEqual(collected, expected, file);
    count += data.rows.length;
    const target = expected[expected.length - 1];
    if (target) {
      const located: any = await serveData(
        '/v1/page',
        new URLSearchParams({
          file: 'content/' + file,
          dialogue: target.id,
          occurrence: target.wikiPosition?.id ?? '',
        }),
        store,
      );
      assert.ok(located.rows.some((r: any) => r.id === target.id));
    }
    // Compare boundary contexts, a choice, and a repeated occurrence using the
    // current client renderer's independent selection of the same payload.
    const indices = new Set([
      0,
      expected.length - 1,
      expected.findIndex((r) => r.type === 'choice'),
      expected.findIndex((r, i) => expected.findIndex((x) => x.id === r.id) !== i),
    ]);
    for (const index of indices) {
      if (index < 0 || !expected[index]) continue;
      const selected = expected[index];
      const result: any = await serveData(
        '/v1/context',
        new URLSearchParams({
          file: 'content/' + file,
          dialogue: selected.id,
          occurrence: selected.wikiPosition?.id ?? '',
        }),
        store,
      );
      const targetIndex = expected.findIndex(
        (r) =>
          r.id === selected.id &&
          (!selected.wikiPosition || r.wikiPosition?.id === selected.wikiPosition.id),
      );
      assert.deepEqual(
        result.rows,
        (selected.type === 'choice' ? choiceDialogue : nearbyDialogue)(expected, targetIndex),
      );
      assert.ok(result.rows.length <= 41);
    }
  }
  assert.equal(count, search.rows.length);
});
test('D1 exact substring search matches the existing client semantics for Korean, speaker and markup queries', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE search_rows(release,ordinal,category,search,body); CREATE VIRTUAL TABLE search_fts USING fts5(search,content='search_rows',content_rowid='rowid',tokenize='trigram case_sensitive 1');",
  );
  const source = JSON.parse(await fs.readFile('public/content/search-index.json', 'utf8')).rows;
  const categories = new Map(archive.map((entry) => [entry.id, entry.category]));
  const insert = db.prepare('INSERT INTO search_rows VALUES(?,?,?,?,?)');
  db.exec('BEGIN');
  source.forEach((r: any, i: number) =>
    insert.run('test', i, categories.get(r.entryId)!, searchText(r), JSON.stringify(r)),
  );
  db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild'); COMMIT;");
  const env: any = {
    SEARCH: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            return {
              async first() {
                return db.prepare(sql).get(...args);
              },
              async all() {
                return { results: db.prepare(sql).all(...args) };
              },
            };
          },
        };
      },
    },
  };
  const store = makeStore(env, 'test');
  const previous = makeStore(
    {
      ...env,
      PREVIOUS_RELEASE: 'test',
      SEARCH_PREVIOUS: env.SEARCH,
      SEARCH: {
        prepare() {
          throw new Error('A previous client must not use the new search DB');
        },
      },
    } as any,
    'test',
  );
  assert.equal((await previous.search('', 'all', 1)).total, source.length);
  for (const query of [
    '',
    '개척자',
    'Mar',
    '단항',
    '나',
    '「',
    '은하 열차',
    '스텔레',
    '반디',
    'a"b',
    '{NICKNAME}',
    '없는문자열검사xyz',
  ]) {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = source.filter((r: any) => terms.every((t) => searchText(r).includes(t)));
    const result = await store.search(query, 'all', 1);
    assert.equal(result.total, matches.length, query);
    assert.deepEqual(result.rows, matches.slice(0, 50), query);
  }
  for (const scope of ['trailblaze', 'simulation', 'books', 'codex']) {
    const expected = source.filter(
      (r: any) => categories.get(r.entryId) === scope && searchText(r).includes('나'),
    );
    const result = await store.search('나', scope, 1);
    assert.equal(result.total, expected.length);
    assert.deepEqual(result.rows, expected.slice(0, 50));
  }
  db.close();
});
test('locale endpoint returns only requested IDs/language and rejects bulk/path traversal', async () => {
  const file = 'content/station-departure--arrival.json';
  for (const language of ['en', 'zh-CN', 'ja']) {
    const data = JSON.parse(
      await fs.readFile(
        `public/content/locales/${language}/station-departure--arrival.json`,
        'utf8',
      ),
    );
    const result: any = await serveData(
      '/v1/locale',
      new URLSearchParams({ file, language, ids: data.rows[0].id }),
      { locale: async () => data } as any,
    );
    assert.deepEqual(result.rows, [data.rows[0]]);
    const batch: any = await serveData(
      '/v1/locales',
      new URLSearchParams({ language, items: JSON.stringify([{ file, ids: [data.rows[0].id] }]) }),
      { locale: async () => data } as any,
    );
    assert.deepEqual(batch.items[0].rows, [data.rows[0]]);
  }
  await assert.rejects(
    serveData(
      '/v1/locale',
      new URLSearchParams({
        file,
        language: 'en',
        ids: Array.from({ length: 101 }, (_, i) => 'r' + i).join(','),
      }),
      {} as any,
    ),
  );
  await assert.rejects(
    serveData(
      '/v1/page',
      new URLSearchParams({ file: 'content/../../verification-state.json' }),
      {} as any,
    ),
  );
});
test('private CI state is authenticated, refuses redirects/failures and never falls back publicly', async () => {
  const env = {
    HSR_PRIVATE_STATE_URL: 'https://api.example/',
    HSR_PRIVATE_STATE_TOKEN: 'test-only',
  };
  let calls = 0;
  await publishedFetch(
    'https://moleculargastronomy1.github.io/hsrArchive/content-watch.json',
    {},
    async (url: URL, options: any) => {
      calls++;
      assert.equal(String(url), 'https://api.example/internal/state/content-watch.json');
      assert.equal(options.headers.get('Authorization'), 'Bearer test-only');
      assert.equal(options.redirect, 'error');
      return new Response('{}');
    },
    env,
  );
  await assert.rejects(
    publishedFetch(
      'https://moleculargastronomy1.github.io/hsrArchive/verification-state.json',
      {},
      async () => {
        calls++;
        return new Response('', { status: 503 });
      },
      env,
    ),
    /refusing public fallback/,
  );
  assert.equal(calls, 2);
  const result = sanitizeMetadata([
    { chapters: [{ content: { file: 'x' }, blocks: [{ text: 'private' }], title: '목차' }] },
  ]);
  assert.deepEqual(result[0].chapters[0].blocks, []);
});
