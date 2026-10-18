import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('events', Path(__file__).resolve().parents[1] / 'scripts/import-simulation-events.py')
events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(events)


class SimulationEventsTest(unittest.TestCase):
    def test_mode_specific_options_and_explicit_response(self):
        content = '''{{模拟宇宙事件2|名称=事件名|模式=模拟宇宙、寰宇蝗灾、黄金与机械
|剧情对话={{事件|模拟宇宙|开场。}}{{模拟宇宙事件选项2
|选项1=继续。|剧情1={{事件|你|继续。}}{{事件|模拟宇宙|回应。}}
|选项-蝗灾=虫群。|模式-蝗灾=寰宇蝗灾
|选项-机械=机械。|模式-机械=黄金与机械}}}}'''
        parts = events.event_segments(content, {'title': '事件名', 'modeNames': ['寰宇蝗灾']})
        self.assertEqual(parts[1][0]['options'][0]['text'], '继续。')
        self.assertEqual(parts[1][1]['text'], '回应。')
        self.assertEqual(parts[2][0]['options'][0]['text'], '虫群。')
        self.assertNotIn('机械。', str(parts))
        with self.assertRaises(events.bwiki.Unresolved):
            events.event_segments(content, {'title': '别的事件', 'modeNames': ['寰宇蝗灾']})
        with self.assertRaises(events.bwiki.Unresolved):
            events.event_segments(content, {'title': '事件名', 'modeNames': ['不可知域']})

    def test_probability_boundaries_never_make_one_choice_response(self):
        content = '''{{模拟宇宙事件2|名称=事件名|模式=模拟宇宙|剧情对话=
{{模拟宇宙事件选项2|选项1=试试。|剧情1=
{{折叠|开始|标题=50%}}{{事件|模拟宇宙|结果一。}}{{折叠|结束}}
{{折叠|开始|标题=50%}}{{事件|模拟宇宙|结果二。}}{{折叠|结束}}}}}}'''
        parts = events.event_segments(content, {'title': '事件名', 'modeNames': ['模拟宇宙']})
        parts = [part for part in parts if part[0]['kind'] != 'unsupported']
        self.assertEqual(len(parts), 3)
        self.assertEqual(len(parts[0]), 1)
        self.assertEqual(parts[1][0]['text'], '结果一。')
        self.assertEqual(parts[2][0]['text'], '结果二。')

    def test_only_explicit_npc_membership_supplies_candidates_and_hashes_stay_exact(self):
        text_hash = 18446744073709551615
        record = {'progress': [{'unknownKey': 17}]}
        structures = {'npc': {'DialogueList': [{'DialoguePath': 'graph'}]},
                      'graph': {'TalkSentenceID': 1, 'OptionTextmapID': {'Hash': text_hash}},
                      'other': {'TalkSentenceID': 2}}
        talks = {1: {'TalkSentenceText': {'Hash': 11}, 'TextmapTalkSentenceName': {'Hash': 9}},
                 2: {'TalkSentenceText': {'Hash': 12}}}
        cn = {'11': '原文', '12': '别的事件', '9': '模拟宇宙', str(text_hash): '选择'}
        kr = {'11': '원문', '12': '다른 사건', '9': '시뮬레이션 우주', str(text_hash): '선택'}
        result = events.candidates(record, {17: 'npc'}, structures, talks, cn, kr)
        values = [item for group in result.values() for item in group]
        self.assertEqual(len(values), 2)
        self.assertEqual({item['text'] for item in values}, {'원문', '선택'})
        self.assertEqual(next(item for item in values if item['talkId'] is None)['textHash'], str(text_hash))

    def test_choice_display_and_effect_require_the_explicit_option_mapping(self):
        record = {'progress': [{'npc': 17}]}
        structures = {'npc': {'DialogueList': [{'DialoguePath': 'graph', 'OptionPath': 'options'}]},
                      'graph': {'RogueOptionID': 77}, 'options': {'OptionList': [{'OptionID': 77, 'DisplayID': 9}]}}
        displays = {9: {'OptionTitle': {'Hash': 111}, 'OptionDesc': {'Hash': 222}},
                    10: {'OptionTitle': {'Hash': 333}}}
        cn = {'111': '左边', '222': '奖励', '333': '不属于这个事件'}
        kr = {'111': '왼쪽', '222': '보상', '333': '다른 사건'}
        result = events.candidates(record, {17: 'npc'}, structures, {}, cn, kr, displays)
        self.assertEqual(result[('choice', '左边', '')][0]['text'], '왼쪽')
        self.assertEqual(result[('effect', '奖励', '左边')][0]['text'], '보상')
        self.assertNotIn(('effect', '奖励', '右边'), result)
        self.assertNotIn('다른 사건', str(result))


if __name__ == '__main__':
    unittest.main()
