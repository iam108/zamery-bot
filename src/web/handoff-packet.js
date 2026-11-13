const { createHash } = require('node:crypto');
const { handoffReadiness } = require('./handoff-readiness');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_OR_PDF = /^(?:image\/(?:jpeg|png|webp|gif|heic|heif|avif|tiff|bmp)|application\/pdf)$/;
const INSPECTION_KEYS = new Set(('org address service visit_date floor_plan floor_actual plan_source plan_note structural_elements archive_available archive_match licensed_boundaries_match alcohol_present alcohol_within_licensed within_cadastral entrances_plan entrances_actual all_entrances_checked zones_checked repair_state risks video_status cadastral_count inter_cadastral_boundary rooms_complete kkt_count kkt_ip tobacco_display tobacco_price_list tobacco_advertising').split(' '));
class PacketError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new PacketError(status, code, message); }
function integer(value, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) fail(400, 'INVALID_ID', 'Некорректный номер заявки или отчёта.');
  return Number(value);
}
function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''; }
function groupNotice(state) {
  const notice=object(state.groupNotice);if(notice.required!==true)return null;
  const status=notice.intent||notice.status==='sending'||notice.status==='unknown'?'unknown':['pending','rejected','blocked','confirmed'].includes(notice.status)?notice.status:'unknown';
  const messages={confirmed:'Сводка в чате клиентов опубликована.',pending:'Сводка в чат клиентов ещё не отправлена.',rejected:'Сводку не удалось отправить в чат клиентов. Можно повторить только сводку.',blocked:'Сводка в чат клиентов пока не опубликована. Повторите проверку публикации.',unknown:'Публикация сводки в чате клиентов не подтверждена. Сначала проверьте чат; автоматический повтор остановлен.'};
  return {status,message:messages[status],manual_review:status==='unknown',retry:['pending','rejected','blocked'].includes(status)};
}
function assignmentView(row) {
  if (!row) return null;
  const checkpoint = object(object(row.data)._handoff), profile = require('./handoff-case-profile').savedCaseProfile(row), notice = groupNotice(checkpoint);
  return {case_id:Number(row.id),lawyer_name:text(row.lawyer_name),submit_id:text(row.handoff_submit_id)||null,
    ...(checkpoint.manual_review?{manual_review:true}:{}),...(profile?{profile}:{}),...(notice?{group_notice:notice}:{}),
    ...(checkpoint.version === 2 ? {
      egrn_delivery: egrnDelivery(checkpoint, row.lawyer_tg_id),
      manager_files: (Array.isArray(checkpoint.packet?.manual_materials) ? checkpoint.packet.manual_materials : [])
        .map(({id,name,mime,role,bytes}) => ({id,name,mime,role,bytes})),
      ...(checkpoint.extraDocuments?.completed === true ? {extra_documents_submit_id:checkpoint.extraDocuments.submit_id} : {}),
    } : {}),
    ...(['true','false'].includes(String(checkpoint.completed))?{delivery_complete:String(checkpoint.completed)==='true'&&!require('./handoff-submit').hasPendingLinkedEgrn(checkpoint,row.lawyer_tg_id)}:{})};
}
function egrnDelivery(checkpoint, lawyerId) {
  const state = object(checkpoint.egrn);
  const pendingLinked = require('./handoff-submit').hasPendingLinkedEgrn(checkpoint, lawyerId);
  if (state.uncertain) return {status:'unknown',text:'Доставка ЕГРН требует проверки.'};
  if (pendingLinked || state.completed === false) return {status:'pending',text:'Доставка ЕГРН пока не подтверждена.'};
  if (['included', 'included-links', 'attached'].includes(state.result) && state.completed === true) {
    return {status:'delivered',text:state.result === 'included' ? 'ЕГРН входит в документы заявки.' : 'ЕГРН отправлена в личный чат юриста.'};
  }
  if (['waiting','ordered'].includes(state.result)) return {status:'waiting',text:'Выписка ожидается. Бот пришлёт её юристу после готовности.'};
  if (['none','missing','unavailable','skipped-manual'].includes(state.result)) return {status:'missing',text:'ЕГРН в переданном комплекте отсутствует.'};
  return {status:'unknown',text:'Доставка ЕГРН не подтверждена сохранённой передачей.'};
}
function https(value) {
  try { const url = new URL(text(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
}
function canonical(value) {
  return JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
}
function clientName(value) {
  const name = text(value).replace(/^[\s,:;—–-]+|[\s,:;—–-]+$/g, '')
    .replace(/^(?:контакт(?:ное лицо)?|имя|управляющ(?:ая|ий)|администратор)\s*[:—–-]?\s*/i, '')
    .replace(/\s*[,—–-]?\s*(?:управляющ(?:ая|ий)|администратор)$/i, '').trim();
  if (/аудитор|передал|перед выездом|позвон|связать|телефон|контакт|номер|нужно|звонить/i.test(name)) return '';
  return /^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2}$/u.test(name) ? name : '';
}
// Names and phones come only from the manager's contacts field. Narrative
// provenance ("контакт передала Ирина") is retained as a note, never a name.
function normalizeContacts(input) {
  if (typeof input === 'string' && /^[\s]*[\[{]/.test(input)) { try { input = JSON.parse(input); } catch (_) {} }
  const result = [];
  const add = (name, phone, comment, telegram) => {
    const item = { name: clientName(name), phone: text(phone) };
    const nick = text(telegram).match(/^(?:https?:\/\/t\.me\/|@)?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i);
    if (nick) item.tg = '@' + nick[1];
    if (comment) item.comment = text(comment);
    if (item.name || item.phone || item.comment || item.tg) result.push(item);
  };
  if (Array.isArray(input)) {
    for (const item of input) result.push(...normalizeContacts(item));
  } else if (input && typeof input === 'object') {
    if (/аудитор|auditor/i.test(text(input.role) + ' ' + text(input.name))) return [];
    const name = input.name || input.client || input.contact || '';
    const phone = input.phone || input.tel || input.mobile || input.telephone || '';
    add(name, phone, input.comment || input.note || (!clientName(name) ? name : ''), input.tg || input.telegram || input.username);
  } else {
    const source = text(input); if (!source) return [];
    const lines = source.split(/[\n;]+/).map(line => line.trim()).filter(Boolean);
    let previousName = '', pendingNotes = [];
    for (const line of lines) {
      if (/^\s*аудитор(?=\s|[:—–-]|$)/i.test(line)) continue;
      const clean = line.replace(/(?:контакт\s+передал[аи]?|номер\s+(?:дала|дал|передал[аи]?))[^.!?;\n]*/gi, '').trim();
      const nick = (clean.match(/(?:@|https?:\/\/t\.me\/)([A-Za-z][A-Za-z0-9_]{3,31})\b/i) || [])[1];
      const withoutNick = value => value.replace(/(?:https?:\/\/t\.me\/|@)[A-Za-z][A-Za-z0-9_]{3,31}\b/gi, '');
      const matches = [...clean.matchAll(/(?:\+?\d[\d\s().-]{7,}\d)/g)];
      if (!matches.length) {
        const name = clientName(withoutNick(clean));
        if (name && nick) { add(name, '', pendingNotes.join('\n'), nick); pendingNotes = []; }
        else if (name) previousName = name;
        else if (result.length) result[result.length - 1].comment = [result[result.length - 1].comment, line].filter(Boolean).join('\n');
        else pendingNotes.push(line);
        continue;
      }
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i], before = clean.slice(i ? matches[i - 1].index + matches[i - 1][0].length : 0, match.index);
        const after = clean.slice(match.index + match[0].length, matches[i + 1]?.index ?? clean.length);
        const name = clientName(withoutNick(before)) || clientName(withoutNick(after)) || previousName;
        const note = clean === line && (name && clean.replace(match[0], '').replace(name, '').replace(/[\s,:—–-]/g, '') === '') ? '' : line;
        add(name, match[0], [...pendingNotes, note].filter(Boolean).join('\n'), nick); pendingNotes = [];
        previousName = '';
      }
    }
    if (!result.length && source && !/^\s*аудитор(?=\s|[:—–-]|$)/i.test(source)) add(clientName(source), '', clientName(source) ? '' : source);
  }
  return result.filter((item, index, all) => all.findIndex(other => canonical(other) === canonical(item)) === index);
}
function innFromOrder(order) {
  const direct = text(order.inn); if (/^\d{10}(?:\d{2})?$/.test(direct)) return direct;
  return (text(order.zones_info).match(/(?:^|[^\p{L}\d])ИНН(?:\s+(?:организации|клиента|юридического\s+лица))?\s*[:№-]?\s*(\d{12}|\d{10})(?!\d)/iu) || [])[1] || '';
}
function legalName(value) { return /^(?:ООО|АО|ПАО|НАО|ЗАО|ОАО|ИП|АНО|ФГУП|ГУП|МУП|Общество\s+с\s+ограниченной\s+ответственностью|Индивидуальный\s+предприниматель)(?=\s|[«"'])/i.test(text(value)); }
function orderView(order, data) {
  const kind = text(order.object_type).toLowerCase(), address = text(order.address);
  const org = [order.owner_name,order.object_name,data?.inspection?.org].map(text).find(legalName) || text(order.object_name) || text(order.owner_name);
  return { id: Number(order.id), org, address,
    inn: innFromOrder(order), cad_num: text(order.cad_num), service: text(order.service),
    kind: /табак/.test(kind) ? 'Табак' : /общепит/.test(kind) ? 'Общепит' : /магазин|рознич|торговл/.test(kind) ? 'Магазин' : '',
    region: text(order.region) || (/московская обл|городской округ/i.test(address) ? 'МО' : /москва/i.test(address) ? 'МСК' : ''),
    contacts: normalizeContacts(order.contacts), archive_url: https(order.archive_url) };
}
function materialView(file, orderId) {
  return { id: text(file.id), name: text(file.name), mime: text(file.mime), role: text(file.role), bytes: Number(file.bytes) || 0,
    sha256: text(file.sha256), url: '/api/audit/orders/' + orderId + '/materials/' + encodeURIComponent(text(file.id)) };
}
function savedFiles(data) {
  const result = new Map();
  for (const file of [...(Array.isArray(data.evidence) ? data.evidence : []), ...(Array.isArray(data.documents) ? data.documents : [])]) {
    if (!file || !UUID.test(file.id || '')) continue; // Older Telegram-only reports have no original-file IDs.
    const meta = { id: file.id.toLowerCase(), name: text(file.name), mime: text(file.mime), role: text(file.role), subject_id: text(file.subject_id), sha256: text(file.sha256).toLowerCase() };
    if (file.bytes != null) meta.bytes = Number(file.bytes);
    if (!IMAGE_OR_PDF.test(meta.mime) || !meta.role || !/^[a-f0-9]{64}$/.test(meta.sha256)) fail(409, 'REPORT_FILES_UNVERIFIED', 'Не удалось подтвердить сохранённый состав материалов отчёта.');
    const existing = result.get(meta.id);
    if (existing && ['name', 'mime', 'role', 'subject_id', 'sha256'].some(key => existing[key] !== meta[key])) fail(409, 'REPORT_FILES_CHANGED', 'Сохранённые сведения о материале отчёта расходятся.');
    if (existing && meta.bytes != null && existing.bytes != null && meta.bytes !== existing.bytes) fail(409, 'REPORT_FILES_CHANGED', 'Размер сохранённого материала отчёта изменился.');
    result.set(meta.id, { ...existing, ...meta });
  }
  return [...result.values()];
}
function verifyFile(expected, row) {
  if (!row || ['name', 'mime', 'role', 'subject_id', 'sha256'].some(key => text(row[key]) !== expected[key]) ||
      !Number.isSafeInteger(Number(row.bytes)) || Number(row.bytes) <= 0 || (expected.bytes != null && Number(row.bytes) !== expected.bytes)) {
    fail(409, 'REPORT_FILE_CHANGED', 'Оригинал не совпадает с материалом сохранённого отчёта.');
  }
}
function telegramUrl(row, source) {
  const chat = String(row.chat_id || ''), ids = (row.msg_ids || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  // Structured audits store their summary first, independently of physical
  // delivery order (v3 sends its photos before that summary). Legacy imported
  // reply trees retain their chronological entry point.
  return /^-100\d+$/.test(chat) && ids.length ? 'https://t.me/c/' + chat.slice(4) + '/' + (source === 'a' ? ids[0] : Math.min(...ids)) : '';
}
function reportAddress(data, savedText) {
  return text(data.inspection?.address) || text((String(savedText || '').match(/(?:^|\n)Адрес\s*:\s*([^\n]+)/i) || [])[1]);
}
function safeEgrn(result, cad) {
  const value = { cad_num: cad, status: ['available', 'waiting', 'missing', 'unknown'].includes(result?.status) ? result.status : 'unknown' };
  if (Number.isSafeInteger(Number(result?.file_count)) && Number(result.file_count) >= 0) value.file_count = Number(result.file_count);
  if (result?.available_in === 'materials' || result?.available_in === 'telegram') value.available_in = result.available_in;
  return value;
}

function createPacketService(options = {}) {
  const pool = options.pool || require('../db/pool');
  const evidenceStore = options.evidenceStore || require('./audit-evidence-store').createAuditEvidenceStore();
  const listMaterials = options.listMaterials || (options.materials && (typeof options.materials === 'function' ? options.materials : options.materials.list?.bind(options.materials))) ||
    (async id => (await pool.query('SELECT id,name,mime,role,bytes,sha256 FROM order_materials WHERE order_id=$1 ORDER BY created_at,id', [id])).rows);
  const orderLinks = require('./order-egrn-links').createOrderEgrnLinks({ pool, readOnly: true });
  async function egrnLinks(orderId) {
    if (options.listEgrnLinks) return options.listEgrnLinks(orderId);
    try { return await orderLinks.list(orderId); }
    catch (error) { if (error.code === '42P01') return []; throw error; }
  }
  async function lookupEgrn({ order, materials }) {
    if (materials.some(file => file.role === 'egrn')) return { status: 'available', file_count: materials.filter(file => file.role === 'egrn').length, available_in: 'materials' };
    if (!text(order.cad_num)) return { status: 'missing' };
    try {
      // Read-only readiness. Never import egrn.js (which can order and poll),
      // select provider payloads, generate links, or migrate old originals.
      const row = (await pool.query("SELECT id,status,files_sent,file_msgs,delivery_manifest FROM egrn_orders WHERE cad_num=$1 AND type_doc=$2 AND status<>'failed' AND created_at>NOW()-INTERVAL '30 days' ORDER BY created_at DESC,id DESC LIMIT 1", [text(order.cad_num),'kvarmrusxmlpdf'])).rows[0];
      if (!row) return { status: 'missing' };
      const files = Array.isArray(row.file_msgs) ? row.file_msgs : [], manifest = Array.isArray(row.delivery_manifest) ? row.delivery_manifest : [];
      // Match attachOrOrder's reusable cache exactly: an orphaned S3 file,
      // an older ready order or an incomplete manifest is not a delivery receipt.
      const reusableFiles = row.status === 'done' && files.length > 0 &&
        (Number(row.files_sent)>0 || manifest.length>0 && manifest.every(key=>files.some(file=>(file.key || file.chat + ':' + file.id)===key)));
      if (files.length && (Number(row.files_sent)>0 || reusableFiles)) return { status:'available', file_count:files.length, available_in:'telegram' };
      return { status:['new','ordered','done'].includes(row.status) && Number(row.files_sent)>=0 ? 'waiting' : 'unknown' };
    } catch (_) { return { status: 'unknown' }; }
  }
  async function audit(id) {
    const row = (await pool.query('SELECT * FROM audits WHERE id=$1', [integer(id)])).rows[0];
    if (!row) fail(404, 'REPORT_NOT_FOUND', 'Сохранённый отчёт не найден.');
    return row;
  }
  async function media(row, full = false, onlyId) {
    const data = object(row.report_data), expected = savedFiles(data), draftId = text(row.draft_id || data.source_draft_id);
    if (onlyId && !expected.some(file => file.id === onlyId)) fail(404, 'FILE_NOT_IN_REPORT', 'Этот файл не входит в сохранённый отчёт.');
    if (!expected.length) return [];
    if (!UUID.test(draftId)) fail(409, 'REPORT_SOURCE_MISSING', 'Связь отчёта с оригиналами не сохранена.');
    const wanted = onlyId ? expected.filter(file => file.id === onlyId) : expected;
    const columns = full ? '*' : 'id,name,mime,role,subject_id,bytes,sha256';
    // Intentionally include soft-deleted rows: the immutable saved report,
    // not the latest editable draft, defines which originals belong here.
    const rows = (await pool.query('SELECT ' + columns + ' FROM audit_evidence WHERE draft_id=$1 AND id=ANY($2::uuid[])', [draftId, wanted.map(file => file.id)])).rows;
    return wanted.map(file => {
      const raw = rows.find(item => text(item.id).toLowerCase() === file.id); verifyFile(file, raw);
      return { expected: file, raw };
    });
  }
  async function legacy(id) {
    const report = await require('./legacy-report').loadReportAggregate(pool, integer(id), { workingChatId: options.workingChatId ?? process.env.GROUP_CHAT_ID });
    if (!report) fail(404, 'REPORT_NOT_FOUND', 'Сохранённый отчёт не найден.');
    return report;
  }
  return {
    async packet(query = {}) {
      const requestedOrder = integer(query.order_id, true), reportId = integer(query.report_id, true), src = query.report_src || 'a';
      if (!['a', 'r'].includes(src)) fail(400, 'INVALID_REPORT_SOURCE', 'Неизвестный источник отчёта.');
      let selected = reportId ? await (src === 'a' ? audit(reportId) : legacy(reportId)) : null;
      const orderId = requestedOrder || integer(selected?.order_id, true);
      if (selected?.order_id && Number(selected.order_id) !== orderId) fail(409, 'REPORT_ORDER_MISMATCH', 'Этот отчёт относится к другой заявке.');
      const order = orderId ? (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0] : null;
      if (orderId && !order) fail(404, 'ORDER_NOT_FOUND', 'Заявка не найдена.');
      if (order && !selected && !reportId) selected = (await pool.query('SELECT * FROM audits WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [orderId])).rows[0] || null;
      const materials = order ? (await listMaterials(orderId)).map(file => materialView(file, orderId)) : [];
      const egrn_links = order ? await egrnLinks(orderId) : [];
      const data = object(selected?.report_data), view = order ? orderView(order,data) : null;
      const report = selected ? { id: Number(selected.id), src: reportId ? src : 'a', order_id: integer(selected.order_id, true), text: String(selected.text || ''), created_at: selected.created_at,
        status: text(data.workflow?.conclusion_status), actor: text(data.actor) || text((String(selected.text || '').match(/(?:^|\n)Аудитор\s*:\s*([^\n]+)/i) || [])[1]) || text(selected.author),
        inspection: Object.fromEntries(Object.entries(object(data.inspection)).filter(([key,value]) => INSPECTION_KEYS.has(key) && (value == null || ['string','number','boolean'].includes(typeof value)))),
        address: reportAddress(data, selected.text), video_url: https(Object.hasOwn(object(data.workflow), 'video_url') ? data.workflow.video_url : data.video_url),
        telegram_url: telegramUrl(selected, reportId ? src : 'a'), media: [], linked: Number(selected.linked || 0) } : null;
      if (report?.src === 'a') {
        const { photoCaption } = require('../bot/audit-delivery');
        report.media = (await media(selected)).map(({ expected, raw }) => ({ id: expected.id, name: expected.name, mime: expected.mime, role: expected.role, subject_id: expected.subject_id,
          bytes: Number(raw.bytes), sha256: expected.sha256, caption: photoCaption(expected, orderId, data), url: '/api/handoff/reports/' + report.id + '/files/' + expected.id +
            (!selected.order_id && orderId ? '?order_id=' + orderId : '') }));
        report.readiness = handoffReadiness(data, {videoUrl:report.video_url, videoRequired:order?.has_video === true});
      }
      if (report) report.historical_address_difference = view && report.address && report.address !== view.address ? { report: report.address, order: view.address } : null;
      let readiness;
      try { readiness = order ? await (options.lookupEgrn || lookupEgrn)({ order, materials }) : { status:'missing' }; } catch (_) { readiness = { status: 'unknown' }; }
      let assignment=null;
      if(order){
        try{
          // SELECT * remains compatible with legacy tables without optional checkpoint columns.
          const caseId=integer(query.case_id,true);
          const row=(await pool.query(caseId ? 'SELECT * FROM cases WHERE order_id=$1 AND id=$2' : 'SELECT * FROM cases WHERE order_id=$1 ORDER BY id DESC LIMIT 1',caseId?[orderId,caseId]:[orderId])).rows[0];
          assignment=assignmentView(row);
        }catch(error){if(error.code!=='42P01')throw error;}
      }
      const requestId = integer(query.request_id, true);
      let request = null;
      if (requestId) {
        const original = (await pool.query('SELECT id,text,created_at FROM reports WHERE id=$1', [requestId])).rows[0];
        if (!original) fail(404, 'REQUEST_NOT_FOUND', 'Сохранённая исходная заявка не найдена.');
        request = { id: Number(original.id), text: String(original.text || ''), created_at: original.created_at };
      }
      const signature = createHash('sha256').update(canonical({ order: view, request, egrn_links, report,
        materials: materials.map(({ id,sha256,bytes,name,mime,role }) => ({ id,sha256,bytes,name,mime,role })) })).digest('hex');
      return { ok: true, signature, order: view, request, report, materials, egrn_links, egrn: safeEgrn(readiness, view?.cad_num || ''), archive_url: view?.archive_url || '', assignment };
    },
    async file(auditId, fileId) {
      if (!UUID.test(fileId || '')) fail(400, 'INVALID_FILE_ID', 'Некорректный номер материала.');
      const row = await audit(auditId), files = await media(row, true, fileId.toLowerCase()), file = files[0];
      const buffer = await evidenceStore.read(file.raw);
      return { ...file.expected, bytes: Number(file.raw.bytes), buffer };
    }
  };
}
function disposition(name, download) {
  const clean = text(name).split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0,180) || 'material';
  return (download ? 'attachment' : 'inline') + '; filename="material"; filename*=UTF-8\'\'' + encodeURIComponent(clean).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}
function savedSelection(client, query = {}) {
  const state = object(object(client.data)._handoff), body = object(state.body);
  const orderId = Number(client.order_id) || null, reportId = Number(body.report_id) || null;
  const src = ['a','r'].includes(body.report_src) ? body.report_src : null;
  const order = integer(query.order_id, true), report = integer(query.report_id, true);
  if ((order && order !== orderId) || (report && (report !== reportId || (query.report_src || 'a') !== src)) ||
      (state.version === 2 && (Number(body.order_id) || null) !== orderId)) {
    fail(403, 'CASE_FORBIDDEN', 'Этот отчёт не входит в доступный вам комплект клиента.');
  }
  const snapshot = state.version === 2 && Array.isArray(state.packet?.materials) ? state.packet : null;
  if (snapshot && ((Number(snapshot.order?.id) || null) !== orderId || (Number(snapshot.report?.id) || null) !== reportId || (snapshot.report?.src || null) !== src ||
      (snapshot.report?.order_id && Number(snapshot.report.order_id) !== orderId))) {
    fail(409, 'CASE_PACKET_CHANGED', 'Не удалось подтвердить сохранённый состав передачи.');
  }
  return { state, snapshot, orderId, reportId, src };
}
function casePacket(client, selection, fallback = null) {
  const id = Number(client.id), { snapshot, state, orderId } = selection;
  const prefix = '/api/handoff/cases/' + id;
  const order = snapshot?.order || (orderId ? { id:orderId } : null);
  const report = snapshot?.report || fallback || (text(client.audit_text) ? { text:String(client.audit_text), media:[] } : null);
  const materials = (snapshot?.materials || []).map(file => ({ ...materialView(file, orderId), url:prefix + '/materials/' + file.id }));
  const egrn = state.linkedEgrn?.files || snapshot?.egrn_links;
  const egrn_links = (snapshot && Array.isArray(egrn) ? egrn : []).map(file => ({ ...materialView(file, orderId), role:'egrn', source:file.source, url:prefix + '/egrn/' + file.id + '/link' }));
  const exactReport = report ? { ...report, media:(Array.isArray(report.media) ? report.media : []).map(file => ({ ...file,
    url:'/api/handoff/reports/' + report.id + '/files/' + file.id + '?' + new URLSearchParams({ case_id:id, ...(orderId ? { order_id:orderId } : {}) }) })) } : null;
  return { ok:true, order, report:exactReport, assignment:assignmentView(client), files_known:!!snapshot,
    signature:snapshot?.signature || null, materials, egrn_links, egrn:safeEgrn(snapshot?.egrn, text(snapshot?.egrn?.cad_num || order?.cad_num)), archive_url:https(snapshot?.archive_url) };
}
function fileMatches(expected, actual, keys) {
  return !!actual && keys.every(key => text(expected[key]) === text(actual[key])) && Number(expected.bytes) === Number(actual.bytes) &&
    (!expected.sha256 || text(expected.sha256) === text(actual.sha256));
}
function setupHandoffPacket(app, options = {}) {
  const service = options.service || createPacketService(options);
  const pool = options.pool || require('../db/pool');
  const { canManageCases, canAccessCase } = require('./auth');
  let materialsStore = options.materialsStore, egrnStore = options.orderEgrnLinks;
  async function caseAccess(req, caseId) {
    const actor = req.tgUser?.id;
    const record = (await pool.query('SELECT to_jsonb(c) AS access_case,s.tg_id,s.role,s.approved FROM cases c LEFT JOIN staff s ON s.tg_id=$2 WHERE c.id=$1',[caseId, actor])).rows[0];
    if (!canAccessCase(record, actor, record?.access_case)) fail(403, 'CASE_FORBIDDEN', 'Этот клиент недоступен вашему аккаунту.');
    return { manager:canManageCases(record, actor), client:record.access_case };
  }
  async function authorize(req, orderId, report) {
    // Storage and packet reads can outlive middleware authorization. Resolve
    // the current staff role and current assignment in the same SQL snapshot.
    const record = (await pool.query(`SELECT s.tg_id,s.role,s.approved,to_jsonb(c) AS access_case FROM staff s
      LEFT JOIN LATERAL (SELECT * FROM cases WHERE order_id=$1 AND lawyer_tg_id=$2 ORDER BY id DESC LIMIT 1) c ON true
      WHERE s.tg_id=$2`, [orderId, req.tgUser && req.tgUser.id])).rows[0];
    if (canManageCases(record, req.tgUser && req.tgUser.id)) return {manager:true,client:null};
    const row = record?.access_case;
    if (!canAccessCase(record, req.tgUser && req.tgUser.id, row)) fail(403, 'CASE_FORBIDDEN', 'Этот клиент недоступен вашему аккаунту.');
    if (report && (!report.order_id || Number(report.order_id) !== Number(orderId))) {
      // A manager may explicitly attach a historical unlinked report to a
      // case. Its saved handoff selection is the authority, not a caller's
      // arbitrary combination of their own order with somebody else's report.
      const selection = object(object(object(row.data)._handoff).body);
      if (Number(selection.report_id) !== Number(report.id) || selection.report_src !== report.src)
        fail(403, 'CASE_FORBIDDEN', 'Этот отчёт не входит в переданный вам комплект.');
    }
    return {manager:false,client:row};
  }
  const route = run => async (req,res) => {
    res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff');
    try { await run(req,res); }
    catch (error) { const known = error instanceof PacketError; res.status(known ? error.status : 503).json({ ok:false, code:known ? error.code : 'HANDOFF_PACKET_UNAVAILABLE', error:known ? error.message : 'Не удалось открыть комплект передачи. Повторите попытку.' }); }
  };
  async function scopedFile(req, caseId, group, query = {}) {
    const id = text(req.params.fileId).toLowerCase();
    if (!UUID.test(id)) fail(400, 'INVALID_FILE_ID', 'Некорректный номер материала.');
    const { client } = await caseAccess(req, caseId), selection = savedSelection(client, query);
    const { snapshot, orderId, state } = selection;
    if (group === 'report' && !snapshot) return { orderId, id, expected:null, saved:false };
    const files = group === 'report' ? snapshot.report?.media : group === 'materials' ? snapshot?.materials : snapshot && (state.linkedEgrn?.files || snapshot.egrn_links);
    const expected = Array.isArray(files) && files.find(file => text(file?.id).toLowerCase() === id);
    if (!expected) fail(404, 'FILE_NOT_IN_CASE', 'Этот файл не входит в сохранённый комплект клиента.');
    return { orderId, id, expected, saved:true };
  }
  function verifiedScope(before, after) {
    if (before.orderId !== after.orderId || before.saved !== after.saved || canonical(before.expected) !== canonical(after.expected)) {
      fail(409, 'CASE_PACKET_CHANGED', 'Состав передачи изменился. Откройте комплект ещё раз.');
    }
  }
  function sendOriginal(req, res, file) {
    res.set('Content-Type',file.mime).set('Content-Length',String(file.buffer.length)).set('Content-Disposition',disposition(file.name,req.query.download === '1')).send(file.buffer);
  }
  // These routes must be mounted after setupAuth: the shared /api/handoff
  // requireStaff middleware protects metadata and every original-file request.
  app.get('/api/handoff/packet', route(async (req,res) => {
    const caseId = integer(req.query.case_id, true);
    let packet, access;
    if (caseId) {
      access = await caseAccess(req, caseId);
      const selection = savedSelection(access.client, req.query);
      let fallback = null;
      if (!selection.snapshot && selection.reportId && selection.src) {
        try { fallback = (await service.packet({ order_id:selection.orderId, report_id:selection.reportId, report_src:selection.src })).report; }
        catch (error) { if (!(error instanceof PacketError)) throw error; }
        access = await caseAccess(req, caseId);
        const current = savedSelection(access.client, req.query);
        if (current.reportId !== selection.reportId || current.src !== selection.src || current.orderId !== selection.orderId || current.snapshot) {
          fail(409, 'CASE_PACKET_CHANGED', 'Состав передачи изменился. Откройте комплект ещё раз.');
        }
      }
      packet = casePacket(access.client, selection, fallback);
    } else {
      // Resolve the saved case first when the lawyer follows an order-only link.
      const order = integer(req.query.order_id, true);
      if (order) {
        access = await authorize(req, order, null);
        if (access.client) {
          const selection = savedSelection(access.client);
          if (selection.snapshot) packet = casePacket(access.client, savedSelection(access.client, req.query));
        }
      }
      if (!packet) {
        packet = await service.packet(req.query);
        access = await authorize(req, packet.order && packet.order.id, packet.report);
        if (access.client) {
          const selection = savedSelection(access.client);
          if (selection.snapshot) packet = casePacket(access.client, savedSelection(access.client, req.query));
          else packet = { ...packet, files_known:false, materials:[], egrn_links:[], egrn:safeEgrn(null, packet.order?.cad_num || '') };
        }
      }
    }
    const manager = access.manager;
    // An order may have more than one historical assignment. Client data must
    // come from the explicit case or the lawyer's currently accessible case.
    if(access.client){
      if(Number(access.client.id)!==Number(packet.assignment?.case_id))packet.assignment=assignmentView(access.client);
      else {const profile=require('./handoff-case-profile').savedCaseProfile(access.client);if(profile)packet.assignment.profile=profile;else delete packet.assignment.profile;}
    }
    const documentsCaseId=caseId||packet.assignment?.case_id;
    if(documentsCaseId&&options.caseDocumentsService){
      try{packet.case_documents=await options.caseDocumentsService.list(documentsCaseId,req.tgUser&&req.tgUser.id);}
      catch(error){if(error?.code==='CASE_DOCUMENT_FORBIDDEN'&&[401,403].includes(error.status))fail(error.status,'CASE_FORBIDDEN','Доступ к комплекту клиента изменился.');throw error;}
    }
    if (packet.assignment) packet.assignment.can_resume = manager && !packet.assignment.manual_review &&
      (packet.assignment.delivery_complete === false || packet.assignment.delivery_complete === true && packet.assignment.group_notice?.retry === true);
    if (!manager) delete packet.request;
    res.json(packet);
  }));
  app.get('/api/handoff/reports/:auditId/files/:fileId', route(async (req,res) => {
    const query = { report_id:req.params.auditId, report_src:'a', order_id:req.query.order_id };
    let packet, caseId = integer(req.query.case_id,true);
    if (!caseId) {
      packet = await service.packet(query);
      const access = await authorize(req, packet.order?.id || null, packet.report);
      if (access.client && savedSelection(access.client).snapshot) caseId = Number(access.client.id);
    }
    if (caseId) {
      const scope = await scopedFile(req, caseId, 'report', query);
      if (!scope.saved) {
        packet = await service.packet({ ...query, order_id:scope.orderId });
        if (!packet.report || Number(packet.order?.id || 0) !== Number(scope.orderId || 0)) fail(403, 'CASE_FORBIDDEN', 'Этот отчёт не входит в доступный вам комплект клиента.');
      }
      const file = await service.file(req.params.auditId, scope.id);
      verifiedScope(scope, await scopedFile(req, caseId, 'report', query));
      if (scope.expected && !fileMatches(scope.expected, file, ['id','name','mime','role','subject_id'])) fail(409, 'REPORT_FILE_CHANGED', 'Оригинал не совпадает с материалом сохранённого отчёта.');
      return sendOriginal(req, res, file);
    }
    const file = await service.file(req.params.auditId, req.params.fileId);
    const access = await authorize(req, packet.order?.id || null, packet.report);
    if (access.client && savedSelection(access.client).snapshot) fail(409, 'CASE_PACKET_CHANGED', 'Откройте оригинал из сохранённого комплекта клиента.');
    sendOriginal(req, res, file);
  }));
  app.get('/api/handoff/cases/:caseId/materials/:fileId', route(async (req,res) => {
    const caseId = integer(req.params.caseId), scope = await scopedFile(req, caseId, 'materials');
    materialsStore ||= require('./order-materials').createMaterialsStore(pool);
    let file;
    try { file = await materialsStore.download(scope.orderId, scope.id); }
    catch (error) { if (error.status === 404) fail(404, 'CASE_FILE_UNAVAILABLE', 'Сохранённый документ заявки недоступен.'); throw error; }
    verifiedScope(scope, await scopedFile(req, caseId, 'materials'));
    if (!fileMatches(scope.expected, file, ['id','name','mime','role'])) fail(409, 'CASE_FILE_CHANGED', 'Оригинал не совпадает с сохранённым документом заявки.');
    sendOriginal(req, res, file);
  }));
  app.get('/api/handoff/cases/:caseId/egrn/:fileId/link', route(async (req,res) => {
    const caseId = integer(req.params.caseId), scope = await scopedFile(req, caseId, 'egrn');
    egrnStore ||= require('./order-egrn-links').createOrderEgrnLinks({ pool, readOnly:true });
    let result;
    try {
      const file = await egrnStore.delivery(scope.orderId, scope.id, scope.expected);
      result = file.kind === 'link' ? file : await egrnStore.link(scope.orderId, scope.id);
    } catch (error) {
      if ([404,409].includes(error.status)) fail(error.status, 'CASE_EGRN_UNAVAILABLE', 'Сохранённая выписка недоступна. Проверьте сообщение бота.');
      throw error;
    }
    verifiedScope(scope, await scopedFile(req, caseId, 'egrn'));
    const url = https(result?.url);
    if (!url) fail(503, 'CASE_EGRN_UNAVAILABLE', 'Не удалось получить ссылку на выписку.');
    res.json({ ok:true, url });
  }));
  return service;
}
module.exports = { createPacketService, setupHandoffPacket, normalizeContacts, innFromOrder, assignmentView, PacketError };
