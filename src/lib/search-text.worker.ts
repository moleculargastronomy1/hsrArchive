import {
  parseSearchManifest,
  parseSearchPart,
  textMatches,
  type SearchText,
  type SearchTextSource,
} from './search-text';

interface Request {
  token: number;
  base: string;
  query: string;
  offset: number;
  limit: number;
}
const worker = self as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (value: unknown) => void;
};
let latest = 0;
let loading: Promise<{ parts: SearchText[][]; sources: SearchTextSource[] }> | undefined;
let cachedQuery: string | undefined;
let matches: SearchText[] = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load(base: string) {
  const get = async (file: string) => {
    const response = await fetch(`${base}search/${file}`);
    if (!response.ok) throw new Error(`기타 텍스트를 불러오지 못했습니다 (${response.status}).`);
    return response;
  };
  const manifest = parseSearchManifest(await (await get('manifest.json')).json());
  const parts: SearchText[][] = new Array(manifest.parts.length);
  let cursor = 0;
  // Bound peak parsing memory and keep the text corpus outside the UI thread.
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < manifest.parts.length) {
        const index = cursor++,
          part = manifest.parts[index];
        const bytes = await (await get(part.file)).arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (digest !== part.sha256)
          throw new Error('기타 텍스트가 갱신되었습니다. 다시 시도해 주세요.');
        parts[index] = parseSearchPart(
          JSON.parse(new TextDecoder().decode(bytes)),
          manifest.commit,
          part.rows,
          manifest.sources.length,
        );
      }
    }),
  );
  return { parts, sources: manifest.sources };
}

worker.onmessage = async ({ data }) => {
  const { token, base, query, offset, limit } = data;
  latest = token;
  try {
    loading ??= load(base).catch((error) => {
      loading = undefined;
      throw error;
    });
    const { parts, sources } = await loading;
    if (latest !== token) return;
    if (query !== cachedQuery) {
      const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      const result: SearchText[] = [];
      for (const part of parts) {
        for (let start = 0; start < part.length; start += 2000) {
          if (latest !== token) return;
          for (let index = start; index < Math.min(start + 2000, part.length); index++)
            if (!terms.length || textMatches(part[index], terms, sources)) result.push(part[index]);
          await pause();
        }
      }
      matches = result;
      cachedQuery = query;
    }
    if (latest === token)
      worker.postMessage({
        token,
        count: matches.length,
        rows: matches.slice(offset, offset + limit),
        sources,
      });
  } catch (error) {
    if (latest === token)
      worker.postMessage({
        token,
        error: error instanceof Error ? error.message : '기타 텍스트를 불러오지 못했습니다.',
      });
  }
};
