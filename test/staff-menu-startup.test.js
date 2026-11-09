'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function fixture(sync) {
  const events=[],errors=[],handlers=[],logs=[];
  const bot={telegram:{async deleteWebhook(value){events.push(['deleteWebhook',value]);}},launch(_options,ready){events.push('polling');ready();return new Promise(()=>{});},stop(){}};
  const app={listen(_port,_host,ready){events.push('listen');ready();}};
  const context=vm.createContext({module:{exports:{}},console:{log(...args){logs.push(args);},error(...args){errors.push(args);}},process:{env:{},once(...args){handlers.push(args);},exit(code){events.push(['exit',code]);}},require(name){
    if(name==='dotenv')return {config(){}};
    if(name==='express')return ()=>app;
    if(name==='./bot/index')return {setupBot(){events.push('setupBot');return bot;}};
    if(name==='./web/index')return {setupWeb(){events.push('setupWeb');}};
    if(name==='./db/pool')return {async query(sql){assert.equal(sql,'SELECT 1');events.push('DB');}};
    if(name==='./bot/staff-menu')return {getStaffMenu(value){assert.equal(value,bot);events.push('menus');return {syncApproved:sync};}};
    throw new Error('Unexpected startup import: '+name);
  }});
  const source=fs.readFileSync(require.resolve('../src/index'),'utf8');
  vm.runInContext(source.slice(0,source.lastIndexOf('\nmain().catch'))+'\nmodule.exports={main};',context);
  return {main:context.module.exports.main,events,errors,handlers,logs};
}

test('startup launches polling without waiting for a hung personal-menu sync',async()=>{
  const h=fixture(()=>new Promise(()=>{}));await h.main();await Promise.resolve();
  assert.ok(h.events.includes('polling'));assert.ok(h.events.includes('menus'));assert.ok(h.events.includes('listen'));
  assert.equal(h.handlers.length,2);assert.deepEqual(h.errors,[]);assert.equal(h.events.some(x=>Array.isArray(x)&&x[0]==='exit'),false);
});

test('startup menu failure does not terminate polling or reveal Telegram/config credentials',async()=>{
  for(const sync of [()=>{throw new Error('synthetic private URL/key detail');},async()=>{throw new Error('synthetic private URL/key detail');}]) {
    const h=fixture(sync);await h.main();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(h.errors,[['Staff menu sync unavailable']]);assert.equal(h.events.some(x=>Array.isArray(x)&&x[0]==='exit'),false);
    assert.doesNotMatch(JSON.stringify(h.errors),/synthetic|private|key detail/);
  }
});

test('successful startup logs counts only',async()=>{
  const h=fixture(async()=>({updated:2,skipped:1,failed:1}));await h.main();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.logs.at(-1),['Staff menus checked:',2,'updated,',1,'skipped,',1,'failed']);
});
