import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseOtherCatalog, otherSectionPath } from '../src/lib/other-text.ts';
import { isDialogueRows } from '../src/lib/dialogue.ts';
import { isWikiReading } from '../src/lib/wiki-reading.ts';

test('Other categories preserve explicit speakers, displayed order and branch boundaries', () => {
  execFileSync(
    process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_other_text.py'],
    { stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1' } },
  );
});
test('Other category links and catalog reject unsafe files and Chinese display labels', () => {
  const payload = {
    schema: 'hsr-other-catalog.v1',
    commit: 'a'.repeat(40),
    groups: [],
    speakers: {},
  };
  assert.equal(parseOtherCatalog(payload).groups.length, 0);
  const group = { id: 'npc-p4841', kind: 'npc', title: '폼폼', sections: [] };
  assert.throws(() => parseOtherCatalog({ ...payload, groups: [{ ...group, title: '帕姆' }] }));
  assert.throws(() => parseOtherCatalog({ ...payload, groups: [{ ...group, id: '../file' }] }));
  assert.throws(() =>
    parseOtherCatalog({
      ...payload,
      groups: [
        {
          ...group,
          sections: [
            {
              id: 's' + 'a'.repeat(16),
              title: '대화',
              rows: 1,
              sha256: 'a'.repeat(64),
              file: '../content.json',
            },
          ],
        },
      ],
    }),
  );
  const route = otherSectionPath('npc', group.id, 's' + 'a'.repeat(16), 'row & 1');
  const params = new URLSearchParams(route.split('?')[1]);
  assert.equal(params.get('row'), 'row & 1');
  assert.equal(params.get('group'), group.id);
});
test('published Other chapters satisfy the existing dialogue and BWIKI occurrence contracts', () => {
  if (!fs.existsSync('public/search/other-catalog.json')) return;
  const catalog = parseOtherCatalog(
    JSON.parse(fs.readFileSync('public/search/other-catalog.json', 'utf8')),
  );
  for (const group of catalog.groups)
    for (const section of group.sections) {
      const payload = JSON.parse(fs.readFileSync('public/search/' + section.file, 'utf8'));
      assert.ok(isDialogueRows(payload.rows), section.file);
      assert.ok(isWikiReading(payload.wikiReading, payload.rows), section.file);
    }
});
