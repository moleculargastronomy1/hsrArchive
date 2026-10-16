import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('bwiki', Path(__file__).resolve().parents[1] / 'scripts/bwiki-dialogue.py')
bwiki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bwiki)


class BwikiDialogueTest(unittest.TestCase):
    @staticmethod
    def key(kind, text, speaker):
        return kind, bwiki.comparable(text), bwiki.normalized(speaker)

    def setUp(self):
        self.script = '''{{任务|任务名称=任務|任务类型=开拓任务}}
==剧情内容==
*角色：开场。
{{剧情选项
|选项1=向左。
|剧情1=*角色：{{颜色|描述|左侧回应。}}
|选项2=向右。
|剧情2=*角色：右侧回应。
}}
*角色：共同后续。
'''
        texts = [(100, '开场。', '시작.'), (1, '向左。', '왼쪽.'), (2, '向右。', '오른쪽.'),
                 (101, '左侧回应。', '왼쪽 응답.'), (102, '右侧回应。', '오른쪽 응답.'),
                 (103, '共同后续。', '공통 후속.')]
        self.rows = [{'id': str(identity), 'talkId': identity, 'entryId': 'entry', 'chapterId': 'chapter',
                      'missionId': 'quest-11', 'mission': '임무', 'scene': 'old', 'speaker': '화자',
                      'type': 'choice' if identity in [1, 2] else 'dialogue', 'source': 'original', 'text': kr}
                     for identity, cn, kr in texts]
        self.index = {self.key('choice' if identity in [1, 2] else 'line', cn, '' if identity in [1, 2] else '角色'): [row]
                      for (identity, cn, kr), row in zip(texts, self.rows)}

    def test_branch_templates_preserve_each_reply_and_common_continuation(self):
        bwiki.validate_mission_page(self.script, '任務')
        with self.assertRaises(bwiki.Unresolved):
            bwiki.validate_mission_page(self.script, '同名书籍')
        parts = bwiki.story_segments(self.script)
        self.assertEqual(len(parts), 1)
        rows, edges = bwiki.compile_segment(parts[0], self.index)
        self.assertEqual([row['id'] for row in rows], ['100', '1', '2', '101', '102', '103'])
        self.assertEqual(edges['1'], ['101'])
        self.assertEqual(edges['2'], ['102'])
        self.assertEqual(edges['101'], ['103'])
        self.assertEqual(edges['102'], ['103'])

    def test_nested_choices_do_not_flatten_branch_ownership(self):
        text = self.script.replace('*角色：{{颜色|描述|左侧回应。}}',
                                   '*角色：{{颜色|描述|左侧回应。}}\n{{剧情选项|选项1=再问。|剧情1=*角色：再次回应。}}')
        index = {**self.index, self.key('choice', '再问。', ''): [{**self.rows[1], 'id': '3'}],
                 self.key('line', '再次回应。', '角色'): [{**self.rows[3], 'id': '104'}]}
        rows, edges = bwiki.compile_segment(bwiki.story_segments(text)[0], index)
        self.assertEqual(edges['101'], ['3'])
        self.assertEqual(edges['3'], ['104'])
        self.assertEqual(edges['104'], ['103'])
        self.assertEqual(edges['2'], ['102'])

    def test_display_only_game_markup_does_not_prevent_matching_or_erase_evidence(self):
        game = '早啊，**{NICKNAME}**。{RUBY_B#「智识星神」}博识尊{RUBY_E#}。——你好。'
        wiki = '早啊，开拓者。博识尊——你好。'
        self.assertEqual(bwiki.normalized(game), bwiki.normalized(wiki))
        self.assertNotEqual(bwiki.canonical(game), bwiki.canonical(wiki))
        self.assertEqual(bwiki.normalized('{RUBY_B#{TEXTJOIN#254}}SNS{RUBY_E#}'), 'SNS')
        self.assertNotEqual(bwiki.normalized('等一下。'), bwiki.normalized('不等了。'))
        self.assertNotEqual(bwiki.normalized('{TEXTJOIN#254}'), bwiki.normalized('{TEXTJOIN#255}'))
        self.assertEqual(bwiki.comparable('「你好！」——开拓者。'), bwiki.comparable('你好，开拓者'))
        self.assertNotEqual(bwiki.comparable('1.5倍'), bwiki.comparable('15倍'))
        self.assertNotEqual(bwiki.comparable('1,000'), bwiki.comparable('1000'))
        self.assertNotEqual(bwiki.normalized('？？？'), bwiki.normalized(''))
        duplicate = {self.key('line', game, '角色'): self.rows[:1] * 2}
        with self.assertRaises(bwiki.Unresolved):
            bwiki.compile_segment([{'kind': 'line', 'speaker': '角色', 'text': wiki}], duplicate)

    def test_simulation_events_preserve_explicit_speaker_choices_and_following_response(self):
        text = self.script.replace('*角色：开场。', '{{事件|星神|角色|开场。}}')
        text = text.replace('*角色：{{颜色|描述|左侧回应。}}', '{{事件|角色|{{颜色|描述|左侧回应。}}}}')
        text = text.replace('*角色：共同后续。', '{{事件|角色|共同后续。}}')
        rows, edges = bwiki.compile_segment(bwiki.story_segments(text)[0], self.index)
        self.assertEqual([row['id'] for row in rows], ['100', '1', '2', '101', '102', '103'])
        self.assertEqual(edges['1'], ['101'])
        self.assertEqual(edges['101'], ['103'])
        unknown = self.script.replace('*角色：开场。', '{{事件|未知分类|角色|开场。}}')
        self.assertEqual(bwiki.story_segments(unknown)[0][0]['kind'], 'unsupported')

    def test_exact_chapter_fallback_recovers_misattributed_cutscene_without_changing_source(self):
        foreign = {**self.rows[0], 'missionId': 'quest-22'}
        key = self.key('line', '开场。', '角色')
        evidence = {foreign['id']: {'text': bwiki.comparable('开场。'), 'speaker': '角色'}}
        index = bwiki.matching_index([], evidence, {key: [foreign]})
        matched, edges = bwiki.compile_segment([{'kind': 'line', 'speaker': '角色', 'text': '开场。'}], index)
        payload = {'rows': [copy.deepcopy(foreign)]}
        bwiki.apply_chunks(payload, [{'missionId': 'quest-11', 'mission': '실제 임무', 'page': '任務', 'revision': 5,
                                     'segment': '0', 'status': 'matched', 'order': [foreign['id']], 'edges': edges}])
        self.assertEqual(payload['rows'][0]['missionId'], 'quest-22')
        self.assertEqual(payload['rows'][0]['bwikiMissionId'], 'quest-11')
        self.assertEqual(payload['rows'][0]['bwikiMission'], '실제 임무')
        self.assertEqual(bwiki.matching_index([], evidence, {key: [foreign, foreign]}), {})
        duplicate = {**foreign, 'id': 'duplicate'}
        local = bwiki.matching_index([foreign, duplicate], {**evidence, duplicate['id']: evidence[foreign['id']]}, {key: [foreign]})
        self.assertEqual(len(local[key]), 2)

    def test_wiki_prerequisites_and_series_numbers_order_missions_without_id_guessing(self):
        fields = bwiki.validate_mission_page(self.script.replace('|任务类型=开拓任务',
            '|任务类型=开拓任务|系列任务=系列|任务编号=02|前置任务=*[[前面]]|后续任务=*[[后面]]'), '任務')
        structure = bwiki.mission_structure(fields, {'前面': ['quest-99'], '后面': ['quest-1']})
        self.assertEqual(structure, {'previous': 'quest-99', 'next': 'quest-1', 'series': '系列', 'number': 2})
        sequence, valid = bwiki.mission_order(['quest-1', 'quest-11', 'quest-99'], {'quest-11': structure})
        self.assertTrue(valid)
        self.assertEqual(sequence, ['quest-99', 'quest-11', 'quest-1'])
        cyclic = {**structure, 'previous': 'quest-1'}
        self.assertEqual(bwiki.mission_order(['quest-1', 'quest-11'], {'quest-11': cyclic}),
                         (['quest-1', 'quest-11'], False))
        ambiguous = bwiki.mission_structure(fields, {'前面': ['quest-99', 'quest-98']})
        self.assertIsNone(ambiguous['previous'])

    def test_connected_rows_follow_one_chapter_sequence_while_unknown_slots_stay_unchanged(self):
        rows = [copy.deepcopy(row) for row in self.rows[:3]]
        rows[0]['missionId'] = 'quest-22'
        rows[1]['missionId'] = 'quest-11'
        rows[2]['missionId'] = 'quest-22'
        unknown = {**self.rows[0], 'id': 'unknown'}
        payload = {'rows': [rows[0], unknown, rows[1], rows[2]]}
        chunks = [{'missionId': mission, 'page': '任務', 'revision': 5, 'segment': mission, 'status': 'matched',
                   'order': identities, 'edges': {identity: [] for identity in identities}}
                  for mission, identities in [('quest-22', ['100', '2']), ('quest-11', ['1'])]]
        bwiki.apply_chunks(payload, chunks, ['quest-11', 'quest-22'])
        self.assertEqual([row['id'] for row in payload['rows']], ['1', 'unknown', '100', '2'])

    def test_optional_questions_and_exit_have_no_inferred_return_or_continuation(self):
        text = self.script.replace('|选项1=向左。', '|选项1=向左。\n|图标1=对话').replace('|选项2=向右。', '|选项2=向右。\n|图标2=退出')
        _, edges = bwiki.compile_segment(bwiki.story_segments(text)[0], self.index)
        self.assertEqual(edges['101'], [])
        self.assertEqual(edges['102'], [])

    def test_missing_duplicate_and_unrecognized_content_create_hard_boundaries(self):
        segment = bwiki.story_segments(self.script)[0]
        duplicate = {**self.index, self.key('line', '开场。', '角色'): self.rows[:1] * 2}
        runs = bwiki.supported_runs(copy.deepcopy(segment), duplicate)
        self.assertEqual(runs[0][0]['kind'], 'unsupported')
        missing = {key: values for key, values in self.index.items() if key[1] != bwiki.comparable('左侧回应。')}
        runs = bwiki.supported_runs(copy.deepcopy(segment), missing)
        self.assertEqual([run[0]['kind'] for run in runs], ['line', 'unsupported', 'line'])
        malformed = self.script.replace('左侧回应。', '{{未知条件|左侧回应。}}')
        parsed = bwiki.story_segments(malformed)
        self.assertTrue(any(run[0]['kind'] == 'unsupported' for part in parsed for run in bwiki.supported_runs(part, self.index)))

    def test_optional_fold_and_scene_notes_never_connect_independent_conversations(self):
        text = '==剧情内容==\n*角色：开场。\n{{折叠|标题=额外对话|内容=*角色：左侧回应。}}\n*角色：共同后续。'
        segments = bwiki.story_segments(text)
        self.assertEqual(len(segments), 3)
        self.assertTrue(all(len(segment) == 1 for segment in segments))

    def test_conflicting_game_edges_and_repeated_wiki_positions_are_not_applied(self):
        index = copy.deepcopy(self.index)
        index[self.key('choice', '向左。', '')][0].update(flowStatus='verified', nextIds=['102'])
        with self.assertRaises(bwiki.Unresolved):
            bwiki.compile_segment(bwiki.story_segments(self.script)[0], index)
        rows, edges = bwiki.compile_segment(bwiki.story_segments(self.script)[0], self.index)
        payload = {'rows': copy.deepcopy(self.rows)}
        chunk = {'missionId': 'quest-11', 'page': '任務', 'revision': 5, 'segment': '1', 'status': 'matched',
                 'order': [row['id'] for row in rows], 'edges': edges}
        self.assertEqual(bwiki.apply_chunks(payload, [chunk, chunk]), [])

    def test_ambiguous_rows_keep_positions_and_alignment_is_repeatable(self):
        rows, edges = bwiki.compile_segment(bwiki.story_segments(self.script)[0], self.index)
        payload = {'rows': list(reversed(copy.deepcopy(self.rows)))}
        unknown = {**self.rows[0], 'id': 'unknown'}
        payload['rows'].insert(2, unknown)
        chunk = {'missionId': 'quest-11', 'page': '任務', 'revision': 5, 'segment': '1', 'status': 'matched',
                 'order': [row['id'] for row in rows], 'edges': edges}
        bwiki.apply_chunks(payload, [chunk])
        self.assertEqual(payload['rows'][2]['id'], 'unknown')
        first = copy.deepcopy(payload)
        bwiki.apply_chunks(payload, [chunk])
        self.assertEqual(first, payload)

    def test_offline_evidence_is_revalidated_and_invalidated_after_official_text_changes(self):
        test_root = Path(__file__).resolve().parents[1] / '.cache/tests'
        test_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='hsr-bwiki-test-', dir=test_root) as temporary:
            root = Path(temporary)
            self.assertTrue(root.resolve().is_relative_to(test_root.resolve()))
            raw = root / 'raw'
            raw.mkdir()
            commit = 'a' * 40
            cn, kr, talks = {'900': '角色'}, {}, []
            for identity, row in zip([100, 1, 2, 101, 102, 103], self.rows):
                text = next(key[1] for key, values in self.index.items() if values[0]['id'] == row['id'])
                key = 18446744073709000000 + identity
                cn[str(key)] = text
                kr[str(key)] = row['text']
                talks.append({'TalkSentenceID': identity, 'TalkSentenceText': {'Hash': key}, 'TextmapTalkSentenceName': {'Hash': 900}})
            files = {'ExcelOutput/MainMission.json': [{'MainMissionID': 11, 'Name': {'Hash': 901}}],
                     'ExcelOutput/TalkSentenceConfig.json': talks, 'TextMap/TextMapCHS.json': cn, 'TextMap/TextMapKR.json': kr}
            plan = {'schema': 'hsr-upstream-plan.v1', 'repository': 'DimbreathBot/TurnBasedGameData', 'commit': commit, 'files': []}
            for name, value in files.items():
                data = json.dumps(value).encode()
                (raw / Path(name).name).write_bytes(data)
                plan['files'].append({'path': name, 'sha': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()})
            plan_file = root / 'plan.json'
            bwiki.write(plan_file, plan)
            bwiki.write(root / 'src/data/imported-content.json', {'entry/chapter': {'file': 'content/entry--chapter.json'}})
            bwiki.write(root / 'src/data/simulation.json', [])
            payload = {'schema': 'hsr-dialogue.v1', 'entryId': 'entry', 'chapterId': 'chapter', 'rows': list(reversed(self.rows))}
            bwiki.write(root / 'public/content/entry--chapter.json', payload)
            bwiki.write(root / 'public/content/search-index.json', {'rows': copy.deepcopy(payload['rows'])})
            bwiki.write(root / 'public/content-update.json', {'commit': commit})
            wiki = root / 'source.wiki'
            wiki.write_bytes(self.script.encode('utf-8'))
            manifest = {'schema': 'hsr-bwiki-input.v1', 'commit': commit, 'checkedAt': '2026-10-16T00:00:00Z',
                        'license': {}, 'review': [], 'pages': [{'missionId': 11, 'status': 'available', 'pageTitle': '任務',
                        'revision': 5, 'file': str(wiki), 'sha256': bwiki.digest(self.script)}]}
            manifest_file = root / 'wiki-plan.json'
            bwiki.write(manifest_file, manifest)
            bwiki.align(root, raw, plan_file, manifest_file)
            result = json.loads((root / 'public/content/entry--chapter.json').read_bytes())
            self.assertEqual(result['bwiki']['matchedRows'], 6)
            self.assertEqual({row['id']: row['text'] for row in result['rows']}, {row['id']: row['text'] for row in self.rows})
            manifest['pages'][0]['status'] = 'unavailable'
            bwiki.write(manifest_file, manifest)
            bwiki.align(root, raw, plan_file, manifest_file)
            result = json.loads((root / 'public/content/entry--chapter.json').read_bytes())
            self.assertEqual(result['bwiki']['cachedRows'], 6)
            audit = json.loads((root / 'public/bwiki-provenance.json').read_bytes())
            self.assertEqual(audit['sources']['任務@5']['sha256'], bwiki.digest(self.script))
            cn[str(18446744073709000100)] = '新版开场。'
            data = json.dumps(cn).encode()
            (raw / 'TextMapCHS.json').write_bytes(data)
            next(file for file in plan['files'] if file['path'] == 'TextMap/TextMapCHS.json')['sha'] = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
            bwiki.write(plan_file, plan)
            bwiki.align(root, raw, plan_file, manifest_file)
            result = json.loads((root / 'public/content/entry--chapter.json').read_bytes())
            self.assertEqual(result['bwiki']['cachedRows'], 0)


if __name__ == '__main__':
    unittest.main()
