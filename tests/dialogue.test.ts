import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { archive, categories } from '../src/data/archive.ts';
import {
  dialoguePage,
  isDialogueRows,
  nearbyDialogue,
  type DialogueRow,
} from '../src/lib/dialogue.ts';
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
test('dialogue links locate exact IDs across page boundaries even when text is identical', () => {
  const rows = Array.from({ length: 101 }, (_, index) => row(String(index)));
  assert.equal(dialoguePage(rows, '0'), 1);
  assert.equal(dialoguePage(rows, '49'), 1);
  assert.equal(dialoguePage(rows, '50'), 2);
  assert.equal(dialoguePage(rows, '100'), 3);
  assert.equal(dialoguePage(rows, 'missing'), undefined);
  assert.equal(dialoguePage([], '0'), undefined);
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
    ['trailblaze', 'simulation', 'codex', 'books'],
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
  assert.ok(
    archive.filter((entry) => entry.category === 'trailblaze').flatMap((entry) => entry.chapters)
      .length >= 36,
  );
});
test('Astropolis additions preserve verified dialogue and label the introduction-only chapter', () => {
  const entry = archive.find((item) => item.id === 'paradise-records')!;
  const additions = ['celestial-gambit', 'penniless-billionaire', 'before-moonrise'].map(
    (id) => entry.chapters.find((chapter) => chapter.id === id)!,
  );
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
  const payload = JSON.parse(fs.readFileSync(`public/${intro.content!.file}`, 'utf8'));
  const source = JSON.parse(fs.readFileSync('src/data/astropolis-intro.json', 'utf8'));
  assert.equal(payload.textReferenceCommit ?? payload.referenceCommit, source.commit);
  assert.equal(payload.rows[0].type, 'narration');
  assert.ok(payload.rows[0].text.includes('현인의 피'));
  if (intro.bwikiManaged) {
    assert.ok(payload.rows.length > 1000);
    assert.equal(intro.contentNote, 'BWIKI 순서·선택지 대조 본문 수록 · 일부 구간 확인 필요');
    assert.ok(payload.rows.some((row: DialogueRow) => row.type === 'choice'));
  } else if (intro.upstreamManaged && payload.rows.length > 1) {
    assert.ok(
      ['공개 임무 구조의 대사·선택지 수록', '이전 검증 본문 수록 · 최신 장면 연결 대기'].includes(
        intro.contentNote!,
      ),
    );
    assert.ok(payload.sourceIds.some((id: string) => id.startsWith('quest-')));
  } else {
    assert.equal(intro.contentNote, '챕터 소개문 수록 · 대사 본문 미수록');
    assert.equal(payload.rows.length, 1);
  }
});

test('official video feed validates IDs, decodes titles and sorts by publication date', () => {
  const xml = `<feed><yt:channelId>${CHANNEL_ID}</yt:channelId><entry><yt:videoId>abcdefghijk</yt:videoId><title>A &amp; B</title><published>2026-10-01T00:00:00Z</published><link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/></entry><entry><yt:videoId>lmnopqrstuv</yt:videoId><title>Short</title><published>2026-10-02T00:00:00Z</published><link rel="alternate" href="https://www.youtube.com/shorts/lmnopqrstuv"/></entry></feed>`;
  const videos = parseVideos(xml);
  assert.equal(videos[0].isShort, true);
  assert.equal(videos[1].title, 'A & B');
  assert.throws(() => parseVideos(xml.replace('abcdefghijk', 'bad')));
  assert.throws(() => parseVideos('<feed/>'));
});

test('published automatic update receipt agrees with the actual content and source revision', () => {
  const receipt = JSON.parse(fs.readFileSync('public/content-update.json', 'utf8'));
  const search = JSON.parse(fs.readFileSync('public/content/search-index.json', 'utf8'));
  const train = JSON.parse(fs.readFileSync('src/data/train-databank.json', 'utf8'));
  assert.equal(receipt.schema, 'hsr-content-update.v1');
  assert.equal(receipt.commit, train.commit);
  assert.equal(receipt.rows, search.rows.length);
  assert.equal(receipt.verifiedTextRows + receipt.retainedTextRows, receipt.rows);
  assert.ok(receipt.verifiedTextRows > 0);
  assert.equal(receipt.intervalHours, 6);
  assert.ok(!Number.isNaN(Date.parse(receipt.checkedAt)));
  for (const entry of archive)
    for (const chapter of entry.chapters)
      assert.equal(chapter.content!.textReferenceCommit, receipt.commit);
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
  const train = JSON.parse(fs.readFileSync('src/data/train-databank.json', 'utf8'));
  assert.deepEqual(
    [aeons.chapters.length, terms.chapters.length, factions.chapters.length],
    train.groups.map(
      (group: { documents: { title: string }[] }) =>
        new Set(group.documents.map((doc) => doc.title)).size,
    ),
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
      assert.equal(payload.referenceCommit, train.commit);
      assert.ok(payload.rows.every((row: DialogueRow) => row.source?.startsWith('NounAtlas:')));
      assert.equal(payload.rows[0].variant, '기본 기록');
    }
  }
  const intro = JSON.parse(fs.readFileSync(`public/${aeons.chapters[0].content!.file}`, 'utf8'));
  assert.match(intro.rows[0].text, /^깊은 하늘과 별바다를 거니는/);
  assert.ok(!intro.rows[0].text.includes('지식학회'));
  const nanook = aeons.chapters.find((chapter) => chapter.id === 'noun-atlas-102')!;
  const updated = JSON.parse(fs.readFileSync(`public/${nanook.content!.file}`, 'utf8'));
  assert.ok(updated.rows.length >= 2);
  assert.notEqual(updated.rows[0].text, updated.rows[1].text);
  const qlipoth = aeons.chapters.find((chapter) => chapter.id === 'noun-atlas-107')!;
  assert.ok(qlipoth.aliases?.includes('aeon-1'));
});
