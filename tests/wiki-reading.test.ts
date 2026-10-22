import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  readingRows,
  isWikiReading,
  positionKey,
  type WikiReading,
} from '../src/lib/wiki-reading.ts';
import {
  choiceDialogue,
  nearbyDialogue,
  dialoguePage,
  type DialogueRow,
} from '../src/lib/dialogue.ts';

const row = (id: string, type: DialogueRow['type'] = 'dialogue'): DialogueRow => ({
  id,
  type,
  entryId: 'entry',
  chapterId: 'chapter',
  mission: '임무',
  scene: 'old',
  speaker: '화자',
  text: id,
  flowBoundary: true,
  flowStatus: 'review',
});
const pos = (id: string, rowId: string, branch: string[] = [], nextIds: string[] = []) => ({
  id,
  rowId,
  branch,
  nextIds,
  replyToIds: branch,
  missionId: 'group',
  mission: '임무',
  sceneId: 'scene',
  scene: '목표',
  page: '任务',
  revision: 5,
  location: [0, 1],
  conditions: [],
  status: 'wiki-display' as const,
});
const reading: WikiReading = {
  schema: 'hsr-wiki-reading.v1',
  missions: [{ id: 'group', title: '임무', page: '任务', officialMissionIds: [11] }],
  occurrences: [
    pos('choice-left', 'left', [], ['response-left']),
    pos('choice-right', 'right', [], ['response-right']),
    pos('response-left', 'shared', ['choice-left']),
    pos('response-right', 'shared', ['choice-right']),
  ],
  unplaced: [{ id: 'quest-11', title: '임무', rowIds: ['unknown'] }],
};

test('occurrence display preserves canonical IDs and selects only the clicked repeated response', () => {
  const canonical = [row('left', 'choice'), row('right', 'choice'), row('shared'), row('unknown')];
  const before = structuredClone(canonical);
  assert.ok(isWikiReading(reading, canonical));
  const rows = readingRows(canonical, reading);
  assert.deepEqual(canonical, before);
  assert.equal(rows.filter((r) => r.id === 'shared').length, 2);
  assert.notEqual(positionKey(rows[2]), positionKey(rows[3]));
  assert.deepEqual(choiceDialogue(rows, 0).map(positionKey), ['choice-left', 'response-left']);
  assert.deepEqual(choiceDialogue(rows, 1).map(positionKey), ['choice-right', 'response-right']);
  assert.deepEqual(
    nearbyDialogue(rows, 4).map((r) => r.id),
    ['unknown'],
  );
  assert.equal(dialoguePage(rows, 'shared', 2), 2);
  assert.equal(rows[0].flowStatus, 'review');
});

test('reading schema rejects lost canonical IDs and links to unknown occurrences', () => {
  const rows = [row('left', 'choice'), row('right', 'choice'), row('shared'), row('unknown')];
  const changed = structuredClone(reading);
  changed.occurrences[0].nextIds = ['missing'];
  assert.equal(isWikiReading(changed, rows), false);
  const lost = structuredClone(reading);
  lost.unplaced = [];
  assert.equal(isWikiReading(lost, rows), false);
});

test('missing BWIKI positions stay in their mission unknown area with original evidence preserved', () => {
  const canonical = [
    row('left', 'choice'),
    row('right', 'choice'),
    row('shared'),
    { ...row('unknown'), bwikiStatus: 'cached' as const },
  ];
  const display = readingRows(canonical, reading);
  assert.equal(display[4].wikiUnplaced?.id, 'quest-11');
  assert.equal(display[4].wikiLegacy, undefined);
  assert.equal(display[4].bwikiStatus, 'cached');
  assert.deepEqual(canonical[3].bwikiStatus, 'cached');
});

test('BWIKI positions and branch replies are invariant under opposing official execution order', () => {
  const canonical = [row('left', 'choice'), row('right', 'choice'), row('shared'), row('unknown')];
  const opposed = { schema: 'hsr-execution-reading.v1' as const,
    occurrences: [], placements: [{ beforeRowId: 'left', contextIds: [], occurrenceIds: [] }] };
  assert.deepEqual(readingRows(canonical, reading, opposed), readingRows(canonical, reading));
});

test('placement rejects unimported ambiguity, cross-boundary replies and canonical text mutation', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_bwiki_placement.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});
