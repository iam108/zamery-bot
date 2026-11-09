'use strict';

const {createHash} = require('node:crypto');
const {prepareMaterials, LIMITS} = require('./order-materials');
const {canManageCases} = require('./auth');
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const DDL = `ALTER TABLE cases ADD COLUMN IF NOT EXISTS handoff_submit_id TEXT;
CREATE TABLE IF NOT EXISTS handoff_manual_materials (
  owner_tg_id BIGINT NOT NULL, submit_id UUID NOT NULL, id UUID NOT NULL,
  name TEXT NOT NULL, mime TEXT NOT NULL, role TEXT NOT NULL,
  bytes INT NOT NULL, sha256 TEXT NOT NULL, content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_tg_id,submit_id,id)
);`;
function fail(message, status=400, code='HANDOFF_MATERIAL_INVALID') {
  throw Object.assign(new Error(message), {status,code});
}
function identity(owner, submitId) {
  if (!/^[1-9]\d{0,15}$/.test(String(owner)) || !Number.isSafeInteger(Number(owner))) fail('Не удалось определить сотрудника.',401);
  if (!UUID.test(String(submitId || ''))) fail('Не удалось определить черновик клиента.');
  return [String(owner),String(submitId).toLowerCase()];
}
function metadata(row) {return {id:String(row.id),name:row.name,mime:row.mime,role:row.role,bytes:Number(row.bytes),sha256:row.sha256};}
function verified(row) {
  const buffer = Buffer.from(row.content || []), meta = metadata(row);
  if (!buffer.length || buffer.length>LIMITS.fileBytes || buffer.length!==meta.bytes ||
      !/^[a-f\d]{64}$/.test(meta.sha256 || '') || createHash('sha256').update(buffer).digest('hex')!==meta.sha256)
    fail('Не удалось подтвердить целостность документа клиента. Передача остановлена.',503,'HANDOFF_MATERIAL_INTEGRITY');
  return {...meta,buffer};
}
function selection(rows, expected) {
  if (!Array.isArray(expected) || expected.length>LIMITS.files || rows.length!==expected.length) fail('Документы изменились. Обновите список перед передачей.',409,'HANDOFF_MATERIAL_CHANGED');
  const used = new Set();
  return expected.map(wanted=>{
    if (!wanted || !UUID.test(wanted.id || '') || used.has(wanted.id)) fail('Проверьте список документов.',409,'HANDOFF_MATERIAL_CHANGED');
    used.add(wanted.id);
    const file=rows.find(row=>String(row.id)===wanted.id);
    if (!file || !['id','name','mime','role','bytes','sha256'].every(key=>metadata(file)[key]===wanted[key])) fail('Документы изменились. Обновите список перед передачей.',409,'HANDOFF_MATERIAL_CHANGED');
    return verified(file);
  });
}
function createManualMaterialsStore(pool) {
  let ready;
  async function ensure() {return ready ||= pool.query(DDL).catch(error=>{ready=null;throw error;});}
  async function rows(client,owner,submitId) {return (await client.query('SELECT * FROM handoff_manual_materials WHERE owner_tg_id=$1 AND submit_id=$2 ORDER BY created_at,id',identity(owner,submitId))).rows;}
  async function list(owner,submitId,originals=false) {await ensure();return (await rows(pool,owner,submitId)).map(originals?verified:metadata);}
  async function mutate(owner,submitId,fn) {
    const ids=identity(owner,submitId);await ensure();const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const locked=(await client.query('SELECT pg_try_advisory_xact_lock(111,hashtext($1)) AS locked',[ids.join(':')])).rows[0]?.locked;
      if (!locked) fail('Передача уже выполняется. Дождитесь результата.',409,'HANDOFF_BUSY');
      const staff=(await client.query('SELECT tg_id,role,approved FROM staff WHERE tg_id=$1',[owner])).rows[0];
      if (!canManageCases(staff,owner)) fail('Нет доступа к документам клиента.',403,'HANDOFF_FORBIDDEN');
      if ((await client.query('SELECT id FROM cases WHERE created_by=$1 AND handoff_submit_id=$2',ids)).rows.length) fail('Передача уже началась. Состав документов сохранён.',409,'HANDOFF_MATERIAL_FROZEN');
      await fn(client,ids);const result=(await rows(client,...ids)).map(metadata);await client.query('COMMIT');return result;
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;} finally {client.release();}
  }
  async function put(owner,submitId,file) {
    const prepared=prepareMaterials([file])[0];
    return mutate(owner,submitId,async(client,ids)=>{
      const existing=await rows(client,...ids);
      const duplicate=existing.find(item=>String(item.id)===prepared.id);
      if (duplicate) {verified(duplicate);return;}
      if (existing.length>=LIMITS.files || existing.reduce((sum,item)=>sum+Number(item.bytes),0)+prepared.bytes>LIMITS.totalBytes) fail('Можно приложить до 20 файлов общим объёмом до 100 МБ.',413);
      await client.query('INSERT INTO handoff_manual_materials(owner_tg_id,submit_id,id,name,mime,role,bytes,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...ids,prepared.id,prepared.name,prepared.mime,prepared.role,prepared.bytes,prepared.sha256,prepared.buffer]);
    });
  }
  async function remove(owner,submitId,id) {
    if (!UUID.test(id || '')) fail('Не удалось определить документ.');
    return mutate(owner,submitId,(client,ids)=>client.query('DELETE FROM handoff_manual_materials WHERE owner_tg_id=$1 AND submit_id=$2 AND id=$3',[...ids,id]));
  }
  // The submitter owns the same advisory lock. All metadata and bytes are
  // checked before its durable case is created; later mutations are forbidden.
  async function freeze(client,owner,submitId,expected) {return selection(await rows(client,owner,submitId),expected).map(metadata);}
  async function loadCase(caseId) {
    if (!Number.isSafeInteger(Number(caseId)) || Number(caseId)<1) fail('Некорректный клиент.');
    await ensure();const c=(await pool.query('SELECT created_by,handoff_submit_id,data FROM cases WHERE id=$1',[caseId])).rows[0];
    const body=c?.data?._handoff?.body;
    if (!c || body?.manual_client!==true || typeof body.submit_id!=='string' || !UUID.test(body.submit_id) ||
        typeof c.handoff_submit_id!=='string' || !UUID.test(c.handoff_submit_id) ||
        body.submit_id.toLowerCase()!==c.handoff_submit_id.toLowerCase()) fail('Документы клиента недоступны.',404);
    return selection(await rows(pool,c.created_by,c.handoff_submit_id),body.manual_files || []);
  }
  return {ensure,list,put,remove,freeze,loadCase};
}
function setupHandoffManualMaterials(app,{pool,ready=async()=>{},store=createManualMaterialsStore(pool)}={}) {
  const upload=require('multer')({storage:require('multer').memoryStorage(),limits:{files:1,fileSize:LIMITS.fileBytes,fields:0,parts:2}}).single('file');
  const sendError=(res,error)=>res.status(error.status || (String(error.code).startsWith('LIMIT_')?413:500)).json({ok:false,code:error.code || 'HANDOFF_MATERIAL_FAILED',error:error.status?error.message:error.code==='LIMIT_FILE_SIZE'?'Файл должен быть не больше 12 МБ.':String(error.code).startsWith('LIMIT_')?'Загрузите один документ без дополнительных полей.':'Не удалось сохранить документы клиента. Повторите попытку.'});
  const response=(res,files)=>res.json({ok:true,files,limits:LIMITS});
  async function access(req) {
    await ready();await store.ensure();
    const owner=req.tgUser?.id;identity(owner,req.query.submit_id);
    const staff=(await pool.query('SELECT tg_id,role,approved FROM staff WHERE tg_id=$1',[owner])).rows[0];
    if (!canManageCases(staff,owner)) fail('Нет доступа к документам клиента.',403,'HANDOFF_FORBIDDEN');
    return owner;
  }
  app.get('/api/handoff/manual-materials',async(req,res)=>{try{const owner=await access(req);response(res,await store.list(owner,req.query.submit_id));}catch(error){sendError(res,error);}});
  app.post('/api/handoff/manual-materials',async(req,res)=>{
    try {const owner=await access(req);upload(req,res,async(error)=>{
      try {if(error)throw error;if(!req.file)fail('Выберите документ.');
        if (/^[\x00-\xff]*$/.test(req.file.originalname)) {
          const bytes=Buffer.from(req.file.originalname,'latin1'),decoded=bytes.toString('utf8');
          if (Buffer.from(decoded,'utf8').equals(bytes)) req.file.originalname=decoded;
        }
        response(res,await store.put(owner,req.query.submit_id,req.file));}
      catch(failure){sendError(res,failure);}finally{if(req.file)delete req.file.buffer;}
    });}catch(error){sendError(res,error);}
  });
  app.delete('/api/handoff/manual-materials/:file_id',async(req,res)=>{try{const owner=await access(req);response(res,await store.remove(owner,req.query.submit_id,req.params.file_id));}catch(error){sendError(res,error);}});
  return store;
}
module.exports={createManualMaterialsStore,setupHandoffManualMaterials};
