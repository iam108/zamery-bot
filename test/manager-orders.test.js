const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createManagerHandlers } = require('../src/web/manager-orders');
const originalMaterials = require('../src/web/order-materials');

function fixture() {
  let order = { id: 58, submitted_by: 108, submitted_name: 'Автор', status: 'in_progress', telegram_msg_id: 900, address: 'Москва, старый адрес', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: null, cad_num: '', created_at: new Date(), request_submit_id: 'original', request_signature: 'original-signature' };
  const files = new Map();
  const calls = [];
  const refs = () => [...files.values()].map(({ buffer, ...file }) => file);
  const materials = {
    ...originalMaterials, ensureOrderMaterials: async () => {},
    listOrderMaterials: async (id, bytes) => { assert.equal(id, 58); return bytes ? [...files.values()] : refs(); },
    saveOrderMaterials: async (id, prepared) => { calls.push('save-originals'); assert.equal(id, 58); for (const f of prepared) if (!files.has(f.id)) files.set(f.id, { ...f, url: '/api/audit/orders/58/materials/' + f.id }); },
    markOrderMaterialDelivered: async (id, fileId, msg) => { files.get(fileId).telegram_msg_id = msg; },
  };
  const queries = {
    getOrderById: async id => id === 58 ? { ...order } : null,
    createOrder: async () => { throw new Error('Editing must not create another order'); },
    updateOrderPacket: async (id, data) => { calls.push('update-packet'); const old = order; order = { ...order, ...data, request_submit_id: old.request_submit_id, request_signature: old.request_signature }; return { ...order }; },
    addLog: async (id, action) => calls.push(action),
    setTelegramMsgId: async () => { throw new Error('Existing card must be edited'); },
  };
  const telegram = {
    editMessageText: async (chat, msg, unused, text, options) => { calls.push({ edit: msg, options }); },
    sendDocument: async (chat, file) => { calls.push({ document: file.filename, content: file.source.toString() }); return { message_id: 901 }; },
    sendMessage: async () => { throw new Error('Existing order must not create another card'); },
  };
  const handlers = createManagerHandlers({ materials, queries, pool: {}, getTelegram: () => telegram, format: item => 'order ' + item.id, attachOrOrder: async () => { throw new Error('No EGRN requested'); } });
  const request = (role = 'manager', uid = 109) => ({ params: { id: '58' }, tgUser: { id: uid }, staff: { name: 'Менеджер', role }, files: [], body: { address: 'Москва, новый адрес', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Продление', archive_url: '', submit_id: 'edit-1' } });
  const response = () => ({ statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; }, set(k,v) { this.headers[k] = v; return this; }, json(value) { this.body = value; return this; } });
  return { handlers, request, response, files, calls, telegram, order: () => order };
}

test('approved staff can read manager packet, only creator or manager can edit', async () => {
  const f = fixture(), req = f.request('auditor', 109), read = f.response();
  await f.handlers.read(req, read);
  assert.equal(read.body.ok, true); assert.equal(read.body.can_edit, false);
  assert.equal(read.headers['Cache-Control'], 'no-store');
  assert.equal(Object.hasOwn(read.body.order, 'request_signature'), false);
  const denied = f.response(); await f.handlers.save(req, denied);
  assert.equal(denied.statusCode, 403); assert.deepEqual(f.calls, []);
  const own = f.response(); await f.handlers.read(f.request('auditor', 108), own);
  assert.equal(own.body.can_edit, true);
});

test('historical request receives service and appended documents in same order; existing archive satisfies renewal', async () => {
  const f = fixture();
  const archive = originalMaterials.prepareMaterials([{ originalname: 'Архив.zip', mimetype: 'application/zip', buffer: Buffer.from('OLD_ARCHIVE') }], ['archive'])[0];
  f.files.set(archive.id, { ...archive, telegram_msg_id: 899 });
  const req = f.request();
  req.files = [{ originalname: 'План.pdf', mimetype: 'application/pdf', buffer: Buffer.from('NEW_PLAN') }]; req.body.file_roles = '["plan"]';
  const res = f.response(); await f.handlers.save(req, res);
  assert.equal(res.body.ok, true); assert.equal(res.body.id, 58); assert.equal(res.body.warning, undefined);
  assert.equal(f.order().service, 'Продление'); assert.equal(f.order().address, req.body.address);
  assert.equal(f.order().submitted_by, 108); assert.equal(f.order().submitted_name, 'Автор');
  assert.equal(f.order().request_submit_id, 'original'); assert.equal(f.order().request_signature, 'original-signature');
  assert.equal(f.files.size, 2); assert.equal(f.calls[0], 'save-originals'); assert.equal(f.calls[1], 'update-packet');
  const card = f.calls.find(call => call.edit); assert.equal(card.edit, 900);
  assert.equal(card.options.reply_markup.inline_keyboard[1][0].callback_data, 'report:58');
  assert.equal(f.calls.filter(call => call.document).length, 1); assert.equal(f.calls.find(call => call.document).content, 'NEW_PLAN');
  const retry = f.response(); await f.handlers.save(req, retry);
  assert.equal(retry.body.ok, true); assert.equal(f.calls.filter(call => call.document).length, 1);
});

test('Telegram update failure preserves packet and retry skips already delivered originals', async () => {
  const f = fixture(), req = f.request('auditor', 108);
  req.body.service = 'Получение'; req.files = [{ originalname: 'План.pdf', mimetype: 'application/pdf', buffer: Buffer.from('PLAN') }];
  f.telegram.editMessageText = async () => { throw new Error('Telegram unavailable'); };
  const first = f.response(); await f.handlers.save(req, first);
  assert.equal(first.body.ok, true); assert.match(first.body.warning, /сохранены/); assert.equal(f.files.size, 1);
  f.telegram.editMessageText = async () => {};
  const second = f.response(); await f.handlers.save(req, second);
  assert.equal(second.body.ok, true); assert.equal(second.body.warning, undefined);
  assert.equal(f.calls.filter(call => call.document).length, 1);
});

test('manager edit form generates valid client script and provides an existing-packet loader', () => {
  const html = require('../src/web/index').miniAppForm();
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(match[1]);
  assert.match(html, /id="existing-files"/);
  assert.match(html, /function loadExistingPacket/);
  assert.match(html, /existingFiles\.some\(function\(f\)\{return f\.role === 'archive';\}\)/);
});
