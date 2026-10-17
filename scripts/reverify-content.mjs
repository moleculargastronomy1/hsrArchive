import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchBwiki } from './fetch-bwiki.mjs';
import { stateFiles, writeDerived } from './verification-state.mjs';
import {
  algorithmHash,
  readRetry,
  saveRetry,
  verificationRows,
  compareVerification,
  orderUnknown,
} from './verification-retry.mjs';

const read = async (file) => JSON.parse(await fs.readFile(file));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data));
export async function finishVerification(root, before, manifest, state, algorithm, mode) {
  const comparison = compareVerification(before, await verificationRows(root));
  for (const page of manifest.pages)
    if (page.status === 'available' && page.alignmentKey) {
      const previous = state.pages[page.title];
      state.pages[page.title] = {
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
  state.algorithm = algorithm;
  const report = await read(path.join(root, 'public/bwiki-provenance.json'));
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
  const result = {
    schema: 'hsr-verification-run.v1',
    checkedAt: new Date().toISOString(),
    mode,
    algorithm,
    upstreamCommit: manifest.commit,
    digest: comparison.digest,
    newlyVerified: comparison.newlyVerified.length,
    newlyVerifiedRowIds: comparison.newlyVerified,
    remainingUnknown: comparison.remainingUnknown.length,
    lostVerification: comparison.lostVerification.length,
    changed: comparison.changed,
    collectionFailures: reasons,
    matchingReviewRecords: matchingReasons,
    targetFiles: manifest.targetFiles ?? 'all',
    bodyDownloads: manifest.pages.filter((item) => item.retrieval === 'download').length,
    cachedDocuments: manifest.pages.filter((item) =>
      ['revision-cache', 'cache-pinned'].includes(item.retrieval),
    ).length,
    scope:
      'Exact official ID/hash matches only. Unknown rows and whole-playthrough coverage are not marked complete.',
  };
  state.lastRun = result;
  if (comparison.changed) state.pendingDigest = comparison.digest;
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
      `\n### 미검증 대사 재검증\n\n- 새 BWIKI 확인: ${result.newlyVerified}행\n- 순서 미확인: ${result.remainingUnknown}행\n- 기존 BWIKI 근거 상실: ${result.lostVerification}행\n- 본문 다운로드/캐시 재사용: ${result.bodyDownloads}/${result.cachedDocuments}문서\n- 수집 실패: ${JSON.stringify(reasons)}\n- 미확인 사유(검토 기록 수): ${JSON.stringify(matchingReasons)}\n- 자료 변경: ${result.changed}; 전체 플레이 검증 완료를 의미하지 않습니다.\n`,
    );
  console.log(
    `Verification: +${result.newlyVerified} BWIKI rows; ${result.remainingUnknown} unknown; changed=${result.changed}`,
  );
  return result;
}

export async function retryContent(root, stage, raw, planFile) {
  const state = await readRetry(root),
    algorithm = await algorithmHash(root),
    before = await verificationRows(root);
  const run = (script, args) =>
    execFileSync(
      process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      [path.join(root, 'scripts', script), ...args],
      { cwd: stage, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } },
    );
  // No books, nomenclature, execution graph or translated-text projection on a
  // retry: start with the last successfully published derived files.
  for (const file of [...(await stateFiles(root)), 'src/data/text-bindings.json']) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(stage, file));
  }
  await fs.mkdir(path.join(stage, '.cache'), { recursive: true });
  await write(path.join(stage, 'receipt.json'), { files: [], rows: before.size });
  run('bwiki-dialogue.py', [stage, raw, planFile, '--discover']);
  run('import-bwiki-chapters.py', [stage, raw, planFile, '--discover']);
  const previous = await read(path.join(root, 'public/bwiki-provenance.json'));
  const requestFile = path.join(stage, '.cache/bwiki/request.json'),
    request = await read(requestFile);
  const waiting = new Map();
  for (const row of before.values())
    if (orderUnknown(row))
      for (const mission of new Set([row.missionId, row.bwikiMissionId]))
        waiting.set(mission, (waiting.get(mission) ?? 0) + 1);
  request.requests.sort(
    (a, b) =>
      (b.missionIds ?? [b.missionId]).reduce((s, id) => s + (waiting.get('quest-' + id) ?? 0), 0) -
      (a.missionIds ?? [a.missionId]).reduce((s, id) => s + (waiting.get('quest-' + id) ?? 0), 0),
  );
  await write(requestFile, request);
  const forceAlignment = Boolean(
    state.pendingDigest && state.pendingDigest !== compareVerification(before, before).digest,
  );
  const manifest = await fetchBwiki(
    stage,
    path.join(root, '.cache/upstream-content/bwiki'),
    fetch,
    { state, algorithm, previousAudit: previous, maxDownloads: 20, forceAlignment },
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
  for (const [file, chunks] of Object.entries(previous.chapters))
    if (chunks.some((chunk) => titles.has(chunk.page))) targets.add(file);
  for (const [file, members] of Object.entries(previous.missionCatalog ?? {}))
    if (members.some((item) => missions.has('quest-' + item.id))) targets.add(file);
  const discovery = await read(path.join(stage, '.cache/bwiki/chapters.json'));
  for (const chapter of discovery.chapters)
    if (chapter.groups.some((group) => selected.some((page) => page.title === group.title)))
      targets.add(chapter.file);
  manifest.targetFiles = [...targets].sort();
  await write(path.join(stage, '.cache/bwiki/manifest.json'), manifest);
  if (targets.size) {
    run('bwiki-dialogue.py', [
      stage,
      raw,
      planFile,
      path.join(stage, '.cache/bwiki/manifest.json'),
      root,
    ]);
    run('import-bwiki-chapters.py', [
      stage,
      raw,
      planFile,
      path.join(stage, '.cache/bwiki/manifest.json'),
      root,
    ]);
  }
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
  const run = (script, args) =>
    execFileSync(
      process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      [path.join(root, 'scripts', script), ...args],
      { cwd: stage, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } },
    );
  const comparison = compareVerification(before, await verificationRows(stage));
  if (comparison.lostVerification.length)
    throw new Error(
      `Retry would lose ${comparison.lostVerification.length} verified rows; preserving deployed data`,
    );
  if (comparison.changed) {
    run('import-localizations.py', [stage, raw, planFile]);
    const receipt = await read(path.join(stage, 'receipt.json'));
    receipt.files.push(...(await read(path.join(stage, '.cache/localization-receipt.json'))).files);
    for (const file of new Set(receipt.files)) {
      if (!(await import('./verification-state.mjs')).statePath(file))
        throw new Error('Unsafe retry publication path');
      await writeDerived(root, file, await fs.readFile(path.join(stage, file)));
    }
  }
  // A no-improvement run retains deployed bytes and only writes the journal.
  return finishVerification(root, before, manifest, state, algorithm, 'retry');
}
