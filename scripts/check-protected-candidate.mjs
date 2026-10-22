import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from './verification-state.mjs';
import { assertSealedData } from './source-first-publication.mjs';
import { auditProtected } from './check-protected-exposure.mjs';

export async function checkCandidate(root, folder) {
  const candidate = JSON.parse(await fs.readFile(path.join(folder, 'candidate.json')));
  if (
    candidate.schema !== 'hsr-protected-candidate.v1' ||
    !/^[a-f0-9]{64}$/.test(candidate.release) ||
    candidate.prefix !== `releases/${candidate.release}`
  )
    throw new Error('Invalid candidate');
  if (
    hash(
      JSON.stringify({
        seal: candidate.seal,
        code: candidate.code,
        schema: 'hsr-private-release.v1',
      }),
    ) !== candidate.release
  )
    throw new Error('Candidate identity differs from its validated inputs');
  await assertSealedData(root, candidate.seal);
  for (const item of candidate.code)
    if (hash(await fs.readFile(path.join(root, item.file))) !== item.sha256)
      throw new Error('Serving code changed after validation');
  for (const [file, checksum] of Object.entries(candidate.hashes)) {
    if (
      file.includes('..') ||
      path.isAbsolute(file) ||
      !/^(?:dist\/|search\.(?:sqlite|sql)$)/.test(file)
    )
      throw new Error('Unsafe candidate artifact');
    if (hash(await fs.readFile(path.join(folder, file))) !== checksum)
      throw new Error('Candidate artifact changed: ' + file);
  }
  for (const object of candidate.objects) {
    if (
      !object.key.startsWith(candidate.prefix + '/') ||
      object.key.includes('..') ||
      object.key.includes('\\')
    )
      throw new Error('Unsafe object path');
    const bytes = await fs.readFile(path.join(folder, 'r2', object.key));
    if (bytes.length !== object.size || hash(bytes) !== object.sha256)
      throw new Error('Private object changed: ' + object.key);
  }
  await auditProtected(root, path.join(folder, 'dist'));
  return candidate;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const candidate = await checkCandidate(process.cwd(), path.resolve('.cache/protected'));
  console.log(JSON.stringify({ release: candidate.release, result: 'same-validated-artifacts' }));
}
