import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('source_first', Path(__file__).resolve().parents[1] / 'scripts/source-first.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class SourceFirstTests(unittest.TestCase):
    def setUp(self):
        self.page = {'pageId': 3, 'pageTitle': '任务', 'revision': 9, 'sha256': 'a' * 64}
        self.node = {'id': 'one', 'kind': 'line', 'chinese': '一句话。', 'speaker': '角色', 'official': [],
                     'rowRefs': [], 'branch': [], 'context': [], 'status': 'pending'}
        self.record = {'talkId': 10, 'textHash': '99', 'text': '한국어 원문', 'speaker': '화자',
                       'koreanHash': s.b.digest('한국어 원문'), 'chineseHash': 'b'*64, 'speakerHash': 'c'*64}
        self.key = ('line', s.b.comparable('一句话。'), '角色')
        self.proof = {'missionId': 1, 'source': 'Config/Level/Mission/1/Act/test.json',
                      'pointer': '/OnStartSequece/0/TaskList/0/SimpleTalkList/0', 'conditions': []}

    def test_global_unique_text_never_establishes_mission_ownership(self):
        s.match_occurrence(self.node, {self.key: [self.record]}, {}, {1}, {})
        self.assertEqual(self.node['status'], 'content-only')
        self.assertNotIn('missionId', self.node)

    def wiki_node(self):
        node = {**copy.deepcopy(self.node), 'page': '任务', 'pageId': 3, 'revision': 9, 'location': [0, 0],
                'pageSha256': 'a'*64}
        scope = {'kind': 'bwiki-mission', 'chapterId': 7, 'page': '任务', 'pageId': 3, 'revision': 9,
                 'sha256': 'a'*64, 'source': 'https://wiki.biligame.com/sr/task?oldid=9'}
        s.match_occurrence(node, {self.key: [self.record]}, {}, {1}, {}, scope)
        return node, scope

    def test_validated_wiki_mission_admits_original_without_claiming_execution(self):
        node, scope = self.wiki_node()
        self.assertEqual(node['status'], 'wiki-confirmed')
        self.assertEqual(node['ownership'], [])
        payload = {'entryId': 'e', 'chapterId': 'c', 'rows': [], 'referenceOrder': []}
        result = {'chapter': {'missions': [{'id': 1, 'title': '임무'}]}, 'occurrences': [node],
                  'orderComparisons': [{'from': node['id'], 'to': 'other', 'officialComparison': 'potential-order-conflict'}]}
        changed, additions = s.add_confirmed(payload, result)
        row = changed['rows'][0]
        self.assertEqual(row['missionEvidence'], 'bwiki')
        self.assertNotIn('nextIds', row)
        self.assertEqual(row['flowStatus'], 'review')
        chapter = {'chapterId': 7, 'missions': [{'id': 1}], 'sources': [
            {'pageTitle': '任务', 'pageId': 3, 'revision': 9, 'sha256': 'a'*64, 'sourceUrl': scope['source']}]}
        public_node = {**node, 'officialIds': [10]}
        reading = {'missions': [{'id': node['missionId'], 'officialMissionIds': [1]}],
                   'occurrences': [{'id': node['id'], 'rowId': row['id'], 'page': '任务', 'revision': 9, 'location': [0, 0]}]}
        s.placement.validate_admission(additions[0], row, public_node, chapter, reading)
        for key, value in [('speaker', '다른 화자'), ('text', '잘못된 원문'), ('textHash', '100'), ('missionId', 'quest-2')]:
            bad = {**row, key: value}
            with self.assertRaisesRegex(ValueError, 'BWIKI original admission'):
                s.placement.validate_admission(additions[0], bad, public_node, chapter, reading)
        with self.assertRaisesRegex(ValueError, 'display position'):
            s.placement.validate_admission(additions[0], row, public_node, chapter, {**reading, 'occurrences': []})

    def test_wiki_scope_does_not_resolve_ambiguous_official_ids_or_page_missions(self):
        node, scope = self.wiki_node()
        for missions, records in [(set(), [self.record]), ({1}, [self.record, {**self.record, 'talkId': 11}])]:
            fresh = {**copy.deepcopy(self.node), 'location': [0, 0]}
            s.match_occurrence(fresh, {self.key: records}, {}, missions, {}, scope)
            self.assertNotEqual(fresh['status'], 'wiki-confirmed')

    def test_shared_wiki_document_has_its_own_scope_without_guessing_official_mission(self):
        node, scope = self.wiki_node()
        s.match_occurrence(node, {self.key: [self.record]}, {}, {1, 2}, {}, scope)
        self.assertEqual(node['status'], 'wiki-confirmed')
        self.assertTrue(node['missionId'].startswith('wiki-mission-'))
        self.assertEqual(node['wikiProof']['catalogMissionIds'], [1, 2])

    def test_typed_exact_reference_confirms_ownership(self):
        s.match_occurrence(self.node, {self.key: [self.record]}, {(10, 'line'): [self.proof]}, {1}, {})
        self.assertEqual(self.node['status'], 'confirmed')
        self.assertEqual(self.node['missionId'], 1)

    def test_wrong_role_or_other_mission_cannot_confirm(self):
        for owners in [{(10, 'choice'): [self.proof]}, {(10, 'line'): [{**self.proof, 'missionId': 2}]}]:
            node = copy.deepcopy(self.node)
            s.match_occurrence(node, {self.key: [self.record]}, owners, {1}, {})
            self.assertEqual(node['status'], 'content-only')

    def test_multiple_official_ids_not_resolved_by_local_row(self):
        s.match_occurrence(self.node, {self.key: [self.record, {**self.record, 'talkId': 11}]},
                           {(10, 'line'): [self.proof]}, {1}, {10: [{'id': 'old'}]})
        self.assertEqual(self.node['status'], 'pending')
        self.assertEqual(self.node['candidateTalkIds'], [10, 11])

    def test_multiple_missions_in_same_page_still_ambiguous(self):
        s.match_occurrence(self.node, {self.key: [self.record]}, {(10, 'line'): [self.proof, {**self.proof, 'missionId': 2}]}, {1, 2}, {})
        self.assertEqual(self.node['status'], 'content-only')

    def test_empty_normalization_does_not_absorb_a_pause(self):
        node = {**self.node, 'chinese': '……'}
        s.match_occurrence(node, {('line', '', '角色'): [self.record]}, {(10, 'line'): [self.proof]}, {1}, {})
        self.assertEqual(node['reason'], 'empty-normalized-content')
        self.assertEqual(node['official'], [])

    def test_new_translation_similarity_is_not_a_matching_method(self):
        node = {**self.node, 'chinese': '另一句近似的话。'}
        s.match_occurrence(node, {self.key: [self.record]}, {(10, 'line'): [self.proof]}, {1}, {})
        self.assertEqual(node['reason'], 'no-exact-official-candidate')

    def test_narration_stage_direction_is_not_official_dialogue(self):
        node = {**self.node, 'kind': 'narration'}
        s.match_occurrence(node, {self.key: [self.record]}, {(10, 'line'): [self.proof]}, {1}, {})
        self.assertEqual(node['status'], 'pending')

    def test_exact_unnamed_narration_is_admitted_without_execution_reference(self):
        talks = [{'TalkSentenceID': 10, 'TalkSentenceText': {'Hash': 99}}]
        index = s.global_candidates(talks, {'99': '一句话。'}, {'99': '한국어 원문'})
        node, scope = self.wiki_node()
        node.update(kind='narration', speaker='', official=[], rowRefs=[], status='pending')
        s.match_occurrence(node, index, {}, {1}, {}, scope)
        self.assertEqual(node['status'], 'wiki-confirmed')
        self.assertEqual(node['ownership'], [])
        payload = {'entryId': 'e', 'chapterId': 'c', 'rows': []}
        result = {'chapter': {'missions': [{'id': 1, 'title': '임무'}]}, 'occurrences': [node], 'orderComparisons': []}
        changed, additions = s.add_confirmed(payload, result)
        row = changed['rows'][0]
        self.assertEqual((row['type'], row['speaker']), ('narration', ''))
        self.assertNotIn('nextIds', row)
        chapter = {'chapterId': 7, 'missions': [{'id': 1}], 'sources': [
            {'pageTitle': '任务', 'pageId': 3, 'revision': 9, 'sha256': 'a'*64, 'sourceUrl': scope['source']}]}
        reading = {'missions': [{'id': node['missionId'], 'officialMissionIds': [1]}],
                   'occurrences': [{'id': node['id'], 'rowId': row['id'], 'page': '任务', 'revision': 9, 'location': [0, 0]}]}
        public_node = {**node, 'officialIds': [10]}
        s.placement.validate_admission(additions[0], row, public_node, chapter, reading)
        with self.assertRaisesRegex(ValueError, 'role match'):
            s.placement.validate_admission(additions[0], {**row, 'type': 'dialogue'}, public_node, chapter, reading)

    def test_narration_keeps_ambiguous_ids_named_speech_and_non_game_directions_pending(self):
        _, scope = self.wiki_node()
        talk = {'TalkSentenceID': 10, 'TalkSentenceText': {'Hash': 99}}
        for talks in [[talk, {**talk, 'TalkSentenceID': 11}],
                      [{**talk, 'TextmapTalkSentenceName': {'Hash': 9}}], []]:
            index = s.global_candidates(talks, {'99': '一句话。', '9': '角色'}, {'99': '한국어 원문', '9': '화자'})
            node = {**copy.deepcopy(self.node), 'kind': 'narration', 'speaker': '', 'location': [0, 0]}
            s.match_occurrence(node, index, {}, {1}, {}, scope)
            self.assertEqual(node['status'], 'pending')
            self.assertEqual(node['official'], [])

    def test_unknown_nodes_are_never_bridged(self):
        nodes, edges = s.inventory([[{'kind': 'line', 'text': '前', 'speaker': '甲'},
                                    {'kind': 'unsupported'}, {'kind': 'line', 'text': '后', 'speaker': '甲'}]], self.page, 1)
        self.assertEqual(edges[nodes[0]['id']], [])
        self.assertNotEqual(nodes[0]['id'], nodes[2]['id'])

    def test_condition_and_fold_labels_survive_without_cross_edges(self):
        raw = '{{#tag:tabber|条件甲=\n*甲：前。\n{{!}}-{{!}}条件乙=\n*甲：后。\n}}\n{{折叠|标题=额外对话|内容=*甲：其他。}}'
        segments = s.b.parse_body(raw, True, True)
        nodes, edges = s.inventory(segments, self.page, 1)
        self.assertEqual(nodes[0]['context'][0]['condition'], '条件甲')
        self.assertEqual(nodes[1]['context'][0]['condition'], '条件乙')
        self.assertEqual(nodes[2]['context'][0]['fold'], '额外对话')
        self.assertTrue(all(not e for e in edges.values()))

    def test_same_official_id_has_distinct_branch_occurrences(self):
        segments = s.b.parse_body('{{剧情选项|选项1=甲|剧情1=*甲：相同。|选项2=乙|剧情2=*甲：相同。}}', True, True)
        nodes, edges = s.inventory(segments, self.page, 1)
        replies = [n for n in nodes if n['kind'] == 'line']
        self.assertNotEqual(replies[0]['id'], replies[1]['id'])
        self.assertNotEqual(replies[0]['branch'], replies[1]['branch'])
        self.assertNotIn(replies[1]['id'], edges[replies[0]['id']])

    def test_act8_different_scope_is_neither_conflict_nor_false_positive(self):
        a = {**self.node, 'official': [{'talkId': 146783614}]}
        x = {**self.node, 'official': [{'talkId': 146783615}]}
        owners = {(146783614, 'line'): [self.proof], (146783615, 'line'): [{**self.proof, 'source': 'different.playable'}]}
        graphs = {self.proof['source']: {'146783614': [146783616], '146783616': []}}
        self.assertEqual(s.classify_order(a, x, owners, graphs), 'execution-scope-unverified')
        z = {**self.node, 'official': [{'talkId': 146783616}]}
        owners[(146783616, 'line')] = [self.proof]
        self.assertEqual(s.classify_order(a, z, owners, graphs), 'compatible-local-order')

    def test_partial_additions_preserve_rows_bookmarks_and_no_inferred_order(self):
        s.match_occurrence(self.node, {self.key: [self.record]}, {(10, 'line'): [self.proof]}, {1}, {})
        payload = {'entryId': 'entry', 'chapterId': 'chapter', 'rows': [{'id': 'bookmark', 'talkId': 2, 'nextIds': ['old']}],
                   'referenceOrder': ['bookmark']}
        result = {'chapter': {'missions': [{'id': 1, 'title': '임무'}]}, 'occurrences': [self.node], 'orderComparisons': []}
        changed, additions = s.add_confirmed(payload, result)
        self.assertEqual(changed['rows'][0], payload['rows'][0])
        self.assertEqual(payload['referenceOrder'], ['bookmark'])
        self.assertEqual(len(additions), 1)
        self.assertNotIn('nextIds', changed['rows'][1])
        self.assertEqual(changed['rows'][1]['flowStatus'], 'review')
        self.assertEqual(len(s.add_confirmed(changed, result)[1]), 0)

    def test_corrupt_official_blob_stops_shared_validator(self):
        cache = Path(__file__).resolve().parents[1] / '.cache/tests'
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as folder:
            data = b'{"OnStartSequece": []}'
            blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
            Path(folder, blob).write_bytes(data + b'corruption')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                s.structure_index({'schema': 'hsr-dialogue-flow-input.v1', 'commit': 'c', 'blobs': folder,
                                   'files': [{'path': self.proof['source'], 'sha': blob}]}, 'c')

    def test_checkpoint_requires_matching_inputs_and_intact_result(self):
        cache = Path(__file__).resolve().parents[1] / '.cache/tests'
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as folder:
            target = Path(folder, 'checkpoint.json')
            result = {'confirmed': 2, 'pending': 7}
            s.write(target, {'key': 'all-inputs-code-policy-v1', 'sha256': s.digest(result), 'result': result})
            self.assertEqual(s.checkpoint(target, 'all-inputs-code-policy-v1'), result)
            self.assertIsNone(s.checkpoint(target, 'code-or-policy-changed'))
            saved = s.read(target)
            saved['result']['confirmed'] = 9
            s.write(target, saved)
            self.assertIsNone(s.checkpoint(target, 'all-inputs-code-policy-v1'))

    def test_document_audit_resumes_after_interruption_and_invalidates_changed_policy(self):
        cache = Path(__file__).resolve().parents[1] / '.cache/tests'
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache) as folder:
            work = Path(folder)
            pages = {}
            record = {'id': 7, 'chineseTitle': '系列', 'missions': []}
            for identity, title in [(1, '任务甲'), (2, '任务乙')]:
                data = ('{{任务|任务名称=' + title + '|任务类型=开拓任务|系列任务=系列}}\n==剧情内容==\n*角色：一句话。').encode()
                file = work / (str(identity) + '.wiki')
                file.write_bytes(data)
                pages[title] = {'title': title, 'pageTitle': title, 'pageId': identity, 'revision': 9,
                                'status': 'available', 'sha256': hashlib.sha256(data).hexdigest(), 'file': str(file)}
                record['missions'].append({'id': identity, 'title': '임무', 'chineseTitle': title})
            original = s.inventory
            calls = []
            def interrupted(*args):
                calls.append(1)
                if len(calls) == 2:
                    raise RuntimeError('simulated interruption')
                return original(*args)
            version = {'policyHash': 'first'}
            args = (record, {'rows': []}, pages, {self.key: [self.record]}, {}, {})
            with patch.object(s, 'inventory', side_effect=interrupted):
                with self.assertRaisesRegex(RuntimeError, 'simulated interruption'):
                    s.audit_chapter(*args, cache=(work, version))
            with patch.object(s, 'inventory', wraps=original) as resumed:
                result = s.audit_chapter(*args, cache=(work, version))
                self.assertEqual(resumed.call_count, 1)
                self.assertEqual(len(result['occurrences']), 2)
            with patch.object(s, 'inventory', wraps=original) as changed:
                s.audit_chapter(*args, cache=(work, {'policyHash': 'changed'}))
                self.assertEqual(changed.call_count, 2)


if __name__ == '__main__':
    unittest.main()
