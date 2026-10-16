import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGameText, searchableGameText } from '../src/lib/game-text.ts';

test('game ruby keeps the official base and annotation without displaying control tags', () => {
  const text = '그는 {RUBY_B#「지식의 에이언즈」} 누스{RUBY_E#}를 안다.';
  assert.deepEqual(parseGameText(text), [
    { text: '그는 ' },
    { text: '누스', ruby: '「지식의 에이언즈」' },
    { text: '를 안다.' },
  ]);
  const searchable = searchableGameText(text);
  assert.ok(searchable.includes('그는 누스를 안다.'));
  assert.ok(searchable.includes('「지식의 에이언즈」'));
  assert.ok(!searchable.includes('RUBY_'));
  assert.deepEqual(parseGameText('{RUBY_B#{TEXTJOIN#254}}SNS{RUBY_E#}'), [{ text: 'SNS' }]);
  assert.deepEqual(parseGameText('{RUBY_B#첫째}하나{RUBY_E#}{RUBY_B#둘째}둘{RUBY_E#}'), [
    { text: '하나', ruby: '첫째' },
    { text: '둘', ruby: '둘째' },
  ]);
  for (const original of ['일반 대사 {NICKNAME}', '<script>문자열</script>', '{RUBY_B#미완성}'])
    assert.deepEqual(parseGameText(original), [{ text: original }]);
});

test('published Korean and comparison passages have no unhandled ruby control tags', () => {
  const files = ['public/content/search-index.json'];
  for (const language of ['en', 'zh-CN', 'ja']) {
    files.push(
      ...fs
        .readdirSync(`public/content/locales/${language}`)
        .map((file) => `public/content/locales/${language}/${file}`),
    );
  }
  let count = 0;
  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const row of payload.rows) {
      if (!row.text.includes('{RUBY_')) continue;
      count++;
      for (const part of parseGameText(row.text)) {
        assert.ok(!/\{RUBY_[BE]#/.test(part.text + (part.ruby ?? '')), `${file}: ${row.id}`);
      }
    }
  }
  assert.ok(count > 1000);
});
