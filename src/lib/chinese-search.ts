import { searchableGameText } from './game-text.ts';

export function chineseSearchEnabled(languages: readonly string[], query: string) {
  return languages.includes('zh-CN') && /\p{Script=Han}/u.test(query);
}

export function parseChineseSearch(value: unknown, corpusSha256: string) {
  const data = value as {
    schema?: string;
    language?: string;
    corpusSha256?: string;
    rows?: unknown;
  };
  if (
    data?.schema !== 'hsr-chinese-search.v1' ||
    data.language !== 'zh-CN' ||
    data.corpusSha256 !== corpusSha256 ||
    !Array.isArray(data.rows)
  )
    throw Error('중국어 검색 자료가 갱신되었습니다. 다시 시도해 주세요.');
  const rows = new Map<string, string>();
  for (const row of data.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== 'string' ||
      typeof row[1] !== 'string' ||
      rows.has(row[0])
    )
      throw Error('중국어 검색 자료 형식을 확인해 주세요.');
    rows.set(row[0], searchableGameText(row[1]).toLocaleLowerCase());
  }
  return rows;
}

export function matchesBilingualTerms(
  korean: string,
  terms: string[],
  chinese?: ReadonlySet<string>,
) {
  return terms.every((term) => korean.includes(term) || chinese?.has(term));
}
