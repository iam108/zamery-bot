'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { handoffReadiness } = require('../src/web/handoff-readiness');

test('a disputed school blocks a new assignment, even if the auditor recorded other findings', () => {
  const result = handoffReadiness({workflow:{territory_result:'findings',conclusion_status:'actions'},zones:[
    {id:'school',name:'Школа',status:'disputed',dist:'92'},
    {id:'gym',name:'Спортзал',status:'confirmed',dist:'74'},
  ]});
  assert.equal(result.blocking, true);
  assert.deepEqual(result.issues, ['Школа — уточните, действует ли ограничение.']);
});

test('a saved drawing can supply a measurement but does not erase a contradiction', () => {
  const zone = {id:'school',name:'Школа',status:'confirmed',dist:'Не проверено'};
  const audit = {schema_version:3,workflow:{territory_result:'findings'},inspection:{zones_checked:'Не проверено'},zones:[zone]};
  assert.equal(handoffReadiness(audit).blocking, true);
  audit.map = {annotations:[{tool:'route',toObjectId:zone.id,distance:'92,5'}]};
  assert.deepEqual(handoffReadiness(audit), {blocking:false,issues:[],territory:'В отчёте отмечено ограничение'});
  audit.workflow.territory_result = 'clear';
  assert.equal(handoffReadiness(audit).blocking, true);
});

test('a missing video blocks only when requested and a general inspection has no territory gate', () => {
  const audit = {schema_version:3,ui_version:5,object_category:'other',zones:[{name:'Школа',status:'disputed'}]};
  assert.equal(handoffReadiness(audit).blocking, false);
  assert.equal(handoffReadiness(audit,{videoRequired:true}).blocking, true);
  assert.equal(handoffReadiness(audit,{videoRequired:true,videoUrl:'https://disk.yandex.ru/d/test'}).blocking, false);
  assert.equal(handoffReadiness({workflow:{conclusion_status:'insufficient'}}).blocking, true);
});

test('a report explicitly marking zones unverified is blocked, legacy text stays viewable', () => {
  assert.equal(handoffReadiness({schema_version:3,inspection:{zones_checked:'Нет'}}).blocking, true);
  assert.equal(handoffReadiness({}).blocking, false);
  assert.match(handoffReadiness({workflow:{territory_result:'clear'}}).territory,/не выявлены/);
});
