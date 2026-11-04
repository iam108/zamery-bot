import {createHash} from 'node:crypto';
import {isValidInn,normalizeLicense,normalizeLicenseNumber,selectLicense,localDate} from './core.mjs';

export const OFFICIAL_EVIDENCE_SOURCE='official_fsrar_operator_verified';
const RECORD_KEYS=['inn','kpp','organization','licenseNumber','issueDate','expiryDate','changeDate','changeReason','status','activity','address','email'];
const PAYLOAD_KEYS=['version','source','jobId','sourceEventKey','sourceUrl','verifiedAt','evidenceSha256','recordHash','record'];
const sha=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex=(value)=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const clone=(value)=>JSON.parse(JSON.stringify(value));
function fail(code){throw Object.assign(new Error(code),{code});}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function exactKeys(value,keys){if(!object(value)||Object.keys(value).some((key)=>!keys.includes(key)))fail('official_evidence_invalid');}

function canonicalRecord(input){
  exactKeys(input,RECORD_KEYS);
  if(RECORD_KEYS.some((key)=>input[key]!=null&&(typeof input[key]!=='string'||input[key].length>4096)))fail('official_evidence_invalid_record');
  const record=normalizeLicense(input);
  if(!isValidInn(record.inn)||!/^\d{9}$/u.test(record.kpp)||!/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(record.licenseNumber)
    ||!record.organization||!record.address||!record.activity||!record.changeReason||!record.issueDate||!record.expiryDate
    ||!record.changeDate||record.expiryDate<record.issueDate||record.changeDate<record.issueDate
    ||!['действующая','действует','active'].includes(record.status)
    ||(record.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(record.email)))fail('official_evidence_invalid_record');
  return Object.fromEntries(RECORD_KEYS.map((key)=>[key,record[key]]));
}

export function officialRecordHash(record){return sha(canonicalRecord(record));}
function binding(job){return sha(Object.fromEntries(['id','sourceEventKey','inn','kpp','licenseNumber','address','reportedAt',
  'reportedDate','decisionDate','operation','sourceText'].map((key)=>[key,job[key]??null])));}
function normalizePayload(input){
  let payload=input;
  if(typeof input==='string'){
    if(Buffer.byteLength(input)>32768)fail('official_evidence_invalid');
    try{payload=JSON.parse(input);}catch{fail('official_evidence_invalid');}
  }
  exactKeys(payload,PAYLOAD_KEYS);
  if(payload.version!==1||payload.source!==OFFICIAL_EVIDENCE_SOURCE||!/^([a-f0-9]{24})$/u.test(payload.jobId??'')
    ||typeof payload.sourceEventKey!=='string'||!payload.sourceEventKey||payload.sourceEventKey.length>200
    ||!hex(payload.evidenceSha256)||!hex(payload.recordHash))fail('official_evidence_invalid');
  const record=canonicalRecord(payload.record);
  if(sha(record)!==payload.recordHash)fail('official_evidence_hash_mismatch');
  if(typeof payload.verifiedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(payload.verifiedAt)
    ||!Number.isFinite(Date.parse(payload.verifiedAt)))fail('official_evidence_invalid');
  let url;
  try{url=new URL(payload.sourceUrl);}catch{fail('official_evidence_source_invalid');}
  if(url.origin!=='https://fsrar.gov.ru'||url.pathname!=='/licens/reestr'||url.username||url.password||url.hash
    ||[...url.searchParams.keys()].some((key)=>!['inn','number','kpp','page'].includes(key))
    ||(url.searchParams.get('inn')&&url.searchParams.get('inn')!==record.inn)
    ||(url.searchParams.get('kpp')&&url.searchParams.get('kpp')!==record.kpp)
    ||(url.searchParams.get('number')&&normalizeLicenseNumber(url.searchParams.get('number'))!==record.licenseNumber)
    ||(url.searchParams.get('page')&&!/^[1-9]\d{0,3}$/u.test(url.searchParams.get('page'))))fail('official_evidence_source_invalid');
  return {...payload,record,sourceUrl:url.toString(),verifiedAt:new Date(payload.verifiedAt).toISOString()};
}
function evidenceId(payload){return sha(Object.fromEntries(PAYLOAD_KEYS.map((key)=>[key,key==='record'?payload.recordHash:payload[key]])));}

export function getOfficialLicenseEvidence(job){
  const stored=job.officialLicenseEvidence;if(!stored)return null;
  const payload=normalizePayload(Object.fromEntries(PAYLOAD_KEYS.map((key)=>[key,stored[key]])));
  if(stored.id!==evidenceId(payload)||stored.bindingHash!==binding(job)||payload.jobId!==job.id
    ||payload.sourceEventKey!==job.sourceEventKey||payload.record.inn!==job.inn)fail('official_evidence_binding_mismatch');
  return {...payload,id:stored.id};
}

/** The operator verified a real official card. This is never labeled an API response. */
export async function importOfficialLicenseEvidence({store,payload,now=()=>new Date()}){
  const evidence=normalizePayload(payload);const id=evidenceId(evidence);
  if(Date.parse(evidence.verifiedAt)>+now()+300000||evidence.record.changeDate>localDate(evidence.verifiedAt,'Europe/Moscow'))fail('official_evidence_invalid');
  return store.update((state)=>{
    const imports=state.runtime?.officialEvidenceImports;
    if(imports?.[id])return {status:'duplicate',jobId:evidence.jobId,evidenceId:id,source:OFFICIAL_EVIDENCE_SOURCE};
    const job=state.jobs[evidence.jobId];
    if(!job||job.status!=='waiting'||job.plan||job.fetchReservation||job.sourceReviewRequired||job.officialLicenseEvidence
      ||state.sources[evidence.sourceEventKey]!==job.id||job.sourceEventKey!==evidence.sourceEventKey||job.inn!==evidence.record.inn)
      fail('official_evidence_job_not_eligible');
    if((job.licenseNumber&&normalizeLicenseNumber(job.licenseNumber)!==evidence.record.licenseNumber)
      ||(job.kpp&&job.kpp!==evidence.record.kpp)||selectLicense(job,[evidence.record]).status!=='ready')fail('official_evidence_not_current');
    const at=now().toISOString();
    job.officialLicenseEvidence={...clone(evidence),id,bindingHash:binding(job),importedAt:at};
    job.status='fetched';job.reason=null;job.nextCheckAt=null;job.updatedAt=at;
    state.runtime??={};state.runtime.officialEvidenceImports??={};
    state.runtime.officialEvidenceImports[id]={jobId:job.id,source:OFFICIAL_EVIDENCE_SOURCE,recordHash:evidence.recordHash,importedAt:at};
    state.journal.push({at,type:'official_registry_evidence_imported',jobId:job.id,evidenceId:id,
      source:OFFICIAL_EVIDENCE_SOURCE,evidenceSha256:evidence.evidenceSha256,recordHash:evidence.recordHash});
    return {status:'imported',jobId:job.id,evidenceId:id,source:OFFICIAL_EVIDENCE_SOURCE};
  });
}
