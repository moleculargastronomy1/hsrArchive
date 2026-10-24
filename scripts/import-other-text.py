"""BWIKI display groups and explicit speakers, joined to one official TextMap release."""
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('other_wiki', Path(__file__).with_name('bwiki-dialogue.py'))
wiki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wiki)
plain = wiki._localizations.plain
KINDS = {'NPC 대사': 'npc', '상호작용': 'interaction', '메시지': 'message', '우편': 'mail', '로딩 화면': 'loading'}
LABELS = {v: k for k, v in KINDS.items()}
LANGUAGES = {'en': 'EN', 'zh-CN': 'CHS', 'ja': 'JP'}


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def code_hash():
    return digest(b''.join(Path(__file__).with_name(n).read_bytes() for n in
        ['import-other-text.py', 'bwiki-dialogue.py', 'import-localizations.py']))


def fields(parts):
    result = {}
    for part in parts[1:]:
        if '=' not in part:
            continue
        key, value = part.split('=', 1)
        key = key.strip()
        if key in result:
            raise wiki.Unresolved('중복 본문 인수')
        result[key] = value.strip()
    return result


def converted(value):
    """Only known presentation templates become dialogue/choice syntax."""
    result = []
    for is_template, body in wiki.templates(value):
        if not is_template:
            result.append(body)
            continue
        parts = wiki.template_parts(body)
        name = parts[0]
        if name == '角色对话':
            if len(parts) == 5 and parts[3] == '文本':
                result.append('\n*' + parts[2] + '：' + parts[4] + '\n')
            else:
                result.append('\n----\n')
        elif name in ['对话', '事件'] and len(parts) == 3:
            result.append('\n*' + parts[1] + '：' + parts[2] + '\n')
        elif name in ['短信选项', '剧情选项', '折叠']:
            args = fields(parts)
            text = '{{' + ('剧情选项' if name == '短信选项' else name)
            for key, content in args.items():
                text += '|' + key + '=' + (converted(content) if re.fullmatch(r'剧情\d+|内容', key) else content)
            result.append('\n' + text + '}}\n')
        else:
            result.append('{{' + body + '}}')
    return ''.join(result)


def page_sections(content, kind, message_sort=False):
    """Return explicit source sections; do not flatten folds or sibling choices."""
    content = re.sub(r'<!--[\s\S]*?-->', '', content)
    if kind in ['npc', 'message', 'mail']:
        sections = []
        for is_template, body in wiki.templates(content):
            if not is_template:
                continue
            parts = wiki.template_parts(body)
            expected = {'npc': 'NPC', 'message': '短信内容', 'mail': '邮件'}[kind]
            if parts[0].lower() != expected.lower():
                continue
            args = fields(parts)
            text = args.get('对话内容' if kind == 'npc' else '内容', '')
            if not text:
                continue
            if kind == 'mail':
                # A mail is one sender's body, not a sequence of inferred speakers.
                body = re.sub(r'<br\s*/?>', '\n', text, flags=re.I)
                nodes = [{'kind': 'mail', 'speaker': args.get('发件人', ''), 'text': body}]
                sections.append((args.get('标题', ''), [nodes], args.get('发件人', '')))
            else:
                parsed = wiki.parse_body(converted(text), fragmented=True, provenance=True)
                if kind == 'message':
                    sections.append((args.get('短信标题', ''), parsed, args.get('人物', '')))
                else:
                    sections.extend((label, segments, args.get('名称', '')) for label, segments, _ in split_sections(parsed))
        if kind == 'npc' and not sections:
            match = re.search(r'^==\s*NPC对话\s*==\s*\n(.*?)(?=^==[^=]|\Z)', content, re.M | re.S)
            if match:
                sections = split_sections(wiki.parse_body(converted(match[1]), fragmented=True, provenance=True))
        if kind == 'message' and message_sort:
            ordering = []
            for is_template, body in wiki.templates(content):
                if is_template:
                    parts = wiki.template_parts(body)
                    if parts[0] == '短信内容' and fields(parts).get('内容'):
                        args = fields(parts)
                        version = args.get('版本', '')
                        number = args.get('排序', '0')
                        if not re.fullmatch(r'\d+\.\d', version) or not re.fullmatch(r'\d+', number):
                            raise wiki.Unresolved('메시지 표시 정렬 키 확인 필요')
                        ordering.append((version, int(number), args.get('短信标题', '')))
            if len(ordering) == len(sections):
                sections = [section for _, section in sorted(zip(ordering, sections), key=lambda pair: pair[0])]
        return sections
    if kind == 'loading':
        sections, label, nodes = [], '', []
        for line in content.splitlines():
            heading = re.fullmatch(r'==\s*([^=]+?)\s*==', line)
            if heading:
                if nodes:
                    sections.append((label, [nodes], ''))
                label, nodes = heading[1], []
            elif line.startswith('!') and '|' not in line and not line.startswith('!!'):
                nodes.append({'kind': 'loading-title', 'text': line[1:].strip()})
            elif line.startswith('|') and not line.startswith(('|-', '|}', '||')):
                text = line[1:].strip()
                if text:
                    nodes.append({'kind': 'narration', 'speaker': '', 'text': re.sub(r'<br\s*/?>', '\n', text, flags=re.I)})
            elif line.startswith('|-'):
                nodes.append({'kind': 'barrier'})
        if nodes:
            sections.append((label, [nodes], ''))
        return sections
    # Table/object headers are boundaries, not dialogue attributed to the object.
    content = re.sub(r'^!\s+([^|\n]+)$', r';\1', content, flags=re.M)
    return split_sections(wiki.parse_body(converted(content), fragmented=True, provenance=True))


def split_sections(segments):
    result, pending, label = [], [], ''
    def flush():
        nonlocal pending
        if pending:
            result.append((label, pending, ''))
        pending = []
    for segment in segments:
        single = segment[0] if len(segment) == 1 else {}
        if single.get('kind') == 'separated':
            flush()
            result.append((single.get('fold', single.get('condition', '')), single['segments'], ''))
        elif single.get('kind') == 'barrier' and single.get('label'):
            flush()
            label = single['label']
        else:
            pending.append(segment)
    flush()
    return result


def build(root, raw, plan_path, wiki_path, previous_path=None, repository_path=None):
    plan = json.loads(plan_path.read_bytes())
    corpus = json.loads((root / 'public/search/manifest.json').read_bytes())
    if (plan.get('schema') != 'hsr-upstream-plan.v1' or plan.get('repository') != 'DimbreathBot/TurnBasedGameData' or
            plan.get('commit') != corpus['commit'] or not re.fullmatch(r'[a-f0-9]{40}', plan.get('commit', ''))):
        raise ValueError('Mixed Other text input versions')
    evidence = {}
    def read(file):
        data = (raw / Path(file['path']).name).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        proof = {'gitBlob': blob, 'sha256': digest(data)}
        if blob != file['sha'] or (Path(file['path']).name.startswith(('TextMapKR', 'TextMapCHS')) and
                                  corpus['files'].get(Path(file['path']).name) != proof):
            raise ValueError('Unverified Other text input')
        evidence[Path(file['path']).name] = proof
        return json.loads(data)
    maps = {}
    for code in ['KR', 'CHS', 'EN', 'JP']:
        files = [f for f in plan['files'] if re.fullmatch(rf'TextMap/TextMap{code}(?:_\d+)?\.json', f['path'])]
        numbers = [int(re.search(r'_(\d+)\.json$', f['path'])[1]) if re.search(r'_(\d+)\.json$', f['path']) else 0 for f in files]
        if not files or sorted(numbers) != list(range(len(files))):
            raise ValueError('Incomplete Other TextMap')
        texts = {}
        for file in files:
            for key, value in read(file).items():
                if not re.fullmatch(r'\d+', key) or not isinstance(value, str) or (key in texts and texts[key] != value):
                    raise ValueError('Invalid Other TextMap')
                texts[key] = value
        maps[code] = texts
    korean, chinese = maps['KR'], maps['CHS']
    lookup = {}
    for key, text in chinese.items():
        if key in korean and plain(korean[key]):
            lookup.setdefault(wiki.normalized(text), []).append(key)
    talks = {}
    table = next((f for f in plan['files'] if f['path'] == 'ExcelOutput/TalkSentenceConfig.json'), None)
    if table:
        for row in read(table):
            key = str(row.get('TalkSentenceText', {}).get('Hash', ''))
            name = row.get('TextmapTalkSentenceName', {}).get('Hash')
            talks.setdefault(key, set()).add(str(name) if name is not None else '')
    def clean(value):
        try:
            return wiki.inline(value).strip()
        except wiki.Unresolved:
            return ''
    def name(value):
        value = clean(value)
        keys = lookup.get(wiki.normalized(value), []) if value else []
        labels = {plain(korean[k]) for k in keys} - {''}
        if len(labels) == 1 and not re.search(r'[\u3400-\u9fff]', next(iter(labels))):
            return next(iter(labels)), keys
        return '', []
    def resolve(text, speaker=''):
        text = clean(text)
        keys = lookup.get(wiki.normalized(text), []) if text else []
        label, speaker_keys = name(speaker)
        if speaker and speaker_keys:
            narrowed = [k for k in keys if talks.get(k, set()) & set(speaker_keys)]
            if narrowed:
                keys = narrowed
        variants = {plain(korean[k]) for k in keys}
        if len(variants) != 1:
            return None
        return {'text': next(iter(variants)), 'hashes': keys, 'speaker': label, 'speakerHashes': speaker_keys,
                'unresolvedSpeaker': bool(speaker and not label)}
    upstream = json.loads(wiki_path.read_bytes())
    if upstream.get('schema') != 'hsr-bwiki-input.v1' or upstream['commit'] != plan['commit']:
        raise ValueError('Mixed Other BWIKI versions')
    layouts, message_sort = [], False
    for layout in upstream.get('layouts', []):
        data = Path(layout['file']).read_bytes()
        if digest(data) != layout['sha256']:
            raise ValueError('Unverified Other display template')
        text = data.decode('utf8')
        if re.search(r'^\|sort=版本,排序,短信标题\s*$', text, re.M) and not re.search(r'^\|order=', text, re.M):
            message_sort = True
            layouts.append({k: layout[k] for k in ['pageTitle', 'pageId', 'revision', 'sha256']})
    if not upstream.get('layouts'):
        for candidate in [previous_path, repository_path]:
            if candidate and candidate.exists():
                old = json.loads(candidate.read_bytes())
                if (old.get('commit') == plan['commit'] and old.get('codeSha256') == code_hash() and
                        old.get('files') == evidence and old.get('layouts')):
                    layouts, message_sort = old['layouts'], True
                    break
    groups, publications, review, speaker_observations = [], [], [], {}
    def write(file, value):
        target = root / file
        target.parent.mkdir(parents=True, exist_ok=True)
        data = encode(value)
        target.write_bytes(data)
        publications.append(file)
        return digest(data)
    seen = set()
    for page in upstream['pages']:
        kind = KINDS.get(page.get('searchKind'))
        if page.get('status') != 'available' or not kind or page['pageId'] in seen:
            continue
        if kind == 'message' and not message_sort:
            review.append({'pageId': page['pageId'], 'reason': '메시지 표시 순서의 고정 근거 미확인; 이전 묶음 유지'})
            continue
        seen.add(page['pageId'])
        data = Path(page['file']).read_bytes()
        if digest(data) != page['sha256']:
            raise ValueError('Unverified Other BWIKI snapshot')
        proof = {k: page[k] for k in ['pageTitle', 'pageId', 'revision', 'sha256']}
        try:
            sections = page_sections(data.decode('utf8'), kind, message_sort)
        except wiki.Unresolved as error:
            review.append({'pageId': page['pageId'], 'reason': str(error)})
            continue
        group_name, _ = name(page['pageTitle'].split('/')[-1])
        group_id = f'{kind}-p{page["pageId"]}'
        group = {'id': group_id, 'kind': kind, 'title': group_name or LABELS[kind] + ' 기록', 'source': proof, 'sections': []}
        label_counts = {}
        for section_number, (label, segments, owner) in enumerate(sections):
            owner_label, _ = name(owner)
            if not group_name and owner_label and kind in ['npc', 'message']:
                group['title'] = owner_label
            title, _ = name(label)
            title = title or (owner_label + ' · ' if kind == 'mail' and owner_label else '') + f'{LABELS[kind]} {section_number + 1}'
            identity = (label, owner)
            count = label_counts.get(identity, 0)
            label_counts[identity] = count + 1
            section_id = 's' + digest(encode([page['pageId'], label, owner, count]))[:16]
            entry_id, chapter_id = 'other-' + group_id, section_id
            rows, positions, records = [], [], {}
            context_number, boundary = 0, False
            loading_title = ''
            def compile_nodes(nodes, pointer, branch=()):
                nonlocal context_number, boundary, loading_title
                first, tails, entry_open = [], [], True
                for index, node in enumerate(nodes):
                    location = [*pointer, index]
                    node_kind = node.get('kind')
                    if node_kind == 'loading-title':
                        loading_title, _ = name(node['text'])
                        continue
                    if node_kind == 'separated':
                        context_number += 1
                        for j, segment in enumerate(node['segments']):
                            compile_nodes(segment, [*location, 'separated', j], (*branch, str(j)))
                            context_number += 1
                        tails = []
                        entry_open = False
                        continue
                    if node_kind == 'choice':
                        options, ends, complete = [], [], True
                        for j, option in enumerate(node['options']):
                            option_node = {**option, 'kind': 'option'}
                            branch_id = digest(encode(location))[:12] + '-' + str(j)
                            starts, option_tails = compile_nodes([option_node], [*location, 'option', j], (*branch, branch_id))
                            body_starts, body_ends = compile_nodes(option.get('body', []), [*location, 'reply', j], (*branch, branch_id))
                            if not starts:
                                complete = False
                            options.extend(starts)
                            for tail in option_tails:
                                positions[tail]['nextIds'] = [positions[s]['id'] for s in body_starts]
                            for start in body_starts:
                                positions[start]['replyToIds'] = [positions[s]['id'] for s in starts]
                            ends.extend(body_ends if body_starts else [] if option.get('body') else option_tails)
                        if complete:
                            for tail in tails:
                                positions[tail]['nextIds'] = [positions[s]['id'] for s in options]
                        if not first and entry_open:
                            first = options
                        tails = ends if complete else []
                        continue
                    if node_kind not in ['line', 'narration', 'option', 'mail']:
                        if kind == 'loading':
                            loading_title = ''
                        context_number += 1
                        tails = []
                        entry_open = False
                        continue
                    candidate = resolve(node.get('text', ''), node.get('speaker', ''))
                    if not candidate and node_kind == 'mail':
                        # Preserve paragraph positions with a boundary at every missing paragraph.
                        parts = [{'kind': 'line', 'text': part, 'speaker': node.get('speaker', '')}
                                 for part in node.get('text', '').splitlines() if part.strip()]
                        starts, ends = compile_nodes(parts, [*location, 'paragraph'], branch)
                        if not first and entry_open:
                            first = starts
                        tails = ends
                        continue
                    if not candidate:
                        review.append({'pageId': page['pageId'], 'section': section_id, 'location': location, 'reason': '공식 원문 대응 미확인'})
                        context_number += 1
                        tails = []
                        entry_open = False
                        continue
                    row_id = entry_id + '-' + digest(encode([section_id, location, candidate['hashes']]))[:20]
                    row = {'id': row_id, 'entryId': entry_id, 'chapterId': chapter_id,
                           'text': candidate['text'], 'speaker': candidate['speaker'], 'mission': group['title'],
                           'scene': title, 'type': 'choice' if node_kind == 'option' else 'dialogue' if candidate['speaker'] else 'narration',
                           'textHashCandidates': candidate['hashes'], 'speakerHashCandidates': candidate['speakerHashes'],
                           'speakerUnresolved': candidate['unresolvedSpeaker']}
                    if loading_title and kind == 'loading':
                        row['displayTitle'] = loading_title
                    position = {'id': row_id, 'rowId': row_id, 'missionId': group_id, 'mission': group['title'],
                                'sceneId': section_id, 'scene': title,
                                'contextId': 'wiki-context-' + digest(encode([group_id, section_id, context_number]))[:24],
                                'page': proof['pageTitle'], 'revision': proof['revision'], 'location': location,
                                'conditions': [], 'branch': list(branch), 'nextIds': [], 'replyToIds': [], 'status': 'wiki-display'}
                    ordinal = len(positions)
                    rows.append(row)
                    positions.append(position)
                    records[row_id] = candidate
                    for tail in tails:
                        positions[tail]['nextIds'] = [row_id]
                    if not first and entry_open:
                        first = [ordinal]
                    tails = [ordinal]
                    for key in candidate['hashes']:
                        speaker_observations.setdefault(key, []).append({**candidate, 'source': proof})
                return first, tails
            for i, segment in enumerate(segments):
                compile_nodes(segment, [i])
                context_number += 1
            if not rows:
                continue
            file = f'other/{entry_id}--{chapter_id}.json'
            sha = write('public/search/' + file, {'schema': 'hsr-dialogue.v1', 'entryId': entry_id, 'chapterId': chapter_id,
                'referenceCommit': plan['commit'], 'rows': rows, 'wikiReading': {'schema': 'hsr-wiki-reading.v1',
                'missions': [{'id': group_id, 'title': group['title'], 'page': proof['pageTitle'], 'officialMissionIds': []}],
                'occurrences': positions, 'unplaced': []}})
            descriptor = {'id': section_id, 'title': title, 'file': file, 'rows': len(rows), 'sha256': sha, 'locales': {}}
            group['sections'].append(descriptor)
            for language, code in LANGUAGES.items():
                translated = []
                for row in rows:
                    record = records[row['id']]
                    values = {plain(maps[code].get(key, ''), language) for key in record['hashes']} - {''}
                    names = {plain(maps[code].get(key, ''), language) for key in record['speakerHashes']} - {''}
                    if len(values) == 1:
                        translated.append({'id': row['id'], 'text': next(iter(values)), 'speaker': next(iter(names)) if len(names) == 1 else ''})
                descriptor['locales'][language] = write(f'public/search/locales/{language}/{entry_id}--{chapter_id}.json', {
                    'schema': 'hsr-localizations.v1', 'entryId': entry_id, 'chapterId': chapter_id,
                    'language': language, 'referenceCommit': plan['commit'], 'rows': translated})
        if group['sections']:
            groups.append(group)
    # Reuse only exact-input, exact-code, revision-pinned derived groups, never raw wiki inference.
    for previous_path in [previous_path, repository_path]:
        if not previous_path or not previous_path.exists():
            continue
        previous = json.loads(previous_path.read_bytes())
        if previous.get('commit') != plan['commit'] or previous.get('codeSha256') != code_hash() or previous.get('files') != evidence:
            continue
        for group in previous['groups']:
            current = next((g for g in groups if g['id'] == group['id']), None)
            if current:
                old_ids, new_ids = set(), set()
                for section in group['sections']:
                    data = (previous_path.parent / section['file']).read_bytes()
                    if digest(data) != section['sha256']:
                        raise ValueError('Unverified previous Other chapter')
                    old_ids.update(r['id'] for r in json.loads(data)['rows'])
                for section in current['sections']:
                    new_ids.update(r['id'] for r in json.loads((root / 'public/search' / section['file']).read_bytes())['rows'])
                if old_ids <= new_ids:
                    continue
                groups.remove(current)
                review.append({'pageId': group['source']['pageId'], 'reason': '기존 출현 보존 검사: 이전 고정 문서 묶음 유지'})
            for section in group['sections']:
                for file in ['public/search/' + section['file'], *[
                    f'public/search/locales/{language}/other-{group["id"]}--{section["id"]}.json' for language in LANGUAGES]]:
                    source = previous_path.parent / file.removeprefix('public/search/')
                    data = source.read_bytes()
                    expected_hash = section['sha256'] if file.startswith('public/search/other/') else section['locales'][file.split('/')[3]]
                    if digest(data) != expected_hash:
                        raise ValueError('Unverified previous Other chapter')
                    target = root / file
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    publications.append(file)
            groups.append(group)
    speakers, speaker_observations = {}, {}
    for group in groups:
        for section in group['sections']:
            payload = json.loads((root / 'public/search' / section['file']).read_bytes())
            for row in payload['rows']:
                for key in row['textHashCandidates']:
                    speaker_observations.setdefault(key, []).append(row)
    for key, observations in speaker_observations.items():
        names = {o['speaker'] for o in observations}
        if len(names) == 1 and '' not in names and not any(o.get('speakerUnresolved') for o in observations):
            speakers[key] = {'text': plain(korean[key]), 'name': next(iter(names)),
                             'nameHashCandidates': sorted({h for o in observations for h in o['speakerHashCandidates']}, key=int),
                             'localizedNames': {}}
            for language, code in LANGUAGES.items():
                labels = {plain(maps[code].get(h, ''), language) for h in speakers[key]['nameHashCandidates']}
                if len(labels) == 1 and '' not in labels:
                    speakers[key]['localizedNames'][language] = next(iter(labels))
    unnamed = {}
    for group in sorted(groups, key=lambda g: g['source']['pageId']):
        if group['title'] == LABELS[group['kind']] + ' 기록':
            if group['kind'] == 'loading':
                group['title'] = LABELS[group['kind']]
            else:
                unnamed[group['kind']] = unnamed.get(group['kind'], 0) + 1
                group['title'] += ' ' + str(unnamed[group['kind']])
    groups.sort(key=lambda g: (list(LABELS).index(g['kind']), g['title'], g['id']))
    write('public/search/other-catalog.json', {'schema': 'hsr-other-catalog.v1', 'commit': plan['commit'],
        'repository': plan['repository'], 'codeSha256': code_hash(), 'files': evidence,
        'groups': groups, 'speakers': speakers, 'review': review, 'layouts': layouts,
        'policy': 'BWIKI display order only; unsupported boundaries never become inferred dialogue links.'})
    receipt = root / '.cache/other-text-receipt.json'
    receipt.parent.mkdir(parents=True, exist_ok=True)
    referenced = {'public/search/other-catalog.json'}
    for group in groups:
        for section in group['sections']:
            referenced.add('public/search/' + section['file'])
            referenced.update(f'public/search/locales/{language}/other-{group["id"]}--{section["id"]}.json' for language in LANGUAGES)
    receipt.write_bytes(encode({'files': sorted(referenced)}))
    print(json.dumps({'groups': len(groups), 'sections': sum(len(g['sections']) for g in groups), 'speakers': len(speakers)}))


def validate(root):
    file = root / 'public/search/other-catalog.json'
    if not file.exists():
        return
    data = json.loads(file.read_bytes())
    corpus = json.loads((root / 'public/search/manifest.json').read_bytes())
    if data.get('schema') != 'hsr-other-catalog.v1' or data['commit'] != corpus['commit'] or any(
            data['files'].get(k) != v for k, v in corpus['files'].items()):
        raise ValueError('Invalid Other catalog input')
    ids = set()
    for group in data['groups']:
        if (not re.fullmatch(r'(?:npc|interaction|message|mail|loading)-p\d+', group['id']) or
                group['kind'] not in LABELS or not group['title'].strip() or re.search(r'[\u3400-\u9fff]', group['title'])):
            raise ValueError('Invalid Other group')
        for section in group['sections']:
            expected = f'other/other-{group["id"]}--{section["id"]}.json'
            if section['file'] != expected or not re.fullmatch(r's[a-f0-9]{16}', section['id']):
                raise ValueError('Invalid Other chapter path')
            raw = (file.parent / expected).read_bytes()
            payload = json.loads(raw)
            rows = payload['rows']
            if digest(raw) != section['sha256'] or payload['referenceCommit'] != data['commit'] or len(rows) != section['rows']:
                raise ValueError('Invalid Other chapter checksum')
            current = {row['id'] for row in rows}
            if len(current) != len(rows) or current & ids:
                raise ValueError('Invalid Other row identity')
            ids.update(current)
            for row in rows:
                if (not row['text'].strip() or re.search(r'[\u3400-\u9fff]', row['speaker']) or
                        not row['textHashCandidates'] or any(not re.fullmatch(r'\d+', k) for k in row['textHashCandidates'])):
                    raise ValueError('Invalid Other original text')
            for p in payload['wikiReading']['occurrences']:
                if p['rowId'] not in current or any(key not in current for key in p['nextIds'] + p['replyToIds']):
                    raise ValueError('Invalid Other dialogue edge')
            for language in LANGUAGES:
                localized_raw = (file.parent / f'locales/{language}/other-{group["id"]}--{section["id"]}.json').read_bytes()
                localized = json.loads(localized_raw)
                if (localized['referenceCommit'] != data['commit'] or localized['entryId'] != payload['entryId'] or
                        localized['chapterId'] != payload['chapterId'] or localized['language'] != language or
                        digest(localized_raw) != section['locales'][language] or
                        any(r['id'] not in current or not r['text'].strip() for r in localized['rows'])):
                    raise ValueError('Invalid Other localization')
    for key, record in data['speakers'].items():
        if (not re.fullmatch(r'\d+', key) or not record['text'].strip() or not record['name'].strip() or
                re.search(r'[\u3400-\u9fff]', record['name']) or not record['nameHashCandidates']):
            raise ValueError('Invalid Other speaker')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--validate':
        validate(Path(sys.argv[2]))
    else:
        build(*(Path(arg) for arg in sys.argv[1:]))
