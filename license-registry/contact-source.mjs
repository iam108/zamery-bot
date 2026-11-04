import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {isValidInn} from './core.mjs';
import {parseContactRequest} from './contact-match.mjs';

const SCHEMA='license_registry_contacts';
const ROLE='license_registry_contacts_reader';
const MARKER='license-registry:contacts-source:v1';
const CASE_COLUMNS=['id','org','inn','address','contacts','client','phone','request_id','order_id','created_at'];
const MAX_INNS=100;
const MAX_PER_INN=1000;
const TIMEOUT=5000;
const q=(value)=>`'${String(value).replace(/'/gu,"''")}'`;
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const safeError=(error,otherwise='contacts_source_unavailable')=>{
  const code=typeof error?.code==='string'&&/^contacts_source_[a-z_]+$/u.test(error.code)?error.code:otherwise;
  return Object.assign(new Error(code),{code});
};
const emit=(log,value)=>{try{log?.(value);}catch{ /* Logging must not expose or interrupt the source. */ }};
const timestamp=(value)=>value instanceof Date?value.toISOString():typeof value==='string'?value:null;
const marker=(chatId)=>`${MARKER}:clients_chat_id=${chatId}`;

function connection(input,{reader=false}={}){
  let url;
  try{url=new URL(input);}catch{fail('contacts_source_connection_invalid');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.username||!url.password||url.hash||url.search
    ||!/^[-a-z0-9]+(?:\.[-a-z0-9]+)*\.railway\.internal$/u.test(url.hostname)
    ||!/^\/(?:[^/]+)$/u.test(url.pathname))fail('contacts_source_connection_invalid');
  let user,database;
  try{user=decodeURIComponent(url.username);database=decodeURIComponent(url.pathname.slice(1));}
  catch{fail('contacts_source_connection_invalid');}
  if(!user||!database||/[\u0000-\u001f/]/u.test(database)||database.length>63||user.length>63
    ||(reader&&user!==ROLE))fail('contacts_source_connection_invalid');
  return {url,user,database};
}

async function loadCredential(file){
  let stat;
  try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  // A crash between publishing and unlinking the temporary hard link can leave
  // two links to the same complete 0600 file. It must remain usable on restart.
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192||(stat.mode&0o077))fail('contacts_source_credentials_invalid');
  const value=(await fs.readFile(file,'utf8')).trim();
  connection(value,{reader:true});
  return value;
}

// Publish a complete credential before committing DDL. A rollback leaves the same
// credential available for a retry, and an existing credential is never replaced.
async function persistCredential(file,value){
  const temporary=`${file}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try{
    handle=await fs.open(temporary,'wx',0o600);
    await handle.writeFile(`${value}\n`);await handle.sync();await handle.close();handle=null;
    try{await fs.link(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}
    await fs.unlink(temporary);
    const directory=await fs.open(path.dirname(file),'r');
    try{await directory.sync();}finally{await directory.close();}
    return await loadCredential(file);
  }finally{
    await handle?.close().catch(()=>{});
    await fs.unlink(temporary).catch(()=>{});
  }
}

async function defaultPoolFactory(options){
  const pg=await import('pg');
  return new (pg.Pool??pg.default.Pool)(options);
}
function options(url,bootstrap=false){
  return {connectionString:url,max:1,connectionTimeoutMillis:TIMEOUT,idleTimeoutMillis:10_000,
    statement_timeout:TIMEOUT,query_timeout:TIMEOUT+1000,
    application_name:bootstrap?'license-registry-contacts-bootstrap':'license-registry-contacts-reader'};
}
function handleIdleErrors(pool,log){
  // pg emits idle-client failures on Pool rather than on a pending query. Keep
  // the listener synchronous and never forward the provider's error object.
  if(typeof pool.on==='function')pool.on('error',()=>emit(log,{type:'contacts_source_connection_error'}));
  return pool;
}
async function transaction(pool,readOnly,operation){
  const client=await pool.connect();let begun=false;
  try{
    await client.query(readOnly?'BEGIN READ ONLY':'BEGIN');begun=true;
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${TIMEOUT}ms'`);
    const result=await operation(client);
    await client.query('COMMIT');begun=false;return result;
  }catch(error){
    if(begun)await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}

function assertRole(row,expectedMarker){
  if(!row||row.marker!==expectedMarker||row.rolcanlogin!==true||row.rolsuper!==false
    ||row.rolcreatedb!==false||row.rolcreaterole!==false||row.rolinherit!==false
    ||row.rolreplication!==false||row.rolbypassrls!==false)fail('contacts_source_role_conflict');
}
async function roleMetadata(client){
  return (await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
    shobj_description(oid,'pg_authid') AS marker FROM pg_catalog.pg_roles WHERE rolname=$1`,[ROLE])).rows[0];
}
async function scopeMetadata(client){
  const schema=(await client.query(`SELECT pg_get_userbyid(nspowner) AS owner,obj_description(oid,'pg_namespace') AS marker
    FROM pg_catalog.pg_namespace WHERE nspname=$1`,[SCHEMA])).rows[0];
  const relations=(await client.query(`SELECT c.relname AS name,c.relkind,pg_get_userbyid(c.relowner) AS owner,
    obj_description(c.oid,'pg_class') AS marker FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1`,[SCHEMA])).rows;
  const routines=(await client.query(`SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$1 LIMIT 1`,[SCHEMA])).rows;
  return {schema,relations,routines};
}
function assertScope(scope,expectedMarker,owner,{allowMissing=false}={}){
  if(!scope.schema){if(allowMissing&&!scope.relations.length&&!scope.routines.length)return;fail('contacts_source_schema_conflict');}
  if(scope.schema.marker!==expectedMarker||scope.schema.owner!==owner||scope.routines.length
    ||scope.relations.some((row)=>!['cases','incoming_reports'].includes(row.name)||row.relkind!=='v'
      ||row.owner!==owner||row.marker!==expectedMarker))fail('contacts_source_schema_conflict');
}

async function privileges(client){
  return (await client.query(`SELECT
    has_table_privilege($1::name,'public.cases','SELECT') AS cases_select,
    has_table_privilege($1::name,'public.reports','SELECT') AS reports_select,
    has_table_privilege($1::name,'public.cases','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS cases_write,
    has_table_privilege($1::name,'public.reports','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS reports_write,
    has_table_privilege($1::name,'${SCHEMA}.cases','SELECT') AS cases_view_select,
    has_table_privilege($1::name,'${SCHEMA}.incoming_reports','SELECT') AS reports_view_select,
    has_table_privilege($1::name,'${SCHEMA}.cases','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS cases_view_write,
    has_table_privilege($1::name,'${SCHEMA}.incoming_reports','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS reports_view_write,
    has_schema_privilege($1::name,$2::text,'USAGE') AS schema_usage,
    has_schema_privilege($1::name,$2::text,'CREATE') AS schema_create,
    has_schema_privilege($1::name,'public','CREATE') AS public_create,
    has_database_privilege($1::name,current_database(),'CREATE') AS database_create,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1)) AS memberships`,[ROLE,SCHEMA])).rows[0];
}
function assertPrivileges(row){
  if(!row||row.cases_view_select!==true||row.reports_view_select!==true||row.schema_usage!==true
    ||['cases_select','reports_select','cases_write','reports_write','cases_view_write','reports_view_write',
      'schema_create','public_create','database_create','memberships'].some((key)=>row[key]!==false))fail('contacts_source_permissions_invalid');
}

async function bootstrap({pool,url,stored,file,chatId}){
  return transaction(pool,false,async(client)=>{
    await client.query('SELECT pg_advisory_xact_lock(108, 771074)');
    const identity=(await client.query('SELECT current_user AS owner,current_database() AS database')).rows[0];
    if(!identity?.owner||identity.owner===ROLE||identity.database!==url.database)fail('contacts_source_bootstrap_invalid');
    const expectedMarker=marker(chatId);
    const scope=await scopeMetadata(client);assertScope(scope,expectedMarker,identity.owner,{allowMissing:true});
    const existingRole=await roleMetadata(client);
    if(existingRole){assertRole(existingRole,expectedMarker);if(!stored)fail('contacts_source_credentials_missing');}
    const columns=(await client.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY($1::text[])`,[['cases','reports']])).rows;
    const names=(table)=>new Set(columns.filter((r)=>r.table_name===table).map((r)=>r.column_name));
    const cases=names('cases'),reports=names('reports');
    if(['id','org','inn','address','client','phone','order_id','created_at'].some((name)=>!cases.has(name))
      ||['id','text','created_at','chat_id'].some((name)=>!reports.has(name)))fail('contacts_source_schema_missing');
    if(!stored){
      const readonly=new URL(url.url);readonly.username=ROLE;readonly.password=randomBytes(32).toString('base64url');
      stored=await persistCredential(file,readonly.toString());
    }
    const reader=connection(stored,{reader:true});
    if(reader.url.hostname!==url.url.hostname||(reader.url.port||'5432')!==(url.url.port||'5432')
      ||reader.database!==url.database)fail('contacts_source_connection_mismatch');
    if(!scope.schema){
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`COMMENT ON SCHEMA ${SCHEMA} IS ${q(expectedMarker)}`);
    }
    if(!existingRole){
      await client.query(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${q(decodeURIComponent(reader.url.password))}`);
      await client.query(`COMMENT ON ROLE ${ROLE} IS ${q(expectedMarker)}`);
    }
    await client.query(`ALTER ROLE ${ROLE} SET default_transaction_read_only = on`);
    const selected=CASE_COLUMNS.map((name)=>cases.has(name)?`c.${name}`:name==='contacts'?`'[]'::jsonb AS contacts`:'NULL::integer AS request_id').join(',');
    await client.query(`CREATE OR REPLACE VIEW ${SCHEMA}.cases WITH (security_barrier=true) AS SELECT ${selected} FROM public.cases c`);
    const forms=[
      'Новая форма заполнена|Наименование организации[[:space:]]*:',
      '(^|\n)[[:space:]]*ИНН[^:\n]{0,80}:',
      '(^|\n)[[:space:]]*Имя клиента[[:space:]]*:',
      '(^|\n)[[:space:]]*(Номер|Телефон|Номер телефона|Телефон клиента)[[:space:]]*:',
      '(^|\n)[[:space:]]*(Адрес|Адрес лицензирования|Адрес объекта)[[:space:]]*:'
    ].map((pattern)=>`r.text ~* ${q(pattern)}`).join(' AND ');
    await client.query(`CREATE OR REPLACE VIEW ${SCHEMA}.incoming_reports WITH (security_barrier=true) AS
      SELECT r.id,r.text,r.created_at FROM public.reports r WHERE r.chat_id=${q(chatId)}::bigint
      AND ${forms}`);
    for(const name of ['cases','incoming_reports'])await client.query(`COMMENT ON VIEW ${SCHEMA}.${name} IS ${q(expectedMarker)}`);
    // All revokes are limited to objects owned by this component.
    await client.query(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON ${SCHEMA}.cases,${SCHEMA}.incoming_reports FROM PUBLIC,${ROLE}`);
    await client.query(`GRANT CONNECT ON DATABASE "${identity.database.replace(/"/gu,'""')}" TO ${ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${ROLE}`);
    await client.query(`GRANT SELECT ON ${SCHEMA}.cases,${SCHEMA}.incoming_reports TO ${ROLE}`);
    assertPrivileges(await privileges(client));
    return stored;
  });
}

export async function prepareContactSource({env=process.env,dataDir,log,poolFactory=defaultPoolFactory}={}){
  let bootstrapPool,pool;
  try{
    if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))fail('contacts_source_directory_invalid');
    const chatId=String(env.CONTACTS_CLIENTS_CHAT_ID??'');
    if(!/^-[1-9]\d{0,17}$/u.test(chatId)||BigInt(chatId)<-9223372036854775808n)fail('contacts_source_chat_invalid');
    const directory=path.join(dataDir,'secrets');await fs.mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,'contacts-db-url');
    let stored=await loadCredential(file);
    const bootstrapUrl=env.CONTACTS_BOOTSTRAP_DATABASE_URL;
    if(bootstrapUrl){
      const url=connection(bootstrapUrl);
      bootstrapPool=handleIdleErrors(await poolFactory(options(url.url.toString(),true)),log);
      if(env.CONTACTS_FORM_DIAGNOSTIC==='true'){
        const patterns={form_title:'Новая форма заполнена',organization:'Наименование организации',inn:'ИНН',
          client_name:'Имя клиента',client:'Клиент[[:space:]]*:',contact:'Контакт',name:'Имя[[:space:]]*:',
          phone:'Телефон',number:'Номер[[:space:]]*:',address:'Адрес',
          line_inn:'(^|\n)[[:space:]]*ИНН[[:space:]]*:',
          line_name:'(^|\n)[[:space:]]*Имя клиента[[:space:]]*:',
          line_phone:'(^|\n)[[:space:]]*(Номер|Телефон|Номер телефона|Телефон клиента)[[:space:]]*:',
          line_address:'(^|\n)[[:space:]]*(Адрес|Адрес лицензирования)[[:space:]]*:'};
        const keys=Object.keys(patterns);
        const counts=await transaction(bootstrapPool,true,async(client)=>(await client.query(
          `SELECT count(*)::text AS total,
           count(*) FILTER (WHERE text ~* 'Новая форма заполнена' AND COALESCE((to_jsonb(reports)->>'dismissed')::boolean,false))::text AS hidden_forms,
           ${keys.map((key,index)=>`count(*) FILTER (WHERE text ~* $${index+2})::text AS ${key}`).join(',')}
           FROM public.reports WHERE chat_id=$1`,[chatId,...Object.values(patterns)])).rows[0]);
        emit(log,{type:'contacts_form_diagnostic',counts:Object.fromEntries(['total','hidden_forms',...keys].map((key)=>[key,Number(counts?.[key]??0)]))});
      }
      stored=await bootstrap({pool:bootstrapPool,url,stored,file,chatId});
      await bootstrapPool.end();bootstrapPool=null;
      delete env.CONTACTS_BOOTSTRAP_DATABASE_URL;
    }
    if(!stored)fail('contacts_source_credentials_missing');
    connection(stored,{reader:true});
    pool=handleIdleErrors(await poolFactory(options(stored)),log);
    let closed=false;
    const source={
      async verify(){
        try{
          if(closed)fail('contacts_source_closed');
          return await transaction(pool,true,async(client)=>{
            const identity=(await client.query(`SELECT current_user AS role,current_setting('default_transaction_read_only') AS default_read_only,
              current_setting('transaction_read_only') AS transaction_read_only`)).rows[0];
            if(identity?.role!==ROLE||identity.default_read_only!=='on'||identity.transaction_read_only!=='on')fail('contacts_source_permissions_invalid');
            const scope=await scopeMetadata(client);
            if(!scope.schema?.owner||scope.schema.owner===ROLE||scope.relations.length!==2)fail('contacts_source_schema_conflict');
            assertScope(scope,marker(chatId),scope.schema.owner);
            assertRole(await roleMetadata(client),marker(chatId));
            assertPrivileges(await privileges(client));
            const counts=(await client.query(`SELECT (SELECT count(*)::text FROM ${SCHEMA}.cases) AS cases,
              (SELECT count(*)::text FROM ${SCHEMA}.incoming_reports) AS incoming_reports`)).rows[0];
            const cases=Number(counts?.cases),incomingReports=Number(counts?.incoming_reports);
            if(!Number.isSafeInteger(cases)||cases<0||!Number.isSafeInteger(incomingReports)||incomingReports<0)fail('contacts_source_invalid_response');
            return {ready:true,schema:SCHEMA,cases,incomingReports};
          });
        }catch(error){throw safeError(error);}
      },
      async lookup(inns){
        try{
          if(closed)fail('contacts_source_closed');
          if(!Array.isArray(inns)||inns.length>MAX_INNS||inns.some((inn)=>typeof inn!=='string'||!isValidInn(inn)))fail('contacts_source_invalid_inns');
          const unique=[...new Set(inns)];
          if(!unique.length)return {cases:[],reviews:[]};
          return await transaction(pool,true,async(client)=>{
            const cases=(await client.query(`SELECT * FROM (SELECT ${CASE_COLUMNS.map((name)=>`c.${name}`).join(',')},
              row_number() OVER (PARTITION BY c.inn ORDER BY c.id) AS source_row_number
              FROM ${SCHEMA}.cases c WHERE c.inn=ANY($1::text[])) bounded WHERE source_row_number<=$2`,[unique,MAX_PER_INN+1])).rows;
            const expression=`(^|[^0-9])(${unique.join('|')})([^0-9]|$)`;
            const reports=(await client.query(`SELECT * FROM (SELECT requested.inn AS lookup_inn,r.id,r.text,r.created_at,
              row_number() OVER (PARTITION BY requested.inn ORDER BY r.id) AS source_row_number
              FROM ${SCHEMA}.incoming_reports r JOIN unnest($1::text[]) AS requested(inn)
              ON r.text ~ ('(^|[^0-9])'||requested.inn||'([^0-9]|$)') WHERE r.text ~ $2) bounded WHERE source_row_number<=$3`,[unique,expression,MAX_PER_INN+1])).rows;
            const reviews=new Map(),caseCounts=new Map(),reportCounts=new Map();
            const result=[];
            for(const row of cases){
              if(!unique.includes(row.inn))fail('contacts_source_invalid_response');
              const count=(caseCounts.get(row.inn)??0)+1;caseCounts.set(row.inn,count);
              if(count>MAX_PER_INN){reviews.set(row.inn,'contacts_source_case_overflow');continue;}
              result.push(Object.fromEntries(CASE_COLUMNS.map((name)=>[name,name==='created_at'?timestamp(row[name]):row[name]??null])));
            }
            for(const report of reports){
              const inn=report.lookup_inn;if(!unique.includes(inn))fail('contacts_source_invalid_response');
              const count=(reportCounts.get(inn)??0)+1;reportCounts.set(inn,count);
              if(count>MAX_PER_INN){reviews.set(inn,'contacts_source_report_overflow');continue;}
              const parsed=parseContactRequest({id:report.id,text:report.text,created_at:timestamp(report.created_at)});
              if(parsed?.status!=='ready'||parsed.source.inn!==inn){
                if(!reviews.has(inn))reviews.set(inn,'contacts_source_report_review');continue;
              }
              result.push(parsed.source);
            }
            return {cases:result.filter((item)=>!reviews.has(item.inn)),
              reviews:unique.filter((inn)=>reviews.has(inn)).map((inn)=>({inn,reason:reviews.get(inn)}))};
          });
        }catch(error){throw safeError(error);}
      },
      async close(){if(closed)return;closed=true;try{await pool.end();}catch{throw safeError(null);}}
    };
    emit(log,{type:'contacts_source_prepared',schema:SCHEMA,bootstrapped:Boolean(bootstrapUrl)});
    return source;
  }catch(error){
    await bootstrapPool?.end().catch(()=>{});await pool?.end().catch(()=>{});
    throw safeError(error);
  }
}
