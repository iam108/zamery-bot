'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { createService, openPage, multiPagePdf, sampleImage, until, hash } = require('./helpers');

let service, browser;
before(async () => { service = await createService(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await service?.close(); });
const step = (page, index) => page.locator('#steps [data-step="' + index + '"]').click();
const choice = (page, path, value) => page.locator('[data-choice="' + path + '"][data-value="' + value + '"]').click();
const clean = visit => { assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []); };

test('a delayed manager PDF import retains the newer selected page and exposes the saved original without remounting it', { timeout: 60000 }, async () => {
  const pdf = multiPagePdf(), material = randomUUID(), name = 'Synthetic-delayed-manager.pdf';
  await service.pool.query('INSERT INTO order_materials(order_id,id,name,mime,role,bytes,sha256,content) VALUES(58,$1,$2,\'application/pdf\',\'plan\',$3,$4,$5)', [material, name, pdf.length, hash(pdf), pdf]);
  const visit = await openPage(browser, service), { page } = visit; let release;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor(); await step(page, 1);
    const editor = page.locator('#plan-editor'), dialog = editor.locator('dialog');
    const choose = () => editor.getByRole('button', { name: 'Выбрать лист PDF / изображение', exact: true }).click();
    const use = dialog.getByRole('button', { name: 'Использовать этот лист', exact: true });
    await choose(); await dialog.locator('input[type=file]').setInputFiles({ name: 'Synthetic-selected-original.pdf', mimeType: 'application/pdf', buffer: pdf });
    await until(() => use.isEnabled(), 'Original PDF is rendered');
    for (let index = 0; index < 3; index++) { await dialog.getByRole('button', { name: 'Следующая страница' }).click(); await until(() => use.isEnabled(), 'PDF sheet ready'); }
    await use.click(); await dialog.waitFor({ state: 'hidden' }); const before = await service.draft(58);
    assert.equal(before.data.plan.page, 4);
    let started; const waiting = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/audit/orders/58/materials/' + material, async route => { const response = await route.fetch(); started(); await held; return route.fulfill({ response }); });
    await page.locator('.details-block summary').filter({ hasText: 'Выбрать документ из заявки' }).click();
    await page.locator('[data-use-plan="' + material + '"]').click(); await waiting;
    await choose(); await until(() => use.isEnabled(), 'Current sheet preview');
    for (let index = 0; index < 3; index++) { await dialog.getByRole('button', { name: 'Предыдущая страница' }).click(); await until(() => use.isEnabled(), 'Newer sheet ready'); }
    await use.click();
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('audit-wizard-v3:1001:58')).data.plan.page === 1), 'Newer source selection retained locally before its queued PUT');
    release(); await dialog.waitFor({ state: 'hidden' });
    await until(async () => (await service.draft(58)).data.plan.page === 1, 'Newer sheet reaches the server');
    const current = await service.draft(58); assert.equal(current.data.plan.evidence_id, before.data.plan.evidence_id);
    await choose(); await until(async () => await dialog.getByLabel('Исходный документ').locator('option', { hasText: name }).count() === 1, 'Downloaded original remains selectable in the current editor');
    assert.equal(await dialog.getByLabel('Исходный документ').inputValue(), before.data.plan.evidence_id);
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const stored = (await service.pool.query('SELECT * FROM audit_evidence WHERE draft_id=$1 AND name=$2', [before.id, name])).rows;
    assert.equal(stored.length, 1); assert.ok(service.objects.get(stored[0].object_key).equals(pdf)); clean(visit);
  } finally { release?.(); await visit.context.close(); }
});

test('a photo POST lost acknowledgement recovers exact bytes while retaining notes typed during the upload', { timeout: 60000 }, async () => {
  const visit = await openPage(browser, service, 1001, { pathname: '/audit?order_id=59' }), { page } = visit; let release;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor(); await choice(page, 'workflow.territory_result', 'clear');
    await page.locator('[data-add-entrance]').click();
    const jpg = await sampleImage(page, 'image/jpeg'), name = 'Synthetic-lost-ack-photo.jpg'; let posts = 0, started;
    const committed = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/audit/drafts/*/evidence', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++; const response = await route.fetch(); assert.equal(response.status(), 200); started(); await held; return route.abort('failed');
    });
    await page.locator('input[data-upload-role="entrance"]:not([capture])').setInputFiles({ name, mimeType: 'image/jpeg', buffer: jpg }); await committed;
    const note = 'Synthetic observation typed while the original upload was pending';
    await page.locator('[data-bind="workflow.territory_notes"]').fill(note); release();
    await page.getByText(name, { exact: true }).waitFor(); await page.locator('#save-now').click();
    await until(async () => (await service.draft(59)).data.workflow.territory_notes === note, 'Typed observation saved on the recovered upload revision');
    assert.equal(posts, 1); assert.equal(await page.locator('#conflict-panel').isVisible(), false);
    const draft = await service.draft(59), files = (await service.pool.query('SELECT * FROM audit_evidence WHERE draft_id=$1', [draft.id])).rows;
    assert.equal(files.length, 1); assert.equal(files[0].sha256, hash(jpg)); assert.ok(service.objects.get(files[0].object_key).equals(jpg)); clean(visit);
  } finally { release?.(); await visit.context.close(); }
});

test('a confirmed attached-scheme deletion clears the card before its failed metadata save and retries cleanly', { timeout: 60000 }, async () => {
  const visit = await openPage(browser, service, 1001, { pathname: '/audit?order_id=60' }), { page } = visit;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor(); await choice(page, 'workflow.territory_result', 'findings'); await choice(page, 'map.mode', 'attached');
    const name = 'Synthetic-removed-scheme.png';
    await page.locator('[data-territory-upload=attached]').setInputFiles({ name, mimeType: 'image/png', buffer: await sampleImage(page, 'image/png') });
    await page.getByText(name, { exact: true }).waitFor(); await page.locator('#save-now').click();
    await until(async () => !!(await service.draft(60)).data.map.evidence_id, 'Attached scheme selection saved');
    const draft = await service.draft(60); let deleted = false;
    const failedPut = async route => route.request().method() === 'PUT' && deleted ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Synthetic scheme metadata save failed' }) }) : route.continue();
    await page.route('**/api/audit/drafts/' + draft.id, failedPut);
    await page.route('**/api/audit/drafts/' + draft.id + '/evidence/' + draft.data.map.evidence_id, async route => { const response = await route.fetch(); assert.equal(response.status(), 200); deleted = true; return route.fulfill({ response }); });
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Удалить ' + name, exact: true }).click();
    await page.getByText(name, { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('#toast').getByText('Synthetic scheme metadata save failed', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('audit-wizard-v3:1001:60')).data.map.evidence_id), '');
    await page.unroute('**/api/audit/drafts/' + draft.id, failedPut); await page.locator('#save-now').click();
    await until(async () => (await service.draft(60)).data.map.evidence_id === '', 'Retry saves the already-confirmed deletion intent');
    assert.ok((await service.pool.query('SELECT deleted_at FROM audit_evidence WHERE draft_id=$1', [draft.id])).rows[0].deleted_at); clean(visit);
  } finally { await visit.context.close(); }
});

test('an accepted photo album with a lost Telegram acknowledgement survives reopening and requires explicit duplicate-risk consent', { timeout: 60000 }, async () => {
  const visit=await openPage(browser,service,1001,{pathname:'/audit?order_id=61'}),{page}=visit;
  const telegram=require('../../src/bot/instance').telegram,sendAlbum=telegram.sendMediaGroup;let lose=true;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor();await choice(page,'building_type','Нежилое');await choice(page,'workflow.territory_result','clear');
    await page.locator('[data-add-entrance]').click();
    await page.locator('input[data-upload-role="entrance"]:not([capture])').setInputFiles({name:'Synthetic-unknown-album.jpg',mimeType:'image/jpeg',buffer:await sampleImage(page,'image/jpeg')});
    await page.getByText('Synthetic-unknown-album.jpg',{exact:true}).waitFor();await step(page,1);
    const editor=page.locator('#plan-editor'),dialog=editor.locator('dialog');
    await editor.getByRole('button',{name:'Выбрать лист PDF / изображение',exact:true}).click();
    await dialog.locator('input[type=file]').setInputFiles({name:'Synthetic-unknown-plan.pdf',mimeType:'application/pdf',buffer:multiPagePdf()});
    const use=dialog.getByRole('button',{name:'Использовать этот лист',exact:true});await until(()=>use.isEnabled(),'Plan sheet rendered');await use.click();
    const canvas=editor.getByLabel('План помещения для разметки');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();assert.ok(box);
    for(const[x,y]of [[.15,.18],[.77,.18],[.77,.78],[.15,.78]])await page.touchscreen.tap(box.x+x*box.width,box.y+y*box.height);
    await editor.getByRole('button',{name:'Замкнуть контур'}).click();await editor.getByRole('button',{name:'Сохранить разметку'}).click();
    for(const name of ['floor_plan','floor_actual','cadastral_count'])await page.locator('[data-bind="inspection.'+name+'"]').fill('1');
    for(const[path,value]of [['inspection.within_cadastral','Да'],['inspection.rooms_complete','Да'],['to','Не нужно'],['bti','Да'],['inspection.alcohol_present','Нет'],['inspection.kkt_count','1'],['inspection.kkt_ip','Нет']])await choice(page,path,value);
    await step(page,2);await page.locator('[data-bind="workflow.conclusion_status"]').selectOption('ready');
    telegram.sendMediaGroup=async(...args)=>{const receipt=await sendAlbum(...args);if(lose){lose=false;throw new Error('Synthetic network loss after Telegram accepted the album');}return receipt;};
    const before=service.messages.length;await page.locator('#submit-audit').click();
    const retry=page.locator('#retry-unknown-delivery');await retry.waitFor({state:'visible'});
    assert.equal(await page.locator('#submit-audit').isDisabled(),true);
    const unknown=await service.draft(61);assert.equal(unknown.delivery.inflight.stage,'photos');const cursor=unknown.delivery.inflight.id;
    assert.equal((await service.pool.query('SELECT id FROM audits WHERE order_id=61')).rows.length,0);
    await page.reload();await retry.waitFor({state:'visible'});assert.equal((await service.draft(61)).delivery.inflight.id,cursor);
    page.once('dialog',dialog=>dialog.dismiss());await retry.click();
    assert.equal(service.messages.slice(before).filter(event=>event.method==='sendMediaGroup').length,1);
    page.once('dialog',dialog=>dialog.accept());await retry.click();await page.getByRole('heading',{name:'Отчёт отправлен'}).waitFor();
    const events=service.messages.slice(before);assert.equal(events.filter(event=>event.method==='sendMessage').length,1,'Confirmed summary remains single');
    assert.equal(events.filter(event=>event.method==='sendMediaGroup').length,2,'Only the explicitly authorized unknown album can repeat');
    assert.equal(events.filter(event=>event.method==='sendDocument').length,1,'Original ZIP is sent once after album confirmation');
    assert.equal((await service.pool.query('SELECT id FROM audits WHERE order_id=61')).rows.length,1);
    const done=(await service.pool.query('SELECT * FROM audit_drafts WHERE id=$1',[unknown.id])).rows[0];assert.ok(done.submitted_at);assert.equal(done.delivery.inflight,undefined);assert.equal(done.delivery.lastRiskRetryCursor,cursor);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS count FROM audit_evidence WHERE draft_id=$1',[unknown.id])).rows[0].count,3);clean(visit);
  }finally{telegram.sendMediaGroup=sendAlbum;await visit.context.close();}
});
