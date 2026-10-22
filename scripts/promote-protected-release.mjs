// Run only after the matching frontend deployment and live checks succeed.
import fs from 'node:fs/promises';
const candidate = JSON.parse(await fs.readFile('.cache/protected/candidate.json'));
const {
  HSR_PRIVATE_STATE_URL: base,
  HSR_PRIVATE_STATE_TOKEN: token,
  HSR_EXPECTED_PREVIOUS_RELEASE: previous,
} = process.env;
if (
  process.argv[2] !== '--deployed' ||
  !base?.startsWith('https://') ||
  !token ||
  previous === undefined
)
  throw new Error(
    'Successful matching deployment and an explicit previous release (empty for bootstrap) are required',
  );
const response = await fetch(new URL('/internal/promote', base), {
  method: 'POST',
  redirect: 'error',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ release: candidate.release, expectedPrevious: previous || null }),
});
if (!response.ok)
  throw new Error('Publication promotion failed; do not discard the previous successful release');
console.log(
  'Successful-release pointer advanced idempotently; prior private objects are retained.',
);
