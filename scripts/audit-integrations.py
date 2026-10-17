"""Audit deployed chapter data and evidence; links and green CI are not verification."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote
from urllib.request import Request, urlopen

_spec = importlib.util.spec_from_file_location('bwiki_audit', Path(__file__).with_name('bwiki-dialogue.py'))
bwiki = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bwiki)
_import_spec = importlib.util.spec_from_file_location('bwiki_import_audit', Path(__file__).with_name('import-bwiki-chapters.py'))
imports = importlib.util.module_from_spec(_import_spec)
_import_spec.loader.exec_module(imports)
KST = timezone(timedelta(hours=9))
CORE = ['id', 'type', 'speaker', 'text', 'missionId', 'talkId', 'source']


def sha(value):
    return hashlib.sha256(value).hexdigest()


def core_hash(row):
    return sha(json.dumps([row.get(key) for key in CORE], ensure_ascii=False, separators=(',', ':')).encode())


def unknown(row):
    return (row.get('flowStatus') == 'review' or row.get('bwikiStatus') == 'review') and row.get('flowStatus') != 'verified' and row.get('bwikiStatus') not in ['matched', 'cached'] and row.get('videoStatus') not in ['caption-matched', 'screen-matched']


def text_proof(row, talks, chinese, korean):
    proof = bwiki.row_evidence(row, talks, chinese, korean)
    if proof:
        return proof
    key = str(row.get('textHash', ''))
    cn, kr = chinese.get(key), korean.get(key)
    if row.get('talkId') is None and cn and kr and bwiki._localizations.plain(kr) == bwiki._localizations.plain(row['text']):
        return {'text': bwiki.comparable(cn), 'speaker': '', 'chineseHash': bwiki.digest(bwiki.canonical(cn)), 'speakerHash': bwiki.digest(''), 'koreanHash': bwiki.digest(bwiki._localizations.plain(kr))}
    return None


def evidence_rows(payload, chunks, sources, talks, chinese, korean):
    by_id = {row['id']: row for row in payload['rows']}
    valid, edges, choices, issues = set(), set(), set(), []
    for chunk in chunks:
        source = sources.get(f"{chunk['page']}@{chunk['revision']}")
        for identity in chunk['order']:
            row, expected = by_id.get(identity), chunk.get('evidence', {}).get(identity)
            proof = text_proof(row, talks, chinese, korean) if row else None
            wrong_type = expected and row and (expected.get('type', row['type']) != row['type'] or 'kind' in expected and (expected['kind'] == 'choice') != (row['type'] == 'choice'))
            if not row or not expected or not proof or not source or wrong_type or row.get('talkId') != expected.get('talkId') or any(proof.get(key) != expected.get(key) for key in ['chineseHash', 'speakerHash', 'koreanHash']):
                issues.append({'rowId': identity, 'reason': '공식 대사 ID/원문 해시 또는 BWIKI 출처 근거 불일치'})
                continue
            if (row.get('bwikiPage'), row.get('bwikiRevision'), row.get('bwikiMissionId')) != (chunk['page'], chunk['revision'], chunk['missionId']) or row.get('bwikiNextIds', []) != chunk['edges'].get(identity, []):
                issues.append({'rowId': identity, 'reason': '게시 행의 문서/분기와 감사 기록 불일치'})
                continue
            valid.add(identity)
        for identity, targets in chunk['edges'].items():
            for target in targets:
                if identity in valid and target in valid and target in chunk['order'] and by_id[identity].get('bwikiScene') and by_id[identity].get('bwikiScene') == by_id[target].get('bwikiScene') and by_id[identity].get('bwikiMissionId') == by_id[target].get('bwikiMissionId'):
                    edges.add((identity, target))
                    if by_id[identity]['type'] == 'choice':
                        choices.add(identity)
    return valid, edges, choices, issues


def load(path):
    return json.loads(path.read_bytes())


def verify_document_chunk(chunk, by_id, talks, chinese, korean, parsed):
    """Replay actual cached wikitext against this chunk, not the published edges alone."""
    index = {}
    for identity in chunk['order']:
        row = by_id.get(identity)
        proof = text_proof(row, talks, chinese, korean) if row else None
        if not proof:
            return False
        kind = 'choice' if row['type'] == 'choice' else 'line'
        name = '' if kind == 'choice' else chunk['evidence'][identity].get('wikiSpeaker', proof['speaker'])
        key = kind, proof['text'], bwiki.normalized(name)
        index.setdefault(key, []).append(row)
    wanted = set(index)
    occurrences = 0
    for keys, segment in parsed:
        if not wanted.issubset(keys):
            continue
        for run in imports.import_runs([segment], index):
            try:
                rows, edges = bwiki.compile_segment(run, index)
            except bwiki.Unresolved:
                continue
            if [row['id'] for row in rows] == chunk['order'] and edges == chunk['edges']:
                occurrences += 1
    return occurrences == 1


def site_read(base, file, stamp):
    url = base.rstrip('/') + '/' + quote(file, safe='/') + '?audit=' + quote(stamp)
    request = Request(url, headers={'User-Agent': 'hsrArchive integration audit/1.0'})
    with urlopen(request, timeout=45) as response:
        return response.read()


def source_cache_check(root, source):
    digest = source.get('sha256', '')
    if not re.fullmatch('[a-f0-9]{64}', digest):
        return False
    for folder in ['.cache/upstream-content/bwiki', '.cache/bwiki/pages', '.cache/bwiki']:
        candidate = root / folder / (digest + '.wiki')
        if candidate.exists() and sha(candidate.read_bytes()) == digest:
            return True
    return False


def parsed_document(root, source, cache):
    key = source.get('sha256', '')
    if key not in cache:
        cache[key] = None
        if re.fullmatch('[a-f0-9]{64}', key):
            for folder in ['.cache/upstream-content/bwiki', '.cache/bwiki/pages', '.cache/bwiki']:
                candidate = root / folder / (key + '.wiki')
                if candidate.exists() and sha(candidate.read_bytes()) == key:
                    try:
                        segments = bwiki.story_segments(candidate.read_text(encoding='utf-8'), True)
                        cache[key] = [(set(imports.node_keys([segment])), segment) for segment in segments]
                    except bwiki.Unresolved:
                        pass
                    break
    return cache[key]


def audit(root, raw, plan_path, base, expected_commit, output, local=False):
    now = datetime.now(timezone.utc)
    stamp = now.isoformat()
    specs = [(entry, chapter) for entry in load(root / 'src/data/trailblaze.json') for chapter in entry['chapters'] if chapter.get('content')]
    snapshot = root if local else root / '.cache/integration-audit/site-snapshot'
    files = ['site-update.json', 'content-update.json', 'bwiki-provenance.json', 'video-order-provenance.json', 'trailblaze-provenance.json'] + [chapter['content']['file'] for _, chapter in specs]
    if not local:
        def download(file):
            target = snapshot / 'public' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(site_read(base, file, stamp))
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(download, files))
    read = lambda file: load(snapshot / 'public' / file)
    site, update, wiki, video = (read(file) for file in files[:4])
    trailblaze = read('trailblaze-provenance.json')
    plan, missions, talk_rows, chinese, korean, inputs = bwiki.inputs(raw, plan_path)
    if any(item.get('commit') != plan['commit'] for item in [update, wiki, video]):
        raise ValueError('Published reports and verified official input have different commits')
    talks = {row['TalkSentenceID']: row for row in talk_rows if row.get('TalkSentenceID') is not None}
    baseline_path = root / '.cache/integration-audit/original-fields.json'
    baseline = load(baseline_path) if baseline_path.exists() else {}
    before_wiki_path = root / '.cache/integration-audit/before-bwiki-provenance.json'
    before_wiki = load(before_wiki_path) if before_wiki_path.exists() else {}
    report = {'schema': 'hsr-integration-audit.v1', 'generatedAt': stamp, 'generatedAtKST': now.astimezone(KST).isoformat(),
              'siteBase': base, 'siteCommit': site['commit'], 'expectedCommit': expected_commit,
              'siteCommitMatches': not local and site['commit'] == expected_commit,
              'upstreamCommit': plan['commit'], 'version': plan.get('version'), 'inputHashes': inputs,
              'criteria': {'완료': '본문 전체·장면 사이 진행·모든 선택지 경로의 독립 검증과 실제 배포 확인이 모두 필요함. 현재 데이터에는 전체 범위 증명이 없어 완료로 판정하지 않음.',
                           '부분 완료': '공식 ID/원문 해시와 BWIKI 문서·연결 근거가 있는 구간 또는 유효 자막 대조가 있으나 전체 범위는 입증되지 않음.',
                           '미완료': '문서/영상 링크만 있거나 검증된 대사 연결이 없음. 또는 실제 게시 자료를 확인하지 못함.'},
              'limits': ['BWIKI 행 순서는 해당 문서 구간의 참고 순서이며 실제 전체 플레이 순서의 독립 검증이 아님.',
                         '선택지 수는 응답 연결이 확인된 선택지의 수이며 게임 전체 분기 수가 아님.',
                         '문서 수정 시각(timestamp)은 수집 시각이 아님. 과거 수집 시각 기록이 없으면 알 수 없음으로 표시함.',
                         '장별 검토 사유 건수와 미확인 대사 행 수는 서로 다른 단위임. 영상 제목 연결은 자막 검증이 아님.',
                         '미확인 행 수는 현재 수록본 안의 수치다. 게임 전체에서 빠진 대사 수는 완전한 독립 기준이 없어 산정할 수 없음.'],
              'chapters': []}
    document_cache, global_talk_ids = {}, set()
    for entry, chapter in specs:
        file = chapter['content']['file']
        payload, expected = read(file), load(root / 'public' / file)
        rows = payload['rows']
        by_id = {row['id']: row for row in rows}
        chunks = wiki.get('chapters', {}).get(file, [])
        valid, edges, choices, issues = evidence_rows(payload, chunks, wiki['sources'], talks, chinese, korean)
        global_talk_ids.update(by_id[identity]['talkId'] for identity in valid if by_id[identity].get('talkId') is not None)
        document_rows, document_edges, document_choices, document_reasons = set(), set(), set(), Counter()
        document_segments = 0
        for chunk in chunks:
            source = wiki['sources'].get(f"{chunk['page']}@{chunk['revision']}", {})
            if not set(chunk['order']).issubset(valid):
                document_reasons['공식 ID/원문 근거가 일치하지 않는 구간'] += 1
                continue
            parsed = parsed_document(root, source, document_cache)
            if parsed is None:
                document_reasons['원문 수집본 없음/해시 또는 문법 재확인 불가'] += 1
            elif verify_document_chunk(chunk, by_id, talks, chinese, korean, parsed):
                document_segments += 1
                document_rows.update(set(chunk['order']) & valid)
                for first, targets in chunk['edges'].items():
                    for last in targets:
                        if (first, last) in edges:
                            document_edges.add((first, last))
                            if by_id[first]['type'] == 'choice':
                                document_choices.add(first)
            else:
                document_reasons['기록된 순서/분기를 문서에서 유일한 구간으로 재현하지 못함'] += 1
        used = {f"{chunk['page']}@{chunk['revision']}" for chunk in chunks}
        sources = [{**wiki['sources'][key], 'cachedContentHashVerified': source_cache_check(root, wiki['sources'][key])} for key in sorted(used) if key in wiki['sources']]
        identities = {int(value[6:]) for value in payload.get('sourceIds', []) if re.fullmatch(r'quest-\d+', value)}
        identities.update(int(row['missionId'][6:]) for row in rows if re.fullmatch(r'quest-\d+', row.get('missionId', '')))
        pages = [page for page in wiki.get('pages', []) if identities.intersection(page.get('missionIds', [page['missionId']])) or page.get('pageTitle') in {source['page'] for source in sources}]
        page_by_mission = {identity: page for page in pages for identity in page.get('missionIds', [page['missionId']])}
        unresolved = [row for row in rows if unknown(row)]
        reasons = Counter()
        for row in unresolved:
            page = page_by_mission.get(int(row['missionId'][6:])) if re.fullmatch(r'quest-\d+', row.get('missionId', '')) else None
            if not text_proof(row, talks, chinese, korean):
                reasons['공식 ID 또는 현재 한국어 원문 일치 확인 불가'] += 1
            elif not page:
                reasons['BWIKI 문서명/임무 귀속 연결 미확정'] += 1
            elif page['status'] == 'unavailable':
                reasons['BWIKI 최신 본문 조회 실패'] += 1
            elif page['status'] == 'missing':
                reasons['BWIKI 임무 문서 없음'] += 1
            else:
                reasons['문서 내 동일 대사·화자·구간/분기 연결 미확정'] += 1
        reviews = [item for item in wiki.get('review', []) if item.get('file') == file or not item.get('file') and item.get('missionId') in identities]
        reviews += wiki.get('imports', {}).get(file, {}).get('review', [])
        chapter_video = video.get('chapters', {}).get(file, {})
        linked_videos = []
        caption_ids = set()
        for item in chapter_video.get('videos', []):
            evidence = [e for e in video.get('evidence', []) if e.get('file') == file and e.get('videoId') == item['id']]
            matched = set()
            for proof in evidence:
                if not re.fullmatch('[a-f0-9]{64}', proof.get('captionSha256', '')):
                    continue
                for match in proof.get('matches', []):
                    row = by_id.get(match['rowId'])
                    if row and row['type'] != 'choice' and bwiki.digest(row['text']) == match.get('koreanHash'):
                        matched.add(row['id'])
            caption_ids.update(matched)
            linked_videos.append({**item, 'lastCheck': video.get('checks', {}).get(item['id']), 'validExactCaptionRows': len(matched)})
        expected_core = {row['id']: core_hash(row) for row in expected['rows']}
        deployed_core = {row['id']: core_hash(row) for row in rows}
        preserved = baseline.get(file)
        field_changes = [identity for identity, digest in (preserved or {}).items() if deployed_core.get(identity) != digest]
        old_valid = {identity for chunk in before_wiki.get('chapters', {}).get(file, []) for identity in chunk['order']}
        old_positions = {identity: position for position, identity in enumerate(preserved or {})}
        ambiguous_moved = [row['id'] for position, row in enumerate(rows) if row['id'] in old_positions and row['id'] not in old_valid and unknown(row) and old_positions[row['id']] != position]
        applied = not local and report['siteCommitMatches'] and expected_core == deployed_core
        raw_verified = {row['id'] for row in rows if row.get('flowStatus') == 'verified'}
        body = [row for row in rows if not (row.get('source') or '').startswith('ExcelOutput/MissionChapterConfig.json:')]
        collected = [source.get('collectedAt') for source in sources if source.get('collectedAt')]
        collected += [page['collectedAt'] for page in pages if page.get('status') == 'available' and page.get('collectedAt')]
        eligible = {row['id'] for row in body}
        status = '부분 완료' if applied and (valid or caption_ids) else '미완료'
        structure = next((item for item in trailblaze.get('chapters', []) if item['chapterId'] == chapter.get('upstreamChapterId')), {})
        report['chapters'].append({'entryId': entry['id'], 'entryTitle': entry.get('arcLabel', entry['title']), 'chapterId': chapter['id'], 'title': chapter['title'], 'file': file,
            'url': base.rstrip('/') + '/#/entry/' + entry['id'] + '/' + chapter['id'], 'status': status,
            'rows': len(rows), 'bodyRows': len(body), 'choiceRows': sum(row['type'] == 'choice' for row in body),
            'officialTalkIdMatchedRows': sum(bool(row.get('talkId') is not None and text_proof(row, talks, chinese, korean)) for row in body),
            'wikiMatchedRows': len(valid), 'wikiUniqueTalkIds': len({by_id[identity]['talkId'] for identity in valid if by_id[identity].get('talkId') is not None}),
            'wikiFreshRows': sum(by_id[identity].get('bwikiStatus') == 'matched' for identity in valid),
            'wikiRetainedRows': sum(by_id[identity].get('bwikiStatus') == 'cached' for identity in valid),
            'wikiSubtitleHashRows': sum(by_id[identity].get('talkId') is None for identity in valid),
            'wikiOrderedSegments': document_segments, 'wikiRecordedSegments': len(chunks),
            'wikiDocumentRecheckedRows': len(document_rows), 'wikiDocumentRecheckUnconfirmedRows': len(valid - document_rows),
            'wikiDocumentRecheckReasons': dict(document_reasons), 'wikiEdges': len(document_edges),
            'wikiRecordedEdges': len(edges), 'wikiRecordedChoices': len(choices), 'wikiChoicesWithResponses': len(document_choices),
            'wikiChoiceResponseEdges': sum(by_id[first]['type'] == 'choice' for first, last in document_edges),
            'rawStructureVerifiedRows': len(raw_verified), 'unknownOrderRows': len(unresolved),
            'wikiUnmatchedBodyRows': len(eligible - valid), 'unknownReasonsByRow': dict(reasons),
            'reviewReasonRecords': dict(Counter(item.get('reason', '상세 사유 없음') for item in reviews)),
            'sourcePages': sources, 'latestAttemptPages': [{key: value for key, value in page.items() if key in ['title', 'missionId', 'missionIds', 'pageTitle', 'status', 'reason', 'revision', 'collectedAt', 'sourceUrl']} for page in pages],
            'latestSuccessfulCollection': max(collected) if collected else None,
            'successfulCollectionTimeUnknownPages': sum(not source.get('collectedAt') for source in sources),
            'videos': linked_videos, 'exactCaptionRows': len(caption_ids),
            'captionOrderUsedRows': sum(row.get('videoStatus') == 'caption-matched' and row['id'] in caption_ids for row in rows),
            'componentStatus': {'bwiki': '부분 완료' if valid else '미완료', 'youtube': '부분 완료' if len(caption_ids) >= 3 else '미완료', 'site': '완료' if applied else '미완료'},
            'rawStructureIssues': structure.get('issues', []),
            'missingOfficialMissionNames': wiki.get('imports', {}).get(file, {}).get('missingMissionNames', []),
            'fullPlaythroughAndAllBranchesVerified': False, 'evidenceIssues': issues,
            'siteApplied': applied, 'siteRowOrderMatchesLocalResult': [row['id'] for row in rows] == [row['id'] for row in expected['rows']],
            'sitePayloadSha256': sha((snapshot / 'public' / file).read_bytes()),
            'originalPreservationChecked': preserved is not None, 'originalFieldChangesOrLostRows': field_changes,
            'addedRows': len(set(deployed_core) - set(preserved or deployed_core)), 'previouslyUnverifiedRowsMoved': ambiguous_moved,
            'unknownRowIds': [row['id'] for row in unresolved]})
    if not local:
        again_site = json.loads(site_read(base, 'site-update.json', stamp + '-end'))
        again_wiki = json.loads(site_read(base, 'bwiki-provenance.json', stamp + '-end'))
        if again_site['commit'] != site['commit'] or again_wiki['checkedAt'] != wiki['checkedAt']:
            raise ValueError('Site changed during audit; rerun to obtain a consistent snapshot')
    chapters = report['chapters']
    unique_sources = {f"{page['page']}@{page['revision']}": page for chapter in chapters for page in chapter['sourcePages']}
    report['summary'] = {'chapters': len(chapters), 'statusCounts': {status: sum(chapter['status'] == status for chapter in chapters) for status in ['완료', '부분 완료', '미완료']},
        'wikiLinkedChapters': sum(chapter['wikiMatchedRows'] > 0 for chapter in chapters),
        'videoLinkedChapters': sum(bool(chapter['videos']) for chapter in chapters),
        'captionVerifiedChapters': sum(chapter['exactCaptionRows'] >= 3 for chapter in chapters),
        'siteAppliedChapters': sum(chapter['siteApplied'] for chapter in chapters),
        'youtubeVerificationIncompleteChapters': sum(chapter['componentStatus']['youtube'] == '미완료' for chapter in chapters),
        'wikiUniqueTalkIds': len(global_talk_ids), 'wikiTalkIdMatchedRows': sum(chapter['wikiMatchedRows'] - chapter['wikiSubtitleHashRows'] for chapter in chapters),
        'wikiSubtitleHashRows': sum(chapter['wikiSubtitleHashRows'] for chapter in chapters),
        'linkedDocumentRevisions': len(unique_sources), 'documentSourceHashUnconfirmed': sum(not source['cachedContentHashVerified'] for source in unique_sources.values()),
        **{key: sum(chapter[key] for chapter in chapters) for key in ['rows', 'wikiMatchedRows', 'wikiFreshRows', 'wikiRetainedRows', 'wikiDocumentRecheckedRows', 'wikiDocumentRecheckUnconfirmedRows', 'wikiOrderedSegments', 'wikiRecordedSegments', 'wikiRecordedChoices', 'wikiChoicesWithResponses', 'wikiChoiceResponseEdges', 'unknownOrderRows', 'exactCaptionRows']},
        'evidenceIssueRows': sum(len(chapter['evidenceIssues']) for chapter in chapters),
        'originalFieldChangesOrLostRows': sum(len(chapter['originalFieldChangesOrLostRows']) for chapter in chapters),
        'previouslyUnverifiedRowsMoved': sum(len(chapter['previouslyUnverifiedRowsMoved']) for chapter in chapters)}
    report['unlinkedStoryVideos'] = video.get('linkReview', [])
    output.parent.mkdir(parents=True, exist_ok=True)
    bwiki.write(output.with_suffix('.json'), report)
    output.write_text(markdown(report), encoding='utf-8')
    print(json.dumps(report['summary'], ensure_ascii=False))
    return report


def markdown(report):
    def count(value): return f'{value:,}'
    def clean(value): return str(value).replace('|', '\\|').replace('\n', ' ')
    def time(value):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(KST).strftime('%Y-%m-%d %H:%M:%S KST') if value else '알 수 없음(과거 기록 미제공)'
    result = ['# 개척 임무 자동 연동 실증 검증 보고서', '',
              f"검증 시각: {time(report['generatedAt'])} · 실제 게시 커밋: `{report['siteCommit']}` · 공식 입력: `{report['upstreamCommit']}`", '',
              '코드 존재나 Actions 성공은 검증 완료의 근거로 사용하지 않았다. 실제 공개 JSON을 다시 받고, 공식 입력의 Git blob·정수 해시·한국어 원문, BWIKI 대사 근거·문서 수정 번호·응답 연결과 대조했다. 수집 시각이 없는 과거 기록은 추정하지 않았다.', '',
              '## 판정 기준', '']
    result += [f'- **{key}**: {value}' for key, value in report['criteria'].items()]
    result += ['', '## 전체 집계', '', '| 항목 | 결과 |', '|---|---:|']
    labels = {'chapters': '전체 장', 'statusCounts': '판정별 장 수', 'wikiLinkedChapters': '공식 대사와 BWIKI가 부분 이상 연결된 장',
              'videoLinkedChapters': '유튜브 영상이 연결된 장', 'captionVerifiedChapters': '유효 자막 3문장 이상 일치한 장',
              'siteAppliedChapters': '실제 게시된 본문·ID를 확인한 장', 'youtubeVerificationIncompleteChapters': '영상 자막 검증 미완료 장', 'rows': '전체 표시 행', 'wikiMatchedRows': '공식 원문 해시까지 재확인한 BWIKI 연결 행',
              'wikiFreshRows': '이번 문서 수집으로 대조한 행', 'wikiRetainedRows': '이전 문서 연결을 재검증해 유지한 행',
              'wikiUniqueTalkIds': '장 사이 중복을 제거한 BWIKI 연결 대사 ID', 'wikiTalkIdMatchedRows': '대사 ID로 일치한 행',
              'wikiSubtitleHashRows': '대사 ID 대신 공식 자막 TextMap 해시로 일치한 행',
              'linkedDocumentRevisions': '연결 문서 수정본 수(중복 제거)', 'documentSourceHashUnconfirmed': '원문 수집본 SHA-256 재확인 불가 수정본',
              'wikiDocumentRecheckedRows': '실제 문서 순서·분기로 재검증한 행', 'wikiDocumentRecheckUnconfirmedRows': 'ID는 일치하나 문서 순서·분기 재검증 미확인 행',
              'wikiOrderedSegments': '실제 문서로 재검증한 순서 구간', 'wikiRecordedSegments': '기록된 BWIKI 순서 구간', 'wikiRecordedChoices': '기록된 응답 연결 선택지',
              'wikiChoicesWithResponses': 'BWIKI 응답 연결이 있는 선택지', 'wikiChoiceResponseEdges': 'BWIKI 선택지→응답 간선',
              'unknownOrderRows': '사이트 표시 기준 순서 미확인 행', 'exactCaptionRows': '실제 자막 원문 일치 행', 'evidenceIssueRows': '근거 불일치 행',
              'originalFieldChangesOrLostRows': '기존 본문·ID·역할·출처 변경/손실', 'previouslyUnverifiedRowsMoved': '기존 미확인 행의 미확인 유지 상태에서 위치 이동'}
    result += [f'| {labels.get(key, key)} | {clean(value)} |' for key, value in report['summary'].items()]
    result += ['', '## 장별 BWIKI·순서·분기·게시 상태', '',
               'BWIKI 일치는 공식 ID 또는 명시된 자막의 공식 TextMap 해시가 일치하는 행이다. 순서 구간·선택지 응답은 BWIKI 내부 연결이며 전체 플레이 순서나 모든 분기의 검증을 뜻하지 않는다. ID 수는 장 안에서 중복을 제거했다.', '',
               '| 장 | 판정 | 전체 행 | BWIKI 일치 행 / ID | 이번 수집 / 이전 유지 행 | 문서 순서 재검증 / 기록 구간 | 응답 선택지 재검증 / 기록 | 순서 미확인 행 | 실제 게시 |',
               '|---|---|---:|---:|---:|---:|---:|---:|---|']
    for chapter in report['chapters']:
        result.append(f"| [{clean(chapter['entryTitle'] + ' / ' + chapter['title'])}]({chapter['url']}) | {chapter['status']} | {count(chapter['rows'])} | {count(chapter['wikiMatchedRows'])} / {count(chapter['wikiUniqueTalkIds'])} | {count(chapter['wikiFreshRows'])} / {count(chapter['wikiRetainedRows'])} | {chapter['wikiOrderedSegments']} / {chapter['wikiRecordedSegments']} | {chapter['wikiChoicesWithResponses']} / {chapter['wikiRecordedChoices']} | {count(chapter['unknownOrderRows'])} | {'확인' if chapter['siteApplied'] else '미확인/불일치'} |")
    result += ['', '## 장별 실제 수집·영상·미확인 사유', '']
    for chapter in report['chapters']:
        statuses = Counter(page['status'] for page in chapter['latestAttemptPages'])
        result += [f"### {chapter['entryTitle']} / {chapter['title']}", '',
            f"- 판정: **{chapter['status']}**. 확인된 마지막 BWIKI 수집: {time(chapter['latestSuccessfulCollection'])}. 수집 시각을 알 수 없는 이전 문서 {chapter['successfulCollectionTimeUnknownPages']}개.",
            f"- 최근 문서 조회 결과: {dict(statuses)}. 실제 연결 문서 {len(chapter['sourcePages'])}개 중 로컬 수집본 SHA-256 재검증 {sum(page['cachedContentHashVerified'] for page in chapter['sourcePages'])}개.",
            f"- 공식 TalkSentenceID/한국어 본문 일치 {chapter['officialTalkIdMatchedRows']}행. BWIKI 미연결 본문 {chapter['wikiUnmatchedBodyRows']}행. 원본 장면 구조 연결 기록 {chapter['rawStructureVerifiedRows']}행. 이 수치들은 전체 플레이 완료 검증이 아니다.",
            f"- 실제 문서 재검증: {chapter['wikiDocumentRecheckedRows']}행, 순서 구간 {chapter['wikiOrderedSegments']}/{chapter['wikiRecordedSegments']}, 선택지 응답 {chapter['wikiChoicesWithResponses']}/{chapter['wikiRecordedChoices']}, 선택지→응답 간선 {chapter['wikiChoiceResponseEdges']}. 재검증 미확인 {chapter['wikiDocumentRecheckUnconfirmedRows']}행. 구간별 사유: {chapter['wikiDocumentRecheckReasons'] or '없음'}.",
            f"- 순서 미확인 {chapter['unknownOrderRows']}행의 분류: {chapter['unknownReasonsByRow'] or '없음'}. 장면 사이 전체 진행 및 게임 전체 수록 여부는 별도 미확인.",
            f"- 별도 원본 구조 검토 사유: {chapter['rawStructureIssues'] or '기록 없음'}. 공식 임무명 미제공 ID: {chapter['missingOfficialMissionNames'] or '기록 없음'}. 미수록 대사 전체 개수는 산정 불가.",
            f"- 장/구간 검토 사유(대사 수와 다른 단위): {chapter['reviewReasonRecords'] or '별도 사유 기록 없음' }.",
            f"- 영상 연결 {len(chapter['videos'])}개. 유효 자막 일치 {chapter['exactCaptionRows']}행, 자막 순서 실제 반영 {chapter['captionOrderUsedRows']}행. 모든 분기·전체 플레이 검증: 미확인.",
            f"- 항목별 판정: BWIKI {chapter['componentStatus']['bwiki']} / 유튜브 자막 {chapter['componentStatus']['youtube']} / 게시 {chapter['componentStatus']['site']}.",
            f"- 사이트 본문/ID 반영: {'확인' if chapter['siteApplied'] else '미확인/불일치'}. 로컬 결과와 행 순서 일치: {chapter['siteRowOrderMatchesLocalResult']}. 기존 본문·역할·ID·출처 변경/손실 {len(chapter['originalFieldChangesOrLostRows'])}행, 추가 {chapter['addedRows']}행."]
        for page in chapter['sourcePages']:
            result.append(f"  - BWIKI [{page['page']}]({page['sourceUrl']}) · 수정 {page['revision']} · 수집 {time(page.get('collectedAt'))} · 수집본 해시 {'확인' if page['cachedContentHashVerified'] else '직접 재확인 불가'}")
        for video in chapter['videos']:
            check = video.get('lastCheck') or {}
            result.append(f"  - 영상 [{video['title']}]({video['url']}) · 제목 연결 근거 {video.get('linkMethod', '이전 제목 일치')} / {video.get('matchedTitle', '')} · 자막 마지막 결과 {check.get('status', '조회 이력 없음')} ({time(check.get('checkedAt'))}) · 원문 일치 {video['validExactCaptionRows']}행")
        result.append('')
    result += ['## 한계 및 출처', ''] + ['- ' + text for text in report['limits']]
    result += ['', f"공식 원문 입력: [고정 릴리스 스냅샷](https://github.com/DimbreathBot/TurnBasedGameData/tree/{report['upstreamCommit']}).",
               'BWIKI 편집·정리 정보: [BWIKI 기여자](https://wiki.biligame.com/sr/开拓任务), [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). 공식 한국어 자료와 대사 ID에 맞춰 재구성한 정보를 검증했다. 게임 원문 권리는 HoYoverse 및 해당 권리자에게 있다.', '']
    return '\n'.join(result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--raw', type=Path, default=Path('.cache/upstream-content/raw'))
    parser.add_argument('--plan', type=Path, default=Path('.cache/upstream-content/plan.json'))
    parser.add_argument('--site', default='https://moleculargastronomy1.github.io/hsrArchive/')
    parser.add_argument('--expected-commit', default=None)
    parser.add_argument('--output', type=Path, default=Path('docs/reports/integration-audit-2026-10-17.md'))
    parser.add_argument('--local', action='store_true')
    args = parser.parse_args()
    commit = args.expected_commit or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.root, text=True).strip()
    audit(args.root.resolve(), args.raw.resolve(), args.plan.resolve(), args.site, commit, args.output, args.local)
