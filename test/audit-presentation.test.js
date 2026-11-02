'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');
const zlib = require('node:zlib');
const yauzl = require('yauzl');
const { compactVisit } = require('./helpers/audit-v5');
const { normalizeWorkflow } = require('../src/bot/audit-workflow');
const ROOT = path.join(__dirname, '../src/bot');
const GROUP = '-1001234567890';
const clone = value => JSON.parse(JSON.stringify(value));

// Complete, differently coloured PNG originals make accidental preview
// duplication visible without embedding any client documents in the tests.
function png(value) {
  function chunk(type, body) {
    const bytes = Buffer.concat([Buffer.from(type), body]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const out = Buffer.alloc(body.length + 12); out.writeUInt32BE(body.length); bytes.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  }
  const size = Buffer.alloc(13); size.writeUInt32BE(2); size.writeUInt32BE(2, 4); size[8] = 8; size[9] = 2;
  const scan = Buffer.from([0,value,0,0,value,0,0,0,value,0,0,value,0,0]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', size), chunk('IDAT', zlib.deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
function report() {
  const data = compactVisit(); data.submit_id = 'presentation:' + randomUUID(); data.draft_id = randomUUID();
  data.conclusion = 'Объект осмотрен. Все материалы приложены.';
  data.workflow.video_url = 'https://disk.yandex.ru/d/audit-video'; data.inspection.video_status = 'Сделано';
  data.evidence.push({ id: randomUUID(), name: 'Внутри.png', mime: 'image/png', role: 'interior', subject_id: 'hall' });
  data.documents = data.evidence.map((item, i) => ({ ...item, source: item.mime === 'application/pdf' ? Buffer.from('%PDF-1.7\nORIGINAL PLAN\n%%EOF') : png(40 + i * 20) }));
  data.photos = []; return data;
}
function signature(input) {
  const data = normalizeWorkflow(input), digest = { ...data, documents: data.documents.map(({ source, data: binary, ...meta }) => ({ ...meta, contentHash: createHash('sha256').update(source || Buffer.from(binary, 'base64')).digest('hex') })) };
  return createHash('sha256').update(JSON.stringify(digest, (key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)).digest('hex');
}
async function bytes(source) {
  if (Buffer.isBuffer(source)) return Buffer.from(source);
  const parts = []; for await (const part of source) parts.push(Buffer.from(part)); return Buffer.concat(parts);
}
async function unzip(buffer) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const files = [];
  return new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', () => resolve(files));
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      zip.openReadStream(entry, async (error, stream) => {
        if (error) { reject(error); return; }
        try { files.push({ name: entry.fileName, data: await bytes(stream) }); zip.readEntry(); } catch (failure) { reject(failure); }
      });
    });
    zip.readEntry();
  });
}
function harness(options = {}) {
  const events = [], delivered = [], saves = options.saves || [], holder = options.holder || { value: {} };
  let sequence = options.sequence || 1000;
  const ctx = { from: { id: 90001, username: 'qa_auditor' }, telegram: {},
    auditDelivery: {
      load: async () => clone(holder.value),
      save: async value => { if (options.checkpointFailure) await options.checkpointFailure(value); holder.value = clone(value); events.push({ method: 'checkpoint', value: clone(value) }); }
    },
    reply: async text => { if (options.fail) await options.fail('reply', [text]); events.push({ method: 'reply', args: [text] }); }
  };
  for (const method of ['sendMessage', 'sendPhoto', 'sendMediaGroup', 'sendDocument', 'editMessageReplyMarkup']) {
    ctx.telegram[method] = async (...args) => {
      events.push({ method, args }); if (options.fail) await options.fail(method, args);
      if (method === 'editMessageReplyMarkup') return true;
      const count = method === 'sendMediaGroup' ? args[1].length : 1, result = [];
      for (let i = 0; i < count; i++) {
        const payload = method === 'sendMediaGroup' ? args[1][i] : args[1];
        const kind = method === 'sendMediaGroup' ? payload.type : method === 'sendMessage' ? 'text' : method === 'sendPhoto' ? 'photo' : 'document';
        const file = method === 'sendMediaGroup' ? payload.media : payload;
        const item = { message_id: sequence++, kind, payload, buffer: kind === 'text' ? null : await bytes(file.source), filename: file?.filename };
        if (kind === 'document') item.document = { file_id: 'telegram-original-' + item.message_id, file_size: item.buffer.length };
        delivered.push(item); result.push(item);
      }
      return method === 'sendMediaGroup' ? result : result[0];
    };
  }
  const context = { module: { exports: {} }, Buffer, URL, process: { env: { GROUP_CHAT_ID: options.group || GROUP, WEBAPP_URL: 'https://audit.example' } },
    console: { log() {}, error() {} }, setTimeout: () => ({ unref() {} }), require(name) {
      if (name === '../db/queries') return { getOrderById: async () => ({ telegram_msg_id: 77 }) };
      if (name === '../web/handoff') return { saveAudit: async (...args) => { if (options.saveFailure) await options.saveFailure(); saves.push(args); events.push({ method: 'saveAudit', args }); } };
      if (name.startsWith('./')) return require(path.join(ROOT, name));
      if (name === 'crypto' || name === 'node:crypto') return require('node:crypto');
      throw new Error('Unexpected handler dependency: ' + name);
    } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(ROOT, 'audit-handler.js'), 'utf8'), context);
  return { events, delivered, saves, holder, ctx, send: data => context.module.exports.handleAuditReport(ctx, data) };
}
function keyboard(h) { return h.events.filter(e => e.method === 'editMessageReplyMarkup').at(-1)?.args[3]?.inline_keyboard.flat() || []; }
function onceFailure(target, detail = 'temporary ' + target + ' failure') { let hit = false; return async method => { if (method === target && !hit) { hit = true; throw new Error(detail); } }; }

test('new UI5 delivery is summary, one photo album and original ZIP, with all actions on the summary', async () => {
  const data = report(), h = harness(); await h.send(data);
  assert.equal(h.events[0].method, 'checkpoint'); assert.equal(h.events[0].value.deliveryVersion, 2);
  assert.equal(h.delivered[0].kind, 'text'); assert.match(h.delivered[0].payload, /отчёт|осмотр/i);
  assert.equal(h.delivered.filter(m => m.kind === 'text').length, 1, 'No separate report-added/handoff message');
  assert.deepEqual(h.delivered.map(m => m.kind), ['text', 'photo', 'photo', 'photo', 'photo', 'document']);
  const group = h.events.find(e => e.method === 'sendMediaGroup'); assert.ok(group.args[1].every(m => m.type === 'photo'));
  const zip = h.delivered.find(m => m.kind === 'document'); assert.match(zip.filename, /\.zip$/i);
  assert.equal(h.events.filter(e => e.method === 'sendDocument').length, 1, 'Originals are not repeated individually after previews');
  const entries = await unzip(zip.buffer);
  for (const file of data.documents) assert.equal(entries.filter(e => e.data.equals(file.source)).length, 1, file.name + ' is preserved exactly once in ZIP');
  const keys = keyboard(h), edit = h.events.find(e => e.method === 'editMessageReplyMarkup');
  assert.equal(edit.args[0], GROUP); assert.equal(edit.args[1], h.delivered[0].message_id);
  assert.ok(h.events.findIndex(e => e.method === 'saveAudit') < h.events.findIndex(e => e.method === 'editMessageReplyMarkup'));
  assert.ok(keys.some(b => b.url === data.workflow.video_url));
  assert.ok(keys.some(b => b.url === 'https://t.me/c/1234567890/' + zip.message_id));
  assert.ok(keys.some(b => b.callback_data === 'handoff:58'));
  assert.equal(h.holder.value.handoffSent, true); assert.equal(h.holder.value.deliveryVersion, 2);
  assert.deepEqual(Array.from(h.saves[0][3]), h.delivered.map(m => m.message_id), 'Every ZIP and preview ID remains available to lawyer handoff');
});

test('empty optional video and basic group do not produce broken action URLs', async () => {
  const data = report(); data.workflow.video_url = ''; delete data.video_url;
  const h = harness({ group: '-12345' }); await h.send(data);
  const keys = keyboard(h);
  assert.equal(keys.some(b => b.url), false, 'A basic group has no private-supergroup message link; ZIP remains a message');
  assert.ok(keys.some(b => b.callback_data === 'handoff:58'));
  assert.equal(h.delivered.filter(m => m.kind === 'document').length, 1);
});

for (const method of ['sendMessage', 'sendMediaGroup', 'sendDocument', 'editMessageReplyMarkup']) {
  test(method + ' failure resumes after restart without repeating confirmed summary, photos or ZIP', async () => {
    const data = report(), holder = { value: {} }, saves = [];
    const first = harness({ holder, saves, fail: onceFailure(method) });
    await assert.rejects(first.send(data));
    const confirmed = first.delivered.slice(), ids = confirmed.map(m => m.message_id);
    const second = harness({ holder, saves, sequence: 2000 }); await second.send(data);
    const all = confirmed.concat(second.delivered);
    assert.equal(all.filter(m => m.kind === 'text').length, 1);
    assert.equal(all.filter(m => m.kind === 'photo').length, 4);
    assert.equal(all.filter(m => m.kind === 'document').length, 1);
    assert.equal(saves.length, 1);
    assert.ok(ids.every(id => saves[0][3].includes(id)));
    assert.equal(holder.value.handoffSent, true); assert.equal(holder.value.replied, true);
    if (method === 'editMessageReplyMarkup') assert.equal(second.delivered.length, 0, 'Retry only installs the keyboard on the saved summary');
  });
}

test('initial version checkpoint failure cannot publish any Telegram message', async () => {
  let fail = true;
  const data = report(), h = harness({ checkpointFailure: async () => { if (fail) { fail = false; throw new Error('checkpoint unavailable'); } } });
  await assert.rejects(h.send(data), /checkpoint unavailable/);
  assert.equal(h.events.some(e => e.method.startsWith('send')), false);
  await h.send(data);
  assert.equal(h.events[0].method, 'checkpoint'); assert.equal(h.events[0].value.deliveryVersion, 2);
  assert.equal(h.delivered.filter(m => m.kind === 'text').length, 1);
});

test('database save failure retains acknowledged media and installs actions only after the record is saved', async () => {
  let failed = false;
  const holder = { value: {} }, saves = [], data = report();
  const first = harness({ holder, saves, saveFailure: async () => { if (!failed) { failed = true; throw new Error('save unavailable'); } } });
  await assert.rejects(first.send(data), /save unavailable/);
  assert.equal(first.events.some(e => e.method === 'editMessageReplyMarkup'), false);
  const second = harness({ holder, saves }); await second.send(data);
  assert.equal(second.delivered.length, 0); assert.equal(saves.length, 1);
  assert.equal(holder.value.saved, true); assert.equal(holder.value.handoffSent, true);
});

test('Telegram message-is-not-modified during summary keyboard retry counts as success', async () => {
  const h = harness({ fail: async method => { if (method === 'editMessageReplyMarkup') throw Object.assign(new Error('Bad Request: message is not modified'), { response: { error_code: 400, description: 'Bad Request: message is not modified' } }); } });
  await h.send(report());
  assert.equal(h.holder.value.handoffSent, true); assert.equal(h.holder.value.replied, true);
});

test('other Telegram edit failures remain errors and preserve the completed report for retry', async () => {
  const h = harness({ fail: async method => { if (method === 'editMessageReplyMarkup') throw Object.assign(new Error('message cannot be edited'), { response: { error_code: 400, description: 'message cannot be edited' } }); } });
  await assert.rejects(h.send(report()));
  assert.equal(h.holder.value.saved, true); assert.equal(h.holder.value.handoffSent, false);
  assert.equal(h.saves.length, 1);
});

test('changed report bytes cannot be substituted after a confirmed compact delivery checkpoint', async () => {
  const data = report(), h = harness({ fail: onceFailure('sendDocument') });
  await assert.rejects(h.send(data));
  const before = h.events.length;
  await assert.rejects(h.send({ ...data, documents: [{ ...data.documents[0], source: Buffer.from('changed-original') }, ...data.documents.slice(1)] }), /без изменений/);
  assert.equal(h.events.length, before);
});

test('a versionless UI5 checkpoint continues old media order and old handoff rather than switching to ZIP', async () => {
  const data = report(), holder = { value: { signature: signature(data), textIds: [501], photoIds: [502,503,504,505], documentIds: [], saved: false, handoffSent: false, replied: false } };
  const h = harness({ holder }); await h.send(data);
  assert.equal(h.delivered.filter(m => m.kind === 'photo').length, 0, 'Legacy preview receipts are retained');
  const originals = h.delivered.filter(m => m.kind === 'document'); assert.equal(originals.length, data.documents.length);
  assert.ok(originals.every(m => !/\.zip$/i.test(m.filename || '')));
  assert.equal(h.events.some(e => e.method === 'editMessageReplyMarkup'), false);
  assert.equal(h.delivered.filter(m => m.kind === 'text').length, 1, 'Only the old separate handoff message is still due');
  assert.match(h.delivered.find(m => m.kind === 'text').payload, /добавлен|передач/);
  assert.notEqual(holder.value.deliveryVersion, 2);
  assert.ok([501,502,503,504,505].every(id => h.saves[0][3].includes(id)));
});

test('even a versionless signed checkpoint without receipts resumes the original delivery format', async () => {
  const data = report(), holder = { value: { signature: signature(data), textIds: [], photoIds: [], documentIds: [], saved: false, handoffSent: false, replied: false } };
  const h = harness({ holder }); await h.send(data);
  assert.equal(h.delivered.filter(m => m.kind === 'document').length, data.documents.length);
  assert.ok(h.delivered.filter(m => m.kind === 'document').every(m => !/\.zip$/i.test(m.filename || '')));
  assert.equal(h.events.some(e => e.method === 'editMessageReplyMarkup'), false);
  assert.notEqual(holder.value.deliveryVersion, 2);
});
