import type { ArchiveEntry, Category, Chapter, World } from './types';
import importedContent from './imported-content.json' with { type: 'json' };
import simulation from './simulation.json' with { type: 'json' };

export const categories: { id: Category; label: string; description: string }[] = [
  { id: 'trailblaze', label: '개척 임무', description: '별을 잇는 여정, 그 중심의 이야기' },
  { id: 'simulation', label: '시뮬레이션 우주', description: '실험과 발견, 우주에 남겨진 기록' },
];

export const worlds: { id: World; label: string; short: string; english: string }[] = [
  {
    id: 'space-station',
    label: '우주정거장 「헤르타」',
    short: '우주정거장',
    english: 'HERTA SPACE STATION',
  },
  { id: 'jarilo', label: '야릴로-Ⅵ', short: '야릴로-Ⅵ', english: 'JARILO-VI' },
  { id: 'luofu', label: '선주 「나부」', short: '선주 「나부」', english: 'THE XIANZHOU LUOFU' },
  { id: 'penacony', label: '페나코니', short: '페나코니', english: 'PENACONY' },
  { id: 'amphoreus', label: '앰포리어스', short: '앰포리어스', english: 'AMPHOREUS' },
  {
    id: 'paradise-astropolis',
    label: '이상 낙원 / 아스트로폴리스',
    short: '이상 낙원 / 아스트로폴리스',
    english: 'PARADISE / ASTROPOLIS',
  },
  {
    id: 'simulated-universe',
    label: '시뮬레이션 우주',
    short: '시뮬레이션 우주',
    english: 'SIMULATED UNIVERSE',
  },
];

// User-supplied trailblaze chapter metadata. The original demo blocks are preserved separately
// from the imported game dialogue attached below.
function demoChapter(id: string, title: string, subject: string): Chapter {
  return {
    id,
    title,
    blocks: [
      {
        id: `${id}-notice`,
        type: 'narration',
        text: '이 본문은 읽기 화면을 확인하기 위한 예시입니다. 실제 게임 대사나 공식 스토리가 아닙니다.',
      },
      {
        id: `${id}-intro`,
        type: 'narration',
        text: `${subject}에 관한 기록이 이곳에 정리됩니다. 추출한 텍스트를 연결하면 장면의 순서에 따라 이야기를 읽을 수 있습니다.`,
      },
      {
        id: `${id}-dialogue-1`,
        type: 'dialogue',
        speaker: '안내자 · 예시',
        text: '서고에 오신 것을 환영합니다. 왼쪽 목차에서 원하는 장을 선택해 보세요.',
      },
      {
        id: `${id}-dialogue-2`,
        type: 'dialogue',
        speaker: '독자 · 예시',
        text: '이어서 읽을 수 있도록 이 기록을 남겨 둘 수 있나요?',
      },
      {
        id: `${id}-dialogue-3`,
        type: 'dialogue',
        speaker: '안내자 · 예시',
        text: '북마크를 누르면 내 서재에 보관됩니다. 마지막으로 읽은 장과 스크롤 위치도 이 브라우저에 저장됩니다.',
      },
      {
        id: `${id}-note`,
        type: 'narration',
        text: '장면 설명과 인물의 대사는 서로 다른 형식으로 표시됩니다. 글자 크기와 화면 테마를 조절하여 편안한 환경에서 읽어 보세요.',
      },
      {
        id: `${id}-end`,
        type: 'narration',
        text: '이 장의 예시 기록은 여기까지입니다. 아래의 다음 장 버튼을 통해 이어지는 기록으로 이동할 수 있습니다.',
      },
    ],
  };
}

function subChapter(
  id: string,
  title: string,
  subject: string,
  parentId: string,
  kind: 'branch' | 'adventure',
): Chapter {
  return { ...demoChapter(id, title, subject), parentId, kind };
}

const originalEntries: ArchiveEntry[] = [
  {
    id: 'station-departure',
    title: '오늘은 어제의 내일',
    subtitle: '프롤로그 — 더 블루',
    arcLabel: '프롤로그 — 더 블루',
    description: '시스템 시간 23시 44분 59초, 한 낯선 여성이 우주정거장 「헤르타」에 나타났다',
    category: 'trailblaze',
    world: 'space-station',
    order: 1,
    language: 'ko-KR',
    tags: ['프롤로그', '더 블루', '우주정거장'],
    source: { kind: 'demo', note: '사용자가 지정한 개척 임무 목록 · 본문은 기능 확인용 예시' },
    chapters: [
      demoChapter('arrival', '제1막: 오늘은 어제의 내일', '우주정거장'),
      demoChapter('platform', '개척 후문: 인간과 신의 면류관', '우주정거장'),
    ],
  },
  {
    id: 'jarilo-records',
    title: '시들어가는 겨울밤',
    subtitle: '제1장 — 야릴로-Ⅵ',
    arcLabel: '제1장 — 야릴로-Ⅵ',
    description:
      '「탐사」, 「이해」, 「수립」, 「연결」——이것이 무명객들이 줄곧 지켜온 「개척」의 길이다. 열차팀의 새로운 멤버가 된 당신의 첫 번째 목적지는 야릴로-Ⅵ, 얼음과 눈으로 뒤덮인 행성이다……',
    category: 'trailblaze',
    world: 'jarilo',
    order: 2,
    language: 'ko-KR',
    tags: ['야릴로-VI', '야릴로-Ⅵ', '벨로보그', '설원'],
    source: { kind: 'demo', note: '사용자가 지정한 개척 임무 목록 · 본문은 기능 확인용 예시' },
    chapters: [
      demoChapter('snowfield', '제1막: 시들어가는 겨울밤', '야릴로-Ⅵ'),
      demoChapter('city', '제2막: 동트는 태양 아래', '야릴로-Ⅵ'),
      demoChapter('winter-dream', '개척 후문: 겨울꿈에서 깨어난 순간', '야릴로-Ⅵ'),
    ],
  },
  {
    id: 'luofu-records',
    title: '바람 따라 즐기는 선경',
    subtitle: '제2장 — 선주 「나부」',
    arcLabel: '제2장 — 선주 「나부」',
    description:
      '「......목적지를 변경해줬으면 해」 뜻밖의 방문객이 말했다. 은하열차에서 멀지 않은 곳에 선주 연맹의 「나부」가 정박해 있다……',
    category: 'trailblaze',
    world: 'luofu',
    order: 3,
    language: 'ko-KR',
    tags: ['선주', '나부'],
    source: { kind: 'demo', note: '사용자가 지정한 개척 임무 목록 · 본문은 기능 확인용 예시' },
    chapters: [
      demoChapter('harbor', '제1막: 바람 따라 즐기는 선경', '선주 「나부」'),
      demoChapter('clouds', '제2막: 구름에 가려진 탑', '선주 「나부」'),
      demoChapter('aftermath', '제3막: 재앙이 지나간 자리', '선주 「나부」'),
      demoChapter('foxian-tale', '개척 후문: 호재지이', '선주 「나부」'),
      demoChapter('swords-upper', '개척 후문: 청천 위 교차하는 칼끝·상', '선주 「나부」'),
      demoChapter('swords-lower', '개척 후문: 청천 위 교차하는 칼끝·하', '선주 「나부」'),
    ],
  },
  {
    id: 'penacony-records',
    title: '음향과 분노',
    subtitle: '제3장 — 페나코니',
    arcLabel: '제3장 — 페나코니',
    description:
      '「꿈의 땅」 페나코니, 수많은 꿈을 좇는 여행객들이 꿈에 그리는 향락주의의 천국——「시계공」의 축제에 참여할 준비가 되었는가?',
    category: 'trailblaze',
    world: 'penacony',
    order: 4,
    language: 'ko-KR',
    tags: ['꿈', '페나코니'],
    source: { kind: 'demo', note: '사용자가 지정한 개척 임무 목록 · 본문은 기능 확인용 예시' },
    chapters: [
      demoChapter('invitation', '제1막: 음향과 분노', '페나코니'),
      demoChapter('dream', '제2막: 비둘기 속의 고양이', '페나코니'),
      demoChapter('our-time', '제3막: 우리들의 시대에', '페나코니'),
      demoChapter('farewell', '제4막: 안녕, 페나코니', '페나코니'),
      demoChapter('nana-outrage', '개척 후문: 나나웃레이지·인의(忍義) 없는 전쟁', '페나코니'),
      demoChapter('eighth-day', '제5막: 여덟째 날에 오르는 여정', '페나코니'),
      demoChapter('dream-grail', '개척 후문: 좋은꿈과 성배', '페나코니'),
      demoChapter('memories-opening', '종말 임무: 기억은 꿈의 오프닝', '페나코니'),
    ],
  },
  {
    id: 'amphoreus-records',
    title: '불을 쫓는 낙목의 영웅기',
    subtitle: '제4장 — 앰포리어스',
    arcLabel: '제4장 — 앰포리어스',
    description:
      '「영원의 땅」 앰포리어스, 세 가지 운명의 길이 얽혀 있는 개척되지 않은 땅. 운명의 소용돌이는 작은 배 한 척의 도래를 기다리고 있다……',
    category: 'trailblaze',
    world: 'amphoreus',
    order: 5,
    language: 'ko-KR',
    tags: ['제4장', '앰포리어스'],
    source: { kind: 'demo', note: '사용자가 지정한 개척 임무 목록 · 본문은 기능 확인용 예시' },
    chapters: [
      demoChapter('journey', '제1막: 불을 쫓는 낙목의 영웅기', '앰포리어스'),
      demoChapter('gate-throne', '제2막: 문의 시작, 왕좌의 종말', '앰포리어스'),
      demoChapter('flowers', '제3막: 안식의 땅의 꽃밭을 지나', '앰포리어스'),
      demoChapter('dawn-fall', '제4막: 여명이 틀 무렵의 추락', '앰포리어스'),
      demoChapter('sun-destruction', '제5막: 태양이 파멸로 향하기에', '앰포리어스'),
      demoChapter('before-heroes-die', '제6막: 영웅은 죽기 전에', '앰포리어스'),
      demoChapter('long-night', '제7막: 긴 밤 속에 다시 대지로', '앰포리어스'),
      demoChapter('yesterdays-tomorrow', '제8막: 어제의 내일이 되어', '앰포리어스'),
      subChapter(
        'as-i-write',
        '모험 임무: 내가 쓰는 대로',
        '앰포리어스',
        'yesterdays-tomorrow',
        'adventure',
      ),
    ],
  },
  {
    id: 'paradise-records',
    title: '낙원에 오신 걸 환영합니다',
    subtitle: '제5장 — 이상 낙원 / 아스트로폴리스',
    arcLabel: '제5장 — 이상 낙원 / 아스트로폴리스',
    description:
      '어느새 빠져든 그림 속 낙원에서 공중의 신좌는 미소 지으며, 신위를 다투는 알현자들이 가면을 쓴 채 모두를 기쁘게 하길 기다린다. 겁화가 은하를 태우는 가운데, 신은 자리를 비우고 환락을 갈망하는 이들에게…「신이 되는 1분」이라는 상을 남겼다.',
    category: 'trailblaze',
    world: 'paradise-astropolis',
    order: 6,
    language: 'ko-KR',
    tags: ['제5장', '이상 낙원', '아스트로폴리스'],
    source: { kind: 'demo', note: '사용자가 지정한 개척 임무 목록 · 본문은 기능 확인용 예시' },
    chapters: [
      demoChapter('paradise', '제1막: 낙원에 오신 걸 환영합니다', '이상 낙원 / 아스트로폴리스'),
      demoChapter('astropolis', '제2막: 새벽에 바치는 폭주', '이상 낙원 / 아스트로폴리스'),
      demoChapter(
        'laughter',
        '제3막: 그리하여, 웃음소리는 멈추지 않으리',
        '이상 낙원 / 아스트로폴리스',
      ),
      demoChapter('river-of-oblivion', '제4막: 산 자의 망천에 잠겨', '이상 낙원 / 아스트로폴리스'),
      demoChapter(
        'silent-horn',
        '제5막: 적막이 깃든 순간, 울리는 경적',
        '이상 낙원 / 아스트로폴리스',
      ),
    ],
  },
];

const contentIndex = importedContent as Record<string, NonNullable<Chapter['content']>>;
export const archive: ArchiveEntry[] = [
  ...originalEntries.map(
    (entry): ArchiveEntry => ({
      ...entry,
      source: {
        kind: 'extracted',
        version: '한국어 고정 자료 a66ec9c',
        sourceIds: entry.chapters.flatMap(
          (chapter) => contentIndex[`${entry.id}/${chapter.id}`]?.sourceIds ?? [],
        ),
      },
      chapters: entry.chapters.map((chapter) => ({
        ...chapter,
        content: contentIndex[`${entry.id}/${chapter.id}`],
      })),
    }),
  ),
  ...(simulation as ArchiveEntry[]),
];
