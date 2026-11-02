import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTelegramSearchSnapshot } from './telegram-ui.mjs';

const options = { chatId: '5164597211', chatTitle: 'Лицензии на алкоголь', now: '2026-11-01T18:00:00+03:00', timeZone: 'Europe/Moscow' };
const row = (text, date = '28.10.2026 at 10:53', n = 3, chat = 'Лицензии на алкоголь') => `\t\t${n} text Group, ${chat}, ${text}, ${date}, ID: N7Dialogs11InnerWidgetE`;

test('extracts the full wrapped caption, sender and exact visible Moscow minute', () => {
  const parsed = parseTelegramSearchSnapshot(row('Валера Рабочий: Photo, \u200e\u2068хорошот, положительное\nИНН 9705148570\u2069, Reactions: ⚡, Received'), options);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.messages.length, 1);
  const message = parsed.messages[0];
  assert.equal(message.author, 'Валера Рабочий');
  assert.equal(message.text, 'хорошот, положительное\nИНН 9705148570');
  assert.equal(message.date, '2026-10-28T07:53:00.000Z');
  assert.match(message.id, /^ui-[a-f0-9]{64}$/u);
  assert.equal(message.source_kind, 'telegram_ui_search');
  assert.equal(message.source_url, null);
  assert.equal(message.source_message_id, null);
});

test('deduplicates observations independently of AX numbers, IDs and reactions', () => {
  const first = row('Валера Рабочий: Photo, \u2068хорошот положительное\u2069, Reactions: ⚡, Received');
  const second = row('Валера Рабочий: Photo, \u2068хорошот положительное\u2069, Reactions: ❤ 8, 🔥, Received', undefined, 140).replace('N7Dialogs11InnerWidgetE', 'changed-native-id');
  const one = parseTelegramSearchSnapshot(first, options);
  const two = parseTelegramSearchSnapshot(second, options);
  const combined = parseTelegramSearchSnapshot(`${first}\n${second}`, options);
  assert.equal(one.messages[0].id, two.messages[0].id);
  assert.equal(combined.messages.length, 1);
});

test('does not strip metadata-looking words inside a wrapped caption', () => {
  const parsed = parseTelegramSearchSnapshot(row('Seen, Photo, \u2068ООО Photo, Received, Reactions: решение положительно\u2069, Reactions: ❤'), options);
  assert.equal(parsed.messages[0].text, 'ООО Photo, Received, Reactions: решение положительно');
  assert.equal(parsed.messages[0].author, null);
});

test('strips suffix metadata from unwrapped own and received messages', () => {
  const parsed = parseTelegramSearchSnapshot([
    row('Seen, Ресторан положительно', '10.09.2026 at 11:33'),
    row('Валера Рабочий: БХ решение положительное, Reactions: 🔥, Received', '02.09.2026 at 11:24', 4),
  ].join('\n'), options);
  assert.deepEqual(parsed.messages.map((m) => m.text), ['БХ решение положительное', 'Ресторан положительно']);
  assert.equal(parsed.messages[0].author, 'Валера Рабочий');
});

test('only exact target-group search rows are accepted, never the history pane or another group', () => {
  const snapshot = [row('Seen, Верно положительно'), row('Seen, Чужое положительно', undefined, 4, 'Лицензии на алкоголь чужие'), '5 text Secondary Actions: Raise, Валера Рабочий\nGroup, Лицензии на алкоголь, Не поиск положительно\nReceived at 12:00, ID: native', row('Seen, Чужое положительно', undefined, 6, 'Другой чат')].join('\n');
  const parsed = parseTelegramSearchSnapshot(snapshot, options);
  assert.deepEqual(parsed.messages.map((m) => m.text), ['Верно положительно']);
});

test('since filters messages while observed bounds retain older visible search coverage', () => {
  const parsed = parseTelegramSearchSnapshot([row('Seen, Старое положительно'), row('Seen, Новое положительно', '01.11.2026 at 10:00', 4)].join('\n'), { ...options, since: '2026-11-01T00:00:00+03:00' });
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].text, 'Новое положительно');
  assert.equal(parsed.oldestObservedAt, '2026-10-28T07:53:00.000Z');
  assert.equal(parsed.newestObservedAt, '2026-11-01T07:00:00.000Z');
});

test('today and yesterday resolve in Moscow rather than the execution timezone', () => {
  const parsed = parseTelegramSearchSnapshot([row('Seen, Сегодня положительно', 'Today at 00:10'), row('Seen, Вчера положительно', 'Yesterday at 23:50', 4)].join('\n'), { ...options, now: '2026-10-31T23:30:00Z' });
  assert.deepEqual(parsed.messages.map((m) => m.date), ['2026-10-31T20:50:00.000Z', '2026-10-31T21:10:00.000Z']);
});

test('recent weekday labels resolve, a same-weekday label remains ambiguous', () => {
  const parsed = parseTelegramSearchSnapshot([row('Seen, Пятница положительно', 'Friday at 10:00'), row('Seen, Неясно положительно', 'Sunday at 10:00', 4)].join('\n'), options);
  assert.equal(parsed.messages[0].date, '2026-10-30T07:00:00.000Z');
  assert.equal(parsed.messages.length, 1);
  assert.ok(parsed.errors.some((e) => e.code === 'ambiguous_weekday_date'));
});

test('invalid, undated and future messages cannot acquire an invented timestamp', () => {
  const parsed = parseTelegramSearchSnapshot([row('Seen, Невалидно положительно', '31.02.2026 at 10:00'), row('Seen, Без даты положительно', '10:00', 4), row('Seen, Будущее положительно', '02.11.2026 at 10:00', 5)].join('\n'), options);
  assert.equal(parsed.messages.length, 0);
  assert.deepEqual(parsed.errors.map((e) => e.code), ['invalid_message_datetime', 'missing_or_unrecognized_message_date', 'future_message_datetime']);
});

test('DST ambiguity is rejected rather than selecting an arbitrary instant', () => {
  const parsed = parseTelegramSearchSnapshot(row('Seen, Смена времени положительно', '01.11.2026 at 01:30'), { ...options, timeZone: 'America/New_York', now: '2026-11-01T20:00:00Z' });
  assert.equal(parsed.messages.length, 0);
  assert.equal(parsed.errors[0].code, 'ambiguous_message_datetime');
});

function fixtureExport(t, records, folder = 'chat-5164597211-test') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ui-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, folder, 'messages.jsonl');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, records.map((r) => JSON.stringify(r)).join('\n'));
  return target;
}
const exported = (id = 62436, chat = '5164597211') => ({ evidence_id: `telegram:chat-${chat}-test:message:${id}`, message: { id, type: 'message', date: '2026-10-28T10:53:59', date_unixtime: String(Date.parse('2026-10-28T07:53:59Z') / 1000), from: 'Валера Рабочий', text: 'хорошот положительное' } });

test('an exact scoped export match supplies the real id and private-group link', (t) => {
  const file = fixtureExport(t, [exported()]);
  const parsed = parseTelegramSearchSnapshot(row('Валера Рабочий: Photo, \u2068хорошот положительное\u2069, Received'), { ...options, exportMessagesPath: file });
  assert.equal(parsed.messages[0].id, 62436);
  assert.equal(parsed.messages[0].source_message_id, 62436);
  assert.equal(parsed.messages[0].source_url, 'https://t.me/c/5164597211/62436');
  assert.equal(parsed.messages[0].source_kind, 'telegram_export_matched_ui');
  assert.match(parsed.messages[0].ui_id, /^ui-/u);
});

test('same text in another chat or minute never fabricates a Telegram source link', (t) => {
  const otherMinute = exported(62437); otherMinute.message.date_unixtime = String(Date.parse('2026-10-28T07:54:59Z') / 1000);
  const file = fixtureExport(t, [exported(62436, '12345'), otherMinute]);
  const parsed = parseTelegramSearchSnapshot(row('Photo, \u2068хорошот положительное\u2069, Received'), { ...options, exportMessagesPath: file });
  assert.match(parsed.messages[0].id, /^ui-/u);
  assert.equal(parsed.messages[0].source_url, null);
});

test('ambiguous matching exports retain a synthetic id and surface the conflict', (t) => {
  const file = fixtureExport(t, [exported(1), exported(2)]);
  const parsed = parseTelegramSearchSnapshot(row('Photo, \u2068хорошот положительное\u2069, Received'), { ...options, exportMessagesPath: file });
  assert.match(parsed.messages[0].id, /^ui-/u);
  assert.equal(parsed.messages[0].source_url, null);
  assert.ok(parsed.errors.some((e) => e.code === 'ambiguous_export_match'));
});

test('CLI writes bounded private output without printing message text', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ui-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = path.join(directory, 'snapshot.ax'); const output = path.join(directory, 'messages.json');
  fs.writeFileSync(snapshot, row('Seen, Секретный клиент положительно'));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./telegram-ui.mjs', import.meta.url)), '--snapshot', snapshot, '--since', '2026-10-01T00:00:00+03:00', '--now', options.now, '--out', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).messages.length, 1);
  assert.ok(!run.stdout.includes('Секретный клиент'));
});
