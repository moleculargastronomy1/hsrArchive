import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { eventPath } from '../scripts/simulation-events.mjs';
import { prioritizeBwikiRequests, retryDecision, HOUR } from '../scripts/verification-retry.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectEventImages } from '../scripts/event-images.mjs';
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
