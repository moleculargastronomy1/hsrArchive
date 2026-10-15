import type { ArchiveEntry, Category, Chapter, World } from './types';

export const categories: { id: Category; label: string; description: string }[] = [
  { id: 'trailblaze', label: '개척 임무', description: '별을 잇는 여정, 그 중심의 이야기' },
  { id: 'companion', label: '동행 임무', description: '여정에서 만난 이들의 또 다른 이야기' },
  { id: 'readable', label: '읽을거리', description: '세계 곳곳에 남겨진 작은 기록들' },
];

export const worlds: { id: World; label: string; short: string; english: string }[] = [
  {
    id: 'space-station',
    label: '우주정거장 「헤르타」',
    short: '우주정거장',
    english: 'HERTA SPACE STATION',
  },
  { id: 'jarilo', label: '야릴로-VI', short: '야릴로-VI', english: 'JARILO-VI' },
  { id: 'luofu', label: '선주 「나부」', short: '선주 「나부」', english: 'THE XIANZHOU LUOFU' },
  { id: 'penacony', label: '페나코니', short: '페나코니', english: 'PENACONY' },
];

// Original interface fixtures, not extracted game dialogue. Replace through the
// ArchiveEntry contract only after verifying source format and game compatibility.
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

export const archive: ArchiveEntry[] = [
  {
    id: 'station-departure',
    title: '별을 향한 첫걸음',
    subtitle: '여정의 시작',
    description: '우주정거장에서 시작되는 개척의 기록을 위한 공간입니다.',
    category: 'trailblaze',
    world: 'space-station',
    order: 1,
    language: 'ko-KR',
    tags: ['프롤로그', '우주정거장'],
    source: { kind: 'demo', note: '탐색과 읽기 기능을 위한 자체 작성 예시' },
    chapters: [
      demoChapter('arrival', '낯선 곳에서의 시작', '우주정거장'),
      demoChapter('platform', '열차가 기다리는 곳', '은하열차'),
      demoChapter('departure', '다음 별을 향하여', '새로운 여정'),
    ],
  },
  {
    id: 'jarilo-records',
    title: '눈으로 덮인 세계',
    subtitle: '얼어붙은 별의 기록',
    description: '야릴로-VI와 벨로보그의 이야기를 정리하는 공간입니다.',
    category: 'trailblaze',
    world: 'jarilo',
    order: 2,
    language: 'ko-KR',
    tags: ['벨로보그', '설원'],
    source: { kind: 'demo', note: '탐색과 읽기 기능을 위한 자체 작성 예시' },
    chapters: [
      demoChapter('snowfield', '설원 너머의 도시', '벨로보그'),
      demoChapter('city', '도시에 남겨진 이야기', '야릴로-VI'),
    ],
  },
  {
    id: 'luofu-records',
    title: '구름 위의 항로',
    subtitle: '오래된 배에 깃든 이야기',
    description: '선주 「나부」에서 만나는 이야기들을 모아 둘 공간입니다.',
    category: 'trailblaze',
    world: 'luofu',
    order: 3,
    language: 'ko-KR',
    tags: ['선주', '나부'],
    source: { kind: 'demo', note: '탐색과 읽기 기능을 위한 자체 작성 예시' },
    chapters: [
      demoChapter('harbor', '별바다의 항구', '선주 「나부」'),
      demoChapter('clouds', '구름 너머의 기록', '선주의 여정'),
    ],
  },
  {
    id: 'penacony-records',
    title: '꿈이 머무는 밤',
    subtitle: '꿈의 세계로 향하는 초대',
    description: '페나코니의 여정을 차례대로 읽기 위한 공간입니다.',
    category: 'trailblaze',
    world: 'penacony',
    order: 4,
    language: 'ko-KR',
    tags: ['꿈', '페나코니'],
    source: { kind: 'demo', note: '탐색과 읽기 기능을 위한 자체 작성 예시' },
    chapters: [
      demoChapter('invitation', '꿈으로의 초대', '페나코니'),
      demoChapter('dream', '밤에 남겨진 흔적', '꿈의 세계'),
    ],
  },
  {
    id: 'march-records',
    title: '사진에 담긴 하루',
    subtitle: 'Mar. 7th · 인물 기록 예시',
    description: '인물별 동행 임무와 관련 기록을 연결하기 위한 예시입니다.',
    category: 'companion',
    world: 'space-station',
    order: 5,
    language: 'ko-KR',
    tags: ['Mar. 7th', '은하열차'],
    source: { kind: 'demo', note: '실제 동행 임무 제목·대사가 아닌 인터페이스 예시' },
    chapters: [demoChapter('album', '사진첩을 펼치며', '인물별 기록')],
  },
  {
    id: 'dan-heng-records',
    title: '고요한 자료실',
    subtitle: '단항 · 인물 기록 예시',
    description: '인물의 이야기와 관련 자료를 함께 읽기 위한 예시입니다.',
    category: 'companion',
    world: 'luofu',
    order: 6,
    language: 'ko-KR',
    tags: ['단항', '은하열차'],
    source: { kind: 'demo', note: '실제 동행 임무 제목·대사가 아닌 인터페이스 예시' },
    chapters: [demoChapter('records', '자료실의 기록', '인물별 이야기')],
  },
  {
    id: 'express-notes',
    title: '열차 안의 작은 메모',
    subtitle: '서적 · 읽을거리 예시',
    description: '서적, 편지, 메모 같은 수집형 텍스트를 보관하는 예시입니다.',
    category: 'readable',
    world: 'space-station',
    order: 7,
    language: 'ko-KR',
    tags: ['메모', '은하열차'],
    source: { kind: 'demo', note: '실제 수집 서적이 아닌 인터페이스 예시' },
    chapters: [demoChapter('memo', '첫 번째 메모', '수집형 텍스트')],
  },
  {
    id: 'belobog-notes',
    title: '도시의 오래된 편지',
    subtitle: '편지 · 읽을거리 예시',
    description: '지역별로 발견한 기록을 분류하기 위한 예시입니다.',
    category: 'readable',
    world: 'jarilo',
    order: 8,
    language: 'ko-KR',
    tags: ['편지', '벨로보그'],
    source: { kind: 'demo', note: '실제 수집 서적이 아닌 인터페이스 예시' },
    chapters: [demoChapter('letter', '남겨진 편지', '지역별 기록')],
  },
];
