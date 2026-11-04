import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {prepareContactSource} from './contact-source.mjs';

const SCHEMA='license_registry_contacts';
const ROLE='license_registry_contacts_reader';
const CHAT='-1001234567890';
const MARKER=`license-registry:contacts-source:v1:clients_chat_id=${CHAT}`;
const BOOTSTRAP='postgresql://postgres:bootstrap-secret-never-log@postgres.railway.internal:5432/railway';
const INN='9721255266';
const OTHER='7707083893';
const columns={cases:['id','org','inn','address','contacts','client','phone','request_id','order_id','created_at'],
  reports:['id','text','created_at','chat_id','dismissed']};
const role=()=>({rolname:ROLE,rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,
  rolinherit:false,rolreplication:false,rolbypassrls:false,marker:MARKER});
const permissions=()=>({cases_select:false,reports_select:false,cases_write:false,reports_write:false,
  cases_view_select:true,reports_view_select:true,cases_view_write:false,reports_view_write:false,
  schema_usage:true,schema_create:false,public_create:false,database_create:false,memberships:false});
const record=(inn=INN,id=1)=>({id,org:'ООО Тест',inn,address:'Москва, Тестовая улица, 1',
  contacts:[{name:'Иван Иванов',phone:'+79991234567'}],client:'Иван Иванов',phone:'+79991234567',
  request_id:11,order_id:22,created_at:new Date('2026-11-04T10:00:00Z')});
const form=(inn=INN)=>`Новая форма заполнена\nИмя клиента: Иван Иванов\nНомер: +79991234567\nНаименование организации: ООО Тест\nИНН: ${inn}\nАдрес лицензирования: Москва, Тестовая улица, 1\nTelegram: @ivan_ivanov`;

function fakeDatabase(){
  const db={schema:null,relations:[],routines:[],role:null,password:null,defaultReadonly:false,
    columns:structuredClone(columns),caseRows:[],reportRows:[],overrides:{},failCommit:0,failure:null};
  const calls=[],pools=[];
  const factory=async(options)=>{
    const url=new URL(options.connectionString);const reader=decodeURIComponent(url.username)===ROLE;
    const pool=Object.assign(new EventEmitter(),{options,reader,ended:false,async end(){this.ended=true;},async connect(){
      if(reader&&(!db.role||decodeURIComponent(url.password)!==db.password))throw new Error('FATAL bad password: private-password-client-name');
      let state=db,transaction=null,readOnly=false;
      return {release(){},async query(sql,values=[]){
        const text=sql.replace(/\s+/gu,' ').trim();calls.push({text,values,reader});
        if(db.failure&&db.failure(text,reader))throw new Error('FATAL password=private-password client=Иван secret SQL');
        if(text==='BEGIN'||text==='BEGIN READ ONLY'){transaction=structuredClone({...db,failure:null});state=transaction;readOnly=text.endsWith('READ ONLY');return {rows:[]};}
        if(text==='ROLLBACK'){transaction=null;state=db;return {rows:[]};}
        if(text==='COMMIT'){
          if(!reader&&db.failCommit){db.failCommit--;throw new Error('commit failed containing password private');}
          if(!reader)Object.assign(db,transaction);transaction=null;state=db;return {rows:[]};
        }
        if(text.startsWith('SET LOCAL ')||text.startsWith('SELECT pg_advisory_xact_lock'))return {rows:[]};
        if(text==='SELECT current_user AS owner,current_database() AS database')return {rows:[{owner:'postgres',database:'railway'}]};
        if(text.startsWith('SELECT current_user AS role,'))return {rows:[{role:reader?ROLE:'postgres',
          default_read_only:db.defaultReadonly?'on':'off',transaction_read_only:readOnly?'on':'off'}]};
        if(text.includes('FROM pg_catalog.pg_namespace WHERE nspname=$1'))return {rows:state.schema?[state.schema]:[]};
        if(text.includes('FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace'))return {rows:state.relations};
        if(text.includes('FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace'))return {rows:state.routines};
        if(text.includes("shobj_description(oid,'pg_authid')"))return {rows:state.role?[state.role]:[]};
        if(text.includes('FROM information_schema.columns'))return {rows:Object.entries(state.columns).flatMap(([table_name,names])=>names.map((column_name)=>({table_name,column_name})))};
        if(text.startsWith('SELECT has_table_privilege'))return {rows:[{...permissions(),...state.overrides}]};
        if(text.startsWith('CREATE SCHEMA ')){state.schema={owner:'postgres',marker:null};return {rows:[]};}
        if(text.startsWith('COMMENT ON SCHEMA ')){state.schema.marker=MARKER;return {rows:[]};}
        if(text.startsWith('CREATE ROLE ')){
          state.role=role();state.role.marker=null;state.password=text.match(/PASSWORD '([^']+)'$/u)?.[1];return {rows:[]};
        }
        if(text.startsWith('COMMENT ON ROLE ')){state.role.marker=MARKER;return {rows:[]};}
        if(text.startsWith('ALTER ROLE ')){state.defaultReadonly=true;return {rows:[]};}
        if(text.startsWith('CREATE OR REPLACE VIEW ')){
          const name=text.match(/VIEW license_registry_contacts\.(\w+)/u)[1];
          state.relations=state.relations.filter((row)=>row.name!==name);
          state.relations.push({name,relkind:'v',owner:'postgres',marker:null});return {rows:[]};
        }
        if(text.startsWith('COMMENT ON VIEW ')){
          const name=text.match(/VIEW license_registry_contacts\.(\w+)/u)[1];state.relations.find((row)=>row.name===name).marker=MARKER;return {rows:[]};
        }
        if(text.startsWith('REVOKE ')||text.startsWith('GRANT '))return {rows:[]};
        if(text.startsWith('SELECT (SELECT count(*)::text'))return {rows:[{cases:String(db.caseRows.length),incoming_reports:String(db.reportRows.length)}]};
        if(text.includes(`FROM ${SCHEMA}.cases c WHERE c.inn=ANY`)){
          const [inns,limit]=values;
          return {rows:inns.flatMap((inn)=>db.caseRows.filter((row)=>row.inn===inn).slice(0,limit))};
        }
        if(text.includes(`FROM ${SCHEMA}.incoming_reports r JOIN`)){
          const [inns,,limit]=values;
          return {rows:inns.flatMap((inn)=>db.reportRows.filter((row)=>row.lookup_inn===inn).slice(0,limit))};
        }
        throw new Error(`Unexpected mock query ${text}`);
      }};
    }});
    pools.push(pool);return pool;
  };
  return {db,calls,pools,factory};
}

async function harness(t,{bootstrap=true}={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'license-contacts-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const fake=fakeDatabase(),logs=[];
  const env={CONTACTS_CLIENTS_CHAT_ID:CHAT,...bootstrap?{CONTACTS_BOOTSTRAP_DATABASE_URL:BOOTSTRAP}:{}};
  const prepare=()=>prepareContactSource({env,dataDir,log:(entry)=>logs.push(entry),poolFactory:fake.factory});
  const file=path.join(dataDir,'secrets','contacts-db-url');
  return {...fake,dataDir,logs,env,prepare,file};
}

test('bootstrap creates only scoped views and a dedicated reader; verifies without exposing credentials or contact data',async(t)=>{
  const h=await harness(t);h.db.caseRows=[record()];
  const source=await h.prepare();t.after(()=>source.close());
  assert.deepEqual(await source.verify(),{ready:true,schema:SCHEMA,cases:1,incomingReports:0});
  const saved=(await fs.readFile(h.file,'utf8')).trim();const url=new URL(saved);
  assert.equal(decodeURIComponent(url.username),ROLE);assert.equal(decodeURIComponent(url.password),h.db.password);
  assert.equal((await fs.stat(h.file)).mode&0o777,0o600);
  assert.equal(h.env.CONTACTS_BOOTSTRAP_DATABASE_URL,undefined);
  assert.equal(h.pools.length,2);assert.equal(h.pools[0].ended,true);
  for(const pool of h.pools){assert.equal(pool.options.max,1);assert.equal(pool.options.statement_timeout,5000);assert.equal(pool.options.query_timeout,6000);}
  const ddl=h.calls.filter((call)=>!call.reader).map((call)=>call.text).join('\n');
  assert.match(ddl,/CREATE ROLE .* LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u);
  assert.match(ddl,/ALTER ROLE .* SET default_transaction_read_only = on/u);
  assert.match(ddl,/VIEW license_registry_contacts.cases WITH \(security_barrier=true\) AS SELECT c.id,c.org,c.inn,c.address,c.contacts,c.client,c.phone,c.request_id,c.order_id,c.created_at FROM public.cases c/u);
  assert.match(ddl,/SELECT r.id,r.text,r.created_at FROM public.reports r WHERE r.chat_id='-1001234567890'::bigint AND/u);
  assert.doesNotMatch(ddl,/COALESCE\(r.dismissed,false\)/u);
  assert.match(ddl,/Имя клиента/u);assert.match(ddl,/Адрес лицензирования/u);assert.match(ddl,/Наименование организации/u);
  assert.doesNotMatch(ddl,/orders|lawyer|audit_text|created_by|r.author|REVOKE.*ON public|REVOKE.*ON DATABASE/u);
  assert.equal(h.calls.filter((call)=>call.reader&&call.text==='BEGIN READ ONLY').length,1);
  assert.equal(JSON.stringify(h.logs).includes('secret'),false);
  assert.equal(JSON.stringify(h.logs).includes('Иван'),false);
});

test('restart reads the persisted reader URL only, with no bootstrap connection or DDL',async(t)=>{
  const h=await harness(t);const first=await h.prepare();await first.close();
  const saved=await fs.readFile(h.file,'utf8');h.calls.length=0;h.pools.length=0;
  const restarted=await h.prepare();t.after(()=>restarted.close());
  await restarted.verify();assert.equal(h.pools.length,1);assert.equal(h.pools[0].reader,true);
  assert.equal(await fs.readFile(h.file,'utf8'),saved);
  assert.equal(h.calls.some((call)=>/CREATE |ALTER |GRANT |REVOKE /u.test(call.text)),false);
});

test('a complete credential survives a crash leaving its temporary publish hard link behind',async(t)=>{
  const h=await harness(t);const first=await h.prepare();await first.close();
  await fs.link(h.file,`${h.file}.orphan.tmp`);
  assert.equal((await fs.stat(h.file)).nlink,2);
  const restarted=await h.prepare();t.after(()=>restarted.close());
  assert.equal((await restarted.verify()).ready,true);
});

test('bootstrap retries with the same durable password after a rolled-back commit',async(t)=>{
  const h=await harness(t);h.db.failCommit=1;
  await assert.rejects(h.prepare(),{code:'contacts_source_unavailable'});
  const persisted=(await fs.readFile(h.file,'utf8')).trim();assert.equal(h.db.role,null);
  assert.equal(h.env.CONTACTS_BOOTSTRAP_DATABASE_URL,BOOTSTRAP);
  const source=await h.prepare();t.after(()=>source.close());await source.verify();
  assert.equal((await fs.readFile(h.file,'utf8')).trim(),persisted);
  assert.equal(h.db.password,decodeURIComponent(new URL(persisted).password));
  assert.equal(h.calls.filter((call)=>call.text==='ROLLBACK').length,1);
});

test('bootstrap never overwrites a foreign schema, role, or objects and never revokes global privileges',async(t)=>{
  for(const conflict of ['schema_marker','schema_owner','role_marker','unexpected_view','routine']){
    const h=await harness(t);
    if(conflict.startsWith('schema'))h.db.schema={owner:conflict==='schema_owner'?'another_owner':'postgres',marker:conflict==='schema_marker'?'someone-else':MARKER};
    if(conflict==='role_marker')h.db.role={...role(),marker:'another-application'};
    if(conflict==='unexpected_view'){
      h.db.schema={owner:'postgres',marker:MARKER};h.db.relations=[{name:'other_view',relkind:'v',owner:'postgres',marker:MARKER}];
    }
    if(conflict==='routine'){h.db.schema={owner:'postgres',marker:MARKER};h.db.routines=[{}];}
    await assert.rejects(h.prepare(),(error)=>/^contacts_source_(schema|role)_conflict$/u.test(error.code));
    assert.equal(h.calls.some((call)=>/^(CREATE|ALTER|GRANT|REVOKE) /u.test(call.text)),false);
    await assert.rejects(fs.stat(h.file),{code:'ENOENT'});
  }
});

test('optional legacy columns use explicit safe defaults, while mandatory columns fail closed',async(t)=>{
  const h=await harness(t);h.db.columns.cases=h.db.columns.cases.filter((name)=>!['contacts','request_id'].includes(name));
  h.db.columns.reports=h.db.columns.reports.filter((name)=>name!=='dismissed');
  const source=await h.prepare();t.after(()=>source.close());
  const views=h.calls.filter((call)=>call.text.startsWith('CREATE OR REPLACE VIEW ')).map((call)=>call.text);
  assert.match(views[0],/'\[\]'::jsonb AS contacts/u);assert.match(views[0],/NULL::integer AS request_id/u);
  assert.doesNotMatch(views[1],/dismissed/u);
  const missing=await harness(t);missing.db.columns.cases=missing.db.columns.cases.filter((name)=>name!=='inn');
  await assert.rejects(missing.prepare(),{code:'contacts_source_schema_missing'});
});

test('lookup batches parameterized INNs, preserves structured client provenance, and excludes staff/notes',async(t)=>{
  const h=await harness(t);h.db.caseRows=[{...record(),author:'STAFF',comment:'LEGAL NOTE',audit_text:'PRIVATE',created_by:9}];
  h.db.reportRows=[{lookup_inn:OTHER,id:45,text:form(OTHER),created_at:new Date('2026-11-04T11:00:00Z'),author:'STAFF',author_id:9}];
  const source=await h.prepare();t.after(()=>source.close());
  const result=await source.lookup([INN,OTHER,INN]);
  assert.deepEqual(result.reviews,[]);assert.equal(result.cases.length,2);
  assert.deepEqual(Object.keys(result.cases[0]),columns.cases);
  assert.equal(result.cases[0].created_at,'2026-11-04T10:00:00.000Z');
  assert.equal(result.cases[1].request_id,45);assert.equal(result.cases[1].id,null);
  assert.equal(result.cases[1].contact_source,'incoming_request');assert.equal(result.cases[1].created_at,'2026-11-04T11:00:00.000Z');
  assert.equal(JSON.stringify(result).includes('STAFF'),false);assert.equal(JSON.stringify(result).includes('LEGAL'),false);
  const queries=h.calls.filter((call)=>call.reader&&call.text.startsWith('SELECT * FROM '));
  assert.equal(queries.length,2);assert.deepEqual(queries[0].values,[[INN,OTHER],1001]);
  assert.deepEqual(queries[1].values,[[INN,OTHER],`(^|[^0-9])(${INN}|${OTHER})([^0-9]|$)`,1001]);
  assert.match(queries[0].text,/inn=ANY\(\$1::text\[\]\)/u);
  assert.match(queries[1].text,/WHERE r.text ~ \$2/u);
  assert.equal(queries.some((call)=>call.text.includes(INN)),false);
  assert.deepEqual(await source.lookup([]),{cases:[],reviews:[]});
  await assert.rejects(source.lookup([`${INN}' OR true`]),{code:'contacts_source_invalid_inns'});
  await assert.rejects(source.lookup(Array(101).fill(INN)),{code:'contacts_source_invalid_inns'});
});

test('an ambiguous client form quarantines only its INN and suppresses every partial candidate for that INN',async(t)=>{
  const h=await harness(t);h.db.caseRows=[record(),record(OTHER,2)];
  h.db.reportRows=[{lookup_inn:INN,id:3,text:`${form()}\nДополнительный телефон: +79990000001`,created_at:null}];
  const source=await h.prepare();t.after(()=>source.close());
  const result=await source.lookup([INN,OTHER]);
  assert.deepEqual(result.reviews,[{inn:INN,reason:'contacts_source_report_review'}]);
  assert.deepEqual(result.cases.map((row)=>row.inn),[OTHER]);
});

test('per-INN case and report overflow are explicit reviews instead of truncated contact matches',async(t)=>{
  for(const kind of ['case','report']){
    const h=await harness(t);h.db.caseRows=[record(OTHER,2000)];
    if(kind==='case')h.db.caseRows.push(...Array.from({length:1002},(_,index)=>record(INN,index+1)));
    else h.db.reportRows=Array.from({length:1002},(_,index)=>({lookup_inn:INN,id:index+1,text:form(),created_at:null}));
    const source=await h.prepare();t.after(()=>source.close());
    const result=await source.lookup([INN,OTHER]);
    assert.deepEqual(result.reviews,[{inn:INN,reason:`contacts_source_${kind}_overflow`}]);
    assert.deepEqual(result.cases.map((row)=>row.inn),[OTHER]);
  }
});

test('effective table/write grants, memberships, and role attributes are verified rather than repaired globally',async(t)=>{
  for(const grant of ['cases_select','reports_select','cases_write','reports_write','cases_view_write','reports_view_write','schema_create','public_create','database_create','memberships']){
    const h=await harness(t);h.db.overrides[grant]=true;
    await assert.rejects(h.prepare(),{code:'contacts_source_permissions_invalid'});
    assert.equal(h.db.schema,null);assert.equal(h.db.role,null);
    assert.equal(h.calls.some((call)=>/^REVOKE.*ON public\./u.test(call.text)),false);
  }
  const h=await harness(t);const source=await h.prepare();t.after(()=>source.close());
  h.db.role.rolsuper=true;await assert.rejects(source.verify(),{code:'contacts_source_role_conflict'});
  h.db.role.rolsuper=false;h.db.defaultReadonly=false;await assert.rejects(source.verify(),{code:'contacts_source_permissions_invalid'});
});

test('private-host validation and credential file permissions fail before opening a database connection',async(t)=>{
  for(const url of ['postgresql://u:p@public.proxy.rlwy.net:1234/railway',
    'postgresql://u:p@postgres.railway.internal:5432/railway?sslmode=disable',
    'postgresql://u:p@postgres.railway.internal.evil.example/railway',
    'postgresql://u:p@127.0.0.1/railway']){
    const h=await harness(t);h.env.CONTACTS_BOOTSTRAP_DATABASE_URL=url;
    await assert.rejects(h.prepare(),{code:'contacts_source_connection_invalid'});assert.equal(h.pools.length,0);
  }
  const h=await harness(t,{bootstrap:false});await assert.rejects(h.prepare(),{code:'contacts_source_credentials_missing'});
  await fs.writeFile(h.file,`postgresql://${ROLE}:password@postgres.railway.internal/railway`,{mode:0o644});
  await assert.rejects(h.prepare(),{code:'contacts_source_credentials_invalid'});assert.equal(h.pools.length,0);
});

test('database errors become fixed codes with no password, SQL, or client names, and close is idempotent',async(t)=>{
  const h=await harness(t);const source=await h.prepare();
  h.db.failure=(text,reader)=>reader&&text.includes('source_row_number');
  await assert.rejects(source.lookup([INN]),(error)=>{
    assert.equal(error.code,'contacts_source_unavailable');assert.equal(error.message,'contacts_source_unavailable');
    assert.equal(error.cause,undefined);return true;
  });
  assert.equal(h.calls.at(-1).text,'ROLLBACK');
  assert.doesNotMatch(JSON.stringify(h.logs),/private-password|Иван|postgresql:/u);
  await source.close();await source.close();assert.equal(h.pools.at(-1).ended,true);
  await assert.rejects(source.lookup([INN]),{code:'contacts_source_closed'});
});

test('idle errors from bootstrap and reader pools are handled without a crash or provider details',async(t)=>{
  const h=await harness(t);const source=await h.prepare();t.after(()=>source.close());
  for(const pool of h.pools){
    assert.equal(pool.listenerCount('error'),1);
    assert.doesNotThrow(()=>pool.emit('error',new Error('password=private-password SQL client=Иван')));
  }
  assert.deepEqual(h.logs.filter((entry)=>entry.type==='contacts_source_connection_error'),[
    {type:'contacts_source_connection_error'},{type:'contacts_source_connection_error'}]);
  assert.doesNotMatch(JSON.stringify(h.logs),/private-password|Иван|postgresql:/u);
  assert.equal((await source.verify()).ready,true);
});
