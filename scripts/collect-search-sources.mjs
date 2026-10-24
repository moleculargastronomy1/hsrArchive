import path from 'node:path';
import { collectSearchSources } from './search-source-collection.mjs';
const root = path.resolve(process.argv[3] ?? process.cwd());
await collectSearchSources(
  path.resolve(process.argv[2] ?? root),
  root,
  process.argv[4] ?? path.join(root, '.cache/upstream-content/plan.json'),
);
