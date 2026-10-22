import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { quarantineRetryChapters } from '../scripts/reverify-content.mjs';
import {
  verificationRows,
  compareVerification,
  assertVerificationPreserved,
} from '../scripts/verification-integration.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.resolve('.cache/retry-quarantine-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root'),
    stage = path.join(dir, 'stage');
  const write = async (base, file, data) => {
    const target = path.join(base, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(data));
  };
  const read = async (base, file) => JSON.parse(await fs.readFile(path.join(base, file), 'utf8'));
  const row = (id, type = 'dialogue') => ({
    id,
    text: id,
    speaker: '화자',
    type,
    entryId: 'entry',
    chapterId: 'chapter',
    missionId: 'quest-1',
    mission: '임무',
    source: 'official.json',
    bwikiStatus: 'matched',
    bwikiPage: '문서',
    bwikiScene: 'scene',
  });
  const rejected = {
    schema: 'hsr-dialogue.v1',
    rows: [
      { ...row('choice', 'choice'), bwikiNextIds: ['reply'] },
      { ...row('reply'), bwikiReplyToIds: ['choice'] },
    ],
    bwiki: { matchedRows: 2, reviewRows: 0 },
  };
  const good = { schema: 'hsr-dialogue.v1', rows: [{ ...row('other'), bwikiStatus: 'review' }] };
  const files = ['content/rejected.json', 'content/good.json'];
  for (const base of [root, stage]) {
    await write(base, 'public/' + files[0], rejected);
    await write(base, 'public/' + files[1], good);
    await write(base, 'public/content/search-index.json', {
      rows: [...rejected.rows, ...good.rows],
    });
    await write(base, 'public/content-update.json', { commit: 'same-release' });
    await write(base, 'receipt.json', { files: files.map((f) => 'public/' + f) });
    for (const name of [
      'bwiki-provenance',
      'source-first-provenance',
      'dialogue-flow-provenance',
      'video-order-provenance',
      'video-review-summary',
      'simulation-events-provenance',
    ])
      await write(base, 'public/' + name + '.json', {
        commit: 'same-release',
        codeHash: base === root ? 'prior-code' : 'current-code',
        totals: { matchedRows: 2, reviewRows: 1 },
        chapters: Object.fromEntries(
          files.map((f) => [f, { proof: base === root ? 'published' : 'candidate' }]),
        ),
      });
  }
  const candidate = structuredClone(rejected);
  candidate.rows[0].bwikiNextIds = [];
  candidate.rows[1].bwikiReplyToIds = [];
  await write(stage, 'public/' + files[0], candidate);
  const upgraded = structuredClone(good);
  upgraded.rows[0].bwikiStatus = 'matched';
  await write(stage, 'public/' + files[1], upgraded);
  return {
    root,
    stage,
    files,
    rejected,
    good,
    candidate,
    write,
    read,
    manifest: { pages: [], checkedAt: '2026-10-22T00:00:00Z' },
  };
}

test('retry quarantines a rejected chapter and retains independent improvements and proof versions', async (t) => {
  const f = await fixture(t),
    before = await verificationRows(f.root);
  const records = await quarantineRetryChapters(f.root, f.stage, before, f.manifest);
  assert.deepEqual(
    records.map((r) => r.file),
    [f.files[0]],
  );
  assert.deepEqual(await f.read(f.stage, 'public/' + f.files[0]), f.rejected);
  assert.equal((await f.read(f.stage, 'public/' + f.files[1])).rows[0].bwikiStatus, 'matched');
  const report = await f.read(f.stage, 'public/source-first-provenance.json');
  assert.equal(report.chapters[f.files[0]].proof, 'published');
  assert.equal(report.chapters[f.files[1]].proof, 'candidate');
  assert.equal(report.retainedChapters[f.files[0]].priorCodeHash, 'prior-code');
  const evidence = await f.read(f.root, records[0].evidence);
  assert.deepEqual(evidence.candidate, f.candidate);
  const after = await verificationRows(f.stage),
    comparison = compareVerification(before, after);
  assertVerificationPreserved(comparison, 'fixture');
  assert.deepEqual(comparison.newlyVerified, ['other']);
  assert.deepEqual(
    (await f.read(f.stage, 'public/content/search-index.json')).rows.slice(0, 2),
    f.rejected.rows,
  );
  assert.deepEqual(await f.read(f.root, 'public/' + f.files[0]), f.rejected);
});

test("registered admissions in a rejected chapter are withheld without losing another chapter's additions", async (t) => {
  const f = await fixture(t);
  const original = { ...f.rejected, entryId: 'entry', chapterId: 'chapter' };
  const candidate = {
    ...f.candidate,
    entryId: 'entry',
    chapterId: 'chapter',
    rows: [...f.candidate.rows, { ...f.rejected.rows[1], id: 'new-admission' }],
  };
  const good = await f.read(f.stage, 'public/' + f.files[1]);
  good.rows.push({ ...good.rows[0], id: 'other-admission' });
  const metadata = {
    'entry/chapter': { file: f.files[0], rows: 2 },
    'entry/other': { file: f.files[1], rows: 1 },
  };
  for (const base of [f.root, f.stage]) {
    await f.write(base, 'public/' + f.files[0], base === f.root ? original : candidate);
    const descriptors = structuredClone(metadata);
    if (base === f.stage) {
      descriptors['entry/chapter'].rows = 3;
      descriptors['entry/other'].rows = 2;
    }
    await f.write(base, 'src/data/imported-content.json', descriptors);
    await f.write(base, 'src/data/trailblaze.json', [
      {
        id: 'entry',
        chapters: [
          { id: 'chapter', content: descriptors['entry/chapter'] },
          { id: 'other', content: descriptors['entry/other'] },
        ],
      },
    ]);
    await f.write(base, 'public/content-update.json', {
      commit: 'same-release',
      rows: base === f.root ? 3 : 5,
      verifiedTextRows: base === f.root ? 3 : 5,
    });
  }
  await f.write(f.stage, 'public/' + f.files[1], good);
  await f.write(f.stage, 'public/content/search-index.json', {
    rows: [...candidate.rows, ...good.rows],
  });
  const report = await f.read(f.stage, 'public/source-first-provenance.json');
  report.chapters[f.files[0]].additions = [{ rowId: 'new-admission' }];
  await f.write(f.stage, 'public/source-first-provenance.json', report);
  const records = await quarantineRetryChapters(
    f.root,
    f.stage,
    await verificationRows(f.root),
    f.manifest,
  );
  assert.deepEqual(records[0].withheldRowIds, ['new-admission']);
  assert.deepEqual(await f.read(f.stage, 'public/' + f.files[0]), original);
  assert.equal((await f.read(f.stage, 'public/' + f.files[1])).rows.at(-1).id, 'other-admission');
  assert.deepEqual(
    (await f.read(f.stage, 'public/content/search-index.json')).rows.map((r) => r.id),
    ['choice', 'reply', 'other', 'other-admission'],
  );
  const update = await f.read(f.stage, 'public/content-update.json');
  assert.equal(update.rows, 4);
  assert.equal(update.verifiedTextRows, 4);
  const result = await f.read(f.stage, 'src/data/imported-content.json');
  assert.equal(result['entry/chapter'].rows, 2);
  assert.equal(result['entry/other'].rows, 2);
  assert.equal((await f.read(f.stage, 'src/data/trailblaze.json'))[0].chapters[0].content.rows, 2);
  assert.equal(
    (await f.read(f.root, records[0].evidence)).candidate.rows.at(-1).id,
    'new-admission',
  );
});

test('a malformed rejected chapter remains a shared-contract failure', async (t) => {
  const f = await fixture(t);
  f.candidate.rows.push(structuredClone(f.candidate.rows[1]));
  await f.write(f.stage, 'public/' + f.files[0], f.candidate);
  await assert.rejects(
    quarantineRetryChapters(f.root, f.stage, await verificationRows(f.root), f.manifest),
    /Duplicate verification row identity/,
  );
});

test('canonical mutation and official/video link loss remain hard failures', async (t) => {
  for (const kind of ['canonical', 'official', 'video']) {
    const f = await fixture(t);
    if (kind !== 'canonical') {
      const original = structuredClone(f.rejected),
        key = kind === 'official' ? 'nextIds' : 'videoNextIds';
      original.rows[0][kind === 'official' ? 'flowStatus' : 'videoStatus'] =
        kind === 'official' ? 'verified' : 'screen-matched';
      original.rows[0][key] = ['reply'];
      await f.write(f.root, 'public/' + f.files[0], original);
      const candidate = structuredClone(original);
      candidate.rows[0][key] = [];
      await f.write(f.stage, 'public/' + f.files[0], candidate);
    } else {
      f.candidate.rows[0].text = 'changed';
      await f.write(f.stage, 'public/' + f.files[0], f.candidate);
    }
    const bytes = await fs.readFile(path.join(f.stage, 'public', f.files[0]), 'utf8');
    await assert.rejects(
      quarantineRetryChapters(f.root, f.stage, await verificationRows(f.root), f.manifest),
      kind === 'canonical' ? /changedCoreRows/ : /official\/video edge/,
    );
    assert.equal(await fs.readFile(path.join(f.stage, 'public', f.files[0]), 'utf8'), bytes);
  }
});

test('execution placements can be retained but confirmed execution facts cannot be replaced', async (t) => {
  const f = await fixture(t),
    original = structuredClone(f.rejected);
  const occurrence = {
    id: 'exec-node',
    rowId: 'choice',
    missionId: 'quest-1',
    source: 'Act.json',
    pointer: '/OnStart/0',
    sceneId: 'scene',
    conditions: [],
    conditionsHash: 'hash',
    nextIds: [],
  };
  original.executionReading = {
    occurrences: [occurrence],
    placements: [{ occurrenceIds: ['exec-node'] }],
  };
  await f.write(f.root, 'public/' + f.files[0], original);
  f.candidate.executionReading = { occurrences: [structuredClone(occurrence)], placements: [] };
  await f.write(f.stage, 'public/' + f.files[0], f.candidate);
  await quarantineRetryChapters(f.root, f.stage, await verificationRows(f.root), f.manifest);
  assert.deepEqual(
    (await f.read(f.stage, 'public/' + f.files[0])).executionReading,
    original.executionReading,
  );
  f.candidate.executionReading.occurrences[0].pointer = '/Other/0';
  await f.write(f.stage, 'public/' + f.files[0], f.candidate);
  await assert.rejects(
    quarantineRetryChapters(f.root, f.stage, await verificationRows(f.root), f.manifest),
    /confirmed execution occurrence/,
  );
});

test('rejected admissions need explicit review and an unchanged chapter is not quarantined', async (t) => {
  const f = await fixture(t);
  f.candidate.rows.push({ ...f.candidate.rows[1], id: 'new-admission' });
  await f.write(f.stage, 'public/' + f.files[0], f.candidate);
  await assert.rejects(
    quarantineRetryChapters(f.root, f.stage, await verificationRows(f.root), f.manifest),
    /chapter admissions/,
  );
  await f.write(f.stage, 'public/' + f.files[0], f.rejected);
  assert.deepEqual(
    await quarantineRetryChapters(f.root, f.stage, await verificationRows(f.root), f.manifest),
    [],
  );
});
