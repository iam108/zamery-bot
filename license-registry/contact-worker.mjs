import {hash} from './state.mjs';
import {isValidInn,normalizeAddress,normalizeDate,normalizeLicenseNumber,parseSheetRows,localDate} from './core.mjs';
import {planContactEnrichment} from './contact-match.mjs';
import {buildContactPlan,applyContactPlan,verifyContactPlan} from './contact-google.mjs';

const clone=(value)=>structuredClone(value);
const clean=(value)=>String(value??'').trim();
const stamp=(now)=>new Date(now()).toISOString();
const failure=(code)=>Object.assign(new Error(code),{code});
const definite=new Set(['contact_plan_invalid','contact_identity_changed','contact_row_moved','contact_row_ambiguous',
  'contact_cell_protected','contact_cell_conflict','contact_readback_mismatch']);
const accepted=(result)=>result==null||['sent','pending','duplicate','log_only'].includes(result.delivery);
const groupKey=(row)=>hash([clean(row.inn),normalizeAddress(row.address)]);
const rowKey=(row)=>hash([clean(row.inn),normalizeAddress(row.address),normalizeLicenseNumber(row.licenseNumber),normalizeDate(row.issueDate),normalizeDate(row.expiryDate)]);
const candidateHash=(candidate)=>hash([candidate?.name??null,candidate?.phone??null,candidate?.telegram??null]);
const active=(row,today)=>isValidInn(row.inn)&&normalizeAddress(row.address)&&row.issueDate&&row.expiryDate&&row.issueDate<=today&&today<=row.expiryDate;
const gap=(row)=>[12,13,14].some((index)=>!clean(row.values?.[index]));
const snapshot=(row)=>({rowNumber:row.rowNumber,inn:row.inn,licenseNumber:row.licenseNumber??'',issueDate:row.issueDate,
  expiryDate:row.expiryDate,address:row.address,name:clean(row.values?.[12]),phone:clean(row.values?.[13]),telegram:clean(row.values?.[14])});
function initialize(state){
  state.contacts??={};state.contacts.records??={};state.contacts.reviews??={};return state.contacts;
}
export async function triggerContactSync(store,runId,now=()=>new Date()){
  if(typeof runId!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/u.test(runId))throw failure('contact_run_id_invalid');
  return store.update((state)=>{
    state.runtime??={};state.runtime.contactRunRequests??={};
    if(state.runtime.contactRunRequests[runId])return false;
    state.runtime.contactRunRequests[runId]=stamp(now);
    Object.assign(initialize(state),{nextSyncAt:null,retryAt:null});return true;
  });
}
function validateReceipt(plan,receipt){
  if(receipt?.verified!==true||receipt.planHash!==plan.hash||receipt.spreadsheetId!==plan.spreadsheetId
    ||receipt.sheetName!==plan.sheetName||receipt.sheetId!==plan.sheetId||receipt.rowNumber!==plan.rowNumber
    ||!Number.isFinite(Date.parse(receipt.verifiedAt))||!receipt.cells
    ||Object.entries(plan.expectedCells).some(([cell,value])=>receipt.cells[cell]!==value))throw failure('contact_receipt_invalid');
  const allowed=new Set(plan.updates.map((update)=>`${update.column}${plan.rowNumber}`));
  if(!Array.isArray(receipt.appliedCells)||receipt.appliedCells.some((cell)=>!allowed.has(cell)))throw failure('contact_receipt_invalid');
  return {verified:true,planHash:plan.hash,spreadsheetId:plan.spreadsheetId,sheetName:plan.sheetName,sheetId:plan.sheetId,
    rowNumber:plan.rowNumber,verifiedAt:receipt.verifiedAt,appliedCells:[...new Set(receipt.appliedCells)],
    cells:Object.fromEntries(Object.entries(plan.expectedCells).map(([cell])=>[cell,receipt.cells[cell]]))};
}

/** Independent fill-empty contact enrichment. It never creates license jobs or calls API-FNS. */
export class ContactWorker{
  constructor({store,google,sourceFactory,now=()=>new Date(),report=async()=>{},log=()=>{},intervalMs=900_000,maxWrites=20,maxReviewNotifications=5}={}){
    if(typeof store?.read!=='function'||typeof store?.update!=='function'||typeof google?.context!=='function'
      ||typeof sourceFactory!=='function'||!Number.isFinite(intervalMs)||intervalMs<1000
      ||!Number.isSafeInteger(maxWrites)||maxWrites<1||!Number.isSafeInteger(maxReviewNotifications)||maxReviewNotifications<1)throw failure('contact_worker_invalid');
    Object.assign(this,{store,google,sourceFactory,now,report,log,intervalMs,maxWrites,maxReviewNotifications});this.busy=false;
  }
  async review(row,code,recordHash=null){
    const key=hash([rowKey(row),code]);const at=stamp(this.now);
    return this.store.update((state)=>{
      const contacts=initialize(state);
      if(recordHash&&contacts.records[recordHash]?.status==='planned')Object.assign(contacts.records[recordHash],{status:'review',reason:code,updatedAt:at});
      if(contacts.reviews[key])return false;
      contacts.reviews[key]={id:key,status:'review',rowKey:rowKey(row),groupKey:groupKey(row),inn:row.inn,organization:clean(row.organization),
        code,recordHash,createdAt:at,notifiedAt:null};
      state.journal.push({at,type:'contact_review_required',contactReviewId:key,code});return true;
    });
  }
  async acknowledge(record,rawReceipt){
    const receipt=validateReceipt(record.plan,rawReceipt);const at=stamp(this.now);
    return this.store.update((state)=>{
      const current=initialize(state).records[record.plan.hash];
      if(current?.status==='done')return false;
      if(current?.status!=='planned'||hash(current.plan)!==hash(record.plan))throw failure('contact_plan_changed');
      Object.assign(current,{status:'done',receipt,verifiedAt:at,updatedAt:at,notificationPending:true});
      state.journal.push({at,type:'contact_write_verified',planHash:record.plan.hash,rowNumber:record.plan.rowNumber,
        cells:receipt.appliedCells.length?receipt.appliedCells:record.plan.updates.map((update)=>`${update.column}${record.plan.rowNumber}`)});
      return true;
    });
  }
  async flushNotifications(){
    const state=await this.store.read();const contacts=state.contacts??{};
    for(const record of Object.values(contacts.records??{}).filter((item)=>item.status==='done'&&item.notificationPending)){
      let result;try{result=await this.report({type:'contact_write_verified',action:'update',jobId:record.plan.hash.slice(0,24),organization:record.organization,
        cells:record.receipt.appliedCells.length?record.receipt.appliedCells:record.plan.updates.map((u)=>`${u.column}${record.plan.rowNumber}`)});}catch{continue;}
      if(accepted(result))await this.store.update((current)=>{const entry=initialize(current).records[record.plan.hash];if(entry?.status==='done')entry.notificationPending=false;});
    }
    const reviews=Object.values((await this.store.read()).contacts?.reviews??{}).filter((item)=>!item.notifiedAt).slice(0,this.maxReviewNotifications);
    for(const item of reviews){
      let result;try{result=await this.report({type:'contact_review_required',jobId:item.id.slice(0,24),organization:item.organization,code:item.code});}catch{continue;}
      if(accepted(result))await this.store.update((current)=>{const entry=initialize(current).reviews[item.id];if(entry)entry.notifiedAt=stamp(this.now);});
    }
  }
  async tick(){
    const summary={scanned:0,updated:0,pending:0,reviews:0,nosource:0,apiCalls:0};
    if(this.busy)return {...summary,skipped:'busy'};this.busy=true;
    let source=null;let remaining=false;
    try{
      const initial=await this.store.read();
      const next=initial.contacts?.retryAt??initial.contacts?.nextSyncAt;
      if(next&&Date.parse(next)>+new Date(this.now()))return {...summary,skipped:'not_due',nextSyncAt:next};
      const today=localDate(this.now(),'Europe/Moscow');
      const replay=[];
      for(const record of Object.values(initial.contacts?.records??{}).filter((item)=>item.status==='planned')){
        if(!active(record.rowSnapshot,today)){
          if(await this.review({...record.rowSnapshot,organization:record.organization},'contact_license_not_active',record.plan.hash))summary.reviews++;
          continue;
        }
        try{if(await this.acknowledge(record,await verifyContactPlan(this.google,record.plan)))summary.updated++;}
        catch(error){
          if(error.code==='contact_readback_pending'&&!definite.has(error.reason))replay.push(record);
          else if(definite.has(error.code)||definite.has(error.reason)||error.code==='contact_receipt_invalid'){
            if(await this.review({...record.rowSnapshot,organization:record.organization},error.reason??error.code,record.plan.hash))summary.reviews++;
          }else remaining=true;
        }
      }
      let context;try{context=await this.google.context();}catch{throw failure('contact_read_failed');}
      const rows=parseSheetRows(context.values,{startRow:context.startRow??1}).filter((row)=>active(row,today));
      const groups=new Map();for(const row of rows){const key=groupKey(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
      const candidates=rows.filter(gap);summary.scanned=candidates.length;
      const inns=[...new Set([...replay.map((record)=>record.rowSnapshot.inn),...candidates.map((row)=>row.inn)])];
      const sourceCases=[];const sourceReviews=[];
      if(inns.length){
        try{
          source=await this.sourceFactory();
          if(typeof source?.verify!=='function'||typeof source?.lookup!=='function'||typeof source?.close!=='function')throw failure('contact_source_unavailable');
          if(await source.verify()===false)throw failure('contact_source_unavailable');
          for(let offset=0;offset<inns.length;offset+=100){
            const found=await source.lookup(inns.slice(offset,offset+100));
            if(!Array.isArray(found?.cases)||!Array.isArray(found?.reviews))throw failure('contact_source_unavailable');
            sourceCases.push(...found.cases);sourceReviews.push(...found.reviews);
          }
        }catch{throw failure('contact_source_unavailable');}
      }
      const hasSource=(row)=>sourceReviews.some((item)=>item?.inn===row.inn)||sourceCases.some((item)=>clean(item?.inn)===row.inn&&normalizeAddress(item?.address)===normalizeAddress(row.address));
      const sourceAmbiguous=(row)=>sourceReviews.some((item)=>item?.inn===row.inn);
      let writes=0;
      for(const record of replay){
        if(writes>=this.maxWrites){remaining=true;continue;}
        const row={...record.rowSnapshot,organization:record.organization};
        const proposal=sourceAmbiguous(row)?{action:'review'}:planContactEnrichment({row,cases:sourceCases});
        if(proposal.action!=='update'||candidateHash(proposal.candidate)!==record.candidateHash){
          if(await this.review(row,'contact_source_changed',record.plan.hash))summary.reviews++;
          continue;
        }
        try{writes++;if(await this.acknowledge(record,await applyContactPlan(this.google,record.plan)))summary.updated++;}
        catch(error){
          if(definite.has(error.code)||error.code==='contact_receipt_invalid'){
            if(await this.review(row,error.code,record.plan.hash))summary.reviews++;
          }else remaining=true;
        }
      }
      for(const row of candidates){
        const latest=await this.store.read();const saved=latest.contacts??{};
        if(Object.values(saved.records??{}).some((item)=>item.status==='planned'&&rowKey(item.rowSnapshot)===rowKey(row)))continue;
        if(Object.values(saved.reviews??{}).some((item)=>item.groupKey===groupKey(row)))continue;
        if(!hasSource(row)){summary.nosource++;continue;}
        if((groups.get(groupKey(row))?.length??0)>1){if(await this.review(row,'contact_row_ambiguous'))summary.reviews++;continue;}
        if(sourceAmbiguous(row)){if(await this.review(row,'contact_source_ambiguous'))summary.reviews++;continue;}
        const proposal=planContactEnrichment({row,cases:sourceCases});
        if(proposal.action==='review'){
          if(!['contact_source_not_found','contact_source_empty'].includes(proposal.reason)&&await this.review(row,proposal.reason))summary.reviews++;
          continue;
        }
        if(proposal.action!=='update')continue;
        if(writes>=this.maxWrites){remaining=true;continue;}
        let plan;
        try{plan=buildContactPlan(this.google,{...row,updates:proposal.updates});}
        catch{if(await this.review(row,'contact_plan_invalid'))summary.reviews++;continue;}
        const record={status:'planned',plan,rowSnapshot:snapshot(row),candidateHash:candidateHash(proposal.candidate),
          provenance:clone(proposal.provenance),organization:row.organization,createdAt:stamp(this.now),updatedAt:stamp(this.now)};
        const created=await this.store.update((state)=>{const contacts=initialize(state);if(contacts.records[plan.hash])return false;contacts.records[plan.hash]=clone(record);return true;});
        if(!created)continue;
        try{writes++;if(await this.acknowledge(record,await applyContactPlan(this.google,plan)))summary.updated++;}
        catch(error){
          if(definite.has(error.code)||error.code==='contact_receipt_invalid'){
            if(await this.review(row,error.code,plan.hash))summary.reviews++;
          }else remaining=true;
        }
      }
      await this.flushNotifications();
      const settled=await this.store.read();
      summary.pending=Object.values(settled.contacts?.records??{}).filter((record)=>record.status==='planned').length;
      remaining||=summary.pending>0||Object.values(settled.contacts?.records??{}).some((record)=>record.notificationPending)
        ||Object.values(settled.contacts?.reviews??{}).some((review)=>!review.notifiedAt);
      const nextSyncAt=new Date(+new Date(this.now())+(remaining?60_000:this.intervalMs)).toISOString();
      await this.store.update((state)=>{Object.assign(initialize(state),{nextSyncAt,retryAt:null,lastSuccessAt:stamp(this.now),lastError:null});});
      summary.nextSyncAt=nextSyncAt;this.log({at:stamp(this.now),type:'contact_sync_summary',...summary});return summary;
    }catch(error){
      const code=error.code==='contact_source_unavailable'?'contact_source_unavailable':error.code==='state_locked'?'state_locked':'contact_read_failed';
      const retryAt=new Date(+new Date(this.now())+(code==='contact_source_unavailable'?300_000:60_000)).toISOString();
      await this.store.update((state)=>{Object.assign(initialize(state),{retryAt,lastError:code});}).catch(()=>{});
      this.log({at:stamp(this.now),type:'contact_sync_error',code,retryAt});throw failure(code);
    }finally{
      if(source)try{await source.close();}catch{this.log({at:stamp(this.now),type:'contact_sync_error',code:'contact_source_close_failed'});}
      this.busy=false;
    }
  }
}
