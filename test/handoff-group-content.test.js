'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGroupNoticeParts } = require('../src/web/handoff-group-content');

function sample() {
  const row = {
    id: 39, order_id: 62, lawyer_name: 'Тестовый юрист', org: 'ООО Альфа', object_name: 'Название объекта',
    address: 'Москва, Тестовая, 62', region: 'МСК', kind: 'Общепит', service: 'Получение', priority: 'срочно',
    inn: '1234567890', comment: 'Первая строка с <текстом>\nВторая строка & уточнение',
    contacts: [{ name: 'Первый контакт', phone: '+79990000000', tg: '@first_test', comment: 'Заметка первая' },
      { name: 'Второй контакт', phone: '', tg: '@second_test', comment: 'Заметка вторая\nПояснение' },
      { name: 'Третий контакт', phone: '', tg: '@third_test' }],
    active_cases: 2,
  };
  const state = {
    body: { manual_client: false },
    fields: { cad_num: '77:01:1000000:123', technical_description_payment: 'paid' },
    manager_name: 'Тестовый менеджер',
    packet: {
      report: { status: 'actions', actor: 'Тестовый аудитор', video_url: 'https://protected.example/video?key=abc',
        readiness: { territory: 'Требуется осмотр зоны' }, media: [{ id: 'sample-media' }] },
      materials: [{ id: 'sample-file' }],
      archive_url: 'https://protected.example/archive?sig=abc',
      egrn_links: [{ id: 'sample-egrn', url: 'https://protected.example/egrn?sig=abc' }],
    },
    extraDocuments: { files: [{ id: 'sample-extra' }] },
    egrn: { result: 'included' },
  };
  return {row,state};
}

test('the group card keeps the complete manager fields, payment, audit summary and workload', () => {
  const {row,state} = sample();
  const parts = buildGroupNoticeParts(row,state);
  assert.equal(parts.length,1);
  const [part] = parts;
  for (const value of ['Клиент передан юристу · Тестовый юрист', 'Организация: ООО Альфа',
    'Объект: Название объекта', 'Москва, Тестовая, 62', 'Общепит · Получение · МСК · Приоритет: срочно',
    'Заявка #62 · Клиент #39', 'ИНН: 1234567890', 'Кадастровый номер: 77:01:1000000:123',
    'ТО: оплачено', 'Передал: Тестовый менеджер', ...row.contacts.map(c => c.tg), row.comment,
    row.contacts[1].comment, 'Отчёт аудитора · Нужны действия · Тестовый аудитор',
    'Территория: Требуется осмотр зоны', 'Оригиналы аудита: 1', 'Документы заявки: 1',
    'Дополнительные документы: 1', 'Видео осмотра приложено.', 'Архив объекта приложен.',
    'ЕГРН: входит в комплект.', 'Клиентов в работе у юриста: 2']) {
    assert.ok(part.includes(value), value);
  }
  assert.doesNotMatch(part,/protected\.example|sig=abc|key=abc/);
});

test('long multiline comments, ten contacts and emoji are kept in order across bounded messages', () => {
  const {row,state} = sample();
  row.comment = '🧩'.repeat(1700) + '\nЗавершение комментария\n' + 'Я'.repeat(560);
  row.contacts = Array.from({length:10}, (_,i) => ({
    name: 'Сотрудник ' + (i+1), comment: 'Б'.repeat(965) + '\nОкончание заметки ' + (i+1),
  }));
  const parts = buildGroupNoticeParts(row,state);
  assert.ok(parts.length > 3);
  const reassembled = parts.map((part,i) => {
    assert.ok(part.length <= 3500);
    assert.doesNotMatch(part,/[\uD800-\uDFFF]/u);
    if (i === 0) return part;
    const header = 'Клиент #39 · продолжение ' + (i+1) + '/' + parts.length + '\n\n';
    assert.ok(part.startsWith(header));
    return part.slice(header.length);
  }).join('');
  assert.ok(reassembled.includes(row.comment));
  for (const [i, contact] of row.contacts.entries()) {
    assert.ok(reassembled.includes((i+1) + '. ' + contact.name + '\n' + contact.comment));
  }
  assert.ok(reassembled.indexOf(row.contacts[9].comment) < reassembled.indexOf(row.comment));
  assert.match(reassembled,/Клиентов в работе у юриста: 2$/);
});

test('manual and older client data show an explicit payment status only when saved', () => {
  const {row,state} = sample();
  row.order_id = null;
  row.request_id = 42;
  state.body.manual_client = true;
  state.packet = {manual_materials:[{id:'synthetic'}]};
  state.egrn.result = 'skipped-manual';
  state.fields.technical_description_payment = 'unpaid';
  let [part] = buildGroupNoticeParts(row,state);
  assert.match(part,/Исходная заявка #42 · Клиент #39/);
  assert.match(part,/ТО: не оплачено/);
  assert.match(part,/Карточка и документы отправлены в личку юриста/);
  assert.match(part,/Документы клиента: 1/);
  assert.doesNotMatch(part,/ЕГРН:/);
  delete state.fields.technical_description_payment;
  [part] = buildGroupNoticeParts(row,state);
  assert.doesNotMatch(part,/ТО:|оплачено/);
});
