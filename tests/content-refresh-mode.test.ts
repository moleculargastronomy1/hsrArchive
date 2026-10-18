import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRefreshMode, requestedSiteBuild } from '../scripts/content-refresh-mode.mjs';

test('a code build or wiki change uses only pending verification for the same official text', () => {
  const plan = { commit: 'same' };
  assert.equal(contentRefreshMode(plan, { commit: 'same' }), '--retry');
  assert.equal(contentRefreshMode(plan, { commit: 'older' }), '--apply');
  assert.equal(requestedSiteBuild({ checks: { source: 'requested-build' } }), true);
  assert.equal(requestedSiteBuild({ mode: 'full', checks: { wiki: 'changed' } }), false);
  assert.equal(requestedSiteBuild({ mode: 'retry' }), false);
});
