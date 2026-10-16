import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPOSITORY, resolveUpstream, gitBlob } from './upstream-content.mjs';
import { isMissionStructurePath, resolveMissionStructures } from './trailblaze-structures.mjs';
import { prepareDialogueFlow } from './dialogue-flow.mjs';
import { fetchBwiki } from './fetch-bwiki.mjs';

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
  if (['--plan', '--apply'].includes(argument) && !mode) mode = argument;
  else if (
    argument === '--title' &&
    !title &&
    args[index + 1]?.trim() &&
    !args[index + 1].startsWith('--')
  )
    title = args[++index].trim();
  else throw new Error('Unknown content update argument: ' + argument);
}
const plan =
  mode === '--apply' ? JSON.parse(await fs.readFile(planFile, 'utf8')) : await resolveUpstream(api);
if (
  plan.schema !== 'hsr-upstream-plan.v1' ||
  plan.repository !== REPOSITORY ||
  !/^[a-f0-9]{40}$/.test(plan.commit)
)
  throw new Error('Invalid upstream plan');
if (title) plan.trailblazeTitle = title;
if (mode !== '--apply') await fs.writeFile(planFile, JSON.stringify(plan, null, 2) + '\n');
if (mode === '--plan') {
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(process.env.GITHUB_OUTPUT, `commit=${plan.commit}\n`);
  console.log(`Resolved ${plan.version} (${plan.commit.slice(0, 7)})`);
} else {
  const raw = path.join(cache, 'raw');
  const blobs = path.join(cache, 'blobs');
  await fs.mkdir(raw, { recursive: true });
  await fs.mkdir(blobs, { recursive: true });
  await Promise.all(
    plan.files.map(async (file) => {
      if (
        !/^(TextMap\/TextMap(?:KR|EN|CHS|JP)(?:_\d+)?|ExcelOutput\/(?:NounAtlas|NounAtlasChangeInfo|TalkSentenceConfig|MissionChapterConfig|MainMission|BookSeriesConfig|BookSeriesWorld|LocalbookConfig))\.json$/.test(
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
  for (const name of [
    'codex.json',
    'simulation.json',
    'imported-content.json',
    'text-bindings.json',
  ])
    await fs.copyFile(path.join(root, 'src/data', name), path.join(stage, 'src/data', name));
  const python = process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const run = (script, args = [], cwd = stage) =>
    execFileSync(python, [path.join(root, 'scripts', script), ...args], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, PYTHONUTF8: '1' },
    });
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
  await prepareDialogueFlow(root, stage, plan.commit, api, blobs);
  run('restore-dialogue-flow.py', [stage, path.join(stage, '.cache/dialogue-flow/manifest.json')]);
  run('bwiki-dialogue.py', [stage, raw, planFile, '--discover']);
  run('import-bwiki-chapters.py', [stage, raw, planFile, '--discover']);
  await fetchBwiki(stage, path.join(cache, 'bwiki'));
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
  // The projector validates every payload and metadata reference before any publication.
  for (const file of receipt.files) {
    if (
      !/^(?:src\/data\/(?:codex|simulation|imported-content|train-databank|astropolis-intro|books|trailblaze)\.json|public\/(?:content-update|books-provenance|trailblaze-provenance|dialogue-flow-provenance|bwiki-provenance|video-order-provenance|video-review-summary)\.json|public\/content\/[A-Za-z0-9_-]+\.json|public\/content\/locales\/(?:manifest|(?:en|zh-CN|ja)\/[A-Za-z0-9_-]+)\.json)$/.test(
        file,
      )
    )
      throw new Error(`Invalid publication path: ${file}`);
  }
  for (const file of receipt.files) {
    const destination = path.join(root, file);
    const bytes = await fs.readFile(path.join(stage, file));
    const previous = await fs.readFile(destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    // Avoid rewriting unchanged JSON, including existing final-newline preferences.
    if (previous && previous.toString('utf8').trimEnd() === bytes.toString('utf8').trimEnd())
      continue;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = destination + '.tmp';
    await fs.writeFile(temporary, bytes);
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, destination);
        break;
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) ||
          attempt >= 4
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  console.log(`Verified and applied ${plan.version}: ${receipt.rows} rows`);
}
