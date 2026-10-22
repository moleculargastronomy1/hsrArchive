import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  inactiveSearchSlot,
  workerConfiguration,
  deploymentEnvironment,
  assertPrivateBucket,
  assertPublishingMode,
} from '../scripts/deploy-protected-candidate.mjs';

test('publishing mode defaults preserve public Pages but never fall back to static full data for private sources', () => {
  assertPublishingMode({ SOURCE_IS_PRIVATE: 'false' });
  assertPublishingMode({ SOURCE_IS_PRIVATE: 'false', HSR_DATA_MODE: 'static' });
  assertPublishingMode({
    SOURCE_IS_PRIVATE: 'true',
    HSR_DATA_MODE: 'protected',
    API_URL: 'https://api.example',
    HSR_PRIVATE_STATE_TOKEN: 'test-only',
  });
  for (const env of [
    {},
    { SOURCE_IS_PRIVATE: 'true' },
    { SOURCE_IS_PRIVATE: 'true', HSR_DATA_MODE: 'static' },
    { SOURCE_IS_PRIVATE: 'false', HSR_DATA_MODE: 'protected' },
    { SOURCE_IS_PRIVATE: 'true', HSR_DATA_MODE: 'protected', API_URL: 'https://api.example' },
    { SOURCE_IS_PRIVATE: 'false', HSR_DATA_MODE: 'protected-typo' },
  ])
    assert.throws(() => assertPublishingMode(env));
});
import { publishFrontend, checkLive, publicRepository } from '../scripts/protected-publisher.mjs';
import { hash } from '../scripts/verification-state.mjs';
import { auditProtected } from '../scripts/check-protected-exposure.mjs';

test('inactive search slots never select either database currently bound by the serving Worker', () => {
  const settings = {
    bindings: [
      { name: 'SEARCH', type: 'd1', id: 'live' },
      { name: 'SEARCH_PREVIOUS', type: 'd1', id: 'last-good' },
      { name: 'DATA_RELEASE', text: 'failed-candidate' },
      { name: 'PREVIOUS_RELEASE', text: 'success' },
      { name: 'ALLOWED_ORIGINS', text: 'https://moleculargastronomy1.github.io' },
    ],
  };
  const databases = [
    { name: 'hsr-search-slot-0', uuid: 'live' },
    { name: 'hsr-search-slot-1', uuid: 'last-good' },
    { name: 'hsr-search-slot-2', uuid: 'inactive' },
  ];
  assert.equal(inactiveSearchSlot(settings, databases).existing.uuid, 'inactive');
  const config = workerConfiguration({
    candidate: { release: 'next' },
    settings,
    previous: 'success',
    database: databases[2],
    account: 'a'.repeat(32),
    name: 'hsr-data',
    bucket: 'hsr-private',
  });
  assert.equal(config.d1_databases[0].database_id, 'inactive');
  assert.equal(config.d1_databases[1].database_id, 'last-good');
  assert.equal(config.vars.PREVIOUS_RELEASE, 'success');
  assert.equal(config.migrations[0].new_sqlite_classes.length, 2);
  assert.throws(
    () =>
      workerConfiguration({
        candidate: { release: 'next' },
        settings,
        previous: 'unknown',
        database: databases[2],
        account: 'a'.repeat(32),
        name: 'hsr-data',
        bucket: 'hsr-private',
      }),
    /last successful/,
  );
  assert.throws(
    () =>
      inactiveSearchSlot(
        { bindings: databases.map((database) => ({ type: 'd1', id: database.uuid })) },
        databases,
      ),
    /No inactive/,
  );
  assert.throws(() => publicRepository('other/repo'));
  assert.throws(() => deploymentEnvironment({}), /approved user Pages/);
  const alternative = {
    bindings: settings.bindings.map((binding: any) =>
      binding.id ? { ...binding, id: undefined, database_id: binding.id } : binding,
    ),
  };
  assert.equal(inactiveSearchSlot(alternative, databases).existing.uuid, 'inactive');
  assert.throws(
    () => inactiveSearchSlot({ bindings: [{ name: 'SEARCH', type: 'd1' }] }, databases),
    /Cannot identify/,
  );
});

test('publication refuses public or unknown R2 access settings before uploading private candidates', () => {
  assertPrivateBucket({ enabled: false }, { domains: [] });
  assertPrivateBucket({ enabled: false }, { domains: [{ enabled: false }] });
  assert.throws(() => assertPrivateBucket({ enabled: true }, { domains: [] }), /public access/);
  assert.throws(
    () => assertPrivateBucket({ enabled: false }, { domains: [{ enabled: true }] }),
    /public access/,
  );
  assert.throws(() => assertPrivateBucket({}, {}), /public access/);
});

test('a real local Git publisher replaces only the archive prefix, preserves other pages, and pushes no private state', async () => {
  const root = await fs.mkdtemp(path.resolve('.cache/publisher-test-'));
  const seed = path.join(root, 'seed'),
    remote = path.join(root, 'remote.git'),
    dist = path.join(root, 'dist');
  await fs.mkdir(seed);
  await fs.mkdir(dist);
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '--initial-branch=main'], seed);
  git(['init', '--bare', '--initial-branch=main', remote], root);
  await fs.writeFile(path.join(seed, 'index.html'), 'other existing user site');
  await fs.mkdir(path.join(seed, 'hsrArchive/content'), { recursive: true });
  await fs.writeFile(path.join(seed, 'hsrArchive/content/old.json'), '{"stale":"must disappear"}');
  git(['add', '.'], seed);
  git(
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed'],
    seed,
  );
  git(['remote', 'add', 'origin', remote], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  await fs.writeFile(path.join(dist, 'index.html'), 'verified UI only');
  await fs.writeFile(path.join(root, 'private-snapshot.json'), 'never publish');
  const clone = path.join(root, 'clone');
  await publishFrontend({
    dist,
    folder: clone,
    repository: 'moleculargastronomy1/moleculargastronomy1.github.io',
    remote,
  });
  assert.equal(
    await fs.readFile(path.join(clone, 'index.html'), 'utf8'),
    'other existing user site',
  );
  assert.equal(
    await fs.readFile(path.join(clone, 'hsrArchive/index.html'), 'utf8'),
    'verified UI only',
  );
  assert.equal(
    await fs.stat(path.join(clone, 'hsrArchive/content/old.json')).catch(() => null),
    null,
  );
  const files = git(['ls-tree', '-r', '--name-only', 'main'], remote).trim().split('\n');
  assert.deepEqual(files.sort(), ['.nojekyll', 'hsrArchive/index.html', 'index.html']);
  await assert.rejects(
    publishFrontend({
      dist,
      folder: clone,
      repository: 'moleculargastronomy1/moleculargastronomy1.github.io',
      remote,
    }),
    /fresh publisher/,
  );
});

test('live publication gate rejects stale HTML, reachable bulk JSON and caches; exact public files pass', async () => {
  const candidate = {
    release: 'test',
    prefix: 'releases/test',
    snapshot: { file: 'verification-state-' + 'a'.repeat(64) + '.json.gz' },
    hashes: { 'dist/index.html': hash('verified UI') },
    objects: [{ key: 'releases/test/public/content/mission--a.json' }],
  };
  const fetcher = async (url: URL) =>
    new Response(url.pathname.endsWith('/index.html') ? 'verified UI' : '', {
      status: url.pathname.endsWith('/index.html') ? 200 : 404,
    });
  const result = await checkLive(
    candidate,
    '.',
    'https://moleculargastronomy1.github.io/hsrArchive/',
    fetcher,
  );
  assert.ok(result.blocked >= 14);
  await assert.rejects(
    checkLive(
      candidate,
      '.',
      'https://moleculargastronomy1.github.io/hsrArchive/',
      async () => new Response('stale UI'),
    ),
    /verified artifact/,
  );
  await assert.rejects(
    checkLive(
      candidate,
      '.',
      'https://moleculargastronomy1.github.io/hsrArchive/',
      async (url: URL) =>
        url.pathname.endsWith('search-index.json') ? new Response('{"rows":[]}') : fetcher(url),
    ),
    /still reachable/,
  );
  const observed = JSON.parse(
    await fs.readFile('docs/reports/data-exposure-before-2026-10-22.json', 'utf8'),
  );
  const oldSnapshot = observed.checks.find((item: any) => item.path.endsWith('.json.gz')).path;
  await assert.rejects(
    checkLive(
      candidate,
      '.',
      'https://moleculargastronomy1.github.io/hsrArchive/',
      async (url: URL) =>
        url.pathname.endsWith(oldSnapshot)
          ? new Response('old cached whole archive')
          : fetcher(url),
    ),
    /still reachable/,
  );
});

test('exposure scanner rejects accidentally embedded CI credentials without printing the value', async () => {
  const dist = await fs.mkdtemp(path.resolve('.cache/secret-scan-test-'));
  const previous = process.env.HSR_PRIVATE_STATE_TOKEN;
  process.env.HSR_PRIVATE_STATE_TOKEN = 'test-only-sensitive-canary-123456';
  try {
    await fs.writeFile(path.join(dist, 'index.html'), process.env.HSR_PRIVATE_STATE_TOKEN);
    await assert.rejects(
      auditProtected(process.cwd(), dist),
      /Private credential in public artifact/,
    );
  } finally {
    if (previous === undefined) delete process.env.HSR_PRIVATE_STATE_TOKEN;
    else process.env.HSR_PRIVATE_STATE_TOKEN = previous;
  }
});
