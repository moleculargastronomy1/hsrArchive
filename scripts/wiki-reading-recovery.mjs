import fs from 'node:fs/promises';
import path from 'node:path';
import { orderUnknown } from './verification-integration.mjs';

// An unavailable document is not evidence that its published positions vanished.
// Retain that exact pinned document, never merge different revisions into a scene.
// A regression in a document that WAS audited remains a publication error.
export function retainUnavailablePositions(
  previous,
  candidate,
  rows,
  beforeRows,
  unavailablePages,
) {
  if (!previous || !candidate || previous.commit !== candidate.commit) return [];
  const available = new Set(candidate.sources.map((source) => source.pageTitle));
  const missing = [...new Set(previous.occurrences.map((p) => p.page))].filter(
    (page) =>
      !available.has(page) &&
      previous.sources.some(
        (source) =>
          source.pageTitle === page &&
          (unavailablePages?.has(page) || unavailablePages?.has(source.title)),
      ),
  );
  if (!missing.length) return [];
  const priorById = new Map(beforeRows.map((row) => [row.id, row]));
  const currentById = new Map(rows.map((row) => [row.id, row]));
  const core = ['id', 'talkId', 'textHash', 'text', 'speaker', 'type', 'missionId', 'source'];
  const retained = [];
  for (const page of missing) {
    const positions = previous.occurrences.filter((p) => p.page === page);
    if (
      positions.some(
        (p) =>
          !currentById.has(p.rowId) ||
          core.some(
            (key) =>
              JSON.stringify(priorById.get(p.rowId)?.[key]) !==
              JSON.stringify(currentById.get(p.rowId)[key]),
          ),
      )
    )
      throw Error('Unavailable BWIKI document has changed canonical content: ' + page);
    // No new claim is made about this page or today's BWIKI revision.
    candidate.occurrences.push(...structuredClone(positions));
    const sources = previous.sources.filter((source) => source.pageTitle === page);
    candidate.sources.push(...structuredClone(sources));
    for (const mission of previous.missions.filter((m) => m.page === page)) {
      if (candidate.missions.some((m) => m.id === mission.id)) continue;
      const oldIndex = previous.missions.findIndex((m) => m.id === mission.id);
      const next = previous.missions
        .slice(oldIndex + 1)
        .find((m) => candidate.missions.some((n) => n.id === m.id));
      const slot = next
        ? candidate.missions.findIndex((m) => m.id === next.id)
        : candidate.missions.length;
      candidate.missions.splice(slot, 0, structuredClone(mission));
    }
    retained.push({
      page,
      reason: 'document-unavailable; previous-pinned-positions-retained',
      occurrences: positions.length,
      sources: structuredClone(sources),
      priorValidation: Object.fromEntries(
        [
          'commit',
          'codeHash',
          'policyHash',
          'policyVersion',
          'officialInputs',
          'structureHashes',
          'reviewRegistryHash',
        ].map((key) => [key, previous[key]]),
      ),
    });
  }
  const order = new Map(candidate.missions.map((m, i) => [m.id, i]));
  candidate.occurrences.sort((a, b) => order.get(a.missionId) - order.get(b.missionId));
  const placed = new Set(candidate.occurrences.map((p) => p.rowId));
  candidate.unplaced = candidate.unplaced
    .map((g) => ({ ...g, rowIds: g.rowIds.filter((id) => !placed.has(id)) }))
    .filter((g) => g.rowIds.length);
  const unknown = new Set(beforeRows.filter(orderUnknown).map((row) => row.id));
  const nodes = new Map(candidate.occurrences.map((p) => [p.id, p]));
  const oldLinks = new Set(
    beforeRows.flatMap((row) => (row.bwikiNextIds ?? []).map((id) => JSON.stringify([row.id, id]))),
  );
  const newReplies = new Set(
    candidate.occurrences
      .filter((p) => currentById.get(p.rowId).type === 'choice')
      .flatMap((p) =>
        p.nextIds
          .map((id) => nodes.get(id))
          .filter((q) => q && currentById.get(q.rowId).type !== 'choice')
          .map((q) => JSON.stringify([p.rowId, q.rowId]))
          .filter((pair) => !oldLinks.has(pair)),
      ),
  );
  Object.assign(candidate.summary, {
    placedRows: placed.size,
    occurrences: candidate.occurrences.length,
    repeatedOccurrences: candidate.occurrences.length - placed.size,
    unplacedRows: rows.length - placed.size,
    previousOrderUnknown: unknown.size,
    newlyPlacedRows: [...unknown].filter((id) => placed.has(id)).length,
    remainingPreviousUnknown: [...unknown].filter((id) => !placed.has(id)).length,
    newChoiceReplyLinks: newReplies.size,
  });
  candidate.retainedSources = [...(candidate.retainedSources ?? []), ...retained];
  return retained;
}

export async function retainUnavailableWikiPositions(stage, before, sourceManifest) {
  const unavailable = new Set(
    (sourceManifest?.pages ?? [])
      .filter((p) => p.status !== 'available')
      .flatMap((p) => [p.title, p.pageTitle])
      .filter(Boolean),
  );
  const retained = [];
  const reportPath = path.join(stage, 'public/source-first-provenance.json');
  let report;
  for (const [file, previous] of Object.entries(before.wikiReadings ?? {})) {
    const target = path.join(stage, 'public', file);
    const payload = JSON.parse(await fs.readFile(target));
    const beforeRows = [...before.values()].filter((row) => row.file === file);
    const records = retainUnavailablePositions(
      previous,
      payload.wikiReading,
      payload.rows,
      beforeRows,
      unavailable,
    );
    if (!records.length) continue;
    await fs.writeFile(target, JSON.stringify(payload));
    report ??= JSON.parse(await fs.readFile(reportPath));
    if (report.chapters[file]) {
      report.chapters[file].reading = payload.wikiReading.summary;
      report.chapters[file].retainedReadingSources = records;
    }
    retained.push({ file, documents: records });
  }
  if (report) await fs.writeFile(reportPath, JSON.stringify(report));
  return retained;
}
