import { createHash } from 'node:crypto';

// Pure functions only: no Telegram, Google, filesystem or network side effects.
export const SHEET_COLUMNS = Object.freeze({ organization: 4, inn: 6, licenseNumber: 7, issueDate: 8, expiryDate: 9, activity: 10, address: 11, email: 15 });
// Exact labels from the live Google Sheet validation, including the first label's space.
export const SHEET_ACTIVITY_VALUES = Object.freeze(['Общепит ', 'Магазин', 'Опт']);
const DAY = 86_400_000;
const clean = (v) => String(v ?? '').replace(/\s+/gu, ' ').trim();
const messageText = (v) => clean(Array.isArray(v) ? v.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('') : v);
export const normalizeName = (v) => clean(v).toLowerCase().replace(/ё/gu, 'е').replace(/\b(?:ooo|llc)\b/gu, ' ').replace(/общество\s+с\s+ограниченной\s+ответственностью|(?<!\p{L})(?:ооо|пао|ао)(?!\p{L})/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
export const normalizeLicenseNumber = (v) => clean(v).toUpperCase().replace(/\s+/gu, '');
export function normalizeAddress(value) {
  return clean(value).toLowerCase().replace(/ё/gu, 'е')
    .replace(/(?<!\p{L})россия(?!\p{L})/gu, '')
    .replace(/(^|[\s,;])пер\.(?=\s)/gu, '$1переулок ')
    .replace(/(^|[\s,;])ул\.(?=\s)/gu, '$1улица ')
    .replace(/(^|[\s,;])г\.(?=\s)/gu, '$1город ')
    .replace(/(^|[\s,;])д\.(?=\s)/gu, '$1дом ')
    .replace(/(^|[\s,;])стр\.(?=\s)/gu, '$1строение ')
    .replace(/(^|[\s,;])корп\.(?=\s)/gu, '$1корпус ')
    .replace(/(^|[\s,;])помещ?\.(?=\s)/gu, '$1помещение ')
    .replace(/(^|[\s,;])эт\.(?=\s)/gu, '$1этаж ')
    .replace(/[.,;:\s]+/gu, ' ').trim();
}

export function isValidInn(value) {
  const s = clean(value);
  if (!/^\d{10}(?:\d{2})?$/u.test(s) || /^0+$/u.test(s)) return false;
  const n = [...s].map(Number);
  const checksum = (weights) => weights.reduce((sum, weight, i) => sum + n[i] * weight, 0) % 11 % 10;
  if (s.length === 10) return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[9];
  return checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[10] && checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[11];
}

export function normalizeDate(value) {
  const s = clean(value).toLowerCase();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/u);
  let year; let month; let day;
  if (m) [, year, month, day] = m;
  else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/u))) [, day, month, year] = m;
  else {
    const months = { янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 };
    m = s.match(/^(\d{1,2})\s+([а-я]+)\.?\s+(\d{4})(?:\s*г\.?)?$/u);
    if (!m || !months[m[2].slice(0, 3)]) return null;
    day = m[1]; month = months[m[2].slice(0, 3)]; year = m[3];
  }
  const d = new Date(Date.UTC(+year, +month - 1, +day));
  if (d.getUTCFullYear() !== +year || d.getUTCMonth() + 1 !== +month || d.getUTCDate() !== +day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}
function wallTimeUtc(parts, timeZone) {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  let instant = wall;
  for (let i = 0; i < 4; i += 1) {
    const p = dateParts(new Date(instant), timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const next = instant + wall - represented;
    if (next === instant) return new Date(next);
    instant = next;
  }
  return new Date(instant);
}
function timestamp(value, timeZone = 'Europe/Moscow') {
  if (value instanceof Date) return new Date(value);
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  const text = clean(value);
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/u);
  if (local) return wallTimeUtc({ year: +local[1], month: +local[2], day: +local[3], hour: +(local[4] ?? 0), minute: +(local[5] ?? 0), second: +(local[6] ?? 0) }, timeZone);
  const result = new Date(text);
  if (!Number.isFinite(+result)) throw new Error('A valid event timestamp is required');
  return result;
}
export function localDate(value, timeZone = 'Europe/Moscow') {
  const p = dateParts(timestamp(value, timeZone), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function nextMorning(value, { timeZone = 'Europe/Moscow', hour = 9 } = {}) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('hour must be 0..23');
  const p = dateParts(timestamp(value, timeZone), timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return wallTimeUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour }, timeZone).toISOString();
}

export function parseSheetRows(values, { startRow = 1 } = {}) {
  return values.map((values, i) => {
    if (!Array.isArray(values)) return values;
    return { rowNumber: startRow + i, values: [...values], organization: clean(values[4]), inn: clean(values[6]), licenseNumber: normalizeLicenseNumber(values[7]), issueDate: normalizeDate(values[8]), expiryDate: normalizeDate(values[9]), activity: clean(values[10]), address: clean(values[11]), email: clean(values[15]) };
  }).filter((r) => r && (clean(r.organization) || isValidInn(r.inn)) && clean(r.inn).toLowerCase() !== 'инн');
}

export function sourceEventKey(message) {
  const chat = message.chatId ?? message.chat_id ?? message.chat?.id;
  const id = message.messageId ?? message.message_id ?? message.id;
  if (chat == null || id == null) throw new Error('Telegram chat and message identifiers are required');
  if (message.source_kind === 'telegram_bot_api') {
    if (!['group', 'supergroup'].includes(message.telegram_chat_type)) throw new Error('Telegram Bot API chat type is required');
    // Basic-group message IDs belong to the receiving bot's message box, not
    // the user-export history. Keep both namespaces and other bots separate.
    if (message.telegram_chat_type === 'group') {
      const bot = String(message.source_bot_id ?? '');
      if (!/^[1-9]\d*$/u.test(bot) || !Number.isSafeInteger(Number(bot))
          || !/^[1-9]\d*$/u.test(String(id)) || !Number.isSafeInteger(Number(id))) {
        throw new Error('Telegram basic-group bot and message identities are required');
      }
      return `telegram-bot:${bot}:group:${chat}:${id}`;
    }
  }
  return `telegram:${chat}:${id}`;
}

function canonicalOperation(text) {
  if (/переоформ/iu.test(text)) return 'reissue';
  if (/продлен|продлён/iu.test(text)) return 'renewal';
  if (/выдач|выдан|получени[ея]\s+лицензи|получил[аи]?\s+лицензи/iu.test(text)) return 'issuance';
  return 'unknown';
}

// contextRows may contain additional { aliases, expectedOperation, kpp, rowNumber }.
export function extractEvent(message, contextRows = [], { timeZone = 'Europe/Moscow' } = {}) {
  const text = messageText(message.text || message.caption);
  if (!text) return { status: 'ignore', reason: 'no_text' };
  if (/(?<!\p{L})(?:жд[её]м|ожидаем|ожидается|надеемся)(?!\p{L})|(?:пока|ещ[её])\s+не\s+(?:получ|выда)|не\s+(?:получ|выда|положитель)|отрицатель|отказ|приостанов/iu.test(text)) return { status: 'ignore', reason: 'not_a_positive_final_result' };
  const explicitDecision = /решени[еяю]\s+(?:о\s+)?(?:выдач|продлен|продлён|переоформ)|решени[ея]\s+(?:получ|готов|положитель)|положительн\w*\s+решени|лицензи[яю]\s+(?:получ|выдан)|получил[аи]?\s+лицензи/iu.test(text);
  const positive = explicitDecision || /положительн/iu.test(text);
  if (!positive) return { status: 'ignore', reason: 'no_positive_result' };
  if (!explicitDecision && /проверк|осмотр|выезд|(?<!\p{L})акт(?!\p{L})|оценк/iu.test(text)) return { status: 'ignore', reason: 'inspection_is_not_a_license_decision' };
  if (text.includes('?')) return { status: 'review', reason: 'positive_result_is_a_question' };
  const labelled = [...text.matchAll(/инн\s*[:№-]?\s*(\d{10}(?:\d{2})?)(?!\d)/giu)].map((m) => m[1]);
  const uniqueInns = [...new Set(labelled)];
  if (uniqueInns.some((inn) => !isValidInn(inn))) return { status: 'review', reason: 'invalid_explicit_inn' };
  if (uniqueInns.length > 1) return { status: 'review', reason: 'multiple_organizations_in_one_message' };
  const rows = contextRows.some(Array.isArray) ? parseSheetRows(contextRows) : contextRows;
  const textName = normalizeName(text);
  const matchingNames = rows.filter((row) => [row.organization, ...(row.aliases ?? [])].some((name) => {
    const n = normalizeName(name);
    return n.length >= 2 && (` ${textName} `).includes(` ${n} `);
  }));
  const namedInns = [...new Set(matchingNames.map((r) => clean(r.inn)).filter(isValidInn))];
  const inn = uniqueInns[0] ?? (namedInns.length === 1 ? namedInns[0] : null);
  if (!inn) return { status: 'review', reason: matchingNames.length ? 'organization_name_is_ambiguous' : 'organization_not_identified' };
  const companyRows = rows.filter((r) => clean(r.inn) === inn);
  const quoted = text.match(/(?:ООО|АО|ПАО|ИП)\s*[«"“]([^»"”]+)[»"”]/iu);
  const companyNames = [...new Set(companyRows.map((r) => clean(r.organization)).filter(Boolean))];
  const organization = quoted ? `${text.match(/ООО|ПАО|АО|ИП/iu)[0].toUpperCase()} «${quoted[1].trim()}»` : companyNames.length === 1 ? companyNames[0] : matchingNames.find((r) => clean(r.inn) === inn)?.organization ?? null;
  const kpp = text.match(/кпп(?:\s+(?:объекта|подразделения))?\s*[:№-]?\s*(\d{9})(?!\d)/iu)?.[1] ?? null;
  const licenseNumber = normalizeLicenseNumber(text.match(/(?:лицензи[яию]|лиц\.)\s*(?:№|номер)?\s*(\d{2}[А-ЯA-Z]{2,4}\d{4,10})/iu)?.[1]) || null;
  const address = clean(message.address) || null;
  const operation = canonicalOperation(text);
  const knownOperation = companyRows.length === 1 ? companyRows[0].expectedOperation : null;
  const decisionDateRaw = message.decisionDate ?? text.match(/решени\p{L}*\s*(?:№\s*[\p{L}\p{N}/_-]+\s*)?(?:от\s+)?(\d{1,2}[./]\d{1,2}[./]\d{4})/iu)?.[1];
  let reportedAt;
  try { reportedAt = timestamp(message.date ?? message.timestamp, timeZone).toISOString(); } catch { return { status: 'review', reason: 'missing_or_invalid_message_date' }; }
  let id;
  try { id = sourceEventKey(message); } catch { return { status: 'review', reason: 'missing_message_identity' }; }
  return { status: 'event', event: { id, sourceEventKey: id, reportedAt, reportedDate: localDate(reportedAt, timeZone), organization: clean(organization) || null, inn, operation: operation === 'unknown' && knownOperation ? knownOperation : operation, kpp, licenseNumber, address, decisionDate: normalizeDate(decisionDateRaw), documentId: message.document?.file_unique_id ?? message.documentId ?? null, sourceUrl: message.url ?? message.sourceUrl ?? null, author: message.author ?? message.from?.name ?? null, nextCheckAt: nextMorning(reportedAt, { timeZone }) } };
}

export function normalizeLicense(item) {
  const get = (canonical, russian) => item[canonical] ?? item[russian];
  return { ...item, inn: clean(get('inn', 'ИНН')), kpp: clean(get('kpp', 'КПП подразделения')), organization: clean(item.organization ?? item['Наименование организации'] ?? item['Наименование']), licenseNumber: normalizeLicenseNumber(get('licenseNumber', 'Номер лицензии')), issueDate: normalizeDate(get('issueDate', 'Дата выдачи')), expiryDate: normalizeDate(get('expiryDate', 'Дата окончания')), activity: clean(get('activity', 'Вид лицензии')), address: clean(get('address', 'Адрес подразделения')), status: clean(get('status', 'Статус лицензии')).toLowerCase(), changeDate: normalizeDate(get('changeDate', 'Дата изменения')), changeReason: clean(get('changeReason', 'Основание изменения')), email: clean(get('email', 'e-mail')) };
}
export function mapActivityForSheet(value) {
  const activity = clean(value).toLowerCase().replace(/ё/gu, 'е');
  if (!activity) return null;
  if (/общепит|общественного\s+питания/u.test(activity)) return SHEET_ACTIVITY_VALUES[0];
  if (activity === 'магазин' || /розничная\s+продажа/u.test(activity)) return SHEET_ACTIVITY_VALUES[1];
  if (activity === 'опт' || /закупк[аи].*хранени[ея].*поставк/u.test(activity)) return SHEET_ACTIVITY_VALUES[2];
  return null;
}
export function licenseIdentity(value) {
  const l = normalizeLicense(value);
  if (!isValidInn(l.inn) || !l.licenseNumber) throw new Error('A valid INN and license number are required');
  return [l.inn, l.licenseNumber, l.kpp, normalizeAddress(l.address)].join('|');
}
const active = (l) => /^(?:действующая|действует|active)$/u.test(l.status);
function eventDate(event) { return normalizeDate(event.decisionDate) ?? normalizeDate(event.reportedDate) ?? (event.reportedAt ? localDate(event.reportedAt) : null); }

export function selectLicense(event, items, { freshnessWindowDays = 2, requireFreshEvent = true } = {}) {
  if (!isValidInn(event.inn)) return { status: 'review', reason: 'event_inn_required' };
  if (!Array.isArray(items)) return { status: 'review', reason: 'invalid_or_incomplete_api_response' };
  if (items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return { status: 'review', reason: 'invalid_api_record' };
  let candidates = items.map(normalizeLicense).filter((l) => l.inn === event.inn && active(l));
  if (event.licenseNumber) candidates = candidates.filter((l) => l.licenseNumber === normalizeLicenseNumber(event.licenseNumber));
  if (event.kpp) candidates = candidates.filter((l) => l.kpp === clean(event.kpp));
  if (event.address) candidates = candidates.filter((l) => normalizeAddress(l.address) === normalizeAddress(event.address));
  if (!candidates.length) return { status: 'waiting', reason: 'no_matching_active_license' };
  if (candidates.some((l) => !l.licenseNumber || !l.issueDate || !l.expiryDate || l.expiryDate < l.issueDate)) return { status: 'review', reason: 'invalid_license_fields' };
  const unique = new Map();
  for (const l of candidates) {
    const key = licenseIdentity(l);
    if (unique.has(key)) {
      const previous = unique.get(key);
      if (previous.issueDate !== l.issueDate || previous.expiryDate !== l.expiryDate || previous.changeDate !== l.changeDate) return { status: 'review', reason: 'conflicting_api_records' };
    } else unique.set(key, l);
  }
  candidates = [...unique.values()];
  if (requireFreshEvent) {
    const decision = eventDate(event);
    if (!decision) return { status: 'review', reason: 'event_date_required' };
    const cutoff = new Date(Date.parse(`${decision}T00:00:00Z`) - (event.decisionDate ? 0 : freshnessWindowDays) * DAY).toISOString().slice(0, 10);
    candidates = candidates.filter((l) => (event.operation === 'issuance' ? l.issueDate : l.changeDate ?? l.issueDate) >= cutoff);
    if (!candidates.length) return { status: 'waiting', reason: 'registry_has_not_reflected_event' };
  }
  if (candidates.length !== 1) return { status: 'review', reason: 'multiple_licenses_or_objects', candidateCount: candidates.length };
  const license = candidates[0];
  if (event.operation === 'renewal' && license.changeReason && !/продлен|продлён/iu.test(license.changeReason)) return { status: 'review', reason: 'api_operation_does_not_match_renewal' };
  if (event.operation === 'reissue' && license.changeReason && !/переоформ|изменени/iu.test(license.changeReason)) return { status: 'waiting', reason: 'registry_has_not_reflected_reissue' };
  if (event.operation === 'renewal' && event.previousExpiryDate && license.expiryDate <= normalizeDate(event.previousExpiryDate)) return { status: 'waiting', reason: 'renewal_has_not_extended_expiry' };
  return { status: 'ready', license, identity: licenseIdentity(license) };
}

function rowValue(row, field) { return clean(row.values?.[SHEET_COLUMNS[field]] ?? row[field]); }
function wholeRow(row) {
  if (row.values) return [...row.values];
  const values = Array(17).fill('');
  for (const [field, index] of Object.entries(SHEET_COLUMNS)) values[index] = clean(row[field]);
  return values;
}
function columnLetter(index) { return String.fromCharCode(65 + index); }

export function planSheetUpsert(value, existingRows, event = {}, { timeZone = 'Europe/Moscow' } = {}) {
  const l = normalizeLicense(value);
  const rows = existingRows.some(Array.isArray) ? parseSheetRows(existingRows) : existingRows;
  if (!isValidInn(l.inn) || !l.licenseNumber || !l.issueDate || !l.expiryDate || l.expiryDate < l.issueDate || !active(l)) return { action: 'review', reason: 'invalid_license_fields', updates: [] };
  if (event.inn && event.inn !== l.inn) return { action: 'review', reason: 'event_inn_mismatch', updates: [] };
  const sameInn = rows.filter((r) => rowValue(r, 'inn') === l.inn);
  let matches = sameInn.filter((r) => normalizeLicenseNumber(rowValue(r, 'licenseNumber')) === l.licenseNumber);
  const incomplete = sameInn.filter((r) => !rowValue(r, 'licenseNumber'));
  const exactIncomplete = incomplete.filter((r) => l.address && normalizeAddress(rowValue(r, 'address')) === normalizeAddress(l.address));
  const datedIncomplete = exactIncomplete.filter((r) => normalizeDate(rowValue(r, 'issueDate')) === l.issueDate &&
    normalizeDate(rowValue(r, 'expiryDate')) === l.expiryDate);
  const earlierPeriod = (r) => {
    const issue = normalizeDate(rowValue(r, 'issueDate'));
    const expiry = normalizeDate(rowValue(r, 'expiryDate'));
    return issue && expiry && expiry >= issue && issue <= l.issueDate && expiry < l.expiryDate;
  };
  if (matches.length && datedIncomplete.length) {
    // A renewal can already have its own manually entered row with blank H.
    // Prefer that row only when both dates and the exact object agree, and all
    // numbered candidates are demonstrably earlier periods. Row order/number
    // and a merely different address never establish a historical period.
    const historical = matches.every(earlierPeriod);
    if (datedIncomplete.length !== 1 || !historical) return { action: 'review', reason: 'duplicate_or_ambiguous_sheet_records', updates: [] };
    matches = datedIncomplete;
  }
  if (matches.length > 1) {
    matches = matches.filter((r) => normalizeAddress(rowValue(r, 'address')) === normalizeAddress(l.address));
    if (matches.length > 1) {
      const currentPeriod = matches.filter((r) => normalizeDate(rowValue(r, 'issueDate')) === l.issueDate &&
        normalizeDate(rowValue(r, 'expiryDate')) === l.expiryDate);
      if (currentPeriod.length === 1 && matches.filter((r) => r !== currentPeriod[0]).every(earlierPeriod)) matches = currentPeriod;
    }
    if (matches.length !== 1) return { action: 'review', reason: 'duplicate_or_ambiguous_sheet_records', updates: [] };
  }
  if (!matches.length) {
    if (exactIncomplete.length === 1) matches = exactIncomplete;
    else if (incomplete.length) return { action: 'review', reason: 'incomplete_existing_sheet_record', updates: [] };
  }
  if (!matches.length && rows.some((r) => normalizeLicenseNumber(rowValue(r, 'licenseNumber')) === l.licenseNumber && rowValue(r, 'inn') !== l.inn)) return { action: 'review', reason: 'license_number_belongs_to_other_inn', updates: [] };
  const current = matches[0];
  if (current) {
    for (const field of ['issueDate', 'expiryDate']) {
      const raw = rowValue(current, field);
      const normalized = normalizeDate(raw);
      if (raw && !normalized) return { action: 'review', reason: `unparseable_existing_${field}`, updates: [] };
      if (normalized && l[field] < normalized) return { action: 'review', reason: `api_${field}_older_than_existing`, updates: [] };
    }
    const knownChange = normalizeDate(current.changeDate ?? current.lastVerifiedChangeDate);
    if (knownChange && (!l.changeDate || l.changeDate < knownChange)) return { action: 'waiting', reason: 'api_older_than_verified_sheet_record', updates: [] };
    const oldAddress = rowValue(current, 'address');
    if (oldAddress && l.address && normalizeAddress(oldAddress) !== normalizeAddress(l.address)) {
      if (event.operation !== 'reissue' || !eventDate(event) || !l.changeDate || l.changeDate < eventDate(event)) return { action: 'review', reason: 'object_address_conflict', updates: [] };
    }
  }
  const organization = l.organization || clean(event.organization) || (current && rowValue(current, 'organization'));
  if (!organization) return { action: 'review', reason: 'organization_name_required', updates: [] };
  const activity = mapActivityForSheet(l.activity);
  if (l.activity && !activity && (!current || !rowValue(current, 'activity'))) return { action: 'review', reason: 'unsupported_activity_for_sheet', updates: [] };
  const desired = { organization, inn: l.inn, licenseNumber: l.licenseNumber, issueDate: l.issueDate, expiryDate: l.expiryDate, activity: activity ?? '', address: l.address, email: l.email };
  const values = current ? wholeRow(current) : Array(17).fill('');
  const updates = [];
  for (const [field, index] of Object.entries(SHEET_COLUMNS)) {
    const after = field === 'activity' ? String(desired[field] ?? '') : clean(desired[field]);
    const before = clean(values[index]);
    if (!after || (field === 'email' && (before || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(after))) || (field === 'organization' && before && !l.organization)) continue;
    const same = ['issueDate', 'expiryDate'].includes(field) ? normalizeDate(before) === after : field === 'licenseNumber' ? normalizeLicenseNumber(before) === after : field === 'address' ? normalizeAddress(before) === normalizeAddress(after) : field === 'activity' ? clean(before) === clean(after) : before === after;
    if (!same) { values[index] = after; updates.push({ row: current?.rowNumber ?? null, column: columnLetter(index), columnIndex: index, before: current ? before : '', after }); }
  }
  const identity = licenseIdentity(l);
  if (!current) return { action: 'append', values, updates, identity, sourceEventKey: event.sourceEventKey ?? event.id ?? null };
  if (!Number.isInteger(current.rowNumber) || current.rowNumber < 2) return { action: 'review', reason: 'row_number_required', updates: [] };
  return { action: updates.length ? 'update' : 'noop', rowNumber: current.rowNumber, updates, identity, sourceEventKey: event.sourceEventKey ?? event.id ?? null };
}

export function prepareJob(event, existingJobs = [], options = {}) {
  const fingerprint = event.documentId ? `document:${event.documentId}:${event.inn}` : null;
  const prior = existingJobs.find((job) => job.sourceEventKey === (event.sourceEventKey ?? event.id) || (fingerprint && job.fingerprint === fingerprint));
  if (prior) return { created: false, job: prior, reason: 'duplicate_event' };
  const id = createHash('sha256').update(event.sourceEventKey ?? event.id).digest('hex').slice(0, 24);
  return { created: true, job: { ...event, id, sourceEventKey: event.sourceEventKey ?? event.id, fingerprint, status: 'waiting', attempts: 0, nextCheckAt: event.nextCheckAt ?? nextMorning(event.reportedAt, options) } };
}
export function isJobDue(job, now = new Date()) { return job.status === 'waiting' && Number.isFinite(Date.parse(job.nextCheckAt)) && Date.parse(job.nextCheckAt) <= +timestamp(now); }
export function planRetry(job, { now = new Date(), timeZone = 'Europe/Moscow', hour = 9, maxAttempts = 7, quotaRemaining = Infinity, quotaReserve = 0 } = {}) {
  if (job.status !== 'waiting') return { ...job, reason: 'job_not_waiting' };
  if (!Number.isInteger(job.attempts) || job.attempts < 0) throw new Error('Invalid attempt counter');
  if (job.attempts >= maxAttempts) return { ...job, status: 'review', reason: 'maximum_attempts_reached', nextCheckAt: null };
  if (!Number.isFinite(quotaRemaining) && quotaRemaining !== Infinity) throw new Error('Invalid quota');
  if (quotaRemaining <= quotaReserve) return { ...job, status: 'quota_exhausted', reason: 'insufficient_api_quota', nextCheckAt: null };
  return { ...job, status: 'waiting', nextCheckAt: nextMorning(now, { timeZone, hour }), reason: 'retry_next_morning' };
}
