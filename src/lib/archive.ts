import type { ArchiveEntry, Category, Chapter, World } from '../data/types.ts';

export function chapterContentLabel(chapter: Chapter) {
  if (!chapter.content) return '예시 대사';
  const original = `${chapter.content.rows.toLocaleString('ko-KR')}줄 · 한국어 원문`;
  return chapter.bwikiManaged ? original : (chapter.contentNote ?? original);
}

export function searchEntries(
  entries: ArchiveEntry[],
  query: string,
  category?: Category,
  world?: World,
) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (world && entry.world !== world) return false;
    const text = [
      entry.title,
      entry.arcLabel ?? '',
      entry.subtitle,
      entry.description,
      ...entry.tags,
      ...entry.chapters.flatMap((chapter) => [
        chapter.title,
        chapter.group ?? '',
        ...chapter.blocks.flatMap((block) => [block.speaker ?? '', block.text]),
      ]),
    ]
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function adjacentChapter(entry: ArchiveEntry, chapterId: string, direction: -1 | 1) {
  const index = entry.chapters.findIndex((chapter) => chapter.id === chapterId);
  return index < 0 ? undefined : entry.chapters[index + direction];
}

export function chapterNumber(entry: ArchiveEntry, chapterId: string): string {
  const chapter = entry.chapters.find((item) => item.id === chapterId);
  if (!chapter) return '';
  if (chapter.parentId) {
    const siblings = entry.chapters.filter((item) => item.parentId === chapter.parentId);
    return `${chapterNumber(entry, chapter.parentId)}.${siblings.indexOf(chapter) + 1}`;
  }
  const roots = entry.chapters.filter((item) => !item.parentId);
  return String(roots.indexOf(chapter) + 1).padStart(2, '0');
}

export function readerPath(entryId: string, chapterId?: string, dialogueId?: string) {
  const path = `/entry/${encodeURIComponent(entryId)}${chapterId ? `/${encodeURIComponent(chapterId)}` : ''}`;
  return chapterId && dialogueId ? `${path}?dialogue=${encodeURIComponent(dialogueId)}` : path;
}
