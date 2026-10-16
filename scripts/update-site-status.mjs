import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// Use the source revision's date so a scheduled rebuild does not invent a site edit.
const [commit, updatedAt] = execFileSync('git', ['log', '-1', '--format=%H%n%cI'], {
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/);
if (!/^[a-f0-9]{40}$/.test(commit) || Number.isNaN(Date.parse(updatedAt)))
  throw new Error('Unable to determine archive source update date');
await fs.writeFile(
  'public/site-update.json',
  JSON.stringify({ schema: 'hsr-site-update.v1', commit, updatedAt }, null, 2) + '\n',
);
