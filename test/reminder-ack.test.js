const test=require('node:test');
const assert=require('node:assert/strict');
const {createReminderDelivery,caseReminderStatus}=require('../src/web/reminder-delivery');

function fixture(send, expectedChat) {
  const delivery={},helper=createReminderDelivery(),now=Date.parse('2026-11-05T10:00:00Z');let saved;
  return {delivery,now,saved:()=>saved,run:()=>helper.deliverRecipient({key:'case:1:808',slot:'808',window:'2026-11-05',delivery,now,
    acknowledged:()=>!!delivery['808'],acknowledge:id=>{delivery['808']=id;},persist:async()=>{saved=JSON.parse(JSON.stringify(delivery));},send,expectedChat})};
}
test('a Telegram 5xx response remains visibly unknown with duplicate risk and a delayed retry',async()=>{
  const h=fixture(async()=>{throw Object.assign(new Error('ACK unknown'),{response:{error_code:502}});});
  assert.equal(await h.run(),'unknown');
  const status=caseReminderStatus({remind_on:'2026-11-05',created_by:808,delivery:h.saved()},808,h.now);
  assert.equal(status.state,'unknown');assert.equal(status.duplicatePossible,true);assert.ok(Date.parse(status.nextAt)>h.now);assert.equal(status.confirmed,0);
});
for(const message_id of [true,[77],{valueOf(){return 77;}}])test('a malformed reminder ACK never invents a confirmed message: '+JSON.stringify(message_id),async()=>{
  const h=fixture(async()=>({message_id}));assert.equal(await h.run(),'unknown');assert.equal(h.saved()['808'],undefined);
});
test('a known Telegram rejection remains retrying without inventing possible delivery',async()=>{
  const h=fixture(async()=>{throw Object.assign(new Error('rejected'),{response:{error_code:403}});});assert.equal(await h.run(),'retrying');assert.equal(h.saved()._attempts['808'].duplicate_possible,false);
});

for(const [target,chat,confirmed] of [
  [808,{id:808},true],['808',{id:'808'},true],['808',{id:909},false],['-100200',{id:-100200},true],['-100200',{id:-100300},false],
  ['@SyntheticGroup',{id:-100200,username:'sYnThEtIcGrOuP'},true],['@SyntheticGroup',{id:-100200,username:'OtherGroup'},false],['@SyntheticGroup',{id:-100200},false],
  ['808',true,false],['808',{id:{toString:()=> '808'}},false],['808',undefined,true],['@SyntheticGroup',null,true],
])test('reminder ACK destination '+String(target)+' / '+JSON.stringify(chat)+' is '+(confirmed?'confirmed':'unknown'),async()=>{
  const h=fixture(async()=>({message_id:77,...(chat===undefined?{}:{chat})}),target);
  assert.equal(await h.run(),confirmed?'confirmed':'unknown');assert.equal(h.saved()['808'],confirmed?77:undefined);
  if(!confirmed){assert.equal(h.saved()._attempts['808'].duplicate_possible,true);assert.ok(h.saved()._attempts['808'].next_at>h.now);}
});
