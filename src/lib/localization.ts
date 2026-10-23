export const comparisonLanguages = [
  { id: 'en', label: '영어', native: 'English' },
  { id: 'zh-CN', label: '중국어(간체)', native: '简体中文' },
  { id: 'ja', label: '일본어', native: '日本語' },
] as const;

export type ComparisonLanguage = (typeof comparisonLanguages)[number]['id'];
export interface LocalizedRow {
  id: string;
  speaker: string;
  text: string;
}
export interface RowIdentity {
  entryId: string;
  chapterId: string;
}
export type LocalizationState =
  | { status: 'ready'; rows: Map<string, LocalizedRow> }
  | { status: 'error' };

export function isComparisonLanguages(value: unknown): value is ComparisonLanguage[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((id) => comparisonLanguages.some((language) => language.id === id))
  );
}

export function localizationKey(row: RowIdentity, language: ComparisonLanguage) {
  if (
    ![row.entryId, row.chapterId].every((id) => /^[A-Za-z0-9_-]+$/.test(id)) ||
    !comparisonLanguages.some((item) => item.id === language)
  )
    throw new Error('Invalid localization identity');
  return `${language}/${row.entryId}--${row.chapterId}`;
}

export function parseLocalizations(
  value: unknown,
  row: RowIdentity,
  language: ComparisonLanguage,
  referenceCommit?: string,
) {
  if (!value || typeof value !== 'object') throw new Error('Invalid localizations');
  const data = value as Record<string, unknown>;
  if (
    data.schema !== 'hsr-localizations.v1' ||
    data.language !== language ||
    data.entryId !== row.entryId ||
    data.chapterId !== row.chapterId ||
    typeof data.referenceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.referenceCommit) ||
    (referenceCommit !== undefined && data.referenceCommit !== referenceCommit) ||
    !Array.isArray(data.rows)
  )
    throw new Error('Mismatched localizations');
  const rows = new Map<string, LocalizedRow>();
  for (const item of data.rows) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      typeof item.speaker !== 'string' ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      rows.has(item.id)
    )
      throw new Error('Invalid localized row');
    rows.set(item.id, item);
  }
  return rows;
}
