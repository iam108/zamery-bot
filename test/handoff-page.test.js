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
function emptyPacket(requestId) {
  return {ok:true,signature:'e'.repeat(64),order:null,report:null,request:requestId?{id:Number(requestId),text:'Saved source request',created_at:'2026-11-02T10:00:00Z'}:null,materials:[],egrn_links:[],egrn:{status:'missing'},archive_url:'',assignment:null};
}
function unboundPrefill(id=9){return{ok:true,order:null,report:null,lawyers:[{tg_id:108,name:'Елена'}],request:{id,text:'Saved request',f:{org:'ООО Пример',address:'Москва, Тестовая, 1',kind:'Общепит',region:'МСК',service:'Получение',client:'Анна',phone:'+79991234567'}}};}
function harness(options = {}) {
  const nodes = new Map(), calls = [], stored = new Map(Object.entries(options.stored || {})), persistent = new Map(Object.entries(options.persistent || {})), events = new Map(), revoked = [], created = [];
  const timers=new Map();let now=0,timerId=0;
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
  let packetRequests = 0, sourcePacketRequests=0,postRequests = 0;
  async function fetch(url, init = {}) {
    calls.push(['fetch', url, init]);
    if(options.fetch){const custom=options.fetch(url,init,response);if(custom!==undefined)return custom;}
    if (url.startsWith('/api/handoff/prefill')) return response(options.prefill || responses.prefill);
    if (url.startsWith('/api/handoff/manual-matches')) return response({ok:true,matches:options.matches||[],has_more:options.hasMore===true});
    if (url.startsWith('/api/handoff/manual-materials')) return response({ok:true,files:options.manualFiles||[],limits:{files:20,fileBytes:12582912,totalBytes:104857600}});
    if (/^\/api\/handoff\/cases\/\d+\/documents$/.test(url)) return response({ok:true,case_id:Number(url.split('/')[4]),batches:[],files:[]});
    if (url.startsWith('/api/handoff/packet')) {
      packetRequests++;const query=new URL(url,'https://bot.example').searchParams;
      if(!query.get('order_id')&&!query.get('report_id'))return options.emptyPacketFetch?options.emptyPacketFetch(url,response):response(emptyPacket(query.get('request_id')));
      sourcePacketRequests++;if(options.packetFetch)return options.packetFetch(url,sourcePacketRequests,response);if(options.packetError&&sourcePacketRequests===1)throw new Error('Сеть недоступна');
      return response({...responses.packet,...(query.get('request_id')?{request:emptyPacket(query.get('request_id')).request}:{})});
    }
    if (url === '/api/handoff' && init.method === 'POST') { postRequests++; if (options.post) return options.post(postRequests, JSON.parse(init.body),init); return response({ ok: true, id: 75, delivery_complete: true }); }
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
  const window = { HandoffDocuments: page.documents, HandoffModel: page.model(), crypto: { randomUUID: require('node:crypto').randomUUID }, addEventListener: (name, fn) => events.set(name, fn), matchMedia: () => ({ matches: false }) };
  const location = { search: options.query || '?order_id=60', origin: 'https://bot.example', href: 'https://bot.example/handoff' + (options.query || '?order_id=60') };
  const context = { window, document, location, history, fetch, URL: TestURL, URLSearchParams, AbortController, FormData, sessionStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value),removeItem:key=>stored.delete(key) },localStorage:{getItem:key=>persistent.get(key)||null,setItem:(key,value)=>persistent.set(key,value),removeItem:key=>persistent.delete(key)}, setTimeout: (fn, ms) => { if(options.virtualClock){const id=++timerId;timers.set(id,{fn,at:now+ms});return id;}const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout:id=>{if(options.virtualClock)timers.delete(id);else clearTimeout(id);}, Date, Math, console };
  vm.createContext(context); vm.runInContext('(' + page.client.toString() + ')();', context);
  return { context, node, nodes, calls, stored,persistent, events, revoked, created, responses, response,timers,async tick(ms){const target=now+ms;for(;;){const next=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await pause();}now=target;await pause();}, postRequests: () => postRequests, packetRequests: () => packetRequests, cached: () => JSON.parse(stored.get('handoff-v2:staff:order-60') || 'null') };
}
function lawyer(h) { h.node('lawyers').value = '108'; h.node('lawyers').onchange(); }

test('the existing lawyer selector shows assigned workload including zero while review retains the plain recipient name',async()=>{
  const h=harness({prefill:{ok:true,lawyers:[{tg_id:108,name:'Елена',active_cases:3},{tg_id:109,name:'Мария',active_cases:0}],report:{src:'a',id:15},order:{id:60}}});await pause();
  assert.match(h.node('lawyers').innerHTML,/Елена · 3 в работе/);assert.match(h.node('lawyers').innerHTML,/Мария · 0 в работе/);
  lawyer(h);assert.equal(h.node('go').textContent,'Передать · Елена');h.node('go').click();assert.equal(h.node('review-lawyer').textContent,'Елена');
});

test('a private readonly lawyer payload without workload does not invent a zero count',async()=>{
  const h=harness({query:'?order_id=60&view=report',prefill:{ok:true,lawyers:[{tg_id:108,name:'Елена'}],report:{src:'a',id:15},order:{id:60}}});await pause();
  assert.doesNotMatch(h.node('lawyers').innerHTML,/в работе/);assert.equal(h.node('assignment').hidden,true);
});

for(const contacts of [[],[{name:'',phone:'',tg:'',comment:'Контакт пока не предоставлен'}]])test('order-bound confirmation requires a usable client contact before opening review: '+JSON.stringify(contacts),async()=>{
  const p=packet();p.order.contacts=contacts;const h=harness({packet:p});await pause();lawyer(h);h.node('go').click();
  assert.equal(h.node('review').hidden,true);assert.match(h.node('form-error').textContent,/контакт/i);assert.equal(h.node('details').open,true);
  h.node('confirm-send').click();await pause();assert.equal(h.postRequests(),0);
});

test('phone-only and Telegram-only client contacts remain valid for an order-bound handoff',async()=>{
  for(const contact of [{phone:'+79991234567'},{tg:'@synthetic_client'}]){
    const p=packet();p.order.contacts=[contact];const h=harness({packet:p});await pause();lawyer(h);h.node('go').click();
    assert.equal(h.node('review').hidden,false);assert.equal(h.node('form-error').textContent,'');
  }
});

test('a failed known-order report packet stays blocked and retry retains V2 order and original-file identity',async()=>{
  const bodies=[],h=harness({query:'?request_id=9',prefill:{ok:true,lawyers:[{tg_id:108,name:'Елена'}],request:{f:{org:'ООО Пример',address:'Москва, Тестовая, 1',kind:'Общепит',region:'МСК',service:'Получение',client:'Карина',phone:'+79991234567'}}},packetError:true,
    searchItems:[{src:'a',id:15,order_id:60,text:'Saved report for source order'}],post:async(n,body)=>{bodies.push(body);return h.response({ok:true,id:75,delivery_complete:true});}});
  await pause();h.node('choose-report').click();await pause();h.node('search-results').children[0].click();await pause();
  assert.equal(h.node('packet-error').hidden,false);assert.equal(h.node('go').disabled,true);assert.equal(h.calls.some(call=>call[0]==='fetch'&&call[1].startsWith('/api/reports/get')),false);
  h.node('confirm-send').click();await pause();assert.equal(h.postRequests(),0);
  h.node('retry-load').click();await pause();assert.equal(h.node('packet-error').hidden,true);lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();
  assert.equal(bodies.length,1);assert.equal(bodies[0].handoff_version,2);assert.equal(bodies[0].order_id,60);assert.equal(bodies[0].report_id,15);assert.equal(bodies[0].packet_signature,packet().signature);
  const urls=h.calls.filter(call=>call[0]==='fetch'&&call[1].startsWith('/api/handoff/packet')).map(call=>new URL(call[1],'https://bot.example')).filter(url=>url.searchParams.has('report_id'));
  assert.equal(urls.length,2);assert.ok(urls.every(url=>url.searchParams.get('order_id')==='60'&&url.searchParams.get('report_id')==='15'));
});

for (const failure of ['network', '500']) test('report search without an order hint never downgrades a '+failure+' packet failure to a legacy send', async () => {
  const h=harness({query:'?request_id=9',prefill:{ok:true,lawyers:[{tg_id:108,name:'Елена'}],request:{f:{org:'ООО Пример',address:'Москва, Тестовая, 1',kind:'Общепит',region:'МСК',service:'Получение',client:'Карина'}}},searchItems:[{src:'a',id:15}],
    packetFetch:async(url,n,response)=>{if(n===1){if(failure==='network')throw new Error('Сеть недоступна');return{ok:false,status:500,json:async()=>({ok:false,error:'Комплект временно недоступен'})};}return response(packet());}});
  await pause();h.node('choose-report').click();await pause();h.node('search-results').children[0].click();await pause();
  assert.equal(h.calls.some(call=>call[0]==='fetch'&&call[1].startsWith('/api/reports/get')),false);
  assert.equal(h.node('packet-error').hidden,false);assert.equal(h.node('go').disabled,true);
  h.node('retry-load').click();await pause();assert.equal(h.node('packet-error').hidden,true);lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();
  const body=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.equal(body.order_id,60);assert.equal(body.report_id,15);assert.equal(body.handoff_version,2);
  const urls=h.calls.filter(call=>call[0]==='fetch'&&call[1].startsWith('/api/handoff/packet')).map(call=>new URL(call[1],'https://bot.example')).filter(url=>url.searchParams.has('report_id'));
  assert.equal(urls.length,2);assert.ok(urls.every(url=>url.searchParams.get('report_id')==='15'));
});

test('a successful packet explicitly without an order keeps a legacy report available', async () => {
  const p=packet();p.order=null;p.report={...p.report,id:21,src:'r',media:[]};p.materials=[];
  const h=harness({query:'?request_id=9',packet:p,prefill:{ok:true,lawyers:[{tg_id:108,name:'Елена'}],request:{f:{org:'ООО Пример',address:'Москва, Тестовая, 1',kind:'Общепит',region:'МСК',service:'Получение',client:'Карина'}}},searchItems:[{src:'r',id:21}]});
  await pause();h.node('choose-report').click();await pause();h.node('search-results').children[0].click();await pause();lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();
  const body=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.equal(body.order_id,null);assert.equal(body.report_id,21);assert.equal(body.report_src,'r');assert.equal(body.handoff_version,2);assert.match(body.submit_id,/^[a-f\d-]{36}$/);assert.equal(body.packet_signature,p.signature);assert.equal(body.request_id,9);
});

test('a no-order request freezes one V2 identity across double click, lost response, reopen and retry',async()=>{
  const bodies=[];let reject;const first=harness({query:'?request_id=9',prefill:unboundPrefill(),post:(_,body)=>{bodies.push(body);return new Promise((resolve,no)=>{reject=no;});}});
  await pause();lawyer(first);first.node('go').click();first.node('confirm-send').click();first.node('confirm-send').click();await pause();assert.equal(bodies.length,1);
  const body=bodies[0];assert.equal(body.order_id,null);assert.equal(body.report_id,null);assert.equal(body.report_src,null);assert.equal(body.handoff_version,2);assert.match(body.submit_id,/^[a-f\d-]{36}$/);assert.equal(body.packet_signature,emptyPacket(9).signature);assert.equal(body.request_id,9);
  reject(new Error('Synthetic lost HTTP acknowledgement'));await pause();assert.equal(first.node('retry-send').hidden,false);
  const saved=JSON.parse(first.stored.get('handoff-v2:staff:request-9'));assert.deepEqual(saved.pending.payload,body);
  const reopened=harness({query:'?request_id=9',prefill:unboundPrefill(),stored:Object.fromEntries(first.stored),post:async(_,payload)=>{bodies.push(payload);return reopened.response({ok:true,id:75,delivery_complete:true});}});await pause();
  reopened.node('retry-send').click();await pause();assert.equal(bodies.length,2);assert.deepEqual(bodies[1],body);assert.equal(reopened.node('retry-send').hidden,true);assert.match(reopened.node('delivery-title').textContent,/Передано/);
});

test('a no-order request packet failure stays blocked until its same source request is loaded successfully',async()=>{
  let fails=true;const h=harness({query:'?request_id=9',prefill:unboundPrefill(),emptyPacketFetch(url,response){if(fails)throw new Error('Source request unavailable');return response(emptyPacket(9));}});await pause();
  assert.equal(h.node('packet-error').hidden,false);lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();assert.equal(h.postRequests(),0);
  fails=false;h.node('retry-load').click();await pause();assert.equal(h.node('packet-error').hidden,true);lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();
  const sent=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.equal(sent.handoff_version,2);assert.equal(sent.request_id,9);assert.equal(sent.packet_signature,emptyPacket(9).signature);assert.ok(h.calls.filter(call=>call[1].startsWith('/api/handoff/packet')).every(call=>new URL(call[1],'https://bot.example').searchParams.get('request_id')==='9'));
});

test('a no-order readonly report forwards its case identity through prefill and every selected packet request',async()=>{
  const p=packet();p.order=null;p.materials=[];p.report={...p.report,id:15,src:'a',order_id:null};p.report.media=p.report.media.map(file=>({...file,url:file.url+'?case_id=75'}));
  const h=harness({query:'?case_id=75&report_src=a&report_id=15&view=report',packet:p,prefill:{ok:true,order:{org:'Saved case',address:'Saved address',kind:'Общепит',service:'Получение',contacts:[]},report:{src:'a',id:15},lawyers:[{tg_id:108,name:'Елена'}]}});await pause();
  assert.equal(h.node('report-dialog').open,true);assert.equal(h.node('assignment').hidden,true);assert.equal(h.node('footer').hidden,true);assert.equal(h.node('org').value,'Saved case');
  const urls=h.calls.filter(call=>call[1].startsWith('/api/handoff/prefill')||call[1].startsWith('/api/handoff/packet')).map(call=>new URL(call[1],'https://bot.example'));assert.ok(urls.length>=2);assert.ok(urls.every(url=>url.searchParams.get('case_id')==='75'));
  assert.ok(urls.filter(url=>url.pathname.endsWith('/packet')).every(url=>url.searchParams.get('report_id')==='15'&&url.searchParams.get('report_src')==='a'));
  h.node('confirm-send').click();h.node('retry-send').click();await pause();assert.equal(h.postRequests(),0);assert.ok(h.calls.filter(call=>call[1].startsWith('/api/handoff/reports/')).every(call=>new URL(call[1],'https://bot.example').searchParams.get('case_id')==='75'));
});

function unlinkedPacket(id){const p=packet();p.order=null;p.materials=[];p.signature='unlinked-report-'+id;p.report={...p.report,id,src:'a',text:'Unlinked report '+id,media:[]};return p;}
for(const sameSource of [false,true])test('reopening a completed no-order handoff '+(sameSource?'keeps the exact source completed':'allows an explicitly different reviewed report'),async()=>{
  const first=harness({query:'?request_id=9&report_src=a&report_id=15',prefill:unboundPrefill(),packet:unlinkedPacket(15)});await pause();lawyer(first);
  first.node('org').listeners.change.call({value:'Saved A edited profile'});first.node('go').click();first.node('confirm-send').click();await pause();
  const sent=JSON.parse(first.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.equal(sent.report_id,15);assert.match(first.node('delivery-title').textContent,/Передано/);
  const id=sameSource?15:16,h=harness({query:'?request_id=9&report_src=a&report_id='+id,prefill:unboundPrefill(),packet:unlinkedPacket(id),stored:Object.fromEntries(first.stored)});await pause();
  if(sameSource){assert.match(h.node('delivery-title').textContent,/Передано/);assert.equal(h.node('org').value,'Saved A edited profile');h.node('go').click();h.node('confirm-send').click();await pause();assert.equal(h.postRequests(),0);}
  else{assert.equal(h.node('delivery').hidden,true);assert.equal(h.node('go').disabled,false);assert.equal(h.node('org').value,'ООО Пример');h.node('go').click();h.node('confirm-send').click();await pause();const body=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.equal(body.report_id,16);assert.equal(body.packet_signature,unlinkedPacket(16).signature);assert.notEqual(body.submit_id,sent.submit_id);}
});
test('a different no-order report never discards an unknown frozen pending body',async()=>{
  const first=harness({query:'?request_id=9&report_src=a&report_id=15',prefill:unboundPrefill(),packet:unlinkedPacket(15),post:()=>{throw new Error('Lost acknowledgement');}});await pause();lawyer(first);first.node('go').click();first.node('confirm-send').click();await pause();
  const body=JSON.parse(first.calls.find(call=>call[1]==='/api/handoff')[2].body),h=harness({query:'?request_id=9&report_src=a&report_id=16',prefill:unboundPrefill(),packet:unlinkedPacket(16),stored:Object.fromEntries(first.stored)});await pause();
  assert.equal(h.node('retry-send').hidden,false);h.node('retry-send').click();await pause();assert.deepEqual(JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body),body);
});

for(const phase of ['headers','body'])test('handoff '+phase+' timeout releases sending, ignores late success and retries the exact frozen intent',async()=>{
  let release,signal;const bodies=[],h=harness({virtualClock:true,post(n,body,init){bodies.push(body);if(n!==1)return h.response({ok:true,id:75,delivery_complete:true});signal=init.signal;const held=new Promise(resolve=>{release=resolve;});return phase==='headers'?held:{ok:true,status:200,json:()=>held};}});await pause();lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();
  assert.equal(h.node('confirm-send').disabled,true);await h.tick(120000);assert.equal(h.node('confirm-send').disabled,false);assert.equal(h.node('retry-send').hidden,false);assert.match(h.node('delivery-text').textContent,/не подтверждена/i);assert.equal(signal.aborted,true);
  release(phase==='headers'?h.response({ok:true,id:999,delivery_complete:true}):{ok:true,id:999,delivery_complete:true});await pause();assert.doesNotMatch(h.node('delivery-title').textContent,/Передано/);
  h.node('retry-send').click();await pause();assert.equal(bodies.length,2);assert.deepEqual(bodies[1],bodies[0]);assert.match(h.node('delivery-title').textContent,/Передано/);assert.equal(h.timers.size,0);
});
for(const phase of ['headers','body'])test('a stalled packet '+phase+' reaches a bounded visible load error and can be retried',async()=>{
  let release,signal,reads=0;const h=harness({virtualClock:true,fetch(url,init,response){if(!url.startsWith('/api/handoff/packet'))return;reads++;if(reads>1)return response(packet());signal=init.signal;const held=new Promise(resolve=>{release=resolve;});return phase==='headers'?held:{ok:true,status:200,json:()=>held};}});await pause();assert.equal(h.node('go').disabled,true);
  await h.tick(30000);assert.equal(h.node('packet-error').hidden,false);assert.equal(signal.aborted,true);h.node('retry-load').click();await pause();assert.equal(h.node('packet-error').hidden,true);assert.equal(h.node('address').value,packet().order.address);
  const stale=packet();stale.order.address='Late stale data';release(phase==='headers'?h.response(stale):stale);await pause();assert.equal(h.node('address').value,packet().order.address);assert.equal(h.timers.size,0);
});

for(const olderFails of [false,true]) test('a late '+(olderFails?'failed':'successful')+' packet cannot replace the latest chosen report',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const h=harness({searchItems:[{src:'a',id:16,order_id:60},{src:'a',id:17,order_id:60}],packetFetch:async(url,n,response)=>{const id=Number(new URL(url,'https://bot.example').searchParams.get('report_id'));if(id===16){await gate;if(olderFails)throw new Error('Older request failed');}const p=packet();if(id){p.report.id=id;p.report.text='Report '+id;p.signature='snapshot-'+id;}return response(p);}});
  await pause();h.node('choose-report').click();await pause();h.node('search-results').children[0].click();await pause();h.node('search-results').children[1].click();await pause();
  h.node('open-report').click();assert.equal(h.node('report-text').textContent,'Report 17');h.node('report-close').click();release();await pause();
  h.node('open-report').click();assert.equal(h.node('report-text').textContent,'Report 17');h.node('report-close').click();assert.equal(h.node('packet-error').hidden,true);assert.equal(h.node('go').disabled,false);
  lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();const body=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.equal(body.report_id,17);assert.equal(body.packet_signature,'snapshot-17');
});

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

for(const reportHasOrder of [true,false])test('manager edits survive selecting an audit that binds an order, report metadata order='+reportHasOrder,async()=>{
  const wanted='ООО «Компания менеджера»',address='Москва, Исправленный адрес, 7';
  const h=harness({query:'?new=1',prefill:{ok:true,lawyers:[{tg_id:108,name:'Елена'}],report:null,order:null},searchItems:[{id:15,src:'a',...(reportHasOrder?{order_id:60}:{}),metadata:{org:'Бренд из заявки'},text:'Сохранённый отчёт'}]});
  await pause();
  for(const [key,value] of Object.entries({org:wanted,address})){h.node(key).value=value;h.node(key).listeners.change.call(h.node(key));}
  h.node('choose-report').click();await pause();h.node('search-results').children[0].click();await pause();
  assert.equal(h.node('org').value,wanted);assert.equal(h.node('address').value,address);
  lawyer(h);h.node('go').click();assert.equal(h.node('review-org').textContent,wanted);h.node('confirm-send').click();await pause();
  const body=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.equal(body.org,wanted);assert.equal(body.address,address);assert.equal(body.order_id,60);assert.equal(body.report_id,15);
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
  assert.equal(h.node('materials-state').textContent,'Документы заявки · 0 файлов');assert.equal(h.node('open-report').disabled,true);
  lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  const body = JSON.parse(h.calls.find(c => c[1] === '/api/handoff')[2].body);
  assert.equal(body.request_id,7);assert.equal(body.order_id,null);assert.equal(body.handoff_version,2);assert.match(body.submit_id,/^[a-f\d-]{36}$/);assert.equal(body.packet_signature,emptyPacket(7).signature);assert.equal(body.report_id,null);assert.equal(body.report_src,null);
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

for(const cachedKind of ['none','completed','legacy-pending'])test('legacy assignment without delivery proof stays explicitly unknown despite '+cachedKind+' session state',async()=>{
  const p=packet(),source=M.profile(p.order);p.assignment={case_id:75,lawyer_name:'Мария',submit_id:null};
  const previous={version:2,fingerprint:M.fingerprint(source),packetSignature:p.signature,lawyer:'109'};
  if(cachedKind==='completed')previous.completed={id:75,name:'Мария'};
  if(cachedKind==='legacy-pending')previous.pending={caseId:75,payload:{order_id:60,report_src:'a',report_id:15},name:'Мария'};
  const h=harness({packet:p,stored:cachedKind==='none'?{}:{'handoff-v2:staff:order-60':JSON.stringify(previous)}});await pause();
  assert.equal(h.node('delivery-title').textContent,'Юрист назначен: Мария');assert.equal(h.node('delivery-text').textContent,'Клиент №75. Подтверждение доставки не сохранено. Нужна проверка доставки.');
  assert.equal(h.node('retry-send').hidden,true);h.node('retry-send').click();h.node('confirm-send').click();await pause();assert.equal(h.postRequests(),0);assert.equal(h.node('open-report').disabled,false);
});

test('a confirmed saved delivery remains distinct from an assignment whose delivery is incomplete',async()=>{
  const p=packet();p.assignment={case_id:75,lawyer_name:'Мария',delivery_complete:true};const h=harness({packet:p});await pause();
  assert.equal(h.node('delivery-title').textContent,'Уже передано: Мария');assert.match(h.node('delivery-text').textContent,/Основной комплект передан/);assert.equal(h.node('retry-send').hidden,true);
});

test('a fresh resumable assignment button invokes only the existing case recovery endpoint',async()=>{
  const bodies=[],p=packet();p.assignment={case_id:75,lawyer_name:'Мария',delivery_complete:false,can_resume:true,submit_id:'existing-job'};
  const h=harness({packet:p,post:async(_,body)=>{bodies.push(body);return h.response({ok:true,id:75,delivery_complete:true});}});await pause();
  assert.equal(h.node('retry-send').hidden,false);h.node('retry-send').click();await pause();assert.equal(bodies.length,1);assert.deepEqual(bodies[0],{resume_case_id:75});assert.match(h.node('delivery-title').textContent,/Передано/);
});

for(const status of ['pending','rejected','blocked'])test('reopening private-complete handoff with '+status+' group notice retries only the summary and keeps a later rejection visible',async()=>{
  const bodies=[],p=packet();p.assignment={case_id:75,lawyer_name:'Мария',delivery_complete:true,can_resume:true,group_notice:{status,manual_review:false}};
  const h=harness({packet:p,post:async(n,body)=>{bodies.push(body);return h.response({ok:true,id:75,delivery_complete:true,group_notice:{status:n===1?'rejected':'confirmed',manual_review:false}});}});await pause();
  assert.match(h.node('delivery-text').textContent,/Личная доставка юристу: подтверждена/);assert.match(h.node('delivery-text').textContent,/Сводк/);
  assert.equal(h.node('retry-send').hidden,false);assert.equal(h.node('retry-send').textContent,'Повторить сводку в чат');
  h.node('retry-send').click();await pause();assert.deepEqual(bodies,[{resume_case_id:75}]);
  assert.match(h.node('delivery-text').textContent,/Личная доставка полного комплекта юристу подтверждена/);assert.match(h.node('delivery-text').textContent,/Сводку не удалось отправить/);
  assert.equal(h.node('retry-send').hidden,false);assert.equal(h.node('retry-send').textContent,'Повторить сводку в чат');
  h.node('retry-send').click();await pause();assert.deepEqual(bodies,[{resume_case_id:75},{resume_case_id:75}]);assert.equal(h.node('retry-send').hidden,true);assert.match(h.node('delivery-text').textContent,/Сводка в чате клиентов опубликована/);
  h.node('retry-send').click();await pause();assert.equal(bodies.length,2);
});

for(const notice of [{status:'unknown'},{status:'sending'},{status:'rejected',manual_review:true}])test('private-complete handoff with uncertain group receipt offers no resend: '+JSON.stringify(notice),async()=>{
  const p=packet();p.assignment={case_id:75,lawyer_name:'Мария',delivery_complete:true,can_resume:true,group_notice:notice};
  const h=harness({packet:p});await pause();assert.match(h.node('delivery-text').textContent,/Личная доставка юристу: подтверждена/);assert.match(h.node('delivery-text').textContent,/Сначала проверьте чат/);
  assert.equal(h.node('retry-send').hidden,true);h.node('retry-send').click();await pause();assert.equal(h.postRequests(),0);
});

test('new private delivery with rejected group summary stays recoverable and an uncertain summary retry stops',async()=>{
  const bodies=[],h=harness({post:async(n,body)=>{bodies.push(body);return h.response({ok:true,id:75,delivery_complete:true,egrn_note:'waiting',group_notice:{status:n===1?'rejected':'unknown',manual_review:n!==1}});}});
  await pause();lawyer(h);h.node('go').click();h.node('confirm-send').click();await pause();
  assert.equal(bodies[0].handoff_version,2);assert.equal(h.node('retry-send').hidden,false);assert.match(h.node('delivery-text').textContent,/Заказанная ЕГРН ещё ожидается/);
  assert.match(h.node('delivery-text').textContent,/Личная доставка полного комплекта юристу подтверждена/);assert.equal(h.cached().completed.groupNotice.status,'rejected');
  h.node('retry-send').click();await pause();assert.deepEqual(bodies[1],{resume_case_id:75});assert.equal(h.node('retry-send').hidden,true);assert.match(h.node('delivery-text').textContent,/Сначала проверьте чат/);assert.match(h.node('delivery-text').textContent,/Заказанная ЕГРН ещё ожидается/);
  h.node('retry-send').click();h.node('confirm-send').click();await pause();assert.equal(bodies.length,2);
});

test('fresh group status and manager capability override a cached completed summary retry on reopen',async()=>{
  for(const group of [{status:'unknown',manual_review:true},{status:'rejected',manual_review:false}]){
    const p=packet(),source=M.profile(p.order);p.assignment={case_id:75,lawyer_name:'Мария',delivery_complete:true,can_resume:false,group_notice:group};
    const h=harness({packet:p,stored:{'handoff-v2:staff:order-60':JSON.stringify({version:2,fingerprint:M.fingerprint(source),packetSignature:p.signature,completed:{id:75,name:'Мария',groupNotice:{status:'rejected'},canResumeNotice:true}})}});await pause();
    assert.equal(h.node('retry-send').hidden,true);assert.match(h.node('delivery-text').textContent,group.status==='unknown'?/Сначала проверьте чат/:/Сводку не удалось отправить/);h.node('retry-send').click();await pause();assert.equal(h.postRequests(),0);
  }
});

test('group notice presentation uses only normalized status and never exposes checkpoint metadata or raw warning',()=>{
  assert.equal(M.groupNotice(null),null);
  const notice=M.groupNotice({status:'rejected',target:'-100PRIVATE',message:'secret transport detail',cursors:{101:99},retry:false});
  assert.equal(notice.retry,true);assert.doesNotMatch(JSON.stringify(notice),/PRIVATE|secret|cursors|target/);
});

test('an unconfirmed recovery response shows its warning in the visible delivery card and disables blind retry',async()=>{
  const p=packet();p.assignment={case_id:75,lawyer_name:'Мария',delivery_complete:false,can_resume:true,submit_id:'existing-job'};
  const h=harness({packet:p,post:async()=>h.response({ok:true,id:75,delivery_complete:false,manual_review:true,retry:false,warn:'Telegram мог принять часть комплекта. Проверьте личный чат.'})});await pause();
  h.node('retry-send').click();await pause();assert.equal(h.postRequests(),1);assert.equal(h.node('delivery-title').textContent,'Юрист назначен: Мария');assert.match(h.node('delivery-text').textContent,/Подтверждение доставки не сохранено/);assert.match(h.node('delivery-text').textContent,/Telegram мог принять/);assert.equal(h.node('retry-send').hidden,true);
  h.node('retry-send').click();await pause();assert.equal(h.postRequests(),1);
});

test('an assigned order reopened in a new session cannot create another client, while the full report stays accessible', async () => {
  const p = packet(); p.assignment = { case_id: 75, lawyer_name: 'Мария', delivery_complete: false, submit_id: 'existing-job' };
  const h = harness({ packet: p }); await pause();
  assert.equal(h.node('go').disabled, true); assert.equal(h.node('assignment').hidden, true);
  assert.equal(h.node('delivery-title').textContent, 'Юрист назначен: Мария');
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
  assert.equal(h.node('delivery-title').textContent, 'Юрист назначен: Мария'); assert.equal(h.node('retry-send').hidden, true); assert.equal(h.node('assignment').hidden, true);
  h.node('retry-send').click(); await pause(); assert.equal(h.postRequests(), 0);
});

test('an already-assigned server rejection shows the actual recipient and case without offering another send', async () => {
  const h = harness({ post: () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'HANDOFF_ALREADY_ASSIGNED', error: 'Клиент уже передан другому юристу.', case_created: true, manual_review: true, retry: false, case_id: 81, lawyer_name: 'Мария', delivery_complete: false }) }) });
  await pause(); lawyer(h); h.node('go').click(); h.node('confirm-send').click(); await pause();
  assert.equal(h.node('delivery-title').textContent, 'Юрист назначен: Мария'); assert.match(h.node('delivery-text').textContent, /81/);
  assert.equal(h.node('assignment').hidden, true); assert.equal(h.node('retry-send').hidden, true); assert.equal(h.node('open-report').disabled, false);
  h.node('retry-send').click(); await pause(); assert.equal(h.postRequests(), 1);
});

for(const phase of ['headers','body'])test('a stalled original '+phase+' releases the download button and a late result cannot download or replace a successful retry',async()=>{
  const p=packet();p.report.media=p.report.media.filter(file=>file.id==='source');p.materials=[];let finish,attempts=0;
  const h=harness({packet:p,virtualClock:true,query:'?order_id=60&view=report',fetch(url){if(!url.includes('/files/source?download=1'))return;attempts++;if(attempts>1)return{ok:true,blob:async()=>({type:'application/pdf',size:400})};return phase==='headers'?new Promise(resolve=>{finish=()=>resolve({ok:true,blob:async()=>({type:'application/pdf',size:400})});}):{ok:true,blob:()=>new Promise(resolve=>{finish=()=>resolve({type:'application/pdf',size:400});})};}});
  await pause();const button=h.node('report-originals').querySelectorAll('[data-download]')[0];button.click();await pause();assert.equal(button.disabled,true);
  await h.tick(180001);assert.equal(button.disabled,false);assert.match(h.node('report-notice').textContent,/вовремя/);assert.equal(h.created.length,0);assert.equal(h.calls.find(call=>call[0]==='fetch'&&call[1].includes('/files/source?download=1'))[2].signal.aborted,true);
  button.click();await pause();assert.equal(button.disabled,false);assert.equal(h.created.length,1);assert.equal(h.calls.filter(call=>call[0]==='click'&&call[1]==='a').length,1);
  finish();await pause();assert.equal(h.created.length,1);assert.equal(h.calls.filter(call=>call[0]==='click'&&call[1]==='a').length,1);
});

for(const outcome of ['success','failure'])test('closing and reopening a report cancels an old original '+outcome+' without affecting the new report',async()=>{
 const p=packet();p.report.media=p.report.media.filter(file=>file.id==='source');p.materials=[];let finish,reject;const h=harness({packet:p,virtualClock:true,query:'?order_id=60',fetch(url){if(url.includes('/files/source?download=1'))return new Promise((resolve,fail)=>{finish=()=>resolve({ok:true,blob:async()=>({type:'application/pdf',size:400})});reject=()=>fail(new Error('Old request failed'));});}});
 await pause();h.node('open-report').click();const old=h.node('report-originals').querySelectorAll('[data-download]')[0];old.click();await pause();const signal=h.calls.find(call=>call[0]==='fetch'&&call[1].includes('download=1'))[2].signal;
 h.node('report-close').click();await pause();assert.equal(signal.aborted,true);assert.equal(old.disabled,false);h.node('open-report').click();h.node('report-notice').textContent='Current report message';if(outcome==='success')finish();else reject();await pause();assert.equal(h.created.length,0);assert.equal(h.node('report-notice').textContent,'Current report message');assert.equal(h.node('report-originals').querySelectorAll('[data-download]')[0].disabled,false);
});

for(const phase of ['headers','body'])test('a stalled gallery '+phase+' shows retry and cannot attach an older image after its deadline',async()=>{
 const p=packet();p.report.media=p.report.media.filter(file=>file.id==='map');p.materials=[];let finish,attempts=0;
 const h=harness({packet:p,virtualClock:true,query:'?order_id=60&view=report',fetch(url){if(!url.includes('/files/map'))return;attempts++;if(attempts>1)return{ok:true,blob:async()=>({type:'image/png',size:100})};return phase==='headers'?new Promise(resolve=>{finish=()=>resolve({ok:true,blob:async()=>({type:'image/png',size:100})});}):{ok:true,blob:()=>new Promise(resolve=>{finish=()=>resolve({type:'image/png',size:100});})};}});
 await pause();await h.tick(180001);const card=h.node('gallery').children[0],status=card.querySelector('.image-state');assert.match(status.textContent,/не загрузилось/);assert.equal(status.children[0].textContent,'Повторить');assert.equal(h.created.length,0);status.children[0].click();await pause();assert.equal(h.created.length,1);finish();await pause();assert.equal(h.created.length,1);
});

test('a late refreshed EGRN link cannot open outside a report that the user already closed',async()=>{
 const p=packet();p.report.media=[];p.materials=[];p.egrn_links=[{id:'12345678-1234-4123-8123-123456789abc',name:'Large original.pdf',bytes:300000000,url:'/api/audit/orders/60/egrn/12345678-1234-4123-8123-123456789abc/link'}];let finish;
 const h=harness({packet:p,query:'?order_id=60',fetch(url){if(url.includes('/egrn/'))return new Promise(resolve=>{finish=()=>resolve({ok:true,status:200,json:async()=>({ok:true,url:'https://storage.example/signed-original'})});});}});await pause();h.node('open-report').click();h.node('report-originals').querySelectorAll('[data-download]')[0].click();await pause();h.node('report-close').click();h.node('open-report').click();finish();await pause();assert.equal(h.calls.filter(call=>call[0]==='click'&&call[1]==='a').length,0);assert.equal(h.node('report-notice').textContent,'');
});

for(const [contentType,blobType] of [
  ['text/html; charset=utf-8','text/html'],['application/xhtml+xml','application/xhtml+xml'],
  ['application/json; charset=utf-8','application/json'],['application/problem+json','application/problem+json'],
  ['application/octet-stream','text/html'],['','application/json'],
])test('a successful service response '+contentType+' / '+blobType+' cannot be downloaded as an original PDF',async()=>{
  const p=packet();p.report.media=p.report.media.filter(file=>file.id==='source');p.materials=[];
  const h=harness({packet:p,query:'?order_id=60&view=report',fetch(url){if(url.includes('/files/source?download=1'))return{ok:true,status:200,headers:{get:()=>contentType},blob:async()=>({type:blobType,size:400})};}});
  await pause();const button=h.node('report-originals').querySelectorAll('[data-download]')[0];button.click();await pause();
  assert.equal(button.disabled,false);assert.match(h.node('report-notice').textContent,/служебный ответ/);
  assert.equal(h.created.length,0);assert.equal(h.calls.filter(call=>call[0]==='click'&&call[1]==='a').length,0);
  assert.equal(h.calls.find(call=>call[0]==='fetch'&&call[1].includes('/files/source?download=1'))[2].signal.aborted,true);
});

test('a gallery service page exposes retry instead of leaving a cancelled image loading forever',async()=>{
  const p=packet();p.report.media=p.report.media.filter(file=>file.id==='map');p.materials=[];let attempt=0;
  const h=harness({packet:p,query:'?order_id=60&view=report',fetch(url){if(url.includes('/files/map'))return ++attempt===1?{ok:true,headers:{get:()=> 'text/html'},blob:async()=>({type:'text/html',size:100})}:{ok:true,headers:{get:()=> 'image/png'},blob:async()=>({type:'image/png',size:100})};}});
  await pause();const state=h.node('gallery').children[0].querySelector('.image-state');assert.match(state.textContent,/не загрузилось/);assert.equal(state.children[0].textContent,'Повторить');assert.equal(h.created.length,0);
  state.children[0].click();await pause();assert.equal(h.created.length,1);assert.equal(attempt,2);
});

for(const [name,mime] of [
  ['Full report.txt','text/plain; charset=utf-8'],['Original.pdf','application/pdf'],['Plan.png','image/png'],
  ['Archive.zip','application/zip'],['Document.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['Table.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],['Legacy.pdf','application/octet-stream'],
])test('a genuine '+name+' remains downloadable with its declared response type',async()=>{
  const p=packet();p.report.media=[{...p.report.media.find(file=>file.id==='source'),name,mime:mime.split(';')[0]}];p.materials=[];
  const h=harness({packet:p,query:'?order_id=60&view=report',fetch(url){if(url.includes('/files/source?download=1'))return{ok:true,status:200,headers:{get:()=>mime},blob:async()=>({type:mime,size:400})};}});
  await pause();h.node('report-originals').querySelectorAll('[data-download]')[0].click();await pause();
  assert.equal(h.created.length,1);assert.equal(h.calls.filter(call=>call[0]==='click'&&call[1]==='a').length,1);assert.equal(h.node('report-notice').textContent,'');
});

function manualDraft(h){return JSON.parse(h.persistent.get('handoff-v2:staff:manual')||h.stored.get('handoff-v2:staff:manual')||'null');}
function fillManual(h,changes={}){
  const values={org:'ООО Новый клиент',address:'Химки, Новая улица, 7',kind:'Общепит',service:'Получение',...changes};
  for(const [key,value] of Object.entries(values)){h.node(key).value=value;h.node(key).listeners.change.call(h.node(key));}
  lawyer(h);
}
const manualDocument={id:'12345678-1234-4123-8123-123456789abc',name:'Сохранённый план.pdf',mime:'application/pdf',role:'document',bytes:100,sha256:'a'.repeat(64)};

test('manual client mode ignores stale source and readonly URL parameters and uses an isolated editable draft',async()=>{
  const ordinary={version:2,profile:{org:'Ordinary source draft'},submitId:'ordinary',completed:{id:1,name:'Old lawyer'}};
  const h=harness({query:'?mode=manual&order_id=60&request_id=8&report_src=a&report_id=15&case_id=39&view=report',stored:{'handoff-v2:staff:order-60':JSON.stringify(ordinary)}});await pause();
  assert.equal(h.node('page-title').textContent,'Создать клиента');assert.equal(h.node('details').open,true);assert.equal(h.node('cad-field').hidden,true);assert.equal(h.node('packet-section').hidden,true);assert.equal(h.node('readonly-note').hidden,true);
  assert.equal(h.node('org').value,'');assert.equal(h.node('region').value,'МО');assert.equal(h.node('priority').value,'обычный');assert.equal(h.node('go').textContent,'Создать и передать');assert.equal(h.node('go').disabled,false);
  assert.equal(h.node('manual-optional').hidden,false);assert.equal(h.node('manual-optional').open,false);assert.deepEqual(h.node('manual-optional-fields').children.map(item=>item.id),['inn-field','contact-section','comment-field','priority-field']);
  assert.ok(manualDraft(h).submitId);assert.deepEqual(JSON.parse(h.stored.get('handoff-v2:staff:order-60')),ordinary);
  const requests=h.calls.filter(call=>call[0]==='fetch');assert.ok(requests.some(call=>call[1]==='/api/handoff/packet'));assert.equal(requests.some(call=>/[?&](?:order_id|request_id|case_id|report_id)=/.test(call[1])),false);
});

test('manual review and payload contain only real client facts and optional saved files, without report or EGRN claims',async()=>{
  const h=harness({query:'?mode=manual'});await pause();fillManual(h,{region:'МСК'});h.node('go').click();await pause();
  assert.equal(h.node('review').hidden,false);assert.equal(h.node('review-title').textContent,'Проверьте клиента');assert.equal(h.node('confirm-send').textContent,'Подтвердить создание');
  assert.match(h.node('review-list').innerHTML,/Карточка клиента/);assert.match(h.node('review-list').innerHTML,/Чек-лист/);assert.doesNotMatch(h.node('review-list').innerHTML,/ЕГРН|[Оо]тчёт|[Оо]ригиналы|Фото|Схемы/);
  h.node('confirm-send').click();await pause();const body=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);
  assert.equal(body.manual_client,true);assert.equal(body.handoff_version,2);for(const key of ['order_id','request_id','report_id','report_src'])assert.equal(body[key],null,key);
  assert.equal(body.egrn_order,false);assert.equal(body.cad_num,'');assert.equal(body.audit_text,'');assert.equal(body.region,'МСК');assert.deepEqual(body.contacts,[]);assert.deepEqual(body.manual_files,[]);
  assert.match(h.node('delivery-title').textContent,/Клиент создан/);assert.doesNotMatch(h.node('delivery-text').textContent,/ЕГРН|отчёт/);
});

test('manual creation requires a selected lawyer and displays the actual available workload',async()=>{
  const h=harness({query:'?mode=manual',prefill:{ok:true,lawyers:[{tg_id:108,name:'Елена',active_cases:3},{tg_id:109,name:'Мария',active_cases:0}]}});await pause();fillManual(h);h.node('lawyers').value='';h.node('lawyers').onchange.call(h.node('lawyers'));h.node('go').click();await pause();
  assert.equal(h.node('review').hidden,true);assert.match(h.node('form-error').textContent,/Выберите юриста/);assert.match(h.node('lawyers').innerHTML,/Елена · 3 в работе/);assert.match(h.node('lawyers').innerHTML,/Мария · 0 в работе/);assert.equal(h.postRequests(),0);
});

for(const field of ['org','address','kind','service','region'])test('manual '+field+' is required before matches, review or creation',async()=>{
  const h=harness({query:'?mode=manual'});await pause();fillManual(h,{[field]:''});h.node('go').click();await pause();
  assert.equal(h.node('review').hidden,true);assert.ok(h.node('form-error').textContent);assert.equal(h.calls.some(call=>call[1].startsWith('/api/handoff/manual-matches')),false);assert.equal(h.postRequests(),0);
});

test('manual matching exposes existing cases and requires a deliberate new-client choice without merging',async()=>{
  const h=harness({query:'?mode=manual',matches:[{case_id:39,org:'ООО Новый клиент',address:'Химки, Новая улица, 7',lawyer_name:'Елена',stage:'Архив',checklist_url:'https://foreign.invalid/ignored'}],hasMore:true});await pause();fillManual(h);h.node('go').click();await pause();
  assert.equal(h.node('review').hidden,true);assert.equal(h.node('manual-matches').hidden,false);assert.match(h.node('manual-match-list').innerHTML,/\/checklist\?case_id=39/);assert.doesNotMatch(h.node('manual-match-list').innerHTML,/foreign.invalid/);assert.match(h.node('manual-match-list').innerHTML,/Архив/);assert.equal(h.node('manual-match-more').hidden,false);assert.equal(h.postRequests(),0);
  h.node('manual-create-new').checked=true;h.node('manual-create-new').onchange.call(h.node('manual-create-new'));h.node('go').click();await pause();assert.equal(h.node('review').hidden,false);
  h.node('review-back').click();h.node('address').value='Другой адрес';h.node('address').listeners.input.call(h.node('address'));assert.equal(h.node('manual-create-new').checked,false);assert.equal(h.node('manual-matches').hidden,true);
});

test('a late manual match response cannot open review or authorize a new client after the facts changed',async()=>{
  let release;const h=harness({query:'?mode=manual',fetch(url){if(url.startsWith('/api/handoff/manual-matches'))return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({ok:true,matches:[]})});});}});await pause();fillManual(h);h.node('go').click();await pause();assert.equal(h.node('go').disabled,true);
  h.node('address').value='Новый выбранный адрес';h.node('address').listeners.input.call(h.node('address'));release();await pause();assert.equal(h.node('review').hidden,true);assert.equal(h.node('manual-matches').hidden,true);assert.equal(h.node('address').value,'Новый выбранный адрес');assert.equal(h.postRequests(),0);
});

test('one malformed manual match cannot be silently dropped or authorize creation as if no match existed',async()=>{
  for(const id of ['INVALID',true,[39],{},0,-1,1.5,2147483648]){
    const h=harness({query:'?mode=manual',matches:[{case_id:39,org:'Valid existing client'},{case_id:id,org:'Malformed existing client'}]});await pause();fillManual(h);h.node('go').click();await pause();
    assert.equal(h.node('review').hidden,true,String(id));assert.match(h.node('manual-match-status').textContent,/Не удалось проверить/);assert.equal(h.node('manual-match-retry').hidden,false);assert.equal(h.node('manual-match-list').innerHTML,'');h.node('confirm-send').click();await pause();assert.equal(h.postRequests(),0);
  }
});

test('a canonical numeric-string case match remains visible and requires deliberate duplicate consent',async()=>{
  const h=harness({query:'?mode=manual',matches:[{case_id:'39',org:'Existing client',address:'Saved address'}]});await pause();fillManual(h);h.node('go').click();await pause();assert.equal(h.node('review').hidden,true);assert.match(h.node('manual-match-list').innerHTML,/case_id=39/);assert.equal(h.node('manual-create-new').checked,false);
});

test('manual durable storage restores unblurred fields, contacts and comment in a fresh page without session cache',async()=>{
  const first=harness({query:'?mode=manual'});await pause();const sid=manualDraft(first).submitId;
  first.node('org').value='Без blur';first.node('org').listeners.input.call(first.node('org'));first.node('comment').value='Комментарий до закрытия';first.node('comment').oninput.call(first.node('comment'));
  first.node('add-contact').click();first.node('contacts').listeners.input({target:{dataset:{contact:'0',field:'phone'},value:'+79991234567'}});
  const next=harness({query:'?mode=manual',persistent:Object.fromEntries(first.persistent)});await pause();assert.equal(next.node('org').value,'Без blur');assert.equal(next.node('comment').value,'Комментарий до закрытия');assert.match(next.node('contacts').innerHTML,/79991234567/);assert.equal(manualDraft(next).submitId,sid);
  const foreign=harness({query:'?mode=manual&u=another',persistent:Object.fromEntries(first.persistent)});await pause();assert.equal(foreign.node('org').value,'');
});

test('manual upload serializes files and sends only acknowledged metadata after all uploads complete',async()=>{
  const files=[],posts=[];let release;
  const h=harness({query:'?mode=manual',fetch(url,init,response){if(url.startsWith('/api/handoff/manual-materials')){if(init.method==='POST'){posts.push({url,init});const result={...manualDocument,id:posts.length===1?manualDocument.id:'22345678-1234-4123-8123-123456789abc',name:init.body.get('file').name};if(posts.length===1)return new Promise(resolve=>{release=()=>{files.push(result);resolve(response({ok:true,files:[...files]}));};});files.push(result);}return response({ok:true,files:[...files]});}}});await pause();fillManual(h);const sid=manualDraft(h).submitId;
  h.node('manual-files').files=[new File(['one'],'first.pdf',{type:'application/pdf'}),new File(['two'],'second.pdf',{type:'application/pdf'})];h.node('manual-files').onchange.call(h.node('manual-files'));await pause();assert.equal(posts.length,1);assert.equal(h.node('go').disabled,true);assert.equal(manualDraft(h).submitId,sid);
  release();await pause();assert.equal(posts.length,2);assert.ok(posts.every(call=>new URL(call.url,'https://bot.example').searchParams.get('submit_id')===sid));assert.ok(posts.every(call=>!call.init.headers||!call.init.headers['Content-Type']));assert.equal(h.node('go').disabled,false);assert.match(h.node('manual-file-list').innerHTML,/first.pdf/);assert.match(h.node('manual-file-list').innerHTML,/second.pdf/);
  h.node('go').click();await pause();h.node('confirm-send').click();await pause();const body=JSON.parse(h.calls.find(call=>call[1]==='/api/handoff')[2].body);assert.deepEqual(body.manual_files,files);assert.equal(body.submit_id,sid);
});

test('a manual file-first lost upload ACK keeps its durable SID and reopening discovers the saved original',async()=>{
  let saved=[];const first=harness({query:'?mode=manual',fetch(url,init,response){if(url.startsWith('/api/handoff/manual-materials')){if(init.method==='POST'){saved=[manualDocument];throw new Error('Lost upload ACK');}return response({ok:true,files:saved});}}});await pause();const sid=manualDraft(first).submitId;
  first.node('manual-files').files=[new File(['source'],'source.pdf')];first.node('manual-files').onchange.call(first.node('manual-files'));await pause();assert.equal(manualDraft(first).submitId,sid);assert.equal(first.node('go').disabled,true);assert.equal(first.node('manual-files-retry').hidden,false);
  const next=harness({query:'?mode=manual',persistent:Object.fromEntries(first.persistent),manualFiles:saved});await pause();assert.equal(manualDraft(next).submitId,sid);assert.match(next.node('manual-file-list').innerHTML,/Сохранённый план/);assert.equal(next.calls.some(call=>call[1].startsWith('/api/handoff/manual-materials')&&call[2].method==='POST'),false);
});

test('a definite manual rejection before case creation preserves SID and uploaded originals for an edited retry',async()=>{
  const bodies=[];const h=harness({query:'?mode=manual',manualFiles:[manualDocument],post(n,body){bodies.push(body);return n===1?{ok:false,status:400,json:async()=>({ok:false,case_created:false,error:'Проверьте данные'})}:h.response({ok:true,id:75,delivery_complete:true});}});await pause();fillManual(h);const sid=manualDraft(h).submitId;h.node('go').click();await pause();h.node('confirm-send').click();await pause();assert.equal(manualDraft(h).submitId,sid);assert.match(h.node('manual-file-list').innerHTML,/Сохранённый план/);assert.equal(h.node('go').disabled,false);
  h.node('comment').value='Исправленный комментарий';h.node('comment').oninput.call(h.node('comment'));h.node('go').click();await pause();h.node('confirm-send').click();await pause();assert.equal(bodies.length,2);assert.equal(bodies[1].submit_id,sid);assert.deepEqual(bodies[1].manual_files,[manualDocument]);assert.equal(bodies[1].comment,'Исправленный комментарий');
});

test('unknown manual delivery cannot reset or mutate files and restart replays the exact frozen payload',async()=>{
  const first=harness({query:'?mode=manual',manualFiles:[manualDocument],post(){throw new Error('Lost handoff ACK');}});await pause();fillManual(first);first.node('go').click();await pause();first.node('confirm-send').click();await pause();const body=JSON.parse(first.calls.find(call=>call[1]==='/api/handoff')[2].body);
  assert.equal(first.node('manual-create-another').hidden,true);assert.equal(first.node('manual-add-files').disabled,true);first.node('manual-create-another').click();assert.equal(manualDraft(first).submitId,body.submit_id);
  const next=harness({query:'?mode=manual',manualFiles:[manualDocument],persistent:Object.fromEntries(first.persistent)});await pause();assert.equal(next.node('manual-create-another').hidden,true);next.node('retry-send').click();await pause();assert.deepEqual(JSON.parse(next.calls.find(call=>call[1]==='/api/handoff')[2].body),body);assert.match(next.node('delivery-title').textContent,/Клиент создан/);
});

test('manual success stays visible across reopening until explicit create-another resets only this draft',async()=>{
  const first=harness({query:'?mode=manual',manualFiles:[manualDocument]});await pause();fillManual(first);first.node('go').click();await pause();first.node('confirm-send').click();await pause();const sid=manualDraft(first).submitId;
  const second=harness({query:'?mode=manual',persistent:Object.fromEntries(first.persistent),fetch(url,init,response){if(url.startsWith('/api/handoff/manual-materials'))return response({ok:true,files:new URL(url,'https://bot.example').searchParams.get('submit_id')===sid?[manualDocument]:[]});}});await pause();assert.match(second.node('delivery-title').textContent,/Клиент создан/);assert.equal(second.node('manual-create-another').hidden,false);assert.equal(second.postRequests(),0);
  second.node('manual-create-another').click();await pause();assert.notEqual(manualDraft(second).submitId,sid);assert.equal(second.node('org').value,'');assert.equal(second.node('region').value,'МО');assert.equal(second.node('manual-file-list').innerHTML,'');assert.equal(second.node('delivery').hidden,true);assert.equal(second.node('go').disabled,false);assert.equal(second.postRequests(),0);
});

test('a malformed manual creation ACK preserves the exact pending intent and saved files until a valid retry confirms it',async()=>{
  const invalid=[{},...[true,[75],0,-1,1.5,2147483648,Number.MAX_SAFE_INTEGER+1,'INVALID'].map(id=>({id,delivery_complete:true})),...[undefined,'true',1].map(delivery_complete=>({id:75,delivery_complete}))];
  for(const ack of invalid){
    const bodies=[],h=harness({query:'?mode=manual',manualFiles:[manualDocument],post(n,body){bodies.push(body);return h.response(n===1?{ok:true,...ack}:{ok:true,id:75,delivery_complete:true});}});await pause();fillManual(h);h.node('go').click();await pause();h.node('confirm-send').click();await pause();
    assert.equal(manualDraft(h).completed,null);assert.deepEqual(manualDraft(h).pending.payload,bodies[0]);assert.equal(h.node('manual-create-another').hidden,true);assert.match(h.node('delivery-text').textContent,/не подтверждён/);assert.doesNotMatch(h.node('delivery-title').textContent,/Клиент создан/);assert.match(h.node('manual-file-list').innerHTML,/Сохранённый план/);
    h.node('retry-send').click();await pause();assert.deepEqual(bodies[1],bodies[0]);assert.match(h.node('delivery-title').textContent,/Клиент создан/);assert.equal(h.node('manual-create-another').hidden,false);
  }
});

test('manual partial and group-only recovery accept only the same confirmed case ID and preserve documents',async()=>{
  const bodies=[],h=harness({query:'?mode=manual',manualFiles:[manualDocument],post(n,body){bodies.push(body);const responses=[{id:75,delivery_complete:false,retry:true},{id:76,delivery_complete:true},{id:75,delivery_complete:true,group_notice:{status:'pending'}},{delivery_complete:true},{id:75,delivery_complete:true,group_notice:{status:'confirmed'}}];return h.response({ok:true,...responses[n-1]});}});await pause();fillManual(h);h.node('go').click();await pause();h.node('confirm-send').click();await pause();assert.equal(manualDraft(h).pending.caseId,75);
  h.node('retry-send').click();await pause();assert.equal(manualDraft(h).completed,null);assert.equal(manualDraft(h).pending.caseId,75);assert.equal(h.node('manual-create-another').hidden,true);assert.match(h.node('manual-file-list').innerHTML,/Сохранённый план/);
  h.node('retry-send').click();await pause();assert.equal(manualDraft(h).completed.id,75);assert.deepEqual(bodies[2],bodies[0]);
  h.node('retry-send').click();await pause();assert.equal(h.node('manual-create-another').hidden,true);assert.match(h.node('delivery-text').textContent,/не подтверждён/);
  h.node('retry-send').click();await pause();assert.deepEqual(bodies[3],{resume_case_id:75});assert.deepEqual(bodies[4],bodies[3]);assert.equal(manualDraft(h).completed.id,75);assert.match(h.node('manual-file-list').innerHTML,/Сохранённый план/);
});


function documentFixture(name='Договор.pdf') { return {id:require('node:crypto').randomUUID(),name,mime:'application/pdf',role:'manager',bytes:4,sha256:'b'.repeat(64)}; }
function documentsServer() {
  const staged=new Map(),batches=[],sent=[],fetched=[];
  return {staged,batches,sent,fetched,fetch(url,init,response){
    if(url.startsWith('/api/handoff/manual-materials')){
      const sid=new URL(url,'https://bot.example').searchParams.get('submit_id');let files=staged.get(sid)||[];
      if(init.method==='POST'){const upload=init.body.get('file');files=files.concat(documentFixture(upload.name));staged.set(sid,files);}
      return response({ok:true,files});
    }
    if(/^\/api\/handoff\/cases\/\d+\/documents$/.test(url)){
      const id=Number(url.split('/')[4]);
      if(init.method==='POST'){
        const body=JSON.parse(init.body);sent.push({id,body});const batch={id:body.submit_id,status:'delivered',retry:false,files:body.files.map(f=>({...f,url:url+'/'+body.submit_id+'/files/'+f.id}))};batches.push(batch);
        return response({ok:true,case_id:id,batch,delivery_complete:true});
      }
      return response({ok:true,case_id:id,batches,files:batches.flatMap(b=>b.files)});
    }
    if(/\/cases\/\d+\/package/.test(url)){fetched.push(url);return {ok:true,status:200,headers:{get:()=> 'application/zip'},blob:async()=>({type:'application/zip',size:100})};}
  }};
}
async function extraFile(h,name='Договор.pdf') {h.node('extra-document-input').files=[new Blob(['test'],{type:'application/pdf'})];h.node('extra-document-input').files[0].name=name;h.node('extra-document-input').onchange();await pause();}

test('ordinary handoff attaches manager documents, preserves company, then appends a second batch without recreating the client',async()=>{
  const docs=documentsServer(),h=harness({fetch:docs.fetch});await pause();lawyer(h);
  h.node('org').value='ООО Тестовый лимон';h.node('org').listeners.input.call(h.node('org'));
  await extraFile(h);assert.match(h.node('extra-document-status').textContent,/Файлы сохранены/);
  h.node('go').click();assert.match(h.node('review-list').innerHTML,/Дополнительно: Договор.pdf/);h.node('confirm-send').click();await pause();
  assert.equal(h.postRequests(),1);assert.equal(docs.sent.length,1);assert.equal(docs.sent[0].id,75);assert.notEqual(docs.sent[0].body.submit_id,h.cached().submitId);assert.equal(h.cached().profile.org,'ООО Тестовый лимон');
  assert.equal(h.node('extra-document-send').hidden,true);
  await extraFile(h,'ТО.pdf');h.node('extra-document-send').click();await pause();assert.equal(h.postRequests(),1);assert.equal(docs.sent.length,2);assert.notEqual(docs.sent[0].body.submit_id,docs.sent[1].body.submit_id);
  h.node('download-package').click();await pause();assert.equal(h.created.length,1,'ZIP can download while report modal is closed');assert.match(docs.fetched[0],/cases\/75\/package/);
});

test('lost document ACK survives browser-session closure and reconciles the same delivered batch without redoing handoff',async()=>{
  const docs=documentsServer();let lost=true;
  const custom=(url,init,response)=>{const result=docs.fetch(url,init,response);if(lost&&init.method==='POST'&&/\/cases\/75\/documents$/.test(url)){lost=false;return Promise.reject(new Error('Connection lost after commit'));}return result;};
  const h=harness({fetch:custom});await pause();lawyer(h);await extraFile(h);h.node('go').click();h.node('confirm-send').click();await pause();
  assert.equal(h.cached().completed.id,75);assert.ok(h.cached().documents.attempt);assert.match(h.node('delivery-text').textContent,/ещё не доставлены/);
  const p=packet();p.assignment={case_id:75,lawyer_name:'Елена',delivery_complete:true,profile:{...p.order,org:'ООО Тестовый лимон'}};
  const fresh=harness({packet:p,persistent:Object.fromEntries(h.persistent),fetch:custom});await pause();
  assert.equal(fresh.postRequests(),0);assert.equal(docs.sent.length,1);assert.equal(fresh.cached().documents.attempt,null);assert.equal(fresh.node('extra-document-send').hidden,true);assert.match(fresh.node('extra-document-history').innerHTML,/Договор.pdf/);
});

test('failed restored upload is checked once and waits for manual retry instead of a request loop',async()=>{
  let attempts=0;const sid=require('node:crypto').randomUUID(),h=harness({persistent:{'handoff-v2:staff:order-60':JSON.stringify({version:2,documents:{id:sid,hasDraft:true}})},fetch(url){if(url.startsWith('/api/handoff/manual-materials')){attempts++;throw new Error('Storage offline');}}});await pause();
  assert.equal(attempts,1);assert.equal(h.node('go').disabled,true);assert.match(h.node('extra-document-status').textContent,/Storage offline/);h.node('extra-document-retry').click();await pause();assert.equal(attempts,2);
});

test('changed lawyer or unknown delivery disables automatic document retry while preserving the batch identity',async()=>{
  for(const status of ['pending','review']){
    const docs=documentsServer(),custom=(url,init,response)=>{
      if(init.method==='POST'&&/\/cases\/75\/documents$/.test(url)){const body=JSON.parse(init.body);docs.sent.push(body);return response({ok:true,case_id:75,delivery_complete:false,batch:{id:body.submit_id,status,retry:false,warn:'Проверьте назначение и доставку',files:body.files}});}
      return docs.fetch(url,init,response);
    };
    const h=harness({fetch:custom});await pause();lawyer(h);await extraFile(h);h.node('go').click();h.node('confirm-send').click();await pause();
    assert.equal(h.node('extra-document-send').disabled,true);assert.equal(h.cached().documents.attempt.review,true);h.node('extra-document-send').click();await pause();assert.equal(docs.sent.length,1);
  }
});

test('an invalid ordinary handoff ACK never sends manager documents to an unconfirmed case',async()=>{
  const docs=documentsServer(),h=harness({fetch:docs.fetch,post:async()=>({ok:true,status:200,json:async()=>({ok:true,id:null,delivery_complete:true})})});await pause();lawyer(h);await extraFile(h);h.node('go').click();h.node('confirm-send').click();await pause();assert.equal(docs.sent.length,0);assert.ok(h.cached().pending);assert.equal(h.cached().completed,null);
});


test('a restored upload keeps the manager company, lawyer and comments before asynchronous hydration',async()=>{
  const docs=documentsServer(),h=harness({fetch:docs.fetch});await pause();lawyer(h);h.node('org').value='ООО Тестовый лимон';h.node('org').listeners.input.call(h.node('org'));h.node('comment').value='Проверить ТО';h.node('comment').oninput();await extraFile(h);
  const fresh=harness({fetch:docs.fetch,persistent:Object.fromEntries(h.persistent)});await pause();assert.equal(fresh.node('org').value,'ООО Тестовый лимон');assert.equal(fresh.cached().lawyer,'108');assert.equal(fresh.node('comment').value,'Проверить ТО');assert.match(fresh.node('extra-document-list').innerHTML,/Договор.pdf/);
});

test('a failed document POST before commit remains retryable after closing the browser',async()=>{
  const docs=documentsServer();let fail=true;const custom=(url,init,response)=>{if(fail&&init.method==='POST'&&/\/cases\/75\/documents$/.test(url)){fail=false;throw new Error('Offline before request');}return docs.fetch(url,init,response);};
  const h=harness({fetch:custom});await pause();lawyer(h);await extraFile(h);h.node('go').click();h.node('confirm-send').click();await pause();const original=h.cached().documents.attempt.submit_id;
  const p=packet();p.assignment={case_id:75,lawyer_name:'Елена',delivery_complete:true};
  const fresh=harness({fetch:custom,packet:p,persistent:Object.fromEntries(h.persistent)});await pause();assert.equal(fresh.node('extra-document-send').disabled,false);fresh.node('extra-document-send').click();await pause();assert.equal(docs.sent.length,1);assert.equal(docs.sent[0].body.submit_id,original);assert.equal(fresh.postRequests(),0);assert.equal(fresh.cached().documents.attempt,null);
});

test('documents view resolves an existing bound case and allows only its manager to append files',async()=>{
  for(const manage of [true,false]){
    const p=packet();p.assignment={case_id:75,lawyer_name:'Елена',delivery_complete:true,profile:{...p.order,org:'ООО Тестовый лимон'}};
    const h=harness({query:'?case_id=75&view=documents',packet:p,prefill:{ok:true,can_manage:manage,order:{...p.order,org:'ООО Тестовый лимон'},report:{id:15,src:'a'},lawyers:[{tg_id:108,name:'Елена'}]}});await pause();
    assert.equal(h.node('page-title').textContent,'Документы клиента');assert.equal(h.node('object-org').textContent,'ООО Тестовый лимон');assert.equal(h.node('report-dialog').open,false);assert.equal(h.node('extra-document-add').hidden,!manage);assert.equal(h.node('download-package').hidden,false);assert.equal(h.node('footer').hidden,true);
  }
});

test('review opening report should not silently cancel a separately started package download',async()=>{
  const p=packet();p.assignment={case_id:75,lawyer_name:'Елена',delivery_complete:true,profile:p.order};let signal,finish;
  const h=harness({packet:p,fetch(url,init){if(/\/cases\/75\/package/.test(url)){signal=init.signal;return {ok:true,status:200,headers:{get:()=> 'application/zip'},blob:()=>new Promise(resolve=>{finish=resolve;})};}}});await pause();
  h.node('download-package').click();await pause();assert.ok(signal);h.node('open-report').click();await pause();assert.equal(signal.aborted,false,'Opening the report must not cancel the package download that started outside it');finish({type:'application/zip',size:100});
});
