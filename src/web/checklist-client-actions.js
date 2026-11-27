'use strict';

const { STAGES } = require('../checklists');
const { canAccessCase, canManageCases } = require('./auth');

const ACTIONS = new Set(['archive_client', 'restore_client']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
function positive(value, max = Number.MAX_SAFE_INTEGER) {
  return (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) &&
    Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= max ? Number(value) : null;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function createChecklistClientActions({ pool }) {
  return { async change(caseId, actorId, body) {
    const id = positive(caseId, 2147483647), actor = positive(actorId);
    if (!id) fail(400, 'CLIENT_ACTION_CASE_INVALID', 'Проверьте номер клиента.');
    if (!actor) fail(403, 'CASE_FORBIDDEN', 'Этот клиент недоступен вашему аккаунту.');
    if (!object(body) || !ACTIONS.has(body.action))
      fail(400, 'CLIENT_ACTION_INVALID', 'Выберите действие с клиентом.');
    if (typeof body.request_id !== 'string' || !UUID.test(body.request_id))
      fail(400, 'CLIENT_ACTION_REQUEST_REQUIRED', 'Откройте карточку заново и повторите действие.');
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision > 2147483646)
      fail(400, 'CLIENT_ACTION_REVISION_REQUIRED', 'Откройте актуальную карточку клиента перед изменением.');
    const requestId = body.request_id.toLowerCase();
    const connection = await pool.connect();
    let transaction = false;
    try {
      await connection.query('BEGIN'); transaction = true;
      const client = (await connection.query('SELECT * FROM cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
      const staff = (await connection.query('SELECT * FROM staff WHERE tg_id=$1 FOR SHARE', [actor])).rows[0];
      if (!client) fail(404, 'CLIENT_ACTION_CASE_NOT_FOUND', 'Клиент не найден.');
      // The current assignment and approval gate exact replays as well as writes.
      if (!canAccessCase(staff, actor, client))
        fail(403, 'CASE_FORBIDDEN', 'Этот клиент недоступен вашему аккаунту.');
      if (client.data != null && !object(client.data))
        fail(409, 'CASE_DATA_INVALID', 'Сведения клиента требуют проверки менеджером. Данные не изменены.');
      const data = client.data || {}, revision = Number(client.checklist_revision);
      if (!Number.isSafeInteger(revision) || revision < 0 || revision > 2147483646)
        fail(409, 'CLIENT_ACTION_CONFLICT', 'Версия карточки изменилась. Откройте её заново.');
      const stage = typeof data._stage === 'string' ? data._stage : null;
      const previous = object(data._lastClientAction) ? data._lastClientAction : null;
      if (previous?.id === requestId) {
        if (previous.action !== body.action || String(previous.actor) !== String(actor))
          fail(409, 'CLIENT_ACTION_REQUEST_CHANGED', 'Эта отправка уже использована для другого действия. Откройте карточку заново.');
        if (previous.to_stage !== stage || previous.revision !== revision)
          fail(409, 'CLIENT_ACTION_CONFLICT', 'После этого действия карточка уже изменилась. Откройте её заново.');
        await connection.query('COMMIT'); transaction = false;
        return { case_id: id, stage, revision, replayed: true };
      }
      if (body.expectedRevision !== revision)
        fail(409, 'CLIENT_ACTION_CONFLICT', 'Карточка изменилась в другом окне. Откройте её заново перед продолжением.');
      const archiving = body.action === 'archive_client';
      if (archiving ? stage === 'Архив' : stage !== 'Архив')
        fail(409, 'CLIENT_ACTION_CONFLICT', archiving ? 'Клиент уже в архиве. Откройте карточку заново.' : 'Клиент уже в работе. Откройте карточку заново.');
      const restored = previous?.action === 'archive_client' && STAGES.includes(previous.from_stage) && previous.from_stage !== 'Архив'
        ? previous.from_stage : 'Сбор документов';
      const nextStage = archiving ? 'Архив' : restored;
      const receipt = { id: requestId, action: body.action, actor: String(actor), from_stage: stage, to_stage: nextStage, revision: revision + 1 };
      // Modify only navigation state and its durable receipt. Files, checklist
      // answers, notes, handoff checkpoints and decision dates remain untouched.
      const saved = (await connection.query(`UPDATE cases SET
        data=jsonb_set(jsonb_set(COALESCE(NULLIF(data,'null'::jsonb),'{}'::jsonb),'{_stage}',to_jsonb($2::text),true),'{_lastClientAction}',$3::jsonb,true),
        checklist_revision=checklist_revision+1
        WHERE id=$1 AND checklist_revision=$4
          AND EXISTS(SELECT 1 FROM staff current_actor WHERE current_actor.tg_id=$5 AND current_actor.approved IS TRUE
            AND (current_actor.role='manager' OR $6::boolean OR current_actor.role='lawyer' AND cases.lawyer_tg_id=current_actor.tg_id))
        RETURNING checklist_revision`, [id, nextStage, JSON.stringify(receipt), revision, actor,
          canManageCases({ approved: true, role: 'auditor' }, actor)])).rows[0];
      if (!saved) fail(403, 'CASE_FORBIDDEN', 'Доступ к клиенту изменился. Откройте карточку заново.');
      await connection.query('COMMIT'); transaction = false;
      return { case_id: id, stage: nextStage, revision: Number(saved.checklist_revision), replayed: false };
    } catch (error) {
      if (transaction) await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { connection.release(); }
  } };
}

module.exports = { createChecklistClientActions };
