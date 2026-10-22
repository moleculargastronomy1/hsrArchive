import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  packState,
  restoreState,
  writeDerived,
  applyDerivedChanges,
  stateFiles,
} from '../scripts/verification-state.mjs';
import { restoreVerification, prepareVerification } from '../scripts/prepare-verification.mjs';
import { sealData, assertSealedData } from '../scripts/source-first-publication.mjs';

const commit = 'a'.repeat(40);
async function fixture(t, local = ['matched', 'review'], published = ['review', 'matched']) {
  const dir = await fs.mkdtemp(path.resolve('.cache/restore-transaction-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root'),
    remote = path.join(dir, 'remote');
  for (const [base, statuses] of [
    [root, local],
    [remote, published],
  ]) {
    await fs.mkdir(path.join(base, 'src/data'), { recursive: true });
    await fs.mkdir(path.join(base, 'public/content'), { recursive: true });
    await fs.writeFile(path.join(base, 'public/content-update.json'), JSON.stringify({ commit }));
    await fs.writeFile(
      path.join(base, 'src/data/imported-content.json'),
      JSON.stringify({ 'entry/chapter': { file: 'content/entry--chapter.json' } }),
    );
    await fs.writeFile(
      path.join(base, 'public/content/entry--chapter.json'),
      JSON.stringify({
        schema: 'hsr-dialogue.v1',
        rows: statuses.map((bwikiStatus, i) => ({
          id: String(i),
          text: '원문' + i,
          type: 'dialogue',
          source: 'original',
          bwikiStatus,
        })),
      }),
    );
    await fs.writeFile(
      path.join(base, 'public/content-watch.json'),
      JSON.stringify({ marker: base === root ? 'local-watch' : 'published-watch' }),
    );
    await fs.writeFile(
      path.join(base, 'public/official-videos.json'),
      JSON.stringify({ marker: base === root ? 'local-video' : 'published-video' }),
    );
  }
  const descriptor = await packState(remote),
    bytes = await fs.readFile(path.join(remote, 'public', descriptor.file));
  const fetcher = async (url) =>
    new Response(url.endsWith('verification-state.json') ? JSON.stringify(descriptor) : bytes);
  const capture = async () => {
    const result = {};
    for (const file of await stateFiles(root))
      result[file] = (await fs.readFile(path.join(root, file))).toString('base64');
    return result;
  };
  return { root, remote, fetcher, capture };
}

test('incomparable published and repository evidence leaves every local byte untouched', async (t) => {
  const f = await fixture(t),
    before = await f.capture();
  await assert.rejects(restoreVerification(f.root, { fetcher: f.fetcher }), /unique evidence/);
  assert.deepEqual(await f.capture(), before);
});

test('a proven published superset restores its dialogue and metadata together', async (t) => {
  const f = await fixture(t, ['matched', 'review'], ['matched', 'matched']);
  const result = await restoreVerification(f.root, { fetcher: f.fetcher });
  assert.equal(result.choice, 'published');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, 'public/content-watch.json'), 'utf8')).marker,
    'published-watch',
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, 'public/official-videos.json'), 'utf8')).marker,
    'published-video',
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, 'public/content/entry--chapter.json'), 'utf8'))
      .rows[1].bwikiStatus,
    'matched',
  );
});

test('snapshot restore rolls back prior files and new files after a later write fails', async (t) => {
  const f = await fixture(t, ['matched', 'review'], ['matched', 'matched']);
  const target = path.join(f.root, 'public/official-videos.json');
  await fs.unlink(target);
  const before = await f.capture();
  let attempts = 0;
  await assert.rejects(
    restoreState(f.root, f.fetcher, {
      write: async (root, file, bytes) => {
        await writeDerived(root, file, bytes);
        if (++attempts === 3) throw Error('injected restore interruption');
      },
    }),
    /restore interruption/,
  );
  assert.deepEqual(await f.capture(), before);
});

test('derived transactions preflight all paths and surface rollback failure', async (t) => {
  const f = await fixture(t),
    before = await f.capture();
  await assert.rejects(
    applyDerivedChanges(f.root, [
      { path: 'public/content-update.json', bytes: Buffer.from('{}') },
      { path: '../escape', bytes: Buffer.from('{}') },
    ]),
    /Unsafe/,
  );
  assert.deepEqual(await f.capture(), before);
  await assert.rejects(
    applyDerivedChanges(
      f.root,
      [{ path: 'public/content-update.json', bytes: Buffer.from('{}') }],
      {
        write: async () => {
          throw Error('disk unavailable');
        },
      },
    ),
    AggregateError,
  );
});

test('source-watch and official-video metadata are sealed and survive a snapshot round trip', async (t) => {
  const f = await fixture(t, ['matched', 'review'], ['matched', 'matched']);
  const seal = await sealData(f.remote);
  await assertSealedData(f.remote, seal);
  await restoreState(f.root, f.fetcher);
  for (const file of ['public/content-watch.json', 'public/official-videos.json'])
    assert.deepEqual(
      await fs.readFile(path.join(f.root, file)),
      await fs.readFile(path.join(f.remote, file)),
    );
  await fs.writeFile(path.join(f.remote, 'public/content-watch.json'), '{}');
  await assert.rejects(
    assertSealedData(f.remote, seal),
    /Validated data changed: public\/content-watch/,
  );
});

test('temporary baseline transport failures defer publication without acknowledging cached results', async (t) => {
  for (const failure of [
    () => new Response('', { status: 503 }),
    () => new Response('', { status: 429 }),
    () => {
      throw new TypeError('connection lost');
    },
  ]) {
    const f = await fixture(t),
      before = await f.capture(),
      output = path.join(f.root, 'output.txt');
    const state = path.join(f.root, '.cache/verification-retry/state.json');
    await fs.mkdir(path.dirname(state), { recursive: true });
    const previous = JSON.stringify({
      schema: 'hsr-verification-retry.v1',
      pages: {},
      pendingDigest: 'not-published',
    });
    await fs.writeFile(state, previous);
    const result = await prepareVerification(f.root, { fetcher: async () => failure(), output });
    assert.equal(result.status, 'deferred');
    assert.equal(await fs.readFile(output, 'utf8'), 'ready=false\n');
    assert.equal(await fs.readFile(state, 'utf8'), previous);
    assert.deepEqual(await f.capture(), before);
  }
});

test('corrupt baseline content is a hard failure rather than an availability deferral', async (t) => {
  const f = await fixture(t),
    before = await f.capture(),
    output = path.join(f.root, 'output.txt');
  await assert.rejects(
    prepareVerification(f.root, {
      output,
      fetcher: async (url) =>
        url.endsWith('verification-state.json') ? f.fetcher(url) : new Response('corrupt'),
    }),
    /checksum/,
  );
  assert.deepEqual(await f.capture(), before);
  await assert.rejects(fs.readFile(output), { code: 'ENOENT' });
});
