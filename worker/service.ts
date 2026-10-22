import { choiceDialogue, nearbyDialogue, type DialogueRow } from '../src/lib/dialogue.ts';
import {
  isWikiReading,
  readingRows,
  positionKey,
  type WikiReading,
} from '../src/lib/wiki-reading.ts';
import { searchableGameText } from '../src/lib/game-text.ts';

export const PAGE_SIZE = 50;
export interface ChapterData {
  schema: string;
  rows: DialogueRow[];
  wikiReading?: WikiReading;
}
export interface DataStore {
  chapter(file: string): Promise<ChapterData>;
  search(
    query: string,
    scope: string,
    page: number,
  ): Promise<{ rows: DialogueRow[]; total: number }>;
  locale(
    file: string,
    language: string,
  ): Promise<Record<string, unknown> & { rows: { id: string }[] }>;
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const filePattern = /^content\/[A-Za-z0-9_-]+--[A-Za-z0-9_-]+\.json$/;
export function validFile(file: string) {
  if (!filePattern.test(file)) throw new HttpError(400, 'Invalid chapter');
  return file;
}
export function rendered(data: ChapterData) {
  if (
    data.schema !== 'hsr-dialogue.v1' ||
    !Array.isArray(data.rows) ||
    (data.wikiReading && !isWikiReading(data.wikiReading, data.rows))
  )
    throw new Error('Invalid private data');
  return readingRows(data.rows, data.wikiReading);
}
export function termsOf(q: string) {
  return q.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}
export function searchText(row: DialogueRow) {
  return `${row.bwikiMission ?? row.mission} ${row.scene} ${row.speaker} ${searchableGameText(row.text)}`.toLocaleLowerCase();
}
function pageNumber(v: string | null) {
  const n = Number(v ?? '1');
  if (!Number.isSafeInteger(n) || n < 1 || n > 100000) throw new HttpError(400, 'Invalid page');
  return n;
}
export function localeBatch(params: URLSearchParams): { file: string; ids: string[] }[] {
  let items: { file: string; ids: string[] }[];
  try {
    items = JSON.parse(params.get('items') ?? 'null');
  } catch {
    throw new HttpError(400, 'Invalid localization batch');
  }
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > 8 ||
    items.some((item) => !item || typeof item.file !== 'string' || !Array.isArray(item.ids)) ||
    items.reduce((n, item) => n + item.ids.length, 0) > 100
  )
    throw new HttpError(400, 'Localization batch too large');
  for (const item of items) validFile(item.file);
  return items;
}
// The response includes the selected rows, never the chapter-wide occurrence graph.
export async function serveData(route: string, params: URLSearchParams, store: DataStore) {
  const file = params.get('file') ?? '';
  const q = params.get('q') ?? '';
  if (q.length > 120 || termsOf(q).length > 8) throw new HttpError(400, 'Query too long');
  if (route === '/v1/search') {
    const scope = params.get('scope') ?? 'all';
    if (!['all', 'trailblaze', 'simulation', 'codex', 'books'].includes(scope))
      throw new HttpError(400, 'Invalid scope');
    const page = pageNumber(params.get('page'));
    const result = await store.search(q, scope, page);
    return { ...result, page, pageSize: PAGE_SIZE };
  }
  if (route === '/v1/locales') {
    const items = localeBatch(params);
    const results = [];
    for (const item of items)
      results.push(
        await serveData(
          '/v1/locale',
          new URLSearchParams({
            file: item.file,
            language: params.get('language') ?? '',
            ids: item.ids.join(','),
          }),
          store,
        ),
      );
    return { items: results };
  }
  validFile(file);
  if (route === '/v1/locale') {
    const language = params.get('language') ?? '';
    const ids = [...new Set((params.get('ids') ?? '').split(',').filter(Boolean))];
    if (
      !['en', 'zh-CN', 'ja'].includes(language) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => id.length > 240 || !/^[A-Za-z0-9_-]+$/.test(id))
    )
      throw new HttpError(400, 'Invalid localization request');
    const data = await store.locale(file, language);
    return {
      schema: data.schema,
      language,
      entryId: data.entryId,
      chapterId: data.chapterId,
      referenceCommit: data.referenceCommit,
      rows: data.rows.filter((r) => ids.includes(r.id)),
    };
  }
  const data = await store.chapter(file);
  const display = rendered(data);
  if (route === '/v1/page' || route === '/v1/record') {
    const row = params.get('dialogue');
    const occurrence = params.get('occurrence');
    const matches = display.filter((r) => termsOf(q).every((term) => searchText(r).includes(term)));
    let page = Math.min(
      pageNumber(params.get('page')),
      Math.max(1, Math.ceil(matches.length / PAGE_SIZE)),
    );
    if (row && !q) {
      let index = matches.findIndex(
        (r) => r.id === row && (!occurrence || r.wikiPosition?.id === occurrence),
      );
      if (index < 0) index = matches.findIndex((r) => r.id === row);
      if (index >= 0) page = Math.floor(index / PAGE_SIZE) + 1;
    }
    const variants = route === '/v1/record' && display.length && display.every((r) => r.variant);
    if (variants) {
      const selected = params.get('variant') ?? row;
      const record = display.find((r) => r.id === selected) ?? display[display.length - 1];
      return {
        rows: [record],
        total: display.length,
        page: 1,
        pageSize: PAGE_SIZE,
        variants: display.map((r) => ({ id: r.id, variant: r.variant })),
      };
    }
    return {
      rows: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total: matches.length,
      page,
      pageSize: PAGE_SIZE,
    };
  }
  if (route === '/v1/context') {
    const row = params.get('dialogue');
    const occurrence = params.get('occurrence');
    const existing = params.get('mode') === 'existing';
    const rows = existing ? data.rows : display;
    const index = rows.findIndex(
      (r) => r.id === row && (existing || !occurrence || r.wikiPosition?.id === occurrence),
    );
    if (index < 0) throw new HttpError(404, 'Dialogue not found');
    const selected = rows[index];
    const context = (selected.type === 'choice' ? choiceDialogue : nearbyDialogue)(rows, index);
    const parents =
      selected.wikiPosition && !existing
        ? selected.wikiPosition.replyToIds
        : (selected.bwikiReplyToIds ?? selected.replyToIds ?? []);
    const choices = rows.filter((r) =>
      parents.includes(selected.wikiPosition && !existing ? positionKey(r) : r.id),
    );
    const alternate =
      !!selected.wikiPosition &&
      !!selected.bwikiNextIds?.some(
        (id) =>
          !selected.wikiPosition!.nextIds.some(
            (key) => display.find((r) => positionKey(r) === key)?.id === id,
          ),
      );
    return { rows: context.slice(0, 41), choices: choices.slice(0, 20), alternate };
  }
  throw new HttpError(404, 'Not found');
}
