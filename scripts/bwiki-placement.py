"""Reading positions reference immutable official rows; links describe wiki display only."""
import hashlib
import json
import re
from collections import Counter, defaultdict


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def canonical(row):
    return {key: row.get(key) for key in ['id', 'talkId', 'textHash', 'text', 'speaker', 'type', 'missionId', 'source']}


def mission_group(chapter_id, page):
    return 'wiki-mission-' + digest([chapter_id, page])[:24]


def build(record, payload, audit, talks, chinese, korean, owners, previous_chunks, b, imports, version, content_index=None):
    rows = {r['id']: r for r in payload['rows']}
    table = {t['TalkSentenceID']: t for t in talks if t}
    missions = {m['id']: m for m in record['missions']}
    groups = defaultdict(list)
    for mission in record['missions']:
        if mission['chineseTitle']:
            groups[mission['chineseTitle']].append(mission)
    documents = {s['pageTitle']: s for s in audit['sources']}
    # Canonical content is checked against this release again, not against a
    # translated wiki sentence or a similarity score.
    index = defaultdict(list)
    for row in rows.values():
        evidence = b.row_evidence(row, table, chinese, korean)
        if evidence:
            index[('choice' if row['type'] == 'choice' else 'line', evidence['text'],
                   '' if row['type'] == 'choice' else evidence['speaker'])].append(row)
    pinned = {}
    wanted = {(proof['kind'], b.comparable(chinese.get(proof['textHash'], '')), proof['wikiSpeaker'])
              for chunk in previous_chunks for proof in chunk.get('evidence', {}).values()
              if 'textHash' in proof and 'wikiSpeaker' in proof}
    old_candidates = imports.official_candidates(talks, chinese, korean, wanted) if wanted else {}
    for chunk in previous_chunks:
        source = documents.get(chunk['page'])
        if not source or source['revision'] != chunk['revision']:
            continue
        for identity, proof in chunk.get('evidence', {}).items():
            row = rows.get(identity)
            if not row or 'textHash' not in proof or 'wikiSpeaker' not in proof:
                continue
            th = proof['textHash']
            key = (proof['kind'], b.comparable(chinese.get(th, '')), proof['wikiSpeaker'])
            candidates = old_candidates.get(key, [])
            if (len(candidates) == 1 and row.get('talkId') == proof['talkId'] and
                    row.get('textHash') == th and row['type'] == proof['type'] and
                    row['text'] == candidates[0]['text'] and row['speaker'] == candidates[0]['speaker'] and
                    all(candidates[0][k] == proof[k] for k in ['chineseHash', 'koreanHash', 'speakerHash'])):
                pinned[(chunk['page'], identity)] = key
                if row not in index[key]:
                    index[key].append(row)
    nodes = audit['occurrences']
    candidates, mapped, methods = {}, {}, {}
    wanted_keys = {('choice' if n['kind'] == 'choice' else 'line', b.comparable(n['chinese']), b.normalized(n['speaker']))
                   for n in nodes if n['kind'] in ['line', 'choice', 'narration']}
    official_candidates = defaultdict(set)
    for talk in talks:
        if not talk:
            continue
        th, sh = str(talk.get('TalkSentenceText', {}).get('Hash')), str(talk.get('TextmapTalkSentenceName', {}).get('Hash'))
        if not chinese.get(th) or not korean.get(th):
            continue
        if sh not in ['None', '0'] and (not chinese.get(sh) or not korean.get(sh)):
            continue
        name = b.normalized(chinese.get(sh, ''))
        keys = [('line', b.comparable(chinese[th]), name)]
        if not name or name == '开拓者':
            keys.append(('choice', b.comparable(chinese[th]), ''))
        for key in keys:
            if key in wanted_keys:
                official_candidates[key].add(talk['TalkSentenceID'])
    if content_index is not None:
        official_candidates = defaultdict(set, {key: {r['talkId'] for r in values}
                                                for key, values in content_index.items() if key in wanted_keys})
    doubtful = {}
    page_groups = {s['pageTitle']: groups.get(s.get('title', s['pageTitle']), groups.get(s['pageTitle'], [])) for s in audit['sources']}
    # A requested title may be a verified redirect to another page title.
    for node in nodes:
        group = page_groups.get(node['page'], [])
        allowed = {m['id'] for m in group}
        if node['kind'] not in ['line', 'choice', 'narration']:
            continue
        key = ('choice' if node['kind'] == 'choice' else 'line', b.comparable(node['chinese']), b.normalized(node['speaker']))
        values = []
        for row in index.get(key, []):
            if node['kind'] == 'narration' and row['type'] != 'narration':
                continue
            owned = row.get('missionId') in {'quest-' + str(i) for i in allowed}
            referenced = any(p['missionId'] in allowed for p in owners.get((row.get('talkId'), node['kind'] if node['kind'] == 'choice' else 'line'), []))
            old_position = (row.get('bwikiPage') == node['page'] and row.get('bwikiRevision') == node['revision'] and
                            row.get('bwikiStatus') in ['matched', 'cached']) or (node['page'], row['id']) in pinned
            if group or owned or referenced or old_position:
                values.append(row['id'])
        # Existing explicitly reviewed translations retain their original pinned
        # review, never a new runtime semantic correspondence.
        if not values and node.get('method') == 'translation-reviewed-pinned':
            values = [identity for identity in node.get('rowRefs', []) if identity in rows]
        candidates[node['id']] = list(dict.fromkeys(values))
        if len(candidates[node['id']]) == 1:
            row = rows[candidates[node['id']][0]]
            # A missing official alternative must not look unique merely because
            # its Korean row has not been imported. A prior page-level binding
            # cannot establish which repeated occurrence uses that official ID.
            prior_binding = row.get('bwikiStatus') in ['matched', 'cached'] and row.get('bwikiPage') == node['page'] and row.get('bwikiRevision') == node['revision']
            referenced = any(p['missionId'] in allowed for p in owners.get((row.get('talkId'), key[0]), []))
            possible = {identity for identity in official_candidates[key] if
                        not owners.get((identity, key[0])) or
                        any(p['missionId'] in allowed for p in owners[(identity, key[0])])} if referenced else official_candidates[key]
            if len(possible) > 1:
                doubtful[node['id']] = possible
            else:
                mapped[node['id']] = candidates[node['id']][0]
                methods[node['id']] = 'prior-pinned-binding' if prior_binding else 'exact-content-and-wiki-scope'

    # Preserve already verified occurrence bindings at the exact same revision
    # and canonical bytes. This is retained evidence, never a fresh ambiguous match.
    previous = payload.get('wikiReading', {})
    prior_positions = {p['id']: p for p in previous.get('occurrences', [])}
    prior_sources = {(s['pageTitle'], s['revision']): s for s in previous.get('sources', [])}
    for node in nodes:
        prior = prior_positions.get(node['id'])
        source = documents.get(node['page'])
        if not prior or not source or prior['rowId'] not in candidates.get(node['id'], []):
            continue
        old_source = prior_sources.get((node['page'], node['revision']), {})
        if (source['sha256'] == old_source.get('sha256') and
                prior['location'] == node['location'] and prior['branch'] == node['branch'] and
                prior['conditions'] == node['context'] and
                prior['evidenceHash'] == digest([canonical(rows[prior['rowId']]), source['sha256'], node['location']])):
            mapped[node['id']], methods[node['id']] = prior['rowId'], 'retained-pinned-position'

    # Disambiguation needs two already unique anchors in one explicit source
    # array and the same gate. Cross-file/Act/Discussion adjacency is insufficient.
    by_id = {n['id']: n for n in nodes}
    graph = audit['wikiGraph']
    reverse = defaultdict(list)
    for identity, targets in graph.items():
        for target in targets:
            reverse[target].append(identity)

    def between(left, candidate, right, kind):
        def locations(identity, role):
            out = []
            for proof in owners.get((identity, role), []):
                match = re.fullmatch(r'(.*/(?:SimpleTalkList|OptionList))/(\d+)', proof['pointer'])
                if match:
                    out.append((proof['source'], match[1], json.dumps(proof['conditions'], sort_keys=True), int(match[2])))
            return out
        for a in locations(rows[left].get('talkId'), 'line'):
            for c in locations(candidate, kind):
                for z in locations(rows[right].get('talkId'), 'line'):
                    if a[:3] == c[:3] == z[:3] and a[3] < c[3] < z[3]:
                        return True
        return False

    for node in nodes:
        identity = node['id']
        if identity in mapped or (len(candidates.get(identity, [])) < 2 and identity not in doubtful):
            continue
        left, right = reverse[identity], graph.get(identity, [])
        if len(left) != 1 or len(right) != 1 or left[0] not in mapped or right[0] not in mapped:
            continue
        a, z = by_id[left[0]], by_id[right[0]]
        if not (a['branch'] == node['branch'] == z['branch'] and a['context'] == node['context'] == z['context']):
            continue
        possible = doubtful.get(identity, {rows[row].get('talkId') for row in candidates[identity]})
        talk_ids = {talk for talk in possible if between(mapped[a['id']], talk, mapped[z['id']], node['kind'])}
        values = [row for row in candidates[identity] if rows[row].get('talkId') in talk_ids]
        if len(values) == 1 and len(talk_ids) == 1:
            mapped[identity], methods[identity] = values[0], 'two-anchors-same-official-array-and-gate'

    reading_groups = []
    placed = set()
    occurrences = []
    display_edges = {n['id']: [target for target in graph.get(n['id'], []) if target in mapped and
        n['location'][0] == by_id[target]['location'][0] and n['context'] == by_id[target]['context'] and
        (n['kind'] != 'choice' or n['id'] in by_id[target]['branch'])] for n in nodes if n['id'] in mapped}
    metadata = {d['pageTitle']: d for d in audit.get('documents', [])}
    page_order = list(dict.fromkeys(n['page'] for n in nodes))
    title_ids = {b.normalized(title): [title] for title in page_order}
    structures = {title: b.mission_structure(metadata[title].get('fields', {}), title_ids) for title in page_order if title in metadata}
    ordered_pages, _ = b.mission_order(page_order, structures)
    for page in ordered_pages:
        group = page_groups.get(page, [])
        group_id = mission_group(record['id'], page)
        title = ' / '.join(dict.fromkeys(m['title'] for m in group)) if group else page
        section = ''
        for node in [n for n in nodes if n['page'] == page]:
            if node['kind'] in ['barrier', 'unsupported']:
                if node.get('label'):
                    section = node['label']
                continue
            if node['id'] not in mapped:
                continue
            row_id = mapped[node['id']]
            placed.add(row_id)
            scene = 'wiki-scene-' + digest([page, node['location'][0], node['context']])[:24]
            occurrences.append({'id': node['id'], 'rowId': row_id, 'missionId': group_id, 'mission': title,
                'sceneId': scene, 'scene': section, 'page': page, 'revision': node['revision'],
                'location': node['location'], 'conditions': node['context'], 'branch': node['branch'],
                'method': methods[node['id']], 'status': 'wiki-display',
                'nextIds': display_edges.get(node['id'], []),
                'replyToIds': [choice for choice in node['branch'] if choice in mapped and by_id[choice]['context'] == node['context'] and by_id[choice]['location'][0] == node['location'][0]],
                'evidenceHash': digest([canonical(rows[row_id]), documents[page]['sha256'], node['location']])})
        reading_groups.append({'id': group_id, 'title': title, 'officialMissionIds': [m['id'] for m in group],
            'page': page, 'objectives': metadata.get(page, {}).get('objectives', {})})
    unknown = defaultdict(list)
    unknown_titles = {}
    for row in rows.values():
        if row['id'] in placed:
            continue
        mission_id = row.get('missionId', row['mission'])
        unknown[mission_id].append(row['id'])
        unknown_titles[mission_id] = row['mission']
    known_edges = {(r['id'], target) for r in rows.values() for target in r.get('bwikiNextIds', [])}
    new_reply_edges = {(mapped[n['id']], mapped[target]) for n in nodes if n['kind'] == 'choice' and n['id'] in mapped
                       for target in display_edges.get(n['id'], []) if by_id[target]['kind'] != 'choice' and
                       (mapped[n['id']], mapped[target]) not in known_edges}
    unknown_before = {r['id'] for r in rows.values() if (r.get('flowStatus') == 'review' or r.get('bwikiStatus') == 'review')
                      and r.get('flowStatus') != 'verified' and r.get('bwikiStatus') not in ['matched', 'cached']
                      and r.get('videoStatus') not in ['caption-matched', 'screen-matched']}
    return {'schema': 'hsr-wiki-reading.v1', **version, 'canonicalRowsHash': digest({r['id']: canonical(r) for r in payload['rows']}),
        'sources': audit['sources'], 'missions': reading_groups, 'occurrences': occurrences,
        'unplaced': [{'id': key, 'title': unknown_titles[key], 'rowIds': ids} for key, ids in unknown.items()],
        'summary': {'previousOrderUnknown': len(unknown_before), 'newlyPlacedRows': len(placed & unknown_before),
            'placedRows': len(placed), 'occurrences': len(occurrences), 'repeatedOccurrences': len(occurrences) - len(placed),
            'newChoiceReplyLinks': len(new_reply_edges), 'unplacedRows': len(rows) - len(placed),
            'remainingPreviousUnknown': len(unknown_before - placed),
            'officialExecutionVerifiedRows': sum(r.get('flowStatus') == 'verified' for r in rows.values())},
        'review': [{'occurrenceId': n['id'], 'candidateRowIds': candidates.get(n['id'], []),
                    'reason': 'no-unique-owned-official-row'} for n in nodes if n['kind'] in ['line', 'choice', 'narration'] and n['id'] not in mapped]}


def validate_admission(addition, row, node, chapter, reading):
    """Validate a BWIKI admission without asserting official mission ownership."""
    def require(ok, reason):
        if not ok:
            raise ValueError('Invalid BWIKI original admission: ' + reason)
    proof, content = addition['proof'], addition['content']
    mission = addition['missionId']
    source = next((s for s in chapter['sources'] if s['pageTitle'] == proof.get('page') and
                   s['revision'] == proof.get('revision')), None)
    require(proof.get('kind') == 'bwiki-mission' and source is not None, 'pinned mission document')
    group = next((m for m in reading['missions'] if m['id'] == mission), None)
    require(proof.get('chapterId') == chapter['chapterId'] and group is not None and
            set(proof.get('catalogMissionIds', [])) == set(group['officialMissionIds']) and
            set(proof['catalogMissionIds']) <= {m['id'] for m in chapter['missions']} and
            mission == mission_group(chapter['chapterId'], proof['page']) == proof.get('missionId'),
            'chapter/mission scope')
    require(source.get('pageId') == proof.get('pageId') and source['sha256'] == proof.get('sha256') and
            source.get('sourceUrl') == proof.get('source') and
            bool(re.fullmatch(r'[a-f0-9]{64}', proof.get('sha256', ''))), 'document evidence')
    require(row is not None and row.get('missionEvidence') == 'bwiki' and
            row.get('missionId') == row.get('bwikiMissionId') == mission, 'display attribution')
    require(row.get('talkId') == addition['talkId'] == content['talkId'] and
            row.get('textHash') == content['textHash'] and row['text'] == content['text'] and
            row['speaker'] == content['speaker'] and
            hashlib.sha256(row['text'].encode()).hexdigest() == content['koreanHash'] and
            all(re.fullmatch(r'[a-f0-9]{64}', content.get(k, '')) for k in ['chineseHash', 'speakerHash']),
            'official text/ID/speaker')
    require(row['source'] == f"ExcelOutput/TalkSentenceConfig.json#TalkSentenceID={row['talkId']}", 'official content source')
    require(node is not None and node['status'] == 'wiki-confirmed' and node['method'] == 'exact-official' and
            node['officialIds'] == [row['talkId']] and
            (node['kind'] == 'choice') == (row['type'] == 'choice'), 'unique exact role match')
    require(node['page'] == proof['page'] and node['pageId'] == proof['pageId'] and
            node['revision'] == proof['revision'] and node['location'] == proof['location'] and
            node['branch'] == proof['branch'] and node['context'] == proof['conditions'], 'occurrence scope')
    position = next((p for p in reading['occurrences'] if p['id'] == node['id']), None)
    require(position is not None and position['rowId'] == row['id'] and position['page'] == node['page'] and
            position['revision'] == node['revision'] and position['location'] == node['location'], 'display position')


def validate(reading, rows, commit):
    def require(condition, reason):
        if not condition:
            raise ValueError('Invalid BWIKI reading positions: ' + reason)
    require(reading.get('schema') == 'hsr-wiki-reading.v1' and reading.get('commit') == commit, 'release/schema')
    require(all(re.fullmatch(r'[a-f0-9]{64}', reading.get(k, '')) for k in ['codeHash', 'policyHash']), 'code/policy hashes')
    by_id = {r['id']: r for r in rows}
    require(reading.get('canonicalRowsHash') == digest({r['id']: canonical(r) for r in rows}), 'canonical row checksum')
    sources = {(s['pageTitle'], s['revision']): s for s in reading['sources']}
    missions = {m['id']: m for m in reading['missions']}
    positions = {p['id']: p for p in reading['occurrences']}
    require(len(missions) == len(reading['missions']) and len(positions) == len(reading['occurrences']), 'duplicate position/group')
    for p in positions.values():
        require(p['rowId'] in by_id and p['missionId'] in missions and p['status'] == 'wiki-display', 'row/group/status')
        source = sources.get((p['page'], p['revision']))
        require(source is not None and bool(re.fullmatch(r'[a-f0-9]{64}', source.get('sha256', ''))), 'pinned source')
        require(p['evidenceHash'] == digest([canonical(by_id[p['rowId']]), source['sha256'], p['location']]), 'position evidence')
        require(all(isinstance(value, str) for gate in p['conditions'] for value in gate.values()), 'condition labels')
        for target in p['nextIds'] + p['replyToIds']:
            q = positions.get(target)
            require(q is not None and p['missionId'] == q['missionId'] and p['sceneId'] == q['sceneId'] and
                    p['page'] == q['page'] and p['revision'] == q['revision'] and p['conditions'] == q['conditions'], 'cross-boundary link')
            require(p['branch'] == q['branch'][:len(p['branch'])] or q['branch'] == p['branch'][:len(q['branch'])], 'sibling branch link')
        for choice in p['replyToIds']:
            require(choice in p['branch'] and by_id[positions[choice]['rowId']]['type'] == 'choice', 'unproven response')
        if by_id[p['rowId']]['type'] == 'choice':
            require(all(p['id'] in positions[target]['branch'] for target in p['nextIds']), 'empty choice response inferred')
    placed = {p['rowId'] for p in positions.values()}
    unplaced = [identity for group in reading['unplaced'] for identity in group['rowIds']]
    require(len(set(unplaced)) == len(unplaced) and not placed.intersection(unplaced) and placed | set(unplaced) == by_id.keys(), 'coverage partition')
    for group in reading['unplaced']:
        require(all(by_id[identity].get('missionId', by_id[identity]['mission']) == group['id'] for identity in group['rowIds']), 'mixed unknown missions')
    visiting, done = set(), set()
    for identity in positions:
        stack = [(identity, False)]
        while stack:
            current, exiting = stack.pop()
            if exiting:
                visiting.remove(current)
                done.add(current)
                continue
            if current in done:
                continue
            require(current not in visiting, 'display cycle')
            visiting.add(current)
            stack.append((current, True))
            stack.extend((target, False) for target in positions[current]['nextIds'])
