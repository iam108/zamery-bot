'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {savedCaseProfile}=require('../src/web/handoff-case-profile');

test('confirmed manager profile exposes legal details and contacts, never packet internals or historical object names',()=>{
  assert.deepEqual(savedCaseProfile({id:90,order_id:62,org:' ООО «Верное юрлицо» ',object_name:'Название заведения',address:' Москва ',inn:7701234567,region:'МСК',kind:'Общепит',service:'Продление',
    contacts:[null,[],{name:' Анна ',phone:'+79991234567',unknown:'SECRET'},{}],data:{_comment:'PRIVATE',_handoff:{fields:{cad_num:'77:01:0004016:1064'},body:{private:'SECRET'},cards:{808:6000}}}}),
  {org:'ООО «Верное юрлицо»',address:'Москва',inn:'7701234567',region:'МСК',kind:'Общепит',service:'Продление',cad_num:'77:01:0004016:1064',contacts:[{name:'Анна',phone:'+79991234567',tg:'',comment:''}]});
});

test('legacy rows without a saved organisation do not fabricate a legal entity from the object brand',()=>{
  for(const row of [null,{}, {org:'',object_name:'Кафе'}, {org:{name:'bad'},address:'Москва'}])assert.equal(savedCaseProfile(row),null);
});
