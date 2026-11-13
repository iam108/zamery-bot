'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { createService, openPage, multiPagePdf, until, LAWYER } = require('./helpers');

const manager = 2001;
const organization = 'ООО «ТЕСТОВАЯ ДОРАБОТКА»';
const reason = 'Приложите договор аренды\nУточните контакт арендатора';
const resolution = 'Договор приложен. Контакт арендатора уточнён.';
const fileName = 'Договор аренды.pdf';
const artifacts = path.resolve(process.env.E2E_ARTIFACTS_DIR || 'test-results/e2e');

function apiResponse(page, pathname, action) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST' &&
    (!action || response.request().postDataJSON()?.action === action));
}

function notices(service, target) {
  return service.messages.filter(message => message.method === 'sendMessage' && String(message.args[0]) === String(target));
}

test('lawyer returns a client, original manager sees it after reopen and attaches a correction before returning it', { timeout: 90000 }, async () => {
  let service, browser;
  const visits = [];
  try {
    service = await createService({ master: true, clientsGroup: '-1001000000002', privateChats: [manager] });
    browser = await chromium.launch();
    await fs.mkdir(artifacts, { recursive: true });
    const reportId = (await service.pool.query(`INSERT INTO audits(order_id,text,chat_id,msg_ids,report_data)
      VALUES(58,$1,NULL,'{}','{}') RETURNING id`, ['Выезд проведён'])).rows[0].id;
    const checkpoint = { version: 2, completed: true, fields: {},
      body: { order_id: 58, report_src: 'a', report_id: reportId, submit_id: randomUUID() },
      packet: { order: { id: 58 }, report: { src: 'a', id: reportId, order_id: 58, text: 'Выезд проведён', media: [] }, materials: [] },
      egrn: { completed: true, result: 'none' },
    };
    const originalData = { _stage: 'Сбор документов', _comment: 'Отметка по делу', _handoff: checkpoint };
    const { id: client } = (await service.pool.query(`INSERT INTO cases(order_id,lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data)
      VALUES(58,$1,'Synthetic lawyer',$2,'Москва, Тестовая улица, 58','МСК','Магазин','Продление','MSK_MAG',$3,$4) RETURNING id`,
    [LAWYER, organization, manager, originalData])).rows[0];
    const open = async (actor, pathname, mobile = true) => {
      const visit = await openPage(browser, service, actor, { pathname, mobile });
      visits.push(visit);
      return visit.page;
    };
    const casePath = '/checklist?case_id=' + client;
    const lawyer = await open(LAWYER, casePath);
    const panel = lawyer.locator('#rework-panel');
    await panel.getByRole('button', { name: 'Вернуть на доработку' }).click();
    await panel.getByRole('button', { name: 'Отправить менеджеру' }).click();
    await panel.getByText('Заполните это поле.').waitFor();
    assert.equal(service.messages.length, 0, 'A blank return cannot notify anyone');

    // Lose only the browser response, after the real endpoint has committed
    // the return and received a Telegram receipt. Retrying reuses its UUID.
    let firstAttempt, retries = 0;
    await lawyer.route('**/api/checklist/request', async route => {
      const body = route.request().postDataJSON();
      if (body.action !== 'return_for_rework') return route.continue();
      const response = await route.fetch();
      const result = await response.json();
      assert.equal(result.rework.requests[0].return_delivery, 'confirmed');
      if (retries++ === 0) { firstAttempt = body.request_id; return route.abort('failed'); }
      assert.equal(body.request_id, firstAttempt);
      return route.fulfill({ response });
    });
    await panel.getByLabel('Что нужно доработать').fill(reason);
    await panel.screenshot({ path: path.join(artifacts, 'mobile-lawyer-return-form.png') });
    await panel.getByRole('button', { name: 'Отправить менеджеру' }).click();
    await until(() => panel.getByRole('alert').textContent().then(Boolean), 'Lost return acknowledgement becomes visible');
    assert.equal(await panel.getByLabel('Что нужно доработать').inputValue(), reason);
    await panel.getByRole('button', { name: 'Отправить менеджеру' }).click();
    await panel.getByText('На доработке у менеджера').waitFor();
    await panel.getByText('Уведомление доставлено в Telegram.').waitFor();
    assert.equal(retries, 2);
    assert.equal(notices(service, manager).length, 1, 'The manager gets one return notification after lost ACK and retry');
    const [returnMessage] = notices(service, manager);
    assert.ok(returnMessage.args[1].includes(reason));
    const managerLink = new URL(returnMessage.args[2].reply_markup.inline_keyboard[0][0].web_app.url);
    assert.equal(managerLink.pathname, '/checklist');
    assert.equal(managerLink.searchParams.get('case_id'), String(client));
    assert.equal(managerLink.searchParams.get('rework'), '1');
    assert.equal(managerLink.searchParams.has('k'), false);

    const other = await open(2002, casePath);
    const otherView = await other.evaluate(async id => {
      const response = await fetch('/api/checklist/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_rework', case_id: id }) });
      return response.json();
    }, client);
    assert.deepEqual(otherView, { ok: true, rework: null });
    assert.equal(await other.getByText(reason).isVisible(), false);

    const managerPage = await open(manager, managerLink.pathname + managerLink.search, false);
    const managerPanel = managerPage.locator('#rework-panel');
    await managerPanel.getByText('На доработке у менеджера').waitFor();
    assert.ok((await managerPanel.innerText()).includes(reason));
    await managerPage.reload();
    await managerPanel.getByText('На доработке у менеджера').waitFor();
    assert.ok((await managerPanel.innerText()).includes(reason));
    await managerPanel.screenshot({ path: path.join(artifacts, 'desktop-manager-rework.png') });

    await managerPanel.getByRole('link', { name: 'Документы клиента' }).click();
    await managerPage.waitForURL(url => url.pathname === '/handoff' && url.searchParams.get('case_id') === String(client));
    await managerPage.getByRole('button', { name: 'Прикрепить документы' }).waitFor();
    const upload = apiResponse(managerPage, '/api/handoff/manual-materials');
    await managerPage.locator('#extra-document-input').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: multiPagePdf() });
    assert.equal((await upload).status(), 200);
    await managerPage.locator('#extra-document-list').getByText(fileName).waitFor();
    const send = apiResponse(managerPage, '/api/handoff/cases/' + client + '/documents');
    await managerPage.getByRole('button', { name: 'Дослать документы' }).click();
    const documentResult = await (await send).json();
    assert.equal(documentResult.delivery_complete, true, JSON.stringify(documentResult));
    await managerPage.locator('#extra-document-history').getByRole('button', { name: new RegExp(fileName) }).waitFor();
    await managerPage.getByRole('button', { name: 'К доработке', exact: true }).click();
    await managerPage.waitForURL(url => url.pathname === '/checklist' && url.searchParams.get('rework') === '1');
    await managerPanel.getByRole('button', { name: 'Сообщить о доработке' }).click();
    await managerPanel.getByLabel('Что уточнили или приложили').fill(resolution);
    const completed = apiResponse(managerPage, '/api/checklist/request', 'resolve_rework');
    await managerPanel.getByRole('button', { name: 'Вернуть юристу' }).click();
    const response = await (await completed).json();
    assert.equal(response.rework.requests[0].status, 'resolved');
    assert.equal(response.rework.requests[0].resolution_delivery, 'confirmed');
    const [resolutionMessage] = notices(service, LAWYER);
    assert.equal(notices(service, LAWYER).length, 1);
    assert.ok(resolutionMessage.args[1].includes(resolution));
    assert.equal(service.messages.filter(message => message.method === 'sendDocument' && String(message.args[0]) === String(LAWYER)).length, 1);

    await lawyer.reload();
    await panel.getByText('История доработок', { exact: false }).click();
    await panel.getByText('Доработка завершена').waitFor();
    assert.ok((await panel.innerText()).includes(reason));
    assert.ok((await panel.innerText()).includes(resolution));
    assert.equal(notices(service, manager).length, 1);
    assert.equal(notices(service, LAWYER).length, 1);
    const caseData = (await service.pool.query('SELECT data FROM cases WHERE id=$1', [client])).rows[0].data;
    assert.deepEqual(caseData, originalData, 'Return and resolution preserve checklist and handoff state');
    assert.equal((await service.pool.query('SELECT id FROM cases WHERE order_id=58')).rows.length, 1);
    assert.equal(service.messages.filter(message => String(message.args[0]).startsWith('-')).length, 0);
    assert.equal(service.egrnRequests.length, 0);
    for (const visit of visits) {
      assert.deepEqual(visit.errors, []);
      assert.deepEqual(visit.blocked, []);
    }
  } finally {
    for (const visit of visits) await visit.context.close();
    if (browser) await browser.close();
    if (service) await service.close();
  }
});
