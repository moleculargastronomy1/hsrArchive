import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from './verification-state.mjs';
import { publicJson } from './protected-public.mjs';

export function publicRepository(repository) {
  if (repository !== 'moleculargastronomy1/moleculargastronomy1.github.io')
    throw new Error('The approved user Pages repository is required');
  return repository;
}

// Only validated dist goes into this disposable clone. No source checkout,
// .cache, SQL, snapshot, report, Worker config or secret is copied into it.
export async function publishFrontend({
  dist,
  folder,
  repository,
  token,
  prefix = 'hsrArchive',
  remote,
}) {
  publicRepository(repository);
  if (!['hsrArchive', 'hsrArchive-preview'].includes(prefix))
    throw new Error('Invalid Pages prefix');
  const clone = path.resolve(folder);
  if (await fs.stat(clone).catch(() => false)) throw new Error('Use a fresh publisher clone');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!remote) {
    if (!token)
      throw new Error('A frontend-only GitHub App token or fine-grained token is required');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 =
      'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64');
  } else if (!path.isAbsolute(remote))
    throw new Error('Test remote must be an absolute local path');
  function git(args, cwd = clone) {
    try {
      return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      throw new Error('Frontend Git operation failed; last-success state is unchanged');
    }
  }
  await fs.mkdir(path.dirname(clone), { recursive: true });
  git(
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      'main',
      remote ?? `https://github.com/${repository}.git`,
      clone,
    ],
    path.dirname(clone),
  );
  const destination = path.join(clone, prefix);
  // Verify the exact absolute target before replacing an old public dist.
  if (
    path.dirname(destination) !== clone ||
    (await fs.lstat(destination).catch(() => null))?.isSymbolicLink()
  )
    throw new Error('Unsafe frontend destination');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(dist, destination, { recursive: true, dereference: false });
  if (!(await fs.stat(path.join(clone, '.nojekyll')).catch(() => null)))
    await fs.writeFile(path.join(clone, '.nojekyll'), '');
  git(['add', '--', prefix, '.nojekyll']);
  if (git(['diff', '--cached', '--name-only']).trim()) {
    git([
      '-c',
      'user.name=HSR Archive publisher',
      '-c',
      'user.email=hsr-archive@users.noreply.github.com',
      'commit',
      '-m',
      'Publish verified HSR Archive frontend',
    ]);
    git(['push', 'origin', 'HEAD:main']);
  }
  return git(['rev-parse', 'HEAD']).trim();
}

export async function checkLive(candidate, folder, base, fetcher = fetch) {
  const origin = new URL(base);
  if (
    origin.origin !== 'https://moleculargastronomy1.github.io' ||
    !['/hsrArchive/', '/hsrArchive-preview/'].includes(origin.pathname)
  )
    throw new Error('Unexpected public frontend origin');
  // Prove the public host serves the exact tested HTML/assets, not a stale build.
  for (const [file, checksum] of Object.entries(candidate.hashes).filter(([file]) =>
    file.startsWith('dist/'),
  )) {
    const url = new URL(file.slice(5), origin);
    url.searchParams.set('release', candidate.release);
    const response = await fetcher(url, {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || hash(Buffer.from(await response.arrayBuffer())) !== checksum)
      throw new Error('Public deployment is not the verified artifact');
  }
  const blocked = new Set([
    'content/search-index.json',
    'verification-state.json',
    candidate.snapshot.file,
    'bwiki-provenance.json',
    'dialogue-flow-provenance.json',
    'source-first-provenance.json',
    'simulation-events-provenance.json',
    'video-order-provenance.json',
    'handbook-originals.json',
    'content-watch.json',
    'verification-progress.json',
    'sw.js',
    'service-worker.js',
  ]);
  // The old snapshot has a different digest from a newly packed private snapshot.
  // Check previously observed URLs too, so an old gzip cached at Pages cannot
  // silently bypass protection after its descriptor disappears.
  const priorExposure = JSON.parse(
    await fs.readFile('docs/reports/data-exposure-before-2026-10-22.json', 'utf8'),
  );
  for (const { path: file } of priorExposure.checks)
    if (
      /^(?:content\/[A-Za-z0-9_/-]+\.json|[A-Za-z0-9_-]+\.json(?:\.gz)?)$/.test(file) &&
      !publicJson.has(file)
    )
      blocked.add(file);
  for (const file of Object.keys(candidate.hashes).filter((file) =>
    /^dist\/assets\/.+\.js$/.test(file),
  ))
    blocked.add(file.slice(5) + '.map');
  const chapters = candidate.objects
    .map((o) => o.key.slice(candidate.prefix.length + '/public/'.length))
    .filter((file) =>
      /^content\/(?:[^/]+\.json|locales\/(?:en|ja|zh-CN)\/[^/]+\.json)$/.test(file),
    );
  for (const language of ['', 'en', 'ja', 'zh-CN']) {
    const found = chapters.find((file) =>
      language
        ? file.startsWith(`content/locales/${language}/`)
        : !file.startsWith('content/locales/'),
    );
    if (found) blocked.add(found);
  }
  for (const file of blocked) {
    const response = await fetcher(new URL(file, origin), {
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 404) throw new Error('Legacy public data path is still reachable');
  }
  // folder intentionally remains private; no fallback upload of private objects.
  return {
    release: candidate.release,
    files: Object.keys(candidate.hashes).filter((file) => file.startsWith('dist/')).length,
    blocked: blocked.size,
  };
}
