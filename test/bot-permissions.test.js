const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(staff = { tg_id: 42, role: 'auditor', approved: true }) {
  const calls = [], actions = [], commands = new Map(), events = new Map();
  const order = { id: 17, status: 'new' };
  const bot = { start() {}, action(pattern, handler) { actions.push([pattern, handler]); },
    command(name, handler) { commands.set(name, handler); }, hears() {},
    on(name, handler) { events.set(name, handler); }, catch(handler) { this.errorHandler = handler; } };
  const auth = { ensureStaff: async () => {}, keyQuery: id => 'u=' + id + '&k=synthetic',
    canManageCases: (actor, id) => actor?.approved === true && (actor.role === 'manager' || id === 99) };
  const queries = {
    getStats: async () => { calls.push('stats'); return {}; },
    getOrderById: async () => ({ ...order }),
    updateOrderStatus: async (...args) => { calls.push(['status', ...args]); return { ...order, status: args[1] }; },
    createOrder: async () => { calls.push('create'); return order; }, addLog: async () => {}, setTelegramMsgId: async () => {} };
  const markup = { button: { callback: () => ({}), webApp: () => ({}), url: () => ({}) },
    inlineKeyboard: () => ({}), removeKeyboard: () => ({}), keyboard: () => ({ resize: () => ({}) }) };
  const context = vm.createContext({ module: { exports: {} }, console: { log() {}, error() {} },
    process: { env: { BOT_TOKEN: 'synthetic', GROUP_CHAT_ID: '-10042', WEBAPP_URL: 'https://bot.example' } },
    require(name) {
      if (name === 'telegraf') return { Telegraf: function () { return bot; }, Markup: markup };
      if (name === '../db/queries') return queries;
      if (name === './formatter') return { formatOrderMessage: () => 'Synthetic order', STATUS_EMOJI: {}, esc: x => x };
      if (name === '../web/manager-orders') return { cardOptions: () => ({ parse_mode: 'HTML' }) };
      if (name === './audit-handler') return { handleAuditReport: async () => calls.push('audit') };
      if (name === '../web/handoff') return { setupReportsBot() {} };
      if (name === './egrn') return { setupEgrn() {} };
      if (name === './manual-order-attachments') return { setupManualOrderAttachments() {} };
      if (name === '../db/pool') return { query: async (sql, params) => { calls.push(['query', sql, params]); return { rows: staff ? [staff] : [] }; } };
      if (name === '../web/auth') return auth;
      if (name === '../web/workspace') return {};
      throw new Error('Unexpected import: ' + name);
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/bot/index'), 'utf8'), context);
  context.module.exports.setupBot();
  function ctx(data) {
    return { from: { id: 42 }, chat: { id: -10042, type: 'supergroup' }, callbackQuery: { data },
      telegram: { sendMessage: async () => { calls.push('message'); return { message_id: 7 }; } },
      editMessageText: async () => calls.push('edit'), answerCbQuery: async text => calls.push(['answer', text]),
      reply: async text => calls.push(['reply', text]) };
  }
  async function action(data, overrides) {
    const [pattern, handler] = actions.find(([pattern]) => pattern.test(data));
    const update = Object.assign(ctx(data), overrides); update.match = data.match(pattern);
    await handler(update);
  }
  return { calls, order, commands, events, ctx, action, bot };
}

test('unapproved users cannot mutate a real order callback or obtain statistics', async () => {
  for (const actor of [null, { tg_id: 42, approved: false, role: 'auditor' }]) {
    const h = harness(actor);
    await h.action('status:in_progress:17');
    await h.commands.get('stats')({ ...h.ctx(), callbackQuery: null });
    assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'status'), false);
    assert.equal(h.calls.includes('stats'), false);
  }
});

test('a status action from a copied foreign-chat card cannot change the original order', async () => {
  const h = harness();
  await h.action('status:in_progress:17', { chat: { id: -999, type: 'supergroup' } });
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'status'), false);
});

test('ordinary auditor work changes a new order once and sends the signed audit link', async () => {
  const h = harness();
  await h.action('status:in_progress:17');
  const mutation = h.calls.find(call => Array.isArray(call) && call[0] === 'status');
  assert.equal(mutation[1], 17); assert.equal(mutation[2], 'in_progress');
  assert.deepEqual(Array.from(mutation[4]), ['new']);
  assert.equal(h.calls.includes('message'), true);
  h.calls.length = 0; h.order.status = 'done';
  await h.action('status:in_progress:17');
  assert.equal(h.calls.includes('message'), false);
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'status'), false);
});

test('revoked keyboard WebApp data cannot bypass HTTP staff checks', async () => {
  const h = harness({ tg_id: 42, role: 'auditor', approved: false });
  await h.events.get('web_app_data')({ ...h.ctx(), callbackQuery: null, chat: { type: 'private' },
    webAppData: { data: { text: () => JSON.stringify({ type: 'audit' }) } } });
  assert.equal(h.calls.includes('audit'), false);
  assert.equal(h.calls.includes('create'), false);
});

test('only a manager can request handoff initiation from the order card', async () => {
  const h = harness(); await h.action('handoff:17');
  assert.equal(h.calls.includes('message'), false);
  const manager = harness({ tg_id: 42, role: 'manager', approved: true });
  await manager.action('handoff:17');
  assert.equal(manager.calls.includes('message'), true);
});


test('the first stranger cannot bootstrap an approved manager in an empty staff database', async () => {
  const h = harness(null);
  await h.action('role:manager', { chat: { type: 'private' } });
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'query' && /^(INSERT|UPDATE)/i.test(call[1].trim()) && /approved\s*=\s*true|,true,/i.test(call[1])), false);
  assert.ok(h.calls.includes('edit'));
});
