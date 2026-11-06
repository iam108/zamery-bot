'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const filename=require.resolve('../src/web/handoff'),local=createRequire(filename),source=fs.readFileSync(filename,'utf8');
function calendars(){
  const context=vm.createContext({module:{exports:{}},Date,URL,URLSearchParams,Buffer,require:name=>name==='../db/pool'?{query(){assert.fail('Rendering the calendar is read-only');}}:local(name)});
  vm.runInContext(source+'\nmodule.exports.qa={isWorkday,addWorkdays,workdaysBetween,checklistPage};',context);
  const server=context.module.exports.qa,list=Object.values(local('../checklists').LISTS)[0];
  const html=server.checklistPage({id:39,org:'Synthetic client',address:'Synthetic address',data:{},service:'Получение'},list);
  const match=html.match(/<script>(var HOLIDAYS=[\s\S]*?)\nwindow\.__CFG=/);assert.ok(match,'The real page embeds its calendar before checklist configuration');
  const client=vm.createContext({Date});vm.runInContext(match[1],client);return{server,client};
}
test('the approved 2027 transfers include the working Saturday and all three substitute days off',()=>{
  for(const calendar of Object.values(calendars()))for(const[day,working]of [['2027-02-20',true],['2027-02-22',false],['2027-11-05',false],['2027-12-31',false]])assert.equal(calendar.isWorkday(new Date(day+'T00:00:00Z')),working,day);
});
test('the actual Moscow fifteen-workday deadline reaches the working Saturday rather than the transferred Monday',()=>{
  const {server,client}=calendars();assert.equal(server.addWorkdays('2027-02-01',15),'2027-02-20');assert.equal(client.addWorkdays('2027-02-01',15),'2027-02-20');
});
test('server and embedded client keep 2026 holidays and the 2026 to 2027 transition identical',()=>{
  for(const calendar of Object.values(calendars())){assert.equal(calendar.addWorkdays('2026-11-03',1),'2026-11-05');assert.equal(calendar.addWorkdays('2026-12-30',1),'2027-01-11');assert.equal(calendar.workdaysBetween('2026-12-30','2027-01-11'),1);assert.equal(calendar.isWorkday(new Date('2026-12-31T00:00:00Z')),false);}
});
