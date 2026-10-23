import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gitBlob, REPOSITORY } from './upstream-content.mjs';
import { stateFiles } from './verification-state.mjs';
import { fetchBwiki } from './fetch-bwiki.mjs';
import { readRetry, saveRetry, algorithmHash } from './verification-retry.mjs';
import { pythonRunner } from './content-process.mjs';
import { publishContentStage } from './content-publication.mjs';
import { retainUnavailableWikiPositions } from './wiki-reading-recovery.mjs';
import {
  verificationRows,
  compareVerification,
  assertVerificationPreserved,
} from './verification-integration.mjs';

const read = async (file) => JSON.parse(await fs.readFile(file));
const write = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(data));
  await fs.rename(file + '.tmp', file);
};
const codeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function copyDerived(root, stage) {
  for (const file of [...(await stateFiles(root)), 'src/data/text-bindings.json']) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(stage, file));
  }
}

// Select the baseline's exact release, never whichever release is newest today.
export async function pinnedPlan(root, cache, offline = false) {
  const update = await read(path.join(root, 'public/content-update.json'));
  const locales = await read(path.join(root, 'public/content/locales/manifest.json'));
  if (update.commit !== locales.commit) throw new Error('Mixed baseline release');
  const known = { ...update.files, ...locales.files };
  const wiki = await read(path.join(root, 'public/bwiki-provenance.json'));
  if (wiki.commit === update.commit)
    for (const [file, proof] of Object.entries(wiki.inputs ?? {}))
      known[path.basename(file)] ??= proof;
  const previousPlan = await read(path.join(cache, 'plan.json')).catch(() => undefined);
  if (previousPlan?.commit === update.commit)
    for (const file of previousPlan.files)
      known[path.basename(file.path)] ??= { gitBlob: file.sha };
  const names = [
    'MainMission.json',
    'MissionChapterConfig.json',
    'TalkSentenceConfig.json',
    'NounAtlas.json',
    ...Object.keys(known).filter((name) => /^TextMap(?:KR|CHS|EN|JP)(?:_\d+)?\.json$/.test(name)),
  ];
  const files = [];
  for (const name of names) {
    const file = (name.startsWith('TextMap') ? 'TextMap/' : 'ExcelOutput/') + name;
    let bytes;
    const sha = known[name]?.gitBlob;
    if (sha) bytes = await fs.readFile(path.join(cache, 'blobs', sha)).catch(() => undefined);
    if (!bytes || (sha && gitBlob(bytes) !== sha)) {
      if (offline) {
        if (!sha) throw new Error('Offline input has no pinned descriptor: ' + name);
        bytes = await fs.readFile(path.join(cache, 'raw', name)).catch(() => undefined);
        if (!bytes || (sha && gitBlob(bytes) !== sha))
          throw new Error('Offline pinned input missing: ' + name);
      } else {
        const response = await fetch(
          `https://raw.githubusercontent.com/${REPOSITORY}/${update.commit}/${file}`,
          { signal: AbortSignal.timeout(120000) },
        );
        if (!response.ok)
          throw new Error('Pinned input unavailable: ' + name + ': ' + response.status);
        bytes = Buffer.from(await response.arrayBuffer());
      }
    }
    if (sha && gitBlob(bytes) !== sha) throw new Error('Pinned official checksum mismatch');
    const blob = gitBlob(bytes);
    await fs.mkdir(path.join(cache, 'blobs'), { recursive: true });
    await fs.mkdir(path.join(cache, 'raw'), { recursive: true });
    await fs.writeFile(path.join(cache, 'blobs', blob), bytes);
    await fs.writeFile(path.join(cache, 'raw', name), bytes);
    files.push({ path: file, sha: blob });
  }
  return {
    schema: 'hsr-upstream-plan.v1',
    repository: REPOSITORY,
    commit: update.commit,
    version: update.version,
    files,
  };
}

export async function collectStructures(commit, missionIds, work, blobs, { offline = false } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const api = async (endpoint) => {
    const name = 'api-' + Buffer.from(endpoint).toString('hex') + '.json';
    for (const folder of [path.join(work, 'api'), path.join(codeRoot, '.cache/dialogue-flow')]) {
      try {
        return await read(path.join(folder, name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (offline) throw new Error('offline-tree-unavailable');
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error('official-tree-unavailable-' + response.status);
    const value = await response.json();
    if (!Array.isArray(value.tree) || value.truncated) throw new Error('incomplete-official-tree');
    await write(path.join(work, 'api', name), value);
    return value;
  };
  const files = [],
    review = [],
    wanted = new Set(missionIds.map(String));
  for (const prefix of ['Config/Level/Mission', 'Story/Mission', 'Story/Discussion/Mission']) {
    try {
      let sha = commit;
      for (const part of prefix.split('/')) {
        const listing = await api(`git/trees/${sha}`);
        if (listing.truncated || !Array.isArray(listing.tree))
          throw new Error('incomplete-official-tree');
        sha = listing.tree.find((r) => r.type === 'tree' && r.path === part)?.sha;
        if (!sha) break;
      }
      if (!sha) {
        review.push({ prefix, reason: 'official-directory-absent' });
        continue;
      }
      const listing = await api(`git/trees/${sha}?recursive=1`);
      if (listing.truncated || !Array.isArray(listing.tree))
        throw new Error('incomplete-official-tree');
      for (const file of listing.tree) {
        if (
          file.type !== 'blob' ||
          !wanted.has(file.path.split('/')[0]) ||
          !file.path.endsWith('.json') ||
          file.path.endsWith('.layout.json')
        )
          continue;
        if (
          !/^[a-f0-9]{40}$/.test(file.sha) ||
          file.path.split('/').some((s) => ['.', '..'].includes(s))
        )
          throw new Error('invalid-official-descriptor');
        files.push({ path: prefix + '/' + file.path, sha: file.sha });
      }
    } catch (error) {
      review.push({ prefix, reason: error.message });
    }
  }
  // Resolve performance IDs through explicit game tables, never through filenames.
  const tableNames = new Set([
    'PerformanceA.json',
    'PerformanceC.json',
    'PerformanceD.json',
    'PerformanceDS.json',
    'PerformanceCG.json',
    'PerformanceE.json',
    'PerformanceSubMissionLink.json',
  ]);
  try {
    const rootTree = await api(`git/trees/${commit}`);
    const excel = rootTree.tree.find((r) => r.path === 'ExcelOutput' && r.type === 'tree');
    if (!excel) throw new Error('execution-table-directory-absent');
    for (const file of (await api(`git/trees/${excel.sha}`)).tree)
      if (file.type === 'blob' && tableNames.has(file.path))
        files.push({ path: 'ExcelOutput/' + file.path, sha: file.sha });
  } catch (error) {
    review.push({ prefix: 'ExcelOutput/Performance', reason: error.message });
  }
  let cursor = 0;
  const available = [];
  await fs.mkdir(blobs, { recursive: true });
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        try {
          let bytes = await fs.readFile(path.join(blobs, file.sha)).catch(() => undefined);
          if (!bytes || gitBlob(bytes) !== file.sha) {
            if (offline) throw new Error('offline-structure-unavailable');
            const response = await fetch(
              `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${file.path}`,
              { signal: AbortSignal.timeout(45000) },
            );
            if (!response.ok) throw new Error('structure-unavailable-' + response.status);
            bytes = Buffer.from(await response.arrayBuffer());
            if (gitBlob(bytes) !== file.sha)
              throw new Error('official-structure-checksum-mismatch');
            await fs.writeFile(path.join(blobs, file.sha), bytes);
          }
          available.push(file);
        } catch (error) {
          review.push({ source: file.path, reason: error.message });
        }
      }
    }),
  );
  return {
    schema: 'hsr-dialogue-flow-input.v1',
    commit,
    blobs: path.resolve(blobs),
    files: available
      .filter((f) => !f.path.startsWith('ExcelOutput/'))
      .sort((a, b) => a.path.localeCompare(b.path)),
    tables: available
      .filter((f) => f.path.startsWith('ExcelOutput/'))
      .sort((a, b) => a.path.localeCompare(b.path)),
    review,
    discoveredFiles: files.length,
  };
}

export async function verifySourceFirst(root, stage, raw, planFile, options = {}) {
  const work = options.work ?? path.join(root, '.cache/source-first');
  const run = pythonRunner(codeRoot, stage);
  const plan = await read(planFile);
  const before = options.executionOnly
    ? undefined
    : (options.previous ?? (await verificationRows(stage)));
  await fs.mkdir(work, { recursive: true });
  run('source-first.py', [stage, raw, planFile, work, '--discover']);
  const cat = await read(path.join(work, 'catalog.json'));
  const structureManifest = options.replay
    ? await read(path.join(work, 'structures.json'))
    : await collectStructures(
        plan.commit,
        cat.chapters.flatMap((c) => c.missions.map((m) => m.id)),
        work,
        path.join(root, '.cache/upstream-content/blobs'),
        options,
      );
  await write(path.join(work, 'structures.json'), structureManifest);
  if (options.executionOnly) {
    run('source-first.py', [
      stage,
      raw,
      planFile,
      work,
      '--execution-only',
      ...(options.apply ? ['--apply'] : []),
    ]);
    return read(path.join(work, 'execution-report.json'));
  }
  const collection = path.join(work, 'collection');
  await fs.mkdir(path.join(collection, '.cache/bwiki'), { recursive: true });
  await fs.copyFile(
    path.join(work, 'request.json'),
    path.join(collection, '.cache/bwiki/request.json'),
  );
  const stateFile = path.join(work, 'collection-state.json');
  const state = await read(stateFile).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return readRetry(root);
  });
  const algorithm = await algorithmHash(codeRoot);
  const manifest = options.replay
    ? await read(path.join(work, 'manifest.json'))
    : await fetchBwiki(
        collection,
        path.join(root, '.cache/upstream-content/bwiki'),
        options.offline
          ? async () => {
              throw new Error('offline-pinned-snapshot-audit; live revision unverified');
            }
          : fetch,
        {
          state,
          algorithm,
          forceAlignment: true,
          maxDownloads: 40,
          previousAudit: await read(path.join(stage, 'public/bwiki-provenance.json')),
        },
      );
  if (!options.offline && !options.replay) await write(stateFile, state);
  await write(path.join(work, 'manifest.json'), manifest);
  try {
    run('source-first.py', [stage, raw, planFile, work, ...(options.apply ? ['--apply'] : [])]);
    if (options.apply) {
      const retained = await retainUnavailableWikiPositions(stage, before, manifest);
      if (retained.length)
        console.log(
          'Retained unavailable BWIKI documents: ' +
            JSON.stringify(
              retained.map((r) => ({ file: r.file, documents: r.documents.map((d) => d.page) })),
            ),
        );
      // Wiki text matching supplies display order. Keep prior execution proof
      // without running another ordering algorithm over the new wiki layout.
      run('source-first.py', [stage, raw, planFile, work, '--preserve-execution', '--apply']);
      const execution = await read(path.join(work, 'execution-report.json'));
      const report = await read(path.join(work, 'report.json'));
      const provenance = await read(path.join(stage, 'public/source-first-provenance.json'));
      report.candidateAdditions += execution.candidateAdditions;
      for (const chapter of execution.chapters) {
        const item = report.chapters.find((c) => c.file === chapter.file);
        if (item) {
          item.execution = chapter.summary;
          item.reading = chapter.reading;
          item.candidateAdditions += chapter.summary.newOfficialRows;
        }
        if (provenance.chapters[chapter.file]) {
          provenance.chapters[chapter.file].execution = chapter.summary;
          provenance.chapters[chapter.file].reading = chapter.reading;
        }
      }
      await write(path.join(work, 'report.json'), report);
      await write(path.join(stage, 'public/source-first-provenance.json'), provenance);
    }
    await write(path.join(work, 'validator-health.json'), {
      status: 'audit-passed; final-stage-contracts-pending',
      algorithm,
    });
  } catch (error) {
    await write(path.join(work, 'validator-health.json'), {
      status: 'failed',
      algorithm,
      publicationStopped: true,
      reason: 'shared-validator-failure; no source-first candidate publication',
    });
    throw error;
  }
  return read(path.join(work, 'report.json'));
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    offline: args.includes('--offline'),
    replay: args.includes('--replay'),
    apply: true,
    executionOnly: args.includes('--execution-only'),
  };
  const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
  const root = path.resolve(value('--root', process.cwd()));
  const baseline = path.resolve(value('--baseline', root));
  const work = path.resolve(value('--work', path.join(root, '.cache/source-first')));
  const stage = path.join(work, 'stage');
  // Always stage and validate. --publish is explicit, with rollback supported by the shared publisher.
  await copyDerived(baseline, stage);
  await write(path.join(stage, 'receipt.json'), {
    files: [],
    rows: (await read(path.join(stage, 'public/content-update.json'))).rows,
  });
  const planFile = path.join(work, 'plan.json');
  const plan = await pinnedPlan(
    baseline,
    path.join(root, '.cache/upstream-content'),
    options.offline,
  );
  await write(planFile, plan);
  const before = await verificationRows(baseline);
  const report = await verifySourceFirst(
    root,
    stage,
    path.join(root, '.cache/upstream-content/raw'),
    planFile,
    { ...options, work },
  );
  const run = pythonRunner(codeRoot, stage);
  if (!options.executionOnly || report.candidateAdditions)
    run('import-localizations.py', [
      stage,
      path.join(root, '.cache/upstream-content/raw'),
      planFile,
    ]);
  const receipt = await read(path.join(stage, 'receipt.json'));
  if (!options.executionOnly || report.candidateAdditions)
    receipt.files.push(...(await read(path.join(stage, '.cache/localization-receipt.json'))).files);
  assertVerificationPreserved(
    compareVerification(before, await verificationRows(stage)),
    'Source-first partial application',
  );
  run('validate-content-stage.py', [stage]);
  await write(path.join(work, 'validated-stage.json'), {
    status: 'passed',
    files: [...new Set(receipt.files)],
    candidateAdditions: report.candidateAdditions,
  });
  if (args.includes('--publish')) {
    assertVerificationPreserved(
      compareVerification(await verificationRows(root), await verificationRows(stage)),
      'Repository compatibility',
    );
    await publishContentStage(root, stage, await stateFiles(stage));
  }
  console.log(
    `Source-first ${report.registeredChapters ?? report.chapters.length} chapters; ${options.executionOnly ? 'official execution extension' : report.candidateAdditions + ' additions'}; ${args.includes('--publish') ? 'published locally' : 'isolated stage only'}`,
  );
  await write(path.join(work, 'validator-health.json'), {
    status: 'passed',
    codeHash: report.codeHash,
    policyHash: report.policyHash,
    finalStageValidated: true,
    productionPublished: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const args = process.argv.slice(2);
    const root = path.resolve(
      args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd(),
    );
    const work = path.resolve(
      args.includes('--work')
        ? args[args.indexOf('--work') + 1]
        : path.join(root, '.cache/source-first'),
    );
    await write(path.join(work, 'validator-health.json'), {
      status: 'failed',
      publicationStopped: true,
      reason: 'shared-pipeline-failure; preserve baseline',
    });
    throw error;
  }
}
