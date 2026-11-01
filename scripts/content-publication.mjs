import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath, applyDerivedChanges } from './verification-state.mjs';
import { pythonRunner } from './content-process.mjs';
import { buildChineseSearch, chineseSearchFile } from './build-chinese-search.mjs';

export async function validateContentStage(root, stage) {
  // Full imports, scheduled retries and scoped verification share this boundary.
  // A restored index belongs to the old corpus, so rebuild it before validation
  // and include it in the same atomic publication as the updated comparisons.
  await buildChineseSearch(stage);
  // The projector runs before external verification. Recheck the final search,
  // routes, branch references and localization IDs after all integrations.
  pythonRunner(root, stage)('validate-content-stage.py', [stage]);
}

export async function publishContentStage(root, stage, files) {
  await validateContentStage(root, stage);
  await publishDerivedFiles(root, stage, [...files, chineseSearchFile]);
}

export async function publishDerivedFiles(root, stage, files, options = {}) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !statePath(file)))
    throw new Error('Unsafe content publication path');
  const entries = [];
  // Read every candidate before changing any destination. A late missing or
  // unsafe receipt entry must never leave a half-applied update.
  for (const file of new Set(files)) {
    const bytes = await fs.readFile(path.join(stage, file));
    entries.push({ path: file, bytes });
  }
  await applyDerivedChanges(root, entries, {
    // Preserve the publisher's established no-op rule for JSON trailing space.
    // Snapshot restoration uses the transaction's byte-exact default instead.
    unchanged: (previous, bytes) =>
      previous?.toString('utf8').trimEnd() === bytes.toString('utf8').trimEnd(),
    ...options,
  });
}
