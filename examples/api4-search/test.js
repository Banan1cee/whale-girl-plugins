'use strict';
const assert = require('node:assert/strict');
const { intent, hooks } = require('./plugin');
const now = Date.parse('2026-11-13T04:00:00Z');
const cases = [
  ['昨天NBA湖人打勇士谁赢了，比分多少', 'sports', '2026-11-12'],
  ['帮我查一下明天成都天气', 'weather', '2026-11-14'],
  ['在吗', null], ['今天心情不好', null], ['比特币现价', 'web', '2026-11-13'],
  ['昨晚发布会都发布了什么', 'web', '2026-11-12'], ['这个梗的出处', 'web', null],
  ['这个字怎么读', 'web', null], ['你叫什么名字', null],
];
for (const [text, domain, date] of cases) {
  const out = intent(text, now);
  assert.equal(out?.domain || null, domain, text);
  if (domain) assert.equal(out.dateRange?.start || null, date, text);
}
(async () => {
  const evidence = { status: 'ok', text: 'fixture', items: [{ title: 'fixture', url: 'https://example.test/source', publishedAt: null }] };
  const out = await hooks['chat.search']({ message: { text: cases[0][0] }, now, settings: {},
    whale: { search: async (query, options) => {
      assert.equal(query, cases[0][0]); assert.equal(options.dateRange.start, '2026-11-12'); return evidence;
    } } });
  assert.equal(out.search, evidence);
  console.log('Api 4 search: 9 intent/date cases and structured evidence passed.');
})();
