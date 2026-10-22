import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkSources,
  makeSnapshot,
  observeUnfetchedWiki,
  readPublishedSnapshot,
  watchObservation,
  watchBaseline,
  contentRefreshDecision,
} from './content-change.mjs';
import {
  algorithmHash,
  videoAlgorithmHash,
  readRetry,
  saveRetry,
  retryDecision,
} from './verification-retry.mjs';
import { SITE } from './verification-state.mjs';
import { videoRetryDecision, mergeVideoChecks } from './video-order.mjs';

const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const config = await read('editorial/video-verification-sources.json');
const mode = process.argv[2];
if (config.schema !== 'hsr-video-sources.v1') throw new Error('Invalid watch configuration');
if (mode === '--record') {
  const previous = await readPublishedSnapshot().catch(() => undefined);
  const manifest = await read('.cache/upstream-content/stage/.cache/bwiki/manifest.json');
  let snapshot = makeSnapshot({
    update: await read('public/content-update.json'),
    wiki: await read('public/bwiki-provenance.json'),
    manifest,
    video: await read('public/video-order-provenance.json'),
    official: await read('public/official-videos.json'),
    config,
    previous,
  });
  if (
    !Array.isArray(manifest.observations) &&
    !(Date.parse((await readRetry()).nextRequestAt ?? '') > Date.now())
  )
    snapshot = await observeUnfetchedWiki(snapshot, manifest);
  // It becomes the next baseline only if this build is successfully deployed.
  await fs.writeFile('public/content-watch.json.tmp', JSON.stringify(snapshot));
  await fs.rename('public/content-watch.json.tmp', 'public/content-watch.json');
  await fs.mkdir('.cache/verification-retry', { recursive: true });
  const run = await read('.cache/verification-retry/run.json').catch(() => undefined);
  await fs.writeFile(
    '.cache/verification-retry/watch.json',
    JSON.stringify(watchObservation(previous, snapshot, run)),
  );
  console.log(`Recorded processed source metadata: ${snapshot.wiki.length} BWIKI titles`);
} else if (!mode || mode === '--check' || mode === '--force') {
  let result;
  const state = await readRetry();
  const algorithm = await algorithmHash();
  const videoAlgorithm = await videoAlgorithmHash();
  let published;
  try {
    const response = await fetch(SITE + 'verification-progress.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok) published = await response.json();
  } catch {
    /* Unknown is recorded below; never acknowledges publication. */
  }
  if (!state.lastRun && !Object.keys(state.pages).length && published?.retry) {
    Object.assign(state, published.retry, {
      algorithm: published.algorithm,
      videoAlgorithm: published.videoAlgorithm,
      lastRun: published,
    });
  }
  if (state.pendingDigest && state.pendingDigest === published?.digest) delete state.pendingDigest;
  const unpublished = Boolean(state.pendingDigest && state.pendingDigest !== published?.digest);
  const retry = retryDecision({ ...state, pendingDigest: undefined }, algorithm, published);
  let videoRetry = { needed: false, reason: 'video-state-unavailable' };
  try {
    const response = await fetch(SITE + 'video-order-provenance.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok) {
      const video = await response.json();
      video.checks = mergeVideoChecks(video.checks, state.videoChecks);
      video.algorithm = state.videoAlgorithm ?? video.algorithm;
      videoRetry = videoRetryDecision(video, Date.now(), videoAlgorithm);
    }
  } catch {
    /* A failed probe never becomes successful verification. */
  }
  if (mode === '--force') result = { changed: true, checks: { source: 'requested-build' } };
  else {
    try {
      const deployed = await readPublishedSnapshot();
      let previous = deployed;
      try {
        const observed = await read('.cache/verification-retry/watch.json');
        if (!state.pendingDigest) previous = watchBaseline(deployed, observed);
      } catch {
        /* First retry uses the deployed baseline. */
      }
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      result = await checkSources(previous, config, {
        headers,
        skipWiki: retry.needed
          ? 'deferred-to-retry'
          : Date.parse(state.nextRequestAt ?? '') > Date.now()
            ? 'backoff'
            : false,
      });
    } catch {
      result = { changed: false, checks: { snapshot: 'unavailable' } };
    }
  }
  // Source changes retain the full pipeline. Independent BWIKI/video retries
  // only process the due verifier and still pass preservation and build gates.
  result = contentRefreshDecision(result, retry, videoRetry, unpublished);
  await saveRetry(state);
  await fs.mkdir(path.resolve('.cache/content-watch'), { recursive: true });
  await fs.writeFile('.cache/content-watch/check.json', JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\nmode=${result.mode}\n`,
    );
  {
    const journal = {
      schema: 'hsr-verification-run.v1',
      checkedAt: new Date().toISOString(),
      mode: result.changed ? result.mode : 'skipped',
      status: result.changed ? 'pending' : 'unchanged',
      newlyVerified: 0,
      remainingUnknown: state.lastRun?.remainingUnknown ?? published?.remainingUnknown ?? null,
      collectionFailures: state.lastRun?.collectionFailures ?? {},
      checks: result.checks,
      reason: unpublished ? 'unpublished-verified-result' : retry.reason,
      unknownCountAvailable: Number.isInteger(
        state.lastRun?.remainingUnknown ?? published?.remainingUnknown,
      ),
      sourceAudit: published?.sourceAudit ?? state.lastRun?.sourceAudit,
    };
    await fs.writeFile('.cache/verification-retry/run.json', JSON.stringify(journal, null, 2));
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### 자료 변경 확인\n\n${result.changed ? (result.mode === 'retry' ? '재시도 사유 확인: 기한이 된 BWIKI·유튜브 대상 구간을 다시 대조합니다.' : '새 자료 또는 소스 배포: 전체 갱신을 실행합니다.') : '새 변경이나 재시도 사유가 없어 전체 갱신·빌드·배포를 생략합니다.'}\n\n` +
        Object.entries(result.checks)
          .map(([name, status]) => `- ${name}: ${status}`)
          .join('\n') +
        '\n\n조회 실패(unavailable)는 변경 없음으로 확정하지 않고 다음 주기에 다시 확인합니다.\n',
    );
  console.log(JSON.stringify(result));
} else throw new Error('Unknown content watch argument');
