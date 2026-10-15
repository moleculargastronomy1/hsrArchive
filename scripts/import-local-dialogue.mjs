import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { archive } from '../src/data/archive.ts';

const sourceRoot = path.resolve(process.argv[2] ?? '.cache/starrail-source');
const referenceRoot = path.resolve(process.argv[3] ?? '../references/starrail-quests');
const commit = 'a66ec9c36e3321ce4ea9e62b58e9326634628dce';
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const catalog = read(path.join(sourceRoot, 'data/catalog.json'));
if (!Array.isArray(catalog)) throw new Error('Unsupported catalog format');
const handbookBytes = fs.readFileSync(path.join(referenceRoot, 'public/handbook-originals.json'));
const handbookManifest = read(
  path.join(referenceRoot, 'editorial/handbook-originals-manifest.json'),
);
if (digest(handbookBytes) !== handbookManifest.sha256) throw new Error('Handbook hash mismatch');
const handbook = JSON.parse(handbookBytes);
if (handbook.schemaVersion !== 'starrail-handbook-originals.v1')
  throw new Error('Unsupported handbook schema');
const providedDocuments = new Map(handbook.documents.map((doc) => [doc.id, doc]));
const trainDatabankBytes = fs.readFileSync('src/data/train-databank.json');
const trainDatabank = JSON.parse(trainDatabankBytes);
if (trainDatabank.schema !== 'hsr-train-databank.v1')
  throw new Error('Unsupported train databank schema');
for (const group of trainDatabank.groups)
  for (const doc of group.documents) providedDocuments.set(doc.id, doc);
const supplements = read(path.join(referenceRoot, 'data/mission-dialogue-supplements.json'));
const deep = read(path.join(referenceRoot, 'data/deep-timeline-dialogue.json'));
if (
  supplements.schema !== 'starrail-mission-dialogue-supplements.v1' ||
  deep.schema !== 'starrail-deep-timeline-dialogue.v1'
) {
  throw new Error(`Unsupported dialogue schemas: ${supplements.schema}, ${deep.schema}`);
}
const normalize = (text) => text.normalize('NFKC').replace(/[\s·•≪≫]/g, '');
const titleOf = (title) => title.replace(/^(?:제\d+막|개척 후문|종말 임무|모험 임무):\s*/, '');
const plain = (text) =>
  text
    .replace(/<\/?(?:color|size|b|i|s|u|unbreak)(?:=[^>]*)?>/gi, '')
    .replace(/\*{0,2}\{NICKNAME\}\*{0,2}/g, '[개척자]')
    .replace(/\u00a0/g, ' ');
const deepByMission = new Map();
for (const scene of deep.scenes) {
  if (scene.ownerStatus !== 'ONE_EXPLICIT_OWNER' || scene.owners.length !== 1) continue;
  const id = scene.owners[0].canonicalMission ?? scene.owners[0].mission;
  if (!deepByMission.has(id)) deepByMission.set(id, []);
  deepByMission.get(id).push(scene);
}
const output = path.resolve('public/content');
fs.mkdirSync(output, { recursive: true });
const metadata = {};
const searchRows = [];
const sourceFiles = {};
let unverifiedScenes = 0;

function convert(entryId, chapterId, documents, dedupeText = false, sourceCommit = commit) {
  const rows = [];
  let missing = 0;
  const sharedText = new Set();
  for (const meta of documents) {
    const file = path.join(sourceRoot, `data/documents/${meta.id}.json`);
    const bytes = providedDocuments.has(meta.id)
      ? Buffer.from(JSON.stringify(providedDocuments.get(meta.id)))
      : fs.readFileSync(file);
    sourceFiles[meta.id] = digest(bytes);
    const doc = JSON.parse(bytes);
    if (doc.id !== meta.id || !Array.isArray(doc.sections))
      throw new Error(`Invalid document: ${meta.id}`);
    const seen = new Set();
    const add = (raw, scene, origin) => {
      if (typeof raw.text !== 'string' || !raw.text.trim()) {
        missing++;
        return;
      }
      if (raw.talk_id === 999999999) return;
      const text = plain(raw.text);
      if (dedupeText && sharedText.has(text)) return;
      sharedText.add(text);
      const key = raw.talk_id ? `${raw.talk_id}:${raw.label ?? ''}` : `${scene}:${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        id: `${entryId}-${chapterId}-${meta.id}-${rows.length}`,
        entryId,
        chapterId,
        missionId: meta.id,
        mission: plain(meta.title),
        scene: plain(scene),
        type: raw.label === '선택지' ? 'choice' : raw.speaker ? 'dialogue' : 'narration',
        speaker: plain(raw.speaker ?? ''),
        text,
        talkId: raw.talk_id ?? null,
        source: origin,
        ...(raw.variant ? { variant: raw.variant } : {}),
      });
    };
    for (const section of doc.sections) {
      // Unknown scene mappings are not silently presented as verified story content.
      if (doc.category === '퀘스트' && section.mapping !== 'LOCAL_ID_ORDER_MATCH') {
        unverifiedScenes++;
        continue;
      }
      for (const row of section.rows ?? [])
        add(row, section.title || meta.title, section.source || doc.source);
    }
    for (const scene of supplements.missions[meta.id] ?? []) {
      if (scene.mapping !== 'EXACT_PUBLIC_STRUCTURE_REFERENCE_TO_PRESERVED_LOCAL_TALK') continue;
      if (
        !(scene.ownership ?? []).some(
          (owner) => `quest-${owner.canonicalMissionId ?? owner.missionId}` === meta.id,
        )
      )
        continue;
      for (const row of scene.rows ?? []) add(row, meta.title, scene.source);
    }
    for (const scene of deepByMission.get(meta.id) ?? []) {
      for (const row of scene.rows) {
        const join = deep.joins[String(row.talkId)];
        if (!join?.raw) {
          missing++;
          continue;
        }
        add(
          {
            talk_id: row.talkId,
            label: /CHOICE|OPTION/.test(row.role) ? '선택지' : '대사',
            speaker: join.speakerRaw,
            text: join.raw,
          },
          scene.title || meta.title,
          scene.source,
        );
      }
    }
  }
  const file = `content/${entryId}--${chapterId}.json`;
  fs.writeFileSync(
    path.join('public', file),
    JSON.stringify({
      schema: 'hsr-dialogue.v1',
      entryId,
      chapterId,
      referenceCommit: sourceCommit,
      sourceIds: documents.map((doc) => doc.id),
      missing,
      orderNote:
        '자료의 참조 순서입니다. 선택지와 분기는 모두 수록하며 실제 플레이 순서와 다를 수 있습니다.',
      rows,
    }),
  );
  const record = { file, rows: rows.length, missing, sourceIds: documents.map((doc) => doc.id) };
  metadata[`${entryId}/${chapterId}`] = record;
  searchRows.push(...rows);
  return record;
}

for (const entry of archive.filter((item) => item.category === 'trailblaze')) {
  for (const chapter of entry.chapters) {
    const wanted = normalize(titleOf(chapter.title));
    const docs = catalog
      .filter((doc) =>
        chapter.kind === 'adventure'
          ? doc.category === '퀘스트' && normalize(doc.title) === wanted
          : doc.category === '퀘스트' &&
            ['개척 임무', '개척 후문', '종말 임무'].includes(doc.kind) &&
            normalize(doc.chapter ?? '') === wanted,
      )
      .sort((a, b) => Number(a.rank) - Number(b.rank) || a.id.localeCompare(b.id));
    if (!docs.length)
      throw new Error(`No exact source chapter match: ${entry.id}/${chapter.title}`);
    const result = convert(entry.id, chapter.id, docs);
    console.log(
      `${entry.id}/${chapter.id}: ${docs.length} missions, ${result.rows} rows, ${result.missing} unavailable`,
    );
  }
}
const simulationGroups = [
  [
    'simulated-universe',
    '시뮬레이션 우주',
    '헤르타의 실험과 시뮬레이션 우주에 남겨진 대화.',
    (doc) => doc.category === '퀘스트' && /^시뮬레이션 우주/.test(doc.title),
  ],
  [
    'swarm-disaster',
    '곤충 떼 재난',
    '곤충 떼 재난의 실험과 진행 기록.',
    (doc) => doc.category === '퀘스트' && /^곤충 떼 재난/.test(doc.title),
  ],
  [
    'gold-and-gears',
    '황금과 기계',
    '황금과 기계에서 이어지는 실험의 기록.',
    (doc) => doc.category === '퀘스트' && /^황금과 기계/.test(doc.title),
  ],
  [
    'divergent-universe',
    '차분화 우주',
    '차분화 우주의 실험에 관한 대화.',
    (doc) => doc.category === '퀘스트' && /^차분화 우주/.test(doc.title),
  ],
  [
    'curios',
    '기물 기록',
    '시뮬레이션 우주에서 발견하는 기물의 이야기.',
    (doc) => doc.category === '시뮬레이션 우주 설정',
  ],
];
const simulation = simulationGroups.map(([id, title, description, select], index) => {
  const docs = catalog
    .filter(select)
    .sort(
      (a, b) =>
        Number(a.rank) - Number(b.rank) || a.id.localeCompare(b.id, 'en', { numeric: true }),
    );
  return {
    id,
    title,
    description,
    subtitle: '시뮬레이션 우주',
    category: 'simulation',
    world: 'simulated-universe',
    order: index + 7,
    language: 'ko-KR',
    tags: [title, '시뮬레이션 우주'],
    source: {
      kind: 'extracted',
      version: `한국어 고정 자료 ${commit.slice(0, 7)}`,
      sourceIds: docs.map((doc) => doc.id),
    },
    chapters: docs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      blocks: [],
      content: convert(id, doc.id, [doc]),
    })),
  };
});
fs.writeFileSync('src/data/simulation.json', JSON.stringify(simulation, null, 2) + '\n');

// Only the requested handbook categories are converted. Monster combat variants share a title;
// keep distinct descriptions, but do not repeat an identical paragraph for every internal ID.
const knownIds = new Set(catalog.map((doc) => doc.id));
const handbookAdditions = handbook.documents.filter(
  (doc) =>
    !knownIds.has(doc.id) && ['광추 이야기', '캐릭터 이야기', '세계관·용어'].includes(doc.category),
);
const allNamed = [...catalog, ...handbookAdditions];
const codexGroups = [
  ...trainDatabank.groups.map((group) => [
    group.id,
    group.title,
    group.description,
    group.documents,
  ]),
  [
    'light-cones',
    '광추',
    '광추에 담긴 기억과 이야기.',
    allNamed.filter((doc) => doc.category === '광추 이야기'),
  ],
  [
    'hostile-species',
    '적대적 생물',
    '적대적 생물의 설명과 기록. 같은 이름의 전투 변형은 함께 묶었습니다.',
    handbook.documents.filter((doc) => doc.category === '적 기록'),
  ],
  [
    'characters',
    '캐릭터',
    '캐릭터 소개와 인물 이야기.',
    allNamed.filter((doc) => doc.category === '캐릭터 이야기'),
  ],
  [
    'relics',
    '유물',
    '유물에 남겨진 이야기와 기억.',
    allNamed.filter((doc) => doc.category === '유물 이야기'),
  ],
];
const codex = codexGroups.map(([groupId, title, description, docs], index) => {
  const entryId = `codex-${groupId}`;
  const isTrain = trainDatabank.groups.some((group) => group.id === groupId);
  const namedGroups = Map.groupBy(docs, (doc) => plain(doc.title));
  return {
    id: entryId,
    title,
    description,
    subtitle: '아카이브',
    category: 'codex',
    world: 'universe',
    order: index + 12,
    language: 'ko-KR',
    tags: [title, '아카이브'],
    source: {
      kind: 'extracted',
      version: isTrain
        ? `열차 자료실 NounAtlas ${trainDatabank.commit.slice(0, 7)}`
        : `한국어 고정 자료 ${commit.slice(0, 7)}`,
      sourceIds: docs.map((doc) => doc.id),
    },
    chapters: [...namedGroups]
      .sort(([a, left], [b, right]) =>
        isTrain ? left[0].sortId - right[0].sortId : a.localeCompare(b, 'ko'),
      )
      .map(([name, documents]) => ({
        id: documents[0].id,
        title: name,
        ...(isTrain
          ? { intro: documents[0].isIntroPage, aliases: legacyAliases(groupId, documents[0]) }
          : {}),
        blocks: [],
        content: convert(
          entryId,
          documents[0].id,
          documents,
          !isTrain,
          isTrain ? trainDatabank.commit : commit,
        ),
      })),
  };
});
function legacyAliases(groupId, doc) {
  if (groupId === 'terms' && doc.isIntroPage) return ['reference-terms-intro'];
  if (groupId === 'factions' && doc.nounId >= 200 && doc.nounId <= 221)
    return [`book-47-section-${doc.nounId - 199}`];
  if (groupId === 'aeons') {
    const name = doc.title.split(',').at(-1).trim();
    const old = allNamed.find(
      (item) =>
        item.title === name &&
        (item.category === '에이언즈·운명의 길' ||
          ['lore-10042', 'lore-10084', 'lore-10087', 'lore-10089'].includes(item.id)),
    );
    return old ? [old.id] : [];
  }
  return [];
}
const currentPayloads = new Set(
  Object.values(metadata).map((record) => path.basename(record.file)),
);
for (const file of fs.readdirSync(output)) {
  if (/^codex-(aeons|terms|factions)--/.test(file) && !currentPayloads.has(file))
    fs.unlinkSync(path.join(output, file));
}
fs.writeFileSync('src/data/codex.json', JSON.stringify(codex, null, 2) + '\n');
const trailblazeIds = new Set(
  archive.filter((entry) => entry.category === 'trailblaze').map((entry) => entry.id),
);
fs.writeFileSync(
  'src/data/imported-content.json',
  JSON.stringify(
    Object.fromEntries(
      Object.entries(metadata).filter(([key]) => trailblazeIds.has(key.split('/')[0])),
    ),
    null,
    2,
  ) + '\n',
);
fs.writeFileSync(
  'public/content/search-index.json',
  JSON.stringify({
    schema: 'hsr-dialogue.v1',
    referenceCommit: commit,
    sourceReferences: [
      { repository: 'mizan0515/starrail-quests', commit },
      { repository: trainDatabank.repository, commit: trainDatabank.commit },
    ],
    rows: searchRows.map(({ missionId, talkId, source, ...row }) => ({
      ...row,
      source: crypto.createHash('sha256').update(source).digest('hex').slice(0, 16),
    })),
  }),
);
fs.writeFileSync(
  'docs/content-provenance.json',
  JSON.stringify(
    {
      reference: 'mizan0515/starrail-quests',
      commit,
      sourceFiles,
      supplementalFiles: {
        'public/handbook-originals.json': digest(handbookBytes),
        'src/data/train-databank.json': digest(trainDatabankBytes),
      },
      trainDatabank: {
        repository: trainDatabank.repository,
        commit: trainDatabank.commit,
        files: trainDatabank.files,
      },
      rows: searchRows.length,
      chapters: Object.keys(metadata).length,
      skippedUnverifiedScenes: unverifiedScenes,
      note: '한국어 텍스트를 현지 파일에서 변환. 임무 귀속이 명시된 장면만 연결. 게임 원문의 권리는 해당 권리자에게 있습니다.',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Imported ${searchRows.length} rows; ${unverifiedScenes} unverified scene mappings excluded.`,
);
