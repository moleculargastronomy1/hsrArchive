import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacentChapter, chapterNumber, readerPath, searchEntries } from '../src/lib/archive.ts';
import { archive } from '../src/data/archive.ts';
import type { ArchiveEntry } from '../src/data/types.ts';

const entries: ArchiveEntry[] = [
  {
    id: 'station',
    title: '우주정거장',
    subtitle: '여정',
    description: '별의 기록',
    category: 'trailblaze',
    world: 'space-station',
    order: 1,
    language: 'ko-KR',
    tags: ['헤르타'],
    source: { kind: 'demo', note: 'test' },
    chapters: [
      {
        id: 'first',
        title: '시작',
        blocks: [{ id: 'one', type: 'dialogue', speaker: '안내자', text: 'Book of Stars' }],
      },
      { id: 'last', title: '끝', blocks: [] },
    ],
  },
  {
    id: 'snow',
    title: '설원',
    subtitle: '도시',
    description: '눈의 기록',
    category: 'simulation',
    world: 'jarilo',
    order: 2,
    language: 'ko-KR',
    tags: ['편지'],
    source: { kind: 'demo', note: 'test' },
    chapters: [{ id: 'memo', title: '메모', blocks: [] }],
  },
];

test('search matches title, tag, chapter, speaker and body, ignoring case and surrounding spaces', () => {
  for (const query of ['우주정거장', '헤르타', '시작', '안내자', '  BOOK stars  ']) {
    assert.deepEqual(
      searchEntries(entries, query).map((item) => item.id),
      ['station'],
    );
  }
});
test('search combines terms and category/world filters', () => {
  assert.equal(searchEntries(entries, '').length, 2);
  assert.equal(searchEntries(entries, '없는 내용').length, 0);
  assert.deepEqual(
    searchEntries(entries, '기록', 'simulation', 'jarilo').map((item) => item.id),
    ['snow'],
  );
  assert.equal(searchEntries(entries, '', 'simulation', 'space-station').length, 0);
});
test('chapter navigation stops at boundaries and rejects unknown chapters', () => {
  assert.equal(adjacentChapter(entries[0], 'first', -1), undefined);
  assert.equal(adjacentChapter(entries[0], 'first', 1)?.id, 'last');
  assert.equal(adjacentChapter(entries[0], 'last', 1), undefined);
  assert.equal(adjacentChapter(entries[0], 'last', -1)?.id, 'first');
  assert.equal(adjacentChapter(entries[0], 'missing', 1), undefined);
});
test('reader paths encode identifiers for static hash routes', () => {
  assert.equal(readerPath('station'), '/entry/station');
  assert.equal(readerPath('station', 'first'), '/entry/station/first');
  assert.equal(readerPath('a/b', 'a b'), '/entry/a%2Fb/a%20b');
  const path = readerPath('a/b', 'a b', 'line ?한글&next=#');
  assert.equal(path.split('?')[0], '/entry/a%2Fb/a%20b');
  assert.equal(new URLSearchParams(path.split('?')[1]).get('dialogue'), 'line ?한글&next=#');
});

test('subchapter numbering preserves main chapter order and navigation', () => {
  const entry: ArchiveEntry = {
    ...entries[0],
    chapters: [
      entries[0].chapters[0],
      { id: 'branch', title: '선택 분기', parentId: 'first', kind: 'branch', blocks: [] },
      entries[0].chapters[1],
    ],
  };
  assert.equal(chapterNumber(entry, 'first'), '01');
  assert.equal(chapterNumber(entry, 'branch'), '01.1');
  assert.equal(chapterNumber(entry, 'last'), '02');
  assert.equal(chapterNumber(entry, 'missing'), '');
  assert.equal(adjacentChapter(entry, 'first', 1)?.id, 'branch');
  assert.equal(adjacentChapter(entry, 'branch', 1)?.id, 'last');
});

test('all supplied trailblaze chapters have unique routes, valid parents and preserved demo dialogue', () => {
  const trailblaze = archive.filter((entry) => entry.category === 'trailblaze');
  const minimums: Record<string, number> = {
    'station-departure': 2,
    'jarilo-records': 3,
    'luofu-records': 6,
    'penacony-records': 8,
    'amphoreus-records': 9,
    'paradise-records': 8,
  };
  for (const [id, count] of Object.entries(minimums))
    assert.ok(trailblaze.find((entry) => entry.id === id)!.chapters.length >= count);
  for (const entry of trailblaze) {
    const visited = new Set<string>();
    for (const chapter of entry.chapters) {
      assert.ok(!visited.has(chapter.id), `${entry.id}: duplicate chapter ID`);
      if (chapter.parentId) assert.ok(visited.has(chapter.parentId), 'Parent must precede child');
      if (
        !chapter.upstreamManaged &&
        !['celestial-gambit', 'penniless-billionaire', 'before-moonrise'].includes(chapter.id)
      )
        assert.ok(
          chapter.blocks.some((block) => block.type === 'dialogue'),
          'Demo dialogue is retained',
        );
      visited.add(chapter.id);
    }
  }
});
