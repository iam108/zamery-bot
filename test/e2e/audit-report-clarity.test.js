'use strict';
const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');
const yauzl=require('yauzl');
const {createService,openPage,multiPagePdf,sampleImage,until,hash}=require('./helpers');
const {compactVisit}=require('../helpers/audit-v5');
let service,browser;
before(async()=>{service=await createService({master:true});browser=await chromium.launch();});
after(async()=>{await browser?.close();await service?.close();});
const field=(page,key)=>page.locator('[data-bind="'+key+'"]');
const choice=(page,key,value)=>page.locator('[data-choice="'+key+'"][data-value="'+value+'"]');
const step=(page,index)=>page.locator('#steps [data-step="'+index+'"]').click();
const issue=(page,id)=>page.locator('#report-feedback .task[data-report-issue="'+id+'"]');
const clean=visit=>{assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);};
async function seed(order,category='catering',serviceName='Получение',change=()=>{}){
 await service.pool.query('UPDATE orders SET object_type=$1,service=$2 WHERE id=$3',[category==='tobacco'?'Табак':category==='other'?'Другое':'Общепит алкоголь',category==='other'?'':serviceName,order]);
 const pdf=multiPagePdf();
 if(serviceName==='Продление')await service.pool.query("INSERT INTO order_materials(order_id,id,name,mime,role,bytes,sha256,content) VALUES($1,$2,'Synthetic archive.pdf','application/pdf','archive',$3,$4,$5)",[order,randomUUID(),pdf.length,hash(pdf),pdf]);
 const initial=await openPage(browser,service,1001,{pathname:'/audit?order_id='+order});await initial.page.locator('#step-content[aria-busy=false]').waitFor();
 const image=await sampleImage(initial.page,'image/png'),jpeg=await sampleImage(initial.page,'image/jpeg'),draft=await service.draft(order);clean(initial);await initial.context.close();
 const data=compactVisit(category,serviceName);data.order_id=order;data.request_packet=draft.data.request_packet;
 Object.assign(data.inspection,{org:draft.data.inspection.org,address:draft.data.inspection.address,service:category==='other'?'':serviceName});
 data.workflow.step=2;data.workflow.territory_result='clear';data.map={evidence_id:'',page:1,annotations:[],versions:[]};data.zones=[];
 data.evidence=data.evidence.filter(file=>!['map','map-source'].includes(file.role));
 const originals=data.evidence.map(file=>({...file,content:file.mime==='application/pdf'?pdf:file.mime==='image/jpeg'?jpeg:image}));
 data.evidence=originals.map(({content,...file})=>({...file,bytes:content.length,sha256:hash(content)}));
 data.plan.preview_evidence_id=data.evidence.find(file=>file.role==='plan').id;
 change(data);
 const wanted=new Set(data.evidence.map(file=>file.id));
 for(const file of originals.filter(file=>wanted.has(file.id)))await service.pool.query('INSERT INTO audit_evidence(draft_id,id,name,mime,role,subject_id,bytes,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[draft.id,file.id,file.name,file.mime,file.role,file.subject_id,file.content.length,hash(file.content),file.content]);
 await service.pool.query('UPDATE audit_drafts SET data=$1,revision=revision+1 WHERE id=$2',[JSON.stringify(data),draft.id]);
 const visit=await openPage(browser,service,1001,{pathname:'/audit?order_id='+order});await visit.page.locator('#step-content[aria-busy=false]').waitFor();await step(visit.page,2);return{...visit,draftId:draft.id,originals:originals.filter(file=>wanted.has(file.id))};
}
async function save(page,order){await page.locator('#save-now').click();await until(()=>page.evaluate(()=>/Черновик сохранён на сервере/.test(document.querySelector('#toast').textContent)),'Server draft acknowledgement');return service.draft(order);}
async function answerFocus(page,id,key,value){await issue(page,id).getByRole('button').click();await until(()=>page.evaluate(([k,v])=>document.activeElement?.dataset.choice===k&&document.activeElement?.dataset.value===v,[key,value]),'Exact selected answer receives focus');assert.ok(await page.locator('[data-report-target]').count());assert.equal(await choice(page,key,value).getAttribute('aria-pressed'),'true');}
async function screenshot(page,name,width){await page.setViewportSize({width,height:900});await page.evaluate(()=>window.scrollTo(0,0));const overflow=await page.evaluate(()=>({view:innerWidth,body:document.documentElement.scrollWidth}));assert.ok(overflow.body<=overflow.view+1,JSON.stringify(overflow));const directory=path.resolve(process.env.E2E_ARTIFACTS_DIR||'test-results/e2e');await fs.mkdir(directory,{recursive:true});await page.screenshot({path:path.join(directory,name+'.png'),fullPage:true});}
async function archiveEntries(buffer){const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value)));return new Promise((resolve,reject)=>{const files=[];zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{if(error)return reject(error);try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);files.push(Buffer.concat(chunks));zip.readEntry();}catch(e){reject(e);}}));zip.readEntry();});}

test('ready contradictions point to the actual answers, preserve facts on outcome choice, and deliver a brief with full originals', {timeout:90000},async()=>{
 const comment='Полный комментарий аудитора. '+('Сохранённый факт без автоматического исправления. '.repeat(90))+'Последняя строка полного комментария.';
 const visit=await seed(58,'catering','Получение',data=>{Object.assign(data.inspection,{rooms_complete:'Нет',within_cadastral:'Нет',alcohol_present:'Да'});data.conclusion=comment;}),{page}=visit;
 try{
  for(const id of ['rooms-incomplete','cadastral-boundaries','alcohol-new'])await issue(page,id).waitFor();
  assert.match(await page.locator('#report-feedback').innerText(),/расходится с ответами/);
  await screenshot(page,'audit-report-clarity-mobile-ready',390);await screenshot(page,'audit-report-clarity-desktop-ready',1280);
  const snapshot=await service.draft(58),blocked=await page.evaluate(async({id,revision})=>{const response=await fetch('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft_id:id,revision})});return{status:response.status,body:await response.json()};},{id:snapshot.id,revision:snapshot.revision});
  assert.equal(blocked.status,400);assert.equal(blocked.body.code,'AUDIT_CONCLUSION_CONFLICT');assert.equal(service.messages.length,0);assert.equal((await service.draft(58)).submitting_revision,null);
  for(const[id,key]of [['rooms-incomplete','inspection.rooms_complete'],['cadastral-boundaries','inspection.within_cadastral'],['alcohol-new','inspection.alcohol_present']]){await answerFocus(page,id,key,id==='alcohol-new'?'Да':'Нет');await step(page,2);}
  await issue(page,'rooms-incomplete').getByRole('button').click();await choice(page,'inspection.rooms_complete','Да').click();await step(page,2);assert.equal(await issue(page,'rooms-incomplete').count(),0);await answerFocus(page,'cadastral-boundaries','inspection.within_cadastral','Нет');await choice(page,'inspection.rooms_complete','Нет').click();await step(page,2);
  await page.locator('#report-feedback [data-conclusion-choice="actions"]').click();const saved=await save(page,58);
  assert.equal(saved.data.workflow.conclusion_status,'actions');for(const[key,value]of [['rooms_complete','Нет'],['within_cadastral','Нет'],['alcohol_present','Да']])assert.equal(saved.data.inspection[key],value);assert.equal(saved.data.conclusion,comment);
  await screenshot(page,'audit-report-clarity-mobile-actions',390);await screenshot(page,'audit-report-clarity-desktop-actions',1280);
  await page.reload();await page.locator('#step-content[aria-busy=false]').waitFor();await step(page,2);assert.equal(await field(page,'workflow.conclusion_status').inputValue(),'actions');assert.equal(await field(page,'conclusion').inputValue(),comment);
  let submittedBody;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/audit')submittedBody=request.postDataJSON();});await page.locator('#submit-audit').click();await page.getByRole('heading',{name:'Отчёт отправлен'}).waitFor();
  const rows=(await service.pool.query('SELECT * FROM audits WHERE order_id=58')).rows;assert.equal(rows.length,1);const audit=rows[0];assert.equal(audit.report_data.inspection.rooms_complete,'Нет');assert.equal(audit.report_data.inspection.within_cadastral,'Нет');assert.equal(audit.report_data.inspection.alcohol_present,'Да');assert.equal(audit.report_data.conclusion,comment);assert.ok(audit.text.includes(comment));
  const physical=service.messages.filter(event=>['sendMessage','sendPhoto','sendMediaGroup','sendDocument'].includes(event.method));assert.equal(physical[0].method,'sendMediaGroup');assert.equal(physical[0].args[1][0].type,'photo');const summary=physical.find(event=>event.method==='sendMessage');assert.ok(summary.args[1].length<3500);assert.ok(!summary.args[1].includes('Последняя строка полного комментария.'));
  const documents=physical.flatMap(event=>event.method==='sendDocument'?[{filename:event.args[1].filename,buffer:event.args[1].source}]:event.method==='sendMediaGroup'&&event.args[1][0].type==='document'?event.args[1].map(item=>({filename:item.media.filename,buffer:item.media.source})):[]);assert.equal(documents.length,2);assert.equal(documents[0].filename,'Отчёт-58-полный.txt');assert.ok(documents[0].buffer.toString('utf8').includes(comment));const zip=await archiveEntries(documents[1].buffer);for(const original of visit.originals.filter(file=>file.role!=='plan'))assert.ok(zip.some(buffer=>buffer.equals(original.content)),original.name+' stays byte-exact');
  assert.equal(Number(audit.msg_ids[0]),summary.item.message_id);const before=service.messages.length;const replay=await page.evaluate(async body=>(await fetch('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json(),submittedBody);assert.equal(replay.ok,true);assert.equal(service.messages.length,before);assert.equal(service.egrnRequests.length,0);clean(visit);
 }finally{await visit.context.close();}
});

test('renewal alcohol contradictions navigate to licensed placement while tobacco and Other keep their own rules', {timeout:90000},async()=>{
 const renewal=await seed(59,'retail','Продление',data=>{data.inspection.alcohol_present='Да';data.inspection.alcohol_within_licensed='Нет';});
 try{const page=renewal.page;await answerFocus(page,'alcohol-zone','inspection.alcohol_within_licensed','Нет');await choice(page,'inspection.alcohol_present','Нет').click();assert.equal(await choice(page,'inspection.alcohol_within_licensed','Нет').count(),0);await step(page,2);assert.equal(await issue(page,'alcohol-zone').count(),0);assert.equal(await issue(page,'alcohol-new').count(),0);await step(page,1);await choice(page,'inspection.alcohol_present','Да').click();await choice(page,'inspection.alcohol_within_licensed','Не проверено').click();await step(page,2);await issue(page,'alcohol-zone').waitFor();await page.locator('#report-feedback [data-conclusion-choice="insufficient"]').click();const saved=await save(page,59);assert.equal(saved.data.workflow.conclusion_status,'insufficient');assert.equal(saved.data.inspection.alcohol_present,'Да');assert.equal(saved.data.inspection.alcohol_within_licensed,'Не проверено');clean(renewal);}finally{await renewal.context.close();}
 for(const[order,category]of [[60,'tobacco'],[61,'other']]){const visit=await seed(order,category,'Получение',data=>{data.inspection.alcohol_present='Да';data.inspection.alcohol_within_licensed='Нет';if(category==='other')data.conclusion='Общий осмотр: факты сохранены без алкогольной проверки.';});try{assert.equal(await visit.page.locator('#report-feedback [data-report-issue^="alcohol-"]').count(),0);await step(visit.page,1);assert.equal(await choice(visit.page,'inspection.alcohol_present','Да').count(),0);if(category==='tobacco')assert.equal(await field(visit.page,'inspection.tobacco_display').inputValue(),'Закрытая');clean(visit);}finally{await visit.context.close();}}
 assert.equal(service.egrnRequests.length,0);
});

test('choosing actions never bypasses a missing entrance photo or marked plan', {timeout:60000},async()=>{
 const visit=await seed(62,'catering','Получение',data=>{data.workflow.conclusion_status='actions';data.evidence=data.evidence.filter(file=>file.role!=='entrance');data.plan.annotations=[];delete data.plan.preview_evidence_id;});
 try{const page=visit.page;assert.match(await page.locator('#report-feedback').innerText(),/Главный вход: добавьте фото/i);assert.match(await page.locator('#report-feedback').innerText(),/границ|разметк/i);assert.equal(await page.locator('#report-feedback [data-conclusion-choice]').count(),0);const before=service.messages.length;await page.locator('#submit-audit').click();assert.equal(service.messages.length,before);assert.equal((await service.pool.query('SELECT id FROM audits WHERE order_id=62')).rows.length,0);assert.equal((await service.draft(62)).submitting_revision,null);clean(visit);}finally{await visit.context.close();}
});

test('the auditor can review the exact conflicting answer when the gateway challenges the former rules script', { timeout: 60000 }, async () => {
  await service.pool.query(`INSERT INTO orders(id,address,owner_name,object_type,object_name,has_video,status,submitted_by,submitted_name,telegram_msg_id,service)
    SELECT 63,address,owner_name,object_type,object_name,has_video,status,submitted_by,submitted_name,63,service FROM orders WHERE id=62`);
  const visit = await seed(63, 'catering', 'Получение', data => { data.inspection.rooms_complete = 'Нет'; });
  try {
    const { page } = visit;
    await page.route('**/audit-report-issues.js*', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Checking your browser...</title>',
    }));
    await page.reload();
    await page.locator('#step-content[aria-busy=false]').waitFor();
    await step(page, 2);
    const conflictingAnswer = issue(page, 'rooms-incomplete');
    assert.match(await conflictingAnswer.innerText(), /Указано «Часть не входит»/);
    await answerFocus(page, 'rooms-incomplete', 'inspection.rooms_complete', 'Нет');
    clean(visit);
  } finally {
    await visit.context.close();
  }
});
