import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../scripts/video-order.mjs';
import {
  finalizeVideoReport,
  videoChapterSummary,
  saveVideoReview,
} from '../scripts/video-review.mjs';

test('video summaries deduplicate valid evidence and keep unobserved choices pending', () => {
  const file = 'content/entry--chapter.json';
  const rows = [
    {
      id: 'dialogue',
      type: 'dialogue',
      text: '정확한 공식 한국어 원문이 유일하게 일치한 대사입니다',
      bwikiStatus: 'review',
    },
    {
      id: 'observed-choice',
      type: 'choice',
      text: '확인한 선택지',
      videoStatus: 'screen-matched',
      videoNextIds: ['reply'],
    },
    {
      id: 'other-choice',
      type: 'choice',
      text: '확인하지 못한 다른 선택지',
      bwikiStatus: 'review',
    },
  ];
  const chapter = { file, videos: [{ id: 'SsuDCp8nYEw' }], unresolvedWikiSections: 0 };
  const evidence = {
    file,
    videoId: 'SsuDCp8nYEw',
    matches: [{ rowId: 'dialogue', koreanHash: sha256(rows[0].text), startMs: 0, endMs: 1000 }],
  };
  const screen = { file, matches: [{ rowId: 'observed-choice' }] };
  const summary = videoChapterSummary(
    chapter,
    rows,
    [evidence, evidence, { ...evidence, videoId: 'unregistered' }],
    [screen, screen],
  );
  assert.equal(summary.captionMatches, 1);
  assert.equal(summary.screenMatches, 1);
  assert.equal(summary.status, 'partial-screen-order-matched');
  assert.equal(summary.pending, true);
  assert.deepEqual(summary.unresolvedChoiceResponseIds, ['other-choice']);
  assert.deepEqual(summary.unresolvedRowIds, ['dialogue', 'other-choice']);
  assert.equal(
    videoChapterSummary(chapter, rows, [
      { ...evidence, matches: [{ ...evidence.matches[0], koreanHash: 'stale' }] },
    ]).captionMatches,
    0,
  );
  assert.equal(
    videoChapterSummary(chapter, [{ id: 'reference', type: 'narration', text: '단독 기록' }])
      .pending,
    false,
  );
  assert.equal(
    videoChapterSummary(chapter, [
      {
        id: 'intro',
        type: 'narration',
        text: '소개',
        source: 'ExcelOutput/MissionChapterConfig.json:1',
      },
    ]).pending,
    true,
  );
  const report = {
    chapters: { [file]: { ...chapter } },
    evidence: [evidence],
    screenEvidence: [screen],
    integrationReview: [{ reason: 'conflict' }, { reason: 'conflict' }],
    checkedAt: '2026-10-18T00:00:00Z',
    checks: {},
  };
  finalizeVideoReport(report, new Map([[file, { rows }]]), 0);
  assert.equal(report.integrationReview.length, 1);
  assert.equal(report.chapters[file].file, undefined);
  assert.equal(report.retry.needed, true);
});

test('video persistence keeps existing text and BWIKI fields, synchronizes order, and records all derived files', async () => {
  const parent = path.resolve('.cache/tests');
  await fs.mkdir(parent, { recursive: true });
  const folder = await fs.mkdtemp(path.join(parent, 'video-review-'));
  const read = async (file) => JSON.parse(await fs.readFile(path.join(folder, file)));
  try {
    await fs.mkdir(path.join(folder, 'public/content'), { recursive: true });
    await fs.writeFile(
      path.join(folder, 'public/content/search-index.json'),
      JSON.stringify({
        rows: [
          {
            id: 'a',
            text: '원문 A',
            bwikiStatus: 'cached',
            videoStatus: 'caption-matched',
            videoId: 'old',
          },
          { id: 'b', text: '원문 B' },
        ],
      }),
    );
    await fs.writeFile(
      path.join(folder, 'receipt.json'),
      JSON.stringify({ files: ['public/content-update.json'] }),
    );
    const changed = new Map([
      [
        'content/entry--chapter.json',
        [
          {
            id: 'b',
            text: '원문 B',
            videoStatus: 'screen-matched',
            videoScene: 'scene',
            videoNextIds: ['a'],
          },
          { id: 'a', text: '원문 A' },
        ],
      ],
    ]);
    await saveVideoReview(
      folder,
      { commit: 'a'.repeat(40), checkedAt: '2026-10-18T00:00:00Z', chapters: {} },
      changed,
    );
    const search = await read('public/content/search-index.json');
    assert.deepEqual(
      search.rows.map((row) => row.id),
      ['b', 'a'],
    );
    assert.equal(search.rows[1].text, '원문 A');
    assert.equal(search.rows[1].bwikiStatus, 'cached');
    assert.equal(search.rows[1].videoStatus, undefined);
    assert.deepEqual(search.rows[0].videoNextIds, ['a']);
    assert.deepEqual((await read('receipt.json')).files, [
      'public/content-update.json',
      'public/content/entry--chapter.json',
      'public/content/search-index.json',
      'public/video-order-provenance.json',
      'public/video-review-summary.json',
    ]);
  } finally {
    assert.ok(folder.startsWith(parent + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
