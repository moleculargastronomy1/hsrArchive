"""Join in-game readable books to their region, series, volume and exact Korean hashes."""
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

WORLD_IDS = {1: 'space-station', 2: 'jarilo', 3: 'luofu', 4: 'penacony',
             5: 'amphoreus', 6: 'paradise-astropolis'}


def plain(value):
    value = value.replace('\\n', '\n').replace('\u00a0', ' ')
    value = re.sub(r'</?(?:color|size|b|i|s|u|unbreak|align)(?:=[^>]*)?>', '', value, flags=re.I)
    return re.sub(r'\*{0,2}\{NICKNAME\}\*{0,2}', '[개척자]', value).strip()


def convert(series_rows, book_rows, world_rows, texts, commit):
    def index(rows, key):
        result = {}
        for row in rows:
            identity = row.get(key)
            if type(identity) is not int or identity <= 0 or identity in result:
                raise ValueError('Invalid or duplicate book identity: ' + key)
            result[identity] = row
        return result

    def text(field, required=True):
        value = texts.get(str((field or {}).get('Hash')), '')
        if not isinstance(value, str) or (required and not plain(value)):
            raise ValueError('Missing Korean book text')
        return plain(value)

    series = index(series_rows, 'BookSeriesID')
    books = index(book_rows, 'BookID')
    worlds = index(world_rows, 'BookSeriesWorld')
    grouped = defaultdict(list)
    for book in books.values():
        if book.get('BookSeriesID') not in series:
            raise ValueError('Book has no exact series')
        grouped[book['BookSeriesID']].append(book)
    entries, payloads = [], {}
    bookshelf = image_books = 0
    for world_id, world in worlds.items():
        if world_id not in WORLD_IDS:
            raise ValueError('New book region requires an explicit site world mapping')
        world_name = text(world['BookSeriesWorldTextmapID'])
        entry_id = 'books-' + WORLD_IDS[world_id]
        chapters = []
        world_series = sorted((row for row in series.values() if row.get('BookSeriesWorld') == world_id),
                              key=lambda row: row['BookSeriesID'])
        for group in world_series:
            series_id = group['BookSeriesID']
            volumes = sorted(grouped[series_id], key=lambda row: (row['BookSeriesInsideID'], row['BookID']))
            if len(volumes) != group['BookSeriesNum']:
                raise ValueError('Incomplete book series')
            group_title = text(group['BookSeries'])
            in_bookshelf = bool(group.get('IsShowInBookshelf', False))
            for volume in volumes:
                book_id = volume['BookID']
                chapter_id = f'book-{book_id}'
                title = text(volume['BookInsideName'])
                content_hash = volume['BookContent']['Hash']
                if type(content_hash) is not int or content_hash <= 0:
                    raise ValueError('Invalid exact book hash')
                row = {
                    'id': f'{entry_id}-{chapter_id}', 'entryId': entry_id, 'chapterId': chapter_id,
                    'missionId': f'book-series-{series_id}', 'mission': group_title,
                    'scene': title, 'speaker': '', 'type': 'narration',
                    'text': text(volume['BookContent']), 'talkId': None, 'textHash': str(content_hash),
                    'source': f'LocalbookConfig:{book_id}/BookContent',
                }
                file = f'content/{entry_id}--{chapter_id}.json'
                source_ids = [f'LocalbookConfig:{book_id}', f'BookSeriesConfig:{series_id}']
                notes = []
                if not in_bookshelf:
                    notes.append('책장에 등록되지 않는 기타 문서')
                if volume.get('LocalBookImagePath'):
                    notes.append('이미지가 포함된 서적의 텍스트 원문입니다. 삽화는 수록하지 않습니다.')
                    image_books += 1
                bookshelf += int(in_bookshelf)
                chapters.append({
                    'id': chapter_id, 'title': title, 'group': group_title,
                    'collection': 'bookshelf' if in_bookshelf else 'document',
                    'contentNote': ' · '.join(notes), 'blocks': [],
                    'content': {'file': file, 'rows': 1, 'missing': 0, 'sourceIds': source_ids,
                                'textReferenceCommit': commit},
                })
                payloads['public/' + file] = {
                    'schema': 'hsr-dialogue.v1', 'entryId': entry_id, 'chapterId': chapter_id,
                    'referenceCommit': commit, 'textReferenceCommit': commit, 'sourceIds': source_ids,
                    'orderNote': 'BookSeriesID, BookSeriesInsideID order; collection state is not inferred.',
                    'book': {'id': book_id, 'seriesId': series_id, 'volume': volume['BookSeriesInsideID'],
                             'bookshelf': in_bookshelf, 'hasImages': bool(volume.get('LocalBookImagePath'))},
                    'rows': [row],
                }
        if chapters:
            entries.append({
                'id': entry_id, 'title': world_name + ' 서적', 'subtitle': '인게임 서적',
                'description': f'{world_name}의 {len(world_series)}개 시리즈 · {len(chapters)}권. 서적, 편지와 기록을 모았습니다.',
                'category': 'books', 'world': WORLD_IDS[world_id], 'order': 30 + world_id,
                'language': 'ko-KR', 'tags': ['서적', '책', world_name],
                'source': {'kind': 'extracted', 'version': '인게임 서적 LocalbookConfig ' + commit[:7],
                           'sourceIds': [chapter['id'] for chapter in chapters]},
                'chapters': chapters,
            })
    if sum(len(entry['chapters']) for entry in entries) != len(books):
        raise ValueError('Book import omitted a source record')
    return entries, payloads, {'books': len(books), 'series': len(series), 'regions': len(entries),
                               'bookshelf': bookshelf, 'documents': len(books) - bookshelf,
                               'booksWithImages': image_books}


def build(raw, manifest_path):
    manifest = json.loads(manifest_path.read_bytes())
    if (manifest.get('schema') != 'hsr-upstream-plan.v1' or
            manifest.get('repository') != 'DimbreathBot/TurnBasedGameData' or
            not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', ''))):
        raise ValueError('Invalid book source manifest')
    evidence = {}

    def read(name):
        descriptor = next(file for file in manifest['files'] if Path(file['path']).name == name)
        data = (raw / name).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != descriptor['sha']:
            raise ValueError('Unverified book input: ' + name)
        evidence[name] = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
        return json.loads(data)

    texts = {}
    for file in manifest['files']:
        if re.fullmatch(r'TextMap/TextMapKR(?:_\d+)?\.json', file['path']):
            for key, value in read(Path(file['path']).name).items():
                if key in texts and texts[key] != value:
                    raise ValueError('Conflicting Korean book text')
                texts[key] = value
    entries, payloads, coverage = convert(read('BookSeriesConfig.json'), read('LocalbookConfig.json'),
                                          read('BookSeriesWorld.json'), texts, manifest['commit'])
    files = []

    def write(file, value, pretty=False):
        target = Path(file)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2 if pretty else None,
                                    separators=None if pretty else (',', ':')) + '\n',
                          encoding='utf-8', newline='\n')
        files.append(file)

    write('src/data/books.json', entries, True)
    for file, payload in payloads.items():
        write(file, payload)
    write('public/books-provenance.json', {
        'schema': 'hsr-books-provenance.v1', 'repository': manifest['repository'],
        'commit': manifest['commit'], 'version': manifest['version'], 'files': evidence, 'coverage': coverage,
        'scope': 'All exact LocalbookConfig text, including documents outside the in-game bookshelf. Images excluded.',
        'copyright': 'Game text © HoYoverse. Data source: DimbreathBot/TurnBasedGameData.',
    }, True)
    receipt = Path('.cache/books-receipt.json')
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({'files': files}), encoding='utf-8')
    print(json.dumps(coverage))


if __name__ == '__main__':
    build(Path(sys.argv[1]), Path(sys.argv[2]))
