'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');
const {createService,openPage,multiPagePdf,until,hash,GROUP,LAWYER}=require('./helpers');

test('an unlinked report survives a lost handoff HTTP ACK and reopening, with one private package and case-bound lawyer originals', {timeout:90000},async()=>{
  let service,browser;const visits=[],clientsGroup='-1007777999922';
  try{
    service=await createService({master:true,clientsGroup});browser=await chromium.launch();
    const telegram=require('../../src/bot/instance').telegram,draftId=randomUUID();
    const text='Synthetic complete unlinked auditor report\nОрганизация: ООО «Без заявки»\nАдрес: Москва, Отдельная улица, 11\nНужны действия: сверить оригиналы.\nПоследняя сохранённая строка.';
    const originals=[
      {id:randomUUID(),name:'Synthetic-unlinked-plan.pdf',mime:'application/pdf',role:'plan-source',subject_id:'source',content:multiPagePdf()},
      {id:randomUUID(),name:'Synthetic-unlinked-document.pdf',mime:'application/pdf',role:'document',subject_id:'original',content:Buffer.concat([multiPagePdf(),Buffer.from('\n% Distinct unlinked original\n')])},
    ];
    const metadata=originals.map(file=>({id:file.id,name:file.name,mime:file.mime,role:file.role,subject_id:file.subject_id,bytes:file.content.length,sha256:hash(file.content)}));
    const data={ui_version:5,workflow:{conclusion_status:'actions'},inspection:{org:'ООО «Без заявки»',address:'Москва, Отдельная улица, 11',service:'Получение'},documents:metadata};
    await service.pool.query('INSERT INTO audit_drafts(id,author_tg_id,order_id,data,submitted_at) VALUES($1,1001,NULL,$2,NOW())',[draftId,JSON.stringify(data)]);
    for(const file of originals)await service.pool.query('INSERT INTO audit_evidence(draft_id,id,name,mime,role,subject_id,bytes,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[draftId,file.id,file.name,file.mime,file.role,file.subject_id,file.content.length,hash(file.content),file.content]);
    const sourceIds=[(await telegram.sendMessage(GROUP,text)).message_id];
    for(const file of originals)sourceIds.push((await telegram.sendDocument(GROUP,{source:file.content,filename:file.name})).message_id);
    const audit=(await service.pool.query('INSERT INTO audits(order_id,text,chat_id,msg_ids,report_data,draft_id) VALUES(NULL,$1,$2,$3,$4,$5) RETURNING id',[text,GROUP,sourceIds,JSON.stringify(data),draftId])).rows[0];
    const foreignAudit=(await service.pool.query("INSERT INTO audits(order_id,text,chat_id,msg_ids) VALUES(NULL,'Synthetic unrelated report',$1,$2) RETURNING id",[GROUP,[sourceIds[0]]])).rows[0];
    const pathname='/handoff?report_src=a&report_id='+audit.id;
    const manager=await openPage(browser,service,2001,{pathname,mobile:false});visits.push(manager);const page=manager.page;
    await until(()=>page.locator('#lawyers option[value="'+LAWYER+'"]').count().then(count=>count===1),'Unlinked handoff source and lawyer loaded');
    await until(()=>page.locator('#open-report').isEnabled(),'Unlinked saved audit packet loaded');
    await page.locator('#details').evaluate(element=>{element.open=true;});
    await page.locator('#org').fill(data.inspection.org);await page.locator('#org').press('Tab');
    await page.locator('#address').fill(data.inspection.address);await page.locator('#address').press('Tab');
    await page.locator('#region').selectOption('МСК');await page.locator('#kind').selectOption('Общепит');await page.locator('#service').selectOption('Получение');
    await page.locator('#lawyers').selectOption(String(LAWYER));
    const bodies=[];let committed;
    await page.route('**/api/handoff',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      bodies.push(route.request().postDataJSON());const response=await route.fetch();assert.equal(response.status(),200);
      const result=await response.json();assert.equal(result.delivery_complete,true);
      if(!committed){committed=result;return route.abort('failed');}
      return route.fulfill({response});
    });
    const before=service.messages.length;
    await page.locator('#go').click();assert.equal(await page.locator('#form-error').innerText(),'','The real producer accepts the completed no-order profile');await page.locator('#review').waitFor({state:'visible'});await page.locator('#confirm-send').click();
    await until(()=>!!committed,'Server committed the handoff before losing its HTTP ACK');await page.locator('#retry-send').waitFor({state:'visible'});
    assert.equal(bodies.length,1);assert.equal(bodies[0].handoff_version,2);assert.equal(bodies[0].order_id,null);assert.equal(bodies[0].report_id,Number(audit.id));assert.equal(bodies[0].report_src,'a');assert.match(bodies[0].submit_id,/^[a-f\d-]{36}$/);assert.ok(bodies[0].packet_signature);
    const rows=(await service.pool.query('SELECT * FROM cases')).rows;assert.equal(rows.length,1);const assigned=rows[0];assert.equal(Number(assigned.id),committed.id);assert.equal(assigned.order_id,null);assert.equal(assigned.data._handoff.completed,true);assert.equal(assigned.data._handoff.groupNotice.status,'confirmed');assert.equal(assigned.audit_text,text);
    const afterCommit=service.messages.length;
    await page.reload();await page.locator('#retry-send').waitFor({state:'visible'});await page.locator('#retry-send').click();await page.locator('#delivery-title').getByText(/^Передано/).waitFor();
    assert.equal(bodies.length,2);assert.deepEqual(bodies[1],bodies[0],'The reopened producer retries its exact saved V2 body');assert.equal(service.messages.length,afterCommit);
    await page.reload();await page.locator('#delivery-title').getByText(/^Передано/).waitFor();assert.equal(service.messages.length,afterCommit);assert.equal((await service.pool.query('SELECT id FROM cases')).rows.length,1);
    const sent=service.messages.slice(before),cards=sent.filter(event=>event.method==='sendMessage'&&String(event.args[0])===String(LAWYER));
    assert.equal(cards.length,1);assert.equal(sent.filter(event=>event.method==='copyMessages').length,1);
    const notices=sent.filter(event=>event.method==='sendMessage'&&String(event.args[0])===clientsGroup);assert.equal(notices.length,1);assert.match(notices[0].args[1],/^Клиент передан юристу/);assert.match(notices[0].args[1],/Без заявки/);
    for(const event of sent){const target=event.method.startsWith('copy')?event.args[0].chat_id:event.args[0];assert.ok([String(LAWYER),clientsGroup].includes(String(target)));if(String(target)===clientsGroup)assert.equal(event,notices[0]);}
    const delivered=[...service.originals.values()].filter(item=>item.chat===String(LAWYER));
    for(const id of sourceIds)assert.equal(delivered.filter(item=>item.copied_from?.chat===GROUP&&item.copied_from.id===id).length,1,'Each actual source message is copied once');
    for(const file of originals)assert.ok(delivered.some(item=>item.copied_from&&item.bytes?.equals(file.content)),'The selected lawyer receives the byte-exact original '+file.name);
    const reportButton=cards[0].args[2].reply_markup.inline_keyboard.flat().find(button=>button.web_app?.url.includes('view=report'));assert.ok(reportButton);
    assert.deepEqual(cards[0].args[2].reply_markup.inline_keyboard[0].map(button=>button.text),['📋 Чек-лист клиента','Перейти к отчёту']);
    const reportUrl=new URL(reportButton.web_app.url);assert.equal(reportUrl.searchParams.get('case_id'),String(assigned.id));assert.equal(reportUrl.searchParams.has('order_id'),false);assert.equal(reportUrl.searchParams.has('u'),false);assert.equal(reportUrl.searchParams.has('k'),false);
    const lawyer=await openPage(browser,service,LAWYER,{pathname:reportUrl.pathname+reportUrl.search,mobile:false});visits.push(lawyer);const view=lawyer.page;
    await view.locator('#report-dialog').waitFor({state:'visible'});assert.equal(await view.locator('#report-text').innerText(),text);assert.equal(await view.locator('#report-originals [data-download]').count(),originals.length);assert.equal(await view.locator('#footer').isVisible(),false);
    for(const file of originals){
      const pending=view.waitForEvent('download');await view.locator('#report-originals [data-download]').filter({hasText:file.name}).click();const download=await pending;
      assert.equal(download.suggestedFilename(),file.name);const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const bytes=Buffer.concat(chunks);assert.ok(bytes.equals(file.content));assert.equal(hash(bytes),hash(file.content));
    }
    await service.pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES(3002,'Synthetic other lawyer','lawyer',true)");
    const foreignCase=(await service.pool.query('INSERT INTO cases(order_id,lawyer_tg_id,lawyer_name,org,created_by,data) VALUES(NULL,3002,$1,$2,2001,$3) RETURNING id',['Synthetic other lawyer','Synthetic foreign client',JSON.stringify(assigned.data)])).rows[0];
    const checks=[
      '/api/handoff/prefill?case_id='+foreignCase.id,
      '/api/handoff/packet?case_id='+foreignCase.id+'&report_src=a&report_id='+audit.id,
      '/api/handoff/packet?case_id='+assigned.id+'&report_src=a&report_id='+foreignAudit.id,
      '/api/handoff/reports/'+audit.id+'/files/'+originals[0].id+'?case_id='+foreignCase.id,
      '/api/handoff/reports/'+audit.id+'/files/'+originals[0].id,
    ];
    for(const url of checks)assert.equal(await view.evaluate(async path=>(await fetch(path)).status,url),403,url);
    assert.equal(service.messages.length,afterCommit,'Read-only lawyer viewing and forbidden requests never resend the package or summary');assert.equal(service.egrnRequests.length,0);
    for(const visit of visits){assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);}
  }finally{await browser?.close();await service?.close();}
});
