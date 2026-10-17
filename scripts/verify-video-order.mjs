import {
  restoreVideoMissions,
  applyScreenEvidence,
  orderUnknown,
} from './verification-integration.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchPlaylist,
  fetchPublicCaptions,
  matchCaptions,
  validatedCaptionMatches,
  selectVideoChecks,
  VIDEO_FIELDS,
  videoRetryDecision,
  mergeVideoChecks,
} from './video-order.mjs';
import { readRetry, saveRetry } from './verification-retry.mjs';
import { linkVideos } from './video-chapter-links.mjs';

const root = path.resolve(process.argv[2] ?? '.');
const previousRoot = path.resolve(process.argv[3] ?? root);
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = async (base, file) => JSON.parse(await fs.readFile(path.join(base, file), 'utf8'));
const write = async (file, data) => {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target + '.tmp', JSON.stringify(data));
  await fs.rename(target + '.tmp', target);
};
const update = await read(root, 'public/content-update.json');
const wiki = await read(root, 'public/bwiki-provenance.json');
const entries = [
  ...(await read(root, 'src/data/trailblaze.json')).map((entry) => ({
    ...entry,
    verificationCategory: 'trailblaze',
  })),
  ...(await read(root, 'src/data/simulation.json')).map((entry) => ({
    ...entry,
    verificationCategory: 'simulation',
  })),
];
const config = await read(repository, 'editorial/video-verification-sources.json');
const prior = await read(previousRoot, 'public/video-order-provenance.json').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return {};
});
if (config.schema !== 'hsr-video-sources.v1' || wiki.commit !== update.commit)
  throw new Error('Mixed video verification inputs');
const retryOnly = process.argv.includes('--retry');
const retryState = await readRetry(repository);
const observations = await read(repository, 'editorial/video-observations.json').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return { schema: 'hsr-video-observations.v1', evidence: [] };
});
if (observations.schema !== 'hsr-video-observations.v1' || !Array.isArray(observations.evidence))
  throw new Error('Invalid reviewed video observations');
const report = {
  schema: 'hsr-video-order-audit.v1',
  commit: update.commit,
  checkedAt: new Date().toISOString(),
  policy:
    'Official execution and BWIKI proofs are preserved. Exact public Korean captions support bracketed ordering; separately reviewed screen paths support only observed scenes and choices. Missing captions and conflicts remain pending. No access restriction bypass or video downloads.',
  sources: [],
  chapters: {},
  evidence: (prior.evidence ?? []).map((item) => ({ ...item, status: 'cached-caption-match' })),
  checks: mergeVideoChecks(prior.checks, retryState.videoChecks),
  screenEvidence: [],
  integrationReview: [],
};
const catalog = new Map();
for (const source of config.sources) {
  if (
    !/^UC[\w-]{22}$/.test(source.channelId) ||
    !/^[\w-]+$/.test(source.playlistId) ||
    source.playlistUrl !== `https://www.youtube.com/playlist?list=${source.playlistId}`
  )
    throw new Error('Invalid video verification source');
  let videos, status;
  try {
    videos = retryOnly
      ? (prior.sources?.find((item) => item.id === source.id)?.videos ?? [])
      : await fetchPlaylist(source);
    status = retryOnly ? 'cached-unchecked' : 'fresh';
  } catch {
    videos = prior.sources?.find((item) => item.id === source.id)?.videos ?? [];
    status = videos.length ? 'cached' : 'unavailable';
  }
  report.sources.push({ ...source, status, videos });
  for (const video of videos) catalog.set(video.id, { ...video, channelId: source.channelId });
}
for (const video of config.videos ?? []) {
  if (
    !/^[\w-]{11}$/.test(video.id) ||
    !/^UC[\w-]{22}$/.test(video.channelId) ||
    video.url !== `https://www.youtube.com/watch?v=${video.id}` ||
    !Array.isArray(video.files)
  )
    throw new Error('Invalid scoped video source');
  catalog.set(video.id, video);
}
const queue = [];
const descriptors = [],
  payloads = new Map();
for (const entry of entries)
  for (const chapter of entry.chapters) {
    if (!chapter.content) continue;
    const file = chapter.content.file;
    if (!/^content\/[\w-]+\.json$/.test(file)) throw new Error('Invalid video chapter');
    const payload = await read(root, 'public/' + file);
    payloads.set(file, payload);
    descriptors.push({
      file,
      category: entry.verificationCategory,
      title: chapter.title,
      arcLabel: entry.arcLabel,
      missionTitles: [
        ...new Set([
          ...(wiki.missionCatalog?.[file] ?? []).map((item) => item.title),
          ...payload.rows
            .filter((row) => ['matched', 'cached'].includes(row.bwikiStatus))
            .map((row) => row.bwikiMission)
            .filter(Boolean),
        ]),
      ],
    });
  }
const linked = linkVideos(descriptors, [...catalog.values()]);
report.linkReview = linked.review;
const files = new Set(['public/video-order-provenance.json', 'public/video-review-summary.json']);
const changed = new Map();
const validEvidenceCount = (payload, evidence) =>
  validatedCaptionMatches(payload.rows, evidence).length;
const missingResponses = (rows) =>
  rows.filter(
    (row) =>
      row.type === 'choice' &&
      !(['matched', 'cached'].includes(row.bwikiStatus) && row.bwikiNextIds?.length) &&
      !(row.flowStatus === 'verified' && row.nextIds?.length) &&
      !(row.videoStatus === 'screen-matched' && row.videoNextIds?.length),
  );
function updatePending(file) {
  const chapter = report.chapters[file],
    rows = payloads.get(file).rows;
  chapter.unresolvedRowIds = rows.filter(orderUnknown).map((row) => row.id);
  chapter.unresolvedChoiceResponseIds = missingResponses(rows).map((row) => row.id);
  chapter.pending =
    chapter.unresolvedRowIds.length > 0 ||
    chapter.unresolvedChoiceResponseIds.length > 0 ||
    chapter.unresolvedWikiSections > 0 ||
    rows.some((row) => row.source?.startsWith('ExcelOutput/MissionChapterConfig.json:'));
}
for (const entry of entries)
  for (const chapter of entry.chapters) {
    if (!chapter.content) continue;
    const file = chapter.content.file;
    if (!/^content\/[\w-]+\.json$/.test(file)) throw new Error('Invalid verification payload');
    const payload = payloads.get(file);
    let metadataChanged = false;
    for (const row of payload.rows)
      for (const key of VIDEO_FIELDS) {
        if (key in row) metadataChanged = true;
        delete row[key];
      }
    const videos = linked.matches[file];
    const unresolved = payload.rows.filter(
      (row) =>
        (row.flowStatus === 'review' || row.bwikiStatus === 'review') &&
        row.flowStatus !== 'verified' &&
        !['matched', 'cached'].includes(row.bwikiStatus ?? ''),
    );
    const importReview = wiki.imports?.[file]?.review ?? [];
    const pending =
      unresolved.length > 0 ||
      missingResponses(payload.rows).length > 0 ||
      importReview.length > 0 ||
      payload.rows.some((row) => row.source?.startsWith('ExcelOutput/MissionChapterConfig.json:'));
    report.chapters[file] = {
      title: chapter.title,
      category: entry.verificationCategory,
      videos: videos.map(({ id, title, url, linkMethod, matchedTitle }) => ({
        id,
        title,
        url,
        linkMethod,
        matchedTitle,
      })),
      unresolvedRowIds: unresolved.map((row) => row.id),
      unresolvedWikiSections: importReview.length,
      pending,
      status: pending
        ? 'pending-video-review'
        : payload.rows.some((row) => row.bwikiStatus || row.flowStatus)
          ? 'bwiki-matched'
          : 'reference-only',
      captionMatches: 0,
      screenMatches: 0,
      reorderedRows: 0,
      playlistUrl: config.sources[0]?.playlistUrl,
    };
    const relevant = [
      ...report.evidence,
      ...observations.evidence.filter(
        (item) => item.method === 'public-transcript-exact' && item.file === file,
      ),
    ];
    const cached = [
      ...new Map(
        relevant
          .filter((item) => item.file === file && videos.some((video) => video.id === item.videoId))
          .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt))
          .map((item) => [item.videoId, item]),
      ).values(),
    ].sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
    for (const evidence of cached) {
      const result = restoreVideoMissions(payload, evidence);
      metadataChanged ||= result.changed > 0 || result.confirmed > 0;
      report.chapters[file].captionMatches += validEvidenceCount(payload, evidence);
      report.chapters[file].reorderedRows += result.changed;
      report.chapters[file].status = result.confirmed
        ? 'partial-caption-order-matched'
        : result.conflicts.length
          ? 'caption-order-conflict'
          : 'pending-video-review';
      if (result.conflicts.length)
        report.integrationReview.push({
          file,
          videoId: evidence.videoId,
          reason: 'existing-order-conflict',
          missionIds: result.conflicts,
        });
      report.evidence = report.evidence.filter(
        (old) => old.file !== file || old.videoId !== evidence.videoId,
      );
      report.evidence.push(evidence);
    }
    for (const evidence of observations.evidence.filter(
      (item) =>
        item.method === 'reviewed-screen-path' &&
        item.file === file &&
        videos.some((video) => video.id === item.videoId),
    )) {
      const result = applyScreenEvidence(payload, evidence);
      if (result.reason)
        report.integrationReview.push({ file, videoId: evidence.videoId, reason: result.reason });
      else {
        metadataChanged = true;
        report.screenEvidence.push(evidence);
        report.chapters[file].screenMatches += result.observed;
        report.chapters[file].status = 'partial-screen-order-matched';
      }
    }
    if (metadataChanged) {
      await write('public/' + file, payload);
      files.add('public/' + file);
      changed.set(file, payload.rows);
    }
    if (pending)
      for (const video of videos)
        queue.push({
          file,
          video,
          payload,
          latest: chapter.upstreamChapterId === update.latestTrailblaze?.id,
        });
    updatePending(file);
  }
queue.sort(
  (a, b) =>
    Number(b.latest) - Number(a.latest) ||
    Date.parse(report.checks?.[a.video.id]?.checkedAt ?? '1970-01-01') -
      Date.parse(report.checks?.[b.video.id]?.checkedAt ?? '1970-01-01'),
);
const examined = new Set();
// Rotate through the backlog even when the newest chapter stays inaccessible.
for (const item of selectVideoChecks(
  queue.filter((item) => report.chapters[item.file].pending),
  report.checks,
  report.checkedAt,
)) {
  examined.add(item.video.id);
  let evidence;
  try {
    const captions = await fetchPublicCaptions(item.video, item.video.channelId);
    const matches = matchCaptions(item.payload.rows, captions.cues);
    evidence = {
      file: item.file,
      videoId: item.video.id,
      url: item.video.url,
      language: captions.language,
      kind: captions.kind,
      captionSha256: captions.sha256,
      checkedAt: report.checkedAt,
      matches,
      status: 'fresh-caption-match',
    };
    report.checks[item.video.id] = {
      checkedAt: report.checkedAt,
      status: matches.length >= 3 ? 'caption-matched' : 'insufficient-exact-matches',
    };
  } catch (error) {
    const old = report.evidence?.find(
      (value) => value.videoId === item.video.id && value.file === item.file,
    );
    evidence = old ? { ...old, status: 'cached-caption-match' } : undefined;
    report.checks[item.video.id] = {
      checkedAt: report.checkedAt,
      status: 'public-captions-unavailable',
      reason: error.message,
      failureKind: /Korean captions unavailable/.test(error.message)
        ? 'no-korean-captions'
        : /restricted/.test(error.message)
          ? 'access-restricted'
          : 'query-failed',
      failures: (report.checks[item.video.id]?.failures ?? 0) + 1,
      nextRetryAt: new Date(
        Date.parse(report.checkedAt) +
          Math.min(72, 24 * 2 ** Math.min(2, report.checks[item.video.id]?.failures ?? 0)) *
            3600000,
      ).toISOString(),
    };
  }
  if (evidence) {
    const result = restoreVideoMissions(item.payload, evidence);
    if (result.conflicts.length)
      report.integrationReview.push({
        file: item.file,
        videoId: evidence.videoId,
        reason: 'existing-order-conflict',
        missionIds: result.conflicts,
      });
    report.evidence = report.evidence.filter(
      (old) => old.file !== evidence.file || old.videoId !== evidence.videoId,
    );
    report.evidence.push(evidence);
    Object.assign(report.chapters[item.file], {
      captionMatches: validEvidenceCount(item.payload, evidence),
      reorderedRows: result.changed,
      status: result.conflicts.length
        ? 'caption-order-conflict'
        : result.confirmed
          ? 'partial-caption-order-matched'
          : 'pending-video-review',
    });
    if (result.changed || result.confirmed) {
      await write('public/' + item.file, item.payload);
      files.add('public/' + item.file);
      changed.set(item.file, item.payload.rows);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
retryState.videoChecks = report.checks;
await saveRetry(retryState, repository);
for (const [file, payload] of payloads) {
  updatePending(file);
  const chapter = report.chapters[file];
  chapter.captionMatches = new Set(
    report.evidence
      .filter(
        (item) => item.file === file && chapter.videos.some((video) => video.id === item.videoId),
      )
      .flatMap((item) => validatedCaptionMatches(payload.rows, item).map((match) => match.rowId)),
  ).size;
  chapter.screenMatches = new Set(
    report.screenEvidence
      .filter((item) => item.file === file)
      .flatMap((item) => item.matches.map((match) => match.rowId)),
  ).size;
  if (chapter.screenMatches) chapter.status = 'partial-screen-order-matched';
}
report.integrationReview = [
  ...new Map(report.integrationReview.map((item) => [JSON.stringify(item), item])).values(),
];
report.retry = {
  ...videoRetryDecision(report, Date.parse(report.checkedAt)),
  examined: examined.size,
  limit: 2,
};
if (changed.size) {
  const search = await read(root, 'public/content/search-index.json');
  const byId = new Map(search.rows.map((row) => [row.id, row]));
  for (const rows of changed.values()) {
    const ids = new Set(rows.map((row) => row.id));
    const slots = search.rows.flatMap((row, index) => (ids.has(row.id) ? [index] : []));
    if (slots.length !== rows.length) throw new Error('Video order lost a search identity');
    slots.forEach((slot, index) => {
      const row = rows[index];
      const value = byId.get(row.id);
      for (const key of VIDEO_FIELDS) {
        delete value[key];
        if (key in row) value[key] = row[key];
      }
      search.rows[slot] = value;
    });
  }
  await write('public/content/search-index.json', search);
  files.add('public/content/search-index.json');
}
await write('public/video-order-provenance.json', report);
await write('public/video-review-summary.json', {
  schema: 'hsr-video-review-summary.v1',
  commit: report.commit,
  checkedAt: report.checkedAt,
  chapters: Object.fromEntries(
    Object.entries(report.chapters).map(([file, chapter]) => [
      file,
      {
        videos: chapter.videos,
        captionMatches: chapter.captionMatches,
        screenMatches: chapter.screenMatches,
        status: chapter.status,
      },
    ]),
  ),
});
const receipt = await read(root, 'receipt.json');
receipt.files = [...new Set([...receipt.files, ...files])].sort();
await write('receipt.json', receipt);
console.log(
  `Video order: ${catalog.size} reference videos; ${examined.size} public-caption checks; ${changed.size} chapters reordered`,
);
