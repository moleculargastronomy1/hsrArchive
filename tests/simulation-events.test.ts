import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { eventPath } from '../scripts/simulation-events.mjs';
import { prioritizeBwikiRequests, retryDecision, HOUR } from '../scripts/verification-retry.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectEventImages } from '../scripts/event-images.mjs';
import { limitBwikiToPending } from '../scripts/bwiki-verification.mjs';
import {
  compareVerification,
  assertVerificationPreserved,
} from '../scripts/verification-integration.mjs';

test('event paths reject escapes and unrelated sources', () => {
  assert.ok(eventPath('Config/Level/Rogue/RogueDialogue/Event001/Act001.json'));
  for (const value of [
    '../event.json',
    'Config/Level/Rogue/RogueNPC/../secret.json',
    'Config/Level/Mission/123/test.json',
    'Config/Level/Rogue/RogueNPC/./test.json',
  ])
    assert.equal(eventPath(value), false);
});

test('BWIKI updates exclude completed files while retaining new events and unresolved responses', async () => {
  await fs.mkdir('.cache/tests', { recursive: true });
  const folder = await fs.mkdtemp(path.resolve('.cache/tests/pending-only-'));
  try {
    await fs.mkdir(path.join(folder, 'public'), { recursive: true });
    await fs.mkdir(path.join(folder, '.cache/bwiki'), { recursive: true });
    await fs.writeFile(
      path.join(folder, 'public/bwiki-provenance.json'),
      JSON.stringify({
        imports: {},
        events: { 'finished-event': { remaining: 0 } },
      }),
    );
    await fs.writeFile(
      path.join(folder, '.cache/bwiki/chapters.json'),
      JSON.stringify({ chapters: [] }),
    );
    const request = {
      requests: [
        { title: '검증 완료', missionId: 1 },
        { title: '미확인', missionId: 2 },
        { title: '응답 미확인', missionId: 3 },
        { title: '새 사건', missionId: 0, eventFiles: ['new-event'] },
        { title: '완료 사건', missionId: 0, eventFiles: ['finished-event'] },
      ],
    };
    const rows = new Map([
      ['one', { file: 'done', missionId: 'quest-1', bwikiStatus: 'matched', type: 'dialogue' }],
      ['two', { file: 'pending', missionId: 'quest-2', bwikiStatus: 'review', type: 'dialogue' }],
      [
        'three',
        {
          file: 'reply',
          missionId: 'quest-3',
          bwikiStatus: 'matched',
          type: 'choice',
          bwikiNextIds: [],
        },
      ],
    ]);
    const targets = await limitBwikiToPending(folder, folder, request, rows);
    assert.deepEqual(
      request.requests.map((item) => item.title),
      ['미확인', '응답 미확인', '새 사건'],
    );
    assert.deepEqual([...targets].sort(), ['new-event', 'pending', 'reply']);
    assert.equal(targets.has('done'), false);
  } finally {
    assert.ok(folder.startsWith(path.resolve('.cache/tests') + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('successful but unresolved documents become due without a new revision and rotate fairly', () => {
  const now = Date.parse('2026-10-19T00:00:00Z');
  const state = {
    algorithm: 'v1',
    pages: {
      first: {
        unresolved: true,
        nextRetryAt: new Date(now - HOUR).toISOString(),
        lastReviewedAt: new Date(now - HOUR).toISOString(),
      },
      second: {
        unresolved: true,
        nextRetryAt: new Date(now - HOUR).toISOString(),
        lastReviewedAt: new Date(now - 24 * HOUR).toISOString(),
      },
      waiting: { unresolved: true, nextRetryAt: new Date(now + HOUR).toISOString() },
    },
  };
  assert.deepEqual(retryDecision(state, 'v1', {}, now).due, ['first', 'second']);
  const requests = ['waiting', 'first', 'second'].map((title) => ({
    title,
    missionId: 0,
    eventFiles: ['event'],
  }));
  assert.deepEqual(
    prioritizeBwikiRequests(requests, state, new Map(), now).map((item) => item.title),
    ['second', 'first', 'waiting'],
  );
  assert.equal(
    retryDecision({ ...state, nextRequestAt: new Date(now + HOUR).toISOString() }, 'v1', {}, now)
      .needed,
    false,
  );
});

test('event joins preserve official membership, modes, precise hashes and probability barriers', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_simulation_events.py'],
    { env: { ...process.env, PYTHONUTF8: '1' } },
  );
});

test('event images require a unique associated file, retain attribution, and honor HTTP backoff', async () => {
  await fs.mkdir('.cache/tests', { recursive: true });
  const folder = await fs.mkdtemp(path.resolve('.cache/tests/event-images-'));
  await fs.mkdir(path.join(folder, '.cache/bwiki'), { recursive: true });
  const page = {
    title: '测试',
    pageTitle: '测试',
    pageId: 9,
    revision: 1,
    status: 'available',
    eventFiles: ['event'],
  };
  const state: any = { pages: {} };
  const manifest: any = { pages: [page] };
  let requests = 0;
  try {
    const fetcher = async (url: URL) => {
      requests++;
      const images = url.searchParams.get('prop') === 'images';
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              images
                ? {
                    ns: 0,
                    pageid: 9,
                    images: [
                      { title: '文件:模拟宇宙事件-测试.png' },
                      { title: '文件:选择图标.png' },
                    ],
                  }
                : {
                    ns: 6,
                    title: '文件:模拟宇宙事件-测试.png',
                    imageinfo: [
                      {
                        url: 'https://patchwiki.biligame.com/images/sr/test.png',
                        descriptionurl: 'https://wiki.biligame.com/sr/文件:模拟宇宙事件-测试.png',
                        sha1: 'a'.repeat(40),
                        mime: 'image/png',
                        width: 600,
                        height: 400,
                      },
                    ],
                  },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    await collectEventImages(folder, folder, manifest, state, { fetcher, pause: async () => {} });
    assert.equal(requests, 2);
    assert.equal(manifest.eventImages['测试'].width, 600);
    assert.match(manifest.eventImages['测试'].sourceUrl, /文件/);
    page.revision = 2;
    await collectEventImages(folder, folder, manifest, state, {
      pause: async () => {},
      fetcher: async () => {
        requests++;
        return new Response('', { status: 429, headers: { 'retry-after': '86400' } });
      },
    });
    assert.equal(manifest.eventImages['测试'].revision, 1);
    await collectEventImages(folder, folder, manifest, state, {
      fetcher: async () => {
        throw Error('must not request');
      },
    });
    assert.equal(requests, 3);
    assert.ok(Date.parse(state.nextRequestAt) > Date.now());
  } finally {
    assert.ok(folder.startsWith(path.resolve('.cache/tests') + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('an image-only improvement triggers publication and cannot be silently erased by restoration', () => {
  const before: any = new Map(),
    after: any = new Map();
  after.eventImages = [
    [
      'entry/event',
      'https://patchwiki.biligame.com/image.png',
      'a'.repeat(40),
      'https://wiki.biligame.com/sr/文件:image.png',
    ],
  ];
  assert.equal(compareVerification(before, after).changed, true);
  assert.throws(() => assertVerificationPreserved(compareVerification(after, before), 'Images'));
});

test('pending chapter routes cannot be overwritten by an older snapshot with orphan event payloads', async () => {
  const { verificationRows, baselineChoice } = await import(
    '../scripts/verification-integration.mjs'
  );
  await fs.mkdir('.cache/tests', { recursive: true });
  const folder = await fs.mkdtemp(path.resolve('.cache/tests/event-baseline-'));
  try {
    await fs.mkdir(path.join(folder, 'src/data'), { recursive: true });
    await fs.mkdir(path.join(folder, 'public/content'), { recursive: true });
    const payload = {
      schema: 'hsr-dialogue.v1',
      entryId: 'entry',
      chapterId: 'event',
      rows: [{ id: 'new', text: '검증한 새 사건' }],
    };
    await fs.writeFile(
      path.join(folder, 'public/content/entry--event.json'),
      JSON.stringify(payload),
    );
    await fs.writeFile(
      path.join(folder, 'src/data/simulation.json'),
      JSON.stringify([
        {
          id: 'entry',
          chapters: [
            { id: 'event', content: { file: 'content/entry--event.json' } },
            { id: 'pending', content: { file: 'content/entry--pending.json' } },
          ],
        },
      ]),
    );
    await fs.writeFile(
      path.join(folder, 'public/content/entry--pending.json'),
      JSON.stringify({ ...payload, chapterId: 'pending', rows: [] }),
    );
    const repository = await verificationRows(folder, { referencedOnly: true });
    await fs.writeFile(
      path.join(folder, 'src/data/simulation.json'),
      JSON.stringify([
        { id: 'old', chapters: [{ id: 'old', content: { file: 'content/old--old.json' } }] },
      ]),
    );
    await fs.writeFile(
      path.join(folder, 'public/content/old--old.json'),
      JSON.stringify({ ...payload, rows: [] }),
    );
    const published = await verificationRows(folder, { referencedOnly: true });
    assert.equal(published.size, 0);
    assert.equal(repository.size, 1);
    // Real published routes are normally a subset of repository routes. Include
    // the unchanged old route so this fixture isolates the added event routes.
    repository.contentRoutes.push('content/old--old.json');
    assert.equal(baselineChoice(repository, published), 'repository');
    const removed = compareVerification(repository, published);
    assert.ok(removed.lostContentRoutes.includes('content/entry--pending.json'));
  } finally {
    assert.ok(folder.startsWith(path.resolve('.cache/tests') + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
