# hsrArchive 참고 자료

기록일: 2026-10-16 (Asia/Seoul)

## 목표와 역할

붕괴: 스타레일 자료를 공개 아카이브 사이트로 제공한다. LimBooks의 기능을 분석해 같은 역할의 기능을 구현하고, 게임별 분류와 데이터 구조는 스타레일에 맞게 설계한다. 아래 기능은 참고 코드에서 확인할 대상으로, hsrArchive에 구현을 완료했다는 뜻은 아니다.

| 프로젝트 | 역할 | 로컬 위치 |
| --- | --- | --- |
| hsrArchive | 실제 개발·배포할 스타레일 아카이브 | `E:\hsrArchive` |
| LimBooks | 사이트 기능, 화면 구성, 탐색과 읽기 흐름의 기준 | `E:\references\LimBooks` |
| paimooon.github.io | 스타레일 텍스트 추출 도구로만 사용 | `E:\references\paimooon.github.io` |
| starrail-quests 설정집 | 스타레일 자료 분류, 설정·기록 간 연결과 읽기 구성의 보조 참고 | `E:\references\starrail-quests` |
| hk3rdtextkrserch | 붕괴 3rd 텍스트 사이트의 검색·주변 대사 열람 코드와 구현 방식 참고 | `E:\references\hk3rdtextkrserch` |

네 참고 저장소는 hsrArchive의 형제 폴더 아래에 별도로 clone했다. 원본 파일과 원본 Git 이력은 hsrArchive 커밋·배포에 포함되지 않는다. 다른 컴퓨터에서는 아래 URL로 다시 clone하고 이 문서의 커밋을 기준으로 확인한다.

## LimBooks — 사이트 기능 참고

- 원본: https://github.com/noita0130/LimBooks
- 브랜치: `master`
- 참고 커밋: `8b2dfe65f29c40213a7dc1a0549ec9f887040381`
- 버전 링크: https://github.com/noita0130/LimBooks/tree/8b2dfe65f29c40213a7dc1a0549ec9f887040381
- 구성: React, Vite, React Router, Tailwind CSS.

### 분석할 기능과 코드 위치

| 분석 대상 | 참고 코드 (LimBooks 기준) |
| --- | --- |
| 스토리 목록과 챕터 탐색 | `src/pages/StoryList.jsx`, `src/pages/ChapterList.jsx` |
| 스토리 읽기와 페이지 이동 | `src/pages/StoryReaderPage.jsx`, `src/pages/StoryContent.jsx` |
| 캐릭터 관련 이야기·음성 구성 | `src/pages/PersonalityPage.jsx`, `src/pages/PersonalityStoryContent.jsx`, `src/pages/PersonalityVoiceContent.jsx` |
| 음성 재생과 음량 조절 | `src/components/AudioButton.jsx`, `src/components/VolumeControl.jsx` |
| 다크 모드, 스크롤 복원, 이전·다음 이동 | `src/hooks/useDarkmode.jsx`, `src/pages/StoryReaderPage.jsx`, `src/utill/` |
| 원본 데이터 구조 | `src/data/`, `src/story/`, `public/` |

먼저 실제 동작과 데이터 의존성을 확인해 기능 목록을 작성한다. 림버스 고유 분류는 스타레일에 맞는 분류로 대응시키며, 음성 등 추가 자료가 필요한 기능은 실제 자료 확보 여부와 함께 검토한다. 이 목록은 초기 분석 출발점이며 원본 전체 기능 목록은 아니다.

## starrail-quests 설정집 — 스타레일 자료 구성 참고

- 지정 페이지: [설정집 · 연결해서 읽기](https://mizan0515.github.io/starrail-quests/%EC%84%A4%EC%A0%95%EC%A7%91.html)
- 원본 저장소: https://github.com/mizan0515/starrail-quests
- 로컬 위치: `E:\references\starrail-quests`
- 브랜치: `main`
- 참고 커밋: `a66ec9c36e3321ce4ea9e62b58e9326634628dce`
- 버전 링크: https://github.com/mizan0515/starrail-quests/tree/a66ec9c36e3321ce4ea9e62b58e9326634628dce
- 확인일: 2026-10-16 (Asia/Seoul). 공개 페이지는 HTTP 200으로 접근했고, 지역·인물별 항목과 설정·기록을 연결해 읽는 구성을 확인했다. 공개 페이지의 배포 커밋과 로컬 참고 커밋의 일치 여부는 확인하지 않았다.
- 참고 범위: 스타레일 자료 분류, 설정·기록의 연결, 관련 문서로 이동하는 탐색과 읽기 구성. 사용자 요청에 따라 이 고정 버전의 로컬 한국어 JSON도 검증·변환해 사이트 본문에 연결했다. 사용한 형식·출처·수록 범위는 `docs/content-import.md`와 `docs/content-provenance.json`에 기록했다.
- 사이트 전체 기능의 기준은 LimBooks, 텍스트 추출 도구는 paimooon.github.io로 유지한다. 이 자료는 스타레일에 맞는 콘텐츠 구성을 보조 참고한다.
- 최초 복제는 `--depth 1`로 최신 커밋만 내려받았다. 과거 이력 분석이 필요하면 별도로 가져온다.

## hk3rdtextkrserch — 텍스트 검색·열람 코드와 구현 방식 참고

- 원본: https://github.com/KARON099/hk3rdtextkrserch
- 로컬 위치: `E:\references\hk3rdtextkrserch`
- 브랜치: `main`
- 참고 커밋: `fc780d4cc71f49fe8d3f6788416e41f2453053d1`
- 버전 링크: https://github.com/KARON099/hk3rdtextkrserch/tree/fc780d4cc71f49fe8d3f6788416e41f2453053d1
- 확인일: 2026-10-16 (Asia/Seoul). 원본 코드를 정적으로 확인했으며 브라우저 실행과 성능 검증은 하지 않았다.
- 최초 복제는 `--depth 1`로 최신 커밋만 내려받았다.
- 사용 범위: 텍스트 검색, 검색 결과 표시, 주변 대사 열람의 코드와 구현 방식. 사이트 전체 기능의 기준은 LimBooks로 유지한다.

### 확인한 구성과 동작

| 참고 대상 | 코드·자료와 확인한 방식 |
| --- | --- |
| 정적 사이트 구성 | `index.html`에 HTML, CSS, JavaScript가 들어 있고 `loadData()`가 `dialogue.json`을 fetch한다. 별도 검색 서버를 호출하지 않는다. |
| 대사 데이터 | `dialogue.json`의 배열에서 `chapter`, `speaker`, `text`를 읽는다. `main_all.xlsx`도 포함되어 있지만 엑셀에서 JSON으로 만드는 변환 코드는 이 참고 커밋의 추적 파일에 없다. |
| 검색 인덱스와 처리 | 장명·화자·대사를 소문자로 미리 준비하고 `search()`에서 `includes()`로 부분 문자열을 검색한다. 2,000개 단위 처리 사이에 이벤트 루프에 제어를 넘기며, 검색 버전 번호로 오래된 검색의 반영을 막는다. |
| 검색 결과 표시 | `renderPage()`가 50건 단위로 표시한다. `highlight()`에서 검색어를 강조하며 원문을 HTML 이스케이프한다. |
| 주변 대사 보기 | `openContext()`와 `renderContext()`가 원본 배열의 인덱스로 선택한 대사와 주변 대사를 최대 41줄 표시한다. 41줄 단위 이동과 선택 대사로 돌아가기를 제공한다. 경계에서는 실제 앞뒤 줄 수가 달라지고, 장 경계를 별도로 제한하지 않는다. |
| 화면과 사용성 | 모바일에서 검색 결과를 카드로 표시하고 주변 대사를 전체 화면 대화상자로 보여준다. 다크 모드 선택을 localStorage에 저장하며 로딩·오류·재시도 화면을 제공한다. |

스타레일에 적용할 때는 원문 순서를 유지할 식별자와 장·장면 경계를 데이터 계약에 맞춰 정한다. 전체 JSON을 브라우저에 올리는 방식이 실제 스타레일 데이터 규모에 적합한지는 별도 측정한다. 붕괴 3rd 대사 데이터와 엑셀 파일은 참고 원본에만 보관하고 hsrArchive의 사이트 데이터로 넣지 않는다.

## 열차 자료실 원문 입력

- 에이언즈·고유 명사·파벌: `DimbreathBot/TurnBasedGameData`의 고정 커밋 `724b139d8c9c32d12552eb95745a4fee72bfe48b`에 있는 `ExcelOutput/NounAtlas.json`, `ExcelOutput/NounAtlasChangeInfo.json`, `TextMap/TextMapKR_0.json`, `TextMap/TextMapKR_1.json`.
- [자료실 항목 표](https://github.com/DimbreathBot/TurnBasedGameData/blob/724b139d8c9c32d12552eb95745a4fee72bfe48b/ExcelOutput/NounAtlas.json)의 제목·본문 해시와 정렬 순서를 대조하고, 한국어 입력은 Git blob 해시로 검증한다. 원본 전체 한국어 맵과 설정 표는 `.cache/train-databank`에만 보관한다.
- 입력을 직접 비교해 100개 원문과 91개 메뉴가 모두 연결됨을 확인했다. 사이트 화면의 기준은 LimBooks로 유지하며, 자료실 전용 원문을 시뮬레이션 우주 연구 기록과 구분한다. 이 작업은 게임 바이너리 추출기를 새로 실행한 것이 아니다.

## paimooon.github.io — 텍스트 추출 전용

업데이트별 확보 경로와 현재 제7막의 자료 한계는 [content-sources.md](content-sources.md)에 기록했다. 제7막 소개문 입력은 `DimbreathBot/TurnBasedGameData` 커밋 `312b4597691e0a29cf9828a15b592757dba86949`의 `ExcelOutput/MissionChapterConfig.json`, `TextMap/TextMapKR_0.json`, `TextMap/TextMapKR_1.json`이며 전체 원본은 `.cache/astro-source`에만 보관한다. 기존 참고 저장소와 기존 데이터의 고정 버전은 변경하지 않았다.

- 원본: https://github.com/paimooon/paimooon.github.io
- 브랜치: `main`
- 참고 커밋: `36eca4736eecfc84d5f2053865068e4426b17186`
- 버전 링크: https://github.com/paimooon/paimooon.github.io/tree/36eca4736eecfc84d5f2053865068e4426b17186
- 사용 범위: 스타레일 텍스트 추출. 사이트 UI와 아카이브 기능의 참고 기준은 LimBooks다.
- `binary.html`: README에서 스타레일 Binary File Reader로 안내하는 도구. 추출 작업 시 입력·출력 형식을 확인할 첫 대상.
- `translate.html`: README에서 스타레일 Translate Comparer로 안내하는 도구. 추출 과정에서 언어별 텍스트 확인이 필요한 경우에만 검토한다.

추출 도구의 현재 게임 버전 지원 여부와 실제 게임 바이너리 입력은 아직 검증하지 않았다. 원본 클라이언트 추출을 새로 실행한 것은 아니며, 고정된 로컬 한국어 JSON의 검증·사이트용 변환은 구현했다. 기능 분석은 `docs/architecture.md`, 실제 본문 연결 과정은 `docs/content-import.md`에 기록했다.

## 예정 데이터 흐름

1. 확보한 스타레일 입력 자료를 추출 도구로 읽는다.
2. 추출 결과를 ID, 언어, 분류, 순서 등 사이트에 필요한 구조로 변환한다.
3. 변환한 데이터를 hsrArchive의 탐색·읽기 화면에 연결한다.

사이트 내부 표시용 데이터 계약은 `src/data/types.ts`에 정의했다. 실제 추출 결과를 확인한 뒤 변환 계약과 필요한 확장을 확정한다.

## 다른 컴퓨터에서 참고 원본 준비

PowerShell 예시:

```powershell
git clone https://github.com/noita0130/LimBooks.git E:\references\LimBooks
git clone https://github.com/paimooon/paimooon.github.io.git E:\references\paimooon.github.io
git clone --depth 1 https://github.com/mizan0515/starrail-quests.git E:\references\starrail-quests
git clone --depth 1 https://github.com/KARON099/hk3rdtextkrserch.git E:\references\hk3rdtextkrserch
```

최신 브랜치는 위 참고 커밋과 다를 수 있다. 기록된 버전과 비교하려면 다음처럼 조회한다.

```powershell
git -C E:\references\LimBooks diff 8b2dfe65f29c40213a7dc1a0549ec9f887040381 HEAD --stat
git -C E:\references\paimooon.github.io diff 36eca4736eecfc84d5f2053865068e4426b17186 HEAD --stat
git -C E:\references\starrail-quests diff a66ec9c36e3321ce4ea9e62b58e9326634628dce HEAD --stat
git -C E:\references\hk3rdtextkrserch diff fc780d4cc71f49fe8d3f6788416e41f2453053d1 HEAD --stat
```

## 참고 원본 업데이트

원본을 업데이트하기로 했을 때만 실행한다. 로컬 변경이 있으면 먼저 확인한다.

```powershell
git -C E:\references\LimBooks status --short
git -C E:\references\paimooon.github.io status --short
git -C E:\references\starrail-quests status --short
git -C E:\references\hk3rdtextkrserch status --short
git -C E:\references\LimBooks pull --ff-only
git -C E:\references\paimooon.github.io pull --ff-only
git -C E:\references\starrail-quests pull --ff-only
git -C E:\references\hk3rdtextkrserch pull --ff-only
git -C E:\references\LimBooks rev-parse HEAD
git -C E:\references\paimooon.github.io rev-parse HEAD
git -C E:\references\starrail-quests rev-parse HEAD
git -C E:\references\hk3rdtextkrserch rev-parse HEAD
```

검토 후 이 문서의 기록일, 참고 커밋, 버전 링크와 변경된 기능 설명을 갱신한다. 원본 소스·에셋을 실제 프로젝트로 가져올 때는 해당 자료의 재사용 조건을 확인한다.

## Codex에서 이어서 작업

Codex 프로젝트 폴더를 `E:\hsrArchive`로 열고 작업한다. 프로젝트 루트의 `AGENTS.md`가 관련 작업에서 이 문서를 읽도록 안내한다. 로컬 경로를 변경하면 이 문서와 `AGENTS.md`의 경로 안내도 함께 수정한다.
