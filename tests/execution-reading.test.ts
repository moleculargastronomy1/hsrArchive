import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  readingRows,
  positionKey,
  isExecutionReading,
  type ExecutionReading,
} from '../src/lib/wiki-reading.ts';
import { choiceDialogue, nearbyDialogue, type DialogueRow } from '../src/lib/dialogue.ts';
import {
  compareVerification,
  assertVerificationPreserved,
} from '../scripts/verification-integration.mjs';

const canonical: DialogueRow[] = ['right', 'response', 'left', 'common'].map((id) => ({
  id,
  entryId: 'entry',
  chapterId: 'chapter',
  mission: '임무',
  scene: 'old',
  speaker: '화자',
  text: '원문 ' + id,
  type: ['left', 'right'].includes(id) ? 'choice' : 'dialogue',
  flowStatus: 'review',
  flowBoundary: true,
}));
const p = (id: string, rowId: string, nextIds: string[] = []) => ({
  id,
  rowId,
  nextIds,
  replyToIds: [],
  missionId: 'quest-1',
  mission: '임무',
  source: 'same-file',
  pointer: '/' + id,
  sceneId: 'scene',
  conditions: [],
  status: 'confirmed' as const,
});
const execution: ExecutionReading = {
  schema: 'hsr-execution-reading.v1',
  occurrences: [
    p('l', 'left', ['a']),
    p('r', 'right', ['b']),
    p('a', 'response', ['c']),
    p('b', 'response', ['c']),
    p('c', 'common'),
  ],
  placements: [
    {
      beforeRowId: 'right',
      contextIds: ['l', 'r', 'a', 'b', 'c'],
      occurrenceIds: ['l', 'r', 'a', 'b', 'c'],
    },
  ],
};

test('partial official execution supports barriers, explicit signals and distinct repeated occurrences', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_execution_reading.py'],
    { env: { ...process.env, PYTHONUTF8: '1' }, stdio: 'pipe' },
  );
});

test('official occurrence projection retains canonical IDs and branch-specific context without changing original rows', () => {
  const before = JSON.stringify(canonical);
  assert.ok(isExecutionReading(execution, canonical));
  const rows = readingRows(canonical, undefined, execution);
  assert.equal(JSON.stringify(canonical), before);
  assert.deepEqual(rows.map(positionKey), ['l', 'r', 'a', 'b', 'c']);
  assert.equal(rows.filter((r) => r.id === 'response').length, 2);
  assert.deepEqual(choiceDialogue(rows, 0).map(positionKey), ['l', 'a', 'c']);
  assert.deepEqual(choiceDialogue(rows, 1).map(positionKey), ['r', 'b', 'c']);
  assert.deepEqual(nearbyDialogue(rows, 2).map(positionKey), ['a', 'c']);
  const broken = structuredClone(execution);
  broken.occurrences[0].nextIds = ['absent'];
  assert.equal(isExecutionReading(broken, canonical), false);
});

test('restoration rejects lost official positions, display placement or response edges', () => {
  const map = (reading: ExecutionReading) =>
    Object.assign(new Map(canonical.map((r) => [r.id, r])), {
      executionReadings: { 'content/test.json': reading },
    });
  const old = map(execution),
    current = map(structuredClone(execution));
  assertVerificationPreserved(compareVerification(old, current), 'intact');
  current.executionReadings['content/test.json'].occurrences[0].nextIds = [];
  assert.throws(
    () => assertVerificationPreserved(compareVerification(old, current), 'changed'),
    /lostReadingLinks/,
  );
  const without = map({ ...execution, placements: [] });
  assert.throws(
    () => assertVerificationPreserved(compareVerification(old, without), 'changed'),
    /lostReadingPositions/,
  );
});
