"""Projection of explicit game occurrences, separate from BWIKI display order."""
import hashlib
import json
import re
from collections import Counter, defaultdict, deque


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()


def json_safe(value):
    """Keep game hashes exact through the existing JavaScript publication pipeline."""
    if type(value) is int and abs(value) > 9007199254740991: return str(value)
    if isinstance(value, dict): return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, list): return [json_safe(v) for v in value]
    return value


def canonical(row):
    return {k: row.get(k) for k in ['id', 'talkId', 'textHash', 'missionId', 'type', 'speaker', 'text', 'source']}


def invocation_index(documents, tables):
    """Explicit sub-mission dependencies and performance-table calls, not ID prefixes."""
    performances = defaultdict(set)
    for table, records in tables.items():
        if not table.startswith('ExcelOutput/Performance'): continue
        for r in records:
            if isinstance(r.get('PerformanceID'), int) and isinstance(r.get('PerformancePath'), str):
                performances[r['PerformanceID']].add((r['PerformancePath'], table))
    invocations, relations, review = defaultdict(list), [], []
    submissions, starts, start_sources, conflicting_submissions = {}, defaultdict(set), defaultdict(list), set()
    for source, d in documents.items():
        main = d.get('MainMissionID')
        if type(main) is int and isinstance(d.get('StartSubMissionList'), list):
            starts[main].update(d['StartSubMissionList'])
            start_sources[main].append(source)
        for sub in d.get('SubMissionList', []):
            if type(sub.get('ID')) is int and type(sub.get('MainMissionID')) is int:
                key = (sub['MainMissionID'], sub['ID'])
                if key in submissions and submissions[key][1] != sub:
                    conflicting_submissions.add(key)
                    review.append({'source': source, 'subMissionId': sub['ID'], 'reason': 'conflicting-submission-definition'})
                else:
                    submissions[key] = (source, sub)
    for key in conflicting_submissions: submissions.pop(key, None)
    reachable = {}
    for main, entry in starts.items():
        reached = {n for n in entry if (main, n) in submissions}
        while True:
            additions = set()
            for (owner, identity), (_, sub) in submissions.items():
                if owner != main or identity in reached: continue
                previous = sub.get('TakeParamIntList', [])
                if not previous or not all(type(n) is int and (main, n) in submissions for n in previous): continue
                if ((sub.get('TakeType') == 'AnySequence' and any(n in reached for n in previous)) or
                    (sub.get('TakeType') == 'AllSequence' and all(n in reached for n in previous))):
                    additions.add(identity)
            if not additions: break
            reached.update(additions)
        reachable[main] = reached
        for identity in reached:
            source, sub = submissions[(main, identity)]
            for predecessor in sub.get('TakeParamIntList', []):
                if predecessor in reached and sub.get('TakeType') in ['AnySequence', 'AllSequence']:
                    relations.append({'mainMissionId': main, 'fromSubMission': predecessor,
                        'toSubMission': identity, 'condition': sub['TakeType'], 'source': source,
                        'status': 'confirmed-dependency; not-dialogue-adjacency'})
            target = sub.get('MissionJsonPath')
            if target in documents:
                invocations[target].append({'mainMissionId': main, 'subMissionId': identity,
                    'entrySources': start_sources[main],
                    'source': source, 'reference': 'MissionJsonPath', 'conditions':
                        {k: v for k, v in sub.items() if k.startswith('Take')}})

    def walk(value, pointer=''):
        if isinstance(value, dict):
            if value.get('TaskEnabled', True) is not True: return
            yield pointer, value
            for k, child in value.items():
                if k in ['TaskList', 'SuccessTaskList', 'FailedTaskList'] and value.get('$type') and not value['$type'].endswith('.PredicateTaskList'):
                    continue
                yield from walk(child, pointer + '/' + k)
        elif isinstance(value, list):
            for i, child in enumerate(value): yield from walk(child, pointer + '/' + str(i))

    def resolve(identity, kind):
        candidates = performances.get(identity, set())
        paths = {p for p, _ in candidates}
        if len(paths) != 1: return None, candidates, 'performance-table-target-not-unique'
        target = next(iter(paths))
        if target not in documents: return None, candidates, 'performance-target-unavailable'
        types = {t.get('PerformanceType') for _, t in walk(documents[target])
                 if t.get('$type', '').endswith('.LevelPerformanceInitialize')}
        if kind not in types: return None, candidates, 'performance-runtime-type-unverified'
        return target, candidates, None

    def guards_at(document, pointer):
        current, guards, parts = document, [], pointer.lstrip('/').split('/')
        for i, key in enumerate(parts):
            if isinstance(current, dict):
                fields = {k: current[k] for k in ['Condition', 'ConditionList', 'Predicate'] if k in current}
                if key in ['SuccessTaskList', 'FailedTaskList']:
                    fields = {k: v for k, v in current.items() if k not in ['SuccessTaskList', 'FailedTaskList', 'TaskList']}
                if fields: guards.append({'pointer': '/' + '/'.join(parts[:i]), 'branch': key, 'fields': fields})
                current = current.get(key)
            elif isinstance(current, list): current = current[int(key)]
        return guards

    for link in tables.get('ExcelOutput/PerformanceSubMissionLink.json', []):
        target, _, _ = resolve(link.get('PerformanceID'), link.get('PerformanceType'))
        if not target: continue
        for owner, reached in reachable.items():
            if link.get('SubMissionID') in reached and re.match(
                    r'(?:Config/Level/Mission|Story/(?:Discussion/)?Mission)/' + str(owner) + '/', target):
                invocations[target].append({'mainMissionId': owner, 'subMissionId': link['SubMissionID'],
                    'source': 'ExcelOutput/PerformanceSubMissionLink.json', 'reference': 'PerformanceSubMissionLink',
                    'performanceId': link['PerformanceID'], 'performanceType': link['PerformanceType']})

    queue = deque(invocations)
    done = set()
    while queue:
        source = queue.popleft()
        if source in done: continue
        done.add(source)
        callers = list(invocations[source])
        for pointer, task in walk(documents[source]):
            if task.get('$type', '').split('.')[-1] != 'TriggerPerformance' or task.get('TaskEnabled', True) is not True:
                continue
            target, candidates, reason = resolve(task.get('PerformanceID'), task.get('PerformanceType'))
            if not target:
                review.append({'source': source, 'pointer': pointer, 'reason': reason})
                continue
            for caller in callers:
                owner = caller['mainMissionId']
                if not re.match(r'(?:Config/Level/Mission|Story/(?:Discussion/)?Mission)/' + str(owner) + '/', target):
                    review.append({'source': source, 'target': target, 'reason': 'shared-performance-mission-scope-review'})
                    continue
                proof = {**caller, 'caller': source, 'pointer': pointer,
                    'callConditions': guards_at(documents[source], pointer),
                    'callChain': caller.get('callChain', []) + [{'source': source, 'pointer': pointer,
                        'target': target, 'performanceId': task['PerformanceID']}],
                    'reference': 'TriggerPerformance -> PerformancePath', 'performanceId': task['PerformanceID'],
                    'performanceType': task['PerformanceType'], 'tables': sorted(t for _, t in candidates)}
                if proof not in invocations[target]: invocations[target].append(proof)
            if target in invocations: queue.append(target)
    return dict(invocations), relations, review


def build(payload, record, executions, valid_rows, version, invocations=None, relations=(), additions=()):
    rows = {r['id']: r for r in payload['rows']}
    owned = {m['id'] for m in record['missions']}
    by_talk = defaultdict(list)
    other_missions = defaultdict(list)
    for r in rows.values():
        by_talk[(r.get('missionId'), r.get('talkId'), 'choice' if r['type'] == 'choice' else 'line')].append(r)
        other_missions[(r.get('talkId'), 'choice' if r['type'] == 'choice' else 'line')].append(r)
    nodes, sources, review, edges, comparisons = {}, {}, [], [], []
    for source, graph in executions.items():
        proof = graph['proof']
        if proof['missionId'] not in owned:
            continue
        mapped = {}
        for pointer, node in graph['nodes'].items():
            candidates = by_talk.get(('quest-' + str(proof['missionId']), node['talkId'], node['type']), [])
            if not candidates:
                candidates = [r for r in other_missions.get((node['talkId'], node['type']), [])
                              if r.get('missionEvidence') == 'bwiki']
            exact_source = [r for r in candidates if r.get('source', '').split('#')[0] == source]
            if len(candidates) != 1 and len(exact_source) == 1:
                candidates = exact_source
            if len(candidates) != 1 or candidates[0]['id'] not in valid_rows or node['status'] != 'confirmed':
                elsewhere = other_missions.get((node['talkId'], node['type']), []) if not candidates else []
                review.append({'source': source, 'pointer': pointer, 'talkId': node['talkId'],
                    'missionId': proof['missionId'], 'status': 'tentative',
                    'candidateRowIds': [r['id'] for r in candidates or elsewhere], 'conditions': node['conditions'],
                    'reason': 'inactive-or-unsupported-container' if node['status'] != 'confirmed' else
                              'official-mission-attribution-disagreement' if elsewhere else
                              'official-row-missing' if not candidates else 'row-or-role-not-unique-or-original-not-valid'})
                continue
            row = candidates[0]
            conditions = json_safe(node['conditions'])
            identity = 'exec-' + digest([source, pointer, node['talkId'], row['id']])[:24]
            mapped[pointer] = identity
            nodes[identity] = {**node, 'id': identity, 'rowId': row['id'], 'source': source,
                'conditions': conditions, 'conditionsHash': digest(conditions),
                'missionId': 'quest-' + str(proof['missionId']), 'mission': row['mission'],
                'sceneId': 'execution-' + digest([source, node['phase'], conditions])[:24],
                'nextIds': [], 'replyToIds': [], 'branch': [],
                'evidenceHash': digest([canonical(row), proof['sha256'], pointer])}
            sources[source] = json_safe({**proof, 'invocations': (invocations or {}).get(source, []),
                               'invocationEvidence': graph.get('invocationEvidence', {})})
        for edge in graph['edges']:
            a, z = mapped.get(edge['from']), mapped.get(edge['to'])
            if not a or not z or edge['status'] != 'confirmed' or nodes[a]['conditions'] != nodes[z]['conditions']:
                review.append({'source': source, **edge, 'status': 'tentative', 'reason': 'endpoint-gate-or-loop-unverified'})
                continue
            if z not in nodes[a]['nextIds']:
                nodes[a]['nextIds'].append(z)
                edges.append({'from': a, 'to': z, 'method': edge['method'], 'status': 'confirmed'})
                if rows[nodes[a]['rowId']]['type'] == 'choice':
                    nodes[z]['replyToIds'].append(a)
        # Unsupported tasks remain boundaries, even when other local lists succeeded.
        review.extend({'source': source, 'status': 'unconfirmed', **r} for r in graph['review'])
    adjacent = defaultdict(set)
    for e in edges:
        adjacent[e['from']].add(e['to']); adjacent[e['to']].add(e['from'])
    components, done = [], set()
    for identity in nodes:
        if identity in done:
            continue
        component, stack = [], [identity]
        while stack:
            p = stack.pop()
            if p in done:
                continue
            done.add(p); component.append(p); stack.extend(adjacent[p] - done)
        members = set(component)
        incoming = Counter(z for p in component for z in nodes[p]['nextIds'])
        queue = deque(p for p in nodes if p in members and not incoming[p])
        order = []
        while queue:
            p = queue.popleft(); order.append(p)
            for z in nodes[p]['nextIds']:
                incoming[z] -= 1
                if not incoming[z]: queue.append(z)
        if len(order) != len(component):
            raise ValueError('Unexpected execution projection cycle')
        components.append(order)
    membership = defaultdict(set)
    for i, component in enumerate(components):
        for p in component: membership[nodes[p]['rowId']].add(i)
    preferred = {}
    for row_id, indices in membership.items():
        if len(indices) == 1:
            preferred[row_id] = next(iter(indices))
            continue
        source = rows[row_id].get('source', '').split('#')[0]
        exact = {i for i in indices if any(nodes[p]['rowId'] == row_id and nodes[p]['source'] == source for p in components[i])}
        if len(exact) == 1: preferred[row_id] = next(iter(exact))
    wiki = payload.get('wikiReading', {})
    wiki_rows = defaultdict(list)
    for p in wiki.get('occurrences', []): wiki_rows[p['rowId']].append(p)
    wiki_nodes = {p['id']: p for p in wiki.get('occurrences', [])}
    wiki_rank = {p['id']: i for i, p in enumerate(wiki.get('occurrences', []))}
    reverse = defaultdict(list)
    for e in edges: reverse[e['to']].append(e['from'])

    def wiki_reachable(a, z):
        seen, stack = set(), [a]
        while stack:
            p = stack.pop()
            if p in seen: continue
            seen.add(p)
            for target in wiki_nodes[p]['nextIds']:
                if target == z: return True
                stack.append(target)
        return False

    disputed = set()
    for edge in edges:
        a, z = (wiki_rows.get(nodes[edge[key]]['rowId'], []) for key in ['from', 'to'])
        if len(a) != 1 or len(z) != 1: continue
        a, z = a[0], z[0]
        fields = ['page', 'revision', 'sceneId', 'branch', 'conditions']
        if any(a[k] != z[k] for k in fields): continue
        result = 'compatible-local-order' if wiki_reachable(a['id'], z['id']) else (
            'potential-order-conflict; invocation-scope-review-required' if wiki_reachable(z['id'], a['id']) else 'no-comparable-wiki-path')
        comparisons.append({**edge, 'source': nodes[edge['from']]['source'],
            'wikiFrom': a['id'], 'wikiTo': z['id'], 'result': result})
        if result.startswith('potential-order-conflict'):
            disputed.update([edge['from'], edge['to']])

    def anchor(p, backward):
        seen = {p}
        while True:
            targets = reverse[p] if backward else nodes[p]['nextIds']
            if len(targets) != 1 or targets[0] in seen: return None
            p = targets[0]; seen.add(p)
            choices = wiki_rows.get(nodes[p]['rowId'], [])
            if choices: return choices[0] if len(choices) == 1 else None

    unplaced = {r for group in wiki.get('unplaced', []) for r in group['rowIds']} if wiki else set(rows)
    unknown = {r for r in unplaced if rows[r].get('flowStatus') != 'verified' and
        rows[r].get('bwikiStatus') not in ['matched', 'cached'] and
        rows[r].get('videoStatus') not in ['caption-matched', 'screen-matched']}
    placements, displayed = [], set()
    for i, component in enumerate(components if version.get('displayOrder') != 'bwiki-only' else []):
        if disputed.intersection(component):
            review.append({'source': nodes[component[0]]['source'], 'status': 'tentative',
                'reason': 'existing-wiki-order-preserved; conflicting-local-component-isolated'})
            continue
        candidates = [p for p in component if nodes[p]['rowId'] in unknown and preferred.get(nodes[p]['rowId']) == i]
        if not candidates:
            continue
        # Canonical IDs shared by several files do not uniquely locate an invocation.
        # Single-component repetitions remain separate explicit occurrences.
        mission = nodes[component[0]]['missionId']
        grouped = defaultdict(list)
        for p in candidates:
            a, z = anchor(p, True), anchor(p, False)
            fields = ['page', 'revision', 'sceneId', 'branch', 'conditions']
            if a and z and all(a[k] == z[k] for k in fields) and wiki_rank[z['id']] == wiki_rank[a['id']] + 1:
                grouped[z['id']].append(p)
            else:
                grouped[None].append(p)
        for before_wiki, selected in grouped.items():
            selected_rows = {nodes[p]['rowId'] for p in selected}
            first_unknown = next(r for r in rows if r in selected_rows)
            placements.append({'id': 'placement-' + digest(selected)[:24], 'occurrenceIds': selected,
                'contextIds': component, 'missionId': mission, 'beforeRowId': first_unknown,
                **({'beforeWikiId': before_wiki} if before_wiki else {}),
                'method': 'between-two-wiki-anchors-in-explicit-local-path' if before_wiki else 'explicit-local-scope-within-mission'})
        displayed.update(nodes[p]['rowId'] for p in candidates)
    for row_id in unknown - displayed:
        if membership.get(row_id):
            review.append({'rowId': row_id, 'status': 'tentative',
                           'reason': 'multiple-official-invocations', 'components': len(membership[row_id])})
    added_ids = {a['rowId'] for a in additions}
    previous = payload.get('executionReading', {})
    previous_nodes = {p['id']: p for p in previous.get('occurrences', [])}
    previous_displayed = {previous_nodes[p]['rowId'] for g in previous.get('placements', [])
                          for p in g['occurrenceIds'] if p in previous_nodes}
    new_displayed = displayed - previous_displayed
    admissions = list(additions)
    for prior in payload.get('executionReading', {}).get('additions', []):
        if prior['rowId'] not in added_ids and prior['rowId'] in valid_rows and any(
                n['rowId'] == prior['rowId'] and n['source'] == prior['proof']['source'] and
                n['pointer'] == prior['proof']['pointer'] for n in nodes.values()):
            current = next(n for n in nodes.values() if n['rowId'] == prior['rowId'] and
                           n['source'] == prior['proof']['source'] and n['pointer'] == prior['proof']['pointer'])
            admissions.append({**prior, 'proof': {**sources[current['source']], 'pointer': current['pointer'],
                'conditions': current['conditions']}})
    reading = {'schema': 'hsr-execution-reading.v1', **version,
        'wikiReadingHash': digest(wiki),
        'canonicalRowsHash': digest([canonical(r) for r in payload['rows']]),
        'sources': sources, 'occurrences': list(nodes.values()), 'placements': placements,
        'additions': json_safe(admissions),
        'missionRelations': json_safe([r for r in relations if r['mainMissionId'] in owned]),
        'summary': {'confirmedRows': len({n['rowId'] for n in nodes.values()}),
            'confirmedOccurrences': len(nodes), 'confirmedEdges': len(edges),
            'confirmedChoiceResponses': sum(bool(n['replyToIds']) for n in nodes.values()),
            'previousUnknownRows': len(unknown - added_ids - previous_displayed), 'newlyPlacedRows': len(new_displayed),
            'totalExecutionPlacedRows': len(displayed),
            'newlyPlacedExistingRows': len(new_displayed - added_ids), 'newOfficialRows': len(added_ids),
            'newlyPlacedNewRows': len(new_displayed & added_ids),
            'remainingPreviousUnknownRows': len((unknown - added_ids - previous_displayed) - displayed),
            'remainingUnknownRows': len(unknown - displayed),
            'placedBetweenWikiAnchors': sum(len(g['occurrenceIds']) for g in placements if g.get('beforeWikiId')),
            'orderComparisons': dict(Counter(c['result'] for c in comparisons)),
            'tentativeItems': sum(r['status'] == 'tentative' for r in review)}}
    return reading, {'review': review, 'edges': edges, 'comparisons': comparisons}


def validate(reading, rows, commit, wiki=None):
    by_id = {r['id']: r for r in rows}
    def require(ok, reason):
        if not ok: raise ValueError('Invalid official execution positions: ' + reason)
    retained = (reading.get('verificationMode') == 'retained-no-order-audit' and
                reading.get('displayOrderPolicy') == 'bwiki-only' and not reading.get('placements'))
    require(reading.get('schema') == 'hsr-execution-reading.v1' and
            (reading.get('commit') == commit or (retained and re.fullmatch('[a-f0-9]{40}', reading.get('commit', '')))), 'schema/release')
    require(all(re.fullmatch('[a-f0-9]{64}', reading.get(k, '')) for k in ['codeHash', 'policyHash']), 'code/policy version')
    require(reading.get('canonicalRowsHash') == digest([canonical(r) for r in rows]), 'canonical checksum')
    require(reading.get('wikiReadingHash') == digest(wiki or {}), 'wiki layout version')
    wiki_ids = {p['id'] for p in (wiki or {}).get('occurrences', [])}
    wiki_unplaced = {r for g in (wiki or {}).get('unplaced', []) for r in g['rowIds']}
    nodes = {p['id']: p for p in reading['occurrences']}
    require(len(nodes) == len(reading['occurrences']), 'duplicate occurrence')
    for p in nodes.values():
        proof = reading['sources'].get(p['source'])
        require(p['rowId'] in by_id and proof is not None and p['status'] == 'confirmed', 'row/source/status')
        row = by_id[p['rowId']]
        require(p['conditionsHash'] == digest(p['conditions']), 'condition checksum')
        require(p['talkId'] == row.get('talkId') and (p['type'] == 'choice') == (row['type'] == 'choice'), 'official ID/role')
        require(bool(re.fullmatch('[a-f0-9]{40}', proof.get('gitBlob', ''))) and
                bool(re.fullmatch('[a-f0-9]{64}', proof.get('sha256', ''))), 'input hashes')
        require(p['missionId'] == 'quest-' + str(proof['missionId']) and
                (row.get('missionEvidence') == 'bwiki' or row.get('missionId') == p['missionId']), 'mission ownership')
        require(p['evidenceHash'] == digest([canonical(row), proof['sha256'], p['pointer']]), 'proof checksum')
        for target in p['nextIds'] + p['replyToIds']:
            q = nodes.get(target)
            require(q is not None and q['source'] == p['source'] and q['phase'] == p['phase'] and
                    q['conditions'] == p['conditions'] and q['missionId'] == p['missionId'], 'cross-scope edge')
        for target in p['replyToIds']:
            require(by_id[nodes[target]['rowId']]['type'] == 'choice' and p['id'] in nodes[target]['nextIds'], 'choice response')
    used = set()
    for addition in reading.get('additions', []):
        row = by_id.get(addition['rowId'])
        proof, content = addition['proof'], addition['content']
        require(row is not None and row.get('talkId') == addition['talkId'] == content['talkId'] and
                row.get('missionId') == 'quest-' + str(addition['missionId']), 'new original ID/mission')
        require(row['text'] == content['text'] and row['speaker'] == content['speaker'] and
                hashlib.sha256(row['text'].encode()).hexdigest() == content['koreanHash'], 'new original text')
        require(proof.get('invocations') and proof['source'] in reading['sources'] and
                proof['gitBlob'] == reading['sources'][proof['source']]['gitBlob'], 'new original invocation')
        require(any(p['rowId'] == row['id'] and p['source'] == proof['source'] and p['pointer'] == proof['pointer'] for p in nodes.values()), 'new original typed reference')
    for group in reading['placements']:
        require(group['beforeRowId'] in by_id and by_id[group['beforeRowId']].get('missionId') == group['missionId'], 'insertion mission')
        require(all(p in nodes for p in group['contextIds'] + group['occurrenceIds']), 'placement reference')
        require(set(group['occurrenceIds']) <= set(group['contextIds']), 'placement context')
        require(not used.intersection(group['occurrenceIds']), 'duplicate display occurrence')
        require(not group.get('beforeWikiId') or group['beforeWikiId'] in wiki_ids, 'wiki anchor')
        if wiki:
            require(all(nodes[p]['rowId'] in wiki_unplaced for p in group['occurrenceIds']), 'existing wiki position moved')
        require(all(nodes[p]['missionId'] == group['missionId'] for p in group['contextIds']), 'mixed display missions')
        used.update(group['occurrenceIds'])
    incoming = Counter(z for p in nodes.values() for z in p['nextIds'])
    queue = deque(p for p in nodes if not incoming[p])
    visited = set()
    while queue:
        p = queue.popleft(); visited.add(p)
        for z in nodes[p]['nextIds']:
            incoming[z] -= 1
            if not incoming[z]: queue.append(z)
    require(len(visited) == len(nodes), 'execution cycle')
