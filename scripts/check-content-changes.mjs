import fs from 'node:fs/promises';
import path from 'node:path';
import { checkSources, makeSnapshot, readPublishedSnapshot } from './content-change.mjs';

const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const config = await read('editorial/video-verification-sources.json');
const mode = process.argv[2];
if (config.schema !== 'hsr-video-sources.v1') throw new Error('Invalid watch configuration');
if (mode === '--record') {
  const previous = await readPublishedSnapshot().catch(() => undefined);
  const snapshot = makeSnapshot({
    update: await read('public/content-update.json'),
    wiki: await read('public/bwiki-provenance.json'),
    manifest: await read('.cache/upstream-content/stage/.cache/bwiki/manifest.json'),
    video: await read('public/video-order-provenance.json'),
    official: await read('public/official-videos.json'),
    config,
    previous,
  });
  // It becomes the next baseline only if this build is successfully deployed.
  await fs.writeFile('public/content-watch.json.tmp', JSON.stringify(snapshot));
  await fs.rename('public/content-watch.json.tmp', 'public/content-watch.json');
  console.log(`Recorded processed source metadata: ${snapshot.wiki.length} BWIKI titles`);
} else if (!mode || mode === '--check' || mode === '--force') {
  let result;
  if (mode === '--force') result = { changed: true, checks: { source: 'requested-build' } };
  else {
    try {
      const previous = await readPublishedSnapshot();
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      result = await checkSources(previous, config, { headers });
    } catch {
      result = { changed: false, checks: { snapshot: 'unavailable' } };
    }
  }
  await fs.mkdir(path.resolve('.cache/content-watch'), { recursive: true });
  await fs.writeFile('.cache/content-watch/check.json', JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### 자료 변경 확인\n\n${result.changed ? '변경 감지: 전체 갱신을 실행합니다.' : '새 변경을 확인하지 못해 전체 갱신·빌드·배포를 생략합니다.'}\n\n` +
        Object.entries(result.checks)
          .map(([name, status]) => `- ${name}: ${status}`)
          .join('\n') +
        '\n\n조회 실패(unavailable)는 변경 없음으로 확정하지 않고 다음 주기에 다시 확인합니다.\n',
    );
  console.log(JSON.stringify(result));
} else throw new Error('Unknown content watch argument');
