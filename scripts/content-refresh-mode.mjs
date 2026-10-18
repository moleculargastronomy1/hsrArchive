// A code deployment or a wiki revision does not require projecting already
// verified Korean text again. Only a different official input uses import.
export function contentRefreshMode(plan, previous) {
  return plan.commit === previous.commit ? '--retry' : '--apply';
}

export function requestedSiteBuild(watch) {
  return watch.checks?.source === 'requested-build';
}
