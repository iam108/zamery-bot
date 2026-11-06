const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const materialsModule = require('../src/web/order-materials');
const { createManagerHandlers } = require('../src/web/manager-orders');
const pg = { skip: !process.env.PGLITE_TEST_MODULE, timeout: 10000 };
const fields = ['address','owner_name','object_type','object_name','has_video','zones_info','deadline','contacts','service','cad_num','archive_url','packet_revision'];
const initial = () => ({address:'Москва, Исходная улица, 1',owner_name:'Клиент',object_type:'Общепит алкоголь',service:'Получение',contacts:'Исходный контакт',submit_id:'initial-order'});
const original = (name,content) => ({originalname:name,mimetype:'application/pdf',buffer:Buffer.from(content)});
function response() { return {statusCode:200,headers:{},status(value){this.statusCode=value;return this;},set(key,value){this.headers[key]=value;return this;},json(value){this.body=value;return this;}}; }
function request(order,uid,submitId,changes={}) {
  const body={};for(const field of fields)if(order[field]!=null)body[field]=order[field];
  return {params:{id:String(order.id)},tgUser:{id:uid},staff:{name:'Менеджер '+uid,role:'manager'},files:[],body:{...body,...changes,submit_id:submitId}};
}

async function database(run) {
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();let tail=Promise.resolve();
  const pool={async connect(){const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;return {query:(sql,values)=>values?db.query(sql,values):db.exec(sql).then(results=>results.at(-1)),release};},
    async query(sql,values){const client=await pool.connect();try{return await client.query(sql,values);}finally{client.release();}}};
  try{
    await db.exec(`CREATE TABLE orders(id SERIAL PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT NOW(),address TEXT,owner_name TEXT,object_type TEXT,object_name TEXT,has_video BOOLEAN,zones_info TEXT,deadline DATE,contacts TEXT,submitted_by BIGINT,submitted_name TEXT,status TEXT DEFAULT 'new',telegram_msg_id BIGINT);
      CREATE TABLE logs(order_id INT,action TEXT,actor TEXT,details TEXT);
      CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());`);
    const store=materialsModule.createMaterialsStore(pool),materials={...materialsModule,ensureOrderMaterials:store.ensure,saveOrderMaterials:store.save,saveOrderMaterialsInTransaction:store.saveInTransaction,listOrderMaterials:store.list,markOrderMaterialDelivered:store.delivered};
    function loadQueries(){const context=vm.createContext({module:{exports:{}},require(name){if(name==='./pool')return pool;if(name==='../web/order-materials')return materials;throw new Error('Unexpected dependency '+name);}});vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'),'utf8'),context);return context.module.exports;}
    const queries=loadQueries(),created=await queries.createOrderWithMaterials({...materialsModule.normalizeManagerOrder(initial(),[]),submitted_by:108},[]);
    await pool.query('UPDATE orders SET telegram_msg_id=900,submitted_name=$1 WHERE id=$2',['Исходный автор',created.id]);
    const order=await queries.getOrderById(created.id);
    const counts=async()=>({materials:Number((await pool.query('SELECT COUNT(*) AS n FROM order_materials')).rows[0].n),logs:Number((await pool.query('SELECT COUNT(*) AS n FROM logs')).rows[0].n),receipts:Number((await pool.query('SELECT COUNT(*) AS n FROM order_packet_submissions')).rows[0].n)});
    await run({pool,store,materials,queries,loadQueries,order,counts});
  }finally{await db.close();}
}

test('packet fields, revision, new originals, log and edit receipt roll back together after a database failure',pg,async()=>database(async h=>{
  const file=original('План.pdf',Buffer.from([0,255,128,1,2])),prepared=materialsModule.prepareMaterials([file],['plan']);
  const data=materialsModule.normalizeManagerOrder({...initial(),address:'Москва, Новый адрес, 2'},prepared);
  const options={actorId:109,actorName:'Другой менеджер',submitId:'save-a',signature:'a'.repeat(64),expectedRevision:h.order.packet_revision};
  await h.pool.query("ALTER TABLE logs ADD CONSTRAINT qa_reject_packet_update CHECK(action <> 'packet_updated')");
  await assert.rejects(h.queries.updateOrderPacketWithMaterials(h.order.id,data,prepared,options));
  const unchanged=await h.queries.getOrderById(h.order.id);assert.equal(unchanged.address,h.order.address);assert.equal(unchanged.packet_revision,h.order.packet_revision);
  assert.deepEqual(await h.counts(),{materials:0,logs:0,receipts:0});
  await h.pool.query('ALTER TABLE logs DROP CONSTRAINT qa_reject_packet_update');
  const saved=await h.loadQueries().updateOrderPacketWithMaterials(h.order.id,data,prepared,options);
  assert.equal(saved.replayed,false);assert.equal(saved.saved_revision,Number(h.order.packet_revision)+1);assert.equal(saved.order.packet_revision,saved.saved_revision);
  assert.equal(saved.order.address,data.address);assert.equal(Number(saved.order.submitted_by),108);assert.equal(saved.order.submitted_name,'Исходный автор');
  assert.deepEqual(await h.counts(),{materials:1,logs:1,receipts:1});assert.ok((await h.store.list(h.order.id,true))[0].buffer.equals(file.buffer));
}));

for(const restart of [false,true])test('stale manager inputs and a new original cannot overwrite a later packet or cause delivery, restarted='+restart,pg,async()=>database(async h=>{
  const deliveries=[];let rejectFirstCard=true;
  function handlers(isA=false){return createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:order=>JSON.stringify({address:order.address,contacts:order.contacts}),
    attachOrOrder:()=>assert.fail('No paid EGRN request'),getTelegram:()=>({
      async editMessageText(_chat,_id,_unused,text){deliveries.push({kind:'card',...JSON.parse(text)});if(isA&&rejectFirstCard){rejectFirstCard=false;throw new Error('Synthetic Telegram rejection');}},
      async sendMessage(){assert.fail('Reuse the existing card');},async sendDocument(_chat,file){deliveries.push({kind:'document',name:file.filename});return {message_id:901};},
    })});}
  let managerA=handlers(true);const managerB=handlers(),readA=response(),readB=response();
  await managerA.read(request(h.order,108,''),readA);await managerB.read(request(h.order,109,''),readB);
  assert.equal(readA.body.order.packet_revision,readB.body.order.packet_revision);
  const savedA=request(readA.body.order,108,'save-a',{address:'Москва, Адрес A, 2'}),warningA=response();
  await managerA.save(savedA,warningA);assert.equal(warningA.body.ok,true);assert.match(warningA.body.warning,/сохранены/);
  const latestForB=response();await managerB.read(request(h.order,109,''),latestForB);
  const savedB=request(latestForB.body.order,109,'save-b',{address:'Москва, Новый адрес B, 3',contacts:'Новый контакт B +79995554433'}),resultB=response();
  await managerB.save(savedB,resultB);assert.equal(resultB.body.ok,true);assert.equal(resultB.body.warning,undefined);
  const before=await h.queries.getOrderById(h.order.id),counts=await h.counts(),sent=deliveries.length;
  if(restart)managerA=handlers(true);
  const stale={...savedA,body:{...savedA.body,submit_id:'stale-new-attempt'},files:[original('Устаревший.pdf','must-not-be-added')]},rejected=response();
  await managerA.save(stale,rejected);
  assert.equal(rejected.statusCode,409);assert.equal(rejected.body.ok,false);assert.equal(rejected.body.code,'ORDER_PACKET_CONFLICT');
  const after=await h.queries.getOrderById(h.order.id);assert.equal(after.address,before.address);assert.equal(after.contacts,before.contacts);assert.equal(after.packet_revision,before.packet_revision);
  assert.deepEqual(await h.counts(),counts);assert.equal(deliveries.length,sent,'Stale edits must stop before Telegram or original-file delivery');
}));

test('an exact edit receipt replays after restart against the current row without replacing newer data',pg,async()=>database(async h=>{
  const dataA=materialsModule.normalizeManagerOrder({...initial(),address:'Москва, Адрес A, 2'},[]),optionsA={actorId:108,actorName:'Автор A',submitId:'save-a',signature:'a'.repeat(64),expectedRevision:h.order.packet_revision};
  const savedA=await h.queries.updateOrderPacketWithMaterials(h.order.id,dataA,[],optionsA);
  const dataB=materialsModule.normalizeManagerOrder({...initial(),address:'Москва, Новый адрес B, 3',contacts:'Контакт B'},[]);
  const savedB=await h.loadQueries().updateOrderPacketWithMaterials(h.order.id,dataB,[],{actorId:109,actorName:'Менеджер B',submitId:'save-b',signature:'b'.repeat(64),expectedRevision:savedA.order.packet_revision});
  const counts=await h.counts(),replay=await h.loadQueries().updateOrderPacketWithMaterials(h.order.id,dataA,[],optionsA);
  assert.equal(replay.replayed,true);assert.equal(replay.saved_revision,savedA.saved_revision);assert.equal(replay.order.packet_revision,savedB.order.packet_revision);
  assert.equal(replay.order.address,dataB.address);assert.equal(replay.order.contacts,dataB.contacts);assert.deepEqual(await h.counts(),counts);
  assert.equal(Number(replay.order.submitted_by),108);assert.equal(replay.order.submitted_name,'Исходный автор');
}));

test('a restarted handler replays exact saved intent using the current card and never applies an older EGRN order to a newer cadastral number',pg,async()=>database(async h=>{
  const cards=[],egrn=[];
  function handlers(){return createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:order=>JSON.stringify({address:order.address,cad:order.cad_num}),
    attachOrOrder:async intent=>{egrn.push(intent);return {result:'none'};},getTelegram:()=>({async editMessageText(_chat,_id,_unused,text){cards.push(JSON.parse(text));},async sendMessage(){assert.fail('Reuse the existing card');},async sendDocument(){assert.fail('No new original is allowed');}})});}
  const first=handlers(),intentA=request(h.order,108,'durable-a',{address:'Москва, Адрес A, 2',cad_num:'77:01:0000001:1',egrn_order:'1'}),savedA=response();
  await first.save(intentA,savedA);assert.equal(savedA.body.ok,true);assert.match(savedA.body.warning,/ЕГРН/);
  const current=response(),managerB=handlers();await managerB.read(request(h.order,109,''),current);
  const intentB=request(current.body.order,109,'durable-b',{address:'Москва, Адрес B, 3',cad_num:'77:01:0000001:2'}),savedB=response();
  await managerB.save(intentB,savedB);assert.equal(savedB.body.ok,true);assert.equal(savedB.body.warning,undefined);
  const counts=await h.counts(),calls=egrn.length,restarted=handlers(),replayed=response();
  await restarted.save(intentA,replayed);
  assert.equal(replayed.statusCode,200);assert.equal(replayed.body.replayed,true);assert.equal(replayed.body.packet_revision,savedA.body.packet_revision);assert.equal(replayed.body.current_revision,savedB.body.packet_revision);
  assert.match(replayed.body.warning,/Кадастровый номер.*изменился/);assert.equal(egrn.length,calls,'The old EGRN intent must not request the newer cadastral number');
  assert.deepEqual(cards.at(-1),{address:intentB.body.address,cad:intentB.body.cad_num});assert.deepEqual(await h.counts(),counts);
  const changed={...intentA,body:{...intentA.body,address:'Подмена сохранённого намерения'},files:[original('Подмена.pdf','must-not-store')]},rejected=response(),cardCount=cards.length;
  await handlers().save(changed,rejected);
  assert.equal(rejected.statusCode,409);assert.equal(rejected.body.code,'ORDER_PACKET_SUBMISSION_CONFLICT');assert.equal(cards.length,cardCount);assert.equal(egrn.length,calls);assert.deepEqual(await h.counts(),counts);
  const latest=await h.queries.getOrderById(h.order.id);assert.equal(latest.address,intentB.body.address);assert.equal(latest.cad_num,intentB.body.cad_num);
}));

test('changing the intent behind an existing actor/order/submission key gives a permanent conflict without side effects',pg,async()=>database(async h=>{
  const data=materialsModule.normalizeManagerOrder({...initial(),address:'Москва, Сохранённый адрес, 2'},[]),options={actorId:108,actorName:'Автор A',submitId:'stable-key',signature:'a'.repeat(64),expectedRevision:h.order.packet_revision};
  const saved=await h.queries.updateOrderPacketWithMaterials(h.order.id,data,[],options),counts=await h.counts();
  const prepared=materialsModule.prepareMaterials([original('Подмена.pdf','different-original')],['plan']),changed={...data,address:'Подмена адреса'};
  await assert.rejects(h.loadQueries().updateOrderPacketWithMaterials(h.order.id,changed,prepared,{...options,signature:'c'.repeat(64),expectedRevision:saved.order.packet_revision}),error=>error.status===409&&error.code==='ORDER_PACKET_SUBMISSION_CONFLICT');
  const latest=await h.queries.getOrderById(h.order.id);assert.equal(latest.address,data.address);assert.equal(latest.packet_revision,saved.order.packet_revision);assert.deepEqual(await h.counts(),counts);
}));

test('new edits require a valid baseline revision and an independent actor may reuse the same submission text',pg,async()=>database(async h=>{
  const data=materialsModule.normalizeManagerOrder(initial(),[]),options={actorId:108,actorName:'A',submitId:'same-text',signature:'a'.repeat(64)};
  for(const expectedRevision of [undefined,'',null,0,-1,1.5,'bad'])await assert.rejects(h.queries.updateOrderPacketWithMaterials(h.order.id,data,[],{...options,expectedRevision}),error=>error.status===400&&error.code==='ORDER_PACKET_REVISION_REQUIRED');
  assert.deepEqual(await h.counts(),{materials:0,logs:0,receipts:0});
  const first=await h.queries.updateOrderPacketWithMaterials(h.order.id,data,[],{...options,expectedRevision:h.order.packet_revision});
  const second=await h.loadQueries().updateOrderPacketWithMaterials(h.order.id,{...data,contacts:'Другой автор'},[],{...options,actorId:109,actorName:'B',signature:'b'.repeat(64),expectedRevision:first.order.packet_revision});
  assert.equal(second.replayed,false);assert.equal(second.order.contacts,'Другой автор');assert.deepEqual(await h.counts(),{materials:0,logs:2,receipts:2});
}));

test('a late creation retry after a newer edit confirms the original revision without authorizing stale creation fields',pg,async()=>database(async h=>{
  const latestData=materialsModule.normalizeManagerOrder({...initial(),address:'Москва, Позднее изменение B, 2',contacts:'Новый контакт B'},[]);
  const changed=await h.queries.updateOrderPacketWithMaterials(h.order.id,latestData,[],{actorId:109,actorName:'B',submitId:'later-edit',signature:'b'.repeat(64),expectedRevision:h.order.packet_revision});
  const counts=await h.counts(),cards=[];
  function handlers(){return createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:order=>order.address,attachOrOrder:()=>assert.fail('No paid EGRN call'),
    getTelegram:()=>({sendMessage:()=>assert.fail('No duplicate card'),editMessageText:async(chat,id,unused,text)=>cards.push(text),sendDocument:()=>assert.fail('No new original')})});}
  const createRetry={params:{},tgUser:{id:108},staff:{name:'Переименованный автор',role:'manager'},files:[],body:initial()},replayed=response();
  await handlers().save(createRetry,replayed);
  assert.equal(replayed.body.ok,true);assert.equal(replayed.body.id,h.order.id);assert.equal(replayed.body.replayed,true);
  assert.equal(replayed.body.packet_revision,1);assert.equal(replayed.body.current_revision,changed.order.packet_revision);assert.match(replayed.body.warning,/После него заявку изменил/);
  assert.deepEqual(cards,[latestData.address],'Confirming a creation also repairs the current card from the current row');
  assert.deepEqual(await h.counts(),counts);
  const stale=request(h.order,108,'after-creation-replay',{...initial(),packet_revision:replayed.body.packet_revision}),rejected=response();
  await handlers().save(stale,rejected);assert.equal(rejected.statusCode,409);assert.equal(rejected.body.code,'ORDER_PACKET_CONFLICT');
  const latest=await h.queries.getOrderById(h.order.id);assert.equal(latest.address,latestData.address);assert.equal(latest.contacts,latestData.contacts);assert.equal(Number(latest.submitted_by),108);assert.equal(latest.submitted_name,'Исходный автор');assert.deepEqual(await h.counts(),counts);
}));

test('same-process creation replay rereads the durable receipt and repairs a newer packet whose card update failed',pg,async()=>database(async h=>{
  const cards=[];let reject=false;const make=()=>createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:order=>order.address,attachOrOrder:()=>assert.fail('No provider request'),getTelegram:()=>({async editMessageText(chat,id,unused,text){if(reject)throw new Error('Synthetic Telegram rejection');cards.push(text);},sendMessage(){assert.fail('No second card');},sendDocument(){assert.fail('No new original');}})});
  const a=make(),b=make(),intent={params:{},tgUser:{id:108},staff:{name:'A',role:'manager'},files:[],body:initial()},first=response();await a.save(intent,first);assert.equal(first.body.warning,undefined);
  reject=true;const second=response();await b.save(request(h.order,109,'newer-b',{address:'Москва, New B address'}),second);assert.equal(second.body.ok,true);assert.ok(second.body.warning);reject=false;
  const before=await h.counts(),replay=response();await a.save(intent,replay);
  assert.equal(replay.body.ok,true);assert.equal(replay.body.replayed,true);assert.equal(replay.body.packet_revision,1);assert.equal(replay.body.current_revision,2);assert.match(replay.body.warning,/изменил другой менеджер/);assert.equal(cards.at(-1),'Москва, New B address');assert.equal(cards.length,2);assert.deepEqual(await h.counts(),before);
}));

for(const restart of [false,true])test('exact creation replay resumes EGRN checks but deduplicates ordered and waiting notices, restart='+restart,pg,async()=>database(async h=>{
  const sent=[],cards=[],intents=[];let serial=1000;
  const make=()=>createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),loadOrderReportLink:async()=>null,format:order=>'CARD '+order.address,
    attachOrOrder:async intent=>{intents.push(intent);return{result:intents.length===1?'ordered':'waiting',cad:intent.cad};},getTelegram:()=>({async editMessageText(chat,id,unused,text){cards.push(text);},async sendMessage(chat,text){sent.push({chat,text});return{message_id:++serial,chat:{id:Number(chat)}};}})});
  const intent={params:{},tgUser:{id:108},staff:{name:'A',role:'manager'},files:[],body:{...initial(),submit_id:'egrn-note-create',cad_num:'77:01:0000001:1',egrn_order:'1'}},a=make(),first=response();await a.save(intent,first);assert.equal(first.body.warning,undefined);
  const counts=await h.counts(),second=response();await(restart?make():a).save(intent,second);assert.equal(second.body.warning,undefined);assert.equal(second.body.id,first.body.id);assert.equal(intents.length,2);assert.equal(new Set(intents.map(value=>value.requestKey)).size,1);assert.deepEqual(await h.counts(),counts);
  assert.equal(sent.filter(value=>value.text.startsWith('CARD ')).length,1);assert.equal(sent.filter(value=>!value.text.startsWith('CARD ')).length,1);assert.equal(cards.length,1,'Replay must still refresh the current card');
  const latest=await h.queries.getOrderById(first.body.id);assert.equal(latest.telegram_delivery.card.state,'confirmed');assert.equal(Object.values(latest.telegram_delivery.egrn_notices).length,1);assert.equal(Object.values(latest.telegram_delivery.egrn_notices)[0].state,'confirmed');
}));

for(const fault of ['400','network','500','checkpoint'])test('EGRN informational note '+fault+' preserves safe retry and unknown ACK across restart',pg,async()=>database(async h=>{
  let attempts=0,serial=1200;const sends=[],intents=[];
  const originalQuery=h.pool.query.bind(h.pool);h.pool.query=async(sql,values)=>{if(fault==='checkpoint'&&/jsonb_set/.test(sql)&&String(values?.[2]).includes('"state":"confirmed"')&&attempts===1){throw new Error('Lost note receipt checkpoint');}return originalQuery(sql,values);};
  const make=()=>createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),loadOrderReportLink:async()=>null,format:order=>'CARD '+order.address,
    attachOrOrder:async intent=>{intents.push(intent);return{result:'waiting',cad:intent.cad};},getTelegram:()=>({async editMessageText(){},async sendMessage(chat,text){if(!text.startsWith('CARD ')){attempts++;sends.push(text);if(attempts===1&&fault!=='checkpoint'){const error=new Error('Synthetic note '+fault);if(fault!=='network')error.response={error_code:Number(fault)};throw error;}}return{message_id:++serial,chat:{id:Number(chat)}};}})});
  const intent={params:{},tgUser:{id:108},staff:{name:'A',role:'manager'},files:[],body:{...initial(),submit_id:'egrn-note-fault',cad_num:'77:01:0000001:1'}},first=response();await make().save(intent,first);assert.equal(first.body.ok,true);assert.ok(first.body.warning);
  const counts=await h.counts(),second=response();await make().save(intent,second);assert.equal(second.body.ok,true);assert.equal(second.body.id,first.body.id);assert.deepEqual(await h.counts(),counts);assert.equal(intents.length,2);assert.ok(intents.every(value=>value.order===false));
  assert.equal(attempts,fault==='400'?2:1);assert.equal(sends.length,fault==='400'?2:1);
  if(fault==='400'){assert.equal(second.body.warning,undefined);const third=response();await make().save(intent,third);assert.equal(attempts,2);}
  else assert.match(second.body.warning,/не подтвержден/);
}));

for(const matches of [true,false])test('a username-configured EGRN note validates its returned chat username and remains idempotent, match='+matches,pg,async()=>database(async h=>{
  const notes=[];const make=()=>createManagerHandlers({groupId:'@SyntheticGroup',pool:h.pool,materials:h.materials,queries:h.loadQueries(),loadOrderReportLink:async()=>null,format:order=>order.address,
    attachOrOrder:async intent=>({result:'waiting',cad:intent.cad}),getTelegram:()=>({async editMessageText(){},async sendMessage(chat,text){notes.push({chat,text});return{message_id:1001,chat:{id:-100321,username:matches?'sYNTHETICgROUP':'AnotherGroup'}};}})});
  const intent=request(h.order,108,'username-note',{cad_num:'77:01:0000001:1'}),first=response();await make().save(intent,first);assert.equal(first.body.ok,true);
  if(matches)assert.equal(first.body.warning,undefined);else assert.match(first.body.warning,/не подтвержден/);
  const second=response();await make().save(intent,second);assert.equal(notes.length,1);assert.equal(notes[0].chat,'@SyntheticGroup');
  const current=await h.queries.getOrderById(h.order.id);assert.equal(Object.values(current.telegram_delivery.egrn_notices)[0].state,matches?'confirmed':'unknown');
  if(matches)assert.equal(second.body.warning,undefined);else assert.match(second.body.warning,/не подтвержден/);
}));

test('real manager publication keeps the latest persisted audit link after packet and status changes',pg,async()=>database(async h=>{
  await h.pool.query('INSERT INTO audits(id,order_id,chat_id,msg_ids,created_at) VALUES(1,$1,$2,$3,$4),(2,$1,$2,$5,$6)',[h.order.id,'-1001111111111',[209,201],'2026-11-01T12:00:00Z',[0],'2026-11-02T12:00:00Z']);
  const keyboards=[],handlers=createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:order=>order.address,attachOrOrder:()=>assert.fail('No provider call'),getTelegram:()=>({async editMessageText(chat,id,unused,text,options){keyboards.push(options.reply_markup.inline_keyboard.flat());}})});
  const first=response();await handlers.save(request(h.order,108,'report-edit-1',{address:'Москва, Новый адрес'}),first);assert.equal(first.body.warning,undefined);assert.equal(keyboards[0].find(button=>button.url).url,'https://t.me/c/1111111111/209');
  await h.pool.query("UPDATE orders SET status='cancelled' WHERE id=$1",[h.order.id]);await h.pool.query('INSERT INTO audits VALUES(3,$1,$2,$3,$4)',[h.order.id,'-1001111111111',[300],'2026-11-03T12:00:00Z']);
  const current=await h.queries.getOrderById(h.order.id),second=response();await handlers.save(request(current,108,'report-edit-2',{address:'Москва, Финальный адрес'}),second);
  assert.equal(second.body.warning,undefined);assert.deepEqual(keyboards[1],[{text:'Перейти к отчёту',url:'https://t.me/c/1111111111/300'}]);
}));
