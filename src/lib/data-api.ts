import { requestBotCheck } from '../components/BotCheck';
export const dataApi = import.meta.env.VITE_DATA_API_URL as string | undefined;
export const dataRelease = import.meta.env.VITE_DATA_RELEASE as string | undefined;
let session: Promise<string> | undefined;
let clearance = '';
let challenge: Promise<void> | undefined;
export class DataApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function responseJson(response: Response) {
  const data = await response.json();
  if (!response.ok)
    throw new DataApiError(response.status, data.error ?? '자료를 불러오지 못했습니다.');
  return data;
}
export async function apiGet<T>(
  route: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  if (!dataApi) throw new Error('Data API is not configured');
  const url = new URL(route, dataApi.replace(/\/$/, '') + '/');
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  url.searchParams.set('release', dataRelease ?? '');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!session) {
      session = fetch(new URL('v1/session', dataApi.replace(/\/$/, '') + '/'), {
        cache: 'no-store',
      })
        .then(responseJson)
        .then((value) => value.token as string)
        .catch((error) => {
          session = undefined;
          throw error;
        });
    }
    const token = await session;
    const response = await fetch(url, {
      signal,
      cache: 'no-store',
      headers: {
        'X-Archive-Session': token,
        ...(clearance ? { 'X-Archive-Clearance': clearance } : {}),
      },
    });
    if (response.status === 401 && attempt === 0) {
      session = undefined;
      continue;
    }
    if (response.status === 429 && attempt < 2) {
      const data = await response.clone().json();
      if (data.challengeSiteKey) {
        if (!challenge)
          challenge = requestBotCheck(data.challengeSiteKey)
            .then(async (value) => {
              const verified = await fetch(
                new URL('v1/challenge', dataApi.replace(/\/$/, '') + '/'),
                {
                  method: 'POST',
                  cache: 'no-store',
                  headers: { 'X-Archive-Session': token, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token: value }),
                },
              ).then(responseJson);
              clearance = verified.clearance;
            })
            .finally(() => {
              challenge = undefined;
            });
        await challenge;
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        continue;
      }
    }
    return responseJson(response);
  }
  throw new Error('열람 세션을 연결하지 못했습니다. 다시 시도해 주세요.');
}
