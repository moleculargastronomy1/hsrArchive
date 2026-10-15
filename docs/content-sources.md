# 업데이트별 한국어 텍스트 확보 경로

확인일: 2026-10-16 (Asia/Seoul).

## paimooon Translate Comparer의 실제 자동 갱신 방식

[translate.html 고정 코드](https://github.com/paimooon/paimooon.github.io/blob/36eca4736eecfc84d5f2053865068e4426b17186/translate.html#L86-L127)를 확인했다. paimooon 최신 커밋도 이 버전과 같으며 커밋 메시지는 `auto update`이다.

- `REPO = "DimbreathBot/TurnBasedGameData"`, `BRANCH = "main"`, `TEXTMAP_DIR = "TextMap"`.
- `DOMContentLoaded`에서 `loadVersion()`과 `loadJSON()`을 실행한다.
- `https://api.github.com/repos/DimbreathBot/TurnBasedGameData/commits/main`의 커밋 메시지 첫 줄을 화면의 현재 버전으로 표시한다.
- `https://api.github.com/repos/DimbreathBot/TurnBasedGameData/contents/TextMap?ref=main`에서 파일 목록을 읽고, 각 언어의 `TextMap<언어>(_숫자)?.json`에 맞는 파일을 선택한다.
- 각 항목의 `download_url`을 fetch하고 JSON들을 합친다. 한국어는 현재 `TextMapKR_0.json`, `TextMapKR_1.json`이다.
- 고정 코드의 로딩 경로는 페이지 접속 시 최신 파일을 읽는 방식이다. 이 저장소에는 별도의 예약 수집 워크플로 파일이 없고, 실행 중 주기적 재조회 코드는 확인되지 않았다.

이 방식은 전체 TextMap에서 언어별 문장을 검색하는 기능이다. 임무별 대사 순서와 분기를 제공하는 기능은 아니므로, 같은 데이터를 받아도 제7막의 임무 귀속 문제는 별도로 해결해야 한다.

## 우선 사용할 자료

| 경로 | 역할 | 확인한 제공 범위 |
| --- | --- | --- |
| [DimbreathBot/TurnBasedGameData](https://github.com/DimbreathBot/TurnBasedGameData) | 릴리스 원본 JSON | 한국어 TextMap, 임무·챕터 표, 대사 표, 제공되는 스토리 구조. 확인한 최신 커밋은 `312b4597691e0a29cf9828a15b592757dba86949`, 2026-10-09, `OSPRODWin4.6.0_D16728363_A16704710_L16700845`. |
| [mizan0515/starrail-quests](https://github.com/mizan0515/starrail-quests) | 한국어 임무별 대사·귀속 증거 | 현재 사이트의 주 입력. 2026-10-16에 확인한 최신 `adefdb0639a81a9940decde5b970aa23d43a6f6c`도 기본 dataset 묶음의 SHA-256이 기존 버전과 같아 제7막 문서가 추가되지 않았음을 확인했다. |
| [paimooon Binary File Reader](https://paimooon.github.io/binary.html) | 게임 파일 추출 도구 | 사용자가 확보한 바이너리를 읽는 도구이며, 업데이트별 완성 대사 자료실은 아니다. 현재 게임 입력과 추출 호환성은 별도 검증해야 한다. |

[Dimbreath 커밋 목록](https://github.com/DimbreathBot/TurnBasedGameData/commits/main/)에서 릴리스 버전 문자열을 확인하고, 사용할 커밋을 고정해 필요한 파일만 받는다. 다음 업데이트에도 같은 경로를 확인할 수 있지만 매 버전의 모든 장면·대사 수록이나 갱신 시점을 보장하는 서비스는 아니다.

한국어 문자열만 있어서는 임무별 읽기 순서를 만들 수 없다. `MissionChapterConfig` → `MainMission`의 챕터 귀속, 스토리·장면의 명시적 대사 참조 → `TalkSentenceConfig` → 한국어 TextMap을 연결하고 선택지와 화자를 보존해야 한다. 해시는 Python 정수로 처리한다. 연결 근거가 없는 문자열과 숫자 접두사 일치는 임무 대사로 수록하지 않는다. 입력의 커밋·Git blob·SHA-256과 수록 범위를 기록한 뒤 검증을 통과한 사이트용 결과만 커밋한다.

## 현재 제7막의 한계

4.6 챕터 표에서 `105009`의 제목과 소개문, `MainMission` 표에서 관련 임무 ID는 확인했다. 그러나 Dimbreath의 해당 고정 버전 `Story/Mission`에는 `1054600` 등의 제7막 구조가 없고, 현재 한국어 참고 저장소에서도 제7막 임무에 귀속된 대사를 찾지 못했다. 따라서 현재 사이트에는 목차와 소개문만 표시한다.

소개문을 재생성하려면 위 Dimbreath 고정 커밋의 `ExcelOutput/MissionChapterConfig.json`과 `TextMap/TextMapKR_0.json`, `TextMap/TextMapKR_1.json`을 `.cache/astro-source`에 파일명 그대로 준비하고 `python scripts/import-astropolis-intro.py`를 실행한다. 이 스크립트는 고정된 Git blob 해시를 확인한다.

## 보조 후보 조사

- [StarrailDialog](https://github.com/mrzjy/StarrailDialog)는 원본 데이터에서 대사·메시지 등을 추출하는 예제 도구다. 전체 추출 결과를 제공하지 않으며 README에 불완전한 대사와 장면 연결 한계가 명시되어 있어 최신 완성 원문의 공급원으로 사용하지 않았다. 확인한 커밋 목록의 마지막 변경은 2024-07-12이다.
- [Yuuki의 StarRail_Data 백업](https://git.yuuki.me/Backup/StarRail_Data)은 릴리스 데이터의 보조 보관처이며 루트에서 4.6 버전 표기를 확인했다. 제7막 한국어 대사와 순서의 제공 여부까지 검증하지 않았으므로 사이트 입력으로 채택하지 않았다.
- HomDGCat 한국어 임무 페이지는 확인 시 DNS 오류로 접속하지 못했다. 최신 원문을 안정적으로 받을 수 있는 경로로 권하지 않는다.

화면·기능 기준은 LimBooks를 유지한다. 위 자료들은 원문 확보 경로이며 화면 참고 기준을 대체하지 않는다.
