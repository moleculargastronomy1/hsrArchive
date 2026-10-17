import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { algorithmHash, videoAlgorithmHash } from '../scripts/verification-retry.mjs';
import {
  checkSources,
  makeSnapshot,
  officialFingerprint,
  playlistFingerprint,
  probeWiki,
  readPublishedSnapshot,
  validSnapshot,
  observeUnfetchedWiki,
  watchBaseline,
  watchObservation,
  contentRefreshDecision,
} from '../scripts/content-change.mjs';
import { sha256 } from '../scripts/video-order.mjs';
import { CHANNEL_ID } from '../scripts/youtube-feed.mjs';

const commit = 'a'.repeat(40);
const source = {
  id: 'story',
  channelId: 'UC' + 'x'.repeat(22),
  playlistId: 'list',
  playlistUrl: 'https://www.youtube.com/playlist?list=list',
};
const config = { sources: [source] };
const videos = [{ id: '12345678901', title: '플레이' }];
const official = [
  { id: 'abcdefghijk', title: '공식', published: '2026-10-17T00:00:00Z', isShort: false },
];
const snapshot = () => ({
  schema: 'hsr-content-watch.v1',
  upstreamCommit: commit,
  configHash: sha256(JSON.stringify(config.sources)),
  wiki: [{ title: '별', canonical: '별', revision: 7 }],
  playlists: [{ id: source.id, fingerprint: playlistFingerprint(videos) }],
  officialFingerprint: officialFingerprint(official),
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const feed = `<feed><yt:channelId>${CHANNEL_ID}</yt:channelId><entry><yt:videoId>abcdefghijk</yt:videoId><title>공식</title><published>2026-10-17T00:00:00Z</published></entry></feed>`;
const fetcher = async (input: string | URL) => {
  const url = new URL(input);
  if (url.hostname === 'api.github.com')
    return json({ sha: commit, commit: { message: 'OSPRODWin4.6.0' } });
  if (url.hostname === 'wiki.biligame.com') {
    assert.equal(url.searchParams.get('rvprop'), 'ids');
    assert.equal(url.searchParams.has('rvslots'), false);
    return json({ query: { pages: [{ title: '별', ns: 0, revisions: [{ revid: 7 }] }] } });
  }
  if (url.pathname === '/playlist')
    return new Response(
      source.channelId +
        ' var ytInitialData = ' +
        JSON.stringify({
          metadata: { playlistMetadataRenderer: { title: '스토리' } },
          contents: {
            playlistVideoRenderer: {
              videoId: videos[0].id,
              title: { runs: [{ text: videos[0].title }] },
            },
          },
        }) +
        ';',
    );
  if (url.pathname === '/feeds/videos.xml') return new Response(feed);
  throw new Error('Unexpected metadata request');
};

test('failed publication cannot acknowledge metadata changes with an unchanged dialogue digest', async () => {
  const published = snapshot();
  published.officialFingerprint = '0'.repeat(64);
  const candidate = snapshot();
  const cached = watchObservation(published, candidate, { mode: 'full', changed: false });
  assert.equal(cached.publishRequired, true);
  const baseline = watchBaseline(published, cached);
  const result = await checkSources(baseline, config, { fetcher });
  assert.equal(result.checks.official, 'changed');
  assert.equal(result.changed, true);
  assert.deepEqual(watchBaseline(published, candidate), published); // Legacy cache is unacknowledged.
  assert.deepEqual(
    watchBaseline(
      published,
      watchObservation(published, candidate, { mode: 'retry', changed: true }),
    ),
    published,
  );
  assert.deepEqual(
    watchBaseline(published, watchObservation(published, candidate, undefined)),
    published,
  );
});

test('no-improvement observations reuse only BWIKI metadata against the exact published baseline', () => {
  const published = snapshot(),
    observed = structuredClone(published);
  observed.wiki[0].revision = 8;
  observed.officialFingerprint = '0'.repeat(64);
  observed.playlists = [];
  const cached = watchObservation(published, observed, { mode: 'retry', changed: false });
  const baseline = watchBaseline(published, cached);
  assert.deepEqual(baseline, { ...published, wiki: observed.wiki });
  const newer = { ...published, officialFingerprint: '1'.repeat(64) };
  assert.deepEqual(watchBaseline(newer, cached), newer);
});

test('video-only code replay stays independent, while unpublished improvements rebuild through all gates', () => {
  const sources = { changed: false, checks: { official: 'unchanged' } };
  const wiki = { needed: false, reason: 'unchanged-processed-inputs' },
    video = { needed: true, reason: 'video-algorithm-changed' };
  const replay = contentRefreshDecision(sources, wiki, video);
  assert.equal(replay.mode, 'retry');
  assert.equal(replay.retryBwiki, false);
  assert.equal(replay.retryVideo, true);
  const unpublished = contentRefreshDecision(
    sources,
    wiki,
    { needed: false, reason: 'backoff' },
    true,
  );
  assert.equal(unpublished.changed, true);
  assert.equal(unpublished.mode, 'full');
  assert.equal(unpublished.checks.publication, 'retry-unpublished-result');
  assert.equal(
    contentRefreshDecision(sources, wiki, { needed: false, reason: 'backoff' }).changed,
    false,
  );
});

test('actual scheduled command retries failed metadata publication even when the dialogue digest is unchanged', async () => {
  const parent = path.resolve('.cache/tests');
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'watch-publication-'));
  const write = async (file, value) => {
    const target = path.join(folder, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(value));
  };
  try {
    await fs.cp('scripts', path.join(folder, 'scripts'), { recursive: true });
    const algorithm = await algorithmHash(folder),
      videoAlgorithm = await videoAlgorithmHash(folder);
    const noPlaylists = { schema: 'hsr-video-sources.v1', sources: [] };
    await write('editorial/video-verification-sources.json', noPlaylists);
    const current = {
      ...snapshot(),
      configHash: sha256(JSON.stringify([])),
      wiki: [],
      playlists: [],
    };
    const old = { ...current, officialFingerprint: '0'.repeat(64) };
    for (const [published, cached, changed] of [
      [old, current, true],
      [old, watchObservation(old, current, { mode: 'full', changed: false }), true],
      [current, watchObservation(old, current, { mode: 'full', changed: false }), false],
    ]) {
      await write('.cache/verification-retry/watch.json', cached);
      await write('.cache/verification-retry/state.json', {
        schema: 'hsr-verification-retry.v1',
        pages: {},
        algorithm,
        videoAlgorithm,
        pendingDigest: 'same-dialogue-digest',
      });
      const mock = path.join(folder, 'mock-network.mjs');
      await fs.writeFile(
        mock,
        `
        const json = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
        globalThis.fetch = async input => {
          const url = new URL(input);
          if (url.pathname.endsWith('/verification-progress.json')) return json({digest:'same-dialogue-digest', algorithm:${JSON.stringify(algorithm)}});
          if (url.pathname.endsWith('/video-order-provenance.json')) return json({algorithm:${JSON.stringify(videoAlgorithm)}, chapters:{}, checks:{}});
          if (url.pathname.endsWith('/content-watch.json')) return json(${JSON.stringify(published)});
          if (url.hostname === 'api.github.com') return json({sha:${JSON.stringify(commit)}, commit:{message:'OSPRODWin4.6.0'}});
          if (url.pathname === '/feeds/videos.xml') return new Response(${JSON.stringify(feed)});
          throw new Error('Unexpected network request');
        };
      `,
      );
      execFileSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(mock).href,
          path.resolve('scripts/check-content-changes.mjs'),
          '--check',
        ],
        {
          cwd: folder,
          stdio: 'pipe',
          env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
        },
      );
      const result = JSON.parse(
        await fs.readFile(path.join(folder, '.cache/content-watch/check.json')),
      );
      assert.equal(result.changed, changed);
      assert.equal(result.checks.official, changed ? 'changed' : 'unchanged');
      if (changed) assert.equal(result.mode, 'full');
    }
  } finally {
    assert.ok(folder.startsWith(parent + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('unchanged source metadata skips full processing; release changes trigger without downloading raw text', async () => {
  assert.equal(validSnapshot(snapshot()), true);
  const unchanged = await checkSources(snapshot(), config, { fetcher });
  assert.equal(unchanged.changed, false);
  assert.ok(Object.values(unchanged.checks).every((status) => status === 'unchanged'));
  let requests = 0;
  const changed = await checkSources(snapshot(), config, {
    fetcher: async (input) => {
      requests++;
      assert.equal(new URL(input).hostname, 'api.github.com');
      return json({ sha: 'b'.repeat(40), commit: { message: 'OSPRODWin4.7.0' } });
    },
  });
  assert.equal(changed.changed, true);
  assert.equal(requests, 1);
});

test('YouTube-only retries preserve the last successful BWIKI watch revisions', () => {
  const previous = snapshot();
  const next = makeSnapshot({
    update: { commit },
    wiki: { commit, sources: {} },
    manifest: { commit, pages: [], observations: [], targetSources: ['youtube'] },
    video: { commit, sources: [{ id: source.id, videos }] },
    official: { recent: official },
    config,
    previous,
  });
  assert.deepEqual(next.wiki, previous.wiki);
  assert.equal(validSnapshot(next), true);
});

test('BWIKI revision and redirect changes trigger independently; restrictions stop batch requests', async () => {
  assert.equal(
    await probeWiki(snapshot().wiki, async () =>
      json({ query: { pages: [{ title: '별', ns: 0, revisions: [{ revid: 8 }] }] } }),
    ),
    'changed',
  );
  assert.equal(
    await probeWiki(snapshot().wiki, async () =>
      json({
        query: {
          redirects: [{ from: '별', to: '새 별' }],
          pages: [{ title: '새 별', ns: 0, revisions: [{ revid: 7 }] }],
        },
      }),
    ),
    'changed',
  );
  assert.equal(
    await probeWiki(snapshot().wiki, async () =>
      json({ query: { pages: [{ title: '별', missing: true }] } }),
    ),
    'changed',
  );
  let requests = 0;
  const many = Array.from({ length: 45 }, (_, i) => ({
    title: String(i),
    canonical: String(i),
    revision: 1,
  }));
  assert.equal(
    await probeWiki(
      many,
      async () => {
        requests++;
        return new Response('', { status: 403 });
      },
      async () => {},
    ),
    'unavailable',
  );
  assert.equal(requests, 1);
});

test('playlist and official feed updates trigger even when the release and BWIKI are unchanged', async () => {
  for (const key of ['playlists', 'officialFingerprint']) {
    const previous = snapshot();
    if (key === 'playlists') previous.playlists[0].fingerprint = '0'.repeat(64);
    else previous.officialFingerprint = '0'.repeat(64);
    assert.equal((await checkSources(previous, config, { fetcher })).changed, true);
  }
  assert.equal(
    playlistFingerprint(videos),
    playlistFingerprint([{ ...videos[0], checkedAt: 'ignored' }]),
  );
});

test('failed lookups are unavailable rather than unchanged, and cannot acknowledge or erase prior revisions', async () => {
  const result = await checkSources(snapshot(), config, {
    fetcher: async () => new Response('', { status: 503 }),
  });
  assert.equal(result.changed, false);
  assert.ok(Object.values(result.checks).every((status) => status === 'unavailable'));
  const recorded = makeSnapshot({
    update: { commit },
    wiki: { commit, sources: {} },
    manifest: { commit, pages: [{ title: '별', status: 'unavailable', revision: 100 }] },
    video: { commit, sources: [{ id: source.id, videos }] },
    official: { recent: official },
    config,
    previous: snapshot(),
  });
  assert.equal(recorded.wiki[0].revision, 7);
  assert.throws(() =>
    makeSnapshot({
      update: { commit },
      wiki: { commit: 'b'.repeat(40) },
      manifest: {},
      video: {},
      official: {},
      config,
    }),
  );
});

test('only absent initial state bootstraps a build; unreadable published state waits for a later check', async () => {
  assert.equal((await checkSources(undefined, config)).changed, true);
  assert.equal(
    await readPublishedSnapshot(async () => new Response('', { status: 404 })),
    undefined,
  );
  await assert.rejects(readPublishedSnapshot(async () => new Response('', { status: 503 })));
  await assert.rejects(readPublishedSnapshot(async () => json({ schema: 'wrong' })));
});

test('metadata-only observations stop repeated processing without promoting the fetched content revision', async () => {
  const prior = snapshot();
  const manifest = { pages: [{ title: '별', status: 'unavailable' }] };
  const current = async () =>
    json({ query: { pages: [{ title: '별', ns: 0, revisions: [{ revid: 8 }] }] } });
  const observed = await observeUnfetchedWiki(prior, manifest, current);
  assert.equal(observed.wiki[0].revision, 8);
  assert.equal(observed.wiki[0].processedRevision, 7);
  assert.equal(prior.wiki[0].revision, 7);
  assert.equal(await probeWiki(observed.wiki, current), 'unchanged');
  const again = await observeUnfetchedWiki(observed, manifest, current);
  assert.equal(again.wiki[0].processedRevision, 7);
  const restricted = await observeUnfetchedWiki(
    prior,
    manifest,
    async () => new Response('', { status: 403 }),
  );
  assert.equal(restricted.wiki[0].revision, 7);
  const recorded = makeSnapshot({
    update: { commit },
    wiki: { commit, sources: {} },
    manifest: {
      commit,
      pages: [{ title: '별', status: 'unavailable' }],
      observations: [{ title: '별', canonical: '별', revision: 8 }],
    },
    video: { commit, sources: [{ id: source.id, videos }] },
    official: { recent: official },
    config,
    previous: prior,
  });
  assert.equal(recorded.wiki[0].revision, 8);
  assert.equal(recorded.wiki[0].processedRevision, 7);
});
