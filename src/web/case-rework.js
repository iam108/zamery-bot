'use strict';

const { randomUUID } = require('node:crypto');
const { canManageCases } = require('./auth');

const DDL = `CREATE TABLE IF NOT EXISTS case_rework (
  id UUID PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  lawyer_id BIGINT NOT NULL,
  manager_id BIGINT NOT NULL,
  lawyer_name TEXT NOT NULL,
  manager_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  return_delivery TEXT NOT NULL DEFAULT 'pending',
  return_started_at TIMESTAMPTZ,
  return_attempt_id UUID,
  return_message_id BIGINT,
  resolution_id UUID UNIQUE,
  response TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_delivery TEXT NOT NULL DEFAULT 'pending',
  resolution_started_at TIMESTAMPTZ,
  resolution_attempt_id UUID,
  resolution_message_id BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS case_rework_open_assignment ON case_rework (case_id,lawyer_id,manager_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS case_rework_history ON case_rework (case_id,lawyer_id,manager_id,requested_at DESC,id DESC);`;

const MAX_NOTE = 1500;
const DELIVERY_DEADLINE = 12000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const CASE_FIELDS = `c.id,c.org,c.lawyer_tg_id,c.created_by,c.data->>'_stage' AS stage`;
const PARTICIPANTS = `l.approved AS lawyer_approved,l.role AS lawyer_role,l.name AS lawyer_name,
  m.approved AS manager_approved,m.role AS manager_role,m.name AS manager_name`;
const SLOTS = {
  return: { delivery: 'return_delivery', started: 'return_started_at', attempt: 'return_attempt_id', receipt: 'return_message_id' },
  resolution: { delivery: 'resolution_delivery', started: 'resolution_started_at', attempt: 'resolution_attempt_id', receipt: 'resolution_message_id' },
};

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function positive(value, maximum = Number.MAX_SAFE_INTEGER) {
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d*$/.test(String(value)) &&
    Number.isSafeInteger(Number(value)) && Number(value) <= maximum;
}

function caseNumber(value) {
  if (!positive(value, 2147483647)) fail(400, 'CASE_REWORK_INVALID', 'Некорректный номер клиента.');
  return Number(value);
}

function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'CASE_REWORK_INVALID', 'Некорректный номер отправки. Обновите форму.');
  return value.toLowerCase();
}

function note(value, message) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_NOTE || text.includes('\0')) fail(400, 'CASE_REWORK_INVALID', message);
  return text;
}

function denied() {
  fail(403, 'CASE_REWORK_FORBIDDEN', 'Доработка недоступна вашему аккаунту.');
}

function participant(row, actorId) {
  if (!row || !positive(actorId)) return null;
  const lawyerId = String(row.lawyer_tg_id || ''), managerId = String(row.created_by || '');
  const lawyer = positive(lawyerId) && row.lawyer_approved === true && row.lawyer_role === 'lawyer';
  const manager = positive(managerId) && canManageCases({ approved: row.manager_approved, role: row.manager_role }, managerId);
  const actor = String(actorId);
  const role = lawyer && actor === lawyerId ? 'lawyer' : manager && actor === managerId ? 'manager' : null;
  if (!role) return null;
  let unavailable = '';
  if (row.stage === 'Архив') unavailable = 'Клиент в архиве.';
  else if (!manager || managerId === lawyerId) unavailable = 'Менеджер, передавший клиента, недоступен.';
  else if (!lawyer) unavailable = 'Назначенный юрист недоступен.';
  return { role, lawyerId, managerId, unavailable };
}

function activeSend(row, slot, now) {
  return row[slot.delivery] === 'sending' && Number(new Date(row[slot.started])) + DELIVERY_DEADLINE + 2000 > now;
}

function deliveryStatus(row, slot, available, now) {
  const status = row[slot.delivery];
  if (status === 'sending' && !activeSend(row, slot, now)) return 'unknown';
  if (status === 'blocked' && available) return 'retryable';
  return status;
}

function view(row, actorId, now) {
  const access = participant(row, actorId);
  if (!access) return null;
  const open = row.requests.find(item => !item.resolved_at);
  const available = !access.unavailable;
  return {
    case_id: Number(row.id),
    role: access.role,
    can_return: available && access.role === 'lawyer' && !open,
    can_resolve: available && access.role === 'manager' && !!open && !activeSend(open, SLOTS.return, now),
    unavailable_reason: access.unavailable,
    requests: row.requests.map(item => ({
      id: item.id,
      reason: item.reason,
      requested_at: item.requested_at,
      lawyer_name: item.lawyer_name,
      manager_name: item.manager_name,
      status: item.resolved_at ? 'resolved' : 'open',
      return_delivery: deliveryStatus(item, SLOTS.return, available, now),
      response: item.response,
      resolved_at: item.resolved_at,
      resolution_id: item.resolution_id,
      resolution_delivery: item.resolved_at ? deliveryStatus(item, SLOTS.resolution, available, now) : null,
    })),
  };
}

function createCaseReworkService(options = {}) {
  const pool = options.pool || require('../db/pool');
  const now = options.now || Date.now;
  let ready;
  function ensure() {
    if (!ready) ready = Promise.resolve().then(async () => {
      if (options.ready) await options.ready();
      await pool.query(DDL);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }

  async function readContext(caseId, actorId, history = false) {
    const result = await pool.query(`SELECT ${CASE_FIELDS},${PARTICIPANTS}
      ${history ? ",COALESCE(h.requests,'[]'::jsonb) AS requests" : ''}
      FROM cases c LEFT JOIN staff l ON l.tg_id=c.lawyer_tg_id LEFT JOIN staff m ON m.tg_id=c.created_by
      ${history ? `LEFT JOIN LATERAL (
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at DESC,r.id DESC) AS requests FROM (
          SELECT * FROM case_rework WHERE case_id=c.id AND lawyer_id=c.lawyer_tg_id AND manager_id=c.created_by
          ORDER BY (resolved_at IS NULL) DESC,requested_at DESC,id DESC LIMIT 30
        ) r
      ) h ON true` : ''}
      WHERE c.id=$1 AND $2::bigint IN (c.lawyer_tg_id,c.created_by)`, [caseId, actorId]);
    return result.rows[0];
  }

  async function get(caseId, actorId) {
    caseId = caseNumber(caseId);
    if (!positive(actorId)) return null;
    await ensure();
    return view(await readContext(caseId, actorId, true), actorId, now());
  }

  async function transaction(run) {
    const client = await pool.connect();
    let rollbackError;
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (failure) { rollbackError = failure; }
      throw error;
    } finally {
      client.release(rollbackError);
    }
  }

  async function lockedContext(client, caseId) {
    const row = (await client.query(`SELECT ${CASE_FIELDS} FROM cases c WHERE c.id=$1 FOR UPDATE`, [caseId])).rows[0];
    if (!row) denied();
    const staff = (await client.query(`SELECT tg_id,name,role,approved FROM staff
      WHERE tg_id=ANY($1::bigint[]) ORDER BY tg_id FOR SHARE`, [[row.lawyer_tg_id, row.created_by].filter(value => value != null)])).rows;
    const lawyer = staff.find(item => String(item.tg_id) === String(row.lawyer_tg_id));
    const manager = staff.find(item => String(item.tg_id) === String(row.created_by));
    return { ...row, lawyer_name: lawyer?.name, lawyer_role: lawyer?.role, lawyer_approved: lawyer?.approved,
      manager_name: manager?.name, manager_role: manager?.role, manager_approved: manager?.approved };
  }

  function matching(item, row, access) {
    return item && Number(item.case_id) === Number(row.id) && String(item.lawyer_id) === access.lawyerId && String(item.manager_id) === access.managerId;
  }

  async function returnRequest(client, row, access, id, reason) {
    const previous = (await client.query('SELECT * FROM case_rework WHERE id=$1 AND case_id=$2', [id, row.id])).rows[0];
    if (previous) {
      if (!matching(previous, row, access) || previous.reason !== reason) fail(409, 'CASE_REWORK_CHANGED', 'Эта отправка уже сохранена с другими данными. Обновите карточку.');
      return previous;
    }
    const created = (await client.query(`INSERT INTO case_rework(id,case_id,lawyer_id,manager_id,lawyer_name,manager_name,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,
    [id, row.id, access.lawyerId, access.managerId, row.lawyer_name, row.manager_name, reason])).rows[0];
    if (!created) fail(409, 'CASE_REWORK_EXISTS', 'По клиенту уже есть запрос на доработку или эта отправка уже использована. Обновите карточку.');
    return created;
  }

  async function resolveRequest(client, row, access, id, resolution, response) {
    const request = (await client.query('SELECT * FROM case_rework WHERE id=$1 AND case_id=$2', [id, row.id])).rows[0];
    if (!matching(request, row, access)) denied();
    if (request.resolved_at) {
      if (request.resolution_id !== resolution || request.response !== response) fail(409, 'CASE_REWORK_CHANGED', 'Запрос уже закрыт с другим ответом. Обновите карточку.');
      return request;
    }
    if (activeSend(request, SLOTS.return, now())) fail(409, 'CASE_REWORK_SENDING', 'Уведомление о возврате отправляется. Повторите через несколько секунд.');
    const saved = (await client.query(`UPDATE case_rework SET resolution_id=$2,response=$3,resolved_at=NOW()
      WHERE id=$1 AND resolved_at IS NULL RETURNING *`, [id, resolution, response])).rows[0];
    if (!saved) fail(409, 'CASE_REWORK_CHANGED', 'Запрос уже изменился. Обновите карточку.');
    return saved;
  }

  async function claim(client, request, phase) {
    const slot = SLOTS[phase];
    if (phase === 'return' && request.resolved_at) return null;
    if (!['pending', 'retryable', 'blocked'].includes(request[slot.delivery])) return null;
    return (await client.query(`UPDATE case_rework SET ${slot.delivery}='sending',${slot.started}=$2,${slot.attempt}=$4
      WHERE id=$1 AND ${slot.delivery}=$3 RETURNING *`,
    [request.id, new Date(now()).toISOString(), request[slot.delivery], randomUUID()])).rows[0];
  }

  async function record(request, phase, status, messageId = null) {
    const slot = SLOTS[phase];
    // Repeat the receipt write, never the Telegram call, if PostgreSQL briefly fails.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await pool.query(`UPDATE case_rework SET ${slot.delivery}=$2,${slot.receipt}=$3
          WHERE id=$1 AND ${slot.delivery}='sending' AND ${slot.attempt}=$4`, [request.id, status, messageId, request[slot.attempt]]);
        return;
      } catch (error) {
        if (attempt === 2) console.error('case rework receipt:', error.code || error.name);
      }
    }
  }

  function messageOptions(caseId, phase) {
    const label = phase === 'return' ? 'Открыть доработку' : 'Открыть клиента';
    let button;
    try {
      const url = new URL('/checklist', options.webappUrl || process.env.WEBAPP_URL);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid WebApp origin');
      url.search = new URLSearchParams({ case_id: String(caseId), rework: '1' }).toString();
      button = { text: label, web_app: { url: url.href } };
    } catch (_) {
      button = { text: label, url: 'https://t.me/LRSZamer_bot?start=case_' + caseId };
    }
    return { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[button]] } };
  }

  async function deliver(request, caseId, actorId, phase) {
    let current;
    try { current = await readContext(caseId, actorId); }
    catch (_) { await record(request, phase, 'retryable'); return; }
    const access = participant(current, actorId);
    if (!access || access.unavailable || !matching(request, current, access) || access.role !== (phase === 'return' ? 'lawyer' : 'manager')) {
      await record(request, phase, 'blocked');
      return;
    }
    const isReturn = phase === 'return';
    const target = isReturn ? access.managerId : access.lawyerId;
    const heading = isReturn ? 'Клиент возвращён на доработку' : 'Доработка завершена';
    const from = isReturn ? 'Юрист ' + request.lawyer_name : 'Менеджер ' + request.manager_name;
    const message = [heading, String(current.org || '').trim().slice(0, 250), 'Клиент №' + caseId + ' · ' + from.slice(0, 150),
      '', isReturn ? 'Что доработать' : 'Что сделано', isReturn ? request.reason : request.response].join('\n');
    let timer, result;
    try {
      const telegram = options.telegram || require('../bot/instance').telegram;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Telegram delivery deadline')), DELIVERY_DEADLINE); });
      result = await Promise.race([telegram.sendMessage(target, message, messageOptions(caseId, phase)), deadline]);
      if (!positive(result?.message_id) || result.chat != null && String(result.chat.id) !== target) throw new Error('Invalid Telegram delivery receipt');
    } catch (error) {
      const code = Number(error?.response?.error_code);
      await record(request, phase, code >= 400 && code < 500 ? 'retryable' : 'unknown');
      return;
    } finally {
      clearTimeout(timer);
    }
    await record(request, phase, 'confirmed', Number(result.message_id));
  }

  async function mutate(body, actorId, phase) {
    const caseId = caseNumber(body.case_id);
    if (!positive(actorId)) denied();
    const isReturn = phase === 'return';
    const id = requestId(isReturn ? body.request_id : body.rework_id);
    const resolution = isReturn ? null : requestId(body.request_id);
    const text = note(isReturn ? body.reason : body.response, isReturn
      ? 'Укажите, что нужно доработать. Не более 1500 символов.'
      : 'Укажите, что было сделано. Не более 1500 символов.');
    await ensure();
    const pending = await transaction(async client => {
      const row = await lockedContext(client, caseId);
      const access = participant(row, actorId);
      if (!access || access.role !== (isReturn ? 'lawyer' : 'manager')) denied();
      if (access.unavailable) fail(409, 'CASE_REWORK_UNAVAILABLE', access.unavailable);
      const request = isReturn ? await returnRequest(client, row, access, id, text)
        : await resolveRequest(client, row, access, id, resolution, text);
      return claim(client, request, phase);
    });
    if (pending) await deliver(pending, caseId, actorId, phase);
    const latest = await get(caseId, actorId);
    if (!latest) denied();
    return latest;
  }

  async function handle(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      const body = req.body || {}, actorId = req.tgUser?.id;
      let result;
      if (!positive(actorId)) denied();
      if (body.action === 'get_rework') result = await get(body.case_id, actorId);
      else if (body.action === 'return_for_rework') result = await mutate(body, actorId, 'return');
      else if (body.action === 'resolve_rework') result = await mutate(body, actorId, 'resolution');
      else fail(400, 'CASE_REWORK_INVALID', 'Неизвестное действие доработки.');
      return res.json({ ok: true, rework: result });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
      if (error.code === '23505') return res.status(409).json({ ok: false, code: 'CASE_REWORK_CHANGED', error: 'Эта отправка уже использована. Обновите карточку.' });
      console.error('case rework:', error.code || error.name);
      return res.status(503).json({ ok: false, code: 'CASE_REWORK_FAILED', error: 'Не удалось подтвердить результат. Обновите карточку или повторите ту же отправку.' });
    }
  }

  return { get, handle };
}

module.exports = { createCaseReworkService, DDL };
