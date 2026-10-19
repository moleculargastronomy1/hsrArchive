import copy
import hashlib
import importlib.util
import json
import tempfile
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

    def test_search_reflects_removed_external_proofs_before_optional_bwiki_alignment(self):
        parent = Path(__file__).resolve().parents[1] / '.cache/tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as folder:
            root = Path(folder)

            def write(file, value):
                target = root / file
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(value), encoding='utf-8')
                return target.read_bytes()

            commit = 'a' * 40
            file = 'public/content/entry--chapter.json'
            payload = copy.deepcopy(self.payload)
            for row in payload['rows']:
                row.update(entryId='entry', chapterId='chapter', mission='mission',
                           bwikiStatus='matched', bwikiScene='old-wiki', bwikiNextIds=[],
                           bwikiReplyToIds=[], bwikiPage='page', bwikiRevision=123,
                           bwikiMissionId='quest-11', bwikiMission='old mission',
                           videoStatus='screen-matched', videoId='12345678901', videoStartMs=0,
                           videoScene='old-video', videoNextIds=[], videoReplyToIds=[])
            original = copy.deepcopy(payload['rows'])
            search_rows = [{**{key: value for key, value in row.items()
                              if key not in ['missionId', 'talkId', 'source']},
                            'source': hashlib.sha256(row['source'].encode()).hexdigest()[:16]}
                           for row in original]
            write(file, payload)
            write('public/content/search-index.json', {'rows': search_rows})
            write('public/content-update.json', {'commit': commit})
            write('src/data/imported-content.json', {'entry/chapter': {
                'file': 'content/entry--chapter.json', 'rows': len(original)}})
            write('src/data/simulation.json', [])
            data = json.dumps(self.document).encode()
            sha = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
            blobs = root / '.cache/blobs'
            blobs.mkdir(parents=True)
            (blobs / sha).write_bytes(data)
            write('.cache/flow.json', {'schema': 'hsr-dialogue-flow-input.v1', 'commit': commit,
                                     'blobs': str(blobs), 'files': [{'path': self.source, 'sha': sha}]})
            flow.run(root, root / '.cache/flow.json')
            rows = json.loads((root / file).read_bytes())['rows']
            search = json.loads((root / 'public/content/search-index.json').read_bytes())['rows']
            expected = [{**{key: value for key, value in row.items()
                            if key not in ['missionId', 'talkId', 'source']},
                         'source': hashlib.sha256(row['source'].encode()).hexdigest()[:16]} for row in rows]
            self.assertEqual(search, expected)
            self.assertTrue(all(row['flowStatus'] == 'verified' for row in rows))
            self.assertTrue(all(not any(key.startswith(('bwiki', 'video')) for key in row) for row in rows))
            for row in rows:
                before = next(item for item in original if item['id'] == row['id'])
                for key in ['id', 'text', 'speaker', 'type', 'missionId', 'talkId', 'source']:
                    self.assertEqual(row[key], before[key])


if __name__ == '__main__':
    unittest.main()
