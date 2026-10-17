import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkVideos } from '../scripts/video-chapter-links.mjs';

test('simulation sources require an explicit reviewed mode/event file scope', () => {
  const chapters = [
    {
      file: 'simulation-a',
      category: 'simulation',
      title: '같은 사건',
      missionTitles: ['같은 사건'],
    },
    {
      file: 'simulation-b',
      category: 'simulation',
      title: '같은 사건',
      missionTitles: ['같은 사건'],
    },
  ];
  const plain = { id: 'exzWuZ3hdoM', title: '시뮬레이션 우주 같은 사건' };
  assert.ok(
    Object.values(linkVideos(chapters, [plain]).matches).every(
      (items: unknown[]) => items.length === 0,
    ),
  );
  const result = linkVideos(chapters, [
    { ...plain, category: 'simulation', files: ['simulation-a'] },
  ]);
  assert.equal(result.matches['simulation-a'][0].linkMethod, 'reviewed-mode-and-event-scope');
  assert.equal(result.matches['simulation-b'].length, 0);
});

test('official subquest names link videos to chapters without treating episode numbers as act numbers', () => {
  const chapters = [
    {
      file: 'chapter-a',
      title: '제1막: 첫 번째 이야기',
      arcLabel: '제4장 — 앰포리어스',
      missionTitles: ['은빛 전차여, 검은 대지로 나아가라'],
    },
    {
      file: 'chapter-b',
      title: '제2막: 다른 이야기',
      arcLabel: '제4장 — 앰포리어스',
      missionTitles: ['밤의 장막이여, 침묵의 과거를 가려라'],
    },
    {
      file: 'other-world',
      title: '제1막: 다른 지역',
      arcLabel: '제5장 — 이상 낙원',
      missionTitles: ['은빛 전차여, 검은 대지로 나아가라'],
    },
  ];
  const result = linkVideos(chapters, [
    {
      id: '12345678901',
      title:
        '[붕괴: 스타레일] 개척 임무 제4장 『앰포리어스』 #17 「은빛 전차여, 검은 대지로 나아가라」',
    },
  ]);
  assert.equal(result.matches['chapter-a'].length, 1);
  assert.equal(result.matches['chapter-a'][0].linkMethod, 'official-mission-title');
  assert.equal(result.matches['chapter-b'].length, 0);
  assert.equal(result.matches['other-world'].length, 0);
});

test('event videos and ambiguous upper/lower continuances never become confirmed chapter links', () => {
  const chapters = [
    { file: 'main', title: '제1막: 처음 떠나는 이야기', missionTitles: ['같은 긴 임무 이름'] },
    {
      file: 'a',
      title: '개척 후문: 청천 위 교차하는 칼끝·상',
      missionTitles: ['같은 긴 임무 이름'],
    },
    {
      file: 'b',
      title: '개척 후문: 청천 위 교차하는 칼끝·하',
      missionTitles: ['같은 긴 임무 이름'],
    },
  ];
  const result = linkVideos(chapters, [
    { id: '12345678901', title: '이벤트 스토리 『처음 떠나는 이야기』' },
    { id: '23456789012', title: '개척 후문 『청천 위 교차하는 칼끝』 #1' },
    { id: '34567890123', title: '개척 후문 『같은 긴 임무 이름』 #2' },
  ]);
  assert.ok(Object.values(result.matches).every((items: unknown[]) => items.length === 0));
  assert.equal(result.review.length, 2);
  assert.equal(result.review[1].candidateFiles.length, 2);
});

test('unique official subtitle and subquest prelude labels can match without translation or fuzzy guessing', () => {
  const chapters = [
    { file: 'war', title: '개척 후문: 나나웃레이지·인의(忍義) 없는 전쟁', missionTitles: [] },
    {
      file: 'market',
      title: '개척 후문: 겨울꿈에서 깨어난 순간',
      missionTitles: ['미래 시장(서막)'],
    },
  ];
  const result = linkVideos(chapters, [
    { id: '12345678901', title: '개척 후문 『인의(忍義) 없는 전쟁』 #2' },
    { id: '23456789012', title: '개척 후문 『미래 시장』' },
  ]);
  assert.equal(result.matches.war.length, 1);
  assert.equal(result.matches.market.length, 1);
});
