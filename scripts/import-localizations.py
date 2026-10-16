"""Publish only exact, Korean-verified text joins from one pinned multilingual release."""
import hashlib
import json
import re
import sys
from pathlib import Path

LANGUAGES = {'en': 'EN', 'zh-CN': 'CHS', 'ja': 'JP'}
NICKNAMES = {'KR': '[개척자]', 'en': '[Trailblazer]', 'zh-CN': '[开拓者]', 'ja': '[開拓者]'}


def plain(value, language='KR'):
    value = value.replace('\\n', '\n').replace('\u00a0', ' ')
    value = re.sub(r'</?(?:color|size|b|i|s|u|unbreak|align)(?:=[^>]*)?>', '', value, flags=re.I)
    return re.sub(r'\*{0,2}\{NICKNAME\}\*{0,2}', NICKNAMES[language], value).strip()


def row_hashes(row, talks, bindings, nouns, chapters):
    record = talks.get(row.get('talkId'))
    if record:
        return (record.get('TalkSentenceText', {}).get('Hash'),
                record.get('TextmapTalkSentenceName', {}).get('Hash'))
    noun = re.fullmatch(r'NounAtlas:(\d+)', row.get('source', ''))
    if noun:
        return nouns.get(int(noun[1]), {}).get('NounDesc', {}).get('Hash'), None
    chapter = re.fullmatch(r'ExcelOutput/MissionChapterConfig.json:(\d+)/ChapterDesc', row.get('source', ''))
    if chapter:
        return chapters.get(int(chapter[1]), {}).get('ChapterDesc', {}).get('Hash'), None
    return row.get('textHash', bindings.get(row['id'])), None


def localize_row(row, hashes, korean, texts, language):
    text_hash, speaker_hash = hashes
    original = korean.get(str(text_hash)) if text_hash is not None else None
    translated = texts.get(str(text_hash)) if text_hash is not None else None
    # Never align by position, text similarity or rounded JavaScript numeric hashes.
    if (not isinstance(original, str) or plain(original) != plain(row['text']) or
            not isinstance(translated, str) or not plain(translated, language)):
        return None
    speaker = texts.get(str(speaker_hash), '') if speaker_hash is not None else ''
    return {'id': row['id'], 'text': plain(translated, language),
            'speaker': plain(speaker, language) if isinstance(speaker, str) else ''}


def build(root, raw, manifest_path):
    manifest = json.loads(manifest_path.read_bytes())
    if (manifest.get('schema') != 'hsr-upstream-plan.v1' or
            manifest.get('repository') != 'DimbreathBot/TurnBasedGameData' or
            not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', ''))):
        raise ValueError('Invalid multilingual source manifest')
    evidence = {}

    def read_raw(file):
        name = Path(file['path']).name
        data = (raw / name).read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != file['sha']:
            raise ValueError('Unverified localization input: ' + name)
        evidence[name] = {'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest()}
        return json.loads(data)

    def table(name):
        file = next(file for file in manifest['files'] if file['path'] == 'ExcelOutput/' + name)
        return read_raw(file)

    def textmap(code):
        files = [file for file in manifest['files']
                 if re.fullmatch(rf'TextMap/TextMap{code}(?:_\d+)?\.json', file['path'])]
        if not files:
            raise ValueError('Missing TextMap: ' + code)
        parts = sorted(int(re.search(r'_(\d+)\.json$', file['path'])[1])
                       if re.search(r'_(\d+)\.json$', file['path']) else 0 for file in files)
        if parts != list(range(len(files))):
            raise ValueError('Incomplete or ambiguous TextMap: ' + code)
        result = {}
        for file in files:
            for key, value in read_raw(file).items():
                if not isinstance(value, str) or (key in result and result[key] != value):
                    raise ValueError('Conflicting or invalid TextMap: ' + code)
                result[key] = value
        return result

    talks = {row['TalkSentenceID']: row for row in table('TalkSentenceConfig.json') if row}
    nouns = {row.get('ID', 0): row for row in table('NounAtlas.json')}
    chapters = {row.get('ID', 0): row for row in table('MissionChapterConfig.json')}
    korean = textmap('KR')
    bindings = json.loads((root / 'src/data/text-bindings.json').read_bytes())
    payloads = []
    for file in sorted((root / 'public/content').glob('*.json')):
        if file.name == 'search-index.json':
            continue
        payload = json.loads(file.read_bytes())
        if (payload.get('schema') != 'hsr-dialogue.v1' or
                file.name != f"{payload['entryId']}--{payload['chapterId']}.json" or
                not re.fullmatch(r'[A-Za-z0-9_-]+\.json', file.name)):
            raise ValueError('Invalid localization source payload: ' + file.name)
        payloads.append((file.name, payload, [row_hashes(row, talks, bindings, nouns, chapters)
                                            for row in payload['rows']]))
    if not payloads:
        raise ValueError('No Korean content to localize')
    publications, coverage = [], {}

    def write(file, data):
        target = root / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n',
                          encoding='utf-8', newline='\n')
        publications.append(file)

    for language, code in LANGUAGES.items():
        texts = textmap(code)
        total = choices = missing = 0
        for name, payload, hashes in payloads:
            rows = []
            for row, keys in zip(payload['rows'], hashes):
                localized = localize_row(row, keys, korean, texts, language)
                if localized is not None:
                    rows.append(localized)
                    choices += int(row['type'] == 'choice')
                else:
                    missing += 1
            total += len(rows)
            write(f'public/content/locales/{language}/{name}', {
                'schema': 'hsr-localizations.v1', 'language': language,
                'entryId': payload['entryId'], 'chapterId': payload['chapterId'],
                'referenceCommit': manifest['commit'], 'rows': rows,
            })
        coverage[language] = {'rows': total, 'choices': choices, 'missing': missing}
        del texts
    write('public/content/locales/manifest.json', {
        'schema': 'hsr-localization-manifest.v1', 'repository': manifest['repository'],
        'commit': manifest['commit'], 'version': manifest['version'], 'files': evidence,
        'coverage': coverage,
        'scope': 'Exact hashes with matching Korean text; missing joins remain unavailable.',
        'copyright': 'Game text © HoYoverse. Data source: DimbreathBot/TurnBasedGameData.',
    })
    receipt = root / '.cache/localization-receipt.json'
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({'files': publications}), encoding='utf-8')
    print(json.dumps(coverage))


if __name__ == '__main__':
    build(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
