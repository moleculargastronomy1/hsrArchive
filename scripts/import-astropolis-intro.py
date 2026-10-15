"""Import the verified chapter introduction; do not infer unlinked dialogue ownership."""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.cache/astro-source')
COMMIT = '312b4597691e0a29cf9828a15b592757dba86949'
EXPECTED = {
    'MissionChapterConfig.json': '3131ed0c02242aa69978f3daa0e6a2f2a8df363b',
    'TextMapKR_0.json': '4c4adcf4ed86c48ebb407442801f3b3dd396eb19',
    'TextMapKR_1.json': '80eee947e1dc31577209e39d841ad2eb127541e0',
}
if len(sys.argv) > 2:
    manifest = json.loads(Path(sys.argv[2]).read_bytes())
    if manifest['schema'] != 'hsr-upstream-plan.v1':
        raise ValueError('Unsupported upstream manifest')
    COMMIT = manifest['commit']
    EXPECTED = {Path(row['path']).name: row['sha'] for row in manifest['files']}
evidence = {}


def read(name):
    raw = (ROOT / name).read_bytes()
    blob = hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest()
    if blob != EXPECTED[name]:
        raise ValueError(f'Unexpected pinned input: {name}')
    evidence[name] = {'gitBlob': blob, 'sha256': hashlib.sha256(raw).hexdigest()}
    return json.loads(raw)


texts = {}
for name in EXPECTED:
    if re.fullmatch(r'TextMapKR(?:_\d+)?\.json', name):
        texts.update(read(name))
chapter = next(row for row in read('MissionChapterConfig.json') if row['ID'] == 105009)


def text(field):
    raw = texts[str(chapter[field]['Hash'])]
    value = re.sub(r'</?(?:color|size|b|i|s|u|unbreak)(?:=[^>]*)?>', '', raw, flags=re.I)
    return value.replace('\u00a0', ' ').replace('\\n', '\n').strip()


title = text('ChapterName')
assert title == '달 뜨기 전, 괴수와 춤을'
source = 'ExcelOutput/MissionChapterConfig.json:105009/ChapterDesc'
document = {
    'id': 'chapter-intro-105009', 'title': title,
    'category': '챕터 소개문', 'chapter': title, 'source': source,
    'sections': [{
        'title': '챕터 소개문', 'mapping': 'EXACT_CHAPTER_KOREAN_HASH', 'source': source,
        'rows': [{'label': '소개문', 'speaker': '', 'text': text('ChapterDesc')}],
    }],
}
result = {
    'schema': 'hsr-chapter-introductions.v1',
    'repository': 'DimbreathBot/TurnBasedGameData', 'commit': COMMIT,
    'files': evidence, 'documents': [document],
    'scope': 'Chapter introduction only. Mission dialogue ownership is not established.',
}
Path('src/data/astropolis-intro.json').write_text(
    json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n',
)
print(title + ': verified introduction imported')
