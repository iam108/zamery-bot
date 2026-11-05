const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { miniAppForm } = require('../src/web/index');

function harness() {
  const html = miniAppForm(), nodes = new Map(), alerts = [], requests = [], waits = [];
  function element(tag = 'div') {
    return { tagName: tag.toUpperCase(), value: '', checked: false, disabled: false, hidden: false, style: {}, options: [], children: [],
      classList: { add() {}, remove() {}, toggle() {} }, appendChild(child) { this.children.push(child); if (child.tagName === 'OPTION') this.options.push(child); }, setAttribute() {} };
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) nodes.set(match[2], element(match[1]));
  const context = { window: {}, location: { search: '' }, URLSearchParams, URL, console, Date, Math, alert: text => alerts.push(text),
    FormData: class { constructor() { this.entries = []; } append(...entry) { this.entries.push(entry); } },
    setTimeout: (fn, delay) => { waits.push(delay); queueMicrotask(fn); },
    document: { getElementById: id => nodes.get(id), querySelectorAll: () => [...nodes.values()].filter(node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)), createElement: element },
    fetch: async (url, options) => { requests.push({ url, options }); return context.respond(url, options); },
  };
  vm.createContext(context);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  for (const [field, value] of Object.entries({ address: 'Москва, адрес', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Получение', cad_num: '77:01:0000001:12' })) nodes.get(field).value = value;
  nodes.get('egrn_order').checked = true;
  return { c: context, nodes, alerts, requests, waits };
}
function response(body, status = 200) { return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }; }
function savedPacket() { return { ok: true, can_edit: true, order: { id: 58, address: 'Москва, адрес', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Получение', cad_num: '77:01:0000001:12' }, materials: [{ id: 'saved-plan', name: 'План.pdf', role: 'plan', bytes: 4 }] }; }

test('a permanent submission conflict stops immediately instead of waiting and resending four times', async () => {
  const h = harness(); h.c.respond = () => response({ ok: false, error: 'Заявка сохранена с другими данными.' }, 409);
  await h.c.submitForm();
  assert.equal(h.requests.length, 1); assert.equal(h.waits.length, 0);
  assert.match(h.alerts[0], /другими данными/);
});

test('saved creation with a delivery warning becomes an editable existing packet and preserves EGRN intent and newer typing', async () => {
  const h = harness(), sent = { name: 'План.pdf', size: 4, materialRole: 'plan' };
  h.c.attachedFiles.push(sent); const originalId = h.c.submitId;
  h.c.respond = (url, options) => {
    if (!options) return response(savedPacket());
    h.nodes.get('address').value = 'Москва, правка во время отправки';
    return response({ ok: true, id: 58, warning: 'Заявка #58 и документы сохранены. Доставка временно недоступна.' });
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
    if (options) return response({ ok: true, id: 58, warning: 'Заявка #58 сохранена. Доставка не завершена.' });
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
