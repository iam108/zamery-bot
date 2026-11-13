'use strict';

const {createHash}=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {canAccessCase}=require('./auth');
const {zipParts,createMaterialsStore,LIMITS}=require('./order-materials');
const {createManualMaterialsStore}=require('./handoff-manual-materials');
const {createCaseDocumentsService}=require('./handoff-case-documents');
const {createPacketService}=require('./handoff-packet');
const {createOrderEgrnLinks}=require('./order-egrn-links');
const {savedCaseProfile}=require('./handoff-case-profile');
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const MAX_BYTES=1024*1024*1024,MAX_FILES=1000;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
function fail(status,code,message){throw Object.assign(new Error(message),{status,code});}
function positive(v){return /^[1-9]\d*$/.test(String(v))&&Number.isSafeInteger(Number(v));}
function component(value,fallback='Документ'){
  let result=String(value||'').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'').trim();
  result=[...result].slice(0,90).join('');
  if(!result||/^\.+$/.test(result))result=fallback;
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result))result='_'+result;
  return result;
}
function documentName(value){
  const name=String(value||''),extension=(name.match(/\.[a-z\d]{1,10}$/i)||[])[0]||'';
  return extension?component(name.slice(0,-extension.length))+extension:component(name);
}
function https(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
function contactLines(row, profile) {
  const contacts = profile?.contacts || [];
  if (!contacts.length) return [row.client, row.phone].filter(Boolean).join(' · ');
  return contacts.map(contact => [
    [contact.name, contact.phone, contact.tg].filter(Boolean).join(' · '),
    contact.comment,
  ].filter(Boolean).join('\n')).join('\n\n');
}
function caseSnapshot(row) {
  const state = object(object(row.data)._handoff);
  return JSON.stringify([savedCaseProfile(row), row.org, row.address, row.client, row.phone, row.audit_text,
    row.created_by, row.handoff_submit_id, row.lawyer_tg_id, row.order_id, state.body, state.packet]);
}
function entries(value){if(value==null)return [];if(!Array.isArray(value))fail(409,'CASE_PACKAGE_CHANGED','Не удалось подтвердить состав документов клиента.');return value;}
function expected(file){
  if(!file||!UUID.test(file.id||'')||typeof file.name!=='string'||typeof file.mime!=='string'||!Number.isSafeInteger(Number(file.bytes))||Number(file.bytes)<1||Number(file.bytes)>LIMITS.fileBytes)
    fail(409,'CASE_PACKAGE_CHANGED','Не удалось подтвердить сведения об оригинале документа.');
  return file;
}
function verify(file,wanted){
  if(!file||!Buffer.isBuffer(file.buffer)||file.buffer.length!==Number(wanted.bytes)||file.buffer.length>LIMITS.fileBytes||
      !['id','name','mime','role','subject_id'].every(k=>wanted[k]==null||String(file[k]??'')===String(wanted[k]))||
      !/^[a-f\d]{64}$/i.test(file.sha256||'')||wanted.sha256&&file.sha256!==wanted.sha256||
      createHash('sha256').update(file.buffer).digest('hex')!==file.sha256)
    fail(503,'CASE_PACKAGE_INTEGRITY','Не удалось проверить оригинал. Комплект не скачан; повторите попытку.');
  return file.buffer;
}
// Reuse the existing ZIP encoder one original at a time. Only central headers
// remain in memory; originals are released before loading the next file.
async function* archiveParts(items,{check=async()=>{},signal}={}){
  const central=[];let offset=0;
  const guard=async()=>{signal?.throwIfAborted();await check();signal?.throwIfAborted();};
  for(const item of items){
    await guard();const buffer=await item.load();await guard();
    if(!Buffer.isBuffer(buffer)||buffer.length!==item.bytes)fail(503,'CASE_PACKAGE_INTEGRITY','Не удалось проверить размер документа.');
    const parts=zipParts([{relative_path:item.path,buffer}],{preservePaths:true});
    const header=parts.next().value,name=parts.next().value,content=parts.next().value,directory=parts.next().value;
    directory.writeUInt32LE(offset,42);central.push(directory);offset+=header.length+name.length+content.length;
    yield header;yield name;yield content;
  }
  await guard();const start=offset;
  for(const directory of central){yield directory;offset+=directory.length;}
  // A revoked/changed assignment must never result in a valid completed ZIP.
  await guard();const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(offset-start,12);end.writeUInt32LE(start,16);yield end;
}
function createCasePackageService(options={}){
  const pool=options.pool||require('../db/pool');
  const materials=options.materials||createMaterialsStore(pool),manual=options.manual||createManualMaterialsStore(pool);
  const documents=options.documents||createCaseDocumentsService({pool,ready:options.ready});
  const reports=options.reports||createPacketService({pool}),egrn=options.egrn||createOrderEgrnLinks({pool,readOnly:true});
  async function access(caseId,actorId){
    if(!positive(caseId)||Number(caseId)>2147483647)fail(400,'CASE_PACKAGE_INVALID','Некорректный клиент.');
    if(!positive(actorId))fail(401,'CASE_PACKAGE_FORBIDDEN','Откройте клиента из бота.');
    const record=(await pool.query('SELECT to_jsonb(c) AS access_case,s.tg_id,s.role,s.approved FROM cases c LEFT JOIN staff s ON s.tg_id=$2 WHERE c.id=$1',[caseId,actorId])).rows[0];
    if(!record||!canAccessCase(record,actorId,record.access_case))fail(403,'CASE_PACKAGE_FORBIDDEN','Этот клиент недоступен вашему аккаунту.');
    return record.access_case;
  }
  async function prepare(caseId,actorId){
    if(options.ready)await options.ready();const c=await access(caseId,actorId),state=object(object(c.data)._handoff),packet=object(state.packet),body=object(state.body);
    const snapshot=caseSnapshot(c),profile=savedCaseProfile(c);
    const check=async()=>{if(snapshot!==caseSnapshot(await access(caseId,actorId)))fail(409,'CASE_PACKAGE_CHANGED','Клиент или состав документов изменился. Скачайте комплект заново.');};
    const root=component(c.org,'Клиент')+'/Клиент №'+Number(caseId),items=[],links=['Документы, которые открываются отдельно. Они не включены в ZIP.'],used=new Set();
    let total=0;
    function add(name,bytes,load){
      if(!Number.isSafeInteger(bytes)||bytes<0)fail(409,'CASE_PACKAGE_CHANGED','Некорректный размер документа.');
      const path=root+'/'+name;if(used.has(path))fail(409,'CASE_PACKAGE_CHANGED','Повторяющийся файл в комплекте.');used.add(path);
      total+=bytes+76+2*Buffer.byteLength(path);if(items.length>=MAX_FILES||total>MAX_BYTES)fail(413,'CASE_PACKAGE_TOO_LARGE','Комплект слишком большой. Скачайте документы по отдельности из карточки клиента.');
      items.push({path,bytes,load});
    }
    function text(name,value){const buffer=Buffer.from(value+'\n','utf8');add(name,buffer.length,async()=>buffer);}
    function original(group,file,index,load){expected(file);add(group+'/'+String(index+1).padStart(3,'0')+'-'+documentName(file.name),Number(file.bytes),async()=>verify(await load(),file));}
    const contacts = contactLines(c, profile);
    const identifiers = [c.inn && 'ИНН '+c.inn, profile?.cad_num && 'Кадастровый номер '+profile.cad_num].filter(Boolean).join(' · ');
    text('Отчёт.txt',[c.org||'Клиент','Клиент №'+Number(caseId),c.address||'',
      [c.kind,c.service,c.region].filter(Boolean).join(' · '),identifiers,
      contacts && 'Контакты\n'+contacts,c.priority?'Приоритет '+c.priority:'',
      c.comment?'Комментарий менеджера\n'+c.comment:'',
      'Отчёт аудитора\n'+(packet.report?.text||c.audit_text||'Отчёт аудитора не привязан к этому клиенту.')].filter(Boolean).join('\n\n'));
    const orderId=Number(c.order_id||0);
    if(state.version===2){
      if(Number(body.order_id||0)!==orderId||Number(packet.order?.id||0)!==orderId)fail(409,'CASE_PACKAGE_CHANGED','Связь с исходной заявкой изменилась.');
      const report=packet.report;
      if(!report&&body.report_id)fail(409,'CASE_PACKAGE_CHANGED','Сохранённый отчёт клиента недоступен.');
      if(report){
        if(!['a','r'].includes(report.src)||Number(body.report_id)!==Number(report.id)||body.report_src!==report.src||report.order_id&&Number(report.order_id)!==orderId)fail(409,'CASE_PACKAGE_CHANGED','Связь с отчётом аудитора изменилась.');
        if(report.src==='a'){
          const record=(await pool.query('SELECT id,order_id FROM audits WHERE id=$1',[report.id])).rows[0];
          if(!record||record.order_id&&Number(record.order_id)!==orderId)fail(409,'CASE_PACKAGE_CHANGED','Отчёт аудитора больше не относится к этому клиенту.');
          entries(report.media).forEach((file,i)=>original('Аудит',file,i,()=>reports.file(report.id,file.id)));
        }else if(entries(report.media).length)fail(409,'CASE_PACKAGE_CHANGED','Неизвестный источник оригиналов отчёта.');
        const url=https(report.telegram_url);if(url)links.push('Сообщение с отчётом и материалами в Telegram: '+url);
        if(!entries(report.media).length)links.push('Оригиналы аудита не сохранены в файловом хранилище. Смотрите сообщение с отчётом в Telegram.');
        if(https(report.video_url))links.push('Видео осмотра: '+https(report.video_url));
      }
      entries(packet.materials).forEach((file,i)=>{if(!orderId)fail(409,'CASE_PACKAGE_CHANGED','Не найдена исходная заявка документов.');original('Документы заявки',file,i,()=>materials.download(orderId,file.id));});
      const initial=entries(packet.manual_materials);
      if(initial.length&&(!positive(c.created_by)||!UUID.test(c.handoff_submit_id||'')||!UUID.test(body.submit_id||'')||body.submit_id.toLowerCase()!==c.handoff_submit_id.toLowerCase()))fail(409,'CASE_PACKAGE_CHANGED','Не удалось подтвердить исходные документы менеджера.');
      if(initial.length&&(body.manual_client!==true||JSON.stringify(initial.map(f=>Object.fromEntries(['id','name','mime','role','bytes','sha256'].map(k=>[k,f[k]]))))!==JSON.stringify(entries(body.manual_files).map(f=>Object.fromEntries(['id','name','mime','role','bytes','sha256'].map(k=>[k,f[k]]))))))fail(409,'CASE_PACKAGE_CHANGED','Состав исходных документов менеджера изменился.');
      initial.forEach((file,i)=>original('Документы менеджера',file,i,()=>manual.read(c.created_by,c.handoff_submit_id,file.id)));
      const extracts=entries(state.linkedEgrn?.files||packet.egrn_links);
      if(extracts.length){
        let available=[];try{available=await egrn.list(orderId);}catch{}await check();
        for(const file of extracts){
          const saved=available.find(v=>v.id===file.id);
          if(!saved||!['name','mime','source'].every(k=>file[k]==null||file[k]===saved[k])||Number(saved.bytes)!==Number(file.bytes)||file.sha256&&file.sha256!==saved.sha256){links.push('ЕГРН — '+String(file.name||'выписка')+': ссылка недоступна; откройте выписку из бота.');continue;}
          try{const result=await egrn.link(orderId,file.id),url=https(result.url);if(!url)throw new Error('Invalid URL');links.push('ЕГРН — '+file.name+': '+url);}catch{links.push('ЕГРН — '+file.name+': ссылка недоступна; обновите ссылку в боте.');}
          await check();
        }
        links.push('Ссылки на выписки могут истечь. Для обновления используйте карточку в боте; новый заказ не нужен.');
      }
      if(!extracts.length&&!entries(packet.materials).some(file=>file.role==='egrn')){
        const status=state.egrn?.result;
        if(status==='attached')links.push('ЕГРН отправлена юристу отдельно в Telegram. В ZIP оригинала нет.');
        else if(['ordered','waiting'].includes(status))links.push('ЕГРН на момент передачи ожидалась. Проверьте готовую выписку в Telegram; в ZIP оригинала нет.');
        else links.push('ЕГРН не включена: в сохранённой передаче нет связанного оригинала.');
      }
      if(https(packet.archive_url))links.push('Архив объекта: '+https(packet.archive_url));
    }else links.push('Историческая передача: подтверждённый список исходных файлов не сохранён. Они не добавлены автоматически.');
    const extra=await documents.list(Number(caseId),actorId);await check();
    entries(extra.files).forEach((file,i)=>original('Дополнительные документы',file,i,()=>documents.file(Number(caseId),file.batch_id,file.id,actorId)));
    if(links.length===1)links.push('Внешних материалов в сохранённой передаче нет.');
    text('Ссылки.txt',links.join('\n\n'));
    await check();return {name:component(c.org,'Клиент')+' — Клиент №'+Number(caseId)+'.zip',items,check,length:total+22};
  }
  return {prepare};
}
function setupCasePackage(app,options={}){
  const service=options.service||createCasePackageService(options);
  app.get('/api/handoff/cases/:caseId/package',async(req,res)=>{
    const controller=new AbortController(),closed=()=>{if(!res.writableFinished)controller.abort();};res.once('close',closed);req.once('aborted',closed);
    try{
      const result=await service.prepare(req.params.caseId,req.tgUser?.id);controller.signal.throwIfAborted();
      res.set('Cache-Control','no-store').set('X-Content-Type-Options','nosniff').set('Content-Type','application/zip').set('Content-Length',String(result.length));
      res.set('Content-Disposition',"attachment; filename=\"client-documents.zip\"; filename*=UTF-8''"+encodeURIComponent(result.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)));
      await pipeline(Readable.from(archiveParts(result.items,{check:result.check,signal:controller.signal})),res,{signal:controller.signal});
    }catch(error){if(!res.headersSent&&!res.destroyed)res.status(error.status||500).json({ok:false,code:error.code||'CASE_PACKAGE_FAILED',error:error.status?error.message:'Не удалось скачать комплект. Повторите попытку.'});else if(!res.destroyed)res.destroy();}
    finally{res.off('close',closed);req.off('aborted',closed);}
  });return service;
}
module.exports={createCasePackageService,setupCasePackage,archiveParts,component};
