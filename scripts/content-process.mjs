import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function pythonRunner(root, stage) {
  return (script, args = [], cwd = stage) =>
    execFileSync(
      process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      [path.join(root, 'scripts', script), ...args],
      { cwd, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } },
    );
}
