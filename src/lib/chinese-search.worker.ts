import { parseChineseSearch } from './chinese-search';

let latest = 0;
let loaded: { hash: string; rows: Promise<Map<string, string>> } | undefined;
self.onmessage = async ({
  data,
}: MessageEvent<{ token: number; base: string; query: string; hash: string }>) => {
  const { token, base, query, hash } = data;
  latest = token;
  try {
    if (loaded?.hash !== hash)
      loaded = {
        hash,
        rows: fetch(`${base}content/locales/chinese-search.json?v=${hash}`)
          .then(async (response) => {
            if (!response.ok) throw Error('중국어 검색 자료를 불러오지 못했습니다.');
            return parseChineseSearch(await response.json(), hash);
          })
          .catch((error) => {
            loaded = undefined;
            throw error;
          }),
      };
    const rows = await loaded.rows;
    const terms = [...new Set(query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean))];
    const matches: [string, string[]][] = [];
    const entries = [...rows];
    for (let start = 0; start < entries.length; start += 2000) {
      if (token !== latest) return;
      for (const [id, text] of entries.slice(start, start + 2000)) {
        const found = terms.filter((term) => text.includes(term));
        if (found.length) matches.push([id, found]);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token === latest) self.postMessage({ token, matches });
  } catch (error) {
    if (token === latest)
      self.postMessage({
        token,
        error: error instanceof Error ? error.message : '중국어 검색에 실패했습니다.',
      });
  }
};
