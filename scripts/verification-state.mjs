import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const SITE = 'https://moleculargastronomy1.github.io/hsrArchive/';
export const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export async function writeDerived(root, relative, bytes) {
  if (!statePath(relative)) throw new Error('Unsafe derived publication path');
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', bytes);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(file + '.tmp', file);
      break;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        attempt >= 4 ||
        !['EPERM', 'EBUSY', 'EACCES', 'UNKNOWN'].includes(error.code)
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}
export const statePath = (file) =>
  /^(?:src\/data\/(?:codex|simulation|imported-content|train-databank|astropolis-intro|books|trailblaze)\.json|public\/(?:content-update|books-provenance|trailblaze-provenance|dialogue-flow-provenance|bwiki-provenance|source-first-provenance|simulation-events-provenance|video-order-provenance|video-review-summary)\.json|public\/content\/[A-Za-z0-9_-]+\.json|public\/content\/locales\/(?:manifest|(?:en|zh-CN|ja)\/[A-Za-z0-9_-]+)\.json)$/.test(
    file,
  );

export async function stateFiles(root) {
  const found = [];
  async function visit(folder) {
    for (const item of await fs.readdir(path.join(root, folder), { withFileTypes: true })) {
      const file = `${folder}/${item.name}`;
      if (item.isDirectory()) await visit(file);
      else if (item.isFile() && statePath(file)) found.push(file);
    }
  }
  await visit('src/data');
  await visit('public');
  return found.sort();
}

export async function packState(root) {
  const files = [];
  for (const file of await stateFiles(root)) {
    const bytes = await fs.readFile(path.join(root, file));
    files.push({ path: file, sha256: hash(bytes), bytes: bytes.toString('base64') });
  }
  const update = JSON.parse(await fs.readFile(path.join(root, 'public/content-update.json')));
  const bytes = gzipSync(
    JSON.stringify({ schema: 'hsr-verification-state.v1', commit: update.commit, files }),
  );
  const sha256 = hash(bytes);
  const file = `verification-state-${sha256}.json.gz`;
  await fs.writeFile(path.join(root, 'public', file), bytes);
  const descriptor = {
    schema: 'hsr-verification-state-pointer.v1',
    commit: update.commit,
    file,
    sha256,
    files: files.length,
  };
  await fs.writeFile(path.join(root, 'public/verification-state.json'), JSON.stringify(descriptor));
  for (const name of await fs.readdir(path.join(root, 'public')))
    if (/^verification-state-[a-f0-9]{64}\.json\.gz$/.test(name) && name !== file)
      await fs.unlink(path.join(root, 'public', name));
  return descriptor;
}

export function unpackState(bytes, descriptor) {
  if (
    descriptor?.schema !== 'hsr-verification-state-pointer.v1' ||
    !/^[a-f0-9]{40}$/.test(descriptor.commit ?? '') ||
    descriptor.file !== `verification-state-${descriptor.sha256}.json.gz` ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '') ||
    hash(bytes) !== descriptor.sha256
  )
    throw new Error('Invalid published verification snapshot checksum');
  const data = JSON.parse(gunzipSync(bytes, { maxOutputLength: 400 * 1024 * 1024 }));
  if (
    data.schema !== 'hsr-verification-state.v1' ||
    data.commit !== descriptor.commit ||
    !Array.isArray(data.files) ||
    data.files.length !== descriptor.files ||
    data.files.length > 50000
  )
    throw new Error('Invalid published verification snapshot');
  const seen = new Set();
  // Validate every entry before allowing any file to be restored. Keep original
  // JSON bytes: parsing/re-serializing here would corrupt 64-bit text hashes.
  return data.files.map((item) => {
    if (!statePath(item.path) || seen.has(item.path) || typeof item.bytes !== 'string')
      throw new Error('Unsafe or duplicate verification state path');
    seen.add(item.path);
    const content = Buffer.from(item.bytes, 'base64');
    if (hash(content) !== item.sha256) throw new Error('Verification state file checksum mismatch');
    return { path: item.path, bytes: content };
  });
}

export async function restoreState(root, fetcher = fetch) {
  const response = await fetcher(SITE + 'verification-state.json', {
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error('Last deployed verification state unavailable; refusing to overwrite it');
  const descriptor = await response.json();
  if (!/^verification-state-[a-f0-9]{64}\.json\.gz$/.test(descriptor.file ?? ''))
    throw new Error('Invalid snapshot URL');
  const body = await fetcher(SITE + descriptor.file, { signal: AbortSignal.timeout(120000) });
  if (!body.ok) throw new Error('Last deployed verification snapshot unavailable');
  const entries = unpackState(Buffer.from(await body.arrayBuffer()), descriptor);
  for (const item of entries) {
    await writeDerived(root, item.path, item.bytes);
  }
  return true;
}
