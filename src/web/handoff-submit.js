const { createHash } = require('node:crypto');
const { getSessionLockPool } = require('../db/session-lock-pool');
const { canManageCases, canAccessCase } = require('./auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DDL = `ALTER TABLE cases ADD COLUMN IF NOT EXISTS handoff_submit_id TEXT;
  ALTER TABLE cases ADD COLUMN IF NOT EXISTS handoff_signature TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS cases_handoff_submit ON cases(created_by,handoff_submit_id) WHERE handoff_submit_id IS NOT NULL;`;
class HandoffError extends Error {
  constructor(status,code,message) { super(message);this.status=status;this.code=code;this.case_created=false; }
}
function fail(status,code,message) { throw new HandoffError(status,code,message); }
function value(item) {return typeof item==='string'||typeof item==='number'?String(item).trim():'';}
function json(item) { if(typeof item==='string'){try{return JSON.parse(item);}catch(_){return {};}}return item&&typeof item==='object'?item:{}; }
function canonical(item) {return JSON.stringify(item,(key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(name=>[name,v[name]])):v);}
function esc(item) {return String(item??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function positive(item,label) {if(!/^[1-9]\d*$/.test(String(item))||!Number.isSafeInteger(Number(item)))fail(400,'HANDOFF_INVALID',label);return Number(item);}
const messageId=item=>(typeof item==='number'||typeof item==='string'&&/^[1-9]\d*$/.test(item))&&Number.isSafeInteger(Number(item))&&Number(item)>0?Number(item):null;
function https(item) {try{const url=new URL(value(item));return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch(_){return '';}}
function fields(body) {
  const d={};
  for(const key of ['org','address','region','kind','service','inn','cad_num','priority','comment'])d[key]=value(body[key]);
  if(!d.org||d.org.length>500||!d.address||d.address.length>500)fail(400,'HANDOFF_INVALID','Укажите организацию и адрес объекта.');
  if(!['МСК','МО','СПб'].includes(d.region)||!['Общепит','Магазин','Табак'].includes(d.kind)||!['Получение','Продление','Переоформление'].includes(d.service))fail(400,'HANDOFF_INVALID','Проверьте регион, тип объекта и услугу.');
  const priority=d.priority.toLowerCase();
  if(!['обычный','срочно','🔥 горящий','горящий'].includes(priority))fail(400,'HANDOFF_INVALID','Выберите приоритет передачи.');
  d.priority=priority==='обычный'?'обычный':'🔥 горящий';
  if(d.inn&&!/^\d{10}(?:\d{2})?$/.test(d.inn))fail(400,'HANDOFF_INVALID','ИНН должен содержать 10 или 12 цифр.');
  if(d.cad_num&&!/^\d{2}:\d{2}:\d{6,7}:\d+$/.test(d.cad_num))fail(400,'HANDOFF_INVALID','Проверьте кадастровый номер.');
  if(d.comment.length>4000)fail(400,'HANDOFF_INVALID','Комментарий не должен превышать 4000 знаков.');
  if(!Array.isArray(body.contacts)||body.contacts.length>10)fail(400,'HANDOFF_CONTACTS','Проверьте контакты клиента.');
  d.contacts=body.contacts.map(contact=>{
    if(!contact||typeof contact!=='object'||Array.isArray(contact))fail(400,'HANDOFF_CONTACTS','Проверьте контакты клиента.');
    const c={name:value(contact.name),phone:value(contact.phone),tg:value(contact.tg),comment:value(contact.comment)};
    if(c.name.length>200||c.phone.length>100||c.tg.length>100||c.comment.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(Object.values(c).join('')))fail(400,'HANDOFF_CONTACTS','Проверьте длину и формат контактов клиента.');
    return c;
  }).filter(c=>c.name||c.phone||c.tg||c.comment);
  if(!d.contacts.some(c=>c.name||c.phone||c.tg))fail(400,'HANDOFF_CONTACTS','Добавьте контакт клиента для юриста.');
  const primary=d.contacts.find(c=>c.name||c.phone||c.tg);d.client=primary.name;d.phone=primary.phone;
  if(body.egrn_order!==undefined&&typeof body.egrn_order!=='boolean')fail(400,'HANDOFF_INVALID','Подтверждение заказа ЕГРН должно быть явным.');
  if(body.egrn_order===true&&!d.cad_num)fail(400,'HANDOFF_INVALID','Для заказа ЕГРН нужен кадастровый номер.');
  return d;
}
function sourceReport(picked) {
  if(!picked||!picked.chat_id||!Array.isArray(picked.msg_ids))fail(409,'HANDOFF_REPORT_UNAVAILABLE','Не найдены сохранённые сообщения выбранного отчёта.');
  const grouped=new Map(),raw=[{chat_id:picked.chat_id,msg_ids:picked.msg_ids.concat(picked.extra||[])},...(Array.isArray(picked.sources)?picked.sources:[])];
  for(const item of raw){
    if(!item||! /^-?\d+$/.test(String(item.chat_id))||!Array.isArray(item.msg_ids))fail(409,'HANDOFF_REPORT_UNAVAILABLE','Проверьте сохранённый комплект сообщений отчёта.');
    const chat=String(item.chat_id),ids=[...new Set([...(grouped.get(chat)||[]),...item.msg_ids.map(Number)])].sort((a,b)=>a-b);
    if(ids.some(id=>!Number.isSafeInteger(id)||id<1))fail(409,'HANDOFF_REPORT_UNAVAILABLE','Проверьте сохранённый комплект сообщений отчёта.');
    grouped.set(chat,ids);
  }
  const sources=[...grouped].filter(([,ids])=>ids.length).map(([chat_id,message_ids])=>({chat_id,message_ids}));
  const total=sources.reduce((count,source)=>count+source.message_ids.length,0);
  if(!total||total>5000)fail(409,'HANDOFF_REPORT_UNAVAILABLE','Проверьте сохранённый комплект сообщений отчёта.');
  const data=[picked.report_data,...(Array.isArray(picked.report_data_sources)?picked.report_data_sources:[])].map(json);
  const hashes=[...new Set(data.flatMap(item=>[...(Array.isArray(item.evidence)?item.evidence:[]),...(Array.isArray(item.documents)?item.documents:[])])
    .map(file=>value(file?.sha256).toLowerCase()).filter(hash=>/^[a-f\d]{64}$/.test(hash)))];
  return {...sources[0],sources,hashes};
}
function sourceParts(source) {return Array.isArray(source.sources)?source.sources:[source];}
function linkedOriginals(packet) {
  if(packet.egrn_links==null)return [];
  if(!Array.isArray(packet.egrn_links))fail(409,'HANDOFF_EGRN_LINKS','Не удалось подтвердить связанные выписки заявки.');
  const files=new Map();
  for(const file of packet.egrn_links){
    if(!file||!UUID.test(file.id||'')||!['stored','telegram'].includes(file.source)||typeof file.name!=='string'||!file.name.trim()||
      !['application/pdf','application/zip','application/x-zip-compressed'].includes(file.mime)||!Number.isSafeInteger(Number(file.bytes))||Number(file.bytes)<1||
      file.sha256!=null&&file.sha256!==''&&!/^[a-f\d]{64}$/i.test(file.sha256))fail(409,'HANDOFF_EGRN_LINKS','Проверьте сохранённый состав связанных выписок заявки.');
    const expected={id:file.id.toLowerCase(),name:file.name,mime:file.mime,bytes:Number(file.bytes),source:file.source,...(file.sha256?{sha256:file.sha256.toLowerCase()}:{})};
    if(files.has(expected.id)&&canonical(files.get(expected.id))!==canonical(expected))fail(409,'HANDOFF_EGRN_LINKS','Сведения о связанной выписке расходятся.');
    files.set(expected.id,expected);
  }
  return [...files.values()];
}
function linkedReceipt(state,chat,id) {
  const receipt=state.linkedEgrn?.confirmed?.[String(chat)]?.[id];
  return Number.isSafeInteger(Number(receipt?.message_id))&&Number(receipt.message_id)>0||typeof receipt?.legacy_receipt==='string'&&receipt.legacy_receipt.length>0;
}
function hasPendingLinkedEgrn(state,chat) {
  const files=state.linkedEgrn?.files||state.packet?.egrn_links||[];
  return Array.isArray(files)&&files.some(file=>!linkedReceipt(state,chat,String(file?.id||'').toLowerCase()));
}
function short(item,limit) {const s=value(item);return s.length>limit?s.slice(0,limit-1).replace(/[\uD800-\uDBFF]$/,'')+'…':s;}
function cardText(c,state) {
  const report=state.packet.report,lines=['⚖️ <b>Клиент передан юристу</b>','🏢 <b>'+esc(c.org)+'</b>','📍 '+esc(c.address),esc([c.kind,c.service,c.region].join(' · '))];
  if(c.inn)lines.push('ИНН: '+esc(c.inn));
  if(state.fields.cad_num)lines.push('Кадастр: '+esc(state.fields.cad_num));
  const contacts=c.contacts.filter(contact=>contact.name||contact.phone||contact.tg);
  for(const contact of contacts.slice(0,3)){const parts=[contact.name,contact.phone,contact.tg].filter(Boolean);if(parts.length)lines.push('👤 '+parts.map(part=>esc(short(part,120))).join(' · '));}
  if(contacts.length>3)lines.push('Остальные контакты — в карточке клиента.');
  lines.push('⚖️ Юрист: '+esc(c.lawyer_name),'Приоритет: '+esc(c.priority));
  if(report.actor)lines.push('Аудитор: '+esc(short(report.actor,100)));
  const status={ready:'Соответствует по проверенным пунктам',actions:'Нужны действия',insufficient:'Нужно уточнить',obstacle:'Есть препятствие'}[report.status];
  if(status)lines.push('Итог аудита: '+esc(status));
  lines.push('Полный отчёт и оригиналы — следом.','Документы заявки: '+state.packet.materials.length+'.');
  if(c.comment)lines.push('💬 '+esc(short(c.comment,500)));
  if(state.manager_name)lines.push('Передал: '+esc(short(state.manager_name,100)));
  lines.push('#заявка'+c.id);return lines.join('\n');
}
function reportUrl(base,state) {
  let url;try{url=new URL('/handoff',base);}catch(_){fail(503,'HANDOFF_CONFIG','Не настроена ссылка на карточку передачи.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)fail(503,'HANDOFF_CONFIG','Не настроена ссылка на карточку передачи.');
  url.search=new URLSearchParams({view:'report',order_id:String(state.body.order_id),report_src:state.body.report_src,report_id:String(state.body.report_id)}).toString();return url.href;
}
function cardOptions(base,c,state) {
  const keyboard=[],report=state.packet.report,url=reportUrl(base,state);
  if(c.checklist_key)keyboard.push([{text:'📋 Чек-лист клиента',web_app:{url:new URL('/checklist?case_id='+c.id,base).href}}]);
  keyboard.push([{text:'Отчёт и материалы',web_app:{url}}]);
  const video=https(report.video_url),archive=https(state.packet.archive_url);
  if(video)keyboard.push([{text:'▶ Видео осмотра',url:video}]);
  if(archive)keyboard.push([{text:'Архив объекта',url:archive}]);
  return {parse_mode:'HTML',...(keyboard.length?{reply_markup:{inline_keyboard:keyboard}}:{})};
}
function partial(c,state,warn,retry=true) {return {ok:true,id:Number(c.id),delivery_complete:false,retry, ...(state.manual_review?{manual_review:true}:{}),warn};}
function completed(c,state) {return {ok:true,id:Number(c.id),delivery_complete:true,...(state.egrn?.note?{warn:state.egrn.note}:{})};}

function createHandoffSubmitter(options={}) {
  const pool=options.pool||require('../db/pool');let initialized;
  async function ensure() {
    if(!initialized)initialized=(async()=>{if(options.ready)await options.ready();await pool.query(DDL);})().catch(error=>{initialized=null;throw error;});
    return initialized;
  }
  const packetService=()=>options.packetService||require('./handoff-packet').createPacketService({pool});
  const telegram=()=>options.telegram||require('../bot/instance').telegram;
  let budgetLedger;
  const accountingText=async()=>{
    try {const ledger=budgetLedger||=require('../bot/egrn-budget').createEgrnBudget({pool});return ledger.describe(await ledger.snapshot());}
    catch(_){return 'Учёт заказов временно недоступен; остаток не сверён.';}
  };
  const loadReport=(src,id)=>options.loadReport?options.loadReport(src,id):src==='a'?pool.query('SELECT * FROM audits WHERE id=$1',[id]).then(result=>result.rows[0]):Promise.reject(new Error('Legacy report loader is not configured'));
  const getExisting=(client,user,submitId)=>client.query('SELECT * FROM cases WHERE created_by=$1 AND handoff_submit_id=$2',[user,submitId]).then(result=>result.rows[0]);
  function compatible(c,signature) {
    if(c.handoff_signature!==signature){const error=new HandoffError(409,'HANDOFF_BODY_CHANGED','Передача уже началась с другими данными. Продолжите сохранённую передачу без изменений.');error.case_created=true;error.case_id=Number(c.id);throw error;}
    const state=json(json(c.data)._handoff);
    if(state.version!==2||!state.packet||!state.body) {const error=new HandoffError(409,'HANDOFF_CHECKPOINT_MISSING','Не удалось подтвердить состояние передачи. Проверьте созданного клиента перед повтором.');error.case_created=true;error.case_id=Number(c.id);throw error;}
    return state;
  }
  return async function submit({body,user,staff}={}) {
    if (!canManageCases(staff, user && user.id)) fail(403, 'HANDOFF_FORBIDDEN', 'Передавать клиента может менеджер.');
    let owner = String(user?.id || '');
    if (!/^[1-9]\d{0,19}$/.test(owner)) fail(401, 'HANDOFF_AUTH', 'Не удалось определить сотрудника.');
    if (body?.resume_case_id != null) {
      const caseId = positive(body.resume_case_id, 'Некорректный номер передачи.');
      await ensure();
      const row = (await pool.query('SELECT * FROM cases WHERE id=$1', [caseId])).rows[0];
      const checkpoint = row && json(json(row.data)._handoff);
      if (!row || checkpoint.version !== 2 || !checkpoint.body) fail(409, 'HANDOFF_CHECKPOINT_MISSING', 'Не найдена сохранённая передача. Проверьте карточку клиента.');
      // Resume the frozen manager-confirmed body and its original idempotency
      // owner, never a newly reconstructed client payload or changed recipient.
      owner = String(row.created_by);
      body = checkpoint.body;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.handoff_version !== 2 || !UUID.test(body.submit_id || '')) fail(400, 'HANDOFF_INVALID', 'Для передачи нужен постоянный номер отправки и версия формы 2.');
    const orderId=positive(body.order_id,'Выберите заявку на выезд.'),reportId=positive(body.report_id,'Выберите сохранённый отчёт аудитора.');
    if(orderId>2147483647||reportId>2147483647)fail(400,'HANDOFF_INVALID','Некорректный номер заявки или отчёта.');
    if(!['a','r'].includes(body.report_src))fail(400,'HANDOFF_INVALID','Выберите сохранённый отчёт аудитора.');
    let serialized;try{serialized=canonical(body);}catch(_){fail(400,'HANDOFF_INVALID','Не удалось прочитать данные передачи.');}
    if(Buffer.byteLength(serialized)>2*1024*1024)fail(413,'HANDOFF_INVALID','Слишком большой текст передачи.');
    const signature=createHash('sha256').update(serialized).digest('hex'),submitId=body.submit_id.toLowerCase();
    let c,state,client,locked=false,orderLocked=false,unlockError,receiptPending=false;
    try {
      await ensure();
      c=await getExisting(pool,owner,submitId);
      if(c){state=compatible(c,signature);if(state.completed&&!hasPendingLinkedEgrn(state,c.lawyer_tg_id))return completed(c,state);if(state.manual_review)return partial(c,state,state.manual_review,false);}
      client=await getSessionLockPool(pool,options.lockPool).connect();
      locked=!!(await client.query('SELECT pg_try_advisory_lock(111,hashtext($1)) AS locked',[owner+':'+submitId])).rows[0]?.locked;
      if(!locked){if(c)return partial(c,state,'Передача уже выполняется. Повторите проверку результата.',true);const busy=new HandoffError(409,'HANDOFF_BUSY','Передача уже выполняется. Повторите проверку результата.');delete busy.case_created;throw busy;}
      c=await getExisting(client,owner,submitId);
      if(c){state=compatible(c,signature);if(state.completed&&!hasPendingLinkedEgrn(state,c.lawyer_tg_id))return completed(c,state);if(state.inflight||state.materials?.inflight)state.manual_review='Не удалось сохранить подтверждение предыдущей отправки. Проверьте уже доставленные сообщения вручную; автоматический повтор остановлен, чтобы не создавать дубли.';if(state.manual_review)return partial(c,state,state.manual_review,false);}
      else {
        orderLocked=!!(await client.query('SELECT pg_try_advisory_lock(112,$1) AS locked',[orderId])).rows[0]?.locked;
        const assigned=(await client.query('SELECT * FROM cases WHERE order_id=$1 ORDER BY id DESC LIMIT 1',[orderId])).rows[0];
        if(assigned){
          const error=new HandoffError(409,'HANDOFF_ALREADY_ASSIGNED','Заявка уже передана юристу «'+(value(assigned.lawyer_name)||'не указан')+'», клиент №'+assigned.id+'.');
          const assignedState = json(json(assigned.data)._handoff);
          if (assignedState.version === 2) {
            error.delivery_complete = assignedState.completed === true && !hasPendingLinkedEgrn(assignedState,assigned.lawyer_tg_id);
            error.can_resume = !error.delivery_complete && !assignedState.manual_review;
          }
          error.case_created=true;error.case_id=Number(assigned.id);error.retry=false;throw error;
        }
        if(!orderLocked){const busy=new HandoffError(409,'HANDOFF_BUSY','Передача этой заявки уже выполняется. Проверьте результат перед повтором.');delete busy.case_created;busy.retry=true;throw busy;}
        const d=fields(body),lawyerId=positive(body.lawyer_tg_id,'Выберите юриста.');
        const packet=await packetService().packet({order_id:orderId,report_src:body.report_src,report_id:reportId,request_id:body.request_id||null});
        if(!packet?.order||!packet.report||packet.report.id!==reportId||packet.report.src!==body.report_src||Number(packet.order.id)!==orderId)fail(409,'HANDOFF_REPORT_UNAVAILABLE','Не удалось подтвердить выбранный отчёт и заявку.');
        if(!/^[a-f\d]{64}$/i.test(body.packet_signature||'')||body.packet_signature!==packet.signature)fail(409,'HANDOFF_PACKET_CHANGED','Заявка или её документы изменились. Обновите комплект перед передачей.');
        const lawyer=(await client.query("SELECT tg_id,name FROM staff WHERE tg_id=$1 AND role='lawyer' AND approved=true",[lawyerId])).rows[0];
        if(!lawyer)fail(400,'HANDOFF_LAWYER','Юрист не найден среди одобренных сотрудников.');
        const checklist=(options.pickChecklist||require('../checklists').pickChecklist)(d.region,d.kind,d.service);
        if(!checklist)fail(400,'HANDOFF_CHECKLIST','Для выбранной услуги не найден чек-лист.');
        const picked=await loadReport(body.report_src,reportId),source=sourceReport(picked);
        const requestId=body.request_id?positive(body.request_id,'Некорректный номер исходной заявки.'):null;
        if (requestId !== (packet.request ? Number(packet.request.id) : null)) fail(409, 'HANDOFF_REQUEST_MISMATCH', 'Исходная заявка не совпадает с просмотренным комплектом. Обновите форму.');
        let request=null;
        if(requestId){
          const row=(await client.query('SELECT chat_id,msg_ids,first_id FROM reports WHERE id=$1',[requestId])).rows[0];
          if(!row)fail(409,'HANDOFF_REQUEST_UNAVAILABLE','Сохранённая исходная заявка не найдена. Обновите форму перед передачей.');
          const original=sourceReport({...row,msg_ids:Array.isArray(row.msg_ids)&&row.msg_ids.length?row.msg_ids:row.first_id?[row.first_id]:[]});
          const alreadyIncluded=new Set(sourceParts(source).filter(part=>part.chat_id===original.chat_id).flatMap(part=>part.message_ids));
          request={id:requestId,...original,first_id:Number(row.first_id)||null,copy_ids:original.message_ids.filter(id=>!alreadyIncluded.has(id))};
        }
        const recipients=[{chat:String(lawyer.tg_id),role:'lawyer'}];
        state={version:2,body:JSON.parse(serialized),fields:d,packet,source,request,manager_name:value(staff?.name),recipients,cards:{},auditCopies:{},requestCopies:{},materials:{confirmed:{},completed:false},linkedEgrn:{files:linkedOriginals(packet),confirmed:{},completed:false},egrn:{completed:false,order_started:false},completed:false};
        reportUrl(options.webappUrl||process.env.WEBAPP_URL,state);
        c=(await client.query(`INSERT INTO cases(order_id,lawyer_tg_id,lawyer_name,checklist_key,org,inn,client,phone,address,region,kind,service,priority,comment,audit_text,total,created_by,contacts,request_id,handoff_submit_id,handoff_signature,data)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$17,$18,$19,$20,$21)
          ON CONFLICT(created_by,handoff_submit_id) WHERE handoff_submit_id IS NOT NULL DO NOTHING RETURNING *`,
          [orderId,lawyer.tg_id,lawyer.name,checklist,d.org,d.inn,d.client,d.phone,d.address,d.region,d.kind,d.service,d.priority,d.comment,packet.report.text,owner,JSON.stringify(d.contacts),requestId,submitId,signature,JSON.stringify({_handoff:state})])).rows[0];
        if(!c){c=await getExisting(client,owner,submitId);if(!c)throw new Error('No durable handoff case');state=compatible(c,signature);}
      }
      c.contacts=Array.isArray(c.contacts)?c.contacts:json(c.contacts);if(!Array.isArray(c.contacts))c.contacts=state.fields.contacts;
      // Older checkpoints include shared chats. Rebuild the destination from
      // the assigned lawyer on every retry, preserving their file receipts.
      state.recipients=[{chat:String(positive(c.lawyer_tg_id,'Не удалось определить личный чат юриста.')),role:'lawyer'}];
      const recipientError=message=>Object.assign(new Error(message),{code:'HANDOFF_RECIPIENT_UNAVAILABLE'});
      const checkRecipient=async chat=>{
        let row;
        try {row=(await client.query(`SELECT c.lawyer_tg_id,s.tg_id,s.role,s.approved FROM cases c
          LEFT JOIN staff s ON s.tg_id=c.lawyer_tg_id WHERE c.id=$1`,[c.id])).rows[0];}
        catch(_){throw recipientError('Не удалось проверить доступ назначенного юриста. Повторите передачу; подтверждённые материалы сохранены.');}
        if(!row||String(row.lawyer_tg_id)!==String(chat)||!canAccessCase(row,chat,row))throw recipientError('Получатель больше недоступен или назначение изменилось. Проверьте юриста и повторите передачу; подтверждённые материалы не отправятся повторно.');
      };
      const save=async()=>{await client.query("UPDATE cases SET data=jsonb_set(COALESCE(data,'{}'::jsonb),'{_handoff}',$1::jsonb,true) WHERE id=$2",[JSON.stringify(state),c.id]);};
      const send=async(operation,run)=>{
        await checkRecipient(operation.chat);
        state.inflight=operation;await save();let result;
        try{result=await run();}catch(error){
          const code=Number(error?.response?.error_code);
          if(code>=400&&code<500||error?.code==='HANDOFF_RECIPIENT_UNAVAILABLE'){state.inflight=null;await save();}
          else{state.manual_review='Результат отправки в Telegram не подтверждён. Проверьте сообщения вручную; автоматический повтор остановлен, чтобы не создавать дубли.';await save();}
          throw error;
        }
        receiptPending=true;return result;
      };
      const validateReceipts=(chat,result)=>{
        const copied=state.auditCopies[String(chat)],request=state.requestCopies?.[String(chat)];
        const known=new Set([state.cards[String(chat)],...(copied?.messageIds||[]),...Object.values(copied?.sources||{}).flatMap(source=>source.messageIds||[]),
          ...(request?.messageIds||[]),...(state.materials.confirmed?.[String(chat)]||[]),...Object.values(state.linkedEgrn?.confirmed?.[String(chat)]||{}).map(receipt=>receipt?.message_id)].map(messageId).filter(Boolean));
        for(const receipt of Array.isArray(result)?result:[result]){
          const id=messageId(receipt?.message_id);
          if(!id||known.has(id)||receipt?.chat!=null&&String(receipt.chat.id)!==String(chat))throw Object.assign(new Error('Telegram не подтвердил новые сообщения в личном чате юриста.'),{code:'HANDOFF_TELEGRAM_RECEIPT'});
          known.add(id);
        }
        return result;
      };
      const transport=telegram(),tg={
        async sendMessage(chat,...args){await checkRecipient(chat);return validateReceipts(chat,await transport.sendMessage(chat,...args));},
        async sendDocument(chat,...args){await checkRecipient(chat);return validateReceipts(chat,await transport.sendDocument(chat,...args));},
        async callApi(method,payload){await checkRecipient(payload.chat_id);return validateReceipts(payload.chat_id,await transport.callApi(method,payload));},
      },base=options.webappUrl||process.env.WEBAPP_URL;
      state.linkedEgrn||={files:linkedOriginals(state.packet),confirmed:{},completed:false};
      if(hasPendingLinkedEgrn(state,c.lawyer_tg_id)&&state.completed){state.completed=false;await save();}
      for(const target of state.recipients){
        if(state.cards[target.chat])continue;
        const sent=await send({type:'card',chat:target.chat},()=>tg.sendMessage(target.chat,cardText(c,state),cardOptions(base,c,state)));
        if(!Number.isSafeInteger(Number(sent?.message_id))||Number(sent.message_id)<1)throw new Error('Missing card receipt');
        state.cards[target.chat]=Number(sent.message_id);state.inflight=null;await save();receiptPending=false;
      }
      for(const target of state.recipients){
        const recipient=state.auditCopies[target.chat]||{offset:0,messageIds:[]};state.auditCopies[target.chat]=recipient;
        for(const [index,source] of sourceParts(state.source).entries()){
          // Version 2 originally stored one source and this flat cursor. Keep
          // using it for the first source so old in-progress cases resume safely.
          let checkpoint=recipient;
          if(index>0){recipient.sources||={};checkpoint=recipient.sources[source.chat_id]||{offset:0,messageIds:[]};recipient.sources[source.chat_id]=checkpoint;}
          while(checkpoint.offset<source.message_ids.length){
            const batch=source.message_ids.slice(checkpoint.offset,checkpoint.offset+100);
            const copied=await send({type:'audit',chat:target.chat,sourceChat:source.chat_id,sourceIds:batch},()=>tg.callApi('copyMessages',{chat_id:target.chat,from_chat_id:source.chat_id,message_ids:batch}));
            const ids=Array.isArray(copied)?copied.map(item=>Number(item?.message_id)):[];
            if(ids.some(id=>!Number.isSafeInteger(id)||id<1)||ids.length!==batch.length){
              checkpoint.partial={sourceIds:batch,messageIds:ids.filter(id=>Number.isSafeInteger(id)&&id>0)};
              state.manual_review='Telegram подтвердил не все сообщения отчёта. Проверьте доставленный комплект вручную; повторная передача этого блока остановлена, чтобы не создавать дубли.';
              state.inflight=null;await save();receiptPending=false;return partial(c,state,state.manual_review,false);
            }
            checkpoint.offset+=batch.length;checkpoint.messageIds.push(...ids);state.inflight=null;await save();receiptPending=false;
          }
        }
      }
      if(state.request){
        const target=String(c.lawyer_tg_id),source=state.request;
        state.requestCopies||={};const checkpoint=state.requestCopies[target]||{offset:0,messageIds:[]};state.requestCopies[target]=checkpoint;
        const wanted=source.chat_id===target?[]:source.copy_ids;
        while(checkpoint.offset<wanted.length){
          const batch=wanted.slice(checkpoint.offset,checkpoint.offset+100);
          const copied=await send({type:'request',chat:target,sourceIds:batch},()=>tg.callApi('copyMessages',{chat_id:target,from_chat_id:source.chat_id,message_ids:batch}));
          const ids=Array.isArray(copied)?copied.map(item=>Number(item?.message_id)):[];
          if(ids.some(id=>!Number.isSafeInteger(id)||id<1)||ids.length!==batch.length){
            checkpoint.partial={sourceIds:batch,messageIds:ids.filter(id=>Number.isSafeInteger(id)&&id>0)};
            state.manual_review='Telegram подтвердил не все сообщения исходной заявки. Проверьте доставленные документы вручную; автоматический повтор остановлен, чтобы не создавать дубли.';
            state.inflight=null;await save();receiptPending=false;return partial(c,state,state.manual_review,false);
          }
          checkpoint.offset+=batch.length;checkpoint.messageIds.push(...ids);state.inflight=null;await save();receiptPending=false;
        }
      }
      if(!state.materials.completed){
        const deliver=options.materialDelivery||require('./handoff-materials').createHandoffMaterialsDelivery({telegram:tg});
        const targets=state.recipients.map(target=>({chat:target.chat,reply:state.cards[target.chat]}));
        const exclude=new Set(state.source.hashes||[]);
        const result=await deliver(Number(state.body.order_id),targets,exclude,{expectedFiles:state.packet.materials,packetHash:state.materials.packetHash,confirmed:state.materials.confirmed,beforeSend:chat=>checkRecipient(chat),
          onPrepared:async prepared=>{Object.assign(state.materials,prepared);state.materials.inflight=true;await save();},
          onPart:async(chat,index,id,prepared)=>{receiptPending=true;validateReceipts(chat,{message_id:id});Object.assign(state.materials,prepared);const key=String(chat),ids=state.materials.confirmed[key]||[];if(index!==ids.length)throw new Error('Noncontiguous material receipt');ids.push(id);state.materials.confirmed[key]=ids;await save();receiptPending=false;}});
        if(!result?.ok){
          if(result?.failed?.some(failure=>failure.stage==='receipt'||failure.uncertain===true)){state.manual_review='Результат передачи оригинала не подтверждён. Проверьте уже отправленные документы вручную; автоматический повтор остановлен.';await save();receiptPending=false;return partial(c,state,state.manual_review,false);}
          state.materials.inflight=false;await save();return partial(c,state,(result?.warnings||[]).join(' ')||'Не все оригиналы документов доставлены. Повторите передачу без создания нового клиента.',true);
        }
        state.materials.completed=true;state.materials.inflight=false;await save();
      }
      if(state.linkedEgrn.files.length){
        const links=state.linkedEgrn,target=String(c.lawyer_tg_id);
        links.confirmed||={};links.confirmed[target]||={};
        const resolve=options.resolveEgrnLinkForDelivery||require('./order-egrn-links').resolveOrderLinkForDelivery;
        for(const file of links.files){
          if(linkedReceipt(state,target,file.id))continue;
          let original;
          try{original=await resolve(Number(state.body.order_id),file.id,file);}
          catch(_){return partial(c,state,'Не удалось открыть связанную выписку ЕГРН из просмотренного комплекта. Она ещё не доставлена; повторите передачу. Новый заказ не создавался.',true);}
          // Old strict EGRN copies used [recipient, original source key]. Only
          // an exact original resolved by the server may reuse that receipt.
          const legacy=typeof original?.source_key==='string'&&original.source_key?JSON.stringify([target,original.source_key]):null;
          if(legacy&&state.egrn.copies?.[legacy]===true){links.confirmed[target][file.id]={legacy_receipt:legacy};await save();continue;}
          const url=original?.kind==='link'&&https(original.url);
          const native=original?.kind==='telegram'&&/^-?\d+$/.test(String(original.chat_id))&&Number.isSafeInteger(Number(original.message_id))&&Number(original.message_id)>0;
          if(!url&&!native)return partial(c,state,'Не удалось подтвердить источник связанной выписки ЕГРН. Выписка ещё не доставлена; повторите передачу. Новый заказ не создавался.',true);
          const sent=await send({type:'linked-egrn',chat:target,original_id:file.id},async()=>{
            let receipt;
            if(url){
              receipt=await tg.sendMessage(target,'📄 Выписка ЕГРН: '+file.name+'\nОригинал: '+file.bytes+' байт. Если срок ссылки истёк, обновите её кнопкой ниже.\n'+await accountingText(),{
                reply_to_message_id:state.cards[target],reply_markup:{inline_keyboard:[[{text:'Скачать оригинал',url}],[{text:'Обновить ссылку',callback_data:'egf:'+file.id}]]}});
            }else{
              try{receipt=await tg.callApi('copyMessage',{chat_id:target,from_chat_id:original.chat_id,message_id:Number(original.message_id),reply_parameters:{message_id:state.cards[target],allow_sending_without_reply:true}});}
              catch(error){
                if(Number(error?.response?.error_code)!==400||!/message to copy not found/i.test(error.response.description||'')||typeof original.file_id!=='string'||!original.file_id)throw error;
                receipt=await tg.sendDocument(target,original.file_id,{caption:file.name,reply_to_message_id:state.cards[target]});
              }
            }
            if(!Number.isSafeInteger(Number(receipt?.message_id))||Number(receipt.message_id)<1)throw new Error('Missing linked EGRN receipt');
            return receipt;
          });
          links.confirmed[target][file.id]={message_id:Number(sent.message_id)};state.inflight=null;await save();receiptPending=false;
        }
        links.completed=true;state.egrn.completed=true;state.egrn.result='included-links';state.egrn.note='Связанные выписки ЕГРН доставлены юристу.\n'+await accountingText();await save();
      }
      if(!state.egrn.completed){
        const egrn=state.egrn,cad=state.fields.cad_num;
        if(state.packet.materials.some(file=>file.role==='egrn')){egrn.completed=true;egrn.result='included';}
        else if(!cad){egrn.completed=true;egrn.result='none';egrn.note='ЕГРН не включена: кадастровый номер не указан.';}
        else {
          await checkRecipient(String(c.lawyer_tg_id));
          const order=state.body.egrn_order===true&&!egrn.order_started;
          if(order){egrn.order_started=true;await save();}
          let result;
          try {result=await (options.attachEgrn||require('../bot/egrn').attachOrOrder)({cad,label:c.org,order,orderedBy:owner,orderedName:state.manager_name,targets:[{chat:Number(c.lawyer_tg_id),reply:state.cards[String(c.lawyer_tg_id)],case_id:Number(c.id)}],note:'Для клиента '+c.org+' (юрист '+c.lawyer_name+')',
            copyOptions:{strict:true,confirmed:egrn.copies||{},beforeSend:target=>checkRecipient(target.chat),onCopied:async(key)=>{egrn.copies||={};egrn.copies[key]=true;await save();}}});}
          catch(error){
            if(error?.code==='HANDOFF_RECIPIENT_UNAVAILABLE')throw error;
            if(error?.uncertain===true){state.manual_review='Результат отправки выписки ЕГРН не подтверждён. Проверьте уже доставленные файлы вручную; автоматический повтор остановлен.';await save();return partial(c,state,state.manual_review,false);}
            egrn.uncertain=order||egrn.uncertain;await save();return partial(c,state,'Пакет клиента создан, но готовность или доставка ЕГРН не подтверждена. Повторите проверку; новый платный заказ повторно не создаётся.',true);
          }
          egrn.result=value(result?.result)||'none';
          if(egrn.uncertain&&!['attached','ordered','waiting'].includes(egrn.result)){
            state.manual_review='Не удалось подтвердить результат ранее начатого заказа ЕГРН. Проверьте заказ вручную; повторный платный запрос не создан.';await save();return partial(c,state,state.manual_review,false);
          }
          egrn.note={attached:'Выписка ЕГРН приложена юристу.',ordered:'Выписка ЕГРН заказана и придёт юристу после готовности.',waiting:'Выписка ЕГРН уже в работе и придёт юристу после готовности.',unavailable:'ЕГРН не включена: доставка ранее заказанной выписки остановлена; новый заказ не создан.',none:'ЕГРН не включена: готовая выписка не найдена, новый заказ не создавался.',missing:'ЕГРН не включена: готовая выписка не найдена, новый заказ не создавался.'}[egrn.result]||'Готовность ЕГРН не подтверждена; выписка не включена в переданный комплект.';
          if(result?.budget_text)egrn.note+='\n'+result.budget_text;
          egrn.completed=true;
        }
        await save();
      }
      state.completed=true;await save();return completed(c,state);
    } catch(error) {
      if(c&&state&&error?.code==='HANDOFF_RECIPIENT_UNAVAILABLE')return partial(c,state,error.message,true);
      if(c&&state&&receiptPending){state.manual_review='Сообщения отправлены, но подтверждение передачи не сохранилось. Проверьте комплект вручную; автоматический повтор остановлен.';return partial(c,state,state.manual_review,false);}
      if(c&&state&&state.manual_review)return partial(c,state,state.manual_review,false);
      if(c&&state&&!(error instanceof HandoffError))return partial(c,state,'Клиент уже создан, но передача полного комплекта не завершена. Повторите доставку без создания нового клиента.',true);
      if(error instanceof HandoffError)throw error;
      const safe=new Error('Не удалось подтвердить создание или доставку клиента. Повторите ту же передачу без изменения данных.');safe.status=503;safe.code='HANDOFF_UNAVAILABLE';throw safe;
    } finally {
      if(client){
        if(orderLocked){try{await client.query('SELECT pg_advisory_unlock(112,$1)',[orderId]);}catch(error){unlockError=error;}}
        if(locked){try{await client.query('SELECT pg_advisory_unlock(111,hashtext($1))',[owner+':'+submitId]);}catch(error){unlockError=error;}}
        client.release(unlockError);
      }
    }
  };
}
module.exports={createHandoffSubmitter,HandoffError,DDL,hasPendingLinkedEgrn};
