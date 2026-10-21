"""Resumable source-first audit. Raw input and checkpoints stay outside publication.

Content, explicit mission ownership and execution order are separate claims.
The only automatic additions have a typed reference in a hash-verified mission file.
No reference TXT, similarity model, ID range or source-array ordering is an input.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import re
import sys
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
    files = ['source-first.py', 'source-first.mjs', 'bwiki-dialogue.py',
             'import-bwiki-chapters.py', 'import-localizations.py', 'restore-dialogue-flow.py',
             'validate-content-stage.py', 'source-first-publication.mjs', 'content-publication.mjs', 'import-trailblaze.py']
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


def structure_index(manifest, commit):
    if manifest.get('schema') != 'hsr-dialogue-flow-input.v1' or manifest.get('commit') != commit:
        raise ValueError('Mixed official structure version')
    owners, graphs, evidence, issues = defaultdict(list), {}, {}, []
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
        proof = {'source': item['path'], 'missionId': int(match[1]), 'gitBlob': blob,
                 'sha256': hashlib.sha256(data).hexdigest()}
        evidence[item['path']] = proof

        def visit(value, pointer='', role=None, conditions=()):
            if isinstance(value, list):
                for i, child in enumerate(value):
                    visit(child, pointer + '/' + str(i), role, conditions)
            elif isinstance(value, dict):
                kind = value.get('$type', '').split('.')[-1]
                # Disabled/conditional references prove ownership, not that the branch executes.
                gates = {k: value[k] for k in value if k in ['TaskEnabled', 'Condition', 'ConditionList', 'Predicate', 'If', 'Else']}
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
        try:
            nodes, order = flow.scene_graph(document)
            graphs[item['path']] = {str(k): v['next'] for k, v in nodes.items()}
        except flow.Unresolved:
            issues.append({'source': item['path'], 'reason': 'execution-structure-partial-or-unsupported'})
    return owners, graphs, evidence, issues


def inventory(segments, page, chapter_id):
    occurrences, edges = [], {}

    def add(node, location, kind, branch, context):
        identity = 'occ-' + digest([chapter_id, page['pageId'], page['revision'], location, kind, node.get('text', '')])[:24]
        item = {'id': identity, 'page': page['pageTitle'], 'pageId': page['pageId'], 'revision': page['revision'],
                'pageSha256': page['sha256'], 'location': location, 'kind': kind, 'branch': branch,
                'context': context, 'chinese': node.get('text', ''), 'speaker': node.get('speaker', ''),
                'status': 'pending', 'official': [], 'rowRefs': []}
        occurrences.append(item)
        node['_occ'] = identity
        return identity

    def walk(nodes, path, branch, context):
        for i, node in enumerate(nodes):
            loc = path + [i]
            if node['kind'] == 'choice':
                for j, option in enumerate(node['options']):
                    identity = add(option, loc + ['choice', j], 'choice', branch, context)
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
        if not name or name == '开拓者':
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
    ls = {p['source'] for p in owners.get((a, left['kind']), []) if not p['conditions']}
    rs = {p['source'] for p in owners.get((z, right['kind']), []) if not p['conditions']}
    common = ls & rs & graphs.keys()
    # A choice branch/condition must have its execution condition mapped first.
    if not common or left['branch'] != right['branch'] or left['context'] != right['context']:
        return 'execution-scope-unverified'
    if any(reachable(graphs[s], z, a) for s in common):
        return 'potential-order-conflict'  # Same file alone does not identify an invocation.
    if any(reachable(graphs[s], a, z) for s in common):
        return 'compatible-local-order'
    return 'execution-scope-unverified'


def match_occurrence(node, index, owners, mission_ids, existing):
    if node['kind'] in ['barrier', 'unsupported']:
        node.update(status='boundary' if node['kind'] == 'barrier' else 'unsupported')
        return
    if node['kind'] == 'narration':
        node.update(status='pending', reason='stage-direction-or-narration-role-unverified')
        return
    key = (node['kind'], b.comparable(node['chinese']), b.normalized(node['speaker']))
    # Empty normalized punctuation must never match or merge with a neighbour.
    if not key[1]:
        node.update(reason='empty-normalized-content')
        return
    candidates = list({r['talkId']: r for r in index.get(key, [])}.values())
    node['candidateTalkIds'] = [r['talkId'] for r in candidates]
    if len(candidates) != 1:
        node.update(reason='ambiguous-official-ids' if candidates else 'no-exact-official-candidate')
        return
    record = candidates[0]
    node.update(official=[record], contentStatus='exact-official', method='exact-official')
    node['rowRefs'] = [r['id'] for r in existing.get(record['talkId'], [])
                       if r['text'] == record['text'] and r['speaker'] == record['speaker'] and
                       (r['type'] == 'choice') == (node['kind'] == 'choice')]
    proofs = owners.get((record['talkId'], node['kind']), [])
    matching = [p for p in proofs if p['missionId'] in mission_ids]
    owned = {p['missionId'] for p in matching}
    # Even a globally unique sentence and a verified wiki chapter do not establish its mission.
    if len(owned) != 1:
        node.update(status='content-only', reason='official-mission-ownership-unverified', ownership=matching)
        return
    node.update(status='confirmed', missionId=next(iter(owned)), ownership=matching)


def audit_chapter(record, payload, pages, index, owners, graphs, reviewed=None, cache=None):
    occurrences, edges, reviews, sources = [], {}, [], []
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
        source.update(sourceUrl='https://wiki.biligame.com/sr/' + b.quote(page['pageTitle']) + '?oldid=' + str(page['revision']),
                      historyUrl='https://wiki.biligame.com/sr/' + b.quote(page['pageTitle']) + '?action=history',
                      timestamp=page.get('timestamp'), collectedAt=page.get('collectedAt'))
        sources.append(source)
        document_reviews = []
        if page.get('retrieval') == 'cache-pinned':
            document_reviews.append({'page': title, 'reason': 'live-revision-unavailable-pinned-snapshot-only'})
            reviews.extend(document_reviews)
        for node in nodes:
            match_occurrence(node, index, owners, mission_ids, existing)
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
                match_occurrence(temporary, {(node['kind'], 'pinnedreview', b.normalized(node['speaker'])): [official]}, owners, mission_ids, existing)
                node.update({k: v for k, v in temporary.items() if k != 'chinese'})
                node.update(method='translation-reviewed-pinned', translationReviewHash=b.translation_review_hash(review))
        occurrences.extend(nodes)
        edges.update(graph)
        if doc_path:
            saved = {'nodes': nodes, 'graph': graph, 'sources': [source], 'review': document_reviews}
            write(doc_path, {'key': doc_key, 'sha256': digest(saved), 'result': saved})
        document_result({'status': 'audited', 'key': doc_key, 'reused': False})
    by_id = {o['id']: o for o in occurrences}
    orders = [{'from': a, 'to': z, 'evidence': 'wiki-display',
               'officialComparison': classify_order(by_id[a], by_id[z], owners, graphs)}
              for a, targets in edges.items() for z in targets]
    # Unresolved endpoints are retained in the source graph, never bridged.
    confirmed = {o['id'] for o in occurrences if o['status'] == 'confirmed'}
    safe_edges = {a: [z for z in targets if z in confirmed] for a, targets in edges.items() if a in confirmed}
    speech = [o for o in occurrences if o['kind'] in ['line', 'choice', 'narration']]
    counts = Counter(o['status'] for o in speech)
    mission_reports = []
    for m in record['missions']:
        page_nodes = [n for n in speech if n['page'] == pages.get(m['chineseTitle'], {}).get('pageTitle')]
        local = [n for n in page_nodes if n.get('missionId') == m['id']]
        mission_reports.append({**m, 'baselineRows': sum(r.get('missionId') == 'quest-' + str(m['id']) for r in payload['rows']),
                                'documentShared': len(grouped[m['chineseTitle']]) > 1,
                                'documentOccurrences': len(page_nodes), 'confirmedOccurrences': len(local),
                                'pendingOrContentOnlyOccurrences': sum(n['status'] != 'confirmed' for n in page_nodes),
                                'status': 'audited-partial' if page_nodes else 'pending-document',
                                'localOrder': 'partial', 'wholePath': 'unverified'})
    return {'schema': 'hsr-source-first-chapter.v1', 'chapter': record, 'baselineRows': len(payload['rows']),
            'baselineLinkedRows': sum(r.get('bwikiStatus') in ['matched', 'cached'] for r in payload['rows']),
            'sources': sources, 'missions': mission_reports, 'occurrences': occurrences, 'wikiGraph': edges, 'confirmedWikiGraph': safe_edges,
            'orderComparisons': orders, 'review': reviews,
            'counts': {'allParsedUnits': len(occurrences), 'speechOccurrences': len(speech),
                       'status': dict(counts), 'boundaries': sum(o['kind'] == 'barrier' for o in occurrences),
                       'unsupported': sum(o['kind'] == 'unsupported' for o in occurrences),
                       'unavailableDocuments': sum('missionIds' in r for r in reviews),
                       'uniqueOfficialContentIds': len({r['talkId'] for o in speech for r in o['official']}),
                       'newConfirmedIds': len({o['official'][0]['talkId'] for o in speech if o['status'] == 'confirmed' and not existing.get(o['official'][0]['talkId'])})},
            'verification': {'content': 'partial', 'localOrder': 'partial', 'wholePath': 'unverified',
                             'referenceTxtUsed': False, 'crossBoundaryEdges': 0}}


def add_confirmed(payload, result):
    """Append source records only; preserve every prior row and traversal edge."""
    value = copy.deepcopy(payload)
    present = {r.get('talkId') for r in value['rows']}
    additions = []
    blocked = {edge[k] for edge in result['orderComparisons'] if edge['officialComparison'] == 'potential-order-conflict' for k in ['from', 'to']}
    for node in result['occurrences']:
        if node['status'] != 'confirmed' or node['id'] in blocked:
            continue
        r = node['official'][0]
        if r['talkId'] in present:
            continue
        proof = node['ownership'][0]
        mission = next(m for m in result['chapter']['missions'] if m['id'] == node['missionId'])
        identity = f"official-{value['entryId']}-{value['chapterId']}-talk-{r['talkId']}"
        row = {'id': identity, 'entryId': value['entryId'], 'chapterId': value['chapterId'],
               'missionId': 'quest-' + str(node['missionId']), 'mission': mission['title'],
               'scene': mission['title'] + ' · 추가 원문 · 순서 미확인',
               'type': 'choice' if node['kind'] == 'choice' else 'dialogue' if r['speaker'] else 'narration', 'talkId': r['talkId'],
               'textHash': r['textHash'], 'text': r['text'], 'speaker': r['speaker'], 'source': proof['source'],
               'flowStatus': 'review', 'flowBoundary': True, 'bwikiStatus': 'review'}
        value['rows'].append(row)
        present.add(r['talkId'])
        additions.append({'rowId': identity, 'talkId': r['talkId'], 'missionId': node['missionId'],
                          'occurrence': node['id'], 'proof': proof, 'content': r})
    # New records are isolated until a matching execution invocation is established.
    for field in ['referenceOrder', 'bwikiBaseOrder']:
        if field in value:
            value[field] += [a['rowId'] for a in additions]
    if additions and 'bwiki' in value:
        value['bwiki']['reviewRows'] = sum(r.get('bwikiStatus') == 'review' for r in value['rows'])
    return value, additions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('raw', type=Path)
    parser.add_argument('plan', type=Path)
    parser.add_argument('work', type=Path)
    parser.add_argument('--discover', action='store_true')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    cat, (plan, talks, cn, kr) = catalog(args.root, args.raw, args.plan)
    args.work.mkdir(parents=True, exist_ok=True)
    write(args.work / 'catalog.json', cat)
    if args.discover:
        write(args.work / 'request.json', {'schema': 'hsr-bwiki-request.v1', 'commit': plan['commit'], 'requests': cat['requests'], 'review': cat['review']})
        print(json.dumps({'chapters': len(cat['chapters']), 'missions': sum(len(c['missions']) for c in cat['chapters']), 'documents': len(cat['requests'])}))
        return
    policy = read(CODE.parent / 'editorial/source-first-policy.json')
    if policy.get('version') != 1 or not policy.get('requireExplicitMissionOwnership') or policy.get('newSemanticMatches') != 'candidate-only':
        raise ValueError('Unsupported or weakened source-first policy')
    manifest = read(args.work / 'manifest.json')
    if manifest.get('schema') != 'hsr-bwiki-input.v1' or manifest['commit'] != plan['commit']:
        raise ValueError('Mixed wiki input version')
    structures = read(args.work / 'structures.json')
    owners, graphs, structure_proofs, structure_review = structure_index(structures, plan['commit'])
    index = global_candidates(talks, cn, kr)
    pages = {p['title']: p for p in manifest['pages']}
    version = {'codeHash': code_hash(), 'policyHash': digest(policy), 'policyVersion': policy['version'],
               'officialInputs': cat['inputHashes'], 'commit': plan['commit'], 'structureHashes': digest(structure_proofs),
               'reviewRegistryHash': hashlib.sha256((CODE.parent / 'editorial/bwiki-translation-matches.json').read_bytes()).hexdigest()}
    summary = {'schema': 'hsr-source-first-run.v1', **version, 'chapters': [], 'catalogReview': cat['review'],
               'structureReview': structure_review, 'collectionReview': structures.get('review', []),
               'referenceTxtUsed': False, 'productionWritten': False, 'status': 'running'}
    progress = args.work / 'progress.json'
    public = {'schema': 'hsr-source-first-provenance.v1', 'commit': plan['commit'], **version,
              'license': manifest.get('license'), 'chapters': {}}
    previous_path = args.root / 'public/source-first-provenance.json'
    previous = read(previous_path) if previous_path.exists() else {}
    registry = read(CODE.parent / 'editorial/bwiki-translation-matches.json')
    source_records = {f"{p['pageTitle']}@{p['revision']}": {'sha256': p['sha256']}
                      for p in manifest['pages'] if p.get('status') == 'available'}
    talk_table = {t['TalkSentenceID']: t for t in talks if t}
    metadata = read(args.root / 'src/data/imported-content.json')
    entries = read(args.root / 'src/data/trailblaze.json')
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
        retained_proofs, unverified_prior = [], []
        by_id = {r['id']: r for r in payload['rows']}
        for prior in previous.get('chapters', {}).get(record['file'], {}).get('additions', []):
            row = by_id.get(prior['rowId'])
            node = next((o for o in result['occurrences'] if o['status'] == 'confirmed' and
                         o['official'][0]['talkId'] == prior['talkId'] and o['missionId'] == prior['missionId']), None)
            if row and node and row['text'] == node['official'][0]['text'] and row['source'] in {p['source'] for p in node['ownership']}:
                retained_proofs.append({**prior, 'occurrence': node['id'], 'content': node['official'][0],
                                        'proof': next(p for p in node['ownership'] if p['source'] == row['source'])})
            elif row:
                unverified_prior.append({'rowId': row['id'], 'reason': 'previous-source-first-proof-not-currently-reproducible',
                                         'previousCommit': previous.get('commit')})
        summary['chapters'].append({'id': record['id'], 'file': record['file'], 'title': record['title'],
                                    'missionCount': len(record['missions']), 'baselineRows': len(payload['rows']),
                                    'counts': result['counts'], 'candidateAdditions': len(added),
                                    'verification': result['verification'], 'result': str(target), 'reused': reused,
                                    'orderComparisonCounts': dict(Counter(e['officialComparison'] for e in result['orderComparisons'])),
                                    'missions': result['missions'],
                                    'review': result['review']})
        write(progress, summary)
        # Keep the complete candidate inventory/graph in resumable checkpoints.
        # Public provenance contains every added row's location/proof and aggregate
        # pending counts, without shipping the full raw-candidate index to readers.
        published_occurrences = {a['occurrence'] for a in retained_proofs + added}
        public['chapters'][record['file']] = {'chapterId': record['id'], 'sources': result['sources'], 'counts': result['counts'],
            'missions': result['missions'],
            'verification': result['verification'], 'additions': retained_proofs + added, 'retainedUnverifiedRows': unverified_prior,
            'occurrences': [{k: v for k, v in o.items() if k not in ['chinese', 'speaker', 'official', 'ownership']}
                            | {'officialIds': [r['talkId'] for r in o['official']]} for o in result['occurrences'] if o['id'] in published_occurrences],
            'wikiGraph': {}, 'orderComparisonCounts': dict(Counter(e['officialComparison'] for e in result['orderComparisons'])),
            'orderReview': [e for e in result['orderComparisons'] if e['officialComparison'] == 'potential-order-conflict'],
            'inventoryKey': key, 'inventorySha256': digest(result), 'review': result['review']}
        if args.apply and added:
            write(args.root / 'public' / record['file'], candidate)
            changed.append('public/' + record['file'])
            key_route = record['entryId'] + '/' + record['chapterId']
            metadata[key_route]['rows'] = len(candidate['rows'])
            for entry in entries:
                for c in entry['chapters']:
                    if entry['id'] == record['entryId'] and c['id'] == record['chapterId']:
                        c['content'] = copy.deepcopy(metadata[key_route])
            total_added += len(added)
        print(json.dumps({'chapter': record['id'], 'counts': result['counts'], 'additions': len(added), 'reused': reused}), flush=True)
    summary.update(status='completed', candidateAdditions=sum(c['candidateAdditions'] for c in summary['chapters']),
                   registeredChapters=len(cat['chapters']), officialMissions=sum(len(c['missions']) for c in cat['chapters']))
    write(progress, summary)
    write(args.work / 'report.json', summary)
    if args.apply:
        if total_added:
            write(args.root / 'src/data/imported-content.json', metadata)
            write(args.root / 'src/data/trailblaze.json', entries)
            search = read(args.root / 'public/content/search-index.json')
            groups = {r['entryId'] + '/' + r['chapterId']: [] for r in search['rows']}
            for r in search['rows']:
                groups[r['entryId'] + '/' + r['chapterId']].append(r)
            for record in cat['chapters']:
                body = read(args.root / 'public' / record['file'])
                groups[record['entryId'] + '/' + record['chapterId']] = [
                    {k: v for k, v in r.items() if k not in ['missionId', 'talkId', 'source']} |
                    {'source': b.digest(r['source'])[:16]} for r in body['rows']]
            search['rows'] = [r for group in groups.values() for r in group]
            b.write(args.root / 'public/content/search-index.json', search)
            update = read(args.root / 'public/content-update.json')
            update['rows'] = len(search['rows'])
            update['verifiedTextRows'] += total_added
            write(args.root / 'public/content-update.json', update)
            wiki = read(args.root / 'public/bwiki-provenance.json')
            wiki.setdefault('totals', {})['reviewRows'] = wiki.get('totals', {}).get('reviewRows', 0) + total_added
            b.write(args.root / 'public/bwiki-provenance.json', wiki)
            changed += ['src/data/imported-content.json', 'src/data/trailblaze.json', 'public/content/search-index.json', 'public/content-update.json', 'public/bwiki-provenance.json']
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
