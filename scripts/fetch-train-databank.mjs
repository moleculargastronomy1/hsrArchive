import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const commit = '724b139d8c9c32d12552eb95745a4fee72bfe48b';
const base = `https://raw.githubusercontent.com/DimbreathBot/TurnBasedGameData/${commit}/`;
const targetRoot = '.cache/train-databank';
const files = [
  ['ExcelOutput/NounAtlas.json', '94e9cbdaf840e8bccbe229b923e7ab48d752a7e8'],
  ['ExcelOutput/NounAtlasChangeInfo.json', '263c21d468db03252487ba8ce8429f32fbdc381f'],
  ['TextMap/TextMapKR_0.json', '4c4adcf4ed86c48ebb407442801f3b3dd396eb19'],
  ['TextMap/TextMapKR_1.json', '80eee947e1dc31577209e39d841ad2eb127541e0'],
];
await fs.mkdir(targetRoot, { recursive: true });
await Promise.all(
  files.map(async ([name, expected]) => {
    const target = `${targetRoot}/${name.split('/').at(-1)}`;
    let bytes;
    try {
      bytes = await fs.readFile(target);
    } catch {}
    if (!bytes) {
      const response = await fetch(base + name, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const actual = crypto
      .createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (actual !== expected) throw new Error(`Pinned Git blob mismatch: ${name}`);
    await fs.writeFile(target, bytes);
    console.log(`Verified ${name}`);
  }),
);
