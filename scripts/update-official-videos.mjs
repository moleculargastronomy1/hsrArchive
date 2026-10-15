import fs from 'node:fs';
import { CHANNEL_ID, CHANNEL_URL, parseVideos } from './youtube-feed.mjs';

const target = 'public/official-videos.json';
try {
  const response = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok) throw new Error(`YouTube feed HTTP ${response.status}`);
  const videos = parseVideos(await response.text());
  if (!videos.length) throw new Error('Empty official video feed');
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        channelId: CHANNEL_ID,
        channelUrl: CHANNEL_URL,
        checkedAt: new Date().toISOString(),
        // The requested /videos tab excludes Shorts; retain a Short only if no normal video is available.
        video: videos.find((video) => !video.isShort) ?? videos[0],
        recent: videos.slice(0, 5),
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Official YouTube video snapshot refreshed.');
} catch (error) {
  if (!fs.existsSync(target)) throw error;
  console.warn(`Keeping the last verified official video snapshot: ${error.message}`);
}
