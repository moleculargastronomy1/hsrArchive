"""Restore only complete, acyclic, explicitly connected local dialogue scenes."""
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


def write_json(path, value, pretty=False):
    temporary = path.with_suffix(path.suffix + '.tmp')
    data = json.dumps(value, ensure_ascii=False, indent=2 if pretty else None,
                      separators=None if pretty else (',', ':'))
    temporary.write_text(data + ('\n' if pretty else ''), encoding='utf-8')
    temporary.replace(path)


class Unresolved(ValueError):
    pass


PRESENTATION_TASKS = {
    'LevelPerformanceInitialize', 'PerformanceTransition', 'LevelPerformanceFinalize',
    'WaitPerformanceEnd', 'FinishLevelGraph', 'SwitchCharacterAnchor', 'SwitchCharacterAnchorV2',
    'ActiveVirtualCamera', 'ActiveTemplateVirtualCamera', 'AdvNpcFaceToPlayer', 'AdvEntityFaceTo',
    'TriggerSound', 'PlayScreenTransfer', 'PlayFullScreenTransfer', 'DestroyNPC', 'WaitSecond',
    'CharacterHeadLookAt', 'CharacterTriggerFreeStyle', 'CharacterTriggerAnimState',
    'CaptureNPCToCharacter', 'CaptureLocalPlayer', 'ReleaseCharacter', 'SetAudioEmotionState',
    'TransitEnvProfileForStory', 'ClearDialogCamera', 'SetTargetEntityFadeWithAnim',
    'ForceSetDialogCamera', 'CreatePhoneOnCharacter', 'CharacterNavigateTo',
    'TriggerPermanentEmotion', 'StopPermanentEmotion', 'AdvEntityStopLookAt',
}


def string(value):
    return value.get('Value') if isinstance(value, dict) else value


def contains_talk(value):
    if isinstance(value, dict):
        return 'TalkSentenceID' in value or any(contains_talk(child) for child in value.values())
    return isinstance(value, list) and any(contains_talk(child) for child in value)


def scene_graph(document):
    """Match real WaitCustomString listeners, never digits embedded in a marker."""
    sequences = document.get('OnStartSequece')
    if not isinstance(sequences, list) or not sequences:
        raise Unresolved('지원하는 시작 시퀀스 없음')
    if document.get('OnInitSequece'):
        raise Unresolved('초기화 실행 연결 확인 필요')
    nodes, listeners, starts, tails, triggers, options = {}, {}, [], [], [], {}
    for sequence in sequences:
        if set(sequence) != {'TaskList'} or not isinstance(sequence['TaskList'], list):
            raise Unresolved('조건부 시퀀스 확인 필요')
        tokens, wait, trigger, ended = [], None, None, False
        for task in sequence['TaskList']:
            if 'TaskEnabled' in task and task['TaskEnabled'] is not True:
                raise Unresolved('비활성 작업의 실행 조건 확인 필요')
            kind = task.get('$type', '').split('.')[-1]
            if kind == 'WaitCustomString':
                if set(task) - {'$type', 'CustomString', 'TaskEnabled'}:
                    raise Unresolved('대기 실행 조건 확인 필요')
                if tokens or wait is not None:
                    raise Unresolved('중간 대기 조건 확인 필요')
                wait = string(task.get('CustomString'))
                if not isinstance(wait, str) or not wait:
                    raise Unresolved('대기 조건 없음')
            elif kind == 'TriggerCustomString':
                if set(task) - {'$type', 'CustomString', 'TaskEnabled'}:
                    raise Unresolved('신호 실행 조건 확인 필요')
                if trigger is not None:
                    raise Unresolved('여러 실행 대상 확인 필요')
                trigger = string(task.get('CustomString'))
                if not isinstance(trigger, str) or not trigger:
                    raise Unresolved('실행 신호 없음')
            elif kind in ['PlayAndWaitSimpleTalk', 'PlayOptionTalk']:
                allowed_task = {'$type', 'TaskEnabled', 'OptionList' if kind == 'PlayOptionTalk' else 'SimpleTalkList'}
                if set(task) - allowed_task:
                    raise Unresolved('대화 작업의 실행 조건 확인 필요')
                if ended or trigger is not None or (tokens and isinstance(tokens[-1], list)):
                    raise Unresolved('선택지 이후 실행 구조 확인 필요')
                choice = kind == 'PlayOptionTalk'
                records = task.get('OptionList' if choice else 'SimpleTalkList')
                if not isinstance(records, list) or not records:
                    raise Unresolved('대사 목록 없음')
                ids = []
                for record in records:
                    identity = record.get('TalkSentenceID')
                    allowed = {'$type', 'TalkSentenceID', 'ProtectTime', 'TextSpeed', 'TalkBgID', 'OptionIconType', 'TriggerCustomString'}
                    if type(identity) is not int or identity == 999999999 or set(record) - allowed:
                        raise Unresolved('대사 조건 또는 중첩 분기 확인 필요')
                    if identity in nodes:
                        raise Unresolved('같은 대사의 여러 실행 위치 확인 필요')
                    nodes[identity] = {'type': 'choice' if choice else 'dialogue', 'next': []}
                    ids.append(identity)
                    if choice:
                        marker = record.get('TriggerCustomString')
                        if not isinstance(marker, str) or not marker:
                            raise Unresolved('선택지 실행 대상 없음')
                        options[identity] = marker
                tokens.extend([ids] if choice else ids)
            elif kind == 'EndPerformance':
                ended = True
            elif kind not in PRESENTATION_TASKS or contains_talk(task):
                raise Unresolved('타임라인 또는 미지원 실행 확인 필요')
        if not tokens:
            if wait is None and trigger is None:
                continue
            raise Unresolved('대사 없는 시퀀스의 실행 관계 확인 필요')
        first = tokens[0] if isinstance(tokens[0], list) else [tokens[0]]
        if len(first) != 1:
            raise Unresolved('선택지로 시작하는 장면 확인 필요')
        if wait:
            if wait in listeners:
                raise Unresolved('여러 대기 대상 확인 필요')
            listeners[wait] = first[0]
        else:
            starts.append(first[0])
        for left, right in zip(tokens, tokens[1:]):
            if isinstance(left, list):
                raise Unresolved('선택지 이후 순서 확인 필요')
            nodes[left]['next'] = right if isinstance(right, list) else [right]
        tails.append(tokens[-1])
        triggers.append(trigger)
    if len(starts) != 1:
        raise Unresolved('장면 시작점 확인 필요')
    for identity, marker in options.items():
        if marker not in listeners:
            raise Unresolved('선택지 응답 구조 없음')
        nodes[identity]['next'] = [listeners[marker]]
    for tail, marker in zip(tails, triggers):
        if marker in listeners:
            if isinstance(tail, list):
                raise Unresolved('선택지와 완료 신호의 실행 관계 확인 필요')
            nodes[tail]['next'] = [listeners[marker]]
    order, visiting, visited = [], set(), set()

    def visit(identity):
        if identity in visiting:
            raise Unresolved('반복 실행 확인 필요')
        if identity in visited:
            return
        visiting.add(identity)
        order.append(identity)
        for target in nodes[identity]['next']:
            visit(target)
        visiting.remove(identity)
        visited.add(identity)

    visit(starts[0])
    if visited != set(nodes):
        raise Unresolved('연결되지 않은 장면 있음')
    # Keep shared continuation after every incoming alternative, rather than
    # appending it to whichever choice a depth-first walk happened to visit first.
    incoming = Counter(target for node in nodes.values() for target in node['next'])
    order = []
    while len(order) < len(nodes):
        available = next((identity for identity in nodes if identity not in order and incoming[identity] == 0), None)
        if available is None:
            raise Unresolved('반복 실행 확인 필요')
        order.append(available)
        for target in nodes[available]['next']:
            incoming[target] -= 1
    return nodes, order


def restore(payload, structures):
    payload.pop('bwikiBaseOrder', None)
    payload.pop('bwiki', None)
    rows = payload['rows']
    old_order = payload.get('referenceOrder', [row['id'] for row in rows])
    if len(set(old_order)) != len(old_order):
        raise ValueError('Duplicate reference order identity')
    rank = {identity: index for index, identity in enumerate(old_order)}
    rows = sorted(rows, key=lambda row: rank.get(row['id'], len(rank)))
    payload['referenceOrder'] = [row['id'] for row in rows]
    by_mission = defaultdict(list)
    for row in rows:
        for key in ['nextIds', 'replyToIds', 'flowStatus', 'flowScene', 'flowBoundary']:
            row.pop(key, None)
        for key in ['bwikiStatus', 'bwikiScene', 'bwikiNextIds', 'bwikiReplyToIds', 'bwikiPage', 'bwikiRevision', 'bwikiMissionId', 'bwikiMission', 'videoStatus', 'videoId', 'videoStartMs']:
            row.pop(key, None)
        if row.get('missionId', '').startswith('quest-'):
            row['flowStatus'] = 'review'
            by_mission[row['missionId']].append(row)
    candidates, review = [], []
    for mission, owned in by_mission.items():
        sources = {row.get('source', '').split('#')[0] for row in owned}
        identities = defaultdict(list)
        for row in owned:
            identities[(row.get('talkId'), row['type'])].append(row)
        for source in sorted(sources):
            owner = re.fullmatch(r'(?:Config/Level/Mission|Story/(?:Discussion/)?Mission)/(\d+)/.+\.json', source)
            if not owner or mission != 'quest-' + owner[1]:
                review.append({'missionId': mission, 'source': source, 'reason': '실행 구조 미제공 또는 임무 귀속 확인 필요'})
                continue
            if source not in structures:
                review.append({'missionId': mission, 'source': source, 'reason': '실행 구조 미제공'})
                continue
            try:
                nodes, order = scene_graph(structures[source])
                selected = []
                missing = []
                for identity in order:
                    matches = identities[(identity, nodes[identity]['type'])]
                    if len(matches) > 1:
                        raise Unresolved('수록 대사의 중복 위치 확인 필요')
                    if matches:
                        selected.append(matches[0])
                    else:
                        missing.append(identity)
                # At least one published row explicitly attributes this scene.
                if not any(row.get('source', '').split('#')[0] == source for row in selected):
                    raise Unresolved('장면 귀속 확인 필요')
                if missing:
                    review.append({'missionId': mission, 'source': source, 'reason': '수록 대사 누락 · 연결된 기존 대사만 제공', 'missingTalkIds': missing})
                candidates.append((source, nodes, selected, not missing))
            except Unresolved as error:
                review.append({'missionId': mission, 'source': source, 'reason': str(error)})
    # Conflicting complete scenes cannot be resolved by file name or text similarity.
    mappings = defaultdict(set)
    for source, nodes, selected, complete in candidates:
        index = {row['talkId']: row['id'] for row in selected}
        for row in selected:
            mappings[row['id']].add(tuple(index.get(target, f'missing-{target}') for target in nodes[row['talkId']]['next']))
    conflicts = {identity for identity, values in mappings.items() if len(values) > 1}
    used, accepted, reordered, partial = set(), [], 0, 0
    for source, nodes, selected, complete in sorted(candidates, key=lambda item: (-len(item[2]), item[0])):
        ids = {row['id'] for row in selected}
        if ids & conflicts or ids & used:
            review.append({'missionId': selected[0]['missionId'], 'source': source, 'reason': '장면 간 중복 또는 연결 충돌'})
            continue
        index = {row['talkId']: row['id'] for row in selected}
        group = hashlib.sha256(source.encode()).hexdigest()[:16]
        for row in selected:
            targets = nodes[row['talkId']]['next']
            row['nextIds'] = [index[target] for target in targets if target in index]
            if any(target not in index for target in targets):
                row['flowBoundary'] = True
            row['flowStatus'] = 'verified'
            row['flowScene'] = group
        reverse = defaultdict(list)
        for row in selected:
            if row['type'] == 'choice':
                for target in row['nextIds']:
                    reverse[target].append(row['id'])
        for row in selected:
            if row['id'] in reverse:
                row['replyToIds'] = reverse[row['id']]
        # Only permute this verified scene's existing slots. All uncertain rows stay put.
        if complete:
            slots = [position for position, row in enumerate(rows) if row['id'] in ids]
            reordered += int([rows[position]['id'] for position in slots] != [row['id'] for row in selected])
            for position, row in zip(slots, selected):
                rows[position] = row
        else:
            partial += 1
        used.update(ids)
        accepted.append(source)
    payload['rows'] = rows
    counts = Counter(row.get('flowStatus') for row in rows)
    payload['flow'] = {'verifiedRows': counts['verified'], 'reviewRows': counts['review'],
                       'verifiedScenes': len(accepted), 'partialScenes': partial, 'reorderedScenes': reordered}
    payload['orderNote'] = '실행 연결이 확인된 장면만 복원했습니다. 확인이 필요한 구간은 기존 참조 순서를 유지합니다.'
    return accepted, review


def run(root, manifest_path):
    manifest = json.loads(manifest_path.read_bytes())
    if manifest.get('schema') != 'hsr-dialogue-flow-input.v1':
        raise ValueError('Invalid flow input')
    status_file = root / 'public/content-update.json'
    if json.loads(status_file.read_bytes()).get('commit') != manifest['commit']:
        raise ValueError('Mixed dialogue text and flow revisions')
    structures, evidence = {}, {}
    for item in manifest['files']:
        if not re.fullmatch(r'[a-f0-9]{40}', item['sha']):
            raise ValueError('Invalid blob identity')
        data = (Path(manifest['blobs']) / item['sha']).read_bytes()
        if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != item['sha']:
            raise ValueError('Flow input hash mismatch')
        structures[item['path']] = json.loads(data)
        evidence[item['path']] = {'gitBlob': item['sha'], 'sha256': hashlib.sha256(data).hexdigest()}
    metadata = json.loads((root / 'src/data/imported-content.json').read_bytes())
    simulation = json.loads((root / 'src/data/simulation.json').read_bytes())
    specs = list(metadata.values()) + [chapter['content'] for entry in simulation for chapter in entry['chapters']]
    used, reviews, totals, publications, all_rows, orders = set(), [], Counter(), [], {}, []
    for spec in specs:
        file = 'public/' + spec['file']
        payload = json.loads((root / file).read_bytes())
        if not any(row.get('missionId', '').startswith('quest-') for row in payload['rows']):
            continue
        before = {row['id']: (row['text'], row['speaker'], row['type']) for row in payload['rows']}
        accepted, review = restore(payload, structures)
        after = {row['id']: (row['text'], row['speaker'], row['type']) for row in payload['rows']}
        if before != after or len(before) != len(payload['rows']):
            raise ValueError('Flow restoration changed published text or identity')
        used.update(accepted)
        reviews.extend({'file': spec['file'], **item} for item in review)
        totals.update(payload['flow'])
        write_json(root / file, payload)
        publications.append(file)
        all_rows.update((row['id'], row) for row in payload['rows'])
        orders.append([row['id'] for row in payload['rows']])
    search_file = root / 'public/content/search-index.json'
    search = json.loads(search_file.read_bytes())
    # Preserve search source boundary hashes; only publish verified navigation metadata.
    for row in search['rows']:
        if row['id'] in all_rows:
            source = all_rows[row['id']]
            for key in ['nextIds', 'replyToIds', 'flowStatus', 'flowScene', 'flowBoundary']:
                row.pop(key, None)
                if key in source:
                    row[key] = source[key]
    search_by_id = {row['id']: row for row in search['rows']}
    positions = {row['id']: position for position, row in enumerate(search['rows'])}
    for order in orders:
        if any(identity not in positions for identity in order):
            raise ValueError('Search index is missing a published dialogue identity')
        slots = sorted(positions[identity] for identity in order)
        for position, identity in zip(slots, order):
            search['rows'][position] = search_by_id[identity]
    write_json(search_file, search)
    publications.append('public/content/search-index.json')
    report = {'schema': 'hsr-dialogue-flow-audit.v1', 'commit': manifest['commit'], 'totals': dict(totals),
              'sources': {source: evidence[source] for source in sorted(used)}, 'review': reviews}
    report_file = 'public/dialogue-flow-provenance.json'
    write_json(root / report_file, report, True)
    publications.append(report_file)
    receipt_file = root / 'receipt.json'
    receipt = json.loads(receipt_file.read_bytes()) if receipt_file.exists() else {'files': [], 'rows': len(search['rows'])}
    receipt['files'] = sorted(set(receipt['files'] + publications))
    write_json(receipt_file, receipt)
    print(json.dumps(dict(totals)))


if __name__ == '__main__':
    run(Path(sys.argv[1]), Path(sys.argv[2]))
