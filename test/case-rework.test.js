'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createCaseReworkService } = require('../src/web/case-rework');

const pg = { skip: !process.env.PGLITE_TEST_MODULE, timeout: 20000 };
const manager = 101, lawyer = 202, caseId = 45;

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(), messages = [];
  const admins = process.env.ADMIN_TG_IDS;
  process.env.ADMIN_TG_IDS = '104';
  let tail = Promise.resolve(), transport = () => {}, afterCommit = () => {}, beforeQuery = () => {};
  let currentTime = Date.now();
  async function lease() {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async function execute(sql, args) {
    await beforeQuery(sql, args);
    return args ? db.query(sql, args) : (await db.exec(sql)).at(-1);
  }
  const pool = {
    async query(sql, args) {
      const release = await lease();
      try { return await execute(sql, args); } finally { release(); }
    },
    async connect() {
      let release = await lease();
      const unlock = () => { if (release) release(); release = null; };
      return {
        async query(sql, args) {
          const result = await execute(sql, args);
          if (sql === 'COMMIT' || sql === 'ROLLBACK') unlock();
          if (sql === 'COMMIT') await afterCommit();
          return result;
        },
        release: unlock,
      };
    },
  };
  const telegram = { async sendMessage(chat, text, options) {
    messages.push({ chat, text, options });
    const result = await transport({ chat, text, options });
    return result === undefined ? { message_id: 900 + messages.length, chat: { id: Number(chat) } } : result;
  } };
  const create = () => createCaseReworkService({ pool, telegram, webappUrl: 'https://test.invalid', now: () => currentTime });
  const call = async (service, actor, body) => {
    let status = 200, result;
    const headers = {};
    await service.handle({ tgUser: { id: actor }, body }, {
      set(name, value) { headers[name] = value; return this; },
      status(value) { status = value; return this; },
      json(value) { result = value; return this; },
    });
    return { status, result, headers };
  };
  try {
    await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
      INSERT INTO staff VALUES (101,'Ольга','manager',true),(102,'Другой менеджер','manager',true),(103,'Отозванный менеджер','manager',false),
      (104,'Администратор','auditor',true),(202,'Валерия','lawyer',true),(203,'Другой юрист','lawyer',true),(204,'Отозванный юрист','lawyer',false);
      CREATE TABLE cases(id INT PRIMARY KEY,org TEXT,created_by BIGINT,lawyer_tg_id BIGINT,data JSONB);
      INSERT INTO cases VALUES
        (45,'Тестовый клиент',101,202,'{"_stage":"Сбор документов","_handoff":{"completed":true},"item":"done"}'),
        (46,'Другой клиент',101,202,'{}'),
        (47,'Архивный клиент',101,202,'{"_stage":"Архив"}'),
        (48,'Без менеджера',103,202,'{}'),
        (49,'Передан администратором',104,202,'{}'),
        (50,'Без юриста',101,204,'{}');`);
    await run({ db, pool, messages, create, call, service: create(),
      onSend(fn) { transport = fn; }, afterCommit(fn) { afterCommit = fn; }, beforeQuery(fn) { beforeQuery = fn; },
      advance(ms) { currentTime += ms; },
    });
  } finally {
    if (admins === undefined) delete process.env.ADMIN_TG_IDS;
    else process.env.ADMIN_TG_IDS = admins;
    await tail;
    await db.close();
  }
}

function returnBody(values = {}) {
  return { action: 'return_for_rework', case_id: caseId, request_id: randomUUID(), reason: 'Нужен договор и контакт арендатора', ...values };
}

function resolveBody(request, values = {}) {
  return { action: 'resolve_rework', case_id: request.case_id, rework_id: request.request_id,
    request_id: randomUUID(), response: 'Договор приложен, контакт добавлен', ...values };
}

const send = (h, body, actor = lawyer) => h.call(h.service, actor, body);

test('lawyer returns and original manager resolves the same client with private, confirmed receipts and history', pg, () => fixture(async h => {
  const original = (await h.db.query('SELECT * FROM cases WHERE id=45')).rows[0];
  const request = returnBody({ reason: '  Договор <в работе> & контакт\nСвяжитесь с собственником  ' });
  const first = await send(h, request);
  assert.equal(first.status, 200);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.equal(first.result.rework.role, 'lawyer');
  assert.equal(first.result.rework.can_return, false);
  assert.equal(first.result.rework.requests[0].reason, request.reason.trim());
  assert.equal(first.result.rework.requests[0].return_delivery, 'confirmed');
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].chat, String(manager));
  assert.match(h.messages[0].text, /Клиент возвращён на доработку/);
  assert.ok(h.messages[0].text.includes(request.reason.trim()));
  assert.equal(h.messages[0].options.parse_mode, undefined);
  assert.equal(h.messages[0].options.reply_markup.inline_keyboard[0][0].web_app.url, 'https://test.invalid/checklist?case_id=45&rework=1');
  const restart = h.create();
  assert.equal((await restart.get(caseId, manager)).can_resolve, true);
  assert.equal((await h.call(restart, lawyer, request)).status, 200);
  assert.equal(h.messages.length, 1);
  const resolution = resolveBody(request);
  const done = await send(h, resolution, manager);
  assert.equal(done.status, 200);
  assert.equal(done.result.rework.can_resolve, false);
  assert.equal(done.result.rework.requests[0].status, 'resolved');
  assert.equal(done.result.rework.requests[0].response, resolution.response);
  assert.equal(done.result.rework.requests[0].resolution_delivery, 'confirmed');
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1].chat, String(lawyer));
  assert.match(h.messages[1].text, /Доработка завершена/);
  assert.equal((await h.call(restart, manager, resolution)).status, 200);
  assert.equal(h.messages.length, 2);
  assert.equal((await restart.get(caseId, lawyer)).can_return, true);
  const receipts = (await h.db.query('SELECT return_message_id,resolution_message_id FROM case_rework')).rows[0];
  assert.deepEqual(receipts, { return_message_id: 901, resolution_message_id: 902 });
  assert.deepEqual((await h.db.query('SELECT * FROM cases WHERE id=45')).rows[0], original);
  const next = await send(h, returnBody({ reason: 'Дополнительное соглашение' }));
  assert.equal(next.status, 200);
  assert.equal(next.result.rework.requests.length, 2);
  assert.equal(next.result.rework.requests[0].status, 'open');
  assert.equal(next.result.rework.requests[1].status, 'resolved');
}));

test('return/resolve and history enforce current assigned lawyer and original responsible manager', pg, () => fixture(async h => {
  const request = returnBody();
  for (const actor of [0, manager, 102, 104, 203, 204]) assert.equal((await send(h, request, actor)).status, 403);
  assert.equal((await send(h, returnBody({ case_id: 47 }))).status, 409);
  assert.equal((await send(h, returnBody({ case_id: 48 }))).status, 409);
  assert.equal((await send(h, returnBody({ case_id: 50 }), 204)).status, 403);
  assert.equal((await send(h, request)).status, 200);
  for (const actor of [lawyer, 102, 104, 203, 204]) assert.equal((await send(h, resolveBody(request), actor)).status, 403);
  for (const actor of [102, 104, 203, 204]) {
    assert.equal(await h.service.get(caseId, actor), null);
    const read = await send(h, { action: 'get_rework', case_id: caseId }, actor);
    assert.equal(read.status, 200);
    assert.deepEqual(read.result, { ok: true, rework: null });
    assert.equal(read.headers['Cache-Control'], 'no-store');
  }
  await h.db.query('UPDATE staff SET approved=false WHERE tg_id=$1', [manager]);
  assert.equal((await send(h, resolveBody(request), manager)).status, 403);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=$1', [manager]);
  await h.db.query('UPDATE cases SET lawyer_tg_id=203 WHERE id=45');
  assert.equal(await h.service.get(caseId, lawyer), null);
  assert.deepEqual((await h.service.get(caseId, 203)).requests, []);
  assert.equal((await send(h, resolveBody(request), manager)).status, 403);
  assert.equal(h.messages.length, 1);
  const byAdmin = returnBody({ case_id: 49 });
  assert.equal((await send(h, byAdmin)).status, 200);
  assert.equal(h.messages[1].chat, '104');
  assert.equal((await send(h, resolveBody(byAdmin), 104)).status, 200);
}));

test('blank reasons, cross-case replay and concurrent requests cannot create another open return', pg, () => fixture(async h => {
  for (const reason of [null, '\n\t', {}, 'x'.repeat(1501), '\0']) assert.equal((await send(h, returnBody({ reason }))).status, 400);
  const first = returnBody(), second = returnBody();
  const results = await Promise.all([send(h, first), send(h, second)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const accepted = results[0].status === 200 ? first : second;
  assert.equal((await send(h, { ...accepted, case_id: 46 })).status, 409);
  assert.equal((await send(h, { ...accepted, reason: 'Другая причина' })).status, 409);
  assert.equal((await send(h, resolveBody(accepted, { case_id: 46 }), manager)).status, 403);
  assert.equal((await send(h, resolveBody(accepted, { response: '' }), manager)).status, 400);
  const resolution = resolveBody(accepted);
  const resolutions = await Promise.all([send(h, resolution, manager), send(h, resolution, manager)]);
  assert.deepEqual(resolutions.map(result => result.status), [200, 200]);
  assert.equal((await send(h, { ...resolution, response: 'Другой ответ' }, manager)).status, 409);
  assert.equal((await send(h, resolveBody(accepted), manager)).status, 409);
  assert.equal(h.messages.length, 2);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM case_rework')).rows[0].n, 1);
}));

test('known rejection allows explicit retry, while an unknown or wrong-chat acknowledgement is never resent', pg, () => fixture(async h => {
  const request = returnBody();
  h.onSend(() => { throw Object.assign(new Error('Forbidden'), { response: { error_code: 403 } }); });
  const rejected = await send(h, request);
  assert.equal(rejected.result.rework.requests[0].return_delivery, 'retryable');
  h.onSend(() => {});
  const retried = await h.call(h.create(), lawyer, request);
  assert.equal(retried.result.rework.requests[0].return_delivery, 'confirmed');
  assert.equal(h.messages.length, 2);
  const resolution = resolveBody(request);
  h.onSend(() => ({ message_id: 303, chat: { id: 203 } }));
  assert.equal((await send(h, resolution, manager)).result.rework.requests[0].resolution_delivery, 'unknown');
  assert.equal((await h.call(h.create(), manager, resolution)).result.rework.requests[0].resolution_delivery, 'unknown');
  assert.equal(h.messages.length, 3);
}));

test('revocation between committed intent and notification prevents the private send', pg, () => fixture(async h => {
  const request = returnBody();
  h.afterCommit(async () => {
    h.afterCommit(() => {});
    await h.pool.query('UPDATE staff SET approved=false WHERE tg_id=$1', [manager]);
  });
  const blocked = await send(h, request);
  assert.equal(blocked.status, 200);
  assert.equal(blocked.result.rework.requests[0].return_delivery, 'blocked');
  assert.match(blocked.result.rework.unavailable_reason, /Менеджер/);
  assert.equal(h.messages.length, 0);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=$1', [manager]);
  assert.equal((await h.service.get(caseId, lawyer)).requests[0].return_delivery, 'retryable');
  assert.equal((await send(h, request)).result.rework.requests[0].return_delivery, 'confirmed');
  assert.equal(h.messages.length, 1);
}));

test('an acknowledged message with unavailable receipt storage is not sent again after restart', pg, () => fixture(async h => {
  const request = returnBody();
  h.beforeQuery((sql, args) => {
    if (sql.startsWith('UPDATE case_rework SET return_delivery=$2') && args[1] === 'confirmed') throw Object.assign(new Error('write unavailable'), { code: 'TEST_RECEIPT_WRITE' });
  });
  const first = await send(h, request);
  assert.equal(first.result.rework.requests[0].return_delivery, 'sending');
  assert.equal(h.messages.length, 1);
  h.advance(16000);
  h.beforeQuery(() => {});
  const retry = await h.call(h.create(), lawyer, request);
  assert.equal(retry.result.rework.requests[0].return_delivery, 'unknown');
  assert.equal(h.messages.length, 1);
}));
