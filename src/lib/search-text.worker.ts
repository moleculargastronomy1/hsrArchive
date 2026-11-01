import {
  parseSearchManifest,
  parseSearchPart,
  textMatches,
  matchesOtherText,
  type OtherTextFilter,
  type SearchText,
  type SearchTextSource,
} from './search-text';
import { parseOtherCatalog } from './other-text';
import { parseLocalizations } from './localization';
import { searchableGameText } from './game-text';

interface Request {
  token: number;
  base: string;
  query: string;
  offset: number;
  limit: number;
  filter?: OtherTextFilter;
  chinese?: boolean;
}
const worker = self as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (value: unknown) => void;
};
let latest = 0;
let loading:
  | Promise<{ parts: SearchText[][]; sources: SearchTextSource[]; commit: string }>
  | undefined;
let cachedQuery: string | undefined;
let cachedFilter: OtherTextFilter | undefined;
let matches: SearchText[] = [];
let cachedChinese = false;
let cachedChineseError: string | undefined;
let chineseLoading:
  | { commit: string; controller: AbortController; rows: Promise<Map<string, string>> }
  | undefined;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadChinese(base: string, commit: string, signal: AbortSignal) {
  const get = async (file: string) => {
    const response = await fetch(`${base}search/locales/${file}`, { signal });
    if (!response.ok) throw Error('중국어 검색 자료를 불러오지 못했습니다.');
    return response;
  };
  const manifest = await (await get('manifest.json')).json();
  if (
    manifest.schema !== 'hsr-search-localizations.v1' ||
    manifest.commit !== commit ||
    !Array.isArray(manifest.parts)
  )
    throw Error('중국어 검색 자료의 버전이 다릅니다. 다시 시도해 주세요.');
  const rows = new Map<string, string>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < 32) {
        const index = cursor++,
          chapterId = `part-${String(index).padStart(2, '0')}`;
        const file = `zh-CN/search-text--${chapterId}.json`;
        const part = manifest.parts.find((item: { file: string }) => item.file === file);
        if (!part || !/^[a-f0-9]{64}$/.test(part.sha256))
          throw Error('중국어 검색 자료의 목록을 확인해 주세요.');
        const bytes = await (await get(file)).arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (hash !== part.sha256)
          throw Error('중국어 검색 자료가 갱신되었습니다. 다시 시도해 주세요.');
        const localized = parseLocalizations(
          JSON.parse(new TextDecoder().decode(bytes)),
          { entryId: 'search-text', chapterId },
          'zh-CN',
          commit,
        );
        if (localized.size !== part.rows) throw Error('중국어 검색 자료의 줄 수를 확인해 주세요.');
        for (const [id, row] of localized)
          rows.set(id, searchableGameText(`${row.speaker}\n${row.text}`).toLocaleLowerCase());
      }
    }),
  );
  return rows;
}

async function load(base: string) {
  const get = async (file: string) => {
    const response = await fetch(`${base}search/${file}`);
    if (!response.ok) throw new Error(`기타 텍스트를 불러오지 못했습니다 (${response.status}).`);
    return response;
  };
  const manifest = parseSearchManifest(await (await get('manifest.json')).json());
  const speakers: Record<string, { text: string; name: string }> = await get('other-catalog.json')
    .then((r) => r.json())
    .then((value) => {
      const catalog = parseOtherCatalog(value);
      return catalog.commit === manifest.commit ? catalog.speakers : {};
    })
    .catch(() => ({}));
  // Titles are optional: an unavailable or older title manifest must never hide text.
  const titles: Record<string, { title: string; text: string }> = await get('locales/manifest.json')
    .then((response) => response.json())
    .then((data) =>
      data.schema === 'hsr-search-localizations.v1' && data.commit === manifest.commit
        ? (data.titles ?? {})
        : {},
    )
    .catch(() => ({}));
  const parts: SearchText[][] = new Array(manifest.parts.length);
  let cursor = 0;
  // Bound peak parsing memory and keep the text corpus outside the UI thread.
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < manifest.parts.length) {
        const index = cursor++,
          part = manifest.parts[index];
        const bytes = await (await get(part.file)).arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (digest !== part.sha256)
          throw new Error('기타 텍스트가 갱신되었습니다. 다시 시도해 주세요.');
        parts[index] = parseSearchPart(
          JSON.parse(new TextDecoder().decode(bytes)),
          manifest.commit,
          part.rows,
          manifest.sources.length,
        );
        for (const row of parts[index]) {
          const title = titles[row[0]];
          if (title?.text === row[1] && typeof title.title === 'string' && title.title.trim())
            row[3] = title.title;
          const speaker = speakers[row[0]];
          if (speaker?.text === row[1]) row[4] = speaker.name;
        }
      }
    }),
  );
  return { parts, sources: manifest.sources, commit: manifest.commit };
}

worker.onmessage = async ({ data }) => {
  const { token, base, query, offset, limit, filter, chinese = false } = data;
  latest = token;
  if (!chinese) {
    chineseLoading?.controller.abort();
    chineseLoading = undefined;
  }
  try {
    loading ??= load(base).catch((error) => {
      loading = undefined;
      throw error;
    });
    const { parts, sources, commit } = await loading;
    if (latest !== token) return;
    let chineseRows: Map<string, string> | undefined;
    let chineseError: string | undefined;
    if (chinese) {
      if (chineseLoading?.commit !== commit) {
        const controller = new AbortController();
        chineseLoading = { commit, controller, rows: loadChinese(base, commit, controller.signal) };
      }
      const pending = chineseLoading;
      try {
        chineseRows = await pending.rows;
      } catch (error) {
        pending.controller.abort();
        if (chineseLoading === pending) chineseLoading = undefined;
        chineseError = error instanceof Error ? error.message : '중국어 검색에 실패했습니다.';
      }
    }
    if (latest !== token) return;
    if (
      query !== cachedQuery ||
      filter !== cachedFilter ||
      chinese !== cachedChinese ||
      chineseError !== cachedChineseError
    ) {
      const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      const result: SearchText[] = [];
      for (const part of parts) {
        for (let start = 0; start < part.length; start += 2000) {
          if (latest !== token) return;
          for (let index = start; index < Math.min(start + 2000, part.length); index++)
            if (
              (filter === undefined || matchesOtherText(part[index], sources, filter)) &&
              (!terms.length ||
                textMatches(part[index], terms, sources, chineseRows?.get(part[index][0])))
            )
              result.push(part[index]);
          await pause();
        }
      }
      matches = result;
      cachedQuery = query;
      cachedFilter = filter;
      cachedChinese = chinese;
      cachedChineseError = chineseError;
    }
    if (latest === token)
      worker.postMessage({
        token,
        count: matches.length,
        rows: matches.slice(offset, offset + limit),
        sources,
        commit,
        chineseError,
      });
  } catch (error) {
    if (latest === token)
      worker.postMessage({
        token,
        error: error instanceof Error ? error.message : '기타 텍스트를 불러오지 못했습니다.',
      });
  }
};
