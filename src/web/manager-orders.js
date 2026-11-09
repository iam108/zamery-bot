const multer = require('multer');
const { createHash, randomUUID } = require('node:crypto');

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
function validReportUrl(value) {
  if (typeof value !== 'string') return null;
  // Telegram deep links point to an existing summary, never to an arbitrary
  // URL supplied by a form or to the editable auditor workflow.
  return /^https:\/\/t\.me\/(?:c\/[1-9]\d*|[A-Za-z][A-Za-z0-9_]{4,31})\/[1-9]\d*$/.test(value) ? value : null;
}
function cardOptions(order, reportUrl) {
  let buttons = [];
  if (order.status === 'in_progress') buttons = [[{ text: '✅ Готово', callback_data: 'status:done:' + order.id }, { text: '❌ Отменить', callback_data: 'status:cancelled:' + order.id }], [{ text: '🔍 Продолжить проверку', callback_data: 'report:' + order.id }]];
  else if (order.status === 'done') buttons = [[{ text: '🔍 Открыть проверку', callback_data: 'report:' + order.id }]];
  else if (order.status !== 'cancelled') buttons = [[{ text: '🔧 Взять в работу', callback_data: 'status:in_progress:' + order.id }]];
  const report = validReportUrl(reportUrl);
  if (report) buttons.push([{ text: 'Перейти к отчёту', url: report }]);
  return { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } };
}

function createManagerHandlers(options = {}) {
  const materials = options.materials || require('./order-materials');
  const queries = options.queries || require('../db/queries');
  const pool = options.pool || require('../db/pool');
  const getTelegram = options.getTelegram || (() => require('../bot/instance').telegram);
  const format = options.format || require('../bot/formatter').formatOrderMessage;
  const attachOrOrder = options.attachOrOrder || (data => require('../bot/egrn').attachOrOrder(data));
  const withOrderLock = options.withOrderDeliveryLock || require('../db/order-delivery-lock').createOrderDeliveryLock(pool, options.orderLockOptions);
  const loadReportLink = options.loadOrderReportLink || (id => require('./order-report-link').loadOrderReportLink(id, { pool }));
  const recent = new Map();

  async function currentAccess(req, order) {
    let row;
    try { row = (await pool.query(`SELECT s.*,o.id AS access_order_id,o.submitted_by AS order_submitted_by FROM staff s
      LEFT JOIN orders o ON o.id=$2 WHERE s.tg_id=$1 AND s.approved IS TRUE`, [req.tgUser.id, order?.id ?? null])).rows[0]; }
    catch (_) { throw Object.assign(new Error('Не удалось проверить текущий доступ к заявке. Повторите проверку позднее.'), { status: 503, code: 'ORDER_PACKET_ACCESS_UNAVAILABLE', response: { error_code: 403 } }); }
    if (!row || order && (!row.access_order_id || row.role !== 'manager' && String(row.order_submitted_by) !== String(req.tgUser.id))) {
      // This is a known refusal before transport, so the durable Telegram
      // protocol may safely retry after access is restored, without unknown ACK.
      throw Object.assign(new Error('Доступ к заявке изменился. Проверьте доступ и откройте форму заново.'), { status: 403, code: 'ORDER_PACKET_FORBIDDEN', response: { error_code: 403 } });
    }
    req.staff = row;
  }

  function guardedTelegram(req, order) {
    const telegram = getTelegram();
    return new Proxy(telegram, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (!['sendMessage', 'editMessageText', 'sendDocument'].includes(key)) return value.bind(target);
      return async (...args) => { await currentAccess(req, order); return value.apply(target, args); };
    } });
  }

  async function publishEgrnNotice(order, egrn, telegram, text) {
    const chat = String((typeof options.groupId === 'function' ? options.groupId() : options.groupId) ?? process.env.GROUP_CHAT_ID);
    const category = ['ordered', 'waiting'].includes(egrn.result) ? 'pending' : egrn.result;
    const key = createHash('sha256').update(JSON.stringify([chat, String(order.telegram_msg_id), egrn.cad, category])).digest('hex');
    const unknown = 'Отправка служебного сообщения о ЕГРН не подтверждена. Проверьте рабочий чат; автоматический повтор этого сообщения остановлен.';
    const row = (await pool.query("SELECT telegram_delivery->'egrn_notices'->$2 AS notice FROM orders WHERE id=$1", [order.id, key])).rows[0];
    if (!row) throw new Error('Заявка больше недоступна.');
    if (row.notice?.state === 'confirmed') return;
    if (row.notice && row.notice.state !== 'rejected') return unknown;
    const token = randomUUID(), intent = { state: 'sending', token, chat, started_at: new Date().toISOString() };
    const claimed = await pool.query(`UPDATE orders SET telegram_delivery=COALESCE(telegram_delivery,'{}'::jsonb)||jsonb_build_object('egrn_notices',
      COALESCE(telegram_delivery->'egrn_notices','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb))
      WHERE id=$1 AND COALESCE(telegram_delivery->'egrn_notices'->$2->>'state','') IN ('','rejected') RETURNING id`, [order.id, key, JSON.stringify(intent)]);
    if (!claimed.rows.length) return unknown;
    const checkpoint = async slot => {
      const saved = await pool.query(`UPDATE orders SET telegram_delivery=jsonb_set(telegram_delivery,ARRAY['egrn_notices',$2],$3::jsonb)
        WHERE id=$1 AND telegram_delivery->'egrn_notices'->$2->>'token'=$4 RETURNING id`, [order.id, key, JSON.stringify(slot), token]);
      if (!saved.rows.length) throw new Error('Не удалось подтвердить служебное сообщение.');
    };
    let sent;
    try {
      sent = await telegram.sendMessage(chat, text, { reply_to_message_id: order.telegram_msg_id, disable_notification: true });
      const receipt = require('./order-telegram-delivery').messageId(sent?.message_id);
      const matchingChat = sent?.chat == null || (chat.startsWith('@') ? String(sent.chat.username || '').toLowerCase() === chat.slice(1).toLowerCase() : String(sent.chat.id) === chat);
      if (!receipt || String(receipt) === String(order.telegram_msg_id) || !matchingChat) throw new Error('Telegram не подтвердил служебное сообщение.');
    } catch (error) {
      const code = error?.response?.error_code, rejected = Number.isSafeInteger(code) && code >= 400 && code < 500;
      try { await checkpoint({ ...intent, state: rejected ? 'rejected' : 'unknown' }); } catch (_) { return unknown; }
      return rejected ? 'Telegram отклонил служебное сообщение о ЕГРН. Повторите проверку доставки позднее.' : unknown;
    }
    try { await checkpoint({ ...intent, state: 'confirmed', message_id: Number(sent.message_id) }); } catch (_) { return unknown; }
  }

  async function read(req, res) {
    try {
      await materials.ensureOrderMaterials();
      const order = await queries.getOrderById(orderId(req.params.id));
      if (!order) return res.status(404).json({ ok: false, error: 'Заявка не найдена.' });
      const packet = {};
      for (const field of ['id', 'address', 'owner_name', 'object_type', 'object_name', 'service', 'cad_num', 'archive_url', 'zones_info', 'contacts', 'deadline', 'has_video', 'submitted_name', 'status', 'packet_revision']) packet[field] = order[field] == null ? '' : order[field];
      res.set('Cache-Control', 'no-store').json({ ok: true, order: packet, materials: await materials.listOrderMaterials(order.id), can_edit: canEditPacket(order, req) });
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'Не удалось загрузить заявку.' }); }
  }

  async function savePacket(req, res) {
    let order, key, signature, ownsRecent = false, savedRevision, replayed = false, saved = false;
    const edit = req.params.id != null;
    const finish = (body, status = 200) => {
      // Only coalesce active requests in memory. Completed retries must read
      // their durable receipt and the current packet before resuming delivery.
      if (key && ownsRecent) recent.delete(key);
      return res.status(status).json(body);
    };
    try {
      await materials.ensureOrderMaterials();
      let existing = [];
      if (edit) {
        order = await queries.getOrderById(orderId(req.params.id));
        if (!order) return finish({ ok: false, error: 'Заявка не найдена.' }, 404);
        await currentAccess(req, order);
        existing = await materials.listOrderMaterials(order.id);
      } else await currentAccess(req);
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
        const result = await queries.updateOrderPacketWithMaterials(order.id, data, prepared, { actorId: req.tgUser.id, actorName: req.staff.name, submitId: sid, signature, expectedRevision: req.body.packet_revision, requiredStaffId: req.tgUser.id });
        order = result.order; savedRevision = result.saved_revision; replayed = result.replayed;
      } else {
        order = await queries.createOrderWithMaterials({ ...data, submitted_by: req.tgUser.id }, prepared, { requiredStaffId: req.tgUser.id });
        // Creation is revision 1 even when a late duplicate returns a row that
        // another manager has already edited. The old form must not inherit it.
        savedRevision = 1; replayed = Number(order.packet_revision) > 1;
        if (!order.submitted_name) {
          order.submitted_name = req.staff.name;
          await pool.query('UPDATE orders SET submitted_name=$1 WHERE id=$2 AND submitted_name IS NULL', [req.staff.name, order.id]);
        }
      }
      saved = true;

      const publish = async () => {
      order = await queries.getOrderById(order.id);
      if (!order) throw Object.assign(new Error('Заявка не найдена.'), { status: 404 });
      await currentAccess(req, order);
      const telegram = guardedTelegram(req, order);
      const delivery = options.telegramDelivery || require('./order-telegram-delivery').createOrderTelegramDelivery({ pool, telegram, groupId: options.groupId, ready: materials.ensureOrderMaterials });
      const warnings = [];
      if (replayed && savedRevision !== Number(order.packet_revision)) warnings.push('Ваше сохранение подтверждено. После него заявку изменил другой менеджер; доставка использует актуальные данные.');
      let card;
      try {
        const report = await loadReportLink(order.id);
        card = await delivery.publishCard(order, format(order), cardOptions(order, report?.url));
        if (card.message_id) order.telegram_msg_id = card.message_id;
        if (!card.ok) warnings.push(card.warning);
        if (card.created) {
          try { await queries.addLog(order.id, 'created', req.staff.name, 'Заявка и материалы сохранены; карточка отправлена в чат'); }
          catch (error) { console.error('order card log:', error.message); }
        }
      } catch (e) { if (['ORDER_PACKET_FORBIDDEN', 'ORDER_PACKET_ACCESS_UNAVAILABLE'].includes(e.code)) throw e; console.error('order card delivery:', e.message); warnings.push('Не удалось проверить или обновить доставку карточки. Повторите проверку позднее.'); }
      if (order.telegram_msg_id && card?.usable !== false) {
        for (const file of await materials.listOrderMaterials(order.id, true)) {
          if (file.telegram_msg_id) continue;
          try {
            const manual = await require('../bot/manual-order-attachments').manualMaterialDeliveryState(pool, order.id, file.id);
            if (manual?.stage === 'sending') { warnings.push('Отправка файла «' + file.name + '» ранее началась в боте, но не подтверждена. Проверьте чат и используйте повтор у исходного вложения.'); continue; }
            if (manual?.stage === 'sent') {
              if (Number.isSafeInteger(Number(manual.group_message_id)) && Number(manual.group_message_id) > 0) await materials.markOrderMaterialDelivered(order.id, file.id, Number(manual.group_message_id));
              else warnings.push('Не удалось подтвердить прежнюю отправку файла «' + file.name + '». Проверьте исходное вложение в боте.');
              continue;
            }
            const sent = await delivery.publishMaterial(order, file);
            if (!sent.ok) warnings.push('Файл «' + file.name + '»: ' + sent.warning);
          } catch (e) { console.error('order document delivery:', e.message); warnings.push('Не удалось проверить доставку файла «' + file.name + '». Повторите проверку позднее.'); }
        }
        const orderEgrn = data.egrn_order === true || data.egrn_order === '1' || data.egrn_order === 'true';
        const sameCad = data.cad_num === String(order.cad_num || '');
        if (orderEgrn && !sameCad) warnings.push('Кадастровый номер в заявке изменился. Проверьте его перед заказом ЕГРН; повторный платный заказ не создавался.');
        // Проверка безопасна и для повтора: ЕГРН хранит заказ и квитанции доставки.
        // Номер и карточка могли сохраниться до временной ошибки прошлого запроса.
        if (order.cad_num && sameCad) {
          try {
            await currentAccess(req, order);
            const egrn = await attachOrOrder({ cad: order.cad_num, label: [order.owner_name, order.object_name].filter(Boolean).join(' · '), order: orderEgrn,
              requestKey: 'manager-order:' + order.id + ':' + order.cad_num,
              orderedBy: req.tgUser.id, orderedName: req.staff.name,
              targets: [{ chat: Number(process.env.GROUP_CHAT_ID), reply: order.telegram_msg_id, order_id: order.id }], note: 'Для заявки на замер #' + order.id });
            if (egrn.packet_warning) warnings.push(egrn.packet_warning);
            if (orderEgrn && egrn.result === 'none') warnings.push('Выписка ЕГРН не заказана: сервис сейчас недоступен. Повторите доставку позднее.');
            if (['unavailable', 'failed'].includes(egrn.result)) warnings.push('Доставка выписки ЕГРН остановлена. Требуется проверить заказ; повторный платный заказ не создавался.');
            if (['uncertain', 'unknown'].includes(egrn.result) && !egrn.packet_warning) warnings.push('Результат заказа ЕГРН не подтверждён. Требуется проверка у поставщика; повторный платный заказ не создавался.');
            const notes = { unavailable: '⚠️ Доставка ранее заказанной выписки остановлена. Повторный заказ не создан.', attached: '📄 Выписка ЕГРН приложена к заявке', ordered: '⏳ Выписка ЕГРН заказана — придёт ответом на заявку', waiting: '⏳ Выписка ЕГРН уже в работе — придёт ответом на заявку' };
            if (notes[egrn.result]) {
              const warning = await publishEgrnNotice(order, egrn, telegram, notes[egrn.result] + ' (' + egrn.cad + ')');
              if (warning) warnings.push(warning);
            }
          } catch (e) { console.error('egrn for order:', e.message); warnings.push('Не удалось проверить доставку выписки ЕГРН.'); }
        }
      }
      finish({ ok: true, id: order.id, packet_revision: savedRevision, current_revision: Number(order.packet_revision), replayed, warning: warnings.length ? 'Заявка #' + order.id + ' и документы сохранены. ' + warnings.join(' ') + ' Новая заявка при повторе не создастся.' : undefined });
      };
      return edit ? await publish() : await withOrderLock(order.id, publish);
    } catch (e) {
      console.error('api/order error:', e.message);
      if (['ORDER_PACKET_FORBIDDEN', 'ORDER_PACKET_ACCESS_UNAVAILABLE'].includes(e.code) && saved) return finish({ ok: true, id: order.id, packet_revision: savedRevision, current_revision: Number(order.packet_revision), replayed,
        warning: 'Заявка #' + order.id + ' и документы сохранены. Текущий доступ не подтверждён; дальнейшая доставка остановлена. Проверьте доступ перед повтором этой же заявки.' });
      finish({ ok: false, id: order && order.id, error: e.message, code: e.code, packet_revision: e.packet_revision, busy: e.busy }, e.status || 400);
    }
  }
  async function save(req, res) {
    if (req.params.id == null) return savePacket(req, res);
    try { return await withOrderLock(orderId(req.params.id), () => savePacket(req, res)); }
    catch (error) { return res.status(error.status || 500).json({ ok: false, error: error.message, code: error.code, busy: error.busy }); }
  }
  return { read, save };
}

function setupManagerOrders(app, options = {}) {
  const limits = Object.assign({ files: 20, fileBytes: 12 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, fields: 64, fieldBytes: 64 * 1024 }, options.uploadLimits);
  const storage = require('./bounded-memory-storage').boundedMemoryStorage({ totalBytes: limits.totalBytes });
  const upload = multer({ storage, limits: { fileSize: limits.fileBytes, files: limits.files, fields: limits.fields, fieldSize: limits.fieldBytes, parts: limits.files + limits.fields + 1 } });
  const parse = (req, res, next) => upload.array('files', limits.files)(req, res, err => {
    if (err) {
      storage.cleanup(req, err);
      if (!req.destroyed) req.resume();
      if (req.aborted || res.destroyed || req.destroyed && err.code === 'UPLOAD_ABORTED') return;
      const message = err.code === 'LIMIT_TOTAL_FILE_SIZE' ? 'Общий объём документов заявки не должен превышать 100 МБ.' :
        /^LIMIT_(?:FIELD|PART)/.test(err.code || '') ? 'В форме слишком много текста или полей. Сократите текст и повторите отправку.' :
        /^LIMIT_/.test(err.code || '') ? 'Можно добавить до 20 файлов, каждый не больше 12 МБ.' : 'Загрузка прервалась. Повторите отправку файлов.';
      return res.status(/^LIMIT_/.test(err.code || '') ? 413 : 400).json({ ok: false, error: message });
    }
    storage.complete(req);
    // Браузеры передают filename в UTF-8, а Multer 1.x читает его как Latin-1.
    for (const file of req.files || []) {
      if (!/^[\x00-\xff]*$/.test(file.originalname)) continue;
      const bytes = Buffer.from(file.originalname, 'latin1'), decoded = bytes.toString('utf8');
      if (Buffer.from(decoded, 'utf8').equals(bytes)) file.originalname = decoded;
    }
    next();
  });
  const handlers = createManagerHandlers();
  // requireStaff is installed for /api/order before these routes.
  app.get('/api/order/access', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));
  app.get('/api/order/:id', handlers.read);
  app.post('/api/order', parse, handlers.save);
  app.post('/api/order/:id', parse, handlers.save);
}

module.exports = { setupManagerOrders, createManagerHandlers, canEditPacket, cardOptions };
