import path from 'node:path';
import fs from 'node:fs/promises';
import { orderUnknown } from './verification-integration.mjs';

// Reprocessing a document is only useful for its unresolved material. Completed
// files retain their existing Korean rows, graph fields and verification records.
export async function limitBwikiToPending(root, stage, request, rows) {
  const report = JSON.parse(await fs.readFile(path.join(root, 'public/bwiki-provenance.json')));
  const pending = new Set();
  const missions = new Set();
  for (const row of rows.values())
    if (
      orderUnknown(row) ||
      row.source?.startsWith('ExcelOutput/MissionChapterConfig.json:') ||
      (row.type === 'choice' &&
        !row.bwikiNextIds?.length &&
        !row.nextIds?.length &&
        !row.videoNextIds?.length)
    )
      pending.add(row.file);
  for (const [file, item] of Object.entries(report.imports ?? {}))
    if (item.review?.length) pending.add(file);
  for (const row of rows.values())
    if (pending.has(row.file)) {
      missions.add(row.missionId);
      missions.add(row.bwikiMissionId);
    }
  for (const [file, members] of Object.entries(report.missionCatalog ?? {}))
    if (pending.has(file)) for (const item of members) missions.add('quest-' + item.id);
  const discovery = JSON.parse(await fs.readFile(path.join(stage, '.cache/bwiki/chapters.json')));
  const chapterPages = new Set(
    discovery.chapters
      .filter((item) => pending.has(item.file))
      .flatMap((item) => item.groups.map((group) => group.title)),
  );
  request.requests = request.requests.filter((page) => {
    const events = (page.eventFiles ?? []).filter(
      (file) => !report.events?.[file] || report.events[file].remaining > 0,
    );
    events.forEach((file) => pending.add(file));
    return (
      events.length ||
      chapterPages.has(page.title) ||
      (page.missionIds ?? [page.missionId]).some((id) => missions.has('quest-' + id))
    );
  });
  return pending;
}

// Discovery and alignment share one order in full updates and targeted retries.
// Collection/backoff remains the caller's policy; this module never reads video data.
export function discoverBwiki(run, stage, raw, planFile) {
  for (const script of [
    'bwiki-dialogue.py',
    'import-bwiki-chapters.py',
    'import-simulation-events.py',
  ])
    run(script, [stage, raw, planFile, '--discover']);
}

export function alignBwiki(run, stage, raw, planFile, previousRoot) {
  for (const script of [
    'bwiki-dialogue.py',
    'import-bwiki-chapters.py',
    'import-simulation-events.py',
  ])
    run(script, [
      stage,
      raw,
      planFile,
      path.join(stage, '.cache/bwiki/manifest.json'),
      previousRoot,
    ]);
}
