import { searchableGameText } from './game-text.ts';
import type { DialogueRow } from './dialogue.ts';

export type SearchText = [hash: string, text: string, sourceIds: number[], title?: string];
export function searchTextRow(row: SearchText): DialogueRow {
  return {
    id: row[0],
    entryId: 'search-text',
    chapterId: `part-${String(BigInt(row[0]) % 32n).padStart(2, '0')}`,
    text: row[1],
    speaker: '',
    mission: '',
    scene: '',
    type: 'narration',
  };
}
export interface SearchTextSource {
  pageTitle: string;
  pageId: number;
  revision: number;
  kind: string;
  label: string;
}

export function searchSourceLabel(source: SearchTextSource) {
  // A BWIKI page title is internal evidence, never a Korean display fallback.
  return source.kind !== '로딩 화면' &&
    /[가-힣]/.test(source.label) &&
    !/[\u3400-\u9fff]/.test(source.label)
    ? source.label
    : '';
}

export const otherTextCategories = [
  { id: 'loading', label: '로딩 화면' },
  { id: 'npc', label: 'NPC 대사' },
  { id: 'interaction', label: '상호작용' },
  { id: 'message', label: '메시지' },
  { id: 'mail', label: '우편' },
] as const;
export type OtherTextCategory = (typeof otherTextCategories)[number]['id'];
export type OtherTextFilter = 'all' | OtherTextCategory;

export function otherTextFilter(value: string | null): OtherTextFilter {
  return otherTextCategories.find((category) => category.id === value)?.id ?? 'all';
}

export function searchScopePath(query = '', scope = 'all', kind: OtherTextFilter = 'all') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (['trailblaze', 'simulation', 'codex', 'books', 'other'].includes(scope))
    params.set('scope', scope);
  if (scope === 'other' && kind !== 'all') params.set('kind', kind);
  return '/search' + (params.size ? '?' + params.toString() : '');
}

export function matchesOtherText(
  row: SearchText,
  sources: SearchTextSource[],
  filter: OtherTextFilter,
) {
  const labels = otherTextCategories
    .filter((category) => filter === 'all' || category.id === filter)
    .map((category) => category.label as string);
  return row[2].some((id) => sources[id] && labels.includes(sources[id].kind));
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
    (row[3] ?? '') +
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
