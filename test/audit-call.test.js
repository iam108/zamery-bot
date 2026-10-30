'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const actions = require('../public/audit-actions');
const source = fs.readFileSync(path.join(__dirname, '../public/audit-call.js'), 'utf8');
const phone = '+79995554433';

function callPage(url, options = {}) {
  const location = new URL(url), events = [], fields = new Map();
  for (const id of ['phone', 'dial', 'copy', 'status']) fields.set(id, {
    id, hidden: true, value: '', textContent: '', href: '',
    click() { events.push(['dial-request', this.href]); },
    focus() { events.push(['focus', id]); },
    select() { events.push(['select', id]); }
  });
  const document = {
    getElementById: id => fields.get(id),
    execCommand(command) { events.push(['legacy-copy', command]); return options.legacyCopy !== false; }
  };
  const navigator = options.clipboard === false ? {} : {clipboard:{
    async writeText(value) { events.push(['copy', value]); if (options.clipboardRejects) throw new Error('denied'); }
  }};
  const history = { replaceState(_state, _unused, next) {
    events.push(['consume-action', next]);
    if (options.historyRejects) throw new Error('blocked');
    location.href = new URL(next, location).href;
  }};
  const context = {window:{AuditActions: actions}, document, navigator, location, history, URLSearchParams};
  vm.runInNewContext(source, context);
  return {events, fields, location};
}

test('an explicit call consumes its one-shot action before requesting the system dialer', () => {
  const h = callPage(actions.callUrl('https://example.test', phone, true));
  assert.equal(h.fields.get('phone').value, phone);
  assert.equal(h.fields.get('phone').hidden, false);
  assert.equal(h.fields.get('dial').hidden, false);
  assert.equal(h.fields.get('dial').href, 'tel:' + phone);
  assert.deepEqual(h.events.map(event => event[0]), ['consume-action', 'dial-request']);
  assert.deepEqual(h.events[1], ['dial-request', 'tel:' + phone]);
  assert.equal(new URLSearchParams(h.location.hash.slice(1)).has('dial'), false);
  assert.equal(new URLSearchParams(h.location.hash.slice(1)).get('phone'), phone);
  assert.match(h.fields.get('status').textContent, /Подтвердите/);
});

test('reload or back to an already consumed contact never repeats an automatic dial request', () => {
  const first = callPage(actions.callUrl('https://example.test', phone, true));
  const refreshed = callPage(first.location.href);
  assert.deepEqual(refreshed.events, []);
  assert.equal(refreshed.fields.get('dial').href, 'tel:' + phone);
});

test('a contact opened without an explicit call flag only offers manual controls', () => {
  for (const flag of ['', '&dial=0', '&dial=true', '&dial=2']) {
    const h = callPage('https://example.test/audit-call.html#phone=%2B79995554433' + flag);
    assert.deepEqual(h.events, []);
    assert.equal(h.fields.get('dial').hidden, false);
    assert.equal(h.fields.get('copy').hidden, false);
  }
});

test('invalid or missing numbers cannot initiate a dial request even with the call flag', () => {
  for (const value of ['', 'javascript:alert(1)', 'номер 79995554433', '+7999']) {
    const h = callPage('https://example.test/audit-call.html#phone=' + encodeURIComponent(value) + '&dial=1');
    assert.deepEqual(h.events, []);
    assert.equal(h.fields.get('dial').hidden, true);
    assert.equal(h.fields.get('copy').hidden, true);
    assert.match(h.fields.get('status').textContent, /Номер не передан/);
  }
});

test('failure to consume an action keeps a manual call available without risking repeated automatic attempts', () => {
  const h = callPage(actions.callUrl('https://example.test', phone, true), {historyRejects:true});
  assert.equal(h.events.filter(event => event[0] === 'dial-request').length, 0);
  assert.equal(h.fields.get('dial').href, 'tel:' + phone);
  assert.equal(h.fields.get('dial').hidden, false);
  assert.match(h.fields.get('status').textContent, /Нажмите «Набрать номер»/);
});

test('phone copy succeeds without another dial request and denied clipboard selects the visible number', async () => {
  const h = callPage(actions.callUrl('https://example.test', phone));
  await h.fields.get('copy').onclick();
  assert.deepEqual(h.events, [['copy', phone]]);
  assert.match(h.fields.get('status').textContent, /Номер скопирован/);
  const denied = callPage(actions.callUrl('https://example.test', phone), {clipboardRejects:true});
  await denied.fields.get('copy').onclick();
  assert.deepEqual(denied.events, [['copy',phone],['focus','phone'],['select','phone']]);
  assert.match(denied.fields.get('status').textContent, /Номер выделен/);
  const legacy = callPage(actions.callUrl('https://example.test', phone), {clipboard:false});
  await legacy.fields.get('copy').onclick();
  assert.deepEqual(legacy.events, [['select','phone'],['legacy-copy','copy']]);
});
