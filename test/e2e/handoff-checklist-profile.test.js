'use strict';

const{test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const{chromium}=require('playwright');
const{createService,openPage,until,LAWYER}=require('./helpers');
let service,browser;
before(async()=>{service=await createService({master:true,clientsGroup:'-1007777999955'});browser=await chromium.launch();});
after(async()=>{await browser?.close();await service?.close();});

for(const profile of[{region:'СПб',kind:'Магазин',service:'Получение'},{region:'МО',kind:'Табак',service:'Получение'}])test('manual '+JSON.stringify(profile)+' warns before sending and opens the assigned lawyer basic card without another-region checklist',{timeout:60000},async()=>{
 const visits=[],messagesBefore=service.messages.length,casesBefore=(await service.pool.query('SELECT id FROM cases')).rows.length;
 try{const manager=await openPage(browser,service,2001,{pathname:'/handoff?mode=manual',mobile:true});visits.push(manager);const p=manager.page;
  await until(()=>p.locator('#manual-files').isEnabled(),'Independent manager form and empty staged document list are ready');
  const org='Synthetic '+profile.region+' '+profile.kind;await p.locator('#details').evaluate(element=>{element.open=true;});await p.locator('#org').fill(org);await p.locator('#org').press('Tab');await p.locator('#address').fill('Synthetic address for '+profile.region);await p.locator('#address').press('Tab');for(const field of['region','kind','service'])await p.locator('#'+field).selectOption(profile[field]);await p.locator('#lawyers').selectOption(String(LAWYER));
  await p.locator('#go').click();await p.locator('#review').waitFor({state:'visible'});await p.locator('#review-checklist-warning').waitFor({state:'visible'});assert.match(await p.locator('#review-checklist-warning').innerText(),/Для этой услуги пока нет подходящего чек-листа/);assert.doesNotMatch(await p.locator('#review-list').innerText(),/Чек-лист по выбранной услуге/);assert.equal((await service.pool.query('SELECT id FROM cases')).rows.length,casesBefore,'The warning appears before any client or delivery is created');assert.equal(service.messages.length,messagesBefore);
  await p.locator('#confirm-send').click();await p.locator('#manual-create-another').waitFor({state:'visible'});const[c]=(await service.pool.query('SELECT * FROM cases WHERE org=$1',[org])).rows;assert.equal(c.checklist_key,null);assert.equal(c.total,0);assert.equal(c.data._handoff.checklistUnavailable,true);for(const[field,value]of Object.entries(profile))assert.equal(c[field],value);
  const privateCard=service.messages.slice(messagesBefore).find(event=>event.method==='sendMessage'&&String(event.args[0])===String(LAWYER));assert.match(privateCard.args[1],/Для этой услуги пока нет подходящего чек-листа/);const cardButton=privateCard.args[2].reply_markup.inline_keyboard.flat().find(button=>button.text==='Карточка клиента');assert.ok(cardButton);const cardURL=new URL(cardButton.web_app.url),lawyer=await openPage(browser,service,LAWYER,{pathname:cardURL.pathname+cardURL.search,mobile:true});visits.push(lawyer);await lawyer.page.locator('#checklist-setup-unsupported').waitFor();assert.equal(await lawyer.page.locator('#case-documents').isVisible(),true);assert.equal(await lawyer.page.locator('#case-archive').isVisible(),true);await lawyer.page.locator('#rework-panel').getByRole('button',{name:'Вернуть на доработку',exact:true}).waitFor();assert.equal(await lawyer.page.locator('#capsule').count(),0);
  const group=service.messages.slice(messagesBefore).find(event=>event.method==='sendMessage'&&String(event.args[0])==='-1007777999955');assert.match(group.args[1],/Для этой услуги пока нет подходящего чек-листа/);assert.equal(service.egrnRequests.length,0);for(const visit of visits){assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);}
 }finally{for(const visit of visits)await visit.context.close();}
});
