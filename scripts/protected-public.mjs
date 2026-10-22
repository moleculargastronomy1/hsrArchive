import fs from 'node:fs/promises';
import path from 'node:path';

export const publicJson = new Set([
  'content-update.json',
  'site-update.json',
  'official-videos.json',
  'video-review-summary.json',
]);
export function sanitizeMetadata(data) {
  if (Array.isArray(data)) return data.map(sanitizeMetadata);
  if (!data || typeof data !== 'object') return data;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      key === 'blocks' && data.content ? [] : key === 'sourceIds' ? [] : sanitizeMetadata(value),
    ]),
  );
}
export async function preparePublic(root, output) {
  await fs.mkdir(output, { recursive: true });
  for (const file of publicJson)
    await fs.copyFile(path.join(root, 'public', file), path.join(output, file));
  await fs.copyFile(path.join(root, 'public/favicon.svg'), path.join(output, 'favicon.svg'));
  // Deliberate allowlist. New public file types must be reviewed here.
}
export function protectedMetadataPlugin() {
  return {
    name: 'hsr-protected-metadata',
    enforce: 'pre',
    async load(id) {
      if (/\/src\/data\/[^/?]+\.json$/.test(id.replaceAll('\\', '/'))) {
        const value = JSON.parse(await fs.readFile(id, 'utf8'));
        return JSON.stringify(sanitizeMetadata(value));
      }
    },
  };
}
