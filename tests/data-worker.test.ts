import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { localWorker } from '../scripts/local-worker.mjs';

test('workerd + real local R2/D1/SQLite DO: partial reading, auth, concurrency limiting and closed recovery paths', async () => {
  const mf = await localWorker({
    bindings: {
      SESSION_SECRET: 'local-only-secret-at-least-32-characters',
      INTERNAL_TOKEN: 'internal-test-only',
      DATA_RELEASE: 'fixture',
      PREVIOUS_RELEASE: 'previous',
      ALLOWED_ORIGINS: 'https://reader.example',
      RATE_POLICY: JSON.stringify({ pageRequests: 4, sessionRequests: 40, ipRequests: 100 }),
    },
  });
  try {
    const bucket = await mf.getR2Bucket('DATA');
    const raw = JSON.parse(
      await fs.readFile('public/content/station-departure--arrival.json', 'utf8'),
    );
    const file = 'content/station-departure--arrival.json';
    await bucket.put('releases/fixture/public/' + file, JSON.stringify(raw));
    await bucket.put('releases/fixture/public/verification-state.json', '{"private":"snapshot"}');
    await bucket.put('releases/fixture/ready.json', '{"release":"fixture"}');
    const headers = {
      'CF-Connecting-IP': '192.0.2.3',
      'User-Agent': 'local-test',
      Origin: 'https://reader.example',
    };
    const call = (route: string, extra: Record<string, string> = {}) =>
      mf.dispatchFetch('https://api.example' + route, { headers: { ...headers, ...extra } });
    const sessionResponse = await call('/v1/session');
    assert.equal(sessionResponse.status, 200);
    const { token } = (await sessionResponse.json()) as any;
    const auth = { 'X-Archive-Session': token };
    const route = '/v1/page?release=fixture&file=' + file;
    const first = await call(route, auth);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(first.headers.get('Access-Control-Allow-Origin'), 'https://reader.example');
    const data = (await first.json()) as any;
    assert.equal(data.rows.length, 50);
    assert.equal(data.wikiReading, undefined);
    assert.ok(data.total > 50);
    assert.equal((await call('/content/search-index.json')).status, 404);
    assert.equal((await call('/verification-state.json')).status, 404);
    assert.equal((await call('/internal/state/verification-state.json')).status, 404);
    assert.equal(
      (
        await call('/internal/state/verification-state.json', {
          Authorization: 'Bearer internal-test-only',
        })
      ).status,
      503,
    );
    const promote = (release: string, expectedPrevious: string | null) =>
      mf.dispatchFetch('https://api.example/internal/promote', {
        method: 'POST',
        headers: { Authorization: 'Bearer internal-test-only', 'Content-Type': 'application/json' },
        body: JSON.stringify({ release, expectedPrevious }),
      });
    assert.equal((await promote('previous', null)).status, 409); // upload incomplete
    assert.equal((await promote('fixture', null)).status, 200);
    assert.equal((await promote('fixture', null)).status, 200); // retry is safe
    await bucket.put('releases/previous/ready.json', '{"release":"previous"}');
    assert.equal((await promote('previous', null)).status, 409); // stale publication
    const internal = await call('/internal/state/verification-state.json', {
      Authorization: 'Bearer internal-test-only',
    });
    assert.equal(internal.status, 200);
    assert.equal(((await internal.json()) as any).private, 'snapshot');
    assert.equal((await call(route)).status, 401);
    assert.equal((await call(route, { ...auth, Origin: 'https://other.example' })).status, 403);
    assert.equal((await call('/v1/page?release=unpublished&file=' + file, auth)).status, 409);
    // One denied release request already consumed one page allowance.
    const burst = await Promise.all(Array.from({ length: 8 }, () => call(route, auth)));
    assert.equal(burst.filter((r) => r.status === 200).length, 2);
    assert.equal(burst.filter((r) => r.status === 429).length, 6);
    assert.ok(
      burst.filter((r) => r.status === 429).every((r) => Number(r.headers.get('Retry-After')) > 0),
    );
    const nextSession = (await call('/v1/session').then((r) => r.json())) as any;
    const locale = JSON.parse(
      await fs.readFile('public/content/locales/en/station-departure--arrival.json', 'utf8'),
    );
    await bucket.put(
      'releases/fixture/public/content/locales/en/station-departure--arrival.json',
      JSON.stringify(locale),
    );
    const batchParams = new URLSearchParams({
      release: 'fixture',
      language: 'en',
      items: JSON.stringify([{ file, ids: [locale.rows[0].id] }]),
    });
    const batch = await call('/v1/locales?' + batchParams, {
      'X-Archive-Session': nextSession.token,
    });
    assert.equal(batch.status, 200);
    assert.deepEqual(((await batch.json()) as any).items[0].rows, [locale.rows[0]]);
    const missing = await call('/v1/page?release=fixture&file=content/missing--chapter.json', {
      'X-Archive-Session': nextSession.token,
    });
    assert.equal(missing.status, 503);
    // A storage error is closed, with no static-JSON fallback URL.
    assert.ok(!(await missing.text()).includes('github.io'));
    const db = await mf.getD1Database('SEARCH');
    await db.exec(
      "CREATE TABLE search_rows(release,ordinal,category,search,body); CREATE VIRTUAL TABLE search_fts USING fts5(search,content='search_rows',content_rowid='rowid',tokenize='trigram case_sensitive 1');",
    );
    await db
      .prepare('INSERT INTO search_rows VALUES(?,?,?,?,?)')
      .bind('fixture', 0, 'trailblaze', '테스트 화자', JSON.stringify(raw.rows[0]))
      .run();
    await db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild');");
    const search = await call('/v1/search?release=fixture&q=' + encodeURIComponent('테스트'), {
      'X-Archive-Session': nextSession.token,
    });
    assert.equal(search.status, 200);
    assert.equal(((await search.json()) as any).total, 1);
  } finally {
    await mf.dispose();
  }
});

test('private uploads validate streamed checksums, resist overwrite, and remain inaccessible publicly', async () => {
  const release = 'a'.repeat(64);
  const mf = await localWorker({
    bindings: {
      SESSION_SECRET: 'local-only-secret-at-least-32-characters',
      INTERNAL_TOKEN: 'upload-test-only',
      DATA_RELEASE: release,
      ALLOWED_ORIGINS: '',
    },
  });
  try {
    const body = '{"private":"data"}';
    const checksum = createHash('sha256').update(body).digest('hex');
    await (
      await mf.getR2Bucket('DATA')
    ).put('probe', body, { sha256: checksum, onlyIf: { etagDoesNotMatch: '*' } });
    const url = `https://api.example/internal/object/${release}/public/verification-state.json`;
    const put = (value: string, digest: string) =>
      mf.dispatchFetch(url, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer upload-test-only',
          'X-Content-SHA256': digest,
          'Content-Length': String(Buffer.byteLength(value)),
        },
        body: value,
      });
    assert.equal((await mf.dispatchFetch(url, { method: 'PUT', body })).status, 404);
    assert.equal((await put(body, checksum)).status, 200);
    assert.equal((await put(body, checksum)).status, 200);
    assert.equal((await put('different', 'b'.repeat(64))).status, 409);
    const object = await (
      await mf.getR2Bucket('DATA')
    ).get(`releases/${release}/public/verification-state.json`);
    assert.equal(await object!.text(), body);
    assert.equal(
      (
        await mf.dispatchFetch(
          `https://api.example/releases/${release}/public/verification-state.json`,
        )
      ).status,
      404,
    );
  } finally {
    await mf.dispose();
  }
});
