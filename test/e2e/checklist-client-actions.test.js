'use strict';

const{test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const{randomUUID}=require('node:crypto');
const{chromium}=require('playwright');
const{createService,openPage,until,LAWYER}=require('./helpers');
let service,browser;
before(async()=>{service=await createService({master:true,privateChats:[2001]});process.env.WEBAPP_URL=service.origin;browser=await chromium.launch();await service.pool.query("UPDATE staff SET name='Synthetic Valerie' WHERE tg_id=$1",[LAWYER]);});
after(async()=>{await browser?.close();await service?.close();});
const initialData={_stage:'Подано',_submittedOn:'2026-11-23',_decisionDue:'2026-12-21',_comment:'Existing lawyer note\nEverything is within the boundaries.',basis:'Аренда',answer:{s:'ok'},_handoff:{version:2,fields:{comment:'Manager checkpoint'},completed:true}};
const managerComment='Existing manager comment\nKeep every word.';
async function seed(extra={}){const c={region:null,kind:null,service:null,key:null,...extra};return(await service.pool.query(`INSERT INTO cases(lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,comment,data,checklist_revision)
  VALUES($1,'Synthetic Valerie','Synthetic client without checklist','Synthetic address',$2,$3,$4,$5,2001,$6,$7,7) RETURNING id`,[LAWYER,c.region,c.kind,c.service,c.key,managerComment,JSON.stringify(initialData)])).rows[0];}
async function row(id){return(await service.pool.query('SELECT * FROM cases WHERE id=$1',[id])).rows[0];}
const noticeCount=actor=>service.messages.filter(item=>item.method==='sendMessage'&&String(item.args[0])===String(actor)).length;
async function checkVisit(visit){assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);assert.equal(service.egrnRequests.length,0);assert.equal(service.messages.filter(item=>String(item.args[0]).startsWith('-')).length,0);}
function signedInit(){const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:LAWYER,first_name:'Synthetic + Valerie / & Ж'})});const check=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>key+'='+value).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update('synthetic-e2e-token').digest();params.set('hash',crypto.createHmac('sha256',secret).update(check).digest('hex'));return params.toString();}

test('an assigned lawyer returns an unconfigured client for correction and the manager responds without selecting a checklist',{timeout:60000},async()=>{
  const c=await seed(),visits=[],managerBefore=noticeCount(2001),lawyerBefore=noticeCount(LAWYER);
  try{const visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});visits.push(visit);const p=visit.page;
    await p.locator('#case-actions').waitFor();assert.equal(await p.locator('#case-note').innerText(),initialData._comment);assert.equal(await p.locator('#case-manager-comment').innerText(),managerComment);assert.equal(await p.locator('#case-documents').isVisible(),true);
    const panel=p.locator('#rework-panel');await panel.getByRole('button',{name:'Вернуть на доработку',exact:true}).click();await panel.getByRole('button',{name:'Отправить менеджеру',exact:true}).click();await panel.getByText('Заполните это поле.',{exact:true}).waitFor();assert.equal(noticeCount(2001),managerBefore);
    const reason='Приложите договор аренды\nУточните контакт клиента';await panel.getByLabel('Что нужно доработать').fill(reason);await panel.getByRole('button',{name:'Отправить менеджеру',exact:true}).click();await panel.getByText('На доработке у менеджера',{exact:true}).waitFor();assert.equal(noticeCount(2001),managerBefore+1);
    const managerVisit=await openPage(browser,service,2001,{pathname:'/checklist?case_id='+c.id+'&rework=1',mobile:false});visits.push(managerVisit);const managerPanel=managerVisit.page.locator('#rework-panel');await managerPanel.getByText('На доработке у менеджера',{exact:true}).waitFor();assert.ok((await managerPanel.innerText()).includes(reason));
    await managerPanel.getByRole('button',{name:'Сообщить о доработке',exact:true}).click();await managerPanel.getByLabel('Что уточнили или приложили').fill('Договор приложен. Контакт проверен.');await managerPanel.getByRole('button',{name:'Вернуть юристу',exact:true}).click();await until(()=>noticeCount(LAWYER)===lawyerBefore+1,'The fake Telegram records one resolution for the assigned lawyer');
    await p.reload();await panel.getByText('История доработок',{exact:false}).click();await panel.getByText('Доработка завершена',{exact:true}).waitFor();const saved=await row(c.id);assert.equal(saved.checklist_key,null);assert.deepEqual(saved.data,initialData);assert.equal(saved.checklist_revision,7);for(const item of visits)await checkVisit(item);
  }finally{for(const visit of visits)await visit.context.close();}
});

test('mobile archive confirmation can be cancelled and confirmed, then restores the previous stage with notes and files untouched',{timeout:60000},async()=>{
  const c=await seed();let visit;try{visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;await p.locator('#case-actions').waitFor();let mutations=0;p.on('request',request=>{if(new URL(request.url()).searchParams.get('manage')==='1')mutations++;});
    await p.locator('#case-archive').click();await p.locator('#case-action-confirmation').waitFor();assert.equal(mutations,0,'Opening confirmation does not change the client');await p.locator('#case-action-cancel').click();assert.equal(await p.locator('#case-action-confirmation').isHidden(),true);assert.deepEqual((await row(c.id)).data,initialData);
    await p.locator('#case-archive').click();await p.locator('#case-action-confirm').click();await p.locator('#case-restore').waitFor();assert.equal(await p.locator('#case-stage').innerText(),'Архив');assert.equal(await p.locator('#checklist-setup').count(),0);assert.equal((await row(c.id)).checklist_key,null);assert.equal((await row(c.id)).checklist_revision,8);
    await p.locator('#case-restore').click();await p.locator('#case-action-confirm').click();await p.locator('#case-archive').waitFor();assert.equal(await p.locator('#case-stage').innerText(),'Подано');assert.equal(await p.locator('#case-note').innerText(),initialData._comment);assert.equal(await p.locator('#case-manager-comment').innerText(),managerComment);assert.equal((await row(c.id)).checklist_revision,9);const data={...(await row(c.id)).data};delete data._lastClientAction;assert.deepEqual(data,initialData);assert.equal(mutations,2);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);await checkVisit(visit);
  }finally{await visit?.context.close();}
});

test('lost archive acknowledgement survives reload and explicit result verification reuses the same request without a second mutation',{timeout:60000},async()=>{
  const c=await seed();let visit;try{visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;await p.locator('#case-archive').waitFor();let firstBody,attempts=0,secondResult;
    await p.route('**/checklist/view?**',async route=>{if(new URL(route.request().url()).searchParams.get('manage')!=='1')return route.continue();const posted=route.request().postDataJSON(),response=await route.fetch();if(attempts++===0){firstBody=posted;assert.equal((await response.json()).replayed,false);return route.abort('failed');}assert.deepEqual(posted,firstBody);secondResult=await response.json();return route.fulfill({response});});
    await p.locator('#case-archive').click();await p.locator('#case-action-confirm').click();await until(async()=>/Проверить результат/.test(await p.locator('#case-action-confirm').innerText()),'Lost archive ACK becomes retryable');assert.equal((await row(c.id)).data._stage,'Архив');assert.equal((await row(c.id)).checklist_revision,8);
    await p.reload();await p.locator('#case-action-retry').waitFor();assert.equal(attempts,1,'Reopening must never resend automatically');await p.locator('#case-action-retry').click();await p.locator('#case-action-confirm').click();await p.locator('#case-restore').waitFor();assert.equal(attempts,2);assert.equal(secondResult.replayed,true);assert.equal((await row(c.id)).checklist_revision,8);assert.equal((await row(c.id)).data._lastClientAction.id,firstBody.request_id);await checkVisit(visit);
  }finally{await visit?.context.close();}
});

test('a malformed success acknowledgement with an arbitrary higher revision retains the pending action until the real change is confirmed',{timeout:60000},async()=>{
  const c=await seed();let visit;try{visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;await p.locator('#case-archive').waitFor();let posted;
    await p.route('**/checklist/view?**',async route=>{if(new URL(route.request().url()).searchParams.get('manage')!=='1')return route.continue();posted=route.request().postDataJSON();return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,case_id:c.id,stage:'Архив',revision:99,replayed:false})});});
    await p.locator('#case-archive').click();await p.locator('#case-action-confirm').click();await until(async()=>/Сервер не подтвердил/.test(await p.locator('#case-action-status').innerText()),'An unrelated higher revision cannot confirm this exact pending action');
    assert.equal((await row(c.id)).checklist_revision,7);assert.equal((await row(c.id)).data._stage,'Подано');assert.equal(await p.locator('#case-stage').innerText(),'Подано');assert.equal(await p.locator('#case-action-confirm').innerText(),'Проверить результат');assert.deepEqual(await p.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),'case-basic-action:'+LAWYER+':'+c.id),posted);
    await p.unroute('**/checklist/view?**');await p.locator('#case-action-confirm').click();await p.locator('#case-restore').waitFor();const saved=await row(c.id);assert.equal(saved.checklist_revision,8);assert.equal(saved.data._stage,'Архив');assert.equal(saved.data._lastClientAction.id,posted.request_id);await checkVisit(visit);
  }finally{await visit?.context.close();}
});

for(const mode of['keyboard key','Telegram launch fragment'])test('unsupported-profile documents remain accessible with '+mode+' authentication preserved',{timeout:60000},async()=>{
  const c=await seed({region:'СПб',kind:'Магазин',service:'Получение'}),context=await browser.newContext({viewport:{width:430,height:850}}),errors=[],blocked=[];
  try{await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('https://telegram.org/js/')||url===service.origin+'/auth.js')return route.abort('failed');if(url.startsWith(service.origin+'/')||/^(blob:|data:)/.test(url))return route.continue();blocked.push(url);return route.abort('blockedbyclient');});const p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',error=>errors.push(error.message));const hash=mode==='Telegram launch fragment'?'#form?tgWebAppData='+encodeURIComponent(signedInit())+'&tgWebAppPlatform=macos':'';
    await p.goto(service.origin+'/checklist?case_id='+c.id+(mode==='keyboard key'?'&'+service.keyQuery(LAWYER):'')+hash,{waitUntil:'domcontentloaded'});await p.locator('#checklist-setup-unsupported').waitFor();assert.equal(await p.locator('#case-archive').isVisible(),true);await p.locator('#rework-panel').getByRole('button',{name:'Вернуть на доработку',exact:true}).waitFor();
    const link=new URL(await p.locator('#case-documents').getAttribute('href'),service.origin);assert.equal(link.pathname,'/handoff');assert.equal(link.searchParams.get('case_id'),String(c.id));assert.equal(link.searchParams.get('view'),'documents');if(hash)assert.equal(link.hash,hash);else{assert.equal(link.searchParams.get('u'),String(LAWYER));assert.ok(link.searchParams.get('k'));}
    const prefill=p.waitForResponse(response=>new URL(response.url()).pathname==='/api/handoff/prefill');await p.locator('#case-documents').click();assert.equal((await prefill).status(),200);await p.getByRole('heading',{name:'Документы клиента',exact:true}).waitFor();assert.equal((await row(c.id)).checklist_key,null);assert.deepEqual((await row(c.id)).data,initialData);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.equal(service.egrnRequests.length,0);
  }finally{await context.close();}
});

test('a stale management page asks for refresh after a conflict instead of silently changing the client again',{timeout:60000},async()=>{
  const c=await seed();let visit;try{visit=await openPage(browser,service,LAWYER,{pathname:'/checklist?case_id='+c.id,mobile:true});const p=visit.page;await p.locator('#case-archive').waitFor();const response=await p.evaluate(async({id,request_id})=>{const response=await fetch('/checklist/view?case_id='+id+'&manage=1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'archive_client',expectedRevision:7,request_id})});return{status:response.status,data:await response.json()};},{id:c.id,request_id:randomUUID()});assert.equal(response.status,200);
    await p.locator('#case-archive').click();await p.locator('#case-action-confirm').click();await p.locator('#case-action-refresh').waitFor();assert.match(await p.locator('#case-action-status').innerText(),/Карточка изменилась|Версия карточки/);assert.equal((await row(c.id)).checklist_revision,8);await p.locator('#case-action-refresh').click();await p.locator('#case-restore').waitFor();assert.equal(await p.locator('#case-stage').innerText(),'Архив');assert.equal((await row(c.id)).checklist_revision,8);await checkVisit(visit);
  }finally{await visit?.context.close();}
});
