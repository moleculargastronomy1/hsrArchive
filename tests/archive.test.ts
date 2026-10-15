import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacentChapter, readerPath, searchEntries } from '../src/lib/archive.ts';
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
    category: 'readable',
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
    searchEntries(entries, '기록', 'readable', 'jarilo').map((item) => item.id),
    ['snow'],
  );
  assert.equal(searchEntries(entries, '', 'readable', 'space-station').length, 0);
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
});
