'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');

// Exercise the public HTTP entry point, real draft transactions and actual
// delivery handler. The shared fixture replaces only DB/Telegram/object storage.
const pg = { skip: !process.env.PGLITE_TEST_MODULE, concurrency: false };
let service, nextOrder = 80;
before(async () => {
  if (pg.skip) return;
  service = await require('./e2e/helpers').createService({ master: true });
});
after(async () => { await service?.close(); });

const physical = events => events.filter(event => ['sendMessage', 'sendMediaGroup', 'sendPhoto', 'sendDocument'].includes(event.method));
const approval = value => service.pool.query('UPDATE staff SET approved=$1 WHERE tg_id=1001', [value]);
async function post(path, body) {
  const auth = new URLSearchParams(service.keyQuery(1001));
  const response = await fetch(service.origin + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Tg-U': auth.get('u'), 'X-Tg-K': auth.get('k'),
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function createDraft() {
  const order = nextOrder++;
  await service.pool.query(`INSERT INTO orders(id,address,owner_name,object_type,object_name,status,submitted_by,submitted_name,telegram_msg_id,service)
    VALUES($1,'Москва, Синтетическая улица','Synthetic client','Другое','Synthetic object','in_progress',2001,'Synthetic manager',$1::int::bigint,'')`, [order]);
  const packet = await require('../src/web/audit-packet').loadAuditPacket(order);
  const data = { schema_version: 3, ui_version: 5, object_category: 'other', order_id: order, request_packet: packet,
    inspection: { org: packet.org, address: packet.address, service: '', visit_date: '2026-11-07' }, workflow: { step: 2, video_url: '' },
    building_type: 'Не проверено', boundaries: 'Под вопросом', bti: 'Не проверено', to: 'Не обязательно',
    conclusion: 'Synthetic recorded facts remain unchanged during delivery recovery.', entrances: [], zones: [],
    plan: { evidence_id: '', page: 1, annotations: [] }, map: { evidence_id: '', page: 1, annotations: [] }, additional_plans: [], evidence: [] };
  const result = await post('/api/audit/drafts', { order_id: order, data });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { ...result.body.draft, order };
}
const submit = draft => post('/api/audit', { draft_id: draft.id, revision: draft.revision });
const row = async draft => (await service.pool.query('SELECT * FROM audit_drafts WHERE id=$1', [draft.id])).rows[0];
const telegram = () => require('../src/bot/instance').telegram;
function forbidden(result) {
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.code, 'AUDIT_FORBIDDEN');
  assert.equal(result.body.delivery_unknown, undefined);
}
async function completedOnce(draft, start) {
  const result = await submit(draft);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  const sends = physical(service.messages.slice(start));
  assert.equal(sends.filter(event => event.method === 'sendMessage').length, 1);
  const documents = sends.filter(event => event.method === 'sendDocument');
  assert.equal(documents.length, 1);
  assert.equal(documents[0].item.filename, 'Отчёт-' + draft.order + '-полный.txt');
  assert.match(documents[0].item.bytes.toString('utf8'), /Synthetic recorded facts remain unchanged/);
  assert.equal((await submit(draft)).body.already_submitted, true);
  assert.equal(physical(service.messages.slice(start)).length, 2);
  assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audits WHERE order_id=$1', [draft.order])).rows[0].n, 1);
  assert.equal(service.egrnRequests.length, 0);
}

test('all approved staff roles retain audit submission access after a role change during intent checkpointing', pg, async () => {
  const drafts = require('../src/web/audit-drafts'), original = drafts.saveDraftDelivery;
  const draft = await createDraft(), start = service.messages.length;
  let changed = false;
  try {
    drafts.saveDraftDelivery = async (...args) => {
      const result = await original(...args);
      if (!changed && args[3]?.inflight) {
        changed = true; await service.pool.query("UPDATE staff SET role='lawyer' WHERE tg_id=1001");
      }
      return result;
    };
    await completedOnce(draft, start);
    assert.equal(changed, true);
    assert.ok((await row(draft)).submitted_at);
  } finally {
    drafts.saveDraftDelivery = original;
    await service.pool.query("UPDATE staff SET role='auditor',approved=true WHERE tg_id=1001");
  }
});

test('the public submit route never moves a frozen partial report to a changed working chat and completed replay stays immutable', pg, async()=>{
  const draft=await createDraft(),start=service.messages.length,tg=telegram(),sendDocument=tg.sendDocument,group=process.env.GROUP_CHAT_ID;
  try{
    tg.sendDocument=async()=>{throw{response:{error_code:400,description:'Synthetic known refusal before original'}};};
    assert.equal((await submit(draft)).status,400);
    const before=await row(draft);assert.equal(before.delivery.destination,group);assert.equal(before.delivery.textIds.length,1);assert.equal(before.delivery.documentIds.length,0);
    tg.sendDocument=sendDocument;process.env.GROUP_CHAT_ID='-1009876543210';
    const changed=await submit(draft);assert.equal(changed.status,409);assert.match(changed.body.error,/Рабочий чат.*изменён/);
    assert.deepEqual((await row(draft)).delivery,before.delivery);assert.equal(physical(service.messages.slice(start)).length,1);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audits WHERE order_id=$1',[draft.order])).rows[0].n,0);
    process.env.GROUP_CHAT_ID=group;await completedOnce(draft,start);
    process.env.GROUP_CHAT_ID='-1009876543210';const replay=await submit(draft);assert.equal(replay.status,200);assert.equal(replay.body.already_submitted,true);assert.equal(physical(service.messages.slice(start)).length,2);
  }finally{tg.sendDocument=sendDocument;process.env.GROUP_CHAT_ID=group;}
});

test('a 429 retry rechecks current approval before the next physical request and clears a definitely unsent fresh intent', pg, async () => {
  const tg = telegram(), original = tg.sendMessage, nativeTimeout = global.setTimeout;
  const draft = await createDraft(), start = service.messages.length;
  let attempts = 0, waits = 0;
  try {
    global.setTimeout = (fn, milliseconds, ...args) => {
      if (milliseconds === 2000) { waits++; return nativeTimeout(fn, 0, ...args); }
      return nativeTimeout(fn, milliseconds, ...args);
    };
    tg.sendMessage = async (...args) => {
      attempts++;
      if (attempts === 1) {
        await approval(false);
        throw Object.assign(new Error('synthetic known rate limit'), { response: { error_code: 429, parameters: { retry_after: 1 } } });
      }
      return original(...args);
    };
    forbidden(await submit(draft));
    assert.equal(waits, 1); assert.equal(attempts, 1);
    assert.equal(physical(service.messages.slice(start)).length, 0);
    const blocked = await row(draft);
    assert.deepEqual(blocked.delivery, {}); assert.equal(blocked.submitting_revision, null); assert.equal(blocked.submitted_at, null);
    tg.sendMessage = original; global.setTimeout = nativeTimeout; await approval(true);
    await completedOnce(draft, start);
  } finally { tg.sendMessage = original; global.setTimeout = nativeTimeout; await approval(true); }
});

test('a known Telegram refusal after revocation remains definitely unsent and resumes without an unknown receipt', pg, async () => {
  const tg = telegram(), original = tg.sendMessage;
  const draft = await createDraft(), start = service.messages.length;
  try {
    tg.sendMessage = async () => {
      await approval(false);
      throw Object.assign(new Error('synthetic known refusal'), { response: { error_code: 400, description: 'Bad Request: synthetic refusal' } });
    };
    const result = await submit(draft);
    assert.equal(result.status, 400); assert.notEqual(result.body.code, 'AUDIT_DELIVERY_UNKNOWN');
    assert.equal(result.body.delivery_unknown, undefined);
    const blocked = await row(draft);
    assert.equal(blocked.delivery.inflight, undefined); assert.equal(blocked.delivery.textIds.length, 0);
    assert.equal(blocked.submitted_at, null); assert.equal(blocked.submitting_revision, draft.revision);
    assert.equal(physical(service.messages.slice(start)).length, 0);
    tg.sendMessage = original; await approval(true); await completedOnce(draft, start);
  } finally { tg.sendMessage = original; await approval(true); }
});

for (const failure of ['network', 'server']) {
  test('an accepted summary with a lost ' + failure + ' acknowledgement stays unknown despite revocation and ordinary replay', pg, async () => {
    const tg = telegram(), original = tg.sendMessage;
    const draft = await createDraft(), start = service.messages.length;
    let attempts = 0;
    try {
      tg.sendMessage = async (...args) => {
        attempts++; await original(...args); await approval(false);
        throw Object.assign(new Error('synthetic lost acknowledgement'), failure === 'server'
          ? { response: { error_code: 502, parameters: { retry_after: 1 } } } : { code: 'ECONNRESET' });
      };
      const result = await submit(draft);
      assert.equal(result.status, 409); assert.equal(result.body.code, 'AUDIT_DELIVERY_UNKNOWN');
      const blocked = await row(draft), cursor = blocked.delivery.inflight.id;
      assert.equal(result.body.delivery_unknown.cursor, cursor);
      assert.equal(blocked.delivery.textIds.length, 0); assert.equal(blocked.submitting_revision, draft.revision);
      assert.equal(physical(service.messages.slice(start)).length, 1); assert.equal(attempts, 1);
      tg.sendMessage = original; await approval(true);
      const replay = await submit(draft);
      assert.equal(replay.body.code, 'AUDIT_DELIVERY_UNKNOWN'); assert.equal(replay.body.delivery_unknown.cursor, cursor);
      assert.equal(physical(service.messages.slice(start)).length, 1);
      assert.equal((await row(draft)).delivery.inflight.id, cursor);
      assert.equal(service.egrnRequests.length, 0);
    } finally { tg.sendMessage = original; await approval(true); }
  });
}

test('an accepted full TXT receipt survives revocation and restored submit completes without repeating either original', pg, async () => {
  const tg = telegram(), original = tg.sendDocument;
  const draft = await createDraft(), start = service.messages.length;
  try {
    tg.sendDocument = async (...args) => { const result = await original(...args); await approval(false); return result; };
    forbidden(await submit(draft));
    const blocked = await row(draft);
    assert.equal(blocked.delivery.textIds.length, 1); assert.equal(blocked.delivery.documentIds.length, 1);
    assert.equal(blocked.delivery.inflight, undefined); assert.equal(blocked.submitted_at, null);
    assert.equal(blocked.submitting_revision, draft.revision); assert.equal(physical(service.messages.slice(start)).length, 2);
    tg.sendDocument = original; await approval(true); await completedOnce(draft, start);
  } finally { tg.sendDocument = original; await approval(true); }
});

test('revocation during the accepted summary keyboard update preserves its outcome but blocks the order-card update', pg, async () => {
  const tg = telegram(), original = tg.editMessageReplyMarkup;
  const draft = await createDraft(), start = service.messages.length;
  let revoked = false;
  try {
    tg.editMessageReplyMarkup = async (...args) => {
      const result = await original(...args);
      if (!revoked) { revoked = true; await approval(false); }
      return result;
    };
    forbidden(await submit(draft));
    const blocked = await row(draft), edits = service.messages.slice(start).filter(event => event.method === 'editMessageReplyMarkup');
    assert.equal(revoked, true); assert.equal(edits.length, 1);
    assert.equal(blocked.delivery.handoffSent, true); assert.equal(blocked.delivery.orderCardLinked, false);
    assert.equal(blocked.delivery.textIds.length, 1); assert.equal(blocked.delivery.documentIds.length, 1);
    assert.equal(blocked.submitted_at, null);
    tg.editMessageReplyMarkup = original; await approval(true); await completedOnce(draft, start);
    assert.equal(service.messages.slice(start).filter(event => event.method === 'editMessageReplyMarkup').length, 2);
  } finally { tg.editMessageReplyMarkup = original; await approval(true); }
});

test('revocation during order-card report lookup is checked again before its native markup request', pg, async () => {
  const original = service.pool.query;
  const draft = await createDraft(), start = service.messages.length;
  let revoked = false;
  try {
    service.pool.query = async (...args) => {
      const result = await original(...args);
      if (!revoked && /SELECT a\.id AS audit_id,a\.chat_id,a\.msg_ids\[1\] AS message_id/.test(args[0])) {
        revoked = true; await original('UPDATE staff SET approved=false WHERE tg_id=1001');
      }
      return result;
    };
    forbidden(await submit(draft));
    assert.equal(revoked, true);
    const blocked = await row(draft);
    assert.equal(blocked.delivery.handoffSent, true); assert.equal(blocked.delivery.orderCardLinked, false);
    assert.equal(service.messages.slice(start).filter(event => event.method === 'editMessageReplyMarkup').length, 1);
    service.pool.query = original; await approval(true); await completedOnce(draft, start);
    assert.equal(service.messages.slice(start).filter(event => event.method === 'editMessageReplyMarkup').length, 2);
  } finally { service.pool.query = original; await approval(true); }
});

test('an access-lookup failure after durable intent is sanitized, definitely unsent and recoverable', pg, async () => {
  const drafts = require('../src/web/audit-drafts'), save = drafts.saveDraftDelivery, query = service.pool.query;
  const draft = await createDraft(), start = service.messages.length;
  let fail = false;
  try {
    drafts.saveDraftDelivery = async (...args) => { const result = await save(...args); if (args[3]?.inflight) fail = true; return result; };
    service.pool.query = async (...args) => {
      if (fail && args[0] === 'SELECT tg_id FROM staff WHERE tg_id=$1 AND approved IS TRUE') throw new Error('SYNTHETIC_INTERNAL_SQL_DIAGNOSTIC');
      return query(...args);
    };
    const result = await submit(draft);
    assert.equal(result.status, 503); assert.equal(result.body.code, 'AUDIT_ACCESS_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC_INTERNAL_SQL_DIAGNOSTIC/);
    assert.equal(result.body.delivery_unknown, undefined); assert.equal(physical(service.messages.slice(start)).length, 0);
    const blocked = await row(draft); assert.deepEqual(blocked.delivery, {}); assert.equal(blocked.submitting_revision, null);
    service.pool.query = query; drafts.saveDraftDelivery = save;
    await completedOnce(draft, start);
  } finally { service.pool.query = query; drafts.saveDraftDelivery = save; }
});
