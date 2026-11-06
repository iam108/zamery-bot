const { createHash } = require('node:crypto');
const { LISTS, STAGES } = require('../checklists');
const { isChecklistItemResolved } = require('../checklist-progress');

const PAIRING_LIFETIME = 10 * 60;
const MAX_NOTE_LENGTH = 16_000;
const WORKSPACE_ROLES = ['lawyer', 'manager'];
const SESSION_DDL = `
  CREATE TABLE IF NOT EXISTS workspace_sessions (
    token_digest TEXT PRIMARY KEY,
    staff_id BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  );
`;

function canonicalToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

function parsePairing(payload, now = Math.floor(Date.now() / 1000)) {
  const match = typeof payload === 'string' && /^mac_([A-Za-z0-9_-]{43})_([0-9a-z]{1,8})$/.exec(payload);
  if (!match || !canonicalToken(match[1])) return null;
  const expiresAt = parseInt(match[2], 36);
  if (expiresAt.toString(36) !== match[2] || expiresAt <= now || expiresAt > now + PAIRING_LIFETIME) return null;
  return { digest: match[1], expiresAt };
}

function bearerDigest(header) {
  const match = typeof header === 'string' && /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header);
  if (!match || !canonicalToken(match[1])) return null;
  return createHash('sha256').update(match[1]).digest('base64url');
}

async function approvePairing(pool, staffId, payload) {
  const pairing = parsePairing(payload);
  if (!pairing) return false;
  const result = await pool.query(`
    INSERT INTO workspace_sessions (token_digest, staff_id, expires_at)
    SELECT $1, tg_id, NOW() + INTERVAL '30 days'
    FROM staff
    WHERE tg_id = $2 AND approved IS TRUE AND role IN ('lawyer', 'manager')
      AND to_timestamp($3) > NOW()
    ON CONFLICT (token_digest) DO NOTHING
    RETURNING staff_id
  `, [pairing.digest, staffId, pairing.expiresAt]);
  return result.rowCount === 1;
}

function canPair(staff) {
  return staff && staff.approved === true && WORKSPACE_ROLES.includes(staff.role);
}

function checklistText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, 500);
}

function checklistDocuments(item, answer) {
  const marks = answer?.m || {};
  const missing = item.o.filter(name => marks[name] === 'bad');
  const present = item.o.filter(name => marks[name] === 'ok');
  const pending = item.o.filter(name => !['ok', 'bad'].includes(marks[name]));
  const other = checklistText(answer?.other);
  if (!missing.length && !present.length && !other) return { state: 'pending', value: '' };
  const lines = [];
  if (missing.length) lines.push('Нет: ' + missing.join(', '));
  if (other) lines.push('Дополнительно не хватает: ' + other);
  if (present.length) lines.push('Есть: ' + present.join(', '));
  if (pending.length) lines.push('Не проверено: ' + pending.join(', '));
  const state = missing.length || other ? 'attention' : pending.length ? 'pending' : 'complete';
  return { state, value: lines.join('\n') };
}

function checklistAnswer(item, answer) {
  const pending = { state: 'pending', value: '' };
  if (item.t === 'docs') return checklistDocuments(item, answer);
  if (item.t === 'k' || item.t === 'flag') {
    const problem = item.t === 'k' ? 'bad' : 'yes';
    const options = item.t === 'k' ? { ok: 'Ок', bad: 'Проблема', na: 'Н/П' } : { no: 'Нет', yes: 'Есть' };
    if (typeof answer?.s !== 'string' || !Object.hasOwn(options, answer.s)) return pending;
    const attention = answer.s === problem;
    const detail = attention && checklistText(answer.c);
    const value = detail ? options[answer.s] + ' · ' + detail : options[answer.s];
    return { state: attention ? 'attention' : 'complete', value };
  }
  if ((item.t === 'p' || item.t === 'r') && item.o.includes(answer)) return { state: 'complete', value: answer };
  if (item.t === 'f' || item.t === 'd') {
    const value = checklistText(answer);
    if (value) return { state: 'complete', value };
  }
  return pending;
}

function checklistSections(caseRow) {
  if (!Object.hasOwn(LISTS, caseRow.checklist_key)) return [];
  const list = LISTS[caseRow.checklist_key];
  const data = caseRow.checklist_choices || {};
  const visible = item => !item.when || Object.entries(item.when).every(([key, value]) => {
    if (key === 'svc') return caseRow.service === value;
    return (data[key] === undefined && !item.strict) || data[key] === value;
  });
  const groups = [{ id: 'passport', title: 'Паспорт объекта', items: list.passport }];
  for (const section of list.sections) groups.push({ id: section.t, title: section.t, items: section.i });
  return groups.map(group => ({
    id: group.id,
    title: group.title,
    items: group.items.filter(visible).map(item => ({ id: item.id, title: item.l, ...checklistAnswer(item, data[item.id]) })),
  })).filter(group => group.items.length);
}

function makeSnapshot(account, cases, now) {
  const clients = [];
  const tasks = [];
  for (const row of cases) {
    const id = String(row.id);
    const stage = row.stage || STAGES[0];
    const sections = checklistSections(row);
    const checklistItems = sections.flatMap(section => section.items);
    const list = Object.hasOwn(LISTS,row.checklist_key) ? LISTS[row.checklist_key] : null;
    const definitions = new Map((list ? list.passport.concat(list.sections.flatMap(section => section.i)) : []).map(item => [item.id,item]));
    clients.push({
      id,
      name: row.org || 'Клиент #' + id,
      address: row.address || '',
      kind: [row.service, row.kind].filter(Boolean).join(' · '),
      stage,
      report: row.audit_text || '',
      checklist: checklistItems.map(item => item.title),
      checklistSections: sections,
      note: row.note || '',
      done: checklistItems.filter(item => isChecklistItemResolved(definitions.get(item.id), row.checklist_choices?.[item.id])).length,
      total: checklistItems.length,
    });
    for (const reminder of row.reminders || []) {
      tasks.push({
        id: String(reminder.id), clientID: id, title: reminder.title, dueDate: reminder.dueDate,
        completed: reminder.completed === true, editable: account.role === 'lawyer',
      });
    }
    if (row.decision_due && ['Подано', 'Выездная проверка'].includes(stage)) {
      tasks.push({
        id: 'decision-' + id, clientID: id, title: 'Проверить решение', dueDate: row.decision_due,
        completed: false, editable: false,
      });
    }
  }
  tasks.sort((first, second) => first.dueDate.localeCompare(second.dueDate) || first.id.localeCompare(second.id));
  return {
    version: 1,
    account: { id: String(account.id), name: account.name, role: account.role },
    today: new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10),
    clients,
    tasks,
  };
}

const SELECT_ACCOUNT = `
  SELECT s.tg_id::text AS id, s.name, s.role
  FROM workspace_sessions session
  JOIN staff s ON s.tg_id = session.staff_id
  WHERE session.token_digest = $1 AND session.expires_at > NOW() AND session.revoked_at IS NULL
    AND s.approved IS TRUE AND s.role IN ('lawyer', 'manager')
`;

const SELECT_CASES = `
  SELECT c.id, c.org, c.address, c.kind, c.service, c.checklist_key, c.audit_text, c.done, c.total,
    c.data ->> '_stage' AS stage, c.data ->> '_comment' AS note,
    c.data - '_handoff' AS checklist_choices,
    to_char(c.decision_due, 'YYYY-MM-DD') AS decision_due, reminders.items AS reminders
  FROM cases c
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
      'id', r.id, 'title', r.text, 'dueDate', to_char(r.remind_on, 'YYYY-MM-DD'),
      'completed', COALESCE(r.done, false)
    ) ORDER BY r.remind_on, r.id) AS items
    FROM case_reminders r WHERE r.case_id = c.id
  ) reminders ON true
  WHERE (($2 = 'lawyer' AND c.lawyer_tg_id = $1) OR ($2 = 'manager' AND c.created_by = $1))
    AND COALESCE(c.data ->> '_stage', '') <> 'Архив'
    AND EXISTS (SELECT 1 FROM workspace_sessions current_session JOIN staff current_staff ON current_staff.tg_id=current_session.staff_id
      WHERE current_session.token_digest=$3 AND current_session.staff_id=$1 AND current_session.expires_at>NOW()
        AND current_session.revoked_at IS NULL AND current_staff.approved IS TRUE AND current_staff.role=$2)
  ORDER BY c.created_at DESC NULLS LAST, c.id DESC
`;

const UPDATE_NOTE = `
  WITH target AS MATERIALIZED (
    SELECT id, COALESCE(data ->> '_comment', '') AS note
    FROM cases
    WHERE id = $1 AND lawyer_tg_id = $2 AND COALESCE(data ->> '_stage', '') <> 'Архив'
      AND EXISTS (SELECT 1 FROM workspace_sessions current_session JOIN staff current_staff ON current_staff.tg_id=current_session.staff_id
        WHERE current_session.token_digest=$5 AND current_session.staff_id=$2 AND current_session.expires_at>NOW()
          AND current_session.revoked_at IS NULL AND current_staff.approved IS TRUE AND current_staff.role='lawyer')
    FOR UPDATE
  ), saved AS (
    UPDATE cases c
    SET data = (CASE WHEN jsonb_typeof(c.data) = 'object' THEN c.data ELSE '{}'::jsonb END)
      || jsonb_build_object('_comment', $3::text, '_workspaceNote', true)
    FROM target
    WHERE c.id = target.id AND target.note = $4 AND target.note <> $3
    RETURNING c.id
  )
  SELECT target.note = $3 OR EXISTS (SELECT 1 FROM saved) AS ok
  FROM target
`;

function positiveId(value) {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
}

function setupWorkspace(app, options = {}) {
  const pool = options.pool || require('../db/pool');
  const getBot = options.getBot || (() => require('../bot/instance').telegram.getMe());
  const now = options.now || Date.now;
  let botUsername;
  const namespace = '/api/workspace';

  function sendError(res, status, code, error) {
    return res.status(status).json({ ok: false, code, error });
  }
  function handle(handler) {
    return async (req, res) => {
      try {
        return await handler(req, res);
      } catch (error) {
        console.error('workspace request:', error.code || error.name || 'error');
        return sendError(res, 503, 'unavailable', 'Связь с ботом временно недоступна.');
      }
    };
  }
  function authenticated(handler) {
    return handle(async (req, res) => {
      const digest = bearerDigest(req.get('Authorization'));
      if (!digest) return sendError(res, 401, 'unauthorized', 'Подтвердите подключение в боте.');
      const { rows: [account] } = await pool.query(SELECT_ACCOUNT, [digest]);
      if (!account) return sendError(res, 401, 'unauthorized', 'Подтвердите подключение в боте.');
      return handler(req, res, account, digest);
    });
  }
  function readOnly(res) {
    return sendError(res, 403, 'read_only', 'Изменить клиента может его юрист.');
  }
  function notFound(res) {
    return sendError(res, 404, 'not_found', 'Запись недоступна.');
  }
  async function currentAccount(res, account, digest) {
    const {rows:[fresh]}=await pool.query(SELECT_ACCOUNT,[digest]);
    if (!fresh || fresh.id!==account.id || fresh.role!==account.role) {
      sendError(res,401,'unauthorized','Доступ изменился. Обновите подключение в боте.');return false;
    }
    return true;
  }

  app.use(namespace, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get(namespace + '/config', handle(async (req, res) => {
    if (!botUsername) {
      botUsername = Promise.resolve().then(getBot).then(me => {
        if (!me || !/^[A-Za-z0-9_]{5,32}$/.test(me.username || '')) throw new Error('Missing bot username');
        return me.username;
      }).catch(error => {
        botUsername = undefined;
        throw error;
      });
    }
    return res.json({ version: 1, botUsername: await botUsername });
  }));
  app.get(namespace + '/snapshot', authenticated(async (req, res, account, digest) => {
    const { rows } = await pool.query(SELECT_CASES, [account.id, account.role,digest]);
    if(!rows.length&&!await currentAccount(res,account,digest))return;
    return res.json(makeSnapshot(account, rows, now()));
  }));
  app.patch(namespace + '/reminders/:id', authenticated(async (req, res, account,digest) => {
    if (account.role !== 'lawyer') return readOnly(res);
    const { id } = req.params;
    if (!positiveId(id) || typeof req.body?.completed !== 'boolean') {
      return sendError(res, 400, 'invalid_reminder', 'Некорректная отметка напоминания.');
    }
    const result = await pool.query(`
      UPDATE case_reminders r SET done = $3
      FROM cases c
      WHERE r.id = $1 AND r.case_id = c.id AND c.lawyer_tg_id = $2
        AND COALESCE(c.data ->> '_stage', '') <> 'Архив'
        AND EXISTS (SELECT 1 FROM workspace_sessions current_session JOIN staff current_staff ON current_staff.tg_id=current_session.staff_id
          WHERE current_session.token_digest=$4 AND current_session.staff_id=$2 AND current_session.expires_at>NOW()
            AND current_session.revoked_at IS NULL AND current_staff.approved IS TRUE AND current_staff.role='lawyer')
      RETURNING r.id
    `, [id, account.id, req.body.completed,digest]);
    if(!result.rowCount&&!await currentAccount(res,account,digest))return;
    return result.rowCount ? res.json({ ok: true }) : notFound(res);
  }));
  app.patch(namespace + '/cases/:id/note', authenticated(async (req, res, account,digest) => {
    if (account.role !== 'lawyer') return readOnly(res);
    const { id } = req.params;
    const { note, expectedNote } = req.body || {};
    if (!positiveId(id) || typeof note !== 'string' || typeof expectedNote !== 'string' ||
        note.length > MAX_NOTE_LENGTH || note.includes('\u0000') || expectedNote.includes('\u0000')) {
      return sendError(res, 400, 'invalid_note', 'Некорректная заметка. Допустимо до 16 000 символов.');
    }
    const { rows: [result] } = await pool.query(UPDATE_NOTE, [id, account.id, note, expectedNote,digest]);
    if (!result) {if(!await currentAccount(res,account,digest))return;return notFound(res);}
    return result.ok ? res.json({ ok: true }) :
      sendError(res, 409, 'note_conflict', 'Заметка изменилась в боте. Обновите данные перед сохранением.');
  }));
  app.post(namespace + '/logout', handle(async (req, res) => {
    const digest = bearerDigest(req.get('Authorization'));
    if (!digest) return sendError(res, 401, 'unauthorized', 'Подключение отсутствует.');
    await pool.query('UPDATE workspace_sessions SET revoked_at = NOW() WHERE token_digest = $1 AND revoked_at IS NULL', [digest]);
    return res.json({ ok: true });
  }));
}

module.exports = { SESSION_DDL, setupWorkspace, parsePairing, approvePairing, canPair };
