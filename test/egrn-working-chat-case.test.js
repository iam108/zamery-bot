'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.join(__dirname, '../src/bot/egrn.js');
const localRequire = createRequire(filename), source = fs.readFileSync(filename, 'utf8');
const counter = 'Заказано выписок: 1. Расчётно осталось: 7.';
function fixture(group) {
  const calls = { snapshots: 0, copies: [], links: [] };
  const original = { id: '11111111-2222-4333-8444-555555555555', egrn_order_id: 7, source_key: 'sha256:' + 'a'.repeat(64),
    name: 'Synthetic original.pdf', mime: 'application/pdf', bytes: 200 * 1024 * 1024, sha256: 'a'.repeat(64) };
  const sandbox = { module: { exports: {} }, Buffer, URL, AbortSignal, console,
    process: { env: { GROUP_CHAT_ID: group, EGRN_CHAT_ID: '@SyntheticEgrn' } },
    require(name) {
      if (name === '../db/pool') return { query() { assert.fail('A cached delivery must not query or modify provider orders in this fixture'); } };
      if (name === './egrn-budget') return { createEgrnBudget: () => ({
        async snapshot() { calls.snapshots++; return {}; }, describe() { return counter; },
        accept() { assert.fail('Counter display must not mutate accounting'); },
      }) };
      if (name === './egrn-telegram-delivery') return { createEgrnTelegramDelivery: () => ({
        async send(order, operation, dispatch) { return dispatch(async () => {}); },
      }) };
      if (name === './egrn-large-delivery') return { createLargeDelivery(options) {
        return localRequire(name).createLargeDelivery({ ...options,
          store: { async get(id) { assert.equal(id, original.id); return { ...original }; } },
          makeUrl: async () => 'https://synthetic.invalid/original',
        });
      } };
      return localRequire(name);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nmodule.exports.qa={isMeasurementsChat,copyNativeOriginal,largeDelivery,setTelegram(value){tgApi=value;}};', sandbox, { filename });
  const qa = sandbox.module.exports.qa;
  qa.setTelegram({
    async callApi(method, value) { assert.equal(method, 'copyMessage'); calls.copies.push(value); return { message_id: 601 }; },
    async sendMessage(chat, text) { calls.links.push({ chat, text }); return { message_id: 701 }; },
  });
  return { calls, qa, original, order: { id: 7 }, native: { key: original.source_key, chat: -100123, id: 501, name: original.name },
    link: { kind: 'link', key: original.source_key, original_id: original.id, name: original.name, mime: original.mime, bytes: original.bytes, sha256: original.sha256 } };
}

test('a free native cached copy omits accounting for the same working-chat username in any letter case', async () => {
  const h = fixture('@SyntheticMeasurements');
  for (const chat of ['@syntheticmeasurements', '@SYNTHETICMEASUREMENTS']) {
    await h.qa.copyNativeOriginal(h.native, { chat }, { budgetText: true, deliveryOrder: h.order });
    assert.doesNotMatch(h.calls.copies.at(-1).caption, /Заказано выписок|Расчётно осталось|Учёт на момент/);
  }
  assert.equal(h.calls.snapshots, 0);
  await h.qa.copyNativeOriginal(h.native, { chat: '@SyntheticEgrn' }, { budgetText: true, deliveryOrder: h.order });
  assert.match(h.calls.copies.at(-1).caption, /Заказано выписок: 1/); assert.equal(h.calls.snapshots, 1);
});

test('a cached large-link copy still omits accounting after its target normalizes the configured username to lowercase', async () => {
  const h = fixture('@SyntheticMeasurements');
  await h.qa.largeDelivery(h.order).copy(h.link, { chat: '@SyntheticMeasurements' });
  assert.equal(h.calls.links[0].chat, '@syntheticmeasurements');
  assert.doesNotMatch(h.calls.links[0].text, /Заказано выписок|Расчётно осталось|Учёт на момент/);
  assert.equal(h.calls.snapshots, 0);
  await h.qa.largeDelivery(h.order).copy(h.link, { chat: '@SyntheticEgrn' });
  assert.match(h.calls.links[1].text, /Заказано выписок: 1/); assert.equal(h.calls.snapshots, 1);
});

test('working-chat matching preserves exact numeric IDs and never conflates other chats or partial usernames', async () => {
  const numeric = fixture('-100456');
  assert.equal(numeric.qa.isMeasurementsChat(-100456), true); assert.equal(numeric.qa.isMeasurementsChat('-100456'), true);
  for (const chat of [-1004567, '-10045', 100456, '@100456', ' -100456']) assert.equal(numeric.qa.isMeasurementsChat(chat), false);
  const username = fixture('@SyntheticMeasurements');
  for (const chat of ['@syntheticmeasurements', '@SyntheticMeasurements', '@SYNTHETICMEASUREMENTS']) assert.equal(username.qa.isMeasurementsChat(chat), true);
  for (const chat of ['@syntheticmeasurements2', '@syntheticmeasurement', '@SyntheticEgrn', 'syntheticmeasurements', -100456]) assert.equal(username.qa.isMeasurementsChat(chat), false);
});
