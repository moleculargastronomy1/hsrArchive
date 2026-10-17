import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from './verification-state.mjs';
import { validatedCaptionMatches } from './video-order.mjs';

// Cross-source decisions belong here. Collectors and exact matchers stay independent.
const coreKeys = [
  'file',
  'entryId',
  'chapterId',
  'text',
  'speaker',
  'type',
  'missionId',
  'mission',
  'talkId',
  'textHash',
  'source',
  'scene',
  'variant',
];
const wikiVerified = (row) => ['matched', 'cached'].includes(row?.bwikiStatus);
const flowVerified = (row) => row?.flowStatus === 'verified';
const videoVerified = (row) => row?.videoStatus === 'caption-matched';
const containsLinks = (current, old, key) =>
  (old[key] ?? []).every((id) => (current[key] ?? []).includes(id));

export function assertVerificationPreserved(comparison, context) {
  const failures = [
    'removedRows',
    'changedCoreRows',
    'lostVerification',
    'lostFlowVerification',
    'lostVideoVerification',
    'conflictingLinks',
    'conflictingOrder',
  ].filter((key) => comparison[key].length);
  if (failures.length)
    throw new Error(
      `${context} rejected: ${failures.map((key) => `${key}=${comparison[key].length}`).join(', ')}; preserving deployed data`,
    );
}

export function orderUnknown(row) {
  return (
    (row.bwikiStatus === 'review' || row.flowStatus === 'review') &&
    row.flowStatus !== 'verified' &&
    !['matched', 'cached'].includes(row.bwikiStatus) &&
    row.videoStatus !== 'caption-matched'
  );
}
export function baselineChoice(repository, published) {
  const contains = (larger, smaller) => {
    try {
      assertVerificationPreserved(compareVerification(smaller, larger), 'Baseline');
      return true;
    } catch {
      return false;
    }
  };
  if (contains(published, repository)) return 'published';
  if (contains(repository, published)) return 'repository';
  return 'conflict';
}

export async function verificationRows(root) {
  const rows = new Map();
  const folder = path.join(root, 'public/content');
  for (const name of (await fs.readdir(folder))
    .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name) && name !== 'search-index.json')
    .sort()) {
    const payload = JSON.parse(await fs.readFile(path.join(folder, name)));
    if (payload.schema !== 'hsr-dialogue.v1') continue;
    for (const row of payload.rows) {
      if (rows.has(row.id)) throw new Error('Duplicate verification row identity: ' + row.id);
      rows.set(row.id, { ...row, file: 'content/' + name });
    }
  }
  return rows;
}
export function compareVerification(before, after) {
  const newlyVerified = [],
    lostVerification = [],
    remainingUnknown = [];
  const removedRows = [],
    changedCoreRows = [];
  const lostFlowVerification = [],
    lostVideoVerification = [],
    conflictingLinks = [];
  for (const [id, row] of before) {
    const current = after.get(id);
    if (!current) {
      removedRows.push(id);
      if (wikiVerified(row)) lostVerification.push(id);
    } else if (coreKeys.some((key) => current[key] !== row[key])) changedCoreRows.push(id);
    if (flowVerified(row) && !flowVerified(current)) lostFlowVerification.push(id);
    if (videoVerified(row) && !videoVerified(current)) lostVideoVerification.push(id);
    if (
      current &&
      ((wikiVerified(row) &&
        ['bwikiNextIds', 'bwikiReplyToIds'].some((key) => !containsLinks(current, row, key))) ||
        (flowVerified(row) &&
          ['nextIds', 'replyToIds'].some((key) => !containsLinks(current, row, key))))
    )
      conflictingLinks.push(id);
  }
  for (const [id, row] of after) {
    if (orderUnknown(row)) remainingUnknown.push(id);
    if (
      ['matched', 'cached'].includes(row.bwikiStatus) &&
      (!before.has(id) || orderUnknown(before.get(id)))
    )
      newlyVerified.push(id);
    if (
      before.has(id) &&
      ['matched', 'cached'].includes(before.get(id).bwikiStatus) &&
      !['matched', 'cached'].includes(row.bwikiStatus)
    )
      lostVerification.push(id);
  }
  const conflictingOrder = [];
  // BWIKI runs and video timestamps prove sequence in their own scope. A flow
  // graph is a partial order: its links above preserve order without freezing
  // unrelated branches in one array arrangement.
  const scopes = new Map();
  for (const [id, row] of before) {
    if (!after.has(id)) continue;
    for (const [verified, layer, scope] of [
      [wikiVerified(row), 'bwiki', row.bwikiScene],
      [videoVerified(row), 'video', row.videoId],
    ]) {
      if (!verified || !scope) continue;
      const key = JSON.stringify([row.file, layer, scope]);
      if (!scopes.has(key)) scopes.set(key, []);
      scopes.get(key).push(id);
    }
  }
  const positions = new Map([...after.keys()].map((id, index) => [id, index]));
  for (const ids of scopes.values()) {
    if (ids.some((id, index) => index > 0 && positions.get(id) < positions.get(ids[index - 1])))
      conflictingOrder.push(...ids);
  }
  const digest = (rows) =>
    hash(
      JSON.stringify(
        [...rows].map(([id, row]) => [
          id,
          ...coreKeys.map((key) => row[key]),
          row.flowStatus,
          row.flowScene,
          row.flowBoundary,
          row.nextIds,
          row.replyToIds,
          row.bwikiScene,
          row.bwikiNextIds,
          row.bwikiReplyToIds,
          row.bwikiMissionId,
          ['matched', 'cached'].includes(row.bwikiStatus),
          row.videoStatus,
          row.videoId,
          row.videoStartMs,
        ]),
      ),
    );
  return {
    newlyVerified,
    lostVerification,
    remainingUnknown,
    removedRows,
    changedCoreRows,
    lostFlowVerification,
    lostVideoVerification,
    conflictingLinks,
    conflictingOrder: [...new Set(conflictingOrder)],
    changed: digest(before) !== digest(after),
    digest: digest(after),
  };
}

export function restoreVideoOrder(payload, evidence) {
  const byId = new Map(payload.rows.map((row) => [row.id, row]));
  const matches = validatedCaptionMatches(payload.rows, evidence);
  if (matches.length < 3) return { changed: 0, confirmed: 0 };
  const positions = new Map(payload.rows.map((row, index) => [row.id, index]));
  const anchors = matches.filter((match) =>
    ['matched', 'cached'].includes(byId.get(match.rowId).bwikiStatus ?? ''),
  );
  // BWIKI remains primary. A conflicting path cannot override it automatically.
  const lastByMission = new Map();
  for (const match of anchors) {
    const row = byId.get(match.rowId);
    const previous = lastByMission.get(row.bwikiMissionId);
    if (previous && positions.get(previous.id) >= positions.get(row.id))
      return { changed: 0, confirmed: 0, conflict: true };
    lastByMission.set(row.bwikiMissionId, row);
  }
  let changed = 0,
    confirmed = 0;
  for (let i = 1; i < anchors.length; i++) {
    const first = anchors[i - 1],
      last = anchors[i];
    const a = byId.get(first.rowId),
      b = byId.get(last.rowId);
    if (!a.bwikiMissionId || a.bwikiMissionId !== b.bwikiMissionId) continue;
    const middle = matches.filter(
      (match) =>
        match.startMs > first.startMs &&
        match.startMs < last.startMs &&
        !['matched', 'cached'].includes(byId.get(match.rowId).bwikiStatus ?? '') &&
        byId.get(match.rowId).flowStatus !== 'verified' &&
        (byId.get(match.rowId).bwikiMissionId === a.bwikiMissionId ||
          (a.missionId &&
            a.missionId === b.missionId &&
            byId.get(match.rowId).missionId === a.missionId)),
    );
    if (!middle.length) continue;
    const before = payload.rows.map((row) => row.id);
    const aIndex = payload.rows.findIndex((row) => row.id === first.rowId);
    const bIndex = payload.rows.findIndex((row) => row.id === last.rowId);
    const outside = middle.filter((match) => {
      const index = payload.rows.findIndex((row) => row.id === match.rowId);
      return index < aIndex || index > bIndex;
    });
    const outsideIds = new Set(outside.map((match) => match.rowId));
    payload.rows = payload.rows.filter((row) => !outsideIds.has(row.id));
    const insertion = payload.rows.findIndex((row) => row.id === last.rowId);
    payload.rows.splice(insertion, 0, ...outside.map((match) => byId.get(match.rowId)));
    const middleIds = new Set(middle.map((match) => match.rowId));
    const slots = payload.rows.flatMap((row, index) => (middleIds.has(row.id) ? [index] : []));
    slots.forEach((slot, index) => {
      payload.rows[slot] = byId.get(middle[index].rowId);
    });
    for (const match of middle)
      Object.assign(byId.get(match.rowId), {
        videoStatus: 'caption-matched',
        videoId: evidence.videoId,
        videoStartMs: match.startMs,
      });
    changed += payload.rows.filter((row, index) => row.id !== before[index]).length;
    confirmed += middle.length;
  }
  return { changed, confirmed };
}
