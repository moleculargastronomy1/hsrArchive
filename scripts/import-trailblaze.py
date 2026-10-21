"""Discover chapters by Korean title, then join only explicit mission/scene references."""
import argparse
import copy
import hashlib
import json
import re
import unicodedata
from pathlib import Path


def plain(value):
    value = value.replace('\\n', '\n').replace('\u00a0', ' ')
    value = re.sub(r'</?(?:color|size|b|i|s|u|unbreak|align)(?:=[^>]*)?>', '', value, flags=re.I)
    return re.sub(r'\*{0,2}\{NICKNAME\}\*{0,2}', '[개척자]', value).strip()


def normalize(value):
    return re.sub(r'[\s·•≪≫]', '', unicodedata.normalize('NFKC', plain(value)))


def sequence(value):
    match = re.fullmatch(r'(서막|제(\d+)막)\s*[•·]\s*(?:제(\d+)장|(후문|종말)(\d+))', plain(value))
    if not match:
        return None
    return (int(match[2] or 0), int(match[3] or match[5]), match[4] or '정규')


def entry_arc(entry):
    match = re.match(r'제(\d+)장', entry.get('arcLabel', entry.get('subtitle', '')))
    return int(match[1]) if match else 0 if entry['id'] == 'station-departure' else None


def discover(chapters, missions, texts, entries, query=None):
    """Titles select chapters; ChapterID establishes ownership, never ID prefixes."""
    result = []
    identities = set()
    for chapter in sorted(chapters, key=lambda row: (row.get('ChapterDisplayPriority', 0), row.get('ID', 0))):
        seq = sequence(texts.get(str(chapter.get('ChapterSequence', {}).get('Hash')), ''))
        if chapter.get('ChapterType') != 'Normal' or not seq:
            continue
        identity = chapter['ID']
        if type(identity) is not int or identity in identities:
            raise ValueError('Duplicate or invalid chapter identity')
        identities.add(identity)
        title = plain(texts.get(str(chapter.get('ChapterName', {}).get('Hash')), ''))
        if not title:
            raise ValueError('Missing Korean Trailblaze title')
        owned = [mission for mission in missions if mission.get('Type') == 'Main' and mission.get('ChapterID') == identity]
        owned.sort(key=lambda row: (row.get('DisplayPriority', 0), row['MainMissionID']))
        if query and not any(normalize(query) in normalize(value) for value in [title] + [
                texts.get(str(row.get('Name', {}).get('Hash')), '') for row in owned]):
            continue
        bound = [(entry, item) for entry in entries for item in entry['chapters']
                 if item.get('upstreamChapterId') == identity]
        matches = bound or [(entry, item) for entry in entries if entry_arc(entry) == seq[0]
                            for item in entry['chapters'] if item.get('kind') != 'adventure' and
                            normalize(re.sub(r'^(?:제\d+막|개척 후문|종말 임무):\s*', '', item['title'])) == normalize(title)]
        if len(matches) > 1:
            raise ValueError('Ambiguous chapter title: ' + title)
        if matches:
            entry, item = matches[0]
        else:
            entry_matches = [entry for entry in entries if entry_arc(entry) == seq[0]]
            if len(entry_matches) > 1:
                raise ValueError('Ambiguous Trailblaze arc')
            entry = entry_matches[0] if entry_matches else {'id': f'trailblaze-arc-{seq[0]}'}
            item = {'id': f'chapter-{identity}', 'content': {'rows': 0}}
        content = item.get('content', {})
        # Once published, IDs/bookmarks survive later extraction improvements.
        # The projector updates exact text; source-first adds newly proven records.
        known_body = content.get('rows', 0) > 1 or any(source.startswith('quest-') for source in content.get('sourceIds', []))
        result.append({
            'id': identity, 'title': title, 'arc': seq[0], 'act': seq[1], 'kind': seq[2],
            'entryId': entry['id'], 'chapterId': item['id'], 'preserved': known_body,
            'descriptionHash': str(chapter.get('ChapterDesc', {}).get('Hash', '')),
            'missions': [{'id': row['MainMissionID'],
                          'title': plain(texts.get(str(row.get('Name', {}).get('Hash')), '')) or '임무 기록'}
                         for row in owned],
        })
    return result


def structure_owner(path):
    match = re.fullmatch(r'(?:Story/Mission|Config/Level/Mission)/([1-9]\d*)/[A-Za-z0-9_./-]+\.json', path)
    if not match or any(part in ['.', '..'] for part in path.split('/')) or path.endswith('.layout.json'):
        raise ValueError('Unsafe mission structure path: ' + path)
    return int(match[1])


def extract_chapter(record, structures, talks, texts):
    """Traverse source list order; unresolved timelines/performances block promotion."""
    rows, issues, seen = [], [], set()
    owners = {mission['id']: mission['title'] for mission in record['missions']}
    if not owners:
        return [], ['소속 임무 표 없음']
    owned_files = {mission: [] for mission in owners}
    for path in structures:
        owner = structure_owner(path)
        if owner in owned_files:
            owned_files[owner].append(path)

    def finish_markers(node):
        result = set()
        if isinstance(node, dict):
            if node.get('$type', '').endswith('.TriggerCustomString'):
                value = node.get('CustomString', '')
                value = value.get('Value') if isinstance(value, dict) else value
                if isinstance(value, str):
                    result.add(value)
            for child in node.values():
                result.update(finish_markers(child))
        elif isinstance(node, list):
            for child in node:
                result.update(finish_markers(child))
        return result

    markers = {mission: set().union(*(finish_markers(structures[path]) for path in paths))
               for mission, paths in owned_files.items()}

    def visit(node, path, mission, pointer='', role=None, scene=None, stack=()):
        if isinstance(node, list):
            for index, item in enumerate(node):
                visit(item, path, mission, f'{pointer}/{index}', role, scene, stack)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get('$type', '').split('.')[-1]
        if node.get('FinishType') == 'Talk' and node.get('ParamStr1') not in markers[mission]:
            issues.append(f'{path}#{pointer}: 임무 완료 대화 구조 미제공')
        if node_type == 'OptionTalkInfo':
            role = 'choice'
        elif node_type in ['SimpleTalkInfo', 'PlaySimpleTalk', 'PlayAndWaitSimpleTalk']:
            role = 'dialogue'
        if 'TalkSentenceID' in node:
            talk_id = node['TalkSentenceID']
            if talk_id != 999999999:
                supported = role or ('dialogue' if node_type in ['PlaySimpleTalk', 'PlayAndWaitSimpleTalk'] else None)
                talk = talks.get(talk_id)
                if not supported or not talk:
                    issues.append(f'{path}#{pointer}: 대사 참조 확인 필요')
                else:
                    text_hash = talk.get('TalkSentenceText', {}).get('Hash')
                    text = texts.get(str(text_hash), '')
                    speaker_hash = talk.get('TextmapTalkSentenceName', {}).get('Hash')
                    speaker = texts.get(str(speaker_hash), '')
                    if not plain(text) or (speaker_hash and not speaker):
                        issues.append(f'{path}#{pointer}: 한국어 연결 누락')
                    else:
                        boundary = scene or path
                        key = (mission, path, pointer, supported)
                        if key not in seen:
                            seen.add(key)
                            file_key = hashlib.sha256((path + '#' + pointer).encode()).hexdigest()[:16]
                            rows.append({
                                'id': f"trailblaze-{record['id']}-{mission}-{file_key}-{talk_id}-{supported}",
                                'entryId': record['entryId'], 'chapterId': record['chapterId'],
                                'missionId': f'quest-{mission}', 'mission': owners[mission],
                                'scene': Path(path).stem, 'type': supported,
                                'speaker': plain(speaker), 'text': plain(text), 'talkId': talk_id,
                                'source': path + '#' + boundary, 'referencePath': pointer,
                            })
        if node_type == 'PlayTimeline':
            name = node.get('TimelineName', '')
            candidates = [name, re.sub(r'\.playable$', '.json', name), name + '.json']
            target = next((item for item in candidates if item in structures), None)
            if not target or structure_owner(target) != mission or target in stack:
                issues.append(f'{path}#{pointer}: 타임라인 원문 구조 미제공')
            else:
                visit(structures[target], target, mission, stack=stack + (target,))
        if node_type in ['TriggerPerformance', 'PlayVideo', 'PlayCutscene', 'PlayCutScene']:
            issues.append(f'{path}#{pointer}: {node_type} 연결 미지원')
        if (re.search(r'Talk|Dialogue|Narration', node_type) and
                node_type not in ['SimpleTalkInfo', 'OptionTalkInfo', 'PlaySimpleTalk',
                                  'PlayAndWaitSimpleTalk', 'PlayOptionTalk'] and
                not node_type.startswith(('Wait', 'End', 'Stop', 'Reset'))):
            issues.append(f'{path}#{pointer}: {node_type} 대사 스키마 미지원')
        for key, value in node.items():
            if key in ['StoryPath', 'PerformancePath', 'GraphPath', 'SubGraphPath', 'TalkConfigPath'] and value:
                issues.append(f'{path}#{pointer}: {key} 연결 미지원')
            if key in ['TalkSentenceIDList', 'TalkSentenceId']:
                issues.append(f'{path}#{pointer}: 대사 스키마 미지원')
            child_role = 'choice' if key == 'OptionList' else 'dialogue' if key in ['SimpleTalkList', 'TalkSentenceList'] else role
            child_scene = scene
            if key == 'TaskList' or key in ['SuccessTaskList', 'FailedTaskList']:
                child_scene = pointer + '/' + key
            if isinstance(value, (dict, list)):
                visit(value, path, mission, pointer + '/' + key, child_role, child_scene, stack)

    for mission in owners:
        paths = sorted(owned_files[mission])
        if not paths:
            issues.append(f'{mission}: 임무 구조 미제공')
        before = len(rows)
        for path in paths:
            owner = structures[path].get('MainMissionID') if isinstance(structures[path], dict) else None
            if owner is not None and owner != mission:
                issues.append(f'{path}: 임무 귀속 불일치')
                continue
            visit(structures[path], path, mission, stack=(path,))
        if paths and len(rows) == before:
            issues.append(f'{mission}: 읽을 수 있는 대사 참조 없음')
    return rows, sorted(set(issues))


def write(root, file, value):
    target = root / file
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def load_inputs(raw, manifest):
    evidence = {}

    def read(name):
        descriptor = next(item for item in manifest['files'] if Path(item['path']).name == name)
        data = (raw / name).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != descriptor['sha']:
            raise ValueError('Unverified Trailblaze input: ' + name)
        evidence[name] = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
        return json.loads(data)

    texts = {}
    for item in manifest['files']:
        if re.fullmatch(r'TextMap/TextMapKR(?:_\d+)?\.json', item['path']):
            for key, value in read(Path(item['path']).name).items():
                if not isinstance(value, str) or (key in texts and texts[key] != value):
                    raise ValueError('Conflicting Korean Trailblaze text')
                texts[key] = value
    chapters, missions = read('MissionChapterConfig.json'), read('MainMission.json')
    ids = [row.get('MainMissionID') for row in missions if row]
    if any(type(identity) is not int or identity <= 0 for identity in ids) or len(set(ids)) != len(ids):
        raise ValueError('Invalid MainMission identities')
    return texts, chapters, missions, read, evidence


def publish(root, entries, records, structures, talks, texts, commit):
    entries = copy.deepcopy(entries)
    metadata = json.loads((root / 'src/data/imported-content.json').read_bytes())
    files, coverage = [], []
    for record in records:
        entry = next((entry for entry in entries if entry['id'] == record['entryId']), None)
        if entry is None:
            entry = {
                'id': record['entryId'], 'title': record['title'], 'subtitle': f"제{record['arc']}장",
                'arcLabel': f"제{record['arc']}장", 'description': '새로운 개척의 기록',
                'category': 'trailblaze', 'world': 'universe', 'order': record['arc'] + 1,
                'language': 'ko-KR', 'tags': ['개척 임무'],
                'source': {'kind': 'extracted', 'version': '공개 임무 구조 ' + commit[:7], 'sourceIds': []},
                'chapters': [],
            }
            entries.append(entry)
        chapter = next((item for item in entry['chapters'] if item['id'] == record['chapterId']), None)
        existed = chapter is not None
        if chapter is None:
            prefix = f"제{record['act']}막" if record['kind'] == '정규' else '개척 후문' if record['kind'] == '후문' else '종말 임무'
            chapter = {'id': record['chapterId'], 'title': prefix + ': ' + record['title'], 'blocks': []}
            entry['chapters'].append(chapter)
        chapter['upstreamChapterId'] = record['id']
        if chapter.get('upstreamManaged'):
            prefix = f"제{record['act']}막" if record['kind'] == '정규' else '개척 후문' if record['kind'] == '후문' else '종말 임무'
            chapter['title'] = prefix + ': ' + record['title']
        if record['preserved']:
            coverage.append({'chapterId': record['id'], 'title': record['title'], 'status': 'preserved'})
            continue
        rows, issues = extract_chapter(record, structures, talks, texts)
        coverage.append({'chapterId': record['id'], 'title': record['title'],
                         'status': 'pending' if issues else 'structured', 'issues': issues,
                         'missionIds': [mission['id'] for mission in record['missions']]})
        key = record['entryId'] + '/' + record['chapterId']
        if issues and existed:
            # Preserve the original introduction, verified body and saved row IDs.
            if chapter.get('upstreamManaged') and chapter.get('content', {}).get('rows', 0) > 1:
                chapter['contentNote'] = '이전 검증 본문 수록 · 최신 장면 연결 대기'
            continue
        chapter['upstreamManaged'] = True
        file = f"content/{record['entryId']}--{record['chapterId']}.json"
        intro_text = plain(texts.get(record['descriptionHash'], ''))
        intro = [{
            'id': f"trailblaze-intro-{record['id']}", 'entryId': record['entryId'], 'chapterId': record['chapterId'],
            'missionId': f"chapter-intro-{record['id']}", 'mission': record['title'], 'scene': '챕터 소개문',
            'type': 'narration', 'speaker': '', 'text': intro_text, 'talkId': None,
            'textHash': record['descriptionHash'],
            'source': f"ExcelOutput/MissionChapterConfig.json:{record['id']}/ChapterDesc",
        }] if intro_text else []
        if existed:
            # Keep legacy intro IDs when promoting an introduction-only route.
            old = root / 'public' / metadata[key]['file']
            if old.exists():
                previous = json.loads(old.read_bytes())
                intro = [row for row in previous['rows'] if row.get('source', '').endswith('/ChapterDesc')]
                for row in intro:
                    row['text'] = intro_text
                    row['textHash'] = record['descriptionHash']
        if issues:
            rows = []
        published_rows = intro + rows
        source_ids = ([f"chapter-intro-{record['id']}"] if intro else []) + ([f"quest-{mission['id']}" for mission in record['missions']] if rows else [])
        payload = {
            'schema': 'hsr-dialogue.v1', 'entryId': record['entryId'], 'chapterId': record['chapterId'],
            'referenceCommit': commit, 'textReferenceCommit': commit, 'sourceIds': source_ids,
            'missing': 0, 'orderNote': '공개 구조의 참조 순서입니다. 선택지·분기는 실제 플레이 순서와 다를 수 있습니다.',
            'rows': published_rows,
        }
        write(root, 'public/' + file, payload)
        files.append('public/' + file)
        metadata[key] = {'file': file, 'rows': len(published_rows), 'missing': 0, 'sourceIds': source_ids,
                         'textReferenceCommit': commit}
        chapter['content'] = metadata[key]
        chapter['contentNote'] = ('챕터 소개문 수록 · 대사 본문 미수록' if intro else '제목 수록 · 대사 본문 미수록') if issues else '공개 임무 구조의 대사·선택지 수록'
    write(root, 'src/data/imported-content.json', metadata)
    write(root, 'src/data/trailblaze.json', entries)
    return files, coverage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('raw', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--discover', action='store_true')
    parser.add_argument('--title', help='한국어 챕터 또는 소속 임무 제목 검색')
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_bytes())
    if (manifest.get('schema') != 'hsr-upstream-plan.v1' or manifest.get('repository') != 'DimbreathBot/TurnBasedGameData'
            or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', ''))):
        raise ValueError('Invalid Trailblaze manifest')
    texts, chapters, missions, read, evidence = load_inputs(args.raw, manifest)
    catalog = json.loads((args.root / '.cache/trailblaze-catalog.json').read_bytes())
    records = discover(chapters, missions, texts, catalog, args.title)
    if args.title and not records:
        raise ValueError('No exact source chapter/mission title contains: ' + args.title)
    if args.discover:
        mission_ids = sorted({mission['id'] for record in records if not record['preserved'] for mission in record['missions']})
        write(args.root, '.cache/trailblaze-plan.json', {'commit': manifest['commit'], 'missionIds': mission_ids})
        print(json.dumps([{'title': row['title'], 'preserved': row['preserved']} for row in records], ensure_ascii=False))
        return
    structure_manifest = json.loads((args.root / '.cache/trailblaze-structures.json').read_bytes())
    if structure_manifest['commit'] != manifest['commit']:
        raise ValueError('Mixed mission structure revisions')
    structures = {}
    for item in structure_manifest['files']:
        if structure_owner(item['path']) != item['missionId'] or item['path'] in structures:
            raise ValueError('Invalid structure ownership')
        data = (args.root / '.cache/structures' / item['path']).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != item['sha']:
            raise ValueError('Unverified mission structure: ' + item['path'])
        evidence[item['path']] = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
        structures[item['path']] = json.loads(data)
    talk_rows = read('TalkSentenceConfig.json')
    talks = {row['TalkSentenceID']: row for row in talk_rows if row}
    if len(talks) != len([row for row in talk_rows if row]):
        raise ValueError('Duplicate TalkSentence identity')
    files, coverage = publish(args.root, catalog, records, structures, talks, texts, manifest['commit'])
    provenance_file = 'public/trailblaze-provenance.json'
    write(args.root, provenance_file, {
        'schema': 'hsr-trailblaze-provenance.v1', 'repository': manifest['repository'], 'commit': manifest['commit'],
        'version': manifest['version'], 'files': evidence, 'chapters': coverage,
        'scope': 'Exact title/ChapterID/owned structure/TalkSentence joins. Missing or unsupported structures remain pending.',
        'copyright': 'Game text © HoYoverse. Data source: DimbreathBot/TurnBasedGameData.',
    })
    write(args.root, '.cache/trailblaze-receipt.json', {
        'files': files + ['src/data/trailblaze.json', provenance_file], 'payloads': files,
    })
    print(json.dumps({status: sum(row['status'] == status for row in coverage) for status in ['preserved', 'structured', 'pending']}))


if __name__ == '__main__':
    main()
