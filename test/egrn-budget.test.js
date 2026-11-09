'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEgrnBudget } = require('../src/bot/egrn-budget');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const event = sourceKey => ({ sourceKey, actorId: 101 });

async function fixture(run, historical = []) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  await db.exec("CREATE TABLE egrn_orders(id INT PRIMARY KEY,id_statement BIGINT,status TEXT,created_at TIMESTAMPTZ); INSERT INTO egrn_orders(id,id_statement,status) SELECT n,NULL,'new' FROM generate_series(1,100) n;");
  for (const row of historical) await db.query('UPDATE egrn_orders SET id_statement=$1,status=$2,created_at=$4 WHERE id=$3', [row.statement ?? null, row.status, row.id, row.createdAt || null]);
  let transaction = Promise.resolve();
  const query = async (sql, params) => {
    const result = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
    if (result) result.rowCount = result.affectedRows;
    return result || { rows: [], rowCount: 0 };
  };
  // PGlite has one connection. Queue checked-out clients like a one-slot pg
  // pool, preserving the transactions used by the actual budget service.
  const pool = { query, async connect() {
    const previous = transaction; let release; transaction = new Promise(resolve => { release = resolve; }); await previous;
    return { query, release };
  } };
  const budget = createEgrnBudget({ pool, account: 'armrus', priceKopecks: 12900 });
  try { await budget.ensure(); await run({ db, pool, budget, other: options => createEgrnBudget({ pool, account: 'armrus', priceKopecks: 12900, ...options }) }); }
  finally { await db.close(); }
}
function money(snapshot, balance, available = balance) {
  assert.equal(snapshot.balanceKnown, true); assert.equal(snapshot.balanceKopecks, balance); assert.equal(snapshot.availableKopecks, available);
  assert.equal(snapshot.remainingOrders, Math.max(0, Math.floor(available / snapshot.priceKopecks)));
}
function unknown(snapshot) {
  assert.equal(snapshot.balanceKnown, false); assert.equal(snapshot.balanceKopecks, null); assert.equal(snapshot.availableKopecks, null); assert.equal(snapshot.remainingOrders, null);
}

test('without a checked opening balance, credits and counted orders never invent a known remainder', pg, () => fixture(async ({ budget }) => {
  unknown(await budget.snapshot());
  const credited = await budget.topup('1000', event('credit')); unknown(credited); assert.equal(credited.recordedTopupsKopecks, 100000);
  const reserved = await budget.reserve(1); unknown(reserved); assert.equal(reserved.pendingOrders, 1);
  const accepted = await budget.accept(1, 7001); unknown(accepted); assert.equal(accepted.confirmedOrders, 1); assert.equal(accepted.pendingOrders, 0);
  const describe = budget.describe || require('../src/bot/egrn-budget').describe;
  assert.equal(typeof describe, 'function'); assert.match(describe(accepted), /остаток не свер[её]н/i);
  money(await budget.syncBalance('500', event('opening')), 50000);
}));

test('ruble credits support ordinary decimals and grouping with exact integer kopecks', pg, () => fixture(async ({ budget }) => {
  const values = [['1',100],['1.2',120],['1,23',123],['10 000,5',1000050],['1\u00a0000.50',100050],[10,1000]];
  let total = 0;
  for (const [amount, cents] of values) { total += cents; const snapshot = await budget.topup(amount, event('amount-' + total)); assert.equal(snapshot.recordedTopupsKopecks, total); unknown(snapshot); }
}));

test('invalid, negative, zero, imprecise and unsafe credits leave the ledger unchanged', pg, () => fixture(async ({ budget }) => {
  for (const amount of ['', ' ', null, '0', '0,00', '-1', '+1', '1e3', '1,234', '1..00', '1 00', '1.000,00', '1,000.00', 'Infinity', 'NaN', '90071992547410']) {
    await assert.rejects(budget.topup(amount, event('invalid-' + String(amount))), error => error.status === 400, String(amount));
  }
  const snapshot = await budget.snapshot(); assert.equal(snapshot.recordedTopupsKopecks, 0); unknown(snapshot);
  money(await budget.syncBalance('0', event('zero-opening')), 0);
  await assert.rejects(budget.syncBalance('-1', event('negative-balance')), error => error.status === 400);
}));

test('money event source keys are shared, idempotent and cannot be silently reused for a different amount or command', pg, () => fixture(async ({ budget }) => {
  await budget.syncBalance('1000', event('opening')); await budget.topup('100,00', event('same-credit'));
  money(await budget.topup('100.00', event('same-credit')), 110000);
  assert.equal((await budget.snapshot()).recordedTopupsKopecks, 10000);
  for (const mutate of [() => budget.topup('101', event('same-credit')), () => budget.syncBalance('100', event('same-credit')), () => budget.topup('1000', event('opening'))]) {
    await assert.rejects(mutate(), error => error.status === 409 && error.code === 'EGRN_BUDGET_EVENT_CONFLICT');
  }
  money(await budget.snapshot(), 110000);
}));

test('reserve, acceptance and rejection are idempotent; an accepted provider order cannot be refunded by later failure', pg, () => fixture(async ({ budget }) => {
  await budget.syncBalance('1000', event('opening'));
  money(await budget.reserve(1), 100000, 87100); money(await budget.reserve(1), 100000, 87100);
  const accepted = await budget.accept(1, 7001); money(accepted, 87100); assert.equal(accepted.confirmedOrders, 1); assert.equal(accepted.pendingOrders, 0);
  money(await budget.accept(1, 7001), 87100); money(await budget.reject(1), 87100);
  await budget.reserve(2); money(await budget.reject(2), 87100); money(await budget.reject(2), 87100);
}));

test('concurrent cadastral orders are all counted even beyond the balance and cannot spend the same reservation twice', pg, () => fixture(async ({ budget }) => {
  await budget.syncBalance('1000', event('opening'));
  await Promise.all(Array.from({ length: 10 }, (_, index) => budget.reserve(index + 1)));
  const reserved = await budget.snapshot(); money(reserved, 100000, -29000); assert.equal(reserved.pendingOrders, 10);
  await Promise.all([budget.accept(1,7001),budget.accept(2,7002),budget.accept(3,7003),budget.reserve(1)]);
  const accepted = await budget.snapshot(); money(accepted, 61300, -29000); assert.equal(accepted.confirmedOrders, 3); assert.equal(accepted.pendingOrders, 7);
}));

test('duplicate provider statement aliases charge once and release only the matching alias reservation', pg, () => fixture(async ({ budget }) => {
  await budget.syncBalance('1000', event('opening')); await budget.reserve(1); await budget.reserve(2); await budget.reserve(3);
  await budget.accept(1,7001);
  const alias = await budget.accept(2,7001); money(alias,87100,74200); assert.equal(alias.confirmedOrders,1); assert.equal(alias.pendingOrders,1);
  money(await budget.reject(2),87100,74200); money(await budget.reject(3),87100);
}));

test('coercible nonprimitive order and statement identifiers cannot create a reservation or charge', pg, () => fixture(async ({ budget }) => {
  await budget.syncBalance('1000', event('identifier-opening'));
  for (const badOrder of [[1], [[1]], new Number(1)]) {
    await assert.rejects(budget.reserve(badOrder), error => error.code === 'EGRN_BUDGET_ORDER');
  }
  money(await budget.snapshot(), 100000); assert.equal((await budget.snapshot()).pendingOrders, 0);
  await budget.reserve('1');
  for (const badStatement of [[7001], [[7001]], new String('7001')]) {
    await assert.rejects(budget.accept(1, badStatement), error => error.code === 'EGRN_BUDGET_STATEMENT');
  }
  let snapshot = await budget.snapshot(); money(snapshot, 100000, 87100);
  assert.equal(snapshot.confirmedOrders, 0); assert.equal(snapshot.pendingOrders, 1);
  snapshot = await budget.accept('1', '9223372036854775807'); money(snapshot, 87100);
  assert.equal(snapshot.confirmedOrders, 1); assert.equal(snapshot.pendingOrders, 0);
}));

test('the reservation price remains immutable across later configured price changes', pg, () => fixture(async ({ budget, other }) => {
  await budget.syncBalance('1000', event('opening')); await budget.reserve(1);
  const changed = other({ priceKopecks: 20000 }); await changed.ensure();
  money(await changed.accept(1,7001),87100);
  money(await changed.reserve(2),87100,67100);
  money(await changed.accept(2,7002),67100);
}));

test('balance reconciliation rejects unresolved reservations; exact old sync replay is safe after newer reservations', pg, () => fixture(async ({ budget }) => {
  await budget.syncBalance('1000', event('opening')); await budget.accept(1,7001); await budget.reserve(2);
  await assert.rejects(budget.syncBalance('500', event('pending-checkpoint')), error => error.status === 409 && error.code === 'EGRN_BUDGET_PENDING');
  money(await budget.syncBalance('1000.00', event('opening')),87100,74200);
  await budget.reject(2); money(await budget.syncBalance('500', event('pending-checkpoint')),50000);
  money(await budget.topup('100', event('later-credit')),60000);
  money(await budget.syncBalance('500.00', event('pending-checkpoint')),60000);
  assert.equal((await budget.snapshot()).recordedTopupsKopecks,10000);
}));

test('historical positive provider IDs bootstrap once without invented debits, including later failed orders and duplicate rows', pg, () => fixture(async ({ budget, db }) => {
  let snapshot = await budget.snapshot(); unknown(snapshot); assert.equal(snapshot.historicalOrders,2); assert.equal(snapshot.confirmedOrders,2); assert.equal(snapshot.pendingOrders,1);
  await budget.topup('100',event('unknown-credit')); unknown(await budget.snapshot());
  await assert.rejects(budget.syncBalance('1000',event('opening')),error=>error.code==='EGRN_BUDGET_PENDING');
  await budget.reconcile(4,null); money(await budget.syncBalance('1000',event('opening')),100000);
  await db.query("UPDATE egrn_orders SET id_statement=7003,status='failed' WHERE id=5"); await budget.ensure();
  await budget.reserve(5); snapshot = await budget.accept(5,7003); money(snapshot,87100); assert.equal(snapshot.historicalOrders,2); assert.equal(snapshot.confirmedOrders,3);
  money(await budget.reject(5),87100);
}, [{id:1,statement:7001,status:'done'},{id:2,statement:7001,status:'ordered'},{id:3,statement:7002,status:'failed'},{id:4,status:'order_unknown'}]));

test('historical ordering requests remain reserved until an explicit provider reconciliation', pg, () => fixture(async ({ budget }) => {
  const initial = await budget.snapshot(); unknown(initial); assert.equal(initial.pendingOrders,1);
  const accepted = await budget.reconcile(1,7001); unknown(accepted); assert.equal(accepted.pendingOrders,0); assert.equal(accepted.confirmedOrders,1);
  money(await budget.syncBalance('1000',event('opening')),100000);
  money(await budget.accept(1,7001),100000);
},[{id:1,status:'ordering'}]));

test('account-local credits and reservations do not change another account balance or event idempotency', pg, () => fixture(async ({ budget, other }) => {
  const second = other({account:'another-provider-account'}); await second.ensure();
  await budget.syncBalance('1000',event('opening')); await second.syncBalance('500',event('opening'));
  await budget.topup('100',event('credit')); await second.topup('200',event('credit'));
  await budget.reserve(1); await second.reserve(1);
  money(await budget.snapshot(),110000,97100); money(await second.snapshot(),70000,57100);
}));

test('historical nonpositive statement placeholders cannot break bootstrap or become confirmed charges', pg, () => fixture(async ({ budget }) => {
  const snapshot = await budget.snapshot(); unknown(snapshot); assert.equal(snapshot.confirmedOrders,0); assert.equal(snapshot.historicalOrders,0); assert.equal(snapshot.pendingOrders,2);
  await budget.reject(1); await budget.reject(2); money(await budget.syncBalance('1000',event('opening')),100000);
},[{id:1,statement:0,status:'ordering'},{id:2,statement:-1,status:'order_unknown'}]));

test('a safe maximum-size exact balance is formatted without floating-point cent rounding', pg, () => fixture(async ({ budget }) => {
  const snapshot = await budget.syncBalance('90071992547409.90',event('large-opening'));
  assert.equal(snapshot.balanceKopecks,9007199254740990);
  const describe = budget.describe || require('../src/bot/egrn-budget').describe;
  assert.match(describe(snapshot),/90071992547409,90/); assert.doesNotMatch(describe(snapshot),/90071992547409,91/);
}));

test('arbitrary new topups provide a useful own-period remainder while the provider opening balance stays unknown', pg, () => fixture(async ({ budget }) => {
  await budget.topup('2500,50',event('arbitrary-credit')); await budget.topup('500',event('second-credit'));
  await budget.reserve(1); let state=await budget.snapshot();unknown(state);assert.equal(state.trackedNetKopecks,300050);assert.equal(state.trackedAvailableKopecks,287150);assert.equal(state.trackedRemainingOrders,22);
  await budget.accept(1,7001);state=await budget.snapshot();assert.equal(state.trackedNetKopecks,287150);assert.equal(state.trackedAvailableKopecks,287150);
  const text=budget.describe(state);assert.match(text,/По учтённым пополнениям с/);assert.match(text,/осталось 22/);assert.match(text,/остаток не сверён/i);
  const count=state.confirmedOrders;await budget.accept(1,7001);await budget.reject(1);state=await budget.snapshot();assert.equal(state.confirmedOrders,count);assert.equal(state.trackedNetKopecks,287150);
}));

test('untracked starting funds are explicit instead of a fabricated zero wallet when new-period spending exceeds credits', pg, () => fixture(async ({ budget }) => {
  await budget.accept(1,7001);const state=await budget.snapshot();unknown(state);assert.equal(state.trackedNetKopecks,-12900);assert.equal(state.trackedAvailableKopecks,-12900);
  const text=budget.describe(state);assert.match(text,/начальные средства не учтены/);assert.doesNotMatch(text,/осталось 0/);assert.doesNotMatch(text,/10.?000|77 выпис/);
}));

test('historical preview is read-only, distinct and priced only as an estimate; resolving old unknown orders does not debit a new topup', pg, () => fixture(async ({ budget }) => {
  const before=await budget.previewHistory();assert.equal(before.confirmedOrders,2);assert.equal(before.estimatedKopecks,25800);assert.equal(before.unknownOrders,1);assert.equal(new Date(before.fromDate).toISOString(),'2026-11-01T12:00:00.000Z');assert.equal(new Date(before.toDate).toISOString(),'2026-11-03T12:00:00.000Z');
  await budget.topup('750',event('new-credit'));await budget.reconcile(4,7003);const state=await budget.snapshot();assert.equal(state.confirmedOrders,3);assert.equal(state.historicalOrders,3);assert.equal(state.trackedNetKopecks,75000);assert.equal(state.trackedRemainingOrders,5);
  const preview=await budget.previewHistory();assert.equal(preview.confirmedOrders,3);assert.equal(preview.unknownOrders,0);assert.equal(preview.estimatedKopecks,38700);assert.equal((await budget.snapshot()).recordedTopupsKopecks,75000);
},[{id:1,statement:7001,status:'done',createdAt:'2026-11-01T12:00:00Z'},{id:2,statement:7001,status:'done',createdAt:'2026-11-02T12:00:00Z'},{id:3,statement:7002,status:'failed',createdAt:'2026-11-03T12:00:00Z'},{id:4,status:'order_unknown'}]));

test('a failed ledger checkpoint rolls back its charge and keeps the original reservation available for one exact retry', pg, () => fixture(async ({ budget, db }) => {
  await budget.syncBalance('1000',event('opening'));await budget.reserve(1);
  await db.exec('ALTER TABLE egrn_budget_accounts ADD CONSTRAINT fixture_checkpoint_failure CHECK(balance_kopecks IS NULL OR balance_kopecks>=90000)');
  await assert.rejects(budget.accept(1,7001));let state=await budget.snapshot();money(state,100000,87100);assert.equal(state.confirmedOrders,0);assert.equal(state.pendingOrders,1);
  await db.exec('ALTER TABLE egrn_budget_accounts DROP CONSTRAINT fixture_checkpoint_failure');state=await budget.accept(1,7001);money(state,87100);assert.equal(state.confirmedOrders,1);assert.equal(state.pendingOrders,0);
}));
