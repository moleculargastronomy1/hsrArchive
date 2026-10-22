// Only CI uses this adapter. Browser builds never import it.
const publishedOrigin = 'https://moleculargastronomy1.github.io/hsrArchive/';
export async function publishedFetch(input, options = {}, fetcher = fetch, env = process.env) {
  const url = String(input);
  if (!env.HSR_PRIVATE_STATE_URL) return fetcher(input, options);
  if (!url.startsWith(publishedOrigin)) throw new Error('Unexpected published state address');
  const base = new URL(env.HSR_PRIVATE_STATE_URL);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !env.HSR_PRIVATE_STATE_TOKEN
  )
    throw new Error('Invalid private state configuration');
  const file = url.slice(publishedOrigin.length);
  if (
    !/^(?:verification-state(?:-[a-f0-9]{64}\.json\.gz|\.json)|content-watch\.json|verification-progress\.json|video-order-provenance\.json|site-update\.json)$/.test(
      file,
    )
  )
    throw new Error('State path is not permitted');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${env.HSR_PRIVATE_STATE_TOKEN}`);
  // Redirects could disclose the bearer token. A private failure never falls back to Pages.
  const response = await fetcher(new URL('internal/state/' + file, base.origin + '/'), {
    ...options,
    headers,
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error('Private last-success state unavailable; refusing public fallback');
  return response;
}
