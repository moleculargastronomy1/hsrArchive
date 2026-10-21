import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isWikiReading, readingRows } from '../src/lib/wiki-reading.ts';

const args = process.argv.slice(2);
const arg = (flag: string, fallback: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const root = path.resolve(arg('--data', '.'));
const work = path.resolve(arg('--work', '.cache/wiki-placement/full'));
const output = path.resolve(arg('--output', '.cache/wiki-placement/exports'));
const report = JSON.parse(await fs.readFile(path.join(work, 'report.json'), 'utf8'));
if (report.status !== 'completed') throw Error('Use a completed isolated audit');
await fs.mkdir(output, { recursive: true });
const orders = {};
for (const chapter of report.chapters) {
  const payload = JSON.parse(await fs.readFile(path.join(root, 'public', chapter.file), 'utf8'));
  if (!isWikiReading(payload.wikiReading, payload.rows))
    throw Error('Invalid site positions: ' + chapter.file);
  orders[chapter.file] = readingRows(payload.rows, payload.wikiReading).map((row, i) => ({
    siteOrder: i + 1,
    page: Math.floor(i / 50) + 1,
    rowId: row.id,
    occurrenceId: row.wikiPosition?.id,
    kind: row.wikiPosition
      ? 'wiki'
      : row.wikiLegacy
        ? 'legacy'
        : row.wikiUnplaced?.id.startsWith('chapter-intro-')
          ? 'intro'
          : 'unknown',
  }));
}
const orderFile = path.join(output, 'site-order.json');
await fs.writeFile(orderFile, JSON.stringify(orders));
execFileSync(
  process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  [
    path.resolve('scripts/export-bwiki-comparison.py'),
    '--data',
    root,
    '--work',
    work,
    '--output',
    output,
    '--site-order',
    orderFile,
    '--archive-commit',
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  ],
  { stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } },
);
