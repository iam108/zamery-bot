'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createService, openPage, multiPagePdf, sampleImage, until } = require('./helpers');
let service, browser;
before(async () => { service = await createService(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await service?.close(); });
async function holdWorker(page) {
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { started = resolve; });
  const handler = async route => { started(); await held; try { await route.continue(); } catch (_) {} };
  await page.route('**/vendor/pdfjs/pdf.worker.mjs', handler);
  return { waiting, async release() { release(); await page.unroute('**/vendor/pdfjs/pdf.worker.mjs', handler); } };
}
test('a stalled PDF worker releases source upload, preserves the selected original and allows a six-page retry', { timeout: 60000 }, async () => {
  const visit = await openPage(browser, service), { page } = visit; let worker;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor(); await page.locator('#steps [data-step="1"]').click();
    await page.locator('[data-choice="plan.mode"][data-value="draw"]').click();
    const editor = page.locator('#plan-editor'), dialog = editor.locator('dialog');
    const choose = () => editor.getByRole('button', { name: 'Выбрать лист PDF / изображение', exact: true }).click();
    const use = dialog.getByRole('button', { name: 'Использовать этот лист', exact: true });
    await choose(); await dialog.locator('input[type=file]').setInputFiles({ name: 'Synthetic retained source.png', mimeType: 'image/png', buffer: await sampleImage(page, 'image/png') });
    await until(() => use.isEnabled(), 'Initial image source ready'); await use.click();
    await until(async () => !!(await service.draft(58)).data.plan.evidence_id, 'Initial source selection saved');
    const previous = (await service.draft(58)).data.plan.evidence_id;
    await page.clock.install(); worker = await holdWorker(page); await choose();
    await dialog.locator('input[type=file]').setInputFiles({ name: 'Synthetic cancelled PDF.pdf', mimeType: 'application/pdf', buffer: multiPagePdf() }); await worker.waiting;
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.locator('#save-state').getByText('Выбор файла отменён.', { exact: true }).waitFor();
    assert.equal(await dialog.locator('input[type=file]').inputValue(), '', 'Reopening can select the same cancelled native file again');
    assert.equal((await service.draft(58)).data.plan.evidence_id, previous);
    await worker.release(); worker = await holdWorker(page); await choose();
    await dialog.locator('input[type=file]').setInputFiles({ name: 'Synthetic stalled PDF.pdf', mimeType: 'application/pdf', buffer: multiPagePdf() }); await worker.waiting;
    await page.clock.fastForward('05:00');
    assert.equal(await dialog.getByRole('button', { name: 'Добавить файл', exact: true }).isDisabled(), false);
    assert.match(await page.locator('#save-state').innerText(), /Файл не загружен/);
    assert.equal((await service.draft(58)).data.plan.evidence_id, previous);
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click(); await worker.release(); worker = null; await page.clock.resume();
    await choose(); await dialog.locator('input[type=file]').setInputFiles({ name: 'Synthetic retry six pages.pdf', mimeType: 'application/pdf', buffer: multiPagePdf() });
    await until(() => use.isEnabled(), 'Retry PDF ready'); await dialog.getByText('Страница 1 из 6', { exact: true }).waitFor();
    for (let i = 0; i < 3; i++) { await dialog.getByRole('button', { name: 'Следующая страница' }).click(); await until(() => use.isEnabled(), 'Retry sheet rendered'); }
    await use.click(); await until(async () => (await service.draft(58)).data.plan.page === 4, 'Retry sheet saved');
    const draft = await service.draft(58), files = (await service.pool.query('SELECT name FROM audit_evidence WHERE draft_id=$1', [draft.id])).rows;
    assert.equal(files.some(file => file.name === 'Synthetic stalled PDF.pdf'), false);
    assert.equal(files.some(file => file.name === 'Synthetic cancelled PDF.pdf'), false);
    assert.ok(draft.data.plan.versions.some(version => version.evidence_id === previous));
    await choose(); await dialog.locator('input[type=file]').setInputFiles({ name: 'Synthetic malformed PDF.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nNot a PDF document') });
    await until(async () => /Не удалось прочитать PDF/.test(await page.locator('#save-state').innerText()), 'Malformed PDF rejected');
    assert.equal((await service.draft(58)).data.plan.evidence_id, draft.data.plan.evidence_id);
    assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []); assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally { await worker?.release(); await visit.context.close(); }
});
test('rendering an existing PDF cannot keep export pending after its worker deadline', { timeout: 60000 }, async () => {
  const visit = await openPage(browser, service, 1001, { pathname: '/audit?order_id=59' }), { page } = visit; let worker;
  try {
    await page.locator('#step-content[aria-busy=false]').waitFor(); await page.clock.install(); worker = await holdWorker(page);
    await page.evaluate(base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), source = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const host = document.createElement('div'); document.body.appendChild(host);
      window.pdfDeadlineProbe = { settled: false };
      const plan = { evidence_id: 'saved-original', page: 4, annotations: [] };
      const editor = AuditPlanEditor.mount(host, { kind: 'plan', getState: () => plan, onChange: async () => {},
        evidence: [{ id: 'saved-original', name: 'Saved six-page PDF.pdf', mime: 'application/pdf', role: 'plan-source' }], evidenceUrl: async () => source });
      window.pdfDeadlineCleanup = () => { editor.destroy(); URL.revokeObjectURL(source); host.remove(); };
      editor.exportPreview().then(value => { window.pdfDeadlineProbe = { settled: true, value }; }, error => { window.pdfDeadlineProbe = { settled: true, error: error.message }; });
    }, multiPagePdf().toString('base64'));
    await worker.waiting; await page.clock.fastForward('05:00');
    const result = await page.evaluate(() => window.pdfDeadlineProbe); assert.equal(result.settled, true); assert.equal(result.value, null);
    await page.evaluate(() => window.pdfDeadlineCleanup()); assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally { await worker?.release(); await visit.context.close(); }
});
