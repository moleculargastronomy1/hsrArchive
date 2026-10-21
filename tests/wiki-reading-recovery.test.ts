import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retainUnavailablePositions } from '../scripts/wiki-reading-recovery.mjs';
import {
  compareVerification,
  assertVerificationPreserved,
} from '../scripts/verification-integration.mjs';

const rows = [
  { id: 'a', text: '원문', type: 'choice', flowStatus: 'review' },
  { id: 'b', text: '응답', type: 'dialogue', flowStatus: 'review' },
  { id: 'c', text: '다른 임무', type: 'dialogue', flowStatus: 'review' },
];
const positions = [
  { id: 'p1', rowId: 'a', page: '甲', missionId: 'm1', nextIds: ['p2'] },
  { id: 'p2', rowId: 'b', page: '甲', missionId: 'm1', nextIds: [] },
  { id: 'p3', rowId: 'c', page: '乙', missionId: 'm2', nextIds: [] },
];
const old = {
  commit: 'release',
  codeHash: 'old-code',
  policyHash: 'old-policy',
  policyVersion: 2,
  sources: [
    { pageTitle: '甲', revision: 5, sha256: 'proof' },
    { pageTitle: '乙', revision: 6, sha256: 'other' },
  ],
  missions: [
    { id: 'm1', page: '甲' },
    { id: 'm2', page: '乙' },
  ],
  occurrences: positions,
  unplaced: [],
  summary: {},
};
const missing = () => ({
  ...structuredClone(old),
  codeHash: 'new-code',
  sources: [old.sources[1]],
  missions: [old.missions[1]],
  occurrences: [positions[2]],
  unplaced: [{ id: 'quest', rowIds: ['a', 'b'] }],
  summary: {},
});
const comparison = (value) => {
  const before = new Map(rows.map((r) => [r.id, r])),
    after = new Map(rows.map((r) => [r.id, r]));
  before.wikiReadings = { file: old };
  after.wikiReadings = { file: value };
  return compareVerification(before, after);
};
test('unavailable documents retain exact prior positions, replies and validation versions', () => {
  const next = missing();
  const prior = structuredClone(old);
  const retained = retainUnavailablePositions(old, next, rows, rows, new Set(['甲']));
  assert.equal(retained.length, 1);
  assert.deepEqual(old, prior);
  assert.deepEqual(next.occurrences, positions);
  assert.deepEqual(next.unplaced, []);
  assert.equal(next.retainedSources[0].priorValidation.codeHash, 'old-code');
  assert.equal(next.codeHash, 'new-code');
  assert.doesNotThrow(() => assertVerificationPreserved(comparison(next), 'Retry'));
});
test('available-source regressions still stop automatic publication', () => {
  const next = missing();
  next.sources = structuredClone(old.sources);
  assert.equal(retainUnavailablePositions(old, next, rows, rows, new Set()).length, 0);
  assert.throws(() => assertVerificationPreserved(comparison(next), 'Retry'), /lostReading/);
});
test('unavailability cannot mask changed official content or a different release', () => {
  const changed = structuredClone(rows);
  changed[0].text = '바뀐 원문';
  assert.throws(
    () => retainUnavailablePositions(old, missing(), changed, rows, new Set(['甲'])),
    /changed canonical/,
  );
  const next = missing();
  next.commit = 'another-release';
  assert.equal(retainUnavailablePositions(old, next, rows, rows, new Set(['甲'])).length, 0);
});
