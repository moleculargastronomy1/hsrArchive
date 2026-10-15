# 열차 아카이브 · hsrArchive

붕괴: 스타레일 텍스트를 탐색하고 읽기 위한 비공식 아카이브입니다. React, TypeScript, Vite로 작성했습니다. **개척 임무 / 시뮬레이션 우주 / 아카이브**를 제공하며, 개척 임무 36개 목차(제7막은 소개문만 수록), 시뮬레이션 우주 291개 항목과 아카이브 1,006개 항목에 로컬 한국어 자료를 연결했습니다. 기존 예시 대사는 개척 임무 본문 아래 접힌 영역에 유지합니다.

## 실행

Node.js 22.13 이상과 pnpm 11.25.0을 사용합니다. 원문 갱신과 검증에는 Python 3.10 이상이 필요합니다. Python 실행 파일이 PATH에 없으면 `HSR_PYTHON`에 실행 파일 경로를 지정합니다.

```sh
pnpm install
pnpm dev
```

출력된 로컬 주소를 브라우저에서 엽니다. 기본 주소는 `http://127.0.0.1:5173`입니다.

```sh
pnpm test
pnpm build
pnpm preview
```

빌드 결과는 `dist/`에 생성됩니다. 상대 경로와 해시 라우팅을 사용하므로 GitHub Pages 같은 정적 호스팅의 하위 경로에서도 별도 SPA 재작성 규칙 없이 사용할 수 있습니다.

## 공개 웹사이트와 배포

사이트 주소: https://moleculargastronomy1.github.io/hsrArchive/

`.github/workflows/deploy-pages.yml`이 `main` push, 수동 실행, 6시간 간격으로 테스트·빌드 후 GitHub Pages에 배포합니다. 공식 유튜브 피드를 확인해 최신 일반 영상 정보를 갱신하며, 피드 장애 때는 마지막으로 확인한 정보를 유지합니다. 게시 시점과 확인 시점을 위젯에 표시합니다. Pages의 배포 소스는 **GitHub Actions**입니다.

같은 배포 작업에서 DimbreathBot의 `main` 릴리스와 한국어 파일 목록을 조회하고 연결된 원문을 자동 갱신합니다. 하나의 커밋에 고정한 입력을 Git blob 해시로 검증한 뒤 대사 ID·64비트 텍스트 해시로 연결합니다. 자료실 세 분류와 연결된 대사·설정 기록·소개문을 갱신하며, 새 임무의 귀속과 읽기 순서는 자동 추정하지 않습니다. 검증 실패 시 배포를 중단해 마지막 정상 사이트가 유지됩니다. 사이트 안내에서 적용 자료 버전과 최근 확인 시간을 볼 수 있습니다. [자동 갱신의 범위와 실행 방법](docs/automatic-content-updates.md).

```sh
pnpm update:content
pnpm test
pnpm build
```

배포에는 `dist/` 빌드 산출물만 업로드하며, 의존성 폴더와 로컬 캐시는 저장소에 커밋하지 않습니다. `package.json`의 `private: true`는 npm 패키지 실수 배포를 방지하는 설정으로, 웹사이트나 GitHub 저장소의 공개 여부와는 별개입니다.

## 구현 범위

- 홈·탐색: 개척 임무, 시뮬레이션 우주, 아카이브, 지역 필터, 목차
- 홈 배너: 공식 한국어 유튜브 최신 일반 영상 재생과 채널 이동
- 아카이브: 광추·적대적 생물·에이언즈·캐릭터·고유 명사·유물·파벌, 항목 이름 검색과 원문 열람
- 검색: 한국어 대사·화자·임무명, 분류 필터, 검색어 강조 (`Ctrl/Cmd + K`)
- 읽기: 장별 원문 지연 로딩, 50줄 페이지와 페이지 번호 입력 이동, 같은 장면 안의 앞뒤 최대 41줄 보기
- 내 서재: 북마크, 최근 읽은 장, 대사 페이지와 스크롤 위치 저장
- 설정: 밝은/어두운 테마, 읽기 글자 크기 조절
- 모바일 화면, 키보드 탐색과 본문 바로가기

사용자 기록은 `localStorage`의 `hsr:` 접두사 키에 저장합니다. 서버 저장과 기기 간 동기화는 없습니다. 저장 공간에 접근할 수 없어도 현재 세션에서 읽기와 설정을 사용할 수 있습니다.

## 구조

```text
src/
  App.tsx                 화면, 해시 라우팅, 탐색·읽기 흐름
  components/WorldArt.tsx  자체 제작한 지역별 SVG 장식
  data/types.ts           사이트용 자료 계약
  data/archive.ts         분류·지역·목차와 원문 메타데이터
  components/DialogueBrowser.tsx  검색·본문·주변 대사 뷰어
  components/OfficialVideo.tsx    공식 최신 영상 위젯
  components/CategoryIcon.tsx     사용자 제공 메뉴 아이콘
  components/CodexReader.tsx      아카이브 목록 검색과 원문 열람
  lib/archive.ts          본문 검색, 챕터 이동, 주소 생성
  lib/storage.ts          로컬 기록과 설정 저장
  styles.css              테마, 반응형 레이아웃
tests/archive.test.ts     검색·필터·챕터 이동 검증
docs/architecture.md      참고 기능 분석, 데이터 연결 계획
docs/references.md        참고 원본과 버전
public/content/          변환한 장별 한국어 원문과 검색 자료
scripts/                 로컬 자료 변환, 공식 영상 피드 갱신
```

개척 임무 표지와 메뉴 아이콘은 사용자가 제공한 `docs/reference-images/`를 사용합니다. 참고 저장소의 코드와 Git 이력은 복사하지 않았습니다. Google Fonts 연결이 없으면 시스템 글꼴을 사용합니다. 게임 음성·로그인은 포함하지 않습니다.

## 한국어 본문과 출처

고정한 로컬 `starrail-quests` JSON과 열차 자료실 전용 `NounAtlas` 한국어 원문에서 58,598개 표시 행을 변환했습니다. 붕괴 3rd 뷰어는 검색과 주변 대사 열람 방식만 참고했고, 붕괴 3rd 대사는 포함하지 않습니다. 게임 원문의 권리는 해당 권리자에게 있습니다.

입력 검증, 임무 연결, 제외한 장면, 재생성 방법과 한계는 [데이터 변환 문서](docs/content-import.md)에 기록했습니다. 실제 게임 버전 전체 수록이나 플레이 순서의 완전한 복원을 보장하지 않습니다. 원본 게임 바이너리 추출기의 호환성을 새로 검증했다고 주장하지 않습니다.
