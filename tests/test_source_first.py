import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('source_first', Path(__file__).resolve().parents[1] / 'scripts/source-first.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class SourceFirstTests(unittest.TestCase):
    def setUp(self):
        self.page = {'pageId': 3, 'pageTitle': '任务', 'revision': 9, 'sha256': 'a' * 64}
        self.node = {'id': 'one', 'kind': 'line', 'chinese': '一句话。', 'speaker': '角色', 'official': [],
                     'rowRefs': [], 'branch': [], 'context': [], 'status': 'pending'}
        self.record = {'talkId': 10, 'textHash': '99', 'text': '한국어 원문', 'speaker': '화자',
                       'koreanHash': s.b.digest('한국어 원문')}
        self.key = ('line', s.b.comparable('一句话。'), '角色')
        self.proof = {'missionId': 1, 'source': 'Config/Level/Mission/1/Act/test.json',
                      'pointer': '/OnStartSequece/0/TaskList/0/SimpleTalkList/0', 'conditions': []}

    def test_global_unique_text_never_establishes_mission_ownership(self):
        s.match_occurrence(self.node, {self.key: [self.record]}, {}, {1}, {})
        self.assertEqual(self.node['status'], 'content-only')
        self.assertNotIn('missionId', self.node)

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


if __name__ == '__main__':
    unittest.main()
