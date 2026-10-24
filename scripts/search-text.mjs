import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pythonRunner } from './content-process.mjs';
import { gitBlob, REPOSITORY } from './upstream-content.mjs';
import { applyDerivedChanges } from './verification-state.mjs';
import { collectSearchSources } from './search-source-collection.mjs';
import { createHash } from 'node:crypto';

export function searchRetryDue(state, now = Date.now()) {
  return (
    !(Date.parse(state?.nextRequestAt ?? '') > now) &&
    !(Date.parse(state?.nextReviewAt ?? '') > now)
  );
}

export async function refreshSearchText(root = process.cwd(), options = {}) {
  const read = async (name, fallback) =>
    JSON.parse(
      await fs.readFile(path.join(root, name)).catch((error) => {
        if (error.code !== 'ENOENT' || fallback === undefined) throw error;
        return JSON.stringify(fallback);
      }),
    );
  const plan = options.plan ?? (await read('.cache/upstream-content/plan.json'));
  const previous = await read('public/search/manifest.json', {});
  const state = await read('.cache/verification-retry/search-sources.json', {});
  const locales = await read('public/search/locales/manifest.json', {});
  const otherCatalog = await read('public/search/other-catalog.json', {});
  const otherAlgorithm = createHash('sha256');
  for (const file of ['import-other-text.py', 'bwiki-dialogue.py', 'import-localizations.py'])
    otherAlgorithm.update(await fs.readFile(path.join(root, 'scripts', file)));
  const otherChanged = otherCatalog.codeSha256 !== otherAlgorithm.digest('hex');
  const localeAlgorithm = createHash('sha256');
  for (const file of [
    'import-search-localizations.py',
    'import-localizations.py',
    'bwiki-dialogue.py',
  ])
    localeAlgorithm.update(await fs.readFile(path.join(root, 'scripts', file)));
  const localeChanged = locales.codeSha256 !== localeAlgorithm.digest('hex');
  const repositoryFile = '.cache/search-text/repository/manifest.json';
  const repository = await read(repositoryFile, {});
  const algorithm = createHash('sha256');
  for (const file of ['import-search-text.py', 'bwiki-dialogue.py', 'import-localizations.py'])
    algorithm.update(await fs.readFile(path.join(root, 'scripts', file)));
  const algorithmHash = algorithm.digest('hex');
  const replay = previous.codeSha256 !== algorithmHash;
  const sourceKey = (source) => `${source.pageId}:${source.revision}:${source.kind}`;
  const known = new Set((previous.sources ?? []).map(sourceKey));
  const repositoryImproved =
    repository.codeSha256 === algorithmHash &&
    repository.commit === plan.commit &&
    repository.sources?.some((source) => !known.has(sourceKey(source)));
  const due = searchRetryDue(state);
  if (
    plan.commit === previous.commit &&
    locales.commit === plan.commit &&
    !due &&
    !replay &&
    !otherChanged &&
    !localeChanged &&
    !repositoryImproved
  )
    return { changed: false, deferred: true };
  if (
    plan.schema !== 'hsr-upstream-plan.v1' ||
    plan.repository !== REPOSITORY ||
    !/^[a-f0-9]{40}$/.test(plan.commit)
  )
    throw Error('Invalid search update plan');
  const files = plan.files.filter(
    (f) =>
      /^TextMap\/TextMap(?:KR|EN|CHS|JP)(?:_\d+)?\.json$/.test(f.path) ||
      f.path === 'ExcelOutput/TalkSentenceConfig.json',
  );
  const stage = path.join(root, '.cache/search-text/candidate');
  const raw = path.join(stage, 'raw');
  await fs.mkdir(raw, { recursive: true });
  await fs.mkdir(path.join(stage, 'public/content'), { recursive: true });
  await fs.copyFile(
    path.join(root, 'public/content/search-index.json'),
    path.join(stage, 'public/content/search-index.json'),
  );
  for (const file of files) {
    if (!/^[a-f0-9]{40}$/.test(file.sha)) throw Error('Invalid search input hash');
    let bytes;
    for (const local of [
      path.join(root, '.cache/upstream-content/blobs', file.sha),
      path.join(root, '.cache/upstream-content/raw', path.basename(file.path)),
    ]) {
      const candidate = await fs.readFile(local).catch(() => undefined);
      if (candidate && gitBlob(candidate) === file.sha) {
        bytes = candidate;
        break;
      }
    }
    if (!bytes) {
      const response = await fetch(
        `https://raw.githubusercontent.com/${REPOSITORY}/${plan.commit}/${file.path}`,
        { signal: AbortSignal.timeout(45000) },
      );
      if (!response.ok) throw Error('Search TextMap HTTP ' + response.status);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (gitBlob(bytes) !== file.sha) throw Error('Search TextMap checksum mismatch');
    await fs.writeFile(path.join(raw, path.basename(file.path)), bytes);
  }
  const planFile = path.join(stage, 'plan.json');
  await fs.writeFile(planFile, JSON.stringify({ ...plan, files }));
  const wikiFile = path.join(stage, '.cache/search-sources/manifest.json');
  try {
    execFileSync(
      process.execPath,
      [path.join(root, 'scripts/collect-search-sources.mjs'), stage, root, planFile],
      {
        cwd: root,
        stdio: 'inherit',
        timeout: 90000,
        env: {
          ...process.env,
          ...(!due || options.cacheOnly ? { HSR_SEARCH_CACHE_ONLY: '1' } : {}),
        },
      },
    );
  } catch {
    // Replay verified cache on a timeout as well: an empty fallback would erase
    // source associations precisely when a changed parser needs revalidation.
    const fallback = await collectSearchSources(stage, root, planFile, { cacheOnly: true });
    fallback.review.push({
      reason: '검색 출처 수집 시간 초과 또는 조회 실패; 검증된 캐시만 재대조',
    });
    await fs.writeFile(wikiFile, JSON.stringify(fallback));
    const stateFile = path.join(root, '.cache/verification-retry/search-sources.json');
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const saved = JSON.parse(await fs.readFile(stateFile));
    await fs.writeFile(
      stateFile,
      JSON.stringify({ ...saved, nextReviewAt: new Date(Date.now() + 6 * 3600000).toISOString() }),
    );
  }
  const run = pythonRunner(root, stage);
  run('import-search-text.py', [
    stage,
    raw,
    planFile,
    wikiFile,
    path.join(root, 'public/search/manifest.json'),
    path.join(root, repositoryFile),
  ]);
  run('import-search-text.py', ['--validate', stage]);
  run('import-other-text.py', [
    stage,
    raw,
    planFile,
    wikiFile,
    path.join(root, 'public/search/other-catalog.json'),
    path.join(root, '.cache/search-text/repository/other-catalog.json'),
  ]);
  run('import-other-text.py', ['--validate', stage]);
  run('import-search-localizations.py', [
    stage,
    raw,
    planFile,
    wikiFile,
    path.join(root, 'public/search/locales/manifest.json'),
  ]);
  run('import-search-localizations.py', ['--validate', stage]);
  const receipt = await read('.cache/search-text/candidate/.cache/search-text-receipt.json');
  const localized = await read(
    '.cache/search-text/candidate/.cache/search-localization-receipt.json',
  );
  receipt.files.push(...localized.files);
  const other = await read('.cache/search-text/candidate/.cache/other-text-receipt.json');
  receipt.files.push(...other.files);
  // Search work cannot publish chapter rows, routes or canonical evidence.
  if (
    receipt.files.some(
      (file) =>
        !/^public\/search\/(?:(?:manifest|other-catalog|part-\d{2})|other\/other-(?:npc|interaction|message|mail|loading)-p\d+--s[a-f0-9]{16}|locales\/(?:manifest|(?:en|zh-CN|ja)\/(?:search-text--part-\d{2}|other-(?:npc|interaction|message|mail|loading)-p\d+--s[a-f0-9]{16})))\.json$/.test(
          file,
        ),
    )
  )
    throw Error('Search refresh attempted to publish outside search');
  const entries = await Promise.all(
    receipt.files.map(async (file) => ({
      path: file,
      bytes: await fs.readFile(path.join(stage, file)),
    })),
  );
  return { changed: (await applyDerivedChanges(root, entries)).length > 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await refreshSearchText();
    if (process.env.GITHUB_OUTPUT)
      await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
    console.log('Search-only refresh: ' + JSON.stringify(result));
  } catch (error) {
    // Optional search work cannot fail a successful canonical update.
    console.error('Search-only refresh deferred; published search retained: ' + error.message);
    if (process.env.GITHUB_OUTPUT)
      await fs.appendFile(process.env.GITHUB_OUTPUT, 'changed=false\n');
  }
}
