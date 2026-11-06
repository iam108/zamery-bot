'use strict';
const { before, after, test }=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const yauzl=require('yauzl');
const {createService,openPage,sampleImage,multiPagePdf,until,hash}=require('./helpers');
let service,browser;
before(async()=>{service=await createService();await service.pool.query("UPDATE orders SET object_type='Другое',service='',has_video=true WHERE id IN(58,59)");browser=await chromium.launch();});
after(async()=>{await browser?.close();await service?.close();});
const step=(page,index)=>page.locator('#steps [data-step="'+index+'"]').click();
const field=(page,path)=>page.locator('[data-bind="'+path+'"]');
const clean=visit=>{assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);};
async function unzip(buffer){
  const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value))),files=[];
  return new Promise((resolve,reject)=>{zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{if(error)return reject(error);try{const parts=[];for await(const part of stream)parts.push(part);files.push({name:entry.fileName,buffer:Buffer.concat(parts)});zip.readEntry();}catch(failure){reject(failure);}}));zip.readEntry();});
}

test('Other keeps legacy facts and exact originals across fresh reopening and submits only after explicit retry of an unknown photo', {timeout:60000}, async()=>{
  let visit=await openPage(browser,service,1001,{pathname:'/audit/legacy?order_id=58'}),{page}=visit;
  const telegram=require('../../src/bot/instance').telegram,sendPhoto=telegram.sendPhoto;let lose=true,modern=0;
  try{
    page.on('request',request=>{if(new URL(request.url()).pathname==='/audit')modern++;});
    await page.getByRole('heading',{name:'Общий осмотр',exact:true}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/audit');assert.equal(modern,0,'The finished initial redirect must not start another loop');
    const png=await sampleImage(page,'image/png'),pdf=multiPagePdf(),note='Synthetic nearby repair observation';
    await page.locator('input[data-upload-role=photo]:not([capture])').setInputFiles([{name:'Synthetic-other-photo.png',mimeType:'image/png',buffer:png},{name:'Synthetic-other-source.pdf',mimeType:'application/pdf',buffer:pdf}]);
    await page.getByText('Synthetic-other-source.pdf',{exact:true}).waitFor();await field(page,'nearby').fill(note);
    await page.locator('[data-add-zone]').click();await field(page,'zones.0.name').fill('Synthetic adjacent premises');await field(page,'zones.0.dist').fill('около 30 м');await field(page,'zones.0.info').fill('Ремонт');
    await step(page,1);await field(page,'building_type').selectOption('Нежилое');await field(page,'boundaries').selectOption('Под вопросом');await field(page,'bti').selectOption('Не проверено');await field(page,'to').selectOption('Не обязательно');
    for(const key of ['veranda','patz','replan','passport_interest','is_owner','chk_storage'])await field(page,key).check();
    await step(page,2);const conclusion='Synthetic general inspection: request the missing room documents.';
    await field(page,'conclusion').fill(conclusion);await field(page,'workflow.followup_notes').fill('Владелец пришлёт документы');await field(page,'workflow.video_url').fill('https://disk.yandex.ru/d/synthetic-other-video');await field(page,'inspection.visit_date').fill('2026-11-06');
    assert.equal(await field(page,'workflow.conclusion_status').count(),0);await page.locator('#save-now').click();
    await until(async()=>(await service.draft(58)).data.conclusion===conclusion,'Generic draft persisted');
    const original=await service.draft(58);assert.equal(original.data.object_category,'other');assert.equal(original.data.inspection.service,'');assert.equal(original.data.entrances.length,0);assert.equal(original.data.plan.evidence_id,'');
    clean(visit);await visit.context.close();visit=await openPage(browser,service,1001,{pathname:'/audit?order_id=58'});page=visit.page;
    await field(page,'conclusion').waitFor();assert.equal(await field(page,'conclusion').inputValue(),conclusion);assert.equal(await field(page,'workflow.video_url').inputValue(),'https://disk.yandex.ru/d/synthetic-other-video');
    await step(page,1);assert.equal(await field(page,'to').inputValue(),'Не обязательно');assert.equal(await field(page,'is_owner').isChecked(),true);assert.equal(await field(page,'chk_storage').isChecked(),true);
    await step(page,0);await page.getByText('Synthetic-other-photo.png',{exact:true}).waitFor();assert.equal(await field(page,'nearby').inputValue(),note);assert.equal(await field(page,'zones.0.name').inputValue(),'Synthetic adjacent premises');
    const stored=(await service.pool.query('SELECT * FROM audit_evidence WHERE draft_id=$1',[original.id])).rows;assert.equal(stored.length,2);
    for(const[bytes,name]of [[png,'Synthetic-other-photo.png'],[pdf,'Synthetic-other-source.pdf']]){const file=stored.find(file=>file.name===name);assert.equal(file.sha256,hash(bytes));assert.ok(service.objects.get(file.object_key).equals(bytes));}
    telegram.sendPhoto=async(...args)=>{assert.equal((await service.draft(58)).delivery.inflight.stage,'photos');const receipt=await sendPhoto(...args);if(lose){lose=false;throw new Error('Synthetic generic photo ACK lost after acceptance');}return receipt;};
    await step(page,2);const start=service.messages.length;await page.locator('#submit-audit').click();await page.locator('#retry-unknown-delivery').waitFor({state:'visible'});
    assert.equal((await service.pool.query('SELECT id FROM audits WHERE order_id=58')).rows.length,0);const cursor=(await service.draft(58)).delivery.inflight.id;
    await page.reload();await page.locator('#retry-unknown-delivery').waitFor({state:'visible'});assert.equal(await field(page,'conclusion').isDisabled(),true);assert.equal((await service.draft(58)).delivery.inflight.id,cursor);
    page.once('dialog',dialog=>dialog.accept());await page.locator('#retry-unknown-delivery').click();await page.getByRole('heading',{name:'Отчёт отправлен',exact:true}).waitFor();
    const events=service.messages.slice(start);assert.equal(events.filter(event=>event.method==='sendMessage').length,1);assert.equal(events.filter(event=>event.method==='sendPhoto').length,2);assert.equal(events.filter(event=>event.method==='sendDocument').length,1);
    const audit=(await service.pool.query('SELECT * FROM audits WHERE order_id=58')).rows;assert.equal(audit.length,1);assert.equal(audit[0].report_data.object_category,'other');assert.equal(audit[0].report_data.conclusion,conclusion);assert.equal(audit[0].report_data.is_owner,true);assert.equal(audit[0].report_data.inspection.service,'');assert.match(audit[0].text,/Общий осмотр · Другое/);assert.doesNotMatch(audit[0].text,/Алкоголь|соответствует по проверенным/i);
    const zip=events.find(event=>event.method==='sendDocument').args[1].source,entries=await unzip(zip);for(const bytes of [png,pdf])assert.equal(entries.filter(entry=>entry.buffer.equals(bytes)).length,1);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS count FROM audit_evidence WHERE draft_id=$1',[original.id])).rows[0].count,2);clean(visit);
  }finally{telegram.sendPhoto=sendPhoto;await visit.context.close();}
});

test('a generic draft cannot bypass a changed manager category and requests review without a redirect loop', {timeout:30000},async()=>{
  const visit=await openPage(browser,service,1001,{pathname:'/audit?order_id=59'}),{page}=visit;
  try{
    await page.getByRole('heading',{name:'Общий осмотр',exact:true}).waitFor();await step(page,2);await field(page,'conclusion').fill('Synthetic original general observation');await field(page,'workflow.video_url').fill('https://disk.yandex.ru/d/synthetic-reviewed-video');await page.locator('#save-now').click();
    await until(async()=>(await service.draft(59)).data.conclusion==='Synthetic original general observation','Original generic facts saved');
    const draft=await service.draft(59),messages=service.messages.length;
    await service.pool.query("UPDATE orders SET object_type='Общепит алкоголь',service='Получение' WHERE id=59");
    const auth=new URLSearchParams(service.keyQuery(1001)),response=await fetch(service.origin+'/api/audit',{method:'POST',headers:{'Content-Type':'application/json','X-Tg-U':auth.get('u'),'X-Tg-K':auth.get('k')},body:JSON.stringify({draft_id:draft.id,revision:draft.revision})});
    assert.equal(response.status,409);assert.equal((await response.json()).code,'AUDIT_PACKET_CHANGED');assert.equal(service.messages.length,messages);
    assert.equal((await service.draft(59)).submitting_revision,null);await page.reload();await page.getByText('Менеджер изменил данные объекта',{exact:true}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/audit');assert.equal(await field(page,'conclusion').inputValue(),'Synthetic original general observation');assert.equal((await service.draft(59)).data.object_category,'other');clean(visit);
  }finally{await visit.context.close();}
});
