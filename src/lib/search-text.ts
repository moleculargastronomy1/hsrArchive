import { searchableGameText } from './game-text.ts';

export type SearchText = [hash: string, text: string, sourceIds: number[]];
export interface SearchTextSource {
  pageTitle: string;
  pageId: number;
  revision: number;
  kind: string;
  label: string;
}
export interface SearchTextManifest {
  schema: 'hsr-search-text.v1';
  commit: string;
  rows: number;
  parts: { file: string; rows: number; sha256: string }[];
  sources: SearchTextSource[];
}

export function parseSearchManifest(value: unknown): SearchTextManifest {
  const data = value as SearchTextManifest;
  if (
    data?.schema !== 'hsr-search-text.v1' ||
    !/^[a-f0-9]{40}$/.test(data.commit) ||
    !Number.isSafeInteger(data.rows) ||
    data.rows < 0 ||
    !Array.isArray(data.parts) ||
    data.parts.length !== 32 ||
    data.parts.some(
      (part, index) =>
        part.file !== `part-${String(index).padStart(2, '0')}.json` ||
        !Number.isSafeInteger(part.rows) ||
        part.rows < 0 ||
        !/^[a-f0-9]{64}$/.test(part.sha256),
    ) ||
    data.parts.reduce((sum, part) => sum + part.rows, 0) !== data.rows ||
    !Array.isArray(data.sources) ||
    data.sources.some(
      (source) =>
        !source ||
        typeof source.pageTitle !== 'string' ||
        !source.pageTitle ||
        typeof source.kind !== 'string' ||
        typeof source.label !== 'string' ||
        !Number.isSafeInteger(source.pageId) ||
        source.pageId <= 0 ||
        !Number.isSafeInteger(source.revision) ||
        source.revision <= 0,
    )
  )
    throw new Error('기타 텍스트의 자료 형식을 확인해 주세요.');
  return data;
}

export function parseSearchPart(
  value: unknown,
  commit: string,
  count: number,
  sources = 0,
): SearchText[] {
  const data = value as { schema: string; commit: string; rows: SearchText[] };
  if (
    data?.schema !== 'hsr-search-text-part.v1' ||
    data.commit !== commit ||
    !Array.isArray(data.rows) ||
    data.rows.length !== count ||
    data.rows.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== 3 ||
        typeof row[0] !== 'string' ||
        !/^\d+$/.test(row[0]) ||
        typeof row[1] !== 'string' ||
        !row[1].trim() ||
        !Array.isArray(row[2]) ||
        row[2].some((id) => !Number.isSafeInteger(id) || id < 0 || id >= sources),
    )
  )
    throw new Error('기타 텍스트의 본문을 확인해 주세요.');
  return data.rows;
}

export function textMatches(row: SearchText, terms: string[], sources: SearchTextSource[] = []) {
  const text = (
    searchableGameText(row[1]) +
    ' ' +
    row[2]
      .map((id) =>
        sources[id] ? `${sources[id].kind} ${sources[id].label} ${sources[id].pageTitle}` : '',
      )
      .join(' ')
  ).toLocaleLowerCase();
  return terms.every((term) => text.includes(term) || row[0].includes(term));
}

export function searchTextWindow(curatedCount: number, page: number, size = 50) {
  const start = (page - 1) * size;
  return {
    offset: Math.max(0, start - curatedCount),
    limit: size - Math.max(0, Math.min(size, curatedCount - start)),
  };
}
