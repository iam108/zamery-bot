'use strict';

const { randomUUID } = require('node:crypto');
const DDL = "ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS delivery_state JSONB NOT NULL DEFAULT '{}'";
const PRIVATE = /^[1-9]\d*$/;
function state(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function unavailable(message = 'Получатель выписки больше недоступен. Проверьте назначение и доступ сотрудника; подтверждённые файлы сохранены.') {
  return Object.assign(new Error(message), { code: 'EGRN_RECIPIENT_UNAVAILABLE', uncertain: false, delivery_stage: 'validation' });
}
function unknown() {
  return Object.assign(new Error('Результат отправки оригинала не подтверждён. Проверьте сообщения в чате; администратор может разрешить повтор командой /egrn_retry с номером готового заказа. Новый платный заказ не создавался.'), { code: 'EGRN_DELIVERY_UNCONFIRMED', uncertain: true });
}
function positive(value) { return (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function confirmedRejection(error) {
  const code = Number(error?.response?.error_code ?? error?.code);
  return Number.isInteger(code) && code >= 400 && code < 500 || /^413\b/.test(String(error?.message || ''));
}
function sourceKey(record) { return record.key || String(record.chat) + ':' + String(record.id); }
function confirmsOriginal(order, operation, receipt) {
  if (!positive(receipt?.message_id)) return false;
  const chat = String(operation.target.chat), id = Number(receipt.message_id);
  if (receipt.chat?.id != null && /^-?[1-9]\d*$/.test(chat) && String(receipt.chat.id) !== chat) return false;
  if (chat.startsWith('@') && receipt.chat?.username != null && '@' + String(receipt.chat.username).toLowerCase() !== chat.toLowerCase()) return false;
  return !(Array.isArray(order.file_msgs) ? order.file_msgs : []).some(record => sourceKey(record) !== operation.key &&
    (String(record.chat) === chat && Number(record.id) === id ||
      (Array.isArray(record.deliveries) ? record.deliveries : []).some(value => String(value.chat) === chat && Number(value.id) === id)));
}
function createEgrnTelegramDelivery({ pool, env = process.env } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('An EGRN SQL pool is required');
  const admins = () => String(env.ADMIN_TG_IDS || '').split(/[\s,;]+/).filter(Boolean);
  const isGroup = chat => [env.GROUP_CHAT_ID,env.EGRN_CHAT_ID].filter(Boolean).some(value=>String(value).toLowerCase()===String(chat).toLowerCase());
  const bindingsFor = (order,target) => target.case_id != null ? [target.case_id] : (Array.isArray(order?.deliver) ? order.deliver : []).filter(value=>String(value?.chat)===String(target.chat)&&value.case_id!=null).map(value=>value.case_id);
  async function authorize(order, target, connection = pool) {
    const chat = String(target?.chat ?? '');
    if (isGroup(chat)) return;
    if (!PRIVATE.test(chat) || !Number.isSafeInteger(Number(chat))) throw unavailable();
    try {
      const bindings = bindingsFor(order,target);
      if (!bindings.length && !admins().includes(chat)) {
        const row = (await connection.query('SELECT approved FROM staff WHERE tg_id=$1', [chat])).rows[0];
        if (row?.approved !== true) throw unavailable();
      }
      for (const caseId of new Set(bindings.map(String))) {
        if (!/^[1-9]\d*$/.test(caseId) || !Number.isSafeInteger(Number(caseId)) || Number(caseId) > 2147483647) throw unavailable();
        // Read assignment, approval and role in the same snapshot, matching
        // the case access rule used by the handoff route.
        const current = (await connection.query('SELECT c.lawyer_tg_id,s.approved,s.role FROM cases c LEFT JOIN staff s ON s.tg_id=c.lawyer_tg_id WHERE c.id=$1', [caseId])).rows[0];
        if (!current || String(current.lawyer_tg_id) !== chat || current.approved !== true ||
            !(['lawyer','manager'].includes(current.role) || admins().includes(chat))) throw unavailable();
      }
    } catch (error) { if (error.code === 'EGRN_RECIPIENT_UNAVAILABLE') throw error; throw unavailable('Не удалось проверить доступ получателя выписки. Доставка пока не подтверждена; повторите проверку позднее.'); }
  }
  function assertAvailable(order) { if (state(order.delivery_state).inflight) throw unknown(); }
  async function retainOwnership(order,intent) {
    const values=[order.id,order.processing_token,intent.attempt],chat=String(intent.target.chat),bindings=bindingsFor(order,intent.target);let access='';
    // Lease and current recipient eligibility share the final SQL snapshot.
    // A long wait for this UPDATE cannot revive an obsolete worker or use an
    // approval/assignment read before that wait.
    if(!isGroup(chat)) {
      values.push(chat);
      if(bindings.length) {
        values.push(JSON.stringify(bindings.map(String)),admins().includes(chat));
        access=` AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text($5::jsonb) binding
          LEFT JOIN cases c ON c.id=binding.value::int LEFT JOIN staff s ON s.tg_id=c.lawyer_tg_id
          WHERE c.id IS NULL OR c.lawyer_tg_id::text<>$4 OR s.approved IS DISTINCT FROM true
            OR NOT (COALESCE(s.role,'') IN ('lawyer','manager') OR $6::boolean))`;
      } else if(!admins().includes(chat)) access=' AND EXISTS (SELECT 1 FROM staff s WHERE s.tg_id::text=$4 AND s.approved=true)';
      else values.pop();
    }
    const result=await pool.query("UPDATE egrn_orders SET processing_until=NOW()+INTERVAL '2 minutes' WHERE id=$1 AND processing_token=$2 AND processing_until>NOW() AND delivery_state->'inflight'->>'attempt'=$3"+access+' RETURNING id',values);
    if(!result.rows.length) {
      await authorize(order,intent.target);
      throw Object.assign(new Error('Обработка выписки продолжена другим процессом.'),{code:'EGRN_LEASE_LOST'});
    }
  }
  async function clearRejected(order, intent) {
    const result = await pool.query("UPDATE egrn_orders SET delivery_state=delivery_state-'inflight',updated_at=NOW() WHERE id=$1 AND processing_token=$2 AND delivery_state->'inflight'->>'attempt'=$3 RETURNING delivery_state", [order.id, order.processing_token, intent.attempt]);
    if (!result.rows.length) throw unknown();
    order.delivery_state = result.rows[0].delivery_state;
    delete order._deliveryAck;
  }
  async function send(order, operation, run) {
    if (!order) return run();
    assertAvailable(order);
    await authorize(order, operation.target);
    const intent = { attempt: randomUUID(), key: operation.key, kind: operation.kind, target: operation.target, started_at: new Date().toISOString() };
    const reserved = await pool.query("UPDATE egrn_orders SET delivery_state=jsonb_set(COALESCE(delivery_state,'{}'::jsonb),'{inflight}',$1::jsonb,true),updated_at=NOW() WHERE id=$2 AND processing_token=$3 AND processing_until>NOW() AND NOT (COALESCE(delivery_state,'{}'::jsonb) ? 'inflight') RETURNING delivery_state", [JSON.stringify(intent), order.id, order.processing_token]);
    if (!reserved.rows.length) throw unknown();
    order.delivery_state = reserved.rows[0].delivery_state;
    let requested = false;
    try {
      // The durable write may have waited for SQL. Recheck the recipient at
      // the actual transport boundary, with no provider call in between.
      await authorize(order, operation.target);
      await retainOwnership(order,intent);
      requested = true;
      // Callers may prepare a readonly accounting snapshot after a slow
      // preflight. Retain the final recipient/lease gate after that await.
      const recheck = async () => {
        try { await authorize(order,operation.target); await retainOwnership(order,intent); }
        catch (error) { error.delivery_stage='validation';error.uncertain=false;throw error; }
      };
      const receipt = await run(recheck);
      if (!confirmsOriginal(order,operation,receipt)) throw unknown();
      order._deliveryAck = { attempt: intent.attempt, message_id: Number(receipt.message_id) };
      return receipt;
    } catch (error) {
      if (!requested || error?.delivery_stage === 'validation' && error?.uncertain === false || confirmedRejection(error)) {
        try { await clearRejected(order, intent); }
        catch (_) { throw unknown(); }
        error.uncertain = false; throw error;
      }
      throw Object.assign(unknown(), { source_code: /^[A-Z_\d]+$/.test(String(error?.code || '')) ? error.code : undefined });
    }
  }
  function containsReceipt(records, intent, acknowledgement) {
    const record = records.find(value => sourceKey(value) === intent.key);
    if (!record) return false;
    const chat = String(intent.target.chat), messageId = acknowledgement.message_id;
    if (intent.kind === 'native-primary' || intent.kind === 'native-repair') return String(record.chat) === chat && Number(record.id) === messageId;
    return (Array.isArray(record.deliveries) ? record.deliveries : []).some(value => String(value.chat) === chat && Number(value.id) === messageId && (record.kind !== 'link' || Number(value.reply || 0) === Number(intent.target.reply || 0)));
  }
  async function persist(order, records) {
    const intent = state(order.delivery_state).inflight, acknowledgement = order._deliveryAck;
    if (intent && (!acknowledgement || acknowledgement.attempt !== intent.attempt || !containsReceipt(records, intent, acknowledgement))) throw unknown();
    const values = [JSON.stringify(records), order.id, order.processing_token];
    const condition = intent ? " AND delivery_state->'inflight'->>'attempt'=$4" : " AND NOT (COALESCE(delivery_state,'{}'::jsonb) ? 'inflight')";
    if (intent) values.push(intent.attempt);
    let result;
    try { result = await pool.query('UPDATE egrn_orders SET file_msgs=$1,' + (intent ? "delivery_state=delivery_state-'inflight'," : '') + 'updated_at=NOW() WHERE id=$2 AND processing_token=$3 AND processing_until>NOW()' + condition + ' RETURNING delivery_state', values); }
    catch (error) { if (intent) throw Object.assign(unknown(), { code: 'EGRN_DELIVERY_CHECKPOINT' }); throw error; }
    if (!result.rows.length) throw intent ? unknown() : Object.assign(new Error('Обработка выписки продолжена другим процессом.'), { code: 'EGRN_LEASE_LOST' });
    order.file_msgs = records; order.delivery_state = result.rows[0].delivery_state; delete order._deliveryAck;
  }
  async function retry(statementId, actorId, messageId, options = {}) {
    if (!positive(messageId) || !Number.isSafeInteger(Number(messageId))) return { state: 'invalid' };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const eligible = options.consumeOnly ? "status IN ('ordered','done')" : "status='done' AND files_sent<=0";
      const order = (await client.query("SELECT *,processing_until>NOW() AS active FROM egrn_orders WHERE id_statement=$1 AND "+eligible+" AND created_at>NOW()-INTERVAL '30 days' ORDER BY id DESC LIMIT 1 FOR UPDATE", [statementId])).rows[0];
      if (!order) { await client.query('COMMIT'); return { state: 'missing' }; }
      const checkpoint = state(order.delivery_state), cursors = state(checkpoint.retry_cursors), actor = String(actorId);
      await authorize({}, { chat: actor }, client);
      if (Number(cursors[actor] || 0) >= Number(messageId)) { await client.query('COMMIT'); return { state: 'replayed', order }; }
      checkpoint.retry_cursors = { ...cursors, [actor]: Number(messageId) };
      if (options.consumeOnly || order.active === true || checkpoint.inflight && !admins().includes(actor)) {
        await client.query('UPDATE egrn_orders SET delivery_state=$1 WHERE id=$2', [JSON.stringify(checkpoint), order.id]);
        await client.query('COMMIT'); return { state: options.consumeOnly || order.active === true ? 'busy' : 'admin_required' };
      }
      delete checkpoint.inflight;
      const result = await client.query("UPDATE egrn_orders SET files_sent=0,failures=0,retry_at=NULL,error=NULL,delivery_state=$1,processing_token=NULL,processing_until=NULL,updated_at=NOW() WHERE id=$2 RETURNING *", [JSON.stringify(checkpoint), order.id]);
      await client.query('COMMIT'); return { state: 'ready', order: result.rows[0] };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  return { authorize, assertAvailable, send, persist, retry, isAdmin: id => admins().includes(String(id)) };
}
module.exports = { DDL, createEgrnTelegramDelivery };
