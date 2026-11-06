'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {createService,openPage,until,LAWYER}=require('./helpers');

test('manager sees live non-archived lawyer counts in the existing selector while assigned readonly lawyers receive no workload', {timeout:60000},async()=>{
  let service,browser;const visits=[],priorAdmins=process.env.ADMIN_TG_IDS;
  try{
    process.env.ADMIN_TG_IDS='';
    service=await createService({master:true});browser=await chromium.launch();
    await service.pool.query('UPDATE staff SET name=$1 WHERE tg_id=$2',['Валерия',LAWYER]);
    await service.pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES(3002,'Юрист без клиентов','lawyer',true),(3003,'Отозванный доступ','lawyer',false)");
    await service.pool.query(`INSERT INTO cases(id,order_id,lawyer_tg_id,lawyer_name,org,data,completed_at) VALUES
      (1001,59,$1,'Валерия','Synthetic active case','{}',NULL),
      (1002,NULL,$1,'Валерия','Synthetic pending delivery','{"_handoff":{"completed":false}}',NULL),
      (1003,NULL,$1,'Валерия','Synthetic decision received','{"_stage":"Решение получено"}','2026-11-01'),
      (1004,NULL,$1,'Валерия','Synthetic archived case','{"_stage":"Архив"}',NULL),
      (1005,NULL,3003,'Отозванный доступ','Synthetic revoked lawyer case','{}',NULL)`,[LAWYER]);
    const manager=await openPage(browser,service,2001,{pathname:'/handoff?order_id=60',mobile:true});visits.push(manager);const p=manager.page;
    await until(()=>p.locator('#lawyers option[value="'+LAWYER+'"]').count().then(count=>count===1),'Workload options loaded');
    assert.equal(await p.locator('#lawyers option[value="'+LAWYER+'"]').innerText(),'Валерия · 3 в работе');
    assert.equal(await p.locator('#lawyers option[value="3002"]').innerText(),'Юрист без клиентов · 0 в работе');assert.equal(await p.locator('#lawyers option[value="3003"]').count(),0);
    await p.locator('#lawyers').selectOption(String(LAWYER));assert.equal(await p.locator('#go').innerText(),'Передать · Валерия');
    assert.equal(await p.locator('#lawyers').evaluate(select=>select.selectedOptions[0].textContent),'Валерия · 3 в работе');
    await service.pool.query("UPDATE cases SET data=jsonb_set(COALESCE(data,'{}'::jsonb),'{_stage}','\"Архив\"') WHERE id=1002");
    await p.reload();await until(()=>p.locator('#lawyers option[value="'+LAWYER+'"]').innerText().then(text=>text==='Валерия · 2 в работе'),'Refreshed factual workload after archive');
    assert.equal(await p.locator('#lawyers').inputValue(),String(LAWYER),'Selection survives refresh without caching an obsolete count');
    const lawyer=await openPage(browser,service,LAWYER,{pathname:'/handoff?order_id=59&view=report',mobile:true});visits.push(lawyer);const view=lawyer.page;
    await until(()=>view.locator('#lawyers option[value="'+LAWYER+'"]').count().then(count=>count===1),'Readonly lawyer prefill completed');
    const body=await view.evaluate(()=>fetch('/api/handoff/prefill?order_id=59').then(response=>response.json()));
    assert.deepEqual(body.lawyers.map(row=>({tg_id:Number(row.tg_id),name:row.name})),[{tg_id:LAWYER,name:'Валерия'}]);assert.equal(Object.hasOwn(body.lawyers[0],'active_cases'),false);
    await until(()=>view.locator('#lawyers option[value="'+LAWYER+'"]').count().then(count=>count===1),'Private lawyer profile loaded');
    assert.equal(await view.locator('#lawyers option[value="'+LAWYER+'"]').innerText(),'Валерия');assert.equal(await view.locator('#assignment').isVisible(),false);
    const key=new URLSearchParams(service.keyQuery(3002)),denied=await fetch(service.origin+'/api/handoff/prefill?order_id=59',{headers:{'X-Tg-U':key.get('u'),'X-Tg-K':key.get('k')}});
    assert.ok(denied.status===403||denied.status===404);const error=await denied.json();assert.equal(error.lawyers,undefined);
    assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);
    for(const visit of visits){assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);}
  }finally{for(const visit of visits)await visit.context.close();await browser?.close();await service?.close();if(priorAdmins===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=priorAdmins;}
});
