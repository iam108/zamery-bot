const { test } = require('node:test');
const assert = require('node:assert/strict');
const { packetFromOrder, createPacketLoader } = require('../src/web/audit-packet');
const order = { id: 58, address: 'Москва, адрес', owner_name: 'Заказчик', object_type: 'Розничная торговля', service: 'Продление', archive_url: 'https://disk.yandex.ru/d/test', has_video: true, contacts: 'Контакт менеджера', zones_info: 'Проверить вход со двора' };

test('manager packet includes service, task, contact and original documents without auditor re-entry', () => {
  const packet = packetFromOrder(order, [{ id: 'plan', name: 'План.pdf', mime: 'application/pdf', role: 'plan', bytes: 100 }, { id: 'archive', name: 'Акт.pdf', mime: 'application/pdf', role: 'archive', bytes: 200 }]);
  assert.equal(packet.object_category, 'retail');
  assert.equal(packet.service, 'Продление');
  assert.equal(packet.zones_info, 'Проверить вход со двора');
  assert.equal(packet.video_required, true);
  assert.equal(packet.archive_download_url, '/api/audit/orders/58/materials/download-all?role=archive');
  assert.equal(packet.materials[0].url, '/api/audit/orders/58/materials/plan');
  assert.equal(packet.materials[0].buffer, undefined);
  const acquisition = packetFromOrder({ ...order, service: 'Получение' }, []);
  assert.equal(acquisition.archive_url, '');
  assert.equal(acquisition.archive_download_url, '');
});

test('frozen packet keeps exactly its original file set and rejects foreign references', async () => {
  let files = [{ id: 'original', name: 'План.pdf', role: 'plan', bytes: 100 }];
  const load = createPacketLoader({ getOrder: async () => order, getMaterials: async () => files });
  const before = await load(58, ['original']);
  files.push({ id: 'late', name: 'Новая выписка.pdf', role: 'egrn', bytes: 200 });
  const retry = await load(58, ['original']);
  assert.deepEqual(retry, before);
  await assert.rejects(load(58, ['foreign']), /не относится/);
});
