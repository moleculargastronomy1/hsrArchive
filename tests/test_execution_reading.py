import copy
import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'scripts' / file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


flow = load('execution_flow_tests', 'restore-dialogue-flow.py')
projection = load('execution_projection_tests', 'execution-placement.py')
source_first = load('execution_source_first_tests', 'source-first.py')


def talk(*ids, kind='PlayAndWaitSimpleTalk'):
    return {'$type': 'RPG.GameCore.' + kind, 'SimpleTalkList': [{'TalkSentenceID': n} for n in ids]}


def task(kind, **values): return {'$type': 'RPG.GameCore.' + kind, **values}
def document(*sequences): return {'OnStartSequece': [{'TaskList': s} for s in sequences]}
def pairs(graph):
    return {(graph['nodes'][e['from']]['talkId'], graph['nodes'][e['to']]['talkId'])
            for e in graph['edges'] if e['status'] == 'confirmed'}


class LocalExecutionTests(unittest.TestCase):
    def test_opaque_timeline_keeps_local_lists_without_bridging(self):
        graph = flow.execution_slices(document([talk(1), task('PlayTimeline', TimelineName='missing.playable'), talk(2, 3)]))
        self.assertEqual(pairs(graph), {(2, 3)})
        self.assertTrue(graph['review'])

    def test_actual_signal_routes_options_to_shared_response(self):
        graph = flow.execution_slices(document([
            task('PlayOptionTalk', OptionList=[{'TalkSentenceID': 1, 'TriggerCustomString': 'not-an-id'},
                                             {'TalkSentenceID': 2, 'TriggerCustomString': 'not-an-id'}])],
            [task('WaitCustomString', CustomString={'Value': 'not-an-id'}), talk(3, 4)]))
        self.assertEqual(pairs(graph), {(1, 3), (2, 3), (3, 4)})

    def test_marker_digits_and_missing_timeline_are_not_responses(self):
        graph = flow.execution_slices(document([
            task('PlayOptionTalk', OptionList=[{'TalkSentenceID': 1, 'TriggerCustomString': 'TalkSentence_3'}])],
            [task('WaitCustomString', CustomString='TalkSentence_3'), task('PlayTimeline'), talk(3)]))
        self.assertEqual(pairs(graph), set())

    def test_parallel_sequences_have_no_inferred_order(self):
        graph = flow.execution_slices(document([talk(1, 2)], [talk(3, 4)]))
        self.assertEqual(pairs(graph), {(1, 2), (3, 4)})

    def test_repetition_uses_occurrence_pointers(self):
        graph = flow.execution_slices(document([talk(1, 2, 1)]))
        self.assertEqual(len(graph['nodes']), 3)
        self.assertEqual(pairs(graph), {(1, 2), (2, 1)})
        self.assertTrue(all(e['status'] == 'confirmed' for e in graph['edges']))

    def test_missing_record_and_disabled_tasks_do_not_bridge(self):
        broken = talk(1, 999999999, 2)
        disabled = {**talk(3), 'TaskEnabled': False}
        graph = flow.execution_slices(document([broken, disabled, talk(4)]))
        self.assertNotIn((1, 2), pairs(graph))
        self.assertNotIn((2, 4), pairs(graph))
        self.assertEqual(next(n for n in graph['nodes'].values() if n['talkId'] == 3)['status'], 'tentative')

    def test_unknown_record_actions_block_edges_but_keep_positions(self):
        value = talk(1, 2); value['SimpleTalkList'][0]['SuccessTaskList'] = [talk(3)]
        graph = flow.execution_slices(document([value]))
        self.assertEqual(pairs(graph), set())
        self.assertEqual(len(graph['nodes']), 2)

    def test_nonblocking_talk_wait_is_required_between_tasks(self):
        self.assertEqual(pairs(flow.execution_slices(document([talk(1, kind='PlaySimpleTalk'), talk(2)]))), set())
        self.assertEqual(pairs(flow.execution_slices(document([talk(1, kind='PlaySimpleTalk'), task('WaitSimpleTalkFinish'), talk(2)]))), {(1, 2)})

    def test_explicit_predicate_branches_keep_separate_conditions(self):
        g = flow.execution_slices(document([task('PredicateTaskList', Predicate={'Value': 1},
            SuccessTaskList=[talk(1, 2)], FailedTaskList=[talk(3, 4)]), talk(5)]))
        self.assertEqual(pairs(g), {(1, 2), (3, 4)})
        a, b = (next(n for n in g['nodes'].values() if n['talkId'] == i) for i in [1, 3])
        self.assertNotEqual(a['conditions'], b['conditions'])

    def test_disabled_parent_does_not_activate_its_nested_talk(self):
        g = flow.execution_slices(document([task('PredicateTaskList', TaskEnabled=False,
            SuccessTaskList=[talk(1, 2)])]))
        self.assertTrue(all(n['status'] == 'tentative' for n in g['nodes'].values()))
        self.assertEqual(pairs(g), set())

    def test_unknown_container_is_tentative_and_order_metadata_is_not_a_predicate(self):
        g = flow.execution_slices(document([task('UnknownContainer', TaskList=[talk(1, 2)])]))
        self.assertTrue(all(n['status'] == 'tentative' for n in g['nodes'].values()))
        d = document([talk(3), task('TriggerCustomString', CustomString='go')],
                     [task('WaitCustomString', CustomString='go'), talk(4)])
        d['OnStartSequece'][0]['Order'] = 1
        d['OnStartSequece'][1]['Order'] = 2
        self.assertIn((3, 4), pairs(flow.execution_slices(d)))


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{'id': str(i), 'missionId': 'quest-1', 'mission': '임무', 'talkId': i,
                      'text': '원문' + str(i), 'speaker': '화자', 'type': 'dialogue', 'source': 'old'} for i in [1, 2]]
        self.payload = {'rows': self.rows}
        self.record = {'missions': [{'id': 1}]}
        self.version = {'commit': 'c', 'codeHash': 'a' * 64, 'policyHash': 'b' * 64}

    def graph(self, source):
        return {**flow.execution_slices(document([talk(1, 2)])),
                'proof': {'source': source, 'missionId': 1, 'gitBlob': 'a' * 40, 'sha256': 'b' * 64}}

    def test_projection_preserves_canonical_rows_and_proof_validation(self):
        before = copy.deepcopy(self.payload)
        reading, report = projection.build(self.payload, self.record, {'source': self.graph('source')}, {'1', '2'}, self.version)
        self.assertEqual(self.payload, before)
        self.assertEqual(reading['summary']['newlyPlacedRows'], 2)
        projection.validate(reading, self.rows, 'c')
        bad = copy.deepcopy(reading); bad['occurrences'][0]['rowId'] = '2'
        with self.assertRaises(ValueError): projection.validate(bad, self.rows, 'c')

    def test_multiple_official_invocations_remain_tentative(self):
        reading, report = projection.build(self.payload, self.record,
            {'a': self.graph('a'), 'b': self.graph('b')}, {'1', '2'}, self.version)
        self.assertEqual(reading['summary']['confirmedOccurrences'], 4)
        self.assertEqual(reading['placements'], [])
        self.assertTrue(any(r.get('reason') == 'multiple-official-invocations' for r in report['review']))

    def test_explicit_original_source_can_locate_one_of_several_static_scopes(self):
        self.rows[0]['source'] = 'a'
        reading, _ = projection.build(self.payload, self.record,
            {'a': self.graph('a'), 'b': self.graph('b')}, {'1', '2'}, self.version)
        self.assertEqual(reading['summary']['newlyPlacedRows'], 1)
        selected = reading['placements'][0]['occurrenceIds']
        positions = {p['id']: p for p in reading['occurrences']}
        self.assertEqual(positions[selected[0]]['source'], 'a')

    def test_wrong_mission_and_invalid_original_are_not_admitted(self):
        graph = self.graph('a'); graph['proof']['missionId'] = 2
        reading, _ = projection.build(self.payload, self.record, {'a': graph}, {'1', '2'}, self.version)
        self.assertEqual(reading['occurrences'], [])
        reading, _ = projection.build(self.payload, self.record, {'a': self.graph('a')}, {'1'}, self.version)
        self.assertEqual(reading['summary']['confirmedEdges'], 0)

    def test_large_condition_hashes_survive_javascript_json_publication(self):
        graph = self.graph('a')
        for node in graph['nodes'].values(): node['conditions'] = [{'Predicate': {'Hash': 18446744073709551615}}]
        reading, _ = projection.build(self.payload, self.record, {'a': graph}, {'1', '2'}, self.version)
        self.assertEqual(reading['occurrences'][0]['conditions'][0]['Predicate']['Hash'], '18446744073709551615')
        projection.validate(reading, self.rows, 'c')


class InvocationTests(unittest.TestCase):
    def setUp(self):
        self.root = 'Config/Level/Mission/11/entry.json'
        self.target = 'Story/Discussion/Mission/11/unrelated-name.json'
        self.documents = {
            'info': {'MainMissionID': 11, 'StartSubMissionList': [91]},
            'partial': {'SubMissionList': [
                {'ID': 91, 'MainMissionID': 11, 'MissionJsonPath': self.root},
                {'ID': 92, 'MainMissionID': 11, 'TakeType': 'AnySequence', 'TakeParamIntList': [91]}]},
            self.root: document([task('TriggerPerformance', PerformanceID=777, PerformanceType='D')]),
            self.target: document([task('LevelPerformanceInitialize', PerformanceType='D'), talk(10)])}
        self.tables = {'ExcelOutput/PerformanceDS.json': [{'PerformanceID': 777, 'PerformancePath': self.target}]}

    def test_performance_table_and_reachable_submission_prove_call_without_filename_guess(self):
        calls, relations, _ = projection.invocation_index(self.documents, self.tables)
        self.assertEqual(calls[self.target][0]['mainMissionId'], 11)
        self.assertEqual(calls[self.target][0]['performanceId'], 777)
        self.assertEqual(relations[0]['fromSubMission'], 91)
        self.assertEqual(relations[0]['toSubMission'], 92)
        self.assertIn('not-dialogue-adjacency', relations[0]['status'])

    def test_absent_table_or_wrong_runtime_type_never_manufactures_call(self):
        calls, _, _ = projection.invocation_index(self.documents, {})
        self.assertNotIn(self.target, calls)

    def test_disabled_caller_does_not_create_performance_invocation(self):
        self.documents[self.root] = document([task('PredicateTaskList', TaskEnabled=False,
            SuccessTaskList=[task('TriggerPerformance', PerformanceID=777, PerformanceType='D')])])
        calls, _, _ = projection.invocation_index(self.documents, self.tables)
        self.assertNotIn(self.target, calls)
        self.documents[self.target] = document([task('LevelPerformanceInitialize', PerformanceType='C'), talk(10)])
        calls, _, _ = projection.invocation_index(self.documents, self.tables)
        self.assertNotIn(self.target, calls)

    def test_new_original_requires_invocation_and_both_languages(self):
        graph = {**flow.execution_slices(self.documents[self.target]), 'proof':
                 {'source': self.target, 'missionId': 11, 'gitBlob': 'a' * 40, 'sha256': 'b' * 64}}
        graphs = SimpleNamespace(executions={self.target: graph}, invocations={})
        payload = {'entryId': 'e', 'chapterId': 'c', 'rows': [{'id': 'bookmark', 'talkId': 1, 'nextIds': ['old']}],
                   'referenceOrder': ['bookmark']}
        record = {'missions': [{'id': 11, 'title': '임무'}]}
        talks = {10: {'TalkSentenceID': 10, 'TalkSentenceText': {'Hash': 123}}}
        unchanged, added = source_first.add_execution_confirmed(payload, record, graphs, talks, {'123': '原文'}, {'123': '한국어'})
        self.assertEqual(added, [])
        graphs.invocations[self.target] = [{'mainMissionId': 11, 'source': 'partial', 'subMissionId': 91}]
        changed, added = source_first.add_execution_confirmed(payload, record, graphs, talks, {'123': '原文'}, {'123': '한국어'})
        self.assertEqual(changed['rows'][0], payload['rows'][0])
        self.assertEqual(len(added), 1)
        self.assertEqual(changed['rows'][1]['missionId'], 'quest-11')
        self.assertEqual(source_first.add_execution_confirmed(changed, record, graphs, talks, {'123': '原文'}, {'123': '한국어'})[1], [])
        self.assertEqual(source_first.add_execution_confirmed(payload, record, graphs, talks, {}, {'123': '한국어'})[1], [])


if __name__ == '__main__': unittest.main()
