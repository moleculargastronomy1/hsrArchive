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

    def test_latest_notice_follows_numbered_main_story_not_afterwords_or_table_order(self):
        def chapter(id, sequence_hash, title_hash, chapter_type='Normal'):
            return {'ID': id, 'ChapterType': chapter_type,
                    'ChapterSequence': {'Hash': sequence_hash}, 'ChapterName': {'Hash': title_hash}}
        texts = {'1': '제5막•제7장', '2': '달\u00a0뜨기 전, 괴수와 춤을',
                 '3': '제4막•제8장', '4': '이전 장', '5': '제5막•후문3',
                 '6': '후문', '7': '제6막•제1장', '8': '<color=#fff>새로운 여정</color>'}
        rows = [chapter(105009, 1, 2), chapter(104010, 3, 4), chapter(105010, 5, 6), {}]
        expected = {'id': 105009, 'chapter': 5, 'act': 7, 'title': '달 뜨기 전, 괴수와 춤을'}
        self.assertEqual(projection.latest_trailblaze_chapter(rows, texts), expected)
        rows.append(chapter(999999, 7, 8, 'Activity'))
        self.assertEqual(projection.latest_trailblaze_chapter(rows, texts), expected)
        rows.insert(0, chapter(106001, 7, 8))
        self.assertEqual(projection.latest_trailblaze_chapter(rows, texts),
                         {'id': 106001, 'chapter': 6, 'act': 1, 'title': '새로운 여정'})
        with self.assertRaises(ValueError):
            projection.latest_trailblaze_chapter(rows, {**texts, '8': ''})
        with self.assertRaises(ValueError):
            projection.latest_trailblaze_chapter([], texts)


if __name__ == '__main__':
    unittest.main()
