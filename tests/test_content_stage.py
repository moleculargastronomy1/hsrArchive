import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
import shutil
import subprocess
import os
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('stage', Path(__file__).resolve().parents[1] / 'scripts/validate-content-stage.py')
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


class ContentStageTest(unittest.TestCase):
    def test_final_contract_and_failed_candidates_leave_existing_bytes_untouched(self):
        parent = Path(__file__).resolve().parents[1] / '.cache/tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as folder:
            root = Path(folder)
            commit = 'a' * 40
            def write(file, value):
                target = root / file
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            rows = [{'id': identity, 'entryId': 'entry', 'chapterId': 'chapter', 'missionId': 'quest-1',
                     'mission': '임무', 'scene': '장면', 'source': 'official', 'speaker': '', 'text': text,
                     'type': kind, 'textHash': 18446744073709551615,
                     'bwikiStatus': 'matched', 'bwikiScene': 'scene', 'bwikiNextIds': targets}
                    for identity, text, kind, targets in [('choice', '선택', 'choice', ['reply']), ('reply', '응답', 'dialogue', [])]]
            payload = {'schema': 'hsr-dialogue.v1', 'entryId': 'entry', 'chapterId': 'chapter', 'rows': rows}
            metadata = {'entry/chapter': {'file': 'content/entry--chapter.json', 'rows': 2}}
            search_rows = [{key: value for key, value in row.items() if key not in ['source', 'talkId', 'missionId']} |
                           {'source': hashlib.sha256(row['source'].encode()).hexdigest()[:16]} for row in rows]
            files = {'src/data/imported-content.json': metadata, 'public/content/entry--chapter.json': payload,
                     'public/content-update.json': {'commit': commit, 'rows': 2},
                     'public/content/search-index.json': {'schema': 'hsr-dialogue.v1', 'textReferenceCommit': commit, 'rows': search_rows},
                     'public/content/locales/manifest.json': {'schema': 'hsr-localization-manifest.v1', 'commit': commit}}
            for name in ['codex', 'simulation', 'books', 'trailblaze']:
                files['src/data/' + name + '.json'] = []
            files['src/data/trailblaze.json'] = [{'id': 'entry', 'chapters': [
                {'id': 'chapter', 'content': copy.deepcopy(metadata['entry/chapter'])}]}]
            for name in ['dialogue-flow-provenance', 'bwiki-provenance', 'video-order-provenance', 'video-review-summary']:
                files['public/' + name + '.json'] = {'commit': commit}
            for language in ['en', 'zh-CN', 'ja']:
                files[f'public/content/locales/{language}/entry--chapter.json'] = {
                    'schema': 'hsr-localizations.v1', 'entryId': 'entry', 'chapterId': 'chapter',
                    'language': language, 'referenceCommit': commit,
                    'rows': [{'id': 'choice', 'speaker': '', 'text': '选择'},
                             {'id': 'reply', 'speaker': '说话人', 'text': '应答'}]}
            for file, value in files.items():
                write(file, value)
            chinese_file = 'public/content/locales/chinese-search.json'
            files[chinese_file] = {'schema': 'hsr-chinese-search.v1', 'language': 'zh-CN',
                'referenceCommit': commit,
                'corpusSha256': hashlib.sha256((root / 'public/content/search-index.json').read_bytes()).hexdigest(),
                'rows': [['choice', '\n选择'], ['reply', '说话人\n应答']]}
            write(chinese_file, files[chinese_file])
            self.assertEqual(stage.validate(root), {'chapters': 1, 'rows': 2})
            cases = [
                (chinese_file, lambda value: value.update(corpusSha256='0' * 64)),
                (chinese_file, lambda value: value['rows'][0].__setitem__(1, '틀린 중문')),
                (chinese_file, lambda value: value['rows'].reverse()),
                ('public/content/search-index.json', lambda value: value['rows'][0].update(text='변경')),
                ('public/content/search-index.json', lambda value: value['rows'].reverse()),
                ('public/content/search-index.json', lambda value: value['rows'][0].update(bwikiStatus='review')),
                ('public/content/entry--chapter.json', lambda value: value['rows'][0].update(bwikiNextIds=['missing'])),
                ('public/content/entry--chapter.json', lambda value: value['rows'][0].update(videoStatus='screen-matched', videoScene='video', videoNextIds=['reply'])),
                ('src/data/imported-content.json', lambda value: value['entry/chapter'].update(rows=3)),
                ('src/data/trailblaze.json', lambda value: value[0]['chapters'][0]['content'].update(textReferenceCommit='b' * 40)),
                ('public/content/locales/en/entry--chapter.json', lambda value: value['rows'][0].update(id='foreign')),
                ('public/video-order-provenance.json', lambda value: value.update(commit='b' * 40)),
            ]
            for file, mutate in cases:
                value = copy.deepcopy(files[file])
                mutate(value)
                write(file, value)
                before = {path: path.read_bytes() for path in root.rglob('*.json')}
                with self.assertRaises(ValueError, msg=file):
                    stage.validate(root)
                self.assertTrue(all(path.read_bytes() == raw for path, raw in before.items()))
                write(file, files[file])

            # Reproduce a retry: restore an old index, update the canonical text
            # and comparisons, and publish a receipt that omits the new index.
            published = root / 'published'
            (published / 'scripts').mkdir(parents=True)
            repository = Path(__file__).resolve().parents[1]
            for script in (repository / 'scripts').glob('*.py'):
                shutil.copy2(script, published / 'scripts' / script.name)
            for file in files:
                target = published / file
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root / file, target)
            payload['rows'][0]['text'] = '갱신된 선택'
            search_rows[0]['text'] = '갱신된 선택'
            chinese_locale = files['public/content/locales/zh-CN/entry--chapter.json']
            chinese_locale['rows'][0]['text'] = '更新后的选择'
            write('public/content/entry--chapter.json', payload)
            write('public/content/search-index.json', files['public/content/search-index.json'])
            write('public/content/locales/zh-CN/entry--chapter.json', chinese_locale)
            with self.assertRaisesRegex(ValueError, 'Chinese search must preserve'):
                stage.validate(root)
            receipt = [file for file in files if file != chinese_file]
            command = ['node', '--input-type=module', '-e',
                'import {publishContentStage} from ' + json.dumps((repository / 'scripts/content-publication.mjs').as_uri()) +
                '; await publishContentStage(process.argv[1], process.argv[2], JSON.parse(process.argv[3]));',
                str(published), str(root), json.dumps(receipt)]
            environment = dict(os.environ, HSR_PYTHON=sys.executable)
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stage.validate(published), {'chapters': 1, 'rows': 2})
            rebuilt = json.loads((published / chinese_file).read_bytes())
            self.assertEqual(rebuilt['rows'], [['choice', '\n更新后的选择'], ['reply', '说话人\n应答']])
            self.assertNotEqual(rebuilt['corpusSha256'], files[chinese_file]['corpusSha256'])
            self.assertEqual([row[0] for row in rebuilt['rows']], ['choice', 'reply'])

            # A real content-contract failure must still leave the live view intact.
            payload['rows'][0]['bwikiNextIds'] = ['missing']
            write('public/content/entry--chapter.json', payload)
            before = {file: (published / file).read_bytes() for file in files}
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=environment)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(all((published / file).read_bytes() == data for file, data in before.items()))


if __name__ == '__main__':
    unittest.main()
