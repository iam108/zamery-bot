import fs from 'node:fs/promises';
import { sign } from 'node:crypto';
import { hash } from './state.mjs';
import { normalizeDate, normalizeAddress, normalizeLicense, normalizeLicenseNumber,
  licenseIdentity, parseSheetRows, planSheetUpsert, SHEET_ACTIVITY_VALUES } from './core.mjs';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DAY = 86_400_000;
const ALLOWED = new Set([4, 6, 7, 8, 9, 10, 11, 15]);
export const REGISTRY_HEADERS = Object.freeze(['B24', 'Компания', 'Сумма сдекли', 'Ссылка на документы',
  'Столбец 5', 'Название', 'ИНН', 'Номер лицензии', 'Дата выдачи лицензии',
  'Дата окончания лицензии', 'Вид деятельности', 'Адрес', 'Имя', 'Телефон',
  'Ссылка на чат в ТГ', 'Email', 'Коментарий']);
const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const letter = (index) => String.fromCharCode(65 + index);
const quote = (name) => `'${name.replace(/'/gu, "''")}'`;
function fail(code, message = code) { const error = new Error(message); error.code = code; throw error; }
function compare(index, value) {
  if (index === 8 || index === 9) return normalizeDate(value) ?? clean(value);
  if (index === 7) return normalizeLicenseNumber(value);
  if (index === 11) return normalizeAddress(value);
  return clean(value);
}
function serial(value) {
  const date = normalizeDate(value);
  if (!date) fail('invalid_sheet_date');
  return Date.parse(`${date}T00:00:00Z`) / DAY + 25569;
}
function displayed(cell = {}) {
  if (cell.formattedValue != null) return cell.formattedValue;
  const v = cell.effectiveValue ?? cell.userEnteredValue ?? {};
  if (v.stringValue != null) return v.stringValue;
  if (v.numberValue != null) {
    if (['DATE', 'DATE_TIME'].includes((cell.effectiveFormat ?? cell.userEnteredFormat)?.numberFormat?.type)) {
      return new Date((v.numberValue - 25569) * DAY).toISOString().slice(0, 10);
    }
    return v.numberValue;
  }
  return v.boolValue == null ? '' : String(v.boolValue).toUpperCase();
}
function occupied(cell) {
  return Boolean(cell?.userEnteredValue && Object.keys(cell.userEnteredValue).length) || clean(displayed(cell)) !== '';
}

/** A direct, server-side adapter. No browser session, MCP token or local Google cookies are used. */
export class GoogleSheetsClient {
  constructor({ spreadsheetId, sheetName = 'Реестр лицензий', sheetId = 0, credentials,
    fetchImpl = fetch, now = () => new Date() } = {}) {
    if (!/^[\w-]+$/u.test(String(spreadsheetId ?? ''))) fail('invalid_spreadsheet_id');
    if (!sheetName || !Number.isInteger(sheetId) || sheetId < 0) fail('invalid_sheet_identity');
    this.spreadsheetId = spreadsheetId;
    this.sheetName = sheetName;
    this.sheetId = sheetId;
    this.credentialsInput = credentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.token = null;
  }

  async credentials() {
    if (this.loadedCredentials) return this.loadedCredentials;
    let input = this.credentialsInput ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON ??
      process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      if (typeof input === 'string') {
        input = JSON.parse(input.trim().startsWith('{') ? input : await fs.readFile(input, 'utf8'));
      }
      if (!input || !/@[^@]+\.gserviceaccount\.com$/u.test(input.client_email ?? '') ||
          typeof input.private_key !== 'string' || !input.private_key.includes('PRIVATE KEY')) throw new Error();
    } catch { fail('google_credentials_missing_or_invalid', 'Valid server-side Google service account credentials are required'); }
    this.loadedCredentials = { client_email: input.client_email, private_key: input.private_key,
      private_key_id: input.private_key_id };
    return this.loadedCredentials;
  }

  async accessToken(force = false) {
    const now = +new Date(this.now());
    if (!force && this.token && this.token.expiresAt > now + 60_000) return this.token.value;
    const c = await this.credentials();
    const seconds = Math.floor(now / 1000);
    const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = { alg: 'RS256', typ: 'JWT' };
    if (c.private_key_id) header.kid = c.private_key_id;
    const unsigned = `${enc(header)}.${enc({ iss: c.client_email, scope: SCOPE,
      aud: TOKEN_URL, iat: seconds, exp: seconds + 3600 })}`;
    let assertion;
    try { assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), c.private_key).toString('base64url')}`; }
    catch { fail('google_credentials_missing_or_invalid', 'Google service account signing failed'); }
    let response; let body;
    try {
      response = await this.fetchImpl(TOKEN_URL, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        signal: AbortSignal.timeout(20_000) });
      body = await response.json();
    } catch { fail('google_token_unavailable', 'Google authentication request failed'); }
    if (!response.ok || typeof body.access_token !== 'string' || !Number.isFinite(Number(body.expires_in))) {
      fail('google_authentication_failed', `Google authentication rejected (HTTP ${response.status})`);
    }
    this.token = { value: body.access_token, expiresAt: now + Number(body.expires_in) * 1000 };
    return this.token.value;
  }

  async request(suffix = '', { query, body, retry = true } = {}) {
    const url = new URL(`${API}/${this.spreadsheetId}${suffix}`);
    if (query) for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
    }
    const token = await this.accessToken();
    let response; let data;
    try {
      response = await this.fetchImpl(url.toString(), { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25_000) });
      data = await response.json();
    } catch { fail('google_network_error', 'Google Sheets request failed before a valid response was received'); }
    if (response.status === 401 && retry) {
      await this.accessToken(true);
      return this.request(suffix, { query, body, retry: false });
    }
    if (!response.ok) fail(response.status === 403 || response.status === 404 ? 'google_access_denied' : 'google_request_failed',
      `Google Sheets request rejected (HTTP ${response.status})`);
    return data;
  }

  validateMetadata(metadata) {
    if (metadata.spreadsheetId !== this.spreadsheetId) fail('sheet_structure_changed', 'Google returned a different spreadsheet');
    const sheets = metadata.sheets?.filter((s) => s.properties?.sheetId === this.sheetId && s.properties?.title === this.sheetName);
    if (sheets?.length !== 1) fail('sheet_structure_changed', 'Expected registry sheet ID and title were not found');
    const grid = sheets[0].properties.gridProperties;
    if (!grid || grid.columnCount < 17 || grid.rowCount < 2 || grid.rowCount > 100_000) {
      fail('sheet_structure_changed', 'Registry grid is outside the configured bounds');
    }
    return sheets[0];
  }

  async context() {
    const metadata = await this.request('', { query: {
      fields: 'spreadsheetId,properties(title,locale,timeZone),sheets(properties,tables)' } });
    const sheet = this.validateMetadata(metadata);
    const range = `${quote(this.sheetName)}!A1:Q${sheet.properties.gridProperties.rowCount}`;
    const data = await this.request(`/values/${encodeURIComponent(range)}`, { query: { valueRenderOption: 'FORMATTED_VALUE' } });
    const values = data.values ?? [];
    if (!Array.isArray(values) || REGISTRY_HEADERS.some((h, i) => clean(values[0]?.[i]) !== h)) {
      fail('sheet_structure_changed', 'Registry headers changed; no values were written');
    }
    return { values, startRow: 1, metadata };
  }

  async readRow(row) {
    const result = await this.request('', { query: {
      ranges: `${quote(this.sheetName)}!A${row}:Q${row}`,
      fields: 'spreadsheetId,sheets(properties(sheetId,title,gridProperties),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation,note,userEnteredFormat,effectiveFormat))))' } });
    const sheet = result.sheets?.find((s) => s.properties?.sheetId === this.sheetId && s.properties?.title === this.sheetName);
    if (!sheet || result.spreadsheetId !== this.spreadsheetId) fail('sheet_structure_changed');
    const cells = Array.from({ length: 17 }, () => ({}));
    for (const data of sheet.data ?? []) {
      const start = data.startRow ?? 0;
      const record = data.rowData?.[row - 1 - start];
      if (record) for (const [i, cell] of (record.values ?? []).entries()) cells[(data.startColumn ?? 0) + i] = cell;
    }
    return cells;
  }

  validatePlan(plan, job) {
    if (!['append', 'update', 'noop'].includes(plan?.action) || !Number.isInteger(plan.rowNumber) || plan.rowNumber < 2 ||
        plan.spreadsheetId !== this.spreadsheetId || plan.sheetName !== this.sheetName || !plan.expectedCells) fail('invalid_sheet_plan');
    const { hash: expectedHash, createdAt, ...unsigned } = plan;
    if (!expectedHash || hash(unsigned) !== expectedHash) fail('invalid_sheet_plan', 'Write plan integrity check failed');
    const license = normalizeLicense(job?.selectedLicense ?? {});
    if (plan.identity !== licenseIdentity(license) || (job.inn && String(job.inn) !== license.inn)) fail('invalid_sheet_plan');
    const touched = new Set();
    for (const update of plan.updates ?? []) {
      if (update.row !== plan.rowNumber || !ALLOWED.has(update.columnIndex) || update.column !== letter(update.columnIndex) || touched.has(update.columnIndex) ||
          !Object.hasOwn(plan.expectedCells, `${update.column}${update.row}`) ||
          compare(update.columnIndex, plan.expectedCells[`${update.column}${update.row}`]) !== compare(update.columnIndex, update.after)) fail('invalid_sheet_plan');
      if (update.columnIndex === 10 && !SHEET_ACTIVITY_VALUES.includes(update.after)) fail('invalid_sheet_activity');
      if ([8, 9].includes(update.columnIndex)) serial(update.after);
      touched.add(update.columnIndex);
    }
    if (plan.action === 'noop' && touched.size || plan.action !== 'noop' && !touched.size) fail('invalid_sheet_plan');
    for (const cell of Object.keys(plan.expectedCells)) {
      const match = cell.match(/^([A-Q])(\d+)$/u);
      if (!match || Number(match[2]) !== plan.rowNumber || !ALLOWED.has(match[1].charCodeAt(0) - 65)) fail('invalid_sheet_plan');
    }
    return license;
  }

  async applyPlan(plan, job) {
    const license = this.validatePlan(plan, job);
    const current = await this.context();
    const sheet = this.validateMetadata(current.metadata);
    const row = plan.rowNumber;
    const gridRows = sheet.properties.gridProperties.rowCount;
    const before = row <= gridRows ? await this.readRow(row) : Array.from({ length: 17 }, () => ({}));
    const expected = { ...plan.expectedCells, [`G${row}`]: license.inn, [`H${row}`]: license.licenseNumber,
      [`I${row}`]: license.issueDate, [`J${row}`]: license.expiryDate };
    const matches = (cells) => (!license.address || compare(11, displayed(cells[11])) === compare(11, license.address)) && Object.entries(expected).every(([a1, value]) => {
      const index = a1.charCodeAt(0) - 65;
      return compare(index, displayed(cells[index])) === compare(index, value);
    });
    // A successful write followed by a crash is completed by readback, without writing twice.
    if (matches(before)) return this.receipt(plan, expected, before);
    const fresh = planSheetUpsert(license, parseSheetRows(current.values), job);
    if (!['append', 'update', 'noop'].includes(fresh.action) || (fresh.rowNumber && fresh.rowNumber !== row)) {
      fail('sheet_plan_stale', 'Registry identity or row location changed; replan from a fresh context');
    }
    if (plan.action !== 'append' && fresh.action === 'append') fail('sheet_plan_stale');
    if (plan.action === 'noop' && fresh.action !== 'noop') fail('sheet_plan_stale');
    if (fresh.action === 'noop') fail('sheet_readback_mismatch');
    const requests = [];
    if (plan.action === 'append' && fresh.action === 'append') {
      const lastUsed = current.values.reduce((last, values, index) => values.some((v) => v != null && String(v) !== '') ? index + 1 : last, 1);
      if (row !== lastUsed + 1 || before.some(occupied)) fail('sheet_plan_stale', 'Proposed append row is occupied or no longer follows the last record');
      if (row > gridRows) requests.push({ appendDimension: { sheetId: this.sheetId, dimension: 'ROWS', length: row - gridRows } });
      let templateRow = null;
      for (let n = lastUsed; n >= 2; n -= 1) {
        if (SHEET_ACTIVITY_VALUES.includes(current.values[n - 1]?.[10])) { templateRow = n; break; }
      }
      if (!templateRow) fail('sheet_append_template_missing');
      const source = { sheetId: this.sheetId, startRowIndex: templateRow - 1, endRowIndex: templateRow, startColumnIndex: 0, endColumnIndex: 17 };
      const destination = { sheetId: this.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 17 };
      for (const pasteType of ['PASTE_FORMAT', 'PASTE_DATA_VALIDATION']) requests.push({ copyPaste: { source, destination, pasteType, pasteOrientation: 'NORMAL' } });
      const tables = (sheet.tables ?? []).filter((t) => (t.range?.startRowIndex ?? 0) === 0 && (t.range?.startColumnIndex ?? 0) === 0 && t.range?.endColumnIndex === 17);
      if ((sheet.tables ?? []).length && tables.length !== 1) fail('sheet_structure_changed', 'The registry native table is ambiguous');
      if (tables[0] && tables[0].range.endRowIndex < row) requests.push({ updateTable: {
        table: { tableId: tables[0].tableId, range: { ...tables[0].range, sheetId: this.sheetId, endRowIndex: row } }, fields: 'range' } });
    } else {
      if (compare(6, displayed(before[6])) !== license.inn ||
          (clean(displayed(before[7])) && compare(7, displayed(before[7])) !== license.licenseNumber)) fail('sheet_plan_stale', 'The destination row no longer identifies this license');
      // Guard cells that identify the object and dates, including fields not changed by this plan.
      for (const index of [4, 6, 7, 8, 9, 11]) {
        if (compare(index, displayed(before[index])) !== compare(index, current.values[row - 1]?.[index])) fail('sheet_plan_stale');
      }
    }
    for (const update of plan.updates ?? []) {
      const index = update.columnIndex;
      const existing = displayed(before[index]);
      if (compare(index, existing) === compare(index, update.after)) continue;
      if (before[index]?.userEnteredValue?.formulaValue || compare(index, existing) !== compare(index, update.before) ||
          index === 15 && occupied(before[index])) fail('sheet_plan_stale', `The value at ${update.column}${row} changed since planning`);
      const cell = { userEnteredValue: [8, 9].includes(index) ? { numberValue: serial(update.after) } : { stringValue: String(update.after) } };
      let fields = 'userEnteredValue';
      if ([8, 9].includes(index) && !['DATE', 'DATE_TIME'].includes((before[index]?.effectiveFormat ?? before[index]?.userEnteredFormat)?.numberFormat?.type)) {
        cell.userEnteredFormat = { numberFormat: { type: 'DATE', pattern: 'dd.mm.yyyy' } };
        fields += ',userEnteredFormat.numberFormat';
      }
      requests.push({ updateCells: { start: { sheetId: this.sheetId, rowIndex: row - 1, columnIndex: index }, rows: [{ values: [cell] }], fields } });
    }
    if (requests.length) await this.request(':batchUpdate', { body: { requests, includeSpreadsheetInResponse: false } });
    const after = await this.readRow(row);
    if (!matches(after)) fail('sheet_readback_mismatch', 'Google readback did not match the planned values; the job remains unacknowledged');
    return this.receipt(plan, expected, after);
  }

  receipt(plan, expected, rowCells) {
    const cells = {};
    for (const a1 of Object.keys(expected)) {
      const index = a1.charCodeAt(0) - 65;
      const value = displayed(rowCells[index]);
      cells[a1] = [8, 9].includes(index) ? normalizeDate(value) : value;
    }
    return { verified: true, planHash: plan.hash, spreadsheetId: this.spreadsheetId,
      sheetName: this.sheetName, verifiedAt: new Date(this.now()).toISOString(), cells };
  }
}
