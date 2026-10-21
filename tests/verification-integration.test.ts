import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compareVerification,
  assertVerificationPreserved,
  baselineChoice,
  verificationRows,
  restoreVideoOrder,
} from '../scripts/verification-integration.mjs';
import { publishDerivedFiles } from '../scripts/content-publication.mjs';
import { sha256, validatedCaptionMatches } from '../scripts/video-order.mjs';

test('equal verification labels cannot hide a changed branch or reversed proven order', () => {
  const before = new Map([
    [
      'choice',
      {
        id: 'choice',
        text: '선택지',
        type: 'choice',
        bwikiStatus: 'matched',
        bwikiScene: 'same-scene',
        bwikiNextIds: ['reply'],
      },
    ],
    [
      'reply',
      {
        id: 'reply',
        text: '응답',
        type: 'dialogue',
        bwikiStatus: 'matched',
        bwikiScene: 'same-scene',
        bwikiReplyToIds: ['choice'],
      },
    ],
  ]);
  const changed = structuredClone(before);
  changed.get('choice')!.bwikiNextIds = ['other'];
  assert.equal(baselineChoice(before, changed), 'conflict');
  assert.throws(
    () => assertVerificationPreserved(compareVerification(before, changed), 'Retry'),
    /conflictingLinks/,
  );
  const reversed = new Map([...before].reverse());
  assert.equal(baselineChoice(before, reversed), 'conflict');
  assert.throws(
    () => assertVerificationPreserved(compareVerification(before, reversed), 'Retry'),
    /conflictingOrder/,
  );
  const cached = new Map([...before].map(([id, row]) => [id, { ...row, bwikiStatus: 'cached' }]));
  assert.equal(compareVerification(before, cached).changed, false);
  assert.equal(baselineChoice(before, cached), 'published');
});

test('independent scene movement and newly verified rows do not claim an unproven global order', () => {
  const before = new Map([
    ['a', { id: 'a', text: '장면 1', flowStatus: 'verified', flowScene: 'scene-1' }],
    ['b', { id: 'b', text: '장면 2', flowStatus: 'verified', flowScene: 'scene-2' }],
  ]);
  const after = new Map([...before].reverse());
  assert.doesNotThrow(() =>
    assertVerificationPreserved(compareVerification(before, after), 'Update'),
  );
  assert.equal(baselineChoice(before, after), 'published');
  const branches = new Map([
    ['a', { id: 'a', text: '독립 분기 1', flowStatus: 'verified', flowScene: 'same-scene' }],
    ['b', { id: 'b', text: '독립 분기 2', flowStatus: 'verified', flowScene: 'same-scene' }],
  ]);
  assert.doesNotThrow(() =>
    assertVerificationPreserved(
      compareVerification(branches, new Map([...branches].reverse())),
      'Update',
    ),
  );
});

test('flow and video evidence participate in preservation, change detection and baseline selection', () => {
  const before = new Map([
    [
      'row',
      {
        id: 'row',
        text: '원문',
        flowStatus: 'verified',
        nextIds: ['reply'],
        videoStatus: 'caption-matched',
        videoId: 'video',
        videoStartMs: 10,
      },
    ],
  ]);
  for (const field of ['flowStatus', 'videoStatus', 'nextIds']) {
    const changed = structuredClone(before);
    delete changed.get('row')![field];
    const comparison = compareVerification(before, changed);
    assert.equal(comparison.changed, true);
    assert.throws(() => assertVerificationPreserved(comparison, 'Update'));
    assert.equal(baselineChoice(before, changed), 'repository');
  }
  const confirmed = new Map([['row', { id: 'row', text: '원문', videoStatus: 'caption-matched' }]]);
  assert.equal(
    compareVerification(new Map([['row', { id: 'row', text: '원문' }]]), confirmed).changed,
    true,
  );
});

test('recovery retains repeated wiki positions and display links even with identical canonical rows', async () => {
  const parent = path.resolve('.cache/tests');
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'wiki-recovery-'));
  try {
    await fs.mkdir(path.join(folder, 'public/content'), { recursive: true });
    const file = path.join(folder, 'public/content/chapter.json');
    const rows = [
      { id: 'choice', type: 'choice', text: '선택지' },
      { id: 'reply', text: '응답' },
    ];
    await fs.writeFile(file, JSON.stringify({ schema: 'hsr-dialogue.v1', rows }));
    const old = await verificationRows(folder);
    const reading = {
      occurrences: [
        { id: 'a', page: '任务', rowId: 'choice', sceneId: 'scene', nextIds: ['b'] },
        { id: 'b', page: '任务', rowId: 'reply', sceneId: 'scene', nextIds: [] },
        { id: 'c', page: '任务', rowId: 'reply', sceneId: 'another', nextIds: [] },
      ],
    };
    await fs.writeFile(
      file,
      JSON.stringify({ schema: 'hsr-dialogue.v1', rows, wikiReading: reading }),
    );
    const improved = await verificationRows(folder);
    assert.equal(compareVerification(old, improved).changed, true);
    assert.equal(baselineChoice(improved, old), 'repository');
    assert.equal(baselineChoice(old, improved), 'published');
    const repeated = structuredClone(improved);
    repeated.wikiReadings = structuredClone(improved.wikiReadings);
    repeated.wikiReadings['content/chapter.json'].occurrences.pop();
    assert.throws(
      () => assertVerificationPreserved(compareVerification(improved, repeated), 'Recovery'),
      /lostReadingPositions/,
    );
    const noReply = structuredClone(improved);
    noReply.wikiReadings = structuredClone(improved.wikiReadings);
    noReply.wikiReadings['content/chapter.json'].occurrences[0].nextIds = [];
    assert.throws(
      () => assertVerificationPreserved(compareVerification(improved, noReply), 'Recovery'),
      /lostReadingLinks/,
    );
    const moved = structuredClone(improved);
    moved.wikiReadings = structuredClone(improved.wikiReadings);
    moved.wikiReadings['content/chapter.json'].occurrences[0].sceneId = 'other';
    assert.throws(
      () => assertVerificationPreserved(compareVerification(improved, moved), 'Recovery'),
      /conflictingReadingPositions/,
    );
  } finally {
    assert.ok(folder.startsWith(parent + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('caption counts and integration reject stale, duplicate, choice, short and unresolved evidence alike', () => {
  const rows = [
    {
      id: 'valid',
      type: 'dialogue',
      text: '원문의 긴 문장이 일치하면 검증 근거로 사용할 수 있습니다.',
    },
    { id: 'choice', type: 'choice', text: '선택지는 한국어 음성 자막만으로 검증하지 않습니다.' },
    { id: 'short', type: 'dialogue', text: '짧은 문장' },
    {
      id: 'token',
      type: 'dialogue',
      text: '{UNRESOLVED} 치환이 남아 있는 긴 문장은 자동으로 확인하지 않습니다.',
    },
  ];
  const matches = rows.map((row, i) => ({
    rowId: row.id,
    startMs: i * 10000,
    endMs: i * 10000 + 1000,
    koreanHash: sha256(row.text),
  }));
  assert.deepEqual(
    validatedCaptionMatches(rows, { matches }).map((item) => item.rowId),
    ['valid'],
  );
  assert.deepEqual(validatedCaptionMatches(rows, { matches: [matches[0], matches[0]] }), []);
  assert.deepEqual(
    validatedCaptionMatches(rows, { matches: [{ ...matches[0], koreanHash: 'stale' }] }),
    [],
  );
});

test('video integration cannot move a foreign mission between anchors or miss interleaved conflicts', () => {
  const row = (id: string, mission: string, matched = true) => ({
    id,
    text: `각 행의 한국어 원문을 그대로 보존하는 긴 문장입니다 ${id}`,
    type: 'dialogue',
    missionId: mission,
    bwikiMissionId: matched ? mission : undefined,
    bwikiStatus: matched ? 'matched' : 'review',
    flowStatus: 'review',
  });
  const a = row('a', 'quest-11'),
    b = row('b', 'quest-11'),
    foreign = row('foreign', 'quest-22', false);
  const evidence = (rows: (typeof a)[]) => ({
    videoId: 'video',
    matches: rows.map((row, i) => ({
      rowId: row.id,
      startMs: i * 10000,
      endMs: i * 10000 + 1000,
      koreanHash: sha256(row.text),
    })),
  });
  const payload = { rows: [foreign, a, b] };
  const before = structuredClone(payload);
  assert.equal(restoreVideoOrder(payload, evidence([a, foreign, b])).confirmed, 0);
  assert.deepEqual(payload, before);
  const other = row('other', 'quest-22');
  const conflict = { rows: [a, other, b] };
  const original = structuredClone(conflict);
  assert.equal(restoreVideoOrder(conflict, evidence([b, other, a])).conflict, true);
  assert.deepEqual(conflict, original);
});

test('publication preflights the whole receipt and preserves exact bytes on invalid or incomplete output', async () => {
  const parent = path.resolve('.cache/tests');
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'publication-'));
  const root = path.join(folder, 'root'),
    stage = path.join(folder, 'stage');
  const first = 'public/content-update.json',
    late = 'public/bwiki-provenance.json';
  try {
    await fs.mkdir(path.join(root, 'public'), { recursive: true });
    await fs.mkdir(path.join(stage, 'public'), { recursive: true });
    const exact = '{"hash":18446744073709551615}';
    await fs.writeFile(path.join(root, first), exact);
    await fs.writeFile(path.join(stage, first), '{"changed":true}');
    await assert.rejects(publishDerivedFiles(root, stage, [first, '../raw.json']), /Unsafe/);
    await assert.rejects(publishDerivedFiles(root, stage, [first, late]), /ENOENT/);
    assert.equal(await fs.readFile(path.join(root, first), 'utf8'), exact);
    await fs.writeFile(path.join(stage, first), exact + '\n');
    await publishDerivedFiles(root, stage, [first, first]);
    assert.equal(await fs.readFile(path.join(root, first), 'utf8'), exact);
    await fs.mkdir(path.join(root, 'public/content'), { recursive: true });
    for (const name of ['a', 'b'])
      await fs.writeFile(
        path.join(root, `public/content/${name}.json`),
        JSON.stringify({ schema: 'hsr-dialogue.v1', rows: [{ id: 'duplicate' }] }),
      );
    await assert.rejects(verificationRows(root), /Duplicate verification row/);
  } finally {
    assert.ok(folder.startsWith(parent + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('final stage validation rejects stale search, branch, metadata and localization contracts', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_content_stage.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});
