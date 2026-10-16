# 인게임 서적

왼쪽 STORIES의 **서적** 메뉴에서 6개 지역별로 이동한다. 지역 안에서는 시리즈별 권 목록을 제공하고, 제목·시리즈 검색과 게임 내 책장 수록/기타 문서 분류로 찾는다. 서적 읽기는 기존 북마크·읽기 기록·글자 크기·테마 및 영문·중문(간체)·일문 동시 비교 기능에 연결했다. 전체 원문 검색에서도 서적 범위를 선택할 수 있다.

## 입력과 연결

- 원본: [DimbreathBot/TurnBasedGameData](https://github.com/DimbreathBot/TurnBasedGameData), 릴리스 커밋 `312b4597691e0a29cf9828a15b592757dba86949`.
- `BookSeriesWorld`의 정확한 지역 ID → `BookSeriesConfig`의 시리즈 ID → `LocalbookConfig`의 서적 ID·권 순서 → 같은 커밋의 한국어 TextMap.
- 64비트 텍스트 해시는 Python 정수로 읽고 표시 데이터의 `textHash`에는 십진 문자열로 보존한다. 아이템 설명인 `ItemConfigBook.ItemDesc`를 서적 본문으로 대체하지 않는다.
- 시리즈 ID와 `BookSeriesInsideID`로 정렬한다. 같은 권 순서 값이 여러 개 있는 원본은 `BookID` 순으로 함께 보존하며 중복으로 버리지 않는다. 실제 플레이·획득 순서를 추정하지 않는다.
- `IsShowInBookshelf`를 따라 책장 수록 여부만 구분한다. 개인 계정의 수집·해금 여부를 뜻하지 않는다.
- 한국어 원문과 정확히 일치하는 해시에만 영어·중국어·일본어를 연결한다. 서식 태그는 표시 문자열에서 제거하고 줄바꿈과 치환 토큰은 기존 규칙에 따라 보존한다.

## 수록과 검증

현재 828개 시리즈, 1,121권을 제공한다. 게임 내 책장 수록 서적은 894권, 기타 문서는 227권이다. 지역별 권 수는 우주정거장 124, 야릴로 163, 선주 나부 219, 페나코니 180, 앰포리어스 209, 이상 낙원 226이다. 이미지가 포함된 서적 25권은 텍스트 원문만 제공하며 읽기 화면에 삽화 미수록을 표시한다.

`public/books-provenance.json`에 입력 Git blob·SHA-256과 수록 수를 기록한다. 원본은 `.cache/upstream-content`에만 보관하고 `src/data/books.json`의 목록과 권별 본문·비교 데이터만 커밋한다. 게임 원문의 권리와 저작권은 HoYoverse 및 해당 권리자에게 있다. 원본 저장소의 데이터 사용 시 출처 표시 요청에 따라 사이트 안내에 출처를 유지한다.

## 자동 갱신

`update-content.mjs`는 기존 네 언어 입력과 함께 서적 표 3개를 같은 릴리스 커밋에서 조회·검증한다. 임시 출력에서 `import-books.py`가 서적을 생성하고, `project-upstream-content.py`가 기존 자료와 서적의 전체 검색 자료를 생성한 뒤 `import-localizations.py`가 비교 원문을 만든다. 서적 ID는 읽기 주소·북마크·기록의 키다.

```powershell
node scripts/update-content.mjs --plan
node scripts/update-content.mjs --apply
pnpm test
pnpm build
```

이미 검증된 입력이 있는 경우 `python scripts/import-books.py .cache/upstream-content/raw .cache/upstream-content/plan.json`으로 목록·본문을 다시 만들 수 있다. 전체 검색 및 비교 기록도 맞추려면 위 자동 갱신을 이어서 실행한다.
