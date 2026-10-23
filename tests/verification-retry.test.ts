import { compareVerification, baselineChoice } from '../scripts/verification-integration.mjs';
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
  algorithmHash,
  videoAlgorithmHash,
  recoverVerificationProgress,
  recordWorkflowProgress,
} from '../scripts/verification-retry.mjs';
import { fetchBwiki } from '../scripts/fetch-bwiki.mjs';
import { finishVerification } from '../scripts/reverify-content.mjs';

const commit = 'a'.repeat(40);

test('workflow journals preserve checkpoints and distinguish failed candidates from publication', async (t) => {
  const root = await fs.mkdtemp(path.resolve('.cache/journal-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const put = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify(value));
  };
  await put('.cache/source-first/progress.json', {
    runId: 'previous',
    status: 'running',
    registeredChapters: 36,
    chapters: [{ file: 'chapter', title: '임무|제목', candidateAdditions: 2 }],
    pendingChapters: ['next'],
    codeHash: 'hash',
    policyVersion: 4,
  });
  await put('.cache/verification-retry/run.json', { status: 'failed', newlyVerified: 0 });
  await put('.cache/verification-retry/state.json', {
    pendingDigest: 'unpublished',
    pages: { page: { reason: 'retry', nextRetryAt: 'tomorrow' } },
  });
  const summary = path.join(root, 'summary.md');
  const result = await recordWorkflowProgress(root, {
    GITHUB_RUN_ID: 'current',
    HSR_JOB_STATUS: 'failure',
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_SHA: commit,
  });
  assert.equal(result.pipelineStatus, 'failure');
  assert.equal(result.audit.currentRun, false);
  assert.equal(result.audit.processedChapters, 1);
  assert.deepEqual(result.audit.pendingChapters, ['next']);
  assert.equal(result.retry.pendingDigest, 'unpublished');
  assert.equal(result.publicationStatus.includes('not-publication-approval'), true);
  assert.match(await fs.readFile(summary, 'utf8'), /임무 제목/);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(root, '.cache/verification-retry/workflow-progress.json')),
    ).runId,
    'current',
  );
  await fs.rm(path.join(root, '.cache/source-first/progress.json'));
  await put('.cache/verification-retry/run.json', {
    status: 'unchanged',
    sourceAudit: {
      status: 'validated-publication-checkpoint',
      registeredChapters: 36,
      chapters: [{ file: 'chapter', title: '보존된 장' }],
      pendingChapters: [],
    },
  });
  const recovered = await recordWorkflowProgress(root, {
    GITHUB_RUN_ID: 'next',
    HSR_JOB_STATUS: 'success',
  });
  assert.equal(recovered.audit.processedChapters, 1);
  assert.equal(recovered.audit.currentRun, false);
  assert.equal(recovered.audit.chapters[0].title, '보존된 장');
});
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

test('BWIKI and video code changes have independent replay fingerprints, with shared safety rules in both', async () => {
  const folder = await temporary();
  try {
    await fs.cp('scripts', path.join(folder, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(folder, 'editorial'), { recursive: true });
    await fs.copyFile(
      'editorial/source-first-policy.json',
      path.join(folder, 'editorial/source-first-policy.json'),
    );
    const initialWiki = await algorithmHash(folder),
      initialVideo = await videoAlgorithmHash(folder);
    await fs.appendFile(path.join(folder, 'editorial/source-first-policy.json'), '\n');
    assert.notEqual(await algorithmHash(folder), initialWiki);
    await fs.copyFile(
      'editorial/source-first-policy.json',
      path.join(folder, 'editorial/source-first-policy.json'),
    );
    await fs.appendFile(path.join(folder, 'scripts/video-order.mjs'), '\n// video-only edit\n');
    assert.equal(await algorithmHash(folder), initialWiki);
    assert.notEqual(await videoAlgorithmHash(folder), initialVideo);
    const editedVideo = await videoAlgorithmHash(folder);
    await fs.appendFile(path.join(folder, 'scripts/bwiki-dialogue.py'), '\n# wiki-only edit\n');
    assert.notEqual(await algorithmHash(folder), initialWiki);
    assert.equal(await videoAlgorithmHash(folder), editedVideo);
    const editedWiki = await algorithmHash(folder);
    await fs.appendFile(
      path.join(folder, 'scripts/bwiki-placement.py'),
      '\n# context placement edit\n',
    );
    assert.notEqual(await algorithmHash(folder), editedWiki);
    assert.equal(await videoAlgorithmHash(folder), editedVideo);
    await fs.mkdir(path.join(folder, 'editorial'), { recursive: true });
    await fs.writeFile(
      path.join(folder, 'editorial/bwiki-translation-matches.json'),
      '{"reviews":[]}',
    );
    const reviewedWiki = await algorithmHash(folder);
    assert.notEqual(reviewedWiki, editedWiki);
    await fs.writeFile(
      path.join(folder, 'editorial/bwiki-translation-matches.json'),
      '{"reviews":[{}]}',
    );
    assert.notEqual(await algorithmHash(folder), reviewedWiki);
    await fs.appendFile(
      path.join(folder, 'scripts/verification-integration.mjs'),
      '\n// shared safety edit\n',
    );
    assert.notEqual(await algorithmHash(folder), editedWiki);
    assert.notEqual(await videoAlgorithmHash(folder), editedVideo);
  } finally {
    await cleanup(folder);
  }
});

test('a video-only run preserves the unexecuted BWIKI algorithm and the newest video retry state', async () => {
  const folder = await temporary();
  try {
    await fs.mkdir(path.join(folder, 'public/content'), { recursive: true });
    await fs.mkdir(path.join(folder, '.cache/verification-retry'), { recursive: true });
    await fs.writeFile(
      path.join(folder, 'public/content/entry--chapter.json'),
      JSON.stringify({ schema: 'hsr-dialogue.v1', rows: [{ id: 'row', text: '원문' }] }),
    );
    await fs.writeFile(
      path.join(folder, 'public/bwiki-provenance.json'),
      JSON.stringify({ review: [], imports: {} }),
    );
    await fs.writeFile(
      path.join(folder, 'public/video-order-provenance.json'),
      JSON.stringify({ retry: { examined: 0, due: [] } }),
    );
    await fs.writeFile(
      path.join(folder, '.cache/verification-retry/state.json'),
      JSON.stringify({
        schema: 'hsr-verification-retry.v1',
        pages: {},
        videoAlgorithm: 'video-new',
        videoChecks: { video: { checkedAt: '2026-10-18T00:00:00Z' } },
      }),
    );
    const before = new Map([
      ['row', { id: 'row', text: '원문', file: 'content/entry--chapter.json' }],
    ]);
    const state = { pages: {}, algorithm: 'wiki-old' };
    const result = await finishVerification(
      folder,
      before,
      { commit, pages: [], targetSources: ['youtube'] },
      state,
      'wiki-new',
      'retry',
    );
    assert.equal(result.algorithm, 'wiki-old');
    assert.equal(result.videoAlgorithm, 'video-new');
    assert.equal(result.changed, false);
    const saved = JSON.parse(
      await fs.readFile(path.join(folder, '.cache/verification-retry/state.json')),
    );
    assert.equal(saved.videoChecks.video.checkedAt, '2026-10-18T00:00:00Z');
  } finally {
    await cleanup(folder);
  }
});

test('published snapshots preserve exact integer bytes and validate every path/checksum before restoring', async () => {
  const root = await temporary();
  try {
    await fs.mkdir(path.join(root, 'src/data'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/content'), { recursive: true });
    const exact = '{"hash":18446744073709551615}';
    await fs.writeFile(path.join(root, 'src/data/trailblaze.json'), exact);
    await fs.writeFile(path.join(root, 'public/content-update.json'), JSON.stringify({ commit }));
    const progress = JSON.stringify({
      status: 'partial',
      quarantinedChapters: [{ file: 'content/held.json' }],
    });
    await fs.writeFile(path.join(root, 'public/verification-progress.json'), progress);
    const descriptor = await packState(root);
    const bytes = await fs.readFile(path.join(root, 'public', descriptor.file));
    assert.equal(
      unpackState(bytes, descriptor)
        .find((item) => item.path === 'src/data/trailblaze.json')
        ?.bytes.toString(),
      exact,
    );
    assert.equal(
      unpackState(bytes, descriptor)
        .find((item) => item.path === 'public/verification-progress.json')
        ?.bytes.toString(),
      progress,
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

test('snapshot records restore legacy JSON and reject incomplete or duplicated v2 records', () => {
  const exact = '{"hash":18446744073709551615}';
  const record = {
    path: 'src/data/trailblaze.json',
    bytes: Buffer.from(exact).toString('base64'),
    sha256: hash(exact),
  };
  const read = (text, count = 1) => {
    const bytes = gzipSync(text),
      sha256 = hash(bytes);
    return unpackState(bytes, {
      schema: 'hsr-verification-state-pointer.v1',
      commit,
      files: count,
      sha256,
      file: `verification-state-${sha256}.json.gz`,
    });
  };
  assert.equal(
    read(
      JSON.stringify({ schema: 'hsr-verification-state.v1', commit, files: [record] }, null, 2),
    )[0].bytes.toString(),
    exact,
  );
  const header = JSON.stringify({ schema: 'hsr-verification-state.v2', commit, files: 1 }) + '\n';
  assert.equal(read(header + JSON.stringify(record) + '\n')[0].bytes.toString(), exact);
  assert.throws(() => read(header));
  assert.throws(() => read(header + JSON.stringify(record)));
  assert.throws(() => read(header + JSON.stringify(record) + '\n' + JSON.stringify(record) + '\n'));
  assert.throws(() => read(header + JSON.stringify({ ...record, sha256: hash('changed') }) + '\n'));
});

test('legacy journal recovery only acknowledges the exact published content digest', () => {
  const state = {
    pendingDigest: 'published',
    lastRun: {
      digest: 'published',
      status: 'partial',
      quarantinedChapters: [{ file: 'content/held.json' }],
    },
    pages: { held: { reason: 'verification-regression; candidate-quarantined' } },
  };
  const recovered = recoverVerificationProgress(state, 'published');
  assert.equal(recovered.status, 'partial');
  assert.deepEqual(recovered.retry.pages, state.pages);
  assert.deepEqual(recovered.quarantinedChapters, state.lastRun.quarantinedChapters);
  assert.deepEqual(
    recoverVerificationProgress({ ...state, pendingDigest: undefined }, 'published'),
    recovered,
  );
  assert.equal(recoverVerificationProgress(state, 'different-content'), undefined);
  assert.equal(
    recoverVerificationProgress({ ...state, pendingDigest: 'unpublished-candidate' }, 'published'),
    undefined,
  );
  assert.equal(
    recoverVerificationProgress({ ...state, lastRun: undefined }, 'published'),
    undefined,
  );
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
    const delayedOptions: any = { state: { pages: {} }, now };
    await fetchBwiki(
      root,
      path.join(root, 'cache'),
      async () => {
        delayedOptions.now += HOUR;
        return new Response('', { status: 429, headers: { 'retry-after': '86400' } });
      },
      delayedOptions,
    );
    assert.equal(Date.parse(delayedOptions.state.nextRequestAt), now + 25 * HOUR);
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
  const deleted = new Map([['unknown', old.get('unknown')!]]);
  assert.deepEqual(compareVerification(old, deleted).lostVerification, ['known']);
  assert.deepEqual(compareVerification(old, deleted).removedRows, ['known']);
  assert.deepEqual(compareVerification(old, new Map([['known', old.get('known')!]])).removedRows, [
    'unknown',
  ]);
  const altered = new Map(
    [...old].map(([id, row]) => [id, { ...row, text: id === 'known' ? '임의 수정' : row.text }]),
  );
  assert.deepEqual(compareVerification(old, altered).changedCoreRows, ['known']);
});
