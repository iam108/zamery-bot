const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminOrderStatus } = require('../src/web/admin-order-status');

function fixture(overrides = {}) {
  let locked = false, writes = 0, edits = [], row = { id:58, status:'new', telegram_msg_id:900, address:'Москва, актуальный адрес' };
  const handler = createAdminOrderStatus({
    groupId:-10001,
    loadOrderReportLink: async () => null,
    withOrderDeliveryLock: async (id, run) => { assert.equal(id,58); locked=true; try { return await run(); } finally { locked=false; } },
    queries:{ getOrderById:async () => { assert.equal(locked,true); return row && {...row}; },
      updateOrderStatus:async (id,status,actor) => { assert.equal(locked,true); assert.equal(actor,'admin-web'); writes++; row={...row,status}; return {...row}; } },
    getTelegram:() => ({ editMessageText:async (chat,msg,unused,text,options) => { assert.equal(locked,true); edits.push({chat,msg,text,options}); } }),
    format:order => order.address+' · '+order.status,
    ...overrides,
  });
  const response = () => ({ statusCode:200, status(value) { this.statusCode=value; return this; }, json(value) { this.body=value; return this; } });
  return { handler, response, writes:() => writes, edits, locked:() => locked, missing() { row=null; } };
}

test('admin status and Telegram card change under the same order lock, retry avoids duplicate status logs', async () => {
  const f=fixture(), req={body:{id:58,status:'done'}}, first=f.response();
  await f.handler(req,first);
  assert.equal(first.body.ok,true); assert.equal(f.writes(),1); assert.equal(f.edits.length,1);
  assert.equal(f.edits[0].text,'Москва, актуальный адрес · done');
  assert.match(f.edits[0].options.reply_markup.inline_keyboard[0][0].callback_data,/report:58/);
  await f.handler(req,f.response()); assert.equal(f.writes(),1); assert.equal(f.edits.length,2);
});

test('Telegram failure after admin status save is visible and its retry refreshes the saved card', async () => {
  let fail=true;
  const f=fixture({ getTelegram:() => ({ editMessageText:async () => { if(fail) throw new Error('Synthetic delivery failure'); } }) });
  const req={body:{id:58,status:'in_progress'}}, first=f.response(); await f.handler(req,first);
  assert.equal(first.body.ok,true); assert.match(first.body.warning,/Статус сохранён/);
  fail=false; const retry=f.response(); await f.handler(req,retry);
  assert.equal(retry.body.ok,true); assert.equal(retry.body.warning,undefined); assert.equal(f.writes(),1);
});

test('unchanged Telegram text is a successful admin status refresh', async () => {
  const f=fixture({ getTelegram:() => ({ editMessageText:async () => { throw { response:{description:'Bad Request: message is not modified'} }; } }) });
  const res=f.response(); await f.handler({body:{id:58,status:'new'}},res);
  assert.equal(res.body.ok,true); assert.equal(res.body.warning,undefined); assert.equal(f.writes(),0);
});

test('busy admin update does not write status or emit a false successful response', async () => {
  const f=fixture({ withOrderDeliveryLock:async () => { throw Object.assign(new Error('busy'),{code:'ORDER_DELIVERY_BUSY'}); } });
  const res=f.response(); await f.handler({body:{id:58,status:'done'}},res);
  assert.equal(res.statusCode,409); assert.equal(res.body.ok,false); assert.match(res.body.error,/сейчас обновляется/); assert.equal(f.writes(),0);
});

test('invalid or missing admin order is rejected without Telegram delivery', async () => {
  const f=fixture();
  for(const id of ['58suffix',0,-1,1.2,2147483648]) {
    const res=f.response(); await f.handler({body:{id,status:'done'}},res); assert.equal(res.statusCode,400);
  }
  f.missing(); const res=f.response(); await f.handler({body:{id:58,status:'done'}},res);
  assert.equal(res.statusCode,404); assert.equal(f.writes(),0); assert.equal(f.edits.length,0);
});

test('admin status refresh keeps the latest saved report link across all statuses including cancelled',async()=>{
  for(const status of ['new','in_progress','done','cancelled']){
    let lookups=0;const f=fixture({loadOrderReportLink:async id=>{assert.equal(id,58);assert.equal(f.locked(),true);lookups++;return{url:'https://t.me/c/111111/209'};}}),res=f.response();
    await f.handler({body:{id:58,status}},res);assert.equal(res.body.ok,true);assert.equal(res.body.warning,undefined);assert.equal(lookups,1);
    const buttons=f.edits[0].options.reply_markup.inline_keyboard.flat();assert.equal(buttons.find(button=>button.text==='Перейти к отчёту').url,'https://t.me/c/111111/209');
    if(status==='cancelled')assert.equal(buttons.length,1);else assert.ok(buttons.some(button=>button.callback_data));
  }
});

test('admin lookup failure cannot strip the old keyboard after the status was saved, and retry refreshes without another status write',async()=>{
  let fail=true;const f=fixture({loadOrderReportLink:async id=>{assert.equal(f.locked(),true);assert.equal(id,58);if(fail)throw new Error('Synthetic report lookup failure');return{url:'https://t.me/c/111111/210'};}});
  const req={body:{id:58,status:'done'}},first=f.response();await f.handler(req,first);assert.equal(first.body.ok,true);assert.match(first.body.warning,/Статус сохранён/);assert.equal(f.writes(),1);assert.equal(f.edits.length,0);
  fail=false;const retry=f.response();await f.handler(req,retry);assert.equal(retry.body.warning,undefined);assert.equal(f.writes(),1);assert.equal(f.edits[0].options.reply_markup.inline_keyboard.flat().find(button=>button.url).url,'https://t.me/c/111111/210');
});
