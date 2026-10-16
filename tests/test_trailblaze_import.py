import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os

spec = importlib.util.spec_from_file_location('trailblaze', Path(__file__).resolve().parents[1] / 'scripts/import-trailblaze.py')
trailblaze = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trailblaze)


class TrailblazeTest(unittest.TestCase):
    def setUp(self):
        self.chapter = {'ID': 900, 'ChapterType': 'Normal', 'ChapterSequence': {'Hash': 1},
                        'ChapterName': {'Hash': 2}, 'ChapterDesc': {'Hash': 3}}
        self.missions = [{'MainMissionID': 11, 'Type': 'Main', 'ChapterID': 900, 'Name': {'Hash': 4}}]
        self.texts = {'1': '제5막•제8장', '2': '다음\u00a0이야기', '3': '소개문', '4': '첫 임무',
                      '18446744073709551615': '<color=#fff>{NICKNAME}</color>의 대사',
                      '6': '{NICKNAME}', '7': '첫 선택', '8': '두 번째 선택'}
        self.entries = [{'id': 'paradise-records', 'arcLabel': '제5장 — 이상 낙원', 'chapters': []}]
        self.record = trailblaze.discover([self.chapter], self.missions, self.texts, self.entries)[0]
        self.path = 'Config/Level/Mission/11/Talk/Talk_1.json'
        self.structures = {self.path: {'OnStartSequece': [{'TaskList': [
            {'$type': 'RPG.GameCore.PlayAndWaitSimpleTalk', 'SimpleTalkList': [
                {'$type': 'RPG.GameCore.SimpleTalkInfo', 'TalkSentenceID': 101}]},
            {'$type': 'RPG.GameCore.PlayOptionTalk', 'OptionList': [
                {'$type': 'RPG.GameCore.OptionTalkInfo', 'TalkSentenceID': 102},
                {'$type': 'RPG.GameCore.OptionTalkInfo', 'TalkSentenceID': 103}]}]}]}}
        self.talks = {101: {'TalkSentenceText': {'Hash': 18446744073709551615},
                            'TextmapTalkSentenceName': {'Hash': 6}},
                      102: {'TalkSentenceText': {'Hash': 7}},
                      103: {'TalkSentenceText': {'Hash': 8}}}

    def test_title_search_and_exact_chapter_ownership(self):
        unrelated = {'MainMissionID': 1100, 'Type': 'Main', 'ChapterID': 901, 'Name': {'Hash': 4}}
        for query in ['다음 이야기', '첫 임무']:
            records = trailblaze.discover([self.chapter], self.missions + [unrelated], self.texts, self.entries, query)
            self.assertEqual([mission['id'] for mission in records[0]['missions']], [11])
            self.assertEqual(records[0]['entryId'], 'paradise-records')
        self.assertEqual(trailblaze.discover([self.chapter], self.missions, self.texts, self.entries, '없는 제목'), [])
        self.assertEqual(trailblaze.discover([{**self.chapter, 'ChapterType': 'Activity'}], self.missions, self.texts, self.entries), [])

    def test_old_routes_and_renamed_titles_keep_official_identity(self):
        chapter = {'id': 'saved-route', 'title': '제8막: 다음 이야기', 'content': {'rows': 10}}
        entries = [{**self.entries[0], 'chapters': [chapter]}]
        record = trailblaze.discover([self.chapter], self.missions, self.texts, entries)[0]
        self.assertTrue(record['preserved'])
        self.assertEqual(record['chapterId'], 'saved-route')
        chapter['upstreamChapterId'] = 900
        record = trailblaze.discover([self.chapter], self.missions, {**self.texts, '2': '변경 제목'}, entries)[0]
        self.assertEqual(record['chapterId'], 'saved-route')
        entries[0]['chapters'].append({**chapter, 'id': 'duplicate'})
        with self.assertRaises(ValueError):
            trailblaze.discover([self.chapter], self.missions, self.texts, entries)

    def test_choices_exact_large_hashes_and_foreign_mission_exclusion(self):
        structures = {**self.structures, 'Story/Mission/1100/Story.json': self.structures[self.path]}
        rows, issues = trailblaze.extract_chapter(self.record, structures, self.talks, self.texts)
        self.assertEqual(issues, [])
        self.assertEqual([row['type'] for row in rows], ['dialogue', 'choice', 'choice'])
        self.assertEqual(rows[0]['speaker'], '[개척자]')
        self.assertEqual(rows[0]['text'], '[개척자]의 대사')
        self.assertTrue(all(row['missionId'] == 'quest-11' for row in rows))
        self.assertEqual(len(set(row['id'] for row in rows)), 3)

    def test_missing_structures_and_unsupported_references_block_promotion(self):
        self.assertTrue(trailblaze.extract_chapter(self.record, {}, self.talks, self.texts)[1])
        for task in [
                {'$type': 'RPG.GameCore.PlayTimeline', 'TimelineName': 'Story/Mission/11/missing.playable'},
                {'$type': 'RPG.GameCore.TriggerPerformance', 'PerformanceID': 123},
                {'$type': 'RPG.GameCore.UnknownDialogue', 'TalkSentenceID': 101},
                {'$type': 'RPG.GameCore.CreateLevelGraph', 'GraphPath': 'unavailable.json'}]:
            structure = json.loads(json.dumps(self.structures))
            structure[self.path]['OnStartSequece'][0]['TaskList'].append(task)
            self.assertTrue(trailblaze.extract_chapter(self.record, structure, self.talks, self.texts)[1])
        self.assertTrue(trailblaze.extract_chapter(self.record, self.structures, self.talks, {**self.texts, '7': ''})[1])
        for path in ['../secret.json', 'Story/Mission/11/../../secret.json', 'Story/Mission/1100/x.layout.json']:
            with self.assertRaises(ValueError):
                trailblaze.structure_owner(path)

    def test_new_intro_promotes_only_when_all_missions_are_linked_and_reruns_are_stable(self):
        cache = Path('.cache').resolve()
        cache.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='test-trailblaze-', dir=cache) as directory:
            root = Path(directory)
            trailblaze.write(root, 'src/data/imported-content.json', {})
            files, coverage = trailblaze.publish(root, self.entries, [self.record], {}, self.talks, self.texts, 'a' * 40)
            entries = json.loads((root / 'src/data/trailblaze.json').read_bytes())
            chapter = entries[0]['chapters'][0]
            self.assertEqual(coverage[0]['status'], 'pending')
            payload_path = root / files[0]
            self.assertEqual(len(json.loads(payload_path.read_bytes())['rows']), 1)
            records = trailblaze.discover([self.chapter], self.missions, self.texts, entries)
            files, coverage = trailblaze.publish(root, entries, records, self.structures, self.talks, self.texts, 'a' * 40)
            payload = json.loads(payload_path.read_bytes())
            self.assertEqual(coverage[0]['status'], 'structured')
            self.assertEqual(len(payload['rows']), 4)
            self.assertEqual(payload['rows'][0]['id'], 'trailblaze-intro-900')
            entries = json.loads((root / 'src/data/trailblaze.json').read_bytes())
            records = trailblaze.discover([self.chapter], self.missions, self.texts, entries)
            trailblaze.publish(root, entries, records, self.structures, self.talks, self.texts, 'a' * 40)
            self.assertEqual(json.loads(payload_path.read_bytes()), payload)
            # Losing upstream structures must not erase a previously verified body.
            trailblaze.publish(root, entries, records, {}, self.talks, self.texts, 'b' * 40)
            self.assertEqual(json.loads(payload_path.read_bytes()), payload)

    def test_one_missing_mission_keeps_entire_chapter_pending(self):
        record = {**self.record, 'missions': self.record['missions'] + [{'id': 12, 'title': '둘째 임무'}]}
        self.assertTrue(trailblaze.extract_chapter(record, self.structures, self.talks, self.texts)[1])

    def test_branch_replies_keep_dialogue_roles_and_separate_context_boundaries(self):
        structures = json.loads(json.dumps(self.structures))
        options = structures[self.path]['OnStartSequece'][0]['TaskList'][1]['OptionList']
        for option in options:
            option['SuccessTaskList'] = [{'$type': 'RPG.GameCore.PlaySimpleTalk', 'TalkSentenceID': 101}]
        rows, issues = trailblaze.extract_chapter(self.record, structures, self.talks, self.texts)
        self.assertEqual(issues, [])
        self.assertEqual([row['type'] for row in rows], ['dialogue', 'choice', 'dialogue', 'choice', 'dialogue'])
        self.assertEqual(len(set(row['id'] for row in rows)), 5)
        self.assertNotEqual(rows[2]['source'], rows[4]['source'])

    def test_missing_completion_talk_graph_blocks_promotion(self):
        structures = {**self.structures, 'Config/Level/Mission/11/MissionInfo.partial.json': {
            'SubMissionList': [{'ID': 9, 'MainMissionID': 11, 'FinishType': 'Talk', 'ParamStr1': 'Mission_Done'}]}}
        self.assertTrue(trailblaze.extract_chapter(self.record, structures, self.talks, self.texts)[1])
        structures[self.path]['OnStartSequece'][0]['TaskList'].append({
            '$type': 'RPG.GameCore.TriggerCustomString', 'CustomString': {'Value': 'Mission_Done'}})
        self.assertEqual(trailblaze.extract_chapter(self.record, structures, self.talks, self.texts)[1], [])

    def test_new_body_reaches_search_and_comparison_languages_with_verified_inputs(self):
        def module(name, filename):
            spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'scripts' / filename)
            result = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(result)
            return result
        projection = module('projection', 'project-upstream-content.py')
        localization = module('localization', 'import-localizations.py')
        cache = Path('.cache').resolve()
        cache.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='test-trailblaze-', dir=cache) as directory:
            root = Path(directory)
            raw = root / 'raw'
            manifest = {'schema': 'hsr-upstream-plan.v1', 'repository': 'DimbreathBot/TurnBasedGameData',
                        'commit': 'a' * 40, 'version': 'OSPRODWin5.0.0_TEST', 'checkedAt': '2026-10-16T00:00:00Z', 'files': []}
            inputs = {'TextMapKR.json': self.texts, 'MissionChapterConfig.json': [self.chapter],
                      'MainMission.json': self.missions, 'NounAtlas.json': [],
                      'TalkSentenceConfig.json': [{'TalkSentenceID': identity, **row} for identity, row in self.talks.items()]}
            for language in ['EN', 'CHS', 'JP']:
                inputs[f'TextMap{language}.json'] = {**self.texts, '7': 'Translated choice'}
            for name, data in inputs.items():
                trailblaze.write(raw, name, data)
                content = (raw / name).read_bytes()
                blob = trailblaze.hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
                prefix = 'TextMap/' if name.startswith('TextMap') else 'ExcelOutput/'
                manifest['files'].append({'path': prefix + name, 'sha': blob})
            trailblaze.write(root, 'manifest.json', manifest)
            texts, chapters, missions, _, _ = trailblaze.load_inputs(raw, manifest)
            records = trailblaze.discover(chapters, missions, texts, self.entries)
            trailblaze.write(root, 'src/data/imported-content.json', {})
            files, _ = trailblaze.publish(root, self.entries, records, self.structures, self.talks, texts, manifest['commit'])
            for name, data in [('text-bindings', {}), ('codex', []), ('simulation', []), ('books', []),
                               ('train-databank', {'commit': manifest['commit'], 'files': {}, 'groups': []}),
                               ('astropolis-intro', {'commit': manifest['commit'], 'files': {}, 'documents': []})]:
                trailblaze.write(root, f'src/data/{name}.json', data)
            trailblaze.write(root, '.cache/trailblaze-receipt.json', {'payloads': files})
            trailblaze.write(root, 'public/content/search-index.json', {'referenceCommit': 'a' * 40, 'sourceReferences': [], 'rows': []})
            previous_directory = Path.cwd()
            try:
                os.chdir(root)
                projection.project(root, raw, root / 'manifest.json')
                localization.build(root, raw, root / 'manifest.json')
            finally:
                os.chdir(previous_directory)
            search = json.loads((root / 'public/content/search-index.json').read_bytes())['rows']
            self.assertEqual(len(search), 4)
            self.assertEqual(sum(row['type'] == 'choice' for row in search), 2)
            for language in ['en', 'zh-CN', 'ja']:
                translated = json.loads((root / f'public/content/locales/{language}/paradise-records--chapter-900.json').read_bytes())['rows']
                self.assertEqual([row['id'] for row in translated], [row['id'] for row in search])
                self.assertTrue(any(row['text'] == 'Translated choice' for row in translated))
            # A corrupted cached table must fail before any new publication.
            (raw / 'MainMission.json').write_text('[]', encoding='utf-8')
            with self.assertRaises(ValueError):
                trailblaze.load_inputs(raw, manifest)


if __name__ == '__main__':
    unittest.main()
