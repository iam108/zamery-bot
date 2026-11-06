'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReportLinkAdmin, setupReportLinkAdmin, BATCH_SIZE, PREVIEW_TTL, MAX_PREVIEWS } = require('../src/bot/report-link-admin');

const group = '-1001234567890';
const rows = () => ({ items: [{ order_id: 58, url: 'https://t.me/c/1234567890/100' }, { order_id: 59, code: 'ORDER_CARD_MISSING' }, { order_id: 60 }], nextAfterId: 60 });
const complete = ids => ({ complete: true, results: ids.map(order_id => ({ order_id, state: 'linked' })) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(setImmediate);
function fixture() {
  let time = 1000, serial = 0, admins = ['108'], preview = rows, apply = complete;
  const reads = [], writes = [], replies = [], answers = [];
  const options = {
    groupId: group, pool: {}, adminIds: () => admins, now: () => time, token: () => String(++serial).padStart(16, 'A'),
    async previewOrderReportLinks(input) { reads.push(input); return preview(input); },
    async applyOrderReportLinks(ids, input) { writes.push({ ids: [...ids], input }); return apply(ids, input); },
  };
  const commands = createReportLinkAdmin(options);
  function ctx(actor = 108, overrides = {}) {
    const local = { from: { id: actor }, chat: { id: actor, type: 'private' }, message: { text: '/report_links' }, replies: [], answers: [],
      telegram: { sendMessage() { assert.fail('Never send a new working-chat card'); }, sendDocument() { assert.fail('Never resend a report'); } },
      async reply(text, markup) { const item = { text, markup }; local.replies.push(item); replies.push(item); return { message_id: replies.length }; },
      async answerCbQuery(text) { local.answers.push(text); answers.push(text); },
    };
    return Object.assign(local, overrides);
  }
  const data = context => context.replies.at(-1)?.markup?.reply_markup?.inline_keyboard[0][0].callback_data;
  return { options, commands, reads, writes, replies, answers, ctx, data,
    setPreview(fn) { preview = fn; }, setApply(fn) { apply = fn; }, setAdmins(ids) { admins = ids.map(String); }, advance(ms) { time += ms; },
    async preview(actor = 108, overrides) { const context = ctx(actor, overrides); await commands.preview(context); return context; },
    async apply(data, actor = 108, overrides) { const context = ctx(actor, { callbackQuery: { data }, ...overrides }); await commands.apply(context); return context; },
  };
}

test('setup only registers private preview and apply commands plus the explicit apply button; it performs no startup work', () => {
  const commands = [], actions = [];
  setupReportLinkAdmin({ command(name, run) { commands.push({ name, run }); }, action(pattern, run) { actions.push({ pattern, run }); } }, {
    previewOrderReportLinks: () => assert.fail('No startup reads'), applyOrderReportLinks: () => assert.fail('No startup writes'),
  });
  assert.deepEqual(commands.map(item => item.name), ['report_links', 'report_links_apply']); assert.equal(actions.length, 1);
  assert.ok(actions[0].pattern.test('report_links_apply:abcdefghijklmnop')); assert.equal(BATCH_SIZE, 20);
});

test('only explicit configured administrators in their private chat can preview or apply, with no manager fallback', async () => {
  const h = fixture();
  for (const context of [h.ctx(109), h.ctx(108, { chat: { id: -1001, type: 'supergroup' } }), h.ctx(109, { staff: { role: 'manager', approved: true } })]) {
    await h.commands.preview(context); await h.commands.apply({ ...context, callbackQuery: { data: 'report_links_apply:abcdefghijklmnop' } });
  }
  h.setAdmins([]); await h.commands.preview(h.ctx());
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.replies.length, 0);
});

test('preview reads at most twenty exact candidates and exposes human order numbers without internal IDs or raw URLs', async () => {
  const h = fixture(), context = await h.preview(108, { message: { text: '/report_links@audit_bot 57' } });
  assert.equal(h.reads.length, 1); assert.deepEqual(h.reads[0], { pool: h.options.pool, groupId: group, limit: 20, afterId: 57 });
  assert.equal(h.writes.length, 0); assert.match(context.replies[0].text, /#58/); assert.match(context.replies[0].text, /#59 — нет исходной карточки/);
  assert.ok(!context.replies[0].text.includes('https://')); assert.ok(!context.replies[0].text.includes(group));
  assert.match(h.data(context), /^report_links_apply:[A-Za-z0-9_-]{16}$/);
  assert.equal(context.replies[0].markup.reply_markup.inline_keyboard[0][0].text, 'Добавить переходы');
});

test('an explicit apply uses only the reviewed repairable IDs and reports preview skips truthfully', async () => {
  const h = fixture(), preview = await h.preview(), data = h.data(preview), result = await h.apply(data);
  assert.deepEqual(h.writes.map(item => item.ids), [[58, 60]]); assert.equal(h.writes[0].input.groupId, group);
  assert.equal(h.writes[0].input.telegram, result.telegram);
  assert.match(result.replies[0].text, /готово 2, пропущено 1, осталось 0/); assert.match(result.replies[0].text, /#59 — нет исходной карточки/);
  assert.match(result.replies[0].text, /\/report_links 60/);
  await h.apply(data); assert.equal(h.writes.length, 1, 'Repeated completed buttons use the cached receipt');
});

test('a partial or throttled batch stops and its explicit retry continues only the remaining IDs', async () => {
  const h = fixture(); let first = true;
  h.setApply(ids => { if (!first) return complete(ids); first = false; return { complete: false, results: [{ order_id: 58, state: 'linked' }], failed_order_id: 60, error: { message: 'raw provider secret' } }; });
  const data = h.data(await h.preview()), stopped = await h.apply(data);
  assert.match(stopped.replies[0].text, /готово 1, пропущено 1, осталось 1/); assert.ok(!stopped.replies[0].text.includes('raw provider'));
  assert.equal(stopped.replies[0].markup.reply_markup.inline_keyboard[0][0].callback_data, data);
  assert.deepEqual(h.writes.map(item => item.ids), [[58, 60]]);
  const done = await h.apply(data); assert.deepEqual(h.writes.map(item => item.ids), [[58, 60], [60]]); assert.match(done.replies[0].text, /готово 2, пропущено 1, осталось 0/);
});

test('a lost private result acknowledgement cannot repeat an already processed batch', async () => {
  const h = fixture(), data = h.data(await h.preview());
  await assert.rejects(h.apply(data, 108, { reply: async () => { throw new Error('Synthetic lost DM ACK'); } }), /lost DM ACK/);
  const repeated = await h.apply(data); assert.equal(h.writes.length, 1); assert.equal(repeated.replies.length, 0); assert.match(repeated.answers[0], /уже обработаны/);
});

test('one active repair batch rejects duplicate taps and other administrators instead of starting a queue', async () => {
  const h = fixture(), wait = deferred(); h.setAdmins([108, 109]);
  const a = h.data(await h.preview(108)), b = h.data(await h.preview(109)); h.setApply(async ids => { await wait.promise; return complete(ids); });
  const first = h.apply(a, 108); await turn();
  for (const [data, actor] of [[a, 108], [b, 109]]) assert.match((await h.apply(data, actor)).answers[0], /уже выполняется/);
  const reads = h.reads.length; assert.match((await h.preview(108)).replies[0].text, /уже выполняется/); assert.equal(h.reads.length, reads);
  assert.equal(h.writes.length, 1); wait.resolve(); await first; await h.apply(b, 109); assert.equal(h.writes.length, 2);
});

test('a slow preview finishing during apply cannot replace that batch or lose its remaining retry', async () => {
  const h = fixture(), data = h.data(await h.preview()), listing = deferred(), applying = deferred();
  h.setPreview(async () => { await listing.promise; return { items: [{ order_id: 99 }], nextAfterId: null }; });
  const slow = h.preview(); await turn(); h.setApply(async () => { await applying.promise; return { complete: false, results: [{ order_id: 58, state: 'linked' }], failed_order_id: 60 }; });
  const running = h.apply(data); await turn(); listing.resolve(); assert.match((await slow).replies[0].text, /уже выполняется/);
  applying.resolve(); await running; h.setApply(complete); await h.apply(data); assert.deepEqual(h.writes.map(item => item.ids), [[58, 60], [60]]);
});

test('expired, replaced, restarted, cross-user and changed-group previews cannot be applied', async () => {
  const h = fixture(); h.setAdmins([108, 109]);
  const old = h.data(await h.preview()), fresh = h.data(await h.preview());
  assert.match((await h.apply(old)).answers[0], /устарел/); assert.match((await h.apply(fresh, 109)).answers[0], /устарел/);
  const restarted = createReportLinkAdmin(h.options), context = h.ctx(108, { callbackQuery: { data: fresh } }); await restarted.apply(context); assert.match(context.answers[0], /устарел/);
  h.advance(PREVIEW_TTL); assert.match((await h.apply(fresh)).answers[0], /устарел/);
  const next = h.data(await h.preview()); h.options.groupId = '-1009999999999'; assert.match((await h.apply(next)).answers[0], /устарел/); assert.equal(h.writes.length, 0);
});

test('a group configuration change while preview is loading still requires a fresh preview', async () => {
  const h = fixture(), wait = deferred(); h.setPreview(async () => { await wait.promise; return rows(); });
  const listing = h.preview(); await turn(); h.options.groupId = '-1009999999999'; wait.resolve();
  const data = h.data(await listing); assert.match((await h.apply(data)).answers[0], /устарел/); assert.equal(h.writes.length, 0);
});

test('preview state is capped at one hundred administrators and expired entries release admission', async () => {
  const h = fixture(); h.setAdmins(Array.from({ length: MAX_PREVIEWS + 1 }, (_, index) => index + 1));
  for (let actor = 1; actor <= MAX_PREVIEWS; actor++) await h.preview(actor);
  assert.match((await h.preview(MAX_PREVIEWS + 1)).replies[0].text, /слишком много просмотров/); assert.equal(h.reads.length, MAX_PREVIEWS);
  h.advance(PREVIEW_TTL); assert.ok(h.data(await h.preview(MAX_PREVIEWS + 1))); assert.equal(h.reads.length, MAX_PREVIEWS + 1); assert.equal(h.writes.length, 0);
});

test('concurrent previews recheck the state cap after their reads finish', async () => {
  const h = fixture(), wait = deferred(); h.setAdmins(Array.from({ length: MAX_PREVIEWS + 1 }, (_, index) => index + 1));
  h.setPreview(async () => { await wait.promise; return rows(); });
  const jobs = Array.from({ length: MAX_PREVIEWS + 1 }, (_, index) => h.preview(index + 1)); await turn(); wait.resolve();
  const contexts = await Promise.all(jobs); assert.equal(contexts.filter(context => h.data(context)).length, MAX_PREVIEWS);
  assert.equal(contexts.filter(context => /слишком много просмотров/.test(context.replies[0].text)).length, 1);
});

test('invalid cursors and unknown tokens perform no reads or writes; raw errors are never exposed', async () => {
  const h = fixture();
  for (const value of ['-1', '1.5', '2147483648', 'all', '0x3a']) await h.preview(108, { message: { text: '/report_links ' + value } });
  await h.apply('report_links_apply:abcdefghijklmnop'); assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
  const secret = 'BOT_TOKEN=synthetic-secret provider-url?private=secret'; h.setPreview(() => { throw new Error(secret); });
  const failed = await h.preview(); assert.ok(!failed.replies[0].text.includes(secret)); h.setPreview(rows);
  const data = h.data(await h.preview()); h.setApply(() => { throw new Error(secret); });
  const stopped = await h.apply(data); assert.ok(!stopped.replies[0].text.includes(secret)); assert.match(stopped.replies[0].text, /осталось 2/);
  h.setApply(complete); await h.apply(data); assert.deepEqual(h.writes.map(item => item.ids), [[58, 60], [58, 60]]);
});

test('terminal card skips remain visible without claiming they were linked and need no repeated operation', async () => {
  const h = fixture(); h.setApply(ids => ({ complete: true, results: ids.map(order_id => ({ order_id, state: 'skipped', code: 'ORDER_CARD_UNAVAILABLE' })) }));
  const data = h.data(await h.preview()), result = await h.apply(data);
  assert.match(result.replies[0].text, /готово 0, пропущено 3, осталось 0/); assert.match(result.replies[0].text, /#58 — исходная карточка недоступна/);
  await h.apply(data); assert.equal(h.writes.length, 1);
});

test('a failed callback acknowledgement never strands the active admission flag', async () => {
  const h = fixture(), data = h.data(await h.preview());
  await h.apply(data, 108, { answerCbQuery() { throw new Error('Synthetic callback expired'); } });
  const next = h.data(await h.preview()); await h.apply(next); assert.equal(h.writes.length, 2);
});

test('text apply requires a private configured administrator and a reviewed list, never IDs supplied as arguments', async () => {
  const h = fixture();
  const run = context => h.commands.applyCommand(context);
  for (const context of [h.ctx(109, { message: { text: '/report_links_apply' } }), h.ctx(108, { chat: { id: -1001, type: 'supergroup' }, message: { text: '/report_links_apply' } })]) await run(context);
  assert.equal(h.replies.length, 0);
  const missing = h.ctx(108, { message: { text: '/report_links_apply' } }); await run(missing);
  assert.match(missing.replies[0].text, /Нет действующего просмотренного списка.*Карточки не менялись/);
  await h.preview();
  const arbitrary = h.ctx(108, { message: { text: '/report_links_apply 999' } }); await run(arbitrary);
  assert.match(arbitrary.replies[0].text, /без дополнительных аргументов/); assert.equal(h.writes.length, 0);
});

test('text apply refuses an expired preview or a changed working group without changing cards', async () => {
  const h = fixture(); await h.preview(); h.advance(PREVIEW_TTL);
  const expired = h.ctx(108, { message: { text: '/report_links_apply' } }); await h.commands.applyCommand(expired);
  assert.match(expired.replies[0].text, /Нет действующего просмотренного списка/);
  await h.preview(); h.options.groupId = '-1009999999999';
  const changed = h.ctx(108, { message: { text: '/report_links_apply' } }); await h.commands.applyCommand(changed);
  assert.match(changed.replies[0].text, /Просмотр устарел/); assert.equal(h.writes.length, 0);
});

test('text apply uses only the most recently reviewed list and a completed duplicate returns its cached receipt', async () => {
  const h = fixture(), old = h.data(await h.preview());
  h.setPreview(() => ({ items: [{ order_id: 99 }], nextAfterId: null }));
  const latest = await h.preview(); assert.match(latest.replies[0].text, /\/report_links_apply — применить последний просмотренный список/);
  assert.match((await h.apply(old)).answers[0], /устарел/);
  const context = h.ctx(108, { message: { text: '/report_links_apply@audit_bot' } }); await h.commands.applyCommand(context);
  assert.deepEqual(h.writes.map(item => item.ids), [[99]]); assert.match(context.replies.at(-1).text, /готово 1, пропущено 0, осталось 0/);
  const repeated = h.ctx(108, { message: { text: '/report_links_apply' } }); await h.commands.applyCommand(repeated);
  assert.match(repeated.replies[0].text, /уже обработаны/); assert.equal(h.writes.length, 1);
});

test('text and button retries share the same remaining batch without repeating confirmed cards', async () => {
  const h = fixture(); let first = true;
  h.setApply(ids => { if (!first) return complete(ids); first = false; return { complete: false, results: [{ order_id: 58, state: 'linked' }], failed_order_id: 60 }; });
  const data = h.data(await h.preview()), command = h.ctx(108, { message: { text: '/report_links_apply' } });
  await h.commands.applyCommand(command); assert.match(command.replies.at(-1).text, /готово 1, пропущено 1, осталось 1/);
  await h.commands.apply(h.ctx(108, { callbackQuery: { data } }), () => assert.fail('Matched button does not delegate middleware'));
  assert.deepEqual(h.writes.map(item => item.ids), [[58, 60], [60]]);
  const repeated = h.ctx(108, { message: { text: '/report_links_apply' } }); await h.commands.applyCommand(repeated);
  assert.equal(h.writes.length, 2); assert.match(repeated.replies[0].text, /уже обработаны/);
});
