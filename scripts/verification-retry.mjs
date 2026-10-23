import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from './verification-state.mjs';

export const RETRY_FILE = '.cache/verification-retry/state.json';
export const HOUR = 3600000;
export const REVIEW_INTERVAL = 24 * HOUR;

export function workflowProgress({ run, audit, execution, state, status, runId, attempt, commit, now = new Date().toISOString() }) {
  return {
    schema: 'hsr-workflow-progress.v1', checkedAt: now, runId, attempt, codeCommit: commit,
    pipelineStatus: status, publicationStatus: 'see-deploy-job; checkpoint-is-not-publication-approval',
    verification: run ?? null,
    audit: audit ? {
      currentRun: audit.runId === runId, status: audit.status, codeHash: audit.codeHash,
      policyHash: audit.policyHash, policyVersion: audit.policyVersion, officialCommit: audit.commit,
      startedAt: audit.startedAt, updatedAt: audit.updatedAt,
      registeredChapters: audit.registeredChapters, processedChapters: audit.chapters?.length ?? 0,
      lastProcessedChapter: audit.lastProcessedChapter, pendingChapters: audit.pendingChapters ?? [],
      chapters: (audit.chapters ?? []).map(c => ({ file: c.file, title: c.title, reused: c.reused,
        candidateAdditions: c.candidateAdditions, counts: c.counts, reading: c.reading,
        orderComparisonCounts: c.orderComparisonCounts, review: c.review })),
    } : null,
    execution: execution ? { status: execution.status, processedChapters: execution.chapters?.length ?? 0,
      codeHash: execution.codeHash, policyHash: execution.policyHash } : null,
    retry: { nextRequestAt: state?.nextRequestAt, pendingDigest: state?.pendingDigest,
      pendingPages: Object.entries(state?.pages ?? {}).filter(([, p]) => p.reason || p.unresolved)
        .map(([title, p]) => ({ title, reason: p.reason, nextRetryAt: p.nextRetryAt, unresolved: p.unresolved })) },
  };
}

export async function recordWorkflowProgress(root = process.cwd(), env = process.env) {
  const optional = async file => {
    const bytes = await fs.readFile(path.join(root, file)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    return bytes ? JSON.parse(bytes) : undefined;
  };
  const [run, audit, execution, state] = await Promise.all([
    optional('.cache/verification-retry/run.json'), optional('.cache/source-first/progress.json'),
    optional('.cache/source-first/execution-progress.json'), optional(RETRY_FILE),
  ]);
  const recoveredAudit = audit ?? run?.sourceAudit ?? state?.lastRun?.sourceAudit;
  const result = workflowProgress({ run, audit: recoveredAudit,
    execution, state, status: env.HSR_JOB_STATUS,
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, commit: env.GITHUB_SHA });
  const target = path.join(root, '.cache/verification-retry/workflow-progress.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) {
    const cell = value => String(value ?? '—').replace(/[\r\n|]/g, ' ');
    const lines = ['\n### 자동 갱신 진행 기록\n',
      `- 파이프라인: ${cell(result.pipelineStatus)} / 대조: ${cell(run?.status)}`,
      `- 기록은 체크포인트이며 게시 성공은 deploy 작업에서 확인합니다.`,
      `- 마지막 조사: ${cell(recoveredAudit?.updatedAt)} / 이번 실행: ${result.audit?.currentRun ? '예' : '이전 체크포인트'}`,
      `- 처리한 장: ${result.audit?.processedChapters ?? 0}/${recoveredAudit?.registeredChapters ?? '—'} / 재시도 대기 문서: ${result.retry.pendingPages.length}`,
      '\n| 장 | 새 원문 후보 | 배치 행 | 순서 미확인 행 | 체크포인트 재사용 |', '| --- | ---: | ---: | ---: | --- |'];
    for (const chapter of result.audit?.chapters ?? []) lines.push(
      `| ${cell(chapter.title)} | ${cell(chapter.candidateAdditions)} | ${cell(chapter.reading?.placedRows)} | ${cell(chapter.reading?.unplacedRows)} | ${chapter.reused ? '예' : '아니오'} |`);
    await fs.appendFile(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  return result;
}

export function prioritizeBwikiRequests(requests, state, waiting = new Map(), now = Date.now()) {
  const pending = (item) =>
    (item.eventFiles?.length ?? 0) +
    (item.missionIds ?? [item.missionId]).reduce(
      (sum, id) => sum + (waiting.get('quest-' + id) ?? 0),
      0,
    );
  const due = (item) => !(Date.parse(state.pages[item.title]?.nextRetryAt ?? '') > now);
  return requests.sort(
    (a, b) =>
      Number(due(b)) - Number(due(a)) ||
      Number(pending(b) > 0) - Number(pending(a) > 0) ||
      (Date.parse(
        state.pages[a.title]?.lastReviewedAt ?? state.pages[a.title]?.lastAttempt ?? '',
      ) || 0) -
        (Date.parse(
          state.pages[b.title]?.lastReviewedAt ?? state.pages[b.title]?.lastAttempt ?? '',
        ) || 0) ||
      pending(b) - pending(a) ||
      a.title.localeCompare(b.title),
  );
}
async function hashAlgorithmFiles(root, files) {
  return hash(
    Buffer.concat(
      await Promise.all(
        files.map(async (file) =>
          Buffer.concat([
            Buffer.from(file + '\0'),
            await fs.readFile(path.join(root, 'scripts', file)),
          ]),
        ),
      ),
    ),
  );
}
export async function algorithmHash(root = process.cwd()) {
  const code = await hashAlgorithmFiles(root, [
    'bwiki-dialogue.py',
    'bwiki-placement.py',
    'wiki-reading-recovery.mjs',
    'import-bwiki-chapters.py',
    'import-simulation-events.py',
    'simulation-events.mjs',
    'event-images.mjs',
    'fetch-bwiki.mjs',
    'fetch-bwiki-legacy.mjs',
    'verification-retry.mjs',
    'reverify-content.mjs',
    'bwiki-verification.mjs',
    'verification-integration.mjs',
    'content-process.mjs',
    'content-publication.mjs',
    'verification-state.mjs',
    'prepare-verification.mjs',
    'validate-content-stage.py',
    'import-localizations.py',
    'source-first.py',
    'execution-placement.py',
    'restore-dialogue-flow.py',
    'dialogue-flow.mjs',
    'trailblaze-structures.mjs',
    'source-first.mjs',
    'update-content.mjs',
    'source-first-publication.mjs',
    'import-trailblaze.py',
  ]);
  const reviews = await fs
    .readFile(path.join(root, 'editorial/bwiki-translation-matches.json'))
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return Buffer.from('no bilingual reviews');
    });
  const policy = await fs.readFile(path.join(root, 'editorial/source-first-policy.json'));
  return hash(Buffer.concat([Buffer.from(code), reviews, policy]));
}
export async function videoAlgorithmHash(root = process.cwd()) {
  return hashAlgorithmFiles(root, [
    'video-order.mjs',
    'video-chapter-links.mjs',
    'verify-video-order.mjs',
    'video-review.mjs',
    'verification-integration.mjs',
    'verification-retry.mjs',
    'content-publication.mjs',
    'verification-state.mjs',
    'validate-content-stage.py',
  ]);
}
export async function readRetry(root = process.cwd()) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, RETRY_FILE)));
    if (
      value.schema !== 'hsr-verification-retry.v1' ||
      !value.pages ||
      typeof value.pages !== 'object'
    )
      throw new Error('Invalid retry state');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schema: 'hsr-verification-retry.v1', pages: {} };
  }
}
export async function saveRetry(state, root = process.cwd()) {
  const file = path.join(root, RETRY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(state));
  await fs.rename(file + '.tmp', file);
}
export function verificationProgress(state, result = state.lastRun) {
  return {
    ...result,
    retry: {
      pages: state.pages,
      nextRequestAt: state.nextRequestAt,
      requestFailures: state.requestFailures,
      lastRequestError: state.lastRequestError,
    },
  };
}
export function recoverVerificationProgress(state, digest) {
  // Old snapshots omitted this derived file. An unpublished or unrelated cache
  // must never acknowledge a different successfully deployed content snapshot.
  if (
    !state.lastRun ||
    state.lastRun.digest !== digest ||
    (state.pendingDigest && state.pendingDigest !== digest)
  )
    return undefined;
  return verificationProgress(state);
}
export function retryDelay(failures, retryAfter, now = Date.now()) {
  const seconds = Number(retryAfter);
  const server =
    retryAfter == null
      ? 0
      : Number.isFinite(seconds)
        ? seconds * 1000
        : Math.max(0, Date.parse(retryAfter) - now) || 0;
  return Math.max(Math.min(72, 6 * 2 ** Math.min(4, Math.max(0, failures - 1))) * HOUR, server);
}
export function failedPage(previous, reason, now, retryAfter) {
  const failures = (previous?.failures ?? 0) + 1;
  return {
    ...previous,
    failures,
    reason,
    lastAttempt: new Date(now).toISOString(),
    nextRetryAt: new Date(now + retryDelay(failures, retryAfter, now)).toISOString(),
  };
}
export function retryDecision(state, algorithm, published, now = Date.now()) {
  if (state.pendingDigest && state.pendingDigest !== published?.digest)
    return { needed: true, reason: 'unpublished-verified-result' };
  if ((state.algorithm ?? published?.algorithm) !== algorithm)
    return { needed: true, reason: 'algorithm-changed' };
  if (Date.parse(state.nextRequestAt ?? '') > now)
    return { needed: false, reason: 'request-backoff' };
  const due = Object.entries(state.pages)
    .filter(([, item]) => (item.reason || item.unresolved) && Date.parse(item.nextRetryAt) <= now)
    .map(([title]) => title);
  return {
    needed: due.length > 0,
    reason: due.length ? 'failed-pages-due' : 'unchanged-processed-inputs',
    due,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--journal') throw Error('Expected --journal');
  await recordWorkflowProgress();
}
