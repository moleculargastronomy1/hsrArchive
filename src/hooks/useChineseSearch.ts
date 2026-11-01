import { useEffect, useMemo, useRef, useState } from 'react';

export function useChineseSearch(enabled: boolean, query: string, hash?: string) {
  const worker = useRef<Worker | undefined>(undefined);
  const sequence = useRef(0);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    hash: string;
    matches: [string, string[]][];
    error?: string;
  }>();
  useEffect(() => {
    if (!enabled || !hash) {
      worker.current?.terminate();
      worker.current = undefined;
      setResult(undefined);
      return;
    }
    const token = ++sequence.current;
    try {
      worker.current ??= new Worker(new URL('../lib/chinese-search.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.current.onmessage = ({ data }) => {
        if (data.token === sequence.current)
          setResult({ query, hash, matches: data.matches ?? [], error: data.error });
      };
      worker.current.onerror = () => {
        if (token === sequence.current)
          setResult({ query, hash, matches: [], error: '중국어 검색을 시작하지 못했습니다.' });
        worker.current?.terminate();
        worker.current = undefined;
      };
      worker.current.postMessage({
        token,
        base: new URL(import.meta.env.BASE_URL, location.href).href,
        query,
        hash,
      });
    } catch {
      setResult({ query, hash, matches: [], error: '중국어 검색을 시작하지 못했습니다.' });
    }
    return () => {
      sequence.current++;
    };
  }, [enabled, query, hash, retry]);
  useEffect(() => () => worker.current?.terminate(), []);
  const current = enabled && result?.query === query && result.hash === hash;
  const matches = useMemo(
    () => new Map(current ? result.matches.map(([id, terms]) => [id, new Set(terms)]) : []),
    [current, result],
  );
  return {
    matches,
    loading: enabled && !!hash && !current,
    error: current ? result.error : undefined,
    retry: () => {
      setResult(undefined);
      setRetry((value) => value + 1);
    },
  };
}
