'use strict';

const UI_VERSION = 1, MAX_CASES = 50, EDIT_TIMEOUT_MS = 10000, EDIT_INTERVAL_MS = 150;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const positive = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const CANDIDATES_SQL = `SELECT c.id FROM cases c JOIN staff s ON s.tg_id=c.lawyer_tg_id
  WHERE s.approved IS TRUE AND s.role='lawyer' AND c.checklist_key IS NOT NULL
    AND c.data#>'{_handoff,version}'='2'::jsonb AND c.data#>'{_handoff,completed}'='true'::jsonb
    AND c.data#>'{_handoff,card_ui_version}' IS DISTINCT FROM $1::jsonb
    AND c.data#>>'{_handoff,body,report_src}' IN ('a','r')
    AND c.data#>>'{_handoff,body,report_id}' ~ '^[1-9][0-9]*$'
  ORDER BY c.id LIMIT $2`;
const CURRENT_SQL = `SELECT c.id,c.order_id,c.lawyer_tg_id,c.checklist_key,c.data->'_handoff' AS checkpoint,
  s.tg_id AS staff_id,s.role AS staff_role,s.approved AS staff_approved
  FROM cases c LEFT JOIN staff s ON s.tg_id=c.lawyer_tg_id WHERE c.id=$1`;
const MARK_SQL = `UPDATE cases c SET data=jsonb_set(c.data,'{_handoff,card_ui_version}',$4::jsonb)
  WHERE c.id=$1 AND c.lawyer_tg_id=$2 AND c.data->'_handoff'=$3::jsonb
    AND EXISTS (SELECT 1 FROM staff s WHERE s.tg_id=c.lawyer_tg_id AND s.role='lawyer' AND s.approved IS TRUE)
  RETURNING c.id`;

function target(row) {
  const state=object(row?.checkpoint),body=object(state?.body),report=object(state?.packet?.report);
  if(!positive(row?.id)||!positive(row?.lawyer_tg_id)||!row.checklist_key||String(row.staff_id)!==String(row.lawyer_tg_id)||
    row.staff_approved!==true||row.staff_role!=='lawyer'||state?.version!==2||state.completed!==true||state.card_ui_version===UI_VERSION||
    state.inflight!=null||state.manual_review||!body||!report||body.manual_client===true||!positive(body.report_id)||Number(body.report_id)>2147483647||
    !['a','r'].includes(body.report_src)||String(report.id)!==String(body.report_id)||report.src!==body.report_src)return null;
  const orderMatches=row.order_id==null?body.order_id==null:positive(row.order_id)&&positive(body.order_id)&&Number(row.order_id)===Number(body.order_id);
  const recipients=state.recipients,chat=String(row.lawyer_tg_id),cards=object(state.cards);
  if(!orderMatches||!Array.isArray(recipients)||recipients.length!==1||recipients[0]?.role!=='lawyer'||
    String(recipients[0]?.chat)!==chat||!cards||!positive(cards[chat]))return null;
  return {state,chat,messageId:Number(cards[chat])};
}

async function deadline(run,ms) {
  let timer;
  try {return await Promise.race([Promise.resolve().then(run),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Card edit timeout')),ms);})]);}
  finally {clearTimeout(timer);}
}

// Repairs only previously acknowledged private cards. It never sends a new
// message or restarts a handoff; repeated Telegram edits are idempotent.
function createCaseCardSync(options={}) {
  const pool=options.pool||require('../db/pool');let running;
  const limit=Number.isSafeInteger(options.limit)&&options.limit>0?Math.min(options.limit,MAX_CASES):MAX_CASES;
  const timeout=Number.isFinite(options.editTimeoutMs)&&options.editTimeoutMs>0?options.editTimeoutMs:EDIT_TIMEOUT_MS;
  const pause=options.pause|| (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  async function run() {
    const stats={examined:0,updated:0,unchanged:0,skipped:0,failed:0};
    const rows=(await pool.query(CANDIDATES_SQL,[JSON.stringify(UI_VERSION),limit])).rows;
    const telegram=options.telegram||require('./instance').telegram;
    const cardOptions=options.cardOptions||require('../web/handoff-submit').cardOptions;
    let attempted=false;
    for(const candidate of rows){
      stats.examined++;
      try{
        if(attempted)await pause(EDIT_INTERVAL_MS);
        // Do not rely on the earlier list if assignment/approval changed.
        const row=(await pool.query(CURRENT_SQL,[candidate.id])).rows[0],selected=target(row);
        if(!selected){stats.skipped++;continue;}
        const markup=cardOptions(options.webappUrl||process.env.WEBAPP_URL,row,selected.state)?.reply_markup;
        if(!markup||!Array.isArray(markup.inline_keyboard))throw new Error('Missing card markup');
        let unchanged=false;
        attempted=true;
        try {
          const receipt=await deadline(()=>telegram.editMessageReplyMarkup(selected.chat,selected.messageId,undefined,markup),timeout);
          if(!positive(receipt?.message_id)||Number(receipt.message_id)!==selected.messageId||
            !positive(receipt?.chat?.id)||String(receipt.chat.id)!==selected.chat)throw new Error('Unconfirmed card edit');
        }
        catch(error){
          const code=error?.response?.error_code,description=String(error?.response?.description||'');
          if(code===400&&/message is not modified/i.test(description))unchanged=true;
          else if(code===400&&/message to edit not found|message can't be edited/i.test(description)||code===403){stats.skipped++;continue;}
          else throw error;
        }
        // Preserve unrelated checklist fields. If this exact handoff or its
        // recipient changed in flight, do not label the new state as repaired.
        const saved=await pool.query(MARK_SQL,[row.id,row.lawyer_tg_id,JSON.stringify(selected.state),JSON.stringify(UI_VERSION)]);
        if(!saved.rows.length){stats.skipped++;continue;}
        stats[unchanged?'unchanged':'updated']++;
      }catch(_){stats.failed++;}
    }
    return stats;
  }
  return function sync(){if(!running)running=run().finally(()=>{running=null;});return running;};
}

module.exports={createCaseCardSync,UI_VERSION,MAX_CASES,EDIT_TIMEOUT_MS};
