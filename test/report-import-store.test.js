const test = require('node:test');
const assert = require('node:assert/strict');
const { importPreparedReports } = require('../src/web/report-import-store');

test('owner discovery uses only disk keys and never batches full captions before the first lookup',async()=>{
  let payloadsRead=0,idsRead=0,staged=0,ownerLookups=0,aggregations=0;
  const text='x'.repeat(128*1024),counts=[];
  const prepared={messageCount:50,async *groups(){yield {firstId:1,author:'Auditor',authorId:'108',date:Date.parse('2026-11-05T10:00:00Z'),last:Date.parse('2026-11-05T10:00:00Z'),reply:null,mgid:null};},
    async *ids(){for(let id=1;id<=50;id++){idsRead++;yield {id};}},
    async *records(){for(let id=1;id<=50;id++){payloadsRead++;yield {id,text,date:new Date('2026-11-05T10:00:00Z')};}},
  };
  const db={async query(sql,values){
    if(sql.startsWith('CREATE TEMP'))return {rows:[]};
    if(sql.includes('MIN(r.id)')){ownerLookups++;assert.equal(payloadsRead,0,'An owner-only prepass must not deserialize or retain captions');assert.ok(values[1].length<=10);return {rows:[]};}
    if(sql.startsWith('INSERT INTO reports('))return {rows:[{id:7}]};
    if(sql.includes('INSERT INTO report_import_pending')){counts.push(values[0].length);staged+=values[0].length;assert.ok(values[2].reduce((sum,value)=>sum+Buffer.byteLength(value),0)<=256*1024);return {rows:[]};}
    if(sql.startsWith('WITH incoming')){aggregations++;return {rowCount:1};}
    assert.fail('Unexpected SQL '+sql);
  }};
  assert.deepEqual(await importPreparedReports(db,'-100100',prepared,{batchRecords:10,batchBytes:256*1024}),{added:1,messages:50});
  assert.equal(idsRead,50);assert.equal(payloadsRead,50);assert.equal(ownerLookups,5);assert.equal(staged,50);assert.ok(counts.every(count=>count<=2));assert.equal(aggregations,1);
});
