import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const SITE = 'https://moleculargastronomy1.github.io/hsrArchive/';
export const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_SNAPSHOT_BYTES = 768 * 1024 * 1024;
export class PublishedStateUnavailable extends Error {
  constructor(message, options) {
    super(message, options);
    this.code = 'PUBLISHED_STATE_UNAVAILABLE';
  }
}

async function publishedRequest(operation) {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof TypeError || ['AbortError', 'TimeoutError'].includes(cause?.name))
      throw new PublishedStateUnavailable('Published state request deferred', { cause });
    throw cause;
  }
}

async function fetchPublished(fetcher, url, options) {
  const response = await publishedRequest(() => fetcher(url, options));
  if ([408, 429, 500, 502, 503, 504].includes(response.status))
    throw new PublishedStateUnavailable(
      'Published state HTTP ' + response.status + '; retry later',
    );
  return response;
}
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
  /^public\/search\/locales\/(?:manifest|(?:en|zh-CN|ja)\/search-text--part-(?:0\d|[12]\d|3[01]))\.json$/.test(file) ||
  /^public\/search\/(?:manifest|part-(?:0\d|[12]\d|3[01]))\.json$/.test(file) ||
  /^(?:src\/data\/(?:codex|simulation|imported-content|train-databank|astropolis-intro|books|trailblaze)\.json|public\/(?:content-update|content-watch|official-videos|books-provenance|trailblaze-provenance|dialogue-flow-provenance|bwiki-provenance|source-first-provenance|simulation-events-provenance|video-order-provenance|video-review-summary|verification-progress)\.json|public\/content\/[A-Za-z0-9_-]+\.json|public\/content\/locales\/(?:manifest|(?:en|zh-CN|ja)\/[A-Za-z0-9_-]+)\.json)$/.test(
    file,
  );

// One transaction boundary for both published snapshots and new derived data.
// Read every target first; a later write failure restores exact previous bytes.
export async function applyDerivedChanges(
  root,
  entries,
  { write = writeDerived, unchanged = (previous, bytes) => previous?.equals(bytes) } = {},
) {
  const seen = new Set(),
    changes = [];
  for (const entry of entries) {
    if (!statePath(entry.path) || seen.has(entry.path) || !Buffer.isBuffer(entry.bytes))
      throw new Error('Unsafe or duplicate derived transaction entry');
    seen.add(entry.path);
    const previous = await fs.readFile(path.join(root, entry.path)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!unchanged(previous, entry.bytes)) changes.push({ ...entry, previous });
  }
  const attempted = [];
  try {
    for (const entry of changes) {
      attempted.push(entry);
      await write(root, entry.path, entry.bytes);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of attempted.reverse()) {
      try {
        if (entry.previous) await write(root, entry.path, entry.previous);
        else await fs.rm(path.join(root, entry.path), { force: true });
        await fs.rm(path.join(root, entry.path + '.tmp'), { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length)
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Derived transaction and rollback failed',
      );
    throw error;
  }
  return changes.map((entry) => entry.path);
}

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
  // Parse one file per line on restore, avoiding V8's single-string size limit.
  const parts = [Buffer.from(JSON.stringify({
    schema: 'hsr-verification-state.v2', commit: update.commit, files: files.length,
  }) + '\n'), ...files.map(file => Buffer.from(JSON.stringify(file) + '\n'))];
  const size = parts.reduce((n, part) => n + part.length, 0);
  if (size > MAX_SNAPSHOT_BYTES) throw Error('Verification snapshot exceeds the restore size limit');
  const bytes = gzipSync(Buffer.concat(parts, size));
  const sha256 = hash(bytes);
  const file = `verification-state-${sha256}.json.gz`;
  const descriptor = {
    schema: 'hsr-verification-state-pointer.v1',
    commit: update.commit,
    file,
    sha256,
    files: files.length,
  };
  // A successful build must never publish a snapshot its own restore cannot read.
  unpackState(bytes, descriptor);
  await fs.writeFile(path.join(root, 'public', file), bytes);
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
  const inflated = gunzipSync(bytes, { maxOutputLength: MAX_SNAPSHOT_BYTES });
  const newline = inflated.indexOf(10);
  let header;
  if (newline >= 0) {
    try { header = JSON.parse(inflated.subarray(0, newline).toString()); } catch { /* Legacy JSON may be pretty-printed. */ }
  }
  const data = header?.schema === 'hsr-verification-state.v2' ? header : JSON.parse(inflated.toString());
  const count = Array.isArray(data.files) ? data.files.length : data.files;
  if (
    !['hsr-verification-state.v1', 'hsr-verification-state.v2'].includes(data.schema) ||
    data.commit !== descriptor.commit ||
    !Number.isSafeInteger(count) || count !== descriptor.files || count > 50000 || count < 0 ||
    (data.schema === 'hsr-verification-state.v1' && !Array.isArray(data.files)) ||
    (data.schema === 'hsr-verification-state.v2' && !Number.isSafeInteger(data.files))
  )
    throw new Error('Invalid published verification snapshot');
  function* records() {
    if (data.schema === 'hsr-verification-state.v1') { yield* data.files; return; }
    let start = newline + 1;
    while (start < inflated.length) {
      const end = inflated.indexOf(10, start);
      if (end < 0) throw Error('Truncated verification snapshot record');
      yield JSON.parse(inflated.subarray(start, end).toString());
      start = end + 1;
    }
  }
  const seen = new Set();
  // Validate every entry before allowing any file to be restored. Keep original
  // JSON bytes: parsing/re-serializing here would corrupt 64-bit text hashes.
  const entries = [];
  for (const item of records()) {
    if (!statePath(item.path) || seen.has(item.path) || typeof item.bytes !== 'string')
      throw new Error('Unsafe or duplicate verification state path');
    seen.add(item.path);
    const content = Buffer.from(item.bytes, 'base64');
    if (hash(content) !== item.sha256) throw new Error('Verification state file checksum mismatch');
    entries.push({ path: item.path, bytes: content });
  }
  if (entries.length !== count) throw Error('Invalid verification snapshot record count');
  return entries;
}

export async function fetchState(fetcher = fetch) {
  const response = await fetchPublished(fetcher, SITE + 'verification-state.json', {
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error('Last deployed verification state unavailable; refusing to overwrite it');
  const descriptor = await publishedRequest(() => response.json());
  if (!/^verification-state-[a-f0-9]{64}\.json\.gz$/.test(descriptor.file ?? ''))
    throw new Error('Invalid snapshot URL');
  const body = await fetchPublished(fetcher, SITE + descriptor.file, {
    signal: AbortSignal.timeout(120000),
  });
  if (body.status === 404)
    throw new PublishedStateUnavailable('Published snapshot unavailable; retry later');
  if (!body.ok) throw new Error('Last deployed verification snapshot unavailable');
  const entries = unpackState(
    Buffer.from(await publishedRequest(() => body.arrayBuffer())),
    descriptor,
  );
  return { descriptor, entries };
}

export async function restoreState(root, fetcher = fetch, options = {}) {
  const state = await fetchState(fetcher);
  if (!state) return false;
  await applyDerivedChanges(root, state.entries, options);
  return true;
}
