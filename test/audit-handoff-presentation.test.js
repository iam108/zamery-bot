'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/web/handoff.js'), 'utf8');
const SOURCE = '-1001111111111', CLIENTS = '-1002222222222', LAWYER = 808;
const VIDEO = 'https://disk.yandex.ru/d/trusted-auditor-video';

function harness(options = {}) {
  const calls = [], writes = [], routes = new Map(); let result, sequence = 6000;
  const reportData = options.reportData === undefined ? { ui_version: 5, workflow: { video_url: VIDEO }, inspection: { service: 'Продление' } } : options.reportData;
  const audit = { id: 7, chat_id: SOURCE, order_id: 58, msg_ids: options.messageIds || [1000,1001,1002,1005], text: 'Сводка аудитора', report_data: reportData };
  const request = { id: 9, chat_id: SOURCE, first_id: 80, msg_ids: [80], text: 'Заявка #58\nООО Пример' };
  const pool = { async query(sql, params = []) {
    if (/CREATE TABLE|ALTER TABLE|CREATE INDEX|CREATE UNIQUE INDEX/.test(sql)) return { rows: [] };
    if (sql.startsWith('SELECT * FROM staff ')) return { rows: [{ tg_id: LAWYER, name: 'Юрист проверки', approved: true }] };
    if (sql.startsWith('SELECT * FROM audits WHERE id=')) return { rows: options.noAudit ? [] : [audit] };
    if (sql.startsWith('SELECT * FROM reports WHERE id=')) return { rows: [request] };
    if (sql.startsWith('SELECT * FROM reports WHERE chat_id=')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM audits WHERE order_id=')) return { rows: options.noAudit ? [] : [audit] };
    if (sql.startsWith('INSERT INTO cases ')) {
      writes.push({ sql, params });
      const keys = ['order_id','lawyer_tg_id','lawyer_name','checklist_key','org','inn','client','phone','address','region','kind','service','priority','comment','audit_text','total','created_by','contacts','request_id'];
      const row = Object.fromEntries(keys.map((key, index) => [key, params[index]])); row.id = 901; row.contacts = JSON.parse(row.contacts);
      return { rows: [row] };
    }
    throw new Error('Unexpected test database operation: ' + sql);
  } };
  const bot = { telegram: {
    async callApi(method, payload) {
      assert.equal(method, 'copyMessages'); calls.push({ method, payload });
      const copied = payload.message_ids.map(() => ({ message_id: sequence++ }));
      return options.dropReceipt && String(payload.chat_id) === String(options.dropReceipt) ? copied.slice(1) : copied;
    },
    async sendMessage(chat, text, opts) { calls.push({ method: 'sendMessage', chat, text, opts }); return { message_id: sequence++ }; }
  } };
  const context = { module: { exports: {} }, URL,
    console: { log() {}, error() {} },
    process: { env: { CLIENTS_CHAT_ID: CLIENTS, WEBAPP_URL: 'https://audit.example' } },
    setTimeout() {}, setInterval() {},
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === '../checklists') return { LISTS: {}, STAGES: [], flagLabels: {}, pickChecklist: () => options.noChecklist ? null : 'qa-checklist' };
      if (name === '../bot/instance') return bot;
      if (name === './auth') return {};
      throw new Error('Unexpected handoff dependency: ' + name);
    }
  };
  vm.createContext(context); vm.runInContext(source + '\nmodule.exports.testGetReport = getReport;', context);
  const app = { get(route, ...handlers) { routes.set('GET ' + route, handlers.at(-1)); }, post(route, ...handlers) { routes.set('POST ' + route, handlers.at(-1)); } };
  context.module.exports.setupHandoff(app);
  return { calls, writes, audit, getReport: context.module.exports.testGetReport,
    async send(changes = {}) {
      const body = { lawyer_tg_id: LAWYER, order_id: 58, report_src: 'a', report_id: 7,
        org: 'ООО Пример', client: 'Контакт клиента', phone: '+79990000000', address: 'Москва, тестовый объект', region: 'МСК', kind: 'Общепит', service: 'Продление', priority: 'Обычный',
        video_url: 'https://untrusted.example/manager-body-must-not-win', ...changes };
      await routes.get('POST /api/handoff')({ body, tgUser: { id: 101 }, staff: { name: 'Менеджер' } }, { json(value) { result = value; } });
      assert.equal(result?.ok, true, result?.error); return result;
    }
  };
}
function recipient(h, chat) { return h.calls.find(call => call.method === 'sendMessage' && String(call.chat) === String(chat)); }
function buttons(message) { return message?.opts?.reply_markup?.inline_keyboard.flat() || []; }

for (const kind of ['a', 'r']) test('handoff through saved ' + kind + ' report copies ZIP IDs and restores trusted video buttons for both recipients', async () => {
  const reportData = { ui_version: 5, workflow: { video_url: VIDEO }, inspection: { service: 'Продление' } };
  const h = harness({ reportData: kind === 'r' ? JSON.stringify(reportData) : reportData });
  const lookedUp = await h.getReport(kind, kind === 'a' ? 7 : 9);
  assert.equal(typeof lookedUp.report_data, kind === 'r' ? 'string' : 'object');
  await h.send({ report_src: kind, report_id: kind === 'a' ? 7 : 9 });
  assert.equal(h.writes.length, 1);
  for (const chat of [CLIENTS, LAWYER]) {
    const copied = h.calls.find(call => call.method === 'copyMessages' && String(call.payload.chat_id) === String(chat));
    assert.equal(copied.payload.from_chat_id, SOURCE);
    assert.ok(copied.payload.message_ids.includes(1005), 'The original ZIP is delivered to the recipient, not linked back to the private source chat');
    assert.ok([1000,1001,1002].every(id => copied.payload.message_ids.includes(id)));
    const card = recipient(h, chat), keys = buttons(card);
    assert.ok(keys.some(key => key.url === VIDEO));
    assert.ok(!keys.some(key => String(key.url || '').includes('untrusted.example')));
    assert.ok(!keys.some(key => /^https:\/\/t\.me\/c\//.test(key.url || '')), 'Recipient actions must not depend on private source-chat membership');
  }
  assert.ok(buttons(recipient(h, LAWYER)).some(button => button.web_app?.url === 'https://audit.example/checklist?case_id=901'));
});

for (const [name, reportData] of [
  ['explicitly cleared optional video', { ui_version: 5, workflow: { video_url: '' }, video_url: VIDEO }],
  ['missing optional video', { ui_version: 5, workflow: {} }],
  ['non-HTTPS saved link', JSON.stringify({ ui_version: 5, workflow: { video_url: 'http://disk.yandex.ru/d/not-https' } })],
  ['malformed saved JSON', '{not-json'],
  ['legacy report', { ui_version: 4, workflow: { video_url: VIDEO } }]
]) test(name + ' cannot add empty or untrusted recipient action buttons', async () => {
  const h = harness({ reportData }); await h.send();
  const lawyerKeys = buttons(recipient(h, LAWYER)), clientKeys = buttons(recipient(h, CLIENTS));
  assert.equal(lawyerKeys.filter(key => key.url).length, 0); assert.equal(clientKeys.length, 0);
  assert.equal(lawyerKeys.length, 1, 'The existing lawyer checklist remains available');
  assert.ok(lawyerKeys[0].web_app);
});

test('a manager body video URL cannot create a video button when no saved audit was selected', async () => {
  const h = harness({ noAudit: true, noChecklist: true }); await h.send({ report_src: '', report_id: '' });
  assert.equal(h.calls.filter(call => call.method === 'copyMessages').length, 0);
  assert.equal(buttons(recipient(h, LAWYER)).length, 0); assert.equal(buttons(recipient(h, CLIENTS)).length, 0);
  assert.equal(recipient(h, LAWYER).opts.reply_markup, undefined, 'There is no empty keyboard');
});

test('a legacy report over 100 messages copies its final ZIP to both recipients instead of truncating the packet', async () => {
  const ids = Array.from({ length: 105 }, (_, index) => 1000 + index), h = harness({ messageIds: ids });
  await h.send();
  for (const chat of [CLIENTS, LAWYER]) {
    const batches = h.calls.filter(call => call.method === 'copyMessages' && String(call.payload.chat_id) === String(chat));
    assert.deepEqual(batches.map(call => call.payload.message_ids.length), [100,5]);
    const received = batches.flatMap(call => Array.from(call.payload.message_ids));
    assert.deepEqual(received, ids); assert.equal(received.at(-1), 1104, 'The final original ZIP is not silently lost');
  }
});

for (const target of [CLIENTS, LAWYER]) test('a missing Telegram copy acknowledgement produces an explicit recipient warning for ' + (target === CLIENTS ? 'the clients chat' : 'the lawyer'), async () => {
  const h = harness({ dropReceipt: target }), result = await h.send();
  assert.match(result.warn, /не все материалы/i);
  assert.match(result.warn, target === CLIENTS ? /Заявки по клиенту/ : /юристу/);
  assert.equal(h.writes.length, 1, 'The assignment still exists and the partial delivery is explicitly reported');
});
