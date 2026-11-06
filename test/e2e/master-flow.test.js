'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { chromium } = require('playwright');
const yauzl = require('yauzl');
const { createService, openPage, multiPagePdf, sampleImage, until, hash, LAWYER, GROUP } = require('./helpers');

const field = (page, name) => page.locator('[data-bind="' + name + '"]');
const choice = (page, name, value) => page.locator('[data-choice="' + name + '"][data-value="' + value + '"]');
const step = (page, index) => page.locator('#steps [data-step="' + index + '"]').click();
async function unzip(buffer) {
  const zip = await new Promise((resolve,reject) => yauzl.fromBuffer(buffer,{lazyEntries:true},(error,result)=>error?reject(error):resolve(result)));
  const files = [];
  return new Promise((resolve,reject) => {
    zip.on('error',reject); zip.on('end',()=>resolve(files));
    zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{
      if(error)return reject(error);
      try { const chunks=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));files.push({name:entry.fileName,bytes:Buffer.concat(chunks)});zip.readEntry(); } catch(failure){reject(failure);}
    }));zip.readEntry();
  });
}

test('master: new manager originals become an annotated audit, complete private lawyer handoff and writable workspace case', {timeout:120000}, async t => {
  let browser, service; const visits=[];
  try {
    service=await createService({master:true});browser=await chromium.launch();
    const manager=await openPage(browser,service,2001,{pathname:'/form',mobile:false});visits.push(manager);
    const p=manager.page,plan=multiPagePdf(),lease=Buffer.concat([multiPagePdf(),Buffer.from('\n% Distinct synthetic lease original\n')]);
    await p.locator('#address').fill('Москва, Сквозная улица, 7');await p.locator('#owner_name').fill('ООО «Сквозная проверка»');
    await p.locator('#object_type').selectOption('Общепит алкоголь');await p.locator('#object_name').fill('Сквозное кафе');await p.locator('#service').selectOption('Получение');
    await p.locator('#contacts').fill('Карина +79991234567');
    await p.locator('#attachments').setInputFiles([{name:'План сквозной проверки.pdf',mimeType:'application/pdf',buffer:plan},{name:'Договор сквозной проверки.pdf',mimeType:'application/pdf',buffer:lease}]);
    const saved=p.waitForResponse(r=>r.url().endsWith('/api/order')&&r.request().method()==='POST');await p.locator('#submit-btn').click();
    const response=await saved,created=await response.json();assert.equal(response.status(),200);assert.equal(created.ok,true);const orderId=created.id;assert.ok(orderId>0);
    await p.locator('#submit-btn').getByText('✅ Заявка отправлена!',{exact:true}).waitFor();
    const material=(await service.pool.query('SELECT * FROM order_materials WHERE order_id=$1 ORDER BY name',[orderId])).rows;
    assert.equal(material.length,2);for(const bytes of [plan,lease])assert.ok(material.some(f=>f.sha256===hash(bytes)&&Buffer.from(f.content).equals(bytes)));
    t.diagnostic('Created a new order through the real manager form, with two byte-exact PDF originals.');
    const originalCard=service.messages.find(event=>event.method==='sendMessage'&&event.args[2]?.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data==='status:in_progress:'+orderId));
    assert.ok(originalCard);assert.equal(originalCard.args[2].reply_markup.inline_keyboard.flat().some(button=>button.text==='Перейти к отчёту'),false);

    const auditor=await openPage(browser,service,1001,{pathname:'/audit?order_id='+orderId});visits.push(auditor);const a=auditor.page;
    await a.locator('#step-content[aria-busy=false]').waitFor();await choice(a,'building_type','Нежилое').click();await choice(a,'workflow.territory_result','clear').click();
    await a.locator('[data-add-entrance]').click();await field(a,'entrances.0.label').fill('Главный вход с улицы');
    const entrance=await sampleImage(a,'image/jpeg');await a.locator('input[data-upload-role="entrance"]:not([capture])').first().setInputFiles({name:'Вход сквозной проверки.jpg',mimeType:'application/octet-stream',buffer:entrance});
    await a.getByText('Вход сквозной проверки.jpg',{exact:true}).waitFor();await step(a,1);
    await a.getByText('Выбрать документ из заявки',{exact:true}).click();const planId=material.find(f=>f.sha256===hash(plan)).id;await a.locator('[data-use-plan="'+planId+'"]').click();
    const editor=a.locator('#plan-editor');await editor.locator('.ape-source').getByText(/лист 1/).waitFor();
    await editor.getByRole('button',{name:'Выбрать лист PDF / изображение',exact:true}).click();const dialog=editor.locator('dialog'),use=dialog.getByRole('button',{name:'Использовать этот лист',exact:true});
    await until(()=>use.isEnabled(),'Manager PDF preview');for(let i=1;i<4;i++){await dialog.getByRole('button',{name:'Следующая страница'}).click();await until(()=>use.isEnabled(),'Manager PDF page selection');}await use.click();await dialog.waitFor({state:'hidden'});
    const canvas=editor.getByLabel('План помещения для разметки');await until(async()=>{const pixel=await canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(10,10,1,1).data));return pixel[1]>100&&pixel[0]<20;},'Manager fourth green PDF page');
    await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();assert.ok(box?.width>100);for(const [x,y]of [[.15,.18],[.77,.18],[.77,.78],[.15,.78]])await a.touchscreen.tap(box.x+x*box.width,box.y+y*box.height);
    await editor.getByRole('button',{name:'Замкнуть контур'}).click();await editor.getByRole('button',{name:'Сохранить разметку'}).click();
    await field(a,'inspection.floor_plan').fill('1');await field(a,'inspection.floor_actual').fill('1');await field(a,'inspection.cadastral_count').fill('1');
    for(const [name,value]of [['inspection.within_cadastral','Да'],['inspection.rooms_complete','Да'],['to','Нужно'],['bti','Нет'],['inspection.alcohol_present','Да'],['inspection.kkt_count','1'],['inspection.kkt_ip','Нет']])await choice(a,name,value).click();
    await field(a,'inspection.plan_note').fill('Убрана внутренняя перегородка; требуется ТО.');
    await a.locator('input[data-upload-role="interior"]:not([capture])').setInputFiles({name:'Алкоголь на объекте.jpg',mimeType:'application/octet-stream',buffer:await sampleImage(a,'image/jpeg')});await a.getByText('Алкоголь на объекте.jpg',{exact:true}).waitFor();
    await step(a,2);await field(a,'workflow.conclusion_status').selectOption('actions');await field(a,'conclusion').fill('Для получения лицензии убрать алкоголь и подготовить ТО.');
    await a.locator('#save-now').click();await until(async()=>{const row=await service.draft(orderId);return row?.data.to==='Нужно'&&row.data.plan.page===4&&row.data.plan.annotations.length>0;},'Truthful observations saved');
    await a.locator('#submit-audit').click();await a.getByRole('heading',{name:'Отчёт отправлен'}).waitFor();
    const audit=(await service.pool.query('SELECT * FROM audits WHERE order_id=$1',[orderId])).rows[0];assert.ok(audit);assert.equal(audit.report_data.to,'Нужно');assert.equal(audit.report_data.inspection.alcohol_present,'Да');assert.equal(audit.report_data.workflow.conclusion_status,'actions');assert.equal(audit.report_data.plan.manager_material_id,planId);assert.equal(audit.report_data.plan.page,4);assert.ok(audit.report_data.plan.annotations.length);assert.match(audit.text,/ТО требуется/);assert.match(audit.text,/Алкоголь на объекте есть/);
    const requestCard=(await service.pool.query('SELECT telegram_msg_id FROM orders WHERE id=$1',[orderId])).rows[0];
    const linkEdit=service.messages.filter(event=>event.method==='editMessageReplyMarkup'&&String(event.args[1])===String(requestCard.telegram_msg_id)).at(-1);
    assert.ok(linkEdit,'The original request must receive the report button after delivery');
    const reportButton=linkEdit.args[3].inline_keyboard.flat().find(button=>button.text==='Перейти к отчёту');
    assert.equal(reportButton?.url,'https://t.me/c/'+String(audit.chat_id).slice(4)+'/'+audit.msg_ids[0]);
    t.diagnostic('Auditor used the manager PDF fourth page, added photos/geometry and sent actual TO/alcohol findings.');

    const handoff=await openPage(browser,service,2001,{pathname:'/handoff?order_id='+orderId,mobile:false});visits.push(handoff);const h=handoff.page;
    await until(()=>h.locator('#lawyers option[value="'+LAWYER+'"]').count().then(n=>n===1),'Lawyer and actual reviewed packet loaded');await h.locator('#lawyers').selectOption(String(LAWYER));
    assert.equal(await h.locator('#egrn-order').isChecked(),false);await h.locator('#comment').fill('Согласовать подготовку ТО и убрать алкоголь.');
    await h.locator('#open-report').click();await h.locator('#report-dialog').waitFor({state:'visible'});await h.getByText('Убрана внутренняя перегородка; требуется ТО.',{exact:false}).first().waitFor();await h.locator('#report-close').click();
    const before=service.messages.length;await h.locator('#go').click();await h.locator('#review').waitFor({state:'visible'});assert.match(await h.locator('#review-list').innerText(),/Отчёт аудитора/);
    const delivered=h.waitForResponse(r=>r.url().includes('/api/handoff')&&r.request().method()==='POST');await h.locator('#confirm-send').click();const handoffResponse=await delivered,result=await handoffResponse.json();assert.equal(handoffResponse.status(),200);assert.equal(result.delivery_complete,true);await h.locator('#delivery-title').getByText(/передан/i).waitFor();
    const cases=(await service.pool.query('SELECT * FROM cases WHERE order_id=$1',[orderId])).rows;assert.equal(cases.length,1);const assigned=cases[0];assert.equal(Number(assigned.lawyer_tg_id),LAWYER);assert.equal(Number(assigned.id),result.id);assert.equal(assigned.data._handoff.completed,true);
    const sent=service.messages.slice(before);assert.ok(sent.length>2);for(const event of sent){const target=event.method.startsWith('copy')?event.args[0].chat_id:event.args[0];assert.equal(String(target),String(LAWYER));}
    const privateOriginals=[...service.originals.values()].filter(item=>item.chat===String(LAWYER));
    const archives=privateOriginals.filter(item=>item.kind==='sendDocument'&&/\.zip$/i.test(item.filename||''));assert.equal(archives.length,2);
    const auditArchive=archives.find(item=>item.copied_from),managerArchive=archives.find(item=>!item.copied_from);assert.ok(auditArchive);assert.ok(managerArchive);
    const auditEntries=await unzip(auditArchive.bytes),managerEntries=await unzip(managerArchive.bytes);
    assert.ok(auditEntries.some(item=>hash(item.bytes)===hash(plan)&&item.bytes.equals(plan)),'Copied audit ZIP must physically deliver the byte-exact manager plan');
    const deliveredHashes=new Set(auditEntries.map(item=>hash(item.bytes)));
    for(const original of audit.report_data.documents)assert.ok(deliveredHashes.has(original.sha256),'Audit original or annotated graphic missing from the private ZIP: '+original.name);
    assert.ok(auditEntries.some(item=>item.name.includes('Вход сквозной проверки')));assert.ok(auditEntries.some(item=>item.name.includes('Алкоголь на объекте')));
    assert.ok(managerEntries.some(item=>hash(item.bytes)===hash(lease)&&item.bytes.equals(lease)),'Private manager ZIP must contain the exact original lease PDF');
    assert.equal(managerEntries.some(item=>hash(item.bytes)===hash(plan)),false,'Manager ZIP must not duplicate the plan already copied inside the audit archive');
    const count=service.messages.length;await h.reload();await until(()=>h.locator('#delivery').isVisible(),'Completed handoff reopened');assert.equal(service.messages.length,count);assert.equal((await service.pool.query('SELECT id FROM cases WHERE order_id=$1',[orderId])).rows.length,1);
    t.diagnostic('The real handoff UI delivered the complete package only to the selected lawyer; reopening sent no duplicates.');

    const token=randomBytes(32).toString('base64url'),digest=createHash('sha256').update(token).digest('base64url');
    const workspace=require('../../src/web/workspace');await service.pool.query(workspace.SESSION_DDL);assert.equal(await workspace.approvePairing(service.pool,LAWYER,'mac_'+digest+'_'+(Math.floor(Date.now()/1000)+300).toString(36)),true);
    const api=async(method,url,data)=>h.request.fetch(service.origin+'/api/workspace/'+url,{method,headers:{Authorization:'Bearer '+token},...(data?{data}:{})});
    const snapshot=await api('GET','snapshot');assert.equal(snapshot.status(),200);const client=(await snapshot.json()).clients.find(row=>row.id===String(assigned.id));assert.ok(client);assert.equal(client.address,'Москва, Сквозная улица, 7');assert.equal(client.report,audit.text);assert.ok(client.total>0);assert.ok(client.checklistSections.length>0);
    const note='Юрист принял комплект: подготовить ТО и убрать алкоголь.';assert.equal((await api('PATCH','cases/'+assigned.id+'/note',{note,expectedNote:client.note})).status(),200);assert.equal((await (await api('GET','snapshot')).json()).clients.find(row=>row.id===client.id).note,note);
    assert.equal((await api('POST','logout')).status(),200);assert.equal((await api('GET','snapshot')).status(),401);
    for(const visit of visits){assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);}assert.equal(service.egrnRequests.length,0,'No provider lookup or paid EGRN request is allowed in this journey');assert.ok(service.messages.filter(e=>!e.method.startsWith('copy')).every(e=>[GROUP,String(LAWYER)].includes(String(e.args[0]))));
    t.diagnostic('Workspace actual HTTP snapshot contained the same assigned case and report; note save/read and logout passed.');
  } catch(error) {
    const directory=path.resolve(process.env.E2E_ARTIFACTS_DIR||'test-results/e2e');await fs.mkdir(directory,{recursive:true});let index=0;
    for(const visit of visits)await visit.page.screenshot({path:path.join(directory,'master-flow-'+(++index)+'.png'),fullPage:true}).catch(()=>{});
    throw error;
  } finally { await browser?.close();await service?.close(); }
});
