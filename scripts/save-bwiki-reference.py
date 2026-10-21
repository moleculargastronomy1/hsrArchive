"""Save a revision-pinned local BWIKI reference; raw source stays outside Git."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from urllib.parse import quote

spec = importlib.util.spec_from_file_location('bwiki', Path(__file__).with_name('bwiki-dialogue.py'))
bwiki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bwiki)


def render(nodes, indent=''):
    lines = []
    for node in nodes:
        if node['kind'] == 'line':
            lines.append(indent + f"{node['speaker']}：{node['text']}")
        elif node['kind'] == 'narration':
            lines.append(indent + '> ' + node['text'])
        elif node['kind'] == 'choice':
            for number, option in enumerate(node['options'], 1):
                lines.append(indent + f"- 选项 {number}：{option['text']}")
                lines.extend(render(option['body'], indent + '  '))
        elif node['kind'] == 'separated':
            for part in node['segments']:
                lines.append(indent + '[独立区间]')
                lines.extend(render(part, indent))
        else:
            lines.append(indent + '[未解析的边界；完整内容见 .wiki 原文]')
        lines.append('')
    return lines


def save(manifest_path, destination):
    manifest = json.loads(manifest_path.read_bytes())
    if manifest.get('schema') != 'hsr-bwiki-input.v1':
        raise ValueError('Unsupported BWIKI manifest')
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    pages, unavailable = [], []
    lines = ['# 第4章 第8幕：成为昨日的明天', '',
             'BWIKI 中文对白本地参考。区间分隔不代表完整游玩顺序；未解析内容保存在对应 .wiki 原文中。', '']
    for page in manifest['pages']:
        if page['status'] != 'available':
            unavailable.append({key: page[key] for key in ['title', 'status', 'reason'] if key in page})
            continue
        data = Path(page['file']).read_bytes()
        if hashlib.sha256(data).hexdigest() != page['sha256']:
            raise ValueError('BWIKI source checksum mismatch')
        name = f"page-{page['pageId']}-revision-{page['revision']}.wiki"
        target = destination / name
        if target.exists() and target.read_bytes() != data:
            raise ValueError('Refusing to overwrite a different pinned source')
        target.write_bytes(data)
        url = 'https://wiki.biligame.com/sr/' + quote(page['pageTitle']) + '?oldid=' + str(page['revision'])
        segments = bwiki.story_segments(data.decode('utf-8'), True)
        record = {key: page[key] for key in ['title', 'pageTitle', 'pageId', 'revision', 'timestamp', 'collectedAt', 'sha256'] if key in page}
        record.update(rawFile=name, sourceUrl=url, segments=segments)
        pages.append(record)
        lines.extend([f"## {page['pageTitle']}", '', f"[BWIKI 固定版本]({url})", ''])
        for number, segment in enumerate(segments, 1):
            lines.extend([f'### 区间 {number}', '', *render(segment)])
    result = {'schema': 'hsr-local-bwiki-reference.v1', 'commit': manifest['commit'],
              'checkedAt': manifest['checkedAt'], 'license': manifest['license'],
              'copyright': 'Game text © HoYoverse and respective rights holders. BWIKI editorial structure © BWIKI contributors, CC BY-NC-SA 4.0.',
              'pages': pages, 'unavailable': unavailable}
    (destination / 'dialogue.zh-CN.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines.extend(['---', '', 'BWIKI contributors · CC BY-NC-SA 4.0 · https://creativecommons.org/licenses/by-nc-sa/4.0/',
                  'Game text © HoYoverse and respective rights holders.', ''])
    (destination / 'dialogue.zh-CN.md').write_text('\n'.join(lines), encoding='utf-8')
    index = {key: value for key, value in result.items() if key != 'pages'}
    index['pages'] = [{key: value for key, value in page.items() if key != 'segments'} for page in pages]
    (destination / 'manifest.json').write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'path': str(destination), 'savedPages': len(pages), 'unavailable': len(unavailable)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    save(args.manifest, args.destination)
