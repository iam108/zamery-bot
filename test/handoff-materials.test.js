'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const { createHandoffMaterialsDelivery, MAX_PART_BYTES } = require('../src/web/handoff-materials');
const sha = value => createHash('sha256').update(value).digest('hex');
const targets = [{ chat: '-1001234567890', reply: 15 }, { chat: 808, reply: 25 }];
function material(name, value, role = 'document') {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { id: sha(Buffer.from(name)).slice(0, 32), name, mime: 'application/pdf', role, bytes: buffer.length, sha256: sha(buffer), buffer };
}
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function unzip(buffer) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = [];
  return new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', () => resolve(entries));
    zip.on('entry', entry => zip.openReadStream(entry, async (error, stream) => {
      if (error) { reject(error); return; }
      try { entries.push({ name: entry.fileName, crc32: entry.crc32, flags: entry.generalPurposeBitFlag, buffer: await collect(stream) }); zip.readEntry(); } catch (failure) { reject(failure); }
    }));
    zip.readEntry();
  });
}
function harness(files, options = {}) {
  const sent = [], attempts = [], loads = []; let sequence = 900;
  const deliver = createHandoffMaterialsDelivery({
    maxPartBytes: options.maximum,
    loadMaterials: async id => { loads.push(id); if (options.loadError) throw options.loadError; return files; },
    telegram: { async sendDocument(chat, file, config) {
      attempts.push({ chat, filename: file.filename }); if (options.fail) await options.fail(chat, file, config);
      const buffer = await collect(file.source), id = ++sequence;
      sent.push({ chat, filename: file.filename, config, buffer, id });
      return options.badAck ? {} : { message_id: id };
    } }
  });
  return { deliver, sent, attempts, loads };
}

test('the complete manager packet includes EGRN, UTF-8 original names and byte-identical files for both recipients', async () => {
  const files = [material('ЕГРН.pdf', '123456789', 'egrn'), material('../План помещения.pdf', 'PLAN ORIGINAL', 'plan'), material('Договор аренды.pdf', 'LEASE ORIGINAL', 'document')];
  const h = harness(files), events = [];
  const result = await h.deliver(58, targets, undefined, { onPrepared(meta) { events.push(['prepared', meta]); }, onPart(chat, index, id, meta) { events.push(['part', chat, index, id, meta]); } });
  assert.equal(result.ok, true); assert.equal(result.files, 3); assert.equal(result.parts, 1); assert.deepEqual(h.loads, [58]);
  assert.equal(h.sent.length, 2); assert.equal(result.delivered.every(target => target.complete), true);
  assert.equal(events[0][0], 'prepared'); assert.equal(events[0][1].packetHash, result.packetHash);
  for (let i = 0; i < h.sent.length; i++) {
    const sent = h.sent[i], entries = await unzip(sent.buffer);
    assert.equal(sent.config.reply_to_message_id, targets[i].reply);
    assert.equal(sent.filename, 'Заявка-58-документы.zip');
    assert.deepEqual(entries.map(entry => entry.name), ['01-ЕГРН.pdf', '02-План помещения.pdf', '03-Договор аренды.pdf']);
    assert.ok(entries.every(entry => entry.flags & 0x800));
    assert.equal(entries[0].crc32, 0xcbf43926);
    entries.forEach((entry, index) => assert.deepEqual(entry.buffer, files[index].buffer));
    assert.deepEqual(result.delivered[i].messageIds, [sent.id]);
  }
  assert.equal(events.filter(event => event[0] === 'part').length, 2); assert.deepEqual(result.warnings, []);
});

test('unchanged packets have deterministic archive bytes, names and receipt identity, including duplicate source names', async () => {
  const files = [material('План.pdf', 'FIRST'), { ...material('План.pdf', 'SECOND'), id: 'second-file' }], h = harness(files);
  const first = await h.deliver(58, [targets[0]]), second = await h.deliver('58', [targets[0]]);
  assert.equal(first.packetHash, second.packetHash); assert.deepEqual(h.sent[0].buffer, h.sent[1].buffer);
  assert.deepEqual((await unzip(h.sent[0].buffer)).map(entry => entry.name), ['01-План.pdf','02-План.pdf']);
});

test('explicit exclusions omit only matching hashes; EGRN is included by default', async () => {
  const egrn = material('ЕГРН.pdf', 'EGRN', 'egrn'), plan = material('План.pdf', 'PLAN', 'plan'), h = harness([egrn, plan]);
  const result = await h.deliver(58, [targets[0]], new Set([plan.sha256]));
  assert.equal(result.ok, true); assert.equal(result.files, 1); assert.equal(result.excluded, 1);
  const entries = await unzip(h.sent[0].buffer); assert.equal(entries.length, 1); assert.deepEqual(entries[0].buffer, egrn.buffer);
});

test('real 12 MiB originals are split before Telegram into ZIP parts no larger than the default 45 MiB limit', { timeout: 30000 }, async () => {
  const files = Array.from({ length: 4 }, (_, index) => material('Документ-' + index + '.pdf', Buffer.alloc(12 * 1024 * 1024, index + 1)));
  const h = harness(files), result = await h.deliver(58, [targets[0]]);
  assert.equal(result.ok, true); assert.equal(result.parts, 2); assert.equal(h.sent.length, 2);
  assert.ok(h.sent.every(file => file.buffer.length <= MAX_PART_BYTES));
  assert.deepEqual(h.sent.map(file => file.filename), ['Заявка-58-документы-01-из-02.zip','Заявка-58-документы-02-из-02.zip']);
});

for (const failure of ['hash', 'bytes']) test('an invalid original ' + failure + ' stops the entire packet before any Telegram request', async () => {
  const bad = material('Неисправный.pdf', 'COMPLETE');
  if (failure === 'hash') bad.sha256 = '0'.repeat(64); else bad.bytes++;
  const h = harness([material('Первый.pdf', 'OK'), bad]), result = await h.deliver(58, targets);
  assert.equal(result.ok, false); assert.equal(h.attempts.length, 0); assert.equal(result.failed[0].code, 'MATERIAL_INTEGRITY');
  assert.match(result.warnings[0], /контрольная сумма|размер/i);
});

test('a storage failure is reported without leaking the provider error or attempting a Telegram delivery', async () => {
  const h = harness([], { loadError: new Error('https://private.example?token=SECRET') }), result = await h.deliver(58, targets);
  assert.equal(result.ok, false); assert.equal(h.attempts.length, 0); assert.equal(result.failed[0].code, 'MATERIAL_LOAD_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private\.example/);
});

test('partial target delivery records each acknowledgement, finishes the other target, and retries only missing parts', async () => {
  const files = [material('Первый.pdf', 'A'.repeat(130)), material('Второй.pdf', 'B'.repeat(130))]; let failed = false;
  const h = harness(files, { maximum: 350, fail(chat, file) { if (String(chat) === String(targets[0].chat) && /02-из/.test(file.filename) && !failed) { failed = true; throw new Error('Telegram unavailable'); } } });
  const confirmed = {}, prepared = [];
  const callbacks = { onPrepared(meta) { prepared.push(meta); }, onPart(chat, part, id) { (confirmed[String(chat)] ||= [])[part] = id; } };
  const first = await h.deliver(58, targets, undefined, callbacks);
  assert.equal(first.ok, false); assert.equal(first.parts, 2); assert.equal(first.delivered[0].messageIds.length, 1); assert.equal(first.delivered[1].messageIds.length, 2);
  assert.equal(first.delivered[0].complete, false); assert.equal(first.delivered[1].complete, true);
  assert.match(first.warnings[0], /Не все документы/);
  const before = h.attempts.length;
  const retry = await h.deliver(58, targets, undefined, { ...callbacks, confirmed, packetHash: first.packetHash });
  assert.equal(retry.ok, true); assert.equal(h.attempts.length - before, 1); assert.match(h.attempts.at(-1).filename, /02-из-02/);
  assert.equal(prepared[0].packetHash, prepared[1].packetHash); assert.equal(retry.delivered.every(target => target.complete), true);
});

test('onPrepared failure publishes nothing and onPart failure stops uncheckpointed follow-on deliveries', async () => {
  const files = [material('Документ.pdf', 'ORIGINAL')], h = harness(files);
  const prepareFailed = await h.deliver(58, targets, undefined, { onPrepared() { throw new Error('database unavailable'); } });
  assert.equal(prepareFailed.ok, false); assert.equal(h.attempts.length, 0); assert.equal(prepareFailed.failed[0].code, 'MATERIAL_CHECKPOINT_FAILED');
  const failed = await h.deliver(58, targets, undefined, { onPart(chat, part, id, meta) { assert.equal(part, 0); assert.ok(id > 0); assert.match(meta.packetHash, /^[a-f\d]{64}$/); throw new Error('checkpoint unavailable'); } });
  assert.equal(failed.ok, false); assert.equal(h.sent.length, 1); assert.equal(failed.delivered[0].messageIds.length, 1); assert.equal(failed.delivered[1].messageIds.length, 0);
  assert.equal(failed.failed[0].stage, 'receipt'); assert.match(failed.warnings[0], /квитанция/);
});

test('a changed packet or malformed receipt cannot reuse confirmed original ZIP acknowledgements', async () => {
  const file = material('Документ.pdf', 'ORIGINAL'), h = harness([file]), initial = await h.deliver(58, [targets[0]]);
  const before = h.attempts.length; file.name = 'Изменено.pdf';
  const changed = await h.deliver(58, [targets[0]], undefined, { packetHash: initial.packetHash, confirmed: { [String(targets[0].chat)]: initial.delivered[0].messageIds } });
  assert.equal(changed.ok, false); assert.equal(changed.failed[0].code, 'MATERIAL_PACKET_CHANGED'); assert.equal(h.attempts.length, before);
  const broken = await h.deliver(58, targets, undefined, { confirmed: { [String(targets[1].chat)]: [0] } });
  assert.equal(broken.ok, false); assert.equal(broken.failed[0].code, 'MATERIAL_RECEIPT_INVALID'); assert.equal(h.attempts.length, before);
});

test('the approved file snapshot is delivered in its original order and late documents are not silently added', async () => {
  const first = material('Первый.pdf', 'FIRST'), second = material('Второй.pdf', 'SECOND'), late = material('Позже.pdf', 'NOT APPROVED');
  const expectedFiles = [first, second].map(({ buffer, ...meta }) => meta), h = harness([late, second, first]);
  const result = await h.deliver(58, [targets[0]], undefined, { expectedFiles });
  assert.equal(result.ok, true); assert.equal(result.files, 2); assert.equal(result.ignored, 1);
  const entries = await unzip(h.sent[0].buffer); assert.deepEqual(entries.map(entry => entry.buffer.toString()), ['FIRST','SECOND']);
});

for (const mutation of ['missing', 'metadata', 'bytes']) test('a frozen snapshot with ' + mutation + ' original is rejected before Telegram', async () => {
  const file = material('Утверждённый.pdf', 'ORIGINAL'), expectedFiles = [{ ...file }], loaded = [{ ...file }];
  if (mutation === 'missing') loaded.length = 0;
  if (mutation === 'metadata') loaded[0].role = 'archive';
  if (mutation === 'bytes') loaded[0].buffer = Buffer.from('REPLACED');
  const h = harness(loaded), result = await h.deliver(58, targets, undefined, { expectedFiles });
  assert.equal(result.ok, false); assert.equal(h.attempts.length, 0);
  assert.ok(['MATERIAL_PACKET_CHANGED','MATERIAL_INTEGRITY'].includes(result.failed[0].code));
});

test('empty approved packets require no uploads, and missing recipients cannot pretend delivery succeeded', async () => {
  const h = harness([]), empty = await h.deliver(58, targets);
  assert.equal(empty.ok, true); assert.equal(empty.files, 0); assert.equal(empty.parts, 0); assert.equal(h.attempts.length, 0);
  const noTarget = harness([material('Документ.pdf', 'ORIGINAL')]), absent = await noTarget.deliver(58, []);
  assert.equal(absent.ok, false); assert.equal(noTarget.loads.length, 0); assert.equal(absent.failed[0].code, 'MATERIAL_TARGET_MISSING');
});

test('a Telegram response without a message ID is not treated as a delivered document', async () => {
  const h = harness([material('Документ.pdf', 'ORIGINAL')], { badAck: true }), result = await h.deliver(58, [targets[0]]);
  assert.equal(result.ok, false); assert.equal(result.delivered[0].messageIds.length, 0); assert.equal(result.failed[0].code, 'MATERIAL_TELEGRAM_RECEIPT');
});

test('one Telegram message cannot confirm two different ZIP parts', async () => {
  const h = harness([material('Первый.pdf', 'A'.repeat(130)), material('Второй.pdf', 'B'.repeat(130))], { maximum: 350 });
  const result = await h.deliver(58, [targets[0]], undefined, { confirmed: { [String(targets[0].chat)]: [901,901] } });
  assert.equal(result.ok, false); assert.equal(result.failed[0].code, 'MATERIAL_RECEIPT_INVALID'); assert.equal(h.attempts.length, 0);
});

for (const errorCode of [400, 429]) test('explicit Telegram rejection ' + errorCode + ' is identified as safe for a receipt-preserving retry', async () => {
  const h = harness([material('Документ.pdf', 'ORIGINAL')], { fail() { throw Object.assign(new Error('SENSITIVE_PROVIDER_ERROR'), { response: { error_code: errorCode } }); } });
  const result = await h.deliver(58, [targets[0]]);
  assert.equal(result.ok, false); assert.equal(result.failed[0].stage, 'telegram'); assert.equal(result.failed[0].uncertain, false);
  assert.equal(JSON.stringify(result).includes('SENSITIVE_PROVIDER_ERROR'), false);
});

test('a network failure without Telegram rejection exposes only an uncertain outcome and safe warning', async () => {
  const h = harness([material('Документ.pdf', 'ORIGINAL')], { fail() { throw new Error('https://private.example?token=SECRET'); } });
  const result = await h.deliver(58, [targets[0]]);
  assert.equal(result.ok, false); assert.equal(result.failed[0].stage, 'telegram'); assert.equal(result.failed[0].uncertain, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('an upload response without a receipt is uncertain even when transport resolves successfully', async () => {
  const h = harness([material('Документ.pdf', 'ORIGINAL')], { badAck: true });
  const result = await h.deliver(58, [targets[0]]);
  assert.equal(result.failed[0].code, 'MATERIAL_TELEGRAM_RECEIPT'); assert.equal(result.failed[0].uncertain, true);
});
