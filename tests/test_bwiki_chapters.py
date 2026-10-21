import copy
import importlib.util
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('imports', Path(__file__).resolve().parents[1] / 'scripts/import-bwiki-chapters.py')
imports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imports)
bwiki = imports.bwiki


class BwikiChapterTest(unittest.TestCase):
    def setUp(self):
        self.record = {'id': 900, 'title': '系列', 'entryId': 'entry', 'chapterId': 'act',
                       'groups': [{'title': '任務', 'koreanTitle': '임무', 'missionIds': [11, 12]}]}
        self.script = '''{{任务|任务名称=任務|任务类型=开拓任务|系列任务=系列|任务编号=01}}
==剧情内容==
*角色：你好，开拓者。
{{剧情选项|选项1=向左。|剧情1=*角色：左边回应。|选项2=向右。|剧情2=*角色：右边回应。}}
*字幕：幕布落下。
'''
        self.cn = {'9': '角色', '8': '{NICKNAME}', '100': '你好，{NICKNAME}。', '101': '向左。',
                   '102': '向右。', '103': '左边回应。', '104': '右边回应。', '18446744073709551615': '幕布落下。'}
        self.kr = {'9': '화자', '8': '{NICKNAME}', '100': '안녕, {NICKNAME}.', '101': '왼쪽.',
                   '102': '오른쪽.', '103': '왼쪽 응답.', '104': '오른쪽 응답.', '18446744073709551615': '막이 내렸다.'}
        self.talks = [{'TalkSentenceID': i, 'TalkSentenceText': {'Hash': i},
                       'TextmapTalkSentenceName': {'Hash': 0 if i in [101, 102] else 9}}
                      for i in range(100, 105)]
        self.intro = {'id': 'existing-intro', 'entryId': 'entry', 'chapterId': 'act', 'missionId': 'intro',
                      'mission': '소개', 'scene': '소개', 'type': 'narration', 'speaker': '', 'text': '소개문', 'source': 'intro'}
        self.page = {'status': 'available', 'title': '任務', 'pageTitle': '任務', 'pageId': 7, 'revision': 5}

    def build(self, script=None, payload=None, pages=None, old=None, sources=None, chinese=None, revalidate_existing=False):
        script = script or self.script
        cn = chinese or self.cn
        keys = set(imports.node_keys(bwiki.story_segments(script, True)))
        for chunk in old or []:
            for expected in chunk['evidence'].values():
                keys.add((expected['kind'], bwiki.comparable(cn.get(expected['textHash'], '')), expected['wikiSpeaker']))
        candidates = imports.official_candidates(self.talks, cn, self.kr, keys)
        return imports.build_chapter(self.record, payload or {'rows': [self.intro]},
            pages if pages is not None else {'任務': self.page}, {'任務': script}, candidates, old or [], sources or {}, cn, revalidate_existing)

    def test_existing_only_replays_subtitle_and_branch_proofs_without_new_ids_or_wiki_parsing(self):
        payload, chunks, _, _ = self.build()
        sources = {'任務@5': {'sha256': 'proof'}}
        # Simulate the general matcher clearing evidence it cannot represent.
        for row in payload['rows']:
            for key in bwiki.BWIKI_FIELDS:
                row.pop(key, None)
        self.cn['105'], self.kr['105'] = '新增台词。', '새 대사.'
        self.talks.append({'TalkSentenceID': 105, 'TalkSentenceText': {'Hash': 105},
                           'TextmapTalkSentenceName': {'Hash': 9}})
        script = self.script + '\n*角色：新增台词。'
        with patch.object(bwiki, 'validate_mission_page', side_effect=AssertionError('Existing-only parsed new wiki content')):
            result, accepted, review, _ = self.build(script=script, payload=payload,
                old=chunks, sources=sources, revalidate_existing=True)
        self.assertEqual({row['id'] for row in result['rows']}, {row['id'] for row in payload['rows']})
        self.assertEqual(result['bwiki']['cachedRows'], 6)
        self.assertEqual([chunk['edges'] for chunk in accepted], [chunk['edges'] for chunk in chunks])
        self.assertEqual({chunk['revision'] for chunk in accepted}, {5})
        self.assertTrue(all('기존 수록 원문 전용 재검증' in item['reason'] for item in review))
        intro, new_chunks, _, _ = self.build(revalidate_existing=True)
        self.assertEqual(intro['rows'], [self.intro])
        self.assertFalse(new_chunks)

    def test_existing_only_rejects_changed_official_hash_identity_speaker_or_ownership(self):
        payload, chunks, _, _ = self.build()
        sources = {'任務@5': {'sha256': 'proof'}}
        for key, value in [('talkId', 999), ('textHash', '999'), ('speaker', '다른 화자'),
                           ('missionId', 'quest-999'), ('type', 'narration')]:
            changed = copy.deepcopy(payload)
            next(row for row in changed['rows'] if row.get('talkId') == 100)[key] = value
            result, accepted, _, _ = self.build(payload=changed, old=chunks, sources=sources, revalidate_existing=True)
            self.assertFalse(any('bwiki-900-talk-100-line' in chunk['order'] for chunk in accepted), key)
        changed_cn = {**self.cn, '100': '官方原文修改。'}
        _, accepted, _, _ = self.build(payload=payload, old=chunks, sources=sources,
            chinese=changed_cn, revalidate_existing=True)
        self.assertFalse(any('bwiki-900-talk-100-line' in chunk['order'] for chunk in accepted))
        _, accepted, _, _ = self.build(payload=payload, old=chunks, revalidate_existing=True)
        self.assertFalse(accepted)

    def test_official_ids_subtitle_hash_and_intro_identity_are_preserved(self):
        payload, chunks, _, _ = self.build()
        self.assertEqual(payload['rows'][0], self.intro)
        self.assertEqual(len(payload['rows']), 7)
        self.assertEqual({row['text'] for row in payload['rows'][1:]},
                         {'안녕, [개척자].', '왼쪽.', '오른쪽.', '왼쪽 응답.', '오른쪽 응답.', '막이 내렸다.'})
        subtitle = next(row for row in payload['rows'] if row['text'] == '막이 내렸다.')
        self.assertIsNone(subtitle['talkId'])
        self.assertEqual(subtitle['textHash'], '18446744073709551615')
        self.assertTrue(all(chunk['officialMissionIds'] == [11, 12] for chunk in chunks))
        first = copy.deepcopy(payload)
        second, _, _, _ = self.build(payload=payload)
        self.assertEqual(first, second)

    def test_duplicate_official_ids_do_not_invent_a_choice_or_hide_other_known_responses(self):
        self.talks.append({**self.talks[1], 'TalkSentenceID': 999})
        payload, chunks, _, _ = self.build()
        self.assertFalse(any(row.get('talkId') in [101, 999] for row in payload['rows']))
        self.assertTrue(any(row['text'] == '왼쪽 응답.' for row in payload['rows']))
        for chunk in chunks:
            self.assertTrue(all(target in chunk['order'] for ids in chunk['edges'].values() for target in ids))

    def test_conditional_tabs_are_independent_and_never_fabricate_player_choices(self):
        text = self.script.replace('{{剧情选项', '{{剧情选项', 1)
        text = text[:text.index('{{剧情选项')] + '''{{剧情选项|选项1=此前问过问题|剧情1=
{{#tag:tabber|第一种=
*角色：左边回应。
{{!}}-{{!}}
第二种=
*角色：右边回应。
}}
}}
*字幕：幕布落下。
'''
        payload, chunks, _, _ = self.build(script=text)
        self.assertTrue(any(row['text'] == '왼쪽 응답.' for row in payload['rows']))
        self.assertTrue(any(row['text'] == '오른쪽 응답.' for row in payload['rows']))
        self.assertFalse(any(row['type'] == 'choice' for row in payload['rows']))
        self.assertTrue(all(len(chunk['order']) == 1 for chunk in chunks))

    def test_unavailable_pages_keep_only_revalidated_cached_connections_and_all_old_rows(self):
        payload, chunks, _, _ = self.build()
        sources = {'任務@5': {'sha256': 'proof'}}
        offline = {'任務': {'status': 'unavailable'}}
        cached, accepted, _, _ = self.build(payload=payload, pages=offline, old=chunks, sources=sources)
        self.assertEqual(cached['bwiki']['cachedRows'], 6)
        self.assertTrue(all(chunk['status'] == 'cached' for chunk in accepted))
        changed = {**self.cn, '100': '正文已经修改。'}
        pending, _, _, _ = self.build(payload=payload, pages=offline, old=chunks, sources=sources, chinese=changed)
        self.assertEqual(len(pending['rows']), len(payload['rows']))
        self.assertEqual(next(row for row in pending['rows'] if row.get('talkId') == 100)['bwikiStatus'], 'review')

    def test_wrong_chapter_series_cannot_promote_an_introduction(self):
        payload, chunks, _, _ = self.build(script=self.script.replace('|系列任务=系列', '|系列任务=其他系列'))
        self.assertEqual(payload['rows'], [self.intro])
        self.assertFalse(chunks)


if __name__ == '__main__':
    unittest.main()
