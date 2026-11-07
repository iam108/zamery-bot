const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const { createHandoffSubmitter } = require('../src/web/handoff-submit');
const { getSessionLockPool, closeSessionLockPool } = require('../src/db/session-lock-pool');

test('ten simultaneous handoffs keep nested packet, material and EGRN queries moving on a one-slot SQL pool', { timeout: 2500 }, async () => {
  const clients = [], cases = new Map();
  let sequence = 1, nestedQueries = 0, copies = 0, cards = 0;
  class SyntheticClient extends EventEmitter {
    constructor(options) { super(); this.options=options; this._queryable=true; this._ending=false; clients.push(this); }
    connect(callback) { queueMicrotask(()=>callback()); }
    ref() {}
    unref() {}
    end(callback) { this._ending=true; queueMicrotask(()=>{ this.emit('end'); callback?.(); }); }
    query(sql, params, callback) {
      if (typeof params === 'function') { callback=params; params=undefined; }
      let rows=[];
      if (sql.includes('pg_try_advisory_lock')) rows=[{locked:true}];
      else if (sql.startsWith('SELECT * FROM cases WHERE created_by=')) rows=[...cases.values()].filter(c=>c.created_by===params[0]&&c.handoff_submit_id===params[1]);
      else if (sql.startsWith('SELECT * FROM cases WHERE order_id=')) rows=[...cases.values()].filter(c=>c.order_id===params[0]);
      else if (sql.startsWith('SELECT tg_id,name FROM staff')) rows=[{tg_id:808,name:'Юрист проверки'}];
      else if (sql.startsWith('SELECT tg_id,role,approved FROM staff')) rows=[{tg_id:101,role:'manager',approved:true}];
      else if (sql.startsWith('SELECT c.lawyer_tg_id')) { const c=cases.get(params[0]);if(c)rows=[{lawyer_tg_id:c.lawyer_tg_id,tg_id:808,role:'lawyer',approved:true,actor_role:'manager',actor_approved:true}]; }
      else if (sql.startsWith('INSERT INTO cases(')) {
        const state=JSON.parse(params[20])._handoff, c={id:sequence++,order_id:params[0],lawyer_tg_id:params[1],lawyer_name:params[2],checklist_key:params[3],
          ...state.fields,created_by:params[15],contacts:JSON.parse(params[16]),handoff_submit_id:params[18],handoff_signature:params[19],data:{_handoff:state}};
        cases.set(c.id,c);rows=[c];
      } else if (sql.startsWith('UPDATE cases SET data=jsonb_set')) cases.get(params[1]).data={_handoff:JSON.parse(params[0])};
      else if (sql==='SELECT nested_business_query') nestedQueries++;
      const result={rows};
      if (callback) { setImmediate(()=>callback(null,result)); return; }
      return Promise.resolve(result);
    }
  }
  const pool=new Pool({Client:SyntheticClient,max:1,connectionTimeoutMillis:300,idleTimeoutMillis:20,allowExitOnIdle:true});
  const nested=()=>pool.query('SELECT nested_business_query');
  const submit=createHandoffSubmitter({pool,webappUrl:'https://bot.example',pickChecklist:()=> 'MSK_OBSH',
    packetService:{async packet({order_id,report_id,report_src}) { await nested(); return {signature:'a'.repeat(64),order:{id:order_id},report:{id:report_id,src:report_src,text:'Аудит завершён',status:'ready'},materials:[]}; }},
    async loadReport() { return {chat_id:'-1001111111111',msg_ids:[123]}; },
    telegram:{async sendMessage(){cards++;return {message_id:1000+cards};},async callApi(){copies++;return [{message_id:2000+copies}];}},
    async materialDelivery(){await nested();return {ok:true};},
    async attachEgrn(){await nested();return {result:'none'};}});
  try {
    const results=await Promise.all(Array.from({length:10},(_,index)=>submit({
      user:{id:101},staff:{role:'manager',approved:true,name:'Менеджер'},
      body:{handoff_version:2,submit_id:randomUUID(),packet_signature:'a'.repeat(64),order_id:index+1,report_src:'a',report_id:15,
        lawyer_tg_id:808,org:'ООО Проверка '+index,address:'Москва, Лесная, 5',region:'МСК',kind:'Общепит',service:'Продление',
        priority:'обычный',cad_num:'77:01:0004016:1064',contacts:[{name:'Контакт',phone:'+79991234567'}],egrn_order:false}})));
    assert.ok(results.every(result=>result.delivery_complete===true));
    assert.equal(cases.size,10);assert.equal(cards,10);assert.equal(copies,10);assert.equal(nestedQueries,30);
    assert.equal(pool.waitingCount,0);
    assert.ok(clients.some(client=>client.options.max===1),'Business queries use the original pool');
    assert.ok(clients.some(client=>client.options.max===2),'Session locks use a separate bounded pool');
    assert.equal(getSessionLockPool(pool),getSessionLockPool(pool),'Audit and handoff callers share one lock pool');
    assert.ok([...cases.values()].every(c=>c.data._handoff.completed===true));
  } finally { await closeSessionLockPool(pool); await pool.end(); }
  assert.ok(clients.every(client=>client._ending),'Test cleanup closes both owned pools');
});
