'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { createService, openPage, multiPagePdf, sampleImage, until, hash } = require('./helpers');

let browser, service;
before(async () => { service = await createService(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await service?.close(); });
const field = (page, name) => page.locator('[data-bind="' + name + '"]');
const choice = (page, name, value) => page.locator('[data-choice="' + name + '"][data-value="' + value + '"]');
const step = (page, index) => page.locator('#steps [data-step="' + index + '"]').click();

async function run(t, action) {
  try { await action(); }
  catch (error) {
    const directory = path.resolve(process.env.E2E_ARTIFACTS_DIR || 'test-results/e2e'); await fs.mkdir(directory, { recursive: true });
    let index = 0; for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: path.join(directory, t.name.replace(/[^a-z0-9]+/gi,'-') + '-' + (++index) + '.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { for (const context of browser.contexts()) await context.close(); }
}
async function save(page) {
  await page.locator('#save-now').click();
  await until(() => page.evaluate(() => /Черновик сохранён на сервере/.test(document.querySelector('#toast').textContent)), 'Server draft save confirmation');
}
async function attach(page, name, buffer) {
  await page.locator('input[data-upload-role="entrance"]:not([capture])').first().setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await page.getByText(name, { exact: true }).first().waitFor();
}
async function choosePdf(page, pdf, number = 4) {
  const editor = page.locator('#plan-editor');
  await editor.getByRole('button', { name: 'Выбрать лист PDF / изображение', exact: true }).click();
  const dialog = editor.locator('dialog'); await dialog.locator('input[type=file]').setInputFiles({ name: 'Synthetic-plan.pdf', mimeType: 'application/octet-stream', buffer: pdf });
  const use = dialog.getByRole('button', { name: 'Использовать этот лист', exact: true });
  await until(() => use.isEnabled(), 'PDF page preview');
  for (let index = 1; index < number; index++) { await dialog.getByRole('button', { name: 'Следующая страница' }).click(); await until(() => use.isEnabled(), 'Selected PDF page'); }
  await use.click(); await dialog.waitFor({ state: 'hidden' });
  await editor.locator('.ape-source').getByText(new RegExp('лист ' + number)).waitFor();
  const canvas = editor.getByLabel('План помещения для разметки'); await canvas.waitFor();
  const color = await canvas.evaluate(element => Array.from(element.getContext('2d').getImageData(10,10,1,1).data));
  assert.ok(color[1] > 100 && color[0] < 20, 'The selected fourth PDF page is green, unlike the red first page');
  return { editor, canvas };
}
async function annotate(page, canvas) {
  await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); assert.ok(box?.width > 100);
  for (const [x,y] of [[.15,.18],[.77,.18],[.77,.78],[.15,.78]]) await page.touchscreen.tap(box.x + x * box.width, box.y + y * box.height);
  await page.locator('#plan-editor').getByRole('button', { name: 'Замкнуть контур' }).click();
  await page.locator('#plan-editor').getByRole('button', { name: 'Сохранить разметку' }).click();
}
async function prepareReport(page, pdf) {
  await choice(page,'building_type','Нежилое').click(); await choice(page,'workflow.territory_result','clear').click();
  await page.locator('[data-add-entrance]').click(); await field(page,'entrances.0.label').fill('Synthetic street entrance');
  await attach(page,'Synthetic-entrance.jpg',await sampleImage(page,'image/jpeg'));
  await step(page,1); const {canvas} = await choosePdf(page,pdf); await annotate(page,canvas);
  await field(page,'inspection.floor_plan').fill('1'); await field(page,'inspection.floor_actual').fill('1'); await field(page,'inspection.cadastral_count').fill('1');
  for (const [name,value] of [['inspection.within_cadastral','Да'],['inspection.rooms_complete','Да'],['to','Не нужно'],['bti','Да'],['inspection.alcohol_present','Нет'],['inspection.kkt_count','1'],['inspection.kkt_ip','Нет']]) await choice(page,name,value).click();
  await step(page,2); await field(page,'workflow.conclusion_status').selectOption('ready');
}
function clean(visit) { assert.deepEqual(visit.errors,[]); assert.deepEqual(visit.blocked,[]); }

test('Android JPG PNG PDF originals and annotations reopen from the server with fresh browser storage', { timeout:60000 }, t => run(t,async()=>{
  const first = await openPage(browser,service), {page} = first; await page.locator('#step-content[aria-busy=false]').waitFor();
  await choice(page,'building_type','Нежилое').click(); await choice(page,'workflow.territory_result','findings').click();
  await choice(page,'map.mode','attached').click();
  await page.locator('[data-add-entrance]').click(); await field(page,'entrances.0.label').fill('Synthetic entrance');
  const jpg = await sampleImage(page,'image/jpeg'), png = await sampleImage(page,'image/png'), pdf = multiPagePdf();
  await attach(page,'Synthetic-entrance.jpg',jpg);
  await page.locator('[data-territory-upload=attached]').setInputFiles({name:'Synthetic-map.png',mimeType:'application/octet-stream',buffer:png});
  await page.getByText('Synthetic-map.png',{exact:true}).first().waitFor();
  await step(page,1); const {canvas} = await choosePdf(page,pdf); await annotate(page,canvas);
  await step(page,2); await field(page,'conclusion').fill('Synthetic saved on-site observations'); await save(page);
  const saved = await service.draft(58); assert.equal(saved.data.plan.page,4); assert.ok(saved.data.plan.annotations.length);
  const evidence = (await service.pool.query('SELECT * FROM audit_evidence WHERE draft_id=$1 AND deleted_at IS NULL',[saved.id])).rows;
  for (const [name,bytes,mime] of [['Synthetic-entrance.jpg',jpg,'image/jpeg'],['Synthetic-map.png',png,'image/png'],['Synthetic-plan.pdf',pdf,'application/pdf']]) {
    const item=evidence.find(file=>file.name===name);assert.ok(item,name);assert.equal(item.mime,mime);assert.equal(item.sha256,hash(bytes));assert.ok(service.objects.get(item.object_key).equals(bytes));
  }
  clean(first); await first.context.close();
  const reopened = await openPage(browser,service,1001,{pathname:'/audit'});
  await reopened.page.locator('a[href*="order_id=58"]').click();await field(reopened.page,'conclusion').waitFor();
  assert.equal(await field(reopened.page,'conclusion').inputValue(),'Synthetic saved on-site observations');
  await step(reopened.page,0);await reopened.page.getByText('Synthetic-entrance.jpg',{exact:true}).first().waitFor();await reopened.page.getByText('Synthetic-map.png',{exact:true}).first().waitFor();
  await step(reopened.page,1);await reopened.page.locator('#plan-editor .ape-source').getByText(/лист 4/).waitFor();
  await until(async()=>{const color=await reopened.page.getByLabel('План помещения для разметки').evaluate(element=>Array.from(element.getContext('2d').getImageData(10,10,1,1).data));return color[1]>100&&color[0]<20;},'Restored PDF raster');
  const current=await service.draft(58);assert.equal(current.id,saved.id);assert.deepEqual(current.data.plan.annotations,saved.data.plan.annotations);clean(reopened);
}));

test('manager browser CAS and exact lost-acknowledgement replay preserve a newer manager packet', { timeout:60000 }, t => run(t,async()=>{
  const a=await openPage(browser,service,2001,{pathname:'/form?order_id=60',mobile:false}),b=await openPage(browser,service,2002,{pathname:'/form?order_id=60',mobile:false});
  await until(()=>a.page.locator('#submit-btn').isEnabled(),'Manager A packet');await until(()=>b.page.locator('#submit-btn').isEnabled(),'Manager B packet');
  await a.page.clock.install();await a.page.clock.pauseAt(new Date());
  const intents=[],results=[];let first=true;
  await a.page.route('**/api/order/60',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const data=await new Response(route.request().postDataBuffer(),{headers:{'Content-Type':route.request().headers()['content-type']}}).formData();
    const intent={};for(const [name,value]of data)intent[name]=typeof value==='string'?value:{name:value.name,sha256:hash(Buffer.from(await value.arrayBuffer()))};intents.push(intent);
    const result=await route.fetch();results.push(await result.json());if(first){first=false;return route.abort('failed');}return route.fulfill({response:result});
  });
  await a.page.locator('#address').fill('Москва, Synthetic manager A, 1');const pdf=multiPagePdf();await a.page.locator('#attachments').setInputFiles({name:'Synthetic-manager-plan.pdf',mimeType:'application/pdf',buffer:pdf});
  await a.page.locator('#submit-btn').click();await until(()=>results.length===1,'The first manager write committed without its browser acknowledgement');
  await until(async()=>/повтор/.test(await a.page.locator('#packet-status').innerText()),'Lost acknowledgement retry countdown');
  await b.page.locator('#address').fill('Москва, stale manager B, 2');const stale=b.page.waitForResponse(response=>response.url().endsWith('/api/order/60')&&response.request().method()==='POST');await b.page.locator('#submit-btn').click();assert.equal((await stale).status(),409);
  await b.page.locator('#packet-retry').click();await until(()=>b.page.locator('#submit-btn').isEnabled(),'Explicit current packet reload');
  await b.page.locator('#address').fill('Москва, newer manager B, 3');await b.page.locator('#contacts').fill('Synthetic current contact B');
  const savedB=b.page.waitForResponse(response=>response.url().endsWith('/api/order/60')&&response.request().method()==='POST');await b.page.locator('#submit-btn').click();assert.equal((await savedB).status(),200);
  await a.page.locator('#address').fill('Synthetic newer typing retained locally');await a.page.clock.runFor(8500);await until(()=>results.length===2,'Exact lost acknowledgement replay');await a.page.clock.resume();
  await a.page.locator('#packet-status').getByText(/другой менеджер/).waitFor();assert.deepEqual(intents[1],intents[0]);assert.equal(results[1].replayed,true);assert.equal(results[1].packet_revision,2);assert.equal(results[1].current_revision,3);
  assert.equal(await a.page.locator('#address').inputValue(),'Synthetic newer typing retained locally');
  const order=(await service.pool.query('SELECT * FROM orders WHERE id=60')).rows[0];assert.equal(order.address,'Москва, newer manager B, 3');assert.equal(order.contacts,'Synthetic current contact B');
  assert.equal(Number((await service.pool.query("SELECT COUNT(*) AS n FROM logs WHERE order_id=60 AND action='packet_updated'")).rows[0].n),2);
  const files=(await service.pool.query('SELECT * FROM order_materials WHERE order_id=60')).rows;assert.equal(files.length,1);assert.ok(Buffer.from(files[0].content).equals(pdf));
  await a.page.locator('#packet-retry').click();await until(async()=>await a.page.locator('#address').inputValue()===order.address,'Explicit reload replaces stale local fields');clean(a);clean(b);
}));

test('a newly supplied source packet blocks delivery until the auditor explicitly reviews it', { timeout:60000 }, t => run(t,async()=>{
  const visit=await openPage(browser,service,1001,{pathname:'/audit?order_id=59'}),{page}=visit;await page.locator('#step-content[aria-busy=false]').waitFor();
  const pdf=multiPagePdf();await prepareReport(page,pdf);await save(page);const before=await service.draft(59),messages=service.messages.length,id=randomUUID();
  await service.pool.query("INSERT INTO order_materials(order_id,id,name,mime,role,bytes,sha256,content) VALUES(59,$1,'Synthetic-new-manager-plan.pdf','application/pdf','plan',$2,$3,$4)",[id,pdf.length,hash(pdf),pdf]);
  await page.locator('#submit-audit').click();await page.getByText('Менеджер изменил данные объекта',{exact:true}).waitFor();await page.getByText('Комплект документов изменился.',{exact:true}).waitFor();
  assert.equal(service.messages.length,messages);assert.equal((await service.pool.query('SELECT id FROM audits WHERE order_id=59')).rows.length,0);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#accept-packet-update').click();await page.getByText('Менеджер изменил данные объекта',{exact:true}).waitFor({state:'hidden'});
  const checked=await service.draft(59);assert.ok(checked.data.request_packet.materials.some(file=>file.id===id));assert.ok(checked.data.packet_rechecks.length);assert.deepEqual(checked.data.plan.annotations,before.data.plan.annotations);
  await page.locator('#submit-audit').click();await page.getByRole('heading',{name:'Отчёт отправлен'}).waitFor();const audit=(await service.pool.query('SELECT report_data FROM audits WHERE order_id=59')).rows[0];assert.ok(audit.report_data.request_packet.materials.some(file=>file.id===id));assert.ok(service.messages.length>messages);clean(visit);
}));
