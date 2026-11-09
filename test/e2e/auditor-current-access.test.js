'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('./helpers');
let service;
before(async () => {
  service = await createService({ master: true });
  await service.pool.query("UPDATE orders SET object_type='Другое',service='' WHERE id IN(60,61,62)");
});
after(async () => { await service?.close(); });
const physical = events => events.filter(event => ['sendMessage','sendMediaGroup','sendPhoto','sendDocument'].includes(event.method));
const approval = value => service.pool.query('UPDATE staff SET approved=$1 WHERE tg_id=1001', [value]);
async function post(path, body) {
  const auth = new URLSearchParams(service.keyQuery(1001));
  const response = await fetch(service.origin + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Tg-U': auth.get('u'), 'X-Tg-K': auth.get('k'),
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function create(order) {
  const packet = await require('../../src/web/audit-packet').loadAuditPacket(order);
  const data = { schema_version:3,ui_version:5,object_category:'other',order_id:order,request_packet:packet,
    inspection:{org:packet.org,address:packet.address,service:'',visit_date:'2026-11-07'},workflow:{step:2,video_url:''},
    building_type:'Не проверено',boundaries:'Под вопросом',bti:'Не проверено',to:'Не обязательно',
    conclusion:'Synthetic recorded facts preserved after access returns.',entrances:[],zones:[],
    plan:{evidence_id:'',page:1,annotations:[]},map:{evidence_id:'',page:1,annotations:[]},additional_plans:[],evidence:[] };
  const result = await post('/api/audit/drafts', { order_id:order,data });
  assert.equal(result.status, 200); return result.body.draft;
}
const submit = draft => post('/api/audit', { draft_id:draft.id,revision:draft.revision });
const row = async draft => (await service.pool.query('SELECT * FROM audit_drafts WHERE id=$1', [draft.id])).rows[0];
function forbidden(result) {
  assert.equal(result.status,403); assert.equal(result.body.ok,false); assert.equal(result.body.code,'AUDIT_FORBIDDEN');
  assert.equal(result.body.delivery_unknown,undefined);
}
function fullReport(events, order) {
  const sends = physical(events); assert.equal(sends.length,2);
  assert.equal(sends.filter(event=>event.method==='sendMessage').length,1);
  const document = sends.find(event=>event.method==='sendDocument');
  assert.equal(document.item.filename,'Отчёт-'+order+'-полный.txt');
  assert.ok(document.item.bytes.toString('utf8').includes('Synthetic recorded facts preserved'));
}

test('public audit submit rechecks approval after an awaited packet and leaves a definitely unsent report editable', async () => {
  const packet = require('../../src/web/audit-packet'), original = packet.loadAuditPacket;
  const draft = await create(62), start = service.messages.length;
  try {
    packet.loadAuditPacket = async (...args) => { const result=await original(...args); await approval(false); return result; };
    forbidden(await submit(draft));
    const blocked = await row(draft); assert.equal(blocked.submitted_at,null); assert.equal(blocked.submitting_revision,null); assert.deepEqual(blocked.delivery,{});
    assert.equal(physical(service.messages.slice(start)).length,0);
    packet.loadAuditPacket=original; await approval(true);
    assert.equal((await submit(draft)).body.ok,true); fullReport(service.messages.slice(start),62);
    assert.equal((await submit(draft)).body.already_submitted,true); fullReport(service.messages.slice(start),62);
    assert.equal(service.egrnRequests.length,0);
  } finally { packet.loadAuditPacket=original; await approval(true); }
});

test('revocation after a durable unsent intent clears only that intent and permits an exact fresh retry', async () => {
  const drafts = require('../../src/web/audit-drafts'), original = drafts.saveDraftDelivery;
  const draft = await create(61), start = service.messages.length; let revoke=true;
  try {
    drafts.saveDraftDelivery = async (...args) => { const result=await original(...args); if(revoke&&args[3]?.inflight){revoke=false;await approval(false);} return result; };
    forbidden(await submit(draft)); assert.equal(revoke,false);
    const blocked = await row(draft); assert.equal(blocked.submitted_at,null); assert.equal(blocked.submitting_revision,null); assert.deepEqual(blocked.delivery,{});
    assert.equal(physical(service.messages.slice(start)).length,0);
    drafts.saveDraftDelivery=original; await approval(true);
    assert.equal((await submit(draft)).body.ok,true); fullReport(service.messages.slice(start),61);
    assert.equal(service.egrnRequests.length,0);
  } finally { drafts.saveDraftDelivery=original; await approval(true); }
});

test('an accepted summary receipt survives revocation and restored HTTP submit sends only the missing full report', async () => {
  const telegram=require('../../src/bot/instance').telegram, original=telegram.sendMessage;
  const draft=await create(60), start=service.messages.length; let revoke=true;
  try {
    telegram.sendMessage=async(...args)=>{const result=await original(...args);if(revoke){revoke=false;await approval(false);}return result;};
    forbidden(await submit(draft)); const blocked=await row(draft);
    assert.equal(physical(service.messages.slice(start)).length,1); assert.equal(blocked.delivery.textIds.length,1);
    assert.equal(blocked.delivery.documentIds.length,0); assert.equal(blocked.delivery.inflight,undefined);
    assert.equal(blocked.submitted_at,null); assert.equal(blocked.submitting_revision,draft.revision);
    telegram.sendMessage=original; await approval(true);
    assert.equal((await submit(draft)).body.ok,true); fullReport(service.messages.slice(start),60);
    assert.equal((await submit(draft)).body.already_submitted,true); fullReport(service.messages.slice(start),60);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audits WHERE order_id=60')).rows[0].n,1);
    assert.equal(service.egrnRequests.length,0);
  } finally { telegram.sendMessage=original; await approval(true); }
});
