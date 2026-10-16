# 한국어 본문 연결과 검증

## 입력과 참고 방식

- 입력: 사용자의 로컬 `E:\references\starrail-quests`, 커밋 `a66ec9c36e3321ce4ea9e62b58e9326634628dce`.
- 고정 `dataset/manifest.json`의 조각·전체 압축·파일 SHA-256 검증을 통과한 JSON을 `.cache/starrail-source`로 복원했다. 참고 원본은 수정하지 않았다.
- 지원 입력은 이 스냅샷의 `catalog.json`, 임무 문서 JSON, `starrail-mission-dialogue-supplements.v1`, `starrail-deep-timeline-dialogue.v1`, `starrail-handbook-originals.v1`과 자료실 전용 `hsr-train-databank.v1`이다. 다른 스키마는 오류로 중단한다.
- `hk3rdtextkrserch`의 부분 문자열 검색, 50건 표시, 최대 41줄 주변 대사 열람 방식을 참고해 새로 작성했다. 참고 코드·붕괴 3rd 원문·엑셀은 복사하지 않았다.

## 변환 규칙과 수록 범위

사용자가 지정한 목차를 정규화한 챕터명과 대조한다. `·`/`•`와 공백 차이를 처리하며, 모험 임무 「내가 쓰는 대로」는 정확한 임무 제목으로 연결한다. 「좋은꿈과 성배」처럼 여러 지역에 걸친 같은 챕터는 해당 임무들을 함께 묶는다.

일반 문서의 `LOCAL_ID_ORDER_MATCH`, 명시적 임무 귀속이 있는 추가 대사, 단일 임무 귀속이 확인된 타임라인 대사를 사용했다. `UNVERIFIED_SCENE_MAPPING` 2,450개 장면은 제외했다. 같은 임무 안에서 같은 대사 ID와 종류의 중복 참조는 한 번 표시한다. 선택지는 별도 표시한다. 사용자 요청에 따라 `{NICKNAME}`과 별표로 감싼 형태를 `[개척자]`로 표시하며, 성별 등 다른 치환 토큰은 유지한다. 지원하는 색상·크기 등 서식 태그는 표시용 문자열에서 제거한다.

시뮬레이션 우주는 실험 임무·곤충 떼 재난·황금과 기계·차분화 우주·기물 기록으로 구성했다. 총 1,333개 읽기 항목(개척 36, 시뮬레이션 291, 아카이브 1,006), 58,598개 표시 행이다. 같은 임무가 분류상 두 곳에서 제공될 수 있으므로 이 수치는 서로 다른 대사 ID의 수가 아니다.

아스트로폴리스 편의 제6막 「천성에 던진 승부수」는 6개 임무의 1,051줄, 개척 후문 「무일푼 재벌 프로젝트」는 9개 임무의 1,120줄을 기존 고정 자료에서 변환했다. 제7막 「달 뜨기 전, 괴수와 춤을」은 대사 본문을 확인하지 못해 `MissionChapterConfig` 105009의 한국어 소개문 1줄만 수록하며 화면에 이를 명시한다. 소개문은 `DimbreathBot/TurnBasedGameData` 커밋 `312b4597691e0a29cf9828a15b592757dba86949`의 `MissionChapterConfig.json`과 한국어 텍스트 맵 두 파일을 정확한 정수 해시로 연결했다. `scripts/import-astropolis-intro.py`에서 Git blob 해시를 검증하고 SHA-256을 기록한다. 소개문을 대사 본문으로 간주하거나 임무 ID 접두사로 대사를 추정하지 않는다.

각 장의 JSON은 문서 ID, 대사 ID, 원본 구조 경로와 참조 커밋을 남긴다. `docs/content-provenance.json`에 사용한 문서 파일의 SHA-256과 제외 수를 기록했다. `public/content/search-index.json`에는 검색에 필요한 표시 필드와 장면 경계 식별자만 제공한다.

## 화면과 한계

에이언즈·고유 명사·파벌은 열차 자료실 전용 `NounAtlas.json`과 `NounAtlasChangeInfo.json`을 한국어 `TextMapKR_0.json`, `TextMapKR_1.json`에 정확한 64비트 해시로 연결한다. 입력 버전은 `DimbreathBot/TurnBasedGameData` 커밋 `724b139d8c9c32d12552eb95745a4fee72bfe48b`이며 Git blob과 SHA-256을 기록한다. Python 정수로 해시를 파싱해 JavaScript 숫자 정밀도 손실을 피한다. 100개 원문이 모두 연결되었고 소개문을 포함해 에이언즈 16개, 고유 명사 40개, 파벌 35개 메뉴로 묶인다.

자료실 메뉴는 소개문을 먼저 표시하고 `SortID`를 따른다. `NounAtlasChangeInfo`의 갱신 관계를 보존하며 같은 항목의 기본 기록과 갱신 기록을 선택할 수 있다. 기본 표시는 가장 뒤의 갱신 기록이며 실제 계정의 스토리 진행·해금 상태를 추정하지 않는다. 시뮬레이션 우주의 에이언즈 연구 기록과 `LoadingDesc` 용어 설명을 자료실 본문으로 사용하지 않는다. 이미지에서 전사했던 「명사」 소개문도 자료실 원문으로 교체했다. 기존 에이언즈·파벌 읽기 주소와 소개문 주소는 별칭으로 연결한다.

나머지 분류는 광추 170개, 적대적 생물 477개, 캐릭터 84개, 유물 184개를 제공한다. 기존 JSON과 같은 참고 커밋의 `public/handbook-originals.json`을 사용하며, 해당 파일은 `editorial/handbook-originals-manifest.json`의 SHA-256과 대조한다. 적대적 생물의 같은 이름을 가진 전투 변형은 한 항목으로 묶고 동일한 문단을 중복 표시하지 않는다. 이 네 분류의 수치는 게임 화면의 도감 개수나 수집 상태와 구분한다.

STORIES 아래 아카이브 메뉴에서 7개 분류로 이동할 수 있다. 분류 안에서는 왼쪽 목록의 이름을 검색하고 오른쪽 패널에서 원문을 읽는다. 홈 배너 오른쪽에 공식 최신 영상을 표시하며, 개척 임무·시뮬레이션 우주·아카이브 메뉴에는 사용자가 제공한 아이콘을 사용한다.

본문은 장별로 불러온다. 전체 검색은 검색 화면에서만 검색 자료를 불러오고 2,000개씩 처리하여 오래된 검색 결과의 반영을 막는다. 결과는 50줄씩 표시한다. 앞뒤 대사는 장·임무·장면·원본 구조 경계를 넘지 않으며 최대 41줄이다. 문자열은 React 텍스트 노드로 표시한다.

자료의 참조 순서는 실제 플레이 순서와 다를 수 있다. 현재 게임 설치 버전을 재추출한 것이 아니며 모든 컷신·분기·변경 대사의 수록을 보장하지 않는다. 연결이 확인되지 않은 장면을 임의로 채우거나 붕괴 3rd 대사로 대체하지 않았다. 기존 개척 임무 예시 대사는 별도 접힌 영역에 유지했다.

## 재생성

참고 원본을 기록된 커밋에 준비한 뒤 프로젝트 루트에서 실행한다. Python·Node 실행 파일은 설치 환경에 맞게 선택한다.

```powershell
python ../references/starrail-quests/tools/restore_dataset.py --bundle ../references/starrail-quests/dataset --target .cache/starrail-source
node scripts/fetch-train-databank.mjs
python scripts/import-train-databank.py
python scripts/import-astropolis-intro.py .cache/astro-source
node --experimental-strip-types scripts/import-local-dialogue.mjs .cache/starrail-source ../references/starrail-quests
pnpm test
pnpm build
```

원본 코드·전체 복원물·Git 이력은 커밋하지 않는다. 사이트에 필요한 변환 결과만 포함한다. 게임 원문과 이미지의 권리는 해당 권리자에게 있다.

## 릴리스 원문 자동 갱신

최초 고정 자료의 임무·장면 연결을 유지하면서 최신 한국어 문자열을 반영하는 [자동 갱신](automatic-content-updates.md)을 배포 작업에 연결했다. 이 문서의 고정 입력·초기 변환 기록과 자동 갱신의 적용 버전은 구분한다. `public/content-update.json`에서 현재 적용한 커밋과 수록 범위를 확인할 수 있다.

## 다국어 비교 원문

한국어에 적용한 동일한 릴리스 커밋의 `TextMapEN`, `TextMapCHS`, `TextMapJP`를 사용한다. 현재 고정 커밋은 `312b4597691e0a29cf9828a15b592757dba86949`이며 입력 Git blob·SHA-256과 언어별 수록 수는 `public/content/locales/manifest.json`에 기록한다. 각 언어에서 58,274줄(선택지 4,271줄)을 연결했고 324줄은 연결 근거가 없어 미제공으로 남긴다.

`scripts/import-localizations.py`는 Python 정수로 해시를 읽어 `TalkSentenceConfig`의 대사 ID, 보존한 `text-bindings.json`, `NounAtlas`의 정확한 기록 ID와 `MissionChapterConfig` 소개문을 연결한다. 같은 해시의 한국어가 실제 표시 원문과 일치할 때만 외국어를 제공한다. 순서나 유사한 문구로 추정하지 않는다. 자료실의 기본·갱신 기록은 각각의 행 ID로 보존한다. `{NICKNAME}`은 언어별 개척자 표기로 치환하며 다른 치환 토큰은 유지한다.

자동 갱신이 네 언어를 함께 검증·변환한다. 로컬에서 이미 검증한 다국어 계획과 원본을 준비한 경우 다음처럼 비교 파일만 재생성할 수 있다.

```powershell
python scripts/import-localizations.py . .cache/upstream-content/raw .cache/upstream-content/plan.json
```

원본 파일 전체는 캐시에만 보관하고 사이트에 수록한 행의 변환 결과만 제공한다. [DimbreathBot/TurnBasedGameData](https://github.com/DimbreathBot/TurnBasedGameData)의 안내에서 데이터 사용 시 출처 표시 요청을 확인했다. 외부 코드는 재사용하지 않았다. 게임 원문의 권리·저작권은 HoYoverse 및 해당 권리자에게 있다.

## 공식 영상

한국어 공식 채널 `UCH33CJMcI0XZUpIhWRHiUuw`의 공개 Atom 피드를 사용한다. 사용자가 지정한 `/videos` 화면에 맞춰 일반 영상 중 최신 항목을 선택하며, 일반 영상이 없는 피드에서만 Shorts를 사용한다. 6시간마다 및 소스 배포 시 확인하고, 장애 시 마지막 검증본을 유지한다. 썸네일을 누르면 공식 YouTube 임베드를 재생하며 원본 채널 링크도 제공한다. 별도의 API 키를 사용하지 않는다.
