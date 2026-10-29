const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAuditSubmitter } = require('../src/web/audit-submit');
const { hydrateDraftReport } = require('../src/bot/audit-workflow');

function harness(changes = {}) {
  const id = randomUUID(), fileId = randomUUID();
  const state = { frozen: false, submitted: false, delivery: {}, releases: 0, marks: 0, locked: false };
  const snapshot = {
    id, revision: 4, order_id: 58,
    data: { object_category: 'catering', conclusion: 'Необходимо уточнить окружение',
      inspection: { org: 'Тестовый объект', address: 'Тестовый адрес', service: 'Получение' },
      workflow: { step: 7, conclusion_status: 'insufficient' }, entrances: [], zones: [], ...changes },
    evidence: [{ id: fileId, name: 'оригинал.pdf', mime: 'application/pdf', role: 'plan-source', subject_id: 'plan', buffer: Buffer.from('ORIGINAL_PDF_BYTES') }],
  };
  const denied = (status, code) => Object.assign(new Error(code), { status, code });
  const authorize = (owner, requestedId, revision) => {
    if (owner !== 108 || requestedId !== id) throw denied(404, 'NOT_FOUND');
    if (revision != null && revision !== 4) throw denied(409, 'REVISION_CONFLICT');
  };
  const drafts = {
    async withDraftDeliveryLock(owner, requestedId, run) {
      authorize(owner, requestedId);
      if (state.locked) throw denied(409, 'DELIVERY_BUSY');
      state.locked = true;
      try { return await run(); } finally { state.locked = false; }
    },
    async loadDraftForSubmit(owner, requestedId, revision) {
      authorize(owner, requestedId, revision);
      if (!state.submitted) state.frozen = true;
      return { ...snapshot, submitted_at: state.submitted ? '2026-10-29T12:00:00Z' : null };
    },
    async releaseDraftSubmission() { state.releases++; if (!Object.keys(state.delivery).length) state.frozen = false; },
    async markDraftSubmitted() { state.submitted = true; state.frozen = false; state.marks++; },
    async loadDraftDelivery() { return JSON.parse(JSON.stringify(state.delivery)); },
    async saveDraftDelivery(owner, requestedId, revision, progress) { authorize(owner, requestedId, revision); state.delivery = JSON.parse(JSON.stringify(progress)); },
  };
  return { id, snapshot, state, drafts, context: { from: { id: 108, first_name: 'Аудитор' }, reply: async () => {} } };
}

test('draft hydration separates originals from report metadata without changing saved answers', () => {
  const h = harness();
  const data = hydrateDraftReport(h.snapshot);
  assert.equal(data.documents[0].source.toString(), 'ORIGINAL_PDF_BYTES');
  assert.equal(data.evidence[0].buffer, undefined);
  assert.equal(data.evidence[0].data, undefined);
  assert.equal(JSON.stringify(data.evidence).includes('ORIGINAL_PDF_BYTES'), false);
  assert.equal(h.snapshot.data.inspection.alcohol_present, undefined);
  assert.equal(data.inspection.alcohol_present, 'Не проверено');
});

test('validation failure releases the draft before any delivery starts', async () => {
  const h = harness({ conclusion: '' });
  let deliveries = 0;
  const submit = createAuditSubmitter(h.drafts, async () => { deliveries++; });
  await assert.rejects(submit(108, h.id, 4, h.context), /итог аудитора/);
  assert.equal(deliveries, 0);
  assert.equal(h.state.releases, 1);
  assert.equal(h.state.frozen, false);
  assert.equal(h.state.locked, false);
});

test('successful submission closes once and repeated request returns without redelivery', async () => {
  const h = harness();
  let deliveries = 0;
  const submit = createAuditSubmitter(h.drafts, async (ctx, data) => {
    deliveries++;
    assert.equal(data.submit_id, 'draft:' + h.id + ':4');
    assert.equal(data.documents[0].source.toString(), 'ORIGINAL_PDF_BYTES');
    await ctx.auditDelivery.save({ textIds: [101], documentIds: [102], saved: true });
  });
  assert.equal((await submit(108, h.id, 4, h.context)).ok, true);
  assert.equal((await submit(108, h.id, 4, h.context)).already_submitted, true);
  assert.equal(deliveries, 1);
  assert.equal(h.state.marks, 1);
  assert.equal(h.state.locked, false);
});

test('Telegram acknowledgement followed by checkpoint failure keeps the exact revision frozen', async () => {
  const h = harness();
  h.drafts.saveDraftDelivery = async () => { throw new Error('checkpoint unavailable'); };
  let acknowledged = 0;
  const submit = createAuditSubmitter(h.drafts, async ctx => {
    acknowledged++;
    await ctx.auditDelivery.save({ textIds: [101] });
  });
  await assert.rejects(submit(108, h.id, 4, h.context), /checkpoint unavailable/);
  assert.equal(acknowledged, 1);
  assert.deepEqual(h.state.delivery, {});
  assert.equal(h.state.frozen, true);
  assert.equal(h.state.releases, 0);
  assert.equal(h.state.submitted, false);
  assert.equal(h.state.locked, false);
});

test('a later submitter resumes durable delivery with the unchanged original snapshot', async () => {
  const h = harness();
  const first = createAuditSubmitter(h.drafts, async ctx => {
    await ctx.auditDelivery.save({ textIds: [101], documentIds: [102] });
    throw new Error('later packet failed');
  });
  await assert.rejects(first(108, h.id, 4, h.context), /later packet failed/);
  assert.equal(h.state.frozen, true);
  const afterRestart = createAuditSubmitter(h.drafts, async (ctx, data) => {
    assert.deepEqual(await ctx.auditDelivery.load(), { textIds: [101], documentIds: [102] });
    assert.equal(data.documents[0].source.toString(), 'ORIGINAL_PDF_BYTES');
    await ctx.auditDelivery.save({ textIds: [101], documentIds: [102, 103], saved: true });
  });
  await afterRestart(108, h.id, 4, h.context);
  assert.equal(h.state.submitted, true);
  assert.deepEqual(h.state.delivery.documentIds, [102, 103]);
});

test('one delivery lock excludes a concurrent sender while tenant and revision checks fail before delivery', async () => {
  const h = harness();
  let proceed, started;
  const active = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  let deliveries = 0;
  const submit = createAuditSubmitter(h.drafts, async () => { deliveries++; started(); await gate; });
  await assert.rejects(submit(109, h.id, 4, h.context), e => e.status === 404);
  await assert.rejects(submit(108, h.id, 3, h.context), e => e.status === 409);
  const first = submit(108, h.id, 4, h.context);
  await active;
  await assert.rejects(submit(108, h.id, 4, h.context), e => e.status === 409 && e.code === 'DELIVERY_BUSY');
  proceed();
  await first;
  assert.equal(deliveries, 1);
  assert.equal(h.state.locked, false);
});

test('simple form uses the manager packet and freezes it across a delivery retry', async () => {
  const fileId = randomUUID();
  const h = harness({ ui_version: 4, workflow: { step: 2, conclusion_status: 'insufficient' },
    request_packet: { org: 'Подменённый клиент', address: 'Подменённый адрес', service: 'Продление', materials: [{ id: fileId }] } });
  let loads = 0;
  const packet = { org: 'Клиент менеджера', address: 'Москва, адрес из заявки', service: 'Продление',
    materials: [{ id: fileId, role: 'archive', name: 'Акт.pdf' }] };
  const loadPacket = async (orderId, ids) => {
    loads++;
    assert.equal(orderId, 58);
    assert.deepEqual(ids, [fileId]);
    return packet;
  };
  const first = createAuditSubmitter(h.drafts, async (ctx, data) => {
    assert.equal(data.inspection.org, packet.org);
    assert.equal(data.inspection.address, packet.address);
    assert.equal(data.inspection.region, 'МСК');
    await ctx.auditDelivery.save({ textIds: [101] });
    throw new Error('later packet failed');
  }, { loadPacket });
  await assert.rejects(first(108, h.id, 4, h.context), /later packet failed/);
  assert.equal(h.state.delivery.packet.org, packet.org);
  const retry = createAuditSubmitter(h.drafts, async (ctx, data) => {
    assert.equal(data.inspection.org, packet.org);
    assert.deepEqual((await ctx.auditDelivery.load()).textIds, [101]);
  }, { loadPacket: async () => { throw new Error('Must reuse frozen manager packet'); } });
  await retry(108, h.id, 4, h.context);
  assert.equal(loads, 1);
  assert.equal(h.state.submitted, true);
});

test('manager service changes require refresh before any report delivery', async () => {
  const h = harness({ ui_version: 4, workflow: { step: 2, conclusion_status: 'insufficient' },
    request_packet: { org: 'Клиент', address: 'Москва', service: 'Получение', materials: [] } });
  let sent = false;
  const submit = createAuditSubmitter(h.drafts, async () => { sent = true; }, {
    loadPacket: async () => ({ org: 'Клиент', address: 'Москва', service: 'Продление', materials: [] }),
  });
  await assert.rejects(submit(108, h.id, 4, h.context), error => error.status === 409);
  assert.equal(sent, false);
  assert.equal(h.state.frozen, false);
});
