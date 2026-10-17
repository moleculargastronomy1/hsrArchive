import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from './verification-state.mjs';

export const RETRY_FILE = '.cache/verification-retry/state.json';
export const HOUR = 3600000;
export async function algorithmHash(root = process.cwd()) {
  const files = [
    'bwiki-dialogue.py',
    'import-bwiki-chapters.py',
    'fetch-bwiki.mjs',
    'fetch-bwiki-legacy.mjs',
    'verification-retry.mjs',
    'reverify-content.mjs',
    'import-localizations.py',
  ];
  return hash(
    Buffer.concat(
      await Promise.all(
        files.map(async (file) =>
          Buffer.concat([
            Buffer.from(file + '\0'),
            await fs.readFile(path.join(root, 'scripts', file)),
          ]),
        ),
      ),
    ),
  );
}
export async function readRetry(root = process.cwd()) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, RETRY_FILE)));
    if (
      value.schema !== 'hsr-verification-retry.v1' ||
      !value.pages ||
      typeof value.pages !== 'object'
    )
      throw new Error('Invalid retry state');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schema: 'hsr-verification-retry.v1', pages: {} };
  }
}
export async function saveRetry(state, root = process.cwd()) {
  const file = path.join(root, RETRY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(state));
  await fs.rename(file + '.tmp', file);
}
export function retryDelay(failures, retryAfter, now = Date.now()) {
  const seconds = Number(retryAfter);
  const server =
    retryAfter == null
      ? 0
      : Number.isFinite(seconds)
        ? seconds * 1000
        : Math.max(0, Date.parse(retryAfter) - now) || 0;
  return Math.max(Math.min(72, 6 * 2 ** Math.min(4, Math.max(0, failures - 1))) * HOUR, server);
}
export function failedPage(previous, reason, now, retryAfter) {
  const failures = (previous?.failures ?? 0) + 1;
  return {
    ...previous,
    failures,
    reason,
    lastAttempt: new Date(now).toISOString(),
    nextRetryAt: new Date(now + retryDelay(failures, retryAfter, now)).toISOString(),
  };
}
export function retryDecision(state, algorithm, published, now = Date.now()) {
  if (state.pendingDigest && state.pendingDigest !== published?.digest)
    return { needed: true, reason: 'unpublished-verified-result' };
  if ((state.algorithm ?? published?.algorithm) !== algorithm)
    return { needed: true, reason: 'algorithm-changed' };
  if (Date.parse(state.nextRequestAt ?? '') > now)
    return { needed: false, reason: 'request-backoff' };
  const due = Object.entries(state.pages)
    .filter(([, item]) => item.reason && Date.parse(item.nextRetryAt) <= now)
    .map(([title]) => title);
  return {
    needed: due.length > 0,
    reason: due.length ? 'failed-pages-due' : 'unchanged-processed-inputs',
    due,
  };
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
  const verified = (row) => ['matched', 'cached'].includes(row.bwikiStatus);
  const contains = (larger, smaller) =>
    [...smaller].every(([id, row]) => {
      const other = larger.get(id);
      return (
        other &&
        ['text', 'speaker', 'type', 'missionId', 'talkId', 'source'].every(
          (key) => other[key] === row[key],
        ) &&
        (!verified(row) || verified(other)) &&
        (row.flowStatus !== 'verified' || other.flowStatus === 'verified') &&
        (row.videoStatus !== 'caption-matched' || other.videoStatus === 'caption-matched')
      );
    });
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
    for (const row of payload.rows) rows.set(row.id, { ...row, file: 'content/' + name });
  }
  return rows;
}
export function compareVerification(before, after) {
  const newlyVerified = [],
    lostVerification = [],
    remainingUnknown = [];
  const removedRows = [],
    changedCoreRows = [];
  for (const [id, row] of before) {
    const current = after.get(id);
    if (!current) {
      removedRows.push(id);
      if (['matched', 'cached'].includes(row.bwikiStatus)) lostVerification.push(id);
    } else if (
      ['text', 'speaker', 'type', 'missionId', 'talkId', 'source'].some(
        (key) => current[key] !== row[key],
      )
    )
      changedCoreRows.push(id);
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
  const digest = (rows) =>
    hash(
      JSON.stringify(
        [...rows].map(([id, row]) => [
          id,
          row.text,
          row.speaker,
          row.type,
          row.missionId,
          row.talkId,
          row.bwikiScene,
          row.bwikiNextIds,
          row.bwikiReplyToIds,
          row.bwikiMissionId,
          ['matched', 'cached'].includes(row.bwikiStatus),
        ]),
      ),
    );
  return {
    newlyVerified,
    lostVerification,
    remainingUnknown,
    removedRows,
    changedCoreRows,
    changed: digest(before) !== digest(after),
    digest: digest(after),
  };
}
