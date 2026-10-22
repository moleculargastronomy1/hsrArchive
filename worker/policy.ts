// Starting values for a preview. Tune with denial counts and reader feedback.
export const defaultPolicy = {
  windowSeconds: 60,
  sessionRequests: 180,
  ipRequests: 1200,
  ipPages: 240,
  ipSearches: 120,
  ipChapters: 480,
  searchRequests: 30,
  pageRequests: 90,
  distinctChapters: 80,
  sustainedReads: 2400,
  sustainedReadsPerHour: 1200,
  sustainedSearches: 600,
  sustainedSearchesPerHour: 300,
  sustainedChapters: 360,
  sustainedChaptersPerHour: 180,
  trapThreshold: 3,
  trapWindowSeconds: 600,
  trapCooldownSeconds: 60,
};
export type Policy = typeof defaultPolicy;
export function parsePolicy(value?: string): Policy {
  const supplied = value ? JSON.parse(value) : {};
  const policy = { ...defaultPolicy, ...supplied };
  if (
    Object.keys(supplied).some((k) => !(k in defaultPolicy)) ||
    Object.values(policy).some(
      (v) => !Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 86400,
    )
  )
    throw new Error('Invalid request policy');
  return policy;
}
export interface Usage {
  start: number;
  total: number;
  pages: number;
  searches: number;
  chapters: string[];
  sessions: Record<string, { total: number; search: number; page: number; chapters: string[] }>;
}
export function consume(
  previous: Usage | undefined,
  session: string,
  kind: string,
  chapter: string | string[],
  now: number,
  policy: Policy,
  cleared = false,
) {
  const windowMs = policy.windowSeconds * 1000;
  const usage: Usage =
    previous && now < previous.start + windowMs
      ? structuredClone(previous)
      : { start: now, total: 0, pages: 0, searches: 0, chapters: [], sessions: {} };
  const retryAfter = Math.max(1, Math.ceil((usage.start + windowMs - now) / 1000));
  if (usage.total >= policy.ipRequests)
    return { usage, allowed: false, reason: 'ip-volume', retryAfter };
  usage.total++;
  if (kind === 'page') usage.pages++;
  if (kind === 'search') usage.searches++;
  const chapters = (Array.isArray(chapter) ? chapter : [chapter]).filter(Boolean);
  for (const item of chapters) if (!usage.chapters.includes(item)) usage.chapters.push(item);
  const shared =
    usage.pages > policy.ipPages
      ? 'ip-pages'
      : usage.searches > policy.ipSearches
        ? 'ip-searches'
        : usage.chapters.length > policy.ipChapters
          ? 'ip-chapter-sweep'
          : '';
  if (shared) return { usage, allowed: false, reason: shared, retryAfter };
  const own = usage.sessions[session] ?? { total: 0, search: 0, page: 0, chapters: [] };
  // Rotation cannot evade the shared IP ceiling. Bound persistent state as well.
  if (!usage.sessions[session] && Object.keys(usage.sessions).length >= 128)
    return { usage, allowed: false, reason: 'session-rotation', retryAfter };
  usage.sessions[session] = own;
  own.total++;
  if (kind === 'search') own.search++;
  if (kind === 'page') own.page++;
  for (const item of chapters) if (!own.chapters.includes(item)) own.chapters.push(item);
  const allowance = cleared ? 2 : 1;
  const reason =
    own.total > policy.sessionRequests * allowance
      ? 'session-volume'
      : own.search > policy.searchRequests * allowance
        ? 'search-volume'
        : own.page > policy.pageRequests * allowance
          ? 'page-volume'
          : own.chapters.length > policy.distinctChapters * allowance
            ? 'chapter-sweep'
            : '';
  return { usage, allowed: !reason, reason, retryAfter: reason ? retryAfter : 0 };
}
