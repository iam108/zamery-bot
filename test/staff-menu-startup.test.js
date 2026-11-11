'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function fixture(sync,cardSync=async()=>({updated:0,unchanged:0,skipped:0,failed:0})) {
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
    if(name==='./bot/case-card-sync')return {createCaseCardSync(options){assert.equal(options.telegram,bot.telegram);events.push('cards');return cardSync;}};
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
  assert.deepEqual(h.logs.find(row=>row[0]==='Staff menus checked:'),['Staff menus checked:',2,'updated,',1,'skipped,',1,'failed']);
});

test('client-card refresh runs independently of menu refresh and never delays polling',async()=>{
  const h=fixture(()=>new Promise(()=>{}),async()=>({updated:3,unchanged:1,skipped:2,failed:0}));await h.main();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(h.events.includes('polling'));assert.ok(h.events.includes('cards'));assert.equal(h.handlers.length,2);
  assert.deepEqual(h.logs.find(row=>row[0]==='Client report buttons checked:'),['Client report buttons checked:',3,'updated,',1,'unchanged,',2,'skipped,',0,'failed']);
  assert.deepEqual(h.errors,[]);
  const hung=fixture(async()=>({updated:0,skipped:0,failed:0}),()=>new Promise(()=>{}));await hung.main();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(hung.events.includes('polling'));assert.equal(hung.handlers.length,2);assert.deepEqual(hung.errors,[]);
});

test('failed client-card refresh keeps polling alive and does not expose Telegram credentials',async()=>{
  for(const cardSync of [()=>{throw new Error('private URL/key detail');},async()=>{throw new Error('private URL/key detail');}]){
    const h=fixture(async()=>({updated:0,skipped:0,failed:0}),cardSync);await h.main();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(h.errors,[['Client report button sync unavailable']]);assert.equal(h.events.some(x=>Array.isArray(x)&&x[0]==='exit'),false);
  }
});
