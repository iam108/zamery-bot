'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {setupOrderRoute} = require('../src/web/order-route');

function fixture(order, geocode) {
  let handler;
  setupOrderRoute({get(path, fn){assert.equal(path,'/api/audit/orders/:id/route');handler=fn;}},{getOrder:async()=>order,geocode});
  return async id => {
    const result = {status:200,headers:{}};
    const res = {set(k,v){result.headers[k]=v;return this;},status(s){result.status=s;return this;},json(body){result.body=body;return this;}};
    await handler({params:{id},query:{address:'Untrusted override',latitude:1,longitude:2}},res);
    return result;
  };
}

test('route looks up only the saved order address without forwarding contacts or user location', async()=>{
  const seen=[];
  const output={status:'ok',point:{latitude:55.75,longitude:37.61},label:'Москва, Тестовая, 1',attribution:{label:'Яндекс Карты',url:'https://yandex.ru/maps/'}};
  const call=fixture({address:'Москва, Тестовая, 1',contacts:'private',cad_num:'private'},async(...args)=>{seen.push(args);return output;});
  const result=await call('60');
  assert.deepEqual(seen,[['Москва, Тестовая, 1']]);
  assert.deepEqual(result.body,{ok:true,...output});
  assert.equal(result.headers['Cache-Control'],'no-store');
});

test('invalid or missing orders never call the geocoder', async()=>{
  const never=()=>assert.fail('No address may be sent');
  assert.equal((await fixture(null,never)('bad')).status,400);
  assert.equal((await fixture(null,never)('0')).status,400);
  assert.equal((await fixture(null,never)('60')).status,404);
  assert.equal((await fixture({address:''},never)('60')).status,400);
});

test('ambiguous results are preserved and unexpected errors expose no provider internals',async()=>{
  const uncertain={status:'needs_choice',candidates:[{label:'Москва, Тестовая, 1',point:{latitude:55.75,longitude:37.61}}]};
  assert.deepEqual((await fixture({address:'Москва, Тестовая, 1'},async()=>uncertain)('60')).body,{ok:true,...uncertain});
  const result=await fixture({address:'Москва, Тестовая, 1'},async()=>{throw new Error('provider URL and secret');})('60');
  assert.equal(result.status,502);assert.doesNotMatch(result.body.error,/secret|provider/);
});

test('missing geocoder credentials expose a usable configuration error without exposing a key',async()=>{
  const call=fixture({address:'Москва, Тестовая, 1'},async()=>{throw Object.assign(new Error('Определение адреса не подключено.'),{status:503,code:'GEOCODER_CONFIG'});});
  const result=await call('60');
  assert.equal(result.status,503);assert.equal(result.body.code,'GEOCODER_CONFIG');
  assert.match(result.body.error,/не подключено/);
});
