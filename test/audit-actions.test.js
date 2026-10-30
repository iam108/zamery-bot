'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../public/audit-actions');

const phone = '+79995554433';
const formats = ['+7 (999) 555-44-33', '8 999 555 44 33', '79995554433', '9995554433'];
const nativeBridge = () => ({ TelegramWebviewProxy: { postEvent() {} } });

test('contact numbers normalize Russian country and local formats', () => {
  for (const value of formats) assert.equal(actions.normalizePhone(value), phone, value);
  for (const value of ['', null, '12345', 'номер 79995554433', '05.11.2026 10']) {
    assert.equal(actions.normalizePhone(value), '', String(value));
  }
});

test('a callable contact is found in manager text, objects, arrays and saved JSON', () => {
  for (const value of formats) {
    assert.equal(actions.findPhone('Перед выездом позвонить Кристине: ' + value), phone, value);
    assert.equal(actions.findPhone({ name: 'Кристина', phone: value }), phone, value);
  }
  assert.equal(actions.findPhone([{ name: 'Ирина' }, { contact_name: 'Кристина', contact_phone: '8 (999) 555-44-33' }]), phone);
  assert.equal(actions.findPhone(JSON.stringify([{ name: 'Кристина', phone: '8 (999) 555-44-33' }])), phone);
  assert.equal(actions.findPhone({ comment: 'До выезда звонить ' + phone + ', доб. 123' }), phone);
  assert.equal(actions.findPhone(phone + '; запасной +7 900 111-22-33'), phone);
});

test('dates beside a phone do not hide it and an appointment date never becomes a phone', () => {
  assert.equal(actions.findPhone('Кристина ' + phone + ' 05.11.2026'), phone);
  assert.equal(actions.findPhone('05.11.2026 в 10 часов: Кристина ' + phone), phone);
  for (const value of ['Встреча 05.11.2026 10 часов', '05.11.2026', 'Срок 5.11.2026', 'Телефон не указан', '+799955544330']) {
    assert.equal(actions.findPhone(value), '', value);
  }
});

test('route uses the building address and keeps building structures in either floor notation', () => {
  const building = 'Москва, Мясницкая улица, д. 15, корпус 2, строение 1';
  for (const suffix of [', этаж 1, комната 75', ', 1 этаж, комната 75', ', 1-й этаж, комната 75', ', эт. 1, пом. 75', ', помещение 75']) {
    assert.equal(actions.routeAddress(building + suffix), building, suffix);
  }
  assert.equal(actions.routeAddress(' Москва,  улица Этажная, д. 3 '), 'Москва, улица Этажная, д. 3');
  assert.equal(actions.routeAddress('Москва, Мясницкая, д. 15, стр. 2, этаж 1'), 'Москва, Мясницкая, д. 15, стр. 2');
  assert.equal(actions.routeAddress('Москва, Мясницкая, д. 15/2'), 'Москва, Мясницкая, д. 15/2');
});

test('manual Maps fallback leaves start unspecified while explicit origins build a complete route', () => {
  const destination = 'Москва, Мясницкая улица, д. 15, строение 2';
  const url = new URL(actions.routeUrl(destination + ', этаж 1, комната 75'));
  assert.equal(url.origin, 'https://yandex.ru');
  assert.equal(url.pathname, '/maps/');
  assert.equal(url.searchParams.get('mode'), 'routes');
  assert.equal(url.searchParams.get('rtext'), '~' + destination);
  assert.equal(url.searchParams.get('rtt'), 'auto');
  assert.equal(actions.routeUrl('  '), '');
  const fromAddress = new URL(actions.routeUrl(destination, ' Москва,  Лубянская площадь, 2 '));
  assert.equal(fromAddress.searchParams.get('rtext'), 'Москва, Лубянская площадь, 2~' + destination);
  const fromLocation = new URL(actions.routeUrl(destination, { latitude: 55.7589444, longitude: 37.6272924 }));
  assert.equal(fromLocation.searchParams.get('rtext'), '55.758944,37.627292~' + destination);
  for (const bad of ['', ' '.repeat(5), 'a'.repeat(251), {latitude: 91, longitude: 30}, {latitude: 55, longitude: Infinity}, {latitude: '55', longitude: 37}, {latitude: 55}]) {
    assert.equal(actions.routeUrl(destination, bad), '', JSON.stringify(bad));
  }
  assert.equal(actions.routeOrigin({latitude:0,longitude:0}), '0,0');
});

test('phone handoff stays on this origin and keeps the private number in the fragment only', () => {
  const raw = actions.callUrl('https://example.test/audit?order_id=92#old', '8 (999) 555-44-33');
  const url = new URL(raw);
  assert.equal(url.origin, 'https://example.test');
  assert.equal(url.pathname, '/audit-call.html');
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('phone'), phone);
  assert.equal(raw.split('#')[0].includes('9995554433'), false);
  assert.equal(actions.callUrl('http://127.0.0.1:8780', phone).startsWith('http://127.0.0.1:8780/audit-call.html#'), true);
  assert.equal(new URL(actions.callUrl('https://example.test/audit/legacy?order_id=92#old', phone)).pathname, '/audit-call.html');
  assert.equal(new URLSearchParams(url.hash.slice(1)).has('dial'), false, 'Opening a saved contact must not start another dial request');
  const direct = new URL(actions.callUrl('https://example.test', phone, true));
  assert.equal(direct.search, '');
  assert.equal(new URLSearchParams(direct.hash.slice(1)).get('dial'), '1');
  assert.equal(new URLSearchParams(direct.hash.slice(1)).get('phone'), phone);
});

test('native mobile route uses numeric destination and never mixes coordinates with an address origin', () => {
  const point = {latitude:55.763022,longitude:37.634874};
  const link = new URL(actions.routeUrl(point));
  assert.equal(link.searchParams.get('rtext'), '~55.763022,37.634874');
  assert.equal(link.searchParams.get('rtt'), 'auto');
  assert.equal(new URL(actions.routeUrl(point,{latitude:55.761487,longitude:37.612191})).searchParams.get('rtext'),'55.761487,37.612191~55.763022,37.634874');
  assert.equal(actions.routeUrl(point,'Москва, улица'), '');
  for(const bad of [{},{latitude:91,longitude:37},{latitude:55,longitude:'37'}, {latitude:NaN,longitude:37}]) assert.equal(actions.routeUrl(bad), '');
});

test('address search fallback is explicitly a search rather than a nonworking mobile route', () => {
  const link = new URL(actions.searchUrl('Москва, Тестовая, 3, этаж 1, комната 2'));
  assert.equal(link.searchParams.get('text'), 'Москва, Тестовая, 3');
  assert.equal(link.searchParams.has('rtext'), false);
  assert.equal(actions.searchUrl(''), '');
});

test('invalid phone and unsafe or malformed handoff origins fail without throwing', () => {
  for (const origin of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', 'ftp://example.test', '', 'not-an-origin', 'https://user:secret@example.test/zamery-bot/', 'https://user@example.test/', 'https://:secret@example.test/']) {
    assert.equal(actions.callUrl(origin, phone), '', origin);
  }
  assert.equal(actions.callUrl('https://example.test', 'нет номера'), '');
});

test('a phone handoff preserves a static project directory with or without a trailing slash', () => {
  for (const base of ['https://iam108.github.io/zamery-bot/', 'https://iam108.github.io/zamery-bot']) {
    const url = new URL(actions.callUrl(base, phone, true));
    assert.equal(url.origin, 'https://iam108.github.io');
    assert.equal(url.pathname, '/zamery-bot/audit-call.html');
    assert.equal(url.search, '');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('phone'), phone);
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('dial'), '1');
    assert.equal(url.href.split('#')[0].includes('9995554433'), false);
  }
});

test('base query and hash never leak to the public phone page and nested directories remain intact', () => {
  for (const base of ['https://iam108.github.io/zamery-bot/?old=query#old-hash', 'https://iam108.github.io/zamery-bot?old=query#old-hash']) {
    const url = new URL(actions.callUrl(base, phone));
    assert.equal(url.pathname, '/zamery-bot/audit-call.html');
    assert.equal(url.search, '');
    assert.equal(url.href.includes('old'), false);
    assert.equal(new URLSearchParams(url.hash.slice(1)).has('dial'), false);
  }
  assert.equal(new URL(actions.callUrl('https://example.test/tools/phone/', phone)).pathname, '/tools/phone/audit-call.html');
  assert.equal(new URL(actions.callUrl('https://example.test/tools/phone', phone)).pathname, '/tools/phone/audit-call.html');
  assert.equal(new URL(actions.callUrl('https://example.test/tools/index.html?old=query#hash', phone)).pathname, '/tools/audit-call.html');
});

test('Telegram link is dispatched synchronously during the user gesture and never opens a second window', () => {
  const events = [];
  const telegram = { platform: 'ios', openLink(url, options) { events.push(['telegram', url, options]); } };
  const url = actions.routeUrl('Москва, Мясницкая, д. 15');
  events.push('gesture');
  assert.equal(actions.openExternal(url, telegram, () => { assert.fail('unexpected browser fallback'); }, nativeBridge()), true);
  events.push('returned');
  assert.deepEqual(events, ['gesture', ['telegram', url, { try_instant_view: false }], 'returned']);
});

test('browser fallback keeps the report window separate and clears opener', () => {
  for (const telegram of [null, { platform: 'unknown', openLink() { assert.fail('not inside Telegram'); } }, { platform: 'ios' }]) {
    const calls = [], external = { opener: 'report' };
    assert.equal(actions.openExternal('https://example.test', telegram, (...args) => { calls.push(args); return external; }), true);
    assert.deepEqual(calls, [['https://example.test', '_blank']]);
    assert.equal(external.opener, null);
  }
});

test('a cached Telegram platform without a native bridge cannot silently swallow an external link', () => {
  const environment = {};
  environment.parent = environment;
  const telegram = { platform:'macos', initData:'cached data', openLink(){ assert.fail('There is no actual native bridge'); } };
  const calls = [], external = {};
  assert.equal(actions.hasTelegramBridge(environment), false);
  assert.equal(actions.openExternal('https://example.test', telegram, (...args) => {calls.push(args);return external;}, environment), true);
  assert.deepEqual(calls, [['https://example.test','_blank']]);
});

test('only the SDK-supported proxy, notify, or actual iframe channels count as Telegram bridges', () => {
  assert.equal(actions.hasTelegramBridge(nativeBridge()), true);
  assert.equal(actions.hasTelegramBridge({external:{notify(){}}}), true);
  assert.equal(actions.hasTelegramBridge({parent:{postMessage(){}}}), true);
  assert.equal(actions.hasTelegramBridge({TelegramWebviewProxy:{}}), false);
  assert.equal(actions.hasTelegramBridge({external:{notify:'not a function'}}), false);
  const unavailable = {};
  Object.defineProperty(unavailable, 'parent', {get(){throw new Error('blocked');}});
  assert.equal(actions.hasTelegramBridge(unavailable), false);
});

test('unsupported Telegram bridge falls back; blocked or throwing browser windows report failure', () => {
  let attempts = 0;
  const telegram = { platform: 'android', openLink() { attempts++; throw new Error('unsupported bridge'); } };
  const external = {};
  assert.equal(actions.openExternal('https://example.test', telegram, () => external, nativeBridge()), true);
  assert.equal(attempts, 1);
  assert.equal(actions.openExternal('https://example.test', telegram, () => null, nativeBridge()), false);
  assert.equal(actions.openExternal('https://example.test', null, () => { throw new Error('popup blocked'); }), false);
});

test('unapproved URL schemes never reach Telegram or the browser window', () => {
  const telegram = { platform: 'ios', openLink() { assert.fail('unsafe Telegram link'); } };
  for (const value of ['javascript:alert(1)', 'tel:' + phone, 'data:text/html,test', 'file:///tmp/test', '//example.test', '']) {
    assert.equal(actions.openExternal(value, telegram, () => { assert.fail('unsafe browser link'); }), false, value);
  }
});
