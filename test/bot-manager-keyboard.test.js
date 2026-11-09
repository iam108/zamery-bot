'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Markup } = require('telegraf');

function harness(initialStaff) {
  let staff = initialStaff, start;
  const replies = [], reads = [], keys = [];
  const bot = { start(handler) { start = handler; }, action() {}, command() {}, hears() {}, on() {}, catch() {} };
  const setups = {
    '../web/handoff': { setupReportsBot() {} }, './egrn': { setupEgrn() {} },
    './report-link-admin': { setupReportLinkAdmin() {} }, './order-delivery-admin': { setupOrderDeliveryAdmin() {} },
    './handoff-status-admin': { setupHandoffStatusAdmin() {} }, './handoff-notice-admin': { setupHandoffNoticeAdmin() {} },
    './case-open': { setupCaseOpen() { return async () => {}; } },
    './staff-approval': { createStaffApprovalHandler() { return async () => {}; } },
    './manual-order-attachments': { setupManualOrderAttachments() {} },
    '../db/queries': {}, '../web/manager-orders': {}, '../web/order-report-link': {}, '../db/order-delivery-lock': {},
    './formatter': { esc: String }, '../web/workspace': {},
  };
  const context = vm.createContext({ module: { exports: {} }, console: { log() {}, error() {} },
    process: { env: { BOT_TOKEN: 'synthetic', GROUP_CHAT_ID: '-100123', WEBAPP_URL: 'https://bot.example' } },
    require(name) {
      if (name === 'telegraf') return { Markup, Telegraf: function () { return bot; } };
      if (name === '../web/auth') return { ensureStaff: async () => {},
        canManageCases: actor => actor?.approved === true && actor.role === 'manager',
        keyQuery(id) { keys.push(id); return 'u=' + id + '&k=synthetic-key-' + id; } };
      if (name === '../db/pool') return { async query(sql, args) {
        assert.equal(sql, 'SELECT * FROM staff WHERE tg_id=$1'); reads.push(args[0]);
        return { rows: staff ? [staff] : [] };
      } };
      if (Object.hasOwn(setups, name)) return setups[name];
      throw new Error('Unexpected bootstrap import: ' + name);
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/bot/index'), 'utf8'), context);
  context.module.exports.setupBot();
  return { replies, reads, keys, setStaff(value) { staff = value; },
    async start(type = 'private') { await start({ from: { id: 42 }, chat: { id: type === 'private' ? 42 : -100123, type },
      reply: async (text, extra) => replies.push({ text, extra }) }); },
  };
}
function buttons(reply) { return reply?.extra?.reply_markup?.keyboard?.flat() || []; }
function find(reply, text) { return buttons(reply).find(button => button.text === text); }

test('an approved manager receives independent client creation and keeps the existing linked handoff button', async () => {
  const h = harness({ tg_id: 42, name: 'Менеджер', role: 'manager', approved: true });
  await h.start();
  const reply = h.replies.at(-1), create = find(reply, '＋ Создать клиента');
  assert.ok(create?.web_app, 'The manager needs the independent manual client entry point');
  const url = new URL(create.web_app.url);
  assert.equal(url.origin, 'https://bot.example'); assert.equal(url.pathname, '/handoff');
  assert.equal(url.searchParams.get('mode'), 'manual');
  assert.equal(url.searchParams.get('u'), '42'); assert.equal(url.searchParams.get('k'), 'synthetic-key-42');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['k', 'mode', 'u']);
  const handoff = find(reply, '⚖️ Передать юристу');
  assert.equal(handoff.web_app.url, 'https://bot.example/handoff?u=42&k=synthetic-key-42');
  assert.equal(find(reply, '📋 Заявка на замер').web_app.url, 'https://bot.example/form?u=42&k=synthetic-key-42');
  assert.ok(buttons(reply).some(button => button === '📄 Выписка ЕГРН' || button.text === '📄 Выписка ЕГРН'));
  assert.deepEqual(h.reads, [42]); assert.deepEqual(h.keys, [42]);
});

for (const role of ['lawyer', 'auditor']) test('manual client creation is not added to the ' + role + ' keyboard', async () => {
  const h = harness({ tg_id: 42, name: 'Сотрудник', role, approved: true });
  await h.start();
  assert.equal(find(h.replies.at(-1), '＋ Создать клиента'), undefined);
  if (role === 'lawyer') assert.ok(buttons(h.replies.at(-1)).some(button => button === '📂 Мои клиенты' || button.text === '📂 Мои клиенты'));
  else assert.ok(find(h.replies.at(-1), '🔍 Отчёт аудитора'));
});

for (const staff of [null, { tg_id: 42, role: 'manager', approved: false }, { tg_id: 42, role: 'manager', approved: null }])
  test('an unknown or unapproved manager cannot receive a signed manual-client entry point: ' + JSON.stringify(staff), async () => {
    const h = harness(staff); await h.start();
    assert.equal(find(h.replies.at(-1), '＋ Создать клиента'), undefined); assert.deepEqual(h.keys, []);
  });

test('start rechecks current approval and ignores nonprivate chats', async () => {
  const h = harness({ tg_id: 42, name: 'Менеджер', role: 'manager', approved: true });
  await h.start('supergroup'); assert.deepEqual(h.reads, []); assert.deepEqual(h.replies, []);
  await h.start(); assert.ok(find(h.replies.at(-1), '＋ Создать клиента'));
  h.setStaff({ tg_id: 42, role: 'manager', approved: false }); await h.start();
  assert.equal(find(h.replies.at(-1), '＋ Создать клиента'), undefined);
  assert.deepEqual(h.reads, [42, 42]); assert.deepEqual(h.keys, [42]);
});
