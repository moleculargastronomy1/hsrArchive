"""Read-only occurrence comparison from validated, frozen audit checkpoints."""
import argparse
import collections
import importlib.util
import json
from pathlib import Path
import shutil
import zipfile


def read(path):
    return json.loads(Path(path).read_bytes())


def cell(value):
    if value is None:
        return '-'
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return value.replace('\\', '\\\\').replace('\t', '\\t').replace('\r', '\\r').replace('\n', '\\n')


def main():
    parser = argparse.ArgumentParser()
    for name in ['data', 'work', 'output', 'site-order']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--archive-commit', required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('export_source_first', Path(__file__).with_name('source-first.py'))
    s = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(s)
    report = read(args.work / 'report.json')
    plan = read(args.work / 'plan.json')
    if report['status'] != 'completed' or report['commit'] != plan['commit']:
        raise ValueError('Incomplete or mixed audit')
    _, _, talks, cn, kr, _ = s.b.inputs(args.data / '.cache/upstream-content/raw', args.work / 'plan.json')
    table = {t['TalkSentenceID']: t for t in talks if t}
    site_orders = read(args.site_order)
    summary, files = [], []
    folder = args.output / '전체36개'
    folder.mkdir(parents=True, exist_ok=True)
    fields = ['BWIKI출현순번', '문서내순번', '사이트표시순번', '사이트페이지', '판정', '구분', '중국어화자',
              'BWIKI중국어원문', '공식한국어화자', '사이트한국어원문', '공식한국어원본', '공식ID', '사이트원문행ID', '출현ID',
              '문서', '수정번호', '원문위치', '조건', '선택지가지', 'BWIKI명시응답출현ID', '사이트응답출현ID',
              '반복출현', '공식중국어참고', '후보공식ID_확정아님', '근거방법']
    for chapter in report['chapters']:
        checkpoint = read(chapter['result'])
        audit = checkpoint['result']
        if checkpoint['sha256'] != s.digest(audit):
            raise ValueError('Changed audit checkpoint')
        payload = read(args.data / 'public' / chapter['file'])
        reading = payload['wikiReading']
        if reading['commit'] != report['commit'] or any(reading[k] != report[k] for k in ['codeHash', 'policyHash', 'policyVersion', 'structureHashes', 'reviewRegistryHash']):
            raise ValueError('Audit and site evidence versions differ: ' + chapter['file'])
        s.placement.validate(reading, payload['rows'], report['commit'])
        rows = {r['id']: r for r in payload['rows']}
        order = site_orders[chapter['file']]
        by_position = {r['occurrenceId']: r for r in order if r.get('occurrenceId')}
        positions = {p['id']: p for p in reading['occurrences']}
        if by_position.keys() != positions.keys() or any(by_position[k]['rowId'] != positions[k]['rowId'] for k in positions):
            raise ValueError('Site occurrence export is not bijective')
        documents = {d['pageTitle']: d for d in audit.get('documents', [])}
        page_order = list(dict.fromkeys(n['page'] for n in audit['occurrences']))
        title_ids = {s.b.normalized(title): [title] for title in page_order}
        structures = {title: s.b.mission_structure(documents[title].get('fields', {}), title_ids)
                      for title in page_order if title in documents}
        page_order, _ = s.b.mission_order(page_order, structures)
        speech = [n for page in page_order for n in audit['occurrences']
                  if n['page'] == page and n['kind'] in ['line', 'choice', 'narration']]
        source_nodes = {n['id']: n for n in audit['occurrences']}
        if not positions.keys() <= source_nodes.keys():
            raise ValueError('A retained source needs its own frozen audit before exporting')
        numbered = {n['id']: i + 1 for i, n in enumerate(speech)}
        repetitions = collections.Counter(p['rowId'] for p in positions.values())
        content_repetitions = collections.Counter((n['speaker'], s.b.comparable(n['chinese'])) for n in speech)
        seen_rows, seen_content, doc_numbers = collections.Counter(), collections.Counter(), collections.Counter()
        counts = collections.Counter()
        lines = []
        def official(row):
            talk = table.get(row.get('talkId'), {})
            th = str(talk.get('TalkSentenceText', {}).get('Hash', row.get('textHash')))
            return cn.get(th, ''), kr.get(th, ''), ('TalkSentenceID:' + str(row['talkId']) if row.get('talkId') is not None else 'TextMapHash:' + str(row.get('textHash')))

        def entry(node, displayed=None):
            pos = positions.get(node['id']) if node else None
            site = by_position.get(node['id']) if node else displayed
            row = rows[site['rowId']] if site else None
            if pos and pos['rowId'] != row['id']:
                raise ValueError('Wrong canonical row at a site occurrence')
            original, korean, identity = official(row) if row else ('', '', None)
            if row and not korean:
                status = '공식입력_대사원문누락_기존ID자리유지'
            elif row and row['text'] != s.b._localizations.plain(korean):
                status = '공식한국어재대조불일치_검토필요'
            elif pos:
                same = s.b.comparable(node['chinese']) == s.b.comparable(original)
                if same:
                    status = ('텍스트확인_중문본문일치_공식ID후보복수' if pos.get('idStatus') == 'unresolved-identical-text'
                              else '연결확인_중문본문일치')
                elif row.get('bwikiMatchMethod') == 'translation-reviewed':
                    status = '연결확인_기존번역검토_문장동일아님'
                else:
                    status = '연결존재_중문재대조불일치_검토필요'
            elif row:
                status = {'execution': '공식실행위치확인_BWIKI출현미연결', 'legacy': '기존검증보존_새출현매칭미확정', 'intro': '챕터소개문_대사순서대상아님'}.get(site['kind'], '사이트원문_출현매칭미확정')
            else:
                status = 'BWIKI출현_공식원문연결미확정'
            repeats = []
            if node:
                key = (node['speaker'], s.b.comparable(node['chinese']))
                seen_content[key] += 1
                if content_repetitions[key] > 1:
                    repeats.append('중문반복:' + str(seen_content[key]) + '/' + str(content_repetitions[key]))
            if pos:
                seen_rows[row['id']] += 1
                if repetitions[row['id']] > 1:
                    repeats.append('원문공유:' + str(seen_rows[row['id']]) + '/' + str(repetitions[row['id']]))
            direct = [target for target in audit['wikiGraph'].get(node['id'], []) if node['id'] in source_nodes[target]['branch']] if node and node['kind'] == 'choice' else []
            branch = [{'id': choice, '중국어선택지': source_nodes[choice]['chinese']} for choice in node['branch']] if node else []
            return [numbered.get(node['id']) if node else None, doc_numbers[node['page']] if node else None,
                    site['siteOrder'] if site else None, site['page'] if site else None, status,
                    ('선택지' if node['kind'] == 'choice' else '분기응답' if node['branch'] else '장면설명' if node['kind'] == 'narration' else '일반대사') if node else site['kind'],
                    node['speaker'] if node else None, node['chinese'] if node else None, row['speaker'] if row else None,
                    row['text'] if row else None, korean if row else None, identity, row['id'] if row else None, node['id'] if node else site.get('occurrenceId') if site else None,
                    node['page'] if node else None, node['revision'] if node else None, node['location'] if node else None,
                    node['context'] if node else None, branch, direct if node else None, pos['nextIds'] if pos else None,
                    ';'.join(repeats) or '-', original or None, pos.get('officialCandidateIds', []) if pos else [r['talkId'] for r in node.get('official', [])] if node else [],
                    pos.get('method') if pos else None]

        lines += [chapter['title'] + ' — BWIKI 출현별 1:1 대조', '공식 입력: ' + report['commit'],
                  '문서 표시 순서와 사이트 표시 순서를 비교합니다. 공식 게임 실행 순서를 뜻하지 않습니다.',
                  '순번은 각각 독립적인 전체 순번입니다. 미확정·사이트 전용 행 때문에 같은 숫자일 필요는 없습니다.',
                  '하나의 BWIKI 출현은 출현ID로 하나의 사이트 출현과 연결하며, 반복 출현의 원문 행ID는 공유합니다.',
                  '공식ID 후보가 복수인 텍스트 공유 행의 행ID·공식ID는 저장 원문 참조입니다. 실제 출현 ID를 하나로 확정하지 않으며 후보 전체를 별도 열에 남깁니다.',
                  '중국어는 고정 수정본의 표시 본문입니다. 유사 번역으로 새 연결을 만들지 않았습니다. - 는 미확정/해당 없음입니다.',
                  '한국어 일치는 기존 공식 표시 변환(특수 공백·서식·이름 치환)을 적용해 검사하며, 공식 한국어 원본도 별도 열에 보존합니다.',
                  '열 구분: 탭. 본문 줄바꿈·탭·역슬래시는 \\n·\\t·\\\\로 기록합니다.',
                  'BWIKI 기여자 · CC BY-NC-SA 4.0 · https://creativecommons.org/licenses/by-nc-sa/4.0/',
                  '게임 원문의 권리는 HoYoverse 및 해당 권리자에게 있습니다.', '', '[A] BWIKI 문서 표시 순서 기준', '\t'.join(fields)]
        records = {}
        for node in speech:
            doc_numbers[node['page']] += 1
            values = entry(node)
            records[node['id']] = values
            counts[values[4]] += 1
            lines.append('\t'.join(map(cell, values)))
        lines += ['', '[B] 실제 사이트 표시 순서 기준 — 같은 출현의 역방향 대조', '\t'.join(fields)]
        for displayed in order:
            values = records.get(displayed.get('occurrenceId'))
            if values is None:
                values = entry(None, displayed)
                counts[values[4]] += 1
            lines.append('\t'.join(map(cell, values)))
        lines += ['', '[C] 장면 경계·미지원 구조 — 대사로 추정하지 않음', '구분\t문서\t수정번호\t원문위치\t표시제목']
        for n in audit['occurrences']:
            if n['kind'] not in ['line', 'choice', 'narration']:
                lines.append('\t'.join(map(cell, [n['kind'], n['page'], n['revision'], n['location'], n.get('label', '')])))
        lines += ['', '[D] 고정 문서와 미확정 기록', json.dumps(audit['sources'], ensure_ascii=False, indent=2),
                  json.dumps(audit['review'], ensure_ascii=False, indent=2)]
        filename = Path(chapter['file']).stem + '.txt'
        target = folder / filename
        target.write_text('\n'.join(lines) + '\n', encoding='utf-8-sig')
        files.append(target)
        item = {'file': filename, 'title': chapter['title'], 'bwikiSpeechOccurrences': len(speech), 'siteOccurrences': len(order),
                'linkedOccurrences': len(positions), 'unconfirmedBwikiOccurrences': len(speech) - len(positions), 'counts': dict(counts)}
        summary.append(item)
        if chapter['file'] == 'content/amphoreus-records--yesterdays-tomorrow.json':
            shutil.copyfile(target, args.output / '제8막_어제의_내일이_되어_BWIKI_1대1_대조.txt')
    manifest = {'commit': report['commit'], 'archiveCommit': args.archive_commit, 'policyVersion': report['policyVersion'], 'policyHash': report['policyHash'], 'codeHash': report['codeHash'],
                'chapterCount': len(summary), 'chapters': summary, 'readOnlyExport': True, 'referenceTxtUsed': False}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
    (args.output / '읽어주세요.txt').write_text('전체 36개 읽기 항목의 BWIKI 출현별 대조 파일입니다.\nA는 BWIKI 순서, B는 실제 사이트 순서, C는 미지원 구조, D는 수정본과 보류 사유입니다.\n확정 출현의 ID는 A/B에서 1:1 대응하며, 미확정 항목에는 대응을 추정하지 않았습니다.\n제8막 파일은 별도로 복사했습니다. manifest.json에 항목별 집계를 기록했습니다.\n', encoding='utf-8-sig')
    with zipfile.ZipFile(args.output / '전체36개_BWIKI_1대1_대조.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for target in files + [args.output / '읽어주세요.txt', args.output / 'manifest.json']:
            archive.write(target, target.relative_to(args.output))
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == '__main__':
    main()
