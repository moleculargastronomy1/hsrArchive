import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('localizations', Path(__file__).resolve().parents[1] / 'scripts/import-localizations.py')
localizations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(localizations)


class LocalizationTest(unittest.TestCase):
    def test_exact_64_bit_hash_and_choice(self):
        key = 18446744073709551615
        row = {'id': 'choice-1', 'talkId': 123, 'text': '[개척자] 선택', 'type': 'choice'}
        talks = {123: {'TalkSentenceText': {'Hash': key}, 'TextmapTalkSentenceName': {'Hash': key - 1}}}
        hashes = localizations.row_hashes(row, talks, {}, {}, {})
        result = localizations.localize_row(row, hashes, {str(key): '**{NICKNAME}** 선택'},
                                           {str(key): '<color=#fff>{NICKNAME} choice</color>', str(key - 1): 'Speaker'}, 'en')
        self.assertEqual(result, {'id': 'choice-1', 'text': '[Trailblazer] choice', 'speaker': 'Speaker'})
        self.assertEqual(row['type'], 'choice')

    def test_missing_hash_stale_korean_and_empty_translation_do_not_guess(self):
        row = {'id': 'row', 'text': '원문'}
        for keys, korean, translated in [((None, None), {}, {}),
                                         ((123, None), {'123': '이전 원문'}, {'123': 'Text'}),
                                         ((123, None), {'123': '원문'}, {'123': ''}),
                                         ((123, None), {'123': '원문'}, {'124': 'Similar text'})]:
            self.assertIsNone(localizations.localize_row(row, keys, korean, translated, 'en'))

    def test_databank_variants_and_chapter_introduction_use_exact_source_records(self):
        row = {'id': 'row', 'source': 'NounAtlas:102'}
        self.assertEqual(localizations.row_hashes(row, {}, {'row': 'wrong'}, {102: {'NounDesc': {'Hash': 123}}}, {}), (123, None))
        row['source'] = 'ExcelOutput/MissionChapterConfig.json:105009/ChapterDesc'
        self.assertEqual(localizations.row_hashes(row, {}, {}, {}, {105009: {'ChapterDesc': {'Hash': 456}}}), (456, None))
        self.assertEqual(localizations.row_hashes({'id': 'row'}, {}, {'row': '9876543210987654321'}, {}, {}), ('9876543210987654321', None))
        self.assertEqual(localizations.row_hashes({'id': 'book', 'textHash': '18446744073709551615'}, {}, {}, {}, {}), ('18446744073709551615', None))


if __name__ == '__main__':
    unittest.main()
