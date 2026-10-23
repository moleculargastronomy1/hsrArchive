"""Validate the final derived view after flow, BWIKI and video integration."""
import hashlib
import json
import re
import sys
import importlib.util
from pathlib import Path


def validate(root):
    spec = importlib.util.spec_from_file_location('search_text_validation', Path(__file__).with_name('import-search-text.py'))
    search_text = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(search_text)
    search_text.validate(root)
    spec = importlib.util.spec_from_file_location('search_locale_validation', Path(__file__).with_name('import-search-localizations.py'))
    search_locale = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(search_locale)
    search_locale.validate(root)
    spec = importlib.util.spec_from_file_location('bwiki_placement_validation', Path(__file__).with_name('bwiki-placement.py'))
    placement = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(placement)
    spec = importlib.util.spec_from_file_location('execution_placement_validation', Path(__file__).with_name('execution-placement.py'))
    execution = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(execution)
    def read(file):
        return json.loads((root / file).read_bytes())

    update = read('public/content-update.json')
    commit = update['commit']
    wiki = read('public/bwiki-provenance.json')
    translated = {identity: (chunk, proof) for chunks in wiki.get('chapters', {}).values()
                  for chunk in chunks for identity, proof in chunk.get('evidence', {}).items()
                  if proof.get('translationReviewHash')}
    translation_reviews = {
        hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest(): record
        for record in wiki.get('translationReviews', {}).get('reviews', [])}
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
        if 'wikiReading' in payload:
            placement.validate(payload['wikiReading'], payload['rows'], commit)
        if 'executionReading' in payload:
            execution.validate(payload['executionReading'], payload['rows'], commit, payload.get('wikiReading'))
        for row in payload['rows']:
            if row.get('bwikiMatchMethod') is not None:
                if row['bwikiMatchMethod'] != 'translation-reviewed' or row['id'] not in translated:
                    raise ValueError('Missing final bilingual review: ' + row['id'])
                chunk, proof = translated[row['id']]
                review = translation_reviews.get(proof['translationReviewHash'], {})
                source = wiki.get('sources', {}).get(f"{chunk['page']}@{chunk['revision']}", {})
                if (row.get('bwikiStatus') not in ['matched', 'cached'] or
                        review.get('file') != file or review.get('rowId') != row['id'] or
                        review.get('talkId') != row.get('talkId') or review.get('type') != row['type'] or
                        review.get('page') != chunk['page'] or review.get('revision') != chunk['revision'] or
                        review.get('pageSha256') != source.get('sha256') or
                        not review.get('translatedKorean') or not review.get('rationale') or
                        any(review.get(key) != proof.get(key) for key in ['chineseHash', 'speakerHash', 'koreanHash'])):
                    raise ValueError('Invalid final bilingual review: ' + row['id'])
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
    source_first = root / 'public/source-first-provenance.json'
    if source_first.exists():
        audit = read('public/source-first-provenance.json')
        if (audit.get('schema') != 'hsr-source-first-provenance.v1' or audit.get('commit') != commit or
                not re.fullmatch(r'[a-f0-9]{64}', audit.get('codeHash', '')) or
                not re.fullmatch(r'[a-f0-9]{64}', audit.get('policyHash', ''))):
            raise ValueError('Invalid source-first release/policy provenance')
        seen_occurrences = set()
        for file, chapter in audit['chapters'].items():
            if file not in expected_files or chapter['verification'].get('wholePath') != 'unverified' or chapter['verification'].get('referenceTxtUsed') is not False:
                raise ValueError('Unsupported source-first verification claim')
            nodes = {n['id']: n for n in chapter['occurrences']}
            if len(nodes) != len(chapter['occurrences']) or seen_occurrences.intersection(nodes):
                raise ValueError('Duplicate source-first occurrence')
            seen_occurrences.update(nodes)
            reading = read('public/' + file).get('wikiReading', {})
            for left, targets in chapter['wikiGraph'].items():
                for target in targets:
                    a, z = nodes[left], nodes[target]
                    if (a['pageId'] != z['pageId'] or a['revision'] != z['revision'] or
                            a['location'][0] != z['location'][0] or a['context'] != z['context'] or
                            not (a['branch'] == z['branch'][:len(a['branch'])] or z['branch'] == a['branch'][:len(z['branch'])])):
                        raise ValueError('Source-first graph crossed a scene/condition boundary')
            for addition in chapter['additions']:
                row = rows.get(addition['rowId'])
                proof, content = addition['proof'], addition['content']
                node = nodes.get(addition['occurrence'])
                if proof.get('kind') == 'bwiki-mission':
                    placement.validate_admission(addition, row, node, chapter, reading)
                    continue
                owner = re.fullmatch(r'(?:Config/Level/Mission|Story/(?:Discussion/)?Mission)/(\d+)/[\w./-]+\.json', proof['source'])
                if (not row or not owner or int(owner[1]) != addition['missionId'] or
                        row['missionId'] != 'quest-' + str(addition['missionId']) or
                        row['source'] != proof['source'] or row.get('talkId') != content['talkId'] or
                        row['text'] != content['text'] or row['speaker'] != content['speaker'] or
                        hashlib.sha256(row['text'].encode()).hexdigest() != content['koreanHash'] or
                        not node or node['status'] not in ['confirmed', 'wiki-confirmed'] or node['officialIds'] != [row['talkId']] or
                        not re.fullmatch(r'[a-f0-9]{40}', proof.get('gitBlob', '')) or
                        not re.fullmatch(r'[a-f0-9]{64}', proof.get('sha256', ''))):
                    raise ValueError('Invalid source-first explicit mission/text proof')
    return {'chapters': len(specs), 'rows': len(rows)}


if __name__ == '__main__':
    print(json.dumps(validate(Path(sys.argv[1]))))
