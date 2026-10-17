import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('integration audit rejects unsupported IDs, missing source evidence, role mismatches and fabricated branch counts', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_integration_audit.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});
