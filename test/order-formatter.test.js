const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOrderMessage } = require('../src/bot/formatter');
const { normalizeManagerOrder } = require('../src/web/order-materials');

function order(fields = {}) {
  return { id: 2147483647, address: 'Москва, Лесная, 5', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Продление',
    archive_url: 'https://disk.yandex.ru/d/abcdef', status: 'in_progress', created_at: '2026-11-05T08:30:00.000Z', deadline: '2026-11-12', submitted_name: 'Менеджер', ...fields };
}

test('a valid maximum-size manager packet fits one Telegram card and keeps later contact phones visible', () => {
  const data = normalizeManagerOrder({ address: 'а'.repeat(500), owner_name: 'б'.repeat(500), object_name: 'в'.repeat(500), object_type: 'Общепит алкоголь',
    service: 'Продление', archive_url: 'https://disk.yandex.ru/d/abcdef?path=/' + 'd'.repeat(1450), zones_info: 'Задача '.repeat(570),
    contacts: 'Комментарий '.repeat(300) + '\nИван +7 (999) 555-44-33; Анна 8 (495) 123-45-67' }, []);
  const original = order(data), snapshot = structuredClone(original), text = formatOrderMessage(original);
  assert.ok(text.length <= 4096, 'Telegram rejects cards longer than its message limit');
  assert.match(text, /\+7 \(999\) 555-44-33/); assert.match(text, /8 \(495\) 123-45-67/);
  assert.match(text, /Задача и известные зоны:<\/b>[^\n]*…/);
  assert.match(text, /Архив объекта:<\/b> Ссылка сохранена в заявке/);
  assert.deepEqual(original, snapshot, 'The complete packet stays in the database/form; only the chat preview is shortened');
});

test('bounded Telegram HTML never splits entities, emoji or its formatting tags', () => {
  const text = formatOrderMessage(order({ address: '&<>🏠'.repeat(150), owner_name: '&'.repeat(500), object_type: '<'.repeat(500), object_name: '>'.repeat(500),
    zones_info: '&<🏠>'.repeat(1000), contacts: '<&>'.repeat(1200) + ' +79995554433', cad_num: '&'.repeat(100), submitted_name: '🏠&'.repeat(1000) }));
  assert.ok(text.length <= 4096);
  assert.equal(text.isWellFormed(), true);
  assert.doesNotMatch(text, /&(?!(?:amp|lt|gt);)/);
  const stack = [];
  for (const match of text.matchAll(/<(\/?)(b|i)>/g)) { if (!match[1]) stack.push(match[2]); else assert.equal(stack.pop(), match[2]); }
  assert.deepEqual(stack, []);
  assert.match(text, /\+79995554433/);
});

test('ordinary cards retain complete addresses, contact names and short archive links', () => {
  const original = order({ contacts: 'Иван +7 (999) 555-44-33', zones_info: 'Проверить школу рядом' }), text = formatOrderMessage(original);
  for (const value of [original.address, original.owner_name, original.contacts, original.zones_info, original.archive_url]) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /…/);
});
