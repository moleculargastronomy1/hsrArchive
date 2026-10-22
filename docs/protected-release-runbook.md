# 보호 구조 전환 실행서

이 문서는 운영 전환 승인을 받은 뒤 사용한다. 현재 운영 workflow와 저장소 공개 범위는 변경하지 않았다. 새로운 계정 연결, 리소스 생성, 업로드·배포·비공개 전환은 아직 실행하지 않았다.

## 실행 전 선택

계정은 사용자 확인상 GitHub Free다. 비공개 원본 저장소의 기존 project Pages는 유지되지 않는다. API 응답의 `plan: null`을 Free의 증거로 사용하지 않았다.

권장 무료 주소 유지안: 공개 사용자 Pages 저장소 `moleculargastronomy1/moleculargastronomy1.github.io`를 만들고, 검증한 공개 dist만 `/hsrArchive/` 아래에 게시한다. 조회 당시 이 저장소는 없었다. 원본 `hsrArchive`는 비공개로 전환한다. 기존 `https://moleculargastronomy1.github.io/hsrArchive/#...` 주소와 origin을 유지하므로 localStorage 북마크·읽기 위치·공유 링크를 보존할 수 있다. private CI의 `GITHUB_TOKEN`은 다른 저장소에 쓸 수 없으므로 공개 프런트 저장소에만 쓰기 권한이 있는 별도 GitHub App/세부 토큰이 필요하다. public repo에는 코드·cache·원문 artifact를 동기화하지 않는다.

대안은 GitHub Pro 전환 후 현재 private project Pages를 유지하거나, Cloudflare Static Assets/Pages로 프런트를 옮기는 것이다. 후자는 `workers.dev`/`pages.dev` 주소로 별도 도메인 없이 가능하지만 기존 origin의 사용자 데이터를 자동으로 다른 origin으로 옮길 수 없다. 주소 유지가 중요하므로 사용자 Pages 방식 또는 Pro가 적합하다. 어느 계정·플랜 변경도 자동 실행하지 않는다.

## 비밀과 설정

| 위치 | 이름 | 용도 |
| --- | --- | --- |
| Worker secret | `SESSION_SECRET` | 32자 이상 무작위 HMAC 키. 브라우저에 제공하지 않음 |
| Worker secret / private CI secret | `INTERNAL_TOKEN` / `HSR_PRIVATE_STATE_TOKEN` | 비공개 후보 업로드·복구·성공본 확정 |
| private CI secret | `CLOUDFLARE_API_TOKEN` | 선택한 계정의 Worker 배포·D1 관리. 필요한 리소스만 허용 |
| private CI variable | `CLOUDFLARE_ACCOUNT_ID` | 선택한 Cloudflare 계정 |
| Worker variables | `DATA_RELEASE`, `PREVIOUS_RELEASE`, `ALLOWED_ORIGINS`, `RATE_POLICY` | 버전 고정, 이전 버전 호환, 정책 조정 |
| Worker bindings | `DATA`, `SEARCH`, `SEARCH_PREVIOUS`, `GUARD`, `RELEASES` | 비공개 R2, 현재·이전 검색 DB, 제한/성공본 상태 |
| private CI/build variables | `VITE_DATA_API_URL`, `HSR_PRIVATE_STATE_URL`, `HSR_D1_DATABASE` | 공개 API 주소, 인증된 복구 주소, 이번 후보의 새 DB |
| 선택적 Worker variable/secret | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | 초과 요청에만 확인 절차. 등록 hostname/action 검증 |
| private CI secret | 별도 프런트 배포 토큰 | 선택한 공개 Pages 저장소에 공개 dist만 게시 |

`VITE_*`에는 공개 주소와 빌드가 정한 release만 둔다. `VITE_DATA_RELEASE`는 후보 생성기가 설정한다. 실제 `worker/wrangler.jsonc`, `.dev.vars`, `.env*`, 빌드/후보는 gitignore 대상이다. 예시 설정만 커밋한다. R2의 r2.dev/public custom domain은 반드시 비활성화한다. API URL과 사이트 키는 비밀이 아니다.

## 격리 후보 생성과 검증

Node 22.13 이상, Python 3.12 이상을 사용한다. 운영 CI는 기존대로 Node 22/Python 3.12다. 원문 갱신은 반드시 기존 공식 입력 변경 확인, `update:content`/source-first 검증, 회귀·보존 검사를 먼저 거친다. 검증 후 재수집하지 않는다.

```powershell
pnpm install --frozen-lockfile
node scripts/prepare-protected-baseline.mjs
pnpm test
$env:VITE_DATA_API_URL='http://127.0.0.1:8787'
pnpm build:protected
pnpm check:exposure
node scripts/check-protected-candidate.mjs
pnpm preview:protected
```

후보는 `.cache/protected`에만 저장한다. `candidate.json`은 원문·검증 코드·정책·입력 자료·검색 DB·실제 공개 dist의 SHA-256을 고정한다. 완료한 후보를 덮어쓰지 않는다. 새 후보는 새 격리 폴더에서 생성하고 실패 후보도 보존한다. `search.sql`/SQLite와 `r2` 아래 원문은 공개 artifact로 올리지 않는다. 수록 원문은 원래 JSON bytes로 복사하고, 공식 64비트 해시를 복구용으로 재직렬화하지 않는다.

본문은 50행, 문맥/선택지 응답은 41행, 번역은 요청한 언어·ID 최대 100개다. 서적/자료실의 갱신 기록 선택은 제목·ID 목록과 선택한 원문만 반환한다. 긴 단일 서적 행은 그 항목을 읽는 데 필요한 원문으로 제공한다. 행 수 제한은 byte 수 제한을 뜻하지 않는다. 원문·BWIKI·공식 실행 간선 생성기는 수정하지 않았다.

기본 분당 한도: 세션 180요청/검색30/페이지90/서로 다른 장40. 공유 IP는 1200요청/검색120/페이지240/장120으로 더 넓다. IPv6는 /64로 묶고 IP를 일별 HMAC 값으로 기록한다. 세션 회전도 공유 IP 한도를 받는다. 제한 상태는 SQLite Durable Object transaction으로 공유하고 시간이 지나면 해제한다. 선택적 edge limiter는 지역별 근사치이므로 엄밀한 세계 공통 제한은 DO가 담당한다. 실제 사용 로그를 보고 정책을 조정한다. 무작위 지연, 브라우저 API 키, URL 은폐는 사용하지 않는다.

Turnstile은 키를 설정한 경우에만 세션 초과 시 제안한다. 일반 방문에는 외부 확인 스크립트도 로드하지 않는다. 서버에서 성공·hostname·action을 검증한 뒤 같은 IP/브라우저/세션에 5분간 세션 한도를 2배로 허용한다. 공유 IP의 전체 한도는 풀지 않는다. 실제 계정 키를 통한 외부 확인 절차는 계정 연결 후 별도로 검증한다. 자동화된 테스트는 검증 실패·hostname/action 불일치·공유 한도 유지까지 검사한다.

## 승인 후 운영 연결 순서

1. 마지막 성공 배포본을 byte 검증하여 R2 비공개 후보로 보존한다. 기존 Pages와 신규 공개 프런트 경로의 실제 내용·캐시 상태를 먼저 기록한다.
2. 새 R2/SQLite DO와 **이번 후보 전용 새 D1 DB**를 준비한다. 기존 검색 DB를 덮어쓰지 않는다. Worker에는 새 `SEARCH`와 이전 `SEARCH_PREVIOUS`를 함께 연결한다. `DATA_RELEASE`/`PREVIOUS_RELEASE`도 함께 둔다. Worker가 갱신되는 동안 이전 프런트도 이전 release로 계속 읽을 수 있어야 한다.
3. 승인한 실제 API origin으로 후보를 생성·테스트한다. 로컬용 URL로 검증한 dist를 그대로 운영에 올리지 않는다. API origin 변경은 새 후보이므로 다시 검증한다. 실제 Worker의 CORS/비공개 R2/세션/문맥/번역/검색을 미리 확인한다.
4. `node scripts/upload-protected-candidate.mjs --upload`는 검증한 동일 bytes만 내부 인증 경로로 업로드한다. R2가 SHA-256을 확인하며 기존 같은 key의 내용은 변경하지 않는다. D1 import가 끝나야 `ready.json`을 만든다. 업로드 실패는 성공 포인터를 바꾸지 않는다.
5. 전체 회귀·복구·후보 seal 검사를 다시 통과한 같은 dist를 프런트 호스팅에 게시한다. 원본 project Pages에도 보호된 dist를 먼저 반영하고, 사용자 Pages의 같은 하위 경로도 준비하여 비공개 전환 시 주소를 이어받게 한다. 전환 기간에 두 자동 publisher가 경쟁하지 않도록 배포 직렬화를 유지한다.
6. 실제 GitHub Pages 기본 주소에서 기존 `content`, `locales`, 검색 JSON, 모든 provenance와 복구 gzip이 404인지 검사한다. HTML·모든 JS·map·service worker도 검사한다. 기존 CDN의 `max-age=600`과 이미 수집된 캐시를 고려해 재확인한다. 옛 파일이 200이면 전환 완료로 처리하지 않는다. 이미 다운로드된 복사본은 회수할 수 없다.
7. 공개 배포 성공과 live 계약 검사를 확인한 뒤에만 `HSR_EXPECTED_PREVIOUS_RELEASE`를 직전 성공 release(최초는 빈 문자열)로 지정하고 `node scripts/promote-protected-release.mjs --deployed`를 실행한다. DO가 이전 포인터를 비교하여 원자적으로 확정하며 같은 작업의 재시도는 안전하다. 그 다음 private CI의 상태 조회를 `HSR_PRIVATE_STATE_URL`로 바꾼다.
8. 사용자 승인 범위 내에서 원본 저장소를 비공개로 전환하고, 같은 원래 URL에서 사용자 Pages의 보호된 화면과 기존 북마크를 다시 검사한다. 외부 연동·원본 clone 권한·PR 접근·Actions 요금과 토큰 접근을 점검한다.

## 6시간 자동 갱신에 적용할 변경

현재 `.github/workflows/deploy-pages.yml`은 그대로 유지되어 기존 운영 갱신이 계속된다. 운영 전환 전에는 다음 연결을 완성해야 한다. 현재 private 서비스에 연결하여 예약 실행을 검증한 상태는 아니다.

- cron `15 */6 * * *`, 공식 입력/BWIKI/영상 변경 탐지와 독립 재시도·backoff·미확인 기록은 유지한다.
- 처음부터 private 원본 workflow에만 비밀과 원문 cache를 둔다. public PR에는 비밀이나 private cache를 제공하지 않는다. 공개 프런트 workflow는 이미 검사한 정적 파일만 받는다.
- `HSR_PRIVATE_STATE_URL`/token을 build job 환경에 설정하면 기존 복구·변경 확인 어댑터가 마지막 성공한 private release를 읽는다. 실패를 공개 Pages fallback이나 '변경 없음'으로 바꾸지 않는다.
- 기존 seal/최종 계약/`pnpm test` 후 정적 `pnpm build`를 `pnpm build:protected`로 바꾸고, 기존 `--check-build` 대신 `check-protected-candidate.mjs`와 노출 검사로 공개/비공개 산출물을 따로 검사한다. 원본 전체를 dist에 요구하는 기존 static seal 검사를 보호 빌드에 그대로 사용하면 안 된다.
- 새 DB/Worker release 준비 → 같은 후보 업로드 → **공개 dist만** 프런트 게시 → 성공 및 live 검사 → 성공 포인터 확정 순으로 연결한다. source-first 보고서·snapshot·raw search SQL을 public Actions artifact에 넣지 않는다.
- 배포 성공 후 재수집·재생성하지 않는다. 업로드·CI·프런트 배포 실패는 이전 성공 포인터를 유지하며 같은 후보를 재개한다. 마지막 성공 release/직전 DB·Worker·dist를 최소 2개 보관한다.

## 장애와 복구

| 실패 | 처리 |
| --- | --- |
| 공식 입력/BWIKI/영상 조회 실패 | 기존 검증기·재시도 정책 유지. 불확실한 내용은 확정하지 않음 |
| 원문·ID·귀속·간선·출현 손실 | 기존 보존 계약이 게시를 중단. private 후보를 남김 |
| API/R2/D1/제한 DO 장애 | 화면에 오류와 재시도. 공개 원문 JSON fallback 없음. 이전 검증 Worker/DB/dist로 복구 |
| R2 업로드/DB import 실패 | ready/success 포인터를 갱신하지 않음. 이전 프런트와 데이터 유지 |
| GitHub Actions/프런트 배포 실패 | 같은 후보 재사용. 성공 포인터와 기존 사용자 데이터 유지 |
| 복구 snapshot 손상 | 모든 항목 checksum 검증 후에만 복원. 실패 시 갱신 중단 |
| 오래된 확정 요청/동시 배포 | DO compare-and-swap이 409로 거절. 임의의 최신 후보를 성공본으로 취급하지 않음 |

지속적인 API 장애 중에는 새로운 원문 열람이 중단될 수 있다. 이것은 정적 사이트에 없던 의존성이다. 후보의 예전 Worker/DB/dist로 복구하되 원문이 공개된 정적 빌드를 복구본으로 사용하지 않는다. 같은 origin의 localStorage 북마크는 서버 장애와 독립적으로 남는다.

## 비용과 적합성 (2026-10-22 공식 요금 기준)

현재 후보의 R2 객체 약 311MB, 검색 SQLite 약 121MB, import SQL 약 72MB다. 저장 용량은 소규모이나 서버에서 JSON을 파싱하고 출현 계층을 만드는 CPU, 짧은 검색의 DB 스캔, 전체 FTS 재색인 쓰기 비용을 함께 봐야 한다.

- Workers Free: 100,000요청/일, CPU 10ms/요청. 로컬 실험은 가능하지만 실제 장 렌더링·검색·자동 import까지 무료 한도 안이라고 보장하지 않는다. 운영은 Workers Paid 최소 **$5/월**을 권장하며 승인 전 구독하지 않는다. 1,000만 요청/월과 CPU 3,000만 ms 포함, 초과는 각각 $0.30/백만 요청과 $0.02/백만 CPU ms다.
- R2 Standard: 10GB-month, A쓰기100만/월, B읽기1,000만/월 무료. 초과 $0.015/GB-month, 쓰기 $4.50/백만, 읽기 $0.36/백만. egress 무료. 매일 4번 전체 11,000여 객체를 다시 올리면 무료 쓰기를 넘을 수 있다(월 약 137만회 → 현재 과금 단위 기준 추가 약 $4.50). 실제로는 변경이 있을 때만 후보를 만든다. 7일 28개 후보는 약8.7GB지만 성공본을 만료시키는 일괄 lifecycle은 적용하지 않는다.
- D1 Free: 500만 행 읽기/일, 10만 쓰기/일, 총5GB. 본문 67,488행의 FTS/색인 import와 1~2글자 검색의 스캔은 무료 한도를 쉽게 소진할 수 있다. Paid는 읽기250억/월·쓰기5,000만/월·저장5GB 포함, 초과 읽기$0.001/백만·쓰기$1/백만·저장$0.75/GB-month다. 전체 재색인 쓰기는 실제 계정의 `rows_written`을 측정한 뒤 예상액에 반영한다.
- SQLite DO도 Free/Paid에 제공된다. Paid는 100만 요청/월·400,000GB-s 포함이며 초과 요청$0.15/백만·시간$12.50/백만GB-s와 저장 사용량이 적용된다. 모든 읽기 요청이 한 번씩 guard DO를 호출한다. Worker와 DO 요청 수는 별도다.
- Turnstile Free 사용 가능. 별도 도메인은 필수가 아니다. private GitHub Actions는 기존 public 무료 실행과 달리 계정의 포함 분량/저장 한도를 사용하므로 기존 6시간 실행 시간과 실제 변경 빈도로 별도 산정해야 한다.

작은 방문량과 드문 데이터 변경은 기본 $5에 가깝게 시작할 수 있으나 $5가 총액 상한은 아니다. 실제 배포 전 검색·FTS 재생성·동시 읽기의 CPU/행 쓰기 측정, 예산 알림, 리소스 유지 개수 결정을 승인 범위에 포함한다.

공식 근거: [Pages 플랜](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Workers 요금/로그](https://developers.cloudflare.com/workers/platform/pricing/), [R2 요금](https://developers.cloudflare.com/r2/pricing/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/), [DO 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Turnstile 플랜](https://developers.cloudflare.com/turnstile/plans/), [R2 checksum/조건부 쓰기](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
