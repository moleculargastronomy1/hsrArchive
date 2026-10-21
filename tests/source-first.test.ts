import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sealData, assertSealedData } from '../scripts/source-first-publication.mjs';
import { publishDerivedFiles } from '../scripts/content-publication.mjs';
import { writeDerived } from '../scripts/verification-state.mjs';
import { nearbyDialogue, choiceDialogue, type DialogueRow } from '../src/lib/dialogue.ts';

test('new source records with unknown invocation cannot imply surrounding dialogue or choice replies', () => {
  const rows: DialogueRow[] = ['a', 'b', 'c'].map((id) => ({
    id,
    entryId: 'entry',
    chapterId: 'chapter',
    mission: 'mission',
    scene: 'scene',
    speaker: 'speaker',
    text: id,
    source: 'same-source',
    type: id === 'b' ? 'choice' : 'dialogue',
    flowStatus: 'review',
    flowBoundary: true,
  }));
  assert.deepEqual(
    nearbyDialogue(rows, 1).map((r) => r.id),
    ['b'],
  );
  assert.deepEqual(
    choiceDialogue(rows, 1).map((r) => r.id),
    ['b'],
  );
});

test('source-first ownership, scope, branch, normalization and recovery rules', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_source_first.py'],
    { env: { ...process.env, PYTHONUTF8: '1' }, stdio: 'pipe' },
  );
});

test('artifact seal detects changed data, changed file sets and changed build output', async () => {
  await fs.mkdir('.cache/tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/tests/hsr-seal-'));
  try {
    await fs.mkdir(path.join(root, 'src/data'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/content'), { recursive: true });
    const file = 'public/content/entry--chapter.json';
    await fs.writeFile(path.join(root, file), 'validated');
    const seal = await sealData(root);
    await assertSealedData(root, seal);
    await fs.mkdir(path.join(root, 'dist/content'), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(root, 'dist/content/entry--chapter.json'));
    await assertSealedData(root, seal, path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'dist/content/entry--chapter.json'), 'changed build');
    await assert.rejects(assertSealedData(root, seal, path.join(root, 'dist')), /differs/);
    await fs.writeFile(path.join(root, file), 'changed data');
    await assert.rejects(assertSealedData(root, seal), /changed/);
    await fs.writeFile(path.join(root, 'public/content/new.json'), '{}');
    await assert.rejects(assertSealedData(root, seal), /file set changed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('partial publication restores byte-exact prior data after a later write fails', async () => {
  await fs.mkdir('.cache/tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.cache/tests/hsr-rollback-'));
  const stage = path.join(root, 'stage');
  try {
    const files = ['public/content/first.json', 'public/content/second.json'];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), 'original ' + file);
      await fs.writeFile(path.join(stage, file), 'candidate ' + file);
    }
    let attempts = 0;
    await assert.rejects(
      publishDerivedFiles(root, stage, files, {
        write: async (r, file, bytes) => {
          if (++attempts === 2) throw new Error('simulated disk failure');
          await writeDerived(r, file, bytes);
        },
      }),
      /disk failure/,
    );
    for (const file of files)
      assert.equal(await fs.readFile(path.join(root, file), 'utf8'), 'original ' + file);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
