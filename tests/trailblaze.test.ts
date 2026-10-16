import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  isMissionStructurePath,
  resolveMissionStructures,
} from '../scripts/trailblaze-structures.mjs';

test('mission discovery uses exact directories and rejects truncated trees and unsafe paths', async () => {
  const sha = (letter: string) => letter.repeat(40);
  const calls: string[] = [];
  const directory = (path: string, letter: string) => ({ path, sha: sha(letter), type: 'tree' });
  const api = async (endpoint: string) => {
    calls.push(endpoint);
    const values: Record<string, unknown> = {
      [`git/trees/${sha('a')}`]: { tree: [directory('Story', 'b')] },
      [`git/trees/${sha('b')}`]: { tree: [directory('Mission', 'c')] },
      [`git/trees/${sha('c')}`]: { tree: [directory('11', 'd'), directory('1100', 'e')] },
      [`git/trees/${sha('d')}?recursive=1`]: {
        tree: [
          { path: 'Story.json', sha: sha('f'), type: 'blob' },
          { path: 'Story.layout.json', sha: sha('f'), type: 'blob' },
        ],
      },
    };
    if (!(endpoint in values)) throw new Error('Unexpected tree request: ' + endpoint);
    return values[endpoint];
  };
  assert.deepEqual(await resolveMissionStructures(api, sha('a'), [11]), [
    { path: 'Story/Mission/11/Story.json', sha: sha('f'), missionId: 11 },
  ]);
  assert.ok(!calls.includes(`git/trees/${sha('e')}?recursive=1`));
  assert.ok(!calls.includes(`git/trees/${sha('a')}?recursive=1`));
  await assert.rejects(
    resolveMissionStructures(async () => ({ truncated: true, tree: [] }), sha('a'), [11]),
  );
  for (const path of [
    '../secret.json',
    'Story/Mission/11/../../secret.json',
    'Story/Mission/11/x.layout.json',
  ])
    assert.equal(isMissionStructurePath(path), false);
});

test('new Trailblaze chapters preserve routes, choices and pending introductions', () => {
  const python = process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, ['tests/test_trailblaze_import.py'], {
    stdio: 'pipe',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
});
