import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trailblazeTitleFiles,
  scopeBwikiRequests,
  alignBwiki,
} from '../scripts/bwiki-verification.mjs';

test('full and scoped retries restore existing imported proofs with new admission disabled', () => {
  for (const simulation of [true, false]) {
    const calls: { script: string; args: string[] }[] = [];
    alignBwiki(
      (script: string, args: string[]) => calls.push({ script, args }),
      'stage',
      'raw',
      'plan',
      'baseline',
      { simulation },
    );
    const replay = calls.find((call) => call.script === 'import-bwiki-chapters.py')!;
    assert.ok(replay);
    assert.equal(replay.args.at(-1), '--revalidate-existing');
    assert.equal(replay.args.at(-2), 'baseline');
    assert.equal(
      calls.some((call) => call.script === 'import-simulation-events.py'),
      simulation,
    );
    assert.equal(calls[0].script, 'bwiki-dialogue.py');
  }
});

test('a targeted BWIKI retry requires one exact chapter title', () => {
  const entries = [
    { chapters: [{ title: '제8막: 어제의 내일이 되어', content: { file: 'target' } }] },
  ];
  assert.deepEqual([...trailblazeTitleFiles(entries, '어제의 내일이 되어')], ['target']);
  assert.throws(() => trailblazeTitleFiles(entries, '어제'));
  assert.throws(() => trailblazeTitleFiles([...entries, ...entries], '어제의 내일이 되어'));
});

test('a targeted retry includes official subquests and excludes unrelated requests and reviews', () => {
  const request = {
    requests: [
      { title: 'current', missionId: 1 },
      { title: 'official subquest', missionId: 2, missionIds: [2, 3] },
      { title: 'discovered', missionId: 4 },
      { title: 'other', missionId: 5 },
    ],
    review: [{ missionId: 3 }, { missionId: 5 }],
  };
  scopeBwikiRequests(
    request,
    new Set(['target']),
    new Map([['a', { file: 'target', missionId: 'quest-1' }]]),
    { missionCatalog: { target: [{ id: 3 }] } },
    { chapters: [{ file: 'target', groups: [{ title: 'discovered' }] }] },
  );
  assert.deepEqual(
    request.requests.map((item) => item.title),
    ['current', 'official subquest', 'discovered'],
  );
  assert.deepEqual(request.review, [{ missionId: 3 }]);
});
