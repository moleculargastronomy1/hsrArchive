import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('s', Path(__file__).resolve().parents[1] / 'scripts/source-first.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class PlacementTest(unittest.TestCase):
    def setUp(self):
        self.record = {'id':77, 'missions':[{'id':11,'title':'임무','chineseTitle':'任务'}]}
        self.cn = {'9':'角色', '100':'开始', '101':'回应', '102':'结束', '201':'左', '202':'右'}
        self.kr = {'9':'화자', '100':'시작', '101':'응답', '102':'종료', '201':'왼쪽', '202':'오른쪽'}
        self.talks = [{'TalkSentenceID':i,'TalkSentenceText':{'Hash':i},'TextmapTalkSentenceName':{'Hash':0 if i>200 else 9}} for i in [100,101,102,201,202]]
        self.rows = [{'id':str(i),'talkId':i,'textHash':str(i),'text':self.kr[str(i)],'speaker':'' if i>200 else '화자',
                     'type':'choice' if i>200 else 'dialogue','missionId':'quest-11','mission':'임무','source':'official',
                     'scene':'old','flowStatus':'review','bwikiStatus':'review'} for i in [100,101,102,201,202]]
        self.page = {'pageTitle':'任务','pageId':1,'revision':5,'sha256':'a'*64}
        self.owners = {(i,'choice' if i>200 else 'line'):[{'missionId':11,'source':'Story/Mission/11/A.json',
            'pointer':f'/SimpleTalkList/{n}','conditions':[]}] for n,i in enumerate([100,101,102,201,202])}
        self.version = {'commit':'c'*40,'codeHash':'b'*64,'policyHash':'d'*64,'policyVersion':2}

    def build(self, text):
        nodes, graph = s.inventory(s.b.story_segments('==剧情内容==\n'+text,True,True),self.page,77)
        audit={'sources':[self.page],'documents':[],'occurrences':nodes,'wikiGraph':graph}
        return s.placement.build(self.record,{'rows':self.rows},audit,self.talks,self.cn,self.kr,self.owners,[],s.b,s.imports,self.version)

    def test_repeated_content_shares_the_original_row_and_preserves_each_position(self):
        before=copy.deepcopy(self.rows)
        reading=self.build('*角色：开始\n*角色：回应\n----\n*角色：回应\n*角色：结束')
        repeated=[p for p in reading['occurrences'] if p['rowId']=='101']
        self.assertEqual(len(repeated),2)
        self.assertNotEqual(repeated[0]['id'],repeated[1]['id'])
        self.assertNotEqual(repeated[0]['sceneId'],repeated[1]['sceneId'])
        self.assertNotIn(repeated[1]['id'],repeated[0]['nextIds'])
        self.assertEqual(self.rows,before)
        s.placement.validate(reading,self.rows,'c'*40)

    def test_wiki_display_does_not_require_or_mutate_official_mission_ownership(self):
        self.owners = {}
        for row in self.rows:
            row['missionId'] = 'quest-99'
        before = copy.deepcopy(self.rows)
        reading = self.build('*角色：开始\n{{剧情选项|选项1=左|剧情1=*角色：回应}}\n*角色：结束')
        self.assertEqual({p['rowId'] for p in reading['occurrences']}, {'100','101','102','201'})
        self.assertTrue(any(p['replyToIds'] for p in reading['occurrences']))
        self.assertEqual(self.rows, before)
        s.placement.validate(reading, self.rows, 'c'*40)

    def test_unnamed_narration_uses_wiki_position_and_preserves_branch_boundaries(self):
        self.cn['300'], self.kr['300'] = '旁白原文', '내레이션 원문'
        self.talks.append({'TalkSentenceID': 300, 'TalkSentenceText': {'Hash': 300}})
        self.rows.append({'id': '300', 'talkId': 300, 'textHash': '300', 'text': '내레이션 원문',
            'speaker': '', 'type': 'narration', 'missionId': 'quest-11', 'mission': '임무', 'source': 'official'})
        self.owners = {}
        reading = self.build('*角色：开始\n:旁白原文\n{{剧情选项|选项1=左|剧情1=:旁白原文|选项2=右|剧情2=}}\n*角色：结束')
        positions = [p for p in reading['occurrences'] if p['rowId'] == '300']
        self.assertEqual(len(positions), 2)
        self.assertNotEqual(positions[0]['id'], positions[1]['id'])
        self.assertNotEqual(positions[0]['branch'], positions[1]['branch'])
        right = next(p for p in reading['occurrences'] if p['rowId'] == '202')
        self.assertEqual(right['nextIds'], [])
        s.placement.validate(reading, self.rows, 'c'*40)

    def test_explicit_responses_are_separate_and_an_empty_choice_gets_no_guessed_response(self):
        reading=self.build('*角色：开始\n{{剧情选项|选项1=左|剧情1=*角色：回应|选项2=右|剧情2=}}\n*角色：结束')
        by_row={p['rowId']:p for p in reading['occurrences']}
        self.assertEqual(by_row['201']['nextIds'],[by_row['101']['id']])
        self.assertEqual(by_row['101']['replyToIds'],[by_row['201']['id']])
        self.assertEqual(by_row['202']['nextIds'],[])
        self.assertEqual(reading['summary']['newChoiceReplyLinks'],1)
        s.placement.validate(reading,self.rows,'c'*40)
        bad=copy.deepcopy(reading)
        next(p for p in bad['occurrences'] if p['rowId']=='202')['nextIds']=[by_row['102']['id']]
        with self.assertRaisesRegex(ValueError,'empty choice'):
            s.placement.validate(bad,self.rows,'c'*40)

    def test_unimported_official_alternative_is_not_mistaken_for_uniqueness(self):
        self.talks.append({'TalkSentenceID':999,'TalkSentenceText':{'Hash':101},'TextmapTalkSentenceName':{'Hash':9}})
        self.owners[(999,'line')]=[{'missionId':11,'source':'OtherAct','pointer':'/SimpleTalkList/1','conditions':[]}]
        reading=self.build('*角色：回应')
        self.assertFalse(reading['occurrences'])
        self.rows[1].update(bwikiStatus='cached',bwikiPage='任务',bwikiRevision=5)
        # An old page binding is preserved on the canonical row but cannot
        # select one of several new occurrence-level official ID candidates.
        reading=self.build('*角色：回应')
        self.assertFalse(reading['occurrences'])
        self.assertEqual(self.rows[1]['bwikiStatus'],'cached')
        # Both unique anchors must refer to the same explicit array and gate.
        reading=self.build('*角色：开始\n*角色：回应\n*角色：结束')
        self.assertTrue(any(p['rowId']=='101' and p['method']=='two-anchors-same-official-array-and-gate' for p in reading['occurrences']))
        self.owners[(999,'line')][0].update(source='Story/Mission/11/A.json')
        reading=self.build('*角色：开始\n*角色：回应\n*角色：结束')
        self.assertFalse(any(p['rowId']=='101' for p in reading['occurrences']))

    def test_unknown_rows_keep_original_mission_groups_and_mutated_text_fails_validation(self):
        self.rows[-1]['missionId']='quest-12'
        self.rows[-1]['mission']='다른 임무'
        reading=self.build('*角色：开始')
        groups={g['id']:g for g in reading['unplaced']}
        self.assertIn('202',groups['quest-12']['rowIds'])
        self.assertNotIn('202',groups['quest-11']['rowIds'])
        changed=copy.deepcopy(self.rows);changed[0]['text']='변경'
        with self.assertRaisesRegex(ValueError,'checksum'):
            s.placement.validate(reading,changed,'c'*40)


if __name__=='__main__':
    unittest.main()
