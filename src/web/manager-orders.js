const multer = require('multer');
const { createHash } = require('node:crypto');

function submissionSignature(data, files) {
  const packet = {};
  for (const field of ['address', 'owner_name', 'object_type', 'object_name', 'service', 'cad_num', 'archive_url', 'zones_info', 'contacts', 'deadline', 'has_video']) packet[field] = data[field];
  packet.egrn_order = data.egrn_order === true || data.egrn_order === '1' || data.egrn_order === 'true';
  packet.files = files.map(({ id, name, mime, role, bytes, sha256 }) => ({ id, name, mime, role, bytes, sha256 }));
  return createHash('sha256').update(JSON.stringify(packet)).digest('hex');
}

function canEditPacket(order, req) {
  return req.staff.role === 'manager' || String(order.submitted_by) === String(req.tgUser.id);
}
function orderId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Некорректный номер заявки.'), { status: 400 });
  return id;
}
function cardOptions(order) {
  let buttons = [];
  if (order.status === 'in_progress') buttons = [[{ text: '✅ Готово', callback_data: 'status:done:' + order.id }, { text: '❌ Отменить', callback_data: 'status:cancelled:' + order.id }], [{ text: '🔍 Продолжить проверку', callback_data: 'report:' + order.id }]];
  else if (order.status === 'done') buttons = [[{ text: '🔍 Открыть проверку', callback_data: 'report:' + order.id }]];
  else if (order.status !== 'cancelled') buttons = [[{ text: '🔧 Взять в работу', callback_data: 'status:in_progress:' + order.id }]];
  return { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } };
}

function createManagerHandlers(options = {}) {
  const materials = options.materials || require('./order-materials');
  const queries = options.queries || require('../db/queries');
  const pool = options.pool || require('../db/pool');
  const getTelegram = options.getTelegram || (() => require('../bot/instance').telegram);
  const format = options.format || require('../bot/formatter').formatOrderMessage;
  const attachOrOrder = options.attachOrOrder || (data => require('../bot/egrn').attachOrOrder(data));
  const recent = new Map();

  async function read(req, res) {
    try {
      await materials.ensureOrderMaterials();
      const order = await queries.getOrderById(orderId(req.params.id));
      if (!order) return res.status(404).json({ ok: false, error: 'Заявка не найдена.' });
      const packet = {};
      for (const field of ['id', 'address', 'owner_name', 'object_type', 'object_name', 'service', 'cad_num', 'archive_url', 'zones_info', 'contacts', 'deadline', 'has_video', 'submitted_name', 'status']) packet[field] = order[field] == null ? '' : order[field];
      res.set('Cache-Control', 'no-store').json({ ok: true, order: packet, materials: await materials.listOrderMaterials(order.id), can_edit: canEditPacket(order, req) });
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'Не удалось загрузить заявку.' }); }
  }

  async function save(req, res) {
    let order, key, signature, ownsRecent = false;
    const edit = req.params.id != null;
    const finish = (body, status = 200) => {
      if (key && ownsRecent) { if (body.ok && !body.warning) recent.set(key, { signature, body }); else recent.delete(key); }
      return res.status(status).json(body);
    };
    try {
      await materials.ensureOrderMaterials();
      let existing = [];
      if (edit) {
        order = await queries.getOrderById(orderId(req.params.id));
        if (!order) return finish({ ok: false, error: 'Заявка не найдена.' }, 404);
        if (!canEditPacket(order, req)) return finish({ ok: false, error: 'Изменить заявку может её автор или менеджер.' }, 403);
        existing = await materials.listOrderMaterials(order.id);
      }
      const sid = String((req.body && req.body.submit_id) || '').slice(0, 40);
      key = sid ? req.tgUser.id + ':' + (edit ? order.id : 'new') + ':' + sid : null;
      const prepared = materials.prepareMaterials(req.files || [], req.body.file_roles || []);
      const data = materials.normalizeManagerOrder(req.body, existing.concat(prepared));
      signature = submissionSignature(data, prepared);
      if (key && recent.has(key)) {
        const previous = recent.get(key);
        if (previous.signature !== signature) return res.status(409).json({ ok: false, error: 'Эта заявка уже сохранена или отправляется с другими данными. Откройте заявку для изменения.' });
        if (previous.pending) return res.status(409).json({ ok: false, busy: true, error: 'Заявка уже отправляется' });
        return res.json(previous.body);
      }
      if (recent.size > 500) for (const [cachedKey, cached] of recent) { if (!cached.pending) { recent.delete(cachedKey); break; } }
      if (key) { recent.set(key, { signature, pending: true }); ownsRecent = true; }
      if (edit) {
        // Сначала добавляем оригиналы: ошибка лимитов не меняет поля заявки.
        await materials.saveOrderMaterials(order.id, prepared);
        order = await queries.updateOrderPacket(order.id, data);
        if (!order) throw Object.assign(new Error('Заявка не найдена.'), { status: 404 });
        await queries.addLog(order.id, 'packet_updated', req.staff.name, 'Менеджер обновил данные и пакет документов заявки');
      } else {
        order = await queries.createOrderWithMaterials({ ...data, submitted_by: req.tgUser.id }, prepared);
        if (!order.submitted_name) {
          order.submitted_name = req.staff.name;
          await pool.query('UPDATE orders SET submitted_name=$1 WHERE id=$2 AND submitted_name IS NULL', [req.staff.name, order.id]);
        }
      }

      const telegram = getTelegram();
      const warnings = [];
      const newCard = !order.telegram_msg_id;
      if (newCard) {
        try {
          const msg = await telegram.sendMessage(process.env.GROUP_CHAT_ID, format(order), cardOptions(order));
          await queries.setTelegramMsgId(order.id, msg.message_id);
          order.telegram_msg_id = msg.message_id;
          await queries.addLog(order.id, 'created', req.staff.name, 'Заявка и материалы сохранены; карточка отправлена в чат');
        } catch (e) { console.error('order card delivery:', e.message); warnings.push('Карточка не доставлена в чат.'); }
      } else if (edit) {
        try { await telegram.editMessageText(process.env.GROUP_CHAT_ID, Number(order.telegram_msg_id), undefined, format(order), cardOptions(order)); }
        catch (e) { if (!/message is not modified/i.test(e.message)) { console.error('order card update:', e.message); warnings.push('Не удалось обновить карточку в чате.'); } }
      }
      if (order.telegram_msg_id) {
        for (const file of await materials.listOrderMaterials(order.id, true)) {
          if (file.telegram_msg_id) continue;
          try {
            const sent = await telegram.sendDocument(process.env.GROUP_CHAT_ID, { source: file.buffer, filename: file.name }, { caption: '📎 Заявка #' + order.id + ' · ' + file.name, reply_to_message_id: order.telegram_msg_id });
            await materials.markOrderMaterialDelivered(order.id, file.id, sent.message_id);
          } catch (e) { console.error('order document delivery:', e.message); warnings.push('Не доставлен в чат файл «' + file.name + '».'); }
        }
        const orderEgrn = data.egrn_order === true || data.egrn_order === '1' || data.egrn_order === 'true';
        // Проверка безопасна и для повтора: ЕГРН хранит заказ и квитанции доставки.
        // Номер и карточка могли сохраниться до временной ошибки прошлого запроса.
        if (data.cad_num) {
          try {
            const egrn = await attachOrOrder({ cad: data.cad_num, label: [data.owner_name, data.object_name].filter(Boolean).join(' · '), order: orderEgrn,
              requestKey: 'manager-order:' + order.id + ':' + data.cad_num,
              orderedBy: req.tgUser.id, orderedName: req.staff.name,
              targets: [{ chat: Number(process.env.GROUP_CHAT_ID), reply: order.telegram_msg_id, order_id: order.id }], note: 'Для заявки на замер #' + order.id });
            if (egrn.packet_warning) warnings.push(egrn.packet_warning);
            if (orderEgrn && egrn.result === 'none') warnings.push('Выписка ЕГРН не заказана: сервис сейчас недоступен. Повторите доставку позднее.');
            if (['unavailable', 'failed'].includes(egrn.result)) warnings.push('Доставка выписки ЕГРН остановлена. Требуется проверить заказ; повторный платный заказ не создавался.');
            if (['uncertain', 'unknown'].includes(egrn.result) && !egrn.packet_warning) warnings.push('Результат заказа ЕГРН не подтверждён. Требуется проверка у поставщика; повторный платный заказ не создавался.');
            const notes = { unavailable: '⚠️ Доставка ранее заказанной выписки остановлена. Повторный заказ не создан.', attached: '📄 Выписка ЕГРН приложена к заявке', ordered: '⏳ Выписка ЕГРН заказана — придёт ответом на заявку', waiting: '⏳ Выписка ЕГРН уже в работе — придёт ответом на заявку' };
            if (notes[egrn.result]) await telegram.sendMessage(process.env.GROUP_CHAT_ID, notes[egrn.result] + ' (' + egrn.cad + ')', { reply_to_message_id: order.telegram_msg_id, disable_notification: true });
          } catch (e) { console.error('egrn for order:', e.message); warnings.push('Не удалось проверить доставку выписки ЕГРН.'); }
        }
      }
      finish({ ok: true, id: order.id, warning: warnings.length ? 'Заявка #' + order.id + ' и документы сохранены. ' + warnings.join(' ') + ' Повторите доставку — новая заявка не создастся.' : undefined });
    } catch (e) {
      console.error('api/order error:', e.message);
      finish({ ok: false, id: order && order.id, error: e.message }, e.status || 400);
    }
  }
  return { read, save };
}

function setupManagerOrders(app) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 20 } });
  const parse = (req, res, next) => upload.array('files', 20)(req, res, err => {
    if (err) return res.status(413).json({ ok: false, error: 'Можно добавить до 20 файлов, каждый не больше 12 МБ.' });
    // Браузеры передают filename в UTF-8, а Multer 1.x читает его как Latin-1.
    for (const file of req.files || []) {
      if (!/^[\x00-\xff]*$/.test(file.originalname)) continue;
      const bytes = Buffer.from(file.originalname, 'latin1'), decoded = bytes.toString('utf8');
      if (Buffer.from(decoded, 'utf8').equals(bytes)) file.originalname = decoded;
    }
    next();
  });
  const handlers = createManagerHandlers();
  app.get('/api/order/:id', handlers.read);
  app.post('/api/order', parse, handlers.save);
  app.post('/api/order/:id', parse, handlers.save);
}

module.exports = { setupManagerOrders, createManagerHandlers, canEditPacket, cardOptions };
