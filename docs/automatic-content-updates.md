# 원문 자동 갱신

paimooon의 [translate.html](https://github.com/paimooon/paimooon.github.io/blob/36eca4736eecfc84d5f2053865068e4426b17186/translate.html#L86-L127)에서 확인한 최신 커밋 조회, 언어별 파일 발견, 병합 방식을 참고해 이 아카이브의 갱신 코드를 새로 구현했다. 해당 사이트의 화면이나 코드를 복사하지 않았다.

## 실행 시점

기존 `.github/workflows/deploy-pages.yml`의 main push, 수동 실행, 6시간 cron에 원문 갱신 단계를 연결했다. 매 방문자에게 전체 원본을 다운로드시키지 않고 배포 과정에서 검증·변환한 자료를 제공한다. GitHub 예약 실행은 대기 상황에 따라 지연될 수 있다.

## 처리 과정

1. GitHub REST API의 `commits/main`에서 `DimbreathBot/TurnBasedGameData` 릴리스 커밋과 버전 문자열을 읽는다.
2. 그 커밋으로 `TextMap` 디렉터리와 ExcelOutput Git tree를 조회한다. Contents API의 1,000개 파일 제한 때문에 전체 테이블 목록은 Git Trees API로 조회한다.
3. `TextMapKR.json` 또는 연속된 `TextMapKR_0.json` 등의 한국어 조각과 영어(`EN`)·중국어 간체(`CHS`)·일본어(`JP`) TextMap, `NounAtlas`, `NounAtlasChangeInfo`, `TalkSentenceConfig`, `MissionChapterConfig`를 받는다. 각 언어의 전체·분할 형식을 검증하고 서로 다른 커밋의 파일을 섞지 않는다.
4. 파일마다 Git blob SHA-1을 검증하고 내용 기반 캐시에 보관한다. Python 정수로 JSON을 파싱하여 64비트 해시 정밀도를 유지한다.
5. 임시 출력에서 자료실 세 분류를 다시 생성하고, 기존 행을 정확한 TalkSentence ID 또는 보존된 텍스트 해시로 갱신한다. 기존 임무·장면·선택지 역할과 행 ID는 보존한다. 연결되지 않은 문장은 기존 본문을 유지한다.
6. 한국어 갱신 후 `import-localizations.py`가 동일한 해시의 한국어가 표시 원문과 일치하는 행만 영문·중문·일문으로 연결한다. 모든 payload·메타데이터·행 ID·행 개수를 검증한 뒤 생성 결과와 전체 검색 자료·언어별 비교 파일을 반영한다. 테스트와 빌드까지 통과하면 Pages에 배포한다. 원본 다운로드·변환·테스트 중 실패가 있으면 새 배포가 실행되지 않는다.

다운로드 URL은 API가 알려 준 파일의 경로와 고정 커밋으로 구성한다. `GITHUB_TOKEN`은 GitHub Actions의 공개 자료 조회에만 사용하며 파일·로그·배포물에 저장하지 않는다. 원본 JSON과 캐시는 `.cache/upstream-content`에만 둔다. 자동 실행은 저장소에 커밋하거나 쓰기 권한을 확대하지 않는다.

## 갱신 범위와 한계

- 에이언즈·고유 명사·파벌: 최신 NounAtlas의 항목·정렬·본문·갱신 기록을 반영한다. 기존 기록이 갑자기 사라지면 검증을 중단해 저장된 읽기 주소를 임의로 지우지 않는다.
- 기존 개척 임무·시뮬레이션 우주 대사: 정확히 연결되는 대사 ID의 한국어 본문과 화자 이름을 갱신한다. 원래 장면 순서와 분기는 유지한다.
- 다른 설정 기록·기물: 최초 변환 때 보존한 문자열 해시가 최신 한국어 맵에 있으면 갱신한다. 해시 자체가 바뀌거나 연결이 없으면 기존 기록을 유지한다.
- 제7막: 현재 연결된 챕터 소개문을 갱신한다. TextMap에 문자열이 있다고 해서 새 임무의 대사 순서와 귀속을 추정하지 않는다. 따라서 제7막 전체 본문이나 이후 새 챕터가 자동으로 생기는 기능은 아니다.

`public/content-update.json`은 적용 커밋·릴리스 버전·확인 시각·입력 해시·정확히 연결한 행 수·기존 원문을 유지한 행 수를 공개한다. 각 payload는 원래 구조 출처를 보존하며 `textReferenceCommit`과 `retainedTextRowIds`를 통해 갱신 범위를 구분한다. `docs/content-provenance.json`은 최초 변환 자료의 고정 감사 기록이며 자동 갱신 기록은 별도다. 사이트 안내에서 버전과 확인 시각을 표시한다.

메인 공지사항의 날짜는 `아카이브 업데이트 : YYYY.MM.DD`로 표시한다. LimBooks에서 확인한 공지 날짜와 내용의 구분을 참고하되, 이 사이트는 소스 수정 사항을 배포할 때 날짜를 자동 생성한다. `pnpm build`가 `scripts/update-site-status.mjs`를 실행하여 현재 Git 커밋과 커밋 시각을 `public/site-update.json`에 기록한다. 화면은 한국 시간 날짜를 표시한다. 새 수정 커밋이 배포되면 날짜가 바뀌며, 같은 소스의 예약 재빌드나 자료 재확인만으로는 날짜가 바뀌지 않는다. 게임 출시일이나 원본 자료의 확인 시각과 구분한다.

`latestTrailblaze`는 검증된 `MissionChapterConfig`와 같은 커밋의 한국어 TextMap에서 매번 생성한다. 번호가 있는 정규 개척 임무 중 가장 뒤의 장·막을 선택하고 후문·종말·이벤트는 제외한다. 원본의 `제5막•제7장` 표기는 사이트의 장·막 체계에 맞춰 `5장 7막`으로 표시한다. 새 버전에 새 정규 장이 있으면 제목과 번호도 자동으로 바뀐다. 이 공지는 릴리스 자료의 최신 임무를 안내하며, 해당 임무의 대사 본문 수록 여부와는 별개다.

화면은 빌드에 포함된 기록을 즉시 표시하고, 열 때마다 공개 갱신 파일을 캐시 재검증하여 읽는다. 파일 조회가 실패하거나 형식이 잘못되면 빌드에 포함된 기록을 유지한다.

## 로컬 실행

Node.js 22.13 이상, Python 3.10 이상이 필요하다. Python 경로는 `HSR_PYTHON`으로 지정할 수 있다.

```sh
pnpm update:content
pnpm test
pnpm build
```

GitHub Actions는 같은 실행을 두 단계로 나눠 커밋별 원본 캐시를 복원한다.

```sh
node scripts/update-content.mjs --plan
node scripts/update-content.mjs --apply
```

`--apply`는 바로 앞에서 확인한 계획을 사용한다. 확인 시각도 계획의 시각으로 기록한다. 수동 고정 자료 재생성 스크립트를 실행한 경우에는 자동 갱신을 다시 실행해 최신 기록과 검색 자료를 맞춘다.

최초 로컬 검증에서는 `OSPRODWin4.6.0_D16728363_A16704710_L16700845`, 커밋 `312b4597691e0a29cf9828a15b592757dba86949`로 58,598개 행 중 58,274개를 정확히 연결했고, 447개 행의 문구·화자를 갱신했다. 324개 행은 기존 본문을 유지했다. 같은 원본으로 다시 실행하면 문구 변경 수는 0이며 중복 행을 추가하지 않는다.
