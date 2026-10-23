"""Publish every nonempty Korean TextMap string absent from the curated search."""
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('search_localizations', Path(__file__).with_name('import-localizations.py'))
localizations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(localizations)
spec = importlib.util.spec_from_file_location('search_bwiki', Path(__file__).with_name('bwiki-dialogue.py'))
bwiki = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bwiki)
PARTS = 32


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def code_hash():
    return hashlib.sha256(b''.join(Path(__file__).with_name(name).read_bytes() for name in
        ['import-search-text.py', 'bwiki-dialogue.py', 'import-localizations.py'])).hexdigest()


def candidates(content, kind):
    # NPC pages also list unrelated quests and items. Attribute dialogue only
    # inside the explicit NPC conversation section, never from those link lists.
    if kind == 'NPC 대사':
        match = re.search(r'^==\s*NPC对话\s*==\s*\n(.*?)(?=^==[^=]|\Z)', content, re.M | re.S)
        if not match:
            return set()
        content = match[1]
    result = set()
    def add(value):
        value = re.sub(r'^\s*[：:]\s*', '', value).strip()
        value = re.sub(r'<br\s*/?>', '\n', value, flags=re.I)
        for part in [value, *value.splitlines()]:
            try:
                text = bwiki.normalized(bwiki.inline(part))
            except bwiki.Unresolved:
                continue
            # Short labels and common responses cannot identify their source.
            if len(text) >= 8 and not re.search(r'[{}]|^https?://', text):
                result.add(text)
    def visit(value):
        try:
            for is_template, body in bwiki.templates(value):
                if is_template:
                    fields = bwiki.template_parts(body)
                    for field in fields[1:]:
                        field = re.sub(r'^[\w\u3400-\u9fff]+\s*=', '', field)
                        add(field)
                        if '{{' in field:
                            visit(field)
                else:
                    for line in body.splitlines():
                        line = re.sub(r'^\s*[*#:;]+\s*', '', line)
                        for cell in re.split(r'\|\||\|', line):
                            add(cell)
                        if '：' in line:
                            add(line.split('：', 1)[1])
        except bwiki.Unresolved:
            pass
    visit(content)
    return result


def classify(texts, raw, plan, manifest_path):
    if not manifest_path:
        return {}, [], {}, []
    manifest = json.loads(manifest_path.read_bytes())
    if manifest.get('schema') != 'hsr-bwiki-input.v1' or manifest['commit'] != plan['commit']:
        raise ValueError('Mixed BWIKI search input versions')
    chinese, evidence = {}, {}
    for file in plan['files']:
        if not re.fullmatch(r'TextMap/TextMapCHS(?:_\d+)?\.json', file['path']):
            continue
        data = (raw / Path(file['path']).name).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != file['sha']:
            raise ValueError('Unverified Chinese search TextMap')
        evidence[Path(file['path']).name] = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
        for key, value in json.loads(data).items():
            if not isinstance(value, str) or (key in chinese and chinese[key] != value):
                raise ValueError('Conflicting Chinese search TextMap')
            chinese[key] = value
    if not chinese:
        raise ValueError('Missing Chinese search TextMap')
    lookup, labels = {}, {}
    for key, value in chinese.items():
        if key not in texts:
            continue
        normalized = bwiki.normalized(value)
        if len(normalized) >= 8:
            lookup.setdefault(normalized, []).append(key)
        labels.setdefault(normalized, set()).add(localizations.plain(texts[key]))
    sources, matches, review = [], {}, list(manifest.get('review', []))
    seen = set()
    for page in manifest['pages']:
        if page.get('status') != 'available':
            review.append({key: page[key] for key in ['title', 'reason'] if key in page})
            continue
        identity = (page['pageId'], page['revision'])
        if identity in seen:
            continue
        seen.add(identity)
        try:
            data = Path(page['file']).read_bytes()
        except OSError:
            review.append({'title': page['pageTitle'], 'reason': '원문 캐시 조회 실패; 이전 검색 출처 보존 대상'})
            continue
        if hashlib.sha256(data).hexdigest() != page['sha256']:
            raise ValueError('Unverified BWIKI search snapshot')
        kind = page.get('searchKind', '관련 문서')
        keys = {key for text in candidates(data.decode('utf-8'), kind) for key in lookup.get(text, [])}
        if not keys:
            continue
        titles = labels.get(bwiki.normalized(page['pageTitle']), set()) - {''}
        source = {key: page[key] for key in ['pageTitle', 'pageId', 'revision', 'timestamp', 'sha256']}
        source.update(kind=kind, label=next(iter(titles)) if len(titles) == 1 else page['pageTitle'])
        index = len(sources)
        sources.append(source)
        for key in keys:
            matches.setdefault(key, []).append(index)
    return matches, sources, evidence, review


def build(root, raw, plan_file, wiki_file=None, previous_file=None):
    plan = json.loads(plan_file.read_bytes())
    if (plan.get('schema') != 'hsr-upstream-plan.v1' or
            plan.get('repository') != 'DimbreathBot/TurnBasedGameData' or
            not re.fullmatch(r'[a-f0-9]{40}', plan.get('commit', ''))):
        raise ValueError('Mixed search TextMap input versions')
    files = [f for f in plan['files'] if re.fullmatch(r'TextMap/TextMapKR(?:_\d+)?\.json', f['path'])]
    names = [Path(f['path']).name for f in files]
    if (not files or len(set(names)) != len(names) or
            ('TextMapKR.json' in names and len(names) != 1) or
            sorted(int(re.search(r'_(\d+)\.json$', n)[1]) if '_' in n else 0 for n in names) != list(range(len(names)))):
        raise ValueError('Incomplete Korean search TextMap')
    texts, evidence = {}, {}
    for file in files:
        name = Path(file['path']).name
        data = (raw / name).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != file['sha']:
            raise ValueError('Unverified search TextMap: ' + name)
        evidence[name] = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
        for key, value in json.loads(data).items():
            if (not re.fullmatch(r'\d+', key) or not isinstance(value, str) or
                    (key in texts and texts[key] != value)):
                raise ValueError('Conflicting or invalid search TextMap')
            texts[key] = value
    matches, sources, chinese_evidence, review = classify(texts, raw, plan, wiki_file)
    evidence.update(chinese_evidence)
    if previous_file and previous_file.exists():
        previous = json.loads(previous_file.read_bytes())
        # Reuse a published exact match only against the same verified KR/CHS
        # input bytes and the same Korean string. Never infer across versions.
        if (previous.get('schema') == 'hsr-search-text.v1' and
                previous.get('files') == evidence and previous.get('codeSha256') == code_hash()):
            source_ids = {s['pageId']: i for i, s in enumerate(sources)}
            for part in previous['parts']:
                if not re.fullmatch(r'part-\d{2}\.json', part['file']):
                    raise ValueError('Unsafe prior search part')
                data = (previous_file.parent / part['file']).read_bytes()
                if hashlib.sha256(data).hexdigest() != part['sha256']:
                    raise ValueError('Unverified previous search part')
                for key, text, ids in json.loads(data)['rows']:
                    if not ids or key not in texts or localizations.plain(texts[key]) != text:
                        continue
                    for old_id in ids:
                        source = previous['sources'][old_id]
                        if source['pageId'] not in source_ids:
                            source_ids[source['pageId']] = len(sources)
                            sources.append(source)
                        index = source_ids[source['pageId']]
                        if index not in matches.setdefault(key, []):
                            matches[key].append(index)
    search = root / 'public/content/search-index.json'
    curated = {localizations.plain(row['text']) for row in json.loads(search.read_bytes())['rows']}
    parts = [[] for _ in range(PARTS)]
    covered = empty = 0
    for key in sorted(texts, key=int):
        text = localizations.plain(texts[key])
        if not text:
            empty += 1
        elif text in curated:
            covered += 1
        else:
            parts[int(key) % PARTS].append([key, text, matches.get(key, [])])
    publications, descriptors = [], []
    folder = root / 'public/search'
    folder.mkdir(parents=True, exist_ok=True)
    for index, rows in enumerate(parts):
        name = f'part-{index:02}.json'
        data = encode({'schema': 'hsr-search-text-part.v1', 'commit': plan['commit'], 'rows': rows})
        (folder / name).write_bytes(data)
        publications.append('public/search/' + name)
        descriptors.append({'file': name, 'rows': len(rows), 'sha256': hashlib.sha256(data).hexdigest()})
    manifest = {'schema': 'hsr-search-text.v1', 'commit': plan['commit'], 'codeSha256': code_hash(),
                'repository': plan['repository'], 'files': evidence,
                'curatedSha256': hashlib.sha256(search.read_bytes()).hexdigest(),
                'textMapStrings': len(texts), 'curatedStrings': covered, 'emptyStrings': empty,
                'rows': sum(len(rows) for rows in parts), 'parts': descriptors,
                'sources': sources, 'classifiedRows': sum(bool(row[2]) for part in parts for row in part),
                'review': review, 'license': {'name': 'CC BY-NC-SA 4.0',
                    'url': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
                    'attribution': '崩坏：星穹铁道 BWIKI contributors'},
                'classification': 'exact-Chinese-TextMap-match; document occurrence only; no game scene/order inference'}
    if wiki_file:
        wiki = json.loads(wiki_file.read_bytes())
        manifest['pendingPages'] = [{'title': p['title'], 'searchKind': p.get('searchKind', '관련 문서')}
                                    for p in wiki['pages'] if p.get('status') != 'available']
    (folder / 'manifest.json').write_bytes(encode(manifest))
    publications.append('public/search/manifest.json')
    receipt = root / '.cache/search-text-receipt.json'
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_bytes(encode({'files': publications}))
    print(f"Search TextMap: {manifest['rows']} additional strings; {covered} already searchable")


def validate(root):
    folder = root / 'public/search'
    if not (folder / 'manifest.json').exists():
        return  # Older isolated verification fixtures have no supplemental search.
    manifest = json.loads((folder / 'manifest.json').read_bytes())
    if (manifest.get('schema') != 'hsr-search-text.v1' or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', '')) or
            len(manifest['parts']) != PARTS):
        raise ValueError('Invalid search TextMap manifest')
    count = 0
    for index, part in enumerate(manifest['parts']):
        if part['file'] != f'part-{index:02}.json':
            raise ValueError('Invalid search TextMap part path')
        data = (folder / part['file']).read_bytes()
        payload = json.loads(data)
        if (hashlib.sha256(data).hexdigest() != part['sha256'] or
                payload.get('schema') != 'hsr-search-text-part.v1' or
                payload['commit'] != manifest['commit'] or len(payload['rows']) != part['rows']):
            raise ValueError('Invalid search TextMap part')
        seen = set()
        for key, text, source_ids in payload['rows']:
            if (not isinstance(key, str) or not re.fullmatch(r'\d+', key) or
                    int(key) % PARTS != index or key in seen or not isinstance(text, str) or not text.strip()):
                raise ValueError('Invalid search TextMap string')
            if (not isinstance(source_ids, list) or len(set(source_ids)) != len(source_ids) or
                    any(type(i) is not int or i < 0 or i >= len(manifest['sources']) for i in source_ids)):
                raise ValueError('Invalid search TextMap source')
            seen.add(key)
        count += len(seen)
    if (count != manifest['rows'] or
            count + manifest['curatedStrings'] + manifest['emptyStrings'] != manifest['textMapStrings']):
        raise ValueError('Incomplete search TextMap coverage')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--validate':
        validate(Path(sys.argv[2]))
    else:
        build(*(Path(arg) for arg in sys.argv[1:]))
