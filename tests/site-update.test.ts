import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSiteUpdateStatus, siteUpdateDate } from '../src/lib/content-update.ts';

test('archive update date uses Korean time and rejects invalid metadata', () => {
  const status = {
    schema: 'hsr-site-update.v1',
    commit: 'a'.repeat(40),
    updatedAt: '2026-10-15T18:00:00Z',
  };
  assert.equal(siteUpdateDate(parseSiteUpdateStatus(status)!), '2026.10.16');
  for (const invalid of [null, { ...status, updatedAt: 'invalid' }, { ...status, commit: '' }])
    assert.equal(parseSiteUpdateStatus(invalid), undefined);
});

test('archive date stays stable on rebuild and changes when the site source is revised', () => {
  const cache = path.resolve('.cache');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'site-update-test-'));
  const script = fileURLToPath(new URL('../scripts/update-site-status.mjs', import.meta.url));
  const git = (args: string[], date?: string) =>
    execFileSync('git', args, {
      cwd: directory,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    });
  const commit = (date: string) =>
    git(
      [
        '-c',
        'user.name=Archive Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'Site revision',
      ],
      date,
    );
  const build = () => {
    execFileSync(process.execPath, [script], { cwd: directory });
    return JSON.parse(fs.readFileSync(path.join(directory, 'public/site-update.json'), 'utf8'));
  };
  try {
    fs.mkdirSync(path.join(directory, 'public'));
    git(['init']);
    commit('2026-10-15T18:00:00Z');
    const first = build();
    assert.equal(siteUpdateDate(first), '2026.10.16');
    assert.deepEqual(build(), first);
    commit('2026-10-16T18:00:00Z');
    const next = build();
    assert.equal(siteUpdateDate(next), '2026.10.17');
    assert.notEqual(next.commit, first.commit);
  } finally {
    assert.equal(path.dirname(directory), cache);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
