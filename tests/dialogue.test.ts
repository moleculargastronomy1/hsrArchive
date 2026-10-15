import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { archive, categories } from '../src/data/archive.ts';
import { isDialogueRows, nearbyDialogue, type DialogueRow } from '../src/lib/dialogue.ts';
import { parseVideos, CHANNEL_ID } from '../scripts/youtube-feed.mjs';

const row = (id: string, chapterId = 'first', scene = 'arrival'): DialogueRow => ({
  id,
  entryId: 'station',
  chapterId,
  mission: 'mission',
  scene,
  speaker: 'speaker',
  text: 'text',
  type: 'dialogue',
});
test('context never crosses a chapter or scene boundary and is bounded to 41 lines', () => {
  const data = [
    row('before', 'other'),
    ...Array.from({ length: 55 }, (_, i) => row(String(i))),
    row('after', 'first', 'other'),
  ];
  assert.equal(nearbyDialogue(data, 27).length, 41);
  assert.deepEqual(
    nearbyDialogue(data, 1, 2).map((item) => item.id),
    ['0', '1', '2'],
  );
  assert.deepEqual(
    nearbyDialogue(data, 55, 2).map((item) => item.id),
    ['52', '53', '54'],
  );
  assert.deepEqual(nearbyDialogue(data, 99), []);
});
test('dialogue schema rejects malformed rows before rendering', () => {
  assert.equal(isDialogueRows([row('valid')]), true);
  assert.equal(isDialogueRows([{ ...row('invalid'), text: null }]), false);
  assert.equal(isDialogueRows([{ ...row('invalid'), type: 'html' }]), false);
});
test('published metadata resolves to matching Korean payloads and unique global row IDs', () => {
  assert.deepEqual(
    categories.map((category) => category.id),
    ['trailblaze', 'simulation', 'codex'],
  );
  const search = JSON.parse(fs.readFileSync('public/content/search-index.json', 'utf8'));
  assert.ok(isDialogueRows(search.rows));
  assert.ok(search.rows.some((item: DialogueRow) => item.text.includes('[개척자]')));
  assert.ok(
    search.rows.every(
      (item: DialogueRow) => !`${item.text} ${item.speaker}`.includes('{NICKNAME}'),
    ),
  );
  assert.equal(new Set(search.rows.map((item: DialogueRow) => item.id)).size, search.rows.length);
  let total = 0;
  for (const entry of archive)
    for (const chapter of entry.chapters) {
      assert.ok(chapter.content, `Missing content: ${entry.id}/${chapter.id}`);
      const payload = JSON.parse(fs.readFileSync(`public/${chapter.content!.file}`, 'utf8'));
      assert.ok(isDialogueRows(payload.rows));
      assert.equal(payload.rows.length, chapter.content!.rows);
      assert.ok(!JSON.stringify(payload.rows).includes('{NICKNAME}'));
      assert.ok(
        payload.rows.every(
          (item: DialogueRow) => item.entryId === entry.id && item.chapterId === chapter.id,
        ),
      );
      total += payload.rows.length;
    }
  assert.equal(total, search.rows.length);
  assert.equal(
    archive.filter((entry) => entry.category === 'trailblaze').flatMap((entry) => entry.chapters)
      .length,
    36,
  );
});
test('Astropolis additions preserve verified dialogue and label the introduction-only chapter', () => {
  const entry = archive.find((item) => item.id === 'paradise-records')!;
  const additions = entry.chapters.slice(-3);
  assert.deepEqual(
    additions.map((chapter) => chapter.title),
    [
      '제6막: 천성에 던진 승부수',
      '개척 후문: 무일푼 재벌 프로젝트',
      '제7막: 달 뜨기 전, 괴수와 춤을',
    ],
  );
  for (const chapter of additions.slice(0, 2)) {
    const payload = JSON.parse(fs.readFileSync(`public/${chapter.content!.file}`, 'utf8'));
    assert.ok(payload.rows.length >= 1000);
    assert.ok(payload.rows.some((row: DialogueRow) => row.type === 'choice'));
    assert.ok(payload.rows.some((row: DialogueRow) => row.type === 'dialogue' && row.speaker));
    assert.ok(payload.sourceIds.every((id: string) => id.startsWith('quest-10545')));
  }
  const intro = additions[2];
  assert.equal(intro.contentNote, '챕터 소개문 수록 · 대사 본문 미수록');
  const payload = JSON.parse(fs.readFileSync(`public/${intro.content!.file}`, 'utf8'));
  assert.equal(payload.referenceCommit, '312b4597691e0a29cf9828a15b592757dba86949');
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].type, 'narration');
  assert.ok(payload.rows[0].text.includes('현인의 피'));
});

test('official video feed validates IDs, decodes titles and sorts by publication date', () => {
  const xml = `<feed><yt:channelId>${CHANNEL_ID}</yt:channelId><entry><yt:videoId>abcdefghijk</yt:videoId><title>A &amp; B</title><published>2026-10-01T00:00:00Z</published><link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/></entry><entry><yt:videoId>lmnopqrstuv</yt:videoId><title>Short</title><published>2026-10-02T00:00:00Z</published><link rel="alternate" href="https://www.youtube.com/shorts/lmnopqrstuv"/></entry></feed>`;
  const videos = parseVideos(xml);
  assert.equal(videos[0].isShort, true);
  assert.equal(videos[1].title, 'A & B');
  assert.throws(() => parseVideos(xml.replace('abcdefghijk', 'bad')));
  assert.throws(() => parseVideos('<feed/>'));
});

test('all seven requested archive collections publish nonempty source text and deduplicated monster variants', () => {
  const codex = archive.filter((entry) => entry.category === 'codex');
  assert.deepEqual(
    codex.map((entry) => entry.title),
    ['에이언즈', '고유 명사', '파벌', '광추', '적대적 생물', '캐릭터', '유물'],
  );
  for (const entry of codex) {
    assert.ok(entry.chapters.length > 0);
    assert.ok(entry.chapters.every((chapter) => chapter.content!.rows > 0));
    assert.equal(
      new Set(entry.chapters.map((chapter) => chapter.title)).size,
      entry.chapters.length,
    );
  }
  const terms = codex.find((entry) => entry.id === 'codex-terms')!;
  const noun = terms.chapters.find((chapter) => chapter.title === '명사')!;
  assert.ok(noun, 'The supplied proper noun example has a matching record');
  const nounData = JSON.parse(fs.readFileSync(`public/${noun.content!.file}`, 'utf8'));
  assert.ok(nounData.rows.some((row: DialogueRow) => row.text.includes('태초 혼돈의 균열')));
  for (const monster of codex.find((entry) => entry.id === 'codex-hostile-species')!.chapters) {
    const payload = JSON.parse(fs.readFileSync(`public/${monster.content!.file}`, 'utf8'));
    assert.equal(
      new Set(payload.rows.map((row: DialogueRow) => row.text)).size,
      payload.rows.length,
    );
  }
});

test('train archive uses NounAtlas text and SortID order, with story updates kept as variants', () => {
  const [aeons, terms, factions] = archive.filter((entry) => entry.category === 'codex');
  assert.deepEqual(
    [aeons.chapters.length, terms.chapters.length, factions.chapters.length],
    [16, 40, 35],
  );
  assert.deepEqual(
    aeons.chapters.slice(0, 5).map((chapter) => chapter.title),
    ['에이언즈', '「개척」, 아키비리', '「파멸」, 나누크', '「수렵」, 란', '「지식」, 누스'],
  );
  assert.deepEqual(
    terms.chapters.slice(0, 4).map((chapter) => chapter.title),
    ['명사', '헤르타(지명)', '야릴로-Ⅵ(지명)', '선주 「나부」(지명)'],
  );
  assert.deepEqual(
    factions.chapters.slice(0, 7).map((chapter) => chapter.title),
    [
      '파벌',
      '은하열차 - 개척',
      '스텔라론 헌터 - ???',
      '무명객 - 개척',
      '선주 연맹 - 수렵',
      '갤럭시 레인저 - 수렵',
      '자멸자 - 공허',
    ],
  );
  for (const entry of [aeons, terms, factions]) {
    assert.equal(entry.chapters[0].intro, true);
    for (const chapter of entry.chapters) {
      const payload = JSON.parse(fs.readFileSync(`public/${chapter.content!.file}`, 'utf8'));
      assert.equal(payload.referenceCommit, '724b139d8c9c32d12552eb95745a4fee72bfe48b');
      assert.ok(payload.rows.every((row: DialogueRow) => row.source?.startsWith('NounAtlas:')));
      assert.equal(payload.rows[0].variant, '기본 기록');
    }
  }
  const intro = JSON.parse(fs.readFileSync(`public/${aeons.chapters[0].content!.file}`, 'utf8'));
  assert.match(intro.rows[0].text, /^깊은 하늘과 별바다를 거니는/);
  assert.ok(!intro.rows[0].text.includes('지식학회'));
  const nanook = aeons.chapters.find((chapter) => chapter.id === 'noun-atlas-102')!;
  const updated = JSON.parse(fs.readFileSync(`public/${nanook.content!.file}`, 'utf8'));
  assert.equal(updated.rows.length, 2);
  assert.notEqual(updated.rows[0].text, updated.rows[1].text);
  const qlipoth = aeons.chapters.find((chapter) => chapter.id === 'noun-atlas-107')!;
  assert.ok(qlipoth.aliases?.includes('aeon-1'));
});
