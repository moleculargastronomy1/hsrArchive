# 한국어 본문 연결과 검증

## 입력과 참고 방식

- 입력: 사용자의 로컬 `E:\references\starrail-quests`, 커밋 `a66ec9c36e3321ce4ea9e62b58e9326634628dce`.
- 고정 `dataset/manifest.json`의 조각·전체 압축·파일 SHA-256 검증을 통과한 JSON을 `.cache/starrail-source`로 복원했다. 참고 원본은 수정하지 않았다.
- 지원 입력은 이 스냅샷의 `catalog.json`, 임무 문서 JSON, `starrail-mission-dialogue-supplements.v1`, `starrail-deep-timeline-dialogue.v1`이다. 다른 스키마는 오류로 중단한다.
- `hk3rdtextkrserch`의 부분 문자열 검색, 50건 표시, 최대 41줄 주변 대사 열람 방식을 참고해 새로 작성했다. 참고 코드·붕괴 3rd 원문·엑셀은 복사하지 않았다.

## 변환 규칙과 수록 범위

사용자가 지정한 33개 목차를 정규화한 챕터명과 대조한다. `·`/`•`와 공백 차이를 처리하며, 모험 임무 「내가 쓰는 대로」는 정확한 임무 제목으로 연결한다. 「좋은꿈과 성배」처럼 여러 지역에 걸친 같은 챕터는 해당 임무들을 함께 묶는다.

일반 문서의 `LOCAL_ID_ORDER_MATCH`, 명시적 임무 귀속이 있는 추가 대사, 단일 임무 귀속이 확인된 타임라인 대사를 사용했다. `UNVERIFIED_SCENE_MAPPING` 2,450개 장면은 제외했다. 같은 임무 안에서 같은 대사 ID와 종류의 중복 참조는 한 번 표시한다. 선택지는 별도 표시한다. 사용자 요청에 따라 `{NICKNAME}`과 별표로 감싼 형태를 `[개척자]`로 표시하며, 성별 등 다른 치환 토큰은 유지한다. 지원하는 색상·크기 등 서식 태그는 표시용 문자열에서 제거한다.

시뮬레이션 우주는 실험 임무·곤충 떼 재난·황금과 기계·차분화 우주·기물 기록으로 구성했다. 총 324개 읽기 항목(개척 33, 시뮬레이션 291), 54,871개 표시 행이다. 같은 임무가 분류상 두 곳에서 제공될 수 있으므로 이 수치는 서로 다른 대사 ID의 수가 아니다.

각 장의 JSON은 문서 ID, 대사 ID, 원본 구조 경로와 참조 커밋을 남긴다. `docs/content-provenance.json`에 사용한 문서 파일의 SHA-256과 제외 수를 기록했다. `public/content/search-index.json`에는 검색에 필요한 표시 필드와 장면 경계 식별자만 제공한다.

## 화면과 한계

본문은 장별로 불러온다. 전체 검색은 검색 화면에서만 검색 자료를 불러오고 2,000개씩 처리하여 오래된 검색 결과의 반영을 막는다. 결과는 50줄씩 표시한다. 앞뒤 대사는 장·임무·장면·원본 구조 경계를 넘지 않으며 최대 41줄이다. 문자열은 React 텍스트 노드로 표시한다.

자료의 참조 순서는 실제 플레이 순서와 다를 수 있다. 현재 게임 설치 버전을 재추출한 것이 아니며 모든 컷신·분기·변경 대사의 수록을 보장하지 않는다. 연결이 확인되지 않은 장면을 임의로 채우거나 붕괴 3rd 대사로 대체하지 않았다. 기존 개척 임무 예시 대사는 별도 접힌 영역에 유지했다.

## 재생성

참고 원본을 기록된 커밋에 준비한 뒤 프로젝트 루트에서 실행한다. Python·Node 실행 파일은 설치 환경에 맞게 선택한다.

```powershell
python ../references/starrail-quests/tools/restore_dataset.py --bundle ../references/starrail-quests/dataset --target .cache/starrail-source
node --experimental-strip-types scripts/import-local-dialogue.mjs .cache/starrail-source ../references/starrail-quests
pnpm test
pnpm build
```

원본 코드·전체 복원물·Git 이력은 커밋하지 않는다. 사이트에 필요한 변환 결과만 포함한다. 게임 원문과 이미지의 권리는 해당 권리자에게 있다.

## 공식 영상

한국어 공식 채널 `UCH33CJMcI0XZUpIhWRHiUuw`의 공개 Atom 피드를 사용한다. 사용자가 지정한 `/videos` 화면에 맞춰 일반 영상 중 최신 항목을 선택하며, 일반 영상이 없는 피드에서만 Shorts를 사용한다. 6시간마다 및 소스 배포 시 확인하고, 장애 시 마지막 검증본을 유지한다. 썸네일을 누르면 공식 YouTube 임베드를 재생하며 원본 채널 링크도 제공한다. 별도의 API 키를 사용하지 않는다.
