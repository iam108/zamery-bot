'use strict';

// Mutations run under the existing per-order delivery lock (namespace 119).
// Each native POST has its own durable generation; an uncertain attempt can
// only be retried after an administrator reviewed that exact generation.
const { createHash } = require('node:crypto');
const readyPools = new WeakMap();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const messageId = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
function problem(message, code='ORDER_DELIVERY_INVALID', status=400) { return Object.assign(new Error(message),{code,status}); }
function orderId(value) { const id=messageId(value);if(!id||id>2147483647)throw problem('Некорректный номер заявки.');return id; }
function json(value) { if(typeof value==='string'){try{return JSON.parse(value);}catch(_){return null;}}return value; }
function state(row) {
  const saved=json(row.telegram_delivery)||{};
  if(typeof saved!=='object'||Array.isArray(saved)||saved.version!=null&&saved.version!==1)throw problem('Не удалось проверить состояние доставки. Нужна проверка администратора.','ORDER_DELIVERY_STATE');
  for(const key of ['materials','retry_cursors'])if(saved[key]!=null&&(typeof saved[key]!=='object'||Array.isArray(saved[key])))throw problem('Не удалось проверить состояние доставки. Нужна проверка администратора.','ORDER_DELIVERY_STATE');
  return {...saved,version:1,materials:{...saved.materials},retry_cursors:{...saved.retry_cursors}};
}
function uncertain(slot) { return slot && ['sending','unknown'].includes(slot.state); }
function hasUnknownMaterialDelivery(row, id) { return !!uncertain(state(row).materials[id]); }
function rejected(error) { const code=Number(error?.response?.error_code);return code>=400&&code<500; }
function description(error) { return error?.response?.description||error?.message||''; }
const unknownWarning = id => 'Результат отправки в Telegram не подтверждён: сообщение могло дойти. Автоматический повтор остановлен. Проверьте рабочий чат; администратор может открыть /order_delivery '+id+'. Повтор после проверки может создать дубликат.';

function createOrderTelegramDelivery(options={}) {
  const pool=options.pool||require('../db/pool');
  const telegram=()=>typeof options.telegram==='function'?options.telegram():options.telegram||require('../bot/instance').telegram;
  const group=()=>String((typeof options.groupId==='function'?options.groupId():options.groupId)??process.env.GROUP_CHAT_ID??'');
  const now=options.now||Date.now;
  async function ready() {
    if(options.ready)return options.ready();
    if(!readyPools.has(pool))readyPools.set(pool,require('./order-materials').createMaterialsStore(pool).ensure);
    return readyPools.get(pool)();
  }
  async function load(value) {
    const id=orderId(value);await ready();const row=(await pool.query('SELECT id,telegram_msg_id,telegram_delivery FROM orders WHERE id=$1',[id])).rows[0];
    if(!row)throw problem('Заявка не найдена.','ORDER_DELIVERY_ORDER_MISSING',404);return row;
  }
  function slotAt(data,key) { return key==='card'?data.card:data.materials[key]; }
  function put(data,key,slot) { if(key==='card')data.card=slot;else data.materials[key]=slot; }
  function destination() { const chat=group();if(!/^-?[1-9]\d*$/.test(chat)&&!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chat))throw problem('Рабочий чат не настроен.');return chat; }
  async function save(id,data) {
    const result=await pool.query('UPDATE orders SET telegram_delivery=$1::jsonb WHERE id=$2 RETURNING id',[JSON.stringify(data),id]);
    if(!result.rows.length)throw problem('Заявка больше недоступна.');
  }
  async function cardReceipt(id,data,receipt) {
    const result=await pool.query('UPDATE orders SET telegram_msg_id=$1,telegram_delivery=$2::jsonb WHERE id=$3 RETURNING id',[receipt,JSON.stringify(data),id]);
    if(!result.rows.length)throw problem('Не удалось сохранить подтверждение карточки.');
  }
  async function materialReceipt(id,key,data,receipt) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const row=(await client.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw problem('Заявка больше недоступна.');
      const file=await client.query('UPDATE order_materials SET telegram_msg_id=$1 WHERE order_id=$2 AND id=$3 RETURNING id',[receipt,id,key]);if(!file.rows.length)throw problem('Оригинал больше недоступен.');
      await client.query('UPDATE orders SET telegram_delivery=$1::jsonb WHERE id=$2',[JSON.stringify(data),id]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  async function post(row,key,run) {
    const id=Number(row.id),data=state(row),previous=slotAt(data,key),chat=destination();
    if(uncertain(previous))return {ok:false,unknown:true,usable:false,warning:unknownWarning(id)};
    if(previous?.chat&&previous.chat!==chat)return {ok:false,usable:false,warning:'Рабочий чат изменился. Проверьте прежнюю доставку с администратором перед повтором.'};
    const files=(await pool.query('SELECT telegram_msg_id FROM order_materials WHERE order_id=$1',[id])).rows;
    const knownIds=new Set([row.telegram_msg_id,...files.map(file=>file.telegram_msg_id),data.card?.chat===chat&&data.card?.message_id,...Object.values(data.materials).filter(slot=>slot?.chat===chat).map(slot=>slot.message_id)].map(messageId).filter(Boolean));
    const generation=Number(previous?.generation||0)+1;if(!Number.isSafeInteger(generation))throw problem('Не удалось проверить номер попытки.');
    const intent={state:'sending',generation,chat,started_at:new Date(now()).toISOString()};put(data,key,intent);await save(id,data);
    let sent;
    try {
      sent=await run(chat);
      const receipt=messageId(sent?.message_id);
      const matchingChat=sent?.chat==null||(chat.startsWith('@')?String(sent.chat.username||'').toLowerCase()===chat.slice(1).toLowerCase():String(sent.chat.id)===chat);
      if(!receipt||knownIds.has(receipt)||!matchingChat)throw problem('Telegram не подтвердил новое сообщение в рабочем чате.','ORDER_DELIVERY_ACK');
    }
    catch(error){
      const safeRetry=rejected(error);put(data,key,{...intent,state:safeRetry?'failed':'unknown'});
      try{await save(id,data);}catch(_){return {ok:false,unknown:true,usable:false,warning:unknownWarning(id)};}
      return {ok:false,unknown:!safeRetry,usable:false,warning:safeRetry?'Telegram отклонил отправку. Повторите доставку после устранения ошибки.':unknownWarning(id)};
    }
    const receipt=messageId(sent.message_id);put(data,key,{...intent,state:'confirmed',message_id:receipt});
    try {if(key==='card')await cardReceipt(id,data,receipt);else await materialReceipt(id,key,data,receipt);}
    catch(_){return {ok:false,unknown:true,usable:false,warning:unknownWarning(id)};}
    return {ok:true,usable:true,message_id:receipt,created:true};
  }
  async function publishCard(order,text,cardOptions) {
    const row=await load(order.id),data=state(row),chat=destination(),saved=data.card;
    if(uncertain(saved))return {ok:false,unknown:true,usable:false,warning:unknownWarning(row.id)};
    if(saved?.chat&&saved.chat!==chat)return {ok:false,usable:false,warning:'Рабочий чат изменился. Проверьте исходную карточку с администратором.'};
    const existing=messageId(row.telegram_msg_id)||messageId(saved?.state==='confirmed'&&saved.message_id);
    if(existing){
      if(!messageId(row.telegram_msg_id))await cardReceipt(row.id,data,existing);
      try {await telegram().editMessageText(chat,existing,undefined,text,cardOptions);return {ok:true,usable:true,message_id:existing};}
      catch(error){
        if(Number(error?.response?.error_code)===400&&/message is not modified/i.test(description(error)))return {ok:true,usable:true,message_id:existing};
        if(!(Number(error?.response?.error_code)===400&&/message to edit not found/i.test(description(error))))return {ok:false,usable:true,message_id:existing,warning:'Не удалось обновить исходную карточку в чате. Повторите обновление позднее.'};
      }
    }
    return post(row,'card',target=>telegram().sendMessage(target,text,cardOptions));
  }
  async function publishMaterial(order,file) {
    if(!UUID.test(file?.id||''))throw problem('Некорректный номер документа.');
    const row=await load(order.id),data=state(row),saved=data.materials[file.id],chat=destination();
    if(saved?.chat&&saved.chat!==chat)return {ok:false,usable:false,warning:'Рабочий чат изменился. Проверьте прежнюю доставку файла с администратором.'};
    const current=(await pool.query('SELECT id,name,mime,bytes,sha256,telegram_msg_id FROM order_materials WHERE order_id=$1 AND id=$2',[row.id,file.id])).rows[0];
    if(!current||!['name','mime','sha256'].every(key=>String(current[key])===String(file[key]))||Number(current.bytes)!==Number(file.bytes)||!Buffer.isBuffer(file.buffer)||file.buffer.length!==Number(current.bytes)||createHash('sha256').update(file.buffer).digest('hex')!==current.sha256)throw problem('Не удалось подтвердить оригинал документа.');
    if(messageId(current.telegram_msg_id))return {ok:true,usable:true,message_id:messageId(current.telegram_msg_id)};
    if(saved?.state==='confirmed'&&messageId(saved.message_id)){
      await materialReceipt(row.id,file.id,data,messageId(saved.message_id));return {ok:true,usable:true,message_id:messageId(saved.message_id)};
    }
    const card=messageId(row.telegram_msg_id);if(!card)return {ok:false,usable:false,warning:'Сначала нужно подтвердить доставку исходной карточки заявки.'};
    return post(row,file.id,target=>telegram().sendDocument(target,{source:file.buffer,filename:file.name},{caption:'📎 Заявка #'+row.id+' · '+file.name,reply_to_message_id:card}));
  }
  async function preview(value,context={}) {
    const row=await load(value),data=state(row),files=(await pool.query('SELECT id,name,telegram_msg_id FROM order_materials WHERE order_id=$1 ORDER BY created_at,id',[row.id])).rows;
    if(context.actorId!=null||context.messageId!=null){
      const actor=messageId(context.actorId),cursor=messageId(context.messageId);
      if(!actor||!cursor)throw problem('Не удалось проверить команду просмотра.');
      if(cursor<=Number(data.retry_cursors[String(actor)]||0))throw problem('Этот просмотр уже обработан. Отправьте /order_delivery заново новым сообщением.','ORDER_DELIVERY_REVIEW_REPLAY',409);
      if(!Object.hasOwn(data.retry_cursors,String(actor))&&Object.keys(data.retry_cursors).length>=100)throw problem('Нужно проверить состояние доставки с администратором.');
      // An old preview redelivered after restart must not bind its old retry
      // command to a newer uncertain generation. Share the durable cursor
      // with recovery confirmations, including previews whose DM ACK is lost.
      data.retry_cursors[String(actor)]=cursor;await save(row.id,data);
    }
    const slots=[];if(uncertain(data.card))slots.push({slot:'card',name:'Карточка заявки',generation:data.card.generation});
    for(const file of files)if(!messageId(file.telegram_msg_id)&&uncertain(data.materials[file.id]))slots.push({slot:file.id,name:file.name,generation:data.materials[file.id].generation});
    return {order_id:Number(row.id),slots};
  }
  async function allowRetry(value,key,context={}) {
    const row=await load(value),data=state(row),actor=messageId(context.actorId),cursor=messageId(context.messageId),slot=slotAt(data,key);
    if(!actor||!cursor||key!=='card'&&!UUID.test(key))throw problem('Не удалось проверить подтверждение повтора.');
    const prior=Number(data.retry_cursors[String(actor)]||0);
    if(cursor<=prior)return {state:'replayed',warning:'Это подтверждение уже обработано. Откройте актуальную проверку доставки.'};
    if(!Object.hasOwn(data.retry_cursors,String(actor))&&Object.keys(data.retry_cursors).length>=100)throw problem('Нужно проверить состояние доставки с администратором.');
    data.retry_cursors[String(actor)]=cursor;
    if(!uncertain(slot)||slot.generation!==context.expectedGeneration||slot.chat!==destination()){
      await save(row.id,data);return {state:'stale',warning:'Состояние доставки изменилось. Сначала снова откройте /order_delivery '+row.id+'.'};
    }
    put(data,key,{...slot,state:'retry_ready'});await save(row.id,data);
    return {state:'retry_ready',warning:'Повтор выбранной части разрешён после проверки чата. Он может создать дубликат. Повторите доставку из формы заявки; остальные подтверждённые файлы не отправятся снова.'};
  }
  return {publishCard,publishMaterial,preview,allowRetry};
}
module.exports={createOrderTelegramDelivery,messageId,hasUnknownMaterialDelivery};
