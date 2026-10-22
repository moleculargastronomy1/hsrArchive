import type { Policy } from './policy.ts';

// Independent of session cookies, User-Agent, release and the short request window.
// Continuous token refill avoids an hourly/daily reset that a crawler can wait for.
interface Budget {
  tokens: number;
  at: number;
}
export interface BehaviorUsage {
  read?: Budget;
  search?: Budget;
  chapter?: Budget;
  seen: Record<string, number>;
  trapStart: number;
  trapHits: number;
  trapProbes?: number;
  blockedUntil: number;
}
function refill(previous: Budget | undefined, capacity: number, perHour: number, now: number) {
  return {
    tokens: Math.min(
      capacity,
      (previous?.tokens ?? capacity) +
        (Math.max(0, now - (previous?.at ?? now)) * perHour) / 3600000,
    ),
    at: now,
  };
}
export function behaviorLifetime(policy: Policy) {
  return (
    Math.ceil(
      Math.max(
        (policy.sustainedReads / policy.sustainedReadsPerHour) * 3600,
        (policy.sustainedSearches / policy.sustainedSearchesPerHour) * 3600,
        (policy.sustainedChapters / policy.sustainedChaptersPerHour) * 3600,
        policy.trapWindowSeconds,
        policy.trapCooldownSeconds,
        policy.windowSeconds,
        3600,
      ),
    ) + 60
  );
}
export function consumeBehavior(
  previous: BehaviorUsage | undefined,
  kind: string,
  chapters: string[],
  now: number,
  policy: Policy,
) {
  const usage: BehaviorUsage = previous
    ? structuredClone(previous)
    : {
        seen: {},
        trapStart: now,
        trapHits: 0,
        blockedUntil: 0,
      };
  const decision = (reason = '', seconds = 0) => ({
    usage,
    allowed: !reason,
    reason,
    retryAfter: Math.max(reason ? 1 : 0, Math.ceil(seconds)),
  });
  if (now >= usage.trapStart + policy.trapWindowSeconds * 1000) {
    usage.trapStart = now;
    usage.trapHits = 0;
    usage.trapProbes = 0;
  }
  // A single prefetch/security scanner hit is evidence only. Never serve decoy text.
  if (kind === 'trap') {
    usage.trapProbes = Math.min(65536, (usage.trapProbes ?? 0) + 1);
    usage.trapHits = Math.min(policy.trapThreshold, usage.trapHits + 1);
    if (usage.trapHits >= policy.trapThreshold)
      usage.blockedUntil = Math.max(usage.blockedUntil, now + policy.trapCooldownSeconds * 1000);
    return decision(); // The HTTP trap response remains an empty 404.
  }
  if (now < usage.blockedUntil) return decision('trap-cooldown', (usage.blockedUntil - now) / 1000);
  if (!['page', 'search'].includes(kind)) return decision();
  for (const [file, at] of Object.entries(usage.seen))
    if (now >= at + 3600000) delete usage.seen[file];
  const fresh = [...new Set(chapters)].filter((file) => usage.seen[file] === undefined);
  const budgets = [
    ['read', policy.sustainedReads, policy.sustainedReadsPerHour, kind === 'page' ? 1 : 0],
    [
      'search',
      policy.sustainedSearches,
      policy.sustainedSearchesPerHour,
      kind === 'search' ? 1 : 0,
    ],
    ['chapter', policy.sustainedChapters, policy.sustainedChaptersPerHour, fresh.length],
  ] as const;
  let reason = '',
    wait = 0;
  for (const [key, capacity, rate, cost] of budgets) {
    usage[key] = refill(usage[key], capacity, rate, now);
    if (usage[key]!.tokens + 1e-9 < cost) {
      reason = 'sustained-' + key;
      wait = Math.max(wait, ((cost - usage[key]!.tokens) * 3600) / rate);
    }
  }
  if (reason) return decision(reason, wait);
  for (const [key, , , cost] of budgets) usage[key]!.tokens -= cost;
  for (const file of fresh) usage.seen[file] = now;
  // Bound state even if a trusted operator configures extremely large budgets.
  const keys = Object.keys(usage.seen);
  for (const file of keys.slice(0, Math.max(0, keys.length - 4096))) delete usage.seen[file];
  return decision();
}

// Not linked from reader pages, bookmarks, sitemaps or real content. Public robots
// excludes this namespace. It detects export discovery, not all forms of scraping.
export const trapPath = '/v1/export/archive.json';
