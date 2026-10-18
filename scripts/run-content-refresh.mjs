import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { contentRefreshMode, requestedSiteBuild } from './content-refresh-mode.mjs';
const read = async (file) => JSON.parse(await fs.readFile(file));
const watch = await read('.cache/content-watch/check.json');
const plan = await read('.cache/upstream-content/plan.json');
const previous = await read('public/content-update.json');
const mode = contentRefreshMode(plan, previous);
try {
  execFileSync(process.execPath, ['scripts/update-content.mjs', mode], {
    stdio: 'inherit',
    env: process.env,
  });
  // Source/UI changes still need deployment when there is no new dialogue
  // evidence. They never force a full text projection of the same input.
  if (requestedSiteBuild(watch) && process.env.GITHUB_OUTPUT)
    await fs.appendFile(process.env.GITHUB_OUTPUT, 'publish=true\n');
} catch (error) {
  const file = '.cache/verification-retry/run.json';
  let before = {};
  try {
    before = await read(file);
  } catch {}
  await fs.mkdir('.cache/verification-retry', { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      ...before,
      checkedAt: new Date().toISOString(),
      mode,
      status: 'failed',
      newlyVerified: 0,
      failure: 'verification-pipeline-failed; deployed data preserved',
      changed: false,
    }),
  );
  process.exitCode = error.status || 1;
}
