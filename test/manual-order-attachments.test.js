const test = require('node:test');
const assert = require('node:assert/strict');
const { createManualOrderAttachments, sourceFile } = require('../src/bot/manual-order-attachments');
const { createMaterialsStore, prepareMaterials, LIMITS } = require('../src/web/order-materials');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
async function fixture(run, options = {}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  await db.exec(`CREATE TABLE orders(id INT PRIMARY KEY,submitted_by BIGINT,status TEXT,address TEXT,object_name TEXT,owner_name TEXT,telegram_msg_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW());
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
    callback(data){const ctx=context({message:undefined,callbackQuery:{data}});return ctx;},
  };
  try { await run(h); } finally { await db.close(); }
}

test('an attachment preserves the exact original in its own single open order before forwarding, and replay is idempotent',pg,async()=>fixture(async h=>{
  const handler=h.create(),ctx=h.context();await handler.receive(ctx);await handler.receive(ctx);
  const files=await h.store.list(58,true);assert.equal(files.length,1);assert.ok(files[0].buffer.equals(h.original));assert.equal(files[0].role,'egrn');
  assert.equal(h.downloads.length,1);assert.equal(h.saves.length,1);assert.equal(h.sends.length,1);assert.equal(h.sends[0].extra.reply_to_message_id,901);
  assert.equal((await h.row()).stage,'sent');assert.equal(h.replies.length,1);assert.match(h.replies[0].text,/сохранён в документах заявки #58 и отправлен/);
}));

test('multiple open orders require explicit selection and cannot attach to another employee or a closed order',pg,async()=>fixture(async h=>{
  await h.extraOrder();const handler=h.create();await handler.receive(h.context());
  assert.equal(h.downloads.length,0);assert.equal(h.sends.length,0);assert.equal((await h.row()).order_id,null);
  const buttons=h.replies[0].extra.reply_markup.inline_keyboard.flat();assert.equal(buttons.length,2);assert.ok(buttons.every(button=>/:(58|61)$/.test(button.callback_data)));
  for(const id of [59,60])await handler.select(h.callback('manual_attach:321:'+id));
  assert.equal(h.saves.length,0);await handler.select(h.callback('manual_attach:321:61'));
  assert.equal((await h.row()).order_id,61);assert.equal((await h.store.list(61)).length,1);assert.equal((await h.store.list(58)).length,0);
  await handler.select(h.callback('manual_attach:321:58'));assert.equal((await h.store.list(58)).length,0);assert.equal(h.sends.length,1);
}));

test('unapproved or non-private actors cannot create receipts, download files or post to the group',pg,async()=>fixture(async h=>{
  const handler=h.create();await handler.receive(h.context({chat:{id:-100,type:'group'}}));assert.equal(h.replies.length,0);
  h.approved=false;await handler.receive(h.context());assert.match(h.replies[0].text,/Нет доступа/);assert.equal(h.downloads.length,0);assert.equal(h.sends.length,0);
  assert.equal((await h.db.query("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='manual_order_attachments'")).rows[0].count,0);
}));

test('oversized originals remain in Telegram without false packet success or a download attempt',pg,async()=>fixture(async h=>{
  const ctx=h.context();ctx.message.document.file_size=13*1024*1024;await h.create().receive(ctx);
  assert.equal(h.downloads.length,0);assert.equal(h.saves.length,0);assert.equal(h.sends.length,0);assert.match(h.replies[0].text,/больше 12 МБ.*не добавлен/);assert.equal((await h.row()).material_id,null);
}));

for(const stage of ['download','save'])test(stage+' failure keeps the original and retries the same order without group success',pg,async()=>fixture(async h=>{
  const handler=h.create();if(stage==='download')h.downloadError=new Error('synthetic');else h.saveError=new Error('synthetic');
  await handler.receive(h.context());assert.equal(h.sends.length,0);assert.match(h.replies.at(-1).text,/Не удалось сохранить/);assert.equal((await h.row()).order_id,58);
  h.downloadError=null;h.saveError=null;await handler.retry(h.callback('manual_retry:321'));
  assert.equal(h.sends.length,1);assert.equal((await h.store.list(58)).length,1);assert.equal((await h.row()).stage,'sent');
}));

test('a confirmed Telegram rejection keeps saved packet bytes and retries publication without downloading again',pg,async()=>fixture(async h=>{
  const handler=h.create();h.sendError=Object.assign(new Error('rejected'),{response:{error_code:400}});await handler.receive(h.context());
  assert.equal((await h.row()).stage,'saved');assert.equal((await h.store.list(58)).length,1);assert.match(h.replies.at(-1).text,/сохранён.*отправить не удалось/);
  h.sendError=null;await handler.retry(h.callback('manual_retry:321'));
  assert.equal(h.downloads.length,1);assert.equal(h.saves.length,1);assert.equal(h.sends.length,2);assert.equal((await h.row()).stage,'sent');
}));

test('an unknown Telegram acknowledgement does not auto-duplicate and an explicit retry reuses the saved original',pg,async()=>fixture(async h=>{
  const handler=h.create();h.sendError=new Error('network acknowledgement lost');await handler.receive(h.context());
  assert.equal((await h.row()).stage,'sending');assert.match(h.replies.at(-1).text,/могло дойти/);await handler.receive(h.context());assert.equal(h.sends.length,1);
  h.sendError=null;await h.create().retry(h.callback('manual_retry:321'));
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
  await handler.receive(h.context());assert.equal(h.downloads.length,1);assert.equal(h.sends.length,0);release();await first;assert.equal(h.sends.length,1);assert.equal((await h.store.list(58)).length,1);
}));

test('a crash during active sending requires an expired lease and explicit retry, preserving the original',pg,async()=>fixture(async h=>{
  const handler=h.create();h.sendError=new Error('unknown');await handler.receive(h.context());h.sendError=null;
  await h.db.exec("UPDATE manual_order_attachments SET lease_until=NOW()+INTERVAL '1 minute'");
  await handler.retry(h.callback('manual_retry:321'));assert.equal(h.sends.length,1);
  await h.db.exec("UPDATE manual_order_attachments SET lease_until=NOW()-INTERVAL '1 second'");
  await h.create().retry(h.callback('manual_retry:321'));assert.equal(h.sends.length,2);assert.equal(h.downloads.length,1);
}));

test('photo selection uses the largest Telegram original, while image documents with missing MIME remain accepted',pg,async()=>fixture(async h=>{
  const ctx=h.context();ctx.message.document={file_id:'image-original',file_name:'ЗАМЕРЫ.PNG',file_size:42,mime_type:'application/octet-stream'};
  await h.create().receive(ctx);assert.equal((await h.store.list(58))[0].mime,'image/png');assert.equal(h.sends[0].kind,'document');
  assert.deepEqual(sourceFile({message_id:99,photo:[{file_id:'small',file_size:1},{file_id:'large',file_size:2}]}),{file_id:'large',bytes:2,name:'Фото-99.jpg',mime:'image/jpeg',photo:true});
}));
