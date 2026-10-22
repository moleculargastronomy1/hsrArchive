// Activated only by the approved private source workflow. No plan upgrades,
// R2 creation, token creation, visibility changes or repo creation happen here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkCandidate } from './check-protected-candidate.mjs';
import { publishFrontend, publicRepository, checkLive } from './protected-publisher.mjs';

export function assertPublishingMode(env) {
  const mode = env.HSR_DATA_MODE ?? '';
  if (
    !['true', 'false'].includes(env.SOURCE_IS_PRIVATE) ||
    !['', 'static', 'protected'].includes(mode)
  )
    throw new Error('Unknown source visibility or publishing mode');
  if (env.SOURCE_IS_PRIVATE === 'true' || mode === 'protected') {
    if (
      env.SOURCE_IS_PRIVATE !== 'true' ||
      mode !== 'protected' ||
      !env.API_URL?.startsWith('https://') ||
      !env.HSR_PRIVATE_STATE_TOKEN
    )
      throw new Error(
        'Private source requires configured protected publishing; refusing a static data fallback',
      );
  }
}

export function workerConfiguration({
  candidate,
  settings,
  previous,
  database,
  account,
  name,
  bucket,
}) {
  if (
    !/^[a-f0-9]{32}$/.test(account) ||
    !/^[a-z0-9-]{1,63}$/.test(name) ||
    !/^[a-z0-9-]{3,63}$/.test(bucket)
  )
    throw new Error('Approved Worker account/name/private bucket settings are required');
  const bindings = settings.bindings ?? [];
  const value = (key) => bindings.find((binding) => binding.name === key);
  const oldRelease = value('DATA_RELEASE')?.text;
  const olderRelease = value('PREVIOUS_RELEASE')?.text;
  const databaseId = (binding) => binding?.id ?? binding?.database_id;
  const oldDb =
    previous === oldRelease
      ? databaseId(value('SEARCH'))
      : previous === olderRelease
        ? databaseId(value('SEARCH_PREVIOUS'))
        : null;
  if (previous && !oldDb)
    throw new Error('The last successful search database must remain available');
  const origins = value('ALLOWED_ORIGINS')?.text;
  if (!origins?.split(',').includes('https://moleculargastronomy1.github.io'))
    throw new Error('Archive origin is not configured');
  const vars = { DATA_RELEASE: candidate.release, ALLOWED_ORIGINS: origins };
  for (const key of ['RATE_POLICY', 'TURNSTILE_SITE_KEY'])
    if (value(key)?.text) vars[key] = value(key).text;
  if (previous) vars.PREVIOUS_RELEASE = previous;
  return {
    name,
    account_id: account,
    main: 'index.ts',
    compatibility_date: '2026-10-22',
    workers_dev: true,
    preview_urls: false,
    vars,
    r2_buckets: [{ binding: 'DATA', bucket_name: bucket }],
    d1_databases: [
      { binding: 'SEARCH', database_name: database.name, database_id: database.uuid },
      ...(previous
        ? [{ binding: 'SEARCH_PREVIOUS', database_name: 'last-success-search', database_id: oldDb }]
        : []),
    ],
    durable_objects: {
      bindings: [
        { name: 'GUARD', class_name: 'RequestGuard' },
        { name: 'RELEASES', class_name: 'ReleaseCoordinator' },
      ],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RequestGuard', 'ReleaseCoordinator'] }],
    ratelimits: [{ name: 'EDGE_LIMIT', namespace_id: '1001', simple: { limit: 1200, period: 60 } }],
    observability: { enabled: true, logs: { invocation_logs: false, head_sampling_rate: 1 } },
  };
}
export function deploymentEnvironment(env) {
  const {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: token,
    HSR_PRIVATE_STATE_URL: api,
    HSR_PRIVATE_STATE_TOKEN: internal,
    HSR_WORKER_NAME: name,
    HSR_R2_BUCKET: bucket,
    HSR_FRONTEND_REPOSITORY: repository,
    HSR_FRONTEND_TOKEN: frontendToken,
  } = env;
  publicRepository(repository);
  if (
    !/^[a-f0-9]{32}$/.test(account ?? '') ||
    !/^[a-z0-9-]{1,63}$/.test(name ?? '') ||
    !/^[a-z0-9-]{3,63}$/.test(bucket ?? '')
  )
    throw new Error('Approved Worker account/name/private bucket settings are required');
  const url = new URL(api);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !token ||
    !internal ||
    !frontendToken
  )
    throw new Error('Authenticated approved deployment configuration is incomplete');
  return { account, token, api, internal, name, bucket, repository, frontendToken };
}
export function inactiveSearchSlot(settings, databases) {
  for (const binding of (settings.bindings ?? []).filter(
    (binding) => binding.type === 'd1' || ['SEARCH', 'SEARCH_PREVIOUS'].includes(binding.name),
  ))
    if (typeof (binding.id ?? binding.database_id) !== 'string')
      throw new Error('Cannot identify a serving database; refusing to reset any slot');
  const active = new Set(
    (settings.bindings ?? [])
      .filter(
        (binding) => binding.type === 'd1' || ['SEARCH', 'SEARCH_PREVIOUS'].includes(binding.name),
      )
      .map((binding) => binding.id ?? binding.database_id),
  );
  for (let index = 0; index < 3; index++) {
    const name = `hsr-search-slot-${index}`;
    const existing = databases.find((database) => database.name === name);
    if (!existing || !active.has(existing.uuid)) return { name, existing };
  }
  throw new Error('No inactive search slot; preserve all serving databases');
}
export function assertPrivateBucket(managed, custom) {
  if (
    managed?.enabled !== false ||
    !Array.isArray(custom?.domains) ||
    custom.domains.some((domain) => domain.enabled !== false)
  )
    throw new Error('R2 public access must be disabled before uploading any private data');
}
export async function deploy(env = process.env, fetcher = fetch) {
  const config = deploymentEnvironment(env);
  const candidate = await checkCandidate(process.cwd(), path.resolve('.cache/protected'));
  if (new URL(candidate.endpoint).origin !== new URL(config.api).origin)
    throw new Error('Candidate uses another API origin');
  // Must run in the private source repository. Accidentally enabling protected
  // mode in a public fork cannot upload its private state/artifacts or publish.
  const repo = await fetcher('https://api.github.com/repos/moleculargastronomy1/hsrArchive', {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    redirect: 'error',
  });
  if (!repo.ok || (await repo.json()).private !== true)
    throw new Error('Protected publishing requires the private source repository');
  const cf = async (suffix, method = 'GET', body) => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${config.account}/${suffix}`,
      {
        method,
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
      },
    );
    const value = await response.json();
    if (!response.ok || !value.success)
      throw new Error(
        'Cloudflare operation failed; preserve the prior release and inspect the account dashboard',
      );
    return value.result;
  };
  const baseline = await fetcher(new URL('/internal/release', config.api), {
    headers: { Authorization: `Bearer ${config.internal}` },
    redirect: 'error',
  });
  if (!baseline.ok) throw new Error('Authenticated last-success state is unavailable');
  const previous = (await baseline.json()).release;
  const settings = await cf(`workers/scripts/${config.name}/settings`);
  assertPrivateBucket(
    await cf(`r2/buckets/${config.bucket}/domains/managed`),
    await cf(`r2/buckets/${config.bucket}/domains/custom`),
  );
  if (previous === candidate.release) {
    await checkLive(
      candidate,
      '.cache/protected',
      'https://moleculargastronomy1.github.io/hsrArchive/',
      fetcher,
    );
    return;
  }
  const databases = await cf('d1/database?per_page=100');
  if (databases.length >= 100)
    throw new Error('Review database retention before creating another release');
  const slot = inactiveSearchSlot(settings, databases);
  const database = slot.existing ?? (await cf('d1/database', 'POST', { name: slot.name }));
  const worker = workerConfiguration({ candidate, settings, previous, database, ...config });
  await fs.writeFile('worker/wrangler.jsonc', JSON.stringify(worker, null, 2));
  const run = (args, extra = {}) =>
    execFileSync(process.execPath, args, {
      stdio: 'inherit',
      env: { ...env, ...extra, WRANGLER_SEND_METRICS: 'false' },
    });
  // Only the third, unbound slot is reset. Both serving search databases remain intact.
  run([
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'execute',
    database.name,
    '--remote',
    '--config',
    'worker/wrangler.jsonc',
    '--command',
    'DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_rows;',
  ]);
  run(['scripts/upload-protected-candidate.mjs', '--upload'], { HSR_D1_DATABASE: database.name });
  run([
    'node_modules/wrangler/bin/wrangler.js',
    'deploy',
    '--config',
    'worker/wrangler.jsonc',
    '--keep-vars',
  ]);
  await publishFrontend({
    dist: '.cache/protected/dist',
    folder: '.cache/protected/publisher-' + Date.now(),
    repository: config.repository,
    token: config.frontendToken,
  });
  let verified = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await checkLive(
        candidate,
        '.cache/protected',
        'https://moleculargastronomy1.github.io/hsrArchive/',
        fetcher,
      );
      verified = true;
      break;
    } catch {
      if (attempt < 59) {
        console.log('Waiting for the verified public Pages artifact and legacy-path removal');
        await new Promise((resolve) => setTimeout(resolve, 15000));
      }
    }
  }
  if (!verified) throw new Error('Live verification failed; last-success pointer is unchanged');
  run(['scripts/promote-protected-release.mjs', '--deployed'], {
    HSR_EXPECTED_PREVIOUS_RELEASE: previous ?? '',
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--deploy')
    throw new Error('Use --deploy only after first activation approval');
  await deploy();
}
