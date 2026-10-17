import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('integration_audit', Path(__file__).resolve().parents[1] / 'scripts/audit-integrations.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class IntegrationAuditTest(unittest.TestCase):
    def setUp(self):
        self.cn = {'101': '选择。', '102': '回应。', '900': '角色'}
        self.kr = {'101': '선택.', '102': '응답.'}
        self.talks = {identity: {'TalkSentenceText': {'Hash': 100 + identity}, 'TextmapTalkSentenceName': {'Hash': 900}}
                      for identity in [1, 2]}
        self.rows = [{'id': str(identity), 'talkId': identity, 'text': self.kr[str(100 + identity)],
                      'type': 'choice' if identity == 1 else 'dialogue', 'bwikiPage': '任務', 'bwikiRevision': 7,
                      'bwikiMissionId': 'quest-1', 'bwikiScene': 'scene', 'bwikiNextIds': ['2'] if identity == 1 else []}
                     for identity in [1, 2]]
        self.chunk = {'page': '任務', 'revision': 7, 'missionId': 'quest-1', 'order': ['1', '2'],
                      'edges': {'1': ['2'], '2': []}, 'evidence': {row['id']: {
                          'talkId': row['talkId'], 'type': row['type'],
                          **audit.text_proof(row, self.talks, self.cn, self.kr)} for row in self.rows}}
        self.sources = {'任務@7': {'page': '任務', 'revision': 7}}

    def run_audit(self, rows=None, chunk=None, sources=None):
        return audit.evidence_rows({'rows': rows or self.rows}, [chunk or self.chunk],
                                   self.sources if sources is None else sources, self.talks, self.cn, self.kr)

    def test_counts_require_official_text_ids_and_published_branch_agreement(self):
        valid, edges, choices, issues = self.run_audit()
        self.assertEqual(valid, {'1', '2'})
        self.assertEqual(edges, {('1', '2')})
        self.assertEqual(choices, {'1'})
        self.assertEqual(issues, [])
        rows = copy.deepcopy(self.rows)
        rows[0]['bwikiNextIds'] = []
        valid, edges, choices, issues = self.run_audit(rows=rows)
        self.assertEqual(valid, {'2'})
        self.assertEqual(edges, set())
        self.assertEqual(choices, set())
        self.assertEqual(len(issues), 1)

    def test_missing_source_wrong_id_type_and_changed_korean_are_not_counted(self):
        self.assertEqual(self.run_audit(sources={})[0], set())
        for key, value in [('talkId', 99), ('type', 'dialogue'), ('koreanHash', '0' * 64)]:
            chunk = copy.deepcopy(self.chunk)
            chunk['evidence']['1'][key] = value
            self.assertNotIn('1', self.run_audit(chunk=chunk)[0])
        rows = copy.deepcopy(self.rows)
        rows[0]['text'] = '바뀐 한국어 원문.'
        self.assertNotIn('1', self.run_audit(rows=rows)[0])
        self.assertEqual(self.rows[0]['text'], '선택.')

    def test_cached_wiki_and_verified_structure_are_distinct_from_unknown_order(self):
        self.assertTrue(audit.unknown({'flowStatus': 'review', 'bwikiStatus': 'review'}))
        self.assertFalse(audit.unknown({'flowStatus': 'review', 'bwikiStatus': 'cached'}))
        self.assertFalse(audit.unknown({'flowStatus': 'verified', 'bwikiStatus': 'review'}))
        self.assertFalse(audit.unknown({'flowStatus': 'review', 'videoStatus': 'caption-matched'}))


if __name__ == '__main__':
    unittest.main()
