"""Resumable source-first audit. Raw input and checkpoints stay outside publication.

Content, explicit mission ownership and execution order are separate claims.
BWIKI mission placement and official execution ownership are independent evidence.
No reference TXT, similarity model, ID range or source-array ordering is an input.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timezone
from collections import Counter, defaultdict
from pathlib import Path

CODE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, CODE / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


b = module('source_first_bwiki', 'bwiki-dialogue.py')
imports = module('source_first_imports', 'import-bwiki-chapters.py')
flow = module('source_first_flow', 'restore-dialogue-flow.py')
placement = module('source_first_placement', 'bwiki-placement.py')
execution_placement = module('source_first_execution_placement', 'execution-placement.py')


class ExecutionGraphs(dict):
    def __init__(self):
        super().__init__()
        self.executions = {}
        self.documents = {}
        self.tables = {}
        self.invocations = {}
        self.mission_relations = []


def read(path):
    return json.loads(Path(path).read_bytes())


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def write(path, value):
    b.write(Path(path), value, pretty=True)


def checkpoint(path, key):
    if not path.exists():
        return None
    stored = read(path)
    if stored.get('key') == key and stored.get('sha256') == digest(stored.get('result')):
        return stored['result']
    return None


def code_hash():
    files = ['source-first.py', 'source-first.mjs', 'bwiki-dialogue.py', 'bwiki-placement.py',
             'import-bwiki-chapters.py', 'import-localizations.py', 'restore-dialogue-flow.py',
             'validate-content-stage.py', 'source-first-publication.mjs', 'content-publication.mjs', 'import-trailblaze.py',
             'execution-placement.py', 'verification-state.mjs', 'update-content.mjs']
    return digest({name: hashlib.sha256((CODE / name).read_bytes()).hexdigest() for name in files})


def catalog(root, raw, plan_path):
    plan, missions, talks, cn, kr, hashes = b.inputs(raw, plan_path)
    chapters = {r['ID']: r for r in imports.read_table(raw, plan, 'MissionChapterConfig.json', hashes)}
    entries = read(root / 'src/data/trailblaze.json')
    official_missions = {m['MainMissionID']: m for m in missions if m}
    records, used, unresolved = [], set(), []
    for entry in entries:
        for chapter in entry['chapters']:
            if not chapter.get('content'):
                unresolved.append({'route': entry['id'] + '/' + chapter['id'], 'reason': 'missing-body-descriptor'})
                continue
            identity = chapter.get('upstreamChapterId')
            # Older continuance routes predate upstreamChapterId. Their explicit
            # quest list can establish one ChapterID without title/ID-range guesses.
            explicit = [official_missions.get(int(s[6:])) for s in chapter['content'].get('sourceIds', [])
                        if re.fullmatch(r'quest-\d+', s)]
            chapters_from_refs = {m.get('ChapterID') for m in explicit if m}
            if identity is None and explicit and all(explicit) and len(chapters_from_refs) == 1:
                identity = next(iter(chapters_from_refs))
            source = chapters.get(identity)
            if not source:
                unresolved.append({'route': entry['id'] + '/' + chapter['id'], 'reason': 'official-chapter-unresolved'})
                # Keep the registered chapter in the denominator, without inventing an ID.
                identity = None
            members = [m for m in missions if identity is not None and m.get('Type') in ['Main', 'Gap'] and m.get('ChapterID') == identity]
            used.update(m['MainMissionID'] for m in members)
            records.append({'id': identity, 'entryId': entry['id'], 'chapterId': chapter['id'],
                            'title': chapter['title'], 'chineseTitle': cn.get(str((source or {}).get('ChapterName', {}).get('Hash')), ''),
                            'file': chapter['content']['file'],
                            'missions': [{'id': m['MainMissionID'], 'title': b._localizations.plain(kr.get(str(m.get('Name', {}).get('Hash')), '')),
                                          'chineseTitle': cn.get(str(m.get('Name', {}).get('Hash')), ''),
                                          'takeOperation': m.get('TakeOperation'), 'takeConditions': m.get('TakeParam', []),
                                          'beginOperation': m.get('BeginOperation'), 'beginConditions': m.get('BeginParam', [])} for m in members]})
    requests, missing = b.mission_requests(missions, cn, kr, used, group_types=('Main', 'Gap'))
    return {'schema': 'hsr-source-first-catalog.v1', 'commit': plan['commit'], 'chapters': records,
            'requests': requests, 'review': unresolved + missing, 'inputHashes': hashes}, (plan, talks, cn, kr)


def structure_index(manifest, commit, verify_order=True):
    if manifest.get('schema') != 'hsr-dialogue-flow-input.v1' or manifest.get('commit') != commit:
        raise ValueError('Mixed official structure version')
    owners, graphs, evidence, issues = defaultdict(list), ExecutionGraphs(), {}, []
    for item in manifest['files']:
        match = re.fullmatch(r'(?:Config/Level/Mission|Story/(?:Discussion/)?Mission)/(\d+)/[\w./-]+\.json', item['path'])
        if not match or any(p in ['.', '..'] for p in item['path'].split('/')):
            raise ValueError('Unsafe official structure path')
        try:
            data = (Path(manifest['blobs']) / item['sha']).read_bytes()
        except FileNotFoundError:
            issues.append({'source': item['path'], 'reason': 'structure-unavailable'})
            continue
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != item['sha']:
            raise ValueError('Official structure checksum mismatch')
        document = json.loads(data)
        if not isinstance(document, dict):
            issues.append({'source': item['path'], 'reason': 'unsupported-structure-root'})
            continue
        graphs.documents[item['path']] = document
        proof = {'source': item['path'], 'missionId': int(match[1]), 'gitBlob': blob,
                 'sha256': hashlib.sha256(data).hexdigest()}
        evidence[item['path']] = proof
        if verify_order:
            local = flow.execution_slices(document)
            if local['nodes']:
                graphs.executions[item['path']] = {**local, 'proof': proof}

        def visit(value, pointer='', role=None, conditions=()):
            if isinstance(value, list):
                for i, child in enumerate(value):
                    visit(child, pointer + '/' + str(i), role, conditions)
            elif isinstance(value, dict):
                kind = value.get('$type', '').split('.')[-1]
                # Disabled/conditional references prove ownership, not that the branch executes.
                gates = {k: value[k] for k in value if k in ['Condition', 'ConditionList', 'Predicate', 'If', 'Else'] or
                         (k == 'TaskEnabled' and value[k] is not True)}
                context = conditions + (({'pointer': pointer, 'fields': gates},) if gates else ())
                typed = 'choice' if kind == 'OptionTalkInfo' else role
                if kind in ['PlayAndWaitSimpleTalk', 'PlaySimpleTalk', 'SimpleTalkInfo']:
                    typed = 'line'
                identity = value.get('TalkSentenceID')
                if type(identity) is int and identity != 999999999 and typed in ['line', 'choice']:
                    owners[(identity, typed)].append({**proof, 'pointer': pointer, 'conditions': list(context)})
                for key, child in value.items():
                    child_role = 'line' if key == 'SimpleTalkList' else 'choice' if key == 'OptionList' else typed
                    visit(child, pointer + '/' + key, child_role, context)
        visit(document)
        if verify_order:
            try:
                nodes, order = flow.scene_graph(document)
                graphs[item['path']] = {str(k): v['next'] for k, v in nodes.items()}
            except flow.Unresolved:
                issues.append({'source': item['path'], 'reason': 'execution-structure-partial-or-unsupported'})
    for item in manifest.get('tables', []):
        if not re.fullmatch(r'ExcelOutput/(?:Performance(?:A|C|D|DS|CG|E|SubMissionLink)|SubMission)\.json', item['path']):
            raise ValueError('Unsupported execution table')
        data = (Path(manifest['blobs']) / item['sha']).read_bytes()
        if hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != item['sha']:
            raise ValueError('Execution table checksum mismatch')
        graphs.tables[item['path']] = json.loads(data)
        evidence[item['path']] = {'source': item['path'], 'gitBlob': item['sha'], 'sha256': hashlib.sha256(data).hexdigest()}
    if not verify_order:
        return owners, graphs, evidence, issues
    graphs.invocations, graphs.mission_relations, invocation_review = execution_placement.invocation_index(graphs.documents, graphs.tables)
    for source, graph in graphs.executions.items():
        paths = set()
        for invocation in graphs.invocations.get(source, []):
            paths.update(invocation.get('entrySources', []))
            paths.update(invocation.get('tables', []))
            paths.update(p for p in [invocation.get('source'), invocation.get('caller')] if p)
            for call in invocation.get('callChain', []): paths.update([call['source'], call['target']])
        graph['invocationEvidence'] = {p: evidence[p] for p in paths if p in evidence}
    issues.extend(invocation_review)
    return owners, graphs, evidence, issues


def inventory(segments, page, chapter_id):
    occurrences, edges = [], {}

    def add(node, location, kind, branch, context):
        identity = 'occ-' + digest([chapter_id, page['pageId'], page['revision'], location, kind, node.get('text', '')])[:24]
        item = {'id': identity, 'page': page['pageTitle'], 'pageId': page['pageId'], 'revision': page['revision'],
                'pageSha256': page['sha256'], 'location': location, 'kind': kind, 'branch': branch,
                'context': context, 'chinese': node.get('text', ''), 'speaker': node.get('speaker', ''),
                **({'label': node['label']} if node.get('label') else {}),
                'status': 'pending', 'official': [], 'rowRefs': []}
        occurrences.append(item)
        node['_occ'] = identity
        return identity

    def walk(nodes, path, branch, context):
        for i, node in enumerate(nodes):
            loc = path + [i]
            if node['kind'] == 'choice':
                group = 'wiki-choice-' + digest([chapter_id, page['pageId'], page['revision'], loc])[:24]
                prompt = nodes[i - 1].get('_occ') if i and nodes[i - 1]['kind'] == 'line' else None
                for j, option in enumerate(node['options']):
                    identity = add(option, loc + ['choice', j], 'choice', branch, context)
                    occurrences[-1].update(choiceGroup=group, optionIndex=j + 1,
                                           optionCount=len(node['options']), promptId=prompt)
                    walk(option['body'], loc + ['body', j], branch + [identity], context)
            elif node['kind'] == 'separated':
                ctx = context + [{k: node[k] for k in ['condition', 'fold'] if k in node}]
                for j, part in enumerate(node['segments']):
                    walk(part, loc + ['separated', j], branch, ctx)
            else:
                add(node, loc, node['kind'], branch, context)

    def wire(nodes, tail):
        current = list(tail)
        for node in reversed(nodes):
            if node['kind'] == 'line':
                edges[node['_occ']] = current
                current = [node['_occ']]
            elif node['kind'] == 'choice':
                choices = []
                for option in node['options']:
                    edges[option['_occ']] = wire(option['body'], current if option['icon'] == '继续' else [])
                    choices.append(option['_occ'])
                current = choices
            elif node['kind'] == 'separated':
                for part in node['segments']:
                    wire(part, [])
                current = []
            else:
                current = []
        return current

    for i, nodes in enumerate(segments):
        walk(nodes, [i], [], [])
        wire(nodes, [])
    return occurrences, edges


def global_candidates(talks, cn, kr):
    result = defaultdict(list)
    for talk in talks:
        if not talk:
            continue
        th = str(talk.get('TalkSentenceText', {}).get('Hash'))
        sh = str(talk.get('TextmapTalkSentenceName', {}).get('Hash'))
        if not cn.get(th) or not kr.get(th):
            continue
        name = cn.get(sh, '')
        if sh not in ['None', '0'] and (not name or not kr.get(sh)):
            continue
        record = {'talkId': talk['TalkSentenceID'], 'textHash': th,
                  'text': b._localizations.plain(kr[th]), 'speaker': b._localizations.plain(kr.get(sh, '')),
                  'chineseHash': b.digest(b.canonical(cn[th])), 'speakerHash': b.digest(b.canonical(name)),
                  'koreanHash': b.digest(b._localizations.plain(kr[th]))}
        result[('line', b.comparable(cn[th]), b.normalized(name))].append(record)
        if not b.normalized(name) and not record['speaker']:
            result[('narration', b.comparable(cn[th]), '')].append(record)
        if not name or b.normalized(name) == '开拓者':
            result[('choice', b.comparable(cn[th]), '')].append(record)
    return result


def reachable(graph, start, end):
    seen, stack = set(), [start]
    while stack:
        value = stack.pop()
        if value in seen:
            continue
        seen.add(value)
        for target in graph.get(str(value), []):
            if target == end:
                return True
            stack.append(target)
    return False


def classify_order(left, right, owners, graphs):
    """Compare only matching explicit scopes; adjacency is not total game order."""
    if not left.get('official') or not right.get('official'):
        return 'unresolved-endpoint'
    a, z = left['official'][0]['talkId'], right['official'][0]['talkId']
    ls = {p['source'] for p in owners.get((a, 'line' if left['kind'] == 'narration' else left['kind']), []) if not p['conditions']}
    rs = {p['source'] for p in owners.get((z, 'line' if right['kind'] == 'narration' else right['kind']), []) if not p['conditions']}
    common = ls & rs & graphs.keys()
    # A choice branch/condition must have its execution condition mapped first.
    if not common or left['branch'] != right['branch'] or left['context'] != right['context']:
        return 'execution-scope-unverified'
    if any(reachable(graphs[s], z, a) for s in common):
        return 'potential-order-conflict'  # Same file alone does not identify an invocation.
    if any(reachable(graphs[s], a, z) for s in common):
        return 'compatible-local-order'
    return 'execution-scope-unverified'


def match_occurrence(node, index, owners, mission_ids, existing, wiki_scope=None):
    if node['kind'] in ['barrier', 'unsupported']:
        node.update(status='boundary' if node['kind'] == 'barrier' else 'unsupported')
        return
    key = (node['kind'], b.comparable(node['chinese']), b.normalized(node['speaker']))
    # Empty normalized punctuation must never match or merge with a neighbour.
    if not key[1]:
        node.update(reason='empty-normalized-content')
        return
    candidates = list({r['talkId']: r for r in index.get(key, [])}.values())
    node['candidateTalkIds'] = [r['talkId'] for r in candidates]
    shared = len(candidates) > 1 and wiki_scope is not None and placement.same_content(candidates)
    if len(candidates) != 1 and not shared:
        node.update(reason='ambiguous-official-ids' if candidates else 'no-exact-official-candidate')
        return
    # rowRefs are storage references for identical official text, never a guess
    # that one of several official IDs is the ID of this wiki occurrence.
    candidates.sort(key=lambda r: (not bool(existing.get(r['talkId'])), r['talkId']))
    record = candidates[0]
    node.update(official=candidates, contentStatus='exact-official',
                method='exact-shared-official-text' if shared else 'exact-official',
                idStatus='unresolved-identical-text' if shared else 'unique')
    node['rowRefs'] = [r['id'] for candidate in candidates for r in existing.get(candidate['talkId'], [])
                       if r['text'] == record['text'] and r['speaker'] == record['speaker'] and
                       (r['type'] == 'choice') == (node['kind'] == 'choice') and
                       (node['kind'] != 'narration' or r['type'] == 'narration')]
    proofs = owners.get((record['talkId'], 'line' if node['kind'] == 'narration' else node['kind']), [])
    matching = [p for p in proofs if p['missionId'] in mission_ids]
    owned = {p['missionId'] for p in matching}
    node['officialMissionIds'] = sorted({p['missionId'] for p in proofs})
    if wiki_scope is not None:
        # This scope is supplied only after page hash, mission title and official
        # chapter-series validation. It never asserts an official execution call.
        if not mission_ids:
            node.update(status='content-only', reason='ambiguous-wiki-mission', ownership=matching)
            return
        mission = placement.mission_group(wiki_scope['chapterId'], wiki_scope['page'])
        node.update(status='wiki-confirmed', missionId=mission, missionEvidence='bwiki',
                    ownership=matching, wikiProof={**wiki_scope, 'missionId': mission, 'catalogMissionIds': sorted(mission_ids),
                        'location': node['location'], 'branch': node['branch'], 'conditions': node['context']},
                    officialOwnershipStatus='confirmed' if len(owned) == 1 else
                        'disagrees' if proofs and not owned else 'unverified')
        return
    if len(owned) != 1:
        node.update(status='content-only', reason='official-mission-ownership-unverified', ownership=matching)
        return
    node.update(status='confirmed', missionId=next(iter(owned)), ownership=matching)


def audit_chapter(record, payload, pages, index, owners, graphs, reviewed=None, cache=None):
    occurrences, edges, reviews, sources, documents = [], {}, [], [], []
    grouped = defaultdict(set)
    for m in record['missions']:
        grouped[m['chineseTitle']].add(m['id'])
    existing = defaultdict(list)
    for row in payload['rows']:
        if row.get('talkId'):
            existing[row['talkId']].append(row)
    for title, mission_ids in grouped.items():
        page = pages.get(title)
        def document_result(value):
            if cache:
                work, version = cache
                write(work / 'missions' / f"{record['id']}-{digest(title)[:16]}.json",
                      {'missionIds': sorted(mission_ids), 'page': title, 'version': version, **value})
        if not title or not page or page.get('status') != 'available':
            reviews.append({'page': title, 'missionIds': sorted(mission_ids), 'reason': (page or {}).get('reason', 'page-unavailable')})
            document_result({'status': 'pending', 'reason': reviews[-1]['reason']})
            continue
        try:
            data = Path(page['file']).read_bytes()
            if hashlib.sha256(data).hexdigest() != page['sha256']:
                raise b.Unresolved('wiki-checksum-mismatch')
            doc_key = digest([cache[1] if cache else {}, record, payload, page['revision'], page['sha256'], title,
                              page.get('retrieval') == 'cache-pinned'])
            doc_path = cache[0] / 'document-results' / (doc_key + '.json') if cache else None
            prior = checkpoint(doc_path, doc_key) if doc_path else None
            if prior:
                occurrences.extend(prior['nodes'])
                edges.update(prior['graph'])
                sources.extend(prior['sources'])
                documents.extend(prior.get('documents', []))
                reviews.extend(prior['review'])
                document_result({'status': 'audited', 'key': doc_key, 'reused': True})
                continue
            fields = b.validate_mission_page(data.decode('utf-8'), title)
            if b.normalized(b.inline(fields.get('系列任务', ''))) != b.normalized(record['chineseTitle']):
                raise b.Unresolved('official-chapter-series-mismatch')
            nodes, graph = inventory(b.story_segments(data.decode('utf-8'), True, True), page, record['id'])
        except (b.Unresolved, FileNotFoundError) as error:
            reviews.append({'page': title, 'missionIds': sorted(mission_ids), 'reason': str(error)})
            document_result({'status': 'pending', 'reason': str(error)})
            continue
        source = {k: page[k] for k in ['pageTitle', 'pageId', 'revision', 'sha256']}
        source['title'] = title
        document = {'pageTitle': page['pageTitle'], 'fields': fields,
                    'objectives': {k: v for k, v in fields.items() if any(word in k for word in ['目标', '条件', '地点'])}}
        documents.append(document)
        source.update(sourceUrl='https://wiki.biligame.com/sr/' + b.quote(page['pageTitle']) + '?oldid=' + str(page['revision']),
                      historyUrl='https://wiki.biligame.com/sr/' + b.quote(page['pageTitle']) + '?action=history',
                      timestamp=page.get('timestamp'), collectedAt=page.get('collectedAt'))
        sources.append(source)
        document_reviews = []
        if page.get('retrieval') == 'cache-pinned':
            document_reviews.append({'page': title, 'reason': 'live-revision-unavailable-pinned-snapshot-only'})
            reviews.extend(document_reviews)
        for node in nodes:
            wiki_scope = {'kind': 'bwiki-mission', 'chapterId': record['id'],
                          'page': page['pageTitle'], 'pageId': page['pageId'], 'revision': page['revision'],
                          'sha256': page['sha256'], 'source': source['sourceUrl']}
            match_occurrence(node, index, owners, mission_ids, existing, wiki_scope)
            # Only prior human-reviewed, fully pinned correspondences can be replayed.
            candidates = [r for r in (reviewed or {}).values() if r['page'] == page['pageTitle'] and
                          r['revision'] == page['revision'] and r['pageSha256'] == page['sha256'] and
                          ('choice' if r['type'] == 'choice' else 'line') == node['kind'] and
                          b.comparable(r['wikiText']) == b.comparable(node['chinese']) and
                          b.normalized(r['wikiSpeaker']) == b.normalized(node['speaker'])]
            if node['status'] == 'pending' and len(candidates) == 1:
                review = candidates[0]
                row = next(r for r in payload['rows'] if r['id'] == review['rowId'])
                official = {'talkId': row['talkId'], 'textHash': str(row.get('textHash', '')),
                            'text': row['text'], 'speaker': row['speaker'],
                            **{k: review[k] for k in ['chineseHash', 'speakerHash', 'koreanHash']}}
                temporary = {**node, 'chinese': 'pinnedreview'}
                match_occurrence(temporary, {(node['kind'], 'pinnedreview', b.normalized(node['speaker'])): [official]}, owners, mission_ids, existing, wiki_scope)
                node.update({k: v for k, v in temporary.items() if k != 'chinese'})
                node.update(method='translation-reviewed-pinned', translationReviewHash=b.translation_review_hash(review))
        occurrences.extend(nodes)
        edges.update(graph)
        if doc_path:
            saved = {'nodes': nodes, 'graph': graph, 'sources': [source], 'documents': [document], 'review': document_reviews}
            write(doc_path, {'key': doc_key, 'sha256': digest(saved), 'result': saved})
        document_result({'status': 'audited', 'key': doc_key, 'reused': False})
    by_id = {o['id']: o for o in occurrences}
    # The wiki already supplies display order. No separate game-order verdict
    # is computed or required for publishing that document order.
    orders = []
    # Unresolved endpoints are retained in the source graph, never bridged.
    confirmed = {o['id'] for o in occurrences if o['status'] in ['confirmed', 'wiki-confirmed']}
    safe_edges = {a: [z for z in targets if z in confirmed] for a, targets in edges.items() if a in confirmed}
    speech = [o for o in occurrences if o['kind'] in ['line', 'choice', 'narration']]
    counts = Counter(o['status'] for o in speech)
    mission_reports = []
    for m in record['missions']:
        page_nodes = [n for n in speech if n['page'] == pages.get(m['chineseTitle'], {}).get('pageTitle')]
        local = [n for n in page_nodes if m['id'] in n.get('wikiProof', {}).get('catalogMissionIds', [])]
        mission_reports.append({**m, 'baselineRows': sum(r.get('missionId') == 'quest-' + str(m['id']) for r in payload['rows']),
                                'documentShared': len(grouped[m['chineseTitle']]) > 1,
                                'documentOccurrences': len(page_nodes), 'confirmedOccurrences': len(local),
                                'pendingOrContentOnlyOccurrences': sum(n['status'] not in ['confirmed', 'wiki-confirmed'] for n in page_nodes),
                                'status': 'audited-partial' if page_nodes else 'pending-document',
                                'localOrder': 'partial', 'wholePath': 'unverified'})
    return {'schema': 'hsr-source-first-chapter.v1', 'chapter': record, 'baselineRows': len(payload['rows']),
            'baselineLinkedRows': sum(r.get('bwikiStatus') in ['matched', 'cached'] for r in payload['rows']),
            'sources': sources, 'documents': documents, 'missions': mission_reports, 'occurrences': occurrences, 'wikiGraph': edges, 'confirmedWikiGraph': safe_edges,
            'orderComparisons': orders, 'review': reviews,
            'choiceCoverage': choice_coverage(occurrences),
            'counts': {'allParsedUnits': len(occurrences), 'speechOccurrences': len(speech),
                       'status': dict(counts), 'boundaries': sum(o['kind'] == 'barrier' for o in occurrences),
                       'unsupported': sum(o['kind'] == 'unsupported' for o in occurrences),
                       'unavailableDocuments': sum('missionIds' in r for r in reviews),
                       'uniqueOfficialContentIds': len({r['talkId'] for o in speech for r in o['official']}),
                       'newConfirmedIds': len({o['official'][0]['talkId'] for o in speech if o['status'] in ['confirmed', 'wiki-confirmed'] and not existing.get(o['official'][0]['talkId'])})},
            'verification': {'content': 'partial', 'localOrder': 'bwiki-display', 'wholePath': 'unverified',
                             'separateOrderVerification': False,
                             'referenceTxtUsed': False, 'crossBoundaryEdges': 0}}


def choice_coverage(nodes):
    groups = defaultdict(list)
    by_id = {n['id']: n for n in nodes}
    for node in nodes:
        if node.get('choiceGroup'):
            groups[node['choiceGroup']].append(node)
    return [{'groupId': key, 'page': values[0]['page'], 'expected': values[0]['optionCount'],
             'matched': sum(n['status'] == 'wiki-confirmed' for n in values),
             'unmatchedOptions': [n['id'] for n in values if n['status'] != 'wiki-confirmed'],
             'promptId': values[0].get('promptId'),
             'promptMatched': by_id.get(values[0].get('promptId'), {}).get('status') == 'wiki-confirmed'}
            for key, values in groups.items()]


def add_confirmed(payload, result):
    """Append source records only; preserve every prior row and traversal edge."""
    value = copy.deepcopy(payload)
    present = {r.get('talkId') for r in value['rows']}
    additions = []
    blocked = {edge[k] for edge in result['orderComparisons'] if edge['officialComparison'] == 'potential-order-conflict' for k in ['from', 'to']}
    for node in result['occurrences']:
        wiki = node['status'] == 'wiki-confirmed'
        if (not wiki and node['status'] != 'confirmed') or (not wiki and node['id'] in blocked):
            continue
        r = node['official'][0]
        if r['talkId'] in present:
            continue
        proof = node['wikiProof'] if wiki else node['ownership'][0]
        mission_title = (' / '.join(dict.fromkeys(m['title'] for m in result['chapter']['missions']
                         if m['id'] in proof['catalogMissionIds'])) if wiki else
                         next(m['title'] for m in result['chapter']['missions'] if m['id'] == node['missionId']))
        identity = f"official-{value['entryId']}-{value['chapterId']}-talk-{r['talkId']}"
        row = {'id': identity, 'entryId': value['entryId'], 'chapterId': value['chapterId'],
               'missionId': node['missionId'] if wiki else 'quest-' + str(node['missionId']), 'mission': mission_title,
               'scene': mission_title + ' · 추가 원문 · 순서 미확인',
               'type': 'choice' if node['kind'] == 'choice' else 'dialogue' if r['speaker'] else 'narration', 'talkId': r['talkId'],
               'textHash': r['textHash'], 'text': r['text'], 'speaker': r['speaker'],
               'source': f"ExcelOutput/TalkSentenceConfig.json#TalkSentenceID={r['talkId']}" if wiki else proof['source'],
               'flowStatus': 'review', 'flowBoundary': True, 'bwikiStatus': 'review'}
        if wiki:
            row.update(missionEvidence='bwiki', bwikiMissionId=row['missionId'], bwikiMission=row['mission'])
        value['rows'].append(row)
        present.add(r['talkId'])
        additions.append({'rowId': identity, 'talkId': r['talkId'], 'missionId': node['missionId'],
                          'occurrence': node['id'], 'proof': proof, 'content': r})
    # Canonical rows stay stable; occurrence-level BWIKI layout supplies display
    # order and responses, independently of the optional execution projection.
    for field in ['referenceOrder', 'bwikiBaseOrder']:
        if field in value:
            value[field] += [a['rowId'] for a in additions]
    if additions and 'bwiki' in value:
        value['bwiki']['reviewRows'] = sum(r.get('bwikiStatus') == 'review' for r in value['rows'])
    return value, additions


def valid_execution_rows(rows, talks, cn, kr):
    return {r['id']: proof for r in rows if (proof := b.row_evidence(r, talks, cn, kr)) and
            # OptionTalkInfo establishes the actor role even when the table has
            # no speaker name and the old UI used a missing-speaker placeholder.
            (r['type'] == 'choice' or
             b._localizations.plain(kr.get(str(talks[r['talkId']].get('TextmapTalkSentenceName', {}).get('Hash')), '')) == r['speaker'])}


def add_execution_confirmed(payload, record, graphs, talks, cn, kr):
    """New originals require an explicit reachable mission -> performance call."""
    present = {r.get('talkId') for r in payload['rows']}
    missions = {m['id'] for m in record['missions']}
    candidates = defaultdict(list)
    for source, graph in graphs.executions.items():
        owner = graph['proof']['missionId']
        invocations = graphs.invocations.get(source, [])
        if owner not in missions or {p['mainMissionId'] for p in invocations} != {owner}: continue
        for pointer, node in graph['nodes'].items():
            if node['status'] != 'confirmed' or node['talkId'] in present: continue
            talk = talks.get(node['talkId'])
            if not talk: continue
            th = str(talk.get('TalkSentenceText', {}).get('Hash'))
            sh = str(talk.get('TextmapTalkSentenceName', {}).get('Hash'))
            if not kr.get(th) or not cn.get(th) or (sh not in ['None', '0'] and (not cn.get(sh) or not kr.get(sh))): continue
            content = {'talkId': node['talkId'], 'textHash': th,
                'text': b._localizations.plain(kr[th]), 'speaker': b._localizations.plain(kr.get(sh, '')),
                'chineseHash': b.digest(b.canonical(cn[th])), 'speakerHash': b.digest(b.canonical(cn.get(sh, ''))),
                'koreanHash': b.digest(b._localizations.plain(kr[th]))}
            candidates[node['talkId']].append({'id': 'exec-admission-' + digest([source, pointer, node['talkId']])[:24],
                'kind': node['type'], 'status': 'confirmed', 'missionId': owner, 'official': [content],
                'ownership': [{**graph['proof'], 'pointer': pointer, 'conditions': node['conditions'], 'invocations': invocations}]})
    selected = [values[0] for values in candidates.values()
                if len({(v['missionId'], v['kind']) for v in values}) == 1]
    return add_confirmed(payload, {'chapter': record, 'occurrences': selected, 'orderComparisons': []})


def extend_wiki_partition(payload, additions):
    wiki = payload.get('wikiReading')
    if not wiki or not additions: return
    rows = {r['id']: r for r in payload['rows']}
    for addition in additions:
        row = rows[addition['rowId']]
        group = next((g for g in wiki['unplaced'] if g['id'] == row['missionId']), None)
        if group is None:
            group = {'id': row['missionId'], 'title': row['mission'], 'rowIds': []}
            wiki['unplaced'].append(group)
        group['rowIds'].append(row['id'])
    wiki['canonicalRowsHash'] = placement.digest({r['id']: placement.canonical(r) for r in payload['rows']})
    wiki['summary']['unplacedRows'] += len(additions)


def refresh_added_views(root, records, count):
    """Use the standard canonical search/metadata projection for either admission path."""
    if not count: return []
    metadata, entries = read(root / 'src/data/imported-content.json'), read(root / 'src/data/trailblaze.json')
    search = read(root / 'public/content/search-index.json')
    groups = defaultdict(list)
    for row in search['rows']: groups[row['entryId'] + '/' + row['chapterId']].append(row)
    for record in records:
        body = read(root / 'public' / record['file'])
        route = record['entryId'] + '/' + record['chapterId']
        metadata[route]['rows'] = len(body['rows'])
        for entry in entries:
            for chapter in entry['chapters']:
                if entry['id'] == record['entryId'] and chapter['id'] == record['chapterId']:
                    chapter['content'] = copy.deepcopy(metadata[route])
        groups[route] = [{k: v for k, v in row.items() if k not in ['missionId', 'talkId', 'source']} |
                        {'source': b.digest(row['source'])[:16]} for row in body['rows']]
    search['rows'] = [row for group in groups.values() for row in group]
    write(root / 'src/data/imported-content.json', metadata)
    write(root / 'src/data/trailblaze.json', entries)
    b.write(root / 'public/content/search-index.json', search)
    update = read(root / 'public/content-update.json')
    update['rows'] = len(search['rows']); update['verifiedTextRows'] += count
    write(root / 'public/content-update.json', update)
    wiki = read(root / 'public/bwiki-provenance.json')
    wiki.setdefault('totals', {})['reviewRows'] = wiki.get('totals', {}).get('reviewRows', 0) + count
    b.write(root / 'public/bwiki-provenance.json', wiki)
    return ['src/data/imported-content.json', 'src/data/trailblaze.json', 'public/content/search-index.json',
            'public/content-update.json', 'public/bwiki-provenance.json']


def preserve_execution(args, cat, plan):
    """Retain old execution evidence; only rebind its unchanged row references.

    New BWIKI content is not required to have an execution call. No execution
    nodes, edges, calls or order comparisons are generated here.
    """
    report = {'status': 'retained', 'candidateAdditions': 0, 'chapters': [],
              'separateOrderVerification': False}
    for record in cat['chapters']:
        payload = read(args.root / 'public' / record['file'])
        reading = payload.get('executionReading')
        if reading:
            if reading.get('displayOrderPolicy') != 'bwiki-only' or reading.get('placements'):
                raise ValueError('Legacy execution display must be migrated before preserving evidence')
            reading['canonicalRowsHash'] = execution_placement.digest([execution_placement.canonical(r) for r in payload['rows']])
            reading['wikiReadingHash'] = execution_placement.digest(payload.get('wikiReading', {}))
            reading['verificationMode'] = 'retained-no-order-audit'
            execution_placement.validate(reading, payload['rows'], plan['commit'], payload.get('wikiReading'))
            if args.apply:
                write(args.root / 'public' / record['file'], payload)
        report['chapters'].append({'file': record['file'], 'reading': payload.get('wikiReading', {}).get('summary'),
                                  'summary': {'newOfficialRows': 0, 'verificationMode': 'retained-no-order-audit'}})
    flow_file = args.root / 'public/dialogue-flow-provenance.json'
    if args.apply and flow_file.exists():
        proof = read(flow_file)
        proof.setdefault('evidenceCommit', proof['commit'])
        proof.update(commit=plan['commit'], verificationMode='retained-no-order-audit')
        write(flow_file, proof)
        receipt_file = args.root / 'receipt.json'
        receipt = read(receipt_file) if receipt_file.exists() else {'files': []}
        receipt['files'] = sorted(set(receipt['files'] + ['public/dialogue-flow-provenance.json']))
        write(receipt_file, receipt)
    write(args.work / 'execution-report.json', report)


def audit_execution_only(args, cat, plan, talks, cn, kr):
    """Extend the deployed snapshot; do not rerun BWIKI collection or rematching."""
    policy = validated_policy()
    owners, graphs, proofs, issues = structure_index(read(args.work / 'structures.json'), plan['commit'])
    version = {'commit': plan['commit'], 'codeHash': code_hash(), 'policyHash': digest(policy),
        'policyVersion': policy['version'], 'displayOrder': policy['displayOrder'],
        'officialInputs': cat['inputHashes'], 'structureHashes': digest(proofs)}
    talk_table = {t['TalkSentenceID']: t for t in talks if t}
    report = {'schema': 'hsr-execution-audit.v1', **version, 'status': 'running', 'chapters': [],
              'structureReview': issues, 'referenceTxtUsed': False, 'wikiRematched': False}
    changed, total_added = [], 0
    for record in cat['chapters']:
        if args.title and record['title'] != args.title:
            continue
        payload = read(args.root / 'public' / record['file'])
        if payload.get('textReferenceCommit', payload['referenceCommit']) != plan['commit']:
            raise ValueError('Mixed execution baseline release')
        payload, added = add_execution_confirmed(payload, record, graphs, talk_table, cn, kr)
        extend_wiki_partition(payload, added)
        total_added += len(added)
        valid = valid_execution_rows(payload['rows'], talk_table, cn, kr)
        reading, review = execution_placement.build(payload, record, graphs.executions, valid, version,
            graphs.invocations, graphs.mission_relations, added)
        previous_execution = payload.get('executionReading', {})
        reading['displayOrderPolicy'] = 'bwiki-only'
        reading['legacyDisplayPlacements'] = previous_execution.get('legacyDisplayPlacements', previous_execution.get('placements', []))
        review['missingOriginals'] = []
        for item in review['review']:
            if item.get('reason') != 'official-row-missing':
                continue
            talk = talk_table.get(item['talkId'], {})
            th = str(talk.get('TalkSentenceText', {}).get('Hash'))
            sh = str(talk.get('TextmapTalkSentenceName', {}).get('Hash'))
            review['missingOriginals'].append({**item, 'textHash': th,
                'officialKorean': kr.get(th), 'officialChinese': cn.get(th),
                'koreanSpeaker': kr.get(sh, ''), 'admission': 'isolated-candidate; invocation-review-required'})
        execution_placement.validate(reading, payload['rows'], plan['commit'], payload.get('wikiReading'))
        report['chapters'].append({'file': record['file'], 'title': record['title'],
            'missionCount': len(record['missions']), 'summary': reading['summary'],
            'reading': payload.get('wikiReading', {}).get('summary'),
            'missingOfficialCandidates': len({r['talkId'] for r in review['missingOriginals']})})
        write(args.work / 'execution-results' / (str(record['id']) + '-' + record['chapterId'] + '.json'), review)
        if args.apply:
            payload['executionReading'] = reading
            write(args.root / 'public' / record['file'], payload)
            changed.append('public/' + record['file'])
        write(args.work / 'execution-progress.json', report)
        print(json.dumps(report['chapters'][-1], ensure_ascii=False), flush=True)
    report.update(status='completed', candidateAdditions=total_added)
    write(args.work / 'execution-report.json', report)
    if args.apply:
        changed.extend(refresh_added_views(args.root, cat['chapters'], total_added))
        provenance = read(args.root / 'public/dialogue-flow-provenance.json')
        provenance['executionAudit'] = {**version, 'chapters': report['chapters'], 'wholeGamePathVerified': False}
        write(args.root / 'public/dialogue-flow-provenance.json', provenance)
        receipt = read(args.root / 'receipt.json') if (args.root / 'receipt.json').exists() else {'files': []}
        receipt['files'] = sorted(set(receipt['files'] + changed + ['public/dialogue-flow-provenance.json']))
        receipt['rows'] = read(args.root / 'public/content-update.json')['rows']
        write(args.root / 'receipt.json', receipt)


def validated_policy():
    policy = read(CODE.parent / 'editorial/source-first-policy.json')
    if (policy.get('version') != 6 or policy.get('requireExplicitMissionOwnership') is not False or
            policy.get('separateOrderVerification') is not False or
            policy.get('ambiguousOfficialIds') != 'share-identical-official-text-with-candidates-preserved' or
            policy.get('narrationEvidence') != 'exact-official-unnamed-text-and-validated-bwiki-position' or
            policy.get('admissionEvidence') != 'exact-official-content-and-validated-bwiki-mission' or
            policy.get('missionAttribution') != 'bwiki-display-separate-from-official-execution' or
            policy.get('displayOrder') != 'bwiki-only' or
            policy.get('newSemanticMatches') != 'candidate-only' or
            policy.get('wikiPositionEdges') != 'wiki-display-only-never-official-execution' or
            policy.get('publishUnknownEdges') is not False):
        raise ValueError('Unsupported or weakened source-first policy')
    return policy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('raw', type=Path)
    parser.add_argument('plan', type=Path)
    parser.add_argument('work', type=Path)
    parser.add_argument('--discover', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--execution-only', action='store_true')
    parser.add_argument('--preserve-execution', action='store_true')
    parser.add_argument('--title')
    args = parser.parse_args()
    cat, (plan, talks, cn, kr) = catalog(args.root, args.raw, args.plan)
    if args.execution_only:
        return audit_execution_only(args, cat, plan, talks, cn, kr)
    if args.preserve_execution:
        return preserve_execution(args, cat, plan)
    args.work.mkdir(parents=True, exist_ok=True)
    write(args.work / 'catalog.json', cat)
    if args.discover:
        write(args.work / 'request.json', {'schema': 'hsr-bwiki-request.v1', 'commit': plan['commit'], 'requests': cat['requests'], 'review': cat['review']})
        print(json.dumps({'chapters': len(cat['chapters']), 'missions': sum(len(c['missions']) for c in cat['chapters']), 'documents': len(cat['requests'])}))
        return
    policy = validated_policy()
    manifest = read(args.work / 'manifest.json')
    if manifest.get('schema') != 'hsr-bwiki-input.v1' or manifest['commit'] != plan['commit']:
        raise ValueError('Mixed wiki input version')
    structures = read(args.work / 'structures.json')
    owners, graphs, structure_proofs, structure_review = structure_index(structures, plan['commit'], verify_order=False)
    index = global_candidates(talks, cn, kr)
    pages = {p['title']: p for p in manifest['pages']}
    version = {'codeHash': code_hash(), 'policyHash': digest(policy), 'policyVersion': policy['version'],
               'displayOrder': policy['displayOrder'],
               'officialInputs': cat['inputHashes'], 'commit': plan['commit'], 'structureHashes': digest(structure_proofs),
               'reviewRegistryHash': hashlib.sha256((CODE.parent / 'editorial/bwiki-translation-matches.json').read_bytes()).hexdigest()}
    summary = {'schema': 'hsr-source-first-run.v1', **version, 'chapters': [], 'catalogReview': cat['review'],
               'structureReview': structure_review, 'collectionReview': structures.get('review', []),
               'referenceTxtUsed': False, 'productionWritten': False, 'status': 'running',
               'startedAt': datetime.now(timezone.utc).isoformat(), 'runId': os.environ.get('GITHUB_RUN_ID'),
               'registeredChapters': len(cat['chapters']),
               'officialMissions': sum(len(c['missions']) for c in cat['chapters'])}
    progress = args.work / 'progress.json'
    public = {'schema': 'hsr-source-first-provenance.v1', 'commit': plan['commit'], **version,
              'license': manifest.get('license'), 'chapters': {}}
    previous_path = args.root / 'public/source-first-provenance.json'
    previous = read(previous_path) if previous_path.exists() else {}
    previous_wiki = read(args.root / 'public/bwiki-provenance.json')
    registry = read(CODE.parent / 'editorial/bwiki-translation-matches.json')
    source_records = {f"{p['pageTitle']}@{p['revision']}": {'sha256': p['sha256']}
                      for p in manifest['pages'] if p.get('status') == 'available'}
    talk_table = {t['TalkSentenceID']: t for t in talks if t}
    changed, total_added = [], 0
    for record in cat['chapters']:
        payload = read(args.root / 'public' / record['file'])
        if payload.get('textReferenceCommit', payload['referenceCommit']) != plan['commit']:
            raise ValueError('Mixed baseline Korean input version')
        titles = {m['chineseTitle'] for m in record['missions']}
        selected = [{k: p.get(k) for k in ['title', 'status', 'reason', 'pageTitle', 'pageId', 'revision', 'sha256']} |
                    {'pinnedOnly': p.get('retrieval') == 'cache-pinned'} for p in manifest['pages'] if p['title'] in titles]
        # Rehash source bytes before permitting a checkpoint replay.
        page_bytes = {p['title']: hashlib.sha256(Path(p['file']).read_bytes()).hexdigest()
                      for p in manifest['pages'] if p['title'] in titles and p.get('status') == 'available' and Path(p.get('file', '')).is_file()}
        key = digest([version, record, payload, selected, page_bytes])
        target = args.work / 'results' / (key + '.json')
        result = checkpoint(target, key)
        reused = result is not None
        if result is None:
            row_evidence = {r['id']: b.row_evidence(r, talk_table, cn, kr) for r in payload['rows']}
            reviewed = b.validated_translation_reviews(registry['reviews'], record['file'], payload['rows'], row_evidence, source_records)
            result = audit_chapter(record, payload, pages, index, owners, graphs, reviewed, (args.work, version))
            write(target, {'key': key, 'sha256': digest(result), 'result': result})
        candidate, added = add_confirmed(payload, result)
        candidate['wikiReading'] = placement.build(record, candidate, result, talks, cn, kr, owners,
            previous_wiki.get('chapters', {}).get(record['file'], []), b, imports, {**version, 'commit': plan['commit']}, content_index=index)
        retained_proofs, unverified_prior = [], []
        by_id = {r['id']: r for r in payload['rows']}
        for prior in previous.get('chapters', {}).get(record['file'], {}).get('additions', []):
            row = by_id.get(prior['rowId'])
            node = next((o for o in result['occurrences'] if o['status'] in ['confirmed', 'wiki-confirmed'] and
                         any(r['talkId'] == prior['talkId'] for r in o['official']) and
                         (o['missionId'] == prior['missionId'] or prior['missionId'] in o.get('wikiProof', {}).get('catalogMissionIds', []))), None)
            content = next((r for r in node['official'] if r['talkId'] == prior['talkId']), None) if node else None
            if row and node and row.get('missionEvidence') == 'bwiki' and node['status'] == 'wiki-confirmed' and row['text'] == content['text'] and row['speaker'] == content['speaker']:
                retained_proofs.append({**prior, 'occurrence': node['id'], 'content': content, 'proof': node['wikiProof']})
            elif row and node and row['text'] == node['official'][0]['text'] and row['source'] in {p['source'] for p in node['ownership']}:
                retained_proofs.append({**prior, 'occurrence': node['id'], 'content': node['official'][0],
                                        'proof': next(p for p in node['ownership'] if p['source'] == row['source'])})
            elif row:
                unverified_prior.append({'rowId': row['id'], 'reason': 'previous-source-first-proof-not-currently-reproducible',
                                         'previousCommit': previous.get('commit'), 'previousProof': prior})
        summary['chapters'].append({'id': record['id'], 'file': record['file'], 'title': record['title'],
                                    'missionCount': len(record['missions']), 'baselineRows': len(payload['rows']),
                                    'counts': result['counts'], 'candidateAdditions': len(added),
                                    'verification': result['verification'], 'result': str(target), 'reused': reused,
                                    'orderComparisonCounts': dict(Counter(e['officialComparison'] for e in result['orderComparisons'])),
                                    'missions': result['missions'],
                                    'reading': candidate['wikiReading']['summary'],
                                    'review': result['review']})
        summary.update(updatedAt=datetime.now(timezone.utc).isoformat(), lastProcessedChapter=record['file'],
                       pendingChapters=[c['file'] for c in cat['chapters'][len(summary['chapters']):]])
        write(progress, summary)
        # Keep the complete candidate inventory/graph in resumable checkpoints.
        # Public provenance contains every added row's location/proof and aggregate
        # pending counts, without shipping the full raw-candidate index to readers.
        published_occurrences = {a['occurrence'] for a in retained_proofs + added}
        public['chapters'][record['file']] = {'chapterId': record['id'], 'title': record['title'], 'sources': result['sources'], 'counts': result['counts'],
            'missions': result['missions'],
            'verification': result['verification'], 'additions': retained_proofs + added, 'retainedUnverifiedRows': unverified_prior,
            'reading': candidate['wikiReading']['summary'],
            'choiceCoverage': result['choiceCoverage'],
            'occurrences': [{k: v for k, v in o.items() if k not in ['chinese', 'speaker', 'official', 'ownership']}
                            | {'officialIds': [r['talkId'] for r in o['official']]}
                            | ({'equivalentContent': o['official']} if o.get('method') == 'exact-shared-official-text' else {})
                            for o in result['occurrences'] if o['id'] in published_occurrences],
            'wikiGraph': {}, 'orderComparisonCounts': dict(Counter(e['officialComparison'] for e in result['orderComparisons'])),
            'orderReview': [e for e in result['orderComparisons'] if e['officialComparison'] == 'potential-order-conflict'],
            'inventoryKey': key, 'inventorySha256': digest(result), 'review': result['review']}
        if args.apply:
            write(args.root / 'public' / record['file'], candidate)
            changed.append('public/' + record['file'])
        if args.apply:
            total_added += len(added)
        print(json.dumps({'chapter': record['id'], 'counts': result['counts'], 'additions': len(added), 'reused': reused}), flush=True)
    summary.update(status='completed', candidateAdditions=sum(c['candidateAdditions'] for c in summary['chapters']),
                   registeredChapters=len(cat['chapters']), officialMissions=sum(len(c['missions']) for c in cat['chapters']))
    write(progress, summary)
    write(args.work / 'report.json', summary)
    if args.apply:
        changed.extend(refresh_added_views(args.root, cat['chapters'], total_added))
        # Publish audit only after the complete run. Checkpoints/raw material are never copied.
        b.write(args.root / 'public/source-first-provenance.json', public)
        receipt_path = args.root / 'receipt.json'
        receipt = read(receipt_path) if receipt_path.exists() else {'files': []}
        receipt.update(rows=read(args.root / 'public/content-update.json')['rows'])
        receipt['files'] = sorted(set(receipt['files'] + changed + ['public/source-first-provenance.json']))
        write(receipt_path, receipt)
    print(json.dumps({'completedChapters': len(summary['chapters']), 'officialMissions': summary['officialMissions'], 'candidateAdditions': summary['candidateAdditions'], 'stageAdded': total_added}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Unexpected shared validator failures propagate: no caller may publish this stage.
        raise
