const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const page = require('../src/web/handoff-page');
const M = page.model();
const clone = value => JSON.parse(JSON.stringify(value));
const pause = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function packet() {
  return { ok: true, signature: 'immutable-snapshot', order: { id: 60, org: 'ООО «ЧООКДИ»', address: 'Москва, Лесная, 5', region: 'МСК', kind: 'Общепит', service: 'Продление', inn: '1234567890', cad_num: '77:01:0004016:1064', contacts: [{ name: 'Карина', phone: '+79991234567', comment: 'Позвонить до выезда' }] }, report: { id: 15, src: 'a', text: 'Организация: ООО «ЧООКДИ»\nАдрес: Москва, Мясницкая, 15\nАудитор: @blanjik\n\nНужны действия\n\nПолный комментарий\nПоследняя строка.', address: 'Москва, Мясницкая, 15', status: 'actions', created_at: '2026-11-02T10:00:00Z', actor: '@blanjik', inspection: { address: 'Москва, Мясницкая, 15' }, telegram_url: 'https://t.me/c/4422574657/845', video_url: 'https://disk.yandex.ru/d/video', media: [{ id: 'map', name: 'Территория.png', mime: 'image/png', role: 'map', subject_id: 'annotation', caption: 'Схема · В3 — Вход', bytes: 100, url: '/api/handoff/reports/15/files/map' }, { id: 'plan', name: 'План.jpg', mime: 'image/jpeg', role: 'plan', subject_id: 'annotation', caption: 'План · лист 2 · этаж 1', bytes: 200, url: '/api/handoff/reports/15/files/plan' }, { id: 'entrance', name: 'Вход.png', mime: 'image/png', role: 'entrance', subject_id: 'e3', caption: 'В3 · Вход', bytes: 300, url: '/api/handoff/reports/15/files/entrance' }, { id: 'source', name: 'ЕГРН.pdf', mime: 'application/pdf', role: 'plan-source', subject_id: 'source', bytes: 400, url: '/api/handoff/reports/15/files/source' }] }, materials: [{ id: 'manager-egrn', name: 'Выписка.pdf', mime: 'application/pdf', role: 'egrn', bytes: 500, url: '/api/audit/orders/60/materials/manager-egrn' }], egrn: { status: 'available' }, archive_url: 'https://disk.yandex.ru/d/archive' };
}
function harness(options = {}) {
  const nodes = new Map(), calls = [], stored = new Map(Object.entries(options.stored || {})), events = new Map(), revoked = [], created = [];
  class Node {
    constructor(id = '') { this.id = id; this.children = []; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.parts = new Map(); this.innerHTML = ''; this.dataset = {}; this.style = {}; this.open = false; this.checked = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set innerHTML(value) { this._html = value; this.children = []; this.parts.clear(); }
    get innerHTML() { return this._html; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    querySelector(selector) { if (!this.parts.has(selector)) { const n = new Node(selector); if (selector === '.image-open' && /class="image-open" disabled/.test(this.innerHTML)) n.disabled = true; this.parts.set(selector, n); } return this.parts.get(selector); }
    querySelectorAll(selector) { if (selector === '[data-download]') { if (!this.parts.has(selector)) this.parts.set(selector, [...this.innerHTML.matchAll(/data-download="(\d+)"/g)].map(match => { const n = new Node('download'); n.dataset.download = match[1]; return n; })); return this.parts.get(selector); } return []; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(key, value) { if (key === 'open') this.open = true; this[key] = value; }
    removeAttribute(key) { if (key === 'open') this.open = false; delete this[key]; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    scrollIntoView() { calls.push(['scroll', this.id]); }
    focus() { document.activeElement = this; }
    remove() {}
    click() { calls.push(['click', this.id]); if (this.onclick) this.onclick({ preventDefault() {} }); }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); };
  const document = { activeElement: null, documentElement: { dataset: {} }, body: new Node('body'), getElementById: node, createElement: tag => new Node(tag), querySelector: selector => selector === 'dialog[open]' ? [...nodes.values()].find(n => n.id.endsWith('dialog') && n.open) || null : null };
  const responses = { packet: options.packet || packet(), prefill: { ok: true, lawyers: [{ tg_id: 108, name: 'Елена' }, { tg_id: 109, name: 'Мария' }], report: { src: 'a', id: 15 }, order: { id: 60 } } };
  let packetRequests = 0, postRequests = 0;
  async function fetch(url, init = {}) {
    calls.push(['fetch', url, init]);
    if (url.startsWith('/api/handoff/prefill')) return response(options.prefill || responses.prefill);
    if (url.startsWith('/api/handoff/packet')) { packetRequests++; if (options.packetError && packetRequests === 1) throw new Error('Сеть недоступна'); return response(responses.packet); }
    if (url === '/api/handoff' && init.method === 'POST') { postRequests++; if (options.post) return options.post(postRequests, JSON.parse(init.body)); return response({ ok: true, id: 75, delivery_complete: true }); }
    if (url.startsWith('/api/reports/search')) return response({ ok: true, items: options.searchItems || [] });
    if (url.startsWith('/api/reports/get')) return response({ ok: true, text: 'Аудитор: @only-auditor\nКомментарий: не превращать в контакт', metadata: { org: 'ООО Тест', address: 'Москва, Тестовая, 1', service: 'Получение' } });
    if (url.startsWith('/api/handoff/reports/') || url.startsWith('/api/audit/orders/')) { if (options.imageError && !/download=1/.test(url)) throw new Error('Image offline'); return { ok: true, blob: async () => ({ type: 'image/png', size: 100 }) }; }
    throw new Error('Unexpected fetch ' + url);
  }
  function response(data) { return { ok: true, status: 200, json: async () => clone(data) }; }
  const historyStack = [{}], history = { state: historyStack[0], pushState(value) { historyStack.push(value); this.state = value; }, back() { historyStack.pop(); this.state = historyStack[historyStack.length - 1] || {}; if (events.get('popstate')) events.get('popstate')(); } };
  class TestURL extends URL {}
  TestURL.createObjectURL = () => { const url = 'blob:protected-' + (created.length + 1); created.push(url); return url; };
  TestURL.revokeObjectURL = url => revoked.push(url);
  const window = { HandoffModel: page.model(), crypto: { randomUUID: () => 'd6fcab88-fb9e-4a29-8cd7-47ad66a0875e' }, addEventListener: (name, fn) => events.set(name, fn), matchMedia: () => ({ matches: false }) };
  const location = { search: options.query || '?order_id=60', origin: 'https://bot.example', href: 'https://bot.example/handoff' + (options.query || '?order_id=60') };
  const context = { window, document, location, history, fetch, URL: TestURL, URLSearchParams, AbortController, sessionStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) }, setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout, Date, Math, console };
  vm.createContext(context); vm.runInContext('(' + page.client.toString() + ')();', context);
  return { context, node, nodes, calls, stored, events, revoked, created, responses, response, postRequests: () => postRequests, packetRequests: () => packetRequests, cached: () => JSON.parse(stored.get('handoff-v2:staff:order-60') || 'null') };
}
function lawyer(h) { h.node('lawyers').value = '108'; h.node('lawyers').onchange(); }

test('package counts describe actual saved files, not source screenshots as extra plans', () => {
  const p = packet(), info = M.packageInfo(p);
  assert.deepEqual([info.maps, info.plans, info.photos, info.originals, info.materials], [1, 1, 1, 4, 1]);
  assert.equal(M.gallery(p.report.media)[0].id, 'map');
  assert.equal(info.egrn, 'available');
  assert.equal(M.mediaLabel(p.report.media[2]), 'В3 · Вход');
  p.report.src = 'r'; p.report.media = []; assert.equal(M.packageInfo(p).known, false);
  assert.equal(M.packageInfo(p).materialsKnown, true, 'known manager materials remain distinct from unknown legacy audit photos');
});

test('escaping and URL allowlists reject script or third-party authenticated fetches', () => {
  assert.equal(M.escape('<img onerror="x"> &'), '&lt;img onerror=&quot;x&quot;&gt; &amp;');
  assert.equal(M.safeHttp('javascript:alert(1)'), '');
  assert.equal(M.protectedUrl('https://evil.example/api/handoff/files/x', 'https://bot.example'), '');
  assert.equal(M.protectedUrl('/auth.js', 'https://bot.example'), '');
  assert.equal(M.protectedUrl('/api/handoff/reports/15/files/id?download=1', 'https://bot.example'), '/api/handoff/reports/15/files/id?download=1');
});

test('current order wins over historical report; manager comment starts empty and contacts remain structured', async () => {
  const h = harness(); await pause();
  assert.equal(h.node('address').value, 'Москва, Лесная, 5');
  assert.equal(h.node('cad_num').value, '77:01:0004016:1064');
  assert.equal(h.node('comment').value, '');
  assert.match(h.node('contacts').innerHTML, /Карина/);
  assert.doesNotMatch(h.node('contacts').innerHTML, /blanjik/);
  assert.match(h.node('historical-note').textContent, /Мясницкая/);
  assert.equal(h.node('egrn-order').checked, false, 'a new paid EGRN order is always opt-in');
});

test('cached assignment/comment survives source changes without restoring a stale address or contact', async () => {
  const source = M.profile(packet().order), cache = { version: 2, fingerprint: M.fingerprint(source), profile: { ...source, address: 'Старая исправленная улица' }, contacts: [{ name: 'Старый контакт', phone: '111' }], lawyer: '108', priority: 'срочно', comment: 'Новый комментарий', submitId: 'same-id', egrnOrder: true };
  const changed = packet(); changed.order.address = 'Москва, Новый адрес, 7';
  const h = harness({ packet: changed, stored: { 'handoff-v2:staff:order-60': JSON.stringify(cache) } }); await pause();
  assert.equal(h.node('address').value, 'Москва, Новый адрес, 7');
  assert.equal(h.node('comment').value, 'Новый комментарий');
  assert.equal(h.node('priority').value, 'срочно');
  assert.doesNotMatch(h.node('contacts').innerHTML, /Старый контакт/);
  h.node('go').click(); assert.equal(h.node('review-lawyer').textContent, 'Елена');
});

test('initial packet failure can be retried and loads the authoritative object without clearing assignment', async () => {
  const h = harness({ packetError: true }); await pause();
  assert.equal(h.node('packet-error').hidden, false); assert.equal(h.node('go').disabled, true);
  lawyer(h); h.node('comment').value = 'Сохранить'; h.node('comment').oninput();
  h.node('retry-load').click(); await pause();
  assert.equal(h.packetRequests(), 2); assert.equal(h.node('packet-error').hidden, true);
  assert.equal(h.node('address').value, 'Москва, Лесная, 5'); assert.equal(h.node('comment').value, 'Сохранить');
  h.node('go').click(); assert.equal(h.node('review-lawyer').textContent, 'Елена');
});

test('full report uses all text/newlines and authenticated Blob URLs; close releases images without losing form state', async () => {
  const p = packet(); p.report.text += '\n' + 'Очень длинный комментарий.\n'.repeat(300) + 'КОНЕЦ';
  const h = harness({ packet: p }); await pause(); lawyer(h);
  h.node('comment').value = 'Не потерять'; h.node('comment').oninput();
  h.node('open-report').click(); await pause();
  assert.equal(h.node('report-dialog').open, true); assert.equal(h.node('report-text').textContent, p.report.text);
  assert.equal(h.node('gallery').children.length, 3);
  assert.equal(h.created.length, 3);
  for (const card of h.node('gallery').children) {
    const image = card.querySelector('img'); assert.match(image.src, /^blob:/); image.onload();
    assert.equal(card.querySelector('.image-open').disabled, false);
  }
  assert.equal(h.node('report-video').href, p.report.video_url);
  assert.match(h.node('report-originals').innerHTML, /Выписка.pdf/);
  const imageButton = h.node('gallery').children[0].querySelector('.image-open'); imageButton.click();
  assert.equal(h.node('zoom-dialog').open, true); h.node('zoom-plus').click(); assert.equal(h.node('zoom-value').textContent, '150%');
  h.node('zoom-close').click(); assert.equal(h.node('zoom-dialog').open, false);
  h.node('report-close').click();
  assert.equal(h.node('report-dialog').open, false); assert.equal(h.revoked.length, 3);
  assert.equal(h.node('comment').value, 'Не потерять');
  h.node('go').click(); assert.equal(h.node('review-lawyer').textContent, 'Елена');
  assert.equal(h.postRequests(), 0);
});

test('image error stays visible with a real retry instead of pretending a photo is loaded', async () => {
  const h = harness({ imageError: true }); await pause(); h.node('open-report').click(); await pause();
  const card = h.node('gallery').children[0], state = card.querySelector('.image-state');
  assert.match(state.textContent, /не загрузилось/); assert.equal(state.children[0].textContent, 'Повторить');
  assert.equal(card.querySelector('.image-open').disabled, true, 'failed photos cannot open an empty zoom surface');
  assert.equal(h.created.length, 0);
  const before = h.calls.filter(c => c[0] === 'fetch').length; state.children[0].click(); await pause();
  assert.ok(h.calls.filter(c => c[0] === 'fetch').length > before);
});

test('first action is a local recipient/package review; final confirm posts exact V2 packet once', async () => {
  const h = harness(); await pause(); lawyer(h);
  h.node('comment').value = 'Важное условие'; h.node('comment').oninput(); h.node('go').click();
  assert.equal(h.postRequests(), 0); assert.equal(h.node('review').hidden, false); assert.equal(h.node('footer').hidden, true);
  assert.match(h.node('review-list').innerHTML, /Схемы: 1/); assert.match(h.node('review-list').innerHTML, /Документы заявки: 1/);
  h.node('review-back').click(); assert.equal(h.node('review').hidden, true); assert.equal(h.node('comment').value, 'Важное условие');
  h.node('go').click(); h.node('confirm-send').click(); await pause();
  const payload = JSON.parse(h.calls.find(c => c[1] === '/api/handoff')[2].body);
  assert.equal(payload.handoff_version, 2); assert.equal(payload.packet_signature, 'immutable-snapshot'); assert.equal(payload.address, 'Москва, Лесная, 5');
  assert.equal(payload.egrn_order, false); assert.equal(payload.contacts[0].name, 'Карина'); assert.equal(payload.comment, 'Важное условие');
  assert.equal(h.postRequests(), 1); assert.match(h.node('delivery-title').textContent, /Передано/);
  assert.equal(h.node('retry-send').hidden, true);
});

test('partial delivery or network error preserves the exact payload and id for safe resume', async () => {
  const bodies = [], h = harness({ post: (n, payload) => { bodies.push(payload); return h.response(n === 1 ? { ok: true, id: 75, delivery_complete: false, retry: true, warn: 'Не удалось доставить PDF' } : { ok: true, id: 75, delivery_complete: true }); } });
  await pause(); lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  assert.equal(h.node('delivery-title').textContent, 'Доставка не завершена'); assert.match(h.node('delivery-text').textContent, /PDF/);
  assert.equal(h.node('retry-send').hidden, false); assert.equal(h.node('lawyers').disabled, true);
  assert.equal(h.cached().pending.payload.submit_id, bodies[0].submit_id);
  h.node('retry-send').click(); await pause();
  assert.equal(bodies.length, 2); assert.deepEqual(bodies[1], bodies[0]); assert.equal(h.node('retry-send').hidden, true);
});

test('readonly report URL loads the explicitly selected report and cannot create a handoff', async () => {
  const h = harness({ query: '?order_id=60&report_src=a&report_id=15&view=report' }); await pause();
  assert.equal(h.node('report-dialog').open, true); assert.equal(h.node('assignment').hidden, true); assert.equal(h.node('footer').hidden, true);
  assert.ok(h.calls.some(c => c[0] === 'fetch' && /packet\?order_id=60&report_src=a&report_id=15/.test(c[1])));
  lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause(); assert.equal(h.postRequests(), 0);
});

test('page contains full-height accessible sheets and reduced-motion/transparency support', () => {
  const html = page();
  assert.match(html, /<dialog id="report-dialog"[^>]*aria-labelledby="report-heading"/);
  assert.match(html, /<pre id="report-text"/); assert.match(html, /height:100dvh/);
  assert.match(html, /prefers-reduced-motion/); assert.match(html, /prefers-reduced-transparency/);
  assert.match(html, /<script src="\/auth.js"><\/script>/);
  assert.doesNotMatch(html, /parseContacts|fillFrom\(/);
});

test('network uncertainty stores the original attempt, then a repeated delivery uses the same case idempotency key', async () => {
  const bodies = [], h = harness({ post: (n, body) => { bodies.push(body); if (n === 1) throw new Error('Связь прервана'); return h.response({ ok: true, id: 75, delivery_complete: true, egrn_note: 'attached' }); } });
  await pause(); lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  assert.match(h.node('delivery-text').textContent, /не подтверждена/);
  h.node('retry-send').click(); await pause(); assert.deepEqual(bodies[0], bodies[1]);
  assert.match(h.node('delivery-text').textContent, /ЕГРН приложена/);
});

test('individual original downloads use authenticated fetch and an attachment flag', async () => {
  const h = harness(); await pause(); h.node('open-report').click(); await pause();
  const buttons = h.node('report-originals').querySelectorAll('[data-download]');
  assert.equal(buttons.length, 5); buttons[4].click(); await pause();
  assert.ok(h.calls.some(c => c[0] === 'fetch' && c[1] === '/api/audit/orders/60/materials/manager-egrn?download=1'));
  assert.ok(h.calls.some(c => c[0] === 'click' && c[1] === 'a'));
});

test('a standalone manager selecting a verified saved audit binds its order and sends the full V2 package', async () => {
  const h = harness({ query: '?new=1', prefill: { ok: true, lawyers: [{ tg_id: 108, name: 'Елена' }], report: null, order: null }, searchItems: [{ id: 15, src: 'a', order_id: 60, metadata: { org: 'ООО «ЧООКДИ»', address: 'Москва, Лесная, 5' }, text: 'Отчёт', created_at: '2026-11-02T10:00:00Z' }] });
  await pause(); h.node('choose-report').click(); await pause(); h.node('search-results').children[0].click(); await pause();
  assert.equal(h.node('address').value, 'Москва, Лесная, 5'); assert.equal(h.node('search-dialog').open, false);
  assert.match(h.node('object-source').textContent, /60/);
  lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  const body = JSON.parse(h.calls.find(c => c[1] === '/api/handoff')[2].body);
  assert.equal(body.order_id, 60); assert.equal(body.handoff_version, 2); assert.equal(body.packet_signature, 'immutable-snapshot');
});

test('legacy request starts from labelled request data and does not copy its historical manager comment', async () => {
  const h = harness({ query: '?request_id=7', prefill: { ok: true, lawyers: [{ tg_id: 108, name: 'Елена' }], order: null, report: null, request: { id: 7, text: 'Аудитор: @do-not-use\nТелефон аудитора: +79990000000', f: { org: 'ООО Клиент', address: 'Москва, Тестовая, 1', region: 'МСК', kind: 'Магазин', service: 'Получение', client: 'Анна', phone: '+79998887766', comment: 'Старое длинное задание менеджера' } } } });
  await pause(); assert.equal(h.node('org').value, 'ООО Клиент'); assert.equal(h.node('comment').value, '');
  assert.match(h.node('contacts').innerHTML, /Анна/); assert.doesNotMatch(h.node('contacts').innerHTML, /do-not-use|79990000000/);
  assert.match(h.node('materials-state').textContent, /не подтверждён/);
  lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  const body = JSON.parse(h.calls.find(c => c[1] === '/api/handoff')[2].body);
  assert.equal(body.request_id, 7); assert.equal(body.order_id, null); assert.equal(body.handoff_version, undefined);
});

test('new package invalidates an old completed session instead of permanently blocking another handoff', async () => {
  const p = packet(), source = M.profile(p.order);
  const h = harness({ stored: { 'handoff-v2:staff:order-60': JSON.stringify({ version: 2, fingerprint: M.fingerprint(source), packetSignature: 'old-signature', lawyer: '108', completed: { id: 74, name: 'Елена' }, submitId: 'old-id' }) } });
  await pause(); assert.equal(h.node('delivery').hidden, true); assert.equal(h.node('go').disabled, false);
  h.node('go').click(); h.node('confirm-send').click(); await pause();
  const body = JSON.parse(h.calls.find(c => c[1] === '/api/handoff')[2].body); assert.notEqual(body.submit_id, 'old-id');
});

test('known pre-creation packet rejection allows refresh while preserving the chosen lawyer and new comment', async () => {
  const h = harness({ post: () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'PACKET_CHANGED', error: 'Материалы заявки изменились.', case_created: false }) }) });
  await pause(); lawyer(h); h.node('comment').value = 'Условие передачи'; h.node('comment').oninput();
  h.node('go').click(); h.node('confirm-send').click(); await pause();
  assert.equal(h.node('delivery').hidden, true); assert.equal(h.node('packet-error').hidden, false);
  assert.equal(h.cached().pending, null); assert.match(h.node('packet-error-text').textContent, /Обновите/);
  h.responses.packet.order.address = 'Москва, Исправленная, 8'; h.responses.packet.signature = 'updated';
  h.node('retry-load').click(); await pause();
  assert.equal(h.node('address').value, 'Москва, Исправленная, 8'); assert.equal(h.node('comment').value, 'Условие передачи');
  h.node('go').click(); assert.equal(h.node('review-lawyer').textContent, 'Елена');
});

test('manual-review delivery response exposes the case number without offering an unsafe repeated send', async () => {
  const h = harness({ post: () => h.response({ ok: true, id: 75, delivery_complete: false, retry: false, manual_review: true, warn: 'Проверьте доставку карточки: ответ Telegram не подтверждён.' }) });
  await pause(); lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  assert.equal(h.node('delivery-title').textContent, 'Нужна проверка доставки'); assert.match(h.node('delivery-text').textContent, /75/);
  assert.equal(h.node('retry-send').hidden, true); assert.equal(h.node('go').disabled, true); assert.equal(h.node('open-report').disabled, false);
});

test('retry of an explicit report URL keeps that exact report rather than silently loading the latest one', async () => {
  const h = harness({ query: '?order_id=60&report_src=a&report_id=15&view=report', packetError: true }); await pause();
  h.node('retry-load').click(); await pause();
  const packetUrls = h.calls.filter(c => c[0] === 'fetch' && c[1].startsWith('/api/handoff/packet')).map(c => c[1]);
  assert.equal(packetUrls.length, 2); assert.equal(packetUrls[0], packetUrls[1]);
  assert.equal(h.node('report-dialog').open, true);
});

test('full-report navigation jumps directly to text, images and files without truncating or sending anything', async () => {
  const p = packet(); p.materials.push({ ...p.materials[0], id: 'lease', name: 'Договор.pdf', role: 'lease' });
  p.report.text += '\n' + 'Длинный текст\n'.repeat(500);
  const h = harness({ packet: p }); await pause(); lawyer(h);
  h.node('comment').value = 'Сохранить мой комментарий'; h.node('comment').oninput();
  assert.equal(h.node('materials-state').textContent, 'Документы заявки · 2 файла');
  h.node('open-report').click(); await pause();
  h.node('jump-images').click(); h.node('jump-files').click(); h.node('jump-text').click();
  for (const id of ['report-images-heading', 'report-files-heading', 'report-text']) assert.ok(h.calls.some(c => c[0] === 'scroll' && c[1] === id));
  assert.equal(h.node('report-text').textContent, p.report.text);
  assert.equal(h.node('report-dialog').open, true); assert.equal(h.postRequests(), 0);
  h.node('report-close').click(); assert.equal(h.node('comment').value, 'Сохранить мой комментарий');
  assert.match(page(), /<nav class="sheet-tabs" aria-label="Разделы полного отчёта">/);
});

test('historical address provenance stays inside object details and remains available in the full report', async () => {
  const html = page(), detailsStart = html.indexOf('<details id="details"'), note = html.indexOf('<p id="historical-note"'), detailsEnd = html.indexOf('</details>', detailsStart);
  assert.ok(note > detailsStart && note < detailsEnd, 'the old address note must not occupy the compact object card');
  assert.ok(!html.slice(detailsStart, note).includes(' open'), 'details are initially collapsed');
  const h = harness(); await pause();
  assert.equal(h.node('object-address').textContent, 'Москва, Лесная, 5');
  assert.doesNotMatch(h.node('object-source').textContent, /Мясницкая/);
  assert.match(h.node('historical-note').textContent, /Мясницкая/);
  h.node('open-report').click(); await pause();
  assert.equal(h.node('report-address-note').hidden, false);
  assert.match(h.node('report-address-note').textContent, /Мясницкая/);
  assert.match(h.node('report-text').textContent, /Мясницкая/);
});

test('legacy request selecting a verified audit binds the full V2 order package while preserving its source request', async () => {
  const h = harness({ query: '?request_id=9', prefill: { ok: true, lawyers: [{ tg_id: 108, name: 'Елена' }], order: null, report: null, request: { id: 9, text: 'Исходная заявка менеджера', f: { org: 'ООО «ЧООКДИ»', address: 'Москва, Лесная, 5', region: 'МСК', kind: 'Общепит', service: 'Продление' } } }, searchItems: [{ id: 15, src: 'a', order_id: 60, metadata: { org: 'ООО «ЧООКДИ»' }, text: 'Отчёт', created_at: '2026-11-02T10:00:00Z' }] });
  await pause(); h.node('choose-report').click(); await pause(); h.node('search-results').children[0].click(); await pause();
  assert.match(h.node('object-source').textContent, /60/);
  assert.equal(h.node('materials-state').textContent, 'Документы заявки · 1 файл');
  assert.match(h.node('packet-counts').innerHTML, /Оригиналы аудита/);
  lawyer(h); h.node('go').click();
  assert.match(h.node('review-list').innerHTML, /Документы заявки: 1/);
  h.node('confirm-send').click(); await pause();
  const body = JSON.parse(h.calls.find(c => c[1] === '/api/handoff')[2].body);
  assert.equal(body.order_id, 60); assert.equal(body.request_id, 9); assert.equal(body.handoff_version, 2);
  assert.equal(body.packet_signature, 'immutable-snapshot'); assert.equal(body.report_src, 'a'); assert.equal(body.report_id, 15);
});

test('an assigned order reopened in a new session cannot create another client, while the full report stays accessible', async () => {
  const p = packet(); p.assignment = { case_id: 75, lawyer_name: 'Мария', delivery_complete: false, submit_id: 'existing-job' };
  const h = harness({ packet: p }); await pause();
  assert.equal(h.node('go').disabled, true); assert.equal(h.node('assignment').hidden, true);
  assert.equal(h.node('delivery-title').textContent, 'Уже передано: Мария');
  assert.match(h.node('delivery-text').textContent, /75/); assert.match(h.node('delivery-text').textContent, /не завершена/);
  assert.equal(h.node('retry-send').hidden, true); assert.equal(h.node('details-editable').disabled, true);
  h.node('open-report').click(); await pause(); assert.equal(h.node('report-dialog').open, true);
  h.node('go').click(); h.node('confirm-send').click(); h.node('retry-send').click(); await pause();
  assert.equal(h.postRequests(), 0);
});

test('matching cached pending submit id resumes its partially assigned case even before a case number was cached', async () => {
  const p = packet(), source = M.profile(p.order), payload = { handoff_version: 2, submit_id: 'same-job', order_id: 60, lawyer_tg_id: '108', packet_signature: p.signature, comment: 'Точный исходный комментарий' };
  p.assignment = { case_id: 75, lawyer_name: 'Елена', delivery_complete: false, submit_id: 'same-job' };
  const h = harness({ packet: p, stored: { 'handoff-v2:staff:order-60': JSON.stringify({ version: 2, fingerprint: M.fingerprint(source), packetSignature: p.signature, lawyer: '108', submitId: 'same-job', pending: { payload, name: 'Елена' } }) } }); await pause();
  assert.equal(h.node('delivery-title').textContent, 'Доставка не завершена'); assert.equal(h.node('retry-send').hidden, false);
  h.node('retry-send').click(); await pause();
  assert.deepEqual(JSON.parse(h.calls.find(c => c[1] === '/api/handoff')[2].body), payload);
  assert.equal(h.postRequests(), 1); assert.match(h.node('delivery-title').textContent, /Передано/);
});

test('a cached pending attempt for another assignment is blocked instead of retrying the wrong lawyer', async () => {
  const p = packet(), source = M.profile(p.order); p.assignment = { case_id: 80, lawyer_name: 'Мария', delivery_complete: false, submit_id: 'actual-job' };
  const h = harness({ packet: p, stored: { 'handoff-v2:staff:order-60': JSON.stringify({ version: 2, fingerprint: M.fingerprint(source), lawyer: '108', pending: { payload: { submit_id: 'different-job', order_id: 60 }, name: 'Елена' } }) } }); await pause();
  assert.equal(h.node('delivery-title').textContent, 'Уже передано: Мария'); assert.equal(h.node('retry-send').hidden, true); assert.equal(h.node('assignment').hidden, true);
  h.node('retry-send').click(); await pause(); assert.equal(h.postRequests(), 0);
});

test('an already-assigned server rejection shows the actual recipient and case without offering another send', async () => {
  const h = harness({ post: () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'HANDOFF_ALREADY_ASSIGNED', error: 'Клиент уже передан другому юристу.', case_created: true, manual_review: true, retry: false, case_id: 81, lawyer_name: 'Мария', delivery_complete: false }) }) });
  await pause(); lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  assert.equal(h.node('delivery-title').textContent, 'Уже передано: Мария'); assert.match(h.node('delivery-text').textContent, /81/);
  assert.equal(h.node('assignment').hidden, true); assert.equal(h.node('retry-send').hidden, true); assert.equal(h.node('open-report').disabled, false);
  h.node('retry-send').click(); await pause(); assert.equal(h.postRequests(), 1);
});
