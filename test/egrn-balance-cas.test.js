'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEgrnBudget, snapshotRevision } = require('../src/bot/egrn-budget');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const context = (sourceKey, expectedSnapshot) => ({ sourceKey, actorId: 101, expectedSnapshot });
const stale = error => error.status === 409 && error.code === 'EGRN_BUDGET_SNAPSHOT_CHANGED';

async function fixture(run, historical = []) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  await db.exec("CREATE TABLE egrn_orders(id INT PRIMARY KEY,id_statement BIGINT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW()); INSERT INTO egrn_orders(id,status) SELECT n,'new' FROM generate_series(1,100) n;");
  for (const row of historical) await db.query('UPDATE egrn_orders SET id_statement=$1,status=$2 WHERE id=$3',[row.statement ?? null,row.status,row.id]);
  let tail = Promise.resolve(), beforeNextConnect;
  const query = async (sql,params) => params ? db.query(sql,params) : (await db.exec(sql)).at(-1) || { rows: [] };
  const pool = { query, async connect() {
    if (beforeNextConnect) { const hook=beforeNextConnect;beforeNextConnect=null;await hook(); }
    const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;return {query,release};
  } };
  const budget=createEgrnBudget({pool});
  try { await budget.ensure();await run({budget,db,restart:()=>createEgrnBudget({pool}),beforeTransaction(fn){beforeNextConnect=fn;}}); }
  finally { await db.close(); }
}

test('a fresh review records the approved 4711 current balance after 41 historical orders without a fabricated 10000 credit',pg,()=>fixture(async({budget})=>{
  const reviewed=await budget.snapshot();assert.equal(reviewed.historicalOrders,41);assert.equal(reviewed.confirmedOrders,41);assert.equal(reviewed.balanceKnown,false);assert.equal(reviewed.balanceKopecks,null);
  const revision=snapshotRevision(reviewed);assert.match(revision,/^[a-f0-9]{64}$/);assert.equal(snapshotRevision({...reviewed,trackingStartedAt:new Date(reviewed.trackingStartedAt).toISOString()}),revision);
  const saved=await budget.syncBalance('4711',context('approved-current-balance',revision));
  assert.equal(saved.balanceKopecks,471100);assert.equal(saved.availableKopecks,471100);assert.equal(saved.remainingOrders,36);assert.equal(saved.recordedTopupsKopecks,0);assert.equal(saved.historicalOrders,41);
},Array.from({length:41},(_,index)=>({id:index+1,statement:7000+index,status:'done'}))));

test('a provider acceptance after review cannot be overwritten by the old proposed balance',pg,()=>fixture(async({budget})=>{
  await budget.syncBalance('10000',{sourceKey:'opening',actorId:101});const revision=snapshotRevision(await budget.snapshot());
  await budget.accept(1,7001);const current=await budget.snapshot();assert.equal(current.balanceKopecks,987100);
  await assert.rejects(budget.syncBalance('4711',context('stale-balance',revision)),stale);
  assert.deepEqual(await budget.snapshot(),current);
}));

test('a new credit after review changes the revision even while the provider opening balance remains unknown',pg,()=>fixture(async({budget})=>{
  const revision=snapshotRevision(await budget.snapshot());await budget.topup('500',{sourceKey:'new-credit',actorId:101});const current=await budget.snapshot();assert.equal(current.balanceKnown,false);
  await assert.rejects(budget.syncBalance('4711',context('stale-balance',revision)),stale);assert.deepEqual(await budget.snapshot(),current);
}));

test('a reservation appearing after review is detected by CAS before an outdated balance can be accepted',pg,()=>fixture(async({budget})=>{
  const revision=snapshotRevision(await budget.snapshot());await budget.reserve(1);const current=await budget.snapshot();
  await assert.rejects(budget.syncBalance('4711',context('stale-balance',revision)),stale);assert.deepEqual(await budget.snapshot(),current);assert.equal(current.pendingOrders,1);
}));

test('accepting or rejecting an old unknown order invalidates its earlier review without inventing a historical debit',pg,async()=>{
  for (const provider of [null,7001]) await fixture(async({budget})=>{
    const revision=snapshotRevision(await budget.snapshot());await budget.reconcile(1,provider);const current=await budget.snapshot();assert.equal(current.pendingOrders,0);assert.equal(current.trackedNetKopecks,0);
    await assert.rejects(budget.syncBalance('4711',context('stale-balance',revision)),stale);assert.deepEqual(await budget.snapshot(),current);
  },[{id:1,status:'order_unknown'}]);
});

test('the comparison occurs after acquiring the account transaction rather than before a concurrent committed credit',pg,()=>fixture(async({budget,beforeTransaction})=>{
  const revision=snapshotRevision(await budget.snapshot());beforeTransaction(()=>budget.topup('500',{sourceKey:'interleaved-credit',actorId:101}));
  await assert.rejects(budget.syncBalance('4711',context('stale-balance',revision)),stale);
  const current=await budget.snapshot();assert.equal(current.balanceKnown,false);assert.equal(current.recordedTopupsKopecks,50000);
}));

test('exact accepted balance-event replay returns current accounting after later changes even when the private review cache expired',pg,()=>fixture(async({budget,restart})=>{
  const revision=snapshotRevision(await budget.snapshot());await budget.syncBalance('4711',context('same-telegram-message',revision));
  await budget.topup('100',{sourceKey:'later-credit',actorId:101});await budget.accept(1,7001);const current=await budget.snapshot();assert.equal(current.balanceKopecks,468200);
  assert.deepEqual(await budget.syncBalance('4711.00',context('same-telegram-message',null)),current);
  assert.deepEqual(await budget.syncBalance('4711',context('same-telegram-message',revision)),current);
  assert.deepEqual(await restart().syncBalance('4711',context('same-telegram-message',null)),current);
  await assert.rejects(budget.syncBalance('4712',context('same-telegram-message',null)),error=>error.code==='EGRN_BUDGET_EVENT_CONFLICT');
  assert.deepEqual(await budget.snapshot(),current);
}));

test('a missing private review is rejected explicitly while a fresh re-review permits one exact current-balance record',pg,()=>fixture(async({budget})=>{
  await assert.rejects(budget.syncBalance('4711',context('private-command',null)),error=>error.status===409&&error.code==='EGRN_BUDGET_REVIEW_REQUIRED');
  assert.equal((await budget.snapshot()).balanceKnown,false);
  await budget.topup('100',{sourceKey:'credit',actorId:101});const fresh=snapshotRevision(await budget.snapshot());const saved=await budget.syncBalance('4711',context('private-command',fresh));assert.equal(saved.balanceKopecks,471100);
}));
