// Code deployments reuse validated published data. Scheduled source work stays
// independent, including when a newer official input is available.
export function contentRefreshMode(plan, previous, watch = {}) {
  if (requestedSiteBuild(watch)) return '--site-only';
  return plan.commit === previous.commit ? '--retry' : '--apply';
}

export function requestedSiteBuild(watch) {
  return watch.checks?.source === 'requested-build';
}
