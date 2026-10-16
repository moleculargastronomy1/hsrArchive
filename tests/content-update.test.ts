import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseContentUpdateStatus } from '../src/lib/content-update.ts';
import {
  gitBlob,
  koreanFiles,
  resolveUpstream,
  REQUIRED_TABLES,
} from '../scripts/upstream-content.mjs';

const sha = 'a'.repeat(40);
test('Korean discovery accepts combined and split maps, and rejects missing or ambiguous parts', () => {
  const file = (name: string) => ({ name, type: 'file', sha });
  assert.deepEqual(
    koreanFiles([file('TextMapEN.json'), file('TextMapKR_1.json'), file('TextMapKR_0.json')]).map(
      (item) => item.name,
    ),
    ['TextMapKR_0.json', 'TextMapKR_1.json'],
  );
  assert.equal(koreanFiles([file('TextMapKR.json')]).length, 1);
  assert.throws(() => koreanFiles([file('TextMapKR_1.json')]));
  assert.throws(() => koreanFiles([file('TextMapKR_0.json'), file('TextMapKR_2.json')]));
  assert.throws(() => koreanFiles([file('TextMapKR.json'), file('TextMapKR_0.json')]));
  assert.throws(() => koreanFiles([file('TextMapEN.json')]));
  assert.notEqual(gitBlob(Buffer.from('original')), gitBlob(Buffer.from('corrupted')));
});

test('upstream discovery pins all file lists to one release commit and uses the complete table tree', async () => {
  const requested: string[] = [];
  const api = async (endpoint: string) => {
    requested.push(endpoint);
    if (endpoint === 'commits/main')
      return {
        sha,
        commit: {
          message: 'OSPRODWin4.6.0_TEST\nOther details',
          committer: { date: '2026-10-15T18:00:00Z' },
        },
      };
    if (endpoint === `contents/TextMap?ref=${sha}`)
      return [{ name: 'TextMapKR.json', type: 'file', sha }];
    if (endpoint === `git/trees/${sha}`)
      return { tree: [{ path: 'ExcelOutput', type: 'tree', sha: 'b'.repeat(40) }] };
    return { tree: REQUIRED_TABLES.map((path) => ({ path, type: 'blob', sha })) };
  };
  const plan = await resolveUpstream(api);
  assert.equal(plan.commit, sha);
  assert.equal(plan.version, 'OSPRODWin4.6.0_TEST');
  assert.equal(plan.files.length, 5);
  assert.ok(requested.includes(`contents/TextMap?ref=${sha}`));
  assert.ok(!requested.some((endpoint) => endpoint.includes('contents/ExcelOutput')));
  await assert.rejects(
    resolveUpstream(async () => ({ sha, commit: { message: 'unidentified update' } })),
  );
});

test('home notice accepts release chapter metadata and rejects malformed updates', () => {
  const status = {
    schema: 'hsr-content-update.v1',
    version: 'OSPRODWin4.6.0_TEST',
    commit: sha,
    checkedAt: '2026-10-17T00:00:00Z',
    latestTrailblaze: {
      id: 105009,
      chapter: 5,
      act: 7,
      title: '달 뜨기 전, 괴수와 춤을',
    },
  };
  const parsed = parseContentUpdateStatus(status)!;
  assert.ok(parsed);
  assert.equal(parsed.latestTrailblaze!.act, 7);
  const { latestTrailblaze, ...legacy } = status;
  assert.ok(parseContentUpdateStatus(legacy));
  for (const invalid of [
    null,
    { ...status, schema: 'unknown' },
    { ...status, checkedAt: 'invalid' },
    { ...status, latestTrailblaze: { ...latestTrailblaze, title: '' } },
    { ...status, latestTrailblaze: { ...latestTrailblaze, act: -1 } },
  ])
    assert.equal(parseContentUpdateStatus(invalid), undefined);
});

test('Python projection preserves exact integer hashes, branch roles and prior text on missing joins', () => {
  const python = process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, ['tests/test_content_projection.py'], {
    stdio: 'pipe',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
});
