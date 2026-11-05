import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {GoogleSheetsClient} from './google.mjs';
import {TelegramClient,convertUpdate} from './telegram.mjs';
import {LicenseWorker,FsrarClient,prepareSecrets,initializeState,classifyApiFailure,privateStateProof} from './runtime.mjs';
import {createReadiness,createHealthHandler,safeErrorCode,validateFsrarStat,retryStartup} from './health.mjs';
import {createNotifier} from './notifier.mjs';
import {runReadOnlyAcceptance} from './acceptance.mjs';
import {createPollingMonitor,pollOnce,safeNotification} from './polling.mjs';
import {importOfficialLicenseEvidence} from './official-evidence.mjs';
import {prepareContactSource} from './contact-source.mjs';
import {ContactWorker,triggerContactSync} from './contact-worker.mjs';
import {convertOwnerUpdate,contactReplyCoverage} from './contact-reply-input.mjs';
import {ContactReplyWorker} from './contact-reply-worker.mjs';
import {RegistryCompletionWorker} from './registry-completion.mjs';

const dir=path.dirname(fileURLToPath(import.meta.url));
const env=process.env;
const controller=new AbortController();
const secrets=[env.BOT_TOKEN,env.FSRAR_API_KEY,env.GOOGLE_SERVICE_ACCOUNT_JSON].filter(Boolean);
const contactsEnabled=env.CONTACT_SYNC_ENABLED==='true'&&env.DRY_RUN!=='true';
const registryCompletionEnabled=env.REGISTRY_COMPLETION_ENABLED==='true'&&env.DRY_RUN!=='true'&&Boolean(env.NOTIFY_CHAT_ID);
const ownerRepliesEnabled=(contactsEnabled||registryCompletionEnabled)&&Boolean(env.NOTIFY_CHAT_ID);
const health=createReadiness({secrets,contactsEnabled,ownerRepliesEnabled,registryCompletionEnabled});
let stopping=false;
let startupDependency=null;
let notificationReporter=null;
let proofStore=null;
let contactSource=null;
const seenReports=new Map();
async function report(event){
  const clean={at:new Date().toISOString(),...event};
  if(clean.code)clean.code=safeErrorCode(clean.code,'processing_failed',secrets);
  if(proofStore&&['runtime_initialized','write_verified'].includes(clean.type)){
    try{console.log(JSON.stringify({at:clean.at,type:'state_proof',trigger:clean.type,...privateStateProof(await proofStore.read())}));}
    catch{console.log(JSON.stringify({at:clean.at,type:'state_proof_error',trigger:clean.type,code:'state_read_failed'}));}
  }
  if(notificationReporter)return safeNotification(notificationReporter,{log:(event)=>console.log(JSON.stringify(event))})(clean);
  const fingerprint=JSON.stringify({...clean,at:undefined});
  if(Date.now()-(seenReports.get(fingerprint)||0)<3600000)return;
  seenReports.set(fingerprint,Date.now());
  console.log(JSON.stringify(clean));
}
const server=http.createServer(createHealthHandler(health));
server.listen(Number(env.PORT||8080),'0.0.0.0');

function monitoredGoogle(client){
  return Object.fromEntries(['context','applyPlan'].map((method)=>[method,async(...args)=>{
    try{const result=await client[method](...args);health.success('google');return result;}
    catch(error){health.failure('google',error,'google_failed');throw error;}
  }]));
}
function monitoredApi(client){
  return {
    async validate(){try{return await client.validate();}catch(error){health.failure('api',error,'fsrar_key_invalid');throw error;}},
    async request(method,job){
      const response=await client.request(method,job);
      if(method==='stat'){
        try{validateFsrarStat(response);health.success('api');}catch(error){health.failure('api',error);throw error;}
      }else{
        const failure=classifyApiFailure(response);
        if(failure)health.failure('api',failure);else health.success('api');
      }
      return response;
    },
  };
}

// Initialization starts no loops, so retrying it cannot create two pollers.
async function initialize(){
  health.begin();startupDependency=null;
  for(const key of ['BOT_TOKEN','TARGET_CHAT_ID'])if(!env[key])throw new Error(`missing_${key.toLowerCase()}`);
  if(!env.GOOGLE_SERVICE_ACCOUNT_JSON&&!env.GOOGLE_APPLICATION_CREDENTIALS)throw new Error('missing_google_credentials');
  let disk;
  try{disk=JSON.parse(await fs.readFile(env.CONFIG_FILE||path.join(dir,'config.json'),'utf8'));}
  catch{throw new Error('config_file_missing_or_invalid');}
  const config={...disk,spreadsheetId:env.SPREADSHEET_ID||disk.spreadsheetId,
    sheetName:env.SHEET_NAME||disk.sheetName,sheetId:Number(env.SHEET_ID??disk.sheetId??0),
    timeZone:env.TIME_ZONE||disk.timeZone,dailyHour:Number(env.DAILY_HOUR??disk.dailyHour??9),
    targetChatId:env.TARGET_CHAT_ID,sourceChatId:env.SOURCE_CHAT_ID||disk.chatId};
  const stateFile=env.STATE_FILE||'/data/state.json';
  const {keyFile}=await prepareSecrets(env,path.dirname(stateFile));
  const store=await initializeState(stateFile,config,env);
  proofStore=store;
  const googleClient=new GoogleSheetsClient({spreadsheetId:config.spreadsheetId,sheetName:config.sheetName,
    sheetId:config.sheetId,credentials:env.GOOGLE_SERVICE_ACCOUNT_JSON||env.GOOGLE_APPLICATION_CREDENTIALS});
  const google=monitoredGoogle(googleClient);
  const telegram=new TelegramClient({token:env.BOT_TOKEN});
  notificationReporter=createNotifier({telegram,store,ownerChatId:env.NOTIFY_CHAT_ID});
  await notificationReporter.verifyOwner();
  startupDependency='telegram';health.stage('verifying_telegram');
  const target=await telegram.verifyTarget({targetChatId:config.targetChatId,chatTitle:disk.chatTitle});
  // Verification grants the first 30-second poll a short readiness grace.
  health.success('telegram');
  startupDependency='google';health.stage('verifying_google');await google.context();
  startupDependency='api';health.stage('verifying_fsrar');
  const api=monitoredApi(new FsrarClient({keyFile,proxyUrl:env.FSRAR_PROXY_URL,proxyServerName:env.FSRAR_PROXY_SERVER_NAME}));await api.validate();
  const quota=validateFsrarStat(await api.request('stat'));
  console.log(JSON.stringify({at:new Date().toISOString(),type:'api_quota',total:quota.total,used:quota.used,remaining:quota.remaining}));
  if(env.OFFICIAL_LICENSE_EVIDENCE_JSON){
    let payload;try{payload=JSON.parse(env.OFFICIAL_LICENSE_EVIDENCE_JSON);}catch{throw new Error('official_evidence_invalid_json');}
    const result=await importOfficialLicenseEvidence({store,payload});
    console.log(JSON.stringify({at:new Date().toISOString(),type:'official_evidence_import',status:result.status,
      jobId:/^[a-f0-9]{24}$/u.test(payload.jobId)?payload.jobId:null}));
  }
  // Explicit one-time acceptance uses private logs, not owner notifications.
  if(env.ACCEPTANCE_SOURCE_JOB_ID)await runReadOnlyAcceptance({sourceJobId:env.ACCEPTANCE_SOURCE_JOB_ID,store,google,api});
  const worker=new LicenseWorker({store,google,api,config,dryRun:env.DRY_RUN==='true',report});
  if(contactsEnabled&&env.CONTACT_SYNC_RUN_ID)await triggerContactSync(store,env.CONTACT_SYNC_RUN_ID);
  const contacts=contactsEnabled?new ContactWorker({store,google:googleClient,report,
    log:(event)=>console.log(JSON.stringify({at:new Date().toISOString(),...event})),
    sourceFactory:async()=>{
      const source=await prepareContactSource({env,dataDir:path.dirname(stateFile),
        log:(event)=>console.log(JSON.stringify({at:new Date().toISOString(),...event}))});
      try{
        const checked=await source.verify();
        console.log(JSON.stringify({at:new Date().toISOString(),type:'contacts_source_verified',ready:checked.ready,
          cases:checked.cases,incomingReports:checked.incomingReports}));
      }catch(error){await source.close().catch(()=>{});throw error;}
      contactSource=source;return source;
    }}):null;
  const registryCompletion=registryCompletionEnabled?new RegistryCompletionWorker({store,google:googleClient,api,config,telegram,
    ownerChatId:env.NOTIFY_CHAT_ID,botId:target.botId,
    log:(event)=>console.log(JSON.stringify({at:new Date().toISOString(),...event}))}):null;
  if(registryCompletion){startupDependency='registryCompletion';await registryCompletion.discover(await googleClient.context());}
  const contactReplies=contactsEnabled&&ownerRepliesEnabled?new ContactReplyWorker({store,google:googleClient,telegram,
    ownerChatId:env.NOTIFY_CHAT_ID,botId:target.botId,
    deferEvent:(state,event)=>Boolean(registryCompletion?.routeFor(state,event)),
    log:(event)=>console.log(JSON.stringify({at:new Date().toISOString(),...event}))}):null;
  if(contactReplies)console.log(JSON.stringify({at:new Date().toISOString(),type:'contact_reply_links_verified',
    ...contactReplyCoverage(await store.read(),{ownerChatId:env.NOTIFY_CHAT_ID,botId:target.botId})}));
  startupDependency=null;health.running({dryRun:env.DRY_RUN==='true'});
  await report({type:'runtime_initialized',targetChatId:String(target.id),dryRun:env.DRY_RUN==='true',
    fsrarQuota:{total:quota.total,used:quota.used,remaining:quota.remaining}});
  return {store,telegram,worker,contacts,contactReplies,registryCompletion,config,botId:target.botId};
}

async function run({store,telegram,worker,contacts,contactReplies,registryCompletion,config,botId}){
  const log=(event)=>console.log(JSON.stringify({at:new Date().toISOString(),...event}));
  const monitor=createPollingMonitor({store,report,log});
  function wakeSignal(){
    let resolve=null;let notified=false;
    return {notify(){notified=true;resolve?.();},async wait(){
      if(notified){notified=false;return;}
      const waitController=new AbortController();
      const abort=()=>waitController.abort();controller.signal.addEventListener('abort',abort,{once:true});
      try{await Promise.race([new Promise((done)=>{resolve=done;}),sleep(60000,undefined,{signal:waitController.signal}).catch(()=>{})]);}
      finally{resolve=null;notified=false;waitController.abort();controller.signal.removeEventListener('abort',abort);}
    }};
  }
  const ownerWake=wakeSignal(),completionWake=wakeSignal();
  const polling=(async()=>{
    while(!stopping){
      const result=await pollOnce({store,telegram,monitor,health,signal:controller.signal,secrets,log,
        persist:async(updates)=>{
          const result=await worker.persistUpdates(updates,(update)=>convertUpdate(update,
            {targetChatId:config.targetChatId,sourceChatId:config.sourceChatId,botId}),
            ownerRepliesEnabled?(update)=>convertOwnerUpdate(update,{ownerChatId:env.NOTIFY_CHAT_ID,botId}):undefined);
          if(contactReplies||registryCompletion)ownerWake.notify();return result;
        }});
      if(result.stopped)break;
      if(!result.ok)await sleep(result.retryMs,undefined,{signal:controller.signal}).catch(()=>{});
    }
  })();
  const processing=(async()=>{
    while(!stopping){
      try{
        const summary=await worker.tick();
        health.success('worker');
        if(summary?.api?.blocked){
          health.failure('api',summary.api.blocked.code);
          await report({type:'api_blocked',code:summary.api.blocked.code});
        }
        const state=await store.read();
        for(const job of Object.values(state.jobs))if(job.status==='review'||job.sourceReviewRequired)await report({type:'review_required',jobId:job.id,organization:job.organization,
          code:job.sourceReviewRequired?'source_message_edited':job.reason});
      }catch(error){
        const code=safeErrorCode(error,'worker_tick_failed',secrets);
        health.failure('worker',code);await report({type:'worker_error',code});
      }
      // A notification retry must continue after the licensing job is already done.
      if(notificationReporter)await safeNotification(()=>notificationReporter.flush(),{log})();
      await sleep(60000,undefined,{signal:controller.signal}).catch(()=>{});
    }
  })();
  const enriching=contacts?(async()=>{
    let verified=false;
    while(!stopping){
      try{
        if(!verified){const source=await contacts.sourceFactory();await source.close();health.success('contacts');verified=true;}
        const result=await contacts.tick();
        if(!result?.skipped)health.success('contacts');
      }catch(error){
        verified=false;
        const code=safeErrorCode(error,'contacts_source_failed',secrets);
        health.failure('contacts',code);await report({type:'contact_source_error',code});
      }
      await sleep(60000,undefined,{signal:controller.signal}).catch(()=>{});
    }
  })():Promise.resolve();
  const replying=contactReplies||registryCompletion?(async()=>{
    while(!stopping){
      try{
        if(registryCompletion&&await registryCompletion.ingestOwnerReplies())completionWake.notify();
        const result=contactReplies?await contactReplies.tick():null;health.success('ownerReplies');
        if(result?.saved)log({type:'state_proof',trigger:'manual_contact_write_verified',...privateStateProof(await store.read())});
      }
      catch(error){health.failure('ownerReplies',safeErrorCode(error,'contact_reply_failed',secrets));
        log({type:'contact_reply_error',code:safeErrorCode(error,'contact_reply_failed',secrets)});}
      if(!stopping)await ownerWake.wait();
    }
  })():Promise.resolve();
  const completing=registryCompletion?(async()=>{
    while(!stopping){
      try{
        const result=await registryCompletion.tick();health.success('registryCompletion');
        if((result?.saved??result?.updated??result?.written??0)>0){
          log({type:'state_proof',trigger:'registry_gap_write_verified',...privateStateProof(await store.read())});
          if(contacts){
            const journal=(await store.read()).journal;
            const last=[...journal].reverse().find((item)=>item.type==='registry_completion_write_verified');
            if(last?.planHash){
              await triggerContactSync(store,`registry-${last.planHash}`);
              try{const contactResult=await contacts.tick();if(!contactResult?.skipped)health.success('contacts');}
              catch(error){health.failure('contacts',safeErrorCode(error,'contacts_source_failed',secrets));}
            }
          }
        }
      }catch(error){
        const code=safeErrorCode(error,'registry_completion_failed',secrets);health.failure('registryCompletion',code);
        log({type:'registry_completion_error',code});
      }
      if(!stopping)await completionWake.wait();
    }
  })():Promise.resolve();
  await Promise.all([polling,processing,enriching,replying,completing]);
}

function stop(){stopping=true;health.stopping();controller.abort();server.close();contactSource?.close().catch(()=>{});}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
try{
  const runtime=await retryStartup(initialize,{signal:controller.signal,onFailure:async(error,{delayMs})=>{
    const code=safeErrorCode(error,'startup_failed',secrets);
    if(startupDependency)health.failure(startupDependency,code);
    health.startupFailure(code,{delayMs});
    await report({type:'startup_failed',code});
  }});
  if(runtime&&!stopping)await run(runtime);
}catch(error){
  health.startupFailure(safeErrorCode(error,'runtime_failed',secrets));
  await report({type:'runtime_failed',code:safeErrorCode(error,'runtime_failed',secrets)});
  // Stop the whole instance instead of restarting while another loop is alive.
  stop();process.exitCode=1;
}
