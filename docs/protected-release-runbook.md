# 보호 구조 전환 실행서

이 문서는 최초 운영 전환 승인을 받은 뒤 사용한다. 최신 상태는 저장소 Public, 기존 Pages 복구 배포 `39702559290` attempt 2 성공이다. 운영 main에는 보호 코드를 합치지 않았다. Cloudflare 로그인·리소스·유료 플랜은 연결하지 않았다. 이전에 실행했다 취소한 비공개 전환과 현재의 승인 대기 상태를 혼동하지 않는다.

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
| private CI variable | `HSR_DATA_MODE=protected` | 최초 승인·스테이징·성공본 초기화가 끝난 뒤에만 켜는 보호 모드 |
| private CI variables | `HSR_DATA_API_URL`, `HSR_WORKER_NAME`, `HSR_R2_BUCKET`, `HSR_FRONTEND_REPOSITORY` | 승인한 기존 Worker·비공개 bucket·사용자 Pages 저장소 |
| private CI secret | `HSR_FRONTEND_TOKEN` | 사용자 Pages 저장소에만 contents 쓰기 권한. 소스 저장소 토큰과 분리 |

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

현재 기본 분당 한도: 세션 180요청/검색30/읽기90/서로 다른 장80. 공유 IP는 1200요청/검색120/읽기240/장480이다. 50개 서적 검색 결과의 3개 언어 비교와 공유 IP 오탐 검사를 반영한 값이다. 번역 batch도 모든 장을 집계한다. IPv6는 /64로 묶는다. DO 식별자는 날짜·세션·UA와 무관하고, 로그의 IP HMAC만 일별로 바꾼다. 제한 상태는 SQLite Durable Object transaction으로 공유한다. 선택적 edge limiter는 지역별 근사치이므로 엄밀한 공유 제한은 DO가 담당한다.

`worker/behavior.ts`의 장기 예산은 읽기 2400개(시간당1200개 회복), 검색600개(시간당300개), 새로운 장360개(시간당180개)다. 같은 장은 1시간 동안 중복 차감하지 않지만 읽기 요청 예산은 계속 차감한다. 세션·UA·release·자정 변경이나 Turnstile 성공으로 이 공유 예산을 초기화하지 않는다. 상태 만료 알람은 예산이 완전히 회복될 수 있는 유휴 시간 이후에만 잡는다. `RATE_POLICY` JSON으로 분당/장기/허니팟 값을 조정한다. 공유망의 집중 연구·접근성 도구도 제한될 수 있으므로 일별 거절 사유와 이용자 피드백으로 조정한다.

허니팟 `/v1/export/archive.json`은 실제 자료·목차·북마크와 분리된 빈404다. 한 번의 스캐너·미리보기 접근은 차단하지 않는다. 10분 내3회 접근부터60초 쿨다운이며 실제 데이터에 가짜 원문을 섞지 않는다. 동일 시간대의 탐지 로그는 지수 간격으로 줄인다. API robots는 `/v1/`, `/internal/`을 제외하지만 이것을 보안 경계로 사용하지 않는다.

Turnstile은 키를 설정한 경우에만 세션 초과 시 제안한다. 일반 방문에는 외부 확인 스크립트도 로드하지 않는다. 서버에서 성공·hostname·action을 검증한 뒤 같은 IP/브라우저/세션에 5분간 세션 한도를 2배로 허용한다. 공유 IP의 전체 한도는 풀지 않는다. 실제 계정 키를 통한 외부 확인 절차는 계정 연결 후 별도로 검증한다. 자동화된 테스트는 검증 실패·hostname/action 불일치·공유 한도 유지까지 검사한다.

## 승인 후 운영 연결 순서

1. 마지막 성공 배포본을 byte 검증하여 R2 비공개 후보로 보존한다. 기존 Pages와 신규 공개 프런트 경로의 실제 내용·캐시 상태를 먼저 기록한다.
2. 승인한 비공개 R2/SQLite DO와 초기 Worker 비밀을 준비한다. D1은 `hsr-search-slot-0..2` 세 개를 순환한다. 현재 Worker의 `SEARCH`와 `SEARCH_PREVIOUS` 어느 쪽에도 연결되지 않은 세 번째 slot만 비우고 import한다. 실패한 import 재시도도 두 제공 DB를 보존한다. 처음부터3개를 모두 생성할 필요는 없다. R2 release 객체와 마지막 성공 snapshot은 불변이다.
3. 승인한 실제 API origin으로 후보를 생성·테스트한다. 로컬용 URL로 검증한 dist를 그대로 운영에 올리지 않는다. API origin 변경은 새 후보이므로 다시 검증한다. 실제 Worker의 CORS/비공개 R2/세션/문맥/번역/검색을 미리 확인한다.
4. `node scripts/upload-protected-candidate.mjs --upload`는 검증한 동일 bytes만 내부 인증 경로로 업로드한다. 내부 인증 업로드는 아직 제공되지 않는 후보 release도 받을 수 있지만 public 조회는 현재/직전 release로 제한한다. R2가 SHA-256을 확인하며 같은 key를 변경하지 않는다. D1 import가 끝나야 `ready.json`을 만든다. 새 Worker는 완성된 DB/객체 업로드 이후에 배포한다. 업로드 실패는 성공 포인터와 기존 Worker를 바꾸지 않는다.
5. 사용자 Pages 저장소의 `main`과 루트 branch 게시 설정을 준비한다. 먼저 같은 dist를 `/hsrArchive-preview/`에서 브라우저·private API·복구·기본 주소 우회 검사한다. 원래 public project Pages가 켜져 있으면 `/hsrArchive/`에서는 그 사이트가 우선될 수 있다. 따라서 사용자 Pages에도 같은 dist를 `/hsrArchive/` 아래에 미리 올린 뒤, 승인한 전환 창에서 원본을 비공개화하고 project Pages 게시 해제를 확인한다. 주소 승계와 CDN 만료는 원자적이지 않으므로 잠깐의 중단/구버전 캐시 가능성을 보고한다. 사용자 Pages 제공이 확인되기 전에 성공으로 확정하지 않는다.
6. 실제 GitHub Pages 기본 주소에서 기존 `content`, `locales`, 검색 JSON, 모든 provenance와 복구 gzip이 404인지 검사한다. HTML·모든 JS·map·service worker도 검사한다. 기존 CDN의 `max-age=600`과 이미 수집된 캐시를 고려해 재확인한다. 옛 파일이 200이면 전환 완료로 처리하지 않는다. 이미 다운로드된 복사본은 회수할 수 없다.
7. 공개 배포 성공과 live 계약 검사를 확인한 뒤에만 `HSR_EXPECTED_PREVIOUS_RELEASE`를 직전 성공 release(최초는 빈 문자열)로 지정하고 `node scripts/promote-protected-release.mjs --deployed`를 실행한다. DO가 이전 포인터를 비교하여 원자적으로 확정하며 같은 작업의 재시도는 안전하다. 그 다음 private CI의 상태 조회를 `HSR_PRIVATE_STATE_URL`로 바꾼다.
8. 같은 원래 URL의 북마크·공유 링크·모바일을 확인하고 원본의 인증 없는 Git/raw/ZIP 접근 거절을 실제로 검사한다. 현재 원본은 Public이므로 그 검사 결과를 미리 성공으로 기록하지 않는다. 외부 복사본과 이미 공개한 커밋은 회수할 수 없다. 성공 포인터 초기화까지 완료한 뒤에만 private CI의 `HSR_DATA_MODE=protected`를 켠다.

## 6시간 자동 갱신에 적용할 변경

운영 main의 `.github/workflows/deploy-pages.yml`과 6시간 갱신은 그대로다. 보호 브랜치에는 같은 workflow의 조건부 protected 경로를 구현했다. 실제 private 서비스에 연결하여 예약 실행을 검증한 상태는 아니다. **Public 소스에서** 보호 모드가 비어 있으면 기존 정적 build/configure/upload/deploy만 실행한다. Private 소스에서는 모드 누락·오타·static 지정도 실패시켜 전체 JSON 정적 배포로 되돌아가지 않는다. protected 모드는 소스가 Private이고 private 상태 URL/token이 있어야 시작하며, 기존 Pages 원문 artifact 경로는 실행하지 않는다.

- cron `15 */6 * * *`, 공식 입력/BWIKI/영상 변경 탐지와 독립 재시도·backoff·미확인 기록은 유지한다.
- 처음부터 private 원본 workflow에만 비밀과 원문 cache를 둔다. public PR에는 비밀이나 private cache를 제공하지 않는다. 공개 프런트 workflow는 이미 검사한 정적 파일만 받는다.
- `HSR_PRIVATE_STATE_URL`/token을 build job 환경에 설정하면 기존 복구·변경 확인 어댑터가 마지막 성공한 private release를 읽는다. 실패를 공개 Pages fallback이나 '변경 없음'으로 바꾸지 않는다.
- seal/최종 계약/`pnpm test` 뒤 protected build·후보 seal·노출 검사를 실행한다. 원본 전체를 dist에 요구하는 기존 static seal 검사는 static 경로에만 둔다.
- `scripts/deploy-protected-candidate.mjs --deploy`가 비공개 원본 확인 → 비활성 D1 slot 선택/import·동일 후보 업로드 → 기존 성공 DB를 보존한 Worker 갱신 → **공개 dist만** 사용자 Pages Git 게시 → 실제 HTML/assets hash 및 옛 JSON/복구/map/SW404 → CAS 성공본 확정을 실행한다. 로그인·구독·bucket/저장소 생성·공개 범위 변경은 이 명령에 포함하지 않는다.
- `protected-publisher.mjs`는 원본 checkout을 복사하지 않고 새 clone의 `/hsrArchive/`만 교체한다. 다른 사용자 페이지는 보존하며 강제 push하지 않는다. 공개 저장소의 과거 이력에도 원문을 넣지 않는다. publisher 인증은 Git 프로세스 환경으로만 전달한다. source-first 보고서·snapshot·raw SQL은 공개 artifact에 넣지 않는다.
- 기존의 workflow concurrency를 유지한다. 수동 Cloudflare 배포를 예약 갱신과 동시에 실행하지 않는다. 후보 manifest만 private Actions artifact에7일 보관하고 큰 원문은 private R2에 둔다. 장기 R2 보존 정책은 비용 승인을 받고 정하되 현재/마지막 성공본을 자동 만료시키지 않는다.
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

D1 세 slot은 현재/직전 제공 DB를 보존하지만 그보다 오래된 slot은 재사용한다. 따라서 오래된 Cloudflare 버전을 bindings까지 그대로 되돌리는 명령을 맹목적으로 쓰지 않는다. last-success 포인터와 현재 Worker의 두 DB/release 대응을 확인하고, 마지막 성공 release와 그 DB를 새 rollback 설정의 현재값으로 지정한다. 가능하면 실패 후보의 완성된 DB를 직전값으로 유지해 새 화면을 이미 받은 이용자도 처리한다. 마지막 성공 프런트 Git 커밋의 dist를 다시 게시하고 live hash/검색을 검사한다. 실제 계정에서 이 복구 절차를 시험하기 전에는 최초 운영을 승인 요청하지 않는다.

## 비용과 적합성 (2026-10-22 공식 요금 기준)

현재 후보의 R2 객체 약 311MB, 검색 SQLite 약 121MB, import SQL 약 72MB다. D1 세 slot은 약363MB 합계로 Free의 DB당500MB/계정10개 제한 내에 들어간다. 저장 용량만으로 무료 운영 가능성을 판단하지 않는다. 로컬 CPU 측정에서 큰 장의 JSON 파싱/출현 구성은 중앙값15~16ms, 최종 단문 검색은78ms였다. 후자는 로컬 SQLite 엔진을 포함하므로 Worker CPU10ms와 직접 비교할 수 없다. 로컬 수치와 Cloudflare CPU 과금은 같지 않으며 실제 Free 계정 측정은 인증 후에만 가능하다.

- Workers Free: 100,000요청/일, CPU 10ms/요청. 로컬 실험은 가능하지만 실제 장 렌더링·검색·자동 import까지 무료 한도 안이라고 보장하지 않는다. 운영은 Workers Paid 최소 **$5/월**을 권장하며 승인 전 구독하지 않는다. 1,000만 요청/월과 CPU 3,000만 ms 포함, 초과는 각각 $0.30/백만 요청과 $0.02/백만 CPU ms다.
- R2 Standard: 10GB-month, A쓰기100만/월, B읽기1,000만/월 무료. 초과 $0.015/GB-month, 쓰기 $4.50/백만, 읽기 $0.36/백만. egress 무료. 매일 4번 전체 11,000여 객체를 다시 올리면 무료 쓰기를 넘을 수 있다(월 약 137만회 → 현재 과금 단위 기준 추가 약 $4.50). 실제로는 변경이 있을 때만 후보를 만든다. 7일 28개 후보는 약8.7GB지만 성공본을 만료시키는 일괄 lifecycle은 적용하지 않는다.
- D1 Free: 500만 행 읽기/일, 10만 쓰기/일, 총5GB. 본문 67,488행의 FTS/색인 import와 1~2글자 검색의 스캔은 무료 한도를 쉽게 소진할 수 있다. Paid는 읽기250억/월·쓰기5,000만/월·저장5GB 포함, 초과 읽기$0.001/백만·쓰기$1/백만·저장$0.75/GB-month다. 전체 재색인 쓰기는 실제 계정의 `rows_written`을 측정한 뒤 예상액에 반영한다.
- SQLite DO도 Free/Paid에 제공된다. Paid는 100만 요청/월·400,000GB-s 포함이며 초과 요청$0.15/백만·시간$12.50/백만GB-s와 저장 사용량이 적용된다. 모든 읽기 요청이 한 번씩 guard DO를 호출한다. Worker와 DO 요청 수는 별도다.
- Turnstile Free 사용 가능. 별도 도메인은 필수가 아니다. private GitHub Actions는 기존 public 무료 실행과 달리 계정의 포함 분량/저장 한도를 사용하므로 기존 6시간 실행 시간과 실제 변경 빈도로 별도 산정해야 한다.

작은 방문량과 드문 데이터 변경은 기본 $5에 가깝게 시작할 수 있으나 $5가 총액 상한은 아니다. 실제 배포 전 검색·FTS 재생성·동시 읽기의 CPU/행 쓰기 측정, 예산 알림, 리소스 유지 개수 결정을 승인 범위에 포함한다.

Free에서는 한도 초과가 서비스 중단으로 이어질 수 있다. D1 단문 검색과 FTS import, guard DO의 요청별 상태 쓰기 한도가 특히 중요하다. R2 무료 포함량은 결제 없는 무제한 계정이라는 뜻이 아니며 활성화·결제정보 등록을 임의로 하지 않는다. 먼저 `pnpm exec wrangler login`으로 공식 OAuth 로그인만 완료하고, `wrangler whoami`로 계정을 확인한다. 토큰/로그인 URL의 인증 코드는 채팅이나 저장소에 붙이지 않는다. Free 실측 및 월간 예상량을 보고한 뒤 리소스/과금/최초 운영 활성화 승인을 따로 받는다.

공식 근거: [Pages 플랜](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Workers 요금/로그](https://developers.cloudflare.com/workers/platform/pricing/), [R2 요금](https://developers.cloudflare.com/r2/pricing/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/), [DO 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Turnstile 플랜](https://developers.cloudflare.com/turnstile/plans/), [R2 checksum/조건부 쓰기](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
