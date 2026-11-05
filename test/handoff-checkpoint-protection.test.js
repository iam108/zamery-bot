'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/web/handoff.js'), 'utf8');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };

// Run the actual registered route and actual SQL against PostgreSQL semantics.
// Only Telegram, staff auth, timers and unrelated packet routes are synthetic.
async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  const routes = new Map(), queries = [], initialization = [], telegram = [];
  let beforeWrite = null, writes = 0;
  const pool = { async query(sql, params) {
    queries.push(sql);
    if (/^UPDATE cases SET data=/.test(sql)) {
      writes++;
      if (beforeWrite) await beforeWrite({ sql, params, number: writes, db });
    }
    const operation = !params && sql.split(';').filter(value => value.trim()).length > 1 ? db.exec(sql) : db.query(sql, params);
    initialization.push(operation);
    return operation;
  } };
  const context = {
    module: { exports: {} }, URL,
    console: { log() {}, error() {} }, process: { env: {} }, setTimeout() {}, setInterval() {},
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === '../checklists') return { LISTS: {}, STAGES: ['Сбор документов', 'Подано', 'Выездная проверка', 'Архив'], pickChecklist: () => 'QA', flagLabels: () => ({}) };
      if (name === '../bot/instance') return { telegram: { async sendMessage(...args) { telegram.push(args); return { message_id: telegram.length }; } } };
      if (name === './handoff-packet') return { setupHandoffPacket: () => ({}) };
      if (name === './auth') return require('../src/web/auth');
      if (name === './http-errors') return require('../src/web/http-errors');
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.createContext(context); vm.runInContext(source, context);
  const app = { get(url, ...handlers) { routes.set('GET ' + url, handlers.at(-1)); }, post(url, ...handlers) { routes.set('POST ' + url, handlers.at(-1)); } };
  try {
    context.module.exports.setupHandoff(app);
    await Promise.all(initialization);
    const route = routes.get('POST /api/checklist/save'); assert.equal(typeof route, 'function');
    async function rawSave(data, extra = {}) {
      let result, status = 200;
      const row = (await db.query('SELECT checklist_revision FROM cases WHERE id=17')).rows[0];
      await route({ body: { case_id: 17, data, done: 1, total: 4, expectedRevision: Number(row?.checklist_revision || 0), ...extra }, tgUser: { id: 808 }, staff: { name: 'Тестовый юрист', role: 'lawyer', approved: true }, get: () => 'application/json' }, {
        status(value) { status = value; return this; }, json(value) { result = value; },
      });
      return { status, result };
    }
    await run({ db, queries, telegram,
      async seed(data) {
        await db.query(`INSERT INTO cases(id,org,lawyer_name,lawyer_tg_id,created_by,region,checklist_key,data)
          VALUES(17,'ООО Проверка','Тестовый юрист',808,101,'МСК','QA',$1)`, [data]);
      },
      rawSave,
      async save(data, extra = {}) {
        const { result, status } = await rawSave(data, extra);
        assert.equal(status, 200); assert.equal(result?.ok, true, result?.error); return result;
      },
      row: async () => (await db.query('SELECT * FROM cases WHERE id=17')).rows[0],
      interleave(fn) { beforeWrite = fn; },
    });
  } finally { await db.close(); }
}
const checkpoint = generation => ({ version: 2, generation, completed: generation > 1, cards: { '808': 900 + generation }, materials: { confirmed: { '808': [1000 + generation] } }, egrn: { copies: { confirmed: true } } });
const asDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

test('a stale checklist form without internal state preserves a newer backend checkpoint atomically', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(1), older: { s: 'no' } });
  h.interleave(async ({ db }) => { await db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=17", [checkpoint(2)]); });
  await h.save({ _stage: 'Сбор документов', document: { s: 'yes', c: 'Проверено юристом' } }, { done: 4, total: 4 });
  const row = await h.row();
  assert.deepEqual(row.data._handoff, checkpoint(2)); assert.deepEqual(row.data.document, { s: 'yes', c: 'Проверено юристом' });
  assert.equal(row.data.older, undefined); assert.equal(row.done, 4); assert.equal(row.total, 4); assert.ok(row.completed_at);
}));

test('client-provided _handoff cannot replace or add fields to an existing backend checkpoint', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(2) });
  await h.save({ _stage: 'Сбор документов', document: { s: 'no' }, _handoff: { version: 2, completed: false, injected: true, cards: {} } });
  const row = await h.row();
  assert.deepEqual(row.data._handoff, checkpoint(2)); assert.equal(row.data.document.s, 'no'); assert.equal(row.completed_at, null);
}));

test('a normal legacy checklist cannot introduce an invented handoff checkpoint', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', prior: 'legacy' });
  await h.save({ _stage: 'Сбор документов', document: { s: 'yes' }, _handoff: checkpoint(99) });
  const row = await h.row();
  assert.equal(Object.hasOwn(row.data, '_handoff'), false); assert.equal(row.data.document.s, 'yes');
}));

test('first transition to submitted preserves the latest checkpoint across both SQL writes and sets decision dates', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(1) });
  h.interleave(async ({ number, db }) => { await db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=17", [checkpoint(number + 1)]); });
  const result = await h.save({ _stage: 'Подано', _submittedOn: '2026-11-02', document: { s: 'yes' }, _handoff: { malicious: true } });
  const row = await h.row();
  assert.equal(h.queries.filter(sql => /^UPDATE cases SET data=/.test(sql)).length, 1);
  assert.deepEqual(row.data._handoff, checkpoint(2)); assert.equal(row.data._stage, 'Подано');
  assert.equal(asDate(row.submitted_on), '2026-11-02'); assert.equal(asDate(row.decision_due), '2026-11-24');
  assert.equal(row.data._submittedOn, '2026-11-02'); assert.equal(row.data._decisionDue, '2026-11-24');
  assert.equal(result.submittedOn, '2026-11-02'); assert.equal(result.decisionDue, '2026-11-24');
}));

test('editing an already submitted date preserves the latest checkpoint across the recalculation branch', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Подано', _submittedOn: '2026-11-02', _decisionDue: '2026-11-24', _handoff: checkpoint(1) });
  await h.db.query("UPDATE cases SET submitted_on='2026-11-02',decision_due='2026-11-24',reminded_on='2026-11-01' WHERE id=17");
  h.interleave(async ({ number, db }) => { await db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=17", [checkpoint(number + 5)]); });
  const result = await h.save({ _stage: 'Подано', _submittedOn: '2026-11-03', _handoff: null });
  const row = await h.row();
  assert.equal(h.queries.filter(sql => /^UPDATE cases SET data=/.test(sql)).length, 1);
  assert.deepEqual(row.data._handoff, checkpoint(6));
  assert.equal(asDate(row.submitted_on), '2026-11-03'); assert.equal(asDate(row.decision_due), '2026-11-25');
  assert.equal(row.data._decisionDue, '2026-11-25'); assert.equal(row.reminded_on, null); assert.equal(result.decisionDue, '2026-11-25');
}));

for (const data of [[], [{ _handoff: { injected: true } }], '', '{"_handoff":{"injected":true}}', 0, 42, false, true]) {
  test('malformed checklist data is rejected before any checkpoint mutation: ' + JSON.stringify(data), pg, async () => fixture(async h => {
    const original = { _stage: 'Сбор документов', _handoff: checkpoint(2), document: { s: 'yes' } };
    await h.seed(original);
    const { status, result } = await h.rawSave(data);
    assert.equal(status, 400); assert.equal(result.ok, false);
    assert.deepEqual((await h.row()).data, original);
    assert.equal(h.queries.some(sql => /^UPDATE cases SET data=/.test(sql)), false);
  }));
}

test('null retains the legacy empty-answer save while preserving the internal handoff checkpoint', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(2), oldAnswer: { s: 'yes' } });
  await h.save(null);
  const row = await h.row();
  assert.deepEqual(row.data, { _handoff: checkpoint(2) }); assert.equal(row.done, 1); assert.equal(row.total, 4);
}));

test('unrelated Telegram checklist updates preserve a Mac note written during the save', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _comment: 'Исходная заметка', _handoff: checkpoint(2) });
  h.interleave(async ({ number, db }) => {
    if (number === 1) {
      await db.query("UPDATE cases SET data=data || jsonb_build_object('_comment','Заметка с Мака','_workspaceNote',true) WHERE id=17");
    }
  });
  const result = await h.save({
    _stage: 'Подано', _submittedOn: '2026-11-02', _comment: 'Исходная заметка', document: { s: 'yes' },
  }, { expectedNote: 'Исходная заметка' });
  const row = await h.row();
  assert.equal(row.data._comment, 'Заметка с Мака');
  assert.equal(result.note, 'Заметка с Мака');
  assert.equal(row.data._decisionDue, '2026-11-24');
  assert.deepEqual(row.data._handoff, checkpoint(2));
  assert.deepEqual(row.data.document, { s: 'yes' });
}));

test('competing Telegram note edits return the saved note and leave the draft unresolved', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _comment: 'Уже изменено на Маке', _workspaceNote: true });
  const pending = { _stage: 'Сбор документов', _comment: 'Правка в Telegram' };
  for (const version of [{}, { expectedNote: 'Устаревший текст' }]) {
    const result = await h.rawSave(pending, version);
    assert.equal(result.status, 409);
    assert.equal(result.result.code, 'note_conflict');
    assert.equal(result.result.note, 'Уже изменено на Маке');
    assert.equal((await h.row()).data._comment, 'Уже изменено на Маке');
  }
  const saved = await h.save({ ...pending, _workspaceNote: false }, { expectedNote: 'Уже изменено на Маке' });
  assert.equal(saved.note, 'Правка в Telegram');
  assert.deepEqual((await h.row()).data, { ...pending, _workspaceNote: true });
}));

test('typing a note while an unrelated Telegram save is in flight keeps the draft and reports a Mac edit', async () => {
  const start = source.indexOf('function checklistClient()');
  const end = source.indexOf('\n  render();\n  loadReminders();', start);
  assert.ok(start >= 0 && end > start);
  // Run the actual inline save code. Stop before rendering the full checklist.
  const elements = new Map(), storage = new Map();
  const requests = [];
  let respond;
  const client = vm.runInNewContext('(' + source.slice(start, end) + `
    return {
      flush,
      changeAnswer() { D.answer = { s: 'yes' }; changed(); },
      typeNote(value) { D._comment = value; changed(); },
      state() { return { draft: D._comment, base: noteBase, conflict: noteConflict }; },
    };
  })()`, {
    window: {
      addEventListener() {},
      __CFG: { data: { _comment: 'А' }, list: { sections: [], passport: [] }, caseInfo: { id: 17 } },
    },
    document: {
      documentElement: { dataset: {} }, addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {} });
        return elements.get(id);
      },
    },
    location: { search: '' },
    localStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
    fetch(url, options) {
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { respond = resolve; });
    },
  });
  client.changeAnswer();
  const saving = client.flush();
  assert.equal(requests[0].expectedNote, 'А');
  client.typeNote('В');
  respond({ status: 200, headers: { get() {} }, text: async () => JSON.stringify({ ok: true, note: 'Б' }) });
  await saving;
  assert.deepEqual({ ...client.state() }, { draft: 'В', base: 'А', conflict: 'Б' });
  assert.equal(JSON.parse(storage.get('zamery_cl_17')).d._comment, 'В');
  assert.match(elements.get('st').textContent, /Заметка изменилась/);
  await client.flush();
  assert.equal(requests.length, 1);
});


test('a stale checklist response freezes autosave and explicit recovery keeps a local copy before refreshing', async () => {
  const start = source.indexOf('function checklistClient()');
  const end = source.indexOf('\n  render();\n  loadReminders();', start);
  const elements = new Map(), storage = new Map(), requests = [];
  let refreshed = 0, downloads = 0;
  const location = { search: '', reload() { refreshed++; } };
  const client = vm.runInNewContext('(' + source.slice(start, end) + `
    return { flush, edit() { D.answer = {s:'ok'}; changed(); } };
  })()`, {
    window: { addEventListener() {}, location, __CFG: { data: {}, list: { sections: [], passport: [] }, caseInfo: { id: 17, revision: 3 } } },
    document: {
      documentElement: { dataset: {} }, addEventListener() {},
      createElement() { return { click() { downloads++; } }; },
      getElementById(id) { if (!elements.has(id)) elements.set(id, { style: {} }); return elements.get(id); },
    },
    location, Blob, URL: { createObjectURL() { return 'blob:qa'; }, revokeObjectURL() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
    async fetch(url, options) {
      requests.push(JSON.parse(options.body));
      return { status: 409, headers: { get() {} }, text: async () => JSON.stringify({ ok:false, code:'checklist_conflict', revision:4, error:'Changed in another tab' }) };
    },
  });
  client.edit(); await client.flush(); await client.flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].expectedRevision, 3);
  assert.match(elements.get('st').textContent, /актуальные ответы/);
  elements.get('st').onclick();
  assert.equal(downloads, 1); assert.equal(refreshed, 1);
  assert.equal(storage.has('zamery_cl_17'), false);
  assert.equal(JSON.parse(storage.get('zamery_cl_17:recovery')).data.answer.s, 'ok');
});
