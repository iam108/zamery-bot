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

const dir=path.dirname(fileURLToPath(import.meta.url));
const env=process.env;
const controller=new AbortController();
const secrets=[env.BOT_TOKEN,env.FSRAR_API_KEY,env.GOOGLE_SERVICE_ACCOUNT_JSON].filter(Boolean);
const health=createReadiness({secrets});
let stopping=false;
let startupDependency=null;
let notificationReporter=null;
let proofStore=null;
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
  const google=monitoredGoogle(new GoogleSheetsClient({spreadsheetId:config.spreadsheetId,sheetName:config.sheetName,
    sheetId:config.sheetId,credentials:env.GOOGLE_SERVICE_ACCOUNT_JSON||env.GOOGLE_APPLICATION_CREDENTIALS}));
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
  // Explicit one-time acceptance uses private logs, not owner notifications.
  if(env.ACCEPTANCE_SOURCE_JOB_ID)await runReadOnlyAcceptance({sourceJobId:env.ACCEPTANCE_SOURCE_JOB_ID,store,google,api});
  const worker=new LicenseWorker({store,google,api,config,dryRun:env.DRY_RUN==='true',report});
  startupDependency=null;health.running({dryRun:env.DRY_RUN==='true'});
  await report({type:'runtime_initialized',targetChatId:String(target.id),dryRun:env.DRY_RUN==='true',
    fsrarQuota:{total:quota.total,used:quota.used,remaining:quota.remaining}});
  return {store,telegram,worker,config,botId:target.botId};
}

async function run({store,telegram,worker,config,botId}){
  const log=(event)=>console.log(JSON.stringify({at:new Date().toISOString(),...event}));
  const monitor=createPollingMonitor({store,report,log});
  const polling=(async()=>{
    while(!stopping){
      const result=await pollOnce({store,telegram,monitor,health,signal:controller.signal,secrets,log,
        persist:(updates)=>worker.persistUpdates(updates,(update)=>convertUpdate(update,
          {targetChatId:config.targetChatId,sourceChatId:config.sourceChatId,botId}))});
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
  await Promise.all([polling,processing]);
}

function stop(){stopping=true;health.stopping();controller.abort();server.close();}
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
