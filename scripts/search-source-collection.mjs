import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchBwiki } from './fetch-bwiki.mjs';

const kinds = ['NPC 대사', '상호작용', '메시지', '우편', '로딩 화면'];
const roots = [
  ['过场提示', '로딩 화면'],
  ['互动文本', '상호작용'],
  ['短信', '메시지'],
  ['邮件', '우편'],
];
export const searchDiscoveryQueries = [
  {
    key: 'message-content',
    kind: '메시지',
    parameters: {
      list: 'embeddedin',
      eititle: 'Template:短信内容',
      einamespace: '0',
      eilimit: '500',
    },
  },
  ...[
    ['NPC', 'NPC 대사'],
    ['交互事件', '상호작용'],
    ['短信', '메시지'],
    ['邮件', '우편'],
  ].map(([category, kind]) => ({
    key: 'category:' + category,
    kind,
    parameters: {
      list: 'categorymembers',
      cmtitle: 'Category:' + category,
      cmnamespace: '0',
      cmlimit: '500',
    },
  })),
  ...[
    ['互动文本', '상호작용'],
    ['短信/', '메시지'],
  ].map(([prefix, kind]) => ({
    key: 'prefix:' + prefix,
    kind,
    parameters: { list: 'allpages', apprefix: prefix, aplimit: '500' },
  })),
];

export function selectSearchRequests(requests, state, now, limit = 40) {
  const due = requests.filter(
    (p) => !(Date.parse(state.pages?.[p.title]?.nextRetryAt ?? '') > now),
  );
  due.sort(
    (a, b) =>
      (Date.parse(state.pages?.[a.title]?.lastAttempt ?? '') || 0) -
      (Date.parse(state.pages?.[b.title]?.lastAttempt ?? '') || 0),
  );
  const selected = [];
  const buckets = kinds.map((kind) => due.filter((p) => p.searchKind === kind));
  while (selected.length < limit && buckets.some((b) => b.length))
    for (const bucket of buckets)
      if (bucket.length && selected.length < limit) selected.push(bucket.shift());
  return selected;
}

export async function collectSearchSources(target, root, planFile, options = {}) {
  const now = options.now ?? Date.now(),
    fetcher = options.fetcher ?? fetch;
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const read = async (file, fallback) =>
    JSON.parse(
      await fs.readFile(file).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return JSON.stringify(fallback);
      }),
    );
  const cache = path.join(root, '.cache/upstream-content/search-bwiki');
  const stage = path.join(target, '.cache/search-sources');
  await fs.mkdir(path.join(stage, '.cache/bwiki'), { recursive: true });
  const plan = await read(planFile);
  const stateFile = path.join(root, '.cache/verification-retry/search-sources.json');
  const state = await read(stateFile, { pages: {} });
  state.pages ??= {};
  state.discovery ??= { cursor: 0, queries: {} };
  state.discovery.queries ??= {};
  const previous = await read(path.join(root, 'public/search/manifest.json'), {});
  const requests = new Map(roots.map(([title, searchKind]) => [title, { title, searchKind }]));
  for (const p of previous.pendingPages ?? []) if (!requests.has(p.title)) requests.set(p.title, p);
  for (const p of previous.sources ?? [])
    if (!requests.has(p.pageTitle))
      requests.set(p.pageTitle, { title: p.pageTitle, searchKind: p.kind });
  const cachedIndex = await read(path.join(cache, 'index.json'), {});
  for (const [title, p] of Object.entries(cachedIndex))
    if (!requests.has(title) && p.searchKind)
      requests.set(title, { title, searchKind: p.searchKind });
  const review = [];
  const cacheOnly = options.cacheOnly ?? process.env.HSR_SEARCH_CACHE_ONLY === '1';
  const selected = selectSearchRequests([...requests.values()], state, now);
  await fs.writeFile(
    path.join(stage, '.cache/bwiki/request.json'),
    JSON.stringify({
      schema: 'hsr-bwiki-request.v1',
      commit: plan.commit,
      requests: cacheOnly ? [] : selected,
      review,
    }),
  );
  // Known bodies come first: a failed category listing must not cancel them.
  const manifest = await fetchBwiki(stage, cache, fetcher, {
    state,
    algorithm: 'search-source-v2',
    maxDownloads: 20,
    now,
    pause,
  });
  for (const p of manifest.pages)
    if (p.status === 'available')
      state.pages[p.title] = {
        ...state.pages[p.title],
        aligned: `${plan.commit}:search-source-v2:${p.revision}`,
        lastAttempt: new Date(now).toISOString(),
        nextRetryAt: new Date(now + 24 * 3600000).toISOString(),
      };
  // Persist body evidence before optional bounded discovery.
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state));
  let attemptedDiscovery = 0;
  const started = Date.now();
  if (!cacheOnly && !(Date.parse(state.nextRequestAt ?? '') > now)) {
    const initialCursor = state.discovery.cursor;
    for (let offset = 0; offset < Math.min(4, searchDiscoveryQueries.length); offset++) {
      if (Date.now() - started > 12000) break;
      const index = (initialCursor + offset) % searchDiscoveryQueries.length;
      const query = searchDiscoveryQueries[index];
      state.discovery.cursor = (index + 1) % searchDiscoveryQueries.length;
      const old = state.discovery.queries[query.key] ?? {};
      if (Date.parse(old.nextRequestAt ?? '') > now) continue;
      attemptedDiscovery++;
      try {
        const url = new URL('https://wiki.biligame.com/sr/api.php');
        url.search = new URLSearchParams({
          action: 'query',
          format: 'json',
          formatversion: '2',
          maxlag: '5',
          ...query.parameters,
          ...old.continuation,
        });
        const response = await fetcher(url, { signal: AbortSignal.timeout(12000) });
        if (!response.ok || !response.headers.get('content-type')?.includes('json'))
          throw Error('BWIKI 목록 조회 실패: ' + response.status);
        const data = await response.json();
        const pages = data.query?.[query.parameters.list];
        if (data.error || !Array.isArray(pages)) throw Error('BWIKI 목록 응답 불완전');
        for (const p of pages) requests.set(p.title, { title: p.title, searchKind: query.kind });
        state.discovery.queries[query.key] = {
          checkedAt: new Date(now).toISOString(),
          continuation: data.continue,
          nextRequestAt: new Date(now + (data.continue ? 6 : 24) * 3600000).toISOString(),
        };
        await pause(1200);
      } catch (error) {
        review.push({ discovery: query.key, reason: error.message });
        state.discovery.queries[query.key] = {
          ...old,
          reason: error.message,
          nextRequestAt: new Date(now + 6 * 3600000).toISOString(),
        };
        state.nextRequestAt = new Date(now + 6 * 3600000).toISOString();
        state.lastRequestError = error.message;
        break; // Respect host backoff; never loop through alternate endpoints.
      }
    }
  }
  const downloaded = await read(path.join(cache, 'index.json'), {});
  for (const [title, p] of Object.entries(downloaded)) {
    if (manifest.pages.some((page) => page.title === title && page.status === 'available'))
      continue;
    manifest.pages.push({
      ...p,
      title,
      searchKind: requests.get(title)?.searchKind ?? p.searchKind ?? '관련 문서',
      status: 'available',
      file: path.join(cache, p.sha256 + '.wiki'),
    });
  }
  for (const p of requests.values())
    if (!manifest.pages.some((page) => page.title === p.title))
      manifest.pages.push({
        ...p,
        status: 'unavailable',
        reason: state.lastRequestError ?? '검색 출처 조회 한도 또는 재시도 대기',
      });
  const canonical = await read(path.join(root, '.cache/upstream-content/bwiki/index.json'), {});
  for (const [title, p] of Object.entries(canonical))
    if (!requests.has(title) && /^[a-f0-9]{64}$/.test(p.sha256 ?? ''))
      manifest.pages.push({
        ...p,
        title,
        searchKind: '관련 문서',
        status: 'available',
        file: path.join(root, '.cache/upstream-content/bwiki', p.sha256 + '.wiki'),
      });
  if (!cacheOnly) state.nextReviewAt = new Date(now + 6 * 3600000).toISOString();
  state.lastCollection = {
    checkedAt: new Date(now).toISOString(),
    selected: cacheOnly ? 0 : selected.length,
    available: manifest.pages.filter(
      (p) => p.status === 'available' && kinds.includes(p.searchKind),
    ).length,
    pending: manifest.pages.filter((p) => p.status !== 'available').length,
    discoveryRequests: attemptedDiscovery,
    cacheOnly,
    lastRequestError: state.lastRequestError,
  };
  manifest.review = review;
  await fs.writeFile(stateFile, JSON.stringify(state));
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
  console.log('Search collection: ' + JSON.stringify(state.lastCollection));
  return manifest;
}
