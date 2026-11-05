'use strict';

const { canAccessCase } = require('./auth');
const { RETRY_MS } = require('./reminder-delivery');

function recipientIds(values) {
  return [...new Set(values.filter(value => /^[1-9]\d*$/.test(String(value))).map(String))];
}

async function loadRecipientAccess(db, client, creators = [], now = Date.now()) {
  const creatorIds = recipientIds(creators);
  try {
    // The owner and staff permissions must come from one statement snapshot.
    // Reusing an earlier case object could authorize its former lawyer after
    // reassignment while the staff lookup was waiting on PostgreSQL.
    const rows = client ? (await db.query(`SELECT to_jsonb(c) AS access_case,s.* FROM cases c
      LEFT JOIN staff s ON s.tg_id=c.lawyer_tg_id OR s.tg_id=ANY($2::bigint[])
      WHERE c.id=$1`, [client.id,creatorIds])).rows : [];
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

module.exports = { loadRecipientAccess, recipientIds };
