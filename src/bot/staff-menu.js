'use strict';

// A per-chat menu is a recoverable entry point, never a shared credential.
// Omitting chatId would change Telegram's GLOBAL menu; reject it before API I/O.
function privateId(value) {
  if (!['number','string'].includes(typeof value) || !/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) return null;
  return String(Number(value));
}
function createStaffMenu(options = {}) {
  const pool=options.pool||require('../db/pool'),auth=options.auth||require('../web/auth'),telegram=options.telegram;
  const now=options.now||Date.now,wait=options.wait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const interval=options.intervalMs??1000,timeout=options.timeoutMs??10000,logger=options.logger||console;
  if (!Number.isSafeInteger(interval)||interval<1000||interval>60000||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000) throw new TypeError('Invalid staff menu timing');
  let tail=Promise.resolve(),nextAt=0,syncJob;
  const pending=new Map();
  function log(code) { try { logger.error?.('staff menu:',code); } catch (_) {} }
  function failed(code) { log(code);return {state:'failed',code}; }
  function formUrl(id) {
    const base=new URL(options.webappUrl??process.env.WEBAPP_URL);
    if (base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/') throw new Error('STAFF_MENU_CONFIG');
    const url=new URL('/form',base),key=new URLSearchParams(auth.keyQuery(id));
    if (key.get('u')!==id||!key.get('k')) throw new Error('STAFF_MENU_CONFIG');
    url.search=key.toString();return url.href;
  }
  async function available(id) {
    const result=await pool.query('SELECT tg_id FROM staff WHERE tg_id=$1 AND approved IS TRUE',[id]);
    return result.rows.some(row=>privateId(row.tg_id)===id);
  }
  async function setMenu(id,url) {
    let timer;
    const request=Promise.resolve().then(()=>telegram.setChatMenuButton({chatId:Number(id),menuButton:{type:'web_app',text:'📋 Новая заявка',web_app:{url}}}));
    try {
      const result=await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Staff menu timeout'),{code:'STAFF_MENU_TIMEOUT'})),timeout);})]);
      if(result!==true)throw Object.assign(new Error('Staff menu acknowledgement missing'),{code:'STAFF_MENU_UNCONFIRMED'});
    } finally { clearTimeout(timer); }
  }
  async function update(id) {
    try {
      await auth.ensureStaff();
      for(let attempt=0;attempt<3;attempt++) {
        const delay=nextAt-now();if(delay>0)await wait(delay);
        if(!await available(id))return {state:'skipped',code:'STAFF_MENU_NOT_APPROVED'};
        const url=formUrl(id);nextAt=now()+interval;
        try { await setMenu(id,url);return {state:'updated'}; }
        catch(error) {
          const retry=error?.response?.parameters?.retry_after;
          if(error?.response?.error_code===429&&Number.isSafeInteger(retry)&&retry>=1&&retry<=30&&attempt<2){await wait((retry+1)*1000);continue;}
          const code=Number.isInteger(error?.response?.error_code)?'TELEGRAM_'+error.response.error_code:['STAFF_MENU_TIMEOUT','STAFF_MENU_UNCONFIRMED'].includes(error?.code)?error.code:'STAFF_MENU_API_UNAVAILABLE';
          return failed(code);
        }
      }
    } catch (_) { return failed('STAFF_MENU_ACCESS_OR_CONFIG_UNAVAILABLE'); }
  }
  function refresh(value) {
    const id=privateId(value);
    if(!id)return Promise.resolve({state:'skipped',code:'STAFF_MENU_INVALID_PRIVATE_CHAT'});
    if(pending.has(id))return pending.get(id);
    const task=tail.then(()=>update(id));
    tail=task.catch(()=>{});
    pending.set(id,task);task.finally(()=>pending.delete(id)).catch(()=>{});return task;
  }
  function syncApproved() {
    if(syncJob)return syncJob;
    syncJob=(async()=>{
      const counts={updated:0,skipped:0,failed:0};let after='0';
      try {
        await auth.ensureStaff();
        for(;;){
          const result=await pool.query('SELECT tg_id FROM staff WHERE approved IS TRUE AND tg_id>$1 ORDER BY tg_id LIMIT 100',[after]);
          if(!result.rows.length)break;
          for(const row of result.rows){const status=await refresh(row.tg_id);counts[status.state]++;}
          const last=String(result.rows.at(-1).tg_id);
          if(!/^\d{1,19}$/.test(last)||BigInt(last)<=BigInt(after))throw new Error('Nonadvancing staff cursor');
          after=last;if(result.rows.length<100)break;
        }
      } catch (_) { counts.failed++;log('STAFF_MENU_SYNC_UNAVAILABLE'); }
      return counts;
    })().finally(()=>{syncJob=null;});
    return syncJob;
  }
  return {refresh,syncApproved};
}
const instances=new WeakMap();
function getStaffMenu(bot,options={}) {
  if(!instances.has(bot))instances.set(bot,createStaffMenu({...options,telegram:bot.telegram}));
  return instances.get(bot);
}
module.exports={createStaffMenu,getStaffMenu};
