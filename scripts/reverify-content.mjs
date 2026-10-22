import { publishContentStage } from './content-publication.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pythonRunner } from './content-process.mjs';
import {
  discoverBwiki,
  alignBwiki,
  limitBwikiToPending,
  trailblazeTitleFiles,
  scopeBwikiRequests,
} from './bwiki-verification.mjs';
import {
  verificationRows,
  compareVerification,
  assertVerificationPreserved,
  orderUnknown,
} from './verification-integration.mjs';
import { fetchBwiki } from './fetch-bwiki.mjs';
import { stateFiles, hash } from './verification-state.mjs';
import {
  algorithmHash,
  readRetry,
  saveRetry,
  REVIEW_INTERVAL,
  prioritizeBwikiRequests,
} from './verification-retry.mjs';
import { prepareSimulationEvents } from './simulation-events.mjs';
import { collectEventImages } from './event-images.mjs';
import { verifySourceFirst } from './source-first.mjs';

const read = async (file) => JSON.parse(await fs.readFile(file));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data));

// A new BWIKI interpretation is a candidate, not permission to replace a
// published branch. Quarantine the complete chapter so revisions, reciprocal
// links, wiki positions and execution placements cannot become a mixed graph.
export async function quarantineRetryChapters(root, stage, before, manifest) {
  const after = await verificationRows(stage);
  const comparison = compareVerification(before, after);
  const work = path.join(root, '.cache/verification-retry/quarantine');
  await fs.mkdir(work, { recursive: true });
  await write(path.join(work, 'comparison.json'), comparison);
  const candidateFaults = [
    'lostVerification',
    'conflictingLinks',
    'conflictingOrder',
    'lostReadingPositions',
    'lostReadingLinks',
    'conflictingReadingPositions',
  ];
  // Canonical, official execution, video, routing and image failures still stop
  // publication. Do not turn a shared validator failure into a successful retry.
  assertVerificationPreserved(
    { ...comparison, ...Object.fromEntries(candidateFaults.map((key) => [key, []])) },
    'Retry shared contracts',
  );
  for (const [id, row] of before) {
    const current = after.get(id);
    for (const [status, keys] of [
      [row.flowStatus === 'verified', ['nextIds', 'replyToIds']],
      [
        ['caption-matched', 'screen-matched'].includes(row.videoStatus),
        ['videoNextIds', 'videoReplyToIds'],
      ],
    ])
      if (
        status &&
        keys.some((key) => (row[key] ?? []).some((target) => !current?.[key]?.includes(target)))
      )
        throw Error('Retry changed a verified official/video edge: ' + id);
  }
  for (const [file, reading] of Object.entries(before.executionReadings ?? {})) {
    const nodes = new Map(
      (after.executionReadings?.[file]?.occurrences ?? []).map((p) => [p.id, p]),
    );
    for (const p of reading.occurrences) {
      const q = nodes.get(p.id);
      if (
        !q ||
        ['rowId', 'missionId', 'source', 'pointer', 'conditionsHash', 'sceneId', 'conditions'].some(
          (key) => JSON.stringify(p[key]) !== JSON.stringify(q[key]),
        ) ||
        p.nextIds.some((id) => !q.nextIds.includes(id))
      )
        throw Error('Retry changed a confirmed execution occurrence: ' + file + ':' + p.id);
    }
  }
  const files = new Set();
  for (const key of candidateFaults)
    for (const id of comparison[key]) {
      const file = before.get(id)?.file ?? after.get(id)?.file ?? id.split(':')[0];
      if (!/^content\/[\w-]+\.json$/.test(file)) throw Error('Unscoped retry regression: ' + id);
      files.add(file);
    }
  if (!files.size) return [];
  const update = await read(path.join(root, 'public/content-update.json'));
  if (update.commit !== (await read(path.join(stage, 'public/content-update.json'))).commit)
    throw Error('Retry quarantine requires the same official input version');
  const restored = new Map(),
    records = [];
  const proofFiles = [
    'bwiki-provenance',
    'source-first-provenance',
    'dialogue-flow-provenance',
    'video-order-provenance',
    'video-review-summary',
  ];
  const proofs = await Promise.all(
    proofFiles.map(async (name) => ({
      name,
      old: await read(path.join(root, 'public/' + name + '.json')),
      candidate: await read(path.join(stage, 'public/' + name + '.json')),
    })),
  );
  // Preflight all files before restoring any. New canonical rows in a rejected
  // chapter need a separate admission review, not an implicit metadata rollback.
  for (const file of files) {
    const original = await read(path.join(root, 'public', file));
    const candidate = await read(path.join(stage, 'public', file));
    const ids = new Set(original.rows.map((r) => r.id));
    if (candidate.rows.length !== ids.size || candidate.rows.some((r) => !ids.has(r.id)))
      throw Error('Retry regression also changes chapter admissions: ' + file);
    restored.set(file, { original, candidate });
  }
  for (const [file, { original, candidate }] of restored) {
    const evidence = path.join(work, hash(JSON.stringify(candidate)), path.basename(file));
    await fs.mkdir(path.dirname(evidence), { recursive: true });
    await write(evidence, {
      candidate,
      provenance: Object.fromEntries(
        proofs.map(({ name, candidate: p }) => [
          name,
          p.chapters?.[file] ?? p.executionAudit?.chapters?.find((c) => c.file === file),
        ]),
      ),
    });
    const pages = [
      ...new Set([
        ...(original.wikiReading?.sources ?? []).map((s) => s.pageTitle),
        ...original.rows.map((r) => r.bwikiPage).filter(Boolean),
      ]),
    ];
    records.push({
      file,
      pages,
      reason: 'candidate-regression; published-chapter-retained',
      evidence: path.relative(root, evidence).split(path.sep).join('/'),
      failures: Object.fromEntries(
        candidateFaults.map((key) => [
          key,
          comparison[key].filter(
            (id) => (before.get(id)?.file ?? after.get(id)?.file ?? id.split(':')[0]) === file,
          ),
        ]),
      ),
    });
    await fs.copyFile(path.join(root, 'public', file), path.join(stage, 'public', file));
    for (const { name, old, candidate: report } of proofs) {
      for (const key of ['chapters', 'imports', 'missionCatalog', 'missionOrder']) {
        if (!report[key] || Array.isArray(report[key])) continue;
        if (old[key]?.[file] !== undefined) report[key][file] = structuredClone(old[key][file]);
        else delete report[key][file];
      }
      if (report.executionAudit?.chapters) {
        report.executionAudit.chapters = report.executionAudit.chapters.filter(
          (c) => c.file !== file,
        );
        const prior = old.executionAudit?.chapters?.find((c) => c.file === file);
        if (prior) report.executionAudit.chapters.push(structuredClone(prior));
      }
      for (const key of ['evidence', 'screenEvidence'])
        if (Array.isArray(report[key]))
          report[key] = [
            ...report[key].filter((item) => item.file !== file),
            ...(old[key] ?? []).filter((item) => item.file === file),
          ];
      if (name === 'bwiki-provenance')
        for (const key of Object.keys(report.totals))
          report.totals[key] += (original.bwiki?.[key] ?? 0) - (candidate.bwiki?.[key] ?? 0);
      report.retainedChapters = {
        ...report.retainedChapters,
        [file]: {
          reason: records.at(-1).reason,
          priorCommit: old.commit,
          priorCodeHash: old.codeHash ?? old.executionAudit?.codeHash,
          priorPolicyHash: old.policyHash ?? old.executionAudit?.policyHash,
        },
      };
    }
  }
  for (const { name, candidate } of proofs)
    await write(path.join(stage, 'public/' + name + '.json'), candidate);
  const oldSearch = await read(path.join(root, 'public/content/search-index.json'));
  const search = await read(path.join(stage, 'public/content/search-index.json'));
  for (const { original } of restored.values()) {
    const ids = new Set(original.rows.map((r) => r.id));
    const rows = oldSearch.rows.filter((r) => ids.has(r.id));
    const slots = search.rows.flatMap((r, i) => (ids.has(r.id) ? [i] : []));
    if (rows.length !== ids.size || slots.length !== rows.length)
      throw Error('Retry quarantine search identity mismatch');
    slots.forEach((slot, i) => {
      search.rows[slot] = rows[i];
    });
  }
  await write(path.join(stage, 'public/content/search-index.json'), search);
  const receipt = await read(path.join(stage, 'receipt.json'));
  receipt.files = [
    ...new Set([
      ...receipt.files,
      ...proofFiles.map((n) => 'public/' + n + '.json'),
      'public/content/search-index.json',
      ...[...files].map((f) => 'public/' + f),
    ]),
  ];
  await write(path.join(stage, 'receipt.json'), receipt);
  manifest.quarantinedChapters = records;
  await write(path.join(work, 'latest.json'), {
    schema: 'hsr-retry-quarantine.v1',
    commit: update.commit,
    checkedAt: new Date().toISOString(),
    records,
  });
  assertVerificationPreserved(
    compareVerification(before, await verificationRows(stage)),
    'Retry after quarantine',
  );
  return records;
}
export async function finishVerification(
  root,
  before,
  manifest,
  state,
  algorithm,
  mode,
  reviewRoot = root,
) {
  const after = await verificationRows(root);
  const comparison = compareVerification(before, after);
  const newlyVideoVerified = [...after.values()]
    .filter(
      (row) =>
        ['caption-matched', 'screen-matched'].includes(row.videoStatus) &&
        !['caption-matched', 'screen-matched'].includes(before.get(row.id)?.videoStatus),
    )
    .map((row) => row.id);
  const video = await read(path.join(reviewRoot, 'public/video-order-provenance.json')).catch(
    () => ({}),
  );
  const latestRetry = await readRetry(root);
  state.videoChecks = latestRetry.videoChecks ?? state.videoChecks;
  state.videoAlgorithm = latestRetry.videoAlgorithm ?? state.videoAlgorithm;
  const quarantinedPages = new Set(
    (manifest.quarantinedChapters ?? []).flatMap((item) => item.pages),
  );
  for (const page of manifest.pages)
    if (
      !quarantinedPages.has(page.pageTitle ?? page.title) &&
      page.status === 'available' &&
      page.alignmentKey &&
      page.needsAlignment
    ) {
      const previous = state.pages[page.title];
      state.pages[page.title] = {
        ...previous,
        aligned: `${manifest.commit}:${algorithm}:${page.revision}`,
        revision: page.revision,
        lastSuccess: page.collectedAt,
        ...(page.retrieval === 'cache-pinned' && previous?.reason
          ? {
              reason: previous.reason,
              failures: previous.failures,
              nextRetryAt: previous.nextRetryAt,
            }
          : {}),
      };
    }
  if (
    !manifest.scoped &&
    !(manifest.targetSources?.length === 1 && manifest.targetSources[0] === 'youtube')
  )
    state.algorithm = algorithm;
  const report = await read(path.join(root, 'public/bwiki-provenance.json'));
  const unresolvedMissions = new Set(
    [...after.values()]
      .filter((row) => orderUnknown(row) || (row.type === 'choice' && !row.bwikiNextIds?.length))
      .flatMap((row) => [row.missionId, row.bwikiMissionId]),
  );
  for (const page of manifest.pages) {
    if (quarantinedPages.has(page.pageTitle ?? page.title)) {
      state.pages[page.title] = {
        ...state.pages[page.title],
        unresolved: true,
        reason: 'verification-regression; candidate-quarantined',
        lastReviewedAt: manifest.checkedAt,
        nextRetryAt: new Date(Date.parse(manifest.checkedAt) + REVIEW_INTERVAL).toISOString(),
      };
      continue;
    }
    const unresolved =
      (page.eventFiles ?? []).some((file) => report.events?.[file]?.remaining > 0) ||
      (page.missionIds ?? [page.missionId]).some((id) => unresolvedMissions.has('quest-' + id));
    if (page.status === 'available' && page.needsAlignment && unresolved) {
      const item = state.pages[page.title] ?? {};
      state.pages[page.title] = {
        ...item,
        unresolved: true,
        lastReviewedAt: manifest.checkedAt,
        nextRetryAt: new Date(
          Math.max(
            Date.parse(item.nextRetryAt ?? '') || 0,
            Date.parse(manifest.checkedAt) + REVIEW_INTERVAL,
          ),
        ).toISOString(),
      };
    } else if (
      page.status === 'available' &&
      page.needsAlignment &&
      !unresolved &&
      page.retrieval !== 'cache-pinned'
    ) {
      const item = state.pages[page.title];
      delete item.unresolved;
      delete item.reason;
      delete item.failures;
      delete item.nextRetryAt;
    }
  }
  const reasons = {};
  for (const page of manifest.pages)
    if (page.status !== 'available')
      reasons[page.reason ?? page.status] = (reasons[page.reason ?? page.status] ?? 0) + 1;
  const matchingReasons = {};
  for (const item of [
    ...report.review,
    ...Object.values(report.imports ?? {}).flatMap((item) => item.review ?? []),
  ])
    matchingReasons[item.reason ?? '미확인 연결'] =
      (matchingReasons[item.reason ?? '미확인 연결'] ?? 0) + 1;
  const events = await read(
    path.join(reviewRoot, 'public/simulation-events-provenance.json'),
  ).catch(() => undefined);
  const eventRecords = Object.values(events?.records ?? {});
  const result = {
    schema: 'hsr-verification-run.v1',
    checkedAt: new Date().toISOString(),
    mode,
    status: manifest.quarantinedChapters?.length ? 'partial' : 'passed',
    quarantinedChapters: manifest.quarantinedChapters ?? [],
    algorithm: state.algorithm,
    videoAlgorithm: state.videoAlgorithm,
    upstreamCommit: manifest.commit,
    digest: comparison.digest,
    newlyVerified: comparison.newlyVerified.length,
    newlyVerifiedRowIds: comparison.newlyVerified,
    newlyVideoVerified: newlyVideoVerified.length,
    newlyVideoVerifiedRowIds: newlyVideoVerified,
    videoReview: {
      examined: video.retry?.examined ?? 0,
      limit: video.retry?.limit ?? 2,
      remainingDue: video.retry?.due?.length ?? 0,
      conflicts: video.integrationReview?.length ?? 0,
      checks: video.checks ?? {},
    },
    remainingUnknown: comparison.remainingUnknown.length,
    lostVerification: comparison.lostVerification.length,
    removedRows: comparison.removedRows.length,
    changedCoreRows: comparison.changedCoreRows.length,
    lostFlowVerification: comparison.lostFlowVerification.length,
    lostVideoVerification: comparison.lostVideoVerification.length,
    conflictingLinks: comparison.conflictingLinks.length,
    conflictingOrder: comparison.conflictingOrder.length,
    changed: comparison.changed,
    collectionFailures: reasons,
    matchingReviewRecords: matchingReasons,
    eventReview: {
      records: eventRecords.length,
      rows: eventRecords.reduce((sum, item) => sum + item.rows, 0),
      pendingRecords: eventRecords.filter((item) => item.status === 'pending').length,
      partialRecords: eventRecords.filter((item) => item.status === 'partial').length,
      linkedImages: eventRecords.filter((item) => item.imageStatus === 'linked').length,
      deferredDocuments: manifest.pages.filter((item) => item.alignmentDeferred).length,
    },
    targetFiles: manifest.targetFiles ?? 'all',
    bodyDownloads: manifest.pages.filter((item) => item.retrieval === 'download').length,
    cachedDocuments: manifest.pages.filter((item) =>
      ['revision-cache', 'cache-pinned'].includes(item.retrieval),
    ).length,
    scope:
      'Exact official ID/hash matches only. Unknown rows and whole-playthrough coverage are not marked complete.',
  };
  state.lastRun = result;
  // Full runs publish source changes even when dialogue bytes are unchanged.
  // Record their current digest so a successful deployment acknowledges it too.
  if (mode !== 'retry' || comparison.changed) state.pendingDigest = comparison.digest;
  await saveRetry(state, root);
  await fs.mkdir(path.join(root, '.cache/verification-retry/runs'), { recursive: true });
  await write(path.join(root, '.cache/verification-retry/run.json'), result);
  await write(
    path.join(
      root,
      '.cache/verification-retry/runs',
      result.checkedAt.replace(/[:.]/g, '-') + '.json',
    ),
    result,
  );
  await write(path.join(root, 'public/verification-progress.json'), {
    ...result,
    retry: {
      pages: state.pages,
      nextRequestAt: state.nextRequestAt,
      requestFailures: state.requestFailures,
      lastRequestError: state.lastRequestError,
    },
  });
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `publish=${mode !== 'retry' || comparison.changed}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### 미검증 대사 재검증\n\n- 새 BWIKI 확인: ${result.newlyVerified}행\n- 새 영상 확인: ${result.newlyVideoVerified}행\n- 유튜브 조회: ${result.videoReview.examined}/${result.videoReview.limit}개, 남은 기한 도래 영상 ${result.videoReview.remainingDue}개\n- 순서 미확인: ${result.remainingUnknown}행\n- 기존 BWIKI 근거 상실: ${result.lostVerification}행\n- 본문 다운로드/캐시 재사용: ${result.bodyDownloads}/${result.cachedDocuments}문서\n- 수집 실패: ${JSON.stringify(reasons)}\n- 미확인 사유(검토 기록 수): ${JSON.stringify(matchingReasons)}\n- 자료 변경: ${result.changed}; 전체 플레이 검증 완료를 의미하지 않습니다.\n`,
    );
  console.log(
    `Verification: +${result.newlyVerified} BWIKI rows; ${result.remainingUnknown} unknown; changed=${result.changed}`,
  );
  return result;
}

export async function retryContent(root, stage, raw, planFile, api, blobs, { title } = {}) {
  const state = await readRetry(root),
    algorithm = await algorithmHash(root),
    before = await verificationRows(root);
  const run = pythonRunner(root, stage);
  const scopedFiles = title
    ? trailblazeTitleFiles(await read(path.join(root, 'src/data/trailblaze.json')), title)
    : undefined;
  // No books, nomenclature, execution graph or translated-text projection on a
  // retry: start with the last successfully published derived files.
  for (const file of [...(await stateFiles(root)), 'src/data/text-bindings.json']) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(stage, file));
  }
  await fs.mkdir(path.join(stage, '.cache'), { recursive: true });
  await write(path.join(stage, 'receipt.json'), { files: [], rows: before.size });
  const watch = await read(path.join(root, '.cache/content-watch/check.json')).catch(() => ({}));
  if (!scopedFiles && watch.retryBwiki === false) {
    const previous = await read(path.join(root, 'public/bwiki-provenance.json'));
    const manifest = {
      schema: 'hsr-bwiki-input.v1',
      commit: previous.commit,
      checkedAt: new Date().toISOString(),
      license: previous.license,
      pages: [],
      review: [],
      observations: [],
      targetFiles: [],
      targetSources: ['youtube'],
    };
    await fs.mkdir(path.join(stage, '.cache/bwiki'), { recursive: true });
    await write(path.join(stage, '.cache/bwiki/manifest.json'), manifest);
    if (watch.retryVideo)
      execFileSync(
        process.execPath,
        [path.join(root, 'scripts/verify-video-order.mjs'), stage, root, '--retry'],
        { cwd: root, stdio: 'inherit' },
      );
    return publishRetryStage(root, stage, raw, planFile, before, manifest, state, algorithm);
  }
  if (scopedFiles) {
    for (const script of ['bwiki-dialogue.py', 'import-bwiki-chapters.py'])
      run(script, [stage, raw, planFile, '--discover']);
  } else {
    await prepareSimulationEvents(stage, raw, planFile, api, blobs, run);
    discoverBwiki(run, stage, raw, planFile);
  }
  const previous = await read(path.join(root, 'public/bwiki-provenance.json'));
  const requestFile = path.join(stage, '.cache/bwiki/request.json'),
    request = await read(requestFile);
  const pendingFiles = scopedFiles ?? (await limitBwikiToPending(root, stage, request, before));
  if (scopedFiles)
    scopeBwikiRequests(
      request,
      scopedFiles,
      before,
      previous,
      await read(path.join(stage, '.cache/bwiki/chapters.json')),
    );
  const waiting = new Map();
  for (const row of before.values())
    if (orderUnknown(row))
      for (const mission of new Set([row.missionId, row.bwikiMissionId]))
        waiting.set(mission, (waiting.get(mission) ?? 0) + 1);
  prioritizeBwikiRequests(request.requests, state, waiting);
  await write(requestFile, request);
  const forceAlignment = Boolean(
    scopedFiles ||
      (state.pendingDigest && state.pendingDigest !== compareVerification(before, before).digest),
  );
  const manifest = await fetchBwiki(
    stage,
    path.join(root, '.cache/upstream-content/bwiki'),
    fetch,
    {
      state,
      algorithm,
      previousAudit: previous,
      maxDownloads: 20,
      maxAlignments: 20,
      forceAlignment,
    },
  );
  // Persist failed collection/backoff even if later validation rejects output.
  await saveRetry(state, root);
  const selected = manifest.pages.filter(
    (page) => page.status === 'available' && page.needsAlignment,
  );
  const missions = new Set(
    selected.flatMap((page) => (page.missionIds ?? [page.missionId]).map((id) => 'quest-' + id)),
  );
  const titles = new Set(selected.map((page) => page.pageTitle));
  const targets = new Set(
    [...before.values()]
      .filter((row) => missions.has(row.missionId) || missions.has(row.bwikiMissionId))
      .map((row) => row.file),
  );
  for (const page of selected) for (const file of page.eventFiles ?? []) targets.add(file);
  for (const [file, chunks] of Object.entries(previous.chapters))
    if (chunks.some((chunk) => titles.has(chunk.page))) targets.add(file);
  for (const [file, members] of Object.entries(previous.missionCatalog ?? {}))
    if (members.some((item) => missions.has('quest-' + item.id))) targets.add(file);
  const discovery = await read(path.join(stage, '.cache/bwiki/chapters.json'));
  for (const chapter of discovery.chapters)
    if (chapter.groups.some((group) => selected.some((page) => page.title === group.title)))
      targets.add(chapter.file);
  for (const file of targets) if (!pendingFiles.has(file)) targets.delete(file);
  manifest.targetFiles = [...targets].sort();
  if (scopedFiles) manifest.scoped = true;
  await write(path.join(stage, '.cache/bwiki/manifest.json'), manifest);
  if (!scopedFiles)
    await collectEventImages(
      stage,
      path.join(root, '.cache/upstream-content/bwiki'),
      manifest,
      state,
    );
  await saveRetry(state, root);
  if (targets.size) {
    alignBwiki(run, stage, raw, planFile, root, { simulation: !scopedFiles });
  }
  if (!scopedFiles && (watch.retryVideo || targets.size))
    execFileSync(
      process.execPath,
      [
        path.join(root, 'scripts/verify-video-order.mjs'),
        stage,
        root,
        watch.retryVideo ? '--retry' : '--reuse',
      ],
      { cwd: root, stdio: 'inherit' },
    );
  return publishRetryStage(root, stage, raw, planFile, before, manifest, state, algorithm);
}

export async function publishRetryStage(
  root,
  stage,
  raw,
  planFile,
  before,
  manifest,
  state,
  algorithm,
) {
  const run = pythonRunner(root, stage);
  if (manifest.targetSources?.[0] !== 'youtube')
    await verifySourceFirst(root, stage, raw, planFile, { apply: true, previous: before });
  const quarantined = await quarantineRetryChapters(root, stage, before, manifest);
  if (quarantined.length)
    console.log(
      'Quarantined retry chapters; published evidence retained: ' +
        JSON.stringify(quarantined.map(({ file, reason }) => ({ file, reason }))),
    );
  const comparison = compareVerification(before, await verificationRows(stage));
  assertVerificationPreserved(comparison, 'Retry');
  const sourceReport = await read(path.join(stage, 'public/source-first-provenance.json')).catch(
    () => undefined,
  );
  const previousReport = await read(path.join(root, 'public/source-first-provenance.json')).catch(
    () => undefined,
  );
  const auditChanged =
    sourceReport && JSON.stringify(sourceReport) !== JSON.stringify(previousReport);
  if (comparison.changed || auditChanged) {
    run('import-localizations.py', [stage, raw, planFile]);
    const receipt = await read(path.join(stage, 'receipt.json'));
    receipt.files.push(...(await read(path.join(stage, '.cache/localization-receipt.json'))).files);
    await publishContentStage(root, stage, receipt.files);
  }
  // A no-improvement run retains deployed bytes and only writes the journal.
  const result = await finishVerification(root, before, manifest, state, algorithm, 'retry', stage);
  if (auditChanged && process.env.GITHUB_OUTPUT)
    await fs.appendFile(process.env.GITHUB_OUTPUT, 'publish=true\n');
  return result;
}
