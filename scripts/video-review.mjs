import fs from 'node:fs/promises';
import path from 'node:path';
import { orderUnknown } from './verification-integration.mjs';
import { validatedCaptionMatches, VIDEO_FIELDS, videoRetryDecision } from './video-order.mjs';

export async function writeVideoJson(root, file, data) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target + '.tmp', JSON.stringify(data));
  await fs.rename(target + '.tmp', target);
}

export function videoChapterSummary(chapter, rows, evidence = [], screenEvidence = []) {
  const unresolvedRowIds = rows.filter(orderUnknown).map((row) => row.id);
  const unresolvedChoiceResponseIds = rows
    .filter(
      (row) =>
        row.type === 'choice' &&
        !(['matched', 'cached'].includes(row.bwikiStatus) && row.bwikiNextIds?.length) &&
        !(row.flowStatus === 'verified' && row.nextIds?.length) &&
        !(row.videoStatus === 'screen-matched' && row.videoNextIds?.length),
    )
    .map((row) => row.id);
  const pending =
    unresolvedRowIds.length > 0 ||
    unresolvedChoiceResponseIds.length > 0 ||
    chapter.unresolvedWikiSections > 0 ||
    rows.some((row) => row.source?.startsWith('ExcelOutput/MissionChapterConfig.json:'));
  const captionMatches = new Set(
    evidence
      .filter(
        (item) =>
          item.file === chapter.file && chapter.videos.some((video) => video.id === item.videoId),
      )
      .flatMap((item) => validatedCaptionMatches(rows, item).map((match) => match.rowId)),
  ).size;
  const screenMatches = new Set(
    screenEvidence
      .filter((item) => item.file === chapter.file)
      .flatMap((item) => item.matches.map((match) => match.rowId)),
  ).size;
  return {
    ...chapter,
    unresolvedRowIds,
    unresolvedChoiceResponseIds,
    pending,
    captionMatches,
    screenMatches,
    status: screenMatches
      ? 'partial-screen-order-matched'
      : (chapter.status ??
        (pending
          ? 'pending-video-review'
          : rows.some((row) => row.bwikiStatus || row.flowStatus)
            ? 'bwiki-matched'
            : 'reference-only')),
  };
}

export function finalizeVideoReport(report, payloads, examined) {
  for (const [file, payload] of payloads) {
    // File belongs to the report map key; keep its public chapter shape unchanged.
    const chapter = videoChapterSummary(
      { ...report.chapters[file], file },
      payload.rows,
      report.evidence,
      report.screenEvidence,
    );
    delete chapter.file;
    report.chapters[file] = chapter;
  }
  report.integrationReview = [
    ...new Map(report.integrationReview.map((item) => [JSON.stringify(item), item])).values(),
  ];
  report.retry = {
    ...videoRetryDecision(report, Date.parse(report.checkedAt)),
    examined,
    limit: 2,
  };
}

export async function saveVideoReview(root, report, changed) {
  const write = (file, data) => writeVideoJson(root, file, data);
  const read = async (file) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  const files = new Set([
    'public/video-order-provenance.json',
    'public/video-review-summary.json',
    ...[...changed.keys()].map((file) => 'public/' + file),
  ]);
  if (changed.size) {
    const search = await read('public/content/search-index.json');
    const byId = new Map(search.rows.map((row) => [row.id, row]));
    for (const rows of changed.values()) {
      const ids = new Set(rows.map((row) => row.id));
      const slots = search.rows.flatMap((row, index) => (ids.has(row.id) ? [index] : []));
      if (slots.length !== rows.length) throw new Error('Video order lost a search identity');
      slots.forEach((slot, index) => {
        const row = rows[index],
          value = byId.get(row.id);
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
  const receipt = await read('receipt.json');
  receipt.files = [...new Set([...receipt.files, ...files])].sort();
  await write('receipt.json', receipt);
}
