'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCaseOpener,setupCaseOpen,NOT_AVAILABLE}=require('../src/bot/case-open');
const auth=require('../src/web/auth');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:15000};
function ctx(actor=808,changes={}) {const replies=[];return {from:{id:actor},chat:{id:actor,type:'private'},message:{text:'/case 39'},replies,async reply(text,extra){replies.push({text,extra});},telegram:new Proxy({},{get(){assert.fail('Only ctx.reply may deliver a navigation card');}}),...changes};}
async function fixture(run) {
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),queries=[],priorAdmins=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='111';
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);
    CREATE TABLE orders(id INT PRIMARY KEY,object_name TEXT);
    CREATE TABLE cases(id INT PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,org TEXT,address TEXT,kind TEXT,service TEXT,data JSONB DEFAULT '{}');
    CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,created_at TIMESTAMPTZ);
    INSERT INTO staff VALUES(108,'manager',true),(808,'lawyer',true),(909,'lawyer',true),(1001,'auditor',true),(111,'auditor',true);
    INSERT INTO orders VALUES(62,'Чанг'),(63,'Другой объект');
    INSERT INTO cases VALUES(39,62,808,'ИП Юридическое имя','Москва, улица Тестовая, 39','Общепит','Продление','{}'),(40,63,909,'Чужой клиент','Другой адрес','Магазин','Получение','{}');
    INSERT INTO audits VALUES(15,62,'2026-11-03T10:00:00Z'),(16,62,'2026-11-04T10:00:00Z'),(99,63,'2026-11-05T10:00:00Z');`);
  const pool={async query(sql,args){assert.match(sql,/^SELECT\b/);queries.push({sql,args});return db.query(sql,args);}};
  const options={pool,auth:{canAccessCase:auth.canAccessCase,keyQuery(){assert.fail('Inline WebApps must not carry actor credentials');}},webappUrl:'https://bot.example'};
  const create=extra=>createCaseOpener({...options,...extra});
  const open=async(actor=808,value='39',changes={})=>{const context=ctx(actor,changes);await create()(context,value);return context;};
  const save=state=>db.query('UPDATE cases SET data=$1 WHERE id=39',[JSON.stringify(state)]);
  try{await run({db,queries,pool,options,create,open,save});}finally{if(priorAdmins===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=priorAdmins;await db.close();}
}
const buttons=c=>c.replies[0].extra.reply_markup.inline_keyboard.flat();
test('only private command registration occurs at setup, and malformed IDs read nothing',async()=>{
  let handler;const open=setupCaseOpen({command(name,run){assert.equal(name,'case');handler=run;}},{pool:{query(){assert.fail('No SQL for setup or invalid IDs');}},auth:{},webappUrl:'https://bot.example'});
  for(const text of ['/case','/case 0','/case -1','/case 1.5','/case 39&report_id=99','/case 2147483648']){const c=ctx(808,{message:{text}});await handler(c);assert.equal(c.replies[0].text,NOT_AVAILABLE);}
  for(const value of [true,[39],0,NaN,'039',Number.MAX_SAFE_INTEGER]){const c=ctx();await open(c,value);assert.equal(c.replies[0].text,NOT_AVAILABLE);}
  const c=ctx(808,{chat:{type:'group',id:-1001}});await handler(c);assert.deepEqual(c.replies,[]);
});
test('current assigned lawyer receives the saved legal organization plus distinct brand and credential-free navigation',pg,()=>fixture(async h=>{
  const c=await h.open(),reply=c.replies[0];assert.match(reply.text,/Клиент #39/);assert.match(reply.text,/Организация: ИП Юридическое имя/);assert.match(reply.text,/Объект: Чанг/);assert.match(reply.text,/Москва, улица Тестовая, 39/);assert.match(reply.text,/Общепит · Продление/);assert.match(reply.text,/Этап: Сбор документов/);assert.match(reply.text,/https:\/\/t.me\/LRSZamer_bot\?start=case_39/);
  const links=buttons(c);assert.equal(links.length,3);assert.equal(links[1].text,'Перейти к отчёту');
  assert.equal(reply.extra.reply_markup.inline_keyboard.length,2);assert.equal(reply.extra.reply_markup.inline_keyboard[0].length,2);
  for(const button of links){const url=new URL(button.web_app.url);assert.equal(url.origin,'https://bot.example');assert.equal(url.searchParams.has('u'),false);assert.equal(url.searchParams.has('k'),false);}
  assert.deepEqual(reply.extra.reply_markup.inline_keyboard[1].map(button=>button.text),['Документы клиента']);assert.equal(new URL(links[2].web_app.url).search,'?case_id=39&view=documents');
  assert.equal(new URL(links[0].web_app.url).search,'?case_id=39');assert.equal(new URL(links[1].web_app.url).searchParams.get('report_id'),'16');assert.deepEqual(h.queries[0].args,[39,808]);assert.equal(h.queries.length,1);
}));
test('unassigned lawyers, auditors, missing/unapproved staff and absent cases receive the same generic response',pg,()=>fixture(async h=>{
  for(const actor of [909,1001,999]){const c=await h.open(actor,'39',{staff:{role:'manager',approved:true},initDataUnsafe:{user:{role:'manager'}}});assert.deepEqual(c.replies,[{text:NOT_AVAILABLE,extra:undefined}]);}
  assert.equal((await h.open(808,'999')).replies[0].text,NOT_AVAILABLE);await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');assert.equal((await h.open()).replies[0].text,NOT_AVAILABLE);
}));
test('approval, role and ownership are read again on each request; managers and approved configured admins use existing case access',pg,()=>fixture(async h=>{
  const opener=h.create();let c=ctx();await opener(c,'39');assert.ok(c.replies[0].extra);
  await h.db.query("UPDATE staff SET role='auditor' WHERE tg_id=808");c=ctx();await opener(c,'39');assert.equal(c.replies[0].text,NOT_AVAILABLE);
  await h.db.exec("UPDATE staff SET role='lawyer' WHERE tg_id=808;UPDATE cases SET lawyer_tg_id=909 WHERE id=39");assert.equal((await h.open()).replies[0].text,NOT_AVAILABLE);
  for(const actor of [108,111])assert.ok((await h.open(actor)).replies[0].extra);await h.db.query('UPDATE staff SET approved=false WHERE tg_id=111');assert.equal((await h.open(111)).replies[0].text,NOT_AVAILABLE);
}));
test('V2 links the exact frozen historical report, including imported source, rather than a newer order audit',pg,()=>fixture(async h=>{
  for(const src of ['a','r']){await h.save({_handoff:{version:2,body:{order_id:62,report_src:src,report_id:15}}});const c=await h.open(),url=new URL(buttons(c)[1].web_app.url);assert.equal(buttons(c)[1].text,'Перейти к отчёту');assert.equal(c.replies[0].extra.reply_markup.inline_keyboard[0].length,2);assert.equal(url.pathname,'/handoff');assert.equal(url.searchParams.get('view'),'report');assert.equal(url.searchParams.get('order_id'),'62');assert.equal(url.searchParams.get('report_src'),src);assert.equal(url.searchParams.get('report_id'),'15');}
}));

test('a V2 no-order case opens its exact saved report through case_id without credentials or a fabricated order',pg,()=>fixture(async h=>{
  await h.db.exec('UPDATE cases SET order_id=NULL WHERE id=39;UPDATE audits SET order_id=NULL WHERE id=15');
  await h.save({_handoff:{version:2,body:{order_id:null,report_src:'a',report_id:15}}});
  const c=await h.open(),url=new URL(buttons(c)[1].web_app.url);assert.equal(url.pathname,'/handoff');assert.equal(url.searchParams.get('case_id'),'39');assert.equal(url.searchParams.get('view'),'report');assert.equal(url.searchParams.get('report_id'),'15');assert.equal(url.searchParams.has('order_id'),false);assert.equal(url.searchParams.has('u'),false);assert.equal(url.searchParams.has('k'),false);
  for(const body of [{order_id:null,report_src:null,report_id:null},{order_id:62,report_src:'a',report_id:15}]){await h.save({_handoff:{version:2,body}});assert.equal(buttons(await h.open()).length,2);}
}));
test('manual clients without an order or report retain document access for the assigned lawyer and manager',pg,()=>fixture(async h=>{
  await h.db.exec('UPDATE cases SET order_id=NULL WHERE id=39');await h.save({_handoff:{version:2,body:{order_id:null,report_id:null,manual_client:true}}});
  for(const actor of [808,108]){const c=await h.open(actor),keyboard=c.replies[0].extra.reply_markup.inline_keyboard;assert.deepEqual(keyboard.map(row=>row.map(button=>button.text)),[['📋 Чек-лист клиента'],['Документы клиента']]);assert.equal(new URL(keyboard[1][0].web_app.url).search,'?case_id=39&view=documents');}
}));
test('invalid or unknown saved report bindings never fall back to the latest audit or inject an external URL',pg,()=>fixture(async h=>{
  for(const change of [{order_id:63},{report_id:'15&report_id=99'},{report_src:'https://evil.invalid'},{report_id:null}]){await h.save({_handoff:{version:2,body:{order_id:62,report_src:'a',report_id:15,...change}}});assert.equal(buttons(await h.open()).length,2);}
  await h.save({_handoff:{version:99,body:{order_id:62,report_src:'a',report_id:15}}});assert.equal(buttons(await h.open()).length,2);
}));
test('legacy cases without an audit still open their checklist, and archived cases remain explicitly labelled',pg,()=>fixture(async h=>{
  await h.db.query('DELETE FROM audits WHERE order_id=62');await h.save({_stage:'Архив'});const c=await h.open();assert.equal(buttons(c).length,2);assert.match(c.replies[0].text,/Этап: Архив/);
  await h.db.query("UPDATE orders SET object_name='ИП Юридическое имя' WHERE id=62");assert.doesNotMatch((await h.open()).replies[0].text,/Объект:/);
}));
test('links stay on the configured HTTPS WebApp origin and never carry base credentials or query keys',pg,()=>fixture(async h=>{
  for(const webappUrl of ['javascript:alert(1)','//evil.invalid','https://user:secret@evil.invalid','http://bot.example']){const c=ctx();await h.create({webappUrl})(c,39);assert.equal(c.replies[0].text,NOT_AVAILABLE);assert.equal(c.replies[0].extra,undefined);}
  const c=ctx();await h.create({webappUrl:'https://bot.example/some/path?u=PRIVATE&k=SECRET#token'})(c,39);for(const button of buttons(c)){assert.equal(new URL(button.web_app.url).origin,'https://bot.example');assert.doesNotMatch(button.web_app.url,/PRIVATE|SECRET|token|some\/path|[?&](?:u|k)=/);}
}));
test('read-only failures expose neither raw database errors nor a case existence signal',async()=>{
  const open=createCaseOpener({pool:{query(){throw new Error('PRIVATE CASE NAME TOKEN');}},auth:{},webappUrl:'https://bot.example'}),c=ctx();await open(c,39);assert.deepEqual(c.replies,[{text:NOT_AVAILABLE,extra:undefined}]);
});
