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

export function useComparisonLanguages() {
  return useStored<ComparisonLanguage[]>('comparison-languages', [], isComparisonLanguages);
}

const cache = new Map<string, Promise<LocalizationState>>();

export function useLocalizations(
  rows: RowIdentity[],
  languages: ComparisonLanguage[],
  options: { source?: 'search' | 'content'; referenceCommit?: string } = {},
) {
  const source = options.source ?? 'content';
  const referenceCommit = options.referenceCommit;
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
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const entries: [string, RowIdentity & { language: ComparisonLanguage }][] =
      JSON.parse(requests);
    setStates((previous) =>
      Object.fromEntries(
        entries.filter(([key]) => previous[key]).map(([key]) => [key, previous[key]]),
      ),
    );
    for (const [key, identity] of entries) {
      const cacheKey = `${source}/${key}/${referenceCommit ?? ''}`;
      let pending = cache.get(cacheKey);
      if (!pending) {
        pending = fetch(
          `${import.meta.env.BASE_URL}${source}/locales/${key}.json${referenceCommit ? '?v=' + referenceCommit : ''}`,
        )
          .then(async (response): Promise<LocalizationState> => {
            if (!response.ok) throw new Error('Localization fetch failed');
            return {
              status: 'ready',
              rows: parseLocalizations(
                await response.json(),
                identity,
                identity.language,
                referenceCommit,
              ),
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
  }, [requests, retry, source, referenceCommit]);
  return {
    states,
    retry: () => {
      setStates({});
      setRetry((value) => value + 1);
    },
  };
}
