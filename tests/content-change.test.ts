import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSources,
  makeSnapshot,
  officialFingerprint,
  playlistFingerprint,
  probeWiki,
  readPublishedSnapshot,
  validSnapshot,
  observeUnfetchedWiki,
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
