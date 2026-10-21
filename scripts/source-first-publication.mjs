import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, stateFiles } from './verification-state.mjs';

export async function sealData(root) {
  const names = await stateFiles(root);
  const files = new Array(names.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < names.length) {
        const index = cursor++;
        const file = names[index];
        files[index] = { file, sha256: hash(await fs.readFile(path.join(root, file))) };
      }
    }),
  );
  return { schema: 'hsr-validated-artifact.v1', files };
}

export async function assertSealedData(root, seal, dist) {
  if (seal.schema !== 'hsr-validated-artifact.v1' || !Array.isArray(seal.files))
    throw new Error('Invalid artifact seal');
  const current = await stateFiles(root);
  if (JSON.stringify(current) !== JSON.stringify(seal.files.map((r) => r.file)))
    throw new Error('Validated artifact file set changed');
  for (const item of seal.files) {
    if (hash(await fs.readFile(path.join(root, item.file))) !== item.sha256)
      throw new Error('Validated data changed: ' + item.file);
    if (
      dist &&
      item.file.startsWith('public/') &&
      hash(await fs.readFile(path.join(dist, item.file.slice(7)))) !== item.sha256
    )
      throw new Error('Built artifact differs from validated data: ' + item.file);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = '.cache/source-first/artifact-seal.json';
  if (process.argv[2] === '--seal') {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(await sealData(process.cwd())));
  } else if (process.argv[2] === '--check-build') {
    await assertSealedData(
      process.cwd(),
      JSON.parse(await fs.readFile(file)),
      path.resolve('dist'),
    );
    console.log('Built artifact contains the same validated data; no recollection or regeneration');
  } else throw new Error('Expected --seal or --check-build');
}
