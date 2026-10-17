import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { choiceDialogue, isDialogueRows, type DialogueRow } from '../src/lib/dialogue.ts';
import { fetchBwiki } from '../scripts/fetch-bwiki.mjs';

test('BWIKI templates, exact integer joins and offline fallback preserve Korean originals', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_bwiki_dialogue.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});

test('BWIKI navigation is distinct from game execution verification', () => {
  const row = (id: string, type: DialogueRow['type'], next: string[]): DialogueRow => ({
    id,
    entryId: 'entry',
    chapterId: 'chapter',
    mission: 'mission',
    scene: id,
    speaker: 'speaker',
    text: id,
    type,
    flowStatus: 'review',
    bwikiStatus: 'matched',
    bwikiScene: 'wiki',
    bwikiNextIds: next,
    bwikiPage: 'page',
    bwikiRevision: 4,
  });
  const rows = [
    row('choice', 'choice', ['reply']),
    row('other', 'dialogue', []),
    row('reply', 'dialogue', []),
  ];
  assert.equal(isDialogueRows(rows), true);
  assert.deepEqual(
    choiceDialogue(rows, 0).map((row) => row.id),
    ['choice', 'reply'],
  );
  assert.equal(isDialogueRows([{ ...rows[0], bwikiNextIds: [1] }]), false);
  rows[2].bwikiScene = 'foreign';
  assert.deepEqual(
    choiceDialogue(rows, 0).map((row) => row.id),
    ['choice'],
  );
  rows[2].bwikiScene = 'wiki';
  rows[0].bwikiMissionId = 'quest-11';
  rows[2].bwikiMissionId = 'quest-11';
  rows[2].mission = 'misattributed source mission';
  assert.deepEqual(
    choiceDialogue(rows, 0).map((row) => row.id),
    ['choice', 'reply'],
  );
  rows[2].bwikiMissionId = 'quest-22';
  assert.deepEqual(
    choiceDialogue(rows, 0).map((row) => row.id),
    ['choice'],
  );
  assert.equal(isDialogueRows([{ ...rows[0], bwikiMissionId: ['quest-11'] }]), false);
});

test('BWIKI access restrictions stop further requests and produce explicit unavailable results', async () => {
  const testRoot = path.resolve('.cache/tests');
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'hsr-bwiki-fetch-'));
  try {
    fs.mkdirSync(path.join(root, '.cache/bwiki'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.cache/bwiki/request.json'),
      JSON.stringify({
        schema: 'hsr-bwiki-request.v1',
        commit: 'a'.repeat(40),
        review: [],
        requests: Array.from({ length: 45 }, (_, index) => ({
          title: 'mission' + index,
          missionId: index + 1,
        })),
      }),
    );
    let calls = 0;
    const result = await fetchBwiki(root, path.join(root, 'cache'), async () => {
      calls++;
      return new Response('<html>Access Restricted</html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      });
    });
    assert.equal(calls, 1);
    assert.equal(result.pages.length, 45);
    assert.ok(result.pages.every((page: { status: string }) => page.status === 'unavailable'));
  } finally {
    assert.ok(path.resolve(root).startsWith(testRoot + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BWIKI revision continuation preserves explicit redirects and complete snapshots', async () => {
  const testRoot = path.resolve('.cache/tests');
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'hsr-bwiki-pages-'));
  try {
    fs.mkdirSync(path.join(root, '.cache/bwiki'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.cache/bwiki/request.json'),
      JSON.stringify({
        schema: 'hsr-bwiki-request.v1',
        commit: 'a'.repeat(40),
        review: [],
        requests: [{ title: 'alias', missionId: 11 }],
      }),
    );
    let calls = 0;
    const result = await fetchBwiki(root, path.join(root, 'cache'), async (url: URL) => {
      calls++;
      if (calls === 1)
        return Response.json({
          query: {
            redirects: [{ from: 'alias', to: 'canonical' }],
            pages: [
              {
                ns: 0,
                pageid: 4,
                title: 'canonical',
                revisions: [{ revid: 8, timestamp: '2026-10-16T00:00:00Z' }],
              },
            ],
          },
        });
      if (calls === 2)
        return Response.json({
          continue: { continue: '||', rvcontinue: 'next' },
          query: {
            redirects: [{ from: 'alias', to: 'canonical' }],
            pages: [{ ns: 0, pageid: 4, title: 'canonical' }],
          },
        });
      assert.equal(url.searchParams.get('rvcontinue'), 'next');
      return Response.json({
        query: {
          pages: [
            {
              ns: 0,
              pageid: 4,
              title: 'canonical',
              revisions: [
                {
                  revid: 8,
                  timestamp: '2026-10-16T00:00:00Z',
                  slots: { main: { content: 'verified snapshot' } },
                },
              ],
            },
          ],
        },
      });
    });
    assert.equal(calls, 3);
    assert.equal(result.pages[0].pageTitle, 'canonical');
    assert.equal(result.pages[0].revision, 8);
    assert.equal(fs.readFileSync(result.pages[0].file, 'utf8'), 'verified snapshot');
  } finally {
    assert.ok(path.resolve(root).startsWith(testRoot + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('published BWIKI evidence preserves uncertain positions and chapter/mission branch boundaries', () => {
  const report = JSON.parse(fs.readFileSync('public/bwiki-provenance.json', 'utf8'));
  const status = JSON.parse(fs.readFileSync('public/content-update.json', 'utf8'));
  assert.equal(report.commit, status.commit);
  assert.equal(report.license.name, 'CC BY-NC-SA 4.0');
  for (const [file, chunks] of Object.entries(report.chapters)) {
    const payload = JSON.parse(fs.readFileSync('public/' + file, 'utf8'));
    const rows = payload.rows as DialogueRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.deepEqual(new Set(payload.bwikiBaseOrder), new Set(byId.keys()));
    rows.forEach((row, index) => {
      if (
        row.bwikiStatus === 'review' &&
        !['caption-matched', 'screen-matched'].includes(row.videoStatus ?? '')
      )
        assert.equal(row.id, payload.bwikiBaseOrder[index]);
      for (const id of row.bwikiNextIds ?? []) {
        const next = byId.get(id)!;
        assert.ok(next);
        assert.equal(next.bwikiScene, row.bwikiScene);
        assert.equal(next.bwikiMissionId, row.bwikiMissionId);
      }
    });
    for (const chunk of chunks as {
      order: string[];
      page: string;
      revision: number;
    }[]) {
      for (const id of chunk.order) {
        assert.equal(byId.get(id)?.bwikiPage, chunk.page);
        assert.equal(byId.get(id)?.bwikiRevision, chunk.revision);
      }
    }
  }
});

test('reported prologue, Luofu and simulation anchors follow BWIKI story order', () => {
  const load = (file: string) => JSON.parse(fs.readFileSync(`public/content/${file}.json`, 'utf8'));
  const position = (payload: { rows: { talkId: number }[] }, id: number) => {
    const index = payload.rows.findIndex((row) => row.talkId === id);
    assert.ok(index >= 0, `Missing dialogue ${id}`);
    return index;
  };
  const station = load('station-departure--arrival');
  assert.equal(station.rows[0].talkId, 200010201);
  assert.ok(position(station, 200010201) < position(station, 200010719));
  const luofu = load('luofu-records--harbor');
  assert.ok(position(luofu, 100001701) < position(luofu, 100001702));
  assert.ok(position(luofu, 100001701) < position(luofu, 100002118));
  const simulation = load('simulated-universe--quest-4030001');
  assert.ok(position(simulation, 403011501) < position(simulation, 403011401));
  const paradise = load('paradise-records--laughter');
  assert.ok(position(paradise, 152120001) < position(paradise, 152120005));
});
