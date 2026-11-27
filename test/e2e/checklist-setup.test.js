'use strict';

const{test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const{chromium}=require('playwright');
const{createService,openPage,until,LAWYER}=require('./helpers');
let service,browser;
before(async()=>{service=await createService({master:true});process.env.WEBAPP_URL=service.origin;browser=await chromium.launch();await service.pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES(3002,'Other synthetic lawyer','lawyer',true)");});
after(async()=>{await browser?.close();await service?.close();});

const data={_stage:'Сбор документов',_comment:'Preserved lawyer note',basis:'Аренда',_handoff:{version:2,fields:{comment:'Private preserved manager checkpoint'}}};
async function seed(extra={}){const c={region:null,kind:null,service:null,key:null,...extra};return(await service.pool.query(`INSERT INTO cases(lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data,checklist_revision)
  VALUES($1,'Synthetic lawyer','Synthetic legacy client','Synthetic address',$2,$3,$4,$5,2001,$6,7) RETURNING id`,[LAWYER,c.region,c.kind,c.service,c.key,JSON.stringify(data)])).rows[0];}
async function row(id){return(await service.pool.query('SELECT * FROM cases WHERE id=$1',[id])).rows[0];}
async function choose(page){await page.locator('#setup-region').selectOption('МО');await page.locator('#setup-kind').selectOption('Магазин');await page.locator('#setup-service').selectOption('Переоформление');}
async function noSideEffects(visit){assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);}
function signedInit({date=Math.floor(Date.now()/1000),tampered=false}={}){
  const params=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id:LAWYER,first_name:'Synthetic + lawyer / & = Ж'})});
  const text=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>key+'='+value).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update('synthetic-e2e-token').digest();params.set('hash',crypto.createHmac('sha256',secret).update(text).digest('hex'));
  if(tampered)params.set('user',JSON.stringify({id:LAWYER,first_name:'Changed unsigned identity'}));return params.toString();
}

test('mobile legacy checklist opens automatically from exact known profile and keeps the lawyer note', {timeout:60000},async()=>{
  const c=await seed({region:'МСК',kind:'Общепит',service:'Получение',key:'constructor'});let visit;
  try{visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;
    await p.locator('#capsule').waitFor();assert.equal(await p.getByRole('heading',{name:'Synthetic legacy client',exact:true}).count(),1);assert.equal(await p.locator('#checklist-setup').count(),0);
    assert.equal(await p.locator('#lawyer-note').inputValue(),data._comment);assert.equal((await row(c.id)).checklist_key,'MSK_OBSH');assert.deepEqual((await row(c.id)).data,data);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'The narrow screen must not scroll horizontally');await noSideEffects(visit);
  }finally{await visit?.context.close();}
});

for(const mobile of[true,false])test((mobile?'mobile':'desktop keyboard')+' setup asks for missing profile, opens the selected checklist and can save answers after reopen',{timeout:60000},async()=>{
  const c=await seed();let visit;
  try{visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile});let p=visit.page;
    await p.locator('#checklist-setup').waitFor();for(const field of['region','kind','service'])assert.equal(await p.locator('#setup-'+field).inputValue(),'','Do not guess missing '+field);
    assert.equal(await p.locator('body').innerText().then(text=>text.includes('Private preserved manager checkpoint')),false);
    await choose(p);if(mobile)await p.locator('#setup-submit').click();else{await p.locator('#setup-submit').focus();await p.keyboard.press('Enter');}
    await p.locator('#capsule').waitFor();assert.equal((await row(c.id)).checklist_key,'MO_MAG_RE');assert.deepEqual((await row(c.id)).data,data);assert.equal(await p.locator('#lawyer-note').inputValue(),data._comment);
    await p.locator('#lawyer-note').fill('New note after choosing the checklist');await until(async()=>((await row(c.id)).data._comment==='New note after choosing the checklist'),'A recovered checklist saves against its new revision');
    await p.reload();await p.locator('#capsule').waitFor();assert.equal(await p.locator('#lawyer-note').inputValue(),'New note after choosing the checklist');assert.equal(await p.locator('#checklist-setup').count(),0);
    assert.deepEqual((await row(c.id)).data._handoff,data._handoff);await noSideEffects(visit);
  }finally{await visit?.context.close();}
});

test('lost setup acknowledgement retains choices and retry opens the committed checklist without a second initialization',{timeout:60000},async()=>{
  const c=await seed();let visit;
  try{visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;await p.locator('#checklist-setup').waitFor();await choose(p);let committed=false;
    await p.route('**/checklist/view?**',async route=>{if(!new URL(route.request().url()).searchParams.has('setup'))return route.continue();const response=await route.fetch();assert.equal(response.status(),200);committed=true;await route.abort('failed');});
    await p.locator('#setup-submit').click();await until(()=>committed,'Setup committed before its response was lost');await p.locator('#setup-submit:enabled').waitFor();assert.equal(await p.locator('#setup-region').inputValue(),'МО');assert.equal(await p.locator('#setup-kind').inputValue(),'Магазин');assert.equal(await p.locator('#setup-service').inputValue(),'Переоформление');
    assert.notEqual(await p.locator('#setup-status').innerText(),'');assert.equal((await row(c.id)).checklist_revision,8);await p.unroute('**/checklist/view?**');await p.locator('#setup-submit').click();await p.locator('#capsule').waitFor();
    const saved=await row(c.id);assert.equal(saved.checklist_revision,8);assert.equal(saved.checklist_key,'MO_MAG_RE');assert.deepEqual(saved.data,data);await noSideEffects(visit);
  }finally{await visit?.context.close();}
});

test('an unrelated lawyer sees a permission error with no checklist selectors or client details',{timeout:60000},async()=>{
  const c=await seed();let visit;
  try{visit=await openPage(browser,service,3002,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;await p.getByText('Этот клиент недоступен вашему аккаунту.',{exact:true}).waitFor();
    assert.equal(await p.locator('#checklist-setup').count(),0);assert.doesNotMatch(await p.locator('body').innerText(),/Synthetic legacy client|Preserved lawyer note|Private preserved manager checkpoint/);assert.equal((await row(c.id)).checklist_key,null);await noSideEffects(visit);
  }finally{await visit?.context.close();}
});

for(const authMode of['signed keyboard key','signed Telegram fragment'])test('a stalled Telegram SDK and unavailable auth script cannot block '+authMode+' setup, reload or saving',{timeout:60000},async()=>{
  const c=await seed(),context=await browser.newContext({viewport:{width:430,height:850}}),errors=[],blocked=[];let release,sdkRequested=0;
  const gate=new Promise(resolve=>{release=resolve;});
  try{
    await context.route('**/*',async route=>{
      const url=route.request().url();if(url.startsWith('https://telegram.org/js/')){sdkRequested++;await gate;try{return await route.abort('failed');}catch(_){return;}}
      if(url===service.origin+'/auth.js')return route.abort('failed');if(url.startsWith(service.origin+'/')||/^(?:blob:|data:)/.test(url))return route.continue();blocked.push(url);return route.abort('blockedbyclient');
    });
    const p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',error=>errors.push(error.message));p.on('dialog',dialog=>dialog.dismiss());
    const suffix=authMode==='signed keyboard key'?'&'+service.keyQuery(LAWYER):'#form?tgWebAppData='+encodeURIComponent(signedInit())+'&tgWebAppPlatform=macos';
    await p.goto(service.origin+'/checklist?case_id='+c.id+suffix,{waitUntil:'domcontentloaded'});await p.locator('#checklist-setup').waitFor();assert.ok(sdkRequested>0,'The external SDK must remain stalled while the checklist works');assert.equal(await p.evaluate(()=>!!window.fetch.__tg),true);
    await choose(p);await p.locator('#setup-submit').click();await p.locator('#capsule').waitFor();assert.equal(await p.locator('#lawyer-note').inputValue(),data._comment);
    const note='Saved with unavailable Telegram SDK: '+authMode;await p.locator('#lawyer-note').fill(note);await until(async()=>(await row(c.id)).data._comment===note,'Inline authentication survives setup and authenticated checklist saving');
    await p.reload({waitUntil:'domcontentloaded'});await p.locator('#capsule').waitFor();assert.equal(await p.locator('#lawyer-note').inputValue(),note);assert.equal((await row(c.id)).checklist_key,'MO_MAG_RE');assert.deepEqual((await row(c.id)).data._handoff,data._handoff);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);
  }finally{release();await context.close();}
});

for(const profile of[{tampered:true},{date:Math.floor(Date.now()/1000)-8*86400}])test('inline checklist authentication rejects '+(profile.tampered?'tampered':'expired')+' launch fragments when external scripts fail',{timeout:60000},async()=>{
  const c=await seed(),context=await browser.newContext(),errors=[];
  try{await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('https://telegram.org/js/')||url===service.origin+'/auth.js')return route.abort('failed');return url.startsWith(service.origin+'/')?route.continue():route.abort('blockedbyclient');});
    const p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',error=>errors.push(error.message));await p.goto(service.origin+'/checklist?case_id='+c.id+'#tgWebAppData='+encodeURIComponent(signedInit(profile)),{waitUntil:'domcontentloaded'});
    await until(async()=>/Нет доступа/.test(await p.locator('body').innerText()),'Invalid signed fragments must remain unauthorized');assert.equal(await p.locator('#checklist-setup').count(),0);assert.doesNotMatch(await p.locator('body').innerText(),/Synthetic legacy client|Preserved lawyer note|Private preserved manager checkpoint/);assert.equal((await row(c.id)).checklist_key,null);assert.deepEqual(errors,[]);assert.equal(service.messages.length,0);
  }finally{await context.close();}
});
