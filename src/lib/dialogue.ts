import { wikiContext, type WikiPosition } from './wiki-reading.ts';

export interface DialogueRow {
  id: string;
  entryId: string;
  chapterId: string;
  mission: string;
  scene: string;
  speaker: string;
  text: string;
  type: 'dialogue' | 'choice' | 'narration';
  source?: string;
  variant?: string;
  nextIds?: string[];
  replyToIds?: string[];
  flowStatus?: 'verified' | 'review';
  flowScene?: string;
  flowBoundary?: boolean;
  bwikiStatus?: 'matched' | 'cached' | 'review';
  bwikiScene?: string;
  bwikiNextIds?: string[];
  bwikiReplyToIds?: string[];
  bwikiPage?: string;
  bwikiRevision?: number;
  bwikiMissionId?: string;
  bwikiMission?: string;
  bwikiMatchMethod?: 'translation-reviewed';
  videoStatus?: 'caption-matched' | 'screen-matched';
  videoScene?: string;
  videoNextIds?: string[];
  videoReplyToIds?: string[];
  wikiPosition?: WikiPosition;
  wikiUnplaced?: { id: string; title: string };
  wikiLegacy?: { id: string; title: string };
}

export function isDialogueRows(value: unknown): value is DialogueRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        row &&
        typeof row === 'object' &&
        ['id', 'entryId', 'chapterId', 'mission', 'scene', 'speaker', 'text'].every(
          (key) => typeof row[key] === 'string',
        ) &&
        ['dialogue', 'choice', 'narration'].includes(row.type) &&
        (row.variant === undefined || typeof row.variant === 'string') &&
        (row.flowStatus === undefined || ['verified', 'review'].includes(row.flowStatus)) &&
        (row.flowScene === undefined || typeof row.flowScene === 'string') &&
        (row.flowBoundary === undefined || typeof row.flowBoundary === 'boolean') &&
        (row.bwikiStatus === undefined ||
          ['matched', 'cached', 'review'].includes(row.bwikiStatus)) &&
        (row.bwikiScene === undefined || typeof row.bwikiScene === 'string') &&
        (row.bwikiMatchMethod === undefined || row.bwikiMatchMethod === 'translation-reviewed') &&
        (row.videoStatus === undefined ||
          ['caption-matched', 'screen-matched'].includes(row.videoStatus)) &&
        (row.videoScene === undefined || typeof row.videoScene === 'string') &&
        (row.bwikiPage === undefined || typeof row.bwikiPage === 'string') &&
        (row.bwikiMissionId === undefined ||
          (typeof row.bwikiMissionId === 'string' &&
            /^(?:quest|bwiki-page)-\d+$/.test(row.bwikiMissionId))) &&
        (row.bwikiMission === undefined || typeof row.bwikiMission === 'string') &&
        (row.bwikiRevision === undefined ||
          (Number.isSafeInteger(row.bwikiRevision) && row.bwikiRevision > 0)) &&
        [
          'nextIds',
          'replyToIds',
          'bwikiNextIds',
          'bwikiReplyToIds',
          'videoNextIds',
          'videoReplyToIds',
        ].every(
          (key) =>
            row[key] === undefined ||
            (Array.isArray(row[key]) && row[key].every((id: unknown) => typeof id === 'string')),
        ),
    )
  );
}

export function dialoguePage(rows: DialogueRow[], rowId: string, pageSize = 50) {
  const index = rows.findIndex((row) => row.id === rowId);
  return index < 0 ? undefined : Math.floor(index / pageSize) + 1;
}

export function nearbyDialogue(rows: DialogueRow[], index: number, radius = 20) {
  const selected = rows[index];
  if (!selected) return [];
  if (selected.wikiPosition) return wikiContext(rows, index, false);
  if (selected.wikiUnplaced) return [selected];
  if (selected.flowBoundary && selected.flowStatus === 'review') return [selected];
  const wiki = ['matched', 'cached'].includes(selected.bwikiStatus ?? '') && !!selected.bwikiScene;
  const sameScene = (row: DialogueRow) =>
    !(row.flowBoundary && row.flowStatus === 'review') &&
    row.entryId === selected.entryId &&
    row.chapterId === selected.chapterId &&
    (wiki
      ? ['matched', 'cached'].includes(row.bwikiStatus ?? '') &&
        row.bwikiScene === selected.bwikiScene &&
        (row.bwikiMissionId ?? row.mission) === (selected.bwikiMissionId ?? selected.mission)
      : row.mission === selected.mission &&
        row.scene === selected.scene &&
        row.source === selected.source);
  let start = index;
  let end = index;
  while (start > 0 && index - start < radius && sameScene(rows[start - 1])) start--;
  while (end + 1 < rows.length && end - index < radius && sameScene(rows[end + 1])) end++;
  return rows.slice(start, end + 1);
}

// A choice follows its explicit response and common continuation, stopping at
// the next choice. Other alternatives never become part of the selected path.
export function choiceDialogue(rows: DialogueRow[], index: number, limit = 41) {
  const selected = rows[index];
  if (selected?.wikiPosition) return wikiContext(rows, index, true, limit);
  if (selected?.wikiUnplaced) return [selected];
  const video =
    selected?.videoStatus === 'screen-matched' &&
    !!selected.videoScene &&
    !!selected.videoNextIds?.length &&
    !selected.bwikiNextIds?.length &&
    !selected.nextIds?.length;
  const wiki =
    !video &&
    selected &&
    ['matched', 'cached'].includes(selected.bwikiStatus ?? '') &&
    !!selected.bwikiScene;
  if (
    !selected ||
    selected.type !== 'choice' ||
    (!wiki && !video && (selected.flowStatus !== 'verified' || !selected.flowScene))
  )
    return nearbyDialogue(rows, index);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = [selected];
  const seen = new Set([selected.id]);
  let current = selected;
  while (result.length < limit) {
    const targets = video ? current.videoNextIds : wiki ? current.bwikiNextIds : current.nextIds;
    if (targets?.length !== 1) break;
    const next = byId.get(targets[0]);
    if (
      !next ||
      seen.has(next.id) ||
      next.type === 'choice' ||
      (video
        ? next.videoStatus !== 'screen-matched' || next.videoScene !== selected.videoScene
        : wiki
          ? !['matched', 'cached'].includes(next.bwikiStatus ?? '') ||
            next.bwikiScene !== selected.bwikiScene
          : next.flowStatus !== 'verified' || next.flowScene !== selected.flowScene) ||
      next.entryId !== selected.entryId ||
      next.chapterId !== selected.chapterId ||
      (video
        ? next.mission !== selected.mission
        : wiki
          ? (next.bwikiMissionId ?? next.mission) !== (selected.bwikiMissionId ?? selected.mission)
          : next.mission !== selected.mission)
    )
      break;
    result.push(next);
    seen.add(next.id);
    current = next;
  }
  return result;
}
