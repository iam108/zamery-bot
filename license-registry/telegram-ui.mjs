#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_TEXT = 20000;
const DEFAULT_CHAT_ID = '5164597211';
const DEFAULT_CHAT_TITLE = 'Лицензии на алкоголь';
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const normalized = (text) => String(text ?? '').normalize('NFKC').replace(BIDI, '').replace(/\s+/gu, ' ').trim();
const cleaned = (text) => String(text ?? '').normalize('NFKC').replace(BIDI, '').replace(/\r\n?/gu, '\n').trim();
const chatNumber = (value) => String(value ?? '').replace(/^-100/u, '');

function partsAt(value, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

// More than one matching instant means an ambiguous DST wall time. Never guess it.
function wallInstant(parts, timeZone) {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const calendar = new Date(wall);
  if (calendar.getUTCFullYear() !== parts.year || calendar.getUTCMonth() + 1 !== parts.month || calendar.getUTCDate() !== parts.day || parts.hour > 23 || parts.minute > 59) return { error: 'invalid_message_datetime' };
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wall + hours * 3600000;
    const p = partsAt(new Date(sample), timeZone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample);
  }
  const candidates = [...offsets].map((offset) => wall - offset).filter((instant) => {
    const p = partsAt(new Date(instant), timeZone);
    return ['year', 'month', 'day', 'hour', 'minute'].every((field) => p[field] === parts[field]);
  });
  return candidates.length === 1 ? { instant: candidates[0] } : { error: candidates.length ? 'ambiguous_message_datetime' : 'invalid_message_datetime' };
}

const WEEKDAYS = new Map([
  ['sunday', 0], ['sun', 0], ['воскресенье', 0], ['вс', 0],
  ['monday', 1], ['mon', 1], ['понедельник', 1], ['пн', 1],
  ['tuesday', 2], ['tue', 2], ['вторник', 2], ['вт', 2],
  ['wednesday', 3], ['wed', 3], ['среда', 3], ['ср', 3],
  ['thursday', 4], ['thu', 4], ['четверг', 4], ['чт', 4],
  ['friday', 5], ['fri', 5], ['пятница', 5], ['пт', 5],
  ['saturday', 6], ['sat', 6], ['суббота', 6], ['сб', 6],
]);

function visibleDate(label, hour, minute, now, timeZone) {
  let year; let month; let day;
  const full = label.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u);
  if (full) [, day, month, year] = full.map(Number);
  else {
    const localNow = partsAt(now, timeZone);
    const localDay = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day));
    const word = normalized(label).toLowerCase().replace(/\.$/u, '');
    let daysBack;
    if (word === 'today' || word === 'сегодня') daysBack = 0;
    else if (word === 'yesterday' || word === 'вчера') daysBack = 1;
    else if (WEEKDAYS.has(word)) {
      daysBack = (localDay.getUTCDay() - WEEKDAYS.get(word) + 7) % 7;
      // A same-weekday label could mean today or one week ago. Telegram's
      // Today label is distinct, so retain the uncertainty rather than guessing.
      if (daysBack === 0) return { error: 'ambiguous_weekday_date' };
    } else return { error: 'unrecognized_message_date' };
    localDay.setUTCDate(localDay.getUTCDate() - daysBack);
    year = localDay.getUTCFullYear(); month = localDay.getUTCMonth() + 1; day = localDay.getUTCDate();
  }
  const resolved = wallInstant({ year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) }, timeZone);
  if (resolved.error) return resolved;
  if (resolved.instant > +now + 60000) return { error: 'future_message_datetime' };
  return { date: new Date(resolved.instant).toISOString(), minute: Math.floor(resolved.instant / 60000) };
}

function wrappedCaption(value) {
  const start = value.search(/[\u2066-\u2068]/u);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < value.length; i += 1) {
    if (/[\u2066-\u2068]/u.test(value[i])) depth += 1;
    else if (value[i] === '\u2069') {
      depth -= 1;
      if (depth === 0) return { text: value.slice(start + 1, i), prefix: value.slice(0, start) };
    }
  }
  return { error: 'unterminated_caption_marker' };
}

function captionOf(value) {
  const wrapped = wrappedCaption(value);
  if (wrapped?.error) return wrapped;
  let prefix = wrapped?.prefix ?? value;
  const own = /^\s*(?:Seen|Sent|Me)(?:\s*,|\s*:|$)/iu.test(prefix);
  prefix = prefix.replace(/^\s*(?:(?:Seen|Received|Sent|Me)(?:\s+edited)?\s*,\s*)+/iu, '');
  const authorMatch = !own && prefix.match(/^([^:\n]{1,120}):\s*/u);
  const author = authorMatch && !/^(?:Photo|File|Video|Audio|Reactions)$/iu.test(authorMatch[1].trim()) ? cleaned(authorMatch[1]) : null;
  if (wrapped) return { text: cleaned(wrapped.text), author };
  let text = value;
  if (author) text = text.slice(text.indexOf(':') + 1);
  text = text.replace(/^\s*(?:(?:Seen|Received|Sent|Me)(?:\s+edited)?\s*,\s*)+/iu, '');
  text = text.replace(/^\s*(?:Photo(?:\s*,\s*\d+\s*[×x]\s*\d+)?|Video|Audio|Voice message)\s*,\s*/iu, '');
  // These are suffixes added to search snippets, not words inside a caption.
  text = text.replace(/,\s*Reactions:\s*[\s\S]*$/iu, '');
  text = text.replace(/(?:,\s*(?:Received|Sent|Seen)(?:\s+edited)?)+\s*$/iu, '');
  return { text: cleaned(text), author };
}

function searchRows(snapshot) {
  const rows = [];
  let active = null;
  for (const line of snapshot.split(/\r?\n/u)) {
    const start = line.match(/^\s*(?:[+~]\s*)?(\d+)\s+text\s+(Group,[\s\S]*)$/u);
    if (start) {
      if (active) rows.push({ ...active, incomplete: true });
      active = { elementIndex: Number(start[1]), value: start[2] };
    } else if (active && /^\s*(?:[+~]\s*)?\d+\s+(?:text|cell|button|container|row|heading|list|table|link|menu)\b/u.test(line)) {
      rows.push({ ...active, incomplete: true }); active = null;
    } else if (active) active.value += `\n${line}`;
    if (active && /,\s*ID:\s*\S+[\s\S]*$/u.test(active.value)) {
      rows.push({ ...active, value: active.value.replace(/,\s*ID:\s*\S+[\s\S]*$/u, '') }); active = null;
    }
    if (rows.length > MAX_ROWS) break;
  }
  if (active) rows.push({ ...active, incomplete: true });
  return rows;
}

function exportIndex(file, chatId, timeZone, errors) {
  const index = new Map();
  if (!file) return index;
  let text;
  try {
    if (fs.statSync(file).size > MAX_EXPORT_BYTES) { errors.push({ code: 'export_too_large' }); return index; }
    text = fs.readFileSync(file, 'utf8');
  } catch { errors.push({ code: 'export_not_readable' }); return index; }
  const folderChat = path.basename(path.dirname(file)).match(/^chat-(\d+)(?:-|$)/u)?.[1];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { errors.push({ code: 'invalid_export_json', line: i + 1 }); continue; }
    const message = row.message ?? row;
    if (message.type && message.type !== 'message') continue;
    const evidence = String(row.evidence_id ?? '').match(/^telegram:chat-(\d+)(?:-[^:]+)?:message:(\d+)$/u);
    const explicitChat = row.chatId ?? row.chat_id ?? message.chatId ?? message.chat_id ?? message.chat?.id;
    const scopedChat = evidence?.[1] ?? explicitChat ?? folderChat;
    if (scopedChat == null || chatNumber(scopedChat) !== chatId) continue;
    // Conflicting evidence must not be accepted merely because the folder matches.
    if (explicitChat != null && chatNumber(explicitChat) !== chatId) continue;
    const id = message.id;
    if (!Number.isSafeInteger(id) || id <= 0 || (evidence && Number(evidence[2]) !== id)) continue;
    const value = Array.isArray(message.text) ? message.text.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('') : message.text ?? message.caption ?? '';
    if (!normalized(value)) continue;
    let instant;
    if (/^\d{9,13}$/u.test(String(message.date_unixtime ?? ''))) {
      const unix = Number(message.date_unixtime); instant = unix < 1e12 ? unix * 1000 : unix;
    } else if (typeof message.date === 'string') {
      if (/(?:Z|[+-]\d\d:\d\d)$/u.test(message.date)) instant = Date.parse(message.date);
      else {
        const m = message.date.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/u);
        if (m) instant = wallInstant({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, timeZone).instant;
      }
    }
    if (!Number.isFinite(instant)) continue;
    const key = `${Math.floor(instant / 60000)}\u0000${normalized(value)}`;
    const matches = index.get(key) ?? [];
    if (!matches.some((m) => m.id === id)) matches.push({ id, author: message.from ?? null });
    index.set(key, matches);
  }
  return index;
}

/** Parse only target-group search snippets; history-pane messages are excluded.
 * Synthetic ui-* ids identify observations, never Telegram message numbers.
 * Weekday labels are interpreted in Telegram's preceding six-day window;
 * a same-weekday label is rejected as ambiguous.
 */
export function parseTelegramSearchSnapshot(snapshot, options = {}) {
  if (typeof snapshot !== 'string') throw new TypeError('snapshot must be text');
  const result = { messages: [], oldestObservedAt: null, newestObservedAt: null, errors: [] };
  if (Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) { result.errors.push({ code: 'snapshot_too_large' }); return result; }
  const chatId = chatNumber(options.chatId ?? DEFAULT_CHAT_ID);
  const chatTitle = cleaned(options.chatTitle ?? DEFAULT_CHAT_TITLE);
  if (!/^\d+$/u.test(chatId) || !chatTitle || chatTitle.includes('\n')) throw new TypeError('A numeric chatId and exact chatTitle are required');
  const timeZone = options.timeZone ?? 'Europe/Moscow';
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(+now)) throw new TypeError('now must be a valid timestamp');
  partsAt(now, timeZone); // Validate the configured zone even if there are no rows.
  const since = options.since == null ? -Infinity : Date.parse(options.since);
  if (options.since != null && !Number.isFinite(since)) throw new TypeError('since must be a valid timestamp');
  const index = exportIndex(options.exportMessagesPath, chatId, timeZone, result.errors);
  const prefix = `Group, ${chatTitle},`;
  const rows = searchRows(snapshot);
  if (rows.length > MAX_ROWS) result.errors.push({ code: 'too_many_search_rows' });
  const unique = new Map();
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (!cleaned(row.value).startsWith(prefix)) continue;
    const fail = (code) => result.errors.push({ code, elementIndex: row.elementIndex });
    if (row.incomplete) { fail('incomplete_search_row'); continue; }
    const remainder = row.value.slice(row.value.indexOf(',') + 1).trimStart();
    // Compare the title independently from the caption and do not accept prefixes.
    if (!remainder.startsWith(`${chatTitle},`)) continue;
    let snippet = remainder.slice(chatTitle.length + 1).trimStart();
    const date = snippet.match(/,\s*([^,\n]+?)\s+(?:at|в)\s+(\d{1,2}):(\d{2})\s*$/iu);
    if (!date) { fail('missing_or_unrecognized_message_date'); continue; }
    const resolved = visibleDate(date[1].trim(), date[2], date[3], now, timeZone);
    if (resolved.error) { fail(resolved.error); continue; }
    if (result.oldestObservedAt == null || resolved.date < result.oldestObservedAt) result.oldestObservedAt = resolved.date;
    if (result.newestObservedAt == null || resolved.date > result.newestObservedAt) result.newestObservedAt = resolved.date;
    snippet = snippet.slice(0, date.index);
    const caption = captionOf(snippet);
    if (caption.error) { fail(caption.error); continue; }
    if (!caption.text) continue;
    if (caption.text.length > MAX_TEXT) { fail('caption_too_large'); continue; }
    if (Date.parse(resolved.date) < since) continue;
    const digest = createHash('sha256').update([chatId, resolved.minute, normalized(caption.text)].join('\u0000')).digest('hex');
    const uiId = `ui-${digest}`;
    const matches = index.get(`${resolved.minute}\u0000${normalized(caption.text)}`) ?? [];
    if (matches.length > 1) fail('ambiguous_export_match');
    const verified = matches.length === 1 ? matches[0] : null;
    const message = { id: verified?.id ?? uiId, ui_id: uiId, chat_id: chatId, chatId, chat_title: chatTitle,
      date: resolved.date, text: caption.text, author: caption.author ?? verified?.author ?? null,
      source_kind: verified ? 'telegram_export_matched_ui' : 'telegram_ui_search',
      source_url: verified ? `https://t.me/c/${chatId}/${verified.id}` : null,
      source_message_id: verified?.id ?? null, source_date_label: date[1].trim() };
    if (!unique.has(uiId)) unique.set(uiId, message);
    else if (!unique.get(uiId).author && message.author) unique.get(uiId).author = message.author;
  }
  result.messages = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  return result;
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!/^--[a-z-]+$/u.test(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --snapshot FILE --since ISO --out FILE');
    options[argv[i].slice(2)] = argv[++i];
  }
  if (!options.snapshot || !options.since || !options.out) throw new Error('--snapshot, --since and --out are required');
  if (fs.statSync(options.snapshot).size > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds the size bound');
  const result = parseTelegramSearchSnapshot(fs.readFileSync(options.snapshot, 'utf8'), {
    chatId: options['chat-id'], chatTitle: options['chat-title'], timeZone: options['time-zone'], now: options.now,
    since: options.since, exportMessagesPath: options['export-messages'] ?? options['export-messages-path'],
  });
  const destination = path.resolve(options.out);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, destination); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  process.stdout.write(`${JSON.stringify({ output: destination, messages: result.messages.length, oldestObservedAt: result.oldestObservedAt, newestObservedAt: result.newestObservedAt, errors: result.errors })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
