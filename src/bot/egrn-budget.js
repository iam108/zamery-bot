'use strict';

// This is a record of the shared provider account, never a payment API.
const DDL = `
  CREATE TABLE IF NOT EXISTS egrn_budget_accounts (
    account TEXT PRIMARY KEY,
    balance_kopecks BIGINT,
    bootstrapped BOOLEAN NOT NULL DEFAULT false,
    tracking_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS egrn_budget_orders (
    account TEXT NOT NULL REFERENCES egrn_budget_accounts(account),
    order_id INT NOT NULL,
    price_kopecks BIGINT,
    state TEXT NOT NULL CHECK(state IN ('reserved','confirmed','rejected')),
    statement_id BIGINT,
    historical BOOLEAN NOT NULL DEFAULT false,
    source_created_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(account,order_id)
  );
  CREATE TABLE IF NOT EXISTS egrn_budget_charges (
    account TEXT NOT NULL REFERENCES egrn_budget_accounts(account),
    statement_id BIGINT NOT NULL,
    order_id INT NOT NULL,
    amount_kopecks BIGINT,
    historical BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(account,statement_id)
  );
  CREATE TABLE IF NOT EXISTS egrn_budget_events (
    id BIGSERIAL PRIMARY KEY,
    account TEXT NOT NULL REFERENCES egrn_budget_accounts(account),
    source_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('topup','balance')),
    amount_kopecks BIGINT NOT NULL,
    actor_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account,source_key)
  );
`;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function error(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function safe(value) {
  const integer = BigInt(value);
  if (integer > MAX || integer < -MAX) throw error('EGRN_BUDGET_AMOUNT', 'Сумма слишком велика для учёта.');
  return Number(integer);
}
function parseAmount(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') throw error('EGRN_BUDGET_AMOUNT', 'Укажите сумму в рублях, например 2500 или 2500,50.');
  const source = String(value).trim();
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:[ \u00a0]\d{3})+)(?:[.,]\d{1,2})?$/.test(source)) throw error('EGRN_BUDGET_AMOUNT', 'Укажите сумму в рублях, например 2500 или 2500,50.');
  const [rubles, fraction = ''] = source.replace(/[ \u00a0]/g, '').split(/[.,]/);
  const kopecks = safe(BigInt(rubles) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (kopecks < 0 || !allowZero && !kopecks) throw error('EGRN_BUDGET_AMOUNT', 'Пополнение должно быть больше нуля.');
  return kopecks;
}
function rubles(kopecks) { const value = BigInt(kopecks), absolute = value < 0n ? -value : value; return (value < 0n ? '−' : '') + absolute / 100n + ',' + String(absolute % 100n).padStart(2, '0') + ' ₽'; }
function describe(value) {
  const lines = ['Заказано выписок: ' + value.confirmedOrders + '.'];
  if (value.balanceKnown) lines.push('Расчётно осталось: ' + value.remainingOrders + ' (доступно ' + rubles(value.availableKopecks) + ').');
  else {
    const date = new Date(value.trackingStartedAt).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    if (value.recordedTopupsKopecks > 0 && value.trackedAvailableKopecks >= 0) lines.push('По учтённым пополнениям с ' + date + ': осталось ' + value.trackedRemainingOrders + ' выписок (' + rubles(value.trackedAvailableKopecks) + ').');
    else if (value.trackedAvailableKopecks < 0) lines.push('С начала учёта расход и резерв превышают учтённые пополнения на ' + rubles(-value.trackedAvailableKopecks) + '; начальные средства не учтены.');
    lines.push('Остаток не сверён: начальный баланс не учтён.');
  }
  if (value.pendingOrders) lines.push('Требуют подтверждения: ' + value.pendingOrders + '; резерв ' + rubles(value.reservedKopecks) + '.');
  return lines.join(' ');
}
function createEgrnBudget(options = {}) {
  const pool = options.pool || require('../db/pool'), account = options.account || 'armrus';
  const price = options.priceKopecks == null ? 12900 : options.priceKopecks;
  if (typeof account !== 'string' || !account || account.length > 200 || !Number.isSafeInteger(price) || price < 1) throw new TypeError('Invalid EGRN budget account or price');
  let initialized;
  const id = value => {
    if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw error('EGRN_BUDGET_ORDER', 'Некорректный номер заказа.');
    return Number(value);
  };
  const statement = value => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) || !/^[1-9]\d{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) throw error('EGRN_BUDGET_STATEMENT', 'Некорректный номер заказа поставщика.');
    return String(value);
  };
  async function lock(client) {
    await client.query('INSERT INTO egrn_budget_accounts(account) VALUES($1) ON CONFLICT DO NOTHING', [account]);
    return (await client.query('SELECT * FROM egrn_budget_accounts WHERE account=$1 FOR UPDATE', [account])).rows[0];
  }
  async function transaction(run) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
    finally { client.release(); }
  }
  async function ensure() {
    if (!initialized) initialized = (async () => {
      await pool.query(DDL);
      await transaction(async client => {
        const current = await lock(client); if (current.bootstrapped) return;
        const exists = (await client.query("SELECT to_regclass('egrn_orders') AS name")).rows[0]?.name;
        if (exists) {
          const old = (await client.query("SELECT id,id_statement,status,to_jsonb(egrn_orders)->>'created_at' AS original_created_at FROM egrn_orders WHERE id_statement>0 OR status IN ('ordering','order_unknown') ORDER BY id")).rows;
          for (const row of old) {
            if (Number(row.id_statement) > 0) {
              await client.query("INSERT INTO egrn_budget_charges(account,statement_id,order_id,historical) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING", [account, statement(row.id_statement), row.id]);
              await client.query("INSERT INTO egrn_budget_orders(account,order_id,state,statement_id,historical,source_created_at) VALUES($1,$2,'confirmed',$3,true,$4) ON CONFLICT DO NOTHING", [account, row.id, statement(row.id_statement), row.original_created_at || null]);
            } else await client.query("INSERT INTO egrn_budget_orders(account,order_id,price_kopecks,state,historical,source_created_at) VALUES($1,$2,$3,'reserved',true,$4) ON CONFLICT DO NOTHING", [account, row.id, price, row.original_created_at || null]);
          }
        }
        await client.query('UPDATE egrn_budget_accounts SET bootstrapped=true WHERE account=$1', [account]);
      });
    })().catch(failure => { initialized = null; throw failure; });
    return initialized;
  }
  async function read(client) {
    const row = (await client.query(`SELECT a.balance_kopecks,a.tracking_started_at,
      (SELECT COUNT(*) FROM egrn_budget_charges c WHERE c.account=a.account) AS confirmed,
      (SELECT COUNT(*) FROM egrn_budget_charges c WHERE c.account=a.account AND c.historical) AS historical,
      (SELECT COUNT(*) FROM egrn_budget_orders o WHERE o.account=a.account AND o.state='reserved') AS pending,
      (SELECT COALESCE(SUM(price_kopecks),0) FROM egrn_budget_orders o WHERE o.account=a.account AND o.state='reserved') AS reserved,
      (SELECT COALESCE(SUM(amount_kopecks),0) FROM egrn_budget_charges c WHERE c.account=a.account AND NOT c.historical) AS charged,
      (SELECT COALESCE(SUM(amount_kopecks),0) FROM egrn_budget_events e WHERE e.account=a.account AND kind='topup') AS topups
      FROM egrn_budget_accounts a WHERE account=$1`, [account])).rows[0];
    const known = row.balance_kopecks != null, balance = known ? safe(row.balance_kopecks) : null, reserved = safe(row.reserved);
    const available = known ? safe(BigInt(balance) - BigInt(reserved)) : null;
    const topups = safe(row.topups), tracked = safe(BigInt(topups) - BigInt(row.charged)), trackedAvailable = safe(BigInt(tracked) - BigInt(reserved));
    const count = value => value > 0 ? Number(BigInt(value) / BigInt(price)) : 0;
    return { account, priceKopecks: price, confirmedOrders: Number(row.confirmed), historicalOrders: Number(row.historical), pendingOrders: Number(row.pending),
      reservedKopecks: reserved, recordedTopupsKopecks: topups, balanceKnown: known, balanceKopecks: balance, availableKopecks: available,
      trackingStartedAt: row.tracking_started_at, trackedNetKopecks: tracked, trackedAvailableKopecks: trackedAvailable,
      trackedRemainingOrders: count(trackedAvailable),
      remainingOrders: known ? count(available) : null };
  }
  async function reserveInTransaction(client, order) {
    order = id(order); await lock(client);
    await client.query("INSERT INTO egrn_budget_orders(account,order_id,price_kopecks,state) VALUES($1,$2,$3,'reserved') ON CONFLICT DO NOTHING", [account, order, price]);
    return read(client);
  }
  async function acceptInTransaction(client, order, provider) {
    order = id(order); provider = statement(provider); const current = await lock(client);
    await client.query("INSERT INTO egrn_budget_orders(account,order_id,price_kopecks,state) VALUES($1,$2,$3,'reserved') ON CONFLICT DO NOTHING", [account, order, price]);
    const entry = (await client.query('SELECT * FROM egrn_budget_orders WHERE account=$1 AND order_id=$2', [account, order])).rows[0];
    if (entry.statement_id != null && String(entry.statement_id) !== provider) throw error('EGRN_BUDGET_STATEMENT_CONFLICT', 'За заказом уже закреплён другой номер поставщика.', 409);
    const inserted = (await client.query('INSERT INTO egrn_budget_charges(account,statement_id,order_id,amount_kopecks,historical) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING statement_id', [account, provider, order, entry.historical ? null : entry.price_kopecks, entry.historical])).rows.length > 0;
    if (inserted && !entry.historical && current.balance_kopecks != null) {
      const next = safe(BigInt(current.balance_kopecks) - BigInt(entry.price_kopecks));
      await client.query('UPDATE egrn_budget_accounts SET balance_kopecks=$1,updated_at=NOW() WHERE account=$2', [next, account]);
    }
    await client.query("UPDATE egrn_budget_orders SET state='confirmed',statement_id=$1 WHERE account=$2 AND order_id=$3", [provider, account, order]);
    return read(client);
  }
  async function rejectInTransaction(client, order) {
    order = id(order); await lock(client);
    // A later provider failure is not evidence of a refund.
    await client.query("UPDATE egrn_budget_orders SET state='rejected' WHERE account=$1 AND order_id=$2 AND statement_id IS NULL", [account, order]);
    return read(client);
  }
  async function event(kind, amount, context = {}) {
    const kopecks = parseAmount(amount, { allowZero: kind === 'balance' });
    const key = context.sourceKey;
    if (typeof key !== 'string' || !key || key.length > 300) throw error('EGRN_BUDGET_SOURCE', 'Не удалось определить номер операции учёта.');
    await ensure();
    return transaction(async client => {
      const current = await lock(client);
      const previous = (await client.query('SELECT kind,amount_kopecks FROM egrn_budget_events WHERE account=$1 AND source_key=$2', [account, key])).rows[0];
      if (previous) {
        if (previous.kind !== kind || safe(previous.amount_kopecks) !== kopecks) throw error('EGRN_BUDGET_EVENT_CONFLICT', 'Эта операция учёта уже записана с другими данными.', 409);
        return read(client);
      }
      const before = await read(client);
      if (kind === 'balance' && before.pendingOrders) throw error('EGRN_BUDGET_PENDING', 'Сначала подтвердите результат ' + before.pendingOrders + ' заказов у поставщика, затем повторите сверку баланса.', 409);
      safe(BigInt(before.recordedTopupsKopecks) + BigInt(kind === 'topup' ? kopecks : 0));
      const next = kind === 'balance' ? kopecks : current.balance_kopecks == null ? null : safe(BigInt(current.balance_kopecks) + BigInt(kopecks));
      await client.query('INSERT INTO egrn_budget_events(account,source_key,kind,amount_kopecks,actor_id) VALUES($1,$2,$3,$4,$5)', [account, key, kind, kopecks, context.actorId || null]);
      await client.query('UPDATE egrn_budget_accounts SET balance_kopecks=$1,updated_at=NOW() WHERE account=$2', [next, account]);
      return read(client);
    });
  }
  return { ensure, describe, reserveInTransaction, acceptInTransaction, rejectInTransaction,
    async snapshot() { await ensure(); return read(pool); },
    async previewHistory() {
      await ensure();
      const row = (await pool.query(`SELECT COUNT(DISTINCT statement_id) AS confirmed,MIN(source_created_at) AS first,MAX(source_created_at) AS last,
        (SELECT COUNT(*) FROM egrn_budget_orders WHERE account=$1 AND historical AND state='reserved') AS pending
        FROM egrn_budget_orders WHERE account=$1 AND historical AND statement_id IS NOT NULL`, [account])).rows[0];
      return { confirmedOrders: Number(row.confirmed), estimatedKopecks: safe(BigInt(row.confirmed) * BigInt(price)),
        fromDate: row.first || null, toDate: row.last || null, unknownOrders: Number(row.pending) };
    },
    async reserve(order) { await ensure(); return transaction(client => reserveInTransaction(client, order)); },
    async accept(order, provider) { await ensure(); return transaction(client => acceptInTransaction(client, order, provider)); },
    async reject(order) { await ensure(); return transaction(client => rejectInTransaction(client, order)); },
    async reconcile(order, provider) { return provider == null ? this.reject(order) : this.accept(order, provider); },
    topup: (amount, context) => event('topup', amount, context), syncBalance: (amount, context) => event('balance', amount, context) };
}
module.exports = { DDL, createEgrnBudget, parseAmount, describe };
