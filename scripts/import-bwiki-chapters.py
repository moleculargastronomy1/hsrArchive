"""Fill introduction-only chapters from BWIKI structure and unique official text IDs."""
import copy
import hashlib
import importlib.util
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

_spec = importlib.util.spec_from_file_location('bwiki', Path(__file__).with_name('bwiki-dialogue.py'))
bwiki = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bwiki)


def read_table(raw, plan, name, evidence=None):
    descriptor = next(item for item in plan['files'] if item['path'] == 'ExcelOutput/' + name)
    data = (raw / name).read_bytes()
    if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != descriptor['sha']:
        raise ValueError('Unverified chapter input: ' + name)
    if evidence is not None:
        evidence['ExcelOutput/' + name] = {'gitBlob': descriptor['sha'], 'sha256': hashlib.sha256(data).hexdigest()}
    return json.loads(data)


def discover(root, raw, plan_path):
    plan, missions, _, chinese, korean, _ = bwiki.inputs(raw, plan_path)
    chapters = {row['ID']: row for row in read_table(raw, plan, 'MissionChapterConfig.json')}
    entries = json.loads((root / 'src/data/trailblaze.json').read_bytes())
    request_path = root / '.cache/bwiki/request.json'
    request = json.loads(request_path.read_bytes())
    if request['commit'] != plan['commit']:
        raise ValueError('Mixed BWIKI discovery versions')
    imported = []
    for entry in entries:
        for chapter in entry['chapters']:
            identity = chapter.get('upstreamChapterId')
            if identity not in chapters or not chapter.get('content'):
                continue
            if chapter['content']['rows'] > 1 and not chapter.get('bwikiManaged'):
                continue
            source = chapters[identity]
            title = chinese.get(str(source.get('ChapterName', {}).get('Hash')), '')
            groups, missing = defaultdict(list), []
            for mission in missions:
                if mission.get('ChapterID') != identity or mission.get('Type') != 'Main':
                    continue
                key = str(mission.get('Name', {}).get('Hash'))
                cn, kr = chinese.get(key), korean.get(key)
                if cn and kr:
                    groups[cn].append({'id': mission['MainMissionID'], 'title': bwiki._localizations.plain(kr)})
                else:
                    missing.append(mission['MainMissionID'])
            if (not title or not groups) and not chapter.get('bwikiManaged'):
                continue
            record = {'id': identity, 'title': title, 'entryId': entry['id'], 'chapterId': chapter['id'],
                      'file': chapter['content']['file'], 'missingMissionNames': missing, 'groups': []}
            for cn, members in groups.items():
                if len({member['title'] for member in members}) != 1:
                    continue
                ids = sorted(member['id'] for member in members)
                record['groups'].append({'title': cn, 'koreanTitle': members[0]['title'], 'missionIds': ids})
                if not any(item['title'] == cn for item in request['requests']):
                    request['requests'].append({'title': cn, 'missionId': ids[0]})
            imported.append(record)
    priority = {group['title']: index for index, group in enumerate(group for record in imported for group in record['groups'])}
    request['requests'].sort(key=lambda item: priority.get(item['title'], len(priority)))
    bwiki.write(request_path, request)
    bwiki.write(root / '.cache/bwiki/chapters.json', {'commit': plan['commit'], 'chapters': imported})
    print(json.dumps({'bwikiChapterCandidates': len(imported)}))


def node_keys(segments):
    for segment in segments:
        for node in segment:
            if node['kind'] == 'line':
                yield ('line', bwiki.comparable(node['text']), bwiki.normalized(node['speaker']))
            elif node['kind'] == 'choice':
                for option in node['options']:
                    yield ('choice', bwiki.comparable(option['text']), '')
                    yield from node_keys([option['body']])
            elif node['kind'] == 'separated':
                yield from node_keys(node['segments'])


def import_runs(segments, index):
    """Unresolved choice labels do not hide independently identifiable response text."""
    result = []
    for segment in segments:
        current = []
        for node in segment:
            try:
                bwiki.compile_segment([node], index)
            except bwiki.Unresolved:
                if current:
                    result.append(current)
                    current = []
                if node['kind'] == 'choice':
                    options = []
                    for option in node['options']:
                        empty = {**option, 'body': []}
                        try:
                            bwiki.compile_segment([{'kind': 'choice', 'options': [empty]}], index)
                            options.append(empty)
                        except bwiki.Unresolved:
                            pass
                    if options:
                        result.append([{'kind': 'choice', 'options': options}])
                    for option in node['options']:
                        result.extend(import_runs([option['body']], index))
                elif node['kind'] == 'separated':
                    result.extend(import_runs(node['segments'], index))
            else:
                current.append(node)
        if current:
            result.append(current)
    return result


def official_candidates(talks, chinese, korean, wanted):
    result = defaultdict(list)
    generic = {bwiki.normalized(label) for label in ['场景角色', '旁白']}
    for talk in talks:
        if not talk:
            continue
        text_hash = str(talk.get('TalkSentenceText', {}).get('Hash'))
        speaker_hash = str(talk.get('TextmapTalkSentenceName', {}).get('Hash'))
        cn, kr = chinese.get(text_hash), korean.get(text_hash)
        if not cn or not kr:
            continue
        speaker = chinese.get(speaker_hash, '')
        if speaker_hash not in ['None', '0'] and (not speaker or not korean.get(speaker_hash)):
            continue
        text, name = bwiki.comparable(cn), bwiki.normalized(speaker)
        keys = [('line', text, name)]
        if not name or name == '开拓者':
            keys.append(('choice', text, ''))
        keys.extend(('line', text, label) for label in generic)
        candidate = {'talkId': talk['TalkSentenceID'], 'textHash': text_hash,
                     'speaker': bwiki._localizations.plain(korean.get(speaker_hash, '')),
                     'text': bwiki._localizations.plain(kr), 'chineseHash': bwiki.digest(bwiki.canonical(cn)),
                     'speakerHash': bwiki.digest(bwiki.canonical(speaker)),
                     'koreanHash': bwiki.digest(bwiki._localizations.plain(kr))}
        for key in set(keys) & wanted:
            result[key].append(candidate)
    # Cutscene subtitle lines may have a TextMap ID but no TalkSentence record.
    # Only the explicitly labelled subtitle role can use that separate identity.
    subtitle = {key for key in wanted if key[0] == 'line' and key[2] == '字幕'}
    subtitle_texts = {key[1] for key in subtitle}
    if subtitle:
        for text_hash, cn in chinese.items():
            kr = korean.get(text_hash)
            if not kr:
                continue
            text = bwiki.comparable(cn)
            if text not in subtitle_texts:
                continue
            result[('line', text, '字幕')].append({
                'talkId': None, 'textHash': text_hash, 'speaker': '', 'text': bwiki._localizations.plain(kr),
                'chineseHash': bwiki.digest(bwiki.canonical(cn)), 'speakerHash': bwiki.digest(''),
                'koreanHash': bwiki.digest(bwiki._localizations.plain(kr)),
            })
    return result


def make_row(record, group, mission_key, key, candidate):
    kind, _, wiki_speaker = key
    identity = ('talk-' + str(candidate['talkId'])) if candidate['talkId'] else 'text-' + candidate['textHash']
    role = 'choice' if kind == 'choice' else 'dialogue' if candidate['speaker'] else 'narration'
    row = {'id': f"bwiki-{record['id']}-{identity}-{kind}", 'entryId': record['entryId'], 'chapterId': record['chapterId'],
           'missionId': mission_key, 'mission': group['koreanTitle'], 'scene': group['koreanTitle'],
           'type': role, 'speaker': candidate['speaker'], 'text': candidate['text'], 'talkId': candidate['talkId'],
           'textHash': candidate['textHash'], 'flowStatus': 'review',
           'source': 'ExcelOutput/TalkSentenceConfig:' + str(candidate['talkId']) if candidate['talkId'] else 'TextMap:' + candidate['textHash']}
    evidence = {name: candidate[name] for name in ['talkId', 'textHash', 'chineseHash', 'speakerHash', 'koreanHash']}
    evidence.update(type=role, wikiSpeaker=wiki_speaker, kind=kind)
    return row, evidence


def build_chapter(record, payload, pages, source_text, candidates, previous_chunks, previous_sources, chinese, revalidate_existing=False):
    # The standard pipeline may only replay old exact proofs here. New IDs and
    # ownership are exclusively admitted by the source-first verifier.
    if revalidate_existing:
        pages, source_text = {}, {}
    by_id = {row['id']: dict(row) for row in payload['rows']}
    original_ids = set(by_id)
    chunks, review, groups = [], [], {}
    occurrences = Counter()
    for group in record['groups']:
        if group['title'] in source_text:
            try:
                for key in node_keys(bwiki.story_segments(source_text[group['title']], True)):
                    choices = candidates.get(key, [])
                    if len(choices) == 1:
                        item = choices[0]
                        occurrences[(item['talkId'], item['textHash'], key[0])] += 1
            except bwiki.Unresolved:
                pass
    for group in record['groups']:
        page = pages.get(group['title'])
        if not page or page['status'] != 'available':
            for old in previous_chunks:
                if old['page'] != group['title'] or old.get('officialMissionIds') != group['missionIds']:
                    continue
                if f"{old['page']}@{old['revision']}" not in previous_sources:
                    continue
                valid = True
                for identity in old['order']:
                    expected = old['evidence'][identity]
                    cn = chinese.get(expected['textHash'], '')
                    key = (expected['kind'], bwiki.comparable(cn), expected['wikiSpeaker'])
                    choices = candidates.get(key, [])
                    row = by_id.get(identity)
                    if len(choices) != 1 or not row:
                        valid = False
                        break
                    candidate = choices[0]
                    if (any(candidate[name] != expected[name] for name in ['talkId', 'textHash', 'chineseHash', 'speakerHash', 'koreanHash']) or
                            row['text'] != candidate['text'] or row['type'] != expected['type'] or
                            row.get('talkId') != expected['talkId'] or row.get('textHash') != expected['textHash'] or
                            row.get('speaker') != candidate['speaker'] or row.get('missionId') != old['missionId']):
                        valid = False
                        break
                if valid:
                    chunks.append({**old, 'status': 'cached'})
                    groups[old['missionId']] = old['missionStructure']
            review.append({'page': group['title'], 'reason': '기존 수록 원문 전용 재검증 · 새 귀속·간선 반영 보류' if revalidate_existing else '조회 실패 · 이전 대조를 공식 원문에 재검증'})
            continue
        try:
            fields = bwiki.validate_mission_page(source_text[group['title']], group['title'])
            if bwiki.normalized(bwiki.inline(fields.get('系列任务', ''))) != bwiki.normalized(record['title']):
                raise bwiki.Unresolved('BWIKI 임무 시리즈와 공식 챕터명 불일치')
            segments = bwiki.story_segments(source_text[group['title']], True)
        except bwiki.Unresolved as error:
            review.append({'page': group['title'], 'reason': str(error)})
            continue
        mission = 'bwiki-page-' + str(page['pageId'])
        # Group membership is exact; individual subquest ownership remains unspecified.
        title_ids = {bwiki.normalized(item['title']): ['bwiki-page-' + str(pages[item['title']]['pageId'])]
                     for item in record['groups'] if pages.get(item['title'], {}).get('status') == 'available'}
        structure = bwiki.mission_structure(fields, title_ids)
        groups[mission] = structure
        index, evidence = {}, {}
        for key in set(node_keys(segments)):
            index[key] = []
            for candidate in candidates.get(key, []):
                if occurrences[(candidate['talkId'], candidate['textHash'], key[0])] > 1:
                    continue
                row, item = make_row(record, group, mission, key, candidate)
                index[key].append(row)
                evidence[row['id']] = item
        for position, segment in enumerate(segments):
            if segment[0]['kind'] == 'barrier':
                continue
            if any(len(index.get(key, [])) != 1 for key in node_keys([segment])) or any(node['kind'] in ['unsupported', 'separated'] for node in segment):
                review.append({'page': group['title'], 'segment': str(position), 'reason': '미확인 선택·조건·누락 대사는 연결하지 않고 확인된 본문만 독립 구간으로 수록'})
            for subposition, run in enumerate(import_runs([segment], index)):
                try:
                    matched, edges = bwiki.compile_segment(run, index)
                    for row in matched:
                        if row['id'] not in by_id:
                            by_id[row['id']] = row
                    chunks.append({'missionId': mission, 'mission': group['koreanTitle'], 'officialMissionIds': group['missionIds'],
                                   'page': page['pageTitle'], 'revision': page['revision'], 'segment': f'{position}.{subposition}',
                                   'status': 'cached' if page.get('retrieval') == 'cache-pinned' else 'matched', 'missionStructure': structure, 'order': [row['id'] for row in matched],
                                   'edges': edges, 'evidence': {row['id']: evidence[row['id']] for row in matched}})
                except bwiki.Unresolved as error:
                    review.append({'page': group['title'], 'segment': f'{position}.{subposition}', 'reason': str(error)})
    occurrences = Counter(identity for chunk in chunks for identity in chunk['order'])
    chunks = [chunk for chunk in chunks if all(occurrences[identity] == 1 for identity in chunk['order'])]
    used = {identity for chunk in chunks for identity in chunk['order']}
    result = copy.deepcopy(payload)
    result['rows'] = [row for identity, row in by_id.items() if identity in original_ids or identity in used]
    # A published body never loses rows on an ambiguous/missing/changed wiki input.
    base = payload.get('bwikiBaseOrder', [row['id'] for row in payload['rows']])
    result['bwikiBaseOrder'] = base + [row['id'] for row in result['rows'] if row['id'] not in set(base)]
    order, acyclic = bwiki.mission_order(list(groups), groups)
    if not acyclic:
        review.append({'reason': 'BWIKI 임무 선후 관계 충돌'})
    accepted = bwiki.apply_chunks(result, chunks, order)
    for row in result['rows']:
        if row['id'].startswith(f"bwiki-{record['id']}-") and row['id'] not in used:
            row['bwikiStatus'] = 'review'
    result['bwiki']['reviewRows'] = sum(row.get('bwikiStatus') == 'review' for row in result['rows'])
    result['bwikiManaged'] = True
    result['orderNote'] = 'BWIKI 문서의 순서·선택지를 공식 대사 ID 또는 자막 TextMap ID와 연결했습니다. 미확인 구간은 별도 검토 기록을 유지합니다.'
    return result, accepted, review, order


def publish(root, raw, plan_path, manifest_path, previous_root, revalidate_existing=False):
    plan, missions, talks, chinese, korean, hashes = bwiki.inputs(raw, plan_path)
    discovery = json.loads((root / '.cache/bwiki/chapters.json').read_bytes())
    manifest = json.loads(manifest_path.read_bytes())
    if 'targetFiles' in manifest:
        discovery['chapters'] = [item for item in discovery['chapters'] if item['file'] in manifest['targetFiles']]
    if discovery['commit'] != plan['commit'] or manifest['commit'] != plan['commit']:
        raise ValueError('Mixed BWIKI chapter input versions')
    if not discovery['chapters']:
        return
    official_chapters = {row['ID']: row for row in read_table(raw, plan, 'MissionChapterConfig.json', hashes)}
    official_missions = {row['MainMissionID']: row for row in missions if row}
    for record in discovery['chapters']:
        chapter = official_chapters.get(record['id'])
        if not chapter or chinese.get(str(chapter.get('ChapterName', {}).get('Hash')), '') != record['title']:
            raise ValueError('Unverified BWIKI chapter ownership')
        for group in record['groups']:
            for identity in group['missionIds']:
                mission = official_missions.get(identity)
                if not mission or mission.get('ChapterID') != record['id'] or chinese.get(str(mission.get('Name', {}).get('Hash'))) != group['title']:
                    raise ValueError('Unverified BWIKI mission group')
    previous_path = previous_root / 'public/bwiki-provenance.json'
    previous = json.loads(previous_path.read_bytes()) if previous_path.exists() else {}
    if revalidate_existing:
        discovery['chapters'] = [item for item in discovery['chapters'] if item['file'] in previous.get('imports', {})]
    report = json.loads((root / 'public/bwiki-provenance.json').read_bytes())
    if report['commit'] != plan['commit']:
        raise ValueError('Mixed BWIKI audit versions')
    pages = {page['title']: page for page in manifest['pages']}
    source_text, wanted = {}, set()
    for page in manifest['pages']:
        if page['status'] != 'available':
            continue
        data = Path(page['file']).read_bytes()
        if bwiki.digest(data.decode('utf-8')) != page['sha256']:
            raise ValueError('Unverified BWIKI chapter page')
        if not revalidate_existing:
            source_text[page['title']] = data.decode('utf-8')
    for record in discovery['chapters']:
        for group in record['groups']:
            if group['title'] in source_text:
                try:
                    wanted.update(node_keys(bwiki.story_segments(source_text[group['title']], True)))
                except bwiki.Unresolved:
                    pass
        for chunk in previous.get('chapters', {}).get(record['file'], []):
            for expected in chunk['evidence'].values():
                if 'textHash' in expected and 'wikiSpeaker' in expected:
                    wanted.add((expected['kind'], bwiki.comparable(chinese.get(expected['textHash'], '')), expected['wikiSpeaker']))
    candidates = official_candidates(talks, chinese, korean, wanted)
    entries = json.loads((root / 'src/data/trailblaze.json').read_bytes())
    metadata = json.loads((root / 'src/data/imported-content.json').read_bytes())
    search = json.loads((root / 'public/content/search-index.json').read_bytes())
    updates = json.loads((root / 'public/content-update.json').read_bytes())
    trailblaze = json.loads((root / 'public/trailblaze-provenance.json').read_bytes())
    receipt = json.loads((root / 'receipt.json').read_bytes())
    files, delta = [], 0
    totals = Counter(report['totals'])
    report.setdefault('imports', {})
    for record in discovery['chapters']:
        path = root / 'public' / record['file']
        payload = json.loads(path.read_bytes())
        if record['file'] in report['chapters']:
            totals.subtract(payload.get('bwiki', {}))
        result, chunks, review, sequence = build_chapter(
            record, payload, pages, source_text, candidates,
            previous.get('chapters', {}).get(record['file'], []), previous.get('sources', {}), chinese, revalidate_existing)
        if revalidate_existing and {row['id'] for row in result['rows']} != {row['id'] for row in payload['rows']}:
            raise ValueError('Existing-only BWIKI verification changed row identities')
        body = [row for row in result['rows'] if row['id'].startswith(f"bwiki-{record['id']}-")]
        if not body:
            if record['file'] in report['chapters']:
                totals.update(payload.get('bwiki', {}))
            continue
        totals.update(result['bwiki'])
        delta += len(result['rows']) - len(payload['rows'])
        source_ids = list(dict.fromkeys(payload.get('sourceIds', []) +
                         ['quest-' + str(identity) for group in record['groups'] for identity in group['missionIds']]))
        result.update(sourceIds=source_ids, textReferenceCommit=plan['commit'])
        bwiki.write(path, result)
        files.append('public/' + record['file'])
        key = record['entryId'] + '/' + record['chapterId']
        metadata[key].update(rows=len(result['rows']), sourceIds=source_ids, textReferenceCommit=plan['commit'])
        entry = next(entry for entry in entries if entry['id'] == record['entryId'])
        if 'source' in entry and 'version' in entry['source']:
            entry['source']['version'] = entry['source']['version'].replace('제7막 소개문', 'BWIKI 본문 대조')
        chapter = next(chapter for chapter in entry['chapters'] if chapter['id'] == record['chapterId'])
        chapter.update(bwikiManaged=True, upstreamManaged=True, content=metadata[key],
                       contentNote='BWIKI 순서·선택지 대조 본문 수록 · 일부 구간 확인 필요')
        for item in trailblaze['chapters']:
            if item['chapterId'] == record['id']:
                item.update(rawStatus=item.get('rawStatus', item['status']), status='bwiki-partial',
                            bwikiRows=len(body), bwikiAudit='bwiki-provenance.json')
        # Rebuild this chapter's search group, preserving all other identities/order.
        prior_indices = [index for index, row in enumerate(search['rows'])
                         if row['entryId'] == record['entryId'] and row['chapterId'] == record['chapterId']]
        insertion = prior_indices[0] if prior_indices else len(search['rows'])
        search['rows'] = [row for row in search['rows']
                          if not (row['entryId'] == record['entryId'] and row['chapterId'] == record['chapterId'])]
        search_rows = []
        for row in result['rows']:
            value = {key: value for key, value in row.items() if key not in ['missionId', 'talkId', 'source']}
            value['source'] = bwiki.digest(row['source'])[:16]
            search_rows.append(value)
        search['rows'][insertion:insertion] = search_rows
        report['chapters'][record['file']] = chunks
        report.setdefault('missionOrder', {})[record['file']] = sequence
        report['imports'][record['file']] = {
            'chapterId': record['id'], 'groups': record['groups'], 'rows': len(body),
            'missingMissionNames': record['missingMissionNames'], 'review': review,
            **({'verificationMode': 'existing-only-revalidated'} if revalidate_existing else {}),
            'scope': 'Unique official TalkSentence IDs; explicitly labelled subtitles may use a unique TextMap hash. No translated text or inferred individual subquest ownership.',
        }
        for chunk in chunks:
            source_key = f"{chunk['page']}@{chunk['revision']}"
            page = pages.get(chunk['page'])
            if page and page['status'] == 'available' and page['revision'] == chunk['revision']:
                report['sources'][source_key] = {
                    'page': chunk['page'], 'revision': chunk['revision'], 'timestamp': page['timestamp'], 'collectedAt': page.get('collectedAt'), 'sha256': page['sha256'],
                    'sourceUrl': 'https://wiki.biligame.com/sr/' + bwiki.quote(chunk['page']) + '?oldid=' + str(chunk['revision']),
                    'historyUrl': 'https://wiki.biligame.com/sr/' + bwiki.quote(chunk['page']) + '?action=history',
                }
            else:
                report['sources'][source_key] = previous['sources'][source_key]
        report['inputs'].update(hashes)
        print(json.dumps({'chapter': record['id'], 'rows': len(body), **result['bwiki']}, ensure_ascii=False))
    if not files:
        return
    if len({row['id'] for row in search['rows']}) != len(search['rows']):
        raise ValueError('Duplicate imported dialogue identity')
    report['totals'] = dict(totals)
    updates['rows'] = len(search['rows'])
    updates['verifiedTextRows'] += delta
    receipt['rows'] = len(search['rows'])
    for file, value in [('src/data/trailblaze.json', entries), ('src/data/imported-content.json', metadata),
                        ('public/content/search-index.json', search), ('public/content-update.json', updates),
                        ('public/trailblaze-provenance.json', trailblaze), ('public/bwiki-provenance.json', report)]:
        if file.startswith('src/data/') or file in ['public/content-update.json', 'public/trailblaze-provenance.json']:
            bwiki.write(root / file, value, pretty=True)
        else:
            bwiki.write(root / file, value)
        files.append(file)
    receipt['files'] = sorted(set(receipt['files'] + files))
    bwiki.write(root / 'receipt.json', receipt)


if __name__ == '__main__':
    if '--discover' in sys.argv:
        discover(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        publish(*(Path(value) for value in sys.argv[1:6]), revalidate_existing='--revalidate-existing' in sys.argv)
