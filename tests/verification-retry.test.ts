import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { hash, packState, unpackState, restoreState } from '../scripts/verification-state.mjs';
import {
  HOUR,
  retryDelay,
  failedPage,
  retryDecision,
  compareVerification,
  baselineChoice,
} from '../scripts/verification-retry.mjs';
import { fetchBwiki } from '../scripts/fetch-bwiki.mjs';

const commit = 'a'.repeat(40);
const rootDir = path.resolve('.cache/tests');
test('restoration chooses a proven superset and refuses incomparable repository/deployed improvements', () => {
  const old = new Map([
    ['a', { text: '원문', bwikiStatus: 'matched' }],
    ['b', { text: '원문2', bwikiStatus: 'review' }],
  ]);
  const improved = new Map([...old].map(([id, row]) => [id, { ...row, bwikiStatus: 'matched' }]));
  assert.equal(baselineChoice(old, improved), 'published');
  assert.equal(baselineChoice(improved, old), 'repository');
  const other = new Map([
    ['a', { text: '원문', bwikiStatus: 'review' }],
    ['b', { text: '원문2', bwikiStatus: 'matched' }],
  ]);
  assert.equal(baselineChoice(old, other), 'conflict');
  assert.equal(
    baselineChoice(old, new Map([['a', { text: '바뀐 원문', bwikiStatus: 'matched' }]])),
    'conflict',
  );
});
async function temporary() {
  await fs.mkdir(rootDir, { recursive: true });
  return fs.mkdtemp(path.join(rootDir, 'verification-'));
}
async function cleanup(root: string) {
  assert.ok(root.startsWith(rootDir + path.sep));
  await fs.rm(root, { recursive: true, force: true });
}

test('published snapshots preserve exact integer bytes and validate every path/checksum before restoring', async () => {
  const root = await temporary();
  try {
    await fs.mkdir(path.join(root, 'src/data'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/content'), { recursive: true });
    const exact = '{"hash":18446744073709551615}';
    await fs.writeFile(path.join(root, 'src/data/trailblaze.json'), exact);
    await fs.writeFile(path.join(root, 'public/content-update.json'), JSON.stringify({ commit }));
    const descriptor = await packState(root);
    const bytes = await fs.readFile(path.join(root, 'public', descriptor.file));
    assert.equal(
      unpackState(bytes, descriptor)
        .find((item) => item.path === 'src/data/trailblaze.json')
        ?.bytes.toString(),
      exact,
    );
    assert.throws(() => unpackState(Buffer.from('corrupt'), descriptor));
    const evil = gzipSync(
      JSON.stringify({
        schema: 'hsr-verification-state.v1',
        commit,
        files: [{ path: '../escape.json', bytes: 'e30=', sha256: hash('{}') }],
      }),
    );
    assert.throws(() =>
      unpackState(evil, {
        ...descriptor,
        files: 1,
        sha256: hash(evil),
        file: `verification-state-${hash(evil)}.json.gz`,
      }),
    );
    await assert.rejects(restoreState(root, async () => new Response('', { status: 503 })));
    assert.equal(await restoreState(root, async () => new Response('', { status: 404 })), false);
    assert.equal(await fs.readFile(path.join(root, 'src/data/trailblaze.json'), 'utf8'), exact);
  } finally {
    await cleanup(root);
  }
});

test('failure retries back off, honor Retry-After, replay changed algorithms, and leave stable ambiguity idle', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  assert.equal(retryDelay(1, undefined, now), 6 * HOUR);
  assert.equal(retryDelay(2, undefined, now), 12 * HOUR);
  assert.equal(retryDelay(9, undefined, now), 72 * HOUR);
  assert.equal(retryDelay(1, '86400', now), 24 * HOUR);
  assert.equal(retryDelay(1, 'Sun, 18 Oct 2026 00:00:00 GMT', now), 24 * HOUR);
  const page = failedPage(undefined, 'HTTP 429', now);
  const state = { pages: { page }, algorithm: 'v1' };
  assert.equal(retryDecision(state, 'v1', {}, now).needed, false);
  assert.equal(retryDecision(state, 'v1', {}, now + 6 * HOUR).needed, true);
  assert.equal(
    retryDecision(
      { ...state, nextRequestAt: new Date(now + 12 * HOUR).toISOString() },
      'v1',
      {},
      now + 6 * HOUR,
    ).needed,
    false,
  );
  assert.equal(retryDecision(state, 'v2', {}, now).reason, 'algorithm-changed');
  assert.equal(
    retryDecision({ pages: { page: { aligned: 'input:v1:7' } }, algorithm: 'v1' }, 'v1', {}, now)
      .needed,
    false,
  );
  assert.equal(
    retryDecision({ ...state, pendingDigest: 'new' }, 'v1', { digest: 'old' }, now).needed,
    true,
  );
});

test('collection reuses unchanged revisions without downloading, and algorithm replay can run during backoff', async () => {
  const root = await temporary();
  try {
    await fs.mkdir(path.join(root, '.cache/bwiki'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.cache/bwiki/request.json'),
      JSON.stringify({
        schema: 'hsr-bwiki-request.v1',
        commit,
        review: [],
        requests: [{ title: '임무', missionId: 11 }],
      }),
    );
    const now = Date.now(),
      state: any = { pages: {} },
      cache = path.join(root, 'cache');
    let calls = 0,
      downloads = 0;
    const fetcher = async (url: URL) => {
      calls++;
      const content = url.searchParams.get('rvprop')?.includes('content');
      if (content) downloads++;
      return Response.json({
        query: {
          pages: [
            {
              title: '임무',
              ns: 0,
              pageid: 4,
              revisions: [
                {
                  revid: 7,
                  timestamp: '2026-10-17T00:00:00Z',
                  ...(content ? { slots: { main: { content: '원문' } } } : {}),
                },
              ],
            },
          ],
        },
      });
    };
    const first = await fetchBwiki(root, cache, fetcher, {
      state,
      algorithm: 'v1',
      now,
      pause: async () => {},
    });
    assert.equal(downloads, 1);
    state.pages['임무'] = { aligned: first.pages[0].alignmentKey };
    calls = 0;
    const second = await fetchBwiki(root, cache, fetcher, {
      state,
      algorithm: 'v1',
      now,
      pause: async () => {},
    });
    assert.equal(downloads, 1);
    assert.equal(calls, 1);
    assert.equal(second.pages[0].needsAlignment, false);
    assert.equal(second.pages[0].collectedAt, first.pages[0].collectedAt);
    state.nextRequestAt = new Date(now + HOUR).toISOString();
    const replay = await fetchBwiki(
      root,
      cache,
      async () => {
        throw new Error('must remain offline');
      },
      { state, algorithm: 'v2', now },
    );
    assert.equal(replay.pages[0].retrieval, 'cache-pinned');
    assert.equal(replay.pages[0].needsAlignment, true);
    assert.equal(replay.pages[0].collectedAt, first.pages[0].collectedAt);
  } finally {
    await cleanup(root);
  }
});

test('429 stops requests immediately and the next run respects global cooldown', async () => {
  const root = await temporary();
  try {
    await fs.mkdir(path.join(root, '.cache/bwiki'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.cache/bwiki/request.json'),
      JSON.stringify({
        schema: 'hsr-bwiki-request.v1',
        commit,
        review: [],
        requests: Array.from({ length: 45 }, (_, i) => ({ title: String(i), missionId: i + 1 })),
      }),
    );
    const state: any = { pages: {} },
      now = Date.now();
    let calls = 0;
    const blocked = async () => {
      calls++;
      return new Response('', { status: 429, headers: { 'retry-after': '86400' } });
    };
    const first = await fetchBwiki(root, path.join(root, 'cache'), blocked, { state, now });
    assert.equal(calls, 1);
    assert.equal(first.pages.length, 45);
    assert.equal(Date.parse(state.nextRequestAt), now + 24 * HOUR);
    await fetchBwiki(root, path.join(root, 'cache'), blocked, { state, now: now + 6 * HOUR });
    assert.equal(calls, 1);
  } finally {
    await cleanup(root);
  }
});

test('counters cannot turn a failed lookup or a cached status change into new verification', () => {
  const old = new Map([
    ['known', { id: 'known', text: '확인', bwikiStatus: 'matched' }],
    ['unknown', { id: 'unknown', text: '미확인', bwikiStatus: 'review' }],
  ]);
  const cached = new Map(
    [...old].map(([id, row]) => [
      id,
      { ...row, bwikiStatus: id === 'known' ? 'cached' : 'review' },
    ]),
  );
  assert.equal(compareVerification(old, cached).changed, false);
  assert.equal(compareVerification(old, cached).newlyVerified.length, 0);
  cached.get('unknown')!.bwikiStatus = 'matched';
  assert.deepEqual(compareVerification(old, cached).newlyVerified, ['unknown']);
  cached.get('known')!.bwikiStatus = 'review';
  assert.deepEqual(compareVerification(old, cached).lostVerification, ['known']);
});
