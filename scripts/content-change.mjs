import { sha256, fetchPlaylist } from './video-order.mjs';
import { REPOSITORY } from './upstream-content.mjs';
import { CHANNEL_ID, parseVideos } from './youtube-feed.mjs';

export const WATCH_URL = 'https://moleculargastronomy1.github.io/hsrArchive/content-watch.json';
const schema = 'hsr-content-watch.v1';
export const playlistFingerprint = (videos) =>
  sha256(JSON.stringify(videos.map(({ id, title }) => ({ id, title }))));
export const officialFingerprint = (videos) =>
  sha256(
    JSON.stringify(
      videos
        .slice(0, 5)
        .map(({ id, title, published, isShort }) => ({ id, title, published, isShort })),
    ),
  );

export function validSnapshot(value) {
  return (
    value?.schema === schema &&
    /^[a-f0-9]{40}$/.test(value.upstreamCommit ?? '') &&
    /^[a-f0-9]{64}$/.test(value.configHash ?? '') &&
    Array.isArray(value.wiki) &&
    value.wiki.length <= 2000 &&
    value.wiki.every(
      (item) =>
        typeof item.title === 'string' &&
        item.title.length > 0 &&
        typeof item.canonical === 'string' &&
        (item.revision === null || (Number.isSafeInteger(item.revision) && item.revision >= 0)),
    ) &&
    new Set(value.wiki.map((item) => item.title)).size === value.wiki.length &&
    Array.isArray(value.playlists) &&
    value.playlists.every(
      (item) => typeof item.id === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint ?? ''),
    ) &&
    /^[a-f0-9]{64}$/.test(value.officialFingerprint ?? '')
  );
}

export function makeSnapshot({ update, wiki, manifest, video, official, config, previous }) {
  if (
    wiki.commit !== update.commit ||
    video.commit !== update.commit ||
    manifest?.commit !== update.commit ||
    !Array.isArray(manifest.pages)
  )
    throw new Error('Mixed content watch inputs');
  const old = new Map(
    (validSnapshot(previous) ? previous.wiki : []).map((item) => [item.title, item]),
  );
  // A failed lookup never acknowledges a new revision. Recover known references
  // from the audit when there is no previously published watch snapshot.
  const references = new Map();
  for (const item of Object.values(wiki.sources)) {
    const current = references.get(item.page);
    if (!current || item.revision > current.revision)
      references.set(item.page, {
        title: item.page,
        canonical: item.page,
        revision: item.revision,
      });
  }
  const pages = manifest.pages.map((item) => {
    if (item.status === 'available')
      return { title: item.title, canonical: item.pageTitle, revision: item.revision };
    if (item.status === 'missing') return { title: item.title, canonical: item.title, revision: 0 };
    return (
      old.get(item.title) ??
      references.get(item.title) ?? { title: item.title, canonical: item.title, revision: null }
    );
  });
  const result = {
    schema,
    upstreamCommit: update.commit,
    configHash: sha256(JSON.stringify(config.sources)),
    wiki: [...new Map(pages.map((item) => [item.title, item])).values()].sort((a, b) =>
      a.title.localeCompare(b.title, 'zh'),
    ),
    playlists: config.sources.map((source) => {
      const catalog = video.sources.find((item) => item.id === source.id);
      if (!catalog) throw new Error('Missing video watch source');
      return { id: source.id, fingerprint: playlistFingerprint(catalog.videos) };
    }),
    officialFingerprint: officialFingerprint(official.recent),
  };
  if (!validSnapshot(result)) throw new Error('Invalid content watch snapshot');
  return result;
}

async function fetchJson(url, fetcher, headers) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30000), headers });
  if (!response.ok || !response.headers.get('content-type')?.includes('json'))
    throw new Error('Metadata unavailable');
  return response.json();
}

export async function probeWiki(
  previous,
  fetcher = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  observations,
) {
  let unavailable = false,
    changed = false;
  for (let start = 0; start < previous.length; start += 20) {
    if (start) await pause(1000);
    const batch = previous.slice(start, start + 20);
    const url = new URL('https://wiki.biligame.com/sr/api.php');
    url.search = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      rvprop: 'ids',
      redirects: '1',
      titles: batch.map((item) => item.title).join('|'),
      format: 'json',
      formatversion: '2',
      maxlag: '5',
    });
    let data;
    try {
      data = await fetchJson(url, fetcher, {
        'User-Agent': 'hsrArchive/0.1 (revision metadata check)',
      });
      if (data.error || data.continue || !Array.isArray(data.query?.pages))
        throw new Error('Incomplete revisions');
    } catch {
      // Stop on restrictions; do not amplify retries across the remaining batches.
      return 'unavailable';
    }
    const aliases = new Map(
      [...(data.query.normalized ?? []), ...(data.query.redirects ?? [])].map((item) => [
        item.from,
        item.to,
      ]),
    );
    for (const item of batch) {
      let canonical = item.title;
      const seen = new Set();
      while (aliases.has(canonical) && !seen.has(canonical)) {
        seen.add(canonical);
        canonical = aliases.get(canonical);
      }
      const page = data.query.pages.find((page) => page.title === canonical);
      const revision = page?.missing ? 0 : page?.revisions?.[0]?.revid;
      if (
        !page ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        (!page.missing && page.ns !== 0)
      ) {
        unavailable = true;
        continue;
      }
      observations?.push({ title: item.title, canonical, revision });
      if (revision !== item.revision || (revision > 0 && canonical !== item.canonical)) {
        if (!observations) return 'changed';
        changed = true;
      }
    }
  }
  return changed ? 'changed' : unavailable || !previous.length ? 'unavailable' : 'unchanged';
}

export async function observeUnfetchedWiki(snapshot, manifest, fetcher = fetch, pause) {
  const unavailable = new Set(
    manifest.pages.filter((item) => item.status === 'unavailable').map((item) => item.title),
  );
  const pending = snapshot.wiki.filter((item) => unavailable.has(item.title));
  if (!pending.length) return snapshot;
  const observations = [];
  await probeWiki(pending, fetcher, pause, observations);
  const byTitle = new Map(observations.map((item) => [item.title, item]));
  return {
    ...snapshot,
    wiki: snapshot.wiki.map((item) => {
      const observed = byTitle.get(item.title);
      // Observing a revision prevents repeated heavy processing. It does not
      // promote dialogue verification or claim that its content was fetched.
      return observed
        ? {
            ...observed,
            processedRevision: 'processedRevision' in item ? item.processedRevision : item.revision,
          }
        : item;
    }),
  };
}

export async function checkSources(
  previous,
  config,
  { fetcher = fetch, headers = {}, pause } = {},
) {
  if (!validSnapshot(previous))
    return { changed: true, checks: { snapshot: 'initial-deployment' } };
  const checks = {};
  if (previous.configHash !== sha256(JSON.stringify(config.sources)))
    return { changed: true, checks: { sources: 'changed' } };
  try {
    const latest = await fetchJson(
      `https://api.github.com/repos/${REPOSITORY}/commits/main`,
      fetcher,
      headers,
    );
    if (
      !/^[a-f0-9]{40}$/.test(latest.sha ?? '') ||
      !/^OSPRODWin\d+\.\d+\.\d+/.test(latest.commit?.message ?? '')
    )
      throw new Error('Unidentified release');
    checks.upstream = latest.sha === previous.upstreamCommit ? 'unchanged' : 'changed';
  } catch {
    checks.upstream = 'unavailable';
  }
  if (checks.upstream === 'changed') return { changed: true, checks };
  checks.bwiki = await probeWiki(previous.wiki, fetcher, pause);
  if (checks.bwiki === 'changed') return { changed: true, checks };
  for (const source of config.sources) {
    try {
      const videos = await fetchPlaylist(source, fetcher);
      checks[source.id] =
        playlistFingerprint(videos) ===
        previous.playlists.find((item) => item.id === source.id)?.fingerprint
          ? 'unchanged'
          : 'changed';
    } catch {
      checks[source.id] = 'unavailable';
    }
  }
  try {
    const response = await fetcher(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw new Error('Official feed unavailable');
    const videos = parseVideos(await response.text());
    if (!videos.length) throw new Error('Empty official feed');
    checks.official =
      officialFingerprint(videos) === previous.officialFingerprint ? 'unchanged' : 'changed';
  } catch {
    checks.official = 'unavailable';
  }
  return { changed: Object.values(checks).includes('changed'), checks };
}

export async function readPublishedSnapshot(fetcher = fetch) {
  const response = await fetcher(WATCH_URL, {
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('Published content state unavailable');
  const value = await response.json();
  if (!validSnapshot(value)) throw new Error('Invalid published content state');
  return value;
}
