# AI 자동 수집 방어 보완 — 격리 검증

## 현재 운영 상태

GitHub API 재확인: 원본은 **Public**(`private:false`), main은 `5a806efc0869528f5b46735ec608498d579b8022`다. 기존 Pages workflow의 마지막 성공 run `39702559290`은 복구 재실행 attempt2도 성공했다. 실제 기존 URL의 홈에서 최신 공지와 임무 목록을 확인했다. 현재 공개 원문은 여전히 다운로드 가능하다. 이번 보호 기능은 `feature/data-access-protection`에만 있으며 운영 전환하지 않았다.

`cc669db3`의 Worker/R2/D1/부분 조회/서버 검색/비공개 복구 어댑터/기존 ID 호환을 재사용했다. 이 보고서의 격리 데이터는 마지막 성공 배포 snapshot에서 복구한 2,840장, 한국어67,488행, 표시 출현67,662개, 선택지8,310개다. 미커밋 작업 파일과 이미지는 보존했다. 과거 공개한 원문·Git 커밋·외부 복사본은 회수할 수 없다.

## 최소 변경 구조

비공개 원본 저장소와 private CI cache에 전체 원문·공식 ID·BWIKI 근거·검증 코드·복구 자료를 둔다. upstream TalkSentenceConfig/TextMap 같은 외부 원본은 기존 정책대로 private CI cache에 두고 Git에 새로 추가하지 않는다. 공개 사용자 Pages 저장소 `moleculargastronomy1/moleculargastronomy1.github.io`의 `/hsrArchive/`에는 검사한 dist만 게시한다. 원래 URL/origin/hash/사이트 ID/localStorage 키를 유지한다. 공개 저장소에는 full JSON·검색 SQL·검증 보고서·복구 gzip을 복사하지 않는다.

사용자 Pages 저장소와 Cloudflare 계정 리소스는 아직 만들지 않았다. 같은 주소의 project Pages와 user Pages가 전환 도중 경쟁할 수 있어 `/hsrArchive-preview/` 스테이징과 승인된 전환 창이 필요하다. 비공개 전환만 먼저 수행하면 GitHub Free의 현재 project Pages가 중단된다. 비공개화와 주소 승계를 원자적으로 처리한다고 가정하지 않는다.

Worker는 50행 페이지, 최대41행 문맥·선택지 응답, 선택한 언어/ID를 제공한다. D1은 검색 결과만 반환한다. R2 public domain이 열려 있거나 확인할 수 없으면 업로드를 중단하는 사전 검사를 추가했다. 프런트 공개 파일 허용 목록·원문 canary·비밀키 포함 검사·번들/map/SW/복구 경로 검사를 유지했다.

## 재사용·보완한 방어

- `worker/policy.ts`: 분당 세션/IP 제한. 기본 세션180요청/읽기90/검색30/장80, IP1200/읽기240/검색120/장480. 번역 batch의 모든 장도 집계한다. 50개 서적 검색 결과의3개 언어 비교에서 오탐이 생기지 않도록 한도를 조정했다.
- `worker/behavior.ts`: 세션·UA·release·자정과 독립적인 IP별 장기 예산. 읽기2400개/시간당1200개 회복, 검색600/시간당300, 새 장360/시간당180. 같은 장은1시간 중복 차감하지 않으며, 반복 페이지/동기화는 읽기 예산을 소비한다. /64 IPv6 집계와 지속되는 DO 상태로 단순 주소·세션 회전을 억제한다.
- `/v1/export/archive.json`: 게임 자료와 분리된 빈404. 한 번 접근은 차단하지 않고10분 내3회부터60초 쿨다운. 가짜 원문/선택지는 제공하지 않는다. robots 제외·UI 링크 부재로 정상 크롤러의 우연한 접근을 줄이고 로그도 지수 간격으로 제한한다.
- 기존 Turnstile 선택 절차를 유지한다. 세션 한도를 잠시 늘릴 수 있지만 공유 IP의 분당·장기 한도는 해제하지 않는다. 장기 예산 초과에는 추가 확인을 통과하면 무제한 열람할 수 있다는 안내를 하지 않는다.
- CORS·robots·UA는 보안 경계가 아니다. 정상/AI 여부를 확정 분류하지 않고 공개 데이터 소비 행위를 제한한다. 검색엔진용 UI는 계속 공개하고, API의 전체 데이터 접근은 검색엔진 UA로 위장해도 면제하지 않는다. zone WAF/verified-bot 추가 규칙은 승인한 도메인·플랜이 있을 때 보조 적용하며 현재 활성화하지 않았다. workers.dev를 직접 호출해도 Worker의 제한은 적용된다.

## 요청한 수집 상황 시험

| 상황 | 관측 결과 | 정상 영향·한계 |
| --- | --- | --- |
| 일반 열람 | 같은 IP의5명이4시간 동안 검색·문맥·3개 언어 비교2400요청, 거절0 | 이 프로파일에서 오탐0. 모든 실제 이용자의 오탐률0%를 뜻하지 않는다. |
| 검색·선택지·다국어 | 전체 데이터의 페이지·문맥·선택지 결과를 기존 함수와 비교. 별도 공유IP 5명×서적 검색50건×3언어 묶음도 전부 허용 | 기존 IDs·본문·간선·번역 연결 보존. |
| Git 전체 복제 | **현재 Public이므로 인증 없는 복제가 가능**. 비공개 원본을 요구하는 보호 publisher는 Public에서 실행을 거절하도록 구현 | 실제 익명 clone 거절은 승인 후 Private 전환 때 다시 검사해야 한다. 격리 시험으로 GitHub의 실제 공개 범위를 바꾸지 않았다. |
| 공개 정적 파일 일괄 받기 | 보호 dist 허용 목록·canary 검사, native Worker에서 검색 JSON·다국어 JSON·복구·provenance404 | 현재 운영의 기존 정적 파일은 여전히200. 보호 배포와 옛 파일 제거 전에는 방어 완료가 아니다. |
| 전체 임무 자동 순회 | 가상 시계로2,840개 장의 **첫 페이지**를1초 간격 요청하고 세션을30건마다 교체: 2462회429, 완료까지49601초(약13.78시간) | 한 IP의 정책상 대기 시간. 큰 장의 나머지 페이지/전체 분기/번역을 모두 수집한 실측이 아니다. |
| 대량 API 요청 | 실제 workerd/R2/D1/DO 동시 요청 시험에서 설정된 한도만200, 나머지429 및Retry-After. 세션 회전/UA 위장·locale batch도 장기 예산을 받음 | 데이터 저장소 오류는503으로 중단, 공개 JSON fallback 없음. |
| 느린·반복 수집 |10초 간격: 2121회429,49610초.6시간마다4회 동기화 시도도 매 회2000건 넘게 제한 |30초 간격은85200초(23시간40분)에 거절 없이 수집 가능.10개 IP 분산1초 요청도2840초(47분20초)에 첫 페이지 모두 가능. 분산·충분히 느린 수집 차단을 주장하지 않는다. |
| 내부 BWIKI/CI | 기존 회귀·조회 실패/backoff·원문/출현/분기 보존 테스트와 인증된 복구 경로 검사 통과. 외부 제한 상태에서도 내부 복구 접근200 | 실제 Cloudflare 계정에서6시간 private CI를 실행한 상태는 아니다. 현재 main의 기존 예약 검증은 유지된다. |

가상 시계 시험은 실제 Worker가 쓰는 동일 정책 함수를 사용한다. HTTP 시험은 로컬 workerd의 실제 R2/D1/SQLite DO를 사용한다. Cloudflare 대역폭·전 세계 동시성·실제 봇 탐지율을 측정했다고 해석하지 않는다. 결과 JSON과 테스트 명령은 저장소에 남긴다.

## 회귀·복구·배포

전체 Node 테스트와 TypeScript 검사, 보호 빌드/기존 정적 빌드, 모든11,379개 데이터 파일의 byte/ID/본문/선택지/출현/간선 회귀 비교를 실행한다. 최종 결과와 후보 release는 이 보고서 아래에 기록한다. 화면 비교는 기존 브라우저 검증에 이어 변경된 API 정책으로 재확인한다.

기존 `deploy-pages.yml`의6시간 cron·공식 입력/BWIKI/영상 확인·미확인 재검토·보존 계약을 재사용했다. 보호 브랜치의 조건부 `HSR_DATA_MODE=protected` 경로에서만 private 복구/빌드/업로드/publisher를 실행한다. 현재 main은 변경하지 않았고 변수도 켜지 않았다. private 모드는 Public 소스에서 시작하지 못하며 full 원문 artifact를 Pages로 보내는 정적 경로는 실행하지 않는다.

배포는 비활성 D1 slot 초기화/import → 불변 R2 후보/ready 업로드 → 현재/직전 DB를 제공하는 Worker 갱신 → dist만 공개 Git 게시 → 실제 공개 HTML/assets hash·옛 파일404 → CAS 성공 포인터 확정 순서다. 인증 업로드는 미제공 release도 받지만 공개 읽기는 현재/직전으로 제한한다. DB import 실패 시 기존 Worker를 바꾸지 않는다. Worker/프런트 실패·구버전 캐시·옛 JSON200이면 성공 포인터를 바꾸지 않는다. 마지막 성공 R2 snapshot으로 다음 CI를 시작한다.

실제 로컬 Git remote 시험에서 `/hsrArchive/`의 낡은 파일만 제거되고 다른 사용자 사이트는 보존되며 private snapshot은 커밋되지 않았다. live 배포 gate는 오래된 HTML, 공개 검색 JSON, 다른 해시를 거절했다. checksum 변조·간선 손실·오래된/동시 확정409·API/복구 실패와 무인증 내부 접근을 기존 테스트와 함께 검사한다. Cloudflare/GitHub 신규 배포 실패 복구 훈련은 계정 인증 후 남아 있다.

## 무료 플랜 검토와 비용

데이터 약311MB, 검색 DB121MB, D1 세 slot 약363MB. 용량은 무료 포함량 안에 들지만 요청/CPU/읽기·쓰기 한도를 따로 봐야 한다.

| 항목 | 공식 무료 범위와 현재 판단 |
| --- | --- |
| Workers |10만요청/일, CPU10ms/요청. 로컬 큰 장 파싱/출현 구성 중앙값15~16ms였으며 Cloudflare 실측과 다르다. 최종 단문 검색78ms는 로컬 SQLite 엔진을 포함한 CPU 시간으로 Worker10ms와 직접 비교할 수 없다. 현재 구조의 무료 운영을 보장하지 않는다. |
| D1 | 읽기500만행/일, 쓰기10만행/일, 계정5GB, DB당500MB/10개DB. 현재3 slot 용량은 적합하나 FTS import와1~2글자 검색은 한도를 쉽게 소진할 수 있다. 한 번의 count가 전체67,488행 후보를 검사할 수 있다. Free 한도 초과는 갱신/검색 중단으로 이어질 수 있다. |
| SQLite DO |10만요청/일,13,000GB-s/일, 행 읽기500만/쓰기10만/일,5GB. 요청마다 상태/알람을 쓰므로 실사용 쓰기 수와CPU를 확인해야 한다. |
| R2 Standard |10GB-month, A쓰기100만/B읽기1000만/월. 현재 release311MB.120회 전체 갱신은 약137만 객체 쓰기로 무료 범위를 넘는다. 변경 때만 갱신하고, R2 활성화/결제정보는 임의로 등록하지 않는다. |
| GitHub | 공개 사용자 Pages 무료. 비공개 원본 Free의 Actions 포함 시간·cache/artifact 한도 별도. 예시로8분×월120회는960분이며 실제 전체 실행 시간과 저장량을 확인한다. 실패 후보 전체를 공개 artifact로 올리지 않는다. |

유료 대안은 Workers Paid 기본 **$5/월 + 초과 사용량**이다. 적은 방문/드문 갱신이면 기본료에 가까울 수 있지만 상한이 아니다. R2 writes·D1 재색인·DO·Actions 저장/시간을 포함한 실측 없이 금액을 확정하지 않는다. 유료 플랜·R2·신규 리소스는 아직 활성화하지 않았다. 로그인 이후 무료 계정에서 가능한 범위의 CPU/rows_read/rows_written을 측정하고, 한도를 넘거나 결제 연결이 필요한 단계에서 멈춘다.

공식 근거: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/), [D1 제한](https://developers.cloudflare.com/d1/platform/limits/), [DO](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [WAF 플랜별 제한](https://developers.cloudflare.com/waf/rate-limiting-rules/), [Pages 플랜](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

## 남은 인증과 최초 운영 승인

공식 OAuth: 작업 폴더에서 `pnpm exec wrangler login`, 완료 후 `pnpm exec wrangler whoami`. 비밀키를 채팅/프런트/Git에 넣지 않는다. 자세한 설정과 순서는 [전환 실행서](../protected-release-runbook.md)에 있다.

계정 인증 후 무료 사용량·실제 API/Turnstile·사용자 Pages 스테이징·익명 clone/우회 경로·신규 배포 복구를 확인해야 한다. 그 결과를 보고 **비공개 전환, 새 공개 프런트 저장소/토큰, 초기 리소스/비용 범위, Pages 주소 승계 창, protected CI 활성화**를 승인받는다. 현재 원본 공개 범위와 운영 접근 정책은 유지한다.

## 최종 로컬 확인

- 최종 후보 `d1c6e8c0e4b9eda54789d9ed4ae6644715d349503387f04a8ef0aa1adc459f5d`.
- 전체 **134 tests pass**, 실패0. 프런트/Worker TypeScript 통과. 보호 빌드와 기존 `pnpm build` 통과. 기존 bundle500kB 경고는 남아 있다.
- 원본11,379개 데이터 파일 전체 회귀 비교 통과: 2,840장/67,488행/선택지8,310개. byte·IDs·본문·출현·연결 손실0.
- 공개37파일, 원문 canary2028개 검사 통과. 실제 HTML 변조는 후보 검사에서 거절됐고 원래 bytes 복구 후 같은 후보 검사도 통과했다. 이전 공개 복구 gzip URL의200도 live gate가 거절한다.
- Worker/R2/D1/DO HTTP 제한·내부 검증 분리·실제 로컬 Git prefix 게시·private mode 누락/오타 거절·R2 public 설정 거절·복구 실패 보존 시험 통과.
- 브라우저: 원문/3개 언어, 기존 북마크1개 재열람, 서적 `나` 검색988건 중50건/번역150개, 선택지 응답 및 `official-station-departure-arrival-talk-100020126`+`occ-f42a035e1f4135ffee1dbf29` 공유 링크 확인. 가시 오류/console error 없음.390px viewport에서 문서375px로 가로 넘침 없음. 최종 release에서도 같은 공유 링크와 북마크·선택지 원문을 새로고침하여 확인했다.
- 실제 운영은 계속 기존 Public Pages다. 최초 protected 서비스·익명 private clone 거절·Cloudflare Free 계측·private CI 실동작·클라우드 배포 복구 훈련은 **인증/승인 후 남은 작업**이다. 현재 보고서가 운영 방어 완료를 뜻하지 않는다.
