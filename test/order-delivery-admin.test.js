const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderDeliveryAdmin, setupOrderDeliveryAdmin, PREVIEW_TTL } = require('../src/bot/order-delivery-admin');

function fixture() {
  let time = 1000, generation = 1, failReply = false, wait;
  const calls = [], replies = [];
  const options = { pool: {}, adminIds: [108], now: () => time, withOrderDeliveryLock: async (id, run) => { calls.push(['lock', id]); return run(); },
    delivery: {
      async preview(id) { calls.push(['preview', id]); if (wait) await wait; return { order_id: id, slots: [{ slot: 'card', name: 'Карточка заявки', generation }] }; },
      async allowRetry(id, slot, context) { calls.push(['retry', id, slot, context]); return { state: 'retry_ready', warning: 'Повтор разрешён. Возможен дубликат; повторите доставку из формы.' }; },
    } };
  const create = () => createOrderDeliveryAdmin(options);
  const ctx = (text = '/order_delivery 58', message = 100, changes = {}) => ({ from: { id: 108 }, chat: { id: 108, type: 'private' }, message: { text, message_id: message }, async reply(text) { if (failReply) throw new Error('Private ACK lost'); replies.push(text); }, ...changes });
  return { options, create, ctx, calls, replies, set time(value) { time = value; }, set generation(value) { generation = value; }, set failReply(value) { failReply = value; }, set wait(value) { wait = value; } };
}

test('only explicitly configured administrators in a private chat can inspect or authorize retries', async () => {
  const f = fixture(), commands = f.create();
  for (const changes of [{ from: { id: 109, role: 'manager' } }, { chat: { id: -100321, type: 'supergroup' } }, { chat: { id: -100321, type: 'group' } }]) {
    await commands.preview(f.ctx(undefined, 100, changes)); await commands.retry(f.ctx('/order_delivery_retry 58 1 confirm_missing', 101, changes));
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.replies, []);
});

test('read-only preview exposes no raw generation and text confirmation targets exactly the reviewed slot under the order lock', async () => {
  const f = fixture(), commands = f.create(); await commands.preview(f.ctx());
  assert.deepEqual(f.calls, [['lock', 58], ['preview', 58]]); assert.match(f.replies[0], /сообщение могло дойти/); assert.match(f.replies[0], /дубликат/); assert.match(f.replies[0], /\/order_delivery_retry 58 1 confirm_missing/);
  await commands.retry(f.ctx('/order_delivery_retry 58 1 confirm_missing', 101));
  assert.deepEqual(f.calls.slice(-2), [['lock', 58], ['retry', 58, 'card', { actorId: 108, messageId: 101, expectedGeneration: 1 }]]);
});

test('missing, expired or restarted preview and mismatched order/slot/admin cannot authorize a retry', async () => {
  const f = fixture(), commands = f.create(), command = () => f.ctx('/order_delivery_retry 58 1 confirm_missing', 101);
  await commands.retry(command()); await commands.preview(f.ctx());
  await commands.retry(f.ctx('/order_delivery_retry 59 1 confirm_missing', 102));
  await commands.retry(f.ctx('/order_delivery_retry 58 2 confirm_missing', 102));
  await commands.retry(f.ctx('/order_delivery_retry 58 1 confirm_missing', 99));
  await f.create().retry(command()); f.time = 1000 + PREVIEW_TTL; await commands.retry(command());
  assert.equal(f.calls.filter(call => call[0] === 'retry').length, 0);
});

test('preview reply failure cannot create an unseen recovery authorization', async () => {
  const f = fixture(), commands = f.create(); f.failReply = true;
  await assert.rejects(commands.preview(f.ctx()), /ACK lost/); f.failReply = false;
  await commands.retry(f.ctx('/order_delivery_retry 58 1 confirm_missing', 101));
  assert.equal(f.calls.filter(call => call[0] === 'retry').length, 0);
});

test('a newer preview invalidates the older order and stale generation response requires another preview', async () => {
  const f = fixture(), commands = f.create(); await commands.preview(f.ctx());
  await commands.preview(f.ctx('/order_delivery 59', 101)); await commands.retry(f.ctx('/order_delivery_retry 58 1 confirm_missing', 102));
  assert.equal(f.calls.filter(call => call[0] === 'retry').length, 0);
  f.options.delivery.allowRetry = async () => ({ state: 'stale', warning: 'Состояние доставки изменилось.' });
  await commands.retry(f.ctx('/order_delivery_retry 59 1 confirm_missing', 103));
  await commands.retry(f.ctx('/order_delivery_retry 59 1 confirm_missing', 104));
  assert.match(f.replies.at(-1), /Нет актуального/);
});

test('an old slow preview cannot overwrite a more recent review', async () => {
  const f = fixture(), commands = f.create(); let release;
  f.wait = new Promise(resolve => { release = resolve; }); const old = commands.preview(f.ctx());
  await new Promise(resolve => setImmediate(resolve)); f.wait = null; f.generation = 2;
  await commands.preview(f.ctx('/order_delivery 59', 102)); release(); await old;
  assert.equal(f.replies.length, 1); assert.match(f.replies[0], /#59/);
  await commands.retry(f.ctx('/order_delivery_retry 59 1 confirm_missing', 103));
  assert.equal(f.calls.at(-1)[3].expectedGeneration, 2);
});

test('errors are private and redacted; commands never initiate Telegram card/file sends', async () => {
  const f = fixture(), commands = f.create(); f.options.delivery.preview = async () => { throw new Error('secret provider response'); };
  await commands.preview(f.ctx()); assert.doesNotMatch(f.replies.join('\n'), /secret/); assert.match(f.replies[0], /Ничего не отправлялось/);
  const registered = []; setupOrderDeliveryAdmin({ command(name, fn) { registered.push([name, typeof fn]); } }, f.options);
  assert.deepEqual(registered, [['order_delivery', 'function'], ['order_delivery_retry', 'function']]);
});
