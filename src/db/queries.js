const pool = require('./pool');

async function createOrder(data, client) {
  if (!client) await require('../web/order-materials').ensureOrderMaterials();
  const connection = client || pool;
  const { rows } = await connection.query(
    `INSERT INTO orders 
      (address, owner_name, object_type, object_name, has_video, zones_info, deadline, contacts, submitted_by, service, cad_num, archive_url, request_submit_id, request_signature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT(submitted_by,request_submit_id) DO NOTHING
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
      data.service || null,
      data.cad_num || null,
      data.archive_url || null,
      data.request_submit_id || null,
      data.request_signature || null,
    ]
  );
  if (rows[0]) return rows[0];
  const existing = (await connection.query('SELECT * FROM orders WHERE submitted_by=$1 AND request_submit_id=$2', [data.submitted_by, data.request_submit_id])).rows[0];
  if (!existing) throw new Error('Не удалось сохранить заявку.');
  if (existing.request_signature !== data.request_signature) throw new Error('Эта заявка уже сохранена с другими данными. Откройте новую форму для новой заявки.');
  return existing;
}

async function createOrderWithMaterials(data, prepared) {
  const materials = require('../web/order-materials');
  // Schema setup uses its own connection. Finish it before leasing the single
  // transaction client so this also works when the pool has max: 1.
  await materials.ensureOrderMaterials();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await createOrder(data, client);
    await materials.saveOrderMaterialsInTransaction(client, order.id, prepared);
    await client.query('COMMIT');
    return order;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
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

async function updateOrderPacket(id, data, client) {
  if (!client) await require('../web/order-materials').ensureOrderMaterials();
  const { rows } = await (client || pool).query(`UPDATE orders SET address=$1,owner_name=$2,object_type=$3,object_name=$4,
    has_video=$5,zones_info=$6,deadline=$7,contacts=$8,service=$9,cad_num=$10,archive_url=$11,packet_revision=packet_revision+1
    WHERE id=$12 RETURNING *`, [data.address, data.owner_name, data.object_type, data.object_name || null,
    data.has_video || false, data.zones_info || null, data.deadline || null, data.contacts || null,
    data.service || null, data.cad_num || null, data.archive_url || null, id]);
  return rows[0] || null;
}

async function updateOrderPacketWithMaterials(id, data, prepared, intent) {
  const revision = Number(intent.expectedRevision), actor = Number(intent.actorId);
  const fail = (message, status, code, current) => Object.assign(new Error(message), { status, code, packet_revision: current });
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) throw fail('Откройте актуальную версию заявки перед сохранением. Ваши данные остались в форме.', 400, 'ORDER_PACKET_REVISION_REQUIRED');
  if (!Number.isSafeInteger(actor) || actor < 1 || typeof intent.submitId !== 'string' || !intent.submitId || intent.submitId.length > 40 || typeof intent.signature !== 'string' || !intent.signature) throw fail('Не удалось подтвердить сохранение. Обновите форму заявки.', 400, 'ORDER_PACKET_INTENT_REQUIRED');
  const materials = require('../web/order-materials');
  await materials.ensureOrderMaterials();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!current) throw fail('Заявка не найдена.', 404, 'ORDER_NOT_FOUND');
    const receipt = (await client.query('SELECT signature,packet_revision FROM order_packet_submissions WHERE order_id=$1 AND actor_id=$2 AND submit_id=$3', [id, actor, intent.submitId])).rows[0];
    // A lost acknowledgement can replay after a restart or another edit.
    // The receipt confirms the original write; it never restores its old fields.
    if (receipt) {
      if (receipt.signature !== intent.signature) throw fail('Эта заявка уже сохранена с другими данными. Откройте заявку для изменения.', 409, 'ORDER_PACKET_SUBMISSION_CONFLICT', current.packet_revision);
      await client.query('COMMIT');
      return { order: current, replayed: true, saved_revision: Number(receipt.packet_revision) };
    }
    if (Number(current.packet_revision) !== revision) throw fail('Заявка уже изменена другим менеджером. Ваши данные остались в форме. Загрузите актуальную версию перед сохранением.', 409, 'ORDER_PACKET_CONFLICT', current.packet_revision);
    // Version validation, originals, fields, log and receipt share one commit.
    await materials.saveOrderMaterialsInTransaction(client, id, prepared);
    const order = await updateOrderPacket(id, data, client);
    await client.query('INSERT INTO logs(order_id,action,actor,details) VALUES($1,$2,$3,$4)', [id, 'packet_updated', intent.actorName || String(actor), 'Менеджер обновил данные и пакет документов заявки']);
    await client.query('INSERT INTO order_packet_submissions(order_id,actor_id,submit_id,signature,packet_revision) VALUES($1,$2,$3,$4,$5)', [id, actor, intent.submitId, intent.signature, order.packet_revision]);
    await client.query('COMMIT');
    return { order, replayed: false, saved_revision: Number(order.packet_revision) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function updateOrderStatus(id, status, actor = 'admin', expectedStatuses = null, requiredStaffId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params = expectedStatuses ? [status,id,expectedStatuses] : [status,id];
    let permission = '';
    if(requiredStaffId!=null){params.push(requiredStaffId);permission=' AND EXISTS (SELECT 1 FROM staff WHERE tg_id=$'+params.length+' AND approved IS TRUE)';}
    const { rows } = await client.query('UPDATE orders SET status = $1 WHERE id = $2' + (expectedStatuses ? ' AND status = ANY($3::text[])' : '') + permission + ' RETURNING *',params);
    if (rows[0]) {
      await client.query('INSERT INTO logs (order_id,action,actor,details) VALUES($1,$2,$3,$4)',
        [id, 'status_change', actor, 'Статус изменён на: ' + status]);
    }
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
      COUNT(*) FILTER (WHERE deadline < (NOW() AT TIME ZONE 'Europe/Moscow')::date AND status NOT IN ('done','cancelled')) AS overdue_count,
      COUNT(*)                                        AS total_count
    FROM orders
  `);
  return rows[0];
}
async function getStatsByMonth() {
  const { rows } = await pool.query(`
    SELECT 
      TO_CHAR(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM') AS month,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'done') AS done,
      COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
    FROM orders
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `);
  return rows;
}

async function getStatsByType() {
  const { rows } = await pool.query(`
    SELECT 
      object_type,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'done') AS done
    FROM orders
    GROUP BY object_type
    ORDER BY total DESC
  `);
  return rows;
}

async function searchObjects({ search = '' } = {}) {
  const { rows } = await pool.query(`
    SELECT 
      COALESCE(NULLIF(object_name, ''), address) AS display_name,
      object_name,
      address,
      object_type,
      COUNT(*) AS visits,
      MAX(created_at) AS last_visit,
      COUNT(*) FILTER (WHERE status = 'done') AS done_count
    FROM orders
    WHERE 
      address ILIKE $1 OR 
      object_name ILIKE $1 OR
      contacts ILIKE $1
    GROUP BY object_name, address, object_type
    ORDER BY last_visit DESC
    LIMIT 50
  `, [`%${search}%`]);
  return rows;
}

async function getOrdersByObject(address, objectName) {
  const { rows } = await pool.query(`
    SELECT * FROM orders
    WHERE address = $1 AND (object_name = $2 OR ($2 = '' AND object_name IS NULL))
    ORDER BY created_at DESC
  `, [address, objectName || '']);
  return rows;
}
module.exports = { 
  createOrder, createOrderWithMaterials, getOrders, getOrderById, updateOrderPacket, updateOrderPacketWithMaterials, updateOrderStatus,
  setTelegramMsgId, addLog, getOrderLogs, getStats,
  getStatsByMonth, getStatsByType, searchObjects, getOrdersByObject
};
