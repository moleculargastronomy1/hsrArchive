import { apiGet } from './data-api';
import type { ComparisonLanguage, RowIdentity } from './localization';

interface Pending {
  identity: RowIdentity & { language: ComparisonLanguage };
  ids: string[];
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
}
let queued: Pending[] = [];
let scheduled = false;
// A global search may show 50 different books. Batch only the requested IDs,
// rather than charging one network request per book per comparison language.
export function requestLocalizations(identity: Pending['identity'], ids: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    queued.push({ identity, ids, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });
}
function flush() {
  const requests = queued;
  queued = [];
  scheduled = false;
  for (const language of ['en', 'zh-CN', 'ja']) {
    const items = requests.filter((r) => r.identity.language === language);
    let batch: Pending[] = [];
    const send = () => {
      if (!batch.length) return;
      const current = batch;
      batch = [];
      const payload = current.map((r) => ({
        file: `content/${r.identity.entryId}--${r.identity.chapterId}.json`,
        ids: r.ids,
      }));
      void apiGet<{ items: any[] }>('v1/locales', { language, items: JSON.stringify(payload) })
        .then((result) => {
          if (result.items.length !== current.length)
            throw new Error('Mismatched localization batch');
          current.forEach((r, index) => r.resolve(result.items[index]));
        })
        .catch((error) => current.forEach((r) => r.reject(error)));
    };
    for (const item of items) {
      const proposed = [...batch, item];
      const payload = proposed.map((r) => ({
        file: `content/${r.identity.entryId}--${r.identity.chapterId}.json`,
        ids: r.ids,
      }));
      if (
        proposed.length > 8 ||
        proposed.reduce((n, r) => n + r.ids.length, 0) > 100 ||
        encodeURIComponent(JSON.stringify(payload)).length > 12000
      )
        send();
      batch.push(item);
    }
    send();
  }
}
