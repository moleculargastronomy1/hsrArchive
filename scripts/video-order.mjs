import crypto from 'node:crypto';

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const VIDEO_FIELDS = [
  'videoStatus',
  'videoId',
  'videoStartMs',
  'videoScene',
  'videoNextIds',
  'videoReplyToIds',
];
export const videoVerified = (row) =>
  ['caption-matched', 'screen-matched'].includes(row?.videoStatus);
export function mergeVideoChecks(...sources) {
  const merged = {};
  for (const source of sources)
    for (const [id, check] of Object.entries(source ?? {}))
      if (!merged[id] || Date.parse(check.checkedAt) > Date.parse(merged[id].checkedAt))
        merged[id] = check;
  return merged;
}

export function parseTranscriptExport(raw, videoId) {
  raw = raw.replace(/\r\n/g, '\n');
  if (
    !raw.startsWith('YouTube transcript\n') ||
    !raw.includes(`\nVideo ID: ${videoId}\n`) ||
    !/^Language: ko$/m.test(raw)
  )
    throw new Error('Transcript identity/language mismatch');
  const cues = [...raw.matchAll(/^\[(\d+(?::\d+){1,2})\] (.+)$/gm)].map((match) => ({
    startMs: match[1].split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000,
    text: match[2],
  }));
  if (!cues.length || cues.some((cue, index) => index && cue.startMs < cues[index - 1].startMs))
    throw new Error('Transcript timestamps unavailable or unordered');
  cues.forEach((cue, index) => {
    cue.endMs = cues[index + 1]?.startMs ?? cue.startMs;
  });
  return {
    cues,
    sha256: sha256(raw),
    language: 'ko',
    kind: /^Captions: auto-generated$/m.test(raw) ? 'asr' : 'manual',
    timingPrecisionMs: 1000,
  };
}

export function videoRetryDecision(report, now = Date.now(), algorithm) {
  const pending = Object.values(report?.chapters ?? {}).filter(
    (chapter) => chapter.pending ?? !['bwiki-matched', 'reference-only'].includes(chapter.status),
  );
  const ids = new Set(
    pending.flatMap((chapter) => (chapter.videos ?? []).map((video) => video.id)),
  );
  const due = [...ids].filter((id) => {
    const check = report.checks?.[id];
    const next = Date.parse(check?.nextRetryAt ?? '');
    if (Number.isFinite(next)) return next <= now;
    const last = Date.parse(check?.checkedAt ?? '');
    return !Number.isFinite(last) || last + 86400000 <= now;
  });
  return {
    needed: (algorithm !== undefined && report?.algorithm !== algorithm) || due.length > 0,
    due,
    reason:
      algorithm !== undefined && report?.algorithm !== algorithm
        ? 'video-algorithm-changed'
        : due.length
          ? 'public-captions-due'
          : 'video-backoff-or-no-source',
  };
}

export function selectVideoChecks(queue, checks, checkedAt, limit = 2) {
  const selected = [],
    seen = new Set();
  for (const item of queue) {
    if (selected.length >= limit) break;
    if (seen.has(item.video.id)) continue;
    const check = checks?.[item.video.id];
    const next = Date.parse(check?.nextRetryAt ?? '');
    const lastCheck = Date.parse(check?.checkedAt ?? '');
    if (
      Number.isFinite(next)
        ? Date.parse(checkedAt) < next
        : Number.isFinite(lastCheck) && Date.parse(checkedAt) - lastCheck < 86400000
    )
      continue;
    selected.push(item);
    seen.add(item.video.id);
  }
  return selected;
}

export function jsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('Public page data unavailable');
  const start = html.indexOf('{', at + marker.length);
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i >= 0 && i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('Incomplete public page data');
}

export function playlistItems(data) {
  const videos = [],
    tokens = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    const lock = value.lockupViewModel;
    const old = value.playlistVideoRenderer;
    const id = lock?.contentId ?? old?.videoId;
    const title =
      lock?.metadata?.lockupMetadataViewModel?.title?.content ??
      old?.title?.runs?.map((x) => x.text).join('');
    if (/^[\w-]{11}$/.test(id ?? '') && title)
      videos.push({ id, title, url: `https://www.youtube.com/watch?v=${id}` });
    const command = value.innertubeCommand;
    if (
      command?.commandMetadata?.webCommandMetadata?.apiUrl === '/youtubei/v1/browse' &&
      typeof command.continuationCommand?.token === 'string'
    )
      tokens.push(command.continuationCommand.token);
    for (const child of Object.values(value)) walk(child);
  }
  walk(data);
  return { videos, tokens: [...new Set(tokens)] };
}

export async function fetchPlaylist(source, fetcher = fetch) {
  const url = new URL(source.playlistUrl);
  url.searchParams.set('hl', 'ko');
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(30000),
    headers: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!response.ok) throw new Error('Public playlist unavailable');
  const html = await response.text();
  const initial = jsonAfter(html, 'var ytInitialData =');
  if (
    initial.metadata?.playlistMetadataRenderer?.title === undefined ||
    !html.includes(source.channelId)
  )
    throw new Error('Playlist identity mismatch');
  const first = playlistItems(initial);
  const videos = new Map(first.videos.map((item) => [item.id, item]));
  const pending = [...first.tokens],
    visited = new Set();
  const version = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1];
  while (pending.length && visited.size < 10) {
    const token = pending.shift();
    if (visited.has(token)) continue;
    if (!version) throw new Error('Public continuation unavailable');
    visited.add(token);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const next = await fetcher('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: version, hl: 'ko', gl: 'KR' } },
        continuation: token,
      }),
    });
    if (!next.ok || !next.headers.get('content-type')?.includes('json'))
      throw new Error('Public continuation restricted');
    const part = playlistItems(await next.json());
    for (const item of part.videos) videos.set(item.id, item);
    pending.push(...part.tokens.filter((item) => !visited.has(item)));
  }
  if (pending.some((item) => !visited.has(item))) throw new Error('Incomplete public playlist');
  return [...videos.values()];
}

export function normalizedKorean(text) {
  const value = text
    .replace(/\{RUBY_B#(?:[^{}]|\{[^{}]*\})*\}([\s\S]*?)\{RUBY_E#\}/g, '$1')
    .replace(/<[^>]*>/g, '')
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR');
  return [...value]
    .filter(
      (char, index) =>
        !/[\p{P}\s]/u.test(char) ||
        (/[.,]/.test(char) &&
          /\d/.test(value[index - 1] ?? '') &&
          /\d/.test(value[index + 1] ?? '')),
    )
    .join('');
}

export function captionCues(data) {
  if (!Array.isArray(data.events)) throw new Error('Unsupported public captions');
  return data.events
    .filter((event) => Array.isArray(event.segs))
    .map((event) => ({
      startMs: event.tStartMs,
      endMs: event.tStartMs + event.dDurationMs,
      text: event.segs.map((segment) => segment.utf8 ?? '').join(''),
    }))
    .filter(
      (cue) =>
        Number.isFinite(cue.startMs) &&
        Number.isFinite(cue.endMs) &&
        cue.startMs >= 0 &&
        cue.endMs >= cue.startMs &&
        cue.text.trim(),
    );
}

export async function fetchPublicCaptions(video, channelId, fetcher = fetch) {
  const response = await fetcher(video.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Video page unavailable');
  const html = await response.text();
  const player = jsonAfter(html, 'var ytInitialPlayerResponse =');
  if (player.videoDetails?.videoId !== video.id || player.videoDetails?.channelId !== channelId)
    throw new Error('Video identity mismatch');
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track =
    tracks.find((item) => item.languageCode === 'ko' && item.kind !== 'asr') ??
    tracks.find((item) => item.languageCode === 'ko');
  if (!track?.baseUrl) throw new Error('Korean captions unavailable');
  const url = new URL(track.baseUrl);
  if (
    url.protocol !== 'https:' ||
    !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
    url.pathname !== '/api/timedtext'
  )
    throw new Error('Unexpected caption source');
  url.searchParams.set('fmt', 'json3');
  const captions = await fetcher(url, { signal: AbortSignal.timeout(30000) });
  if (!captions.ok) throw new Error('Public captions restricted');
  const raw = await captions.text();
  if (!raw.trim()) throw new Error('Public captions unreadable');
  const cues = captionCues(JSON.parse(raw));
  if (!cues.length) throw new Error('Public captions empty');
  return {
    cues,
    sha256: sha256(raw),
    language: 'ko',
    kind: track.kind === 'asr' ? 'asr' : 'manual',
  };
}

export function matchCaptions(rows, cues) {
  const counts = new Map();
  for (const row of rows) {
    const text = normalizedKorean(row.text);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  // Use time-bounded windows; never concatenate unrelated distant captions.
  const windows = cues.map((cue, index) => {
    let text = '',
      endMs = cue.endMs;
    for (let i = index; i < cues.length && cues[i].startMs - cue.startMs <= 30000; i++) {
      text += normalizedKorean(cues[i].text);
      endMs = cues[i].endMs;
    }
    return { text, startMs: cue.startMs, endMs };
  });
  const matches = [];
  for (const row of rows) {
    const text = normalizedKorean(row.text);
    const unresolved = row.text.replace(
      /\{RUBY_B#(?:[^{}]|\{[^{}]*\})*\}([\s\S]*?)\{RUBY_E#\}/g,
      '$1',
    );
    if (
      row.type === 'choice' ||
      text.length < 16 ||
      /[{}]/.test(unresolved) ||
      counts.get(text) !== 1
    )
      continue;
    const hits = windows.filter((window) => window.text.includes(text));
    if (!hits.length) continue;
    // Overlapping windows describe one utterance; widely separated repeats are ambiguous.
    if (hits.at(-1).startMs - hits[0].startMs > 30000) continue;
    matches.push({
      rowId: row.id,
      startMs: hits.at(-1).startMs,
      endMs: hits.at(-1).endMs,
      koreanHash: sha256(row.text),
    });
  }
  return matches.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

// Fresh and cached evidence use the same exact-text, identity and timestamp rules.
export function validatedCaptionMatches(rows, evidence) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const counts = new Map();
  for (const row of rows) {
    const text = normalizedKorean(row.text);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const matches = evidence.matches
    .filter((match) => {
      const row = byId.get(match.rowId);
      return (
        row &&
        (match.talkId === undefined || row.talkId === match.talkId) &&
        row.type !== 'choice' &&
        normalizedKorean(row.text).length >= 16 &&
        !/[{}]/.test(
          row.text.replace(/\{RUBY_B#(?:[^{}]|\{[^{}]*\})*\}([\s\S]*?)\{RUBY_E#\}/g, '$1'),
        ) &&
        counts.get(normalizedKorean(row.text)) === 1 &&
        Number.isFinite(match.startMs) &&
        Number.isFinite(match.endMs) &&
        match.startMs >= 0 &&
        match.endMs >= match.startMs &&
        sha256(row.text) === match.koreanHash
      );
    })
    .sort((a, b) => a.startMs - b.startMs);
  return new Set(matches.map((match) => match.rowId)).size === matches.length ? matches : [];
}
