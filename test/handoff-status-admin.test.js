'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHandoffStatusAdmin,setupHandoffStatusAdmin,MAX_CASES}=require('../src/bot/handoff-status-admin');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:15000};
function context(text='/handoff_status 62',changes={}) {
  const replies=[];return {from:{id:108},chat:{id:108,type:'private'},message:{text},replies,
    async reply(value){replies.push(value);},telegram:new Proxy({},{get(){assert.fail('The diagnostic must not call Telegram transport');}}),...changes};
}
test('setup registers one command and performs no startup reads or writes',()=>{
  const commands=[];setupHandoffStatusAdmin({command(name,run){commands.push({name,run});}},{pool:{query(){assert.fail('No startup SQL');}}});
  assert.deepEqual(commands.map(c=>c.name),['handoff_status']);assert.equal(typeof commands[0].run,'function');
});
test('only explicitly configured administrators in private chats can read diagnostic data',async()=>{
  let reads=0;const status=createHandoffStatusAdmin({adminIds:[108],pool:{query(){reads++;assert.fail('Unauthorized read');}}});
  for(const ctx of [context(undefined,{from:{id:109},staff:{role:'manager',approved:true}}),context(undefined,{chat:{id:-1001,type:'supergroup'}}),context(undefined,{chat:{id:-1001,type:'group'}})]){await status(ctx);assert.deepEqual(ctx.replies,[]);}
  await createHandoffStatusAdmin({adminIds:[],pool:{query(){assert.fail('No admin fallback');}}})(context());assert.equal(reads,0);
});
test('invalid order IDs never execute SQL and SQL errors expose no underlying details',async()=>{
  let reads=0;const status=createHandoffStatusAdmin({adminIds:'108',pool:{query(){reads++;throw new Error('synthetic SECRET document URL');}}});
  for(const text of ['/handoff_status','/handoff_status 0','/handoff_status -1','/handoff_status 1.5','/handoff_status 2147483648','/handoff_status 62; SELECT secret']){const ctx=context(text);await status(ctx);assert.match(ctx.replies[0],/номер_заявки/);}
  assert.equal(reads,0);const ctx=context();await status(ctx);assert.equal(reads,1);assert.match(ctx.replies[0],/Не удалось прочитать/);assert.doesNotMatch(ctx.replies[0],/SECRET|URL/);
});
async function fixture(run,{optional=true}={}) {
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),queries=[];
  await db.exec(`CREATE TABLE orders(id INT PRIMARY KEY,status TEXT,telegram_msg_id BIGINT,created_at TIMESTAMPTZ);
    CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,username TEXT,role TEXT,approved BOOLEAN);
    CREATE TABLE cases(id INT PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,created_by BIGINT,created_at TIMESTAMPTZ,data JSONB DEFAULT '{}');
    INSERT INTO orders VALUES(62,'done',902,'2026-11-01T12:00:00Z'),(63,'new',903,'2026-11-02T12:00:00Z');
    INSERT INTO staff VALUES(808,'Valerie actual','valerie_current','lawyer',true),(909,'UNRELATED STAFF','unrelated_username','auditor',false);`);
  if(optional)await db.exec('ALTER TABLE cases ADD COLUMN completed_at TIMESTAMPTZ;ALTER TABLE cases ADD COLUMN status TEXT;');
  const pool={async query(sql,args){assert.match(sql,/^SELECT\b/);queries.push({sql,args});return db.query(sql,args);}};
  const add=async(id=39,order=62,data={})=>db.query("INSERT INTO cases(id,order_id,lawyer_tg_id,lawyer_name,created_by,created_at,data) VALUES($1,$2,808,'Valerie saved',108,'2026-11-03T10:20:30Z',$3)",[id,order,JSON.stringify(data)]);
  const status=createHandoffStatusAdmin({pool,adminIds:()=>['108']});
  const invoke=async(text)=>{const ctx=context(text);await status(ctx);assert.ok(ctx.replies.every(part=>part.length<=3500));return ctx.replies.join('\n');};
  try{await run({db,queries,add,invoke});}finally{await db.close();}
}
test('missing orders and an existing order without a case remain distinct, with one read and no mutation',pg,()=>fixture(async h=>{
  assert.match(await h.invoke('/handoff_status 99'),/Заявка #99 не найдена/);
  const text=await h.invoke('/handoff_status@synthetic_bot 62');assert.match(text,/Передача заявки #62/);assert.match(text,/Клиенты по этой заявке не найдены/);assert.match(text,/карточка msg 902/);assert.equal(h.queries.length,2);assert.deepEqual(h.queries[1].args,[62]);
}));
test('legacy case assignment does not imply delivery and optional old schema columns need no migration',pg,()=>fixture(async h=>{
  await h.add(39,62,{_stage:'Архив',phone:'PRIVATE CONTACT',documents:['PRIVATE FILE']});
  const text=await h.invoke();assert.match(text,/Клиент #39/);assert.match(text,/legacy\/unknown/);assert.match(text,/Доставка не подтверждена/);assert.match(text,/Этап Архив/);assert.match(text,/status не хранится/);assert.match(text,/Valerie actual.*@valerie_current/);assert.match(text,/Valerie saved/);assert.doesNotMatch(text,/PRIVATE/);assert.equal(h.queries.length,1);
},{optional:false}));
test('current checkpoint counts are per recipient, preserve mismatch and unknown states, and never disclose packet contents',pg,()=>fixture(async h=>{
  const secret='PRIVATE-CLIENT-DOCUMENT-TOKEN',state={version:2,completed:false,manual_review:secret,inflight:{type:'audit',chat:'808',sourceIds:[secret]},
    recipients:[{chat:'909',role:'lawyer'}],cards:{808:201,909:202},auditCopies:{808:{messageIds:[301,302],sources:{'-1001':{messageIds:[303]}}}},requestCopies:{808:{messageIds:[401]}},
    materials:{confirmed:{808:[501,502]},files:4,parts:3,completed:false,inflight:true},linkedEgrn:{files:[{name:secret},{name:secret}],confirmed:{808:{one:{message_id:601},two:{legacy_receipt:secret}}},completed:false},
    egrn:{completed:true,result:'attached',order_started:false,uncertain:false,copies:{'["808","opaque-original"]':true}},body:{contacts:[secret]},fields:{phone:secret},packet:{report:{text:secret},materials:[{name:secret}]}};
  await h.add(39,62,{_handoff:state});const before=await h.db.query('SELECT data FROM cases WHERE id=39'),text=await h.invoke();
  assert.match(text,/Checkpoint v2 · completed нет · manual_review да/);assert.match(text,/совпадает с назначенным: нет/);assert.match(text,/inflight да · audit · TG 808/);
  assert.match(text,/TG 808: карточка 1 \(msg 201\); отчёт 3; заявка 1; ZIP 2\/3; ЕГРН-ссылки 2\/2; ЕГРН-копии 1/);
  assert.match(text,/TG 909: карточка 1/);assert.doesNotMatch(text,/PRIVATE|opaque|UNRELATED|unrelated_username|contacts|https:/);assert.deepEqual((await h.db.query('SELECT data FROM cases WHERE id=39')).rows,before.rows);assert.equal(h.queries.length,1);
}));
test('closed case and current recipient identity/access are shown rather than the saved display name alone',pg,()=>fixture(async h=>{
  await h.add(39,62,{_handoff:{version:2,completed:true,recipients:[{chat:'808'}],cards:{808:201}},_stage:'Архив'});
  await h.db.exec("UPDATE cases SET completed_at='2026-11-05T15:16:17Z',status='closed' WHERE id=39;UPDATE staff SET name='Valerie changed',username='valerie_new',role='auditor',approved=false WHERE tg_id=808;");
  const text=await h.invoke();assert.match(text,/completed_at UTC 2026-11-05T15:16:17.000Z/);assert.match(text,/status closed/);assert.match(text,/роль auditor · approved нет/);assert.match(text,/Valerie changed · @valerie_new/);assert.match(text,/совпадает с назначенным: да/);assert.match(text,/completed да/);
}));
test('only the newest bounded cases of the requested order are inspected, including a missing staff recipient',pg,()=>fixture(async h=>{
  for(const number of [35,36,37,38,39])await h.add(number);await h.add(999,63,{_handoff:{version:2,manual_review:'FOREIGN-ORDER'}});await h.db.exec('DELETE FROM staff WHERE tg_id=808');
  const text=await h.invoke();assert.match(text,/Клиентов по заявке: 5/);assert.match(text,new RegExp('показаны последние '+MAX_CASES));for(const number of [39,38,37])assert.ok(text.includes('Клиент #'+number));for(const number of [35,36,999])assert.ok(!text.includes('Клиент #'+number));assert.match(text,/staff нет · роль неизвестно · approved неизвестно/);assert.doesNotMatch(text,/FOREIGN-ORDER|UNRELATED/);assert.equal(h.queries.length,1);
}));
