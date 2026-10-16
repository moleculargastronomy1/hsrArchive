import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { archive } from '../src/data/archive.ts';
import { searchEntries } from '../src/lib/archive.ts';

test('in-game books preserve every exact source identity, region, series, collection and volume', () => {
  const provenance = JSON.parse(fs.readFileSync('public/books-provenance.json', 'utf8'));
  const entries = archive.filter((entry) => entry.category === 'books');
  const search = JSON.parse(fs.readFileSync('public/content/search-index.json', 'utf8'));
  const searchIds = new Set(search.rows.map((row: { id: string }) => row.id));
  const ids = new Set<number>();
  const series = new Set<number>();
  let bookshelf = 0,
    documents = 0,
    images = 0;
  assert.equal(entries.length, provenance.coverage.regions);
  assert.ok(entries.length >= 6);
  for (const entry of entries) {
    let lastSeries = 0,
      lastVolume = 0;
    for (const chapter of entry.chapters) {
      const payload = JSON.parse(fs.readFileSync(`public/${chapter.content!.file}`, 'utf8'));
      const row = payload.rows[0];
      assert.equal(payload.rows.length, 1);
      assert.equal(row.entryId, entry.id);
      assert.equal(row.chapterId, chapter.id);
      assert.equal(row.mission, chapter.group);
      assert.equal(row.scene, chapter.title);
      assert.match(row.textHash, /^\d+$/);
      assert.ok(BigInt(row.textHash) > 0n);
      assert.ok(!/<\/?(?:align|size|color|unbreak|b|i)(?:=[^>]*)?>/i.test(row.text));
      assert.ok(searchIds.has(row.id));
      assert.equal(ids.has(payload.book.id), false);
      ids.add(payload.book.id);
      series.add(payload.book.seriesId);
      assert.ok(payload.book.seriesId >= lastSeries);
      if (payload.book.seriesId === lastSeries) assert.ok(payload.book.volume >= lastVolume);
      lastSeries = payload.book.seriesId;
      lastVolume = payload.book.volume;
      assert.equal(payload.book.bookshelf, chapter.collection === 'bookshelf');
      bookshelf += Number(payload.book.bookshelf);
      documents += Number(!payload.book.bookshelf);
      images += Number(payload.book.hasImages);
      if (payload.book.hasImages) assert.ok(chapter.contentNote!.includes('삽화'));
      for (const language of ['en', 'zh-CN', 'ja']) {
        const translated = JSON.parse(
          fs.readFileSync(
            `public/content/locales/${language}/${entry.id}--${chapter.id}.json`,
            'utf8',
          ),
        );
        assert.ok(translated.rows.some((item: { id: string }) => item.id === row.id));
      }
    }
  }
  assert.deepEqual(provenance.coverage, {
    books: ids.size,
    series: series.size,
    regions: entries.length,
    bookshelf,
    documents,
    booksWithImages: images,
  });
  assert.ok(ids.size > 1000);
  assert.ok(searchEntries(archive, '꽃다발', 'books').length > 0);
});

test('book conversion verifies precise hashes, volume ties, missing joins and non-bookshelf documents', () => {
  const python = process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, ['tests/test_books.py'], {
    stdio: 'pipe',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
});
