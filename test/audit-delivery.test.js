const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { splitTelegramHtml, photoCaption } = require('../src/bot/audit-delivery');

function plain(html) { return html.replace(/<[^>]+>/g, ''); }
function assertBalanced(html) {
  const stack = [];
  for (const match of html.matchAll(/<(\/?)(\w+)(?:\s[^>]*)?>/g)) {
    if (match[1]) assert.equal(stack.pop(), match[2]); else stack.push(match[2]);
  }
  assert.equal(stack.length, 0);
}

test('long HTML is split safely with balanced tags, intact entities and emoji', () => {
  const source = '<b>' + 'План &amp; границы 😀 '.repeat(800) + '</b>\n<i>Конец</i>';
  const chunks = splitTelegramHtml(source);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3500);
    assertBalanced(chunk);
    assert.equal(/&(?:a|am|amp)$/.test(chunk), false);
    assert.equal(/[\uD800-\uDBFF]$/.test(plain(chunk)), false);
  }
  assert.equal(chunks.map(plain).join(''), plain(source));
});

test('split prefers complete report lines and does not truncate long lines', () => {
  const lines = ['<b>Заголовок</b>', 'А'.repeat(2000), 'Б'.repeat(2000), 'В'.repeat(8000)];
  const chunks = splitTelegramHtml(lines.join('\n'));
  assert.equal(chunks.map(plain).join(''), plain(lines.join('\n')));
  assert.ok(chunks[0].endsWith('\n'));
  assert.ok(chunks.every(c => c.length <= 3500));
});

test('plan and map attachments have descriptive short captions', () => {
  assert.equal(photoCaption({ role: 'plan' }, 58), 'План с разметкой · отчёт по заявке #58');
  assert.equal(photoCaption({ role: 'map' }, 58), 'Карта и входы · отчёт по заявке #58');
  assert.ok(photoCaption({}, 58).length < 1024);
});

function harness(options = {}) {
  const calls = [];
  const saved = [];
  let sequence = 1;
  const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ctx = { from: { id: 10, username: 'auditor' }, telegram: {}, reply: async text => { calls.push({ method: 'reply', text }); } };
  for (const method of ['sendMessage', 'sendPhoto', 'sendMediaGroup', 'sendDocument']) {
    ctx.telegram[method] = async (...args) => {
      calls.push({ method, args });
      if (options.fail) await options.fail(method, args);
      if (method === 'sendMediaGroup') return args[1].map(() => ({ message_id: sequence++ }));
      return { message_id: sequence++ };
    };
  }
  const context = { module: { exports: {} }, Buffer, process: { env: { GROUP_CHAT_ID: 'group' } },
    console: { log() {}, error() {} }, setTimeout: () => ({ unref() {} }), require(name) {
      if (name === '../db/queries') return { getOrderById: async () => ({ telegram_msg_id: 77 }) };
      if (name === '../web/handoff') return { saveAudit: async (...args) => {
        if (options.saveFailure) await options.saveFailure();
        saved.push(args);
      } };
      if (name === './formatter') return { esc };
      if (name === './audit-delivery') return require('../src/bot/audit-delivery');
      if (name === './audit-workflow') return require('../src/bot/audit-workflow');
      if (name === 'crypto') return require('node:crypto');
      if (name === './audit-inspection') return {
        validateInspection: data => { if (options.invalid) throw new Error('Заполните услугу'); },
        buildInspectionReport: data => data.schema_version === 2
          ? { html: ['<b>Услуга:</b> Продление', 'Организации: Школа &amp; стоматология'], plain: ['Услуга: Продление', 'Организации: Школа & стоматология'] }
          : { html: [], plain: [] },
      };
      throw new Error('Unexpected require: ' + name);
    } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/bot/audit-handler.js'), 'utf8'), context);
  return { ctx, calls, saved, send: data => context.module.exports.handleAuditReport(ctx, data) };
}

function data(extra = {}) {
  return { submit_id: 'report-1', order_id: 58, object_category: 'catering', conclusion: 'Нужно ТО', bti: 'Не проверено', ...extra };
}
const photo = role => ({ data: Buffer.from('fake-image').toString('base64'), role });

test('new inspection sections are included in text and persisted structured data', async () => {
  const h = harness(); const report = data({ schema_version: 2 });
  await h.send(report);
  const body = h.calls.find(c => c.method === 'sendMessage').args[1];
  assert.match(body, /Услуга:<\/b> Продление/);
  assert.match(body, /Организации: Школа &amp; стоматология/);
  assert.doesNotMatch(body, /🚫 <b>Зоны:/);
  assert.match(body, /БТИ:<\/b> ❓ Не проверено/);
  assert.match(h.saved[0][1], /Организации: Школа & стоматология/);
  assert.equal(h.saved[0][4], report);
  const handoff = h.calls.filter(c => c.method === 'sendMessage').at(-1).args[1];
  assert.match(handoff, /проверьте замечания/);
  assert.doesNotMatch(handoff, /готова к передаче/);
});

test('one photo uses sendPhoto with a short caption, full text sent separately', async () => {
  const h = harness();
  await h.send(data({ photos: [photo('plan')], conclusion: 'А'.repeat(9000) }));
  const textCalls = h.calls.filter(c => c.method === 'sendMessage');
  assert.ok(textCalls.length >= 4);
  assert.ok(textCalls.every(c => c.args[1].length <= 3500));
  const photoCall = h.calls.find(c => c.method === 'sendPhoto');
  assert.match(photoCall.args[2].caption, /План с разметкой/);
  assert.equal(h.calls.some(c => c.method === 'sendMediaGroup'), false);
  assert.ok(h.saved[0][3].length >= 4);
});

test('album failure is an error and retry does not resend report text', async () => {
  let failed = false;
  const h = harness({ fail: async method => {
    if (method === 'sendMediaGroup' && !failed) { failed = true; throw new Error('temporary upload failure'); }
  } });
  const report = data({ photos: [photo('plan'), photo('map')] });
  await assert.rejects(h.send(report), /фотографии не доставлены/);
  assert.equal(h.saved.length, 0);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 1);
  await h.send(report);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 2); // body + handoff only
  assert.equal(h.calls.filter(c => c.method === 'sendMediaGroup').length, 2);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0][3].length, 3);
  await h.send(report);
  assert.equal(h.saved.length, 1);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 2);
});

test('database failure is reported and successful media is not repeated on retry', async () => {
  let failed = false;
  const h = harness({ saveFailure: async () => { if (!failed) { failed = true; throw new Error('database unavailable'); } } });
  const report = data({ photos: [photo('photo')] });
  await assert.rejects(h.send(report), /database unavailable/);
  await h.send(report);
  assert.equal(h.calls.filter(c => c.method === 'sendPhoto').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 2);
  assert.equal(h.saved.length, 1);
});

test('validation happens before any Telegram or database writes', async () => {
  const h = harness({ invalid: true });
  await assert.rejects(h.send(data({ schema_version: 2 })), /Заполните услугу/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.saved.length, 0);
});

test('legacy and tobacco submissions remain accepted and legacy zones remain visible', async () => {
  const h = harness();
  await h.send(data({ object_category: 'tobacco', t_address: 'Адрес', submit_id: 'tobacco' }));
  assert.match(h.calls[0].args[1], /Табак/);
  await h.send(data({ submit_id: 'legacy', zones: [{ name: 'Школа', dist: '30' }] }));
  assert.match(h.calls.find(c => c.method === 'sendMessage' && c.args[1].includes('🚫')).args[1], /Школа/);
});

test('changed payload cannot be mixed with partially delivered report', async () => {
  const h = harness({ fail: async method => { if (method === 'sendPhoto') throw new Error('failure'); } });
  await assert.rejects(h.send(data({ photos: [photo('photo')] })), /фотографии/);
  await assert.rejects(h.send(data({ photos: [photo('photo')], conclusion: 'Изменено' })), /без изменений/);
});

test('original documents are batched beyond ten and resume durable checkpoints after restart', async () => {
  let stored = {}, albums = 0;
  const files = Array.from({ length: 23 }, (_, i) => ({ name: 'file-' + i + '.pdf', mime: 'application/pdf', role: 'document', source: Buffer.from('original-' + i) }));
  const report = data({ schema_version: 3, workflow: { conclusion_status: 'insufficient' }, entrances: [], zones: [], documents: files });
  const first = harness({ fail: async method => { if (method === 'sendMediaGroup' && ++albums === 2) throw new Error('temporary failure'); } });
  first.ctx.auditDelivery = { load: async () => stored, save: async progress => { stored = JSON.parse(JSON.stringify(progress)); } };
  await assert.rejects(first.send(report), /не все оригиналы/);
  assert.equal(stored.documentIds.length, 10);
  const second = harness();
  second.ctx.auditDelivery = first.ctx.auditDelivery;
  await second.send(report);
  const resumedAlbums = second.calls.filter(c => c.method === 'sendMediaGroup');
  assert.deepEqual(resumedAlbums.map(c => c.args[1].length), [10, 3]);
  assert.ok(resumedAlbums.every(c => c.args[1].every(f => f.type === 'document')));
  assert.equal(second.calls.filter(c => c.method === 'sendMessage').length, 1); // only handoff, report text already confirmed
  assert.equal(stored.documentIds.length, 23);
  assert.equal(second.saved.length, 1);
});

test('JSONB key reordering resumes a frozen UI4 packet without resending confirmed text or originals', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite();
  try {
    let stored = {};
    const packet = require('../src/web/audit-packet').packetFromOrder({ id: 58, owner_name: 'Клиент', address: 'Москва, объект', service: 'Получение', object_type: 'Общепит алкоголь' }, [
      { id: 'one', name: 'План.pdf', mime: 'application/pdf', role: 'plan', bytes: 3, sha256: 'first' },
      { id: 'two', name: 'Выписка.pdf', mime: 'application/pdf', role: 'egrn', bytes: 3, sha256: 'second' },
    ]);
    const report = data({ schema_version: 3, ui_version: 4, workflow: { step: 2, conclusion_status: 'insufficient' }, inspection: {}, request_packet: packet, entrances: [], zones: [],
      documents: [{ id: 'photo', name: 'Вход.pdf', mime: 'application/pdf', role: 'entrance', source: Buffer.from('ORIGINAL') }] });
    const delivery = {
      load: async () => stored,
      save: async progress => { stored = (await db.query('SELECT $1::jsonb AS progress', [JSON.stringify({ ...progress, packet })])).rows[0].progress; },
    };
    const first = harness({ saveFailure: async () => { throw new Error('save unavailable after Telegram acknowledgements'); } });
    first.ctx.auditDelivery = delivery;
    await assert.rejects(first.send(report), /save unavailable/);
    assert.equal(stored.textIds.length, 1); assert.equal(stored.documentIds.length, 1);
    assert.notEqual(JSON.stringify(stored.packet), JSON.stringify(packet));
    assert.deepEqual(stored.packet, packet);
    const second = harness(); second.ctx.auditDelivery = delivery;
    const retry = { ...report, request_packet: stored.packet };
    await assert.rejects(second.send({ ...retry, request_packet: { ...stored.packet, address: 'Другой объект' } }), /без изменений/);
    await assert.rejects(second.send({ ...retry, request_packet: { ...stored.packet, materials: [...stored.packet.materials].reverse() } }), /без изменений/);
    await assert.rejects(second.send({ ...retry, documents: [{ ...report.documents[0], source: Buffer.from('CHANGED') }] }), /без изменений/);
    assert.equal(second.calls.length, 0);
    await second.send(retry);
    assert.equal(second.calls.filter(call => call.method === 'sendDocument').length, 0);
    assert.equal(second.calls.filter(call => call.method === 'sendMessage').length, 1); // only the handoff
    assert.equal(second.saved.length, 1);
  } finally { await db.close(); }
});

test('unchanged legacy checkpoint upgrades to canonical signature while changed payload stays rejected', async () => {
  const { createHash } = require('node:crypto');
  const report = data({ extra: { z: 1, a: 2 } });
  const oldSignature = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  let stored = { signature: oldSignature, textIds: [101], photoIds: [], documentIds: [], saved: false, handoffSent: false, replied: false };
  const h = harness();
  h.ctx.auditDelivery = { load: async () => stored, save: async progress => { stored = JSON.parse(JSON.stringify(progress)); } };
  await assert.rejects(h.send({ ...report, conclusion: 'Другой итог' }), /без изменений/);
  assert.equal(h.calls.length, 0);
  await h.send(report);
  assert.notEqual(stored.signature, oldSignature);
  assert.equal(h.calls.filter(call => call.method === 'sendMessage').length, 1);
  assert.equal(h.saved.length, 1);
});

test('UI5 delivers ordered inline previews while retaining every original for handoff', () => {
  const { deliveryMedia } = require('../src/bot/audit-delivery');
  const files = [
    { id: 'inside', name: 'room.jpg', role: 'interior', mime: 'image/jpeg', source: Buffer.from('ROOM') },
    { id: 'pdf', name: 'egrn.pdf', role: 'plan-source', mime: 'application/pdf', source: Buffer.from('%PDF') },
    { id: 'plan', name: 'marked.png', role: 'plan', subject_id: 'annotation', mime: 'image/png', source: Buffer.from('PLAN') },
    { id: 'map', name: 'map.png', role: 'map', subject_id: 'annotation', mime: 'image/png', source: Buffer.from('MAP') },
    { id: 'source', name: 'plan.png', role: 'plan', subject_id: 'source', mime: 'image/png', source: Buffer.from('SOURCE') },
    { id: 'heic', name: 'entrance.heic', role: 'entrance', mime: 'image/heic', source: Buffer.from('HEIC') },
  ];
  const packet = deliveryMedia({ ui_version: 5, documents: files });
  assert.deepEqual(packet.photos.map(p => p.id), ['map', 'plan', 'inside']);
  assert.equal(Buffer.from(packet.photos[0].data, 'base64').toString(), 'MAP');
  assert.equal(packet.documents, files);
  assert.equal(files[0].data, undefined);
  assert.equal(deliveryMedia({ ui_version: 4, documents: files }).photos.length, 0);
});

test('UI5 sends map/plan/entrance inline, originals separately, and does not duplicate confirmed media on retry', async () => {
  const { compactVisit } = require('./helpers/audit-v5');
  const report = compactVisit();
  report.submit_id = 'v5-inline-retry';
  report.documents = report.evidence.map(file => ({ ...file, source: Buffer.from('original-' + file.id) }));
  let failSave = true;
  const h = harness({ saveFailure: async () => { if (failSave) { failSave = false; throw new Error('save retry'); } } });
  await assert.rejects(h.send(report), /save retry/);
  const albums = h.calls.filter(call => call.method === 'sendMediaGroup');
  assert.equal(albums.length, 2);
  assert.deepEqual(Array.from(albums[0].args[1], item => item.type), ['photo', 'photo', 'photo']);
  assert.match(albums[0].args[1][0].caption, /Карта/);
  assert.match(albums[0].args[1][1].caption, /План/);
  assert.ok(albums[1].args[1].every(item => item.type === 'document'));
  assert.equal(albums[1].args[1].length, report.documents.length);
  await h.send(report);
  assert.equal(h.calls.filter(call => call.method === 'sendMediaGroup').length, 2);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0][4].documents[0].source, report.documents[0].source);
});
