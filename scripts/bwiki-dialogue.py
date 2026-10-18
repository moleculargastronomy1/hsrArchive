"""Align BWIKI structure with exact, same-release Chinese/Korean dialogue IDs."""
import hashlib
import html
import json
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote

from importlib.util import module_from_spec, spec_from_file_location

_spec = spec_from_file_location('localizations', Path(__file__).with_name('import-localizations.py'))
_localizations = module_from_spec(_spec)
_spec.loader.exec_module(_localizations)


def write(path, value, pretty=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2 if pretty else None,
                                    separators=None if pretty else (',', ':')) + ('\n' if pretty else ''), encoding='utf-8')
    for attempt in range(5):
        try:
            temporary.replace(path)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.2 * (attempt + 1))


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
    plan, missions, _, chinese, korean, _ = inputs(raw, plan_path)
    used, priority = set(), set()
    trailblaze_path = root / 'src/data/trailblaze.json'
    story_files = {chapter['content']['file'] for entry in json.loads(trailblaze_path.read_bytes())
                   for chapter in entry['chapters'] if chapter.get('content')} if trailblaze_path.exists() else set()
    official_chapters = {chapter['upstreamChapterId'] for entry in json.loads(trailblaze_path.read_bytes())
                         for chapter in entry['chapters'] if chapter.get('upstreamChapterId') and chapter.get('content')} if trailblaze_path.exists() else set()
    used.update(row['MainMissionID'] for row in missions if row.get('Type') == 'Main' and row.get('ChapterID') in official_chapters)
    for spec in specs(root):
        payload = json.loads((root / 'public' / spec['file']).read_bytes())
        identities = {int(row['missionId'][6:]) for row in payload['rows'] if re.fullmatch(r'quest-\d+', row.get('missionId', ''))}
        used.update(identities)
        if spec['file'] in story_files and not any(row.get('bwikiStatus') in ['matched', 'cached'] for row in payload['rows']):
            priority.update(identities)
    requests, missing = mission_requests(missions, chinese, korean, used)
    requests.sort(key=lambda item: (not bool(set(item.get('missionIds', [item['missionId']])) & priority), item['title']))
    write(root / '.cache/bwiki/request.json', {'schema': 'hsr-bwiki-request.v1', 'commit': plan['commit'],
                                               'requests': requests, 'review': missing})
    print(json.dumps({'missions': len(used), 'requests': len(requests), 'review': len(missing)}))


def mission_requests(missions, chinese, korean, used):
    titles = defaultdict(list)
    missing = []
    for mission in missions:
        identity = mission.get('MainMissionID')
        title = chinese.get(str(mission.get('Name', {}).get('Hash')), '').strip()
        if title:
            titles[title].append(mission)
        elif identity in used:
            missing.append({'missionId': identity, 'reason': '공식 중국어 임무명 없음'})
    requests = []
    for title, members in sorted(titles.items()):
        identities = sorted({item['MainMissionID'] for item in members})
        if not set(identities) & used:
            continue
        chapters = {item.get('ChapterID') for item in members}
        names = {_localizations.plain(korean.get(str(item.get('Name', {}).get('Hash')), '')) for item in members}
        grouped = len(identities) > 1 and len(chapters) == 1 and next(iter(chapters)) not in [None, 0] and len(names) == 1 and '' not in names and all(item.get('Type') == 'Main' for item in members)
        if len(identities) == 1 or grouped:
            request = {'title': title, 'missionId': identities[0]}
            if grouped:
                request.update(missionIds=identities, officialChapterId=next(iter(chapters)))
            requests.append(request)
        else:
            missing.extend({'missionId': identity, 'reason': '같은 중국어 제목의 여러 임무 · 챕터/공식 명칭 연결 모호'}
                           for identity in identities if identity in used)
    return requests, missing


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


def canonical(value):
    value = _localizations.plain(html.unescape(value), 'zh-CN')
    value = re.sub(r'<br\s*/?>', ' ', value, flags=re.I)
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value))


def normalized(value):
    # Compare displayed base text. Keep full official strings in evidence hashes.
    value = re.sub(r'\{RUBY_B#(?:[^{}]|\{[^{}]*\})*\}([\s\S]*?)\{RUBY_E#\}',
                   lambda match: match[1], value)
    value = canonical(value).replace('[开拓者]', '开拓者')
    # A period immediately before an em-dash is an editorial separator in BWIKI.
    # Words, numbers, unresolved substitutions and other punctuation stay intact.
    return re.sub(r'。(?=——)', '', value)


def comparable(value):
    value = normalized(value)
    presentation = set('。.,，!?！？;；:：“”‘’「」『』（）()[]【】…—')
    return ''.join(char for index, char in enumerate(value)
                   if char not in presentation or
                   (char in '.,，' and index > 0 and index + 1 < len(value) and
                    value[index - 1].isdigit() and value[index + 1].isdigit()))


def parse_body(value, fragmented=False):
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
            parsed = parse_body(body, fragmented)
            if len(parsed) > 1:
                if not fragmented:
                    raise Unresolved('응답 안의 독립 장면 확인 필요')
                parsed = [[{'kind': 'separated', 'segments': parsed}]]
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
        structural = ['剧情选项', '折叠', '事件'] + (['#tag:tabber'] if fragmented else [])
        if is_template and name not in structural:
            buffer += '{{' + data + '}}'
            continue
        if not is_template:
            buffer += data
            continue
        consume(buffer)
        buffer = ''
        if name == '#tag:tabber':
            flush()
            args = template_parts(data)[1:]
            if len(args) != 1:
                segments.append([{'kind': 'unsupported'}])
                continue
            tabs = split_tabs(args[0])
            for tab in tabs:
                label, separator, body = tab.partition('=')
                if not separator or not label.strip():
                    segments.append([{'kind': 'unsupported'}])
                else:
                    segments.extend(parse_body(body, fragmented))
            flush()
        elif name == '事件':
            try:
                args = template_parts(data)[1:]
                if len(args) == 3 and args[0] == '星神':
                    args = args[1:]
                if len(args) != 2 or any(re.match(r'\w+\s*=', arg) for arg in args):
                    raise Unresolved('미지원 사건 대사 형식')
                current.append({'kind': 'line', 'speaker': inline(args[0]), 'text': inline(args[1])})
            except Unresolved:
                flush()
                segments.append([{'kind': 'unsupported'}])
        elif name == '剧情选项':
            try:
                current.append(choice(data))
            except Unresolved:
                flush()
                segments.append([{'kind': 'unsupported'}])
        else:
            flush()
            _, fields = template(data)
            if fields.get('标题') not in ['前情提要', '剧情梗概']:
                segments.extend(parse_body(fields.get('内容', ''), fragmented))
            flush()
    consume(buffer)
    flush()
    return segments

def split_tabs(value):
    parts, start, position, depth = [], 0, 0, 0
    while position < len(value):
        delimiter = next((item for item in ['{{!}}-{{!}}', '|-|'] if value.startswith(item, position)), None)
        if depth == 0 and delimiter:
            parts.append(value[start:position])
            position += len(delimiter)
            start = position
        elif value.startswith('{{', position):
            depth += 1
            position += 2
        elif value.startswith('}}', position):
            depth -= 1
            position += 2
        else:
            position += 1
    parts.append(value[start:])
    return parts


def story_segments(content, fragmented=False):
    match = re.search(r'^==\s*(?:剧情内容|任务剧情)\s*==\s*$', content, flags=re.M)
    if not match:
        raise Unresolved('지원하는 임무 대사 구역 없음')
    body = content[match.end():]
    stop = re.search(r'^==[^=].*?==\s*$', body, flags=re.M)
    return parse_body(body[:stop.start()] if stop else body, fragmented)


def validate_mission_page(content, title):
    content = re.sub(r'<!--.*?-->', '', content, flags=re.S)
    for is_template, value in templates(content):
        if is_template and template_parts(value)[0] == '任务':
            _, fields = template(value)
            if normalized(inline(fields.get('任务名称', ''))) != normalized(title):
                raise Unresolved('위키 문서의 공식 임무명 불일치')
            if fields.get('任务类型') not in ['开拓任务', '开拓续闻', '终末任务', '同行任务', '冒险任务', '日常任务', '活动任务', '命路群像']:
                raise Unresolved('위키 문서의 임무 종류 확인 필요')
            return fields
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
    return {'text': comparable(cn), 'speaker': normalized(speaker), 'chineseHash': digest(canonical(cn)),
            'speakerHash': digest(canonical(speaker)), 'koreanHash': digest(_localizations.plain(kr))}


def compile_segment(segment, index):
    rows, nodes, edges = [], {}, {}

    def resolve(node, kind):
        key = (kind, comparable(node['text']), normalized(node.get('speaker', '')))
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
            # Conditional scenes and responses have independent boundaries.
            if node['kind'] == 'separated':
                for part in node['segments']:
                    runs.extend(supported_runs(part, index))
            elif node['kind'] == 'choice':
                for option in node['options']:
                    runs.extend(supported_runs(option['body'], index))
        else:
            current.append(node)
    if current:
        runs.append(current)
    return runs


BWIKI_FIELDS = ['bwikiStatus', 'bwikiScene', 'bwikiNextIds', 'bwikiReplyToIds', 'bwikiPage', 'bwikiRevision', 'bwikiMissionId', 'bwikiMission']


def matching_index(rows, evidence, chapter_index):
    index = defaultdict(list)
    for row in rows:
        item = evidence[row['id']]
        if item:
            key = ('choice' if row['type'] == 'choice' else 'line', item['text'], '' if row['type'] == 'choice' else item['speaker'])
            index[key].append(row)
    # Some old scene exports assign a cutscene to the wrong quest within its chapter.
    # A missing local match may use one exact chapter-wide ID, never a guessed ID.
    for key, candidates in chapter_index.items():
        if key not in index and len(candidates) == 1:
            index[key] = candidates
    return index


def mission_structure(fields, title_ids):
    def linked(key):
        match = re.fullmatch(r'\s*\*?\s*\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]\s*', fields.get(key, ''))
        candidates = title_ids.get(normalized(match[1]), []) if match else []
        return candidates[0] if len(candidates) == 1 else None

    number = fields.get('任务编号', '').strip()
    try:
        series = inline(fields.get('系列任务', ''))
    except Unresolved:
        series = ''
    return {'previous': linked('前置任务'), 'next': linked('后续任务'), 'series': series,
            'number': int(number) if re.fullmatch(r'\d+', number) else None}


def mission_order(missions, structures):
    edges = {mission: set() for mission in missions}
    series = defaultdict(list)
    for mission, item in structures.items():
        if mission not in edges:
            continue
        if item.get('previous') in edges:
            edges[item['previous']].add(mission)
        if item.get('next') in edges:
            edges[mission].add(item['next'])
        if item.get('series') and isinstance(item.get('number'), int):
            series[item['series']].append((item['number'], mission))
    for group in series.values():
        if len({number for number, _ in group}) != len(group):
            continue
        ordered = sorted(group)
        for (_, first), (_, second) in zip(ordered, ordered[1:]):
            edges[first].add(second)
    result = []
    pending = set(missions)
    while pending:
        ready = [mission for mission in missions if mission in pending and
                 not any(mission in edges[other] for other in pending)]
        if not ready:
            # Conflicting wiki prerequisites never become an invented sequence.
            return list(missions), False
        mission = ready[0]
        result.append(mission)
        pending.remove(mission)
    return result, True


def apply_chunks(payload, chunks, mission_sequence=None):
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
                       bwikiPage=chunk['page'], bwikiRevision=chunk['revision'], bwikiMissionId=chunk['missionId'],
                       bwikiMission=chunk.get('mission', row['mission']))
            if row['type'] == 'choice':
                for target in chunk['edges'][identity]:
                    reverse[target].append(identity)
        for target, choices in reverse.items():
            by_id[target]['bwikiReplyToIds'] = choices
        by_mission[chunk['missionId']].extend(order)
    reordered = 0
    ordered_ids = []
    for mission in mission_sequence or by_mission:
        order = by_mission.get(mission, [])
        if any(by_id[identity]['bwikiMissionId'] != mission for identity in order):
            raise ValueError('BWIKI mission boundary mismatch')
        ordered_ids.extend(order)
    selected = set(ordered_ids)
    slots = [position for position, row in enumerate(rows) if row['id'] in selected]
    reordered = sum(rows[position]['id'] != identity for position, identity in zip(slots, ordered_ids))
    for position, identity in zip(slots, ordered_ids):
        rows[position] = by_id[identity]
    payload['bwiki'] = {'matchedRows': sum(row.get('bwikiStatus') == 'matched' for row in rows),
                        'cachedRows': sum(row.get('bwikiStatus') == 'cached' for row in rows),
                        'reviewRows': sum(row.get('bwikiStatus') == 'review' for row in rows),
                        'segments': len(accepted), 'reorderedRows': reordered}
    return accepted


def cached_chunk_valid(old, before, evidence, index, sources):
    if f"{old['page']}@{old['revision']}" not in sources:
        return False
    for identity in old['order']:
        item, expected, row = evidence.get(identity), old['evidence'].get(identity), before.get(identity)
        if not item or not expected or not row:
            return False
        key = ('choice' if row['type'] == 'choice' else 'line', item['text'], '' if row['type'] == 'choice' else item['speaker'])
        if row.get('talkId') != expected.get('talkId') or row['type'] != expected.get('type') or any(item[key] != expected[key] for key in ['chineseHash', 'speakerHash', 'koreanHash']) or len(index[key]) != 1 or index[key][0]['id'] != identity:
            return False
        source_targets = set(row.get('nextIds', [])) & set(old['order'])
        wiki_targets = set(old['edges'].get(identity, []))
        if row.get('flowStatus') == 'verified' and source_targets and wiki_targets and source_targets != wiki_targets:
            return False
    return True


def align(root, raw, plan_path, manifest_path, previous_root=None):
    plan, mission_rows, talk_rows, chinese, korean, input_hashes = inputs(raw, plan_path)
    mission_names = {'quest-' + str(row['MainMissionID']): _localizations.plain(korean.get(str(row.get('Name', {}).get('Hash')), ''))
                     for row in mission_rows if row}
    title_ids = defaultdict(list)
    for row in mission_rows:
        if row:
            title = chinese.get(str(row.get('Name', {}).get('Hash')), '')
            if title:
                title_ids[normalized(title)].append('quest-' + str(row['MainMissionID']))
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
            'page': title, 'revision': revision, 'timestamp': page.get('timestamp'), 'collectedAt': page.get('collectedAt') or source_records.get(f'{title}@{revision}', {}).get('collectedAt'), 'sha256': page['sha256'],
            'sourceUrl': 'https://wiki.biligame.com/sr/' + quote(title) + '?oldid=' + str(revision),
            'historyUrl': 'https://wiki.biligame.com/sr/' + quote(title) + '?action=history',
        }
    pages, text = {}, {}
    for page in manifest['pages']:
        for identity in page.get('missionIds', [page['missionId']]):
            pages['quest-' + str(identity)] = page
        if page['status'] == 'available':
            data = Path(page['file']).read_bytes()
            if digest(data.decode('utf-8')) != page['sha256']:
                raise ValueError('Unverified BWIKI page input')
            text[page['missionId']] = data.decode('utf-8')
    # Shared titles belong to a verified official chapter, not one arbitrarily
    # selected subquest. Keep original row ownership and group the wiki document.
    routes, group_members = {}, {}
    wanted = {identity for page in manifest['pages'] for identity in page.get('missionIds', [])}
    verified_groups = {tuple(item.get('missionIds', [])) for item in mission_requests(mission_rows, chinese, korean, wanted)[0] if item.get('missionIds')}
    for page in manifest['pages']:
        members = sorted(page.get('missionIds', []))
        if len(members) <= 1:
            continue
        if tuple(members) not in verified_groups:
            raise ValueError('Unverified official BWIKI mission group')
        group = 'bwiki-page-' + str(page['pageId']) if page.get('status') == 'available' and isinstance(page.get('pageId'), int) else None
        if not group:
            cached = {chunk['missionId'] for chunks in previous.get('chapters', {}).values() for chunk in chunks
                      if chunk.get('officialMissionIds') == members}
            group = next(iter(cached)) if len(cached) == 1 else None
        if group:
            pages[group] = page
            group_members[group] = members
            mission_names[group] = mission_names['quest-' + str(members[0])]
            routes.update(('quest-' + str(identity), group) for identity in members)
    title_ids = {title: list(dict.fromkeys(routes.get(identity, identity) for identity in identities))
                 for title, identities in title_ids.items()}
    # A newly reachable document may reveal that an older single-quest proof
    # belongs to an officially shared title. Migrate only its derived grouping;
    # IDs, original ownership, source revision and evidence hashes stay intact.
    for values in previous.get('chapters', {}).values():
        for old in values:
            group = routes.get(old['missionId'])
            if group:
                old.update(missionId=group, officialMissionIds=group_members[group], mission=mission_names[group])
                if old.get('missionStructure'):
                    old['missionStructure'] = {key: routes.get(value, value) if isinstance(value, str) else value for key, value in old['missionStructure'].items()}
    targets = set(manifest['targetFiles']) if 'targetFiles' in manifest else None
    chapters = {file: chunks for file, chunks in previous.get('chapters', {}).items() if targets is not None and file not in targets}
    review = [item for item in previous.get('review', []) if targets is not None and item.get('file') and item['file'] not in targets] + list(manifest['review'])
    publications, totals, changed_rows, orders = [], Counter(), {}, []
    mission_sequences = {file: value for file, value in previous.get('missionOrder', {}).items() if targets is not None and file not in targets}
    chapter_owners = {chapter['content']['file']: chapter['upstreamChapterId']
                      for entry in json.loads((root / 'src/data/trailblaze.json').read_bytes())
                      for chapter in entry['chapters'] if chapter.get('content') and chapter.get('upstreamChapterId')} if (root / 'src/data/trailblaze.json').exists() else {}
    for spec in specs(root):
        file = 'public/' + spec['file']
        payload = json.loads((root / file).read_bytes())
        if targets is not None and spec['file'] not in targets:
            totals.update(payload.get('bwiki', {}))
            continue
        owned = defaultdict(list)
        base_rank = {identity: position for position, identity in enumerate(payload.get('bwikiBaseOrder', []))}
        source_rows = sorted(payload['rows'], key=lambda row: base_rank.get(row['id'], len(base_rank)))
        for row in source_rows:
            if row.get('missionId', '').startswith('quest-'):
                owned[routes.get(row['missionId'], row['missionId'])].append(row)
        # Explore official subquests missing from the old scene export. Matching
        # still requires one unique existing row in this same official chapter.
        if spec['file'] in chapter_owners:
            for mission in mission_rows:
                if mission.get('Type') == 'Main' and mission.get('ChapterID') == chapter_owners[spec['file']]:
                    identity = 'quest-' + str(mission['MainMissionID'])
                    owned.setdefault(routes.get(identity, identity), [])
        if not owned:
            continue
        before = {row['id']: dict(row) for row in payload['rows']}
        evidence = {row['id']: row_evidence(row, talks, chinese, korean) for row in payload['rows']}
        chapter_index = defaultdict(list)
        for row in payload['rows']:
            item = evidence[row['id']]
            if item:
                chapter_index[('choice' if row['type'] == 'choice' else 'line', item['text'], '' if row['type'] == 'choice' else item['speaker'])].append(row)
        chunks, structures = [], {}
        for mission, rows in owned.items():
            page = pages.get(mission)
            index = matching_index(rows, evidence, chapter_index)
            if not page or page['status'] != 'available':
                review.append({'file': spec['file'], 'missionId': mission, 'reason': page.get('reason', '위키 임무명 연결 확인 필요') if page else '위키 임무명 연결 확인 필요'})
                # Keep the last derived mapping only when every exact ID, official
                # Chinese/Korean string and uniqueness constraint still validates.
                for old in previous.get('chapters', {}).get(spec['file'], []):
                    if old['missionId'] != mission:
                        continue
                    if cached_chunk_valid(old, before, evidence, index, source_records):
                        chunks.append({**old, 'status': 'cached', 'mission': mission_names.get(mission) or (rows[0]['mission'] if rows else '임무 기록')})
                        if old.get('missionStructure'):
                            structures[mission] = old['missionStructure']
                continue
            try:
                fields = validate_mission_page(text[page['missionId']], page.get('title', page['pageTitle']))
                structures[mission] = mission_structure(fields, title_ids)
                segments = story_segments(text[page['missionId']], True)
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
                        chunks.append({'missionId': mission, 'mission': mission_names.get(mission) or (rows[0]['mission'] if rows else '임무 기록'), 'page': page['pageTitle'], 'revision': page['revision'],
                                       **({'officialMissionIds': group_members[mission]} if mission in group_members else {}),
                                       'segment': identity, 'status': 'cached' if page.get('retrieval') == 'cache-pinned' else 'matched', 'missionStructure': structures[mission], 'order': [row['id'] for row in matched],
                                       'edges': edges, 'evidence': {row['id']: {'talkId': row['talkId'], 'type': row['type'], **{key: evidence[row['id']][key] for key in ['chineseHash', 'speakerHash', 'koreanHash']}} for row in matched}})
                    except Unresolved as error:
                        review.append({'file': spec['file'], 'missionId': mission, 'segment': identity, 'reason': str(error)})
        # An incomplete new collection/parser must not erase prior evidence.
        for old in previous.get('chapters', {}).get(spec['file'], []):
            mission = old['missionId']
            if mission not in owned or any(chunk['order'] == old['order'] and chunk['edges'] == old['edges'] for chunk in chunks):
                continue
            index = matching_index(owned[mission], evidence, chapter_index)
            if not cached_chunk_valid(old, before, evidence, index, source_records):
                continue
            old_ids = set(old['order'])
            coverage = {identity for chunk in chunks for identity in chunk['order']}
            if old_ids <= coverage:
                continue
            chunks = [chunk for chunk in chunks if not old_ids.intersection(chunk['order'])]
            chunks.append({**old, 'status': 'cached'})
            if old.get('missionStructure'):
                structures.setdefault(mission, old['missionStructure'])
        for old in previous.get('chapters', {}).get(spec['file'], []):
            counts = Counter(identity for chunk in chunks for identity in chunk['order'])
            if not any(counts[identity] > 1 for identity in old['order']) or old['missionId'] not in owned:
                continue
            index = matching_index(owned[old['missionId']], evidence, chapter_index)
            if not cached_chunk_valid(old, before, evidence, index, source_records):
                continue
            protected = set(old['order'])
            chunks = [chunk for chunk in chunks if not protected.intersection(chunk['order'])]
            chunks.append({**old, 'status': 'cached'})
            review.append({'file': spec['file'], 'missionId': old['missionId'], 'reason': '새 대조의 중복 위치 · 공식 원문 재검증한 이전 연결 유지'})
        counts = Counter(identity for chunk in chunks for identity in chunk['order'])
        for chunk in chunks:
            if any(counts[identity] > 1 for identity in chunk['order']):
                review.append({'file': spec['file'], 'missionId': chunk['missionId'], 'segment': chunk['segment'], 'reason': '같은 대사의 여러 위키 위치 · 새 구간 보류'})
        chunks = [chunk for chunk in chunks if all(counts[identity] == 1 for identity in chunk['order'])]
        # Removing an overlapping new run can uncover another old chunk whose
        # IDs were contained in that run. Reach a fixed point; old chunks have
        # disjoint IDs, so retaining one cannot invalidate another old chunk.
        old_chunks = previous.get('chapters', {}).get(spec['file'], [])
        for _ in range(len(old_chunks) + 1):
            restored = False
            coverage = {identity for chunk in chunks for identity in chunk['order']}
            for old in old_chunks:
                if set(old['order']) <= coverage or old['missionId'] not in owned:
                    continue
                index = matching_index(owned[old['missionId']], evidence, chapter_index)
                if not cached_chunk_valid(old, before, evidence, index, source_records):
                    continue
                protected = set(old['order'])
                chunks = [chunk for chunk in chunks if not protected.intersection(chunk['order'])]
                chunks.append({**old, 'status': 'cached'})
                coverage = {identity for chunk in chunks for identity in chunk['order']}
                restored = True
            if not restored:
                break
        occurrences = Counter(identity for chunk in chunks for identity in chunk['order'])
        for chunk in chunks:
            if any(occurrences[identity] > 1 for identity in chunk['order']):
                review.append({'file': spec['file'], 'missionId': chunk['missionId'], 'segment': chunk['segment'], 'reason': '같은 대사의 여러 위키 위치'})
        sequence, acyclic = mission_order(list(owned), structures)
        if not acyclic:
            review.append({'file': spec['file'], 'reason': 'BWIKI 임무 선후 관계 충돌 · 기존 임무 순서 유지'})
        mission_sequences[spec['file']] = sequence
        accepted = apply_chunks(payload, chunks, sequence)
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
    mission_catalog = {}
    catalog_file = root / 'src/data/trailblaze.json'
    if catalog_file.exists():
        for entry in json.loads(catalog_file.read_bytes()):
            for chapter in entry['chapters']:
                if chapter.get('upstreamChapterId') and chapter.get('content'):
                    mission_catalog[chapter['content']['file']] = [
                        {'id': row['MainMissionID'], 'title': mission_names['quest-' + str(row['MainMissionID'])], 'chapterId': row['ChapterID']}
                        for row in mission_rows if row.get('ChapterID') == chapter['upstreamChapterId'] and row.get('Type') == 'Main' and mission_names.get('quest-' + str(row['MainMissionID']))]
    report = {'schema': 'hsr-bwiki-audit.v1', 'commit': plan['commit'], 'checkedAt': manifest['checkedAt'],
              'license': manifest['license'], 'modifications': 'BWIKI scene and branch structure aligned to official dialogue IDs; Korean text unchanged.',
              'matchingPolicy': {'version': 2, 'normalization': ['display markup', 'ruby base text', 'default protagonist name', 'editorial punctuation (numeric separators preserved)', 'Unicode typography', 'whitespace'],
                                 'evidence': 'Full official Chinese strings, speakers and Korean strings remain hashed; ambiguous IDs are excluded.'},
              'inputs': input_hashes, 'totals': dict(totals), 'chapters': chapters, 'missionCatalog': mission_catalog, 'missionOrder': mission_sequences, 'review': review,
              'sources': {key: source_records[key] for key in sorted(used_sources)}, 'imports': previous.get('imports', {}),
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
