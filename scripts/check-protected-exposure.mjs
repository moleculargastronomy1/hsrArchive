import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicJson } from './protected-public.mjs';

export async function auditProtected(root, dist) {
  const files = [];
  const visit = async (dir, prefix = '') => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error('Symlink in public artifact');
      if (item.isDirectory()) await visit(path.join(dir, item.name), relative + '/');
      else files.push(relative);
    }
  };
  await visit(dist);
  for (const file of files)
    if (
      !publicJson.has(file) &&
      !['index.html', 'favicon.svg'].includes(file) &&
      !/^assets\/[^/\\]+\.(?:js|css|png|jpe?g|webp|svg|woff2?)$/.test(file)
    )
      throw new Error('Forbidden public artifact: ' + file);
  // Chapter-body canaries also detect leakage through JS strings/escaped JSON.
  const canaries = new Set();
  for (const name of await fs.readdir(path.join(root, 'public/content'))) {
    if (!name.endsWith('.json') || name === 'search-index.json') continue;
    const data = JSON.parse(await fs.readFile(path.join(root, 'public/content', name), 'utf8'));
    for (const row of data.rows ?? [])
      if (row.text.length > 100) {
        canaries.add(row.text);
        break;
      }
  }
  for (const file of files.filter((f) => /\.(?:js|json|html)$/.test(f))) {
    const text = await fs.readFile(path.join(dist, file), 'utf8');
    for (const name of [
      'SESSION_SECRET',
      'INTERNAL_TOKEN',
      'HSR_PRIVATE_STATE_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'HSR_FRONTEND_TOKEN',
    ])
      if (process.env[name]?.length >= 12 && text.includes(process.env[name]))
        throw new Error('Private credential in public artifact: ' + file);
    if (/serviceWorker\.register|sourceMappingURL=|hsr-dialogue\.v1.{0,15}["']rows/.test(text))
      throw new Error('Unexpected worker/map/body in public artifact: ' + file);
    for (const canary of canaries)
      if (text.includes(canary) || text.includes(JSON.stringify(canary).slice(1, -1)))
        throw new Error('Chapter body in public artifact: ' + file);
  }
  return { files: files.length, canaries: canaries.size };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(
    await auditProtected(process.cwd(), path.resolve(process.argv[2] ?? '.cache/protected/dist')),
  );
