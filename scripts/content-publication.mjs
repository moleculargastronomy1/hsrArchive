import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath, writeDerived } from './verification-state.mjs';
import { pythonRunner } from './content-process.mjs';

export async function publishContentStage(root, stage, files) {
  // The projector runs before external verification. Recheck the final search,
  // routes, branch references and localization IDs after all integrations.
  pythonRunner(root, stage)('validate-content-stage.py', [stage]);
  await publishDerivedFiles(root, stage, files);
}

export async function publishDerivedFiles(root, stage, files, { write = writeDerived } = {}) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !statePath(file)))
    throw new Error('Unsafe content publication path');
  const changes = [];
  // Read every candidate before changing any destination. A late missing or
  // unsafe receipt entry must never leave a half-applied update.
  for (const file of new Set(files)) {
    const bytes = await fs.readFile(path.join(stage, file));
    const previous = await fs.readFile(path.join(root, file)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (previous?.toString('utf8').trimEnd() === bytes.toString('utf8').trimEnd()) continue;
    changes.push({ file, bytes, previous });
  }
  const attempted = [];
  try {
    for (const item of changes) {
      attempted.push(item);
      await write(root, item.file, item.bytes);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of attempted.reverse()) {
      try {
        if (item.previous) await write(root, item.file, item.previous);
        else await fs.rm(path.join(root, item.file), { force: true });
        await fs.rm(path.join(root, item.file + '.tmp'), { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length)
      throw new AggregateError([error, ...rollbackErrors], 'Content write and rollback failed');
    throw error;
  }
}
