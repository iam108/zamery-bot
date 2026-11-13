'use strict';

const { createHash } = require('node:crypto');
const { getSessionLockPool } = require('../db/session-lock-pool');
const auth = require('./auth');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const positive = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const clean = (value, limit = 500) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit);
const validGroup = value => /^-[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
// A losing admin command records its cursor while another sender holds lock111.
// Every checkpoint save merges these high-water marks, including saves by that
// still-running sender, so a busy old command cannot later clear a new unknown.
const SAVE_CHECKPOINT_SQL = `UPDATE cases SET data=jsonb_set(COALESCE(data,'{}'::jsonb),'{_handoff}',
  CASE WHEN jsonb_typeof($1::jsonb->'groupNotice')='object' OR jsonb_typeof(data#>'{_handoff,groupNotice,cursors}')='object' THEN
    jsonb_set($1::jsonb,'{groupNotice}',(CASE WHEN jsonb_typeof($1::jsonb->'groupNotice')='object' THEN $1::jsonb->'groupNotice' ELSE '{}'::jsonb END)||jsonb_build_object('cursors',(
      SELECT COALESCE(jsonb_object_agg(key,cursor),'{}'::jsonb) FROM (
        SELECT key,MAX(CASE WHEN value ~ '^[1-9][0-9]{0,15}$' THEN value::bigint ELSE 0 END) AS cursor
        FROM (SELECT * FROM jsonb_each_text(CASE WHEN jsonb_typeof(data#>'{_handoff,groupNotice,cursors}')='object' THEN data#>'{_handoff,groupNotice,cursors}' ELSE '{}'::jsonb END)
          UNION ALL SELECT * FROM jsonb_each_text(CASE WHEN jsonb_typeof($1::jsonb#>'{groupNotice,cursors}')='object' THEN $1::jsonb#>'{groupNotice,cursors}' ELSE '{}'::jsonb END)) cursors
        WHERE key ~ '^[1-9][0-9]{0,15}$' GROUP BY key
      ) merged WHERE cursor>0)),true)
  ELSE $1::jsonb END,true) WHERE id=$2`;
const STATE_SQL = `SELECT c.id,c.order_id,c.created_by,c.handoff_submit_id,c.lawyer_tg_id,c.lawyer_name,c.org,c.address,c.kind,c.service,c.priority,c.data,to_jsonb(c)->>'request_id' AS request_id,
  o.object_name,o.telegram_msg_id AS order_message_id,
  actor.tg_id AS actor_id,actor.role AS actor_role,actor.approved AS actor_approved,
  recipient.role AS recipient_role,recipient.approved AS recipient_approved,
  (SELECT COUNT(*)::int FROM cases active WHERE active.lawyer_tg_id=c.lawyer_tg_id AND COALESCE(active.data->>'_stage','')<>'Архив') AS active_cases
FROM cases c JOIN staff actor ON actor.tg_id=$2 AND actor.approved=true
LEFT JOIN staff recipient ON recipient.tg_id=c.lawyer_tg_id LEFT JOIN orders o ON o.id=c.order_id WHERE c.id=$1`;

function initialNotice(target) {
  const chat = String(target ?? '').trim();
  return chat ? { version: 1, required: true, target: chat, generation: 0, status: 'pending', cursors: {} } : null;
}
function pendingNotice(state) {
  const notice = object(state.groupNotice);
  return notice.required === true && !(notice.status === 'confirmed' && positive(notice.receipt?.message_id));
}
function noticeWarning(state, caseId) {
  const notice = object(state.groupNotice);
  if (!pendingNotice(state)) return '';
  const prefix = state.body?.manual_client === true ? 'Карточка клиента доставлена в личный чат юриста. ' : 'Отчёт и собранные материалы доставлены в личный чат юриста. ';
  if (notice.status === 'unknown' || notice.intent) return prefix + 'Публикация краткой карточки в чате клиентов не подтверждена. Проверьте чат перед повтором: возможен дубликат. Проверка: /handoff_notice ' + caseId + '.';
  return prefix + (notice.warning || 'Краткая карточка в чате клиентов ещё не опубликована.') + ' Проверка: /handoff_notice ' + caseId + '.';
}
function summary(row, state) {
  const ids = (row.order_id ? 'Заявка #' + row.order_id + ' · ' : row.request_id ? 'Исходная заявка #' + row.request_id + ' · ' : '') + 'Клиент #' + row.id;
  const lines = ['Клиент передан юристу · ' + clean(row.lawyer_name, 200), '', 'Организация: ' + clean(row.org)];
  if (clean(row.object_name) && clean(row.object_name) !== clean(row.org)) lines.push('Объект: ' + clean(row.object_name));
  lines.push(clean(row.address), [clean(row.kind, 100), clean(row.service, 100), clean(row.priority, 100) && 'Приоритет: ' + clean(row.priority, 100)].filter(Boolean).join(' · '), ids, '',
    state.body?.manual_client === true ? (state.packet?.manual_materials?.length ? 'Карточка и документы отправлены в личку юриста.' : 'Карточка отправлена в личку юриста.') : 'Отчёт и собранные материалы — в личке юриста.');
  if (['waiting', 'ordered'].includes(state.egrn?.result)) lines.push('ЕГРН: ожидается.');
  if (['none', 'missing', 'unavailable'].includes(state.egrn?.result)) lines.push('ЕГРН: отсутствует в комплекте.');
  lines.push('Клиентов в работе у юриста: ' + Number(row.active_cases));
  return lines.join('\n');
}

function createHandoffNoticePublisher(options = {}) {
  const pool = options.pool || require('../db/pool');
  const target = () => String(options.clientsChatId ?? process.env.CLIENTS_CHAT_ID ?? '').trim();
  const now = options.now || Date.now;
  const unavailable = () => Object.assign(new Error('Состояние уведомления недоступно.'), { code: 'HANDOFF_NOTICE_UNAVAILABLE' });
  async function load(client, caseId, actorId) {
    const row = (await client.query(STATE_SQL, [caseId, actorId])).rows[0];
    const staff = row && { role: row.actor_role, approved: row.actor_approved };
    if (!row || !auth.canManageCases(staff, actorId)) throw unavailable();
    return row;
  }
  function checkpoint(row) { return object(object(row.data)._handoff); }
  function reason(row, state) {
    if (!validGroup(target())) return 'Чат клиентов не настроен; карточка туда не отправлена.';
    if (state.groupNotice?.target && state.groupNotice.target !== target()) return 'Настройка чата клиентов изменилась. Нужна проверка сохранённого назначения уведомления.';
    if (state.version !== 2 || state.completed !== true || state.manual_review || state.inflight || state.materials?.inflight || state.materials?.completed !== true || state.egrn?.completed !== true ||
      require('./handoff-submit').hasPendingLinkedEgrn(state, row.lawyer_tg_id)) return 'Личная доставка полного собранного комплекта ещё не подтверждена; карточка в общий чат не отправлена.';
    if ((row.order_id == null ? state.body?.order_id != null || Number(state.body?.request_id || 0) !== Number(row.request_id || 0) : !positive(row.order_id) || Number(state.body?.order_id) !== Number(row.order_id)) || Number(state.body?.lawyer_tg_id) !== Number(row.lawyer_tg_id) || typeof state.body?.submit_id !== 'string' || !row.handoff_submit_id || state.body.submit_id.toLowerCase() !== row.handoff_submit_id.toLowerCase()) return 'Сохранённая передача не совпадает с текущим клиентом и назначением. Нужна проверка карточки.';
    const lawyer = String(row.lawyer_tg_id);
    if (!positive(state.cards?.[lawyer]) || !Array.isArray(state.recipients) || !state.recipients.some(recipient => String(recipient.chat) === lawyer) ||
      !auth.canAccessCase({ role: row.recipient_role, approved: row.recipient_approved }, lawyer, row)) return 'Назначение или доступ юриста изменились. Проверьте получателя перед публикацией карточки.';
    if (object(row.data)._stage === 'Архив') return 'Клиент уже в архиве; новая карточка передачи не опубликована.';
    return '';
  }
  function view(row, state) {
    const notice = object(state.groupNotice), text = summary(row, state), generation = Number.isSafeInteger(notice.generation) && notice.generation >= 0 ? notice.generation : 0;
    const status = notice.status === 'confirmed' && positive(notice.receipt?.message_id) ? 'confirmed' : notice.intent || notice.status === 'unknown' ? 'unknown' : ['pending', 'rejected', 'blocked'].includes(notice.status) ? notice.status : 'missing';
    const warning = reason(row, state);
    const revision = createHash('sha256').update(JSON.stringify([row.id, row.order_id, String(row.lawyer_tg_id), row.created_by, row.handoff_submit_id, target(), text, generation, status, warning])).digest('hex');
    return { case_id: Number(row.id), generation, revision, target: target(), text, status, can_apply: !warning && status !== 'confirmed', requires_confirmation: status === 'unknown', warning: warning || (status === 'unknown' ? 'Сообщение могло дойти. Проверьте чат; повтор может создать дубликат.' : status === 'confirmed' ? 'Краткая карточка уже опубликована.' : 'Публикация затронет только краткую карточку в чате клиентов.') };
  }
  const saveState = (client, row, state) => client.query(SAVE_CHECKPOINT_SQL, [JSON.stringify(state), row.id]);
  async function consumeBusy(caseId, context) {
    await pool.query(`UPDATE cases SET data=jsonb_set(COALESCE(data,'{}'::jsonb),'{_handoff,groupNotice}',
      (CASE WHEN jsonb_typeof(data#>'{_handoff,groupNotice}')='object' THEN data#>'{_handoff,groupNotice}' ELSE '{}'::jsonb END)||jsonb_build_object('cursors',
        COALESCE(data#>'{_handoff,groupNotice,cursors}','{}'::jsonb)||jsonb_build_object($2::text,GREATEST(
          CASE WHEN data#>>ARRAY['_handoff','groupNotice','cursors',$2::text] ~ '^[1-9][0-9]{0,15}$' THEN (data#>>ARRAY['_handoff','groupNotice','cursors',$2::text])::bigint ELSE 0 END,$3::bigint))),true)
      WHERE id=$1 AND EXISTS(SELECT 1 FROM staff WHERE tg_id=$2::bigint AND approved=true AND (role='manager' OR $4::boolean))`,
    [caseId,String(context.actorId),context.messageId,auth.canManageCases({approved:true,role:'auditor'},context.actorId)]);
  }
  function knownIds(row, state, chat) {
    const ids = new Set();
    const add = value => { if (positive(value)) ids.add(Number(value)); };
    if (String(options.workingChatId ?? process.env.GROUP_CHAT_ID ?? '') === chat) add(row.order_message_id);
    for (const source of state.source?.sources || (state.source ? [state.source] : [])) if (String(source.chat_id) === chat) (source.message_ids || []).forEach(add);
    if (String(state.request?.chat_id) === chat) (state.request.message_ids || []).forEach(add);
    add(state.groupNotice?.receipt?.message_id);
    return ids;
  }
  async function publishLocked({ client, c: row, state, actorId, save = () => saveState(client, row, state) }) {
    const notice = state.groupNotice;
    if (!notice || notice.required !== true || !pendingNotice(state)) return;
    if (notice.intent || notice.status === 'unknown') { notice.status = 'unknown'; return; }
    let current;
    try { current = await load(client, row.id, actorId); }
    catch (_) { notice.status = 'blocked'; notice.warning = 'Не удалось подтвердить действующий доступ менеджера. Карточка в чат клиентов не отправлена.'; await save(); return; }
    const warning = reason(current, state);
    if (warning) { notice.status = 'blocked'; notice.warning = warning; await save(); return; }
    const reviewed = view(current, state), generation = reviewed.generation + 1;
    notice.generation = generation; notice.status = 'sending'; notice.warning = '';
    notice.intent = { generation, at: new Date(now()).toISOString(), lawyer_id: String(current.lawyer_tg_id) };
    notice.text = reviewed.text;
    try { await save(); }
    catch (_) { notice.status = 'blocked'; notice.intent = null; notice.warning = 'Не удалось сохранить начало публикации. Карточка в чат клиентов не отправлена.'; return; }
    let fresh;
    try { fresh = await load(client, row.id, actorId); }
    catch (_) { notice.intent = null; notice.status = 'blocked'; notice.warning = 'Не удалось подтвердить действующий доступ менеджера. Карточка не отправлена.'; await save(); return; }
    const changed = reason(fresh, checkpoint(fresh)) || (String(fresh.lawyer_tg_id) !== notice.intent.lawyer_id ? 'Назначение юриста изменилось.' : '');
    if (changed) { notice.intent = null; notice.status = 'blocked'; notice.warning = changed; await save(); return; }
    let receipt;
    try {
      // Recheck after the durable intent, immediately before the Telegram call.
      const telegram = options.telegram || require('../bot/instance').telegram;
      receipt = await telegram.sendMessage(notice.target, notice.text, { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: state.body?.manual_client === true ? 'Открыть клиента' : 'Открыть клиента и отчёт', url: 'https://t.me/LRSZamer_bot?start=case_' + row.id }]] } });
      if (!receipt || Array.isArray(receipt) || !positive(receipt.message_id) || receipt.chat != null && String(receipt.chat.id) !== notice.target || knownIds(current, state, notice.target).has(Number(receipt.message_id))) throw Object.assign(new Error('Invalid group notice acknowledgement'), { code: 'HANDOFF_NOTICE_ACK' });
    } catch (error) {
      const code = Number(error?.response?.error_code);
      if (code >= 400 && code < 500) { notice.intent = null; notice.status = 'rejected'; notice.warning = 'Telegram отклонил краткую карточку. Личная доставка сохранена; публикацию можно повторить после проверки чата.'; }
      else { notice.status = 'unknown'; notice.warning = 'Публикация краткой карточки не подтверждена. Проверьте чат перед повтором: возможен дубликат.'; }
      try { await save(); } catch (_) { /* The durable intent still prevents automatic resending. */ }
      return;
    }
    notice.receipt = { message_id: Number(receipt.message_id), chat_id: notice.target, at: new Date(now()).toISOString() };
    notice.status = 'confirmed'; notice.intent = null;
    try { await save(); }
    catch (_) {
      notice.status = 'unknown'; notice.intent = { generation, at: new Date(now()).toISOString(), lawyer_id: String(current.lawyer_tg_id) };
      notice.warning = 'Telegram ответил, но квитанция публикации не сохранилась. Проверьте чат перед повтором.';
      try { await save(); } catch (_) { /* The original send intent remains durable. */ }
    }
  }
  async function preview(caseId, { actorId } = {}) {
    if (!positive(caseId) || Number(caseId) > 2147483647 || !positive(actorId)) throw unavailable();
    const row = await load(pool, Number(caseId), actorId);
    return view(row, checkpoint(row));
  }
  async function apply(caseId, context = {}) {
    if (!positive(caseId) || Number(caseId) > 2147483647 || !positive(context.actorId) || !positive(context.messageId)) throw unavailable();
    const first = await load(pool, Number(caseId), context.actorId), owner = String(first.created_by), submit = first.handoff_submit_id;
    if (!positive(owner) || typeof submit !== 'string' || !submit) throw unavailable();
    const client = await getSessionLockPool(pool, options.lockPool).connect();
    let locked = false, releaseError;
    try {
      locked = !!(await client.query('SELECT pg_try_advisory_lock(111,hashtext($1)) AS locked', [owner + ':' + submit])).rows[0]?.locked;
      if (!locked) { await consumeBusy(Number(caseId),context); return { state: 'busy', warning: 'Передача или публикация уже выполняется. Дождитесь результата.' }; }
      const row = await load(client, Number(caseId), context.actorId), state = checkpoint(row);
      if (String(row.created_by) !== owner || row.handoff_submit_id !== submit) throw unavailable();
      const notice = object(state.groupNotice), cursor = positive(object(notice.cursors)[String(context.actorId)]) || 0;
      if (Number(context.messageId) <= cursor) return { state: 'replayed', warning: 'Это разрешение уже обработано. Для новой попытки заново проверьте /handoff_notice ' + caseId + '.' };
      const current = view(row, state);
      state.groupNotice = {...notice,cursors:{...object(notice.cursors),[String(context.actorId)]:Number(context.messageId)}};
      await saveState(client,row,state);
      if (current.status === 'confirmed') return { state: 'confirmed', warning: 'Краткая карточка уже опубликована.', message_id: notice.receipt.message_id };
      if (current.generation !== context.expectedGeneration || current.revision !== context.expectedRevision || current.target !== context.expectedTarget) return { state: 'stale', warning: 'Состояние изменилось. Выполните /handoff_notice ' + caseId + ' заново; ничего не отправлялось.' };
      if (!current.can_apply) return { state: 'blocked', warning: current.warning };
      if (current.requires_confirmation && context.confirmMissing !== true) return { state: 'unknown', warning: 'Сначала проверьте чат. Только если карточки нет, подтвердите confirm_missing; повтор может создать дубликат.' };
      state.groupNotice = { ...initialNotice(current.target), ...notice, required: true, target: current.target, status: 'pending', intent: null, receipt: null,
        cursors: { ...object(notice.cursors), [String(context.actorId)]: Number(context.messageId) } };
      await saveState(client, row, state);
      await publishLocked({ client, c: row, state, actorId: context.actorId });
      return { state: state.groupNotice.status, warning: noticeWarning(state, row.id) || 'Краткая карточка опубликована. Личная доставка не повторялась.', ...(state.groupNotice.status === 'confirmed' ? { message_id: state.groupNotice.receipt.message_id } : {}) };
    } finally {
      if (locked) try { await client.query('SELECT pg_advisory_unlock(111,hashtext($1))', [owner + ':' + submit]); } catch (error) { releaseError = error; }
      client.release(releaseError);
    }
  }
  return { preview, apply, publishLocked };
}
module.exports = { createHandoffNoticePublisher, initialNotice, pendingNotice, noticeWarning, SAVE_CHECKPOINT_SQL };
