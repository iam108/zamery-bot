'use strict';

const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {createService,LAWYER}=require('./e2e/helpers');

let service,originalConnect,previousAdmins;
before(async()=>{
  previousAdmins=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='';
  service=await createService({master:true});originalConnect=service.pool.connect;
  await service.pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES(3002,'Other synthetic lawyer','lawyer',true),(3003,'Synthetic race lawyer','lawyer',true)");
});
after(async()=>{if(service)service.pool.connect=originalConnect;await service?.close();if(previousAdmins===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=previousAdmins;});

const originalData={_stage:'Сбор документов',_comment:'Preserve the lawyer note',basis:'Аренда',fl_arrest:{s:'no',c:'Keep my checked answer'},_workspaceNote:{revision:2,text:'Preserve workspace note'},_handoff:{version:2,body:{order_id:null},fields:{comment:'Preserve manager comment'}},extra_legacy_answer:'Keep unknown older answers'};
async function seed(extra={}){
  const c={region:'МСК',kind:'Общепит',service:'Получение',key:null,lawyer:LAWYER,data:originalData,...extra};
  return (await service.pool.query(`INSERT INTO cases(lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data,checklist_revision)
    VALUES($1,'Synthetic lawyer','Synthetic checklist setup','Synthetic address',$2,$3,$4,$5,2001,$6,7) RETURNING *`,[c.lawyer,c.region,c.kind,c.service,c.key,JSON.stringify(c.data)])).rows[0];
}
async function row(id){return(await service.pool.query('SELECT * FROM cases WHERE id=$1',[id])).rows[0];}
async function request(path,actor=LAWYER,body){
  const q=new URLSearchParams(service.keyQuery(actor));
  const response=await fetch(service.origin+path,{method:'POST',headers:{'X-Tg-U':q.get('u'),'X-Tg-K':q.get('k'),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch(_){}
  return{status:response.status,text,json};
}
const view=(id,actor)=>request('/checklist/view?case_id='+id,actor);
const setup=(id,extra={},actor)=>request('/checklist/view?case_id='+id+'&setup=1',actor,{case_id:id,region:'МСК',kind:'Общепит',service:'Получение',...extra});

for(const key of [null,'legacy-missing','constructor','__proto__','toString'])test('a '+JSON.stringify(key)+' checklist key recovers exact known case metadata without losing existing answers',async()=>{
  const c=await seed({key});const result=await view(c.id);
  assert.equal(result.status,200,result.text);assert.match(result.text,/Чек-лист/);assert.doesNotMatch(result.text,/Чек-лист не найден|Не удалось выполнить действие/);
  const saved=await row(c.id);assert.equal(saved.checklist_key,'MSK_OBSH');assert.equal(saved.checklist_revision,8);assert.deepEqual(saved.data,originalData);
  assert.deepEqual([saved.region,saved.kind,saved.service],['МСК','Общепит','Получение']);
  await view(c.id);assert.equal((await row(c.id)).checklist_revision,8,'Reopening must not repeat initialization');
});

test('an already valid template remains authoritative even when other saved metadata differs',async()=>{
  const c=await seed({key:'MO_MAG_RE'});const result=await view(c.id);assert.equal(result.status,200,result.text);
  const denied=await setup(c.id);assert.equal(denied.status,409);assert.equal(denied.json.code,'CHECKLIST_ALREADY_CONFIGURED');
  const saved=await row(c.id);assert.equal(saved.checklist_key,'MO_MAG_RE');assert.equal(saved.checklist_revision,7);assert.deepEqual(saved.data,originalData);
});

test('incomplete metadata opens explicit setup rather than guessing Moscow or a shop',async()=>{
  const c=await seed({region:null,kind:'Unknown old type',service:null,key:'old-key'});const result=await view(c.id);
  assert.equal(result.status,200,result.text);assert.match(result.text,/checklist-setup/);assert.equal((await row(c.id)).checklist_key,'old-key');assert.equal((await row(c.id)).checklist_revision,7);
  const saved=await setup(c.id,{region:'МО',kind:'Магазин',service:'Переоформление'});assert.equal(saved.status,200,saved.text);assert.equal(saved.json.ok,true);assert.equal(saved.json.checklist_key,'MO_MAG_RE');
  const configured=await row(c.id);assert.equal(configured.checklist_key,'MO_MAG_RE');assert.equal(configured.checklist_revision,8);assert.deepEqual(configured.data,originalData);
  assert.deepEqual([configured.region,configured.kind,configured.service],['МО','Магазин','Переоформление']);assert.equal((await view(c.id)).status,200);
});

test('explicit setup cannot alter already known case metadata or accept unknown profile choices',async()=>{
  const c=await seed({region:'МО',kind:null,service:'Получение'});
  const changed=await setup(c.id);assert.equal(changed.status,409);assert.equal(changed.json.code,'CHECKLIST_PROFILE_CHANGED');
  for(const extra of [{region:'Unknown'},{kind:'constructor'},{service:'Other'},{region:''},{kind:['Общепит']},{service:null}]){
    const bad=await setup(c.id,{region:'МО',...extra});assert.equal(bad.status,400,bad.text);
  }
  const saved=await row(c.id);assert.equal(saved.checklist_key,null);assert.equal(saved.checklist_revision,7);assert.deepEqual(saved.data,originalData);
});

test('unsupported known combinations are explained instead of receiving a checklist for another region or service',async()=>{
  for(const profile of[{region:'СПб',kind:'Общепит',service:'Получение'},{region:'МО',kind:'Табак',service:'Переоформление'},{region:'МСК',kind:'Общепит',service:'Переоформление'}]){
    const c=await seed(profile);const opened=await view(c.id);assert.equal(opened.status,200,opened.text);assert.match(opened.text,/checklist-setup-unsupported/);assert.doesNotMatch(opened.text,/id="checklist-setup"|id="setup-submit"/);
    const denied=await setup(c.id,profile);assert.equal(denied.status,400,denied.text);assert.equal(denied.json.code,'CHECKLIST_PROFILE_UNSUPPORTED');assert.equal((await row(c.id)).checklist_key,null);assert.deepEqual((await row(c.id)).data,originalData);
  }
});

test('foreign and revoked lawyers cannot view, choose or recover a client checklist',async()=>{
  const c=await seed({region:null});for(const action of [()=>view(c.id,3002),()=>setup(c.id,{},3002)]){const denied=await action();assert.equal(denied.status,403);assert.doesNotMatch(denied.text,/Synthetic checklist setup|Preserve manager comment/);}
  await service.pool.query('UPDATE staff SET approved=false WHERE tg_id=3003');try{
    const owned=await seed({region:null,lawyer:3003});assert.equal((await view(owned.id,3003)).status,403);assert.equal((await setup(owned.id,{},3003)).status,403);assert.equal((await row(owned.id)).checklist_key,null);
  }finally{await service.pool.query('UPDATE staff SET approved=true WHERE tg_id=3003');}
  assert.equal((await row(c.id)).checklist_key,null);assert.equal((await row(c.id)).checklist_revision,7);
});

test('approved managers and configured administrators can recover checklist access without being the assigned lawyer',async()=>{
  await service.pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES(3004,'Synthetic administrator','auditor',true)");process.env.ADMIN_TG_IDS='3004';
  try{for(const actor of[2001,3004]){const c=await seed();const result=await view(c.id,actor);assert.equal(result.status,200,result.text);assert.equal((await row(c.id)).checklist_key,'MSK_OBSH');assert.deepEqual((await row(c.id)).data,originalData);}}
  finally{process.env.ADMIN_TG_IDS='';}
});

for(const change of ['approval','role','assignment'])test('checklist recovery rechecks current '+change+' after initial HTTP authorization',async()=>{
  const c=await seed({lawyer:3003});let triggered=false;
  service.pool.connect=async function(){if(!triggered){triggered=true;await service.pool.query(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=3003':change==='role'?"UPDATE staff SET role='auditor' WHERE tg_id=3003":'UPDATE cases SET lawyer_tg_id=3002 WHERE id=$1',change==='assignment'?[c.id]:undefined);}return originalConnect.call(this);};
  try{const denied=await view(c.id,3003);assert.equal(triggered,true,'The race must occur at the recovery transaction');assert.equal(denied.status,403,denied.text);const saved=await row(c.id);assert.equal(saved.checklist_key,null);assert.equal(saved.checklist_revision,7);assert.deepEqual(saved.data,originalData);}
  finally{service.pool.connect=originalConnect;await service.pool.query("UPDATE staff SET approved=true,role='lawyer' WHERE tg_id=3003");}
});

for(const change of ['approval','role','assignment'])test('the final checklist write rejects '+change+' changed after loading current actor and client',async()=>{
  const c=await seed({lawyer:3003});let triggered=false;
  service.pool.connect=async function(){const connection=await originalConnect.call(this),query=connection.query.bind(connection);connection.query=async function(sql,args){
    if(!triggered&&sql.startsWith('UPDATE cases SET checklist_key=')){triggered=true;await query(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=3003':change==='role'?"UPDATE staff SET role='auditor' WHERE tg_id=3003":'UPDATE cases SET lawyer_tg_id=3002 WHERE id=$1',change==='assignment'?[c.id]:undefined);}
    return query(sql,args);
  };return connection;};
  try{const denied=await view(c.id,3003);assert.equal(triggered,true,'The race must be injected immediately before the final update');assert.equal(denied.status,403,denied.text);const saved=await row(c.id);assert.equal(saved.checklist_key,null);assert.equal(saved.checklist_revision,7);assert.deepEqual(saved.data,originalData);}
  finally{service.pool.connect=originalConnect;}
});

test('concurrent explicit setup initializes once and never replaces the winner or drops saved data',async()=>{
  const c=await seed({region:null,kind:null,service:null});const responses=await Promise.all([setup(c.id),setup(c.id,{region:'МО',kind:'Магазин',service:'Переоформление'})]);
  assert.deepEqual(responses.map(result=>result.status).sort(),[200,409]);const winner=responses.find(result=>result.status===200);const saved=await row(c.id);
  assert.equal(saved.checklist_key,winner.json.checklist_key);assert.equal(saved.checklist_revision,8);assert.deepEqual(saved.data,originalData);
  const retry=await setup(c.id,{region:saved.region,kind:saved.kind,service:saved.service});assert.equal(retry.status,409);assert.equal((await row(c.id)).checklist_revision,8);
});

test('invalid archived templates are not reinitialized and invalid saves and print links fail clearly',async()=>{
  const archived=await seed({data:{...originalData,_stage:'Архив'}});assert.equal((await view(archived.id)).status,409);assert.equal((await setup(archived.id)).status,409);assert.equal((await row(archived.id)).checklist_key,null);
  const c=await seed({region:null,key:'legacy-missing'});
  const saved=await request('/api/checklist/save',LAWYER,{case_id:c.id,data:{_comment:'must not overwrite'},expectedRevision:7,done:1,total:1});assert.equal(saved.status,400,saved.text);assert.equal(saved.json.code,'CHECKLIST_SETUP_REQUIRED');
  const print=await request('/api/checklist/printlink',LAWYER,{case_id:c.id});assert.equal(print.status,409,print.text);assert.equal(print.json.code,'CHECKLIST_SETUP_REQUIRED');
  const auth=require('../src/web/auth');for(const mode of ['1','full']){const response=await fetch(service.origin+'/checklist?case_id='+c.id+'&print='+mode+'&'+auth.signCase(c.id,1));assert.equal(response.status,404);assert.match(await response.text(),/Сначала выберите чек-лист/);}
  assert.deepEqual((await row(c.id)).data,originalData);assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);
});
