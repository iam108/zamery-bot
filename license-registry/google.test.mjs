import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { GoogleSheetsClient, REGISTRY_HEADERS } from './google.mjs';
import { hash } from './state.mjs';
import { parseSheetRows, planSheetUpsert } from './core.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { client_email: 'registry@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), private_key_id: 'test-key' };
const id = 'registry-sheet'; const title = 'Реестр лицензий';
const now = () => new Date('2026-11-02T09:00:00.000Z');
const license = { inn: '9705148570', kpp: '770501001', organization: '', licenseNumber: '77РПО0021680',
  issueDate: '2026-10-28', expiryDate: '2027-10-27', activity: 'Розничная продажа, общепит',
  address: 'Москва, Средний Овчинниковский переулок, дом 3', status: 'действующая',
  changeDate: '2026-10-28', email: 'horoshot.msk@example.test' };
function existingRow() {
  const row = Array(17).fill('');
  Object.assign(row, { 0: 'TRUE', 1: 'ЛРС', 2: '100000', 3: 'https://example.test/documents',
    4: 'ООО «ХОРОШОТ»', 5: 'My brand', 6: license.inn, 8: '28 окт. 2026', 9: '27 окт. 2027',
    10: 'Общепит ', 11: license.address, 12: 'Менеджер', 13: '555', 14: 'private-chat', 16: 'Ручной комментарий' });
  return row;
}
function jobAndPlan(values, { rowNumber, selectedLicense = license, organization = 'ООО «ХОРОШОТ»' } = {}) {
  const job = { id: 'job', inn: selectedLicense.inn, organization, operation: 'issuance',
    reportedDate: '2026-10-28', sourceEventKey: 'telegram:5164597211:62436', selectedLicense };
  const plan = planSheetUpsert(selectedLicense, parseSheetRows(values), job);
  assert.ok(['update', 'append', 'noop'].includes(plan.action), JSON.stringify(plan));
  if (plan.action === 'append') {
    plan.rowNumber = rowNumber ?? values.length + 1;
    plan.updates = plan.updates.map((u) => ({ ...u, row: plan.rowNumber }));
  }
  const expectedCells = Object.fromEntries(plan.updates.map((u) => [`${u.column}${u.row}`, u.after]));
  if (plan.action === 'noop') Object.assign(expectedCells, { [`G${plan.rowNumber}`]: selectedLicense.inn,
    [`H${plan.rowNumber}`]: selectedLicense.licenseNumber, [`I${plan.rowNumber}`]: selectedLicense.issueDate,
    [`J${plan.rowNumber}`]: selectedLicense.expiryDate });
  const unsigned = { ...plan, expectedCells, spreadsheetId: id, sheetName: title };
  return { job, plan: { ...unsigned, hash: hash(unsigned), createdAt: '2026-11-02T08:59:00.000Z' } };
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
function mockGoogle(initial, { gridRows = 10, tables = [], beforeRead, afterBatch, headers } = {}) {
  const values = structuredClone(initial);
  if (headers) values[0] = headers;
  const batches = []; const calls = []; const notes = new Map([['2:7', 'Existing human note']]);
  let rowReads = 0;
  let metadata = { spreadsheetId: id, properties: { title, locale: 'ru_RU', timeZone: 'Europe/Moscow' },
    sheets: [{ properties: { sheetId: 0, title, gridProperties: { rowCount: gridRows, columnCount: 22 } }, tables: structuredClone(tables) }] };
  const extraCells = new Map();
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl); calls.push({ url: url.toString(), options });
    if (url.origin === 'https://oauth2.googleapis.com') {
      const p = new URLSearchParams(options.body);
      const parts = p.get('assertion').split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url')), true);
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
      assert.equal(payload.scope, 'https://www.googleapis.com/auth/spreadsheets');
      assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
      return response({ access_token: 'SECRET_TEST_TOKEN', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer SECRET_TEST_TOKEN');
    if (url.pathname.endsWith(':batchUpdate')) {
      const body = JSON.parse(options.body); batches.push(body);
      for (const request of body.requests) {
        if (request.appendDimension) metadata.sheets[0].properties.gridProperties.rowCount += request.appendDimension.length;
        if (request.updateTable) metadata.sheets[0].tables.find((t) => t.tableId === request.updateTable.table.tableId).range = structuredClone(request.updateTable.table.range);
        if (request.updateCells) {
          const { rowIndex, columnIndex } = request.updateCells.start;
          while (values.length <= rowIndex) values.push([]);
          const cell = request.updateCells.rows[0].values[0];
          const v = cell.userEnteredValue;
          values[rowIndex][columnIndex] = v.stringValue ?? new Date((v.numberValue - 25569) * 86_400_000).toISOString().slice(0, 10);
        }
      }
      if (afterBatch) afterBatch(values);
      return response({ spreadsheetId: id, replies: body.requests.map(() => ({})) });
    }
    if (url.pathname.includes('/values/')) return response({ values });
    if (url.searchParams.has('ranges')) {
      const row = Number(url.searchParams.get('ranges').match(/!A(\d+):Q/)[1]);
      rowReads += 1;
      if (beforeRead) beforeRead({ rowReads, values, extraCells });
      const cells = Array.from({ length: 17 }, (_, index) => {
        const v = values[row - 1]?.[index] ?? '';
        return { formattedValue: String(v), ...(v === '' ? {} : { userEnteredValue: { stringValue: String(v) } }),
          ...([8, 9].includes(index) ? { effectiveFormat: { numberFormat: { type: 'DATE', pattern: 'dd mmm yyyy' } } } : {}),
          ...(notes.has(`${row}:${index}`) ? { note: notes.get(`${row}:${index}`) } : {}),
          ...(extraCells.get(`${row}:${index}`) ?? {}) };
      });
      return response({ spreadsheetId: id, sheets: [{ properties: metadata.sheets[0].properties,
        data: [{ startRow: row - 1, startColumn: 0, rowData: [{ values: cells }] }] }] });
    }
    return response(metadata);
  };
  return { fetchImpl, values, batches, calls, metadata, notes };
}
function client(mock, options = {}) { return new GoogleSheetsClient({ spreadsheetId: id, sheetName: title,
  sheetId: 0, credentials, fetchImpl: mock.fetchImpl, now, ...options }); }

test('server JWT is signed, scoped to Sheets, and reused while reading a bounded context', async () => {
  const mock = mockGoogle([[...REGISTRY_HEADERS], existingRow()]);
  const result = await client(mock).context();
  assert.equal(result.startRow, 1);
  assert.equal(result.values.length, 2);
  assert.equal(mock.calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com')).length, 1);
  const range = decodeURIComponent(new URL(mock.calls.find((c) => c.url.includes('/values/')).url).pathname);
  assert.ok(range.endsWith("'Реестр лицензий'!A1:Q10"));
});

test('update only writes planned H/P cells, preserves manual fields and notes, and returns verified readback', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()];
  const mock = mockGoogle(values); const { job, plan } = jobAndPlan(values);
  const result = await client(mock).applyPlan(plan, job);
  assert.equal(result.verified, true); assert.equal(result.planHash, plan.hash);
  assert.deepEqual(result.cells, { H2: license.licenseNumber, P2: license.email,
    G2: license.inn, I2: license.issueDate, J2: license.expiryDate });
  assert.deepEqual(mock.batches[0].requests.map((r) => r.updateCells.start.columnIndex), [7, 15]);
  assert.ok(mock.batches[0].requests.every((r) => r.updateCells.fields === 'userEnteredValue'));
  for (const i of [0, 1, 2, 3, 5, 12, 13, 14, 16]) assert.equal(mock.values[1][i], values[1][i]);
  assert.equal(mock.notes.get('2:7'), 'Existing human note');
});

test('a changed header stops a write before batchUpdate', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()];
  const mock = mockGoogle(values, { headers: [...REGISTRY_HEADERS].map((v, i) => i === 7 ? 'Другая колонка' : v) });
  const { job, plan } = jobAndPlan(values);
  await assert.rejects(client(mock).applyPlan(plan, job), { code: 'sheet_structure_changed' });
  assert.equal(mock.batches.length, 0);
});

test('human sorting relocates the row and makes the saved plan stale', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; const { job, plan } = jobAndPlan(values);
  const other = existingRow(); other[6] = '9721255266'; other[4] = 'ООО ДРУГОЕ';
  const mock = mockGoogle([[...REGISTRY_HEADERS], other, existingRow()]);
  await assert.rejects(client(mock).applyPlan(plan, job), { code: 'sheet_plan_stale' });
  assert.equal(mock.batches.length, 0);
});

test('a freshly inserted email formula is preserved even if it displays an empty string', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; const { job, plan } = jobAndPlan(values);
  const mock = mockGoogle(values, { beforeRead: ({ extraCells }) => extraCells.set('2:15', {
    formattedValue: '', userEnteredValue: { formulaValue: '=IF(TRUE,"","")' } }) });
  await assert.rejects(client(mock).applyPlan(plan, job), { code: 'sheet_plan_stale' });
  assert.equal(mock.batches.length, 0);
});

test('a lost write acknowledgement is recovered by verified readback without another write', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; const { job, plan } = jobAndPlan(values);
  const alreadyWritten = structuredClone(values); alreadyWritten[1][7] = license.licenseNumber; alreadyWritten[1][15] = license.email;
  const mock = mockGoogle(alreadyWritten);
  assert.equal((await client(mock).applyPlan(plan, job)).verified, true);
  assert.equal(mock.batches.length, 0);
});

test('the original committed plan remains verifiable when a duplicate row is later introduced', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; const { job, plan } = jobAndPlan(values);
  const written = existingRow(); written[7] = license.licenseNumber; written[15] = license.email;
  const mock = mockGoogle([[...REGISTRY_HEADERS], written, [...written]]);
  const receipt = await client(mock).applyPlan(plan, job);
  assert.equal(receipt.planHash, plan.hash);
  assert.equal(mock.batches.length, 0);
});

test('matching INN, license number and dates do not acknowledge a different licensed object', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; const { job, plan } = jobAndPlan(values);
  const otherObject = existingRow(); otherObject[7] = license.licenseNumber; otherObject[15] = license.email;
  otherObject[11] = 'Москва, другая улица, дом 100';
  const mock = mockGoogle([[...REGISTRY_HEADERS], otherObject]);
  await assert.rejects(client(mock).applyPlan(plan, job), { code: 'sheet_plan_stale' });
  assert.equal(mock.batches.length, 0);
});

test('append grows the grid and actual native table, copies only formatting/validation, and types dates as serials', async () => {
  const prior = existingRow(); prior[4] = 'ООО ДРУГОЕ'; prior[6] = '9721255266'; prior[7] = '77РПО0021046';
  const values = [[...REGISTRY_HEADERS], prior]; const { job, plan } = jobAndPlan(values);
  const mock = mockGoogle(values, { gridRows: 2, tables: [{ tableId: 'actual-table', name: 'Таблица1',
    range: { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 17 } }] });
  const result = await client(mock).applyPlan(plan, job);
  assert.equal(result.verified, true); assert.equal(mock.values.length, 3);
  const requests = mock.batches[0].requests;
  assert.equal(requests.find((r) => r.appendDimension).appendDimension.length, 1);
  assert.deepEqual(requests.filter((r) => r.copyPaste).map((r) => r.copyPaste.pasteType), ['PASTE_FORMAT', 'PASTE_DATA_VALIDATION']);
  assert.equal(requests.find((r) => r.updateTable).updateTable.table.tableId, 'actual-table');
  assert.equal(requests.find((r) => r.updateTable).updateTable.table.range.endRowIndex, 3);
  for (const r of requests.filter((r) => r.updateCells && [8, 9].includes(r.updateCells.start.columnIndex))) {
    assert.equal(typeof r.updateCells.rows[0].values[0].userEnteredValue.numberValue, 'number');
    assert.equal(r.updateCells.rows[0].values[0].userEnteredFormat.numberFormat.type, 'DATE');
  }
  for (const i of [0, 1, 2, 3, 5, 12, 13, 14, 16]) assert.ok(!mock.values[2][i]);
});

test('Google accepting the batch does not count as success when readback differs', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; const { job, plan } = jobAndPlan(values);
  const mock = mockGoogle(values, { afterBatch: (v) => { v[1][7] = '77РПО_WRONG'; } });
  await assert.rejects(client(mock).applyPlan(plan, job), { code: 'sheet_readback_mismatch' });
  assert.equal(mock.batches.length, 1);
});

test('tampered plan cannot write even an allowed column', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; const { job, plan } = jobAndPlan(values);
  plan.updates[0].after = 'forged'; const mock = mockGoogle(values);
  await assert.rejects(client(mock).applyPlan(plan, job), { code: 'invalid_sheet_plan' });
  assert.equal(mock.calls.length, 0);
});

test('credentials and provider response bodies never appear in authentication errors', async () => {
  const c = new GoogleSheetsClient({ spreadsheetId: id, credentials, fetchImpl: async () => response({
    error: 'SECRET_PROVIDER_BODY', access_token: 'SECRET_TEST_TOKEN' }, 400), now });
  await assert.rejects(c.context(), (error) => error.code === 'google_authentication_failed' && !/SECRET|PRIVATE KEY/u.test(error.message));
});

test('no-op requires the correct license and both dates to be read back', async () => {
  const values = [[...REGISTRY_HEADERS], existingRow()]; values[1][7] = license.licenseNumber; values[1][15] = license.email;
  const { job, plan } = jobAndPlan(values); assert.equal(plan.action, 'noop');
  const mock = mockGoogle(values);
  const receipt = await client(mock).applyPlan(plan, job);
  assert.equal(receipt.cells.I2, license.issueDate); assert.equal(receipt.cells.J2, license.expiryDate);
  assert.equal(mock.batches.length, 0);
});

test('a historical Expert license in row 632 is preserved while the proven current blank-license row 869 is completed', async () => {
  const expert = { ...license, inn: '7736274613', licenseNumber: '77РПО0017082',
    issueDate: '2022-11-18', expiryDate: '2027-11-17', email: '',
    address: 'Россия, , Москва Город, , , , , , , , вн.тер.г. муниципальный округ Пресненский, ул. Ходынская, д. 2, стр. 1, этаж 1, часть помещ. I' };
  const values = Array.from({ length: 869 }, () => []);
  values[0] = [...REGISTRY_HEADERS];
  const historical = Array(17).fill('');
  Object.assign(historical, { 4: 'ООО "ЭКСПЕРТ"', 6: expert.inn, 7: expert.licenseNumber,
    8: '18.11.2022', 9: '17.11.2025', 10: 'Общепит ',
    11: 'оссия, , Москва Город, Ходынская Улица, 2 , 1, этаж 1, часть пом. I',
    16: 'Историческая запись, сохранить' });
  values[631] = historical;
  const current = Array(17).fill('');
  Object.assign(current, { 4: 'ООО "ЭКСПЕРТ"', 6: expert.inn, 8: '18 ноя 2022',
    9: '17 ноя 2027', 10: 'Общепит ', 11: expert.address, 16: 'Текущая ручная запись' });
  values[868] = current;
  const { job, plan } = jobAndPlan(values, { selectedLicense: expert, organization: 'ООО "ЭКСПЕРТ"' });
  assert.equal(plan.action, 'update'); assert.equal(plan.rowNumber, 869);
  assert.deepEqual(plan.updates.map((u) => [u.column, u.row]), [['H', 869]]);
  const mock = mockGoogle(values, { gridRows: 900 });
  const receipt = await client(mock).applyPlan(plan, job);
  assert.equal(receipt.cells.H869, expert.licenseNumber);
  assert.equal(receipt.cells.I869, '2022-11-18'); assert.equal(receipt.cells.J869, '2027-11-17');
  assert.deepEqual(mock.values[631], historical);
  assert.equal(mock.values[868][16], 'Текущая ручная запись');
  assert.ok(mock.batches[0].requests.every((r) => r.updateCells?.start.rowIndex === 868));
  // A plan saved by an older worker must also be refused instead of upgrading the historical row.
  const obsolete = { action: 'update', rowNumber: 632, identity: plan.identity, sourceEventKey: job.sourceEventKey,
    updates: [{ row: 632, column: 'J', columnIndex: 9, before: historical[9], after: expert.expiryDate },
      { row: 632, column: 'L', columnIndex: 11, before: historical[11], after: expert.address }],
    expectedCells: { J632: expert.expiryDate, L632: expert.address }, spreadsheetId: id, sheetName: title };
  const oldPlan = { ...obsolete, hash: hash(obsolete), createdAt: plan.createdAt };
  const freshMock = mockGoogle(values, { gridRows: 900 });
  await assert.rejects(client(freshMock).applyPlan(oldPlan, job), { code: 'sheet_plan_stale' });
  assert.equal(freshMock.batches.length, 0);
  assert.deepEqual(freshMock.values[631], historical);
});

function virtualRequestClock() {
  let now = 0;
  let pending = [];
  return {
    clock: () => now,
    wait: (delay) => new Promise((resolve) => pending.push({ until: now + delay, resolve })),
    advance(ms) {
      now += ms;
      const due = pending.filter(({ until }) => until <= now);
      pending = pending.filter(({ until }) => until > now);
      for (const { resolve } of due) resolve();
    },
  };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('concurrent reads share the default forty requests per rolling minute', async () => {
  const time = virtualRequestClock();
  const dispatched = [];
  const google = client({ fetchImpl: async () => {
    dispatched.push(time.clock());
    return response({});
  } }, { requestClock: time.clock, requestWait: time.wait });
  google.token = { value: 'fixture-token', expiresAt: Infinity };
  const pending = Promise.all(Array.from({ length: 85 }, () => google.request()));
  await nextTurn();
  assert.deepEqual(dispatched, Array(40).fill(0));
  time.advance(59_999);
  await nextTurn();
  assert.equal(dispatched.length, 40);
  time.advance(1);
  await nextTurn();
  assert.deepEqual(dispatched.slice(40), Array(40).fill(60_000));
  time.advance(60_000);
  await pending;
  assert.deepEqual(dispatched.slice(80), Array(5).fill(120_000));
});

test('metadata, values and row reads share a read budget while batch writes have a separate budget', async () => {
  const time = virtualRequestClock();
  const mock = mockGoogle([[...REGISTRY_HEADERS], existingRow()]);
  const google = client(mock, {
    readLimit: 2, writeLimit: 1, requestWindowMs: 1000, requestClock: time.clock, requestWait: time.wait,
  });
  await google.context();
  const read = google.readRow(2);
  await google.request(':batchUpdate', { body: { requests: [] } });
  const write = google.request(':batchUpdate', { body: { requests: [] } });
  await nextTurn();
  assert.equal(mock.calls.filter(({ options }) => options.method === 'GET').length, 2);
  assert.equal(mock.calls.filter(({ url }) => new URL(url).searchParams.has('ranges')).length, 0);
  assert.equal(mock.batches.length, 1);
  time.advance(1000);
  const [cells] = await Promise.all([read, write]);
  assert.equal(cells[6].formattedValue, license.inn);
  assert.equal(mock.batches.length, 2);
  assert.equal(mock.calls.filter(({ options }) => options.method === 'GET').length, 3);
});

test('quota and transport failures have safe codes and never retry uncertain batch writes', async () => {
  const providerText = 'private provider body';
  const failures = [
    [async () => { throw new Error(providerText); }, 'google_network_error'],
    [async () => ({ ok: true, status: 200, json: async () => { throw new Error(providerText); } }), 'google_network_error'],
    [async () => ({ ok: false, status: 429, json: async () => { throw new Error(providerText); } }), 'google_rate_limited'],
    [async () => ({ ok: false, status: 503, json: async () => { throw new Error(providerText); } }), 'google_request_failed'],
  ];
  for (const [failFetch, code] of failures) {
    let dispatches = 0;
    const google = client({ fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST');
      dispatches++;
      return failFetch();
    } });
    google.token = { value: 'fixture-token', expiresAt: Infinity };
    await assert.rejects(google.request(':batchUpdate', { body: { requests: [] } }), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(providerText));
      return true;
    });
    assert.equal(dispatches, 1);
  }
});
