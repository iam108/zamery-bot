'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');
const {createService,openPage,multiPagePdf,hash,GROUP}=require('./helpers');

test('handoff original download times out, retries exact bytes and closing the report prevents a late download', {timeout:60000},async()=>{
 let service,browser,visit,release;
 try{
  service=await createService({master:true});browser=await chromium.launch();const id=randomUUID(),draft=randomUUID(),pdf=multiPagePdf();
  const file={id,name:'Synthetic-handoff-original.pdf',mime:'application/pdf',role:'plan-source',subject_id:'source',bytes:pdf.length,sha256:hash(pdf)};
  await service.pool.query('INSERT INTO audit_drafts(id,author_tg_id,order_id,data,submitted_at) VALUES($1,1001,58,$2,NOW())',[draft,'{}']);
  await service.pool.query('INSERT INTO audit_evidence(draft_id,id,name,mime,role,subject_id,bytes,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[draft,id,file.name,file.mime,file.role,file.subject_id,file.bytes,file.sha256,pdf]);
  const audit=(await service.pool.query('INSERT INTO audits(order_id,text,chat_id,msg_ids,report_data,draft_id) VALUES(58,$1,$2,$3,$4,$5) RETURNING id',['Synthetic complete report',GROUP,[1000],JSON.stringify({documents:[file]}),draft])).rows[0];
  visit=await openPage(browser,service,2001,{pathname:'/handoff?order_id=58&view=report'});const page=visit.page;await page.locator('#report-dialog').waitFor({state:'visible'});await page.clock.install();
  const pattern='**/api/handoff/reports/'+audit.id+'/files/'+id+'?download=1';let entered,finished;
  const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;}),completed=new Promise(resolve=>{finished=resolve;});
  const handler=async route=>{entered();await held;try{await route.continue();}catch(_){}finally{finished();}};
  await page.route(pattern,handler);const button=page.locator('#report-originals [data-download="0"]');await button.click();await started;assert.equal(await button.isDisabled(),true);
  await page.clock.fastForward('05:00');assert.equal(await button.isDisabled(),false);assert.match(await page.locator('#report-notice').innerText(),/вовремя/);
  release();await completed;await page.unroute(pattern,handler);release=null;await page.clock.resume();let downloads=0;page.on('download',()=>downloads++);
  const pending=page.waitForEvent('download');await button.click();const download=await pending;assert.equal(download.suggestedFilename(),file.name);const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const bytes=Buffer.concat(chunks);assert.ok(bytes.equals(pdf));assert.equal(hash(bytes),file.sha256);assert.equal(downloads,1);
  for(const [contentType,body] of [['text/html; charset=utf-8','<!doctype html><html><body>Checking your browser</body></html>'],['application/json','{"error":"Synthetic service response"}']]){
   const serviceResponse=route=>route.fulfill({status:200,contentType,body});await page.route(pattern,serviceResponse);await button.click();
   const warned=await page.waitForFunction(()=>!document.querySelector('#report-originals [data-download="0"]').disabled&&document.getElementById('report-notice').textContent.includes('служебный ответ'),{},{timeout:1000}).then(()=>true,()=>false);
   assert.equal(downloads,1,'An HTTP 200 '+contentType+' service response must not be downloaded under the original PDF name');assert.equal(warned,true);assert.equal(await button.isDisabled(),false);await page.unroute(pattern,serviceResponse);
  }
  let enterOld,finishOld;const oldStarted=new Promise(resolve=>{enterOld=resolve;}),oldHold=new Promise(resolve=>{release=resolve;}),oldComplete=new Promise(resolve=>{finishOld=resolve;});
  const oldHandler=async route=>{enterOld();await oldHold;try{await route.continue();}catch(_){}finally{finishOld();}};
  await page.route(pattern,oldHandler);await button.click();await oldStarted;await page.locator('#report-close').click();await page.locator('#report-dialog').waitFor({state:'hidden'});await page.locator('#open-report').click();assert.equal(await button.isDisabled(),false);
  release();await oldComplete;await page.unroute(pattern,oldHandler);release=null;await page.evaluate(()=>Promise.resolve());assert.equal(downloads,1,'Closing the old report must not cause an unsolicited late download');assert.equal(await page.locator('#report-notice').innerText(),'');
  assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);
 }finally{release?.();await browser?.close();await service?.close();}
});
