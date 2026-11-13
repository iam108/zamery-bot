'use strict';
const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const yauzl=require('yauzl');
const {createService,openPage,multiPagePdf,sampleImage,until,hash,GROUP,LAWYER}=require('./helpers');

let service,browser,reportId;
const artifacts=path.resolve(process.env.E2E_ARTIFACTS_DIR||'test-results/e2e');
const company='ООО «ТЕСТОВЫЙ ДОГОВОР»';
const sourceName='Synthetic source establishment';
const managerAddress='Москва, Тестовая улица, 58, помещение 2';
const managerInn='1234567890';
const managerCad='77:01:0004016:9999';
const managerComment=['Уточнить регистрацию договора аренды.', ...Array.from({length:12},(_,i)=>'Пункт '+(i+1)+'. Сверить комплект перед подачей.'), 'Техническое описание оплачено.'].join('\n');
const document=name=>Buffer.concat([multiPagePdf(),Buffer.from('\n% '+name+'\n')]);
const auditOriginal=document('Auditor source original');
const orderOriginal=document('Original order document');
const initialDocument=document('Manager initial extra document');
const laterDocument=document('Manager later extra document');
before(async()=>{
  await fs.mkdir(artifacts,{recursive:true});
  service=await createService({master:true,clientsGroup:'-1001000000002'});browser=await chromium.launch();
  await service.pool.query('UPDATE orders SET contacts=$1,cad_num=\'\',owner_name=$2,object_name=$2 WHERE id=58',[
    JSON.stringify([{name:'Synthetic contact',phone:'+79991234567'}]),sourceName]);
  const telegram=require('../../src/bot/instance').telegram;
  const request=await telegram.sendMessage(GROUP,'Synthetic request #58');
  await service.pool.query('UPDATE orders SET telegram_msg_id=$1 WHERE id=58',[request.message_id]);
  const text='Synthetic auditor report: rooms and boundaries checked.\nНужны действия: приложить договор.';
  const message=await telegram.sendMessage(GROUP,text),file=await telegram.sendDocument(GROUP,{source:auditOriginal,filename:'audit-original.pdf'});
  const data={ui_version:5,workflow:{conclusion_status:'actions',video_url:''},inspection:{org:sourceName,address:'Москва, Тестовая улица, 58',service:'Получение'}};
  reportId=Number((await service.pool.query('INSERT INTO audits(order_id,text,chat_id,msg_ids,report_data) VALUES(58,$1,$2,$3,$4) RETURNING id',[
    text,GROUP,[message.message_id,file.message_id],JSON.stringify(data)])).rows[0].id);
  const materials=require('../../src/web/order-materials');
  await materials.saveOrderMaterials(58,materials.prepareMaterials([{originalname:'order-original.pdf',mimetype:'application/pdf',buffer:orderOriginal}],['egrn']));
});
after(async()=>{await browser?.close();await service?.close();});
const clean=visit=>{assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);};
async function unzip(buffer){
  const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value))),files=[];
  return new Promise((resolve,reject)=>{zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{
    if(error)return reject(error);try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);files.push({name:entry.fileName,buffer:Buffer.concat(chunks)});zip.readEntry();}catch(e){reject(e);}
  }));zip.readEntry();});
}
async function uploaded(page,name,buffer,mime='application/pdf'){
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/handoff/manual-materials'&&r.request().method()==='POST');
  await page.locator('#extra-document-input').setInputFiles({name,mimeType:mime,buffer});
  const value=await response;assert.equal(value.status(),200);const result=await value.json();
  await page.locator('#extra-document-list strong').getByText(name,{exact:true}).waitFor();
  await until(()=>page.locator('#extra-document-add').isEnabled(),'Upload finished and metadata persisted');
  return result.files;
}
async function downloaded(page,button){
  const pending=page.waitForEvent('download');await button.click();const download=await pending;
  assert.equal(await download.failure(),null);return {name:download.suggestedFilename(),buffer:await fs.readFile(await download.path())};
}
async function privateArchives(){
  const archives=[...service.originals.values()].filter(item=>item.chat===String(LAWYER)&&!item.copied_from&&/\.zip$/i.test(item.filename||''));
  return Promise.all(archives.map(async item=>({item,files:await unzip(item.bytes)})));
}

test('normal report handoff preserves manager company and documents through close/reopen, later lost ACK, private delivery and lawyer ZIP download',{timeout:90000},async()=>{
  const visit=await openPage(browser,service,2001,{pathname:'/handoff?order_id=58',mobile:false});let page=visit.page;
  let lawyer;
  try{
    await page.locator('#lawyers option[value="'+LAWYER+'"]').waitFor({state:'attached'});
    await until(()=>page.locator('#open-report').isEnabled(),'Source report loaded');
    await page.locator('#details').evaluate(element=>{element.open=true;});
    for(const [field,value] of [['org',company],['address',managerAddress],['inn',managerInn],['cad_num',managerCad]]){
      const input=page.locator('#'+field);
      await input.fill(value);
      await input.press('Tab');
      assert.equal(await input.inputValue(),value);
    }
    await page.locator('#kind').selectOption('Магазин');
    await page.locator('#service').selectOption('Получение');
    await page.locator('[data-contact="0"][data-field="tg"]').fill('@synthetic_contact');
    await page.locator('#priority').selectOption('срочно');
    await page.locator('#comment').fill(managerComment);
    const initialFiles=await uploaded(page,'manager-contract.pdf',initialDocument);
    assert.equal(initialFiles.length,1);assert.equal(initialFiles[0].sha256,hash(initialDocument));
    await page.screenshot({path:artifacts+'/desktop-initial-attachment.png',fullPage:true});
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('handoff-v2:2001:order-58')));
    assert.equal(saved.profile.org,company);assert.equal(saved.documents.hasDraft,true);
    const url=page.url();await page.close();page=await visit.context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>visit.errors.push(error.message));
    await page.goto(url);await page.locator('#extra-document-list strong').getByText('manager-contract.pdf',{exact:true}).waitFor();
    assert.equal(await page.locator('#org').inputValue(),company,'Company survives a closed form without source-name overwrite');
    await page.locator('#lawyers').selectOption(String(LAWYER));
    const start=service.messages.length;
    await page.locator('#go').click();await page.locator('#review').waitFor({state:'visible'});
    assert.match(await page.locator('#review').innerText(),/manager-contract\.pdf/);
    assert.match(await page.locator('#review-identifiers').innerText(),/1234567890.+77:01:0004016:9999/);
    assert.equal(await page.locator('#review-comment').innerText(),managerComment);
    let independentPosts=0;
    page.on('request',request=>{if(request.method()==='POST'&&/\/api\/handoff\/cases\/\d+\/documents$/.test(new URL(request.url()).pathname))independentPosts++;});
    const handed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/handoff'&&r.request().method()==='POST');
    await page.locator('#confirm-send').click();
    const handoffResponse=await handed,handoff=await handoffResponse.json();
    const sent=handoffResponse.request().postDataJSON();
    assert.deepEqual({org:sent.org,address:sent.address,inn:sent.inn,cad:sent.cad_num,priority:sent.priority,comment:sent.comment},
      {org:company,address:managerAddress,inn:managerInn,cad:managerCad,priority:'срочно',comment:managerComment});
    assert.equal(handoff.delivery_complete,true,JSON.stringify(handoff));assert.equal(handoff.extra_documents_submit_id,saved.documents.id);
    assert.deepEqual(sent.extra_documents,{submit_id:saved.documents.id,files:initialFiles.map(({id,name,mime,role,bytes,sha256})=>({id,name,mime,role,bytes,sha256}))});
    await page.locator('#extra-document-history').getByRole('button',{name:/manager-contract\.pdf/}).waitFor();
    const caseId=Number(handoff.id),record=(await service.pool.query('SELECT * FROM cases WHERE id=$1',[caseId])).rows[0];
    const [initial]=(await service.pool.query('SELECT * FROM case_document_batches WHERE case_id=$1',[caseId])).rows;
    assert.equal(initial.delivery.completed,true);assert.equal(initial.recipient_tg_id.toString(),String(LAWYER));assert.equal(independentPosts,0);
    assert.equal(record.org,company);assert.equal(record.data._handoff.body.org,company);
    assert.equal(record.data._handoff.packet.order.org,sourceName,'Auditor source is preserved separately');
    assert.equal(initial.id,saved.documents.id);assert.notEqual(initial.id,record.handoff_submit_id);
    assert.equal((await service.pool.query('SELECT id FROM cases WHERE order_id=58')).rows.length,1);
    const events=service.messages.slice(start),card=events.find(e=>e.method==='sendMessage'&&String(e.args[0])===String(LAWYER));
    assert.ok(card);assert.match(card.args[1],/ТЕСТОВЫЙ ДОГОВОР/);
    for(const text of [managerAddress,managerInn,managerCad,'@synthetic_contact','Магазин','Получение','горящий'])assert.ok(card.args[1].includes(text),text);
    assert.match(card.args[1],/Сведениях от менеджера/);
    const privateMessages=events.filter(e=>e.method==='sendMessage'&&String(e.args[0])===String(LAWYER));
    assert.equal(privateMessages.length,2);
    const details=privateMessages[1];
    assert.match(details.args[1],/Сведения от менеджера/);
    assert.ok(details.args[1].includes(managerComment));
    assert.equal(Number(details.args[2].reply_parameters.message_id),Number(card.item.message_id));
    assert.deepEqual(record.data._handoff.managerDetails.messageIds,[details.item.message_id]);
    const reportButton=card.args[2].reply_markup.inline_keyboard.flat().find(button=>button.text==='Перейти к отчёту');
    assert.ok(reportButton);const reportUrl=new URL(reportButton.web_app.url);assert.equal(reportUrl.searchParams.get('report_id'),String(reportId));
    assert.ok(events.filter(e=>['sendDocument','sendPhoto','sendMediaGroup'].includes(e.method)).every(e=>String(e.args[0])===String(LAWYER)),'Documents go only to assigned lawyer');
    const firstArchives=await privateArchives();
    assert.equal(firstArchives.flatMap(a=>a.files).filter(f=>f.buffer.equals(initialDocument)).length,1);
    assert.equal(firstArchives.flatMap(a=>a.files).filter(f=>f.buffer.equals(orderOriginal)).length,1);
    const additionalArchive=firstArchives.find(archive=>archive.files.some(file=>file.buffer.equals(initialDocument)));
    const lastPrivateIndex=events.findIndex(e=>e.item?.message_id===additionalArchive.item.message_id);
    const groupIndex=events.findIndex(e=>e.method==='sendMessage'&&String(e.args[0])==='-1001000000002');
    assert.ok(lastPrivateIndex>=0&&groupIndex>lastPrivateIndex,'The group is notified only after the reviewed manager originals are delivered');

    // Add a second batch to the existing client; lose only the HTTP response,
    // after the actual server has saved Telegram receipts and immutable bytes.
    await uploaded(page,'manager-addendum.pdf',laterDocument);
    let posts=0;const endpoint='/api/handoff/cases/'+caseId+'/documents';
    await page.route('**'+endpoint,async route=>{
      if(route.request().method()!=='POST')return route.continue();posts++;
      const response=await route.fetch();assert.equal(response.status(),200);const result=await response.json();assert.equal(result.delivery_complete,true);
      if(posts===1)return route.abort('failed');return route.fulfill({response});
    });
    const beforeLost=service.messages.length;
    await page.locator('#extra-document-send').click();
    await until(()=>page.locator('#extra-document-status').innerText().then(text=>/Failed to fetch|Load failed|NetworkError/.test(text)),'Lost ACK appears as a retryable error');
    assert.equal(posts,1);assert.equal((await service.pool.query('SELECT id FROM case_document_batches WHERE case_id=$1',[caseId])).rows.length,2);
    const lostSaved=await page.evaluate(()=>JSON.parse(localStorage.getItem('handoff-v2:2001:order-58')));
    assert.equal(lostSaved.documents.attempt.case_id,caseId);assert.equal(lostSaved.documents.hasDraft,true);
    await page.reload();await page.locator('#extra-document-history').getByRole('button',{name:/manager-addendum\.pdf/}).waitFor();
    await until(()=>page.locator('#extra-document-send').isHidden(),'History ACK reconciles the same document batch');
    const afterLost=service.messages.length;assert.equal(posts,1,'Reload reconciles delivery by GET, without a second POST');
    assert.equal(afterLost,beforeLost+1,'Only the new supplemental ZIP was sent');
    assert.equal((await service.pool.query('SELECT id FROM cases WHERE order_id=58')).rows.length,1,'Later upload cannot create another client');
    const allArchives=await privateArchives();
    assert.equal(allArchives.flatMap(a=>a.files).filter(f=>f.buffer.equals(initialDocument)).length,1);
    assert.equal(allArchives.flatMap(a=>a.files).filter(f=>f.buffer.equals(laterDocument)).length,1);

    // The lawyer sees the manager's legal entity, original audit and both
    // supplementary batches, and can download every exact byte or one ZIP.
    lawyer=await openPage(browser,service,LAWYER,{pathname:reportUrl.pathname+reportUrl.search,mobile:true});
    await lawyer.page.locator('#report-dialog').waitFor({state:'visible'});
    assert.equal(await lawyer.page.locator('#report-heading').innerText(),company);
    assert.match(await lawyer.page.locator('#report-text').innerText(),/Synthetic auditor report/);
    assert.equal(await lawyer.page.locator('#footer').isVisible(),false);
    const received=await downloaded(lawyer.page,lawyer.page.locator('#report-originals').getByRole('button',{name:/manager-addendum\.pdf/}));
    assert.equal(received.name,'manager-addendum.pdf');assert.equal(hash(received.buffer),hash(laterDocument));assert.ok(received.buffer.equals(laterDocument));
    const receivedOrder=await downloaded(lawyer.page,lawyer.page.locator('#report-originals').getByRole('button',{name:/order-original\.pdf/}));
    assert.equal(receivedOrder.name,'order-original.pdf');assert.deepEqual(receivedOrder.buffer,orderOriginal);
    const archive=await downloaded(lawyer.page,lawyer.page.locator('#report-download-package'));
    assert.match(archive.name,/ТЕСТОВЫЙ ДОГОВОР/);const contents=await unzip(archive.buffer);
    assert.ok(contents.every(f=>f.name.startsWith(company+'/Клиент №'+caseId+'/')));
    for(const original of [orderOriginal,initialDocument,laterDocument])assert.equal(contents.filter(f=>f.buffer.equals(original)).length,1,'ZIP contains every frozen document exactly once');
    assert.match(contents.find(f=>f.name.endsWith('/Отчёт.txt')).buffer.toString(),/ТЕСТОВЫЙ ДОГОВОР/);
    assert.match(contents.find(f=>f.name.endsWith('/Отчёт.txt')).buffer.toString(),/Synthetic auditor report/);
    const summary=contents.find(f=>f.name.endsWith('/Отчёт.txt')).buffer.toString();
    for(const text of [managerAddress,managerInn,managerCad,managerComment,'@synthetic_contact'])assert.ok(summary.includes(text),text);
    assert.equal(service.egrnRequests.length,0);assert.equal(service.messages.length,afterLost,'Read-only downloads do not resend Telegram messages');clean(visit);clean(lawyer);
  }finally{await lawyer?.context.close();await visit.context.close();}
});

test('case document view supports managers and assigned lawyers for report clients and manual clients without an order',{timeout:90000},async()=>{
  const visits=[];
  try{
    const ordinary=(await service.pool.query('SELECT id FROM cases WHERE order_id=58')).rows[0];assert.ok(ordinary);
    for(const actor of [2002,LAWYER]){
      const visit=await openPage(browser,service,actor,{pathname:'/handoff?case_id='+ordinary.id+'&view=documents',mobile:true});visits.push(visit);
      await visit.page.locator('#extra-document-history').getByRole('button',{name:/manager-contract\.pdf/}).waitFor();
      assert.equal(await visit.page.locator('#page-title').innerText(),'Документы клиента');
      assert.equal(await visit.page.locator('#org').inputValue(),company);
      assert.equal(await visit.page.locator('#saved-client-comment').innerText(),managerComment);
      assert.match(await visit.page.locator('#saved-client-contacts').innerText(),/@synthetic_contact/);
      assert.match(await visit.page.locator('#saved-client-identifiers').innerText(),/1234567890.+77:01:0004016:9999/);
      assert.match(await visit.page.locator('#object-meta').innerText(),/Магазин · Получение · МСК · Срочно/);
      if(actor===LAWYER)await visit.page.screenshot({path:artifacts+'/mobile-lawyer-handoff-package.png',fullPage:true});
      assert.equal(await visit.page.locator('#report-dialog').isVisible(),false,'Documents view must not force a report modal');
      assert.equal(await visit.page.locator('#extra-document-add').isVisible(),actor!==LAWYER);
      const result=await downloaded(visit.page,visit.page.locator('#download-package'));
      assert.equal((await unzip(result.buffer)).filter(f=>f.buffer.equals(initialDocument)).length,1);
    }

    const manual=await openPage(browser,service,2001,{pathname:'/handoff?mode=manual',mobile:true});visits.push(manual);const page=manual.page;
    await until(()=>page.locator('#manual-files').isEnabled(),'Manual form is ready');
    const manualName='ООО «ТЕСТ БЕЗ ВЫЕЗДА»';
    await page.locator('#org').fill(manualName);await page.locator('#address').fill('Московская область, Синтетическая улица, 12');
    await page.locator('#kind').selectOption('Общепит');await page.locator('#service').selectOption('Продление');await page.locator('#lawyers').selectOption(String(LAWYER));
    const initial=document('Manual company initial contract');
    await page.locator('#manual-documents-details').evaluate(element=>{element.open=true;});
    await page.locator('#manual-files').setInputFiles({name:'manual-initial.pdf',mimeType:'application/pdf',buffer:initial});
    await page.locator('#manual-file-list').getByText('manual-initial.pdf',{exact:true}).waitFor();
    await until(()=>page.locator('#go').isEnabled(),'Manual PDF stored');
    await page.locator('#go').click();await page.locator('#review').waitFor({state:'visible'});
    const submitted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/handoff'&&r.request().method()==='POST');await page.locator('#confirm-send').click();
    const created=await (await submitted).json();assert.equal(created.delivery_complete,true,JSON.stringify(created));
    const c=(await service.pool.query('SELECT * FROM cases WHERE id=$1',[created.id])).rows[0];assert.equal(c.order_id,null);assert.equal(c.org,manualName);

    const manager=await openPage(browser,service,2002,{pathname:'/handoff?case_id='+created.id+'&view=documents',mobile:true});visits.push(manager);const view=manager.page;
    await until(()=>view.locator('#extra-document-add').isEnabled(),'Another current manager can attach files to this manual client');
    assert.equal(await view.locator('#org').inputValue(),manualName);assert.equal(await view.locator('#report-dialog').isVisible(),false);
    const png=await sampleImage(view,'image/png'),jpeg=await sampleImage(view,'image/jpeg');
    await uploaded(view,'site.png',png,'image/png');
    await view.locator('[data-extra-remove]').click();await until(()=>view.locator('#extra-document-list li').count().then(n=>n===0),'Removal deletes only the unsent staged original');
    await uploaded(view,'site.jpg',jpeg,'image/jpeg');
    const delivered=view.waitForResponse(r=>new URL(r.url()).pathname==='/api/handoff/cases/'+created.id+'/documents'&&r.request().method()==='POST');
    await view.locator('#extra-document-send').click();assert.equal((await (await delivered).json()).delivery_complete,true);
    await view.locator('#extra-document-history').getByRole('button',{name:/site\.jpg/}).waitFor();
    const lawyer=await openPage(browser,service,LAWYER,{pathname:'/handoff?case_id='+created.id+'&view=documents',mobile:true});visits.push(lawyer);
    await lawyer.page.locator('#extra-document-history').getByRole('button',{name:/site\.jpg/}).waitFor();
    assert.equal(await lawyer.page.locator('#extra-document-add').isVisible(),false);assert.equal(await lawyer.page.locator('#org').inputValue(),manualName);
    await lawyer.page.screenshot({path:artifacts+'/mobile-lawyer-documents.png',fullPage:true});
    const image=await downloaded(lawyer.page,lawyer.page.locator('#extra-document-history').getByRole('button',{name:/site\.jpg/}));assert.ok(image.buffer.equals(jpeg));
    const zip=await downloaded(lawyer.page,lawyer.page.locator('#download-package')),entries=await unzip(zip.buffer);
    assert.ok(entries.every(e=>e.name.startsWith(manualName+'/Клиент №'+created.id+'/')));
    assert.equal(entries.filter(e=>e.buffer.equals(initial)).length,1,'Manual initial files belong to the same downloadable package');
    assert.equal(entries.filter(e=>e.buffer.equals(jpeg)).length,1);assert.equal(entries.filter(e=>e.buffer.equals(png)).length,0,'Removed files must not be delivered or archived');
    assert.equal((await service.pool.query('SELECT id FROM cases WHERE order_id IS NULL')).rows.length,1);assert.equal(service.egrnRequests.length,0);
    for(const visit of visits)clean(visit);
  }finally{await Promise.all(visits.map(visit=>visit.context.close()));}
});

test('closing the case form during a saved upload recovers its same document without re-upload or duplicate delivery',{timeout:60000},async()=>{
  const c=(await service.pool.query('SELECT id FROM cases WHERE order_id=58')).rows[0];
  const visit=await openPage(browser,service,2002,{pathname:'/handoff?case_id='+c.id+'&view=documents',mobile:true});let page=visit.page,release;
  const original=document('Upload response lost when form closes'),filename='closed-form-upload.pdf';let committed,posts=0;
  const gate=new Promise(resolve=>{release=resolve;});
  try{
    await until(()=>page.locator('#extra-document-add').isEnabled(),'Current manager document form loaded');
    await page.route('**/api/handoff/manual-materials?*',async route=>{
      if(route.request().method()!=='POST')return route.continue();posts++;
      const response=await route.fetch();assert.equal(response.status(),200);committed=await response.json();await gate;
      try{await route.fulfill({response});}catch(error){if(!visit.page.isClosed())throw error;}
    });
    await page.locator('#extra-document-input').setInputFiles({name:filename,mimeType:'application/pdf',buffer:original});
    await until(()=>!!committed,'Server stored original before browser receives upload ACK');
    const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('handoff-v2:2002:case-'+new URLSearchParams(location.search).get('case_id'))));
    assert.equal(stored.documents.hasDraft,true);assert.equal(committed.files.length,1);const id=committed.files[0].id,url=page.url();
    await page.close();release();page=await visit.context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>visit.errors.push(error.message));
    await page.goto(url);await page.locator('#extra-document-list strong').getByText(filename,{exact:true}).waitFor();
    await until(()=>page.locator('#extra-document-send').isEnabled(),'Same persisted upload becomes ready after reopening');
    assert.equal(posts,1);const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('handoff-v2:2002:case-'+new URLSearchParams(location.search).get('case_id'))));
    assert.equal(restored.documents.id,stored.documents.id);assert.equal(restored.documents.attempt,null);
    const before=service.messages.length,pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/handoff/cases/'+c.id+'/documents'&&r.request().method()==='POST');
    await page.locator('#extra-document-send').click();const result=await (await pending).json();assert.equal(result.delivery_complete,true);assert.equal(result.batch.id,stored.documents.id);assert.equal(result.batch.files[0].id,id);
    await page.locator('#extra-document-history').getByRole('button',{name:new RegExp(filename.replaceAll('.','\\.'))}).waitFor();
    assert.equal(service.messages.length,before+1);assert.equal((await privateArchives()).flatMap(v=>v.files).filter(v=>v.buffer.equals(original)).length,1);
    await page.reload();await page.locator('#extra-document-history').getByRole('button',{name:/closed-form-upload\.pdf/}).waitFor();
    assert.equal(service.messages.length,before+1);assert.equal(posts,1);assert.equal(service.egrnRequests.length,0);clean(visit);
  }finally{release();await visit.context.close();}
});
