"""Exact-hash comparisons and evidence-backed loading titles for supplemental search."""
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('search_text', Path(__file__).with_name('import-search-text.py'))
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)
LANGUAGES = search.localizations.LANGUAGES


def code_hash():
    return hashlib.sha256(b''.join(Path(__file__).with_name(name).read_bytes() for name in
        ['import-search-localizations.py', 'import-localizations.py', 'bwiki-dialogue.py'])).hexdigest()


def loading_pairs(content):
    # Accept only a whole, simple two-cell table row. Complex/conditional rows
    # and partial paragraphs cannot establish a title/body relationship.
    for table in re.findall(r'^\{\|[^\n]*\n(.*?)^\|\}', content, re.M | re.S):
        for row in re.split(r'^\|-.*$', table, flags=re.M):
            match = re.fullmatch(r'\s*!([^\n|!]+)\n\|([^|]+?)\s*', row, re.S)
            if not match:
                continue
            try:
                yield tuple(search.bwiki.normalized(search.bwiki.inline(re.sub(
                    r'<br\s*/?>', '\n', value, flags=re.I))) for value in match.groups())
            except search.bwiki.Unresolved:
                continue


def build(root, raw, plan_path, wiki_path=None, previous_path=None):
    plan = json.loads(plan_path.read_bytes())
    corpus = json.loads((root / 'public/search/manifest.json').read_bytes())
    if (plan.get('schema') != 'hsr-upstream-plan.v1' or
            plan.get('repository') != 'DimbreathBot/TurnBasedGameData' or
            not re.fullmatch(r'[a-f0-9]{40}', plan.get('commit', '')) or
            plan['commit'] != corpus['commit']):
        raise ValueError('Mixed search localization versions')
    evidence = {}

    def textmap(code):
        files = [f for f in plan['files'] if re.fullmatch(rf'TextMap/TextMap{code}(?:_\d+)?\.json', f['path'])]
        names = [Path(f['path']).name for f in files]
        if (not files or len(set(names)) != len(names) or
                (f'TextMap{code}.json' in names and len(names) != 1) or
                sorted(int(re.search(r'_(\d+)\.json$', n)[1]) if '_' in n else 0 for n in names) != list(range(len(names)))):
            raise ValueError('Incomplete search localization TextMap: ' + code)
        texts = {}
        for file in files:
            name = Path(file['path']).name
            data = (raw / name).read_bytes()
            blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
            proof = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
            if blob != file['sha'] or (code in ['KR', 'CHS'] and corpus['files'].get(name) != proof):
                raise ValueError('Unverified search localization input: ' + name)
            evidence[name] = proof
            for key, value in json.loads(data).items():
                if (not re.fullmatch(r'\d+', key) or not isinstance(value, str) or
                        (key in texts and texts[key] != value)):
                    raise ValueError('Invalid search localization string')
                texts[key] = value
        return texts

    korean = textmap('KR')
    publications, parts, coverage, titles = [], [], {}, {}

    def write(relative, payload):
        data = search.encode(payload)
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        publications.append(relative)
        return hashlib.sha256(data).hexdigest()

    for language, code in LANGUAGES.items():
        texts = textmap(code)
        buckets = [[] for _ in range(search.PARTS)]
        missing = 0
        for key in sorted(korean, key=int):
            if not search.localizations.plain(korean[key]):
                continue
            text = search.localizations.plain(texts.get(key, ''), language)
            if text:
                buckets[int(key) % search.PARTS].append({'id': key, 'text': text, 'speaker': ''})
            else:
                missing += 1
        for index, rows in enumerate(buckets):
            name = f'{language}/search-text--part-{index:02}.json'
            digest = write('public/search/locales/' + name, {
                'schema': 'hsr-localizations.v1', 'language': language,
                'entryId': 'search-text', 'chapterId': f'part-{index:02}',
                'referenceCommit': plan['commit'], 'rows': rows})
            parts.append({'file': name, 'rows': len(rows), 'sha256': digest})
        coverage[language] = {'rows': sum(map(len, buckets)), 'missing': missing}
        if code == 'CHS':
            chinese = texts

    if previous_path and previous_path.exists():
        previous = json.loads(previous_path.read_bytes())
        if (previous.get('schema') == 'hsr-search-localizations.v1' and previous.get('commit') == plan['commit'] and
                previous.get('files') == evidence and previous.get('codeSha256') == code_hash()):
            titles.update(previous.get('titles', {}))
    if wiki_path and wiki_path.exists():
        wiki = json.loads(wiki_path.read_bytes())
        if wiki.get('schema') != 'hsr-bwiki-input.v1' or wiki.get('commit') != plan['commit']:
            raise ValueError('Mixed loading title evidence versions')
        lookup = {}
        for key, text in chinese.items():
            if key in korean:
                lookup.setdefault(search.bwiki.normalized(text), []).append(key)
        proposals = {}
        for page in wiki['pages']:
            if page.get('status') != 'available' or page.get('searchKind') != '로딩 화면':
                continue
            data = Path(page['file']).read_bytes()
            if hashlib.sha256(data).hexdigest() != page['sha256']:
                raise ValueError('Unverified loading title evidence')
            proof = {k: page[k] for k in ['pageTitle', 'pageId', 'revision', 'sha256']}
            for title, body in loading_pairs(data.decode('utf8')):
                ids = lookup.get(title, [])
                labels = {search.localizations.plain(korean[key]) for key in ids} - {''}
                if len(labels) != 1:
                    continue
                for key in lookup.get(body, []):
                    proposals.setdefault(key, []).append({'title': next(iter(labels)),
                        'titleHashCandidates': ids, 'text': search.localizations.plain(korean[key]), 'source': proof})
        for key, values in proposals.items():
            if len({v['title'] for v in values}) == 1:
                titles[key] = values[0]
            else:
                titles.pop(key, None)
    write('public/search/locales/manifest.json', {
        'schema': 'hsr-search-localizations.v1', 'commit': plan['commit'],
        'repository': plan['repository'], 'files': evidence, 'codeSha256': code_hash(),
        'parts': parts, 'coverage': coverage, 'titles': titles,
        'copyright': 'Game text © HoYoverse. BWIKI title associations: CC BY-NC-SA 4.0.'})
    receipt = root / '.cache/search-localization-receipt.json'
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_bytes(search.encode({'files': publications}))
    print(json.dumps({'coverage': coverage, 'titles': len(titles)}))


def validate(root):
    folder = root / 'public/search/locales'
    if not (folder / 'manifest.json').exists():
        return
    manifest = json.loads((folder / 'manifest.json').read_bytes())
    corpus = json.loads((root / 'public/search/manifest.json').read_bytes())
    expected = {f'{language}/search-text--part-{index:02}.json' for language in LANGUAGES for index in range(search.PARTS)}
    if (manifest.get('schema') != 'hsr-search-localizations.v1' or manifest['commit'] != corpus['commit'] or
            len(manifest['parts']) != len(expected) or {p['file'] for p in manifest['parts']} != expected or
            any(manifest['files'].get(k) != v for k, v in corpus['files'].items() if k.startswith('TextMapKR'))):
        raise ValueError('Invalid search localization manifest')
    counts = dict.fromkeys(LANGUAGES, 0)
    for part in manifest['parts']:
        data = (folder / part['file']).read_bytes()
        payload = json.loads(data)
        language, name = part['file'].split('/')
        index = int(name[-7:-5])
        rows = payload['rows']
        if (hashlib.sha256(data).hexdigest() != part['sha256'] or payload.get('schema') != 'hsr-localizations.v1' or
                payload['language'] != language or payload['entryId'] != 'search-text' or
                payload['chapterId'] != f'part-{index:02}' or payload['referenceCommit'] != manifest['commit'] or
                len(rows) != part['rows'] or len({r['id'] for r in rows}) != len(rows) or any(
                    not isinstance(r['id'], str) or not re.fullmatch(r'\d+', r['id']) or int(r['id']) % search.PARTS != index or
                    not isinstance(r['text'], str) or not r['text'].strip() or r['speaker'] != '' for r in rows)):
            raise ValueError('Invalid search localization part')
        counts[language] += len(rows)
    if any(count != manifest['coverage'][language]['rows'] for language, count in counts.items()):
        raise ValueError('Invalid search localization coverage')
    for key, title in manifest['titles'].items():
        if (not re.fullmatch(r'\d+', key) or not title['title'].strip() or not title['text'].strip() or
                not title['titleHashCandidates'] or any(not re.fullmatch(r'\d+', h) for h in title['titleHashCandidates']) or
                not re.fullmatch(r'[a-f0-9]{64}', title['source']['sha256']) or
                type(title['source']['revision']) is not int or title['source']['revision'] <= 0):
            raise ValueError('Invalid loading title evidence')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--validate':
        validate(Path(sys.argv[2]))
    else:
        build(*(Path(arg) for arg in sys.argv[1:]))
