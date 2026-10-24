import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('search_text', Path(__file__).resolve().parents[1] / 'scripts/import-search-text.py')
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)
spec = importlib.util.spec_from_file_location('search_locale', Path(__file__).resolve().parents[1] / 'scripts/import-search-localizations.py')
locale = importlib.util.module_from_spec(spec)
spec.loader.exec_module(locale)


class SearchTextTest(unittest.TestCase):
    def test_comparisons_and_title_require_same_official_hash_and_whole_table_row(self):
        folder = Path('.cache/tests')
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as tmp:
            root = Path(tmp)
            (root / 'raw').mkdir()
            (root / 'public/content').mkdir(parents=True)
            (root / 'public/content/search-index.json').write_text('{"rows":[]}')
            body_id = '8635891183804058996'
            files = []
            for code, texts in {
                'KR': {body_id: '모든 것에 깃든 존재의 본질', '2': '허수의 나무', '3': '연결 없음'},
                'CHS': {body_id: '遍入一切的存在本质，诞生众多世界的宇宙结构。', '2': '虚数之树'},
                'EN': {body_id: '<b>Essence</b>\\n{NICKNAME}'},
                'JP': {body_id: 'あらゆる存在の本質。'},
            }.items():
                data = json.dumps(texts).encode()
                name = f'TextMap{code}.json'
                (root / 'raw' / name).write_bytes(data)
                files.append({'path': 'TextMap/' + name, 'sha': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()})
            plan = {'schema': 'hsr-upstream-plan.v1', 'repository': 'DimbreathBot/TurnBasedGameData', 'commit': 'a'*40, 'files': files}
            (root / 'plan.json').write_text(json.dumps(plan))
            data = '!unsupported\n{| class=wikitable\n!虚数之树\n|遍入一切的存在本质，诞生众多世界的宇宙结构。\n|}\n'.encode('utf8')
            wiki_file = root / 'loading.wiki'
            wiki_file.write_bytes(data)
            page = {'status': 'available', 'searchKind': '로딩 화면', 'pageTitle': '过场提示', 'pageId': 3402, 'revision': 104164,
                    'timestamp': '2026-07-31', 'file': str(wiki_file), 'sha256': hashlib.sha256(data).hexdigest()}
            wiki = {'schema': 'hsr-bwiki-input.v1', 'commit': plan['commit'], 'pages': [page]}
            (root / 'wiki.json').write_text(json.dumps(wiki))
            search.build(root, root/'raw', root/'plan.json', root/'wiki.json')
            locale.build(root, root/'raw', root/'plan.json', root/'wiki.json')
            locale.validate(root)
            manifest = json.loads((root / 'public/search/locales/manifest.json').read_bytes())
            self.assertEqual(manifest['titles'][body_id]['title'], '허수의 나무')
            self.assertEqual(manifest['titles'][body_id]['titleHashCandidates'], ['2'])
            self.assertEqual(manifest['coverage']['en'], {'rows': 1, 'missing': 2})
            target = root / f'public/search/locales/en/search-text--part-{int(body_id)%32:02}.json'
            self.assertEqual(json.loads(target.read_bytes())['rows'][0]['text'], 'Essence\n[Trailblazer]')
            self.assertEqual(list(locale.loading_pairs('{|\n!rowspan=2|虚数之树\n|正文\n|}')), [])
            (root/'raw/TextMapEN.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'Unverified'):
                locale.build(root, root/'raw', root/'plan.json')
            target.write_text('{}')
            with self.assertRaises((ValueError, KeyError)):
                locale.validate(root)

    def test_full_textmap_coverage_exact_hashes_and_tamper_rejection(self):
        folder = Path('.cache/tests')
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as tmp:
            root = Path(tmp)
            (root / 'raw').mkdir()
            (root / 'public/content').mkdir(parents=True)
            (root / 'public/content/search-index.json').write_text(json.dumps({'rows': [{'text': '수록된 본문'}]}), encoding='utf8')
            source = {'18446744073709551615': '미분류 NPC 대사', '2': '<b>수록된 본문</b>',
                      '3': '로딩 화면 안내\\n{NICKNAME}', '4': ' ', '5': '<b>짧은 말</b>'}
            data = json.dumps(source).encode()
            (root / 'raw/TextMapKR.json').write_bytes(data)
            plan = {'schema': 'hsr-upstream-plan.v1', 'repository': 'DimbreathBot/TurnBasedGameData',
                    'commit': 'a' * 40, 'files': [{'path': 'TextMap/TextMapKR.json',
                    'sha': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()}]}
            (root / 'plan.json').write_text(json.dumps(plan))
            search.build(root, root / 'raw', root / 'plan.json')
            search.validate(root)
            manifest = json.loads((root / 'public/search/manifest.json').read_bytes())
            self.assertEqual((manifest['rows'], manifest['curatedStrings'], manifest['emptyStrings']), (3, 1, 1))
            rows = [r for p in manifest['parts'] for r in json.loads((root / 'public/search' / p['file']).read_bytes())['rows']]
            self.assertIn(['18446744073709551615', '미분류 NPC 대사', []], rows)
            self.assertIn(['3', '로딩 화면 안내\n[개척자]', []], rows)
            (root / 'raw/TextMapKR.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'Unverified'):
                search.build(root, root / 'raw', root / 'plan.json')
            (root / 'public/search/part-00.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'Invalid'):
                search.validate(root)

    def test_npc_classification_excludes_unrelated_quests_and_short_common_lines(self):
        wiki = '==基本信息==\n无关的长句子不能成为NPC对话\n==NPC对话==\n* 帕姆：请不要干扰列车长的日常工作！\n* 帕姆：你好\n==相关剧情==\n其他任务长句子不能成为NPC对话'
        values = search.candidates(wiki, 'NPC 대사')
        self.assertIn('请不要干扰列车长的日常工作!', values)
        self.assertNotIn('你好', values)
        self.assertNotIn('其他任务长句子不能成为NPC对话', values)
        self.assertNotIn('无关的长句子不能成为NPC对话', values)

    def test_actual_npc_template_extracts_only_dialogue_and_ignores_comments_and_related_content(self):
        wiki = '{{NPC|名称=无关名字不能当作对话|对话内容={{折叠|标题=随机对话|内容=*帕姆：请不要干扰列车长的日常工作！}}|相关剧情=其他任务长句子不能成为NPC对话}}\n<!--{{NPC|对话内容=注释里面的长句不能作为对话}}-->'
        values = search.candidates(wiki, 'NPC 대사')
        self.assertIn('请不要干扰列车长的日常工作!', values)
        self.assertNotIn('其他任务长句子不能成为NPC对话', values)
        self.assertNotIn('注释里面的长句不能作为对话', values)
        self.assertEqual(search.candidates('{{NPC|对话内容=含有重复字段的原文一|对话内容=含有重复字段的原文二}}', 'NPC 대사'), set())

    def test_message_and_mail_are_limited_to_their_actual_body_fields(self):
        wiki = '{{短信内容|短信标题=这不是应当分类的消息正文|内容={{角色对话|左|三月七|文本|姬子姐有事找你，别忘啦}}{{角色对话|左|三月七|图片|不应该作为文本的图片名称}}}}\n无关的页面介绍不能进入消息正文'
        values = search.candidates(wiki, '메시지')
        self.assertIn('姬子姐有事找你,别忘啦', values)
        self.assertNotIn('不应该作为文本的图片名称', values)
        self.assertNotIn('这不是应当分类的消息正文', values)
        mail = '{{邮件|标题=这不是应当分类的邮件正文|内容=感谢你的支持，这是邮件的原文。}}'
        self.assertIn('感谢你的支持,这是邮件的原文。', search.candidates(mail, '우편'))
        self.assertNotIn('这不是应当分类的邮件正文', search.candidates(mail, '우편'))

    def test_loading_table_and_nested_dialogue_are_exact_candidates(self):
        values = search.candidates('|裂界\n|随星核而出现的空间扭曲现象，不停蚕食着现实。\n{{剧情选项|选项1=这是一个很长的选择选项|剧情1={{对话|帕姆|请不要干扰列车长的日常工作！}}}}', '로딩 화면')
        self.assertIn('随星核而出现的空间扭曲现象,不停蚕食着现实。', values)
        self.assertIn('请不要干扰列车长的日常工作!', values)


if __name__ == '__main__':
    unittest.main()
