import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const BWIKI_LICENSE = {
  name: 'CC BY-NC-SA 4.0',
  url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  attribution: '崩坏：星穹铁道 BWIKI contributors',
};

export async function fetchBwiki(stage, cache, fetcher = fetch) {
  const request = JSON.parse(await fs.readFile(path.join(stage, '.cache/bwiki/request.json')));
  if (request.schema !== 'hsr-bwiki-request.v1' || !/^[a-f0-9]{40}$/.test(request.commit))
    throw new Error('Invalid BWIKI request');
  const results = [];
  let restricted = false;
  await fs.mkdir(cache, { recursive: true });
  // Batch public API requests and keep one request in flight to avoid burdening the wiki.
  for (let start = 0; start < request.requests.length; start += 20) {
    const batch = request.requests.slice(start, start + 20);
    if (restricted) {
      results.push(
        ...batch.map((item) => ({
          ...item,
          status: 'unavailable',
          reason: 'BWIKI 접근 제한 · 기존 자료 유지',
        })),
      );
      continue;
    }
    if (start > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    let response;
    try {
      const parameters = {
        action: 'query',
        prop: 'revisions',
        rvprop: 'ids|timestamp|content',
        rvslots: 'main',
        redirects: '1',
        titles: batch.map((item) => item.title).join('|'),
        format: 'json',
        formatversion: '2',
        maxlag: '5',
      };
      const pages = new Map(),
        normalized = [],
        redirects = [];
      let continuation;
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        if (pageNumber) await new Promise((resolve) => setTimeout(resolve, 1000));
        const url = new URL('https://wiki.biligame.com/sr/api.php');
        url.search = new URLSearchParams({ ...parameters, ...continuation });
        const fetched = await fetcher(url, {
          signal: AbortSignal.timeout(45000),
          headers: {
            'User-Agent': 'hsrArchive/0.1 (BWIKI dialogue reference; public archive)',
          },
        });
        if (
          [403, 429].includes(fetched.status) ||
          !fetched.headers.get('content-type')?.includes('json')
        ) {
          restricted = true;
          throw new Error('BWIKI access restricted');
        }
        if (!fetched.ok) throw new Error('BWIKI HTTP ' + fetched.status);
        const part = await fetched.json();
        if (part.error || !Array.isArray(part.query?.pages))
          throw new Error('Incomplete BWIKI response');
        for (const page of part.query.pages) {
          const previous = pages.get(page.title);
          if (
            previous?.revisions?.[0] &&
            page.revisions?.[0] &&
            previous.revisions[0].revid !== page.revisions[0].revid
          )
            throw new Error('BWIKI page changed during continuation');
          if (!previous?.revisions?.length || page.revisions?.length) pages.set(page.title, page);
        }
        normalized.push(...(part.query.normalized ?? []));
        redirects.push(...(part.query.redirects ?? []));
        continuation = part.continue;
        if (!continuation) break;
      }
      if (continuation) throw new Error('Incomplete BWIKI continuation');
      response = {
        query: { pages: [...pages.values()], normalized, redirects },
      };
    } catch {
      results.push(
        ...batch.map((item) => ({
          ...item,
          status: 'unavailable',
          reason: 'BWIKI 조회 실패 · 기존 자료 유지',
        })),
      );
      continue;
    }
    const aliases = new Map(
      [...(response.query.normalized ?? []), ...(response.query.redirects ?? [])].map((item) => [
        item.from,
        item.to,
      ]),
    );
    for (const item of batch) {
      let title = item.title;
      const seen = new Set();
      while (aliases.has(title) && !seen.has(title)) {
        seen.add(title);
        title = aliases.get(title);
      }
      const page = response.query.pages.find((page) => page.title === title);
      const revision = page?.revisions?.[0];
      const content = revision?.slots?.main?.content;
      if (
        !page ||
        page.missing ||
        page.ns !== 0 ||
        typeof content !== 'string' ||
        !Number.isSafeInteger(revision?.revid) ||
        revision.revid <= 0 ||
        Number.isNaN(Date.parse(revision.timestamp))
      ) {
        results.push({
          ...item,
          status: 'missing',
          reason: 'BWIKI 임무 문서 없음',
        });
        continue;
      }
      const bytes = Buffer.from(content, 'utf8');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const target = path.join(cache, sha256 + '.wiki');
      await fs.writeFile(target, bytes);
      results.push({
        ...item,
        status: 'available',
        pageTitle: page.title,
        pageId: page.pageid,
        revision: revision.revid,
        timestamp: revision.timestamp,
        sha256,
        file: path.resolve(target),
      });
    }
  }
  const manifest = {
    schema: 'hsr-bwiki-input.v1',
    commit: request.commit,
    checkedAt: new Date().toISOString(),
    license: BWIKI_LICENSE,
    pages: results,
    review: request.review,
  };
  await fs.writeFile(path.join(stage, '.cache/bwiki/manifest.json'), JSON.stringify(manifest));
  console.log(
    `BWIKI: ${results.filter((item) => item.status === 'available').length}/${results.length} mission pages available`,
  );
  return manifest;
}
