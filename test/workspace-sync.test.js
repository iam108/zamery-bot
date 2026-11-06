const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { LISTS } = require('../src/checklists');
const { SESSION_DDL, setupWorkspace, parsePairing, approvePairing, canPair } = require('../src/web/workspace');

const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const seconds = () => Math.floor(Date.now() / 1000);
const pairing = (value, end = seconds() + 300) => 'mac_' + digest(value) + '_' + end.toString(36);
const fixedNow = Date.parse('2026-11-05T22:15:00Z');

function setup(options) {
  const routes = new Map();
  let middleware;
  const app = {
    get: (path, handler) => routes.set('GET ' + path, handler),
    patch: (path, handler) => routes.set('PATCH ' + path, handler),
    post: (path, handler) => routes.set('POST ' + path, handler),
    use: (path, handler) => { assert.equal(path, '/api/workspace'); middleware = handler; },
  };
  setupWorkspace(app, options);
  return async function request(method, path, credential, body, params = {}) {
    const response = { status: 200, headers: {}, body: null };
    const req = { body, params, get: key => key === 'Authorization' && credential ? 'Bearer ' + credential : '' };
    const res = {
      set(key, value) { response.headers[key] = value; },
      status(value) { response.status = value; return this; },
      json(value) { response.body = value; return this; },
    };
    middleware(req, res, () => {});
    await routes.get(method + ' /api/workspace/' + path)(req, res);
    return response;
  };
}

test('the bot pairing payload is bounded, expiring and canonical', () => {
  const value = token(), now = seconds();
  assert.deepEqual(parsePairing(pairing(value, now + 600), now), { digest: digest(value), expiresAt: now + 600 });
  assert.equal(parsePairing(pairing(value, now), now), null);
  assert.equal(parsePairing(pairing(value, now + 601), now), null);
  assert.equal(parsePairing(pairing(value, now + 30).replace(/_([0-9a-z]+)$/, '_0$1'), now), null);
  assert.equal(parsePairing('mac_' + 'B'.repeat(43) + '_' + (now + 30).toString(36), now), null);
  assert.equal(canPair({ approved: true, role: 'auditor' }), false);
  assert.equal(canPair({ approved: false, role: 'lawyer' }), false);
});

test('the public config coalesces concurrent lookups and returns only the bot username', async () => {
  let calls = 0;
  const request = setup({
    pool: { query() { assert.fail('Config and malformed credentials do not access the database.'); } },
    getBot: async () => { calls++; return { username: 'TestZameryBot', first_name: 'Ignored', id: 21 }; },
  });
  const [first, second, invalid] = await Promise.all([
    request('GET', 'config'), request('GET', 'config'), request('GET', 'snapshot', 'invalid'),
  ]);
  assert.deepEqual(first.body, { version: 1, botUsername: 'TestZameryBot' });
  assert.deepEqual(second, first);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.equal(calls, 1);
  assert.equal(invalid.status, 401);
});

const pg = { skip: !process.env.PGLITE_TEST_MODULE };
async function database(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite();
  try {
    await db.exec(SESSION_DDL + `
      CREATE TABLE staff (tg_id BIGINT PRIMARY KEY, name TEXT, role TEXT, approved BOOLEAN);
      CREATE TABLE cases (
        id INT PRIMARY KEY, lawyer_tg_id BIGINT, created_by BIGINT, created_at TIMESTAMPTZ DEFAULT NOW(),
        org TEXT, address TEXT, kind TEXT, service TEXT, checklist_key TEXT, audit_text TEXT, phone TEXT,
        done INT, total INT, data JSONB, decision_due DATE
      );
      CREATE TABLE case_reminders (id INT PRIMARY KEY, case_id INT, remind_on DATE, text TEXT, done BOOLEAN);
      INSERT INTO staff VALUES
        (101, 'Юрист', 'lawyer', true), (102, 'Второй юрист', 'lawyer', true),
        (103, 'Менеджер', 'manager', true), (104, 'Ожидает доступа', 'lawyer', false),
        (105, 'Аудитор', 'auditor', true);
      INSERT INTO cases (id, lawyer_tg_id, created_by, org, address, kind, service, checklist_key, audit_text, phone, done, total, data, decision_due) VALUES
        (1, 101, 103, 'Свой клиент', 'Москва', 'Магазин', 'Продление', 'MSK_MAG', 'Текст отчёта', 'private-phone', 1, 3,
          '{"_stage":"Подано","_comment":"Исходная заметка","_handoff":{"secret":"private-data"},"answer":"keep"}', '2026-11-06'),
        (2, 102, 103, 'Клиент другого юриста', '', '', '', '', '', '', 0, 0, '{}', NULL),
        (3, 101, 103, 'Архивный клиент', '', '', '', '', '', '', 0, 0, '{"_stage":"Архив"}', NULL),
        (4, 102, 102, 'Не передавался менеджером', '', '', '', '', '', '', 0, 0, '{}', NULL);
      INSERT INTO case_reminders VALUES
        (11, 1, '2026-11-05', 'Подготовить письмо', false),
        (12, 1, '2026-11-07', 'Задача выполнена', true),
        (21, 2, '2026-11-06', 'Чужая задача', false),
        (31, 3, '2026-11-06', 'Архивная задача', false);
    `);
    let beforeQuery;
    const pool = { async query(sql, args) {
      if(beforeQuery)await beforeQuery(sql,args);
      const result = await db.query(sql, args);
      return { rows: result.rows, rowCount: result.rows.length || result.affectedRows };
    } };
    const request = setup({ pool, now: () => fixedNow });
    async function connect(id) {
      const credential = token();
      assert.equal(await approvePairing(pool, id, pairing(credential)), true);
      return credential;
    }
    await run({ db, pool, request, connect,interleave(fn){beforeQuery=fn;} });
  } finally {
    await db.close();
  }
}

test('only approved roles can pair, and logout, expiry or revocation stop access', pg, async () => database(async ({ db, pool, request, connect }) => {
  const pending = token(), link = pairing(pending);
  assert.equal((await request('GET', 'snapshot', pending)).status, 401);
  for (const denied of [104, 105, 999]) assert.equal(await approvePairing(pool, denied, link), false);
  assert.equal(await approvePairing(pool, 101, link), true);
  assert.equal(await approvePairing(pool, 102, link), false);
  assert.equal((await request('GET', 'snapshot', pending)).body.account.id, '101');
  assert.deepEqual((await request('POST', 'logout', pending)).body, { ok: true });
  assert.equal((await request('GET', 'snapshot', pending)).status, 401);
  assert.equal(await approvePairing(pool, 101, link), false);
  const expired = await connect(101);
  await db.query("UPDATE workspace_sessions SET expires_at=NOW() - INTERVAL '1 minute' WHERE token_digest=$1", [digest(expired)]);
  assert.equal((await request('GET', 'snapshot', expired)).status, 401);
  const revokedStaff = await connect(101);
  await db.exec('UPDATE staff SET approved=false WHERE tg_id=101');
  assert.equal((await request('GET', 'snapshot', revokedStaff)).status, 401);
}));

for(const operation of ['snapshot','note','reminder'])for(const change of ['approval','role','logout','expiry'])test('workspace '+operation+' rejects '+change+' changed after initial authentication but before its final query',pg,async()=>database(async h=>{
  const credential=await h.connect(101);let changed=false;
  h.interleave(async sql=>{
    const target=operation==='snapshot'?sql.includes('SELECT c.id, c.org'):operation==='note'?sql.includes('WITH target AS MATERIALIZED'):sql.includes('UPDATE case_reminders r SET done');
    if(!changed&&target){changed=true;await h.db.exec(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=101':change==='role'?"UPDATE staff SET role='manager' WHERE tg_id=101":change==='logout'?'UPDATE workspace_sessions SET revoked_at=NOW()':"UPDATE workspace_sessions SET expires_at=NOW()-INTERVAL '1 minute'");}
  });
  const result=operation==='snapshot'?await h.request('GET','snapshot',credential):operation==='note'?await h.request('PATCH','cases/:id/note',credential,{note:'Must not save',expectedNote:'Исходная заметка'},{id:'1'}):await h.request('PATCH','reminders/:id',credential,{completed:true},{id:'11'});
  assert.equal(changed,true);assert.equal(result.status,401);assert.equal(result.body.clients,undefined);
  assert.equal((await h.db.query("SELECT data->>'_comment' AS note FROM cases WHERE id=1")).rows[0].note,'Исходная заметка');assert.equal((await h.db.query('SELECT done FROM case_reminders WHERE id=11')).rows[0].done,false);
}));

for(const operation of ['note','reminder'])test('workspace '+operation+' cannot write a case reassigned after authentication',pg,async()=>database(async h=>{
  const credential=await h.connect(101);let changed=false;h.interleave(async sql=>{if(!changed&&(operation==='note'?sql.includes('WITH target AS MATERIALIZED'):sql.includes('UPDATE case_reminders r SET done'))){changed=true;await h.db.exec('UPDATE cases SET lawyer_tg_id=102 WHERE id=1');}});
  const result=operation==='note'?await h.request('PATCH','cases/:id/note',credential,{note:'Must not save',expectedNote:'Исходная заметка'},{id:'1'}):await h.request('PATCH','reminders/:id',credential,{completed:true},{id:'11'});
  assert.equal(result.status,404);assert.equal((await h.db.query("SELECT data->>'_comment' AS note FROM cases WHERE id=1")).rows[0].note,'Исходная заметка');assert.equal((await h.db.query('SELECT done FROM case_reminders WHERE id=11')).rows[0].done,false);
}));

test('lawyers see assigned active cases, managers see cases they handed off, and private fields stay out of JSON', pg, async () => database(async ({ request, connect }) => {
  const lawyer = await connect(101), manager = await connect(103);
  const result = await request('GET', 'snapshot', lawyer);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.account, { id: '101', name: 'Юрист', role: 'lawyer' });
  assert.equal(result.body.today, '2026-11-06');
  assert.deepEqual(result.body.clients.map(c => c.id), ['1']);
  assert.equal(result.body.clients[0].note, 'Исходная заметка');
  assert.equal(result.body.clients[0].report, 'Текст отчёта');
  assert.ok(result.body.clients[0].checklist.length > 0);
  assert.deepEqual(result.body.tasks, [
    { id: '11', clientID: '1', title: 'Подготовить письмо', dueDate: '2026-11-05', completed: false, editable: true },
    { id: 'decision-1', clientID: '1', title: 'Проверить решение', dueDate: '2026-11-06', completed: false, editable: false },
    { id: '12', clientID: '1', title: 'Задача выполнена', dueDate: '2026-11-07', completed: true, editable: true },
  ]);
  assert.doesNotMatch(JSON.stringify(result.body), /private-phone|private-data|Чужая задача|Архивный клиент/);
  const handedOff = await request('GET', 'snapshot', manager);
  assert.deepEqual(handedOff.body.clients.map(c => c.id).sort(), ['1', '2']);
  assert.ok(handedOff.body.tasks.every(t => !t.editable));
}));

test('workspace checklist keeps actual answers and missing documents grouped and hides inapplicable data', pg, async () => database(async ({ db, request, connect }) => {
  const checklist = LISTS.MSK_OBSH;
  const find = label => checklist.sections.flatMap(section => section.i).find(item => item.l === label);
  const rent = find('Акт приёма-передачи');
  const owner = find('Право собственности подтверждено');
  const address = find('Адрес соответствует ФИАС');
  const egrn = find('На здание / помещение №');
  const choices = {
    basis: 'Собственность',
    building: 'Нежилое',
    graph_dog: 'Есть',
    [rent.id]: { s: 'bad', c: 'hidden rent answer' },
    [owner.id]: { s: 'na', by: 'private author name' },
    [address.id]: { s: 'bad', c: 'Уточнить\nкорпус\u202e' },
    [egrn.id]: '77:01:0000001:20',
    fl_arrest: { s: 'yes', c: 'Сверить запись' },
    docs: { m: { 'Выписка из ЕГРН': 'ok', 'Технический план': 'bad', unrelated: 'private document' }, other: 'Акт осмотра' },
    _handoff: { secret: 'private handoff' },
  };
  await db.query('UPDATE cases SET checklist_key=$1, service=$2, data=$3,done=99,total=999 WHERE id=1', ['MSK_OBSH', 'Получение', choices]);
  const credential = await connect(101);
  const { body } = await request('GET', 'snapshot', credential);
  const client = body.clients[0];
  const items = client.checklistSections.flatMap(section => section.items);
  const result = id => items.find(item => item.id === id);
  assert.equal(client.checklistSections[0].title, 'Паспорт объекта');
  assert.equal(client.total, items.length, 'Progress counts the same currently applicable items as the sheet');
  assert.equal(client.done, 6, 'An attention document group with unchecked options is not resolved; stale stored progress cannot override saved answers');
  assert.deepEqual(client.checklist, items.map(item => item.title));
  assert.deepEqual(result('basis'), { id: 'basis', title: 'Основание', state: 'complete', value: 'Собственность' });
  assert.equal(result('graph_egrn').state, 'pending');
  assert.equal(result('graph_egrn').value, '');
  assert.equal(result(rent.id), undefined);
  assert.equal(result('graph_dog'), undefined);
  assert.equal(result(find('Юр. адрес совпадает с РАР').id), undefined);
  assert.equal(result(owner.id).value, 'Н/П');
  assert.equal(result(egrn.id).value, '77:01:0000001:20');
  assert.equal(result(address.id).state, 'attention');
  assert.equal(result(address.id).value, 'Проблема · Уточнить корпус');
  assert.equal(result('fl_arrest').state, 'attention');
  assert.equal(result('fl_arrest').value, 'Есть · Сверить запись');
  assert.equal(result('docs').state, 'attention');
  assert.match(result('docs').value, /Нет: Технический план\nДополнительно не хватает: Акт осмотра\nЕсть: Выписка из ЕГРН\nНе проверено:/);
  assert.doesNotMatch(JSON.stringify(client), /hidden rent answer|private author name|private document|private handoff/);
}));

test('reminder writes are owner scoped and note writes are compare-and-swap', pg, async () => database(async ({ db, request, connect }) => {
  const lawyer = await connect(101), manager = await connect(103);
  async function mark(id, completed, credential = lawyer) {
    return request('PATCH', 'reminders/:id', credential, { completed }, { id });
  }
  assert.equal((await mark('21', true)).status, 404);
  assert.equal((await mark('31', true)).status, 404);
  assert.equal((await mark('decision-1', true)).status, 400);
  assert.equal((await mark('11', 'true')).status, 400);
  assert.equal((await mark('11', true, manager)).status, 403);
  assert.deepEqual((await mark('11', true)).body, { ok: true });
  assert.equal((await request('GET', 'snapshot', lawyer)).body.tasks.find(task => task.id === '11').completed, true);
  assert.deepEqual((await mark('11', false)).body, { ok: true });

  async function note(id, note, expectedNote, credential = lawyer) {
    return request('PATCH', 'cases/:id/note', credential, { note, expectedNote }, { id });
  }
  assert.equal((await note('2', 'Чужая', '')).status, 404);
  assert.equal((await note('1', 'Новая', 'Исходная заметка', manager)).status, 403);
  assert.equal((await note('1', 'Новая', 'Старая')).status, 409);
  assert.deepEqual((await note('1', 'Новая', 'Исходная заметка')).body, { ok: true });
  assert.deepEqual((await note('1', 'Новая', 'Исходная заметка')).body, { ok: true });
  assert.equal((await note('1', 'Другой текст', 'Исходная заметка')).status, 409);
  const { rows: [{ data }] } = await db.query('SELECT data FROM cases WHERE id=1');
  assert.deepEqual(data, {
    _stage: 'Подано', _comment: 'Новая', _workspaceNote: true,
    _handoff: { secret: 'private-data' }, answer: 'keep',
  });
  await db.exec('UPDATE cases SET lawyer_tg_id=102 WHERE id=1');
  assert.equal((await mark('11', true)).status, 404);
  assert.equal((await note('1', 'Новая', 'Новая')).status, 404);
}));

test('workspace document progress matches web checklist counts while retaining partial missing-document alerts', pg, async () => database(async ({ db, pool, request, connect }) => {
  const fs = require('node:fs'), vm = require('node:vm');
  const context = vm.createContext({ module: { exports: {} }, require(name) {
    if (name === '../db/pool') return pool;
    if (name === '../checklists') return require('../src/checklists');
    if (name === '../checklist-progress') return require('../src/checklist-progress');
    if (name === './auth' || name === './http-errors') return {};
    throw new Error('Unexpected dependency: '+name);
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/web/handoff'),'utf8')+'\nmodule.exports.count=checklistCounts;',context);
  const list = LISTS.MSK_OBSH, docs = list.passport.concat(list.sections.flatMap(section => section.i)).find(item => item.t === 'docs');
  const credential = await connect(101);
  for (const [title,answer,expectedDone,expectedState] of [
    ['partial missing',{ m: { [docs.o[0]]: 'bad' } },0,'attention'],
    ['partial present',{ m: { [docs.o[0]]: 'ok' } },0,'pending'],
    ['extra missing before checking',{ m: {}, other: 'Нужен акт осмотра' },0,'attention'],
    ['all present',{ m: Object.fromEntries(docs.o.map(name => [name,'ok'])) },1,'complete'],
    ['all checked with one missing',{ m: Object.fromEntries(docs.o.map((name,index) => [name,index ? 'ok' : 'bad'])) },1,'attention'],
  ]) {
    const choices = { docs: answer };
    await db.query('UPDATE cases SET checklist_key=$1,service=$2,data=$3,done=999,total=999 WHERE id=1',['MSK_OBSH','Получение',choices]);
    const client = (await request('GET','snapshot',credential)).body.clients[0];
    const web = context.module.exports.count({ checklist_key: 'MSK_OBSH', service: 'Получение' },choices);
    assert.equal(client.done,expectedDone,title); assert.equal(web.done,expectedDone,title); assert.equal(client.total,web.total,title);
    const item = client.checklistSections.flatMap(section => section.items).find(item => item.id === docs.id);
    assert.equal(item.state,expectedState,title);
    if (answer.m[docs.o[0]] === 'bad') assert.match(item.value,new RegExp('Нет: '+docs.o[0]),title);
    if (answer.other) assert.ok(item.value.includes(answer.other),title);
  }
}));
