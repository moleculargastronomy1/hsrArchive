import { useEffect, useRef, useState } from 'react';
import type { SearchText, SearchTextSource, OtherTextFilter } from '../lib/search-text';

export function useSearchText(
  enabled: boolean,
  query: string,
  offset: number,
  limit: number,
  filter?: OtherTextFilter,
) {
  const worker = useRef<Worker | undefined>(undefined);
  const sequence = useRef(0);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    offset: number;
    limit: number;
    count: number;
    rows: SearchText[];
    sources?: SearchTextSource[];
    commit?: string;
    error?: string;
    filter?: OtherTextFilter;
  }>();
  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    const token = ++sequence.current;
    try {
      worker.current ??= new Worker(new URL('../lib/search-text.worker.ts', import.meta.url), {
        type: 'module',
      });
      const current = worker.current;
      current.onmessage = ({ data }) => {
        if (data.token === sequence.current)
          setResult({
            query,
            offset,
            limit,
            count: data.count ?? 0,
            rows: data.rows ?? [],
            sources: data.sources,
            commit: data.commit,
            error: data.error,
            filter,
          });
      };
      current.onerror = () => {
        if (token === sequence.current)
          setResult({
            query,
            offset,
            limit,
            count: 0,
            rows: [],
            error: '기타 텍스트 검색을 시작하지 못했습니다.',
            filter,
          });
        current.terminate();
        worker.current = undefined;
      };
      current.postMessage({
        token,
        base: new URL(import.meta.env.BASE_URL, location.href).href,
        query,
        offset,
        limit,
        filter,
      });
    } catch {
      setResult({
        query,
        offset,
        limit,
        count: 0,
        rows: [],
        error: '기타 텍스트 검색을 시작하지 못했습니다.',
        filter,
      });
    }
    return () => {
      sequence.current++;
    };
  }, [enabled, query, offset, limit, filter, retry]);
  const sameQuery = enabled && result?.query === query && result.filter === filter;
  const ready = sameQuery && result.offset === offset && result.limit === limit;
  return {
    count: sameQuery ? result.count : 0,
    rows: ready ? result.rows : [],
    sources: sameQuery ? (result.sources ?? []) : [],
    commit: sameQuery ? result.commit : undefined,
    loading: enabled && !ready,
    error: sameQuery ? result.error : undefined,
    retry: () => {
      setResult(undefined);
      setRetry((value) => value + 1);
    },
  };
}
