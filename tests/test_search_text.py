import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('search_text', Path(__file__).resolve().parents[1] / 'scripts/import-search-text.py')
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


class SearchTextTest(unittest.TestCase):
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

    def test_loading_table_and_nested_dialogue_are_exact_candidates(self):
        values = search.candidates('|裂界\n|随星核而出现的空间扭曲现象，不停蚕食着现实。\n{{剧情选项|选项1=这是一个很长的选择选项|剧情1={{对话|帕姆|请不要干扰列车长的日常工作！}}}}', '로딩 화면')
        self.assertIn('随星核而出现的空间扭曲现象,不停蚕食着现实。', values)
        self.assertIn('请不要干扰列车长的日常工作!', values)


if __name__ == '__main__':
    unittest.main()
