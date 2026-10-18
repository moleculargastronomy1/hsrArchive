import fs from 'node:fs/promises';
import path from 'node:path';
import { failedPage } from './verification-retry.mjs';

export function validEventImage(item) {
  try {
    const url = new URL(item.url),
      source = new URL(item.sourceUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'patchwiki.biligame.com' &&
      source.protocol === 'https:' &&
      source.hostname === 'wiki.biligame.com' &&
      /^[a-f0-9]{40}$/.test(item.sha1) &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(item.mime) &&
      Number.isSafeInteger(item.width) &&
      item.width > 0 &&
      Number.isSafeInteger(item.height) &&
      item.height > 0
    );
  } catch {
    return false;
  }
}

const titleKey = (value) => value.normalize('NFKC').replace(/[·•∙\s]/g, '');

// Collect references, not copyrighted image binaries. A file must be explicitly
// listed on the event page and resolve to one unique event image in MediaWiki.
export async function collectEventImages(stage, cache, manifest, state, options = {}) {
  const fetcher = options.fetcher ?? fetch,
    now = options.now ?? Date.now();
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const file = path.join(cache, 'event-images.json');
  const known = JSON.parse(
    await fs.readFile(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '{}';
    }),
  );
  const pages = manifest.pages.filter(
    (page) =>
      page.eventFiles?.length &&
      (!manifest.targetFiles ||
        page.eventFiles.some((file) => manifest.targetFiles.includes(file))),
  );
  const result = {},
    review = [];
  let blocked = Date.parse(state.nextRequestAt ?? '') > now,
    checked = 0;
  async function query(parameters) {
    await pause(1200);
    const url = new URL('https://wiki.biligame.com/sr/api.php');
    url.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      maxlag: '5',
      ...parameters,
    });
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(45000),
      headers: { 'User-Agent': 'hsrArchive/0.3 (event image attribution metadata)' },
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
      const failure = failedPage(
        { failures: state.requestFailures ?? 0 },
        'BWIKI image HTTP ' + response.status,
        now,
        response.headers.get('retry-after'),
      );
      state.requestFailures = failure.failures;
      state.nextRequestAt = failure.nextRetryAt;
      state.lastRequestError = failure.reason;
      blocked = true;
      throw new Error(failure.reason);
    }
    const data = await response.json();
    if (data.error) throw new Error('BWIKI image API ' + (data.error.code ?? 'error'));
    if (data.error || data.continue || !Array.isArray(data.query?.pages))
      throw new Error('사건 이미지 메타데이터 미확인');
    return data.query.pages;
  }
  for (const page of pages) {
    const previous = known[page.title];
    if (validEventImage(previous)) result[page.title] = previous;
    if (blocked || checked >= (options.maxPages ?? 20) || page.status !== 'available') {
      review.push({
        page: page.title,
        reason: blocked ? 'BWIKI 접근 대기 · 기존 이미지 유지' : '다음 이미지 재검토 주기 대기',
      });
      continue;
    }
    if (
      validEventImage(previous) &&
      previous.revision === page.revision &&
      now - Date.parse(previous.checkedAt) < 24 * 3600000
    )
      continue;
    checked++;
    try {
      const associated = await query({
        prop: 'images',
        titles: page.pageTitle,
        imlimit: 'max',
        redirects: '1',
      });
      const article = associated.find((item) => item.ns === 0 && item.pageid === page.pageId);
      const matches = (article?.images ?? []).filter((item) => {
        const name = item.title
          .replace(/^(?:文件|File|图像):/, '')
          .replace(/\.(?:png|jpe?g|webp)$/i, '');
        return [page.title, page.pageTitle].some(
          (title) => titleKey(name) === titleKey('模拟宇宙事件-' + title),
        );
      });
      if (matches.length !== 1) throw new Error('대표 사건 이미지 없음 또는 복수 후보');
      const files = await query({
        prop: 'imageinfo',
        titles: matches[0].title,
        iiprop: 'url|size|sha1|mime',
        redirects: '1',
      });
      const imageFile = files.find((item) => item.ns === 6 && item.imageinfo?.length === 1);
      const info = imageFile?.imageinfo?.[0];
      const item = {
        url: info?.url,
        sourceUrl: info?.descriptionurl,
        sha1: info?.sha1,
        mime: info?.mime,
        width: info?.width,
        height: info?.height,
        fileTitle: imageFile?.title,
        page: page.pageTitle,
        revision: page.revision,
        checkedAt: new Date(now).toISOString(),
      };
      if (!validEventImage(item)) throw new Error('사건 이미지 주소·형식 검증 실패');
      result[page.title] = known[page.title] = item;
    } catch (error) {
      review.push({ page: page.title, reason: error.message });
      // Transport/API failures also back off; a known absent image is reviewed
      // with its event, without deleting the previous successful reference.
      if (!blocked && /fetch|timeout|BWIKI|메타데이터 미확인/i.test(error.message)) {
        const failure = failedPage({ failures: state.requestFailures ?? 0 }, error.message, now);
        Object.assign(state, {
          requestFailures: failure.failures,
          nextRequestAt: failure.nextRetryAt,
          lastRequestError: failure.reason,
        });
        blocked = true;
      }
    }
  }
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(file, JSON.stringify(known));
  Object.assign(manifest, { eventImages: result, eventImageReview: review });
  await fs.writeFile(path.join(stage, '.cache/bwiki/manifest.json'), JSON.stringify(manifest));
  return { checked, linked: Object.keys(result).length, review };
}
