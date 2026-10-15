// Uses the file-discovery approach observed in paimooon's translate.html;
// conversion and publication are implemented independently for this archive.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPOSITORY, resolveUpstream, gitBlob } from './upstream-content.mjs';

const root = process.cwd();
const cache = path.resolve('.cache/upstream-content');
const planFile = path.join(cache, 'plan.json');
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
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
const mode = process.argv[2];
if (mode && !['--plan', '--apply'].includes(mode)) throw new Error('Unknown content update mode');
const plan =
  mode === '--apply' ? JSON.parse(await fs.readFile(planFile, 'utf8')) : await resolveUpstream(api);
if (
  plan.schema !== 'hsr-upstream-plan.v1' ||
  plan.repository !== REPOSITORY ||
  !/^[a-f0-9]{40}$/.test(plan.commit)
)
  throw new Error('Invalid upstream plan');
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
        !/^(TextMap\/TextMapKR(?:_\d+)?|ExcelOutput\/(?:NounAtlas|NounAtlasChangeInfo|TalkSentenceConfig|MissionChapterConfig))\.json$/.test(
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
  await fs.mkdir(path.join(stage, 'src/data'), { recursive: true });
  await fs.mkdir(path.join(stage, 'public/content'), { recursive: true });
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
  run('import-train-databank.py', [raw, planFile]);
  run('import-astropolis-intro.py', [raw, planFile]);
  run('project-upstream-content.py', [root, raw, planFile], stage);
  const receipt = JSON.parse(await fs.readFile(path.join(stage, 'receipt.json'), 'utf8'));
  // The projector validates every payload and metadata reference before any publication.
  for (const file of receipt.files) {
    if (
      !/^(?:src\/data\/(?:codex|simulation|imported-content|train-databank|astropolis-intro)\.json|public\/content-update\.json|public\/content\/[A-Za-z0-9_-]+\.json)$/.test(
        file,
      )
    )
      throw new Error(`Invalid publication path: ${file}`);
  }
  for (const file of receipt.files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(stage, file), path.join(root, file));
  }
  console.log(`Verified and applied ${plan.version}: ${receipt.rows} rows`);
}
