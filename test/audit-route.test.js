'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../public/audit-route');

function createDocument(options = {}) {
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.events = {}; this.value = ''; this.className = ''; this.disabled = false; this.textContent = ''; this.isConnected = false; }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = v; if (k === 'class') this.className = v; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
    connect(value) { this.isConnected = value; this.children.forEach(child => child.connect(value)); }
    appendChild(child) { this.children.push(child); child.parentNode = this; child.connect(this.isConnected); return child; }
    replaceChildren(...children) { this.children.forEach(child => child.connect(false)); this.children = []; children.forEach(child => this.appendChild(child)); }
    addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
    emit(k, event = {}) { for (const fn of this.events[k] || []) fn({ target: this, preventDefault() {}, ...event }); }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    remove() { this.connect(false); if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
  }
  const document = { body: new Node('body'), createElement: tag => { const n = new Node(tag); if (options.noModal && tag === 'dialog') n.showModal = undefined; return n; }, getElementById: id => document.body.descendants().find(n => n.id === id) || null };
  document.body.isConnected = true;
  return document;
}
function harness(options = {}) {
  const document = createDocument(options);
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

function preparedHarness(options = {}) {
  const document = createDocument(options), calls = [], built = [];
  const draft = { inspection: { address: 'Москва, Мясницкая, 15' }, plan: {annotations:[{id:'keep-me'}]} }, before = JSON.stringify(draft);
  let requests = 0;
  const point = {latitude:55.763022,longitude:37.634874};
  const loader = options.load || (async () => ({status:'ok',point,label:'Москва, Мясницкая улица, 15'}));
  const actions = {
    routeUrl(value) {
      assert.ok(route.locationPoint(value), 'Prepared routes must receive a numeric destination, never an address string or a starting point');
      built.push({...value});
      return 'https://yandex.ru/maps/?mode=routes&rtext=~' + value.latitude + ',' + value.longitude + '&rtt=auto';
    },
    searchUrl(address) { return 'https://yandex.ru/maps/?text=' + encodeURIComponent(address); }
  };
  const config = {document,address:draft.inspection.address,actions,draft,onBeforeLeave:()=>calls.push('save'),openExternal:url=>{calls.push(['open',url]);return true;},...options,load:()=>{requests++;return loader();}};
  delete config.noModal;
  const controller = route.prepare(config);
  const button = document.createElement('a'); button.textContent = 'Построить маршрут'; document.body.appendChild(button); controller.bind(button);
  const by = predicate => document.body.descendants().find(predicate);
  return {document,controller,config,button,point,draft,before,calls,built,by,get requests(){return requests;},
    dialog:()=>document.getElementById('route-preparation-dialog'),
    control:attribute=>by(n=>n.getAttribute(attribute)!==null),
    click(){let prevented=false;button.onclick({preventDefault(){prevented=true;}});return prevented;},
    buttonNamed:name=>by(n=>n.tagName==='BUTTON'&&n.textContent===name)};
}

test('prepared destination opens synchronously with one tap, no origin form or GPS prompt, and a cached lookup', async () => {
  const navigator={};Object.defineProperty(navigator,'geolocation',{get(){assert.fail('Destination preparation must never ask for the auditor location');}});
  const telegram={};Object.defineProperty(telegram,'LocationManager',{get(){assert.fail('No Telegram location request');}});
  const h=preparedHarness({navigator,telegram});await h.controller.ready;await h.controller.load();
  assert.equal(h.requests,1);assert.equal(h.dialog(),null);assert.match(h.button.getAttribute('href'),/~55\.763022,37\.634874/);
  h.calls.push('gesture');assert.equal(h.click(),true);h.calls.push('returned');
  assert.deepEqual(h.calls,['gesture','save',['open',h.button.getAttribute('href')],'returned']);
  assert.equal(h.dialog(),null);assert.equal(JSON.stringify(h.draft),h.before);h.controller.dispose();
});

test('an early tap shows only progress and resolving the destination never opens Maps automatically', async () => {
  let finish;const h=preparedHarness({load:()=>new Promise(resolve=>{finish=resolve;})});
  h.click();assert.ok(h.dialog());assert.equal(h.document.body.descendants().some(n=>n.tagName==='INPUT'),false);
  assert.match(h.by(n=>n.getAttribute('role')==='status').textContent,/Уточняю/);
  assert.equal(h.control('data-build-prepared-route').hidden,true);const first=h.controller.load();assert.equal(first,h.controller.ready);
  await Promise.resolve();assert.equal(h.requests,1);
  finish({status:'ok',point:h.point,label:'Объект'});await first;
  assert.deepEqual(h.calls,[]);assert.equal(h.control('data-build-prepared-route').hidden,false);
  h.control('data-build-prepared-route').onclick();assert.deepEqual(h.calls,['save',['open',h.button.getAttribute('href')]]);
  h.controller.dispose();
});

test('a failed lookup is cached, a deliberate retry is single-flight, and success still needs a user tap', async () => {
  let finish;let tries=0;
  const h=preparedHarness({load:()=>++tries===1?Promise.reject(new Error('Сервис временно недоступен')):new Promise(resolve=>{finish=resolve;})});
  await h.controller.ready;h.click();assert.match(h.by(n=>n.getAttribute('role')==='alert').textContent,/временно недоступен/);
  await h.controller.load();assert.equal(h.requests,1);
  const pending=h.controller.retry();assert.equal(h.controller.retry(),pending);assert.equal(h.control('data-retry-route').hidden,true);
  await Promise.resolve();assert.equal(h.requests,2);finish({status:'ok',point:h.point,label:'Нашёлся'});await pending;
  assert.deepEqual(h.calls,[]);h.click();assert.equal(h.calls.filter(c=>Array.isArray(c)&&c[0]==='open').length,1);
  h.controller.dispose();
});

test('ambiguous buildings require an explicit safe-text choice and retain safe Yandex attribution', async () => {
  const choice={latitude:55.766,longitude:37.639},label='<img src=x onerror=alert(1)> · корпус 2';
  const h=preparedHarness({load:async()=>({status:'needs_choice',candidates:[{label:'Основное здание',point:{latitude:55.763,longitude:37.634}},{label,point:choice},{label:'Недопустимое',point:{latitude:91,longitude:0}}],attribution:{label:'Яндекс Карты',url:'javascript:alert(1)'}})});
  await h.controller.ready;h.click();assert.equal(h.document.body.descendants().some(n=>n.tagName==='IMG'),false);assert.equal(h.buttonNamed('Недопустимое'),undefined);
  assert.equal(h.control('data-build-prepared-route').hidden,true);h.buttonNamed(label).onclick();
  assert.deepEqual(h.calls,[]);assert.match(h.button.getAttribute('href'),/~55\.766,37\.639/);
  assert.match(h.button.getAttribute('title'),/Яндекс Карты/);
  const attribution=h.by(n=>n.getAttribute('class')==='field-note route-attribution');
  assert.equal(attribution.getAttribute('href'),'https://yandex.ru/maps/');assert.equal(attribution.textContent,'Яндекс Карты');assert.equal(attribution.hidden,false);
  h.control('data-build-prepared-route').onclick();assert.deepEqual(h.built.at(-1),choice);assert.equal(JSON.stringify(h.draft),h.before);h.controller.dispose();
});

test('not found and invalid geocoder points offer an honest address search rather than a text route', async () => {
  for(const result of [{status:'not_found'},{status:'ok',point:{latitude:'55',longitude:37}},{status:'needs_choice',candidates:[{label:'invalid',point:{latitude:55,longitude:Infinity}}]}]){
    const h=preparedHarness({load:async()=>result});await h.controller.ready;h.click();
    assert.equal(h.built.length,0);assert.equal(h.control('data-build-prepared-route').hidden,true);
    const fallback=h.by(n=>n.tagName==='A'&&n.textContent==='Открыть адрес в Картах');let prevented=false;
    fallback.onclick({preventDefault(){prevented=true;}});assert.equal(prevented,false);
    assert.equal(fallback.getAttribute('href'),'https://yandex.ru/maps/?text='+encodeURIComponent(h.config.address));
    assert.deepEqual(h.calls,['save']);h.controller.dispose();
  }
});

test('an unconfigured Yandex address lookup clearly preserves manual Maps search and deliberate retry', async () => {
  for(const value of [Object.assign(new Error('Missing API key'),{code:'GEOCODER_CONFIG'}),Object.assign(new Error('HTTP 503'),{payload:{code:'GEOCODER_CONFIG'}}),new Error('Определение адреса не подключено. Откройте адрес в Картах.')]){
    const h=preparedHarness({load:async()=>{throw value;}});await h.controller.ready;h.click();
    assert.match(h.by(n=>n.getAttribute('role')==='alert').textContent,/Определение адреса не подключено/);
    assert.equal(h.control('data-build-prepared-route').hidden,true);assert.equal(h.control('data-retry-route').hidden,false);
    assert.deepEqual(h.calls,[]);assert.equal(h.built.length,0);
    const fallback=h.by(n=>n.tagName==='A'&&n.textContent==='Открыть адрес в Картах');
    const search='https://yandex.ru/maps/?text='+encodeURIComponent(h.config.address);
    assert.equal(fallback.getAttribute('href'),search);let prevented=false;fallback.onclick({preventDefault(){prevented=true;}});assert.equal(prevented,false);assert.deepEqual(h.calls,['save']);
    h.control('data-retry-route').onclick();await h.controller.load();assert.equal(h.requests,2);assert.match(h.by(n=>n.getAttribute('role')==='alert').textContent,/Определение адреса не подключено/);
    assert.equal(JSON.stringify(h.draft),h.before);h.controller.dispose();
  }
});

test('Yandex not-found guidance is shown as safe text and never changes a search into an unverified route', async () => {
  const message='Точный дом не найден. Проверьте номер строения. <img src=x onerror=alert(1)>';
  const h=preparedHarness({load:async()=>({status:'not_found',message,attribution:{label:'Яндекс Карты',url:'https://yandex.ru/maps/'}})});
  await h.controller.ready;h.click();assert.equal(h.by(n=>n.getAttribute('role')==='alert').textContent,message);
  assert.equal(h.document.body.descendants().some(n=>n.tagName==='IMG'),false);assert.equal(h.built.length,0);
  const attribution=h.by(n=>n.getAttribute('class')==='field-note route-attribution');assert.equal(attribution.textContent,'Яндекс Карты');assert.equal(attribution.getAttribute('href'),'https://yandex.ru/maps/');
  h.controller.dispose();
});

test('re-rendering binds the new link without updating detached nodes or running duplicate handlers', async () => {
  let finish;const h=preparedHarness({load:()=>new Promise(resolve=>{finish=resolve;})});await Promise.resolve();
  const old=h.button,oldHref=old.getAttribute('href');old.remove();
  const fresh=h.document.createElement('a');h.document.body.appendChild(fresh);const previousUnbind=h.controller.bind(fresh);const latestUnbind=h.controller.bind(fresh);
  previousUnbind();assert.equal(typeof fresh.onclick,'function','An old cleanup must not remove the newer binding');
  finish({status:'ok',point:h.point,label:'Новое отображение'});await h.controller.ready;
  assert.equal(old.getAttribute('href'),oldHref);assert.match(fresh.getAttribute('href'),/~55\.763022,37\.634874/);
  fresh.onclick({preventDefault(){}});assert.equal(h.calls.filter(c=>Array.isArray(c)&&c[0]==='open').length,1);
  latestUnbind();assert.equal(fresh.onclick,null);h.controller.dispose();
});

test('closing progress preserves background preparation while dispose cancels all late UI updates', async () => {
  let finish;const h=preparedHarness({load:()=>new Promise(resolve=>{finish=resolve;})});await Promise.resolve();h.click();h.dialog().emit('cancel');assert.equal(h.dialog(),null);
  finish({status:'ok',point:h.point,label:'Фоновая подготовка'});await h.controller.ready;assert.equal(h.dialog(),null);assert.deepEqual(h.calls,[]);h.click();assert.equal(h.calls.length,2);h.controller.dispose();
  let release;const disposed=preparedHarness({load:()=>new Promise(resolve=>{release=resolve;})});await Promise.resolve();disposed.click();const href=disposed.button.getAttribute('href');disposed.controller.dispose();
  release({status:'ok',point:disposed.point,label:'Поздний ответ'});await disposed.controller.ready;
  assert.equal(disposed.dialog(),null);assert.equal(disposed.button.onclick,null);assert.equal(disposed.button.getAttribute('href'),href);assert.deepEqual(disposed.calls,[]);
  await disposed.controller.retry();assert.equal(disposed.requests,1);
});

test('blocked Maps opening stays visible, retries the same destination and does not refetch the address', async () => {
  for(const fail of [()=>false,()=>{throw new Error('blocked');}]){
    const h=preparedHarness({openExternal:fail});await h.controller.ready;h.click();assert.ok(h.dialog());
    assert.match(h.by(n=>n.getAttribute('role')==='alert').textContent,/не открылись/);assert.equal(h.control('data-build-prepared-route').disabled,false);
    h.control('data-build-prepared-route').onclick();assert.equal(h.requests,1);assert.deepEqual(h.calls,['save','save']);h.controller.dispose();
  }
});

test('native address-search fallback survives a failed primary bridge without a second SDK attempt', async () => {
  for(const result of ['false','throw']){
    let attempts=0;
    const h=preparedHarness({openExternal:()=>{attempts++;if(result==='throw')throw new Error('bridge failed');return false;}});
    await h.controller.ready;h.click();assert.equal(attempts,1);assert.ok(h.dialog());
    const fallback=h.by(n=>n.tagName==='A'&&n.textContent==='Открыть адрес в Картах');
    assert.equal(fallback.getAttribute('href'),'https://yandex.ru/maps/?text='+encodeURIComponent(h.config.address));
    assert.equal(fallback.getAttribute('target'),'_blank');assert.equal(fallback.getAttribute('rel'),'noopener');
    let prevented=false;const returned=fallback.onclick({preventDefault(){prevented=true;}});
    assert.equal(returned,undefined);assert.equal(prevented,false,'A native anchor must be free to navigate even if the SDK failed');
    assert.equal(attempts,1,'Recovery must not retry the same broken external-link mechanism');
    assert.deepEqual(h.calls,['save','save']);assert.equal(JSON.stringify(h.draft),h.before);h.controller.dispose();
  }
});

test('fallback navigation is not delayed or canceled by an in-flight or failed report save', async () => {
  for(const mode of ['pending','throw']){
    let release,saveCalls=0;
    const saved=new Promise(resolve=>{release=resolve;});
    const h=preparedHarness({load:async()=>({status:'not_found'}),onBeforeLeave:()=>{saveCalls++;if(mode==='throw')throw new Error('save failed');return saved;},openExternal:()=>{assert.fail('Native recovery cannot call the SDK');}});
    await h.controller.ready;h.click();const fallback=h.by(n=>n.tagName==='A'&&n.textContent==='Открыть адрес в Картах');
    let prevented=false;const returned=fallback.onclick({preventDefault(){prevented=true;}});
    assert.equal(returned,undefined);assert.equal(prevented,false);assert.equal(saveCalls,1);assert.equal(JSON.stringify(h.draft),h.before);
    release();await saved;h.controller.dispose();
  }
});

test('missing destination makes no lookup and a browser without showModal still has a closeable progress dialog', async () => {
  const h=preparedHarness({address:'',noModal:true});await h.controller.ready;h.click();assert.equal(h.requests,0);
  assert.match(h.by(n=>n.getAttribute('role')==='alert').textContent,/нет адреса/);assert.equal(h.dialog().getAttribute('open'),'');
  assert.equal(h.dialog().getAttribute('aria-modal'),'true');h.buttonNamed('Закрыть').onclick();assert.equal(h.dialog(),null);assert.deepEqual(h.calls,[]);h.controller.dispose();
});
