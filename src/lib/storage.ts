import { useCallback, useState } from 'react';

export interface ReadingProgress {
  chapterId: string;
  scroll: number;
  updatedAt: number;
}
export type ReadingHistory = Record<string, ReadingProgress>;

// Preferences are optional: private browsing or full storage must never block reading.
export function loadStored<T>(
  key: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`hsr:${key}`) ?? 'null');
    return validate(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveStored(key: string, value: unknown) {
  try {
    localStorage.setItem(`hsr:${key}`, JSON.stringify(value));
  } catch {
    /* Memory state still works. */
  }
}

export function useStored<T>(key: string, fallback: T, validate: (value: unknown) => value is T) {
  const [value, setValue] = useState(() => loadStored(key, fallback, validate));
  const update = useCallback(
    (next: T | ((previous: T) => T)) =>
      setValue((previous) => {
        const result = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
        saveStored(key, result);
        return result;
      }),
    [key],
  );
  return [value, update] as const;
}

export const isBookmarks = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
export const isHistory = (value: unknown): value is ReadingHistory => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      item &&
      typeof item === 'object' &&
      typeof item.chapterId === 'string' &&
      Number.isFinite(item.scroll) &&
      item.scroll >= 0 &&
      Number.isFinite(item.updatedAt),
  );
};
