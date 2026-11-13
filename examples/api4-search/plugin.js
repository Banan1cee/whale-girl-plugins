'use strict';

// Full-access CJS example. No real credentials or npm install scripts.
function intent(text, now = Date.now(), timeZone = 'Asia/Shanghai') {
  const query = String(text || '').trim();
  if (!/查一下|帮我查|搜索|联网|NBA|比分|谁赢|现价|发布会|出处|怎么读|天气/i.test(query)) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const offset = /昨天|昨晚/.test(query) ? -1 : /明天/.test(query) ? 1 : /今天|今日|现价/.test(query) ? 0 : null;
  const date = offset === null ? null : new Date(Date.parse(today + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  return { query, timeZone, dateRange: date ? { start: date, end: date } : undefined,
    domain: /天气/.test(query) ? 'weather' : /NBA|比分|谁赢/i.test(query) ? 'sports' : 'web' };
}

exports.intent = intent;
exports.hooks = {
  'chat.search': async ctx => {
    const request = intent(ctx.message.text, ctx.now, ctx.settings.timeZone || 'Asia/Shanghai');
    if (!request) return {};
    const { query, ...options } = request;
    const search = await ctx.whale.search(query, { ...options, timeoutMs: 8000 });
    // The actual evidence, including unknown publication dates, is passed through unchanged.
    return { search };
  },
};
exports.run = async ctx => {
  const request = intent(typeof ctx.input === 'string' ? ctx.input : ctx.input?.text, ctx.now);
  if (!request) return { triggered: false };
  const { query, ...options } = request;
  return { triggered: true, search: await ctx.whale.search(query, options) };
};
