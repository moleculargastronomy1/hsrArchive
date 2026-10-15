export const CHANNEL_ID = 'UCH33CJMcI0XZUpIhWRHiUuw';
export const CHANNEL_URL = 'https://www.youtube.com/@Honkaistarrail_kr/videos';

const decode = (text) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export function parseVideos(xml) {
  if (!xml.includes(CHANNEL_ID)) throw new Error('Unexpected YouTube channel');
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, entry]) => {
      const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
      const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
      const url = entry.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/)?.[1];
      if (
        !id ||
        !/^[\w-]{11}$/.test(id) ||
        !title ||
        !published ||
        Number.isNaN(Date.parse(published))
      )
        throw new Error('Invalid video feed entry');
      return {
        id,
        title: decode(title),
        published,
        url: `https://www.youtube.com/watch?v=${id}`,
        isShort: Boolean(url?.includes('/shorts/')),
      };
    })
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}
