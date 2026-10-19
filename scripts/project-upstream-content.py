"""Refresh only exact TalkSentence/hash joins; preserve established scene order and roles."""
import hashlib
import json
import re
import sys
from pathlib import Path


def plain(value):
    value = value.replace('\\n', '\n').replace('\u00a0', ' ')
    value = re.sub(r'</?(?:color|size|b|i|s|u|unbreak)(?:=[^>]*)?>', '', value, flags=re.I)
    return re.sub(r'\*{0,2}\{NICKNAME\}\*{0,2}', '[개척자]', value)


def refresh_row(row, talks, texts, bindings, chapters=None):
    # Talk identity and the original branch/scene structure are separate from localized text.
    record = talks.get(row.get('talkId')) if row.get('talkId') else None
    text_hash = record.get('TalkSentenceText', {}).get('Hash') if record else row.get('textHash', bindings.get(row['id']))
    introduction = re.fullmatch(r'ExcelOutput/MissionChapterConfig.json:(\d+)/ChapterDesc', row.get('source', ''))
    if introduction and chapters is not None:
        text_hash = chapters.get(int(introduction[1]), {}).get('ChapterDesc', {}).get('Hash')
    if text_hash is None or not isinstance(texts.get(str(text_hash)), str) or not texts[str(text_hash)].strip():
        return dict(row), False
    result = dict(row)
    result['text'] = plain(texts[str(text_hash)])
    if row.get('missionId', '').startswith('event-'):
        result['text'] = re.sub(r'</?align(?:=[^>]*)?>', '', result['text'], flags=re.I).strip()
    if introduction and chapters is not None:
        result['textHash'] = str(text_hash)
    if record:
        speaker_hash = record.get('TextmapTalkSentenceName', {}).get('Hash')
        if speaker_hash and isinstance(texts.get(str(speaker_hash)), str):
            result['speaker'] = plain(texts[str(speaker_hash)])
            if row.get('missionId', '').startswith('event-'):
                result['speaker'] = result['speaker'].strip()
    return result, True


def safe_payload(file):
    if not re.fullmatch(r'content/[A-Za-z0-9_-]+\.json', file):
        raise ValueError(f'Unsafe payload path: {file}')
    return 'public/' + file


def index_talk_rows(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError('Invalid talk table')
    result = {}
    for row in rows:
        # The dump contains one all-default sentinel serialized as an empty object.
        if row == {}:
            continue
        key = row.get('TalkSentenceID') if isinstance(row, dict) else None
        if type(key) is not int or key <= 0 or key in result:
            raise ValueError('Duplicate or invalid TalkSentence identity')
        result[key] = row
    if not result:
        raise ValueError('Empty talk table')
    return result


def latest_trailblaze_chapter(rows, texts):
    candidates = []
    for row in rows:
        if row.get('ChapterType') != 'Normal':
            continue
        sequence = plain(texts.get(str(row.get('ChapterSequence', {}).get('Hash')), ''))
        # The game's sequence labels use act/chapter in the reverse order of this archive.
        match = re.fullmatch(r'제(\d+)막\s*[•·]\s*제(\d+)장', sequence)
        if match:
            chapter, act = map(int, match.groups())
            if chapter > 0 and act > 0:
                candidates.append((chapter, act, row))
    if not candidates:
        raise ValueError('No numbered Trailblaze chapter in release snapshot')
    chapter, act, row = max(candidates, key=lambda item: item[:2])
    title = plain(texts.get(str(row.get('ChapterName', {}).get('Hash')), '')).strip()
    if not title:
        raise ValueError('Latest Trailblaze chapter has no Korean title')
    return {'id': row['ID'], 'chapter': chapter, 'act': act, 'title': title}


def validate_payload(payload, entry_id, chapter_id):
    if payload.get('schema') != 'hsr-dialogue.v1' or not isinstance(payload.get('rows'), list):
        raise ValueError('Invalid dialogue payload')
    if payload.get('entryId') != entry_id or payload.get('chapterId') != chapter_id:
        raise ValueError('Mismatched dialogue identity')
    for row in payload['rows']:
        if (any(not isinstance(row.get(key), str) for key in
                ['id', 'entryId', 'chapterId', 'mission', 'scene', 'speaker', 'text']) or
                row['entryId'] != entry_id or row['chapterId'] != chapter_id or
                row.get('type') not in ['dialogue', 'choice', 'narration'] or not row['text'].strip()):
            raise ValueError('Invalid dialogue row')


def project(root, raw, manifest_path):
    stage = Path.cwd()
    manifest = json.loads(manifest_path.read_bytes())
    commit = manifest['commit']
    evidence = {}

    def read_raw(name):
        expected = next(row['sha'] for row in manifest['files'] if Path(row['path']).name == name)
        data = (raw / name).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if expected != blob:
            raise ValueError('Unverified input: ' + name)
        evidence[name] = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
        return json.loads(data)

    texts = {}
    for file in manifest['files']:
        if re.fullmatch(r'TextMap/TextMapKR(?:_\d+)?\.json', file['path']):
            for key, value in read_raw(Path(file['path']).name).items():
                if not isinstance(value, str) or (key in texts and texts[key] != value):
                    raise ValueError('Conflicting or invalid Korean text')
                texts[key] = value
    talk_rows = read_raw('TalkSentenceConfig.json')
    talks = index_talk_rows(talk_rows)
    chapter_rows = read_raw('MissionChapterConfig.json')
    latest_chapter = latest_trailblaze_chapter(chapter_rows, texts)
    chapter_lookup = {row['ID']: row for row in chapter_rows if row.get('ID')}

    def read(file):
        return json.loads((stage / file).read_bytes())

    publications = set()

    def write(file, data, pretty=False):
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2 if pretty else None,
                                    separators=None if pretty else (',', ':')) + '\n',
                          encoding='utf-8', newline='\n')
        publications.add(file)

    bindings = read('src/data/text-bindings.json')
    train = read('src/data/train-databank.json')
    introductions = read('src/data/astropolis-intro.json')
    for source in [train, introductions]:
        if source['commit'] != commit:
            raise ValueError('Mixed upstream revisions')
        evidence.update(source['files'])
    codex = read('src/data/codex.json')
    metadata = read('src/data/imported-content.json')
    trailblaze = read('src/data/trailblaze.json')
    # Preserved chapters keep their bodies, but share the refreshed descriptor.
    # Reject disagreement before linking; never overwrite conflicting evidence.
    for entry in trailblaze:
        for chapter in entry['chapters']:
            if chapter.get('content'):
                key = entry['id'] + '/' + chapter['id']
                if metadata.get(key) != chapter['content']:
                    raise ValueError('Conflicting Trailblaze content descriptor: ' + key)
                chapter['content'] = metadata[key]
    simulation = read('src/data/simulation.json')
    books = read('src/data/books.json')
    payloads = {}
    verified = changed = retained = 0
    trailblaze_receipt = read('.cache/trailblaze-receipt.json')
    for file in trailblaze_receipt['payloads']:
        if not file.startswith('public/'):
            raise ValueError('Invalid Trailblaze publication')
        safe_payload(file.removeprefix('public/'))
        payloads[file] = read(file)
        verified += len(payloads[file]['rows'])

    for group in train['groups']:
        entry = next(item for item in codex if item['id'] == 'codex-' + group['id'])
        previous = {chapter['id']: chapter for chapter in entry['chapters']}
        grouped = {}
        for doc in group['documents']:
            grouped.setdefault(doc['title'], []).append(doc)
        chapters = []
        for title, docs in grouped.items():
            doc = docs[0]
            chapter_id = doc['id']
            rows = []
            for item in docs:
                for section in item['sections']:
                    for row in section['rows']:
                        rows.append({
                            'id': f"{entry['id']}-{chapter_id}-{item['id']}-{len(rows)}",
                            'entryId': entry['id'], 'chapterId': chapter_id,
                            'missionId': item['id'], 'mission': item['title'],
                            'scene': section['title'], 'speaker': '', 'type': 'narration',
                            'text': row['text'], 'talkId': None, 'source': section['source'],
                            'variant': row['variant'],
                        })
            file = f"content/{entry['id']}--{chapter_id}.json"
            source_ids = [item['id'] for item in docs]
            payloads['public/' + file] = {
                'schema': 'hsr-dialogue.v1', 'entryId': entry['id'], 'chapterId': chapter_id,
                'referenceCommit': commit, 'sourceIds': source_ids, 'missing': 0,
                'orderNote': 'NounAtlas 정렬 순서. 갱신 기록을 함께 보존합니다.', 'rows': rows,
            }
            old = previous.get(chapter_id, {})
            chapters.append({
                'id': chapter_id, 'title': title, 'intro': doc['isIntroPage'],
                'aliases': old.get('aliases', []), 'blocks': [],
                'content': {'file': file, 'rows': len(rows), 'missing': 0, 'sourceIds': source_ids},
            })
            verified += len(rows)
        # Missing old records require investigation rather than silently erasing saved routes.
        if set(previous) - {chapter['id'] for chapter in chapters}:
            raise ValueError('Upstream removed an existing databank record')
        entry.update(chapters=chapters, description=group['description'])
        entry['source'] = {'kind': 'extracted', 'version': '열차 자료실 NounAtlas ' + commit[:7],
                           'sourceIds': [doc['id'] for doc in group['documents']]}

    specs = [(key.split('/')[0], key.split('/')[1], value) for key, value in metadata.items()]
    specs.extend((entry['id'], chapter['id'], chapter['content'])
                 for entry in simulation + codex for chapter in entry['chapters'])
    for entry in books:
        for chapter in entry['chapters']:
            content = chapter['content']
            file = safe_payload(content['file'])
            payloads[file] = read(file)
            validate_payload(payloads[file], entry['id'], chapter['id'])
            specs.append((entry['id'], chapter['id'], content))
            verified += len(payloads[file]['rows'])
    for entry_id, chapter_id, content in specs:
        file = safe_payload(content['file'])
        if file in payloads:
            continue
        payload = json.loads((root / file).read_bytes())
        validate_payload(payload, entry_id, chapter_id)
        if entry_id == 'paradise-records' and chapter_id == 'before-moonrise' and len(payload['rows']) == 1:
            doc = introductions['documents'][0]
            payload['rows'][0]['text'] = doc['sections'][0]['rows'][0]['text']
            payload['referenceCommit'] = commit
            verified += 1
        else:
            updated_rows, unresolved = [], []
            for row in payload['rows']:
                result, matched = refresh_row(row, talks, texts, bindings, chapter_lookup)
                updated_rows.append(result)
                verified += int(matched)
                changed += int(matched and (result['text'] != row['text'] or result['speaker'] != row['speaker']))
                retained += int(not matched)
                if not matched:
                    unresolved.append(row['id'])
            payload['rows'] = updated_rows
            payload['textReferenceCommit'] = commit
            payload['retainedTextRowIds'] = unresolved
        payloads[file] = payload
        if len(payload['rows']) != content['rows']:
            raise ValueError('Refresh changed established dialogue row count')

    all_rows = []
    for entry_id, chapter_id, content in specs:
        file = safe_payload(content['file'])
        payload = payloads[file]
        validate_payload(payload, entry_id, chapter_id)
        if content['rows'] != len(payload['rows']):
            raise ValueError('Invalid refreshed metadata')
        content['textReferenceCommit'] = commit
        all_rows.extend(payload['rows'])
        write(file, payload)
    if len({row['id'] for row in all_rows}) != len(all_rows):
        raise ValueError('Duplicate published dialogue identity')
    if verified == 0:
        raise ValueError('Upstream did not resolve any existing content')
    old_search = json.loads((root / 'public/content/search-index.json').read_bytes())
    references = old_search['sourceReferences']
    if not any(item.get('repository') == manifest['repository'] and item.get('commit') == commit for item in references):
        references.append({'repository': manifest['repository'], 'commit': commit})
    search_rows = []
    for row in all_rows:
        result = {key: value for key, value in row.items() if key not in ['missionId', 'talkId', 'source']}
        result['source'] = hashlib.sha256(row['source'].encode()).hexdigest()[:16]
        search_rows.append(result)
    write('public/content/search-index.json', {
        'schema': 'hsr-dialogue.v1', 'referenceCommit': old_search['referenceCommit'],
        'sourceReferences': references, 'textReferenceCommit': commit, 'rows': search_rows,
    })
    for entry in simulation + codex:
        if not entry['id'].startswith(('codex-aeons', 'codex-terms', 'codex-factions')):
            entry['source']['version'] = entry['source']['version'].split(' · 원문 갱신')[0] + ' · 원문 갱신 ' + commit[:7]
    for file, data in [('codex', codex), ('simulation', simulation), ('books', books), ('imported-content', metadata),
                       ('trailblaze', trailblaze), ('train-databank', train), ('astropolis-intro', introductions)]:
        write('src/data/' + file + '.json', data, True)
    write('public/content-update.json', {
        'schema': 'hsr-content-update.v1', 'repository': manifest['repository'],
        'commit': commit, 'version': manifest['version'], 'checkedAt': manifest['checkedAt'],
        'latestTrailblaze': latest_chapter,
        'intervalHours': 6, 'files': evidence,
        'rows': len(all_rows), 'verifiedTextRows': verified, 'changedTextRows': changed,
        'retainedTextRows': retained,
        'scope': 'Exact TalkSentence/hash joins, NounAtlas, LocalbookConfig and verified new Trailblaze structures. Unlinked text is retained. New story ownership is not inferred.',
    }, True)
    write('receipt.json', {'files': sorted(publications), 'rows': len(all_rows)}, True)
    print(json.dumps({'verified': verified, 'changed': changed, 'retained': retained, 'rows': len(all_rows)}))


if __name__ == '__main__':
    project(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
