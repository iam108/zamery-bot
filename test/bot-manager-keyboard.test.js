'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Markup } = require('telegraf');
const { canManageCases } = require('../src/web/auth');

function harness(initialStaff, adminIds = '') {
  let staff = initialStaff, start, configuredAdmins = adminIds;
  const replies = [], reads = [], keys = [], menuUpdates = [];
  const bot = { start(handler) { start = handler; }, action() {}, command() {}, hears() {}, on() {}, catch() {} };
  const setups = {
    '../web/handoff': { setupReportsBot() {} }, './egrn': { setupEgrn() {} },
    './report-link-admin': { setupReportLinkAdmin() {} }, './order-delivery-admin': { setupOrderDeliveryAdmin() {} },
    './handoff-status-admin': { setupHandoffStatusAdmin() {} }, './handoff-notice-admin': { setupHandoffNoticeAdmin() {} },
    './case-open': { setupCaseOpen() { return async () => {}; } },
    './staff-approval': { createStaffApprovalHandler() { return async () => {}; } },
    './manual-order-attachments': { setupManualOrderAttachments() {} },
    './staff-menu': { getStaffMenu() { return { async refresh(id) { menuUpdates.push(id); } }; } },
    '../db/queries': {}, '../web/manager-orders': {}, '../web/order-report-link': {}, '../db/order-delivery-lock': {},
    './formatter': { esc: String }, '../web/workspace': {},
  };
  const context = vm.createContext({ module: { exports: {} }, console: { log() {}, error() {} },
    process: { env: { BOT_TOKEN: 'synthetic', GROUP_CHAT_ID: '-100123', WEBAPP_URL: 'https://bot.example' } },
    require(name) {
      if (name === 'telegraf') return { Markup, Telegraf: function () { return bot; } };
      if (name === '../web/auth') return { ensureStaff: async () => {},
        canManageCases(actor, id) {
          // Use the real synchronous policy with an isolated configuration,
          // including runtime changes, without exposing the host environment.
          const before = process.env.ADMIN_TG_IDS; process.env.ADMIN_TG_IDS = configuredAdmins;
          try { return canManageCases(actor, id); }
          finally { if (before === undefined) delete process.env.ADMIN_TG_IDS; else process.env.ADMIN_TG_IDS = before; }
        },
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
  return { replies, reads, keys,menuUpdates, setStaff(value) { staff = value; }, setAdminIds(value) { configuredAdmins = value; },
    async start(type = 'private') { await start({ from: { id: 42 }, chat: { id: type === 'private' ? 42 : -100123, type },
      reply: async (text, extra) => replies.push({ text, extra }) }); },
  };
}
function buttons(reply) { return reply?.extra?.reply_markup?.keyboard?.flat() || []; }
function find(reply, text) { return buttons(reply).find(button => button.text === text); }

test('approved private start repairs the same actor menu while unapproved and group starts issue no menu key', async () => {
  const h=harness({tg_id:42,name:'Юрист',role:'lawyer',approved:true});
  await h.start();assert.deepEqual(h.menuUpdates,[42]);
  h.setStaff({tg_id:42,role:'lawyer',approved:false});await h.start();assert.deepEqual(h.menuUpdates,[42]);
  await h.start('supergroup');assert.deepEqual(h.menuUpdates,[42]);
});

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
  assert.equal(find(h.replies.at(-1), '⚖️ Передать юристу'), undefined);
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

for (const role of ['lawyer', 'auditor']) test('an approved configured admin with role ' + role + ' gets both client buttons and retains their role menu', async () => {
  const h = harness({ tg_id: 42, name: 'Администратор', role, approved: true }, '999; 42,100');
  await h.start(); const reply = h.replies.at(-1);
  const create = find(reply, '＋ Создать клиента'), handoff = find(reply, '⚖️ Передать юристу');
  assert.ok(create?.web_app, 'The backend-authorized admin needs the manual client entry point');
  assert.ok(handoff?.web_app, 'The same admin needs the existing linked handoff entry point');
  assert.equal(create.web_app.url, 'https://bot.example/handoff?mode=manual&u=42&k=synthetic-key-42');
  assert.equal(handoff.web_app.url, 'https://bot.example/handoff?u=42&k=synthetic-key-42');
  if (role === 'lawyer') assert.ok(buttons(reply).some(button => button === '📂 Мои клиенты' || button.text === '📂 Мои клиенты'));
  else assert.ok(find(reply, '🔍 Отчёт аудитора'));
  assert.equal(buttons(reply).filter(button => button.text === '＋ Создать клиента').length, 1);
  assert.equal(buttons(reply).filter(button => button.text === '⚖️ Передать юристу').length, 1);
  assert.deepEqual(h.reads, [42]); assert.deepEqual(h.keys, [42]);
});

for (const approved of [false, null]) test('configured admin IDs never bypass staff approval: ' + approved, async () => {
  const h = harness({ tg_id: 42, name: 'Администратор', role: 'lawyer', approved }, '42');
  await h.start(); assert.equal(find(h.replies.at(-1), '＋ Создать клиента'), undefined);
  assert.equal(find(h.replies.at(-1), '⚖️ Передать юристу'), undefined); assert.deepEqual(h.keys, []);
});

test('a repeated private start applies admin revocation and keeps the lawyer menu', async () => {
  const h = harness({ tg_id: 42, name: 'Администратор', role: 'lawyer', approved: true }, '42');
  await h.start(); assert.ok(find(h.replies.at(-1), '＋ Создать клиента')); assert.ok(find(h.replies.at(-1), '⚖️ Передать юристу'));
  h.setAdminIds('999'); await h.start(); const reply = h.replies.at(-1);
  assert.equal(find(reply, '＋ Создать клиента'), undefined); assert.equal(find(reply, '⚖️ Передать юристу'), undefined);
  assert.ok(buttons(reply).some(button => button === '📂 Мои клиенты' || button.text === '📂 Мои клиенты'));
  assert.deepEqual(h.reads, [42, 42]); assert.deepEqual(h.keys, [42, 42]);
});
