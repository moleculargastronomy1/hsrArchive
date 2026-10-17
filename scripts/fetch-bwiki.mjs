import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from './verification-state.mjs';
import { failedPage } from './verification-retry.mjs';
import { BWIKI_LICENSE, fetchBwikiLegacy } from './fetch-bwiki-legacy.mjs';
export { BWIKI_LICENSE };

export async function fetchBwiki(stage, cache, fetcher = fetch, options = {}) {
  const request = JSON.parse(await fs.readFile(path.join(stage, '.cache/bwiki/request.json')));
  if (request.schema !== 'hsr-bwiki-request.v1' || !/^[a-f0-9]{40}$/.test(request.commit))
    throw new Error('Invalid BWIKI request');
  const now = options.now ?? Date.now(),
    pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const state = options.state ?? { pages: {} },
    algorithm = options.algorithm ?? 'manual';
  let index = {},
    blocked = Date.parse(state.nextRequestAt ?? '') > now,
    downloads = 0;
  const results = [],
    observations = [];
  await fs.mkdir(cache, { recursive: true });
  try {
    index = JSON.parse(await fs.readFile(path.join(cache, 'index.json')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const page of options.previousAudit?.pages ?? [])
    if (page.status === 'available' && !index[page.title]) index[page.title] = page;
  const failure = (item, reason, attempted = true, retryAfter) => {
    if (attempted)
      state.pages[item.title] = failedPage(state.pages[item.title], reason, now, retryAfter);
    return {
      ...item,
      status: 'unavailable',
      reason,
      nextRetryAt: state.pages[item.title]?.nextRetryAt,
    };
  };
  const stop = (reason, retryAfter) => {
    blocked = true;
    const failed = failedPage({ failures: state.requestFailures ?? 0 }, reason, now, retryAfter);
    Object.assign(state, {
      requestFailures: failed.failures,
      nextRequestAt: failed.nextRetryAt,
      lastRequestError: reason,
    });
  };
  const cached = async (item) => {
    const old = index[item.title];
    if (!/^[a-f0-9]{64}$/.test(old?.sha256 ?? '')) return undefined;
    const file = path.resolve(cache, old.sha256 + '.wiki');
    try {
      if (hash(await fs.readFile(file)) !== old.sha256) return undefined;
    } catch {
      return undefined;
    }
    return {
      ...Object.fromEntries(
        ['pageTitle', 'pageId', 'revision', 'timestamp', 'collectedAt', 'sha256']
          .filter((key) => old[key] !== undefined)
          .map((key) => [key, old[key]]),
      ),
      ...item,
      status: 'available',
      file,
      retrieval: 'cache-pinned',
    };
  };
  for (let start = 0; start < request.requests.length; start += 20) {
    const batch = request.requests.slice(start, start + 20);
    let metadata, errorReason;
    if (!blocked) {
      if (start) await pause(1200);
      try {
        const url = new URL('https://wiki.biligame.com/sr/api.php');
        url.search = new URLSearchParams({
          action: 'query',
          prop: 'revisions',
          rvprop: 'ids|timestamp',
          redirects: '1',
          titles: batch.map((item) => item.title).join('|'),
          format: 'json',
          formatversion: '2',
          maxlag: '5',
        });
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(45000),
          headers: { 'User-Agent': 'hsrArchive/0.2 (revision cache)' },
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
          stop('BWIKI HTTP ' + response.status, response.headers.get('retry-after'));
          throw new Error(state.lastRequestError);
        }
        metadata = await response.json();
        if (metadata.error || metadata.continue || !Array.isArray(metadata.query?.pages)) {
          stop(
            metadata.error?.code === 'maxlag' ? 'BWIKI maxlag' : 'BWIKI 수정 번호 응답 불완전',
            response.headers.get('retry-after'),
          );
          throw new Error(state.lastRequestError);
        }
      } catch (error) {
        errorReason = error.message;
        metadata = undefined;
        if (!blocked) stop(errorReason);
      }
    }
    const aliases = new Map(
      [...(metadata?.query.normalized ?? []), ...(metadata?.query.redirects ?? [])].map((item) => [
        item.from,
        item.to,
      ]),
    );
    const pending = [];
    for (const item of batch) {
      const old = await cached(item);
      let canonical = item.title;
      const seen = new Set();
      while (aliases.has(canonical) && !seen.has(canonical)) {
        seen.add(canonical);
        canonical = aliases.get(canonical);
      }
      const page = metadata?.query.pages.find((page) => page.title === canonical),
        revision = page?.revisions?.[0];
      const key = `${request.commit}:${algorithm}:${revision?.revid ?? old?.revision ?? 0}`;
      const observed = page?.missing ? 0 : revision?.revid;
      if (
        page &&
        (page.missing || page.ns === 0) &&
        Number.isSafeInteger(observed) &&
        observed >= 0
      )
        observations.push({ title: item.title, canonical, revision: observed });
      if (!metadata) {
        if (errorReason) failure(item, errorReason, true);
        // Replay an old pinned revision only for an improved algorithm; the
        // collection timestamp and source revision stay those of the old copy.
        if (
          old &&
          options.algorithm &&
          (options.forceAlignment || state.pages[item.title]?.aligned !== key)
        )
          results.push({ ...old, needsAlignment: true, alignmentKey: key });
        else results.push(failure(item, errorReason ?? 'BWIKI 요청 대기 · 이전 검증 보존', false));
      } else if (page?.missing) {
        state.pages[item.title] = failedPage(state.pages[item.title], 'BWIKI 임무 문서 없음', now);
        results.push({ ...item, status: 'missing', reason: 'BWIKI 임무 문서 없음' });
      } else if (
        !page ||
        page.ns !== 0 ||
        !Number.isSafeInteger(revision?.revid) ||
        revision.revid <= 0 ||
        Number.isNaN(Date.parse(revision.timestamp))
      )
        results.push(failure(item, 'BWIKI 수정 번호 확인 실패'));
      else if (old?.revision === revision.revid && old.pageTitle === canonical)
        results.push({
          ...old,
          retrieval: 'revision-cache',
          metadataCheckedAt: new Date(now).toISOString(),
          needsAlignment: Boolean(
            options.forceAlignment || state.pages[item.title]?.aligned !== key,
          ),
          alignmentKey: key,
        });
      else if (
        Date.parse(state.pages[item.title]?.nextRetryAt ?? '') > now &&
        state.pages[item.title]?.attemptedRevision === revision.revid
      )
        results.push(failure(item, 'BWIKI 본문 재시도 대기', false));
      else if (downloads >= (options.maxDownloads ?? Infinity))
        results.push(failure(item, '실행당 본문 조회 한도 · 다음 주기 재검토'));
      else {
        pending.push({ ...item, alignmentKey: key, expectedRevision: revision.revid });
        downloads++;
      }
    }
    if (!pending.length || blocked) continue;
    await pause(1200);
    const scratch = path.join(cache, 'request-stage');
    await fs.mkdir(path.join(scratch, '.cache/bwiki'), { recursive: true });
    await fs.writeFile(
      path.join(scratch, '.cache/bwiki/request.json'),
      JSON.stringify({ ...request, requests: pending }),
    );
    let bodyFailure;
    const body = await fetchBwikiLegacy(scratch, cache, async (...args) => {
      try {
        const response = await fetcher(...args);
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
          stop('BWIKI HTTP ' + response.status, response.headers.get('retry-after'));
          bodyFailure = state.lastRequestError;
        } else {
          const data = await response
            .clone()
            .json()
            .catch(() => ({}));
          if (data.error) {
            stop('BWIKI ' + (data.error.code ?? 'API error'), response.headers.get('retry-after'));
            bodyFailure = state.lastRequestError;
          }
        }
        return response;
      } catch (error) {
        stop('BWIKI 본문 연결 실패');
        bodyFailure = state.lastRequestError;
        throw error;
      }
    });
    for (const page of body.pages) {
      if (page.status !== 'available' || page.revision !== page.expectedRevision) {
        const item = failure(page, bodyFailure ?? 'BWIKI 본문 누락 또는 수집 중 수정');
        state.pages[page.title].attemptedRevision = page.expectedRevision;
        results.push(item);
      } else {
        const record = { ...page, retrieval: 'download', needsAlignment: true };
        index[page.title] = record;
        results.push(record);
      }
    }
    if (!blocked) {
      state.requestFailures = 0;
      delete state.nextRequestAt;
      delete state.lastRequestError;
    }
  }
  await fs.writeFile(path.join(cache, 'index.json'), JSON.stringify(index));
  const manifest = {
    schema: 'hsr-bwiki-input.v1',
    commit: request.commit,
    checkedAt: new Date(now).toISOString(),
    license: BWIKI_LICENSE,
    pages: results,
    observations,
    review: request.review,
  };
  await fs.writeFile(path.join(stage, '.cache/bwiki/manifest.json'), JSON.stringify(manifest));
  console.log(
    `BWIKI: ${results.filter((item) => item.status === 'available').length}/${results.length} available; ${downloads} body downloads selected`,
  );
  return manifest;
}
