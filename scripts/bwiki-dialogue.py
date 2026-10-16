"""Align BWIKI structure with exact, same-release Chinese/Korean dialogue IDs."""
import hashlib
import html
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote

from importlib.util import module_from_spec, spec_from_file_location

_spec = spec_from_file_location('localizations', Path(__file__).with_name('import-localizations.py'))
_localizations = module_from_spec(_spec)
_spec.loader.exec_module(_localizations)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(path)


def inputs(raw, plan_path):
    plan = json.loads(plan_path.read_bytes())
    if plan.get('schema') != 'hsr-upstream-plan.v1' or plan.get('repository') != 'DimbreathBot/TurnBasedGameData':
        raise ValueError('Invalid BWIKI game input plan')
    evidence = {}

    def read(file):
        data = (raw / Path(file['path']).name).read_bytes()
        if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != file['sha']:
            raise ValueError('Unverified BWIKI game input: ' + file['path'])
        evidence[file['path']] = {'gitBlob': file['sha'], 'sha256': hashlib.sha256(data).hexdigest()}
        return json.loads(data)

    def table(name):
        return read(next(file for file in plan['files'] if file['path'] == 'ExcelOutput/' + name))

    def textmap(code):
        files = [file for file in plan['files'] if re.fullmatch(rf'TextMap/TextMap{code}(?:_\d+)?\.json', file['path'])]
        if not files:
            raise ValueError('Missing TextMap: ' + code)
        parts = sorted(int(re.search(r'_(\d+)\.json$', file['path'])[1])
                       if re.search(r'_(\d+)\.json$', file['path']) else 0 for file in files)
        if parts != list(range(len(files))):
            raise ValueError('Incomplete TextMap: ' + code)
        result = {}
        for file in files:
            for key, value in read(file).items():
                if not isinstance(value, str) or (key in result and result[key] != value):
                    raise ValueError('Conflicting TextMap')
                result[key] = value
        return result

    return plan, table('MainMission.json'), table('TalkSentenceConfig.json'), textmap('CHS'), textmap('KR'), evidence


def specs(root):
    metadata = json.loads((root / 'src/data/imported-content.json').read_bytes())
    simulation = json.loads((root / 'src/data/simulation.json').read_bytes())
    return list(metadata.values()) + [chapter['content'] for entry in simulation for chapter in entry['chapters']]


def discover(root, raw, plan_path):
    plan, missions, _, chinese, _, _ = inputs(raw, plan_path)
    used = set()
    for spec in specs(root):
        payload = json.loads((root / 'public' / spec['file']).read_bytes())
        used.update(int(row['missionId'][6:]) for row in payload['rows'] if re.fullmatch(r'quest-\d+', row.get('missionId', '')))
    titles = defaultdict(list)
    missing = []
    for mission in missions:
        identity = mission.get('MainMissionID')
        if identity not in used:
            continue
        title = chinese.get(str(mission.get('Name', {}).get('Hash')), '').strip()
        if title:
            titles[title].append(identity)
        else:
            missing.append({'missionId': identity, 'reason': '공식 중국어 임무명 없음'})
    requests = [{'title': title, 'missionId': identities[0]} for title, identities in sorted(titles.items()) if len(identities) == 1]
    missing.extend({'missionId': identity, 'reason': '같은 중국어 제목의 여러 임무'}
                   for title, identities in titles.items() if len(identities) > 1 for identity in identities)
    write(root / '.cache/bwiki/request.json', {'schema': 'hsr-bwiki-request.v1', 'commit': plan['commit'],
                                               'requests': requests, 'review': missing})
    print(json.dumps({'missions': len(used), 'requests': len(requests), 'review': len(missing)}))


class Unresolved(ValueError):
    pass


def template_parts(value):
    """Split only top-level pipes, preserving nested templates and wiki links."""
    result, start, braces, links, index = [], 0, 0, 0, 0
    while index < len(value):
        pair = value[index:index + 2]
        if pair == '{{':
            braces += 1
            index += 2
        elif pair == '}}':
            braces -= 1
            index += 2
        elif pair == '[[':
            links += 1
            index += 2
        elif pair == ']]':
            links -= 1
            index += 2
        elif value[index] == '|' and braces == links == 0:
            result.append(value[start:index].strip())
            start = index + 1
            index += 1
        else:
            index += 1
        if braces < 0 or links < 0:
            raise Unresolved('위키 문법 경계 확인 필요')
    if braces or links:
        raise Unresolved('닫히지 않은 위키 문법')
    result.append(value[start:].strip())
    return result


def templates(value):
    index, plain_start = 0, 0
    while index < len(value):
        if value[index:index + 2] != '{{':
            index += 1
            continue
        if index > plain_start:
            yield False, value[plain_start:index]
        begin, depth = index, 1
        index += 2
        while index < len(value) and depth:
            pair = value[index:index + 2]
            if pair == '{{':
                depth += 1
                index += 2
            elif pair == '}}':
                depth -= 1
                index += 2
            else:
                index += 1
        if depth:
            raise Unresolved('닫히지 않은 위키 템플릿')
        yield True, value[begin + 2:index - 2]
        plain_start = index
    if plain_start < len(value):
        yield False, value[plain_start:]


def template(value):
    parts = template_parts(value)
    fields = {}
    for part in parts[1:]:
        if '=' not in part:
            raise Unresolved('이름 없는 분기 인수')
        key, data = part.split('=', 1)
        key = key.strip()
        if key in fields:
            raise Unresolved('중복 분기 인수')
        fields[key] = data.strip()
    return parts[0], fields


def inline(value):
    pieces = []
    for is_template, data in templates(value):
        if not is_template:
            pieces.append(data)
            continue
        parts = template_parts(data)
        name, args = parts[0], parts[1:]
        if name in ['颜色', 'color', '黑幕'] and args:
            pieces.append(inline(args[-1]))
        elif name in ['注音', 'ruby'] and args:
            pieces.append(inline(args[0]))
        else:
            raise Unresolved('미지원 인라인 템플릿: ' + name)
    result = ''.join(pieces)
    result = re.sub(r'\[\[(?:[^\]|]+\|)?([^\]]+)\]\]', r'\1', result)
    result = result.replace("'''", '').replace("''", '')
    return html.unescape(result)


def normalized(value):
    value = _localizations.plain(html.unescape(value), 'zh-CN')
    value = re.sub(r'<br\s*/?>', ' ', value, flags=re.I)
    # Typography/whitespace normalization only; no translation or similarity joins.
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value))


def parse_body(value):
    """Return independent sections. Optional/folded conversations never join the main path."""
    segments, current = [], []

    def flush():
        nonlocal current
        if current:
            segments.append(current)
        current = []

    def consume(text):
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            match = re.fullmatch(r'\*+\s*([^：:]+)[：:](.+)', line)
            if match:
                try:
                    current.append({'kind': 'line', 'speaker': inline(match[1]), 'text': inline(match[2])})
                except Unresolved:
                    flush()
                    segments.append([{'kind': 'unsupported'}])
            else:
                flush()
                # Never connect across headings, stage directions, images or
                # unparsed narration; these may represent independent scenes.
                segments.append([{'kind': 'barrier' if line.startswith(('=', '----', ':')) else 'unsupported'}])

    def choice(data):
        name, fields = template(data)
        if name != '剧情选项' or any(not re.fullmatch(r'(?:选项|剧情|图标)\d+|默认选项', key) for key in fields):
            raise Unresolved('미지원 선택지 템플릿')
        numbers = sorted(int(key[2:]) for key in fields if re.fullmatch(r'选项\d+', key))
        if not numbers or numbers != list(range(1, len(numbers) + 1)) or numbers[-1] > 10:
            raise Unresolved('선택지 번호 확인 필요')
        options = []
        for number in numbers:
            body = fields.get(f'剧情{number}', '')
            parsed = parse_body(body)
            if len(parsed) > 1:
                raise Unresolved('응답 안의 독립 장면 확인 필요')
            icon = fields.get(f'图标{number}', '继续')
            if icon not in ['继续', '对话', '退出']:
                raise Unresolved('미지원 선택지 동작')
            options.append({'kind': 'option', 'text': inline(fields[f'选项{number}']),
                            'body': parsed[0] if parsed else [], 'icon': icon})
        return {'kind': 'choice', 'options': options}

    # A presentation template on a dialogue line must remain inline; only whole
    # structural templates are pulled out of the line-oriented stream.
    value = re.sub(r'<!--.*?-->', '', value, flags=re.S)
    buffer = ''
    for is_template, data in templates(value):
        name = template_parts(data)[0] if is_template else ''
        if is_template and name not in ['剧情选项', '折叠']:
            buffer += '{{' + data + '}}'
            continue
        if not is_template:
            buffer += data
            continue
        consume(buffer)
        buffer = ''
        if name == '剧情选项':
            try:
                current.append(choice(data))
            except Unresolved:
                flush()
                segments.append([{'kind': 'unsupported'}])
        else:
            flush()
            _, fields = template(data)
            if fields.get('标题') not in ['前情提要', '剧情梗概']:
                segments.extend(parse_body(fields.get('内容', '')))
            flush()
    consume(buffer)
    flush()
    return segments

def story_segments(content):
    match = re.search(r'^==\s*(?:剧情内容|任务剧情)\s*==\s*$', content, flags=re.M)
    if not match:
        raise Unresolved('지원하는 임무 대사 구역 없음')
    body = content[match.end():]
    stop = re.search(r'^==[^=].*?==\s*$', body, flags=re.M)
    return parse_body(body[:stop.start()] if stop else body)


def validate_mission_page(content, title):
    content = re.sub(r'<!--.*?-->', '', content, flags=re.S)
    for is_template, value in templates(content):
        if is_template and template_parts(value)[0] == '任务':
            _, fields = template(value)
            if normalized(inline(fields.get('任务名称', ''))) != normalized(title):
                raise Unresolved('위키 문서의 공식 임무명 불일치')
            if fields.get('任务类型') not in ['开拓任务', '开拓续闻', '同行任务', '冒险任务', '日常任务', '活动任务', '命路群像']:
                raise Unresolved('위키 문서의 임무 종류 확인 필요')
            return
    raise Unresolved('위키 임무 문서 형식 확인 필요')


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def row_evidence(row, talks, chinese, korean):
    talk = talks.get(row.get('talkId'))
    if not talk:
        return None
    text_hash = str(talk.get('TalkSentenceText', {}).get('Hash'))
    name_hash = str(talk.get('TextmapTalkSentenceName', {}).get('Hash'))
    cn, kr = chinese.get(text_hash), korean.get(text_hash)
    if not isinstance(cn, str) or not isinstance(kr, str) or _localizations.plain(kr) != _localizations.plain(row['text']):
        return None
    speaker = chinese.get(name_hash, '')
    return {'text': normalized(cn), 'speaker': normalized(speaker), 'chineseHash': digest(normalized(cn)),
            'speakerHash': digest(normalized(speaker)), 'koreanHash': digest(_localizations.plain(kr))}


def compile_segment(segment, index):
    rows, nodes, edges = [], {}, {}

    def resolve(node, kind):
        key = (kind, normalized(node['text']), normalized(node.get('speaker', '')))
        matches = index.get(key, [])
        if len(matches) != 1:
            raise Unresolved('대사 ID 누락 또는 중복 문장')
        row = matches[0]
        if row['id'] in nodes:
            raise Unresolved('같은 대사의 여러 위키 위치')
        nodes[row['id']] = row
        rows.append(row)
        node['rowId'] = row['id']

    def identify(sequence):
        for node in sequence:
            if node['kind'] == 'line':
                resolve(node, 'line')
            elif node['kind'] == 'choice':
                for option in node['options']:
                    resolve(option, 'choice')
                for option in node['options']:
                    identify(option['body'])
            else:
                raise Unresolved('미지원 장면 내용')

    def wire(sequence, following):
        current = following
        for node in reversed(sequence):
            if node['kind'] == 'line':
                edges[node['rowId']] = list(current)
                current = [node['rowId']]
            else:
                choices = [option['rowId'] for option in node['options']]
                for option in node['options']:
                    # An optional question/exit icon does not establish a
                    # continuation or return loop. Keep only its explicit body.
                    tail = current if option['icon'] == '继续' else []
                    edges[option['rowId']] = wire(option['body'], tail)
                current = choices
        return list(current)

    identify(segment)
    wire(segment, [])
    if not rows:
        raise Unresolved('대사 없는 장면')
    # Disagreement with explicit game execution edges is a review item.
    selected = set(nodes)
    for row in rows:
        source_targets = set(row.get('nextIds', [])) & selected
        wiki_targets = set(edges[row['id']])
        if row.get('flowStatus') == 'verified' and source_targets and wiki_targets and source_targets != wiki_targets:
            raise Unresolved('원본 실행 연결과 BWIKI 분기 충돌')
    return rows, edges


def supported_runs(segment, index):
    """Unknown/missing lines are hard boundaries, not permission to bridge a gap."""
    runs, current = [], []
    for node in segment:
        try:
            compile_segment([node], index)
        except Unresolved:
            if current:
                runs.append(current)
                current = []
            runs.append([{'kind': 'unsupported'}])
        else:
            current.append(node)
    if current:
        runs.append(current)
    return runs


BWIKI_FIELDS = ['bwikiStatus', 'bwikiScene', 'bwikiNextIds', 'bwikiReplyToIds', 'bwikiPage', 'bwikiRevision']


def apply_chunks(payload, chunks):
    rows = payload['rows']
    base = payload.get('bwikiBaseOrder', [row['id'] for row in rows])
    rank = {identity: position for position, identity in enumerate(base)}
    if len(rank) != len(base):
        raise ValueError('Duplicate BWIKI base identity')
    rows.sort(key=lambda row: rank.get(row['id'], len(rank)))
    payload['bwikiBaseOrder'] = [row['id'] for row in rows]
    by_id = {row['id']: row for row in rows}
    for row in rows:
        for key in BWIKI_FIELDS:
            row.pop(key, None)
        if row.get('missionId', '').startswith('quest-'):
            row['bwikiStatus'] = 'review'
    counts = Counter(identity for chunk in chunks for identity in chunk['order'])
    accepted = [chunk for chunk in chunks if all(counts[identity] == 1 for identity in chunk['order'])]
    by_mission = defaultdict(list)
    for chunk in accepted:
        order = chunk['order']
        if any(identity not in by_id for identity in order) or any(target not in order for ids in chunk['edges'].values() for target in ids):
            raise ValueError('Invalid BWIKI chunk links')
        group = digest(f"{chunk['page']}:{chunk['revision']}:{chunk['segment']}")[:16]
        reverse = defaultdict(list)
        for identity in order:
            row = by_id[identity]
            row.update(bwikiStatus=chunk['status'], bwikiScene=group, bwikiNextIds=chunk['edges'][identity],
                       bwikiPage=chunk['page'], bwikiRevision=chunk['revision'])
            if row['type'] == 'choice':
                for target in chunk['edges'][identity]:
                    reverse[target].append(identity)
        for target, choices in reverse.items():
            by_id[target]['bwikiReplyToIds'] = choices
        by_mission[chunk['missionId']].extend(order)
    reordered = 0
    for mission, order in by_mission.items():
        selected = set(order)
        slots = [position for position, row in enumerate(rows) if row['id'] in selected]
        if any(by_id[identity]['missionId'] != mission for identity in order):
            raise ValueError('BWIKI mission boundary mismatch')
        reordered += sum(rows[position]['id'] != identity for position, identity in zip(slots, order))
        for position, identity in zip(slots, order):
            rows[position] = by_id[identity]
    payload['bwiki'] = {'matchedRows': sum(row.get('bwikiStatus') == 'matched' for row in rows),
                        'cachedRows': sum(row.get('bwikiStatus') == 'cached' for row in rows),
                        'reviewRows': sum(row.get('bwikiStatus') == 'review' for row in rows),
                        'segments': len(accepted), 'reorderedRows': reordered}
    return accepted


def align(root, raw, plan_path, manifest_path, previous_root=None):
    plan, _, talk_rows, chinese, korean, input_hashes = inputs(raw, plan_path)
    manifest = json.loads(manifest_path.read_bytes())
    if manifest.get('schema') != 'hsr-bwiki-input.v1' or manifest.get('commit') != plan['commit']:
        raise ValueError('Mixed BWIKI and game input versions')
    if json.loads((root / 'public/content-update.json').read_bytes()).get('commit') != plan['commit']:
        raise ValueError('Mixed Korean and BWIKI game input versions')
    talks = {row['TalkSentenceID']: row for row in talk_rows if row}
    previous_file = (previous_root or root) / 'public/bwiki-provenance.json'
    previous = json.loads(previous_file.read_bytes()) if previous_file.exists() else {}
    if previous and previous.get('schema') != 'hsr-bwiki-audit.v1':
        raise ValueError('Invalid previous BWIKI evidence')
    source_records = dict(previous.get('sources', {}))
    for page in previous.get('pages', []) + manifest['pages']:
        if page['status'] != 'available':
            continue
        title, revision = page['pageTitle'], page['revision']
        source_records[f'{title}@{revision}'] = {
            'page': title, 'revision': revision, 'timestamp': page.get('timestamp'), 'sha256': page['sha256'],
            'sourceUrl': 'https://wiki.biligame.com/sr/' + quote(title) + '?oldid=' + str(revision),
            'historyUrl': 'https://wiki.biligame.com/sr/' + quote(title) + '?action=history',
        }
    pages, text = {}, {}
    for page in manifest['pages']:
        pages['quest-' + str(page['missionId'])] = page
        if page['status'] == 'available':
            data = Path(page['file']).read_bytes()
            if digest(data.decode('utf-8')) != page['sha256']:
                raise ValueError('Unverified BWIKI page input')
            text[page['missionId']] = data.decode('utf-8')
    chapters, review, publications, totals, changed_rows, orders = {}, list(manifest['review']), [], Counter(), {}, []
    for spec in specs(root):
        file = 'public/' + spec['file']
        payload = json.loads((root / file).read_bytes())
        owned = defaultdict(list)
        for row in payload['rows']:
            if row.get('missionId', '').startswith('quest-'):
                owned[row['missionId']].append(row)
        if not owned:
            continue
        before = {row['id']: dict(row) for row in payload['rows']}
        chunks = []
        for mission, rows in owned.items():
            page = pages.get(mission)
            evidence = {row['id']: row_evidence(row, talks, chinese, korean) for row in rows}
            index = defaultdict(list)
            for row in rows:
                item = evidence[row['id']]
                if item:
                    index[('choice' if row['type'] == 'choice' else 'line', item['text'], '' if row['type'] == 'choice' else item['speaker'])].append(row)
            if not page or page['status'] != 'available':
                review.append({'file': spec['file'], 'missionId': mission, 'reason': page.get('reason', '위키 임무명 연결 확인 필요') if page else '위키 임무명 연결 확인 필요'})
                # Keep the last derived mapping only when every exact ID, official
                # Chinese/Korean string and uniqueness constraint still validates.
                for old in previous.get('chapters', {}).get(spec['file'], []):
                    if old['missionId'] != mission:
                        continue
                    if f"{old['page']}@{old['revision']}" not in source_records:
                        continue
                    valid = True
                    for identity in old['order']:
                        item = evidence.get(identity)
                        expected = old['evidence'].get(identity)
                        row = before.get(identity)
                        key = ('choice' if row and row['type'] == 'choice' else 'line', item['text'] if item else '',
                               '' if row and row['type'] == 'choice' else item['speaker'] if item else '')
                        if not item or not expected or row.get('talkId') != expected.get('talkId') or row['type'] != expected.get('type') or any(item[key] != expected[key] for key in ['chineseHash', 'speakerHash', 'koreanHash']) or len(index[key]) != 1:
                            valid = False
                            break
                        source_targets = set(row.get('nextIds', [])) & set(old['order'])
                        wiki_targets = set(old['edges'].get(identity, []))
                        if row.get('flowStatus') == 'verified' and source_targets and wiki_targets and source_targets != wiki_targets:
                            valid = False
                            break
                    if valid:
                        chunks.append({**old, 'status': 'cached'})
                continue
            try:
                validate_mission_page(text[page['missionId']], page.get('title', page['pageTitle']))
                segments = story_segments(text[page['missionId']])
            except Unresolved as error:
                review.append({'file': spec['file'], 'missionId': mission, 'reason': str(error)})
                continue
            for position, segment in enumerate(segments):
                if segment[0]['kind'] == 'barrier':
                    continue
                for subposition, run in enumerate(supported_runs(segment, index)):
                    identity = f'{position}.{subposition}'
                    try:
                        matched, edges = compile_segment(run, index)
                        chunks.append({'missionId': mission, 'page': page['pageTitle'], 'revision': page['revision'],
                                       'segment': identity, 'status': 'matched', 'order': [row['id'] for row in matched],
                                       'edges': edges, 'evidence': {row['id']: {'talkId': row['talkId'], 'type': row['type'], **{key: evidence[row['id']][key] for key in ['chineseHash', 'speakerHash', 'koreanHash']}} for row in matched}})
                    except Unresolved as error:
                        review.append({'file': spec['file'], 'missionId': mission, 'segment': identity, 'reason': str(error)})
        occurrences = Counter(identity for chunk in chunks for identity in chunk['order'])
        for chunk in chunks:
            if any(occurrences[identity] > 1 for identity in chunk['order']):
                review.append({'file': spec['file'], 'missionId': chunk['missionId'], 'segment': chunk['segment'], 'reason': '같은 대사의 여러 위키 위치'})
        accepted = apply_chunks(payload, chunks)
        if len(payload['rows']) != len(before) or set(before) != {row['id'] for row in payload['rows']}:
            raise ValueError('BWIKI alignment changed existing row identities')
        for row in payload['rows']:
            for key in ['text', 'speaker', 'type', 'mission', 'missionId', 'talkId', 'source', 'scene']:
                if row.get(key) != before[row['id']].get(key):
                    raise ValueError('BWIKI alignment changed Korean source text or ownership')
        chapters[spec['file']] = accepted
        totals.update(payload['bwiki'])
        changed_rows.update((row['id'], row) for row in payload['rows'])
        orders.append([row['id'] for row in payload['rows']])
        write(root / file, payload)
        publications.append(file)
    search_file = root / 'public/content/search-index.json'
    search = json.loads(search_file.read_bytes())
    for row in search['rows']:
        if row['id'] in changed_rows:
            source = changed_rows[row['id']]
            for key in BWIKI_FIELDS:
                row.pop(key, None)
                if key in source:
                    row[key] = source[key]
    positions = {row['id']: position for position, row in enumerate(search['rows'])}
    by_id = {row['id']: row for row in search['rows']}
    for order in orders:
        slots = sorted(positions[identity] for identity in order)
        for position, identity in zip(slots, order):
            search['rows'][position] = by_id[identity]
    write(search_file, search)
    publications.append('public/content/search-index.json')
    used_sources = {f"{chunk['page']}@{chunk['revision']}" for chunks in chapters.values() for chunk in chunks}
    report = {'schema': 'hsr-bwiki-audit.v1', 'commit': plan['commit'], 'checkedAt': manifest['checkedAt'],
              'license': manifest['license'], 'modifications': 'BWIKI scene and branch structure aligned to official dialogue IDs; Korean text unchanged.',
              'inputs': input_hashes, 'totals': dict(totals), 'chapters': chapters, 'review': review,
              'sources': {key: source_records[key] for key in sorted(used_sources)},
              'pages': [{**{key: value for key, value in page.items() if key != 'file'},
                         **({'sourceUrl': 'https://wiki.biligame.com/sr/' + quote(page['pageTitle']) + '?oldid=' + str(page['revision']),
                             'historyUrl': 'https://wiki.biligame.com/sr/' + quote(page['pageTitle']) + '?action=history'} if page['status'] == 'available' else {})}
                        for page in manifest['pages']]}
    write(root / 'public/bwiki-provenance.json', report)
    publications.append('public/bwiki-provenance.json')
    receipt_path = root / 'receipt.json'
    receipt = json.loads(receipt_path.read_bytes()) if receipt_path.exists() else {'files': [], 'rows': len(search['rows'])}
    receipt['files'] = sorted(set(receipt['files'] + publications))
    write(receipt_path, receipt)
    print(json.dumps(dict(totals)))


if __name__ == '__main__':
    if '--discover' in sys.argv:
        discover(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        align(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]),
              Path(sys.argv[5]) if len(sys.argv) > 5 else None)
