const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };

async function fixture(run, options = {}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  await db.exec("CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,username TEXT,role TEXT,approved BOOLEAN,requested_role TEXT); INSERT INTO staff VALUES(808,'Сотрудник',NULL,'auditor',false,'lawyer');");
  const actions = [], messages = [], edits = [], answers = [], writes = [];
  let beforeWrite;
  const pool = { async query(sql,args) {
    if (/^(UPDATE|DELETE|INSERT)/.test(sql.trim())) {
      if (beforeWrite) { const hook=beforeWrite; beforeWrite=null; await hook(); }
      writes.push({sql,args});
    }
    const result=await db.query(sql,args);return {...result,rowCount:result.affectedRows ?? result.rows.length};
  } };
  const bot = { start(){},action(pattern,handler){actions.push([pattern,handler]);},command(){},hears(){},on(){},catch(){} };
  const context=vm.createContext({module:{exports:{}},console:{log(){},error(){}},process:{env:{BOT_TOKEN:'synthetic',GROUP_CHAT_ID:'-10042',WEBAPP_URL:'https://example.invalid',ADMIN_TG_IDS:options.explicitAdmins ?? '99'}},require(name){
    if(name==='telegraf')return {Telegraf:function(){return bot;},Markup:{button:{callback(){},webApp(){},url(){}},inlineKeyboard(){},keyboard(){return {resize(){}}}}};
    if(name==='../db/pool')return pool;
    if(name==='../db/queries')return {};
    if(name==='./formatter')return {esc:x=>x};
    if(name==='../web/manager-orders')return {};
    if(name==='../web/order-report-link')return {};
    if(name==='../db/order-delivery-lock')return {};
    if(name==='../web/auth')return {ensureStaff:async()=>{}};
    if(name==='../web/workspace')return {};
    if(name==='../web/handoff')return {setupReportsBot(){}};
    if(name==='./egrn')return {setupEgrn(){}};
    if(name==='./report-link-admin')return {setupReportLinkAdmin(){}};
    if(name==='./order-delivery-admin')return {setupOrderDeliveryAdmin(){}};
    if(name==='./manual-order-attachments')return {setupManualOrderAttachments(){}};
    if(name==='./staff-approval')return require('../src/bot/staff-approval');
    throw new Error('Unexpected require: '+name);
  }});
  vm.runInContext(fs.readFileSync(require.resolve('../src/bot/index'),'utf8'),context);context.module.exports.setupBot();
  const action=async(data,actor=99)=>{
    const match=actions.find(([pattern])=>pattern.test(data));assert.ok(match,'Registered approval callback: '+data);
    const [pattern,handler]=match;
    await handler({from:{id:actor,first_name:'Администратор'},chat:{id:actor,type:'private'},callbackQuery:{data},match:data.match(pattern),
      editMessageText:async(text,options)=>edits.push({text,options}),answerCbQuery:async text=>answers.push(text),telegram:{sendMessage:async(...args)=>messages.push(args)}});
  };
  try {await run({db,pool,action,messages,edits,answers,writes,beforeWrite(fn){beforeWrite=fn;},row:async()=>(await db.query('SELECT * FROM staff WHERE tg_id=808')).rows[0]});}
  finally {await db.close();}
}

test('an older approval button without its requested role refreshes the request instead of approving unseen permissions',pg,()=>fixture(async h=>{
  await h.action('ap:808');
  const row=await h.row();assert.equal(row.approved,false);assert.equal(row.requested_role,'lawyer');assert.equal(h.writes.length,0);assert.equal(h.messages.length,0);
  assert.match(h.edits[0].text,/Юрист/);
  const buttons=h.edits[0].options.reply_markup.inline_keyboard.flat();assert.ok(buttons.some(button=>button.callback_data==='ap:808:lawyer'));
}));

test('a changed role request cannot be approved through a previous role-specific button',pg,()=>fixture(async h=>{
  await h.action('ap:808:auditor');assert.equal((await h.row()).approved,false);assert.equal(h.writes.length,0);
}));

test('approval compares the requested role atomically when a different request arrives after the read',pg,()=>fixture(async h=>{
  h.beforeWrite(()=>h.db.query("UPDATE staff SET requested_role='manager' WHERE tg_id=808"));
  await h.action('ap:808:lawyer');const row=await h.row();assert.equal(row.approved,false);assert.equal(row.requested_role,'manager');assert.equal(h.messages.length,0);
}));

test('a concurrent rejection cannot delete staff already approved by another administrator',pg,()=>fixture(async h=>{
  h.beforeWrite(()=>h.db.query("UPDATE staff SET role='lawyer',approved=true,requested_role=NULL WHERE tg_id=808"));
  await h.action('rj:808:lawyer');const row=await h.row();assert.ok(row);assert.equal(row.approved,true);assert.equal(row.role,'lawyer');assert.equal(h.messages.length,0);
}));

test('matching approval records exactly the reviewed role once and duplicate callbacks do not notify again',pg,()=>fixture(async h=>{
  await h.action('ap:808:lawyer');const row=await h.row();assert.equal(row.approved,true);assert.equal(row.role,'lawyer');assert.equal(row.requested_role,null);assert.equal(h.messages.length,1);
  await h.action('ap:808:lawyer');assert.equal(h.messages.length,1);
}));

test('denial clears an approved employee request without revoking their existing role and removes a still-pending applicant',pg,async()=>{
  await fixture(async h=>{await h.db.query("UPDATE staff SET approved=true,role='auditor' WHERE tg_id=808");await h.action('rj:808:lawyer');const row=await h.row();assert.equal(row.approved,true);assert.equal(row.role,'auditor');assert.equal(row.requested_role,null);});
  await fixture(async h=>{await h.action('rj:808:lawyer');assert.equal(await h.row(),undefined);});
});

test('an unauthorized reviewer cannot read or change a pending role request',pg,()=>fixture(async h=>{
  await h.action('ap:808:lawyer',77);assert.equal(h.writes.length,0);assert.equal((await h.row()).approved,false);assert.equal(h.messages.length,0);
}));

test('revoking a fallback manager during approval prevents the final role mutation',pg,()=>fixture(async h=>{
  await h.db.query("INSERT INTO staff VALUES(99,'Менеджер',NULL,'manager',true,NULL)");
  h.beforeWrite(()=>h.db.query('UPDATE staff SET approved=false WHERE tg_id=99'));
  await h.action('ap:808:lawyer');const row=await h.row();assert.equal(row.approved,false);assert.equal(row.requested_role,'lawyer');assert.equal(h.messages.length,0);
  assert.match(h.answers.at(-1),/только администратор/);
},{explicitAdmins:''}));
