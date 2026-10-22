export async function verifyTurnstile(
  secret: string,
  token: string,
  hostnames: string[],
  fetcher = fetch,
) {
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) return false;
  const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret, response: token }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success: boolean; hostname: string; action: string };
  return (
    result.success === true &&
    hostnames.includes(result.hostname) &&
    result.action === 'archive-read'
  );
}
