export interface ContentUpdateStatus {
  schema: 'hsr-content-update.v1';
  version: string;
  commit: string;
  checkedAt: string;
  latestTrailblaze?: {
    id: number;
    chapter: number;
    act: number;
    title: string;
  };
}

export function parseContentUpdateStatus(value: unknown): ContentUpdateStatus | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  const validDate = (date: unknown): date is string =>
    typeof date === 'string' && !Number.isNaN(Date.parse(date));
  if (
    data.schema !== 'hsr-content-update.v1' ||
    typeof data.version !== 'string' ||
    !data.version.trim() ||
    typeof data.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.commit) ||
    !validDate(data.checkedAt)
  )
    return;
  const latest = data.latestTrailblaze as Record<string, unknown> | undefined;
  if (
    latest !== undefined &&
    (!latest ||
      ![latest.id, latest.chapter, latest.act].every(
        (number) => typeof number === 'number' && Number.isSafeInteger(number) && number > 0,
      ) ||
      typeof latest.title !== 'string' ||
      !latest.title.trim())
  )
    return;
  return data as unknown as ContentUpdateStatus;
}

export interface SiteUpdateStatus {
  schema: 'hsr-site-update.v1';
  commit: string;
  updatedAt: string;
}

export function parseSiteUpdateStatus(value: unknown): SiteUpdateStatus | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (
    data.schema !== 'hsr-site-update.v1' ||
    typeof data.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.commit) ||
    typeof data.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(data.updatedAt))
  )
    return;
  return data as unknown as SiteUpdateStatus;
}

export function siteUpdateDate(status: SiteUpdateStatus): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(status.updatedAt));
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('.');
}
