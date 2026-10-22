import { useEffect, useState } from 'react';
import {
  isComparisonLanguages,
  localizationKey,
  parseLocalizations,
  type ComparisonLanguage,
  type LocalizationState,
  type RowIdentity,
} from '../lib/localization';
import { useStored } from '../lib/storage';
import { dataApi } from '../lib/data-api';
import { requestLocalizations } from '../lib/localization-api';

export function useComparisonLanguages() {
  return useStored<ComparisonLanguage[]>('comparison-languages', [], isComparisonLanguages);
}

const cache = new Map<string, Promise<LocalizationState>>();

export function useLocalizations(
  rows: (RowIdentity & { id?: string })[],
  languages: ComparisonLanguage[],
) {
  const [states, setStates] = useState<Record<string, LocalizationState>>({});
  const requests = JSON.stringify([
    ...new Map(
      rows.flatMap((row) =>
        languages.map(
          (language) =>
            [
              localizationKey(row, language),
              { entryId: row.entryId, chapterId: row.chapterId, language },
            ] as const,
        ),
      ),
    ).entries(),
  ]);
  const requestedIds = JSON.stringify(
    Object.fromEntries(
      [...new Set(rows.map((r) => `${r.entryId}/${r.chapterId}`))].map((key) => [
        key,
        [
          ...new Set(
            rows
              .filter((r) => `${r.entryId}/${r.chapterId}` === key)
              .map((r) => r.id)
              .filter(Boolean),
          ),
        ].sort(),
      ]),
    ),
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const entries: [string, RowIdentity & { language: ComparisonLanguage }][] =
      JSON.parse(requests);
    setStates((previous) =>
      dataApi
        ? {}
        : Object.fromEntries(
            entries.filter(([key]) => previous[key]).map(([key]) => [key, previous[key]]),
          ),
    );
    for (const [key, identity] of entries) {
      const ids: string[] =
        JSON.parse(requestedIds)[`${identity.entryId}/${identity.chapterId}`] ?? [];
      const cacheKey = dataApi ? `${key}:${ids.join(',')}` : key;
      let pending = cache.get(cacheKey);
      if (!pending) {
        const request = dataApi
          ? Promise.all(
              Array.from({ length: Math.ceil(ids.length / 25) }, (_, index) =>
                requestLocalizations(identity, ids.slice(index * 25, (index + 1) * 25)),
              ),
            ).then((parts) => ({ ...parts[0], rows: parts.flatMap((p) => p.rows) }))
          : fetch(`${import.meta.env.BASE_URL}content/locales/${key}.json`).then((response) => {
              if (!response.ok) throw new Error('Localization fetch failed');
              return response.json();
            });
        pending = request
          .then(async (value): Promise<LocalizationState> => {
            return {
              status: 'ready',
              rows: parseLocalizations(value, identity, identity.language),
            };
          })
          .catch((): LocalizationState => {
            if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
            return { status: 'error' };
          });
        cache.set(cacheKey, pending);
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
      }
      void pending.then((state) => {
        if (active) setStates((previous) => ({ ...previous, [key]: state }));
      });
    }
    return () => {
      active = false;
    };
  }, [requests, requestedIds, retry]);
  return {
    states,
    retry: () => {
      setStates({});
      setRetry((value) => value + 1);
    },
  };
}
