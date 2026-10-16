import crypto from 'node:crypto';

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function selectVideoChecks(queue, checks, checkedAt, limit = 2) {
  const selected = [], seen = new Set();
  for (const item of queue) {
    if (selected.length >= limit) break;
    if (seen.has(item.video.id)) continue;
    const lastCheck = Date.parse(checks?.[item.video.id]?.checkedAt ?? '');
    if (Number.isFinite(lastCheck) && Date.parse(checkedAt) - lastCheck < 86400000) continue;
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
  const response = await fetcher(source.playlistUrl, { signal: AbortSignal.timeout(30000) });
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
        context: { client: { clientName: 'WEB', clientVersion: version } },
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

export function restoreVideoOrder(payload, evidence) {
  const byId = new Map(payload.rows.map((row) => [row.id, row]));
  const counts = new Map();
  for (const row of payload.rows) {
    const text = normalizedKorean(row.text);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const matches = evidence.matches
    .filter(
      (match) =>
        byId.has(match.rowId) &&
        byId.get(match.rowId).type !== 'choice' &&
        counts.get(normalizedKorean(byId.get(match.rowId).text)) === 1 &&
        Number.isFinite(match.startMs) &&
        Number.isFinite(match.endMs) &&
        match.startMs >= 0 &&
        match.endMs >= match.startMs &&
        sha256(byId.get(match.rowId).text) === match.koreanHash,
    )
    .sort((a, b) => a.startMs - b.startMs);
  if (new Set(matches.map((match) => match.rowId)).size !== matches.length)
    return { changed: 0, confirmed: 0 };
  if (matches.length < 3) return { changed: 0, confirmed: 0 };
  const positions = new Map(payload.rows.map((row, index) => [row.id, index]));
  const anchors = matches.filter((match) =>
    ['matched', 'cached'].includes(byId.get(match.rowId).bwikiStatus ?? ''),
  );
  // BWIKI remains primary. A conflicting path cannot override it automatically.
  for (let i = 1; i < anchors.length; i++) {
    const a = byId.get(anchors[i - 1].rowId),
      b = byId.get(anchors[i].rowId);
    if (a.bwikiMissionId === b.bwikiMissionId && positions.get(a.id) >= positions.get(b.id))
      return { changed: 0, confirmed: 0, conflict: true };
  }
  let changed = 0,
    confirmed = 0;
  for (let i = 1; i < anchors.length; i++) {
    const first = anchors[i - 1],
      last = anchors[i];
    const a = byId.get(first.rowId),
      b = byId.get(last.rowId);
    if (!a.bwikiMissionId || a.bwikiMissionId !== b.bwikiMissionId) continue;
    const middle = matches.filter(
      (match) =>
        match.startMs > first.startMs &&
        match.startMs < last.startMs &&
        !['matched', 'cached'].includes(byId.get(match.rowId).bwikiStatus ?? '') &&
        byId.get(match.rowId).flowStatus !== 'verified',
    );
    if (!middle.length) continue;
    const before = payload.rows.map((row) => row.id);
    const aIndex = payload.rows.findIndex((row) => row.id === first.rowId);
    const bIndex = payload.rows.findIndex((row) => row.id === last.rowId);
    const outside = middle.filter((match) => {
      const index = payload.rows.findIndex((row) => row.id === match.rowId);
      return index < aIndex || index > bIndex;
    });
    const outsideIds = new Set(outside.map((match) => match.rowId));
    payload.rows = payload.rows.filter((row) => !outsideIds.has(row.id));
    const insertion = payload.rows.findIndex((row) => row.id === last.rowId);
    payload.rows.splice(insertion, 0, ...outside.map((match) => byId.get(match.rowId)));
    const middleIds = new Set(middle.map((match) => match.rowId));
    const slots = payload.rows.flatMap((row, index) => (middleIds.has(row.id) ? [index] : []));
    slots.forEach((slot, index) => {
      payload.rows[slot] = byId.get(middle[index].rowId);
    });
    for (const match of middle)
      Object.assign(byId.get(match.rowId), {
        videoStatus: 'caption-matched',
        videoId: evidence.videoId,
        videoStartMs: match.startMs,
      });
    changed += payload.rows.filter((row, index) => row.id !== before[index]).length;
    confirmed += middle.length;
  }
  return { changed, confirmed };
}
