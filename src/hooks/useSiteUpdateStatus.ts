import { useEffect, useState } from 'react';
import bundledStatus from '../../public/site-update.json';
import { parseSiteUpdateStatus } from '../lib/content-update';

export default function useSiteUpdateStatus() {
  const [status, setStatus] = useState(() => parseSiteUpdateStatus(bundledStatus));
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}site-update.json`, {
      signal: controller.signal,
      cache: 'no-cache',
    })
      .then((response) => {
        if (!response.ok) throw new Error('Site update status unavailable');
        return response.json();
      })
      .then((data: unknown) => {
        const next = parseSiteUpdateStatus(data);
        if (next) setStatus(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return status;
}
