const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, response, savedPacket, settle } = require('./helpers/manager-form');

for(const stage of ['headers','blob body'])test('existing manager file '+stage+' has a bounded download, ignores a late response and can be retried',async()=>{
  const h=harness({virtualClock:true}),button={textContent:'Download original',disabled:false},file={url:'/api/audit/orders/58/materials/original',name:'Original.pdf'};
  let release,finished=false,clicked=0;const objects=[];
  h.c.URL={createObjectURL(blob){objects.push(blob);return 'blob:synthetic-original';},revokeObjectURL(){}};
  h.c.document.body={appendChild(){}};h.c.document.createElement=()=>({click(){clicked++;},remove(){}});
  h.c.respond=()=>stage==='headers'?new Promise(resolve=>{release=resolve;}):{ok:true,blob:()=>new Promise(resolve=>{release=resolve;})};
  h.c.downloadExistingFile(file,button).then(()=>{finished=true;});await settle();await h.tick(179999);assert.equal(finished,false);assert.equal(button.disabled,true);
  await h.tick(1);assert.equal(finished,true);assert.equal(button.disabled,false);assert.equal(button.textContent,'Download original');assert.equal(h.requests[0].options.signal.aborted,true);assert.equal(objects.length,0);assert.match(h.alerts.at(-1),/долго|ответ/i);
  release(stage==='headers'?{ok:true,blob:async()=>({late:true})}:{late:true});await settle();assert.equal(objects.length,0);assert.equal(clicked,0);
  const original={bytes:'full original'};h.c.respond=()=>({ok:true,blob:async()=>original});await h.c.downloadExistingFile(file,button);
  assert.deepEqual(objects,[original]);assert.equal(clicked,1);assert.equal(button.disabled,false);assert.equal(h.requests.length,2);await h.tick(60000);assert.equal(h.timers.size,0);
});

for (const stalled of ['headers', 'JSON body']) test('a stalled manager packet ' + stalled + ' stops loading after 30 seconds without losing typed input', async () => {
  const h = harness({ virtualClock: true }); h.c.editOrderId = '58';
  let signal, completed = false;
  h.c.respond = (url, options) => { signal = options && options.signal; return stalled === 'headers' ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) }; };
  h.nodes.get('address').value = 'Мой сохранённый в форме текст';
  h.c.loadExistingPacket(true).then(() => { completed = true; });
  await settle(); await h.tick(30000);
  assert.equal(completed, true);
  assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
  assert.equal(h.nodes.get('packet-retry').hidden, false);
  assert.equal(h.nodes.get('address').value, 'Мой сохранённый в форме текст');
  assert.match(h.nodes.get('packet-status').textContent, /долго|ответ|связ/i);
});

for (const stalled of ['headers', 'response body']) test('a stalled ' + stalled + ' permits a 100 MB upload budget then releases submission with its original intent', async () => {
  const h = harness({ virtualClock: true }); let completed = false, signal;
  for (let n = 0; n < 10; n++) h.c.attachedFiles.push({ name: 'Документ-' + n + '.pdf', size: 10 * 1024 * 1024, materialRole: 'document' });
  const intent = h.c.submitId;
  h.c.respond = (url, options) => { signal = options.signal; return stalled === 'headers' ? new Promise(() => {}) : { status: 200, text: () => new Promise(() => {}) }; };
  h.c.submitForm().then(() => { completed = true; }); await settle();
  await h.tick(300000);
  assert.equal(completed, false, 'A valid body can use the server\'s entire five-minute request timeout');
  h.nodes.get('address').value = 'Правка во время ожидания';
  await h.tick(600000);
  assert.equal(completed, true); assert.equal(signal.aborted, true);
  assert.equal(h.nodes.get('submit-btn').disabled, false); assert.equal(h.c.submitId, intent);
  assert.equal(h.c.attachedFiles.length, 10); assert.equal(h.nodes.get('address').value, 'Правка во время ожидания');
  assert.match(h.alerts.at(-1), /может.*сохран|подтвержден/i);
  assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
});

test('stopping local waiting keeps the exact frozen edit for a lost-acknowledgement retry and ignores late replies', async () => {
  const h = harness({ virtualClock: true }); h.c.editOrderId = '58';
  h.c.respond = () => response(savedPacket(1)); await h.c.loadExistingPacket();
  const intent = h.c.submitId, file = { name: 'План.pdf', size: 4, materialRole: 'plan' };
  h.c.attachedFiles.push(file); h.nodes.get('address').value = 'Отправленная правка';
  let release, signal, completed = false;
  h.c.respond = (url, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); };
  h.c.submitForm().then(() => { completed = true; }); await settle();
  const firstPost = h.requests.at(-1); h.nodes.get('address').value = 'Более новая правка в форме';
  assert.match(h.nodes.get('submit-btn').textContent, /Прекратить ожидание/);
  await h.c.submitForm(); await settle();
  assert.equal(completed, true); assert.equal(signal.aborted, true);
  assert.equal(h.c.submitId, intent); assert.equal(h.c.packetRevision, 1); assert.equal(h.c.attachedFiles.length, 1);
  assert.match(h.alerts.at(-1), /может.*сохран|подтвержден/i);
  h.c.respond = (url, options) => options && options.method === 'POST' ? response({ ok: true, id: 58, replayed: true, packet_revision: 2, current_revision: 2 }) : response(savedPacket(2));
  await h.c.submitForm();
  const posts = h.requests.filter(item => item.options && item.options.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[1].options.body, firstPost.options.body);
  assert.equal(posts[1].options.body.entries.find(([name]) => name === 'submit_id')[1], intent);
  assert.equal(posts[1].options.body.entries.find(([name]) => name === 'packet_revision')[1], '1');
  assert.equal(posts[1].options.body.entries.find(([name]) => name === 'address')[1], 'Отправленная правка');
  assert.equal(h.nodes.get('address').value, 'Более новая правка в форме'); assert.equal(h.c.packetRevision, 2);
  assert.equal(h.c.attachedFiles.length, 0);
  release(response({ ok: true, id: 999, packet_revision: 99, current_revision: 99 })); await settle();
  assert.equal(h.c.editOrderId, '58'); assert.equal(h.c.packetRevision, 2); assert.equal(h.timers.size, 0);
});

test('confirmation of a stopped creation retains newer typing as an edit instead of closing the form', async () => {
  const h = harness({ virtualClock: true }); let closed = 0;
  h.c.tg.close = () => { closed++; }; h.nodes.get('address').value = 'Отправленный адрес';
  h.c.respond = () => new Promise(() => {});
  const waiting = h.c.submitForm(); await settle();
  const original = h.requests.at(-1).options.body;
  await h.c.submitForm(); await waiting;
  h.nodes.get('address').value = 'Новый адрес после ожидания';
  h.c.respond = (url, options) => options && options.method === 'POST' ? response({ ok: true, id: 58, packet_revision: 1, current_revision: 1 }) : response(savedPacket(1));
  await h.c.submitForm();
  assert.equal(h.requests.filter(item => item.options && item.options.method === 'POST').at(-1).options.body, original);
  assert.equal(h.c.editOrderId, '58'); assert.equal(h.c.packetRevision, 1);
  assert.equal(h.nodes.get('address').value, 'Новый адрес после ожидания');
  assert.match(h.alerts.at(-1), /Новые правки остались/);
  await h.tick(2000); assert.equal(closed, 0); assert.equal(h.nodes.get('submit-btn').disabled, false);
});

test('stopping during a busy retry countdown performs no further upload and retains the confirmation intent', async () => {
  const h = harness({ virtualClock: true }); let done = false;
  h.c.respond = () => response({ ok: false, busy: true, error: 'Заявка уже отправляется' }, 409);
  const intent = h.c.submitId; h.c.submitForm().then(() => { done = true; }); await settle();
  assert.equal(h.requests.length, 1);
  await h.c.submitForm(); await settle();
  assert.equal(done, true); assert.equal(h.requests.length, 1); assert.equal(h.c.submitId, intent);
  assert.equal(h.timers.size, 0); assert.equal(h.nodes.get('submit-btn').disabled, false);
});

test('an automatic retry never starts with less than a full upload and delivery budget', async () => {
  const h = harness({ virtualClock: true }); let fail, done = false;
  h.c.respond = () => new Promise((resolve, reject) => { fail = reject; });
  h.c.submitForm().then(() => { done = true; }); await settle();
  await h.tick(310000); fail(new Error('Synthetic delayed disconnect')); await settle();
  assert.equal(done, true); assert.equal(h.requests.length, 1);
  assert.equal(h.nodes.get('submit-btn').disabled, false); assert.equal(h.timers.size, 0);
  assert.match(h.alerts.at(-1), /Подтверждение не получено/);
});
