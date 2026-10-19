import importlib.util
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
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

    def test_auto_discovered_introductions_follow_changed_chapter_hashes(self):
        row = {**self.row, 'talkId': None, 'type': 'narration', 'textHash': '1',
               'source': 'ExcelOutput/MissionChapterConfig.json:900/ChapterDesc'}
        updated, matched = projection.refresh_row(row, {}, {'2': '새 소개문'}, {},
                                                   {900: {'ChapterDesc': {'Hash': 2}}})
        self.assertTrue(matched)
        self.assertEqual(updated['text'], '새 소개문')
        self.assertEqual(updated['textHash'], '2')
        self.assertEqual(updated['id'], row['id'])

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

    def test_projection_keeps_preserved_and_new_chapter_descriptors_in_sync(self):
        parent = Path(__file__).resolve().parents[1] / '.cache/tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as folder:
            root, raw, stage = [Path(folder) / name for name in ['root', 'raw', 'stage']]
            old_commit, commit = 'a' * 40, 'b' * 40

            def write(base, file, value):
                target = base / file
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
                return target.read_bytes()

            tables = {
                'TextMap/TextMapKR.json': {'1': '갱신된 선택', '2': '제1막•제1장', '3': '새로운 장'},
                'ExcelOutput/TalkSentenceConfig.json': [
                    {'TalkSentenceID': 123, 'TalkSentenceText': {'Hash': 1}}],
                'ExcelOutput/MissionChapterConfig.json': [
                    {'ID': 900, 'ChapterType': 'Normal', 'ChapterSequence': {'Hash': 2},
                     'ChapterName': {'Hash': 3}}],
            }
            manifest = {'commit': commit, 'repository': 'DimbreathBot/TurnBasedGameData',
                        'version': 'OSPRODWin1.0.0_TEST', 'checkedAt': '2026-10-20T00:00:00Z', 'files': []}
            for file, value in tables.items():
                data = write(raw, Path(file).name, value)
                manifest['files'].append({'path': file, 'sha': hashlib.sha1(
                    f'blob {len(data)}\0'.encode() + data).hexdigest()})
            write(raw, 'plan.json', manifest)
            legacy_rows = [
                {**self.row, 'missionId': 'quest-1', 'nextIds': ['reply'],
                 'flowScene': 'scene', 'flowStatus': 'verified'},
                {**self.row, 'id': 'reply', 'talkId': 456, 'type': 'dialogue',
                 'text': '연결되지 않은 기존 원문', 'replyToIds': ['row'],
                 'bwikiStatus': 'cached', 'bwikiScene': 'scene'},
            ]
            new_row = {**self.row, 'id': 'new-row', 'chapterId': 'new', 'text': '새 장의 원문'}
            metadata = {}
            chapters = []
            for chapter_id, rows, reference in [('chapter', legacy_rows, old_commit),
                                                 ('new', [new_row], commit)]:
                file = f'content/entry--{chapter_id}.json'
                content = {'file': file, 'rows': len(rows), 'missing': 0,
                           'sourceIds': ['quest-1'], 'textReferenceCommit': reference}
                metadata['entry/' + chapter_id] = content
                chapters.append({'id': chapter_id, 'title': chapter_id, 'content': copy.deepcopy(content),
                                 'upstreamChapterId': 900, 'blocks': []})
                write(root if chapter_id == 'chapter' else stage, 'public/' + file, {
                    'schema': 'hsr-dialogue.v1', 'entryId': 'entry', 'chapterId': chapter_id,
                    'referenceCommit': reference, 'textReferenceCommit': reference, 'rows': rows})
            entries = [{'id': 'entry', 'title': '보존된 목차', 'chapters': chapters}]
            for file, value in {
                'src/data/imported-content.json': metadata, 'src/data/trailblaze.json': entries,
                'src/data/text-bindings.json': {}, 'src/data/codex.json': [],
                'src/data/simulation.json': [], 'src/data/books.json': [],
                'src/data/train-databank.json': {'commit': commit, 'files': {}, 'groups': []},
                'src/data/astropolis-intro.json': {'commit': commit, 'files': {}, 'documents': []},
                '.cache/trailblaze-receipt.json': {'payloads': ['public/content/entry--new.json']},
            }.items():
                write(stage, file, value)
            write(root, 'public/content/search-index.json', {'sourceReferences': [], 'referenceCommit': old_commit})
            root_bytes = {file: file.read_bytes() for file in root.rglob('*.json')}
            subprocess.run([sys.executable, str(Path(projection.__file__).resolve()),
                            str(root), str(raw), str(raw / 'plan.json')], cwd=stage,
                           check=True, capture_output=True)
            load = lambda file: json.loads((stage / file).read_bytes())
            projected = load('src/data/trailblaze.json')
            descriptors = load('src/data/imported-content.json')
            for before, after in zip(chapters, projected[0]['chapters']):
                expected = {**before['content'], 'textReferenceCommit': commit}
                self.assertEqual(after, {**before, 'content': expected})
                self.assertEqual(after['content'], descriptors['entry/' + after['id']])
            updated_rows = load('public/content/entry--chapter.json')['rows']
            self.assertEqual(updated_rows[0], {**legacy_rows[0], 'text': '갱신된 선택'})
            self.assertEqual(updated_rows[1], legacy_rows[1])
            self.assertEqual(load('public/content/entry--new.json')['rows'], [new_row])
            self.assertEqual(load('public/content-update.json')['retainedTextRows'], 1)
            self.assertIn('src/data/trailblaze.json', load('receipt.json')['files'])
            self.assertTrue(all(file.read_bytes() == data for file, data in root_bytes.items()))
            # A disagreement must fail before rewriting any staged evidence.
            for field, value in [('rows', 99), ('sourceIds', ['quest-999']),
                                 ('file', 'content/foreign--chapter.json'),
                                 ('textReferenceCommit', 'c' * 40)]:
                with self.subTest(conflicting_field=field):
                    write(stage, 'src/data/imported-content.json', metadata)
                    conflicting = copy.deepcopy(entries)
                    conflicting[0]['chapters'][0]['content'][field] = value
                    write(stage, 'src/data/trailblaze.json', conflicting)
                    before = {file: file.read_bytes() for file in stage.rglob('*.json')}
                    result = subprocess.run(
                        [sys.executable, str(Path(projection.__file__).resolve()),
                         str(root), str(raw), str(raw / 'plan.json')], cwd=stage, capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(b'Conflicting Trailblaze content descriptor: entry/chapter', result.stderr)
                    self.assertTrue(all(file.read_bytes() == data for file, data in before.items()))


if __name__ == '__main__':
    unittest.main()
