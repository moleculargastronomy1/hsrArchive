import hashlib
import importlib.util
import json
import shutil
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('other', Path(__file__).resolve().parents[1] / 'scripts/import-other-text.py')
other = importlib.util.module_from_spec(spec)
spec.loader.exec_module(other)


class OtherTextTest(unittest.TestCase):
    def test_order_speakers_choices_boundaries_and_exact_large_hashes(self):
        folder = Path('.cache/tests')
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as temp:
            root = Path(temp)
            (root/'raw').mkdir()
            (root/'public/search').mkdir(parents=True)
            values = {
                '1': ('帕姆', '폼폼'), '2': ('三月七', 'Mar. 7th'),
                '18446744073709551615': ('你好，乘客！', '안녕, 승객!'),
                '3': ('第一项', '첫 선택'), '4': ('第二项', '둘째 선택'),
                '5': ('回答甲', '응답 갑'), '6': ('回答乙', '응답 을'), '7': ('接着说', '이어서'),
                '8': ('消息第一', '첫 메시지'), '9': ('消息第二', '둘째 메시지'),
                '10': ('来信第一段', '편지 첫 단락'), '11': ('来信第二段', '편지 둘째 단락'),
                '12': ('同一句话', '반복 대사'), '13': ('未知人物的台词', '이름 미확인 대사'),
            }
            plan = {'schema': 'hsr-upstream-plan.v1', 'repository': 'DimbreathBot/TurnBasedGameData',
                    'commit': 'a'*40, 'files': []}
            evidence = {}
            for code in ['KR', 'CHS', 'EN', 'JP']:
                texts = {key: pair[0 if code == 'CHS' else 1] for key, pair in values.items()}
                name = f'TextMap{code}.json'
                data = other.encode(texts)
                (root/'raw'/name).write_bytes(data)
                blob = hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()
                plan['files'].append({'path': 'TextMap/'+name, 'sha': blob})
                if code in ['KR', 'CHS']:
                    evidence[name] = {'gitBlob': blob, 'sha256': other.digest(data)}
            (root/'plan.json').write_bytes(other.encode(plan))
            (root/'public/search/manifest.json').write_bytes(other.encode({'commit': plan['commit'], 'files': evidence}))
            npc = '''{{NPC|名称=帕姆|对话内容={{折叠|标题=默认对话|内容=
*帕姆：你好，乘客！
{{剧情选项|选项1=第一项|剧情1=*帕姆：回答甲|选项2=第二项|剧情2=*三月七：回答乙}}
*帕姆：接着说
}}}}'''
            npc = npc[:-2] + '{{折叠|标题=缺口|内容={{剧情选项|选项1=第一项|剧情1=未知说明\n*帕姆：回答甲}}\n*帕姆：接着说}}' + '}}'
            message = '''{{短信内容|人物=三月七|短信标题=后|版本=1.0|排序=2|内容={{角色对话|左|三月七|文本|消息第二}}}}
{{短信内容|人物=三月七|短信标题=前|版本=1.0|排序=1|内容={{角色对话|左|三月七|文本|消息第一}}{{角色对话|左|三月七|文本|同一句话}}{{角色对话|左|陌生人物|文本|未知人物的台词}}}}'''
            mail = '{{邮件|发件人=帕姆|标题=信|内容=来信第一段<br>未确认的中间段落<br>来信第二段}}'
            interaction = '*帕姆：同一句话\n'
            pages = []
            for page_id, kind, title, content in [(1, 'NPC 대사', '帕姆', npc),
                    (2, '메시지', '短信/三月七', message), (3, '우편', '邮件', mail),
                    (4, '상호작용', '互动文本', interaction)]:
                path = root/f'{page_id}.wiki'
                raw = content.encode()
                path.write_bytes(raw)
                pages.append({'status': 'available', 'searchKind': kind, 'pageTitle': title,
                              'pageId': page_id, 'revision': 100, 'sha256': other.digest(raw), 'file': str(path)})
            layout = root/'layout.wiki'
            layout.write_text('|sort=版本,排序,短信标题\n', encoding='utf8')
            source = {'schema': 'hsr-bwiki-input.v1', 'commit': plan['commit'], 'pages': pages,
                      'layouts': [{'pageTitle': '模板:短信查询', 'pageId': 100, 'revision': 60748,
                                   'sha256': other.digest(layout.read_bytes()), 'file': str(layout)}]}
            (root/'wiki.json').write_bytes(other.encode(source))
            other.build(root, root/'raw', root/'plan.json', root/'wiki.json')
            other.validate(root)
            catalog = json.loads((root/'public/search/other-catalog.json').read_bytes())
            self.assertEqual(len(catalog['groups']), 4)
            self.assertEqual(catalog['speakers']['18446744073709551615']['name'], '폼폼')
            self.assertEqual(catalog['speakers']['18446744073709551615']['localizedNames']['en'], '폼폼')
            self.assertNotIn('12', catalog['speakers'])
            self.assertNotIn('13', catalog['speakers'])
            group = next(g for g in catalog['groups'] if g['kind'] == 'npc')
            payload = json.loads((root/'public/search'/group['sections'][0]['file']).read_bytes())
            self.assertEqual([r['text'] for r in payload['rows']], ['안녕, 승객!', '첫 선택', '응답 갑', '둘째 선택', '응답 을', '이어서'])
            self.assertEqual(payload['rows'][0]['textHashCandidates'], ['18446744073709551615'])
            positions = payload['wikiReading']['occurrences']
            self.assertEqual(positions[1]['nextIds'], [positions[2]['id']])
            self.assertEqual(positions[3]['nextIds'], [positions[4]['id']])
            self.assertNotIn(positions[3]['id'], positions[2]['nextIds'])
            gap = json.loads((root/'public/search'/group['sections'][1]['file']).read_bytes())
            gap_choice = next(p for p in gap['wikiReading']['occurrences'] if next(r for r in gap['rows'] if r['id'] == p['rowId'])['type'] == 'choice')
            self.assertEqual(gap_choice['nextIds'], [])
            message_group = next(g for g in catalog['groups'] if g['kind'] == 'message')
            self.assertEqual(message_group['title'], 'Mar. 7th')
            first = json.loads((root/'public/search'/message_group['sections'][0]['file']).read_bytes())
            self.assertEqual(first['rows'][0]['text'], '첫 메시지')
            self.assertEqual(first['rows'][-1]['speaker'], '')
            mail_group = next(g for g in catalog['groups'] if g['kind'] == 'mail')
            mail_body = json.loads((root/'public/search'/mail_group['sections'][0]['file']).read_bytes())
            self.assertEqual(len(mail_body['rows']), 2)
            self.assertEqual(mail_body['wikiReading']['occurrences'][0]['nextIds'], [])
            shutil.copytree(root/'public/search', root/'previous')
            original_source = group['source']
            changed = npc.replace('你好，乘客！', '这是尚未关联的中文句子')
            (root/'1.wiki').write_text(changed, encoding='utf8')
            source['pages'][0]['sha256'] = other.digest((root/'1.wiki').read_bytes())
            (root/'wiki.json').write_bytes(other.encode(source))
            other.build(root, root/'raw', root/'plan.json', root/'wiki.json', root/'previous/other-catalog.json')
            other.validate(root)
            preserved = json.loads((root/'public/search/other-catalog.json').read_bytes())
            self.assertEqual(next(g for g in preserved['groups'] if g['kind'] == 'npc')['source'], original_source)
            target = root/'public/search'/group['sections'][0]['file']
            target.write_text('{}')
            with self.assertRaises((ValueError, KeyError)):
                other.validate(root)

    def test_unsupported_choice_response_never_jumps_to_later_text(self):
        parsed = other.wiki.parse_body(other.converted('{{短信选项|选项1=第一项|剧情1=未知说明\n{{角色对话|左|帕姆|文本|回答甲}}}}'), fragmented=True, provenance=True)
        self.assertEqual(parsed[0][0]['kind'], 'choice')
        body = parsed[0][0]['options'][0]['body']
        self.assertTrue(body)


if __name__ == '__main__':
    unittest.main()
