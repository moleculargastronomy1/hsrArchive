import {
  serveData,
  termsOf,
  PAGE_SIZE,
  HttpError,
  validFile,
  localeBatch,
  type DataStore,
} from './service.ts';
import { consume, parsePolicy } from './policy.ts';
import { consumeBehavior, behaviorLifetime, trapPath } from './behavior.ts';
import { verifyTurnstile } from './turnstile.ts';

interface R2Object {
  json<T = any>(): Promise<T>;
  body: ReadableStream;
  customMetadata?: Record<string, string>;
}
interface Bucket {
  get(key: string): Promise<R2Object | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: ReadableStream | null, options: unknown): Promise<unknown>;
}
interface Statement {
  bind(...args: unknown[]): Statement;
  all<T = any>(): Promise<{ results: T[] }>;
  first<T = any>(): Promise<T>;
}
interface Env {
  DATA: Bucket;
  SEARCH: { prepare(sql: string): Statement };
  SEARCH_PREVIOUS?: Env['SEARCH'];
  GUARD: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
  RELEASES: Env['GUARD'];
  EDGE_LIMIT?: { limit(arg: { key: string }): Promise<{ success: boolean }> };
  DATA_RELEASE: string;
  PREVIOUS_RELEASE?: string;
  SESSION_SECRET: string;
  INTERNAL_TOKEN?: string;
  ALLOWED_ORIGINS: string;
  RATE_POLICY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function mac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
export function ipGroup(ip: string) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip;
  // Aggregate IPv6 privacy addresses to a /64. CF supplies the address.
  if (/^[a-fA-F0-9:]+$/.test(ip) && ip.includes(':')) {
    const [a, b = ''] = ip.toLowerCase().split('::');
    const left = a ? a.split(':') : [],
      right = b ? b.split(':') : [];
    const groups = ip.includes('::')
      ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
      : left;
    return groups
      .slice(0, 4)
      .map((x) => x.padStart(4, '0'))
      .join(':');
  }
  throw new HttpError(503, 'Client address unavailable');
}
export async function sessionToken(secret: string, client: string, now = Date.now()) {
  const value = `${Math.floor(now / 1000) + 3600}.${crypto.randomUUID()}`;
  return value + '.' + (await mac(secret, client + ':' + value));
}
export async function verifySession(
  token: string,
  secret: string,
  client: string,
  now = Date.now(),
) {
  if (!/^\d{10}\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token)) return false;
  const [expires, id, signature] = token.split('.');
  if (Number(expires) <= now / 1000 || Number(expires) > now / 1000 + 3601) return false;
  return signature === (await mac(secret, client + ':' + expires + '.' + id));
}
export class RequestGuard {
  ctx: any;
  env: Env;
  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request: Request) {
    const { session, kind, chapter, cleared } = (await request.json()) as {
      session: string;
      kind: string;
      chapter: string[];
      cleared?: boolean;
    };
    const result = await this.ctx.storage.transaction(async (tx: any) => {
      const policy = parsePolicy(this.env.RATE_POLICY);
      const now = Date.now();
      const decision = consume(
        await tx.get('usage'),
        session,
        kind,
        chapter,
        now,
        policy,
        cleared === true,
      );
      await tx.put('usage', decision.usage);
      await tx.setAlarm(now + behaviorLifetime(policy) * 1000);
      const behavior = consumeBehavior(
        await tx.get('behavior'),
        decision.allowed || kind === 'trap' ? kind : 'other',
        chapter,
        now,
        policy,
      );
      await tx.put('behavior', behavior.usage);
      if (!behavior.allowed)
        return {
          allowed: false,
          reason: behavior.reason,
          retryAfter: behavior.retryAfter,
        };
      return {
        allowed: decision.allowed,
        reason: decision.reason,
        retryAfter: decision.retryAfter,
        logProbe: kind === 'trap' && Number.isInteger(Math.log2(behavior.usage.trapProbes ?? 0)),
      };
    });
    return json(result);
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
// Publication state changes only after the public artifact deployment succeeds.
// A failed upload/build/deployment cannot advance the CI recovery baseline.
export class ReleaseCoordinator {
  ctx: any;
  constructor(ctx: any) {
    this.ctx = ctx;
  }
  async fetch(request: Request) {
    if (request.method === 'GET')
      return json({ release: (await this.ctx.storage.get('release')) ?? null });
    const { release, expectedPrevious } = (await request.json()) as {
      release: string;
      expectedPrevious: string | null;
    };
    return this.ctx.storage.transaction(async (tx: any) => {
      const previous = (await tx.get('release')) ?? null;
      if (previous === release) return json({ release }); // idempotent retry
      if (previous !== expectedPrevious)
        return json({ error: 'Publication baseline changed' }, 409);
      await tx.put('release', release);
      await tx.put('previous', previous);
      return json({ release, previous });
    });
  }
}

export function makeStore(env: Env, release: string): DataStore {
  const get = async (key: string) => {
    const object = await env.DATA.get(`releases/${release}/public/${key}`);
    if (!object) throw new HttpError(503, 'Requested data unavailable');
    return object.json();
  };
  return {
    chapter: (file) => get(file),
    locale: (file, language) => get(`content/locales/${language}/${file.slice(8)}`),
    async search(query, scope, page) {
      const database = release === env.PREVIOUS_RELEASE ? env.SEARCH_PREVIOUS : env.SEARCH;
      if (!database) throw new HttpError(503, 'Search release unavailable');
      const terms = termsOf(query);
      const where = ['release = ?'];
      const args: unknown[] = [release];
      if (scope !== 'all') {
        where.push('category = ?');
        args.push(scope);
      }
      // Exact substring semantics, including 1–2 character Korean queries.
      // Trigram FTS narrows longer terms; instr checks the original AND match.
      const long = terms.find((t) => [...t].length >= 3);
      if (long) {
        where.push('rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)');
        args.push('"' + long.replaceAll('"', '""') + '"');
      }
      for (const term of terms) {
        where.push('instr(search, ?) > 0');
        args.push(term);
      }
      const condition = where.join(' AND ');
      const count = await database
        .prepare(`SELECT count(*) AS total FROM search_rows WHERE ${condition}`)
        .bind(...args)
        .first<{ total: number }>();
      const result = await database
        .prepare(
          `SELECT body FROM search_rows WHERE ${condition} ORDER BY ordinal LIMIT ? OFFSET ?`,
        )
        .bind(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all<{ body: string }>();
      return { total: count.total, rows: result.results.map((r) => JSON.parse(r.body)) };
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
    const cors: Record<string, string> =
      origin && allowed.includes(origin)
        ? {
            'Access-Control-Allow-Origin': origin,
            Vary: 'Origin',
            'Access-Control-Expose-Headers': 'Retry-After',
          }
        : {};
    try {
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
        throw new HttpError(503, 'Service configuration unavailable');
      // Authenticated, fixed allowlist; no bucket list, upload or public snapshot route.
      if (url.pathname.startsWith('/internal/')) {
        if (
          !env.INTERNAL_TOKEN ||
          (await mac(env.SESSION_SECRET, request.headers.get('Authorization') ?? '')) !==
            (await mac(env.SESSION_SECRET, `Bearer ${env.INTERNAL_TOKEN}`))
        )
          throw new HttpError(404, 'Not found');
        const coordinator = env.RELEASES.get(env.RELEASES.idFromName('last-success'));
        if (url.pathname.startsWith('/internal/object/') && request.method === 'PUT') {
          const relative = url.pathname.slice('/internal/object/'.length);
          const [release, ...parts] = relative.split('/');
          const file = parts.join('/');
          const checksum = request.headers.get('X-Content-SHA256') ?? '';
          const length = Number(request.headers.get('Content-Length'));
          if (!Number.isSafeInteger(length) || length < 1 || length > 90 * 1024 * 1024)
            throw new HttpError(411, 'A bounded content length is required');
          if (
            !/^[a-f0-9]{64}$/.test(release) ||
            !/^[a-f0-9]{64}$/.test(checksum) ||
            !/^(?:ready\.json|src\/data\/[A-Za-z0-9_-]+\.json|public\/(?:[A-Za-z0-9_-]+\.json(?:\.gz)?|content\/[A-Za-z0-9_-]+\.json|content\/locales\/(?:manifest|(?:en|zh-CN|ja)\/[A-Za-z0-9_-]+)\.json))$/.test(
              file,
            )
          )
            throw new HttpError(400, 'Invalid private object');
          const key = `releases/${release}/${file}`;
          const existing = await env.DATA.head(key);
          if (existing) {
            if (existing.customMetadata?.sha256 !== checksum)
              throw new HttpError(409, 'Immutable object differs');
            return json({ uploaded: true });
          }
          // Authenticated candidates may be uploaded before the serving version changes.
          // Promotion still requires a completely uploaded, currently served release.
          // R2 checks the digest; stream large snapshots without buffering them in the isolate.
          const result = await env.DATA.put(key, request.body, {
            sha256: checksum,
            customMetadata: { sha256: checksum },
            onlyIf: { etagDoesNotMatch: '*' },
          });
          if (!result)
            throw new HttpError(409, 'Concurrent private upload; retry the same candidate');
          return json({ uploaded: true });
        }
        if (url.pathname === '/internal/release' && request.method === 'GET')
          return coordinator.fetch(new Request('https://releases/'));
        if (url.pathname === '/internal/promote' && request.method === 'POST') {
          const value = (await request.json()) as {
            release: string;
            expectedPrevious: string | null;
          };
          if (![env.DATA_RELEASE, env.PREVIOUS_RELEASE].includes(value.release))
            throw new HttpError(409, 'Release is not served by this Worker');
          const ready = await env.DATA.get(`releases/${value.release}/ready.json`);
          if (!ready || (await ready.json()).release !== value.release)
            throw new HttpError(409, 'Candidate upload incomplete');
          return coordinator.fetch(
            new Request('https://releases/', { method: 'POST', body: JSON.stringify(value) }),
          );
        }
        if (!url.pathname.startsWith('/internal/state/') || request.method !== 'GET')
          throw new HttpError(404, 'Not found');
        const file = url.pathname.slice('/internal/state/'.length);
        if (
          !/^(?:verification-state(?:-[a-f0-9]{64}\.json\.gz|\.json)|content-watch\.json|verification-progress\.json|video-order-provenance\.json|site-update\.json)$/.test(
            file,
          )
        )
          throw new HttpError(404, 'Not found');
        const { release } = (await coordinator
          .fetch(new Request('https://releases/'))
          .then((r) => r.json())) as { release: string | null };
        if (!release) throw new HttpError(503, 'Successful private publication not initialized');
        const object = await env.DATA.get(`releases/${release}/public/${file}`);
        if (!object) throw new HttpError(503, 'Private recovery state unavailable');
        return new Response(object.body, {
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
      }
      if (origin && !allowed.includes(origin)) throw new HttpError(403, 'Origin not allowed');
      if (url.pathname === '/robots.txt' && request.method === 'GET')
        return new Response('User-agent: *\nDisallow: /v1/\nDisallow: /internal/\n', {
          headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' },
        });
      if (url.pathname === trapPath && request.method === 'GET') {
        const group = ipGroup(request.headers.get('CF-Connecting-IP') ?? '');
        const guardId = await mac(env.SESSION_SECRET, 'guard:' + group);
        const logId = await mac(
          env.SESSION_SECRET,
          new Date().toISOString().slice(0, 10) + ':' + group,
        );
        if (env.EDGE_LIMIT && !(await env.EDGE_LIMIT.limit({ key: logId })).success)
          return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        const probeResponse = await env.GUARD.get(env.GUARD.idFromName(guardId)).fetch(
          new Request('https://guard/check', {
            method: 'POST',
            body: JSON.stringify({ session: 'trap', kind: 'trap', chapter: [] }),
          }),
        );
        if (!probeResponse.ok) throw new Error('Guard unavailable');
        if (((await probeResponse.json()) as { logProbe?: boolean }).logProbe)
          console.log(
            JSON.stringify({
              event: 'archive-export-probe',
              client: logId.slice(0, 12),
              at: new Date().toISOString(),
            }),
          );
        return new Response(null, {
          status: 404,
          headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
        });
      }
      if (request.method === 'OPTIONS')
        return new Response(null, {
          status: 204,
          headers: {
            ...cors,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'X-Archive-Session, X-Archive-Clearance, Content-Type',
            'Access-Control-Max-Age': '600',
          },
        });
      if (request.method !== (url.pathname === '/v1/challenge' ? 'POST' : 'GET'))
        throw new HttpError(405, 'Method not allowed');
      const routes = [
        '/v1/session',
        '/v1/page',
        '/v1/search',
        '/v1/context',
        '/v1/locale',
        '/v1/locales',
        '/v1/record',
        '/v1/challenge',
      ];
      if (!routes.includes(url.pathname)) throw new HttpError(404, 'Not found');
      if (url.href.length > 30000) throw new HttpError(400, 'Request too large');
      const day = new Date().toISOString().slice(0, 10);
      const group = ipGroup(request.headers.get('CF-Connecting-IP') ?? '');
      const client = await mac(
        env.SESSION_SECRET,
        group + ':' + (request.headers.get('User-Agent') ?? '').slice(0, 300),
      );
      const ip = await mac(env.SESSION_SECRET, day + ':' + group);
      if (env.EDGE_LIMIT && !(await env.EDGE_LIMIT.limit({ key: ip })).success)
        return json({ error: '잠시 후 다시 시도해 주세요.', retryAfter: 60 }, 429, {
          ...cors,
          'Retry-After': '60',
        });
      const token = request.headers.get('X-Archive-Session') ?? '';
      if (
        url.pathname !== '/v1/session' &&
        !(await verifySession(token, env.SESSION_SECRET, client))
      )
        return json({ error: '열람 세션을 다시 연결해 주세요.' }, 401, cors);
      const session = url.pathname === '/v1/session' ? 'new-session' : token.split('.')[1];
      const pass = request.headers.get('X-Archive-Clearance') ?? '';
      const [expires, signature] = pass.split('.');
      const cleared =
        /^\d{10}\.[a-f0-9]{64}$/.test(pass) &&
        Number(expires) > Date.now() / 1000 &&
        Number(expires) < Date.now() / 1000 + 301 &&
        signature === (await mac(env.SESSION_SECRET, `clear:${client}:${session}:${expires}`));
      const kind =
        url.pathname === '/v1/search'
          ? 'search'
          : ['page', 'record', 'context', 'locale', 'locales'].includes(url.pathname.slice(4))
            ? 'page'
            : 'other';
      const file = url.searchParams.get('file') ?? '';
      if (file) validFile(file);
      const chapter =
        url.pathname === '/v1/locales'
          ? localeBatch(url.searchParams).map((item) => item.file)
          : file
            ? [file]
            : [];
      const guardId = await mac(env.SESSION_SECRET, 'guard:' + group);
      const decision = await env.GUARD.get(env.GUARD.idFromName(guardId)).fetch(
        new Request('https://guard/check', {
          method: 'POST',
          body: JSON.stringify({
            session: url.pathname === '/v1/challenge' ? 'challenge' : session,
            kind,
            chapter,
            cleared,
          }),
        }),
      );
      if (!decision.ok) throw new Error('Guard unavailable');
      const result = (await decision.json()) as {
        allowed: boolean;
        retryAfter: number;
        reason: string;
      };
      if (!result.allowed) {
        console.log(
          JSON.stringify({
            event: 'archive-limit',
            reason: result.reason,
            route: url.pathname,
            client: ip.slice(0, 12),
            at: new Date().toISOString(),
          }),
        );
        return json(
          {
            error: `${result.retryAfter}초 후 다시 시도해 주세요.`,
            retryAfter: result.retryAfter,
            ...(!result.reason.startsWith('ip-') &&
            !result.reason.startsWith('sustained-') &&
            result.reason !== 'trap-cooldown' &&
            result.reason !== 'session-rotation' &&
            env.TURNSTILE_SITE_KEY &&
            env.TURNSTILE_SECRET &&
            !cleared
              ? { challengeSiteKey: env.TURNSTILE_SITE_KEY }
              : {}),
          },
          429,
          { ...cors, 'Retry-After': String(result.retryAfter) },
        );
      }
      if (url.pathname === '/v1/session')
        return json({ token: await sessionToken(env.SESSION_SECRET, client) }, 200, cors);
      if (url.pathname === '/v1/challenge') {
        const body = await request.text();
        if (body.length > 4096 || !env.TURNSTILE_SECRET)
          throw new HttpError(400, '확인 절차를 사용할 수 없습니다.');
        const value = JSON.parse(body);
        if (
          !(await verifyTurnstile(
            env.TURNSTILE_SECRET,
            value.token,
            allowed.map((item) => new URL(item).hostname),
          ))
        )
          throw new HttpError(403, '확인을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        const expires = Math.floor(Date.now() / 1000) + 300;
        return json(
          {
            clearance: `${expires}.${await mac(env.SESSION_SECRET, `clear:${client}:${session}:${expires}`)}`,
          },
          200,
          cors,
        );
      }
      const release = url.searchParams.get('release');
      if (!release || ![env.DATA_RELEASE, env.PREVIOUS_RELEASE].includes(release))
        throw new HttpError(409, '자료가 갱신되었습니다. 페이지를 새로 열어 주세요.');
      return json(
        await serveData(url.pathname, url.searchParams, makeStore(env, release)),
        200,
        cors,
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      // Never log query strings, raw IPs, text, auth headers or upstream errors.
      if (status >= 500)
        console.log(
          JSON.stringify({
            event: 'archive-unavailable',
            route: url.pathname.startsWith('/v1/') ? url.pathname : 'other',
            at: new Date().toISOString(),
          }),
        );
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : '자료 연결이 일시적으로 어렵습니다. 잠시 후 다시 시도해 주세요.',
        },
        status,
        cors,
      );
    }
  },
};
