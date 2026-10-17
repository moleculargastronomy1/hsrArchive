"""Compare exact published bytes and dialogue contracts across a code-only refactor."""
import hashlib
import json
import sys
from pathlib import Path


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def snapshot(root):
    files = sorted({*root.glob('src/data/*.json'), *root.glob('public/content/**/*.json'),
                    *root.glob('public/*provenance.json'), root / 'public/content-update.json',
                    root / 'public/video-review-summary.json'})
    result = {'schema': 'hsr-content-regression.v1', 'files': {}, 'chapters': 0, 'rows': 0, 'choices': 0}
    core = ['id', 'entryId', 'chapterId', 'text', 'speaker', 'type', 'missionId', 'mission',
            'talkId', 'textHash', 'source', 'scene', 'variant']
    for file in files:
        raw = file.read_bytes()
        data = json.loads(raw)  # Python preserves the original 64-bit integer hashes.
        record = {'bytes': hashlib.sha256(raw).hexdigest()}
        if isinstance(data, dict) and data.get('schema') == 'hsr-dialogue.v1':
            rows = data['rows']
            choices = [row for row in rows if row['type'] == 'choice']
            record.update(
                ids=digest(sorted(row['id'] for row in rows)),
                body=digest([{key: row[key] for key in core if key in row} for row in rows]),
                choices=digest(choices),
                order=digest([row['id'] for row in rows]),
                verification=digest([{key: value for key, value in row.items()
                                      if key.startswith(('bwiki', 'video', 'flow')) or
                                      key in ['nextIds', 'replyToIds', 'choiceGroup']}
                                     for row in rows]),
            )
            if file.name != 'search-index.json':
                result['chapters'] += 1
                result['rows'] += len(rows)
                result['choices'] += len(choices)
        result['files'][file.relative_to(root).as_posix()] = record
    return result


if __name__ == '__main__':
    mode, target = sys.argv[1:]
    current = snapshot(Path.cwd())
    target = Path(target)
    if mode == '--capture':
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(current, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    elif mode == '--compare':
        before = json.loads(target.read_bytes())
        if before['schema'] != current['schema']:
            raise ValueError('Invalid regression snapshot')
        changed = {file: [key for key in set(before['files'].get(file, {})) | set(current['files'].get(file, {}))
                          if before['files'].get(file, {}).get(key) != current['files'].get(file, {}).get(key)]
                   for file in sorted(set(before['files']) | set(current['files']))
                   if before['files'].get(file) != current['files'].get(file)}
        if changed:
            print(json.dumps(changed, ensure_ascii=False, indent=2))
            sys.exit(1)
    else:
        raise ValueError('Expected --capture or --compare')
    print(json.dumps({key: value for key, value in current.items() if key != 'files'} |
                     {'files': len(current['files']), 'result': mode}, ensure_ascii=False))
