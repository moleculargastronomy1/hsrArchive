import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchPlaylist,
  fetchPublicCaptions,
  matchCaptions,
  normalizedKorean,
  restoreVideoOrder,
  selectVideoChecks,
  sha256,
} from './video-order.mjs';

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
const entries = await read(root, 'src/data/trailblaze.json');
const config = await read(repository, 'editorial/video-verification-sources.json');
const prior = await read(previousRoot, 'public/video-order-provenance.json').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return {};
});
if (config.schema !== 'hsr-video-sources.v1' || wiki.commit !== update.commit)
  throw new Error('Mixed video verification inputs');
const report = {
  schema: 'hsr-video-order-audit.v1',
  commit: update.commit,
  checkedAt: new Date().toISOString(),
  policy:
    'BWIKI is primary. Public Korean caption matches are supporting evidence, not full gameplay/branch verification. Missing captions and conflicts remain pending. No access restriction bypass or video downloads.',
  sources: [],
  chapters: {},
  evidence: (prior.evidence ?? []).map((item) => ({ ...item, status: 'cached-caption-match' })),
  checks: { ...prior.checks },
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
    videos = await fetchPlaylist(source);
    status = 'fresh';
  } catch {
    videos = prior.sources?.find((item) => item.id === source.id)?.videos ?? [];
    status = videos.length ? 'cached' : 'unavailable';
  }
  report.sources.push({ ...source, status, videos });
  for (const video of videos) catalog.set(video.id, { ...video, channelId: source.channelId });
}
const queue = [];
const files = new Set(['public/video-order-provenance.json', 'public/video-review-summary.json']);
const changed = new Map();
const validEvidenceCount = (payload, evidence) =>
  evidence.matches.filter((match) => {
    const row = payload.rows.find((row) => row.id === match.rowId);
    return (
      row &&
      sha256(row.text) === match.koreanHash &&
      payload.rows.filter((other) => normalizedKorean(other.text) === normalizedKorean(row.text))
        .length === 1
    );
  }).length;
for (const entry of entries)
  for (const chapter of entry.chapters) {
    if (!chapter.content) continue;
    const file = chapter.content.file;
    if (!/^content\/[\w-]+\.json$/.test(file)) throw new Error('Invalid verification payload');
    const payload = await read(root, 'public/' + file);
    let metadataChanged = false;
    for (const row of payload.rows)
      for (const key of ['videoStatus', 'videoId', 'videoStartMs']) {
        if (key in row) metadataChanged = true;
        delete row[key];
      }
    const title = normalizedKorean(
      chapter.title.replace(/^(?:제\d+막|개척 후문|종말 임무|모험 임무):\s*/, ''),
    );
    const videos = [...catalog.values()].filter(
      (video) => title.length >= 5 && normalizedKorean(video.title).includes(title),
    );
    const unresolved = payload.rows.filter(
      (row) =>
        row.flowStatus === 'review' && !['matched', 'cached'].includes(row.bwikiStatus ?? ''),
    );
    const importReview = wiki.imports?.[file]?.review ?? [];
    const pending = unresolved.length > 0 || importReview.length > 0 || payload.rows.length <= 1;
    report.chapters[file] = {
      title: chapter.title,
      videos: videos.map(({ id, title, url }) => ({ id, title, url })),
      unresolvedRowIds: unresolved.map((row) => row.id),
      unresolvedWikiSections: importReview.length,
      status: pending ? 'pending-video-review' : 'bwiki-matched',
      captionMatches: 0,
      reorderedRows: 0,
      playlistUrl: config.sources[0]?.playlistUrl,
    };
    const cached = report.evidence
      .filter((item) => item.file === file && videos.some((video) => video.id === item.videoId))
      .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
    if (cached) {
      const result = restoreVideoOrder(payload, cached);
      metadataChanged ||= result.changed > 0 || result.confirmed > 0;
      report.chapters[file].captionMatches = validEvidenceCount(payload, cached);
      report.chapters[file].reorderedRows = result.changed;
      report.chapters[file].status = result.conflict
        ? 'caption-order-conflict'
        : 'pending-video-review';
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
  }
queue.sort(
  (a, b) =>
    Number(b.latest) - Number(a.latest) ||
    Date.parse(prior.checks?.[a.video.id]?.checkedAt ?? '1970-01-01') -
      Date.parse(prior.checks?.[b.video.id]?.checkedAt ?? '1970-01-01'),
);
const examined = new Set();
// Rotate through the backlog even when the newest chapter stays inaccessible.
for (const item of selectVideoChecks(queue, prior.checks, report.checkedAt)) {
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
  } catch {
    const old = prior.evidence?.find(
      (value) => value.videoId === item.video.id && value.file === item.file,
    );
    evidence = old ? { ...old, status: 'cached-caption-match' } : undefined;
    report.checks[item.video.id] = {
      checkedAt: report.checkedAt,
      status: 'public-captions-unavailable',
    };
  }
  if (evidence) {
    const result = restoreVideoOrder(item.payload, evidence);
    report.evidence = report.evidence.filter(
      (old) => old.file !== evidence.file || old.videoId !== evidence.videoId,
    );
    report.evidence.push(evidence);
    Object.assign(report.chapters[item.file], {
      captionMatches: validEvidenceCount(item.payload, evidence),
      reorderedRows: result.changed,
      status: result.conflict
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
      for (const key of ['videoStatus', 'videoId', 'videoStartMs']) {
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
      { videos: chapter.videos, captionMatches: chapter.captionMatches, status: chapter.status },
    ]),
  ),
});
const receipt = await read(root, 'receipt.json');
receipt.files = [...new Set([...receipt.files, ...files])].sort();
await write('receipt.json', receipt);
console.log(
  `Video order: ${catalog.size} reference videos; ${examined.size} public-caption checks; ${changed.size} chapters reordered`,
);
