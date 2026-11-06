'use strict';

const { canAccessCase, canManageCases } = require('./auth');
const { RETRY_MS } = require('./reminder-delivery');

function recipientIds(values) {
  return [...new Set(values.filter(value => /^[1-9]\d*$/.test(String(value))).map(String))];
}

async function loadRecipientAccess(db, client, creators = [], now = Date.now(), gate = {}) {
  const creatorIds = recipientIds(creators);
  try {
    // The owner and staff permissions must come from one statement snapshot.
    // Reusing an earlier case object could authorize its former lawyer after
    // reassignment while the staff lookup was waiting on PostgreSQL.
    // A task can be completed while the staff lookup waits. Its active flag
    // belongs to this final owner/staff snapshot, not a preceding SELECT.
    const activeReminder = gate.reminderId != null;
    const rows = client ? (await db.query(`SELECT to_jsonb(c) AS access_case,s.* FROM cases c
      LEFT JOIN staff s ON s.tg_id=c.lawyer_tg_id OR s.tg_id=ANY($2::bigint[])
      WHERE c.id=$1` + (activeReminder ? ' AND EXISTS (SELECT 1 FROM case_reminders r WHERE r.id=$3 AND r.case_id=c.id AND r.done=false)' : ''),
    activeReminder ? [client.id,creatorIds,gate.reminderId] : [client.id,creatorIds])).rows : [];
    const current = rows[0]?.access_case || null;
    const ids = recipientIds([current?.lawyer_tg_id,...creatorIds]);
    const allowed = ids.filter(id => canAccessCase(rows.find(actor => String(actor.tg_id) === id), id, current));
    // Keep the full case snapshot separate: persisting it under delivery would
    // recursively duplicate that case's own delivery and handoff checkpoints.
    return { client: current, access: { checked: true, checked_at: now, next_at: now+RETRY_MS,
      allowed, excluded: ids.filter(id => !allowed.includes(id)) } };
  } catch (_) {
    // Absence of current staff evidence never grants a send permission.
    return { client, access: { checked: false, checked_at: now, next_at: now+RETRY_MS, allowed: [], excluded: [] } };
  }
}

async function completeReminder(db, reminderId, actorId) {
  if (!/^[1-9]\d*$/.test(String(reminderId)) || !Number.isSafeInteger(Number(reminderId)) || Number(reminderId)>2147483647 ||
      !/^[1-9]\d*$/.test(String(actorId)) || !Number.isSafeInteger(Number(actorId))) return false;
  // The mutation uses current approval, role and assignment together. A read
  // that preceded a SQL wait cannot authorize a former owner or revoked staff.
  const admin = canManageCases({ approved: true, role: 'auditor' }, actorId);
  const result = await db.query(`UPDATE case_reminders AS reminder SET done=true
    FROM cases c,staff actor WHERE reminder.id=$1 AND c.id=reminder.case_id
      AND actor.tg_id=$2 AND actor.approved=true
      AND (actor.role='manager' OR $3::boolean OR actor.role='lawyer' AND c.lawyer_tg_id=actor.tg_id)
    RETURNING reminder.id`, [Number(reminderId), actorId, admin]);
  return result.rows.length > 0;
}

module.exports = { loadRecipientAccess, recipientIds, completeReminder };
