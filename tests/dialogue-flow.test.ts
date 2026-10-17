import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { choiceDialogue, isDialogueRows, type DialogueRow } from '../src/lib/dialogue.ts';

const row = (id: string, type: DialogueRow['type'], nextIds: string[]): DialogueRow => ({
  id,
  entryId: 'entry',
  chapterId: 'chapter',
  mission: 'mission',
  scene: id,
  source: id,
  speaker: 'speaker',
  text: id,
  type,
  nextIds,
  flowStatus: 'verified',
  flowScene: 'scene',
});

test('selected choice follows only its response and common continuation across source boundaries', () => {
  const rows = [
    row('a', 'choice', ['a-reply']),
    row('b', 'choice', ['b-reply']),
    row('b-reply', 'dialogue', ['common']),
    row('a-reply', 'dialogue', ['common']),
    row('common', 'dialogue', ['next-choice']),
    row('next-choice', 'choice', []),
  ];
  assert.deepEqual(
    choiceDialogue(rows, 0).map((item) => item.id),
    ['a', 'a-reply', 'common'],
  );
  assert.deepEqual(
    choiceDialogue(rows, 1).map((item) => item.id),
    ['b', 'b-reply', 'common'],
  );
  assert.deepEqual(
    choiceDialogue(rows, 0, 2).map((item) => item.id),
    ['a', 'a-reply'],
  );
  rows[3].flowScene = 'foreign';
  assert.deepEqual(
    choiceDialogue(rows, 0).map((item) => item.id),
    ['a'],
  );
});

test('malformed links fail validation and cyclic response links stop safely', () => {
  const rows = [row('a', 'choice', ['reply']), row('reply', 'dialogue', ['reply'])];
  assert.equal(isDialogueRows(rows), true);
  assert.equal(isDialogueRows([{ ...rows[0], nextIds: [1] }]), false);
  assert.deepEqual(
    choiceDialogue(rows, 0).map((item) => item.id),
    ['a', 'reply'],
  );
});

test('screen-observed single choice uses its own response graph while preserving official and BWIKI graphs', () => {
  const rows = [
    row('choice', 'choice', []),
    row('reply', 'dialogue', []),
    row('other-choice', 'choice', []),
  ];
  for (const item of rows) {
    item.flowStatus = 'review';
    item.videoStatus = 'screen-matched';
    item.videoScene = 'video-scene';
  }
  rows[0].bwikiStatus = 'cached';
  rows[0].bwikiScene = 'wiki-scene';
  rows[0].videoNextIds = ['reply'];
  rows[1].videoNextIds = ['other-choice'];
  assert.equal(isDialogueRows(rows), true);
  assert.deepEqual(
    choiceDialogue(rows, 0).map((item) => item.id),
    ['choice', 'reply'],
  );
  rows[1].videoScene = 'foreign-event';
  assert.deepEqual(
    choiceDialogue(rows, 0).map((item) => item.id),
    ['choice'],
  );
  rows[0].bwikiNextIds = ['reply'];
  assert.deepEqual(
    choiceDialogue(rows, 0).map((item) => item.id),
    ['choice'],
  );
  assert.equal(isDialogueRows([{ ...rows[0], videoStatus: 'title-linked' }]), false);
  assert.equal(isDialogueRows([{ ...rows[0], videoNextIds: [1] }]), false);
});

test('safe restoration validates actual markers and never changes unresolved text', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_dialogue_flow.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});

test('published flow links stay inside the verified scene and uncertain row positions are preserved', () => {
  const metadata = JSON.parse(fs.readFileSync('src/data/imported-content.json', 'utf8'));
  const simulation = JSON.parse(fs.readFileSync('src/data/simulation.json', 'utf8'));
  const specs: { file: string }[] = [
    ...(Object.values(metadata) as { file: string }[]),
    ...simulation.flatMap((entry: { chapters: { content: { file: string } }[] }) =>
      entry.chapters.map((chapter) => chapter.content),
    ),
  ];
  let verifiedChoices = 0;
  for (const spec of specs) {
    const payload = JSON.parse(fs.readFileSync('public/' + spec.file, 'utf8'));
    if (!payload.referenceOrder) continue;
    const rows = payload.rows as DialogueRow[];
    const byId = new Map(rows.map((item) => [item.id, item]));
    assert.deepEqual(new Set(payload.referenceOrder), new Set(byId.keys()));
    rows.forEach((item, index) => {
      if (
        item.flowStatus === 'review' &&
        !['matched', 'cached'].includes(item.bwikiStatus ?? '') &&
        !['caption-matched', 'screen-matched'].includes(item.videoStatus ?? '')
      ) {
        assert.equal(item.id, payload.referenceOrder[index]);
        assert.equal(item.nextIds, undefined);
      }
      for (const target of item.nextIds ?? []) {
        const next = byId.get(target)!;
        assert.ok(next);
        assert.equal(next.flowScene, item.flowScene);
        assert.equal(next.flowStatus, 'verified');
        assert.equal(next.mission, item.mission);
      }
      if (item.type === 'choice' && item.flowStatus === 'verified') verifiedChoices++;
    });
  }
  assert.ok(verifiedChoices > 100);
});

test('reported choice opens its remote response and the unsupported act-three timeline remains under review', () => {
  const fourth = JSON.parse(
    fs.readFileSync('public/content/paradise-records--river-of-oblivion.json', 'utf8'),
  );
  const chosen = fourth.rows.findIndex((item: { talkId: number }) => item.talkId === 153021002);
  const context = choiceDialogue(fourth.rows, chosen);
  assert.ok(context.some((item) => item.text === '응, 당연하지'));
  assert.ok(!context.some((item) => item.text.startsWith('조금. 하지만 Mar. 7th')));
  const third = JSON.parse(
    fs.readFileSync('public/content/paradise-records--laughter.json', 'utf8'),
  );
  const reported = third.rows.find((item: { talkId: number }) => item.talkId === 152120005);
  assert.equal(reported.flowStatus, 'review');
  assert.ok(third.referenceOrder.includes(reported.id));
});
