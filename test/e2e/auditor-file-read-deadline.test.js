'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { createService, openPage, sampleImage, until } = require('./helpers');
let service, browser;
before(async () => { service = await createService(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await service?.close(); });
async function holdPhoneReads(page) {
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    window.heldPhoneReads = [];
    File.prototype.arrayBuffer = function () {
      if (!this.name.startsWith('Held-')) return original.call(this);
      const file = this;
      return new Promise(resolve => { window.heldPhoneReads.push(() => original.call(file).then(resolve)); });
    };
  });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('a stalled phone screenshot times out, releases the actual form queue and permits a byte-exact retry', { timeout: 60000 }, async () => {
  const visit = await openPage(browser, service), { page } = visit;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor();
    await page.locator('[data-choice="workflow.territory_result"][data-value="clear"]').click();
    await page.locator('[data-add-entrance]').click();
    const input = page.locator('input[data-upload-role="entrance"]:not([capture])');
    const original = await sampleImage(page, 'image/jpeg');
    await page.clock.install(); await holdPhoneReads(page);
    await input.setInputFiles({ name: 'Held-entrance.jpg', mimeType: 'image/jpeg', buffer: original });
    await until(() => page.evaluate(() => window.heldPhoneReads.length === 1), 'Native file read starts');
    await page.clock.fastForward('00:31');
    await until(async () => /Не удалось дождаться файла/.test(await page.locator('#save-state').innerText()), 'Stalled read visibly releases');
    assert.equal(await input.inputValue(), '', 'The same picker file can be selected again');
    await page.evaluate(async () => { await Promise.all(window.heldPhoneReads.map(release => release())); });
    await page.clock.resume();
    await input.setInputFiles({ name: 'Retried-entrance.jpg', mimeType: 'image/jpeg', buffer: original });
    await page.getByText('Retried-entrance.jpg', { exact: true }).waitFor();
    const draft = await service.draft(58);
    const files = (await service.pool.query('SELECT * FROM audit_evidence WHERE draft_id=$1', [draft.id])).rows;
    assert.equal(files.length, 1); assert.equal(files[0].name, 'Retried-entrance.jpg');
    assert.equal(files[0].sha256, hash(original)); assert.deepEqual(service.objects.get(files[0].object_key), original);
    await page.reload(); await page.getByText('Retried-entrance.jpg', { exact: true }).waitFor();
    assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally { await visit.context.close(); }
});

test('closing the sheet chooser cancels a stalled phone original without orphan files and the next plan can be selected', { timeout: 60000 }, async () => {
  const visit = await openPage(browser, service, 1001, { pathname: '/audit?order_id=59' }), { page } = visit;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor(); await page.locator('#steps [data-step="1"]').click();
    await page.locator('[data-choice="plan.mode"][data-value="draw"]').click();
    const editor = page.locator('#plan-editor'), dialog = editor.locator('dialog');
    const open = () => editor.getByRole('button', { name: 'Выбрать лист PDF / изображение', exact: true }).click();
    const original = await sampleImage(page, 'image/png'); await holdPhoneReads(page);
    await open(); await dialog.locator('input[type=file]').setInputFiles({ name: 'Held-plan.png', mimeType: 'image/png', buffer: original });
    await until(() => page.evaluate(() => window.heldPhoneReads.length === 1), 'Plan read starts');
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await until(async () => /Выбор файла отменён/.test(await page.locator('#save-state').innerText()), 'Chooser cancellation releases read');
    await page.evaluate(async () => { await Promise.all(window.heldPhoneReads.map(release => release())); });
    await open(); await dialog.locator('input[type=file]').setInputFiles({ name: 'Retried-plan.png', mimeType: 'image/png', buffer: original });
    const use = dialog.getByRole('button', { name: 'Использовать этот лист', exact: true });
    await until(() => use.isEnabled(), 'New plan loads after cancellation'); await use.click();
    await until(async () => !!(await service.draft(59)).data.plan.evidence_id, 'Plan selection saved');
    const draft = await service.draft(59), rows = (await service.pool.query('SELECT * FROM audit_evidence WHERE draft_id=$1', [draft.id])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Retried-plan.png'); assert.equal(rows[0].sha256, hash(original));
    assert.equal(rows[0].id, draft.data.plan.evidence_id); assert.deepEqual(service.objects.get(rows[0].object_key), original);
    await page.reload(); await page.locator('#step-content[aria-busy=false]').waitFor();
    assert.equal((await service.draft(59)).data.plan.evidence_id, rows[0].id);
    assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally { await visit.context.close(); }
});
