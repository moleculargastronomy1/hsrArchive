"""Validate the final derived view after flow, BWIKI and video integration."""
import hashlib
import json
import re
import sys
from pathlib import Path


def validate(root):
    def read(file):
        return json.loads((root / file).read_bytes())

    update = read('public/content-update.json')
    commit = update['commit']
    for file in ['dialogue-flow-provenance', 'bwiki-provenance', 'video-order-provenance',
                 'video-review-summary']:
        if read('public/' + file + '.json')['commit'] != commit:
            raise ValueError('Mixed final verification versions: ' + file)
    events_path = root / 'public/simulation-events-provenance.json'
    if events_path.exists() and read('public/simulation-events-provenance.json')['commit'] != commit:
        raise ValueError('Mixed final event versions')
    if read('public/content/locales/manifest.json')['commit'] != commit:
        raise ValueError('Mixed localization version')
    specs = dict(read('src/data/imported-content.json'))
    for name in ['codex', 'simulation', 'books', 'trailblaze']:
        for entry in read('src/data/' + name + '.json'):
            for chapter in entry['chapters']:
                if chapter.get('image'):
                    from urllib.parse import urlparse
                    image = chapter['image']
                    if (urlparse(image.get('url', '')).scheme != 'https' or
                        urlparse(image.get('url', '')).hostname != 'patchwiki.biligame.com' or
                        urlparse(image.get('sourceUrl', '')).scheme != 'https' or
                        urlparse(image.get('sourceUrl', '')).hostname != 'wiki.biligame.com' or
                        not re.fullmatch(r'[a-f0-9]{40}', image.get('sha1', ''))):
                        raise ValueError('Unverified final event image')
                if chapter.get('content'):
                    key = entry['id'] + '/' + chapter['id']
                    if key in specs and specs[key] != chapter['content']:
                        raise ValueError('Conflicting content descriptors: ' + key)
                    specs[key] = chapter['content']
    rows, orders = {}, []
    expected_files = {item['file'] for item in specs.values()}
    actual_files = {'content/' + path.name for path in (root / 'public/content').glob('*.json')
                    if path.name != 'search-index.json'}
    if expected_files != actual_files:
        raise ValueError('Unreferenced or missing final payload')
    for route, content in specs.items():
        entry, chapter = route.split('/')
        file = content['file']
        if file != f'content/{entry}--{chapter}.json' or not re.fullmatch(r'content/[\w-]+\.json', file):
            raise ValueError('Invalid content route: ' + route)
        payload = read('public/' + file)
        if (payload['schema'] != 'hsr-dialogue.v1' or payload['entryId'] != entry or
                payload['chapterId'] != chapter or len(payload['rows']) != content['rows']):
            raise ValueError('Invalid content descriptor: ' + route)
        by_id = {row['id']: row for row in payload['rows']}
        for row in payload['rows']:
            if (row['id'] in rows or row['entryId'] != entry or row['chapterId'] != chapter or
                    row['type'] not in ['dialogue', 'choice', 'narration'] or
                    any(not isinstance(row.get(key), str) for key in
                        ['id', 'text', 'speaker', 'mission', 'scene', 'source']) or not row['text'].strip()):
                raise ValueError('Invalid or duplicate final row: ' + row['id'])
            if 'videoStatus' in row and (row['videoStatus'] not in ['caption-matched', 'screen-matched'] or
                    not re.fullmatch(r'[\w-]{11}', row.get('videoId', '')) or
                    not isinstance(row.get('videoStartMs'), (int, float)) or row['videoStartMs'] < 0 or
                    (row['videoStatus'] == 'screen-matched' and not row.get('videoScene'))):
                raise ValueError('Invalid final video proof: ' + row['id'])
            for key, scene, status in [('nextIds', 'flowScene', 'flowStatus'),
                                       ('replyToIds', 'flowScene', 'flowStatus'),
                                       ('bwikiNextIds', 'bwikiScene', 'bwikiStatus'),
                                       ('bwikiReplyToIds', 'bwikiScene', 'bwikiStatus'),
                                       ('videoNextIds', 'videoScene', 'videoStatus'),
                                       ('videoReplyToIds', 'videoScene', 'videoStatus')]:
                links = row.get(key, [])
                if not isinstance(links, list) or len(set(links)) != len(links):
                    raise ValueError('Invalid final links: ' + row['id'])
                for target in links:
                    other = by_id.get(target)
                    if (not other or target == row['id'] or not row.get(scene) or
                            other.get(scene) != row[scene] or
                            other.get(status) not in ['verified', 'matched', 'cached', 'screen-matched']):
                        raise ValueError('Unresolved final link: ' + row['id'])
                    if key.startswith('video') and (row.get('videoStatus') != 'screen-matched' or
                            other.get('videoStatus') != 'screen-matched' or
                            row.get('videoId') != other.get('videoId') or
                            row.get('missionId') != other.get('missionId') or row['source'] != other['source'] or
                            (key == 'videoReplyToIds' and (other['type'] != 'choice' or row['id'] not in other.get('videoNextIds', [])))):
                        raise ValueError('Conflicting final video scope/choice: ' + row['id'])
            rows[row['id']] = row
        orders.append([row['id'] for row in payload['rows']])
        for language in ['en', 'zh-CN', 'ja']:
            localized = read(f'public/content/locales/{language}/' + Path(file).name)
            identities = [row['id'] for row in localized['rows']]
            if (localized['schema'] != 'hsr-localizations.v1' or localized['language'] != language or
                    localized['entryId'] != entry or localized['chapterId'] != chapter or
                    localized['referenceCommit'] != commit or len(set(identities)) != len(identities) or
                    not set(identities) <= by_id.keys()):
                raise ValueError('Invalid final localization: ' + file)
    search = read('public/content/search-index.json')
    search_ids = [row['id'] for row in search['rows']]
    if len(set(search_ids)) != len(search_ids) or set(search_ids) != rows.keys() or update['rows'] != len(rows):
        raise ValueError('Final search identity/count mismatch')
    positions = {identity: position for position, identity in enumerate(search_ids)}
    for order in orders:
        if [positions[identity] for identity in order] != sorted(positions[identity] for identity in order):
            raise ValueError('Final search order mismatch')
    for row in search['rows']:
        expected = {key: value for key, value in rows[row['id']].items()
                    if key not in ['missionId', 'talkId', 'source']}
        expected['source'] = hashlib.sha256(rows[row['id']]['source'].encode()).hexdigest()[:16]
        if row != expected:
            raise ValueError('Final search text/verification mismatch: ' + row['id'])
    if events_path.exists():
        events = read('public/simulation-events-provenance.json')
        wiki = read('public/bwiki-provenance.json')
        for file, record in events['records'].items():
            payload = read('public/' + file)
            if record['rows'] != len(payload['rows']):
                raise ValueError('Final event count mismatch')
            for chunk in wiki['chapters'].get(file, []):
                if f"{chunk['page']}@{chunk['revision']}" not in wiki['sources']:
                    raise ValueError('Missing event source attribution')
                for identity in chunk['order']:
                    row, proof = rows[identity], chunk['evidence'][identity]
                    if (row['missionId'] != payload['chapterId'] or row['talkId'] != proof['talkId'] or
                        row.get('textHash') != proof['textHash'] or row['type'] != proof['type'] or
                        hashlib.sha256(row['text'].encode()).hexdigest() != proof['koreanHash']):
                        raise ValueError('Final event ID/text proof mismatch')
    return {'chapters': len(specs), 'rows': len(rows)}


if __name__ == '__main__':
    print(json.dumps(validate(Path(sys.argv[1]))))
