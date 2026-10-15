import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('projection', Path(__file__).resolve().parents[1] / 'scripts/project-upstream-content.py')
projection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projection)


class ProjectionTest(unittest.TestCase):
    def setUp(self):
        self.row = {'id': 'row', 'talkId': 123, 'entryId': 'entry', 'chapterId': 'chapter',
                    'mission': 'mission', 'scene': 'scene', 'source': 'scene/choice',
                    'type': 'choice', 'speaker': 'old', 'text': 'preserved'}

    def test_exact_hash_and_branch_identity(self):
        key = 18446744073709551615
        talk = {123: {'TalkSentenceText': {'Hash': key}, 'TextmapTalkSentenceName': {'Hash': key - 1}}}
        texts = {str(key): '**{NICKNAME}**\u00a0선택', str(key-1): '{NICKNAME}'}
        updated, matched = projection.refresh_row(self.row, talk, texts, {})
        self.assertTrue(matched)
        self.assertEqual(updated['text'], '[개척자] 선택')
        self.assertEqual(updated['speaker'], '[개척자]')
        for field in ['id', 'mission', 'scene', 'source', 'type']:
            self.assertEqual(updated[field], self.row[field])
        self.assertEqual(self.row['text'], 'preserved')

    def test_missing_and_empty_text_retain_original(self):
        for talks, texts in [({}, {}), ({123: {'TalkSentenceText': {'Hash': 1}}}, {'1': ''})]:
            updated, matched = projection.refresh_row(self.row, talks, texts, {})
            self.assertFalse(matched)
            self.assertEqual(updated, self.row)

    def test_existing_narration_hash(self):
        narration = {**self.row, 'talkId': None, 'type': 'narration'}
        updated, matched = projection.refresh_row(narration, {}, {'12345678901234567890': '갱신 본문'}, {'row': '12345678901234567890'})
        self.assertTrue(matched)
        self.assertEqual(updated['text'], '갱신 본문')

    def test_invalid_publication_is_rejected(self):
        for path in ['../secret.json', 'content/../../secret.json', '/content/entry.json']:
            with self.assertRaises(ValueError):
                projection.safe_payload(path)
        payload = {'schema':'hsr-dialogue.v1','entryId':'entry','chapterId':'chapter','rows':[self.row]}
        projection.validate_payload(payload,'entry','chapter')
        with self.assertRaises(ValueError):
            projection.validate_payload(payload,'wrong-entry','chapter')
        payload['rows'] = [{**self.row, 'text': None}]
        with self.assertRaises(ValueError):
            projection.validate_payload(payload,'entry','chapter')

    def test_default_sentinel_and_invalid_talk_identity(self):
        self.assertEqual(list(projection.index_talk_rows([{}, {'TalkSentenceID':123}])), [123])
        for rows in [[{}], [{'VoiceID':123}], [{'TalkSentenceID':123}, {'TalkSentenceID':123}]]:
            with self.assertRaises(ValueError):
                projection.index_talk_rows(rows)


if __name__ == '__main__':
    unittest.main()
