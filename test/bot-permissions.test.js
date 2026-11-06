const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createOrderDeliveryLock } = require('../src/db/order-delivery-lock');

function harness(staff = { tg_id: 42, role: 'auditor', approved: true }, options = {}) {
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
    updateOrderStatus: async (...args) => { calls.push(['status', ...args]); order.status=args[1]; return { ...order }; },
    createOrder: async () => { calls.push('create'); return order; }, addLog: async () => calls.push('log'), setTelegramMsgId: async () => calls.push('message-checkpoint') };
  const markup = { button: { callback: () => ({}), webApp: () => ({}), url: () => ({}) },
    inlineKeyboard: () => ({}), removeKeyboard: () => ({}), keyboard: () => ({ resize: () => ({}) }) };
  const context = vm.createContext({ module: { exports: {} }, console: { log() {}, error() {} },
    process: { env: { BOT_TOKEN: 'synthetic', GROUP_CHAT_ID: '-10042', WEBAPP_URL: 'https://bot.example' } },
    require(name) {
      if (name === 'telegraf') return { Telegraf: function () { return bot; }, Markup: markup };
      if (name === '../db/queries') return queries;
      if (name === './formatter') return { formatOrderMessage: options.format || (() => 'Synthetic order'), STATUS_EMOJI: {}, esc: x => x };
      if (name === '../web/manager-orders') return { cardOptions: require('../src/web/manager-orders').cardOptions };
      if (name === './report-link-admin') return require('../src/bot/report-link-admin');
      if (name === '../web/order-report-link') return { loadOrderReportLink: options.loadOrderReportLink || (async () => null) };
      if (name === '../db/order-delivery-lock') return { withOrderDeliveryLock: options.withOrderDeliveryLock || (async (id, run) => run()) };
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
      editMessageText: async (text,opts) => { calls.push('edit'); calls.push(['card', text,opts]); }, answerCbQuery: async text => calls.push(['answer', text]),
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
  assert.equal(h.calls.includes('message'), false);assert.equal(h.calls.includes('log'), false);assert.equal(h.calls.includes('message-checkpoint'), false);
  assert.match(h.calls.find(call=>Array.isArray(call)&&call[0]==='reply')[1],/Нет доступа/);
});

for(const payload of [{address:'Old order',owner_name:'Client',object_type:'Другое'},{type:'audit',conclusion:'Old audit'},'malformed old data'])
  test('an approved obsolete WebApp event receives a private upgrade hint without publishing or writing '+JSON.stringify(payload),async()=>{
    const h=harness({tg_id:42,role:'manager',approved:true});
    const update={...h.ctx(),callbackQuery:null,chat:{id:42,type:'private'},webAppData:{data:{text:()=>typeof payload==='string'?payload:JSON.stringify(payload)}}};
    await h.events.get('web_app_data')(update);await h.events.get('web_app_data')(update);
    assert.equal(h.calls.some(call=>['create','audit','message','log','message-checkpoint','edit'].includes(call)),false);
    assert.equal(h.calls.some(call=>Array.isArray(call)&&call[0]==='query'&&/^(INSERT|UPDATE|DELETE)/i.test(call[1].trim())),false);
    const replies=h.calls.filter(call=>Array.isArray(call)&&call[0]==='reply');assert.equal(replies.length,2);
    for(const reply of replies)assert.match(reply[1],/версия формы устарела.*\/start/);
  });

test('an obsolete WebApp event outside a private chat is ignored without database access or replies',async()=>{
  const h=harness();await h.events.get('web_app_data')({...h.ctx(),webAppData:{data:{text:()=>assert.fail('Do not read group payload')}}});
  assert.deepEqual(h.calls,[]);
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

test('a bot status callback waits for manager delivery and reads the final status and address inside the shared order lock', async () => {
  const lock = createOrderDeliveryLock({}), h = harness(undefined, { withOrderDeliveryLock: lock, format: order => JSON.stringify(order) });
  let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const manager = lock(17, async () => { h.order.address = 'Адрес после изменения менеджером'; started(); await gate; h.order.status = 'done'; });
  await entered; const callback = h.action('status:in_progress:17'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.includes('edit'), false); assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'status'), false);
  release(); await Promise.all([manager, callback]);
  const card = JSON.parse(h.calls.find(call => Array.isArray(call) && call[0] === 'card')[1]);
  assert.equal(card.status, 'done'); assert.equal(card.address, 'Адрес после изменения менеджером');
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'status'), false); assert.equal(h.calls.includes('message'), false);
});

test('a busy order tells the bot user to wait without changing its status or card', async () => {
  const h = harness(undefined, { withOrderDeliveryLock: async () => { throw Object.assign(new Error('busy'), { code: 'ORDER_DELIVERY_BUSY' }); } });
  await h.action('status:in_progress:17');
  assert.equal(h.calls.includes('edit'), false); assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'status'), false);
  assert.match(h.calls.find(call => Array.isArray(call) && call[0] === 'answer')[1], /сейчас обновляется/);
});

test('bot status updates and stale callbacks preserve the latest report under the common lock',async()=>{
  for(const [initial,target]of [['new','in_progress'],['in_progress','done'],['in_progress','cancelled'],['done','done'],['done','in_progress'],['new','new']]){
    let locked=false,lookups=0;const h=harness(undefined,{withOrderDeliveryLock:async(id,run)=>{assert.equal(id,17);locked=true;try{return await run();}finally{locked=false;}},loadOrderReportLink:async id=>{assert.equal(locked,true);assert.equal(id,17);lookups++;return{url:'https://t.me/c/111111/209'};}});h.order.status=initial;
    await h.action('status:'+target+':17');assert.equal(lookups,1);
    const buttons=h.calls.find(call=>Array.isArray(call)&&call[0]==='card')[2].reply_markup.inline_keyboard.flat();assert.equal(buttons.find(button=>button.text==='Перейти к отчёту').url,'https://t.me/c/111111/209');
    if(h.order.status==='cancelled')assert.equal(buttons.length,1);else assert.ok(buttons.some(button=>button.callback_data));
  }
});

test('bot report lookup failure preserves the existing keyboard and saved status; repeat refreshes rather than changes status again',async()=>{
  let failed=true;const h=harness(undefined,{loadOrderReportLink:async()=>{if(failed)throw new Error('Synthetic report lookup failure');return{url:'https://t.me/c/111111/210'};}});
  await h.action('status:done:17');assert.equal(h.order.status,'done');assert.equal(h.calls.includes('edit'),false);assert.ok(h.calls.some(call=>Array.isArray(call)&&call[0]==='answer'&&/Ошибка|сохран/iu.test(call[1])));
  failed=false;await h.action('status:done:17');assert.equal(h.calls.filter(call=>Array.isArray(call)&&call[0]==='status').length,1);
  assert.equal(h.calls.find(call=>Array.isArray(call)&&call[0]==='card')[2].reply_markup.inline_keyboard.flat().find(button=>button.url).url,'https://t.me/c/111111/210');
});
