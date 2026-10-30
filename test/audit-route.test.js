'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../public/audit-route');

function harness(options = {}) {
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.events = {}; this.value = ''; this.className = ''; this.disabled = false; this.textContent = ''; this.isConnected = false; }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = v; if (k === 'class') this.className = v; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(child) { this.children.push(child); child.parentNode = this; child.isConnected = true; return child; }
    addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
    emit(k, event = {}) { for (const fn of this.events[k] || []) fn({ target: this, preventDefault() {}, ...event }); }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
  }
  const document = { body: new Node('body'), createElement: tag => { const n = new Node(tag); if (options.noModal && tag === 'dialog') n.showModal = undefined; return n; }, getElementById: id => document.body.descendants().find(n => n.id === id) || null };
  document.body.isConnected = true;
  const calls = [], built = [], originalDraft = { inspection: { address: 'Москва, объект' }, annotations: [{ id: 'saved-1' }] };
  const before = JSON.stringify(originalDraft);
  const actions = { routeAddress: address => String(address || '').trim(), routeUrl: (address, origin) => { built.push({ address, origin }); return origin ? 'https://yandex.ru/maps/?prepared=1' : 'https://yandex.ru/maps/?choose-start=1'; } };
  const config = { document, address: 'Москва, объект', actions, navigator: {}, draft: originalDraft, onBeforeLeave: () => calls.push('save'), openExternal: url => { calls.push(['open', url]); return true; }, ...options };
  delete config.noModal;
  const controller = route.open(config);
  const by = predicate => document.body.descendants().find(predicate);
  return { document, controller, config, calls, built, originalDraft, before, by,
    primary: by(n => n.getAttribute('data-build-route') !== null), input: by(n => n.id === 'route-origin'), location: by(n => n.getAttribute('data-route-location') !== null), status: by(n => n.getAttribute('role') === 'status'), fallback: by(n => n.tagName === 'A'),
    button: name => by(n => n.tagName === 'BUTTON' && n.textContent === name) };
}

test('location validation rejects malformed coordinates while retaining the equator and date line', () => {
  assert.deepEqual(route.locationPoint({ latitude: 0, longitude: -180, horizontal_accuracy: 25 }), { latitude: 0, longitude: -180 });
  for (const value of [null, {}, { latitude: null, longitude: 0 }, { latitude: '55.7', longitude: 37.6 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: NaN, longitude: 0 }]) assert.equal(route.locationPoint(value), null);
});

test('Telegram location is requested only after initialization and bypasses browser prompts when supported', async () => {
  const order = [], telegram = { version: '8.0', LocationManager: { isLocationAvailable: true, init(done) { order.push('init'); done(); }, getLocation(done) { order.push('get'); done({ latitude: 55.7, longitude: 37.6 }); } } };
  const point = await route.requestLocation({ telegram, navigator: { geolocation: { getCurrentPosition() { assert.fail('No duplicate browser permission prompt'); } } } });
  assert.deepEqual(order, ['init', 'get']); assert.deepEqual(point, { latitude: 55.7, longitude: 37.6 });
});

test('old or unavailable Telegram location falls back to bounded browser geolocation', async () => {
  for (const telegram of [null, { version: '7.9', LocationManager: { init() { assert.fail('Unsupported Telegram version'); }, getLocation() {} } }, { version: '8.0', LocationManager: { isLocationAvailable: false, init(done) { done(); }, getLocation() { assert.fail('Unavailable Telegram location'); } } }]) {
    let settings;
    const point = await route.requestLocation({ telegram, navigator: { geolocation: { getCurrentPosition(done, fail, options) { settings = options; done({ coords: { latitude: 0, longitude: 0 } }); } } } });
    assert.deepEqual(point, { latitude: 0, longitude: 0 }); assert.deepEqual(settings, { enableHighAccuracy: false, maximumAge: 0, timeout: 10000 });
  }
});

test('denial never silently asks a second provider; missing and corrupt GPS data fail clearly', async () => {
  const telegram = { isVersionAtLeast: () => true, LocationManager: { isLocationAvailable: true, init(done) { done(); }, getLocation(done) { done(null); } } };
  await assert.rejects(route.requestLocation({ telegram, navigator: { geolocation: { getCurrentPosition() { assert.fail('Denied permission is final for this attempt'); } } } }), error => error.code === 'denied');
  await assert.rejects(route.requestLocation({ navigator: {} }), error => error.code === 'unavailable');
  await assert.rejects(route.requestLocation({ navigator: { geolocation: { getCurrentPosition(done) { done({ coords: { latitude: 100, longitude: 0 } }); } } } }), error => error.code === 'invalid');
});

test('a nonresponding location provider times out and does not block retry forever', async () => {
  await assert.rejects(route.requestLocation({ locationTimeout: 10, navigator: { geolocation: { getCurrentPosition() {} } } }), error => error.code === 'timeout');
});

test('opening the route asks for no permission and keeps build disabled until an origin is supplied', () => {
  let requests = 0;
  const h = harness({ address: '<img src=x onerror=alert(1)>', navigator: { geolocation: { getCurrentPosition() { requests++; } } } });
  assert.equal(requests, 0); assert.equal(h.primary.disabled, true); assert.equal(h.fallback.getAttribute('href'), 'https://yandex.ru/maps/?choose-start=1');
  assert.ok(h.controller.dialog.descendants().some(n => n.textContent === '<img src=x onerror=alert(1)>'));
  assert.ok(!h.controller.dialog.descendants().some(n => n.tagName === 'IMG'));
  h.primary.onclick(); assert.deepEqual(h.calls, []);
  h.controller.close();
});

test('typed origin dispatches synchronously on the click and does not edit the report', () => {
  const h = harness(); h.input.value = '  Москва, Лубянская площадь  '; h.input.oninput(); assert.equal(h.primary.disabled, false);
  h.calls.push('gesture'); h.primary.onclick(); h.calls.push('returned');
  assert.deepEqual(h.built.at(-1), { address: 'Москва, объект', origin: 'Москва, Лубянская площадь' });
  assert.deepEqual(h.calls, ['gesture', 'save', ['open', 'https://yandex.ru/maps/?prepared=1'], 'returned']);
  assert.equal(JSON.stringify(h.originalDraft), h.before); h.controller.close();
});

test('asynchronous GPS only prepares a route; opening requires a subsequent explicit click', async () => {
  let finish;
  const h = harness({ navigator: { geolocation: { getCurrentPosition(done) { finish = done; } } } });
  const pending = h.location.onclick(); assert.equal(h.primary.disabled, true); assert.equal(h.location.disabled, true); assert.deepEqual(h.calls, []);
  finish({ coords: { latitude: 55.7, longitude: 37.6 } }); await pending;
  assert.deepEqual(h.calls, []); assert.equal(h.primary.disabled, false); assert.equal(h.input.value, 'Моё местоположение');
  assert.equal(JSON.stringify(h.originalDraft), h.before, 'GPS must never be copied into the draft');
  h.primary.onclick(); assert.deepEqual(h.built.at(-1).origin, { latitude: 55.7, longitude: 37.6 });
  assert.equal(h.location.disabled, false); h.controller.close();
});

test('denied GPS stays visible and allows manual recovery without reporting an opened route', async () => {
  const h = harness({ navigator: { geolocation: { getCurrentPosition(done, fail) { fail({ code: 1 }); } } } });
  await h.location.onclick(); assert.equal(h.primary.disabled, true); assert.equal(h.location.disabled, false); assert.match(h.status.textContent, /не разрешён/); assert.deepEqual(h.calls, []);
  h.input.value = 'Москва, другая улица'; h.input.oninput(); h.primary.onclick(); assert.equal(h.calls.filter(c => Array.isArray(c) && c[0] === 'open').length, 1); h.controller.close();
});

test('late GPS cannot overwrite an address typed during the request or reopen a closed dialog', async () => {
  let finish;
  const h = harness({ navigator: { geolocation: { getCurrentPosition(done) { finish = done; } } } });
  let pending = h.location.onclick(); h.input.value = 'От офиса'; h.input.oninput(); finish({ coords: { latitude: 55, longitude: 37 } }); await pending;
  assert.equal(h.input.value, 'От офиса'); h.primary.onclick(); assert.equal(h.built.at(-1).origin, 'От офиса');
  pending = h.location.onclick(); h.controller.close(); finish({ coords: { latitude: 54, longitude: 36 } }); await pending;
  assert.equal(h.controller.dialog.isConnected, false); assert.equal(h.calls.filter(c => Array.isArray(c) && c[0] === 'open').length, 1);
});

test('explicit Maps fallback works without an origin; opening failures remain visible', () => {
  const h = harness({ openExternal: () => false }); let prevented = false;
  h.fallback.onclick({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(h.built.at(-1).origin, undefined); assert.match(h.status.textContent, /не открылись/);
  assert.deepEqual(h.calls, ['save']); h.controller.close();
});

test('missing address cannot open any route, while Escape, close and nonmodal fallback remain usable', () => {
  const h = harness({ address: '', noModal: true }); assert.equal(h.primary.disabled, true); assert.equal(h.location.disabled, true); assert.equal(h.fallback.getAttribute('href'), null); assert.match(h.status.textContent, /нет адреса/);
  assert.equal(h.controller.dialog.getAttribute('open'), ''); assert.equal(h.controller.dialog.getAttribute('aria-modal'), 'true');
  assert.equal(route.open(h.config), h.controller, 'Repeated taps reuse the same visible dialog');
  h.controller.dialog.emit('cancel'); assert.equal(h.document.getElementById('route-dialog'), null); assert.deepEqual(h.calls, []);
  const fresh = harness(); fresh.button('Закрыть').onclick(); assert.equal(fresh.document.getElementById('route-dialog'), null);
});
