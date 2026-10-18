import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from './verification-state.mjs';
import { validatedCaptionMatches, videoVerified, sha256 } from './video-order.mjs';

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
    'lostEventImages',
    'lostContentRoutes',
  ].filter((key) => comparison[key]?.length);
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
    !videoVerified(row)
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

export async function verificationRows(root, { referencedOnly = false } = {}) {
  const rows = new Map();
  const references = new Set();
  const optionalJson = async (file) => {
    const bytes = await fs.readFile(path.join(root, file)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return bytes ? JSON.parse(bytes) : undefined;
  };
  for (const item of Object.values((await optionalJson('src/data/imported-content.json')) ?? {}))
    if (item.file) references.add(item.file);
  for (const name of ['simulation', 'codex', 'books', 'trailblaze'])
    for (const entry of (await optionalJson(`src/data/${name}.json`)) ?? [])
      for (const chapter of entry.chapters)
        if (chapter.content?.file) references.add(chapter.content.file);
  if (referencedOnly && !references.size) throw new Error('Missing authoritative content routes');
  rows.contentRoutes = [...references].sort();
  const simulation = await fs
    .readFile(path.join(root, 'src/data/simulation.json'))
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  rows.eventImages = simulation
    ? JSON.parse(simulation)
        .flatMap((entry) =>
          entry.chapters
            .filter((chapter) => chapter.image)
            .map((chapter) => [
              entry.id + '/' + chapter.id,
              chapter.image.url,
              chapter.image.sha1,
              chapter.image.sourceUrl,
            ]),
        )
        .sort((a, b) => a[0].localeCompare(b[0]))
    : [];
  const folder = path.join(root, 'public/content');
  for (const name of (await fs.readdir(folder))
    .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name) && name !== 'search-index.json')
    .sort()) {
    if (referencedOnly && !references.has('content/' + name)) continue;
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
  const routes = new Set(after.contentRoutes ?? []);
  const lostContentRoutes = (before.contentRoutes ?? []).filter((file) => !routes.has(file));
  const imageKeys = new Set((after.eventImages ?? []).map(([key]) => key));
  const lostEventImages = (before.eventImages ?? [])
    .filter(([key]) => !imageKeys.has(key))
    .map(([key]) => key);
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
          ['nextIds', 'replyToIds'].some((key) => !containsLinks(current, row, key))) ||
        (videoVerified(row) &&
          ['videoNextIds', 'videoReplyToIds'].some((key) => !containsLinks(current, row, key))))
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
      JSON.stringify({
        eventImages: rows.eventImages ?? [],
        contentRoutes: rows.contentRoutes ?? [],
        rows: [...rows].map(([id, row]) => [
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
          row.videoScene,
          row.videoNextIds,
          row.videoReplyToIds,
        ]),
      }),
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
    lostEventImages,
    lostContentRoutes,
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
        !videoVerified(byId.get(match.rowId)) &&
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

export function restoreVideoMissions(payload, evidence) {
  const byId = new Map(payload.rows.map((row) => [row.id, row]));
  const groups = new Map();
  for (const match of evidence.matches) {
    const row = byId.get(match.rowId);
    if (!row) continue;
    const mission = row.bwikiMissionId ?? row.missionId;
    if (!mission) continue;
    if (!groups.has(mission)) groups.set(mission, []);
    groups.get(mission).push(match);
  }
  const result = { changed: 0, confirmed: 0, conflicts: [] };
  for (const [missionId, matches] of groups) {
    const candidate = structuredClone(payload);
    const applied = restoreVideoOrder(candidate, { ...evidence, matches });
    if (applied.conflict) result.conflicts.push(missionId);
    else {
      try {
        assertVerificationPreserved(
          compareVerification(
            new Map(payload.rows.map((row) => [row.id, row])),
            new Map(candidate.rows.map((row) => [row.id, row])),
          ),
          'Video mission',
        );
      } catch {
        result.conflicts.push(missionId);
        continue;
      }
      payload.rows = candidate.rows;
      result.changed += applied.changed;
      result.confirmed += applied.confirmed;
    }
  }
  return result;
}

// Screen-reviewed paths carry exact official row hashes and one original source
// scope. They never manufacture unobserved alternatives or overwrite other graphs.
export function applyScreenEvidence(payload, evidence) {
  const byId = new Map(payload.rows.map((row) => [row.id, row]));
  const matches = evidence.matches;
  const fail = (reason) => ({ changed: 0, confirmed: 0, reason });
  if (
    evidence.method !== 'reviewed-screen-path' ||
    !/^[\w-]{11}$/.test(evidence.videoId ?? '') ||
    !Array.isArray(matches) ||
    matches.length < 3 ||
    new Set(matches.map((item) => item.rowId)).size !== matches.length ||
    !Array.isArray(evidence.edges) ||
    evidence.edges.length !== matches.length - 1 ||
    matches
      .slice(0, -1)
      .some(
        (match, index) =>
          evidence.edges[index]?.from !== match.rowId ||
          evidence.edges[index]?.to !== matches[index + 1].rowId,
      )
  )
    return fail('incomplete-screen-path');
  for (const [index, match] of matches.entries()) {
    const row = byId.get(match.rowId);
    if (
      !row ||
      row.source !== evidence.source ||
      row.missionId !== evidence.missionId ||
      row.talkId !== match.talkId ||
      row.type !== match.type ||
      sha256(row.text) !== match.koreanHash ||
      !Number.isFinite(match.startMs) ||
      match.startMs < 0 ||
      (index && match.startMs <= matches[index - 1].startMs) ||
      !/^[a-f0-9]{64}$/.test(match.frameSha256 ?? '')
    )
      return fail('screen-proof-no-longer-valid');
  }
  for (const edge of evidence.edges ?? []) {
    const index = matches.findIndex((item) => item.rowId === edge.from);
    if (index < 0 || matches[index + 1]?.rowId !== edge.to) return fail('unobserved-screen-edge');
    const row = byId.get(edge.from);
    if (row.type === 'choice' && edge.selection !== 'observed-single-option')
      return fail('choice-selection-unproven');
    for (const [verified, key] of [
      [wikiVerified(row), 'bwikiNextIds'],
      [flowVerified(row), 'nextIds'],
      [videoVerified(row), 'videoNextIds'],
    ])
      if (verified && row[key]?.length && !row[key].includes(edge.to))
        return fail('screen-order-conflict');
  }
  const before = new Map(payload.rows.map((row) => [row.id, { ...row }]));
  const candidate = structuredClone(payload);
  const candidateById = new Map(candidate.rows.map((row) => [row.id, row]));
  const scene =
    'video-' +
    sha256(
      JSON.stringify([evidence.videoId, evidence.source, matches.map((item) => item.rowId)]),
    ).slice(0, 16);
  for (const match of matches)
    Object.assign(candidateById.get(match.rowId), {
      videoStatus: 'screen-matched',
      videoId: evidence.videoId,
      videoStartMs: match.startMs,
      videoScene: scene,
    });
  for (const edge of evidence.edges ?? []) {
    candidateById.get(edge.from).videoNextIds = [edge.to];
    if (candidateById.get(edge.from).type === 'choice')
      candidateById.get(edge.to).videoReplyToIds = [edge.from];
  }
  // Move only previously unverified observed rows beside their observed neighbor.
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index],
      row = before.get(match.rowId);
    if (wikiVerified(row) || flowVerified(row) || videoVerified(row)) continue;
    const next = matches[index + 1],
      previous = matches[index - 1];
    if (!next && !previous) continue;
    candidate.rows = candidate.rows.filter((item) => item.id !== row.id);
    const insertion = next
      ? candidate.rows.findIndex((item) => item.id === next.rowId)
      : candidate.rows.findIndex((item) => item.id === previous.rowId) + 1;
    candidate.rows.splice(insertion, 0, candidateById.get(row.id));
  }
  const comparison = compareVerification(
    before,
    new Map(candidate.rows.map((row) => [row.id, row])),
  );
  try {
    assertVerificationPreserved(comparison, 'Screen integration');
  } catch {
    return fail('screen-conflicts-with-established-proof');
  }
  payload.rows = candidate.rows;
  return {
    changed: comparison.changed ? 1 : 0,
    confirmed: matches.filter((item) => orderUnknown(before.get(item.rowId))).length,
    observed: matches.length,
    edges: (evidence.edges ?? []).length,
  };
}
