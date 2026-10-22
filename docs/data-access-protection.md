# 데이터 접근 보호: 조사와 격리 전환

## 1단계 조사 (2026-10-22)

기준: `5a806efc0869528f5b46735ec608498d579b8022`. GitHub API와 `git ls-remote`로 최신 main과 일치함을 확인했다. 기존 작업 폴더의 미커밋 데이터와 이미지는 건드리지 않는다. 구현 브랜치는 `feature/data-access-protection`이다. 운영 부하 검사는 하지 않는다.

- 공개 원본 저장소: Git clone, ZIP, raw, 커밋 이력으로 `public/content`, `src/data`, `editorial`의 원문·연결·검토 근거를 받을 수 있다. 비공개 전환은 과거 복사본·분리된 fork를 회수하지 않는다.
- Pages: `.github/workflows/deploy-pages.yml`이 6시간 cron, main push, 수동 실행을 지원한다. 변경 확인 → 마지막 성공 상태 복구 → 공식 입력/BWIKI/영상 검증 → 보존 계약 → 테스트 → 스냅샷 → Vite build → seal 검사 → 동일 dist 배포 순서다. 최근 2회 예약 실행은 success였다. Actions 성공은 모든 대사 검증 완료를 뜻하지 않는다.
- 한국어: `public/content/{entry}--{chapter}.json`의 `rows`에 공식 ID, 사이트 행 ID, 원문, 귀속, 공식/BWIKI/영상 간선과 `wikiReading` 출현 그래프가 있다. 2,840개 본문 파일, 67,150개 원문 행. 검색 파일 포함 160,327,847 bytes.
- 전체 검색: `public/content/search-index.json`은 67,150행의 원문을 포함한다. 검색 화면에서 한 번 받으면 대량 복원이 가능하다.
- 다국어: `public/content/locales/{en,zh-CN,ja}/*.json`, 언어별 66,826행. 전체 upstream TextMap 자체는 `.cache`에 있으나 사이트에 수록된 번역은 경로 순회로 취득 가능하다.
- 증거: `bwiki-provenance.json` 약 30MB, `source-first-provenance.json`, `dialogue-flow-provenance.json`, 영상 기록에는 귀속·간선·검토 자료가 있다.
- 복구: `verification-state.json`이 공개 gzip 스냅샷을 가리킨다. `packState`는 전체 파생 원문·다국어·메타데이터를 base64로 묶는다. 본문 파일만 제거하면 이 경로로 우회할 수 있다.
- 정적 빌드: Vite는 `public`을 전부 복사한다. `archive.ts`가 JSON 메타데이터와 blocks를 JS에 포함한다. protected build는 공개 디렉터리와 JSON import 양쪽을 제한해야 한다. 현재 서비스 워커 등록 코드는 없다. 이미 받은 브라우저·외부 캐시는 회수할 수 없다.
- CI cache는 배포 디렉터리와 분리되어 있지만 공개 저장소의 PR/Actions 접근 정책에 따라 신뢰 경계를 다시 확인해야 한다. 공개 저장소에 새 비밀 데이터 cache/artifact를 만들지 않는다.

## 최소 변경 설계와 위험

표시·검증 원본 파일은 그대로 보존한다. 기존 정적 모드는 유지하고 별도 protected build만 공개 파일 허용 목록, 본문 없는 메타데이터, Worker API를 사용한다. R2는 비공개 원본/복구 저장, D1은 서버 검색, Durable Object는 IP별 공유 제한 상태를 담당한다. page 50행, 문맥/응답 41행, 번역은 요청한 행·언어만 제공한다. 문맥 생성은 기존 검증된 TypeScript 함수를 그대로 재사용한다. API 장애는 명시적 재시도 UI로 처리하고 공개 JSON으로 fallback하지 않는다.

변경 대상: Vite protected 설정, 전용 빌드/후보/노출 검사 스크립트, Worker와 조정 가능한 제한 정책, DialogueBrowser/CodexReader/다국어 데이터 어댑터, 비공개 CI 상태 조회 어댑터, 격리 테스트/전환 실행서. 원문·간선 생성기는 수정하지 않는다.

주요 위험은 공개 복구 스냅샷 잔존, 번들 내부 blocks, 검색 비용, 공유 IP 오탐, 프런트/API 버전 불일치, 검증 후 데이터 재생성, 비공개 전환 시 Pages 중단이다. 완전 수집 방지는 불가능하다. 분산 IP·낮은 속도·실제 브라우저 수집은 남는다. CORS·robots·URL 은폐·클라이언트 키는 접근 통제가 아니다.

사용자 확인: 계정은 GitHub Free. Free의 비공개 저장소는 Pages 미지원이다. 현재 주소를 유지하려면 별도 공개 프런트 저장소와 비공개 원본 사이의 배포 또는 GitHub Pro 전환이 필요하다. 대안은 Cloudflare Static Assets/Pages 프런트 호스팅과 기존 URL의 안내/이동이다. 새 저장소·서비스·결제·공개 범위 변경은 별도 승인 사항이다.

공식 근거: [GitHub Pages 플랜](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [공개 범위 변경](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility), [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/), [R2 요금](https://developers.cloudflare.com/r2/pricing/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/), [DO 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/), [rate limiter의 지역별 근사 한계](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
