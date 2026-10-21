import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { contentRefreshMode } from './content-refresh-mode.mjs';
const read = async (file) => JSON.parse(await fs.readFile(file));
const watch = await read('.cache/content-watch/check.json');
const plan = await read('.cache/upstream-content/plan.json');
const previous = await read('public/content-update.json');
const title = process.env.HSR_TRAILBLAZE_TITLE?.trim();
const mode = title ? '--retry' : contentRefreshMode(plan, previous, watch);
try {
  if (title && plan.commit !== previous.commit)
    throw new Error('Targeted BWIKI retry requires the current deployed official input version');
  if (mode === '--site-only') {
    // The workflow validates/tests the restored snapshot before building. Do not
    // collect, project text, or acknowledge newly observed source revisions.
    if (process.env.GITHUB_OUTPUT)
      await fs.appendFile(process.env.GITHUB_OUTPUT, 'publish=true\nsite_only=true\n');
    const file = '.cache/verification-retry/run.json';
    const journal = await read(file).catch(() => ({}));
    await fs.mkdir('.cache/verification-retry', { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        ...journal,
        checkedAt: new Date().toISOString(),
        mode: 'site-only',
        status: 'skipped',
        reason: 'source-deployment; validated content reused; source revisions unacknowledged',
        newlyVerified: 0,
        changed: false,
      }),
    );
    console.log('Site-only build: reusing validated content without collection or text projection');
  } else {
    execFileSync(
      process.execPath,
      ['scripts/update-content.mjs', mode, ...(title ? ['--title', title] : [])],
      {
        stdio: 'inherit',
        env: process.env,
      },
    );
  }
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
