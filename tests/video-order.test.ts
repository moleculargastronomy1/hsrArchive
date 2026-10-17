import { restoreVideoOrder } from '../scripts/verification-integration.mjs';
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
} from '../scripts/video-order.mjs';

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
