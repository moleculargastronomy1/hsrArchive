"""Exact event ownership from handbooks/NPC paths; BWIKI supplies mode-scoped presentation."""
import copy
import hashlib
import importlib.util
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

spec = importlib.util.spec_from_file_location('bwiki', Path(__file__).with_name('bwiki-dialogue.py'))
bwiki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bwiki)

MODES = {100: ('simulated-universe', '시뮬레이션 우주', ['模拟宇宙']),
         130: ('swarm-disaster', '곤충 떼 재난', ['寰宇蝗灾']),
         160: ('gold-and-gears', '황금과 기계', ['黄金与机械']),
         260: ('unknowable-domain', '인지 불가 영역', ['不可知域']),
         'tourn': ('divergent-universe', '차분화 우주', ['人间喜剧', '千面英雄', '乐园漫记', '差分宇宙'])}


def read(path):
    return json.loads(path.read_bytes())


def load(raw, plan_path, root):
    plan, _, talks, cn, kr, evidence = bwiki.inputs(raw, plan_path)

    def table(name):
        desc = next(item for item in plan['files'] if item['path'] == 'ExcelOutput/' + name)
        data = (raw / name).read_bytes()
        if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != desc['sha']:
            raise ValueError('Invalid event table hash: ' + name)
        evidence[desc['path']] = {'gitBlob': desc['sha'], 'sha256': hashlib.sha256(data).hexdigest()}
        return json.loads(data)

    # The official type table identifies mode IDs; do not infer them from NPC numbers.
    type_names = {row['RogueHandBookEventType']: cn.get(str(row.get('RogueEventTypeTitle', {}).get('Hash')))
                  for row in table('RogueHandBookEventType.json')}
    for identity in [100, 130, 160, 260]:
        if type_names.get(identity, '').split('：')[-1] != MODES[identity][2][0]:
            raise ValueError('Unrecognized official event mode: ' + str(identity))
    catalog = []
    for name, namespace in [('RogueHandBookEvent.json', 'rogue'), ('RogueTournHandBookEvent.json', 'tourn')]:
        for row in table(name):
            title_hash = str(row['EventTitle']['Hash'])
            if not cn.get(title_hash) or not kr.get(title_hash):
                raise ValueError('Missing official event title')
            modes = ['tourn'] if namespace == 'tourn' else row.get('EventTypeList', [])
            for mode in modes:
                if mode not in MODES:
                    continue
                entry, label, names = MODES[mode]
                chapter = f"event-{namespace}-{row['EventHandbookID']}"
                catalog.append({'namespace': namespace, 'id': row['EventHandbookID'], 'mode': mode,
                                'entryId': entry, 'chapterId': chapter, 'modeNames': names,
                                'title': bwiki._localizations.plain(cn[title_hash]),
                                'koreanTitle': bwiki._localizations.plain(kr[title_hash]),
                                'titleHash': title_hash, 'progress': row.get('UnlockNPCProgressIDList', []),
                                'order': row.get('Order', row.get('Priority', row['EventHandbookID'])),
                                'file': f'content/{entry}--{chapter}.json'})
    npcs = {}
    for name in ['RogueNPC.json', 'RogueTournNPC.json', 'RogueMagicNPC.json']:
        for row in table(name):
            if row['RogueNPCID'] in npcs and npcs[row['RogueNPCID']] != row['NPCJsonPath']:
                raise ValueError('Conflicting NPC identity')
            npcs[row['RogueNPCID']] = row['NPCJsonPath'].strip()
    manifest = read(root / '.cache/simulation-events/manifest.json')
    if manifest['commit'] != plan['commit']:
        raise ValueError('Mixed event structure version')
    structures = {}
    for item in manifest['files']:
        if not re.fullmatch(r'Config/Level/Rogue/(?:RogueNPC|RogueDialogue)/[\w/-]+\.json', item['path']):
            raise ValueError('Unsafe event structure path')
        data = (root / '.cache/simulation-events/raw' / item['path']).read_bytes()
        if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != item['sha']:
            raise ValueError('Invalid event structure hash')
        structures[item['path']] = json.loads(data)
        evidence[item['path']] = {'gitBlob': item['sha'], 'sha256': hashlib.sha256(data).hexdigest()}
    displays = {row['OptionDisplayID']: row for row in table('RogueDialogueOptionDisplay.json')}
    return plan, catalog, npcs, structures, {row['TalkSentenceID']: row for row in talks if row.get('TalkSentenceID')}, cn, kr, displays, evidence


def catalog(root, raw, plan_path):
    plan, records, *_ = load(raw, plan_path, root)
    entries = read(root / 'src/data/simulation.json')
    publications = ['src/data/simulation.json']
    for mode, (entry_id, label, _) in MODES.items():
        entry = next((item for item in entries if item['id'] == entry_id), None)
        if entry is None:
            entry = {'id': entry_id, 'title': label, 'subtitle': '시뮬레이션 우주',
                     'description': label + '의 사건과 실험 기록.', 'category': 'simulation',
                     'world': 'simulated-universe', 'order': 11, 'language': 'ko-KR',
                     'tags': [label, '사건 기록'], 'source': {'kind': 'extracted',
                         'version': '공식 사건 도감 ' + plan['commit'][:7], 'sourceIds': []}, 'chapters': []}
            entries.append(entry)
        for record in sorted((r for r in records if r['mode'] == mode), key=lambda r: (r['order'], r['id'])):
            existing = next((c for c in entry['chapters'] if c['id'] == record['chapterId']), None)
            if existing:
                existing['title'] = record['koreanTitle']
                continue
            payload = {'schema': 'hsr-dialogue.v1', 'entryId': entry_id, 'chapterId': record['chapterId'],
                       'referenceCommit': plan['commit'], 'textReferenceCommit': plan['commit'],
                       'sourceIds': [record['chapterId']], 'missing': 0, 'rows': [],
                       'orderNote': '공식 사건 도감의 항목입니다. 모드별 본문·분기는 BWIKI 대조 후 수록합니다.'}
            entry['chapters'].append({'id': record['chapterId'], 'title': record['koreanTitle'],
                'group': '사건 기록', 'blocks': [], 'contentNote': '사건 본문·선택지 대조 대기',
                'content': {'file': record['file'], 'rows': 0, 'missing': 0,
                            'sourceIds': [record['chapterId']], 'textReferenceCommit': plan['commit']}})
            bwiki.write(root / 'public' / record['file'], payload)
            publications.append('public/' + record['file'])
        entry['source']['sourceIds'] = list(dict.fromkeys(identity for ch in entry['chapters']
            for identity in ch.get('content', {}).get('sourceIds', [])))
        entry['source']['version'] = entry['source']['version'].split(' · 사건 기록')[0] + ' · 사건 기록 ' + plan['commit'][:7]
    bwiki.write(root / 'src/data/simulation.json', entries, pretty=True)
    receipt = read(root / 'receipt.json')
    receipt['files'] = sorted(set(receipt['files'] + publications))
    bwiki.write(root / 'receipt.json', receipt)
    bwiki.write(root / '.cache/simulation-events/catalog.json', {'commit': plan['commit'], 'records': records})
    print(json.dumps({'eventRecords': len(records)}))


def discover(root):
    records = read(root / '.cache/simulation-events/catalog.json')['records']
    request = read(root / '.cache/bwiki/request.json')
    for record in records:
        page = next((item for item in request['requests'] if item['title'] == record['title']), None)
        if page is None:
            page = {'title': record['title'], 'missionId': 0, 'eventFiles': []}
            request['requests'].append(page)
        page.setdefault('eventFiles', []).append(record['file'])
    bwiki.write(root / '.cache/bwiki/request.json', request)


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def candidates(record, npcs, structures, talks, cn, kr, displays=None):
    """Only references owned by this handbook event can supply a Korean row."""
    identities, options, effects = set(), set(), set()
    paths = set()
    option_displays = {}
    for progress in record['progress']:
        matches = [value for value in progress.values() if isinstance(value, int) and value in npcs]
        if len(matches) != 1:
            continue
        npc = structures.get(npcs[matches[0]], {})
        paths.update(item['DialoguePath'].strip() for item in npc.get('DialogueList', []) if item.get('DialoguePath'))
        for item in npc.get('DialogueList', []):
            for option in structures.get(item.get('OptionPath', '').strip(), {}).get('OptionList', []):
                if option.get('OptionID') and option.get('DisplayID'):
                    option_displays.setdefault(option['OptionID'], set()).add(option['DisplayID'])
    for path in sorted(paths):
        for node in walk(structures.get(path, {})):
            if isinstance(node.get('TalkSentenceID'), int):
                identities.add(node['TalkSentenceID'])
            if isinstance(node.get('OptionTextmapID'), dict) and node['OptionTextmapID'].get('Hash'):
                options.add(str(node['OptionTextmapID']['Hash']))
            mapped = option_displays.get(node.get('RogueOptionID'), set())
            if len(mapped) == 1:
                display = (displays or {}).get(next(iter(mapped)), {})
                label = display.get('OptionTitle', {}).get('Hash')
                effect = display.get('OptionDesc', {}).get('Hash')
                if label:
                    options.add(str(label))
                    if effect:
                        effects.add((str(label), str(effect)))
    index = defaultdict(list)

    def add(kind, identity, text_hash, name_hash=None, label=None):
        chinese, korean = cn.get(str(text_hash)), kr.get(str(text_hash))
        if not chinese or not korean:
            return
        speaker = cn.get(str(name_hash), '') if name_hash else ''
        key = (kind, bwiki.comparable(chinese), bwiki.comparable(cn.get(label, '')) if kind == 'effect' else
               '' if kind == 'choice' else bwiki.normalized(speaker))
        index[key].append({'talkId': identity, 'textHash': str(text_hash),
            'text': bwiki._localizations.plain(korean),
            'speaker': bwiki._localizations.plain(kr.get(str(name_hash), '')) if name_hash else '',
            'chineseHash': bwiki.digest(bwiki.canonical(chinese)),
            'speakerHash': bwiki.digest(bwiki.canonical(speaker)),
            'koreanHash': bwiki.digest(bwiki._localizations.plain(korean))})
    for identity in sorted(identities):
        talk = talks.get(identity)
        if talk:
            add('line', identity, talk.get('TalkSentenceText', {}).get('Hash'),
                talk.get('TextmapTalkSentenceName', {}).get('Hash'))
    for text_hash in sorted(options):
        add('choice', None, text_hash)
    for label, text_hash in sorted(effects):
        add('effect', None, text_hash, label=label)
    return index


def event_segments(content, record):
    """Interpret event templates as data; never execute wiki variables or code."""
    comments_removed = re.sub(r'<!--.*?-->', '', content, flags=re.S)
    containers = []
    for node in walk_templates(comments_removed):
        name = bwiki.template_parts(node)[0]
        if name in ['模拟宇宙事件', '模拟宇宙事件2']:
            _, fields = bwiki.template(node)
            containers.append(fields)
    if len(containers) != 1:
        raise bwiki.Unresolved('사건 문서 구조 확인 필요')
    fields = containers[0]
    if bwiki.normalized(bwiki.inline(fields.get('名称', ''))) != bwiki.normalized(record['title']):
        raise bwiki.Unresolved('공식 사건명과 위키 사건명 불일치')
    allowed = set(record['modeNames'])
    modes = set(re.split('[、,，]', fields.get('模式', '')))
    if not modes & allowed:
        raise bwiki.Unresolved('해당 모드의 사건 본문 없음')
    body = fields.get('剧情对话', '')
    if not body.strip():
        raise bwiki.Unresolved('사건 본문 누락')

    def parse(value):
        segments, current = [], []

        def flush():
            nonlocal current
            if current:
                segments.append(current)
                current = []

        for is_template, data in bwiki.templates(value):
            if not is_template:
                if data.strip():
                    flush()  # prose/HTML/conditions are hard boundaries
                    segments.append([{'kind': 'unsupported'}])
                continue
            args = bwiki.template_parts(data)
            name = args[0]
            if name == '事件':
                values = args[1:]
                if len(values) == 3 and values[0] == '星神':
                    values = values[1:]
                if len(values) == 2:
                    try:
                        current.append({'kind': 'line', 'speaker': bwiki.inline(values[0]), 'text': bwiki.inline(values[1])})
                    except bwiki.Unresolved:
                        flush()
                else:
                    flush()
            elif name in ['模拟宇宙事件选项', '模拟宇宙事件选项2']:
                _, options = bwiki.template(data)
                for field in options:
                    if not re.fullmatch(r'选项(?:\d+|-[\w\-]+)', field):
                        continue
                    suffix = field[2:]
                    only = set(re.split('[、,，]', options.get('模式' + suffix, '')))
                    excluded = set(re.split('[、,，]', options.get('排除模式' + suffix, '')))
                    if only != {''} and not only & allowed or excluded & allowed:
                        continue
                    flush()  # Never turn sibling options into a linear sequence.
                    try:
                        label = bwiki.inline(re.sub(r'\{\{#info:[^{}]*\}\}', '', options[field]))
                        choice = {'kind': 'choice', 'options': [{'kind': 'option', 'text': label,
                            'body': [], 'icon': '退出'}]}
                    except bwiki.Unresolved:
                        continue
                    responses = parse(options.get('剧情' + suffix, ''))
                    try:
                        effect = bwiki.inline(options.get('内容' + suffix, ''))
                    except bwiki.Unresolved:
                        effect = ''
                    # The template often repeats the player's selected label.
                    # Remove that exact echo; it is not a separate TalkSentence.
                    if responses and responses[0] and responses[0][0].get('speaker') == '你' and \
                            bwiki.comparable(responses[0][0]['text']) == bwiki.comparable(label):
                        responses[0] = responses[0][1:]
                        responses = [part for part in responses if part]
                    if len(responses) == 1 and all(node['kind'] == 'line' for node in responses[0]):
                        segments.append([choice] + ([{'kind': 'effect', 'text': effect, 'label': label}] if effect else []) + responses[0])
                    else:
                        segments.append([choice] + ([{'kind': 'effect', 'text': effect, 'label': label}] if effect else []))
                        segments.extend(responses)
            elif name == '剧情选项' and args[1:] == ['选项1=选择']:
                continue
            else:
                flush()
                segments.append([{'kind': 'unsupported'}])
                # Unknown templates, probability folds and wiki variables cannot
                # establish an edge. Their explicit event lines remain inspectable.
                if name in ['折叠', '#tag:tabber']:
                    for arg in args[1:]:
                        if '=' in arg and arg.split('=', 1)[0] in ['内容']:
                            segments.extend(parse(arg.split('=', 1)[1]))
        flush()
        return segments
    return parse(body)


def walk_templates(value):
    for is_template, data in bwiki.templates(value):
        if not is_template:
            continue
        yield data
        for arg in bwiki.template_parts(data)[1:]:
            yield from walk_templates(arg)


def align(root, raw, plan_path, manifest_path, previous_root):
    plan, records, npcs, structures, talks, cn, kr, displays, evidence = load(raw, plan_path, root)
    manifest = read(manifest_path)
    report = read(root / 'public/bwiki-provenance.json')
    previous = read(previous_root / 'public/bwiki-provenance.json')
    old_events_path = previous_root / 'public/simulation-events-provenance.json'
    old_events = read(old_events_path) if old_events_path.exists() else {}
    event_report = copy.deepcopy(old_events.get('records', {}))
    pages = {page['title']: page for page in manifest['pages']}
    targets = set(manifest['targetFiles']) if 'targetFiles' in manifest else None
    entries = read(root / 'src/data/simulation.json')
    delta = 0
    publications, changed = ['src/data/simulation.json', 'public/bwiki-provenance.json',
                             'public/simulation-events-provenance.json'], {}
    for record in records:
        file = record['file']
        if targets is not None and file not in targets:
            continue
        payload = read(root / 'public' / file)
        previous_count = len(payload['rows'])
        index = candidates(record, npcs, structures, talks, cn, kr, displays)
        page = pages.get(record['title'])
        by_id = {row['id']: row for row in payload['rows']}
        chunks, review = [], []
        if page and page['status'] == 'available':
            data = Path(page['file']).read_bytes()
            if hashlib.sha256(data).hexdigest() != page['sha256']:
                raise ValueError('Invalid BWIKI event page hash')
            try:
                segments = event_segments(data.decode('utf-8'), record)
                hits = []
                for segment in segments:
                    matched = []
                    for node in segment:
                        if node['kind'] == 'unsupported':
                            if matched:
                                hits.append(matched)
                                matched = []
                            review.append({'reason': '미지원 조건·확률·동적 위키 문법 경계'})
                            continue
                        kind = node['kind'] if node['kind'] in ['choice', 'effect'] else 'line'
                        text = node['options'][0]['text'] if kind == 'choice' else node['text']
                        speaker = bwiki.comparable(node['label']) if kind == 'effect' else '' if kind == 'choice' else bwiki.normalized(node['speaker'])
                        key = (kind, bwiki.comparable(text), speaker)
                        found = index.get(key, [])
                        if len(found) != 1:
                            if matched:
                                hits.append(matched)
                                matched = []
                            review.append({'reason': '공식 사건 내 대사 ID 누락·중복 또는 화자 불일치', 'kind': kind})
                            continue
                        item = found[0]
                        identity = ('talk-' + str(item['talkId'])) if item['talkId'] else 'text-' + item['textHash']
                        row_id = f"{record['entryId']}-{record['chapterId']}-{identity}-{kind}"
                        row = {'id': row_id, 'entryId': record['entryId'], 'chapterId': record['chapterId'],
                               'missionId': record['chapterId'], 'mission': record['koreanTitle'],
                               'scene': record['koreanTitle'], 'type': 'choice' if kind == 'choice' else
                               'dialogue' if item['speaker'] else 'narration', 'speaker': item['speaker'],
                               'text': item['text'], 'talkId': item['talkId'], 'textHash': item['textHash'],
                               'source': f"{record['namespace']}HandBookEvent:{record['id']}/{identity}",
                               'flowStatus': 'review', 'bwikiStatus': 'review'}
                        matched.append((row, item))
                    if matched:
                        hits.append(matched)
                occurrences = Counter(row['id'] for hit in hits for row, _ in hit)
                for position, hit in enumerate(hits):
                    # Repeated locations must not acquire a guessed sequence.
                    unique = [(row, item) for row, item in hit if occurrences[row['id']] == 1]
                    if len(unique) != len(hit):
                        review.append({'reason': '반복 대사의 위키 위치 확인 필요'})
                    # Do not bridge a removed repeated line.
                    runs, run = [], []
                    for row, item in hit:
                        if occurrences[row['id']] != 1:
                            if run:
                                runs.append(run)
                                run = []
                        else:
                            run.append((row, item))
                    if run:
                        runs.append(run)
                    for subposition, run in enumerate(runs):
                        order = [row['id'] for row, _ in run]
                        for row, _ in run:
                            by_id.setdefault(row['id'], row)
                        chunks.append({'missionId': 'bwiki-page-' + str(page['pageId']),
                            'mission': record['koreanTitle'], 'page': page['pageTitle'], 'revision': page['revision'],
                            'segment': f'event-{record["entryId"]}-{position}.{subposition}',
                            'status': 'cached' if page.get('retrieval') == 'cache-pinned' else 'matched',
                            'order': order, 'edges': {identity: [order[i+1]] if i+1 < len(order) else []
                                                      for i, identity in enumerate(order)},
                            'evidence': {row['id']: {**item, 'type': row['type']} for row, item in run}})
                if not hits:
                    review.append({'reason': '지원하는 사건 본문 없음'})
            except bwiki.Unresolved as error:
                review.append({'reason': str(error)})
        else:
            review.append({'reason': page.get('reason', '사건 문서 조회 대기') if page else '사건 문서 조회 대기'})
        # Preserve previously proven chunks only after rechecking official event
        # membership and exact Chinese/Korean hashes, even after HTTP restrictions.
        candidate_by_identity = {(item['talkId'], item['textHash']): item for values in index.values() for item in values}
        for old in previous.get('chapters', {}).get(file, []):
            valid = f"{old['page']}@{old['revision']}" in previous.get('sources', {}) and all(identity in by_id and
                (expected := old['evidence'].get(identity)) and
                (item := candidate_by_identity.get((expected.get('talkId'), expected.get('textHash')))) and
                all(item.get(key) == expected.get(key) for key in ['chineseHash', 'speakerHash', 'koreanHash']) and
                by_id[identity]['text'] == item['text'] and by_id[identity]['speaker'] == item['speaker'] and
                by_id[identity]['type'] == expected['type']
                for identity in old['order'])
            coverage = {identity for chunk in chunks for identity in chunk['order']}
            new_edges = {identity: set(ids) for chunk in chunks for identity, ids in chunk['edges'].items()}
            preserves_edges = all(set(ids) <= new_edges.get(identity, set()) for identity, ids in old['edges'].items())
            if valid and (not set(old['order']) <= coverage or not preserves_edges):
                protected = set(old['order'])
                chunks = [chunk for chunk in chunks if not protected.intersection(chunk['order'])]
                chunks.append({**old, 'status': 'cached'})
        payload['rows'] = list(by_id.values())
        delta += len(payload['rows']) - previous_count
        payload['bwikiBaseOrder'] = [row['id'] for row in payload['rows']]
        accepted = bwiki.apply_chunks(payload, chunks)
        for row in payload['rows']:
            row.setdefault('bwikiStatus', 'review')
        payload['textReferenceCommit'] = plan['commit']
        payload['orderNote'] = '공식 사건 도감에 귀속된 한국어 원문입니다. BWIKI에서 확인한 모드별 구간만 연결하며 조건·확률·미확인 경계는 이어 붙이지 않습니다.'
        report['chapters'][file] = accepted
        for chunk in accepted:
            key = f"{chunk['page']}@{chunk['revision']}"
            if page and page['status'] == 'available' and chunk['revision'] == page['revision']:
                from urllib.parse import quote
                report['sources'][key] = {'page': page['pageTitle'], 'revision': page['revision'],
                    'timestamp': page.get('timestamp'), 'collectedAt': page.get('collectedAt'), 'sha256': page['sha256'],
                    'sourceUrl': 'https://wiki.biligame.com/sr/' + quote(page['pageTitle']) + '?oldid=' + str(page['revision']),
                    'historyUrl': 'https://wiki.biligame.com/sr/' + quote(page['pageTitle']) + '?action=history'}
            if key not in report['sources'] and key in previous.get('sources', {}):
                report['sources'][key] = previous['sources'][key]
        chapter = next(c for entry in entries if entry['id'] == record['entryId'] for c in entry['chapters']
                       if c['id'] == record['chapterId'])
        chapter['content']['rows'] = len(payload['rows'])
        chapter['contentNote'] = '사건 기록 · 조건·확률별 장면과 선택지 응답은 일부 확인 대기'
        image = manifest.get('eventImages', {}).get(record['title'])
        if image:
            chapter['image'] = {**image, 'alt': record['koreanTitle']}
        changed.update((row['id'], row) for row in payload['rows'])
        bwiki.write(root / 'public' / file, payload)
        publications.append('public/' + file)
        event_report[file] = {'eventId': record['id'], 'catalog': record['namespace'], 'mode': record['entryId'],
            'page': record['title'], 'rows': len(payload['rows']), 'matchedRows': sum(len(c['order']) for c in accepted),
            'candidateRows': sum(len(values) for values in index.values()),
            'status': 'partial' if payload['rows'] else 'pending',
            'imageStatus': 'linked' if chapter.get('image') else 'pending',
            'review': review + [{'reason': '선택지 응답·조건·확률 분기 전체 확인 대기'}]}
    search = read(root / 'public/content/search-index.json')
    # Rebuild only event rows, preserving the order and bytes of other records.
    event_ids = set(changed)
    search['rows'] = [row for row in search['rows'] if row['id'] not in event_ids]
    for record in records:
        if targets is not None and record['file'] not in targets:
            continue
        for row in read(root / 'public' / record['file'])['rows']:
            search['rows'].append({**{key: value for key, value in row.items() if key not in ['missionId', 'talkId', 'source']},
                                   'source': hashlib.sha256(row['source'].encode()).hexdigest()[:16]})
    bwiki.write(root / 'public/content/search-index.json', search)
    publications.append('public/content/search-index.json')
    update = read(root / 'public/content-update.json')
    update['rows'] = len(search['rows'])
    update['verifiedTextRows'] += delta
    bwiki.write(root / 'public/content-update.json', update)
    publications.append('public/content-update.json')
    bwiki.write(root / 'src/data/simulation.json', entries, pretty=True)
    totals = Counter()
    for item in bwiki.specs(root):
        totals.update(read(root / 'public' / item['file']).get('bwiki', {}))
    report['totals'] = dict(totals)
    report['events'] = {file: {'remaining': max(1, item['candidateRows'] - item['matchedRows']),
                              'status': item['status'], 'page': item['page']}
                        for file, item in event_report.items()}
    bwiki.write(root / 'public/bwiki-provenance.json', report)
    bwiki.write(root / 'public/simulation-events-provenance.json', {'schema': 'hsr-simulation-events.v1',
        'commit': plan['commit'], 'checkedAt': manifest['checkedAt'], 'inputs': evidence, 'records': event_report,
        'structureReview': read(root / '.cache/simulation-events/manifest.json').get('review', []),
        'imageReview': manifest.get('eventImageReview', []),
        'copyright': 'Game text © HoYoverse and respective rights holders.', 'license': manifest['license']})
    receipt = read(root / 'receipt.json')
    receipt['files'] = sorted(set(receipt['files'] + publications))
    receipt['rows'] = len(search['rows'])
    bwiki.write(root / 'receipt.json', receipt)
    print(json.dumps({'eventRecords': len(event_report), 'eventRows': sum(item['rows'] for item in event_report.values())}))


if __name__ == '__main__':
    root, raw, plan = map(Path, sys.argv[1:4])
    if '--catalog' in sys.argv:
        catalog(root, raw, plan)
    elif '--discover' in sys.argv:
        discover(root)
    else:
        align(root, raw, plan, Path(sys.argv[4]), Path(sys.argv[5]))
