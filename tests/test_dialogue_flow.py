import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('flow', Path(__file__).resolve().parents[1] / 'scripts/restore-dialogue-flow.py')
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)


def task(kind, **values):
    return {'$type': 'RPG.GameCore.' + kind, **values}


def talk(identity):
    return task('PlayAndWaitSimpleTalk', SimpleTalkList=[{'TalkSentenceID': identity}])


def sequence(*tasks):
    return {'TaskList': list(tasks)}


class DialogueFlowTest(unittest.TestCase):
    def setUp(self):
        self.source = 'Config/Level/Mission/11/Act/Act11.json'
        # Non-numeric markers prove that matching is based on real listeners.
        self.document = {'OnStartSequece': [
            sequence(talk(100), task('PlayOptionTalk', OptionList=[
                {'TalkSentenceID': 1, 'TriggerCustomString': 'left'},
                {'TalkSentenceID': 2, 'TriggerCustomString': 'right'},
            ])),
            sequence(task('WaitCustomString', CustomString={'Value': 'left'}), talk(101),
                     task('TriggerCustomString', CustomString={'Value': 'merge'})),
            sequence(task('WaitCustomString', CustomString={'Value': 'right'}), talk(102),
                     task('TriggerCustomString', CustomString={'Value': 'merge'})),
            sequence(task('WaitCustomString', CustomString={'Value': 'merge'}), talk(103)),
        ]}
        self.payload = {'rows': [self.row(identity) for identity in [1, 2, 100, 101, 102, 103]]}

    def row(self, identity):
        return {'id': str(identity), 'missionId': 'quest-11', 'talkId': identity,
                'source': self.source, 'type': 'choice' if identity in [1, 2] else 'dialogue',
                'text': str(identity), 'speaker': 'speaker'}

    def test_explicit_branches_merge_after_all_alternatives_and_preserve_every_row(self):
        before = copy.deepcopy(self.payload['rows'])
        accepted, _ = flow.restore(self.payload, {self.source: self.document})
        self.assertEqual(accepted, [self.source])
        self.assertEqual([row['talkId'] for row in self.payload['rows']], [100, 1, 2, 101, 102, 103])
        rows = {row['talkId']: row for row in self.payload['rows']}
        self.assertEqual(rows[1]['nextIds'], ['101'])
        self.assertEqual(rows[2]['nextIds'], ['102'])
        self.assertEqual(rows[101]['nextIds'], ['103'])
        self.assertEqual(rows[101]['replyToIds'], ['1'])
        self.assertEqual({row['id'] for row in before}, {row['id'] for row in self.payload['rows']})

    def test_missing_structure_restores_original_order_and_removes_stale_links(self):
        flow.restore(self.payload, {self.source: self.document})
        flow.restore(self.payload, {})
        self.assertEqual([row['talkId'] for row in self.payload['rows']], [1, 2, 100, 101, 102, 103])
        self.assertTrue(all(row['flowStatus'] == 'review' and 'nextIds' not in row for row in self.payload['rows']))

    def test_uncertain_rows_keep_their_exact_positions_and_repeated_runs_are_stable(self):
        other = {**self.row(999), 'source': 'unknown.playable'}
        self.payload['rows'].insert(2, other)
        flow.restore(self.payload, {self.source: self.document})
        self.assertIs(self.payload['rows'][2], other)
        first = copy.deepcopy(self.payload)
        flow.restore(self.payload, {self.source: self.document})
        self.assertEqual(self.payload, first)

    def test_missing_text_duplicate_occurrences_and_foreign_owners_are_not_promoted(self):
        cases = [self.payload['rows'] + [{**self.row(101), 'id': 'duplicate-location'}],
                 [{**row, 'missionId': 'quest-12'} for row in self.payload['rows']]]
        for rows in cases:
            payload = {'rows': copy.deepcopy(rows)}
            accepted, _ = flow.restore(payload, {self.source: self.document})
            self.assertEqual(accepted, [])
            self.assertEqual([row['id'] for row in payload['rows']], [row['id'] for row in rows])

    def test_partial_scene_links_existing_replies_but_never_reorders_or_hides_missing_boundary(self):
        self.payload['rows'] = self.payload['rows'][:-1]
        before = [row['id'] for row in self.payload['rows']]
        accepted, review = flow.restore(self.payload, {self.source: self.document})
        self.assertEqual(accepted, [self.source])
        self.assertEqual([row['id'] for row in self.payload['rows']], before)
        self.assertEqual(review[0]['missingTalkIds'], [103])
        rows = {row['talkId']: row for row in self.payload['rows']}
        self.assertEqual(rows[1]['nextIds'], ['101'])
        self.assertTrue(rows[101]['flowBoundary'])
        self.assertEqual(rows[101]['nextIds'], [])

    def test_cycles_missing_listeners_disabled_and_unknown_timeline_stay_unresolved(self):
        documents = []
        missing = copy.deepcopy(self.document)
        missing['OnStartSequece'][0]['TaskList'][1]['OptionList'][0]['TriggerCustomString'] = 'missing'
        documents.append(missing)
        cycle = copy.deepcopy(self.document)
        cycle['OnStartSequece'][-1]['TaskList'].append(task('TriggerCustomString', CustomString={'Value': 'left'}))
        documents.append(cycle)
        disabled = copy.deepcopy(self.document)
        disabled['OnStartSequece'][0]['TaskList'][0]['TaskEnabled'] = False
        documents.append(disabled)
        timeline = copy.deepcopy(self.document)
        timeline['OnStartSequece'][0]['TaskList'].insert(0, task('PlayTimeline', TimelineName='missing.playable'))
        documents.append(timeline)
        unknown = copy.deepcopy(self.document)
        unknown['OnStartSequece'][0]['TaskList'].insert(0, task('UnknownSignalDispatcher'))
        documents.append(unknown)
        for document in documents:
            with self.assertRaises(flow.Unresolved):
                flow.scene_graph(document)


if __name__ == '__main__':
    unittest.main()
