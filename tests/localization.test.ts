import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  comparisonLanguages,
  isComparisonLanguages,
  localizationKey,
  parseLocalizations,
} from '../src/lib/localization.ts';

test('comparison preferences allow multiple languages and reject duplicates and unknown languages', () => {
  assert.ok(isComparisonLanguages([]));
  assert.ok(isComparisonLanguages(['en', 'zh-CN', 'ja']));
  for (const value of [null, ['en', 'en'], ['ko'], ['en', 1]])
    assert.equal(isComparisonLanguages(value), false);
  assert.throws(() => localizationKey({ entryId: '../secret', chapterId: 'chapter' }, 'en'));
});

test('translation loading validates language, chapter, text and duplicate row IDs', () => {
  const identity = { entryId: 'entry', chapterId: 'chapter' };
  const payload = {
    schema: 'hsr-localizations.v1',
    ...identity,
    language: 'en',
    referenceCommit: 'a'.repeat(40),
    rows: [{ id: 'a', text: 'Choice', speaker: '' }],
  };
  assert.equal(parseLocalizations(payload, identity, 'en').get('a')!.text, 'Choice');
  assert.throws(() => parseLocalizations(payload, identity, 'en', 'b'.repeat(40)));
  for (const value of [
    null,
    { ...payload, language: 'ja' },
    { ...payload, chapterId: 'wrong' },
    { ...payload, rows: [...payload.rows, ...payload.rows] },
    { ...payload, rows: [{ ...payload.rows[0], text: null }] },
  ])
    assert.throws(() => parseLocalizations(value, identity, 'en'));
});

test('published comparison files match Korean row identities, choices, variants and recorded coverage', () => {
  const receipt = JSON.parse(fs.readFileSync('public/content/locales/manifest.json', 'utf8'));
  const update = JSON.parse(fs.readFileSync('public/content-update.json', 'utf8'));
  assert.equal(receipt.commit, update.commit);
  for (const language of comparisonLanguages) {
    let total = 0,
      missing = 0,
      choices = 0;
    for (const name of fs.readdirSync(`public/content/locales/${language.id}`)) {
      const original = JSON.parse(fs.readFileSync(`public/content/${name}`, 'utf8'));
      const translated = JSON.parse(
        fs.readFileSync(`public/content/locales/${language.id}/${name}`, 'utf8'),
      );
      const rows = parseLocalizations(translated, original, language.id);
      assert.equal(translated.referenceCommit, receipt.commit);
      const sourceIds = new Set(original.rows.map((row: { id: string }) => row.id));
      assert.ok(
        [...rows.keys()].every((id) => sourceIds.has(id)),
        name,
      );
      total += rows.size;
      missing += original.rows.length - rows.size;
      choices += original.rows.filter(
        (row: { id: string; type: string }) => row.type === 'choice' && rows.has(row.id),
      ).length;
    }
    assert.deepEqual(receipt.coverage[language.id], { rows: total, choices, missing });
    assert.ok(total > 58000);
    assert.ok(choices > 4000);
    const nanook = JSON.parse(
      fs.readFileSync(
        `public/content/locales/${language.id}/codex-aeons--noun-atlas-102.json`,
        'utf8',
      ),
    );
    assert.ok(nanook.rows.length >= 2);
    assert.notEqual(nanook.rows[0].text, nanook.rows[1].text);
  }
});

test('multilingual projection preserves precise hash joins and rejects stale Korean text', () => {
  const python = process.env.HSR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, ['tests/test_localizations.py'], {
    stdio: 'pipe',
    env: { ...process.env, PYTHONUTF8: '1' },
  });
});
