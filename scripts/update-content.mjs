import { publishContentStage } from './content-publication.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPOSITORY, resolveUpstream, gitBlob } from './upstream-content.mjs';
import { isMissionStructurePath, resolveMissionStructures } from './trailblaze-structures.mjs';
import { prepareDialogueFlow } from './dialogue-flow.mjs';
import { fetchBwiki } from './fetch-bwiki.mjs';
import { retryContent, finishVerification } from './reverify-content.mjs';
import {
  algorithmHash,
  readRetry,
  saveRetry,
  prioritizeBwikiRequests,
} from './verification-retry.mjs';

import {
  verificationRows,
  compareVerification,
  assertVerificationPreserved,
} from './verification-integration.mjs';
import { pythonRunner } from './content-process.mjs';
import { discoverBwiki, alignBwiki, limitBwikiToPending } from './bwiki-verification.mjs';
import { prepareSimulationEvents } from './simulation-events.mjs';
import { collectEventImages } from './event-images.mjs';

const root = process.cwd();
const cache = path.resolve('.cache/upstream-content');
const planFile = path.join(cache, 'plan.json');
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
async function api(endpoint) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${endpoint}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`GitHub API HTTP ${response.status}: ${endpoint.split('?')[0]}`);
  return response.json();
}
await fs.mkdir(cache, { recursive: true });
let mode, title;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (['--plan', '--apply', '--retry'].includes(argument) && !mode) mode = argument;
  else if (
    argument === '--title' &&
    !title &&
    args[index + 1]?.trim() &&
    !args[index + 1].startsWith('--')
  )
    title = args[++index].trim();
  else throw new Error('Unknown content update argument: ' + argument);
}
const plan = ['--apply', '--retry'].includes(mode)
  ? JSON.parse(await fs.readFile(planFile, 'utf8'))
  : await resolveUpstream(api);
if (
  plan.schema !== 'hsr-upstream-plan.v1' ||
  plan.repository !== REPOSITORY ||
  !/^[a-f0-9]{40}$/.test(plan.commit)
)
  throw new Error('Invalid upstream plan');
if (title) plan.trailblazeTitle = title;
if (!['--apply', '--retry'].includes(mode))
  await fs.writeFile(planFile, JSON.stringify(plan, null, 2) + '\n');
if (mode === '--plan') {
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(process.env.GITHUB_OUTPUT, `commit=${plan.commit}\n`);
  console.log(`Resolved ${plan.version} (${plan.commit.slice(0, 7)})`);
} else {
  const before = await verificationRows(root);
  const raw = path.join(cache, 'raw');
  const blobs = path.join(cache, 'blobs');
  await fs.mkdir(raw, { recursive: true });
  await fs.mkdir(blobs, { recursive: true });
  await Promise.all(
    plan.files.map(async (file) => {
      if (
        !/^(TextMap\/TextMap(?:KR|EN|CHS|JP)(?:_\d+)?|ExcelOutput\/(?:NounAtlas|NounAtlasChangeInfo|TalkSentenceConfig|MissionChapterConfig|MainMission|BookSeriesConfig|BookSeriesWorld|LocalbookConfig|RogueHandBookEvent|RogueHandBookEventType|RogueTournHandBookEvent|RogueNPC|RogueTournNPC|RogueMagicNPC|RogueDialogueOptionDisplay))\.json$/.test(
          file.path,
        ) ||
        !/^[a-f0-9]{40}$/.test(file.sha)
      )
        throw new Error('Invalid upstream file descriptor');
      let bytes;
      for (const candidate of [
        path.join(blobs, file.sha),
        path.resolve('.cache/train-databank', path.basename(file.path)),
        path.resolve('.cache/astro-source', path.basename(file.path)),
      ]) {
        try {
          const existing = await fs.readFile(candidate);
          if (gitBlob(existing) === file.sha) {
            bytes = existing;
            break;
          }
        } catch {}
      }
      if (!bytes) {
        const response = await fetch(
          `https://raw.githubusercontent.com/${REPOSITORY}/${plan.commit}/${file.path}`,
          { signal: AbortSignal.timeout(120000) },
        );
        if (!response.ok) throw new Error(`Upstream file HTTP ${response.status}: ${file.path}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (gitBlob(bytes) !== file.sha) throw new Error(`Git blob mismatch: ${file.path}`);
      await fs.writeFile(path.join(blobs, file.sha), bytes);
      await fs.writeFile(path.join(raw, path.basename(file.path)), bytes);
    }),
  );
  const stage = path.join(cache, 'stage');
  // Check the absolute scratch path before clearing stale localization inputs.
  if (!path.isAbsolute(stage) || path.relative(cache, stage) !== 'stage')
    throw new Error('Unsafe content staging directory');
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(path.join(stage, 'src/data'), { recursive: true });
  await fs.mkdir(path.join(stage, 'public/content'), { recursive: true });
  await fs.mkdir(path.join(stage, '.cache'), { recursive: true });
  if (mode === '--retry') {
    if (
      JSON.parse(await fs.readFile(path.join(root, 'public/content-update.json'))).commit !==
      plan.commit
    )
      throw new Error('Retry requires the same official input commit');
    await retryContent(root, stage, raw, planFile, api, blobs);
    process.exit(0);
  }
  for (const name of [
    'codex.json',
    'simulation.json',
    'imported-content.json',
    'text-bindings.json',
  ])
    await fs.copyFile(path.join(root, 'src/data', name), path.join(stage, 'src/data', name));
  const run = pythonRunner(root, stage);
  const catalog = path.join(stage, '.cache/trailblaze-catalog.json');
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(root, 'scripts/export-trailblaze-catalog.mjs'),
      catalog,
    ],
    { cwd: root },
  );
  const trailblazeArgs = [
    stage,
    raw,
    planFile,
    ...(plan.trailblazeTitle ? ['--title', plan.trailblazeTitle] : []),
  ];
  run('import-trailblaze.py', [...trailblazeArgs, '--discover']);
  const missionPlan = JSON.parse(
    await fs.readFile(path.join(stage, '.cache/trailblaze-plan.json'), 'utf8'),
  );
  if (missionPlan.commit !== plan.commit) throw new Error('Mixed mission structure plan');
  const structures = await resolveMissionStructures(api, plan.commit, missionPlan.missionIds);
  // Limit download concurrency. Preserve paths rather than flattening colliding filenames.
  for (const file of structures) {
    if (!isMissionStructurePath(file.path)) throw new Error('Invalid mission structure path');
    let bytes = await fs.readFile(path.join(blobs, file.sha)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!bytes || gitBlob(bytes) !== file.sha) {
      const response = await fetch(
        `https://raw.githubusercontent.com/${REPOSITORY}/${plan.commit}/${file.path}`,
        { signal: AbortSignal.timeout(120000) },
      );
      if (!response.ok) throw new Error(`Mission structure HTTP ${response.status}: ${file.path}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (gitBlob(bytes) !== file.sha) throw new Error('Mission structure Git blob mismatch');
    await fs.writeFile(path.join(blobs, file.sha), bytes);
    const target = path.join(stage, '.cache/structures', file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  await fs.writeFile(
    path.join(stage, '.cache/trailblaze-structures.json'),
    JSON.stringify({ commit: plan.commit, files: structures }),
  );
  // Existing introductions can be promoted without changing their saved row IDs.
  for (const entry of JSON.parse(await fs.readFile(catalog, 'utf8')))
    for (const chapter of entry.chapters) {
      if (
        !chapter.content ||
        !/^[A-Za-z0-9_-]+$/.test(entry.id) ||
        !/^[A-Za-z0-9_-]+$/.test(chapter.id)
      )
        throw new Error('Invalid existing Trailblaze route');
      const file = `content/${entry.id}--${chapter.id}.json`;
      if (chapter.content.file !== file) throw new Error('Mismatched Trailblaze payload path');
      await fs.copyFile(path.join(root, 'public', file), path.join(stage, 'public', file));
    }
  run('import-train-databank.py', [raw, planFile]);
  run('import-astropolis-intro.py', [raw, planFile]);
  run('import-books.py', [raw, planFile]);
  run('import-trailblaze.py', trailblazeArgs);
  run('project-upstream-content.py', [root, raw, planFile], stage);
  await prepareSimulationEvents(stage, raw, planFile, api, blobs, run);
  await prepareDialogueFlow(root, stage, plan.commit, api, blobs);
  run('restore-dialogue-flow.py', [stage, path.join(stage, '.cache/dialogue-flow/manifest.json')]);
  discoverBwiki(run, stage, raw, planFile);
  const retryState = await readRetry(root),
    algorithm = await algorithmHash(root);
  const requestFile = path.join(stage, '.cache/bwiki/request.json');
  const request = JSON.parse(await fs.readFile(requestFile));
  const pendingFiles = await limitBwikiToPending(
    root,
    stage,
    request,
    await verificationRows(stage),
  );
  const waiting = new Map();
  for (const row of before.values())
    if (!['matched', 'cached'].includes(row.bwikiStatus))
      waiting.set(row.missionId, (waiting.get(row.missionId) ?? 0) + 1);
  prioritizeBwikiRequests(request.requests, retryState, waiting);
  await fs.writeFile(requestFile, JSON.stringify(request));
  const manifest = await fetchBwiki(stage, path.join(cache, 'bwiki'), fetch, {
    state: retryState,
    algorithm,
    previousAudit: JSON.parse(await fs.readFile(path.join(root, 'public/bwiki-provenance.json'))),
  });
  manifest.targetFiles = [...pendingFiles].sort();
  await collectEventImages(stage, path.join(cache, 'bwiki'), manifest, retryState);
  await saveRetry(retryState, root);
  alignBwiki(run, stage, raw, planFile, root);
  execFileSync(process.execPath, [path.join(root, 'scripts/verify-video-order.mjs'), stage, root], {
    cwd: root,
    stdio: 'inherit',
  });
  run('import-localizations.py', [stage, raw, planFile]);
  const receipt = JSON.parse(await fs.readFile(path.join(stage, 'receipt.json'), 'utf8'));
  const localizations = JSON.parse(
    await fs.readFile(path.join(stage, '.cache/localization-receipt.json'), 'utf8'),
  );
  receipt.files.push(...localizations.files);
  const books = JSON.parse(
    await fs.readFile(path.join(stage, '.cache/books-receipt.json'), 'utf8'),
  );
  receipt.files.push(...books.files);
  const trailblaze = JSON.parse(
    await fs.readFile(path.join(stage, '.cache/trailblaze-receipt.json'), 'utf8'),
  );
  receipt.files.push(...trailblaze.files);
  // Preserve existing proof first; publication validates the final integrated view.
  const preservation = compareVerification(before, await verificationRows(stage));
  if (
    JSON.parse(await fs.readFile(path.join(root, 'public/content-update.json'))).commit ===
    plan.commit
  )
    assertVerificationPreserved(preservation, 'Same-version update');
  await publishContentStage(root, stage, receipt.files);
  console.log(`Verified and applied ${plan.version}: ${receipt.rows} rows`);
  await finishVerification(root, before, manifest, retryState, algorithm, 'full');
}
