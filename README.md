# 열차의 서고 · hsrArchive

붕괴: 스타레일 텍스트를 탐색하고 읽기 위한 비공식 아카이브의 기본 뼈대입니다. React, TypeScript, Vite로 작성했습니다. 개척 임무 목록은 사용자가 제공한 프롤로그와 제1~5장의 제목·소개문·목차 33개를 반영했습니다. 앰포리어스의 「모험 임무: 내가 쓰는 대로」는 제8막의 하위 항목으로 표시합니다. **챕터의 예시 대사는 유지했으며 실제 게임 텍스트가 아닙니다.**

## 실행

Node.js 22.6 이상과 pnpm을 사용합니다.

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

`.github/workflows/deploy-pages.yml`이 `main` 브랜치에 push될 때 테스트와 빌드를 실행한 뒤 GitHub Pages에 배포합니다. Actions 화면에서 수동 실행할 수도 있습니다. Pages의 배포 소스는 **GitHub Actions**입니다.

배포에는 `dist/` 빌드 산출물만 업로드하며, 의존성 폴더와 로컬 캐시는 저장소에 커밋하지 않습니다. `package.json`의 `private: true`는 npm 패키지 실수 배포를 방지하는 설정으로, 웹사이트나 GitHub 저장소의 공개 여부와는 별개입니다.

## 구현 범위

- 홈: 지역별 개척 임무, 동행 임무, 내 서재 진입
- 탐색: 개척 임무·동행 임무·읽을거리 분류, 지역 필터
- 검색: 제목, 태그, 챕터 제목, 화자, 본문 검색 (`Ctrl/Cmd + K`로 검색창 이동)
- 읽기: 챕터 목차, 대사·장면 설명 구분, 이전·다음 장 이동
- 내 서재: 북마크, 최근 읽은 장과 스크롤 위치 저장
- 설정: 밝은/어두운 테마, 읽기 글자 크기 조절
- 모바일 화면, 키보드 탐색과 본문 바로가기

사용자 기록은 `localStorage`의 `hsr:` 접두사 키에 저장합니다. 서버 저장과 기기 간 동기화는 없습니다. 저장 공간에 접근할 수 없어도 현재 세션에서 읽기와 설정을 사용할 수 있습니다.

## 구조

```text
src/
  App.tsx                 화면, 해시 라우팅, 탐색·읽기 흐름
  components/WorldArt.tsx  자체 제작한 지역별 SVG 장식
  data/types.ts           사이트용 자료 계약
  data/archive.ts         예시 자료와 분류·지역 메타데이터
  lib/archive.ts          본문 검색, 챕터 이동, 주소 생성
  lib/storage.ts          로컬 기록과 설정 저장
  styles.css              테마, 반응형 레이아웃
tests/archive.test.ts     검색·필터·챕터 이동 검증
docs/architecture.md      참고 기능 분석, 데이터 연결 계획
docs/references.md        참고 원본과 버전
```

개척 임무 표지는 사용자가 `docs/reference-images/`에 제공한 이미지를 연결합니다. 프롤로그와 제1~4장은 각 지역의 이미지, 제5장은 이상 낙원·아스트로폴리스 이미지를 함께 표시합니다. 참고 저장소의 코드는 복사하지 않았습니다. Google Fonts를 불러오며 네트워크가 없으면 시스템 글꼴로 표시됩니다. 게임 음성, 실제 텍스트 추출·변환, 로그인은 후속 작업입니다.
