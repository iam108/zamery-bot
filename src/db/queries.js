const pool = require('./pool');

async function createOrder(data) {
  const { rows } = await pool.query(
    `INSERT INTO orders 
      (address, owner_name, object_type, object_name, has_video, zones_info, deadline, contacts, submitted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      data.address,
      data.owner_name,
      data.object_type,
      data.object_name || null,
      data.has_video || false,
      data.zones_info || null,
      data.deadline || null,
      data.contacts || null,
      data.submitted_by || null,
    ]
  );
  return rows[0];
}

async function getOrders({ status, search, limit = 50, offset = 0 } = {}) {
  let where = [];
  let params = [];
  let i = 1;

  if (status && status !== 'all') {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (search) {
    where.push(`(address ILIKE $${i} OR owner_name ILIKE $${i} OR object_name ILIKE $${i} OR contacts ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM orders ${whereClause}`,
    params
  );

  return { orders: rows, total: parseInt(countRows[0].count) };
}

async function getOrderById(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] || null;
}

async function updateOrderStatus(id, status, actor = 'admin') {
  const { rows } = await pool.query(
    'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  if (rows[0]) {
    await addLog(id, 'status_change', actor, `Статус изменён на: ${status}`);
  }
  return rows[0];
}

async function setTelegramMsgId(orderId, msgId) {
  await pool.query('UPDATE orders SET telegram_msg_id = $1 WHERE id = $2', [msgId, orderId]);
}

async function addLog(orderId, action, actor, details) {
  await pool.query(
    'INSERT INTO logs (order_id, action, actor, details) VALUES ($1,$2,$3,$4)',
    [orderId, action, actor || 'system', details || null]
  );
}

async function getOrderLogs(orderId) {
  const { rows } = await pool.query(
    'SELECT * FROM logs WHERE order_id = $1 ORDER BY created_at DESC',
    [orderId]
  );
  return rows;
}

async function getStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'new')         AS new_count,
      COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
      COUNT(*) FILTER (WHERE status = 'done')        AS done_count,
      COUNT(*) FILTER (WHERE status = 'cancelled')   AS cancelled_count,
      COUNT(*) FILTER (WHERE deadline < NOW() AND status NOT IN ('done','cancelled')) AS overdue_count,
      COUNT(*)                                        AS total_count
    FROM orders
  `);
  return rows[0];
}

module.exports = { createOrder, getOrders, getOrderById, updateOrderStatus, setTelegramMsgId, addLog, getOrderLogs, getStats };
