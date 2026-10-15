"""Join the train's NounAtlas with Korean text, preserving integer hashes and story updates."""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.cache/train-databank')
COMMIT = '724b139d8c9c32d12552eb95745a4fee72bfe48b'
EXPECTED = {
    'NounAtlas.json': '94e9cbdaf840e8bccbe229b923e7ab48d752a7e8',
    'TextMapKR_0.json': '4c4adcf4ed86c48ebb407442801f3b3dd396eb19',
    'TextMapKR_1.json': '80eee947e1dc31577209e39d841ad2eb127541e0',
    'NounAtlasChangeInfo.json': '263c21d468db03252487ba8ce8429f32fbdc381f',
}
evidence = {}


def read(name):
    raw = (ROOT / name).read_bytes()
    blob = hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest()
    if name in EXPECTED and EXPECTED[name] != blob:
        raise ValueError(f'Unexpected pinned input: {name}')
    evidence[name] = {'gitBlob': blob, 'sha256': hashlib.sha256(raw).hexdigest()}
    return json.loads(raw)


texts = {}
for index in range(2):
    texts.update(read(f'TextMapKR_{index}.json'))
rows = read('NounAtlas.json')
changes = read('NounAtlasChangeInfo.json')
parents = {target: change['NounID'] for change in changes for target in change['ChangeNounIDList']}


def root_id(value):
    seen = set()
    while value in parents:
        if value in seen:
            raise ValueError('Cyclic NounAtlas update chain')
        seen.add(value)
        value = parents[value]
    return value


def plain(value):
    value = value.replace('\\n', '\n').replace('\u00a0', ' ')
    value = re.sub(r'</?(?:color|size|b|i|s|u|unbreak)(?:=[^>]*)?>', '', value, flags=re.I)
    return re.sub(r'\*{0,2}\{NICKNAME\}\*{0,2}', '[개척자]', value).strip()


def text(field):
    key = str(field['Hash'])
    if key not in texts or not texts[key].strip():
        raise ValueError(f'Missing Korean hash: {key}')
    return plain(texts[key])


group_info = {2: ('aeons', '에이언즈'), 1: ('terms', '고유 명사'), 3: ('factions', '파벌')}
groups = []
for kind, (group_id, title) in group_info.items():
    members = {}
    for row in rows:
        if row['Type'] == kind:
            members.setdefault(root_id(row.get('ID', 0)), []).append(row)
    documents = []
    for canonical, versions in members.items():
        versions.sort(key=lambda row: row.get('ID', 0))
        first, latest = versions[0], versions[-1]
        is_intro = bool(first.get('IsIntroPage'))
        documents.append({
            'id': f'noun-atlas-{canonical}', 'title': text(latest['NounTitle']),
            'category': '열차 자료실', 'nounId': canonical, 'sortId': first.get('SortID', 0),
            'isIntroPage': is_intro, 'relatedIds': latest.get('RelatedTerms', []),
            'source': f'NounAtlas:{canonical}',
            'sections': [{
                'title': text(version['NounTitle']), 'mapping': 'EXACT_NOUN_ATLAS_KOREAN_HASH',
                'source': f'NounAtlas:{version.get("ID", 0)}',
                'rows': [{
                    'label': '본문', 'speaker': '', 'text': text(version['NounDesc']),
                    'hash': str(version['NounDesc']['Hash']),
                    'variant': '기본 기록' if index == 0 else f'갱신 기록 {index}',
                    'nounId': version.get('ID', 0),
                }],
            } for index, version in enumerate(versions)],
        })
    documents.sort(key=lambda doc: (not doc['isIntroPage'], doc['sortId'], doc['nounId']))
    intro = next(doc for doc in documents if doc['isIntroPage'])
    groups.append({'id': group_id, 'title': title, 'introId': intro['id'],
                   'description': re.split(r'\.\s', intro['sections'][0]['rows'][0]['text'])[0] + '.',
                   'documents': documents})

output = {'schema': 'hsr-train-databank.v1', 'repository': 'DimbreathBot/TurnBasedGameData',
          'commit': COMMIT, 'files': evidence, 'groups': groups,
          'note': 'NounAtlas SortID order. Updated text remains selectable; player unlock state is not inferred.'}
Path('src/data/train-databank.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({group['title']: len(group['documents']) for group in groups}, ensure_ascii=False))
