'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const file=require.resolve('../src/web/handoff'),local=createRequire(file),source=fs.readFileSync(file,'utf8');
const pg={skip:!process.env.PGLITE_TEST_MODULE};

async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),queries=[],routes=new Map();
  let tail=Promise.resolve();
  const pool={async query(sql,params){let release;const previous=tail;tail=new Promise(resolve=>release=resolve);await previous;queries.push({sql,params});try{return params?await db.query(sql,params):(await db.exec(sql)).at(-1);}finally{release();}}};
  const auth=local('./auth'),priorAdmins=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='99';
  const context=vm.createContext({module:{exports:{}},process:{env:{}},console:{error(){},log(){}},Buffer,URL,Date,setTimeout(){},setInterval(){},require(name){
    if(name==='../db/pool')return pool;
    if(name==='../bot/instance')return{telegram:{sendMessage(){assert.fail('Workload reads must send no Telegram messages');}}};
    if(name==='./handoff-packet')return{setupHandoffPacket(){return{};}};
    if(name==='./auth')return auth;
    return local(name);
  }});
  try{
    vm.runInContext(source+'\nmodule.exports.qa={ensureTables,ensureDeadlines};',context);await context.module.exports.qa.ensureTables();
    await pool.query(`ALTER TABLE staff ADD COLUMN approved BOOLEAN;CREATE TABLE orders(id INT PRIMARY KEY,address TEXT);INSERT INTO orders VALUES(60,'Москва, Тестовая, 60');
      INSERT INTO staff(tg_id,name,role,approved) VALUES(101,'Валерия','lawyer',true),(102,'Елена','lawyer',true),(103,'Юрист без клиентов','lawyer',true),(104,'Отозванный доступ','lawyer',false),(105,'Менеджер','manager',true),(106,'Без подтверждения','lawyer',NULL);
      INSERT INTO cases(id,order_id,lawyer_tg_id,data,completed_at) VALUES
      (1,60,101,'{}',NULL),(2,NULL,101,NULL,NULL),(3,NULL,101,'{"_stage":"Сбор документов"}',NULL),(4,NULL,101,'{"_stage":"Архив"}',NULL),
      (5,NULL,101,'{"_stage":"Решение получено"}','2026-11-01'),(6,NULL,101,'null',NULL),
      (7,NULL,102,'{"_handoff":{"completed":false}}',NULL),(8,NULL,102,'{"_stage":"Архив","_handoff":{"completed":false}}',NULL),
      (9,NULL,104,'{}',NULL),(10,NULL,105,'{}',NULL),(11,NULL,NULL,'{}',NULL),(12,NULL,102,'"Legacy checklist text"',NULL);`);
    context.module.exports.setupHandoff({get(path,handler){routes.set(path,handler);},post(){},delete(){}});await context.module.exports.qa.ensureDeadlines();
    const request=async({id=2001,role='manager',approved=true,order_id,case_id}={})=>{let status=200,result;const before=queries.length;await routes.get('/api/handoff/prefill')({query:{...(order_id?{order_id:String(order_id)}:{}),...(case_id?{case_id:String(case_id)}:{})},staff:{role,approved},tgUser:{id}},{status(value){status=value;return this;},json(value){result=value;return this;}});return{status,result,queries:queries.slice(before)};};
    await run({request,pool,db});
  }finally{if(priorAdmins===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=priorAdmins;await tail;await db.close();}
}

test('manager prefill includes every approved lawyer with actual non-archived assigned cases, including zero and incomplete delivery',pg,()=>fixture(async h=>{
  const response=await h.request();assert.equal(response.status,200);assert.equal(response.result.ok,true);assert.equal(response.result.can_manage,true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.lawyers)),[{tg_id:101,name:'Валерия',active_cases:5},{tg_id:102,name:'Елена',active_cases:2},{tg_id:103,name:'Юрист без клиентов',active_cases:0}]);
  assert.equal(response.queries.filter(query=>/COUNT\(/i.test(query.sql)).length,1,'One aggregate read supplies all lawyers without per-lawyer requests');
}));

test('assigned lawyer prefill exposes only the same lawyer name and never queries other workloads',pg,()=>fixture(async h=>{
  const response=await h.request({id:101,role:'lawyer',order_id:60});assert.equal(response.status,200);assert.equal(response.result.ok,true);assert.equal(response.result.can_manage,false);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.lawyers)),[{tg_id:101,name:'Валерия'}]);
  assert.equal(response.queries.some(query=>/COUNT\(/i.test(query.sql)),false);
}));

test('prefill for an existing order-bound client uses the manager-confirmed company and address',pg,()=>fixture(async h=>{
  await h.pool.query("UPDATE cases SET org=$1,address=$2,inn=$3,region='МСК',kind='Общепит',service='Получение',contacts=$4 WHERE id=1",
    ['ООО «Подтверждённая компания»','Москва, Исправленный адрес, 3','7701234567',JSON.stringify([{name:'Анна',phone:'+79991234567'}])]);
  const response=await h.request({id:101,role:'lawyer',case_id:1});assert.equal(response.status,200);assert.equal(response.result.ok,true);
  assert.equal(response.result.can_manage,false);assert.equal(response.result.order.id,60);assert.equal(response.result.order.org,'ООО «Подтверждённая компания»');assert.equal(response.result.order.address,'Москва, Исправленный адрес, 3');
  assert.equal(response.result.order.contacts[0].name,'Анна');
  assert.equal((await h.pool.query('SELECT address FROM orders WHERE id=60')).rows[0].address,'Москва, Тестовая, 60');
  const denied=await h.request({id:102,role:'lawyer',case_id:1});assert.equal(denied.status,403);assert.equal(denied.result.order,undefined);
}));

test('unassigned, unapproved and auditor callers cannot obtain workload through the generic prefill API',pg,()=>fixture(async h=>{
  for(const actor of [{id:102,role:'lawyer',order_id:60},{id:101,role:'auditor',order_id:60},{id:101,role:'manager',approved:false,order_id:60},{id:101,role:'lawyer'}]){
    const response=await h.request(actor);assert.ok(response.status===403||response.status===404);assert.equal(response.result.ok,false);assert.equal(response.result.lawyers,undefined);assert.equal(response.queries.some(query=>/COUNT\(/i.test(query.sql)),false);
  }
}));

test('an explicitly configured approved administrator uses the existing manager access rule for workload',pg,()=>fixture(async h=>{
  const response=await h.request({id:99,role:'auditor'});assert.equal(response.result.ok,true);assert.equal(response.result.can_manage,true);assert.equal(response.result.lawyers.length,3);assert.equal(response.result.lawyers[0].active_cases,5);
}));
