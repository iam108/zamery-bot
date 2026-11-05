const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareReportImport } = require('../src/web/report-import-spool');
const parseExport = buffer => JSON.parse(buffer.toString('utf8')).map(message => ({...message,date:new Date(message.date)}));
const message = (id,text='Part '+id,changes={}) => ({id,text,date:'2026-11-05T10:00:00Z',author:'Auditor',sender:'user108',authorId:'108',media:false,reply:null,...changes});
const startsReport = text => /^New report/.test(text);
async function fixture(run) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zamery-spool-test-'));
  const files=[];
  async function add(messages){const target=path.join(directory,'original-'+files.length+'.json');await fs.writeFile(target,JSON.stringify(messages));const file={path:target,originalname:path.basename(target)};files.push(file);return file;}
  try{await run({directory,files,add,prepare:options=>prepareReportImport(files,{parseExport,startsReport,parentDirectory:directory,...options})});}finally{await fs.rm(directory,{recursive:true,force:true});}
}

test('all fifty uploads sort across small external runs and overlapping IDs keep their first source occurrence',async()=>fixture(async h=>{
  await h.add([message(50,'First source wins'),message(1)]);
  for(let index=2;index<=50;index++)await h.add([message(index)]);
  const observed=[],prepared=await h.prepare({chunkBytes:180,maxOpenRuns:2,observe:value=>observed.push(value)});
  try{
    assert.equal(h.files.length,50);assert.equal(prepared.messageCount,50);
    const groups=[];for await(const group of prepared.groups())groups.push(group);assert.equal(groups.length,1);assert.equal(groups[0].count,50);
    const records=[];for await(const record of prepared.records(groups[0]))records.push(record);
    assert.deepEqual(records.map(record=>record.id),Array.from({length:50},(_,i)=>i+1));assert.equal(records.at(-1).text,'First source wins');
    assert.ok(observed.filter(value=>value.readers).every(value=>value.readers<=2));
    assert.deepEqual((await fs.readdir(prepared.directory)).sort(),['groups.jsonl','payload.jsonl','sorted.jsonl']);
    assert.equal((await fs.stat(prepared.directory)).mode&0o777,0o700);
    for(const file of await fs.readdir(prepared.directory))assert.equal((await fs.stat(path.join(prepared.directory,file))).mode&0o777,0o600);
  }finally{await prepared.cleanup();}
  assert.equal((await fs.readdir(h.directory)).length,50,'Cleanup keeps caller-owned uploads for its outer cleanup');
}));

test('global ordering joins cross-file captions while sender, thread, report headers and album rules remain intact',async()=>fixture(async h=>{
  await h.add([message(6,'New report two'),message(1,'One'),message(3,'Other sender',{sender:'user109',authorId:'109'}),message(9,'Album tail',{sender:'user999',mgid:'album',date:'2026-12-01T00:00:00Z'})]);
  await h.add([message(2,'Two'),message(4,'Thread',{reply:1}),message(5,'New report one'),message(7,'Album head',{mgid:'album'}),message(8,'',{media:false})]);
  const prepared=await h.prepare({chunkBytes:100,maxOpenRuns:2});
  try{const groups=[];for await(const group of prepared.groups()){const ids=[];for await(const record of prepared.records(group))ids.push(record.id);groups.push(ids);}
    assert.deepEqual(groups,[[1,2],[3],[4],[5],[6,7,9]]);assert.equal(prepared.messageCount,9,'Empty messages still count once, as before');
  }finally{await prepared.cleanup();}
}));

test('an invalid record in the last source removes all sort work before a prepared import can be consumed',async()=>fixture(async h=>{
  await h.add([message(1)]);await h.add([message(2,'Invalid',{date:'invalid'})]);
  await assert.rejects(h.prepare({chunkBytes:1,maxOpenRuns:2}),/некорректным номером или датой/);
  assert.deepEqual((await fs.readdir(h.directory)).sort(),['original-0.json','original-1.json']);
}));

test('merge reader heads contain only small disk offsets even when each source has a large caption',async()=>fixture(async h=>{
  for(let index=0;index<4;index++)await h.add([message(4-index,'x'.repeat(512*1024))]);
  const events=[],prepared=await h.prepare({chunkBytes:1,maxOpenRuns:2,observe:value=>events.push(value)});
  try{assert.ok(events.filter(value=>value.headBytes).every(value=>value.headBytes<512));const groups=[];for await(const group of prepared.groups())groups.push(group);assert.equal(groups.length,1);
    let count=0;for await(const record of prepared.records(groups[0])){assert.equal(record.text.length,512*1024);count++;}assert.equal(count,4);
  }finally{await prepared.cleanup();}
}));

test('a multi-file continuous group remains a disk range and its few-MiB fixture has bounded resident memory',async()=>fixture(async h=>{
  const count=5000,start=Date.parse('2026-11-05T10:00:00Z');
  for(let part=0;part<5;part++)await h.add(Array.from({length:1000},(_,offset)=>{const index=part*1000+offset;return message(index+1,'Caption '+index+' '+'.'.repeat(500),{date:new Date(start+index*120000).toISOString()});}));
  const baseline=process.memoryUsage().rss;let peak=baseline;
  const prepared=await h.prepare({chunkBytes:4096,maxOpenRuns:3,observe:()=>{peak=Math.max(peak,process.memoryUsage().rss);}});
  try{const groups=[];for await(const group of prepared.groups())groups.push(group);assert.equal(groups.length,1);assert.equal(groups[0].count,count);assert.equal(Object.hasOwn(groups[0],'messages'),false);
    let visited=0;for await(const record of prepared.records(groups[0])){assert.equal(record.id,++visited);}assert.equal(visited,count);
    assert.ok(peak-baseline<128*1024*1024,'A few-MiB import must not retain hundreds of MiB');
    console.log('Small streaming import RSS delta:',Math.round((peak-baseline)/1024/1024)+' MiB; messages='+count+'; group manifest bytes='+Buffer.byteLength(JSON.stringify(groups[0])));
  }finally{await prepared.cleanup();}
}));

test('cancellation while normalizing a source removes its partial payload and all runs',async()=>fixture(async h=>{
  await h.add(Array.from({length:20},(_,index)=>message(index+1)));let checks=0;
  await assert.rejects(h.prepare({chunkBytes:1,maxOpenRuns:2,isAborted:()=>++checks>5}),error=>error.code==='UPLOAD_ABORTED');
  assert.deepEqual(await fs.readdir(h.directory),['original-0.json']);
}));

test('cancellation inside a merge stops that group immediately and removes partial generations',async()=>fixture(async h=>{
  await h.add(Array.from({length:200},(_,index)=>message(index+1)));let aborted=false,merges=0;
  await assert.rejects(h.prepare({chunkBytes:180,maxOpenRuns:2,isAborted:()=>aborted,observe:value=>{if(value.readers){merges++;aborted=true;}}}),error=>error.code==='UPLOAD_ABORTED');
  assert.equal(merges,1);assert.deepEqual(await fs.readdir(h.directory),['original-0.json']);
}));

test('a permissions error after creating the private spool directory cannot leave that directory behind',async()=>fixture(async h=>{
  await h.add([message(1)]);const original=fs.chmod;
  fs.chmod=async function(target,...rest){if(path.dirname(target)===h.directory&&path.basename(target).startsWith('zamery-import-spool-'))throw Object.assign(new Error('Synthetic permission failure'),{code:'EIO'});return original.call(this,target,...rest);};
  try{await assert.rejects(h.prepare(),error=>error.code==='EIO');}finally{fs.chmod=original;}
  assert.deepEqual(await fs.readdir(h.directory),['original-0.json']);
}));
