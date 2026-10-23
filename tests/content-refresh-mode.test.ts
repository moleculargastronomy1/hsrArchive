import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { contentRefreshMode, requestedSiteBuild } from '../scripts/content-refresh-mode.mjs';

test('a code build or wiki change uses only pending verification for the same official text', () => {
  const plan = { commit: 'same' };
  assert.equal(contentRefreshMode(plan, { commit: 'same' }), '--retry');
  assert.equal(contentRefreshMode(plan, { commit: 'older' }), '--apply');
  assert.equal(requestedSiteBuild({ checks: { source: 'requested-build' } }), true);
  assert.equal(requestedSiteBuild({ mode: 'full', checks: { wiki: 'changed' } }), false);
  assert.equal(requestedSiteBuild({ mode: 'retry' }), false);
});

test('site deployments never run text processing or acknowledge a newer official input', async () => {
  const root = process.cwd();
  await fs.mkdir('.cache/tests', { recursive: true });
  const folder = await fs.mkdtemp(path.resolve('.cache/tests/site-only-'));
  try {
    await fs.mkdir(path.join(folder, '.cache/content-watch'), { recursive: true });
    await fs.mkdir(path.join(folder, '.cache/upstream-content'), { recursive: true });
    await fs.mkdir(path.join(folder, 'public'), { recursive: true });
    const watch = { checks: { source: 'requested-build' } };
    assert.equal(contentRefreshMode({ commit: 'new' }, { commit: 'old' }, watch), '--site-only');
    await fs.writeFile(path.join(folder, '.cache/content-watch/check.json'), JSON.stringify(watch));
    await fs.writeFile(path.join(folder, '.cache/upstream-content/plan.json'), '{"commit":"new"}');
    await fs.writeFile(path.join(folder, 'public/content-update.json'), '{"commit":"old"}');
    const output = path.join(folder, 'outputs');
    // No collector script exists here: a mistaken invocation must fail.
    execFileSync(process.execPath, [path.join(root, 'scripts/run-content-refresh.mjs')], {
      cwd: folder,
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.equal(await fs.readFile(output, 'utf8'), 'publish=true\nsite_only=true\n');
    assert.equal(
      await fs.readFile(path.join(folder, 'public/content-update.json'), 'utf8'),
      '{"commit":"old"}',
    );
    assert.equal((await fs.readdir(path.join(folder, 'public'))).length, 1);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(folder, '.cache/verification-retry/run.json'))).mode,
      'site-only',
    );
  } finally {
    assert.ok(folder.startsWith(path.resolve('.cache/tests') + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('a search-only deadline skips all canonical collectors', async () => {
  const root = process.cwd();
  const folder = await fs.mkdtemp(path.resolve('.cache/tests/search-only-'));
  try {
    for (const name of ['.cache/content-watch', '.cache/upstream-content', 'public'])
      await fs.mkdir(path.join(folder, name), { recursive: true });
    await fs.writeFile(
      path.join(folder, '.cache/content-watch/check.json'),
      JSON.stringify({
        mode: 'retry',
        retrySearch: true,
        retryBwiki: false,
        retryVideo: false,
      }),
    );
    await fs.writeFile(path.join(folder, '.cache/upstream-content/plan.json'), '{"commit":"same"}');
    await fs.writeFile(path.join(folder, 'public/content-update.json'), '{"commit":"same"}');
    const output = path.join(folder, 'outputs');
    // No canonical processing scripts exist in the fixture.
    execFileSync(process.execPath, [path.join(root, 'scripts/run-content-refresh.mjs')], {
      cwd: folder,
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.equal(await fs.readFile(output, 'utf8'), 'publish=false\nsearch_only=true\n');
    assert.deepEqual(await fs.readdir(path.join(folder, 'public')), ['content-update.json']);
    assert.equal(
      await fs.readFile(path.join(folder, 'public/content-update.json'), 'utf8'),
      '{"commit":"same"}',
    );
    // An invalid search update must also finish without failing canonical deployment.
    execFileSync(process.execPath, [path.join(root, 'scripts/search-text.mjs')], {
      cwd: folder,
      env: { ...process.env, GITHUB_OUTPUT: output },
      stdio: 'pipe',
    });
    assert.match(await fs.readFile(output, 'utf8'), /changed=false/);
    assert.deepEqual(await fs.readdir(path.join(folder, 'public')), ['content-update.json']);
  } finally {
    assert.ok(folder.startsWith(path.resolve('.cache/tests') + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
