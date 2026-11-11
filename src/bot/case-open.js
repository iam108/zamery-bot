'use strict';

const { STAGES } = require('../checklists');
const NOT_AVAILABLE = 'Клиент недоступен. Проверьте номер и доступ к рабочему аккаунту.';
const SQL = `SELECT c.id,c.order_id,c.lawyer_tg_id,c.org,c.address,c.kind,c.service,c.data->>'_stage' AS stage,
  c.data#>'{_handoff,version}' AS handoff_version,c.data#>>'{_handoff,body,order_id}' AS selected_order_id,
  c.data#>>'{_handoff,body,report_src}' AS report_src,c.data#>>'{_handoff,body,report_id}' AS report_id,
  c.data#>'{_handoff,body}' IS NOT NULL AND c.data#>'{_handoff,body}'<>'null'::jsonb AS has_selection,
  o.object_name,s.tg_id AS actor_id,s.role AS actor_role,s.approved AS actor_approved,a.id AS latest_audit_id
FROM cases c JOIN staff s ON s.tg_id=$2 AND s.approved=true LEFT JOIN orders o ON o.id=c.order_id
LEFT JOIN LATERAL (SELECT id FROM audits WHERE order_id=c.order_id ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 1) a ON true
WHERE c.id=$1`;
function positive(value,max=Number.MAX_SAFE_INTEGER) {
  return (typeof value==='number'||typeof value==='string'&&/^[1-9]\d*$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=max?Number(value):null;
}
function text(value,limit=500) {
  const clean=typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').trim():'';
  return clean.length>limit?clean.slice(0,limit-1).replace(/[\uD800-\uDBFF]$/,'')+'…':clean;
}
function selection(row) {
  const order=positive(row.order_id,2147483647);
  if(row.handoff_version===2) {
    const report=positive(row.report_id,2147483647);
    const matches=order?positive(row.selected_order_id,2147483647)===order:row.order_id==null&&row.selected_order_id==null;
    return matches&&report&&['a','r'].includes(row.report_src)?{order,report,src:row.report_src}:null;
  }
  // An unknown/corrupt saved selection must never be silently replaced with
  // a newer report. Only an old case with no selection uses the current audit.
  if(row.has_selection||!order)return null;
  const report=positive(row.latest_audit_id,2147483647);return report?{order,report,src:'a',legacy:true}:null;
}
function urls(baseValue,caseId,report) {
  const base=new URL(baseValue);
  if(base.protocol!=='https:'||base.username||base.password)throw new Error('Invalid WebApp base');
  const make=(pathname,params)=>{const url=new URL(pathname,base);url.search=new URLSearchParams(params).toString();if(url.origin!==base.origin)throw new Error('Invalid WebApp origin');return url.href;};
  const buttons=[[{text:'📋 Чек-лист клиента',web_app:{url:make('/checklist',{case_id:String(caseId)})}}]];
  if(report)buttons[0].push({text:'Перейти к отчёту',web_app:{url:make('/handoff',{view:'report',...(report.order?{order_id:String(report.order)}:{case_id:String(caseId)}),report_src:report.src,report_id:String(report.report)})}});
  buttons.push([{text:'Документы клиента',web_app:{url:make('/handoff',{case_id:String(caseId),view:'documents'})}}]);
  return {disable_web_page_preview:true,reply_markup:{inline_keyboard:buttons}};
}
function createCaseOpener(options={}) {
  const pool=options.pool||require('../db/pool'),auth=options.auth||require('../web/auth');
  return async function open(ctx,value) {
    if(ctx.chat?.type!=='private')return;
    const caseId=positive(value,2147483647),actor=positive(ctx.from?.id);
    if(!caseId||!actor)return ctx.reply(NOT_AVAILABLE);
    let card;
    try {
      const row=(await pool.query(SQL,[caseId,actor])).rows[0];
      const staff=row&&{tg_id:row.actor_id,role:row.actor_role,approved:row.actor_approved};
      if(row&&auth.canAccessCase(staff,actor,row)) {
        const lines=['📂 Клиент #'+caseId,'Организация: '+(text(row.org)||'Не указана')];
        const brand=text(row.object_name);if(brand&&brand!==text(row.org))lines.push('Объект: '+brand);
        lines.push('Адрес: '+(text(row.address)||'Не указан'));
        const kind=[text(row.kind,100),text(row.service,100)].filter(Boolean).join(' · ');if(kind)lines.push(kind);
        lines.push('Этап: '+(STAGES.includes(row.stage)?row.stage:'Сбор документов'),'','Открыть этого клиента: https://t.me/LRSZamer_bot?start=case_'+caseId);
        card={text:lines.join('\n'),extra:urls(options.webappUrl??process.env.WEBAPP_URL,caseId,selection(row))};
      }
    } catch (_) { /* Do not disclose existence, names, raw errors or credentials. */ }
    if(!card)return ctx.reply(NOT_AVAILABLE);
    // Only the requesting private chat receives this small navigation card.
    // Inline WebApps use Telegram initData, never somebody else's u/k key.
    return ctx.reply(card.text,card.extra);
  };
}
function setupCaseOpen(bot,options={}) {
  const open=createCaseOpener(options);
  bot.command('case',ctx=>{const match=String(ctx.message?.text||'').match(/^\/case(?:@[a-z\d_]+)?\s+([1-9]\d*)\s*$/i);return open(ctx,match?.[1]);});
  return open;
}
module.exports={createCaseOpener,setupCaseOpen,NOT_AVAILABLE};
