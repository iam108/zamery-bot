const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const LIMIT = 50 * 1024 * 1024;

function harness({ docs = [], urls = [], downloadedSize = 10, sendError, orderFields = {}, statusRequest, linkError, staffAllowed = true, renewFile, renewError } = {}) {
  const queries = [];
  const sent = [];
  const notices = [];
  const logs = [];
  const linkCalls = [], linkCopies = [], actions = [], renewed = [], apiCalls = [];
  const order = { id: 1, id_statement: 42, cad_num: '77:17:0120316:1', status: 'done',
    status_text: 'готова', polls: 1, chat_id: 10, ordered_by: 10, deliver: [], files_sent: 0, ...orderFields };
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    if(sql.startsWith('SELECT 1 FROM staff'))return{rows:staffAllowed?[{approved:true}]:[]};
    if (sql.startsWith('UPDATE egrn_orders SET files_sent=$1')) {
      Object.assign(order, { files_sent: params[0], file_msgs: JSON.parse(params[1]), error: params[2] });
      if (sql.includes('failures=$4')) Object.assign(order, { failures: params[3], retry_at: params[4] });
    }
    if (sql.startsWith('SELECT * FROM egrn_orders WHERE cad_num=')) return { rows: [order] };
    return { rows: sql.startsWith('SELECT * FROM egrn_orders') && order.files_sent === 0 &&
      (!order.retry_at || order.retry_at <= Date.now()) ? [order] : [] };
  } };
  let poll;
  const context = {
    module: { exports: {} },
    require: (name) => {
      if (name === '../db/pool') return pool;
      if (name === './formatter') return { esc: String };
      if(name === './egrn-files')return{async get(id){renewed.push(id);if(renewError)throw renewError;return renewFile||null;}};
      if(name === '../web/egrn-downloads')return{createDownloadUrl:id=>'https://bot.example.test/egrn-files/'+id+'/download?exp=fresh&sig=test'};
      if(name === './order-evidence')return{async registerCached(targets,files){renewed.push({targets,files});return{};}};
      if (name === './egrn-large-delivery') return { createLargeDelivery({persist}) { return {
        async deliver(o,file,key,records) {
          linkCalls.push({file,key});
          const failure=typeof linkError==='function'?linkError():linkError;if(failure)throw failure;
          const record={kind:'link',key,original_id:'saved-large-file',name:file.name,bytes:file.buf?file.buf.length:file.bytes,deliveries:[]};
          records.push(record);await persist(o,records);return record;
        },
        async retry(o,record,records) { const failure=typeof linkError==='function'?linkError():linkError;if(failure)throw failure;linkCalls.push({retry:record.original_id});await persist(o,records);return record; },
        async copy(record,target) { linkCopies.push({record,target});const failure=typeof linkError==='function'?linkError():linkError;if(failure)throw failure;return {message_id:123}; }
      }; } };

      throw new Error('Unexpected require: ' + name);
    },
    Buffer, process: { env: { EGRN_TOKEN: 'test', EGRN_DECLARANT_ID: '1' } },
    console: { error(...args) { logs.push(args); } },
    fetch(){apiCalls.push('forbidden');throw new Error('Unexpected paid API request');},
    setTimeout: (fn) => { poll = fn; }, setInterval() {},
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../src/bot/egrn.js'), 'utf8');
  vm.runInContext(source + '\nmodule.exports.testHooks = { checkDocumentSize, documentTooLarge, configure: function(docs, urls, size) {' +
    ' apiStatus = async function() { return {}; };' +
    ' readStatus = function() { return { done: true, failed: false, text: "готова" }; };' +
    ' extractDocs = function() { return docs; }; findFileUrls = function() { return urls; };' +
    ' download = async function() { return { buf: { length: size }, name: "download.pdf" }; };' +
    ' }, setStatusRequest: function(fn) { apiStatus = fn; } };', context);
  const hooks = context.module.exports.testHooks;
  hooks.configure(docs, urls, downloadedSize);
  if (statusRequest) hooks.setStatusRequest(statusRequest);
  const bot = { on() {}, hears() {}, action(pattern,handler) {actions.push({pattern,handler});}, command() {}, telegram: {
    sendDocument: async (chat, file) => {
      sent.push(file);
      const error = typeof sendError === 'function' ? sendError(file) : sendError;
      if (error) throw error;
      return { message_id: sent.length };
    },
    sendMessage: async (chat, text) => { notices.push({ chat, text }); },
    editMessageText: async (...args) => { notices.push({ edit: args }); },
    callApi: async () => {},
  } };
  context.module.exports.setupEgrn(bot);
  return { hooks, sent, queries, order, notices, logs, linkCalls, linkCopies, renewed, apiCalls, actions, poll: () => poll(), attachOrOrder: context.module.exports.attachOrOrder,
    deliveries: () => queries.filter(q => q.sql.startsWith('UPDATE egrn_orders SET files_sent=$1')) };
}

function doc(size, name = 'statement.pdf') {
  return { buf: { length: size }, name, kind: 'pdf' };
}

test('size boundary: allowed at limit, rejected above limit', () => {
  const { hooks } = harness();
  assert.doesNotThrow(() => hooks.checkDocumentSize({ length: LIMIT }));
  assert.throws(() => hooks.checkDocumentSize({ length: LIMIT + 1 }),
    err => err.code === 'EGRN_DOCUMENT_TOO_LARGE');
});

test('recognizes Telegraf and plain HTTP 413 without matching unrelated numbers', () => {
  const { hooks } = harness();
  assert.equal(hooks.documentTooLarge({ response: { error_code: 413 } }), true);
  assert.equal(hooks.documentTooLarge(new Error('413: Request Entity Too Large')), true);
  assert.equal(hooks.documentTooLarge({ code: 413 }), true);
  assert.equal(hooks.documentTooLarge(new Error('download 500 for order 413')), false);
});

test('oversized embedded document is saved and delivered as a link', async () => {
  const h = harness({ docs: [doc(LIMIT + 1)] });
  await h.poll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.order.files_sent, 1);
  assert.equal(h.order.file_msgs[0].kind,'link');
  assert.equal(h.linkCalls[0].file.buf.length,LIMIT+1);
});

test('oversized downloaded document is delivered as a link', async () => {
  const h = harness({ urls: ['https://example.test/file.pdf'], downloadedSize: LIMIT + 1 });
  await h.poll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.order.files_sent, 1);
  assert.equal(h.order.file_msgs[0].kind,'link');
});

test('Telegram 413 falls back to a saved link when local size check passed', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('413: Request Entity Too Large') });
  await h.poll();
  assert.equal(h.sent.length, 1);
  assert.equal(h.order.files_sent, 1);
  assert.equal(h.order.file_msgs[0].kind,'link');
});

test('downloaded document also handles structured Telegram 413', async () => {
  const h = harness({ urls: ['https://example.test/file.pdf'],
    sendError: { message: 'Request Entity Too Large', response: { error_code: 413 } } });
  await h.poll();
  assert.equal(h.order.files_sent, 1);
  assert.equal(h.order.file_msgs[0].kind,'link');
});

test('temporary upload failure remains eligible for retry', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('502: Bad Gateway') });
  await h.poll();
  const params = h.deliveries()[0].params;
  assert.equal(params[0], 0);
  assert.equal(params[3], 1);
  assert.ok(params[4] > Date.now());
  assert.equal(h.notices.length, 0);
});

test('ordinary delivery succeeds and clears stale errors', async () => {
  const h = harness({ docs: [doc(10)] });
  await h.poll();
  assert.equal(h.deliveries()[0].params[0], 1);
  assert.equal(h.deliveries()[0].params[2], null);
});

test('mixed large and small documents retain a link and normal Telegram metadata', async () => {
  const h = harness({ docs: [doc(LIMIT + 1), doc(10)] });await h.poll();
  assert.equal(h.order.files_sent,2);assert.equal(h.order.file_msgs[0].kind,'link');
  assert.equal(h.order.file_msgs[1].key,'embedded:1:statement.pdf');assert.equal(h.sent.length,1);
});

test('failed large-link delivery is retried without another paid order',async()=>{
  const h=harness({docs:[doc(LIMIT+1)],linkError:new Error('Storage temporarily unavailable')});
  await h.poll();assert.equal(h.order.files_sent,0);assert.equal(h.order.failures,1);assert.equal(h.notices.length,0);
  assert.equal(h.queries.some(q=>q.sql.includes('INSERT INTO egrn_orders')),false);
});

test('file logs contain order, statement, filename and bytes', async () => {
  const h = harness({ docs: [doc(LIMIT + 1, 'large.pdf')],linkError:new Error('Storage unavailable') });
  await h.poll();
  const log = JSON.parse(h.logs.find(entry => entry[0] === 'egrn file:')[1]);
  assert.equal(log.order_id, 1);
  assert.equal(log.id_statement, 42);
  assert.equal(log.filename, 'large.pdf');
  assert.equal(log.bytes, LIMIT + 1);
});

test('fifth consecutive failure stops delivery and notifies once', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('502: Bad Gateway') });
  const delays = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = Date.now();
    await h.poll();
    if (attempt < 5) delays.push(h.order.retry_at - before);
    h.order.retry_at = null; // Simulate the next eligible poll.
  }
  assert.equal(h.order.files_sent, -1);
  assert.equal(h.order.failures, 5);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].text, /нескольких попыток/);
  for (let i = 0; i < delays.length; i++) {
    assert.ok(Math.abs(delays[i] - 180000 * Math.pow(2, i)) < 1000);
  }
  await h.poll();
  assert.equal(h.sent.length, 5);
});

test('retry deadline prevents premature resend', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('502: Bad Gateway') });
  await h.poll();
  await h.poll();
  assert.equal(h.sent.length, 1);
  assert.ok(h.queries.some(q => q.sql.includes('retry_at <= NOW()')));
});

test('partial transient failure retries only the unsent document', async () => {
  let fail = true;
  const h = harness({ docs: [doc(10, 'first.pdf'), doc(10, 'second.pdf')],
    sendError: file => fail && file.filename === 'second.pdf' ? new Error('502: Bad Gateway') : null });
  await h.poll();
  assert.equal(h.order.files_sent, 0);
  assert.equal(h.order.file_msgs.length, 1);
  fail = false;
  h.order.retry_at = null;
  await h.poll();
  assert.deepEqual(h.sent.map(f => f.filename), ['first.pdf', 'second.pdf', 'second.pdf']);
  assert.equal(h.order.files_sent, 2);
  assert.equal(h.order.error, null);
});

test('status request failures are bounded and report checking failure accurately', async () => {
  const h = harness({ orderFields: { failures: 4, status: 'ordered' },
    statusRequest: async () => { throw new Error('terminated'); } });
  await h.poll();
  assert.equal(h.order.files_sent, -1);
  assert.equal(h.order.failures, 5);
  assert.match(h.notices[0].text, /Не удалось проверить готовность/);
});

test('overlapping polls share one in-flight request and release the guard afterward', async () => {
  let release;
  let calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ docs: [doc(10)], statusRequest: async () => { calls++; await blocked; return {}; } });
  const first = h.poll();
  await new Promise(resolve => setImmediate(resolve));
  await h.poll();
  assert.equal(calls, 1);
  release();
  await first;
  h.order.files_sent = 0;
  await h.poll();
  assert.equal(calls, 2);
});

test('guard is released after status request failure', async () => {
  let calls = 0;
  const h = harness({ statusRequest: async () => { calls++; throw new Error('terminated'); } });
  await h.poll();
  h.order.retry_at = null;
  await h.poll();
  assert.equal(calls, 2);
});

test('stopped delivery does not create a second paid order from a form', async () => {
  const h = harness({ orderFields: { files_sent: -1 } });
  const result = await h.attachOrOrder({ cad: '77:17:0120316:1', order: true });
  assert.equal(result.result, 'unavailable');
  assert.equal(result.id, 42);
  assert.equal(h.queries.some(q => q.sql.includes('INSERT INTO egrn_orders')), false);
});

test('ready status without files uses the same bounded retry policy', async () => {
  const h = harness({ orderFields: { failures: 4 } });
  await h.poll();
  assert.equal(h.order.files_sent, -1);
  assert.match(h.order.error, /файлы не найдены/);
  assert.equal(h.notices.length, 1);
});

test('a stored large file resumes delivery without downloading the original again',async()=>{
  const key='embedded:0:statement.pdf',record={kind:'link',key,original_id:'saved-large-file',name:'statement.pdf',bytes:100*1024*1024};
  const h=harness({orderFields:{file_msgs:[record],delivery_manifest:[key]},statusRequest:async()=>assert.fail('No provider re-download after storage succeeded')});
  await h.poll();assert.equal(h.order.files_sent,1);assert.equal(h.linkCalls[0].retry,'saved-large-file');
});

test('reusing a saved large file after a notification failure does not create a second order',async()=>{
  const key='embedded:0:statement.pdf',record={kind:'link',key,original_id:'saved-large-file',name:'statement.pdf',bytes:100*1024*1024};
  const h=harness({orderFields:{files_sent:-1,file_msgs:[record],delivery_manifest:[key]}});
  const result=await h.attachOrOrder({cad:'77:17:0120316:1',order:true,targets:[{chat:20,reply:9}]});
  assert.equal(result.result,'attached');assert.equal(h.linkCopies.length,1);
  assert.equal(h.queries.some(q=>q.sql.includes('INSERT INTO egrn_orders')),false);
});

test('failed copying of a saved link is reported instead of claiming successful attachment',async()=>{
  const key='embedded:0:statement.pdf',record={kind:'link',key,original_id:'saved-large-file',name:'statement.pdf',bytes:100*1024*1024};
  const h=harness({orderFields:{files_sent:1,file_msgs:[record]},linkError:new Error('Temporary link delivery failure')});
  await assert.rejects(h.attachOrOrder({cad:'77:17:0120316:1',order:true,targets:[{chat:20}]}),/Temporary link delivery failure/);
  assert.equal(h.queries.some(q=>q.sql.includes('INSERT INTO egrn_orders')),false);
});


test('mixed cached link and native PDF still attaches the native original to the request',async()=>{
  const record={kind:'link',key:'large',original_id:'saved-large-file',name:'large.pdf',bytes:100*1024*1024};
  const native={key:'small',chat:10,id:3,file_id:'native-file',name:'small.pdf',bytes:100};
  const h=harness({orderFields:{files_sent:2,file_msgs:[record,native]}});
  const result=await h.attachOrOrder({cad:'77:17:0120316:1',order:true,targets:[{chat:20,order_id:99}]});
  assert.equal(result.result,'attached');assert.equal(h.linkCopies.length,1);
  assert.deepEqual(h.renewed[0].files,[native]);assert.equal(h.apiCalls.length,0);
});

for(const allowed of [true,false])test('refresh link '+(allowed?'creates a new link without ordering':'denies an unapproved caller before reading a file'),async()=>{
  const id='11111111-1111-5111-8111-111111111111';
  const h=harness({staffAllowed:allowed,renewFile:{id,bytes:100*1024*1024}}),edits=[],answers=[];
  const action=h.actions.find(value=>value.pattern.test('egf:'+id));assert.ok(action);
  await action.handler({from:{id:42},match:['egf:'+id,id],callbackQuery:{message:{chat:{id:10}}},async editMessageReplyMarkup(value){edits.push(value);},async answerCbQuery(text){answers.push(text);}});
  assert.equal(h.apiCalls.length,0);
  assert.equal(edits.length,allowed?1:0);assert.equal(h.renewed.length,allowed?1:0);
  if(allowed){assert.match(edits[0].inline_keyboard[0][0].url,/exp=fresh/);assert.equal(edits[0].inline_keyboard[1][0].callback_data,'egf:'+id);}
  else assert.match(answers[0],/Нет доступа/);
});

test('refresh failures never expose provider URLs or credentials',async()=>{
  const id='11111111-1111-5111-8111-111111111111',h=harness({renewError:new Error('https://private.example?token=secret')}),answers=[];
  const action=h.actions.find(value=>value.pattern.test('egf:'+id));
  await action.handler({from:{id:42},match:['egf:'+id,id],callbackQuery:{message:{chat:{id:10}}},async editMessageReplyMarkup(){assert.fail('No usable link exists');},async answerCbQuery(text){answers.push(text);}});
  assert.match(answers[0],/Не удалось обновить/);assert.doesNotMatch(answers[0],/https|secret|token/);assert.equal(h.apiCalls.length,0);
});

test('migration recovers only recent ready size failures, including structured Telegram errors',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();
  const h=harness();await h.poll();
  const ddl=h.queries.find(value=>value.sql.includes('CREATE TABLE IF NOT EXISTS egrn_orders')).sql;
  try{
    await db.exec(ddl);
    for(const [error,status,age] of [['Файл слишком большой для Telegram: 100000000 байт','done',1],['413: Request Entity Too Large','done',1],['Request Entity Too Large','done',1],['502; 413: Request Entity Too Large','done',1],['download 500 for order 413','done',1],['502 Bad Gateway','done',1],['413: Request Entity Too Large','failed',1],['413: Request Entity Too Large','done',31],['Файл выписки превышает 200 МБ.','done',1],['Файл выписки превышает 200 МБ.','done',31],['Файл выписки превышает 200 МБ.','failed',1],['Случайная ошибка 200 МБ.','done',1]])
      await db.query("INSERT INTO egrn_orders(cad_num,type_doc,error,status,files_sent,created_at) VALUES('77:01:0000000:1','kvarmrusxmlpdf',$1,$2,-1,NOW()-$3::int*INTERVAL '1 day')",[error,status,age]);
    await db.exec(ddl);
    assert.deepEqual((await db.query('SELECT files_sent FROM egrn_orders ORDER BY id')).rows.map(row=>row.files_sent),[0,0,0,0,-1,-1,-1,-1,0,-1,-1,-1]);
  }finally{await db.close();}
});

test('poll delivers a streamed file over 200 MiB without assembling a buffer and always cleans the source',async()=>{
  let cleaned=0, opened=0;
  const file={name:'large.pdf',bytes:300*1024*1024,sha256:'a'.repeat(64),open(){opened++;throw new Error('The poller must pass the lazy source directly to storage');}};
  const source={item:{id_req:42,status:[]},hasFiles:true,async documents(){return[file];},async cleanup(){cleaned++;}};
  const h=harness({statusRequest:async()=>source});await h.poll();
  assert.equal(h.order.files_sent,1);assert.equal(h.sent.length,0);assert.equal(h.linkCalls[0].file,file);
  assert.equal(cleaned,1);assert.equal(opened,0);assert.equal(h.apiCalls.length,0);
  assert.equal(h.queries.some(q=>q.sql.includes('INSERT INTO egrn_orders')),false);
});

test('streamed delivery failure keeps a retry and releases its temporary source',async()=>{
  let cleaned=0;
  const file={name:'large.pdf',bytes:300*1024*1024,sha256:'a'.repeat(64),open(){throw new Error('Not expected');}};
  const h=harness({statusRequest:async()=>({item:{id_req:42,status:[]},hasFiles:true,async documents(){return[file];},async cleanup(){cleaned++;}}),linkError:new Error('Temporary storage failure')});
  await h.poll();assert.equal(h.order.files_sent,0);assert.equal(h.order.failures,1);assert.equal(cleaned,1);assert.equal(h.sent.length,0);assert.equal(h.apiCalls.length,0);
});

test('small streamed PDF keeps native Telegram delivery',async()=>{
  let cleaned=0;
  const bytes=Buffer.from('%PDF-1.7\nsmall');
  const file={name:'small.pdf',bytes:bytes.length,open:async function*(){yield bytes.subarray(0,5);yield bytes.subarray(5);}};
  const h=harness({statusRequest:async()=>({item:{id_req:42,status:[]},hasFiles:true,async documents(){return[file];},async cleanup(){cleaned++;}})});
  await h.poll();assert.equal(h.order.files_sent,1);assert.equal(h.sent.length,1);assert.deepEqual(h.sent[0].source,bytes);assert.equal(cleaned,1);assert.equal(h.linkCalls.length,0);
});

test('document extraction errors release the private temporary files without delivering success',async()=>{
  let cleaned=0;
  const h=harness({statusRequest:async()=>({item:{id_req:42,status:[]},hasFiles:true,async documents(){throw new Error('Interrupted file');},async cleanup(){cleaned++;}})});
  await h.poll();assert.equal(cleaned,1);assert.equal(h.order.files_sent,0);assert.equal(h.sent.length,0);assert.equal(h.linkCalls.length,0);assert.equal(h.apiCalls.length,0);
});
