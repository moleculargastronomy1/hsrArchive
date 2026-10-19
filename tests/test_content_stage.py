import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
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
                     'public/content/search-index.json': {'rows': search_rows},
                     'public/content/locales/manifest.json': {'commit': commit}}
            for name in ['codex', 'simulation', 'books', 'trailblaze']:
                files['src/data/' + name + '.json'] = []
            files['src/data/trailblaze.json'] = [{'id': 'entry', 'chapters': [
                {'id': 'chapter', 'content': copy.deepcopy(metadata['entry/chapter'])}]}]
            for name in ['dialogue-flow-provenance', 'bwiki-provenance', 'video-order-provenance', 'video-review-summary']:
                files['public/' + name + '.json'] = {'commit': commit}
            for language in ['en', 'zh-CN', 'ja']:
                files[f'public/content/locales/{language}/entry--chapter.json'] = {
                    'schema': 'hsr-localizations.v1', 'entryId': 'entry', 'chapterId': 'chapter',
                    'language': language, 'referenceCommit': commit, 'rows': [{'id': 'choice'}, {'id': 'reply'}]}
            for file, value in files.items():
                write(file, value)
            self.assertEqual(stage.validate(root), {'chapters': 1, 'rows': 2})
            cases = [
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


if __name__ == '__main__':
    unittest.main()
