const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

test('an auditor receives the exact SQL calendar deadline in every server timezone', () => {
  const script = `const pg=require('pg');const {packetFromOrder}=require('./src/web/audit-packet');const deadline=pg.types.getTypeParser(1082,'text')('2026-11-12');console.log(packetFromOrder({id:58,deadline},[]).deadline);`;
  for(const TZ of ['UTC','Europe/Moscow','America/Los_Angeles']){
    const actual=execFileSync(process.execPath,['-e',script],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8'}).trim();
    assert.equal(actual,'2026-11-12',TZ);
  }
});

test('a deadline due today stays available through the Moscow calendar day in SQL statistics', {skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();
  try{
    await db.exec("CREATE TABLE orders(id INT,status TEXT,deadline DATE); SET TIME ZONE 'Europe/Moscow'; INSERT INTO orders VALUES(1,'new',(NOW() AT TIME ZONE 'Europe/Moscow')::date),(2,'in_progress',(NOW() AT TIME ZONE 'Europe/Moscow')::date-1),(3,'new',(NOW() AT TIME ZONE 'Europe/Moscow')::date+1),(4,'done',(NOW() AT TIME ZONE 'Europe/Moscow')::date-1),(5,'cancelled',(NOW() AT TIME ZONE 'Europe/Moscow')::date-1);");
    const pool={query:(sql,values)=>db.query(sql,values)};
    const c=vm.createContext({module:{exports:{}},require:name=>{assert.equal(name,'./pool');return pool;}});
    vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'),'utf8'),c);
    for(const zone of ['Europe/Moscow','UTC','America/Los_Angeles']){
      await db.exec("SET TIME ZONE '"+zone+"'");
      assert.equal(Number((await c.module.exports.getStats()).overdue_count),1,zone);
    }
  }finally{await db.close();}
});

test('admin list does not mark today overdue and does mark yesterday overdue',()=>{
  const source=fs.readFileSync(require.resolve('../src/web/index'),'utf8');
  const admin=source.slice(source.indexOf('function adminPage('),source.indexOf('function orderDetailPage('));
  const now=Date.parse('2026-11-05T12:00:00Z');
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const c=vm.createContext({Date:Clock,esc:String,encodeURIComponent,...require('../src/calendar-date')});vm.runInContext(admin,c);
  const props={stats:{},status:'all',search:'',page:1,totalPages:1,total:1};
  const row={id:58,status:'new',created_at:new Date(now),owner_name:'Synthetic',address:'Synthetic',object_type:'Synthetic'};
  const today=c.adminPage({...props,orders:[{...row,deadline:'2026-11-05'}]});
  assert.doesNotMatch(today,/<td style="color:#f87171">/);
  const yesterday=c.adminPage({...props,orders:[{...row,deadline:'2026-11-04'}]});assert.match(yesterday,/<td style="color:#f87171">/);
});

test('calendar dates reject invalid days and become overdue exactly at the next Moscow midnight',()=>{
  const {calendarDate,calendarRu,isOrderOverdue,moscowToday}=require('../src/calendar-date');
  for(const value of ['',null,'bad','2026-02-30','2026-13-01',new Date(NaN)])assert.equal(calendarDate(value),'');
  assert.equal(calendarRu('2026-11-05'),'05.11.2026');assert.equal(calendarRu('bad'),'—');
  const order={deadline:'2026-11-05',status:'new'};
  assert.equal(moscowToday(Date.parse('2026-11-05T20:59:59Z')),'2026-11-05');
  assert.equal(isOrderOverdue(order,Date.parse('2026-11-05T20:59:59Z')),false);
  assert.equal(isOrderOverdue(order,Date.parse('2026-11-05T21:00:00Z')),true);
  assert.equal(isOrderOverdue({...order,status:'done'},Date.parse('2026-11-05T21:00:00Z')),false);
});

test('reminder delivery status keeps the SQL reminder date in eastern and western server timezones',()=>{
  const script=`const pg=require('pg');const {caseReminderStatus}=require('./src/web/reminder-delivery');const date=pg.types.getTypeParser(1082,'text')('2026-11-12');console.log(caseReminderStatus({remind_on:date,created_by:101,delivery:{}},808,Date.parse('2026-11-11T12:00:00Z')).state);`;
  for(const TZ of ['Europe/Moscow','UTC','America/Los_Angeles'])assert.equal(execFileSync(process.execPath,['-e',script],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8'}).trim(),'scheduled',TZ);
});

test('monthly order statistics use the Moscow month across the UTC month boundary', {skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();
  try{
    await db.exec("SET TIME ZONE 'UTC';CREATE TABLE orders(id INT,status TEXT,created_at TIMESTAMPTZ);INSERT INTO orders VALUES(1,'new','2026-10-31T22:00:00Z');");
    const pool={query:(sql,values)=>db.query(sql,values)},c=vm.createContext({module:{exports:{}},require:name=>{assert.equal(name,'./pool');return pool;}});
    vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'),'utf8'),c);
    assert.equal((await c.module.exports.getStatsByMonth())[0].month,'2026-11');
  }finally{await db.close();}
});
