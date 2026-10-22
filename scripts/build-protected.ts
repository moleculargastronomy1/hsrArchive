import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';
import { archive } from '../src/data/archive.ts';
import { searchText, rendered } from '../worker/service.ts';
import { sealData, assertSealedData } from './source-first-publication.mjs';
import { packState, hash } from './verification-state.mjs';
import { preparePublic } from './protected-public.mjs';
import { auditProtected } from './check-protected-exposure.mjs';

const root = process.cwd();
const output = path.resolve('.cache/protected');
const endpoint = process.env.VITE_DATA_API_URL;
if (
  !endpoint ||
  (!/^https:\/\/[^/]+\/?$/.test(endpoint) && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(endpoint))
)
  throw new Error(
    'Set VITE_DATA_API_URL to the approved Worker origin (or local 127.0.0.1 preview)',
  );
if (await fs.stat(path.join(output, 'candidate.json')).catch(() => false))
  throw new Error(
    'Candidate already exists. Preserve it; use a fresh isolated worktree for a new candidate.',
  );
await fs.mkdir(output, { recursive: true });
execFileSync(
  process.env.HSR_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
  ['scripts/validate-content-stage.py', '.'],
  { stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } },
);
const seal = await sealData(root);
const code = [];
const codeFiles = [
  'public/content-watch.json',
  'public/verification-progress.json',
  'public/site-update.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
];
async function collectCode(folder: string) {
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    const file = `${folder}/${item.name}`;
    if (item.isDirectory() && item.name !== '__pycache__') await collectCode(file);
    else if (item.isFile() && /\.(?:ts|tsx|mjs|py|json|css|yml)$/.test(file)) codeFiles.push(file);
  }
}
for (const folder of ['worker', 'src', 'scripts', 'editorial', 'tests', '.github/workflows'])
  await collectCode(folder);
for (const file of codeFiles.sort()) code.push({ file, sha256: hash(await fs.readFile(file)) });
const release = hash(JSON.stringify({ seal, code, schema: 'hsr-private-release.v1' }));
process.env.VITE_DATA_RELEASE = release;
// Prepare a private, byte-exact recovery snapshot. No raw upstream collection.
const snapshot = await packState(root);
const prefix = `releases/${release}`;
const objects: { key: string; sha256: string; size: number }[] = [];
const files = [
  ...seal.files.map((f: { file: string }) => f.file),
  ...[
    'verification-state.json',
    snapshot.file,
    'content-watch.json',
    'verification-progress.json',
    'site-update.json',
  ].map((f) => 'public/' + f),
];
for (const file of files) {
  const bytes = await fs.readFile(file);
  const target = path.join(output, 'r2', prefix, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  objects.push({ key: `${prefix}/${file}`, sha256: hash(bytes), size: bytes.length });
}
const database = path.join(output, 'search.sqlite');
const db = new DatabaseSync(database);
const schema = `CREATE TABLE search_rows (release TEXT NOT NULL, ordinal INTEGER NOT NULL, category TEXT NOT NULL, search TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX search_release ON search_rows(release, ordinal);
CREATE INDEX search_scope ON search_rows(release, category, ordinal);
CREATE VIRTUAL TABLE search_fts USING fts5(search, content='search_rows', content_rowid='rowid', tokenize='trigram case_sensitive 1');`;
db.exec(schema);
const sql = createWriteStream(path.join(output, 'search.sql'));
sql.write(schema + '\n');
const literal = (v: unknown) => "'" + String(v).replaceAll("'", "''") + "'";
const source = JSON.parse(await fs.readFile('public/content/search-index.json', 'utf8'));
const categories = new Map(archive.map((e) => [e.id, e.category]));
const insert = db.prepare('INSERT INTO search_rows VALUES (?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (const [index, row] of source.rows.entries()) {
  if (!categories.has(row.entryId)) throw new Error('Missing search category');
  const values = [
    release,
    index,
    categories.get(row.entryId),
    searchText(row),
    JSON.stringify(row),
  ];
  insert.run(...values);
  if (!sql.write(`INSERT INTO search_rows VALUES (${values.map(literal).join(',')});\n`))
    await once(sql, 'drain');
}
db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild'); COMMIT;");
sql.end("INSERT INTO search_fts(search_fts) VALUES('rebuild');\n");
await once(sql, 'finish');
db.close();
// Every referenced chapter is renderable with exactly the existing renderer.
let chapters = 0,
  rows = 0,
  occurrences = 0;
for (const entry of archive)
  for (const chapter of entry.chapters) {
    if (!chapter.content) continue;
    const data = JSON.parse(
      await fs.readFile(path.join(root, 'public', chapter.content.file), 'utf8'),
    );
    const display = rendered(data);
    if (new Set(display.map((r) => r.id)).size !== data.rows.length)
      throw new Error('Lost canonical rows');
    chapters++;
    rows += data.rows.length;
    occurrences += display.length;
  }
await preparePublic(root, path.join(output, 'public'));
await build({ mode: 'protected' });
await assertSealedData(root, seal);
for (const item of code)
  if (hash(await fs.readFile(item.file)) !== item.sha256)
    throw new Error('Code or policy changed during candidate generation');
await auditProtected(root, path.join(output, 'dist'));
const artifacts = ['search.sqlite', 'search.sql'];
async function artifactFiles(folder: string, prefix = '') {
  for (const item of await fs.readdir(path.join(folder, prefix), { withFileTypes: true })) {
    const file = path.join(prefix, item.name);
    if (item.isDirectory()) await artifactFiles(folder, file);
    else artifacts.push('dist/' + file.replaceAll('\\', '/'));
  }
}
await artifactFiles(path.join(output, 'dist'));
const hashes: Record<string, string> = {};
for (const file of artifacts) hashes[file] = hash(await fs.readFile(path.join(output, file)));
const candidate = {
  schema: 'hsr-protected-candidate.v1',
  release,
  endpoint,
  prefix,
  seal,
  code,
  objects,
  hashes,
  snapshot,
  summary: {
    chapters,
    rows,
    occurrences,
    searchRows: source.rows.length,
    privateBytes: objects.reduce((n, o) => n + o.size, 0),
  },
};
await fs.writeFile(path.join(output, 'candidate.json'), JSON.stringify(candidate, null, 2));
console.log(JSON.stringify({ release, ...candidate.summary }));
