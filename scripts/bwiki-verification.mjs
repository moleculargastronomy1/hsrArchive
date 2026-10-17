import path from 'node:path';

// Discovery and alignment share one order in full updates and targeted retries.
// Collection/backoff remains the caller's policy; this module never reads video data.
export function discoverBwiki(run, stage, raw, planFile) {
  for (const script of ['bwiki-dialogue.py', 'import-bwiki-chapters.py'])
    run(script, [stage, raw, planFile, '--discover']);
}

export function alignBwiki(run, stage, raw, planFile, previousRoot) {
  for (const script of ['bwiki-dialogue.py', 'import-bwiki-chapters.py'])
    run(script, [
      stage,
      raw,
      planFile,
      path.join(stage, '.cache/bwiki/manifest.json'),
      previousRoot,
    ]);
}
