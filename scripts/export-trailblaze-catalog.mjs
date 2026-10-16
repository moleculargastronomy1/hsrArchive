import fs from 'node:fs';
import { archive } from '../src/data/archive.ts';

fs.writeFileSync(
  process.argv[2],
  JSON.stringify(archive.filter((entry) => entry.category === 'trailblaze')),
);
