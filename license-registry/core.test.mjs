import test from 'node:test';
import assert from 'node:assert/strict';
import { SHEET_COLUMNS, SHEET_ACTIVITY_VALUES, mapActivityForSheet, isValidInn, normalizeDate, normalizeAddress, normalizeName, parseSheetRows, extractEvent, nextMorning, localDate, selectLicense, planSheetUpsert, sourceEventKey, licenseIdentity, prepareJob, planRetry, isJobDue } from './core.mjs';

const INN = '9721255266';
const OTHER_INN = '9705148570';
const address = 'Москва, переулок Большой Толмачёвский, дом 5, строение 4';
const context = [{ rowNumber: 2, organization: 'ООО «СВЕРТЭ»', inn: INN, address }];
const message = (text, extra = {}) => ({ chatId: -100123, id: 44, date: '2026-10-30T10:51:13+03:00', text, ...extra });
const license = (overrides = {}) => ({ 'ИНН': INN, 'КПП подразделения': '770645001', 'Адрес подразделения': address, 'Номер лицензии': '77РПО0021046', 'Вид лицензии': 'Розничная продажа, общепит', 'Дата выдачи': '2026-04-17', 'Дата окончания': '2029-04-16', 'Статус лицензии': 'действующая', 'Дата изменения': '2026-10-29', 'Основание изменения': 'решение о переоформлении лицензии', 'e-mail': 'sverte@example.org', ...overrides });
function sheetRow(overrides = {}) {
  const values = ['TRUE', 'ЛРС', '80000', 'https://documents.example/1', 'ООО «СВЕРТЭ»', 'Заведение', INN, '77РПО0021046', '17.04.2026', '16.04.2029', 'Общепит ', address, 'Контакт', '79990000000', 'https://t.me/client', 'sales@example.org', 'Ручной комментарий'];
  for (const [field, value] of Object.entries(overrides)) values[SHEET_COLUMNS[field]] = value;
  return parseSheetRows([values], { startRow: 2 })[0];
}
const event = (overrides = {}) => ({ id: 'telegram:-100123:44', sourceEventKey: 'telegram:-100123:44', inn: INN, organization: 'ООО «СВЕРТЭ»', reportedAt: '2026-10-30T07:51:13Z', reportedDate: '2026-10-30', operation: 'reissue', ...overrides });

test('INN checksum accepts valid 10/12 digits and rejects corrupt or artificial numbers', () => {
  assert.equal(isValidInn(INN), true);
  assert.equal(isValidInn('500100732259'), true);
  for (const s of ['9721255267', '0000000000', '000000000000', '972125526', '97212552660', 'ИНН 9721255266']) assert.equal(isValidInn(s), false, s);
});

test('dates validate calendar and support existing Russian sheet formats', () => {
  assert.equal(normalizeDate('17.04.2026'), '2026-04-17');
  assert.equal(normalizeDate('17 апр. 2026'), '2026-04-17');
  assert.equal(normalizeDate('23 января 2028 г'), '2028-01-23');
  assert.equal(normalizeDate('31.11.2026'), null);
  assert.equal(normalizeDate('2026-02-29'), null);
  assert.equal(normalizeDate('2028-02-29'), '2028-02-29');
});

test('T+1 is based on Moscow calendar date, including UTC day boundary', () => {
  assert.equal(nextMorning('2026-10-31T22:00:00Z'), '2026-11-02T06:00:00.000Z');
  assert.equal(nextMorning('2026-11-01T23:59:59'), '2026-11-02T06:00:00.000Z');
  assert.equal(nextMorning('2026-12-31T10:00:00Z'), '2027-01-01T06:00:00.000Z');
  assert.equal(localDate('2026-10-31T22:00:00Z'), '2026-11-01');
  assert.throws(() => nextMorning('bad-date'));
  assert.throws(() => nextMorning('2026-11-01', { hour: 24 }));
});

test('normalization is conservative about a different room or floor', () => {
  assert.equal(normalizeName('ООО «СВЁРТЭ»'), 'свертэ');
  assert.equal(normalizeAddress('Россия,, Москва, пер. Большой Толмачёвский, д. 5'), normalizeAddress('Москва, переулок Большой Толмачевский, дом 5'));
  assert.notEqual(normalizeAddress(`${address}, этаж 1`), normalizeAddress(`${address}, этаж -1`));
});

test('extracts positive result with INN, operation and stable source identity', () => {
  const result = extractEvent(message(`ООО «СВЕРТЭ», ИНН ${INN}. Решение о переоформлении получено, положительно.`), context);
  assert.equal(result.status, 'event');
  assert.equal(result.event.inn, INN);
  assert.equal(result.event.operation, 'reissue');
  assert.equal(result.event.nextCheckAt, '2026-10-31T06:00:00.000Z');
  assert.equal(result.event.sourceEventKey, 'telegram:-100123:44');
});

test('normal short caption resolves a unique known organization without reading PDF', () => {
  const result = extractEvent(message('Свертэ положительно'), context);
  assert.equal(result.status, 'event');
  assert.equal(result.event.inn, INN);
  assert.equal(result.event.organization, 'ООО «СВЕРТЭ»');
});

test('Telegram rich-text arrays, known short aliases and numbered decision dates are supported', () => {
  const rich = extractEvent(message(['МВ ', { type: 'bold', text: 'положительно' }]), [{ ...context[0], aliases: ['МВ'] }]);
  assert.equal(rich.status, 'event');
  assert.equal(rich.event.inn, INN);
  const dated = extractEvent(message(`Свертэ положительно. Решение № 20_01_1886 от 28.10.2026`), context);
  assert.equal(dated.event.decisionDate, '2026-10-28');
});

test('does not mistake positive inspection, expected result, refusal or question for issued license', () => {
  const texts = [
    'Свертэ проверка положительно', 'Свертэ положительный акт', 'Свертэ осмотр положительно',
    'Свертэ ждем положительное решение', 'Свертэ ожидаем решение о выдаче лицензии',
    'Свертэ решение о выдаче, пока ждем', 'Свертэ не получили положительное решение',
    'Свертэ отказ, положительно пока нет', 'Свертэ приостановка', 'Свертэ положительно?',
  ];
  for (const text of texts) assert.notEqual(extractEvent(message(text), context).status, 'event', text);
});

test('only explicit INN or known company context identifies organization', () => {
  assert.equal(extractEvent(message(`Решение положительное, P001-${INN}`)).status, 'review');
  assert.equal(extractEvent(message(`Решение положительное, ИНН 9721255267`)).reason, 'invalid_explicit_inn');
  assert.equal(extractEvent(message(`Решение положительное, ИНН ${INN}, ИНН ${OTHER_INN}`)).reason, 'multiple_organizations_in_one_message');
  const ambiguous = [...context, { organization: 'ООО «СВЕРТЭ»', inn: OTHER_INN }];
  assert.equal(extractEvent(message('Свертэ положительно'), ambiguous).reason, 'organization_name_is_ambiguous');
});

test('missing time or message identity enters review rather than creating unschedulable event', () => {
  assert.equal(extractEvent(message('Свертэ положительно', { date: undefined }), context).status, 'review');
  assert.equal(extractEvent(message('Свертэ положительно', { id: undefined }), context).status, 'review');
  assert.throws(() => sourceEventKey({ text: 'x' }));
});

test('old Sverte API response does not complete October reissue event', () => {
  const result = selectLicense(event(), [license({ 'Дата изменения': '2026-04-17', 'Основание изменения': 'решение о выдаче лицензии' })]);
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'registry_has_not_reflected_event');
});

test('fresh reissue has exact identity and can be selected', () => {
  const result = selectLicense(event({ kpp: '770645001', address }), [license()]);
  assert.equal(result.status, 'ready');
  assert.equal(result.license.licenseNumber, '77РПО0021046');
  assert.equal(result.identity, licenseIdentity(license()));
});

test('new active license wins over old expired license on same INN', () => {
  const items = [
    license({ 'ИНН': OTHER_INN, 'Номер лицензии': '77РПО0018919', 'Дата выдачи': '2024-06-14', 'Дата окончания': '2026-06-13', 'Статус лицензии': 'истекла', 'Дата изменения': '2026-06-14' }),
    license({ 'ИНН': OTHER_INN, 'Номер лицензии': '77РПО0021680', 'Дата выдачи': '2026-10-28', 'Дата окончания': '2027-10-27', 'Дата изменения': '2026-10-28', 'Основание изменения': 'решение о выдаче лицензии' }),
  ];
  const result = selectLicense(event({ inn: OTHER_INN, reportedDate: '2026-10-28', operation: 'issuance' }), items);
  assert.equal(result.status, 'ready');
  assert.equal(result.license.licenseNumber, '77РПО0021680');
});

test('multiple objects need exact KPP/address; no prefix matching or arbitrary first record', () => {
  const second = license({ 'КПП подразделения': '770645002', 'Адрес подразделения': `${address}, этаж -1` });
  assert.equal(selectLicense(event(), [license(), second]).reason, 'multiple_licenses_or_objects');
  assert.equal(selectLicense(event({ kpp: '770645002' }), [license(), second]).license.kpp, '770645002');
  assert.equal(selectLicense(event({ address: 'Москва' }), [license(), second]).status, 'waiting');
});

test('duplicate API copies deduplicate, conflicting same-identity dates require review', () => {
  assert.equal(selectLicense(event(), [license(), license()]).status, 'ready');
  assert.equal(selectLicense(event(), [license(), license({ 'Дата окончания': '2028-04-16' })]).reason, 'conflicting_api_records');
  assert.equal(selectLicense(event(), [null]).reason, 'invalid_api_record');
  assert.equal(selectLicense(event(), { error: 'not available' }).reason, 'invalid_or_incomplete_api_response');
});

test('renewal checks operation and expiry extension instead of accepting old active license', () => {
  assert.equal(selectLicense(event({ operation: 'renewal' }), [license()]).reason, 'api_operation_does_not_match_renewal');
  const result = selectLicense(event({ operation: 'renewal', previousExpiryDate: '2029-04-16' }), [license({ 'Основание изменения': 'решение о продлении лицензии' })]);
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'renewal_has_not_extended_expiry');
});

test('append contains only allowed source fields and preserves blank commercial columns', () => {
  const result = planSheetUpsert(license(), [], event());
  assert.equal(result.action, 'append');
  assert.equal(result.values.length, 17);
  for (const i of [0, 1, 2, 3, 5, 12, 13, 14, 16]) assert.equal(result.values[i], '');
  assert.equal(result.values[4], 'ООО «СВЕРТЭ»');
  assert.equal(result.values[8], '2026-04-17');
  assert.equal(result.values[9], '2029-04-16');
  assert.equal(result.values[10], 'Общепит ');
  assert.equal(SHEET_ACTIVITY_VALUES.includes(result.values[10]), true);
  assert.deepEqual(result.updates.map((x) => x.column), ['E', 'G', 'H', 'I', 'J', 'K', 'L', 'P']);
});

test('API activity maps to the exact native validation options without dropping trailing space', () => {
  assert.equal(mapActivityForSheet('Розничная продажа, общепит'), 'Общепит ');
  assert.equal(mapActivityForSheet('Розничная продажа алкогольной продукции при оказании услуг общественного питания'), 'Общепит ');
  assert.equal(mapActivityForSheet('Розничная продажа алкоголя'), 'Магазин');
  assert.equal(mapActivityForSheet('закупка, хранение и поставки алкогольной продукции'), 'Опт');
  assert.equal(mapActivityForSheet('Общепит '), 'Общепит ');
  assert.equal(mapActivityForSheet('производство этилового спирта'), null);
  assert.equal(planSheetUpsert(license({ 'Вид лицензии': 'производство этилового спирта' }), [], event()).reason, 'unsupported_activity_for_sheet');
});

test('existing validated activity compares trimmed but remains untouched', () => {
  const row = sheetRow({ licenseNumber: '', email: '' });
  const result = planSheetUpsert(license(), [row], event());
  assert.equal(result.action, 'update');
  assert.deepEqual(result.updates.map((update) => update.column), ['H', 'P']);
  assert.equal(row.values[10], 'Общепит ');
});

test('repeat processing is noop and does not rewrite human dates or contacts', () => {
  const row = sheetRow();
  const result = planSheetUpsert(license(), [row], event());
  assert.equal(result.action, 'noop');
  assert.deepEqual(result.updates, []);
  assert.equal(row.values[8], '17.04.2026');
  assert.equal(row.values[15], 'sales@example.org');
});

test('renewal patch changes only factual cells, preserving notes and commercial fields', () => {
  const row = sheetRow({ expiryDate: '16.04.2027' });
  const before = [...row.values];
  const result = planSheetUpsert(license({ 'Основание изменения': 'решение о продлении лицензии' }), [row], event({ operation: 'renewal' }));
  assert.equal(result.action, 'update');
  assert.deepEqual(result.updates.map((x) => [x.column, x.before, x.after]), [['J', '16.04.2027', '2029-04-16']]);
  assert.deepEqual(row.values, before);
});

test('email is filled only if empty; invalid API email is never written', () => {
  assert.equal(planSheetUpsert(license(), [sheetRow({ email: '' })], event()).updates[0].column, 'P');
  assert.equal(planSheetUpsert(license({ 'e-mail': '???' }), [sheetRow({ email: '' })], event()).action, 'noop');
});

test('older API dates and known-newer verified record are not overwritten', () => {
  const later = sheetRow({ expiryDate: '16.04.2030' });
  assert.equal(planSheetUpsert(license(), [later], event()).reason, 'api_expiryDate_older_than_existing');
  assert.equal(planSheetUpsert(license(), [{ ...sheetRow(), lastVerifiedChangeDate: '2026-10-30' }], event()).reason, 'api_older_than_verified_sheet_record');
  assert.equal(planSheetUpsert(license(), [sheetRow({ expiryDate: 'уточнить' })], event()).reason, 'unparseable_existing_expiryDate');
});

test('duplicate existing rows are never deleted or silently merged', () => {
  const result = planSheetUpsert(license(), [sheetRow(), { ...sheetRow(), rowNumber: 3 }], event());
  assert.equal(result.action, 'review');
  assert.equal(result.reason, 'duplicate_or_ambiguous_sheet_records');
  assert.deepEqual(result.updates, []);
});

test('blank license row can be completed only with exact object address', () => {
  const result = planSheetUpsert(license(), [sheetRow({ licenseNumber: '' })], event());
  assert.equal(result.action, 'update');
  assert.deepEqual(result.updates.map((x) => x.column), ['H']);
  assert.equal(planSheetUpsert(license(), [sheetRow({ licenseNumber: '', address: 'другой объект' })], event()).reason, 'incomplete_existing_sheet_record');
});

test('new license number creates a new row, not overwriting older license of same INN', () => {
  const newRecord = license({ 'Номер лицензии': '77РПО0022000', 'Дата выдачи': '2026-10-30', 'Дата окончания': '2027-10-29' });
  const result = planSheetUpsert(newRecord, [sheetRow()], event({ operation: 'issuance' }));
  assert.equal(result.action, 'append');
  assert.equal(result.values[7], '77РПО0022000');
});

test('address conflict requires current reissue rather than stale general update', () => {
  const expanded = license({ 'Адрес подразделения': `${address}, этаж -1` });
  assert.equal(planSheetUpsert(expanded, [sheetRow()], event({ operation: 'renewal' })).reason, 'object_address_conflict');
  assert.equal(planSheetUpsert(expanded, [sheetRow()], event({ operation: 'reissue', decisionDate: '2026-10-29' })).action, 'update');
});

test('header and checkbox-only rows are excluded without changing spreadsheet row indexes', () => {
  const header = Array(17).fill(''); header[4] = 'Организация'; header[6] = 'ИНН';
  const rows = parseSheetRows([header, ['FALSE'], sheetRow().values]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowNumber, 3);
});

test('source edits and repeated document forwards cannot create duplicate jobs', () => {
  const first = prepareJob(event({ documentId: 'file-unique' }));
  assert.equal(first.created, true);
  assert.equal(prepareJob(event({ text: 'edited' }), [first.job]).created, false);
  assert.equal(prepareJob(event({ id: 'telegram:-100123:45', sourceEventKey: 'telegram:-100123:45', documentId: 'file-unique' }), [first.job]).created, false);
  assert.equal(isJobDue(first.job, '2026-10-31T05:59:59Z'), false);
  assert.equal(isJobDue(first.job, '2026-10-31T06:00:00Z'), true);
});

test('retries are bounded by attempts and actual API quota, counter is owned by worker', () => {
  const job = prepareJob(event()).job;
  assert.equal(planRetry({ ...job, attempts: 7 }, { maxAttempts: 7 }).status, 'review');
  assert.equal(planRetry(job, { quotaRemaining: 0 }).status, 'quota_exhausted');
  const retry = planRetry({ ...job, attempts: 2 }, { now: '2026-10-31T07:00:00Z', quotaRemaining: 98 });
  assert.equal(retry.nextCheckAt, '2026-11-01T06:00:00.000Z');
  assert.equal(retry.attempts, 2);
  assert.equal(retry.status, 'waiting');
});
