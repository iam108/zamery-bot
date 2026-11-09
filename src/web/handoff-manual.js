'use strict';

const { canManageCases } = require('./auth');

function error(status, code, message) { return Object.assign(new Error(message), { status, code, case_created:false }); }
function manualClient(body) {
  if (body.manual_client !== undefined && typeof body.manual_client !== 'boolean') throw error(400, 'HANDOFF_MANUAL_INVALID', 'Проверьте режим ручного создания клиента.');
  const manual = body.manual_client === true;
  if (body.manual_files !== undefined && (!Array.isArray(body.manual_files) || body.manual_files.length > 20)) throw error(400, 'HANDOFF_MANUAL_INVALID', 'Проверьте документы ручного клиента.');
  if (manual && (['order_id','request_id','report_id','report_src'].some(key => body[key] != null) || body.egrn_order !== false))
    throw error(400, 'HANDOFF_MANUAL_INVALID', 'Ручной клиент создаётся без заявки, отчёта и операций ЕГРН.');
  if (!manual && body.manual_files?.length) throw error(400, 'HANDOFF_MANUAL_INVALID', 'Документы ручного клиента нельзя добавить в другую передачу.');
  return manual;
}
function normalize(value) { return value.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е'); }
const normalized = column => "translate(lower(regexp_replace(btrim(COALESCE(" + column + ",'')), '[[:space:]]+', ' ', 'g')),'ё','е')";
function createManualMatches(options = {}) {
  const pool = options.pool || require('../db/pool');
  return async function matches(query, actorId) {
    if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) < 1) throw error(403, 'CASE_FORBIDDEN', 'Создавать клиента может менеджер.');
    if (options.ready) await options.ready();
    const actor = (await pool.query('SELECT tg_id,role,approved FROM staff WHERE tg_id=$1', [actorId])).rows[0];
    if (!canManageCases(actor, actorId)) throw error(403, 'CASE_FORBIDDEN', 'Создавать клиента может менеджер.');
    const fields = {};
    for (const key of ['org','address','inn']) {
      const value = query[key] ?? '';
      if (typeof value !== 'string' || value.length > (key === 'inn' ? 12 : 500)) throw error(400, 'HANDOFF_MATCHES_INVALID', 'Проверьте организацию, адрес и ИНН.');
      fields[key] = value.trim();
    }
    if (!fields.address || !fields.org && !fields.inn || fields.inn && !/^\d{10}(?:\d{2})?$/.test(fields.inn)) throw error(400, 'HANDOFF_MATCHES_INVALID', 'Для поиска укажите адрес и организацию или корректный ИНН.');
    const result = (await pool.query(`SELECT found.* FROM staff actor LEFT JOIN LATERAL (
      SELECT c.id,c.org,c.address,c.lawyer_name,COALESCE(c.data->>'_stage','') AS stage,
        CASE WHEN $2<>'' AND btrim(COALESCE(c.inn,''))=$2 THEN 'inn_address' ELSE 'org_address' END AS match_by
      FROM cases c WHERE ${normalized('c.address')}=$1 AND (($2<>'' AND btrim(COALESCE(c.inn,''))=$2) OR ($3<>'' AND ${normalized('c.org')}=$3))
      ORDER BY c.id DESC LIMIT 11
      ) found ON true WHERE actor.tg_id=$4 AND actor.approved IS TRUE AND (actor.role='manager' OR $5::boolean)`,
    [normalize(fields.address),fields.inn,normalize(fields.org),actorId,canManageCases({ approved:true,role:'auditor' },actorId)])).rows;
    // Distinguish an authorized empty search from access lost while awaiting SQL.
    if (!result.length) throw error(403, 'CASE_FORBIDDEN', 'Создавать клиента может менеджер.');
    const rows = result.filter(row => row.id != null);
    return { matches: rows.slice(0,10).map(row => ({ case_id:Number(row.id),org:row.org || '',address:row.address || '',lawyer_name:row.lawyer_name || '',stage:row.stage || '',
      checklist_url:'/checklist?case_id='+Number(row.id),match_by:row.match_by })), has_more:rows.length > 10 };
  };
}
function setupHandoffManual(app, options = {}) {
  const matches = createManualMatches(options);
  app.get('/api/handoff/manual-matches', async (req, res) => {
    if (!canManageCases(req.staff,req.tgUser?.id)) return res.status(403).json({ ok:false,code:'CASE_FORBIDDEN',error:'Создавать клиента может менеджер.' });
    try { return res.json({ ok:true,...await matches(req.query,req.tgUser.id) }); }
    catch (failure) { return res.status(failure.status || 503).json({ ok:false,code:failure.status ? failure.code : 'HANDOFF_MATCHES_UNAVAILABLE',error:failure.status ? failure.message : 'Не удалось проверить похожих клиентов. Повторите проверку.' }); }
  });
}

module.exports = { manualClient, createManualMatches, setupHandoffManual };
