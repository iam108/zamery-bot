'use strict';

const {canManageCases,canAccessCase}=require('./auth');
const {getSessionLockPool}=require('../db/session-lock-pool');
const {createManualMaterialsStore}=require('./handoff-manual-materials');
const {createHandoffMaterialsDelivery}=require('./handoff-materials');
const {LIMITS}=require('./order-materials');
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const positive=value=>(typeof value==='number'||typeof value==='string'&&/^[1-9]\d*$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
function fail(status,code,message){throw Object.assign(new Error(message),{status,code});}
function caseNumber(value){if(!positive(value)||Number(value)>2147483647)fail(400,'CASE_DOCUMENT_INVALID','Некорректный клиент.');return Number(value);}
function batchNumber(value){if(typeof value!=='string'||!UUID.test(value))fail(400,'CASE_DOCUMENT_INVALID','Не удалось определить пакет документов.');return value.toLowerCase();}
function metadata(file){return Object.fromEntries(['id','name','mime','role','bytes','sha256'].map(key=>[key,file[key]]));}
function requestedFiles(value){
  if(!Array.isArray(value)||!value.length||value.length>LIMITS.files)fail(400,'CASE_DOCUMENT_INVALID','Прикрепите от 1 до 20 документов.');
  return value.map(file=>{if(!file||typeof file!=='object'||Array.isArray(file))fail(400,'CASE_DOCUMENT_INVALID','Проверьте список документов.');return metadata(file);});
}
const ACCESS_SQL=`SELECT c.id,c.org,c.lawyer_tg_id,c.data,actor.tg_id,actor.role,actor.approved,
  lawyer.tg_id AS recipient_id,lawyer.role AS recipient_role,lawyer.approved AS recipient_approved
  FROM cases c LEFT JOIN staff actor ON actor.tg_id=$2 LEFT JOIN staff lawyer ON lawyer.tg_id=c.lawyer_tg_id WHERE c.id=$1`;

function createCaseDocumentsService(options={}){
  const pool=options.pool||require('../db/pool'),store=options.store||createManualMaterialsStore(pool);
  const ensure=async()=>{if(options.ready)await options.ready();await store.ensure();};
  async function access(caseId,actorId,manage=false,client=pool){
    if(!positive(actorId))fail(401,'CASE_DOCUMENT_FORBIDDEN','Не удалось определить сотрудника.');
    const row=(await client.query(ACCESS_SQL,[caseNumber(caseId),actorId])).rows[0];
    if(!(manage?row&&canManageCases(row,actorId):canAccessCase(row,actorId,row)))fail(403,'CASE_DOCUMENT_FORBIDDEN','Этот клиент недоступен вашему аккаунту.');
    return row;
  }
  function batchView(batch,caseRow){
    const state=object(batch.delivery),changed=String(batch.recipient_tg_id)!==String(caseRow.lawyer_tg_id);
    const uncertain=!!(state.review||state.inflight),status=uncertain?'review':state.completed?'delivered':'pending';
    const files=batch.files.map(file=>({...metadata(file),batch_id:batch.id,url:'/api/handoff/cases/'+batch.case_id+'/documents/'+batch.id+'/files/'+file.id}));
    return {id:String(batch.id),case_id:Number(batch.case_id),created_at:batch.created_at,status,files,
      retry:!state.completed&&!uncertain&&!changed,delivery_complete:state.completed===true,
      ...(state.review?{warn:state.review}:uncertain?{warn:'Результат отправки не подтверждён. Проверьте документы в Telegram перед повтором.'}:changed&&!state.completed?{warn:'Назначенный юрист изменился. Проверьте, кому нужно передать оставшиеся документы.'}:state.warning?{warn:state.warning}:{})};
  }
  async function list(caseId,actorId){
    caseId=caseNumber(caseId);await ensure();const c=await access(caseId,actorId);
    const rows=(await pool.query('SELECT * FROM case_document_batches WHERE case_id=$1 ORDER BY created_at,id',[caseId])).rows;
    await access(caseId,actorId);
    const batches=rows.map(row=>batchView(row,c));return {ok:true,case_id:caseId,org:c.org||'',batches,files:batches.flatMap(batch=>batch.files)};
  }
  async function file(caseId,batchId,fileId,actorId){
    caseId=caseNumber(caseId);batchId=batchNumber(batchId);fileId=batchNumber(fileId);await ensure();await access(caseId,actorId);
    const row=(await pool.query('SELECT * FROM case_document_batches WHERE id=$1 AND case_id=$2',[batchId,caseId])).rows[0];
    if(!row||!row.files.some(item=>item.id===fileId))fail(404,'CASE_DOCUMENT_MISSING','Документ не найден.');
    const expected=row.files.find(item=>item.id===fileId),found=await store.read(row.owner_tg_id,row.id,fileId);
    if(!found||JSON.stringify(metadata(found))!==JSON.stringify(metadata(expected)))fail(503,'CASE_DOCUMENT_INTEGRITY','Не удалось подтвердить целостность документа.');
    await access(caseId,actorId);return found;
  }
  async function send({caseId,actorId,submitId,files,retry=false}={}){
    caseId=caseNumber(caseId);submitId=batchNumber(submitId);if(!retry)files=requestedFiles(files);
    await ensure();let current=await access(caseId,actorId,true),client,batch,locked=false,uploadLocked=false,unlockError,owner=String(actorId),receiptPending=false;
    const respond=()=>{const view=batchView(batch,current);return {ok:true,case_id:caseId,batch:view,delivery_complete:view.delivery_complete,...(view.warn?{warn:view.warn}:{})};};
    try{
      client=await getSessionLockPool(pool,options.lockPool,'case-documents').connect();
      locked=!!(await client.query('SELECT pg_try_advisory_lock(113,hashtext($1)) AS locked',[submitId])).rows[0]?.locked;
      if(!locked)fail(409,'CASE_DOCUMENT_BUSY','Документы уже отправляются. Проверьте результат через несколько секунд.');
      const existing=(await client.query('SELECT * FROM case_document_batches WHERE id=$1',[submitId])).rows[0];
      if(existing){
        if(Number(existing.case_id)!==caseId||!retry&&(String(existing.owner_tg_id)!==String(actorId)||JSON.stringify(existing.files.map(metadata))!==JSON.stringify(files)))fail(409,'CASE_DOCUMENT_CHANGED','Этот пакет уже сохранён с другими данными. Откройте список документов клиента.');
        batch=existing;
        owner=String(batch.owner_tg_id);
      }else if(retry)fail(404,'CASE_DOCUMENT_MISSING','Пакет документов не найден.');
      uploadLocked=!!(await client.query('SELECT pg_try_advisory_lock(111,hashtext($1)) AS locked',[owner+':'+submitId])).rows[0]?.locked;
      if(!uploadLocked)fail(409,'CASE_DOCUMENT_BUSY','Документы ещё сохраняются. Повторите отправку после загрузки.');
      current=await access(caseId,actorId,true,client);
      if(!batch){
        if(!positive(current.recipient_id)||String(current.recipient_id)!==String(current.lawyer_tg_id)||current.recipient_role!=='lawyer'||current.recipient_approved!==true)fail(409,'CASE_DOCUMENT_RECIPIENT','Назначенный юрист сейчас недоступен. Проверьте назначение клиента.');
        // Staged originals belong to this manager and remain immutable once
        // the durable batch exists. The same lock is used by upload/delete.
        const frozen=await store.freeze(client,owner,submitId,files);
        if((await client.query('SELECT id FROM cases WHERE created_by=$1 AND handoff_submit_id=$2',[owner,submitId])).rows.length)fail(409,'CASE_DOCUMENT_CHANGED','Этот пакет уже входит в исходную передачу. Для досылки выберите новые документы.');
        current=await access(caseId,actorId,true,client);
        batch=(await client.query(`INSERT INTO case_document_batches(id,case_id,owner_tg_id,recipient_tg_id,files,delivery)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[submitId,caseId,owner,current.lawyer_tg_id,JSON.stringify(frozen),JSON.stringify({confirmed:{},completed:false,inflight:false})])).rows[0];
      }
      const state=object(batch.delivery);batch.delivery=state;
      if(state.completed||state.review||state.inflight)return respond();
      const recipient=String(batch.recipient_tg_id);
      const verifyRecipient=async()=>{
        current=await access(caseId,actorId,true,client);
        if(String(current.lawyer_tg_id)!==recipient||String(current.recipient_id)!==recipient||current.recipient_role!=='lawyer'||current.recipient_approved!==true)fail(409,'MATERIAL_RECIPIENT_UNAVAILABLE','Доступ или назначение юриста изменились. Подтверждённые документы сохранены.');
      };
      const save=async()=>{
        const result=await client.query('UPDATE case_document_batches SET delivery=$2,updated_at=NOW() WHERE id=$1 RETURNING id',[batch.id,JSON.stringify(state)]);
        if(result.rows.length!==1)throw new Error('Missing document batch');
      };
      await verifyRecipient();
      const baseTelegram=options.telegram||require('../bot/instance').telegram;
      const telegram={async sendDocument(chat,document,extra){
        const name=String(current.org||'Клиент').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,250);
        return baseTelegram.sendDocument(chat,document,{...extra,caption:'📎 Дополнительные документы · '+name+'\nКлиент #'+caseId+' · оригиналы менеджера.'});
      }};
      const deliver=options.delivery||createHandoffMaterialsDelivery({telegram,loadMaterials:()=>store.list(owner,submitId,true),label:'Клиент'});
      const reply=object(object(current.data)._handoff).cards?.[recipient];
      const result=await deliver(caseId,[{chat:recipient,...(positive(reply)?{reply:Number(reply)}:{})}],[],{
        expectedFiles:batch.files,confirmed:state.confirmed||{},packetHash:state.packetHash,
        onPrepared:async prepared=>{Object.assign(state,prepared);delete state.warning;await save();},
        beforeSend:async()=>{await verifyRecipient();state.inflight=true;await save();},
        onPart:async(chat,index,id,prepared)=>{
          receiptPending=true;const ids=state.confirmed[recipient]||[];
          if(String(chat)!==recipient||index!==ids.length||!positive(id)||ids.includes(Number(id)))throw new Error('Invalid document receipt');
          Object.assign(state,prepared);ids.push(Number(id));state.confirmed[recipient]=ids;state.inflight=false;await save();receiptPending=false;
        }
      });
      if(result?.ok){
        state.inflight=false;state.completed=true;delete state.warning;
        try{await save();}catch(error){state.completed=false;throw error;}
        return respond();
      }
      const uncertain=result?.failed?.some(item=>item.uncertain===true||item.stage==='receipt');
      if(uncertain){state.review='Результат отправки документов не подтверждён. Проверьте личный чат юриста; автоматический повтор остановлен, чтобы не создать дубли.';}
      else{state.inflight=false;state.warning=(result?.warnings||[]).join(' ')||'Документы сохранены, но доставлены не полностью. Повторите досылку.';}
      await save();return respond();
    }catch(error){
      if(batch){
        // A lost physical receipt must not be converted into a retryable send.
        // Its durable pre-send intent remains available to the next request.
        if(receiptPending||batch.delivery?.inflight){batch.delivery.review='Не удалось сохранить подтверждение отправки. Проверьте документы у юриста перед повтором.';return respond();}
        if(error.status)throw error;
        batch.delivery.warning='Документы сохранены. Не удалось завершить досылку; проверьте результат и повторите её.';return respond();
      }
      if(error.status)throw error;
      fail(503,'CASE_DOCUMENT_UNAVAILABLE','Не удалось сохранить пакет документов. Повторите отправку тех же файлов.');
    }finally{
      if(client){
        if(uploadLocked)try{await client.query('SELECT pg_advisory_unlock(111,hashtext($1))',[owner+':'+submitId]);}catch(error){unlockError=error;}
        if(locked)try{await client.query('SELECT pg_advisory_unlock(113,hashtext($1))',[submitId]);}catch(error){unlockError=error;}
        client.release(unlockError);
      }
    }
  }
  return {ensure,list,file,send};
}

function setupHandoffCaseDocuments(app,options={}){
  const service=options.service||createCaseDocumentsService(options);
  const route=run=>async(req,res)=>{
    res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff');
    try{await run(req,res);}catch(error){res.status(error.status||503).json({ok:false,code:error.code||'CASE_DOCUMENT_UNAVAILABLE',error:error.status?error.message:'Не удалось открыть документы клиента. Повторите попытку.'});}
  };
  const base='/api/handoff/cases/:caseId/documents';
  app.get(base,route(async(req,res)=>res.json(await service.list(req.params.caseId,req.tgUser?.id))));
  app.post(base,route(async(req,res)=>res.json(await service.send({caseId:req.params.caseId,actorId:req.tgUser?.id,submitId:req.body?.submit_id,files:req.body?.files}))));
  app.post(base+'/:batchId/retry',route(async(req,res)=>res.json(await service.send({caseId:req.params.caseId,actorId:req.tgUser?.id,submitId:req.params.batchId,retry:true}))));
  app.get(base+'/:batchId/files/:fileId',route(async(req,res)=>{
    const file=await service.file(req.params.caseId,req.params.batchId,req.params.fileId,req.tgUser?.id);
    const name=encodeURIComponent(file.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
    res.set('Content-Type',file.mime).set('Content-Length',String(file.buffer.length)).set('Content-Disposition',"attachment; filename=\"document\"; filename*=UTF-8''"+name).send(file.buffer);
  }));
  return service;
}
module.exports={createCaseDocumentsService,setupHandoffCaseDocuments};
