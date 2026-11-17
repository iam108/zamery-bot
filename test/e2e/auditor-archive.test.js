'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { compactVisit } = require('../helpers/audit-v5');
const { AUDITOR, GROUP, createService, hash, multiPagePdf, openPage, sampleImage, until } = require('./helpers');

let service, browser;
before(async () => {
  service = await createService({ master: true });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await service?.close();
});

const order = 58;
const archiveUrl = 'https://disk.yandex.ru/d/syntheticArchive58';
const field = (page, key) => page.locator(`[data-bind="${key}"]`);
const choice = (page, key, value) => page.locator(`[data-choice="${key}"][data-value="${value}"]`);
const step = (page, index) => page.locator(`#steps [data-step="${index}"]`).click();

async function openAudit(orderId = order) {
  const visit = await openPage(browser, service, AUDITOR, { pathname: `/audit?order_id=${orderId}` });
  await visit.page.locator('#step-content[aria-busy=false]').waitFor();
  return visit;
}

async function reopenAudit(visit) {
  const url = visit.page.url();
  await visit.page.close();
  const page = await visit.context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => visit.errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#step-content[aria-busy=false]').waitFor();
  return page;
}

async function seedRenewal() {
  await service.pool.query("UPDATE orders SET service='Продление',archive_url=$1 WHERE id=$2", [archiveUrl, order]);
  const initial = await openAudit();
  try {
    const draft = await service.draft(order);
    const data = compactVisit('catering', 'Продление');
    data.order_id = order;
    data.request_packet = draft.data.request_packet;
    Object.assign(data.inspection, {
      org: draft.data.inspection.org,
      address: draft.data.inspection.address,
      archive_match: '',
      licensed_boundaries_match: '',
    });
    Object.assign(data.workflow, { step: 0, territory_result: 'clear', archive_review: '' });
    data.map = { evidence_id: '', page: 1, annotations: [] };
    data.evidence = data.evidence.filter(file => !['map', 'map-source'].includes(file.role));
    const buffers = {
      'application/pdf': multiPagePdf(),
      'image/jpeg': await sampleImage(initial.page, 'image/jpeg'),
      'image/png': await sampleImage(initial.page, 'image/png'),
    };
    for (const file of data.evidence) {
      const content = buffers[file.mime];
      Object.assign(file, { bytes: content.length, sha256: hash(content) });
      await service.pool.query('INSERT INTO audit_evidence(draft_id,id,name,mime,role,subject_id,bytes,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [draft.id, file.id, file.name, file.mime, file.role, file.subject_id, file.bytes, file.sha256, content]);
    }
    data.plan.preview_evidence_id = data.evidence.find(file => file.role === 'plan').id;
    await service.pool.query('UPDATE audit_drafts SET data=$1,revision=revision+1 WHERE id=$2', [JSON.stringify(data), draft.id]);
    assert.deepEqual(data.request_packet.materials, []);
    assert.equal(data.request_packet.archive_url, archiveUrl);
  } finally {
    await initial.context.close();
  }
}

test('a matching-plan comment survives a save outage and closing the mobile form', { timeout: 30000 }, async () => {
  const orderId = 59;
  const note = 'всё в границах, всё ок';
  const visit = await openAudit(orderId);
  try {
    await step(visit.page, 1);
    await choice(visit.page, 'bti', 'Да').click();
    await visit.page.locator('[data-choice="bti"][data-value="Да"][aria-pressed="true"]').waitFor();
    const comment = field(visit.page, 'inspection.plan_note');
    assert.ok(await comment.isVisible(), 'The plan comment is available even when the plan matches');
    await until(async () => (await visit.page.locator('#save-state').textContent()).includes('Сохранено на сервере'),
      'The matching-plan choice is acknowledged before simulating a save outage');
    let rejectedWrites = 0;
    await visit.page.route('**/api/audit/drafts/*', async route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      rejectedWrites++;
      return route.fulfill({ status: 503, json: { ok: false, error: 'Synthetic write outage' } });
    });
    await comment.fill(note);
    await until(() => rejectedWrites > 0, 'The autosave encounters the simulated outage');
    assert.equal((await service.draft(orderId)).data.inspection.plan_note, '');
    const reopened = await reopenAudit(visit);
    assert.equal(await field(reopened, 'inspection.plan_note').inputValue(), note);
    await until(async () => (await service.draft(orderId))?.data.inspection.plan_note === note,
      'The last edit reaches the server after reopening, without using the save button');
    assert.deepEqual(visit.errors, []);
    assert.deepEqual(visit.blocked, []);
  } finally {
    await visit.context.close();
  }
});

test('a mobile renewal with an external archive preserves the confirmed comparison and matching-plan note through reopen and delivery', { timeout: 60000 }, async () => {
  await seedRenewal();
  const note = 'всё в границах, всё ок';
  const visit = await openAudit();
  let fresh;
  try {
    const { page } = visit;
    const compared = choice(page, 'workflow.archive_review', 'checked');
    assert.ok(await compared.isVisible(), 'The external archive has an explicit comparison choice');
    assert.equal(await compared.innerText(), 'Сверено');
    assert.equal(await compared.getAttribute('aria-pressed'), 'false');
    await compared.click();
    await step(page, 1);
    assert.equal(await compared.getAttribute('aria-pressed'), 'true');
    await choice(page, 'inspection.archive_match', 'Да').click();
    await choice(page, 'inspection.licensed_boundaries_match', 'Да').click();
    assert.equal(await choice(page, 'bti', 'Да').getAttribute('aria-pressed'), 'true');
    await field(page, 'inspection.plan_note').fill(note);
    await step(page, 2);
    await page.locator('.report-preview summary').click();
    const preview = page.locator('.report-preview');
    await preview.getByText('Сверено · планировка совпадает', { exact: true }).waitFor();
    await preview.getByText(note, { exact: false }).waitFor();
    assert.equal(await page.locator('#report-feedback [data-report-group="required"]').count(), 0);
    assert.doesNotMatch(await page.locator('#report-feedback').textContent() ?? '', /Архив не предоставлен|Графика не приложена|Сверка с архивом не выполнена/i);
    const reopened = await reopenAudit(visit);
    await reopened.locator('#steps [data-step="2"][aria-current="step"]').waitFor();
    await until(async () => {
      const saved = (await service.draft(order))?.data;
      return saved?.inspection.plan_note === note && saved.workflow.step === 2;
    }, 'The plan note and report step are preserved on the server after reopening');
    fresh = await openAudit();
    await fresh.page.locator('#steps [data-step="2"][aria-current="step"]').waitFor();
    await step(fresh.page, 1);
    assert.equal(await field(fresh.page, 'inspection.plan_note').inputValue(), note);
    await step(fresh.page, 2);
    assert.equal(await fresh.page.locator('#submit-audit').innerText(), 'Отправить отчёт');
    await fresh.page.locator('#submit-audit').click();
    await fresh.page.getByRole('heading', { name: 'Отчёт отправлен', exact: true }).waitFor();
    const audits = (await service.pool.query('SELECT text,report_data FROM audits WHERE order_id=$1', [order])).rows;
    assert.equal(audits.length, 1);
    const [audit] = audits;
    assert.equal(audit.report_data.workflow.archive_review, 'checked');
    assert.equal(audit.report_data.inspection.archive_match, 'Да');
    assert.equal(audit.report_data.inspection.licensed_boundaries_match, 'Да');
    assert.equal(audit.report_data.inspection.plan_note, note);
    assert.match(audit.text, /Архив: .*сверено/i);
    assert.match(audit.text, /Лицензированные границы: сохранены/i);
    assert.ok(audit.text.includes(note));
    const telegram = [...service.originals.values()].filter(item => item.chat === GROUP);
    assert.equal(telegram.filter(item => item.kind === 'sendMessage' && item.text?.includes(note)).length, 1,
      'The Telegram summary includes the matching-plan comment');
    const reports = telegram.filter(item => item.bytes?.toString('utf8') === audit.text);
    assert.equal(reports.length, 1, 'The full Telegram report includes the note and archive comparison');
    assert.deepEqual(service.egrnRequests, []);
    assert.deepEqual(visit.errors.concat(fresh.errors), []);
    assert.deepEqual(visit.blocked.concat(fresh.blocked), []);
  } finally {
    await visit.context.close();
    await fresh?.context.close();
  }
});
