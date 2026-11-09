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
const step=(page,index)=>page.locator('#steps [data-step="'+index+'"]').click();
const field=(page,key)=>page.locator('[data-bind="'+key+'"]');
const mode=(page,value)=>page.locator('[data-choice="plan.mode"][data-value="'+value+'"]');
const pending={tool:'boundary',points:[{x:.12,y:.15},{x:.78,y:.18},{x:.71,y:.79}]};
async function seed(order,school) {
 await service.pool.query("UPDATE orders SET object_type='Табак',service='Получение' WHERE id=$1",[order]);
 const initial=await openPage(browser,service,1001,{pathname:'/audit?order_id='+order});
 await initial.page.locator('#step-content[aria-busy=false]').waitFor();
 const png=await sampleImage(initial.page,'image/png'),jpg=await sampleImage(initial.page,'image/jpeg'),pdf=multiPagePdf(),draft=await service.draft(order);
 assert.deepEqual(initial.errors,[]);assert.deepEqual(initial.blocked,[]);await initial.context.close();
 const data=compactVisit('tobacco');data.order_id=order;data.request_packet=draft.data.request_packet;
 Object.assign(data.inspection,{org:draft.data.inspection.org,address:draft.data.inspection.address,service:'Получение',tobacco_display:'Открытая',tobacco_price_list:'Нет',tobacco_advertising:'Есть'});
 data.workflow.step=2;data.workflow.conclusion_status='obstacle';data.conclusion='Школа и замечания по торговле табаком зафиксированы аудитором; факты не менять.';
 data.plan.mode='draw';data.plan.annotations=[];data.plan.pending=structuredClone(pending);
 data.evidence=data.evidence.filter(file=>file.role!=='map-source');
 if(school){
  const attached=data.evidence.find(file=>file.role==='map');attached.subject_id='attached';attached.name='Сохранённая схема территории.png';
  data.workflow.territory_result='findings';data.map={mode:'attached',evidence_id:attached.id,page:1,annotations:[]};
  data.zones=[{id:'school-1',name:'Школа №123',type:'Школа',status:'confirmed',entrance_id:'entrance-1',dist:'70',method:'Пешеходный маршрут',source:'',resolution:'',note:'',info:''}];
  data.evidence.push({id:randomUUID(),name:'Фото школы.jpg',mime:'image/jpeg',role:'zone',subject_id:'school-1'});
 }else{
  data.workflow.territory_result='clear';data.map={evidence_id:'',page:1,annotations:[]};data.zones=[];data.evidence=data.evidence.filter(file=>file.role!=='map');
 }
 const originals=data.evidence.map(file=>({...file,content:file.mime==='application/pdf'?pdf:file.mime==='image/jpeg'?jpg:png}));
 data.evidence=originals.map(({content,...file})=>({...file,bytes:content.length,sha256:hash(content)}));
 data.plan.preview_evidence_id=data.evidence.find(file=>file.role==='plan').id;
 for(const file of originals)await service.pool.query('INSERT INTO audit_evidence(draft_id,id,name,mime,role,subject_id,bytes,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[draft.id,file.id,file.name,file.mime,file.role,file.subject_id,file.content.length,hash(file.content),file.content]);
 await service.pool.query('UPDATE audit_drafts SET data=$1,revision=revision+1 WHERE id=$2',[JSON.stringify(data),draft.id]);
 const visit=await openPage(browser,service,1001,{pathname:'/audit?order_id='+order});await visit.page.locator('#step-content[aria-busy=false]').waitFor();await step(visit.page,2);
 return {...visit,draftId:draft.id,oldSource:data.plan.evidence_id,png,jpg,pdf};
}
async function save(page,order) {
 await page.locator('#save-now').click();await until(()=>page.evaluate(()=>/Черновик сохранён на сервере/.test(document.querySelector('#toast').textContent)),'The latest report reaches its durable draft');
 return service.draft(order);
}
async function uploadArtwork(page,file,pageNumber=1) {
 const editor=page.locator('#plan-editor');await editor.getByRole('button',{name:'Прикрепить готовый план',exact:true}).click();
 const dialog=editor.locator('dialog'),use=dialog.getByRole('button',{name:'Использовать этот лист',exact:true});
 await dialog.locator('input[type=file]').setInputFiles(file);await until(()=>use.isEnabled(),'The ready original renders in the source chooser');
 for(let number=1;number<pageNumber;number++){await dialog.getByRole('button',{name:'Следующая страница'}).click();await until(()=>use.isEnabled(),'The selected PDF page renders');}
 await use.click();await dialog.waitFor({state:'hidden'});await editor.locator('.ape-viewport canvas').waitFor({state:'visible'});
}
async function serverSubmit(page,order) {
 const draft=await service.draft(order);return page.evaluate(async input=>{const response=await fetch('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},{draft_id:draft.id,revision:draft.revision});
}
async function screenshot(page,name) {
 const directory=path.resolve(process.env.E2E_ARTIFACTS_DIR||'test-results/e2e');await fs.mkdir(directory,{recursive:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'The mobile report has no horizontal overflow');
 await page.screenshot({path:path.join(directory,name+'.png'),fullPage:true});
}
function physical(events){return events.filter(event=>['sendMessage','sendPhoto','sendMediaGroup','sendDocument'].includes(event.method));}
function documents(events){return physical(events).flatMap(event=>event.method==='sendDocument'?[{name:event.args[1].filename,buffer:event.args[1].source}]:event.method==='sendMediaGroup'&&event.args[1][0].type==='document'?event.args[1].map(item=>({name:item.media.filename,buffer:item.media.source})):[]);}
async function archiveEntries(buffer) {
 const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value)));
 return new Promise((resolve,reject)=>{const files=[];zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{if(error)return reject(error);try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);files.push({name:entry.fileName,buffer:Buffer.concat(chunks)});zip.readEntry();}catch(failure){reject(failure);}}));zip.readEntry();});
}
async function completed(page,order,start) {
 await step(page,2);await page.locator('#submit-audit').click();await page.getByRole('heading',{name:'Отчёт отправлен',exact:true}).waitFor();
 const audits=(await service.pool.query('SELECT * FROM audits WHERE order_id=$1',[order])).rows;assert.equal(audits.length,1);
 const audit=audits[0];assert.equal(audit.report_data.workflow.conclusion_status,'obstacle');
 for(const[key,value]of [['tobacco_display','Открытая'],['tobacco_price_list','Нет'],['tobacco_advertising','Есть']])assert.equal(audit.report_data.inspection[key],value);
 assert.equal(audit.report_data.plan.mode,'attached');assert.equal(audit.report_data.plan.pending,null);assert.deepEqual(audit.report_data.plan.annotations,[]);
 const sent=documents(service.messages.slice(start));assert.equal(sent.length,2);assert.equal(sent[0].name,'Отчёт-'+order+'-полный.txt');assert.equal(sent[0].buffer.toString('utf8'),audit.text);
 assert.equal(service.egrnRequests.length,0);return{audit,entries:await archiveEntries(sent[1].buffer)};
}

test('a tobacco obstacle with a confirmed school uses ready PNG/JPG artwork, retains its old pending drawing and sends only after the missing basis is supplied',{timeout:90000},async()=>{
 const visit=await seed(58,true),{page}=visit;const start=service.messages.length;let submits=0;
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/audit')submits++;});
 try {
  assert.equal(await field(page,'workflow.conclusion_status').inputValue(),'obstacle');assert.match(await page.locator('#report-feedback').innerText(),/Школа/);await screenshot(page,'tobacco-blocker-before');
  const blocked=await serverSubmit(page,58);assert.equal(blocked.status,400);assert.equal(physical(service.messages.slice(start)).length,0);assert.equal((await service.draft(58)).submitting_revision,null);
  await page.reload();await page.locator('#step-content[aria-busy=false]').waitFor();assert.deepEqual((await service.draft(58)).data.plan.pending,pending);await step(page,2);
  await page.locator('#report-feedback .task button[data-issue-control^="plan."]').first().click();
  await until(()=>page.locator('#plan-editor').getByRole('button',{name:'Замкнуть контур',exact:true}).evaluate(node=>document.activeElement===node),'The unfinished-contour action focuses the actual close-contour control');
  await mode(page,'attached').click();await uploadArtwork(page,{name:'Готовый план.png',mimeType:'image/png',buffer:visit.png});await save(page,58);
  await mode(page,'draw').click();await page.locator('#plan-editor .ape-viewport canvas').waitFor({state:'visible'});const restored=await save(page,58);assert.equal(restored.data.plan.evidence_id,visit.oldSource);assert.deepEqual(restored.data.plan.pending,pending);assert.deepEqual(restored.data.plan.annotations,[]);
  await mode(page,'attached').click();await save(page,58);
  await step(page,0);await page.locator('input[data-territory-upload=attached]').setInputFiles({name:'Готовая схема.jpg',mimeType:'image/jpeg',buffer:visit.jpg});await page.getByText('Готовая схема.jpg',{exact:true}).waitFor();await save(page,58);
  await step(page,2);const missingBasis=page.locator('#report-feedback .task button[data-issue-control="zones.school-1.resolution"]');await missingBasis.waitFor();
  const before=submits;await page.locator('#submit-audit').click();await page.evaluate(()=>Promise.resolve());
  assert.equal(submits,before,'The actual submit action stays blocked by the missing basis before posting the report');assert.equal(physical(service.messages.slice(start)).length,0);
  await missingBasis.click();await until(()=>page.evaluate(()=>document.activeElement?.dataset.bind==='zones.0.resolution'),'The missing-school-basis button focuses the actual editable explanation');
  const basis='Основание: на фото и готовой схеме отмечена школа №123, маршрут от входа объекта — 70 м.';await field(page,'zones.0.resolution').fill(basis);await save(page,58);
  assert.equal(await field(page,'zones.0.status').inputValue(),'confirmed');await page.reload();await page.locator('#step-content[aria-busy=false]').waitFor();await step(page,2);
  assert.equal(await field(page,'workflow.conclusion_status').inputValue(),'obstacle');assert.equal(await page.locator('#report-feedback .task button[data-issue-control="zones.school-1.resolution"]').count(),0);
  assert.equal(await page.locator('#report-feedback [data-report-group="required"]').count(),0);assert.match(await page.locator('#report-feedback').innerText(),/Школа|Ограничение/);await screenshot(page,'tobacco-blocker-ready-artwork');
  const result=await completed(page,58,start),zone=result.audit.report_data.zones[0];assert.equal(zone.status,'confirmed');assert.equal(zone.name,'Школа №123');assert.equal(zone.dist,'70');assert.equal(zone.resolution,basis);assert.match(result.audit.text,/Школа №123/);assert.match(result.audit.text,/70/);
  for(const[name,buffer]of [['Готовый план.png',visit.png],['Готовая схема.jpg',visit.jpg]])assert.equal(result.entries.filter(file=>file.name.endsWith(name)&&file.buffer.equals(buffer)).length,1);
  assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);
 }finally{await visit.context.close();}
});

test('a ready multi-page PDF keeps its selected fourth page after reload and delivers the unchanged complete PDF without requiring a new contour',{timeout:90000},async()=>{
 const visit=await seed(59,false),{page}=visit;const start=service.messages.length;
 try {
  await step(page,1);await mode(page,'attached').click();await uploadArtwork(page,{name:'Готовый план — 6 листов.pdf',mimeType:'application/pdf',buffer:visit.pdf},4);
  const saved=await save(page,59);assert.equal(saved.data.plan.mode,'attached');assert.equal(saved.data.plan.page,4);assert.equal(saved.data.plan.pending,null);assert.deepEqual(saved.data.plan.annotations,[]);
  await page.reload();await page.locator('#step-content[aria-busy=false]').waitFor();await step(page,1);const canvas=page.locator('#plan-editor .ape-viewport canvas');await canvas.waitFor({state:'visible'});
  await until(()=>canvas.evaluate(node=>{const p=node.getContext('2d').getImageData(Math.floor(node.width/2),Math.floor(node.height/2),1,1).data;return p[1]>p[0]+50&&p[1]>p[2]+50;}),'The saved fourth (green) PDF page is the visible ready artwork');
  const result=await completed(page,59,start);assert.equal(result.audit.report_data.plan.page,4);assert.equal(result.entries.filter(file=>file.name.endsWith('Готовый план — 6 листов.pdf')&&file.buffer.equals(visit.pdf)).length,1);
  assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);
 }finally{await visit.context.close();}
});
