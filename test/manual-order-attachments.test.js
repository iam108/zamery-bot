const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createManualOrderAttachments, sourceFile } = require('../src/bot/manual-order-attachments');
const { createMaterialsStore, prepareMaterials, LIMITS } = require('../src/web/order-materials');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
async function fixture(run, options = {}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  await db.exec(`CREATE TABLE orders(id INT PRIMARY KEY,submitted_by BIGINT,status TEXT,address TEXT,object_name TEXT,owner_name TEXT,telegram_msg_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
    INSERT INTO orders(id,submitted_by,status,address,object_name,telegram_msg_id) VALUES(58,108,'new','Москва, Лесная, 5','ООО ЧООКДИ',901),(59,109,'new','Другой объект','Чужая заявка',902),(60,108,'done','Закрыта','Закрытая',903);`);
  const pool = { async query(sql, params) { return !params && sql.split(';').filter(s=>s.trim()).length > 1 ? (await db.exec(sql), {rows:[]}) : db.query(sql, params); }, async connect() { return { query: (...args) => pool.query(...args), release() {} }; } };
  const store = createMaterialsStore(pool), sends=[], replies=[], downloads=[], saves=[];
  const original = Buffer.from('%PDF-1.7 synthetic original without transforms');
  let sequence=1000, approved=true, sendError=null, replyError=null, downloadError=null, saveError=null, downloadWait=null, delivered={};
  const materials = { LIMITS, prepareMaterials, async saveOrderMaterials(id, files) { saves.push({id,files}); if(saveError)throw saveError;return store.save(id,files); } };
  const context = (changes={}) => ({
    chat:{id:108,type:'private'},from:{id:108},message:{message_id:321,document:{file_id:'synthetic-file',file_size:original.length,file_name:'Выписка ЕГРН.pdf',mime_type:'application/pdf'}},
    async reply(text,extra) { if(replyError)throw replyError;replies.push({text,extra});return {message_id:sequence++}; }, async answerCbQuery(){},
    telegram:{ async getFileLink(id){return 'https://api.telegram.org/file/botSYNTHETIC/'+id;},async sendPhoto(chat,id,extra){return send('photo',chat,id,extra);},async sendDocument(chat,id,extra){return send('document',chat,id,extra);} },...changes,
  });
  async function send(kind,chat,id,extra) { sends.push({kind,chat,id,extra}); if(sendError)throw sendError;return {message_id:sequence++,...delivered}; }
  const create = () => createManualOrderAttachments({pool,materials,groupId:'-100321',getMe:async()=>({approved}),download:async link=>{downloads.push(link);if(downloadWait)await downloadWait;if(downloadError)throw downloadError;return original;},log(){},...options});
  const h={db,pool,store,original,materials,context,create,sends,replies,downloads,saves,
    async row(){return (await db.query('SELECT * FROM manual_order_attachments WHERE source_chat_id=108 AND source_message_id=321')).rows[0];},
    async extraOrder(){await db.exec("INSERT INTO orders(id,submitted_by,status,address,object_name,telegram_msg_id) VALUES(61,108,'in_progress','Москва, Мясницкая, 15','Вторая заявка',904)");},
    set approved(value){approved=value;},set sendError(value){sendError=value;},set replyError(value){replyError=value;},set downloadError(value){downloadError=value;},set saveError(value){saveError=value;},set downloadWait(value){downloadWait=value;},set delivered(value){delivered=value;},
    async callback(data){if(/^manual_retry:\d+$/.test(data)){const row=await h.row();if(row?.retry_generation)data+=':'+row.retry_generation;}const ctx=context({message:undefined,callbackQuery:{data}});return ctx;},
  };
  try { await run(h); } finally { await db.close(); }
}

test('an attachment preserves the exact original in its own single open order before forwarding, and replay is idempotent',pg,async()=>fixture(async h=>{
  const handler=h.create(),ctx=h.context();await handler.receive(ctx);await handler.receive(ctx);
  const files=await h.store.list(58,true);assert.equal(files.length,1);assert.ok(files[0].buffer.equals(h.original));assert.equal(files[0].role,'egrn');
  assert.equal(h.downloads.length,1);assert.equal(h.saves.length,1);assert.equal(h.sends.length,1);assert.equal(h.sends[0].extra.reply_to_message_id,901);
  assert.equal((await h.row()).stage,'sent');assert.equal(h.replies.length,1);assert.match(h.replies[0].text,/сохранён в документах заявки #58 и отправлен/);
  assert.equal(Number(files[0].telegram_msg_id),Number((await h.row()).group_message_id));
}));

test('multiple open orders require explicit selection and cannot attach to another employee or a closed order',pg,async()=>fixture(async h=>{
  await h.extraOrder();const handler=h.create();await handler.receive(h.context());
  assert.equal(h.downloads.length,0);assert.equal(h.sends.length,0);assert.equal((await h.row()).order_id,null);
  const buttons=h.replies[0].extra.reply_markup.inline_keyboard.flat();assert.equal(buttons.length,2);assert.ok(buttons.every(button=>/:(58|61)$/.test(button.callback_data)));
  for(const id of [59,60])await handler.select(await h.callback('manual_attach:321:'+id));
  assert.equal(h.saves.length,0);await handler.select(await h.callback('manual_attach:321:61'));
  assert.equal((await h.row()).order_id,61);assert.equal((await h.store.list(61)).length,1);assert.equal((await h.store.list(58)).length,0);
  await handler.select(await h.callback('manual_attach:321:58'));assert.equal((await h.store.list(58)).length,0);assert.equal(h.sends.length,1);
}));

test('unapproved or non-private actors cannot create receipts, download files or post to the group',pg,async()=>fixture(async h=>{
  const handler=h.create();await handler.receive(h.context({chat:{id:-100,type:'group'}}));assert.equal(h.replies.length,0);
  h.approved=false;await handler.receive(h.context());assert.match(h.replies[0].text,/Нет доступа/);assert.equal(h.downloads.length,0);assert.equal(h.sends.length,0);
  assert.equal((await h.db.query("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='manual_order_attachments'")).rows[0].count,0);
}));

test('revocation during an original download prevents storage and group publication',pg,async()=>fixture(async h=>{
  let release;h.downloadWait=new Promise(resolve=>{release=resolve;});const running=h.create().receive(h.context());while(!h.downloads.length)await new Promise(resolve=>setImmediate(resolve));h.approved=false;release();await running;
  assert.equal(h.sends.length,0);assert.equal(h.saves.length,0);assert.equal((await h.row()).stage,'pending');assert.match(h.replies.at(-1).text,/в документы заявки он не добавлен/);
}));
test('revocation while a manual attachment waits for the order lock blocks download and publication',pg,async()=>{
  const options={};await fixture(async h=>{options.withOrderDeliveryLock=async(id,run)=>{h.approved=false;return run();};await h.create().receive(h.context());assert.equal(h.downloads.length,0);assert.equal(h.saves.length,0);assert.equal(h.sends.length,0);assert.match(h.replies.at(-1).text,/Нет доступа/);},options);
});
for(const boundary of ['saved-original','durable-intent'])test('revocation after '+boundary+' keeps saved bytes and a known unsent retry',pg,async()=>fixture(async h=>{
  if(boundary==='saved-original'){const save=h.materials.saveOrderMaterials;h.materials.saveOrderMaterials=async(...args)=>{const result=await save(...args);h.approved=false;return result;};}
  else{const query=h.pool.query;h.pool.query=async(sql,args)=>{const result=await query(sql,args);if(sql.includes("SET stage='sending'"))h.approved=false;return result;};}
  const handler=h.create();await handler.receive(h.context());assert.equal(h.sends.length,0);assert.equal((await h.row()).stage,'saved');assert.equal((await h.store.list(58)).length,1);assert.doesNotMatch(h.replies.at(-1).text,/могло дойти|не получено/);
  h.approved=true;if(boundary==='durable-intent')h.pool.query=async(sql,args)=>!args&&sql.split(';').filter(s=>s.trim()).length>1?(await h.db.exec(sql),{rows:[]}):h.db.query(sql,args);
  await h.create().retry(await h.callback('manual_retry:321'));assert.equal(h.sends.length,1);assert.equal(h.downloads.length,1);assert.equal((await h.store.list(58)).length,1);
}));
test('closing the source order during the durable intent stops publication and retains its saved original',pg,async()=>fixture(async h=>{
  const query=h.pool.query;h.pool.query=async(sql,args)=>{const result=await query(sql,args);if(sql.includes("SET stage='sending'"))await h.db.exec("UPDATE orders SET status='done' WHERE id=58");return result;};
  await h.create().receive(h.context());assert.equal(h.sends.length,0);assert.equal((await h.row()).stage,'saved');assert.equal((await h.store.list(58)).length,1);
}));

test('oversized originals remain in Telegram without false packet success or a download attempt',pg,async()=>fixture(async h=>{
  const ctx=h.context();ctx.message.document.file_size=13*1024*1024;await h.create().receive(ctx);
  assert.equal(h.downloads.length,0);assert.equal(h.saves.length,0);assert.equal(h.sends.length,0);assert.match(h.replies[0].text,/больше 12 МБ.*не добавлен/);assert.equal((await h.row()).material_id,null);
}));

for(const stage of ['download','save'])test(stage+' failure keeps the original and retries the same order without group success',pg,async()=>fixture(async h=>{
  const handler=h.create();if(stage==='download')h.downloadError=new Error('synthetic');else h.saveError=new Error('synthetic');
  await handler.receive(h.context());assert.equal(h.sends.length,0);assert.match(h.replies.at(-1).text,/Не удалось сохранить/);assert.equal((await h.row()).order_id,58);
  h.downloadError=null;h.saveError=null;await handler.retry(await h.callback('manual_retry:321'));
  assert.equal(h.sends.length,1);assert.equal((await h.store.list(58)).length,1);assert.equal((await h.row()).stage,'sent');
}));

test('a confirmed Telegram rejection keeps saved packet bytes and retries publication without downloading again',pg,async()=>fixture(async h=>{
  const handler=h.create();h.sendError=Object.assign(new Error('rejected'),{response:{error_code:400}});await handler.receive(h.context());
  assert.equal((await h.row()).stage,'saved');assert.equal((await h.store.list(58)).length,1);assert.match(h.replies.at(-1).text,/сохранён.*отправить не удалось/);
  h.sendError=null;await handler.retry(await h.callback('manual_retry:321'));
  assert.equal(h.downloads.length,1);assert.equal(h.saves.length,1);assert.equal(h.sends.length,2);assert.equal((await h.row()).stage,'sent');
}));

test('an unknown Telegram acknowledgement does not auto-duplicate and an explicit retry reuses the saved original',pg,async()=>fixture(async h=>{
  const handler=h.create();h.sendError=new Error('network acknowledgement lost');await handler.receive(h.context());
  assert.equal((await h.row()).stage,'sending');assert.match(h.replies.at(-1).text,/могло дойти/);await handler.receive(h.context());assert.equal(h.sends.length,1);
  h.sendError=null;await h.create().retry(await h.callback('manual_retry:321'));
  assert.equal(h.sends.length,2);assert.equal(h.downloads.length,1);assert.equal(h.saves.length,1);assert.equal((await h.row()).stage,'sent');
}));

test('an invalid Telegram message id is an uncertain acknowledgement, never a delivered receipt',pg,async()=>fixture(async h=>{
  h.delivered={message_id:undefined};const handler=h.create();await handler.receive(h.context());
  assert.equal((await h.row()).stage,'sending');assert.equal((await h.row()).group_message_id,null);assert.match(h.replies.at(-1).text,/Подтверждение отправки.*не получено/);
  await handler.receive(h.context());assert.equal(h.sends.length,1);
}));

test('a lost group checkpoint after a successful send cannot silently duplicate on the next update',pg,async()=>fixture(async h=>{
  const query=h.pool.query;let fail=true;h.pool.query=async(sql,args)=>{if(fail&&sql.includes("SET stage='sent'")){fail=false;throw new Error('synthetic lost checkpoint');}return query(sql,args);};
  const handler=h.create();await handler.receive(h.context());assert.equal(h.sends.length,1);assert.equal((await h.row()).stage,'sending');
  await handler.receive(h.context());assert.equal(h.sends.length,1);assert.match(h.replies.at(-1).text,/могло дойти/);
}));

test('a failed private success message never downgrades a delivered group post into a resendable receipt',pg,async()=>fixture(async h=>{
  h.replyError=Object.assign(new Error('private unavailable'),{response:{error_code:403}});await h.create().receive(h.context());
  assert.equal((await h.row()).stage,'sent');h.replyError=null;await h.create().receive(h.context());
  assert.equal(h.sends.length,1);assert.equal(h.replies.length,1);assert.match(h.replies[0].text,/отправлен в рабочий чат/);
}));

test('simultaneous repeated updates never download or publish the same source twice',pg,async()=>fixture(async h=>{
  let release;h.downloadWait=new Promise(resolve=>{release=resolve;});const handler=h.create(),first=handler.receive(h.context());
  while(!h.downloads.length)await new Promise(resolve=>setTimeout(resolve,5));
  const second=handler.receive(h.context());await new Promise(resolve=>setImmediate(resolve));assert.equal(h.downloads.length,1);assert.equal(h.sends.length,0);release();await Promise.all([first,second]);assert.equal(h.sends.length,1);assert.equal((await h.store.list(58)).length,1);
}));

test('a crash during active sending requires an expired lease and explicit retry, preserving the original',pg,async()=>fixture(async h=>{
  const handler=h.create();h.sendError=new Error('unknown');await handler.receive(h.context());h.sendError=null;
  await h.db.exec("UPDATE manual_order_attachments SET lease_until=NOW()+INTERVAL '1 minute'");
  await handler.retry(await h.callback('manual_retry:321'));assert.equal(h.sends.length,1);
  await h.db.exec("UPDATE manual_order_attachments SET lease_until=NOW()-INTERVAL '1 second'");
  await h.create().retry(await h.callback('manual_retry:321'));assert.equal(h.sends.length,2);assert.equal(h.downloads.length,1);
}));

test('photo selection uses the largest Telegram original, while image documents with missing MIME remain accepted',pg,async()=>fixture(async h=>{
  const ctx=h.context();ctx.message.document={file_id:'image-original',file_name:'ЗАМЕРЫ.PNG',file_size:h.original.length,mime_type:'application/octet-stream'};
  await h.create().receive(ctx);assert.equal((await h.store.list(58))[0].mime,'image/png');assert.equal(h.sends[0].kind,'document');
  assert.deepEqual(sourceFile({message_id:99,photo:[{file_id:'small',file_size:1},{file_id:'large',file_size:2}]}),{file_id:'large',bytes:2,name:'Фото-99.jpg',mime:'image/jpeg',photo:true});
}));

test('known Telegram file size must match downloaded bytes before storage or publication',pg,async()=>fixture(async h=>{
  const ctx=h.context();ctx.message.document.file_size=h.original.length+1;await h.create().receive(ctx);
  assert.equal(h.saves.length,0);assert.equal(h.sends.length,0);assert.equal((await h.row()).stage,'pending');assert.match(h.replies.at(-1).text,/Не удалось сохранить/);
}));

async function managerSave(h) {
  await h.db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS object_type TEXT; ALTER TABLE orders ADD COLUMN IF NOT EXISTS has_video BOOLEAN; ALTER TABLE orders ADD COLUMN IF NOT EXISTS zones_info TEXT; ALTER TABLE orders ADD COLUMN IF NOT EXISTS deadline DATE; ALTER TABLE orders ADD COLUMN IF NOT EXISTS contacts TEXT; CREATE TABLE IF NOT EXISTS logs(order_id INT,action TEXT,actor TEXT,details TEXT); UPDATE orders SET owner_name='Client',object_type='Общепит алкоголь',service='Получение' WHERE id=58;");
  const originals=require('../src/web/order-materials'),materials={...originals,ensureOrderMaterials:h.store.ensure,saveOrderMaterials:h.store.save,saveOrderMaterialsInTransaction:h.store.saveInTransaction,listOrderMaterials:h.store.list,markOrderMaterialDelivered:h.store.delivered};
  const context=vm.createContext({module:{exports:{}},require(name){if(name==='./pool')return h.pool;if(name==='../web/order-materials')return materials;throw new Error(name);}});
  vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'),'utf8'),context);
  const telegram=h.context().telegram;telegram.editMessageText=async()=>{};
  const handlers=require('../src/web/manager-orders').createManagerHandlers({groupId:'-100321',pool:h.pool,materials,queries:context.module.exports,getTelegram:()=>telegram,format:()=> 'order',attachOrOrder:()=>assert.fail('No paid API')});
  const row=(await h.pool.query('SELECT * FROM orders WHERE id=58')).rows[0],response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  await handlers.save({params:{id:'58'},tgUser:{id:108},staff:{name:'Author',role:'manager'},files:[],body:{address:row.address,owner_name:'Client',object_type:'Общепит алкоголь',service:'Получение',submit_id:'manager-save',packet_revision:row.packet_revision}},response);
  return response;
}

for(const historical of [false,true])test('manager save does not reupload a manually published original, historical receipt='+historical,pg,async()=>fixture(async h=>{
  await h.create().receive(h.context());if(historical)await h.pool.query('UPDATE order_materials SET telegram_msg_id=NULL WHERE order_id=58');
  const saved=await managerSave(h);assert.equal(saved.body.ok,true);assert.equal(saved.body.warning,undefined);assert.equal(h.sends.length,1);
  assert.equal(Number((await h.store.list(58))[0].telegram_msg_id),Number((await h.row()).group_message_id));
}));

test('a lost manual publication checkpoint stays unknown to manager delivery and both receipt writes roll back',pg,async()=>fixture(async h=>{
  const query=h.pool.query;let fail=true;h.pool.query=async(sql,args)=>{if(fail&&sql.includes("SET stage='sent'")){fail=false;throw new Error('Synthetic receipt failure');}return query(sql,args);};
  await h.create().receive(h.context());assert.equal((await h.row()).stage,'sending');assert.equal((await h.store.list(58))[0].telegram_msg_id,null);
  const saved=await managerSave(h);assert.equal(saved.body.ok,true);assert.match(saved.body.warning,/не подтверждена/);assert.equal(h.sends.length,1);
}));

test('a manual retry adopts a confirmed manager publication rather than forwarding the same file again',pg,async()=>fixture(async h=>{
  h.sendError=Object.assign(new Error('Telegram rejected'),{response:{error_code:400}});await h.create().receive(h.context());assert.equal((await h.row()).stage,'saved');
  h.sendError=null;const saved=await managerSave(h);assert.equal(saved.body.ok,true);assert.equal(h.sends.length,2);
  await h.create().retry(await h.callback('manual_retry:321'));assert.equal(h.sends.length,2);assert.equal((await h.row()).stage,'sent');
  assert.equal(Number((await h.row()).group_message_id),Number((await h.store.list(58))[0].telegram_msg_id));
}));

test('a manual attachment cannot bypass an unknown manager publication of the identical saved original',pg,async()=>fixture(async h=>{
  h.sendError=Object.assign(new Error('Telegram rejected'),{response:{error_code:400}});await h.create().receive(h.context());
  h.sendError=new Error('Manager send accepted but ACK lost');const saved=await managerSave(h);assert.match(saved.body.warning,/могло дойти/);assert.equal(h.sends.length,2);
  h.sendError=null;await h.create().retry(await h.callback('manual_retry:321'));
  assert.equal(h.sends.length,2,'A manual retry must not reopen the manager delivery generation');assert.match(h.replies.at(-1).text,/order_delivery 58/);assert.equal((await h.store.list(58))[0].telegram_msg_id,null);
}));

test('a Telegram 5xx response is an unknown manual delivery, and redelivered source updates cannot repeat it automatically',pg,async()=>fixture(async h=>{
  h.sendError=Object.assign(new Error('upstream ACK unknown'),{response:{error_code:502}});await h.create().receive(h.context());
  assert.equal((await h.row()).stage,'sending');h.sendError=null;await h.create().receive(h.context());assert.equal(h.sends.length,1);assert.match(h.replies.at(-1).text,/могло дойти/);
}));

for(const ack of [{message_id:true},{message_id:[777]},{message_id:901},{message_id:1000,chat:{id:-100999}}])test('manual original rejects malformed, card-reused or wrong-chat ACK '+JSON.stringify(ack),pg,async()=>fixture(async h=>{
  h.delivered=ack;await h.create().receive(h.context());assert.equal((await h.row()).stage,'sending');assert.equal((await h.store.list(58))[0].telegram_msg_id,null);
  h.delivered={};await h.create().receive(h.context());assert.equal(h.sends.length,1);
  const manager=await managerSave(h);assert.match(manager.body.warning,/не подтверждена/);assert.equal(h.sends.length,1);
}));
test('a manual original cannot reuse another document receipt in the same order chat',pg,async()=>fixture(async h=>{
  const other=prepareMaterials([{originalname:'Другой.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF other original')}]);await h.store.save(58,other);await h.store.delivered(58,other[0].id,777);
  h.delivered={message_id:777};await h.create().receive(h.context());assert.equal((await h.row()).stage,'sending');assert.equal((await h.store.list(58)).filter(file=>Number(file.telegram_msg_id)===777).length,1);
}));
test('the same explicit manual retry callback cannot authorize a later unknown attempt after restart',pg,async()=>fixture(async h=>{
  h.sendError=new Error('ACK lost');await h.create().receive(h.context());const confirmation=await h.callback('manual_retry:321');
  await h.create().retry(confirmation);assert.equal(h.sends.length,2);await h.create().retry(confirmation);assert.equal(h.sends.length,2);assert.equal((await h.row()).stage,'sending');
  h.sendError=null;await h.create().retry(await h.callback('manual_retry:321'));assert.equal(h.sends.length,3);assert.equal((await h.row()).stage,'sent');assert.equal(h.downloads.length,1);assert.equal((await h.store.list(58)).length,1);
}));
test('concurrent clicks of one reviewed manual retry generation dispatch only one native attempt',pg,async()=>fixture(async h=>{
  h.sendError=new Error('ACK lost');await h.create().receive(h.context());const confirmation=await h.callback('manual_retry:321');
  const send=confirmation.telegram.sendDocument;let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  confirmation.telegram.sendDocument=async(...args)=>{enter();await gate;return send(...args);};
  const a=h.create().retry(confirmation);await entered;const b=h.create().retry(confirmation);release();await Promise.all([a,b]);assert.equal(h.sends.length,2);assert.equal((await h.row()).stage,'sending');
}));
test('a legacy manual retry button only refreshes the currently reviewed attempt instead of sending an original',pg,async()=>fixture(async h=>{
  h.sendError=new Error('ACK lost');await h.create().receive(h.context());
  await h.create().retry(h.context({message:undefined,callbackQuery:{data:'manual_retry:321'}}));assert.equal(h.sends.length,1);
  assert.match(h.replies.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data,/^manual_retry:321:[a-f\d-]{36}$/i);
}));
