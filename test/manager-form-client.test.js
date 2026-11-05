const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, response, savedPacket } = require('./helpers/manager-form');

test('a permanent submission conflict stops immediately instead of waiting and resending four times', async () => {
  const h = harness(); h.c.respond = () => response({ ok: false, error: 'Заявка сохранена с другими данными.' }, 409);
  await h.c.submitForm();
  assert.equal(h.requests.length, 1); assert.equal(h.waits.filter(ms => ms === 1000).length, 0);
  assert.match(h.alerts[0], /другими данными/);
});

test('saved creation with a delivery warning becomes an editable existing packet and preserves EGRN intent and newer typing', async () => {
  const h = harness(), sent = { name: 'План.pdf', size: 4, materialRole: 'plan' };
  h.c.attachedFiles.push(sent); const originalId = h.c.submitId;
  h.c.respond = (url, options) => {
    if (!options || options.method !== 'POST') return response(savedPacket());
    h.nodes.get('address').value = 'Москва, правка во время отправки';
    return response({ ok: true, id: 58, packet_revision: 1, current_revision: 1, warning: 'Заявка #58 и документы сохранены. Доставка временно недоступна.' });
  };
  await h.c.submitForm();
  assert.equal(h.c.editOrderId, '58'); assert.notEqual(h.c.submitId, originalId);
  assert.equal(h.c.attachedFiles.length, 0); assert.equal(h.c.existingFiles[0].id, 'saved-plan');
  assert.equal(h.nodes.get('address').value, 'Москва, правка во время отправки');
  assert.equal(h.nodes.get('egrn_order').checked, true);
  assert.equal(h.nodes.get('submit-btn').disabled, false);
  h.c.respond = () => response({ ok: false, error: 'Synthetic stop' }, 400);
  await h.c.submitForm(); const retry = h.requests.at(-1);
  assert.equal(retry.url, '/api/order/58');
  assert.equal(retry.options.body.entries.find(entry => entry[0] === 'egrn_order')[1], '1');
  assert.equal(retry.options.body.entries.some(entry => entry[0] === 'files'), false);
});

test('a saved packet reload failure stays visibly recoverable and a later reload retains typed input', async () => {
  const h = harness(); let reads = 0;
  h.c.respond = (url, options) => {
    if (options && options.method === 'POST') return response({ ok: true, id: 58, packet_revision: 1, current_revision: 1, warning: 'Заявка #58 сохранена. Доставка не завершена.' });
    return ++reads === 1 ? response({ ok: false, error: 'Не удалось загрузить сохранённую заявку.' }, 503) : response(savedPacket());
  };
  h.nodes.get('address').value = 'Москва, новая правка';
  await h.c.submitForm();
  assert.equal(h.c.editOrderId, '58'); assert.equal(h.c.packetReady, false);
  assert.equal(h.nodes.get('packet-retry').hidden, false);
  assert.match(h.nodes.get('packet-status').textContent, /Не удалось загрузить/);
  assert.match(h.alerts[0], /#58.*сохранена/);
  await h.c.loadExistingPacket();
  assert.equal(h.c.packetReady, true); assert.equal(h.nodes.get('address').value, 'Москва, новая правка');
  assert.equal(h.nodes.get('egrn_order').checked, true);
});

test('a post-save reload cannot attach a newer manager revision to preserved older form fields', async () => {
  const h = harness(); h.c.editOrderId = '58';
  h.c.respond = () => response(savedPacket(1)); await h.c.loadExistingPacket();
  assert.equal(h.c.packetRevision, 1);
  h.nodes.get('address').value = 'Москва, мои поля';
  h.c.respond = (url, options) => options && options.method === 'POST' ? response({ ok: true, id: 58, packet_revision: 2, current_revision: 2, warning: 'Заявка #58 сохранена. Повторите доставку.' }) : response(savedPacket(3));
  await h.c.submitForm();
  assert.equal(h.nodes.get('address').value, 'Москва, мои поля');
  assert.equal(h.c.packetRevision, 2, 'The baseline comes from the confirmed POST, never the later metadata-only GET');
  assert.match(h.nodes.get('packet-status').textContent, /другой менеджер/);
  assert.equal(h.nodes.get('packet-retry').hidden, false);
  const count = h.requests.length;
  h.c.respond = () => response({ ok: false, code: 'ORDER_PACKET_CONFLICT', packet_revision: 3, error: 'Заявка уже изменена другим менеджером. Ваши данные остались в форме.' }, 409);
  await h.c.submitForm();
  assert.equal(h.requests.length, count + 1);
  assert.equal(h.requests.at(-1).options.body.entries.find(([name]) => name === 'packet_revision')[1], '2');
  assert.equal(h.c.packetRevision, 2); assert.equal(h.nodes.get('address').value, 'Москва, мои поля');
  // Reloading current fields is an explicit action after the conflict.
  h.c.respond = () => response(savedPacket(3)); await h.c.loadExistingPacket();
  assert.equal(h.c.packetRevision, 3); assert.equal(h.nodes.get('address').value, 'Москва, адрес');
});

test('lost edit acknowledgements replay the exact intent and keep its confirmed baseline if a newer packet exists', async () => {
  const h = harness(); h.c.editOrderId = '58';
  h.c.respond = () => response(savedPacket(1)); await h.c.loadExistingPacket();
  h.nodes.get('address').value = 'Москва, подтверждённая правка'; let attempts = 0;
  h.c.respond = (url, options) => {
    if (!options || options.method !== 'POST') return response(savedPacket(3));
    if (++attempts === 1) throw new Error('Synthetic lost acknowledgement');
    return response({ ok: true, id: 58, replayed: true, packet_revision: 2, current_revision: 3, warning: 'Сохранение подтверждено. Заявку уже изменил другой менеджер.' });
  };
  await h.c.submitForm();
  const posts = h.requests.filter(item => item.options && item.options.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body);
  assert.equal(posts[0].options.body.entries.find(([name]) => name === 'packet_revision')[1], '1');
  assert.equal(h.c.packetRevision, 2); assert.equal(h.nodes.get('address').value, 'Москва, подтверждённая правка');
  assert.match(h.alerts.at(-1), /подтверждено/);
});

test('a fresh explicit reload starts a new intent after a lost acknowledgement and changed local fields', async () => {
  const h = harness(); h.c.editOrderId = '58';
  h.c.respond = () => response(savedPacket(1)); await h.c.loadExistingPacket();
  const confirmedIntent = h.c.submitId;
  h.nodes.get('address').value = 'Правка после потерянного подтверждения';
  h.c.respond = () => response({ ok: false, code: 'ORDER_PACKET_SUBMISSION_CONFLICT', packet_revision: 2, error: 'Эта заявка уже сохранена с другими данными. Откройте заявку для изменения.' }, 409);
  await h.c.submitForm();
  assert.equal(h.c.submitId, confirmedIntent); assert.equal(h.nodes.get('packet-retry').hidden, false);
  assert.equal(h.nodes.get('address').value, 'Правка после потерянного подтверждения');
  h.c.respond = () => response(savedPacket(2)); await h.c.loadExistingPacket();
  assert.notEqual(h.c.submitId, confirmedIntent); assert.equal(h.c.packetRevision, 2);
  h.nodes.get('address').value = 'Новая правка после актуальной версии';
  h.c.respond = () => response({ ok: false, error: 'Synthetic stop' }, 400); await h.c.submitForm();
  const body = h.requests.at(-1).options.body.entries;
  assert.notEqual(body.find(([name]) => name === 'submit_id')[1], confirmedIntent);
  assert.equal(body.find(([name]) => name === 'packet_revision')[1], '2');
});
