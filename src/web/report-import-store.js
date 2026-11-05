'use strict';

// All records have already been validated and externally sorted on disk.
// The caller owns the transaction and the same per-chat lock as live capture.
async function importPreparedReports(db, chatId, prepared, options = {}) {
  const batchRecords = Math.min(500, options.batchRecords || 500), batchBytes = options.batchBytes || 2 * 1024 * 1024;
  function check() { if (options.isAborted && options.isAborted()) throw Object.assign(new Error('Импорт прерван.'), { code: 'UPLOAD_ABORTED' }); }
  async function* batches(group, includeText) {
    let batch = [], bytes = 0;
    for await (const message of includeText ? prepared.records(group) : prepared.ids(group)) {
      check(); const length = includeText ? Buffer.byteLength(message.text || '') : 0;
      if (batch.length && (batch.length >= batchRecords || bytes + length > batchBytes)) { yield batch; batch = []; bytes = 0; }
      batch.push(message); bytes += length;
    }
    if (batch.length) yield batch;
  }
  async function owners(messages) {
    const ids = messages.map(message => message.id);
    const result = await db.query(`SELECT incoming.id AS message_id, MIN(r.id) AS report_id
      FROM reports r JOIN unnest($2::bigint[]) AS incoming(id) ON incoming.id=ANY(r.msg_ids)
      WHERE r.chat_id=$1 AND r.msg_ids && $2::bigint[] GROUP BY incoming.id ORDER BY incoming.id`, [chatId, ids]);
    return new Map(result.rows.map(row => [Number(row.message_id), Number(row.report_id)]));
  }
  await db.query('CREATE TEMP TABLE report_import_pending(report_id INT NOT NULL,message_id BIGINT NOT NULL,text TEXT NOT NULL,sent_at TIMESTAMPTZ NOT NULL,new_report BOOLEAN NOT NULL) ON COMMIT DROP');
  for await (const group of prepared.groups()) {
    check(); let firstOwner = null;
    // A known message can occur late in a very large group. The unseen prefix
    // belongs to that first known report, so determine its owner before writes.
    for await (const batch of batches(group, false)) {
      const known = await owners(batch);
      const first = batch.find(message => known.has(message.id));
      if (first) { firstOwner = known.get(first.id); break; }
    }
    const existingGroup = firstOwner !== null;
    if (!existingGroup) {
      const inserted = await db.query(`INSERT INTO reports(chat_id,first_id,msg_ids,text,author,created_at,reply_to,author_id,mgid,last_message_at)
        VALUES($1,$2,'{}','',$3,$4,$5,$6,$7,$8) ON CONFLICT(chat_id,first_id) DO NOTHING RETURNING id`,
      [chatId, group.firstId, group.author, new Date(group.date).toISOString(), group.reply, group.authorId, group.mgid, new Date(group.last).toISOString()]);
      if (!inserted.rows.length) continue;
      firstOwner = Number(inserted.rows[0].id);
    }
    let owner = firstOwner;
    for await (const batch of batches(group, true)) {
      const known = existingGroup ? await owners(batch) : new Map(), pending = [];
      for (const message of batch) {
        if (known.has(message.id)) { owner = known.get(message.id); continue; }
        pending.push({ owner, message });
      }
      if (!pending.length) continue;
      if (options.observe) options.observe({ staged: pending.length, textBytes: pending.reduce((sum,item) => sum + Buffer.byteLength(item.message.text || ''), 0) });
      await db.query(`INSERT INTO report_import_pending(report_id,message_id,text,sent_at,new_report)
        SELECT * FROM unnest($1::int[],$2::bigint[],$3::text[],$4::timestamptz[],$5::boolean[])`,
      [pending.map(item => item.owner), pending.map(item => item.message.id), pending.map(item => item.message.text || ''), pending.map(item => item.message.date.toISOString()), pending.map(() => !existingGroup)]);
    }
  }
  check();
  // Aggregate once per report inside PostgreSQL. Repeatedly appending every
  // chunk to growing msg_ids/text would copy large reports quadratically.
  const result = await db.query(`WITH incoming AS (
      SELECT report_id,array_agg(message_id ORDER BY message_id) AS ids,
        string_agg(NULLIF(text,''),E'\n' ORDER BY message_id) AS text,MAX(sent_at) AS last,BOOL_OR(new_report) AS new_report
      FROM report_import_pending GROUP BY report_id
    ) UPDATE reports r SET msg_ids=ARRAY(SELECT DISTINCT n FROM unnest(r.msg_ids || incoming.ids) AS n ORDER BY n),
      text=CASE WHEN incoming.text IS NULL THEN r.text WHEN r.text='' THEN incoming.text ELSE r.text || E'\n' || incoming.text END,
      last_message_at=CASE WHEN incoming.new_report THEN r.last_message_at ELSE GREATEST(COALESCE(r.last_message_at,r.created_at),incoming.last) END
    FROM incoming WHERE r.id=incoming.report_id`);
  check();
  return { added: result.rowCount == null ? result.affectedRows : result.rowCount, messages: prepared.messageCount };
}

module.exports = { importPreparedReports };
