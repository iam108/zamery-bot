'use strict';

const { checklistExists, exactChecklist, CHECKLIST_PROFILE } = require('../checklists');
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
      if (client.data?._stage === 'Архив') fail(409, 'CHECKLIST_CASE_ARCHIVED', 'Клиент находится в архиве. Для выбора чек-листа сначала верните его в работу.');
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

function setupPage(client) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const labels = { region: 'Регион', kind: 'Тип объекта', service: 'Услуга' };
  const names = { 'МСК': 'Москва', 'МО': 'Московская область', 'СПб': 'Санкт-Петербург' };
  const unsupported = Object.entries(CHECKLIST_PROFILE).every(([field, values]) => values.includes(client[field])) && !exactChecklist(client);
  const fields = Object.entries(CHECKLIST_PROFILE).map(([field, values]) => {
    const known = values.includes(client[field]);
    return '<label for="setup-' + field + '">' + labels[field] + '</label><select id="setup-' + field + '" required' + (known ? ' disabled' : '') + '>' +
      '<option value="" disabled' + (!known ? ' selected' : '') + '>Выберите…</option>' + values.map(value => '<option value="' + esc(value) + '"' + (client[field] === value ? ' selected' : '') + '>' + esc(names[value] || value) + '</option>').join('') + '</select>';
  }).join('');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Выбрать чек-лист</title><script async src="https://telegram.org/js/telegram-web-app.js"></script><script>' + require('./auth').clientScript() + '</script><style>' +
    '*{box-sizing:border-box}body{margin:0;padding:28px 16px max(28px,env(safe-area-inset-bottom));font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0e1a2b;background:linear-gradient(140deg,#d7eaff,#d9f2e9 55%,#e8e1ff);min-height:100vh}' +
    'main{max-width:560px;margin:0 auto;padding:24px;border:1px solid rgba(255,255,255,.85);border-radius:26px;background:rgba(255,255,255,.72)}' +
    '.kicker,p{color:#53647b}.kicker{font-size:14px}h1{font-size:26px;line-height:1.2;overflow-wrap:anywhere}h2{font-size:20px;margin-bottom:8px}p{margin:8px 0 20px;overflow-wrap:anywhere}' +
    'label{display:block;font-weight:600;margin:18px 0 6px}select,button{width:100%;font:inherit;border-radius:14px;min-height:48px;padding:12px;border:1px solid #c6d3e3}select{background:#fff;color:#0e1a2b}select:disabled{color:#53647b;opacity:1;background:#eef3f9}' +
    'button{background:#2f6bff;color:#fff;border:0;font-weight:600;margin-top:24px;cursor:pointer}button:disabled{opacity:.65;cursor:wait}button:focus-visible,select:focus-visible{outline:3px solid #1753df;outline-offset:3px}#setup-status{min-height:24px;margin-top:14px}' +
    '@media(prefers-color-scheme:dark){body{color:#eef2f8;background:linear-gradient(140deg,#0d2248,#103c39 55%,#251c46)}main{background:rgba(20,30,49,.88);border-color:#40516d}.kicker,p{color:#b5c2d5}select{background:#17243a;color:#eef2f8;border-color:#53647b}select:disabled{background:#202d43;color:#b5c2d5}}' +
    '</style></head><body><main><div class="kicker">Клиент №' + esc(client.id) + '</div><h1>' + esc(client.org || 'Клиент') + '</h1>' +
    (client.address ? '<p>' + esc(client.address) + '</p>' : '') + (unsupported
      ? '<section id="checklist-setup-unsupported"><h2>Для этого клиента пока нет чек-листа</h2><p>' + [client.region, client.kind, client.service].map(value => esc(names[value] || value)).join(' · ') + '</p><p>Для такого сочетания региона, типа объекта и услуги подходящий чек-лист ещё не подготовлен. Свяжитесь с менеджером для уточнения порядка работы. Сохранённые сведения клиента доступны в его карточке.</p></section>'
      : '<h2>Выберите чек-лист</h2><p>В карточке не хватает сведений для выбора чек-листа. Укажите их один раз, чтобы открыть нужные проверки. Сохранённые ответы и заметки останутся.</p>' +
        '<form id="checklist-setup" data-case-id="' + esc(client.id) + '">' + fields + '<button type="submit" id="setup-submit">Открыть чек-лист</button><div id="setup-status" role="status" aria-live="polite"></div></form>') + '</main><script>(' + setupClient.toString() + ')();</script></body></html>';
}

module.exports = { createChecklistSetupService, setupPage };
