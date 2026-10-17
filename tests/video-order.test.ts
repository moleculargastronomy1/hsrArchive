import {
  restoreVideoOrder,
  restoreVideoMissions,
  applyScreenEvidence,
  compareVerification,
  assertVerificationPreserved,
} from '../scripts/verification-integration.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  jsonAfter,
  playlistItems,
  captionCues,
  matchCaptions,
  sha256,
  fetchPublicCaptions,
  selectVideoChecks,
  videoRetryDecision,
  parseTranscriptExport,
  mergeVideoChecks,
} from '../scripts/video-order.mjs';

test('video retry is independent of BWIKI changes and honors persisted failure backoff', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  const report = {
    chapters: {
      pending: { status: 'partial-screen-order-matched', videos: [{ id: 'a' }, { id: 'b' }] },
      complete: { status: 'bwiki-matched', videos: [{ id: 'c' }] },
      reference: { status: 'reference-only', videos: [{ id: 'd' }] },
    },
    checks: { a: { checkedAt: '2026-10-16T00:00:00Z', nextRetryAt: '2026-10-19T00:00:00Z' } },
  };
  assert.deepEqual(videoRetryDecision(report, now).due, ['b']);
  const queue = ['a', 'b', 'b', 'c'].map((id) => ({ video: { id } }));
  assert.deepEqual(
    selectVideoChecks(queue, report.checks, new Date(now).toISOString(), 1).map(
      (item) => item.video.id,
    ),
    ['b'],
  );
  report.checks.b = { checkedAt: '2026-10-18T00:00:00Z' };
  assert.equal(videoRetryDecision(report, now).needed, false);
  assert.equal(
    mergeVideoChecks(
      { a: { checkedAt: '2026-10-18T00:00:00Z' } },
      { a: { checkedAt: '2026-10-17T00:00:00Z' } },
    ).a.checkedAt,
    '2026-10-18T00:00:00Z',
  );
});

test('public transcript exports preserve source identity, Korean language and timestamp precision', () => {
  const raw =
    'YouTube transcript\nVideo ID: SsuDCp8nYEw\nLanguage: ko\nCaptions: auto-generated\n\n[1:02] 한국어 첫 대사\n[1:03] 다음 대사';
  const parsed = parseTranscriptExport(raw, 'SsuDCp8nYEw');
  assert.deepEqual(parsed.cues, [
    { startMs: 62000, endMs: 63000, text: '한국어 첫 대사' },
    { startMs: 63000, endMs: 63000, text: '다음 대사' },
  ]);
  assert.equal(parsed.kind, 'asr');
  assert.equal(parsed.timingPrecisionMs, 1000);
  assert.throws(() => parseTranscriptExport(raw, 'exzWuZ3hdoM'));
  assert.throws(() =>
    parseTranscriptExport(raw.replace('Language: ko', 'Language: en'), 'SsuDCp8nYEw'),
  );
  assert.throws(() => parseTranscriptExport(raw.replace('[1:03]', '[0:03]'), 'SsuDCp8nYEw'));
});

test('one conflicting video mission cannot override anchors or prevent another independently anchored mission', () => {
  const row = (id, mission, matched = true) => ({
    id,
    missionId: mission,
    bwikiMissionId: mission,
    bwikiStatus: matched ? 'matched' : 'review',
    bwikiScene: mission,
    flowStatus: 'review',
    type: 'dialogue',
    text: `공식 원문은 언제나 변경 없이 정확하게 보존되어야 합니다 ${id}`,
  });
  const a = row('a', 'quest-1'),
    b = row('b', 'quest-1'),
    c = row('c', 'quest-1', false),
    x = row('x', 'quest-2'),
    y = row('y', 'quest-2'),
    z = row('z', 'quest-2', false);
  const payload = { rows: [c, a, b, z, x, y] };
  const original = structuredClone(payload);
  const evidence = {
    videoId: 'SsuDCp8nYEw',
    matches: [b, c, a, x, z, y].map((row, index) => ({
      rowId: row.id,
      koreanHash: sha256(row.text),
      startMs: index * 10000,
      endMs: index * 10000 + 1000,
    })),
  };
  const result = restoreVideoMissions(payload, evidence);
  assert.deepEqual(result.conflicts, ['quest-1']);
  assert.equal(result.confirmed, 1);
  assert.deepEqual(payload.rows.slice(0, 3), original.rows.slice(0, 3));
  assert.deepEqual(
    payload.rows.slice(3).map((row) => row.id),
    ['x', 'z', 'y'],
  );
  assertVerificationPreserved(
    compareVerification(
      new Map(original.rows.map((row) => [row.id, row])),
      new Map(payload.rows.map((row) => [row.id, row])),
    ),
    'Test',
  );
});

test('screen path requires exact official roles and scene, all consecutive edges and an observed choice', () => {
  const rows = [
    {
      id: 'a',
      talkId: 10,
      type: 'dialogue',
      text: '화면에서 확인한 공식 첫 대사',
      flowStatus: 'review',
      missionId: 'quest-1',
      source: 'official-scene',
    },
    {
      id: 'b',
      talkId: 20,
      type: 'choice',
      text: '화면의 유일한 선택지',
      bwikiStatus: 'cached',
      bwikiScene: 'wiki-b',
      missionId: 'quest-1',
      source: 'official-scene',
    },
    {
      id: 'c',
      talkId: 30,
      type: 'dialogue',
      text: '선택 후 화면에서 확인한 응답',
      flowStatus: 'review',
      missionId: 'quest-1',
      source: 'official-scene',
    },
  ];
  const proof = {
    method: 'reviewed-screen-path',
    videoId: 'exzWuZ3hdoM',
    source: 'official-scene',
    missionId: 'quest-1',
    matches: rows.map((row, index) => ({
      rowId: row.id,
      talkId: row.talkId,
      type: row.type,
      koreanHash: sha256(row.text),
      startMs: index * 1000,
      frameSha256: 'a'.repeat(64),
    })),
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', selection: 'observed-single-option' },
    ],
  };
  const payload = { rows: structuredClone(rows) };
  assert.equal(applyScreenEvidence(payload, proof).confirmed, 2);
  assert.deepEqual(payload.rows[1].videoNextIds, ['c']);
  assert.deepEqual(payload.rows[2].videoReplyToIds, ['b']);
  assert.equal(payload.rows[1].bwikiStatus, 'cached');
  assertVerificationPreserved(
    compareVerification(
      new Map(rows.map((row) => [row.id, row])),
      new Map(payload.rows.map((row) => [row.id, row])),
    ),
    'Test',
  );
  const cases = [
    { ...proof, edges: [] },
    {
      ...proof,
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    },
    { ...proof, missionId: 'quest-2' },
    {
      ...proof,
      matches: proof.matches.map((match, index) =>
        index === 1 ? { ...match, type: 'dialogue' } : match,
      ),
    },
    {
      ...proof,
      matches: proof.matches.map((match, index) =>
        index === 2 ? { ...match, koreanHash: 'stale' } : match,
      ),
    },
  ];
  for (const evidence of cases) {
    const candidate = { rows: structuredClone(rows) };
    assert.ok(applyScreenEvidence(candidate, evidence).reason);
    assert.deepEqual(candidate.rows, rows);
  }
  const conflicting = { rows: structuredClone(rows) };
  conflicting.rows[1].bwikiNextIds = ['other'];
  const before = structuredClone(conflicting);
  assert.equal(applyScreenEvidence(conflicting, proof).reason, 'screen-order-conflict');
  assert.deepEqual(conflicting, before);
});

test('video review rotates past recent failures, deduplicates videos and retries after a day', () => {
  const queue = ['latest', 'old', 'old', 'unseen'].map((id) => ({ video: { id } }));
  const checks = { latest: { checkedAt: '2026-10-17T00:00:00Z' } };
  assert.deepEqual(
    selectVideoChecks(queue, checks, '2026-10-17T06:00:00Z').map((item) => item.video.id),
    ['old', 'unseen'],
  );
  assert.deepEqual(
    selectVideoChecks(queue, checks, '2026-10-18T00:00:00Z').map((item) => item.video.id),
    ['latest', 'old'],
  );
});

test('BWIKI chapter import preserves official IDs, subtitles, conditional branches and cached evidence', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_bwiki_chapters.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});

test('public playlist parsing reads JSON without executing scripts and follows only browse continuation', () => {
  assert.deepEqual(
    jsonAfter('var data = {"text":"}; evil()", "nested":{"x":1}}; evil()', 'var data ='),
    { text: '}; evil()', nested: { x: 1 } },
  );
  assert.throws(() => jsonAfter('var data = {', 'var data ='));
  const result = playlistItems({
    a: {
      lockupViewModel: {
        contentId: 'SsuDCp8nYEw',
        metadata: { lockupMetadataViewModel: { title: { content: '스토리' } } },
      },
    },
    b: {
      innertubeCommand: {
        commandMetadata: { webCommandMetadata: { apiUrl: '/youtubei/v1/browse' } },
        continuationCommand: { token: 'next' },
      },
    },
    c: {
      innertubeCommand: {
        commandMetadata: { webCommandMetadata: { apiUrl: '/untrusted' } },
        continuationCommand: { token: 'wrong' },
      },
    },
  });
  assert.equal(result.videos[0].id, 'SsuDCp8nYEw');
  assert.deepEqual(result.tokens, ['next']);
});

test('caption matches require exact long unique Korean text and never match choices or distant fragments', () => {
  const rows = [
    { id: 'a', type: 'dialogue', text: '우리는 오늘 다시 우주를 향해 새로운 모험을 시작합니다.' },
    {
      id: 'b',
      type: 'dialogue',
      text: '이것은 아주 오래전부터 우리에게 전해져 내려온 이야기입니다.',
    },
    {
      id: 'choice',
      type: 'choice',
      text: '이 선택지의 긴 문장은 음성만으로 선택지 표시를 증명하지 못합니다.',
    },
  ];
  const cues = captionCues({
    events: rows.map((row, i) => ({
      tStartMs: i * 40000,
      dDurationMs: 3000,
      segs: [{ utf8: row.text }],
    })),
  });
  assert.deepEqual(
    matchCaptions(rows, cues).map((item) => item.rowId),
    ['a', 'b'],
  );
  assert.deepEqual(matchCaptions([rows[0], { ...rows[0], id: 'duplicate' }], cues), []);
  assert.deepEqual(
    matchCaptions(
      [rows[0]],
      [
        { startMs: 0, endMs: 1000, text: rows[0].text.slice(0, 10) },
        { startMs: 60000, endMs: 61000, text: rows[0].text.slice(10) },
      ],
    ),
    [],
  );
});

test('video ordering moves only bracketed review rows, preserving all BWIKI anchor order and original text', () => {
  const row = (id, status) => ({
    id,
    text: `충분히 긴 고유 대사 ${id}의 원문을 그대로 보존합니다`,
    type: 'dialogue',
    bwikiStatus: status,
    bwikiMissionId: 'quest-11',
    flowStatus: 'review',
  });
  const a = row('a', 'matched'),
    b = row('b', 'matched'),
    c = row('c', 'review'),
    other = row('other', 'matched');
  const payload = { rows: [c, other, a, b] };
  const evidence = {
    videoId: 'SsuDCp8nYEw',
    matches: [a, c, b].map((row, index) => ({
      rowId: row.id,
      startMs: index * 10000,
      endMs: index * 10000 + 1000,
      koreanHash: sha256(row.text),
    })),
  };
  const before = new Map(payload.rows.map((row) => [row.id, row.text]));
  assert.ok(restoreVideoOrder(payload, evidence).confirmed > 0);
  const confirmed = structuredClone(payload);
  assert.equal(restoreVideoOrder(payload, evidence).confirmed, 0);
  assert.deepEqual(payload, confirmed);
  assert.deepEqual(
    payload.rows.map((row) => row.id),
    ['other', 'a', 'c', 'b'],
  );
  assert.ok(payload.rows.every((row) => row.text === before.get(row.id)));
  const conflict = {
    ...evidence,
    matches: [...evidence.matches]
      .reverse()
      .map((match, i) => ({ ...match, startMs: i * 10000, endMs: i * 10000 + 1000 })),
  };
  assert.equal(restoreVideoOrder(payload, conflict).conflict, true);
  assert.equal(
    restoreVideoOrder(payload, {
      ...evidence,
      matches: evidence.matches.map((match) => ({ ...match, koreanHash: 'stale' })),
    }).confirmed,
    0,
  );
});

test('unavailable public captions stop without downloading video or bypassing access restrictions', async () => {
  let calls = 0;
  await assert.rejects(
    fetchPublicCaptions(
      { id: 'SsuDCp8nYEw', url: 'https://www.youtube.com/watch?v=SsuDCp8nYEw' },
      'channel',
      async () => {
        calls++;
        return new Response('', { status: 403 });
      },
    ),
  );
  assert.equal(calls, 1);
});
