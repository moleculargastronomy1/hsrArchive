import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchBwiki } from './fetch-bwiki.mjs';

// Search-only collection; never writes chapter rows, attribution or reading order.
const root = path.resolve(process.argv[3] ?? process.cwd());
const target = path.resolve(process.argv[2] ?? root);
const cache = path.join(root, '.cache/upstream-content/search-bwiki');
const stage = path.join(target, '.cache/search-sources');
await fs.mkdir(path.join(stage, '.cache/bwiki'), { recursive: true });
const plan = JSON.parse(
  await fs.readFile(process.argv[4] ?? path.join(root, '.cache/upstream-content/plan.json')),
);
const stateFile = path.join(root, '.cache/verification-retry/search-sources.json');
const state = JSON.parse(await fs.readFile(stateFile).catch(() => '{"pages":{}}'));
const requests = new Map([
  ['过场提示', { title: '过场提示', searchKind: '로딩 화면' }],
  ['互动文本', { title: '互动文本', searchKind: '상호작용' }],
]);
const categories = [
  ['NPC', 'NPC 대사'],
  ['交互事件', '상호작용'],
  ['短信', '메시지'],
  ['邮件', '우편'],
  ['光锥', '광추'],
  ['遗器', '유물'],
  ['阅读物', '서적'],
];
const review = [];
let blocked = Date.parse(state.nextRequestAt ?? '') > Date.now();
async function listing(parameters) {
  if (blocked) throw Error('BWIKI 조회 대기');
  const url = new URL('https://wiki.biligame.com/sr/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    maxlag: '5',
    ...parameters,
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
    blocked = true;
    state.nextRequestAt = new Date(Date.now() + 6 * 3600000).toISOString();
    state.lastRequestError = 'BWIKI 검색 출처 목록 조회 실패: ' + response.status;
    throw Error('BWIKI 목록 조회 실패: ' + response.status);
  }
  const data = await response.json();
  if (data.error || !data.query) throw Error('BWIKI 목록 응답 불완전');
  return data;
}
for (const [category, searchKind] of categories) {
  try {
    let continuation;
    do {
      const data = await listing({
        list: 'categorymembers',
        cmtitle: 'Category:' + category,
        cmlimit: '500',
        cmnamespace: '0',
        ...continuation,
      });
      for (const page of data.query.categorymembers)
        requests.set(page.title, { title: page.title, searchKind });
      continuation = data.continue;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    } while (continuation);
  } catch (error) {
    review.push({ category, reason: error.message });
  }
}
try {
  let continuation;
  do {
    const data = await listing({
      list: 'allpages',
      apprefix: '互动文本',
      aplimit: '500',
      ...continuation,
    });
    for (const page of data.query.allpages)
      requests.set(page.title, { title: page.title, searchKind: '상호작용' });
    continuation = data.continue;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  } while (continuation);
} catch (error) {
  review.push({ prefix: '互动文本', reason: error.message });
}
// Also use the existing revision-pinned mission/event corpus without new downloads.
const index = JSON.parse(
  await fs.readFile(path.join(root, '.cache/upstream-content/bwiki/index.json')).catch(() => '{}'),
);
// Keep discovered targets when listing is temporarily unavailable on later runs.
const previous = JSON.parse(
  await fs.readFile(path.join(root, 'public/search/manifest.json')).catch(() => '{}'),
);
for (const item of previous.pendingPages ?? [])
  if (!requests.has(item.title)) requests.set(item.title, item);
for (const item of previous.sources ?? [])
  if (!requests.has(item.pageTitle))
    requests.set(item.pageTitle, { title: item.pageTitle, searchKind: item.kind });
const all = [...requests.values()];
all.sort(
  (a, b) =>
    (Date.parse(state.pages[a.title]?.lastAttempt ?? '') || 0) -
    (Date.parse(state.pages[b.title]?.lastAttempt ?? '') || 0),
);
const selected = all
  .filter((p) => !(Date.parse(state.pages[p.title]?.nextRetryAt ?? '') > Date.now()))
  .slice(0, 40);
await fs.writeFile(
  path.join(stage, '.cache/bwiki/request.json'),
  JSON.stringify({
    schema: 'hsr-bwiki-request.v1',
    commit: plan.commit,
    requests: selected,
    review,
  }),
);
const manifest = await fetchBwiki(stage, cache, fetch, {
  state,
  algorithm: 'search-source-v1',
  maxDownloads: 20,
});
for (const page of manifest.pages) {
  if (page.status === 'available')
    state.pages[page.title] = {
      ...state.pages[page.title],
      aligned: `${plan.commit}:search-source-v1:${page.revision}`,
      lastAttempt: new Date().toISOString(),
      nextRetryAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    };
}
for (const page of all)
  if (!selected.some((p) => p.title === page.title))
    manifest.pages.push({
      ...page,
      status: 'unavailable',
      reason: '검색 출처 조회 한도 또는 재시도 대기',
    });
const searchIndex = JSON.parse(await fs.readFile(path.join(cache, 'index.json')).catch(() => '{}'));
for (const [title, page] of Object.entries(searchIndex)) {
  if (!manifest.pages.some((p) => p.title === title && p.status === 'available'))
    manifest.pages.push({
      ...page,
      title,
      status: 'available',
      file: path.join(cache, page.sha256 + '.wiki'),
    });
}
state.nextReviewAt = new Date(
  Date.now() + (all.length > selected.length ? 6 : 24) * 3600000,
).toISOString();
await fs.mkdir(path.dirname(stateFile), { recursive: true });
await fs.writeFile(stateFile, JSON.stringify(state));
for (const [title, page] of Object.entries(index)) {
  if (!requests.has(title) && /^[a-f0-9]{64}$/.test(page.sha256 ?? ''))
    manifest.pages.push({
      ...page,
      title,
      searchKind: '관련 문서',
      status: 'available',
      file: path.join(root, '.cache/upstream-content/bwiki', page.sha256 + '.wiki'),
    });
}
await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
console.log(
  `Search sources: ${requests.size} requested; ${manifest.pages.length} snapshots; ${review.length} discovery failures`,
);
