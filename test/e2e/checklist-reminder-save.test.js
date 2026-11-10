'use strict';

const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {createService,openPage,until,LAWYER}=require('./helpers');
let sharedService,sharedBrowser;
before(async()=>{sharedService=await createService({master:true});process.env.WEBAPP_URL=sharedService.origin;sharedBrowser=await chromium.launch();});
after(async()=>{await sharedBrowser?.close();await sharedService?.close();});

test('reminder editor retains unsaved input through checklist rendering and a newer reminder while an earlier save is acknowledged', {timeout:60000},async()=>{
  const service=sharedService,browser=sharedBrowser;let visit,release,connect;
  try{
    const c=(await service.pool.query(`INSERT INTO cases(lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data)
      VALUES($1,'Synthetic lawyer','Synthetic reminder race','Москва','МСК','Магазин','Продление','MSK_MAG',2001,'{}') RETURNING id`,[LAWYER])).rows[0];
    visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;
    const text=p.getByPlaceholder('О чём напомнить'),date=p.locator('.remadd input[type=date]');
    await text.fill('A saved reminder');await date.fill('2026-11-13');
    await p.getByRole('button',{name:'Выездная проверка',exact:true}).click();
    assert.equal(await text.inputValue(),'A saved reminder','A normal checklist render must not discard an unsaved reminder');
    assert.equal(await date.inputValue(),'2026-11-13');
    let held=false;const gate=new Promise(resolve=>{release=resolve;});
    await p.route('**/api/checklist/reminders',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const response=await route.fetch();held=true;await gate;await route.fulfill({response});
    });
    await p.getByRole('button',{name:'+ Напомнить',exact:true}).click();await until(()=>held,'Reminder A committed while its ACK is held');
    await text.fill('B next unsaved reminder');await date.fill('2026-11-16');release();
    await until(()=>p.getByRole('button',{name:'+ Напомнить',exact:true}).isEnabled(),'Reminder A ACK is applied');
    assert.equal(await p.locator('.remrow .lbl').innerText(),'A saved reminder','Visible saved item must describe the actual posted snapshot');
    assert.equal(await text.inputValue(),'B next unsaved reminder','The newer reminder remains editable rather than being erased by A ACK');
    assert.equal(await date.inputValue(),'2026-11-16');
    assert.match(await p.locator('.remdraft').innerText(),/ещё не сохранено/);
    const rows=(await service.pool.query('SELECT text,remind_on FROM case_reminders WHERE case_id=$1',[c.id])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].text,'A saved reminder');assert.equal(new Date(rows[0].remind_on).toISOString().slice(0,10),'2026-11-13');
    await p.unroute('**/api/checklist/reminders');
    let failedSaveWaiting=false;const denied=new Promise(resolve=>{release=resolve;});connect=service.pool.connect;
    service.pool.connect=async function(){
      const client=await connect.call(this),query=client.query;client.query=async function(sql,args){
        if(sql.includes('INSERT INTO case_reminders')&&args?.[2]==='B next unsaved reminder'){failedSaveWaiting=true;await denied;throw new Error('Synthetic storage unavailable before reminder insert');}
        return query.call(this,sql,args);
      };return client;
    };
    await p.getByRole('button',{name:'+ Напомнить',exact:true}).click();await until(()=>failedSaveWaiting,'Reminder B waits before its failed insert');
    await p.getByRole('button',{name:'Сбор документов',exact:true}).click();
    assert.equal(await p.getByRole('button',{name:'Сохраняю…',exact:true}).isDisabled(),true,'A new render must retain the single pending submission guard');
    await text.fill('C retained after B failure');release();
    await until(()=>p.getByRole('button',{name:'Проверить сохранение',exact:true}).isEnabled(),'An unconfirmed save releases the current button for exact verification');
    assert.equal(await text.inputValue(),'C retained after B failure');assert.equal(await date.inputValue(),'2026-11-16');
    assert.match(await p.locator('.remdraft').innerText(),/не подтверждено/);
    service.pool.connect=connect;
    await p.getByRole('button',{name:'Проверить сохранение',exact:true}).click();
    await until(()=>p.getByRole('button',{name:'+ Напомнить',exact:true}).isEnabled(),'The exact original B request is now confirmed');
    assert.equal(await text.inputValue(),'C retained after B failure');assert.match(await p.locator('.remdraft').innerText(),/ещё не сохранено/);
    await p.getByRole('button',{name:'+ Напомнить',exact:true}).click();
    await until(()=>p.locator('.remrow').count().then(count=>count===3),'A new deliberate C reminder is saved after B is confirmed');
    assert.deepEqual(await p.locator('.remrow .lbl').allInnerTexts(),['A saved reminder','B next unsaved reminder','C retained after B failure']);assert.equal(await text.inputValue(),'');
    assert.deepEqual((await service.pool.query('SELECT text FROM case_reminders WHERE case_id=$1 ORDER BY id',[c.id])).rows.map(row=>row.text),['A saved reminder','B next unsaved reminder','C retained after B failure']);
    assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);assert.equal(service.egrnRequests.length,0);
  }finally{release?.();if(connect)service.pool.connect=connect;await visit?.context.close();}
});

test('a committed reminder with lost HTTP ACK survives close/reopen and verifies exact A before deliberately creating a separate draft B', {timeout:60000},async()=>{
  const service=sharedService,browser=sharedBrowser;let visit,release;
  try{
    const c=(await service.pool.query(`INSERT INTO cases(lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data)
      VALUES($1,'Synthetic lawyer','Synthetic lost reminder ACK','Москва','МСК','Магазин','Продление','MSK_MAG',2001,'{}') RETURNING id`,[LAWYER])).rows[0];
    visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});let p=visit.page,firstBody,committed=false;
    const gate=new Promise(resolve=>{release=resolve;});
    await p.route('**/api/checklist/reminders',async route=>{
      if(route.request().method()!=='POST')return route.continue();firstBody=route.request().postDataJSON();await route.fetch();committed=true;await gate;await route.abort('failed');
    });
    await p.getByPlaceholder('О чём напомнить').fill('A committed but ACK lost');await p.locator('.remadd input[type=date]').fill('2026-11-13');
    await p.getByRole('button',{name:'+ Напомнить',exact:true}).click();await until(()=>committed,'A exists durably before losing its HTTP response');
    await p.getByPlaceholder('О чём напомнить').fill('B newer unsaved reminder');await p.locator('.remadd input[type=date]').fill('2026-11-16');release();
    await p.getByRole('button',{name:'Проверить сохранение',exact:true}).waitFor();await p.close();
    p=await visit.context.newPage();p.on('pageerror',error=>visit.errors.push(error.message));await p.goto(service.origin+'/checklist?case_id='+c.id+'&'+service.keyQuery(LAWYER));
    await p.getByRole('button',{name:'Проверить сохранение',exact:true}).waitFor();assert.equal(await p.getByPlaceholder('О чём напомнить').inputValue(),'B newer unsaved reminder');
    let retriedBody; p.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/checklist/reminders'))retriedBody=request.postDataJSON();});
    await p.getByRole('button',{name:'Проверить сохранение',exact:true}).click();await p.getByRole('button',{name:'+ Напомнить',exact:true}).waitFor();
    assert.deepEqual(retriedBody,firstBody);assert.equal(await p.locator('.remrow').count(),1);assert.equal(await p.locator('.remrow .lbl').innerText(),'A committed but ACK lost');
    assert.equal(await p.getByPlaceholder('О чём напомнить').inputValue(),'B newer unsaved reminder');assert.match(await p.locator('.remdraft').innerText(),/ещё не сохранено/);
    assert.equal((await service.pool.query('SELECT * FROM case_reminders WHERE case_id=$1',[c.id])).rows.length,1);
    await p.getByRole('button',{name:'+ Напомнить',exact:true}).click();await until(()=>p.locator('.remrow').count().then(count=>count===2),'B is a separate deliberate reminder after confirming A');
    assert.notEqual(retriedBody.request_id,firstBody.request_id);const rows=(await service.pool.query('SELECT text,request_id FROM case_reminders WHERE case_id=$1 ORDER BY id',[c.id])).rows;
    assert.deepEqual(rows.map(row=>row.text),['A committed but ACK lost','B newer unsaved reminder']);assert.equal(new Set(rows.map(row=>row.request_id)).size,2);
    assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);assert.equal(service.egrnRequests.length,0);
  }finally{release?.();await visit?.context.close();}
});
