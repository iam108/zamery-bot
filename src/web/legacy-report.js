'use strict';

// Recurse over report IDs, not paths: UNION gives each report one place in
// the result and terminates even if old imports contain duplicate message
// ownership, a self reply, or a cycle. Every edge remains inside its chat.
const DESCENDANTS_SQL = `WITH RECURSIVE seeds AS (
  SELECT chat_id,msg_ids FROM reports WHERE id=$1
  UNION ALL
  SELECT chat_id,msg_ids FROM audits WHERE id=ANY($2::int[])
), descendants(id) AS (
  SELECT report.id FROM seeds seed JOIN reports report
    ON report.chat_id=seed.chat_id
      AND report.reply_to=ANY(COALESCE(seed.msg_ids,'{}'::bigint[]))
  UNION
  SELECT child.id FROM descendants tree
  JOIN reports parent ON parent.id=tree.id
  JOIN reports child ON child.chat_id=parent.chat_id
    AND child.reply_to=ANY(COALESCE(parent.msg_ids,'{}'::bigint[]))
)
SELECT report.* FROM reports report JOIN descendants tree ON tree.id=report.id
WHERE report.id<>$1
ORDER BY CASE WHEN report.chat_id=(SELECT chat_id FROM reports WHERE id=$1) THEN 0 ELSE 1 END,
  report.chat_id,report.first_id,report.id`;

function isOrderCard(text) {
  return /^[^\wА-Яа-я]*(Новая заявка|Заявка\s*#\d+)/i.test(text || '') || /Чей объект\s*:/.test(text || '');
}

async function loadReportDescendants(db, root, linkedAudits = []) {
  return (await db.query(DESCENDANTS_SQL, [root.id, linkedAudits.map(audit => audit.id)])).rows;
}

async function loadReportAggregate(db, id, options = {}) {
  const root = (await db.query('SELECT * FROM reports WHERE id=$1', [id])).rows[0];
  if (!root) return null;
  const card = isOrderCard(root.text);
  const number = card && (String(root.text || '').match(/Заявка\s*#(\d+)/i) || [])[1];
  // orders.telegram_msg_id identifies a card only inside the working chat.
  // A same-number reply in the clients chat is a different Telegram source.
  const workingChat = String(options.workingChatId ?? process.env.GROUP_CHAT_ID ?? '');
  const linkedOrder = !number && root.reply_to && workingChat && String(root.chat_id) === workingChat
    ? (await db.query('SELECT id FROM orders WHERE telegram_msg_id=$1 ORDER BY id DESC LIMIT 1', [root.reply_to])).rows[0] : null;
  const orderId = number ? Number(number) : linkedOrder ? Number(linkedOrder.id) : null;
  // A caller's requested order is never an authority for audit seeds. Only
  // the selected card's saved server-side relation can add another source.
  const audits = card && Number.isInteger(orderId) && orderId > 0 && orderId <= 2147483647
    ? (await db.query('SELECT * FROM audits WHERE order_id=$1 ORDER BY created_at,id', [orderId])).rows : [];
  const replies = await loadReportDescendants(db, root, audits);
  const sources = new Map();
  const addSource = (chat, messages) => {
    const key = String(chat), source = sources.get(key) || { chat_id: chat, msg_ids: [] };
    source.msg_ids = [...new Set(source.msg_ids.concat((messages || []).map(Number)))].sort((a,b) => a-b);
    sources.set(key, source);
  };
  const rootMessages = [...new Set((root.msg_ids || []).concat(replies.filter(reply => String(reply.chat_id) === String(root.chat_id))
    .flatMap(reply => reply.msg_ids || [])).map(Number))].sort((a,b) => a-b);
  addSource(root.chat_id, rootMessages);
  audits.forEach(audit => addSource(audit.chat_id, audit.msg_ids));
  replies.forEach(reply => addSource(reply.chat_id, reply.msg_ids));
  const text = [...(card ? [] : [root.text]), ...replies.map(reply => reply.text), ...audits.map(audit => audit.text)].filter(Boolean).join('\n\n');
  const latest = audits[audits.length-1];
  return { ...root, order_id: orderId, msg_ids: rootMessages, sources: [...sources.values()], text,
    extra: [...new Set(audits.filter(audit => String(audit.chat_id) === String(root.chat_id)).flatMap(audit => audit.msg_ids || []).map(Number))].sort((a,b) => a-b),
    linked: replies.length + audits.length, report_data: latest && latest.report_data,
    report_data_sources: audits.map(audit => audit.report_data), metadata_source: latest || { text } };
}

module.exports = { loadReportDescendants, loadReportAggregate };
