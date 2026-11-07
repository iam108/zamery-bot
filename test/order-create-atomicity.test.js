const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const materialsModule = require('../src/web/order-materials');
const { createManagerHandlers } = require('../src/web/manager-orders');
const pg = { skip: !process.env.PGLITE_TEST_MODULE, timeout: 10000 };

const input = () => ({ address:'Москва, Тестовая улица, 12',owner_name:'Клиент',object_type:'Общепит алкоголь',service:'Получение',submit_id:'atomic-order-1',contacts:'Контакт' });
const original = (name, content) => ({ originalname:name,mimetype:'application/pdf',buffer:Buffer.from(content) });

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  let tail = Promise.resolve(), active = 0, maximum = 0;
  // An exclusive single-connection pool detects nested pool leases and keeps
  // independent concurrent callers from accidentally sharing a transaction.
  const pool = {
    async connect() {
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; }); await previous;
      active++; maximum = Math.max(maximum, active);
      return { query:(sql, values) => values ? db.query(sql, values) : db.exec(sql).then(results => results.at(-1)), release() { active--; release(); } };
    },
    async query(sql, values) { const client = await pool.connect(); try { return await client.query(sql, values); } finally { client.release(); } },
  };
  try {
    await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
      INSERT INTO staff VALUES(108,'Исходный автор','manager',true);
      CREATE TABLE orders(id SERIAL PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT NOW(),address TEXT,owner_name TEXT,object_type TEXT,object_name TEXT,has_video BOOLEAN,zones_info TEXT,deadline DATE,contacts TEXT,submitted_by BIGINT,submitted_name TEXT,status TEXT DEFAULT 'new',telegram_msg_id BIGINT);
      CREATE TABLE logs(order_id INT,action TEXT,actor TEXT,details TEXT);
      CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());`);
    const store = materialsModule.createMaterialsStore(pool);
    const materials = { ...materialsModule,ensureOrderMaterials:store.ensure,saveOrderMaterials:store.save,saveOrderMaterialsInTransaction:store.saveInTransaction,listOrderMaterials:store.list,markOrderMaterialDelivered:store.delivered };
    const loadQueries = () => {
      const context = vm.createContext({ module:{exports:{}},require(name) {
        if (name === './pool') return pool;
        if (name === '../web/order-materials') return materials;
        throw new Error('Unexpected dependency ' + name);
      } });
      vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'), 'utf8'), context);
      return context.module.exports;
    };
    await run({ db,pool,store,materials,queries:loadQueries(),loadQueries,get maximum(){return maximum;} });
  } finally { await db.close(); }
}

test('failed original storage rolls back the new order and permits a corrected full retry with the same submission id', pg, async () => fixture(async h => {
  await h.store.ensure();
  await h.pool.query("ALTER TABLE order_materials ADD CONSTRAINT qa_reject_original CHECK(name <> 'Отказ.pdf')");
  let cards = 0, documents = 0;
  const handlers = createManagerHandlers({ groupId:'-100321',materials:h.materials,queries:h.queries,pool:h.pool,format:()=>'Synthetic order',attachOrOrder:()=>assert.fail('No paid EGRN request'),
    getTelegram:()=>({
      async sendMessage() {
        const count = (await h.pool.query('SELECT COUNT(*) AS n FROM order_materials')).rows[0].n;
        assert.equal(Number(count),2,'A card may be sent only after both originals committed');
        cards++; return {message_id:900};
      },
      async sendDocument(_chat, file) { assert.ok(Buffer.isBuffer(file.source)); documents++; return {message_id:900+documents}; },
    }),
  });
  const request = { params:{},tgUser:{id:108},staff:{name:'Исходный автор',role:'manager'},body:input(),files:[original('План.pdf','%PDF-plan-exact'),original('Отказ.pdf','%PDF-second-exact')] };
  const response = () => ({statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
  const failed=response(); await handlers.save(request,failed);
  assert.equal(failed.body.ok,false);assert.equal(failed.body.id,undefined);
  assert.equal(Number((await h.pool.query('SELECT COUNT(*) AS n FROM orders')).rows[0].n),0);
  assert.equal(Number((await h.pool.query('SELECT COUNT(*) AS n FROM order_materials')).rows[0].n),0);
  assert.equal(cards,0);assert.equal(documents,0);
  await h.pool.query('ALTER TABLE order_materials DROP CONSTRAINT qa_reject_original');
  request.body.address='Москва, Исправленная улица, 12';
  const retried=response(); await handlers.save(request,retried);
  assert.equal(retried.body.ok,true);assert.equal(retried.body.warning,undefined);
  const duplicate=response(); await handlers.save(request,duplicate);
  assert.equal(duplicate.body.id,retried.body.id);assert.equal(cards,1);assert.equal(documents,2);
  const orders=(await h.pool.query('SELECT * FROM orders')).rows;assert.equal(orders.length,1);
  assert.equal(orders[0].address,request.body.address);assert.equal(Number(orders[0].submitted_by),108);assert.equal(orders[0].submitted_name,'Исходный автор');
  const stored=await h.store.list(orders[0].id,true);assert.equal(stored.length,2);
  for(const file of request.files)assert.ok(stored.find(item=>item.name===file.originalname).buffer.equals(file.buffer));
  assert.equal(h.maximum,1);
}));

test('a lost original-card ACK stays unknown across restarted manager forms and only reviewed recovery permits a new POST', pg, async () => fixture(async h => {
  let accepted = 0, loseAck = true;
  const telegram = { async sendMessage() { accepted++; if (loseAck) throw new Error('Synthetic lost ACK after accepting card'); return { message_id: 900 + accepted }; }, async editMessageText() {} };
  const handlers = () => createManagerHandlers({ groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:()=> 'Synthetic card',getTelegram:()=>telegram,attachOrOrder:()=>assert.fail('No provider call') });
  const req = { params:{},tgUser:{id:108},staff:{name:'Автор',role:'manager'},body:input(),files:[] };
  const response = () => ({ status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;} });
  const first=response();await handlers().save(req,first);assert.equal(first.body.ok,true);assert.match(first.body.warning,/могло дойти/);assert.doesNotMatch(first.body.warning,/Карточка не доставлена/);
  loseAck=false;const retry=response();await handlers().save(req,retry);assert.equal(retry.body.id,first.body.id);assert.match(retry.body.warning,/Автоматический повтор остановлен/);assert.equal(accepted,1);
  assert.equal(Number((await h.pool.query('SELECT COUNT(*) AS n FROM orders')).rows[0].n),1);
  const delivery=require('../src/web/order-telegram-delivery').createOrderTelegramDelivery({pool:h.pool,groupId:'-100321',ready:h.store.ensure});
  const preview=await delivery.preview(first.body.id);assert.equal(preview.slots[0].slot,'card');
  await delivery.allowRetry(first.body.id,'card',{actorId:108,messageId:200,expectedGeneration:preview.slots[0].generation});
  const recovered=response();await handlers().save(req,recovered);assert.equal(recovered.body.warning,undefined);assert.equal(accepted,2);
  await handlers().save(req,response());assert.equal(accepted,2);
}));

test('a real SQL card receipt failure cannot be mistaken for an unsent card on the next manager request',pg,async()=>fixture(async h=>{
  await h.store.ensure();await h.pool.query('ALTER TABLE orders ADD CONSTRAINT qa_no_card_receipt CHECK(telegram_msg_id IS NULL)');
  let accepted=0;const handlers=()=>createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:()=> 'Synthetic card',attachOrOrder:()=>assert.fail('No provider call'),getTelegram:()=>({async sendMessage(){accepted++;return{message_id:900};}})});
  const req={params:{},tgUser:{id:108},staff:{name:'Автор',role:'manager'},body:input(),files:[]},response=()=>({status(){return this;},json(body){this.body=body;return this;}});
  const first=response();await handlers().save(req,first);assert.match(first.body.warning,/могло дойти/);
  await h.pool.query('ALTER TABLE orders DROP CONSTRAINT qa_no_card_receipt');
  const second=response();await handlers().save(req,second);assert.equal(accepted,1);assert.match(second.body.warning,/Автоматический повтор остановлен/);
  const saved=(await h.pool.query('SELECT * FROM orders')).rows[0];assert.equal(saved.telegram_msg_id,null);assert.equal(saved.telegram_delivery.card.state,'sending');
}));

test('manager file receipt failure preserves unknown per-file state while reordered pending and confirmed originals keep their own receipts',pg,async()=>fixture(async h=>{
  await h.store.ensure();await h.pool.query("ALTER TABLE order_materials ADD CONSTRAINT qa_no_first_receipt CHECK(telegram_msg_id IS NULL OR name <> 'А.pdf')");
  let sequence=900;const sent=[];
  const telegram={async sendMessage(){return{message_id:sequence++};},async editMessageText(){},async sendDocument(_chat,file){sent.push(file.filename);return{message_id:sequence++};}};
  const handlers=()=>createManagerHandlers({groupId:'-100321',pool:h.pool,materials:h.materials,queries:h.loadQueries(),format:()=> 'Synthetic card',getTelegram:()=>telegram,attachOrOrder:()=>assert.fail('No provider call')});
  const req={params:{},tgUser:{id:108},staff:{name:'Автор',role:'manager'},body:input(),files:[original('А.pdf','A bytes'),original('Б.pdf','B bytes')]},response=()=>({status(){return this;},json(body){this.body=body;return this;}});
  const first=response();await handlers().save(req,first);assert.match(first.body.warning,/могло дойти/);assert.deepEqual([...sent].sort(),['А.pdf','Б.pdf']);
  await h.pool.query('ALTER TABLE order_materials DROP CONSTRAINT qa_no_first_receipt');
  // Reopening the saved packet carries no uploads and may return originals in
  // another order; only an explicit reviewed retry can reopen the missing ACK.
  const row=(await h.pool.query('SELECT * FROM orders')).rows[0],edit={...req,params:{id:String(row.id)},files:[],body:{...input(),submit_id:'saved-packet-retry',packet_revision:row.packet_revision}};
  const later=response();await handlers().save(edit,later);assert.equal(sent.length,2);assert.match(later.body.warning,/Автоматический повтор остановлен/);
  const files=await h.store.list(row.id,true);assert.equal(files.find(file=>file.name==='А.pdf').telegram_msg_id,null);assert.ok(files.find(file=>file.name==='Б.pdf').telegram_msg_id);
  const delivery=require('../src/web/order-telegram-delivery').createOrderTelegramDelivery({pool:h.pool,groupId:'-100321',ready:h.store.ensure});
  const pending=(await delivery.preview(row.id)).slots;assert.equal(pending.length,1);assert.equal(pending[0].name,'А.pdf');
  await delivery.allowRetry(row.id,pending[0].slot,{actorId:108,messageId:300,expectedGeneration:pending[0].generation});
  const recovered=response();await handlers().save(edit,recovered);assert.equal(recovered.body.warning,undefined);assert.deepEqual(sent.filter(name=>name==='Б.pdf'),['Б.pdf']);assert.equal(sent.filter(name=>name==='А.pdf').length,2);
}));

test('the aggregate originals limit rolls back a new order after storage validation fails', pg, async () => fixture(async h => {
  const prepared=Array.from({length:21},(_,index)=>materialsModule.prepareMaterials([original('Документ-'+index+'.pdf','exact-'+index)],['document'])[0]);
  const payload={...materialsModule.normalizeManagerOrder(input(),prepared),submitted_by:108};
  await assert.rejects(h.queries.createOrderWithMaterials(payload,prepared),/до 20 файлов/);
  assert.equal(Number((await h.pool.query('SELECT COUNT(*) AS n FROM orders')).rows[0].n),0);
  assert.equal(Number((await h.pool.query('SELECT COUNT(*) AS n FROM order_materials')).rows[0].n),0);
  const valid=prepared.slice(0,2), corrected={...materialsModule.normalizeManagerOrder(input(),valid),submitted_by:108};
  const order=await h.queries.createOrderWithMaterials(corrected,valid);
  assert.equal((await h.store.list(order.id,true)).length,2);assert.equal(h.maximum,1);
}));

test('independent concurrent duplicate requests create one order and preserve exact original bytes', pg, async () => fixture(async h => {
  const binary=Buffer.concat([Buffer.from('%PDF-ORIGINAL-'),Buffer.from([0,255,128,10])]);
  const prepared=materialsModule.prepareMaterials([original('План.pdf',binary),original('Выписка.pdf','%PDF-EGRN-exact')],['plan','egrn']);
  const payload={...materialsModule.normalizeManagerOrder(input(),prepared),submitted_by:108};
  const otherProcess=h.loadQueries();
  const [a,b]=await Promise.all([h.queries.createOrderWithMaterials(payload,prepared),otherProcess.createOrderWithMaterials(payload,prepared)]);
  assert.equal(a.id,b.id);assert.equal(Number((await h.pool.query('SELECT COUNT(*) AS n FROM orders')).rows[0].n),1);
  const stored=await h.store.list(a.id,true);assert.equal(stored.length,2);
  for(const file of prepared){const result=stored.find(item=>item.id===file.id);assert.equal(result.sha256,file.sha256);assert.equal(result.role,file.role);assert.ok(result.buffer.equals(file.buffer));}
  assert.equal(h.maximum,1);
}));

test('changed creation intent cannot overwrite an existing order, its author, or its originals', pg, async () => fixture(async h => {
  const prepared=materialsModule.prepareMaterials([original('Исходный.pdf','original-intact')],['plan']);
  const payload={...materialsModule.normalizeManagerOrder(input(),prepared),submitted_by:108};
  const order=await h.queries.createOrderWithMaterials(payload,prepared);
  await h.pool.query('UPDATE orders SET submitted_name=$1 WHERE id=$2',['Первый автор',order.id]);
  const changedFiles=materialsModule.prepareMaterials([original('Подмена.pdf','different-bytes')],['egrn']);
  const changed={...materialsModule.normalizeManagerOrder({...input(),address:'Подменённый адрес'},changedFiles),submitted_by:108};
  await assert.rejects(h.loadQueries().createOrderWithMaterials(changed,changedFiles),/с другими данными/);
  await h.queries.updateOrderPacket(order.id,{...payload,address:'Позднее правомерное изменение'});
  const retry=await h.loadQueries().createOrderWithMaterials(payload,prepared);
  assert.equal(retry.id,order.id);assert.equal(retry.address,'Позднее правомерное изменение');assert.equal(Number(retry.submitted_by),108);assert.equal(retry.submitted_name,'Первый автор');
  assert.equal(retry.request_signature,payload.request_signature);assert.equal(retry.request_submit_id,payload.request_submit_id);
  const stored=await h.store.list(order.id,true);assert.equal(stored.length,1);assert.ok(stored[0].buffer.equals(prepared[0].buffer));
  assert.equal(Number((await h.pool.query('SELECT COUNT(*) AS n FROM orders')).rows[0].n),1);
}));
