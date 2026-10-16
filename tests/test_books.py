import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('books', Path(__file__).resolve().parents[1] / 'scripts/import-books.py')
books = importlib.util.module_from_spec(spec)
spec.loader.exec_module(books)


class BooksTest(unittest.TestCase):
    def setUp(self):
        self.hash = 18446744073709551615
        self.texts = {'1': '우주정거장 「헤르타」', '2': '시리즈', '3': '제1권',
                      str(self.hash): '<align="center"><b>원문</b></align>\\n{NICKNAME}',
                      '4': '제2권', str(self.hash - 1): '다른 원문'}
        self.worlds = [{'BookSeriesWorld': 1, 'BookSeriesWorldTextmapID': {'Hash': 1}}]
        self.series = [{'BookSeriesID': 10, 'BookSeriesWorld': 1, 'BookSeries': {'Hash': 2},
                        'BookSeriesNum': 2, 'IsShowInBookshelf': True}]
        self.volumes = [
            {'BookID': 20, 'BookSeriesID': 10, 'BookSeriesInsideID': 2, 'BookInsideName': {'Hash': 4},
             'BookContent': {'Hash': self.hash - 1}, 'LocalBookImagePath': ['source image']},
            {'BookID': 10, 'BookSeriesID': 10, 'BookSeriesInsideID': 1, 'BookInsideName': {'Hash': 3},
             'BookContent': {'Hash': self.hash}, 'LocalBookImagePath': []},
        ]

    def convert(self):
        return books.convert(self.series, self.volumes, self.worlds, self.texts, 'a' * 40)

    def test_exact_hashes_order_regions_and_image_note(self):
        entries, payloads, coverage = self.convert()
        chapters = entries[0]['chapters']
        self.assertEqual(entries[0]['world'], 'space-station')
        self.assertEqual([ch['id'] for ch in chapters], ['book-10', 'book-20'])
        self.assertEqual(chapters[0]['group'], '시리즈')
        row = payloads['public/' + chapters[0]['content']['file']]['rows'][0]
        self.assertEqual(row['textHash'], str(self.hash))
        self.assertEqual(row['text'], '원문\n[개척자]')
        self.assertIn('삽화', chapters[1]['contentNote'])
        self.assertEqual(coverage['booksWithImages'], 1)

    def test_duplicate_volume_order_keeps_both_unique_book_ids(self):
        self.volumes[0]['BookSeriesInsideID'] = 1
        entries, _, _ = self.convert()
        self.assertEqual([ch['id'] for ch in entries[0]['chapters']], ['book-10', 'book-20'])

    def test_documents_outside_bookshelf_are_preserved(self):
        self.series[0].pop('IsShowInBookshelf')
        entries, _, coverage = self.convert()
        self.assertEqual(coverage['documents'], 2)
        self.assertEqual(entries[0]['chapters'][0]['collection'], 'document')

    def test_unlinked_text_series_missing_volume_and_duplicate_identity_are_rejected(self):
        self.volumes[0]['BookContent']['Hash'] = 123456789
        with self.assertRaises(ValueError): self.convert()
        self.setUp()
        self.volumes[0]['BookSeriesID'] = 999
        with self.assertRaises(ValueError): self.convert()
        self.setUp()
        self.volumes.pop()
        with self.assertRaises(ValueError): self.convert()
        self.setUp()
        self.volumes[0]['BookID'] = 10
        with self.assertRaises(ValueError): self.convert()


if __name__ == '__main__':
    unittest.main()
