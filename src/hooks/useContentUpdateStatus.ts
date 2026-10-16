import { useEffect, useState } from 'react';
import bundledStatus from '../../public/content-update.json';
import { parseContentUpdateStatus } from '../lib/content-update';

export default function useContentUpdateStatus() {
  const [status, setStatus] = useState(() => parseContentUpdateStatus(bundledStatus));
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}content-update.json`, {
      signal: controller.signal,
      cache: 'no-cache',
    })
      .then((response) => {
        if (!response.ok) throw new Error('Update status unavailable');
        return response.json();
      })
      .then((data: unknown) => {
        const next = parseContentUpdateStatus(data);
        if (next) setStatus(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return status;
}
