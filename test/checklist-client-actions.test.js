'use strict';

const{test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const{randomUUID}=require('node:crypto');
const{createService,LAWYER}=require('./e2e/helpers');
let service,originalConnect,previousAdmins;
before(async()=>{previousAdmins=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='3004';service=await createService({master:true});originalConnect=service.pool.connect;
  await service.pool.query("UPDATE staff SET name='Synthetic Valerie' WHERE tg_id=$1",[LAWYER]);
  await service.pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES(3002,'Other lawyer','lawyer',true),(3003,'Race lawyer','lawyer',true),(3004,'Configured administrator','auditor',true)");
});
after(async()=>{if(service)service.pool.connect=originalConnect;await service?.close();if(previousAdmins===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=previousAdmins;});
const originalData={_stage:'Подано',_submittedOn:'2026-11-23',_decisionDue:'2026-12-21',_decisionReminderSent:true,_comment:'Keep the lawyer note',basis:'Аренда',answer:{s:'ok',c:'Keep answer'},_workspaceNote:true,_handoff:{version:2,fields:{comment:'Manager comment'},completed:true}};
async function seed(extra={}){const c={region:null,kind:null,service:null,key:null,lawyer:LAWYER,data:originalData,...extra};return(await service.pool.query(`INSERT INTO cases(lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data,checklist_revision,done,total,completed_at)
  VALUES($1,'Synthetic Valerie','Synthetic basic-management client','Synthetic address',$2,$3,$4,$5,2001,$6,7,3,44,'2026-11-24T12:00:00Z') RETURNING *`,[c.lawyer,c.region,c.kind,c.service,c.key,JSON.stringify(c.data)])).rows[0];}
async function row(id){return(await service.pool.query('SELECT * FROM cases WHERE id=$1',[id])).rows[0];}
function credentials(actor){const q=new URLSearchParams(service.keyQuery(actor));return{'X-Tg-U':q.get('u'),'X-Tg-K':q.get('k'),'Content-Type':'application/json'};}
async function request(path,{actor=LAWYER,body,method='POST'}={}){const response=await fetch(service.origin+path,{method,headers:credentials(actor),...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();let json;try{json=JSON.parse(text);}catch(_){}return{status:response.status,text,json};}
const action=(id,body,actor=LAWYER)=>request('/checklist/view?case_id='+id+'&manage=1',{actor,body});
const body=(extra={})=>({action:'archive_client',expectedRevision:7,request_id:randomUUID(),...extra});
async function activeCount(actor=LAWYER){const result=await request('/api/handoff/prefill',{actor:2001,method:'GET'});assert.equal(result.status,200,result.text);return result.json.lawyers.find(item=>String(item.tg_id)===String(actor)).active_cases;}
function unchangedPayload(saved,expected,stage){const data={...saved.data};delete data._lastClientAction;assert.deepEqual(data,{...expected.data,_stage:stage});for(const key of['checklist_key','region','kind','service','done','total','lawyer_tg_id','lawyer_name','created_by','completed_at'])assert.deepEqual(saved[key],expected[key],key+' must be unchanged');}

test('assigned Valerie can archive a client without a checklist and restore its prior stage, with workload and all case data preserved',async()=>{
  const c=await seed(),before=await activeCount(),archive=body();
  const archived=await action(c.id,archive);assert.equal(archived.status,200,archived.text);assert.equal(archived.json.ok,true);assert.equal(archived.json.stage,'Архив');assert.equal(archived.json.revision,8);assert.equal(archived.json.replayed,false);unchangedPayload(await row(c.id),c,'Архив');assert.equal(await activeCount(),before-1);
  const reopened=await request('/checklist/view?case_id='+c.id);assert.equal(reopened.status,200,reopened.text);assert.match(reopened.text,/case-restore/);assert.doesNotMatch(reopened.text,/id="checklist-setup"/);assert.equal((await row(c.id)).checklist_key,null);
  const restored=await action(c.id,body({action:'restore_client',expectedRevision:8}));assert.equal(restored.status,200,restored.text);assert.equal(restored.json.stage,'Подано');assert.equal(restored.json.revision,9);unchangedPayload(await row(c.id),c,'Подано');assert.equal(await activeCount(),before);
  assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);
});

for(const extra of[{region:'СПб',kind:'Магазин',service:'Получение',key:null},{region:'МСК',kind:'Общепит',service:'Получение',key:'MSK_OBSH'},{key:'constructor'}])test('basic management is independent of '+JSON.stringify(extra)+' checklist availability',async()=>{
  const c=await seed(extra);const result=await action(c.id,body());assert.equal(result.status,200,result.text);unchangedPayload(await row(c.id),c,'Архив');
});

test('archive requires an explicit known action, safe revision and UUID and ignores injected case fields',async()=>{
  const c=await seed();for(const bad of[{action:'delete'},{action:null},{expectedRevision:-1},{expectedRevision:'7'},{expectedRevision:7.5},{expectedRevision:null},{request_id:'no-id'},{request_id:null}]){
    const result=await action(c.id,body(bad));assert.equal(result.status,400,result.text);assert.equal((await row(c.id)).checklist_revision,7);
  }
  const accepted=await action(c.id,body({data:{_handoff:{erase:true}},lawyer_tg_id:3002,checklist_key:'MO_MAG',org:'Wrong organization',_stage:'Подано'}));assert.equal(accepted.status,200,accepted.text);unchangedPayload(await row(c.id),c,'Архив');assert.equal((await row(c.id)).org,c.org);
});

test('foreign, unapproved and reassigned lawyers cannot archive, restore or replay another actor receipt',async()=>{
  const c=await seed();assert.equal((await action(c.id,body(),3002)).status,403);
  const requestBody=body();assert.equal((await action(c.id,requestBody)).status,200);await service.pool.query('UPDATE staff SET approved=false WHERE tg_id=$1',[LAWYER]);
  try{assert.equal((await action(c.id,requestBody)).status,403);assert.equal((await action(c.id,body({action:'restore_client',expectedRevision:8}))).status,403);}finally{await service.pool.query('UPDATE staff SET approved=true WHERE tg_id=$1',[LAWYER]);}
  await service.pool.query('UPDATE cases SET lawyer_tg_id=3002 WHERE id=$1',[c.id]);assert.equal((await action(c.id,requestBody)).status,403);assert.equal((await action(c.id,body({action:'restore_client',expectedRevision:8}))).status,403);assert.equal((await row(c.id)).checklist_revision,8);
});

test('approved managers and configured administrators can archive clients while unconfigured auditors cannot',async()=>{
  for(const actor of[2001,3004]){const c=await seed();assert.equal((await action(c.id,body(),actor)).status,200);}
  const c=await seed();assert.equal((await action(c.id,body(),1001)).status,403);assert.equal((await row(c.id)).checklist_revision,7);
});

test('exact request replay after a lost acknowledgement returns the same receipt without another revision',async()=>{
  const c=await seed(),posted=body();let lost=false;
  service.pool.connect=async function(){const connection=await originalConnect.call(this),query=connection.query.bind(connection);connection.query=async function(sql,args){const result=await query(sql,args);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('Synthetic lost COMMIT ACK');}return result;};return connection;};
  try{const uncertain=await action(c.id,posted);assert.equal(lost,true);assert.equal(uncertain.status,500);assert.equal((await row(c.id)).data._stage,'Архив');}
  finally{service.pool.connect=originalConnect;}
  const retry=await action(c.id,posted);assert.equal(retry.status,200,retry.text);assert.equal(retry.json.replayed,true);assert.equal(retry.json.revision,8);unchangedPayload(await row(c.id),c,'Архив');
  const changed=await action(c.id,{...posted,action:'restore_client'});assert.equal(changed.status,409);assert.equal(changed.json.code,'CLIENT_ACTION_REQUEST_CHANGED');
  const differentActor=await action(c.id,posted,2001);assert.equal(differentActor.status,409);assert.equal((await row(c.id)).checklist_revision,8);
});

test('concurrent archive requests with the same revision have exactly one winner',async()=>{
  const c=await seed(),responses=await Promise.all([action(c.id,body()),action(c.id,body())]);assert.deepEqual(responses.map(item=>item.status).sort(),[200,409]);assert.equal((await row(c.id)).checklist_revision,8);unchangedPayload(await row(c.id),c,'Архив');
});

test('stale actions cannot overwrite checklist changes or an already archived or restored client',async()=>{
  const c=await seed();await service.pool.query("UPDATE cases SET checklist_revision=8,data=jsonb_set(data,'{_comment}',to_jsonb('Newer concurrent note'::text)) WHERE id=$1",[c.id]);
  const stale=await action(c.id,body());assert.equal(stale.status,409);assert.equal((await row(c.id)).data._comment,'Newer concurrent note');assert.equal((await row(c.id)).data._stage,'Подано');
  assert.equal((await action(c.id,body({expectedRevision:8}))).status,200);assert.equal((await action(c.id,body({expectedRevision:9}))).status,409);assert.equal((await action(c.id,body({action:'restore_client',expectedRevision:9}))).status,200);assert.equal((await action(c.id,body({action:'restore_client',expectedRevision:10}))).status,409);assert.equal((await row(c.id)).checklist_revision,10);
});

test('normal checklist saves preserve the server action receipt when the browser omits or forges it',async()=>{
  const c=await seed({region:'МСК',kind:'Общепит',service:'Получение',key:'MSK_OBSH'});assert.equal((await action(c.id,body())).status,200);assert.equal((await action(c.id,body({action:'restore_client',expectedRevision:8}))).status,200);
  const receipt=(await row(c.id)).data._lastClientAction;
  for(const forged of[true,false]){
    const current=await row(c.id),data={_stage:'Сбор документов',basis:forged?'Собственность':'Аренда',_comment:originalData._comment};if(forged)data._lastClientAction={id:randomUUID(),action:'archive_client',revision:1,actor:'3002'};
    const saved=await request('/api/checklist/save',{body:{case_id:c.id,data,expectedRevision:current.checklist_revision,expectedNote:originalData._comment,done:0,total:44}});assert.equal(saved.status,200,saved.text);assert.equal(saved.json.ok,true,saved.text);
    const after=await row(c.id);assert.deepEqual(after.data._lastClientAction,receipt);assert.equal(after.data._stage,'Сбор документов');assert.equal(after.data.basis,data.basis);assert.deepEqual(after.data._handoff,originalData._handoff);
  }
});

test('a checklist form opened before archiving cannot silently put the archived client back into work',async()=>{
  const c=await seed({key:'MSK_OBSH',region:'МСК',kind:'Общепит',service:'Получение'});assert.equal((await action(c.id,body())).status,200);const receipt=(await row(c.id)).data._lastClientAction;
  const stale=await request('/api/checklist/save',{body:{case_id:c.id,data:{...originalData,_stage:'Сбор документов'},expectedRevision:7,expectedNote:originalData._comment,done:3,total:44}});assert.equal(stale.status,409,stale.text);
  const after=await row(c.id);assert.equal(after.data._stage,'Архив');assert.deepEqual(after.data._lastClientAction,receipt);assert.equal(after.checklist_revision,8);
});

test('restoring an old archive without a prior receipt safely chooses document collection and preserves unknown metadata',async()=>{
  const c=await seed({data:{...originalData,_stage:'Архив'}});const result=await action(c.id,body({action:'restore_client'}));assert.equal(result.status,200,result.text);assert.equal(result.json.stage,'Сбор документов');unchangedPayload(await row(c.id),c,'Сбор документов');
});

for(const change of['approval','role','assignment'])test('management rechecks '+change+' after HTTP authentication before any state change',async()=>{
  const c=await seed({lawyer:3003});let changed=false;
  service.pool.connect=async function(){if(!changed){changed=true;await service.pool.query(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=3003':change==='role'?"UPDATE staff SET role='auditor' WHERE tg_id=3003":'UPDATE cases SET lawyer_tg_id=3002 WHERE id=$1',change==='assignment'?[c.id]:undefined);}return originalConnect.call(this);};
  try{const denied=await action(c.id,body(),3003);assert.equal(changed,true);assert.equal(denied.status,403,denied.text);const saved=await row(c.id);assert.deepEqual(saved.data,c.data);assert.equal(saved.checklist_revision,7);}
  finally{service.pool.connect=originalConnect;await service.pool.query("UPDATE staff SET role='lawyer',approved=true WHERE tg_id=3003");}
});

test('a corrupt non-object case payload is never replaced during basic management',async()=>{
  for(const value of[[],['legacy'],3,'old']){const c=await seed({data:value});const result=await action(c.id,body());assert.equal(result.status,409,result.text);assert.equal(result.json.code,'CASE_DATA_INVALID');assert.deepEqual((await row(c.id)).data,value);assert.equal((await row(c.id)).checklist_revision,7);}
  assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);
});
