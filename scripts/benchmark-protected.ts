// Local CPU observations are not Cloudflare CPU accounting or a free-tier guarantee.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rendered } from '../worker/service.ts';
import { makeStore } from '../worker/index.ts';

const folder = path.resolve('.cache/protected');
const candidate = JSON.parse(await fs.readFile(path.join(folder, 'candidate.json'), 'utf8'));
const chapters = candidate.objects
  .filter(
    (object: any) =>
      /\/public\/content\/[^/]+\.json$/.test(object.key) &&
      !object.key.endsWith('/search-index.json'),
  )
  .sort((a: any, b: any) => b.size - a.size)
  .slice(0, 3);
const results: any[] = [];
for (const chapter of chapters) {
  const bytes = await fs.readFile(path.join(folder, 'r2', chapter.key), 'utf8');
  const samples = [];
  let rows = 0;
  for (let index = 0; index < 8; index++) {
    const start = process.cpuUsage();
    rows = rendered(JSON.parse(bytes)).length;
    const cpu = process.cpuUsage(start);
    samples.push((cpu.user + cpu.system) / 1000);
  }
  samples.sort((a, b) => a - b);
  results.push({
    file: chapter.key.split('/public/')[1],
    bytes: chapter.size,
    rows,
    localCpuMedianMs: samples[4],
    localCpuMaxMs: samples[7],
  });
}
const db = new DatabaseSync(path.join(folder, 'search.sqlite'), { readOnly: true });
const store = makeStore(
  {
    SEARCH: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            return {
              async first() {
                return db.prepare(sql).get(...args);
              },
              async all() {
                return { results: db.prepare(sql).all(...args) };
              },
            };
          },
        };
      },
    },
  } as any,
  candidate.release,
);
const searches = [];
for (const query of ['나', '개척자', '없는문자열xyz']) {
  const start = process.cpuUsage();
  const result = await store.search(query, 'all', 1);
  const cpu = process.cpuUsage(start);
  searches.push({ query, total: result.total, localCpuMs: (cpu.user + cpu.system) / 1000 });
}
db.close();
const report = {
  schema: 'hsr-local-cost-observation.v1',
  productionMetered: false,
  release: candidate.release,
  chapters: results,
  searches,
};
await fs.writeFile('.cache/local-cost-observation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
