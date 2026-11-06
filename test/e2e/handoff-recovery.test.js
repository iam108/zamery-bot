'use strict';
const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const yauzl=require('yauzl');
const {createService,openPage,multiPagePdf,until,hash,GROUP,LAWYER}=require('./helpers');
let service,browser;
const originalAudit=Buffer.concat([multiPagePdf(),Buffer.from('\n% Synthetic auditor original\n')]);
const originalManager=Buffer.concat([multiPagePdf(),Buffer.from('\n% Synthetic manager original\n')]);
const reportIds=new Map(),sourceIds=new Map();
before(async()=>{
  service=await createService({master:true});browser=await chromium.launch();
  const telegram=require('../../src/bot/instance').telegram;
  for(const order of [58,59]){
    await service.pool.query('UPDATE orders SET contacts=$1,cad_num=\'\' WHERE id=$2',[JSON.stringify([{name:'Synthetic client contact',phone:'+79991234567'}]),order]);
    const card=await telegram.sendMessage(GROUP,'Synthetic request #'+order);await service.pool.query('UPDATE orders SET telegram_msg_id=$1 WHERE id=$2',[card.message_id,order]);
    const text='Synthetic complete auditor report for request #'+order+'\nНужны действия: сверить документы.';
    const summary=await telegram.sendMessage(GROUP,text),document=await telegram.sendDocument(GROUP,{source:originalAudit,filename:'Synthetic-auditor-original.pdf'});
    const data={ui_version:5,workflow:{conclusion_status:'actions',video_url:''},inspection:{org:'Synthetic client',address:'Москва, Тестовая улица, '+order,service:'Получение'}};
    const row=(await service.pool.query('INSERT INTO audits(order_id,text,chat_id,msg_ids,report_data) VALUES($1,$2,$3,$4,$5) RETURNING id',[order,text,GROUP,[summary.message_id,document.message_id],JSON.stringify(data)])).rows[0];
    reportIds.set(order,Number(row.id));sourceIds.set(order,[summary.message_id,document.message_id]);
  }
  const materials=require('../../src/web/order-materials');await materials.saveOrderMaterials(58,materials.prepareMaterials([{originalname:'Synthetic-manager-original.pdf',mimetype:'application/pdf',buffer:originalManager}]));
});
after(async()=>{await browser?.close();await service?.close();});
const clean=visit=>{assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);};
async function unzip(buffer){
  const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value))),files=[];
  return new Promise((resolve,reject)=>{zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{if(error)return reject(error);try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);files.push({name:entry.fileName,bytes:Buffer.concat(chunks)});zip.readEntry();}catch(failure){reject(failure);}}));zip.readEntry();});
}

test('a known rejected handoff resumes its existing case after a fresh browser context and sends one complete private package', {timeout:60000},async()=>{
  let visit=await openPage(browser,service,2001,{pathname:'/handoff?order_id=58',mobile:false}),{page}=visit;
  const telegram=require('../../src/bot/instance').telegram,sendDocument=telegram.sendDocument;let rejected=0;
  telegram.sendDocument=async(...args)=>{
    if(String(args[0])===String(LAWYER)&&/\.zip$/i.test(args[1]?.filename||'')&&rejected===0){rejected++;throw Object.assign(new Error('Synthetic Telegram explicitly rejected this manager ZIP'),{response:{error_code:400,description:'Bad Request: synthetic rejected upload'}});}
    return sendDocument(...args);
  };
  try{
    await until(()=>page.locator('#lawyers option[value="'+LAWYER+'"]').count().then(count=>count===1),'Loaded assigned-lawyer selector');
    await page.locator('#lawyers').selectOption(String(LAWYER));const start=service.messages.length;
    await page.locator('#go').click();await page.locator('#review').waitFor({state:'visible'});
    const pending=page.waitForResponse(response=>response.url().endsWith('/api/handoff')&&response.request().method()==='POST');await page.locator('#confirm-send').click();
    const firstResponse=await pending,first=await firstResponse.json();assert.equal(firstResponse.status(),200);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(first.manual_review,undefined);assert.equal(rejected,1);
    await page.locator('#delivery-title').getByText('Доставка не завершена',{exact:true}).waitFor();
    const assigned=(await service.pool.query('SELECT * FROM cases WHERE order_id=58')).rows;assert.equal(assigned.length,1);const caseId=Number(assigned[0].id);
    assert.equal(caseId,first.id);assert.equal(assigned[0].data._handoff.completed,false);assert.equal(assigned[0].data._handoff.manual_review,undefined);
    clean(visit);await visit.context.close();visit=await openPage(browser,service,2001,{pathname:'/handoff?order_id=58',mobile:false});page=visit.page;
    const retry=page.getByRole('button',{name:'Продолжить доставку',exact:true});await retry.waitFor({state:'visible'});
    assert.match(await page.locator('#delivery-title').innerText(),/^Юрист назначен:/);assert.match(await page.locator('#delivery-text').innerText(),/ещё не завершена/);
    const resumed=page.waitForResponse(response=>response.url().endsWith('/api/handoff')&&response.request().method()==='POST');await retry.click();
    const response=await resumed,result=await response.json();assert.deepEqual(response.request().postDataJSON(),{resume_case_id:caseId});assert.equal(result.id,caseId);assert.equal(result.delivery_complete,true);
    await page.locator('#delivery-title').getByText(/Передано/).waitFor();
    const done=(await service.pool.query('SELECT * FROM cases WHERE order_id=58')).rows;assert.equal(done.length,1);assert.equal(Number(done[0].id),caseId);assert.equal(done[0].data._handoff.completed,true);
    const events=service.messages.slice(start);assert.equal(events.filter(event=>event.method==='sendMessage'&&String(event.args[0])===String(LAWYER)).length,1,'Existing private client card is not resent');
    assert.equal(events.filter(event=>event.method==='copyMessages').length,1,'Confirmed audit messages are not copied again');
    const privateItems=[...service.originals.values()].filter(item=>item.chat===String(LAWYER));
    for(const id of sourceIds.get(58))assert.equal(privateItems.filter(item=>item.copied_from?.chat===GROUP&&item.copied_from.id===id).length,1,'Each actual audit source message is delivered once');
    assert.equal(privateItems.filter(item=>item.copied_from&&item.bytes?.equals(originalAudit)).length,1);
    const archives=privateItems.filter(item=>!item.copied_from&&/\.zip$/i.test(item.filename||''));assert.equal(archives.length,1);
    const files=await unzip(archives[0].bytes);assert.equal(files.filter(file=>hash(file.bytes)===hash(originalManager)&&file.bytes.equals(originalManager)).length,1);
    const sent=service.messages.length;clean(visit);await visit.context.close();visit=await openPage(browser,service,2001,{pathname:'/handoff?order_id=58',mobile:false});page=visit.page;await page.locator('#delivery-title').getByText(/Уже передано/).waitFor();assert.equal(service.messages.length,sent);assert.equal((await service.pool.query('SELECT id FROM cases WHERE order_id=58')).rows.length,1);
    assert.equal(service.egrnRequests.length,0);clean(visit);
  }finally{telegram.sendDocument=sendDocument;await visit.context.close();}
});

test('a legacy assignment without delivery checkpoints stays unknown after stale completed and legacy-pending session caches', {timeout:30000},async()=>{
  await service.pool.query("INSERT INTO cases(id,order_id,lawyer_tg_id,lawyer_name,org,address,region,kind,service,data,created_by) VALUES(39,59,$1,'Synthetic lawyer','Synthetic client','Москва, Тестовая улица, 59','МСК','Общепит','Получение','{}',2001)",[LAWYER]);
  const visit=await openPage(browser,service,2001,{pathname:'/handoff?order_id=59',mobile:false}),{page}=visit;
  try{
    await page.locator('#delivery-title').getByText(/^Юрист назначен:/).waitFor();const before=service.messages.length;let posts=0;
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/handoff'&&request.method()==='POST')posts++;});
    for(const kind of ['completed','legacy-pending']){
      await page.evaluate(({kind,id})=>{const saved={version:2};if(kind==='completed')saved.completed={id,name:'Synthetic lawyer'};else saved.pending={caseId:id,payload:{order_id:59,report_src:'a',report_id:1},name:'Synthetic lawyer'};sessionStorage.setItem('handoff-v2:2001:order-59',JSON.stringify(saved));},{kind,id:39});
      await page.reload();await page.locator('#delivery-title').getByText(/^Юрист назначен:/).waitFor();assert.match(await page.locator('#delivery-text').innerText(),/Подтверждение доставки не сохранено/);assert.equal(await page.locator('#retry-send').isVisible(),false);assert.equal(await page.locator('#go').isDisabled(),true);
    }
    await page.locator('#open-report').click();await page.locator('#report-dialog').waitFor({state:'visible'});await page.locator('#report-text').getByText('Synthetic complete auditor report for request #59',{exact:false}).waitFor();
    assert.equal(posts,0);assert.equal(service.messages.length,before);assert.equal((await service.pool.query('SELECT id FROM cases WHERE order_id=59')).rows.length,1);assert.equal(reportIds.has(59),true);clean(visit);
  }finally{await visit.context.close();}
});
