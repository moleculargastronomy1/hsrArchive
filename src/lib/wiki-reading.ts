import type { DialogueRow } from './dialogue';

export interface WikiPosition {
  id: string;
  rowId: string;
  missionId: string;
  mission: string;
  sceneId: string;
  scene: string;
  page: string;
  revision: number;
  location: (string | number)[];
  conditions: { condition?: string; fold?: string }[];
  branch: string[];
  nextIds: string[];
  replyToIds: string[];
  status: 'wiki-display';
}
export interface WikiReading {
  schema: 'hsr-wiki-reading.v1';
  missions: { id: string; title: string; page: string; officialMissionIds: number[] }[];
  occurrences: WikiPosition[];
  unplaced: { id: string; title: string; rowIds: string[] }[];
}

export interface ExecutionPosition {
  id: string;
  rowId: string;
  missionId: string;
  mission: string;
  source: string;
  pointer: string;
  sceneId: string;
  nextIds: string[];
  replyToIds: string[];
  conditions: unknown[];
  status: 'confirmed';
}
export interface ExecutionReading {
  schema: 'hsr-execution-reading.v1';
  occurrences: ExecutionPosition[];
  placements: {
    occurrenceIds: string[];
    contextIds: string[];
    beforeRowId: string;
    beforeWikiId?: string;
  }[];
}
export function isExecutionReading(value: unknown, rows: DialogueRow[]): value is ExecutionReading {
  if (!value || typeof value !== 'object') return false;
  const v = value as ExecutionReading;
  if (
    v.schema !== 'hsr-execution-reading.v1' ||
    !Array.isArray(v.occurrences) ||
    !Array.isArray(v.placements)
  )
    return false;
  const ids = new Set(v.occurrences.map((p) => p.id));
  const rowIds = new Set(rows.map((r) => r.id));
  return (
    ids.size === v.occurrences.length &&
    v.occurrences.every(
      (p) =>
        p.status === 'confirmed' &&
        rowIds.has(p.rowId) &&
        typeof p.source === 'string' &&
        typeof p.pointer === 'string' &&
        typeof p.sceneId === 'string' &&
        Array.isArray(p.conditions) &&
        [p.nextIds, p.replyToIds].every(
          (links) => Array.isArray(links) && links.every((id) => ids.has(id)),
        ),
    ) &&
    v.placements.every(
      (g) =>
        rowIds.has(g.beforeRowId) &&
        Array.isArray(g.contextIds) &&
        Array.isArray(g.occurrenceIds) &&
        [...g.contextIds, ...g.occurrenceIds].every((id) => ids.has(id)),
    )
  );
}

export function isWikiReading(value: unknown, rows: DialogueRow[]): value is WikiReading {
  if (!value || typeof value !== 'object') return false;
  const v = value as WikiReading;
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (
    v.schema !== 'hsr-wiki-reading.v1' ||
    !Array.isArray(v.missions) ||
    !Array.isArray(v.occurrences) ||
    !Array.isArray(v.unplaced)
  )
    return false;
  const ids = new Set(v.occurrences.map((p) => p.id));
  const missions = new Set(v.missions.map((m) => m.id));
  if (ids.size !== v.occurrences.length || missions.size !== v.missions.length) return false;
  if (
    !v.missions.every(
      (m) =>
        typeof m.id === 'string' &&
        typeof m.title === 'string' &&
        Array.isArray(m.officialMissionIds),
    )
  )
    return false;
  if (
    !v.occurrences.every(
      (p) =>
        p.status === 'wiki-display' &&
        byId.has(p.rowId) &&
        typeof p.id === 'string' &&
        typeof p.sceneId === 'string' &&
        typeof p.scene === 'string' &&
        typeof p.mission === 'string' &&
        missions.has(p.missionId) &&
        typeof p.page === 'string' &&
        Number.isSafeInteger(p.revision) &&
        p.revision > 0 &&
        Array.isArray(p.conditions) &&
        p.conditions.every((c) => c && typeof c === 'object') &&
        Array.isArray(p.branch) &&
        [p.nextIds, p.replyToIds].every(
          (links) => Array.isArray(links) && links.every((id) => ids.has(id)),
        ),
    )
  )
    return false;
  const placed = new Set(v.occurrences.map((p) => p.rowId));
  const unplaced = v.unplaced.flatMap((g) => g.rowIds ?? []);
  return (
    v.unplaced.every(
      (g) => typeof g.id === 'string' && typeof g.title === 'string' && Array.isArray(g.rowIds),
    ) &&
    new Set(unplaced).size === unplaced.length &&
    unplaced.every((id) => byId.has(id) && !placed.has(id)) &&
    placed.size + unplaced.length === rows.length
  );
}

// Occurrence IDs are presentation identities; canonical row IDs remain the
// localization, search and bookmark keys even when a line is shown twice.
export function readingRows(
  rows: DialogueRow[],
  reading?: WikiReading,
  execution?: ExecutionReading,
): DialogueRow[] {
  if (!reading) return mergeExecutionRows(rows, rows, execution);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: DialogueRow[] = [];
  const consumed = new Set<string>();
  const appendUnknown = (group: WikiReading['unplaced'][number]) => {
    consumed.add(group.id);
    const existing = group.rowIds
      .map((id) => byId.get(id)!)
      .filter(
        (row) =>
          row.flowStatus === 'verified' ||
          ['matched', 'cached'].includes(row.bwikiStatus ?? '') ||
          ['caption-matched', 'screen-matched'].includes(row.videoStatus ?? ''),
      );
    const known = new Set(existing.map((row) => row.id));
    // Failure to reconstruct a finer wiki position cannot revoke an existing
    // proof. Keep that original scope separate from genuinely unknown rows.
    for (const row of existing)
      result.push({ ...row, wikiLegacy: { id: group.id, title: group.title } });
    for (const id of group.rowIds)
      if (!known.has(id))
        result.push({ ...byId.get(id)!, wikiUnplaced: { id: group.id, title: group.title } });
  };
  for (const mission of reading.missions) {
    result.push(
      ...reading.occurrences
        .filter((p) => p.missionId === mission.id)
        .map((position) => ({ ...byId.get(position.rowId)!, wikiPosition: position })),
    );
    for (const group of reading.unplaced) {
      if (consumed.has(group.id)) continue;
      const row = byId.get(group.rowIds[0]);
      if (
        mission.officialMissionIds.some((id) => group.id === `quest-${id}`) ||
        group.title === mission.title ||
        row?.bwikiPage === mission.page
      )
        appendUnknown(group);
    }
  }
  for (const group of reading.unplaced) if (!consumed.has(group.id)) appendUnknown(group);
  return mergeExecutionRows(result, rows, execution);
}

function mergeExecutionRows(
  base: DialogueRow[],
  canonical: DialogueRow[],
  execution?: ExecutionReading,
) {
  if (!execution) return base;
  const byId = new Map(canonical.map((row) => [row.id, row]));
  const positions = new Map(
    execution.occurrences.map(
      (p) => [p.id, { ...byId.get(p.rowId)!, executionPosition: p }] as const,
    ),
  );
  const insertions = new Map<string, DialogueRow[]>();
  const moved = new Set<string>();
  for (const group of execution.placements) {
    const peers = group.contextIds.map((id) => positions.get(id)!);
    const placed = group.occurrenceIds.map((id) => ({
      ...positions.get(id)!,
      executionPeers: peers,
    }));
    for (const row of placed) moved.add(row.id);
    const insertion = group.beforeWikiId ?? group.beforeRowId;
    insertions.set(insertion, [...(insertions.get(insertion) ?? []), ...placed]);
  }
  return base.flatMap((row) => [
    ...(insertions.get(positionKey(row)) ?? insertions.get(row.id) ?? []),
    ...(moved.has(row.id) ? [] : [row]),
  ]);
}

export function positionKey(row: DialogueRow) {
  return row.wikiPosition?.id ?? row.executionPosition?.id ?? row.id;
}

export function executionContext(rows: DialogueRow[], index: number, choice: boolean, limit = 41) {
  const selected = rows[index],
    p = selected?.executionPosition;
  if (!p) return selected ? [selected] : [];
  const peers = selected.executionPeers ?? rows;
  const byId = new Map(
    peers.filter((r) => r.executionPosition).map((r) => [r.executionPosition!.id, r]),
  );
  const before: DialogueRow[] = [],
    after: DialogueRow[] = [],
    seen = new Set([p.id]);
  let current = selected;
  if (!choice)
    while (before.length < 20) {
      const incoming = peers.filter((r) =>
        r.executionPosition?.nextIds.includes(current.executionPosition!.id),
      );
      if (
        incoming.length !== 1 ||
        incoming[0].type === 'choice' ||
        seen.has(incoming[0].executionPosition!.id)
      )
        break;
      current = incoming[0];
      before.unshift(current);
      seen.add(current.executionPosition!.id);
    }
  current = selected;
  while (
    before.length + after.length + 1 < limit &&
    current.executionPosition?.nextIds.length === 1
  ) {
    const next = byId.get(current.executionPosition.nextIds[0]);
    if (
      !next?.executionPosition ||
      next.type === 'choice' ||
      seen.has(next.executionPosition.id) ||
      next.executionPosition.source !== p.source ||
      JSON.stringify(next.executionPosition.conditions) !== JSON.stringify(p.conditions)
    )
      break;
    after.push(next);
    seen.add(next.executionPosition.id);
    current = next;
  }
  return [...before, selected, ...after];
}
export function wikiContext(rows: DialogueRow[], index: number, choice: boolean, limit = 41) {
  const selected = rows[index];
  const p = selected?.wikiPosition;
  if (!p) return selected ? [selected] : [];
  if (choice) {
    const byId = new Map(
      rows.filter((row) => row.wikiPosition).map((row) => [row.wikiPosition!.id, row]),
    );
    const result = [selected];
    const seen = new Set([p.id]);
    let current = selected;
    while (result.length < limit && current.wikiPosition?.nextIds.length === 1) {
      const next = byId.get(current.wikiPosition.nextIds[0]);
      if (
        !next?.wikiPosition ||
        next.type === 'choice' ||
        seen.has(next.wikiPosition.id) ||
        next.wikiPosition.sceneId !== p.sceneId ||
        next.wikiPosition.missionId !== p.missionId
      )
        break;
      result.push(next);
      seen.add(next.wikiPosition.id);
      current = next;
    }
    return result;
  }
  const same = (row: DialogueRow) =>
    row.wikiPosition?.sceneId === p.sceneId &&
    row.wikiPosition.missionId === p.missionId &&
    JSON.stringify(row.wikiPosition.branch) === JSON.stringify(p.branch);
  let start = index,
    end = index;
  while (start > 0 && index - start < 20 && same(rows[start - 1])) start--;
  while (end + 1 < rows.length && end - index < 20 && same(rows[end + 1])) end++;
  return rows.slice(start, end + 1);
}
