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
        (row.variant === undefined || typeof row.variant === 'string'),
    )
  );
}

export function nearbyDialogue(rows: DialogueRow[], index: number, radius = 20) {
  const selected = rows[index];
  if (!selected) return [];
  const sameScene = (row: DialogueRow) =>
    row.entryId === selected.entryId &&
    row.chapterId === selected.chapterId &&
    row.mission === selected.mission &&
    row.scene === selected.scene &&
    row.source === selected.source;
  let start = index;
  let end = index;
  while (start > 0 && index - start < radius && sameScene(rows[start - 1])) start--;
  while (end + 1 < rows.length && end - index < radius && sameScene(rows[end + 1])) end++;
  return rows.slice(start, end + 1);
}
