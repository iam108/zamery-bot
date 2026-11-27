'use strict';

const { checklistExists, exactChecklist, CHECKLIST_PROFILE, STAGES } = require('../checklists');
const { canAccessCase, canManageCases } = require('./auth');

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
function caseNumber(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647)
    fail(400, 'CHECKLIST_CASE_INVALID', 'Проверьте номер клиента.');
  return Number(value);
}

function createChecklistSetupService({ pool, counts }) {
  async function resolve(caseId, actorId, choices) {
    const id = caseNumber(caseId), explicit = choices !== undefined;
    const connection = await pool.connect();
    let transaction = false;
    try {
      await connection.query('BEGIN'); transaction = true;
      // Serialize assignment with other initializers and case reassignment.
      const client = (await connection.query('SELECT * FROM cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
      const staff = (await connection.query('SELECT * FROM staff WHERE tg_id=$1', [actorId])).rows[0];
      if (!client) fail(404, 'CHECKLIST_CASE_NOT_FOUND', 'Клиент не найден.');
      if (!canAccessCase(staff, actorId, client)) fail(403, 'CASE_FORBIDDEN', 'Этот клиент недоступен вашему аккаунту.');
      if (checklistExists(client.checklist_key)) {
        if (explicit) fail(409, 'CHECKLIST_ALREADY_CONFIGURED', 'Чек-лист уже выбран. Откройте его заново.');
        await connection.query('COMMIT'); transaction = false; return client;
      }
      if (client.data?._stage === 'Архив') {
        if (explicit) fail(409, 'CHECKLIST_CASE_ARCHIVED', 'Клиент находится в архиве. Для выбора чек-листа сначала верните его в работу.');
        await connection.query('COMMIT'); transaction = false; return client;
      }
      const profile = {};
      for (const [field, allowed] of Object.entries(CHECKLIST_PROFILE)) {
        const previous = client[field];
        if (explicit) {
          if (!choices || typeof choices !== 'object' || Array.isArray(choices) || !allowed.includes(choices[field]))
            fail(400, 'CHECKLIST_PROFILE_REQUIRED', 'Выберите регион, тип объекта и услугу.');
          if (allowed.includes(previous) && previous !== choices[field])
            fail(409, 'CHECKLIST_PROFILE_CHANGED', 'Сведения клиента изменились. Откройте карточку заново и проверьте регион, тип объекта и услугу.');
          profile[field] = choices[field];
        } else profile[field] = previous;
      }
      const key = exactChecklist(profile);
      if (!key) {
        if (explicit) fail(400, 'CHECKLIST_PROFILE_UNSUPPORTED', 'Для выбранных региона, типа объекта и услуги пока нет подходящего чек-листа. Свяжитесь с менеджером для уточнения порядка работы.');
        await connection.query('COMMIT'); transaction = false; return client;
      }
      const progress = counts({ ...client, ...profile, checklist_key: key }, client.data || {});
      const updated = (await connection.query(`UPDATE cases SET checklist_key=$2,region=$3,kind=$4,service=$5,
        done=$6,total=$7,checklist_revision=checklist_revision+1,
        completed_at=CASE WHEN $7::int>0 AND $6::int>=$7::int THEN COALESCE(completed_at,NOW()) ELSE NULL END
        WHERE id=$1 AND EXISTS(SELECT 1 FROM staff actor WHERE actor.tg_id=$8 AND actor.approved IS TRUE
          AND (actor.role='manager' OR $9::boolean OR actor.role='lawyer' AND cases.lawyer_tg_id=actor.tg_id))
        RETURNING *`, [id, key, profile.region, profile.kind, profile.service, progress.done, progress.total, actorId,
          canManageCases({ approved: true, role: 'auditor' }, actorId)])).rows[0];
      if (!updated) fail(403, 'CASE_FORBIDDEN', 'Доступ к клиенту изменился. Откройте карточку заново.');
      await connection.query('COMMIT'); transaction = false; return updated;
    } catch (error) {
      if (transaction) await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { connection.release(); }
  }
  return {
    prepare: (caseId, actorId) => resolve(caseId, actorId),
    initialize: (caseId, actorId, choices) => resolve(caseId, actorId, choices)
  };
}

function setupClient() {
  const form = document.getElementById('checklist-setup'), button = document.getElementById('setup-submit'), status = document.getElementById('setup-status');
  const tg = window.Telegram?.WebApp;
  try { tg?.ready(); tg?.expand(); } catch (_) {}
  if (!form) return;
  form.addEventListener('submit', async function (event) {
    event.preventDefault(); if (button.disabled) return;
    button.disabled = true; status.textContent = 'Открываю чек-лист…';
    const body = { case_id: Number(form.dataset.caseId) };
    for (const field of ['region', 'kind', 'service']) body[field] = document.getElementById('setup-' + field).value;
    try {
      const response = await fetch('/checklist/view?case_id=' + encodeURIComponent(body.case_id) + '&setup=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('Не удалось подтвердить сохранение. Попробуйте ещё раз.'); }
      if (response.ok && result.ok || result.code === 'CHECKLIST_ALREADY_CONFIGURED') { location.reload(); return; }
      throw new Error(result.error || 'Не удалось открыть чек-лист. Попробуйте ещё раз.');
    } catch (error) { status.textContent = error.message || 'Нет связи. Попробуйте ещё раз.'; button.disabled = false; }
  });
}

function clientActions(actorId) {
  const root = document.getElementById('case-actions');
  if (!root) return;
  const caseId = Number(root.dataset.caseId), revision = Number(root.dataset.revision), stage = root.dataset.stage;
  const archive = document.getElementById('case-archive'), restore = document.getElementById('case-restore');
  const retry = document.getElementById('case-action-retry'), refresh = document.getElementById('case-action-refresh');
  const panel = document.getElementById('case-action-confirmation'), description = document.getElementById('case-action-description');
  const confirm = document.getElementById('case-action-confirm'), cancel = document.getElementById('case-action-cancel');
  const status = document.getElementById('case-action-status'), documents = document.getElementById('case-documents');
  const key = 'case-basic-action:' + actorId + ':' + caseId;
  const actions = ['archive_client', 'restore_client'];
  let pending = null, selected = '', busy = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved && actions.includes(saved.action) && Number.isSafeInteger(saved.expectedRevision) && saved.expectedRevision >= 0 &&
      /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(saved.request_id || '')) pending = saved;
  } catch (_) {}
  function remember(value) {
    pending = value;
    try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch (_) {}
    if (archive) archive.hidden = !!value || stage === 'Архив';
    if (restore) restore.hidden = !!value || stage !== 'Архив';
    retry.hidden = !value;
  }
  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  // Keep the same signed launch context when opening documents in Telegram.
  const url = new URL(documents.href, location.href), launch = new URLSearchParams(location.search);
  if (launch.has('u') && launch.has('k')) { url.searchParams.set('u', launch.get('u')); url.searchParams.set('k', launch.get('k')); }
  url.hash = location.hash; documents.href = url.href;
  function ask(action) {
    if (busy) return;
    selected = pending?.action || action;
    description.textContent = selected === 'archive_client'
      ? 'Клиент исчезнет из активного списка и расчёта нагрузки юриста. Документы, заметки и история сохранятся. Клиента можно будет вернуть в работу.'
      : 'Клиент снова появится в активном списке и расчёте нагрузки юриста. Документы, заметки и история сохранятся.';
    confirm.textContent = pending ? 'Проверить результат' : selected === 'archive_client' ? 'Убрать в архив' : 'Вернуть в работу';
    cancel.textContent = pending ? 'Позже' : 'Отмена'; panel.hidden = false; confirm.focus();
  }
  if (archive) archive.onclick = () => ask('archive_client');
  if (restore) restore.onclick = () => ask('restore_client');
  retry.onclick = () => ask(pending?.action);
  cancel.onclick = () => { if (busy) return; panel.hidden = true; selected = ''; if (pending) status.textContent = 'Результат предыдущего действия пока не подтверждён. Можно проверить его позже.'; };
  refresh.onclick = () => { if (busy) return; remember(null); location.reload(); };
  confirm.onclick = async () => {
    if (busy || !actions.includes(selected)) return;
    if (!pending) remember({ action: selected, expectedRevision: revision, request_id: uuid() });
    busy = true; root.setAttribute('aria-busy', 'true');
    for (const button of [archive, restore, retry, refresh, confirm, cancel]) if (button) button.disabled = true;
    status.textContent = 'Проверяю результат…'; refresh.hidden = true;
    let timeout;
    try {
      const controller = new AbortController(); timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch('/checklist/view?case_id=' + encodeURIComponent(caseId) + '&manage=1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending), keepalive: true, signal: controller.signal
      });
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('Не удалось подтвердить результат. Проверьте это же действие ещё раз.'); }
      if (!response.ok || result?.ok !== true) {
        if (response.status === 409) refresh.hidden = false;
        throw new Error(result?.error || 'Не удалось подтвердить результат. Попробуйте ещё раз.');
      }
      const nextStage = result.stage;
      if (Number(result.case_id) !== caseId || !Number.isSafeInteger(result.revision) || result.revision !== pending.expectedRevision + 1 ||
        (pending.action === 'archive_client' ? nextStage !== 'Архив' : !['Сбор документов', 'Подано', 'Выездная проверка', 'Решение получено'].includes(nextStage)))
        throw new Error('Сервер не подтвердил изменение этого клиента. Проверьте результат ещё раз.');
      remember(null); location.reload();
    } catch (error) {
      status.textContent = error.name === 'AbortError' ? 'Сервер не ответил. Проверьте это же действие ещё раз — повторного изменения не будет.' : error.message;
      confirm.textContent = 'Проверить результат'; cancel.textContent = 'Позже';
    } finally {
      clearTimeout(timeout); busy = false; root.removeAttribute('aria-busy');
      for (const button of [archive, restore, retry, refresh, confirm, cancel]) if (button) button.disabled = false;
    }
  };
  remember(pending);
  if (pending) status.textContent = 'Есть действие без подтверждённого результата. Нажмите «Проверить результат».';
}

function setupPage(client, actorId) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const labels = { region: 'Регион', kind: 'Тип объекта', service: 'Услуга' };
  const names = { 'МСК': 'Москва', 'МО': 'Московская область', 'СПб': 'Санкт-Петербург' };
  const stage = STAGES.includes(client.data?._stage) ? client.data._stage : 'Сбор документов';
  const archived = stage === 'Архив';
  const unsupported = Object.entries(CHECKLIST_PROFILE).every(([field, values]) => values.includes(client[field])) && !exactChecklist(client);
  const notes = [
    ['case-manager-comment', 'Комментарий менеджера', client.comment],
    ['case-note', 'Заметка юриста', client.data?._comment]
  ].filter(([, , value]) => typeof value === 'string' && value.trim()).map(([id, title, value]) => '<h3>' + title + '</h3><p class="case-note" id="' + id + '">' + esc(value) + '</p>').join('');
  const fields = Object.entries(CHECKLIST_PROFILE).map(([field, values]) => {
    const known = values.includes(client[field]);
    return '<label for="setup-' + field + '">' + labels[field] + '</label><select id="setup-' + field + '" required' + (known ? ' disabled' : '') + '>' +
      '<option value="" disabled' + (!known ? ' selected' : '') + '>Выберите…</option>' + values.map(value => '<option value="' + esc(value) + '"' + (client[field] === value ? ' selected' : '') + '>' + esc(names[value] || value) + '</option>').join('') + '</select>';
  }).join('');
  const management = '<section class="case-section" id="case-actions" data-case-id="' + esc(client.id) + '" data-revision="' + esc(Number(client.checklist_revision) || 0) + '" data-stage="' + esc(stage) + '"><h2>Действия с клиентом</h2><div class="case-controls">' +
    '<a id="case-documents" href="/handoff?case_id=' + esc(client.id) + '&amp;view=documents">Документы клиента</a>' +
    '<button type="button" class="danger" id="case-archive"' + (archived ? ' hidden' : '') + '>Убрать в архив</button><button type="button" class="primary" id="case-restore"' + (!archived ? ' hidden' : '') + '>Вернуть в работу</button>' +
    '<button type="button" class="secondary" id="case-action-retry" hidden>Проверить результат</button></div>' +
    '<div id="case-action-confirmation" hidden><p id="case-action-description"></p><div class="case-controls"><button type="button" class="primary" id="case-action-confirm">Подтвердить</button><button type="button" class="secondary" id="case-action-cancel">Отмена</button></div></div>' +
    '<div id="case-action-status" role="status" aria-live="polite"></div><div class="case-controls"><button type="button" class="secondary" id="case-action-refresh" hidden>Открыть актуальную карточку</button></div></section>' +
    '<section class="case-section" id="rework-panel" aria-labelledby="rework-title" hidden><h2 id="rework-title">Доработка заявки</h2><div id="rework-state" role="status" aria-live="polite"></div><div id="rework-content"></div></section>';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Карточка клиента</title><script async src="https://telegram.org/js/telegram-web-app.js"></script><script>' + require('./auth').clientScript() + '</script><style>' +
    '*{box-sizing:border-box}body{margin:0;padding:28px 16px max(28px,env(safe-area-inset-bottom));font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0e1a2b;background:linear-gradient(140deg,#d7eaff,#d9f2e9 55%,#e8e1ff);min-height:100vh}' +
    'main{max-width:560px;margin:0 auto;padding:24px;border:1px solid rgba(255,255,255,.85);border-radius:26px;background:rgba(255,255,255,.72)}' +
    '.kicker,p{color:#53647b}.kicker{font-size:14px}h1{font-size:26px;line-height:1.2;overflow-wrap:anywhere}h2{font-size:20px;margin-bottom:8px}p{margin:8px 0 20px;overflow-wrap:anywhere}' +
    'label{display:block;font-weight:600;margin:18px 0 6px}select,button{width:100%;font:inherit;border-radius:14px;min-height:48px;padding:12px;border:1px solid #c6d3e3}select{background:#fff;color:#0e1a2b}select:disabled{color:#53647b;opacity:1;background:#eef3f9}' +
    'button{background:#2f6bff;color:#fff;border:0;font-weight:600;margin-top:24px;cursor:pointer}button:disabled{opacity:.65;cursor:wait}button:focus-visible,select:focus-visible{outline:3px solid #1753df;outline-offset:3px}#setup-status{min-height:24px;margin-top:14px}' +
    '[hidden]{display:none!important}.case-section{border-top:1px solid rgba(83,100,123,.2);margin-top:24px;padding-top:20px}.case-note{white-space:pre-wrap;color:inherit;margin:8px 0 18px}h3{font-size:15px;margin:18px 0 6px}#case-stage{display:inline-block;border-radius:999px;background:rgba(47,107,255,.1);color:inherit;padding:5px 12px;margin:0 0 16px;font-size:14px}' +
    '.case-controls{display:flex;gap:10px;flex-wrap:wrap}.case-controls button,.case-controls a,.rework-actions .pbtn{width:auto;flex:1 1 180px;text-align:center;text-decoration:none;padding:12px 14px;min-height:48px;border-radius:14px;margin:0;border:1px solid rgba(83,100,123,.2);font:inherit;font-weight:600;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}.case-controls a,.case-controls button.secondary,.rework-actions .pbtn{background:rgba(83,100,123,.08);color:inherit}.case-controls button.danger{background:#b83b43;color:#fff}.case-controls button.primary,.rework-actions .rework-primary{background:#2f6bff;color:#fff}' +
    '#case-action-confirmation{border:1px solid rgba(83,100,123,.25);border-radius:16px;padding:16px;margin-top:16px}#case-action-status{min-height:24px;margin-top:12px;white-space:pre-wrap}#case-action-refresh{margin-top:12px}.rework-actions{display:flex;flex-wrap:wrap;gap:10px}#rework-panel textarea{width:100%;min-height:110px;resize:vertical;margin:8px 0 12px;padding:12px;border-radius:12px;border:1px solid #a8b9cd;font:inherit;color:inherit;background:rgba(255,255,255,.3)}#rework-panel label{margin-top:12px}#rework-panel p{white-space:pre-wrap;overflow-wrap:anywhere}#rework-panel [role=alert]{color:#b62e39}#rework-panel .rework-history{border-top:1px solid rgba(83,100,123,.2);margin-top:16px;padding-top:16px}#rework-panel details{margin-top:16px}#rework-panel summary{cursor:pointer}' +
    '@media(prefers-color-scheme:dark){body{color:#eef2f8;background:linear-gradient(140deg,#0d2248,#103c39 55%,#251c46)}main{background:rgba(20,30,49,.88);border-color:#40516d}.kicker,p{color:#b5c2d5}select{background:#17243a;color:#eef2f8;border-color:#53647b}select:disabled{background:#202d43;color:#b5c2d5}}' +
    '</style></head><body><main><div class="kicker">Клиент №' + esc(client.id) + '</div><h1>' + esc(client.org || 'Клиент') + '</h1>' +
    (client.address ? '<p>' + esc(client.address) + '</p>' : '') + '<div id="case-stage">' + esc(stage) + '</div>' + management + '<section class="case-section" id="case-checklist-configuration">' + (archived
      ? '<section id="checklist-setup-archived"><h2>Клиент в архиве</h2><p>Документы, заметки и история сохранены. Чтобы продолжить работу и выбрать чек-лист, верните клиента в работу.</p></section>'
      : unsupported
      ? '<section id="checklist-setup-unsupported"><h2>Для этого клиента пока нет чек-листа</h2><p>' + [client.region, client.kind, client.service].map(value => esc(names[value] || value)).join(' · ') + '</p><p>Для такого сочетания региона, типа объекта и услуги подходящий чек-лист ещё не подготовлен. Свяжитесь с менеджером для уточнения порядка работы. Сохранённые сведения клиента доступны в его карточке.</p></section>'
      : '<h2>Настройка чек-листа</h2><p>Для выбора чек-листа укажите недостающие сведения. Основные действия с клиентом доступны выше.</p>' +
        '<form id="checklist-setup" data-case-id="' + esc(client.id) + '">' + fields + '<button type="submit" id="setup-submit">Открыть чек-лист</button><div id="setup-status" role="status" aria-live="polite"></div></form>') + '</section>' +
    (notes ? '<section class="case-section" id="case-comments"><h2>Комментарии и заметки</h2>' + notes + '</section>' : '') +
    '</main><script>(' + setupClient.toString() + ')();(' + clientActions.toString() + ')(' + JSON.stringify(String(actorId || '')) + ');(' + require('./case-rework-ui').toString() + ')(' + JSON.stringify(Number(client.id)) + ',' + JSON.stringify(String(actorId || '')) + ');</script></body></html>';
}

module.exports = { createChecklistSetupService, setupPage };
