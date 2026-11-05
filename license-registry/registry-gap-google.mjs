import {hash} from './state.mjs';
import {isValidInn,normalizeDate,normalizeAddress,normalizeLicenseNumber,mapActivityForSheet} from './core.mjs';
import {normalizeContactPhone,normalizeContactTelegram} from './contact-match.mjs';

const COLS=Object.freeze({G:6,H:7,I:8,J:9,K:10,L:11,M:12,N:13,O:14,P:15});
const DATES=new Set(['I','J']);const DAY=86_400_000;
const clone=(value)=>structuredClone(value);
const canonical=(value)=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])])):value;
const digest=(value)=>hash(canonical(value));
const text=(value)=>value==null?'':String(value);
const clean=(value)=>text(value).trim();
const letter=(index)=>String.fromCharCode(65+index);
function fail(code,planHash,reason){throw Object.assign(new Error(code),{code,...(planHash?{planHash}:{}),...(reason?{reason}:{})});}
function positive(value){return /^[1-9]\d*$/u.test(String(value??''))&&Number.isSafeInteger(Number(value));}
function auth(input,row){
  if(!input||typeof input.requestId!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/u.test(input.requestId)||!positive(input.ownerChatId)
    ||!['owner','fsrar'].includes(input.source))fail('registry_gap_plan_invalid');
  const result={requestId:input.requestId,ownerChatId:String(input.ownerChatId),source:input.source};
  if(input.sourceMessageId!=null){if(!positive(input.sourceMessageId))fail('registry_gap_plan_invalid');result.sourceMessageId=String(input.sourceMessageId);}
  if(input.explicitRow!=null){if(input.explicitRow!==row)fail('registry_gap_plan_invalid');result.explicitRow=row;}
  return result;
}
function comparable(index,value){
  if(index===8||index===9)return clean(value)?normalizeDate(value)??clean(value):'';
  if(index===7)return normalizeLicenseNumber(value);
  if(index===11)return normalizeAddress(value);
  if(index===6)return clean(value);
  if(index===10)return mapActivityForSheet(value)??text(value);
  return text(value);
}
function proposed(column,value){
  if(typeof value!=='string'||!value.trim()||value.length>4096||/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/u.test(value)
    ||(!['M','N'].includes(column)&&value.includes('\n')))fail('registry_gap_plan_invalid');
  const input=value.trim();
  if(column==='G'){if(!isValidInn(input))fail('registry_gap_plan_invalid');return input;}
  if(column==='H'){const number=normalizeLicenseNumber(input);if(!/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(number))fail('registry_gap_plan_invalid');return number;}
  if(DATES.has(column)){const date=normalizeDate(input);if(!date)fail('registry_gap_plan_invalid');return date;}
  if(column==='K'){const activity=mapActivityForSheet(input);if(!activity)fail('registry_gap_plan_invalid');return activity;}
  if(column==='M'){
    const names=input.split('\n').map((name)=>name.replace(/\s+/gu,' ').trim());
    if(names.length>5||names.some((name)=>!/^[\p{L}\p{M} .’'()\-]{1,160}$/u.test(name)||!/[\p{L}]/u.test(name)))fail('registry_gap_plan_invalid');
    return names.join('\n');
  }
  if(column==='N'){
    const phones=input.split('\n').map(normalizeContactPhone);if(phones.length>5||phones.some((phone)=>!phone))fail('registry_gap_plan_invalid');return phones.join('\n');
  }
  if(column==='O'){const telegram=normalizeContactTelegram(input);if(!telegram)fail('registry_gap_plan_invalid');return telegram;}
  if(column==='L'&&!normalizeAddress(input))fail('registry_gap_plan_invalid');
  return input;
}
function spec(google,input){
  if(!google?.spreadsheetId||!google?.sheetName||!Number.isInteger(google.sheetId)||google.sheetId<0
    ||!Number.isSafeInteger(input?.rowNumber)||input.rowNumber<2||input.rowNumber>100000
    ||!Array.isArray(input.expectedRowValues)||input.expectedRowValues.length!==17
    ||input.expectedRowValues.some((value)=>value!=null&&!['string','number','boolean'].includes(typeof value))
    ||!Array.isArray(input.updates)||input.updates.length>10)fail('registry_gap_plan_invalid');
  const expectedRowValues=Array.from(input.expectedRowValues,text);
  if(!clean(expectedRowValues[4]))fail('registry_gap_plan_invalid');
  const seen=new Set();const requestedUpdates=input.updates.map((update)=>{
    if(!update||!Object.hasOwn(COLS,update.column)||seen.has(update.column))fail('registry_gap_plan_invalid');seen.add(update.column);
    return {column:update.column,after:proposed(update.column,update.after)};
  }).sort((a,b)=>COLS[a.column]-COLS[b.column]);
  const afterValues=[...expectedRowValues];
  for(const update of requestedUpdates){
    const index=COLS[update.column],before=expectedRowValues[index];
    if(before!==''&&comparable(index,before)!==comparable(index,update.after))fail('registry_gap_conflict');
    afterValues[index]=before===''?update.after:before;
  }
  if(!isValidInn(afterValues[6]))fail('registry_gap_plan_invalid');
  if(clean(afterValues[7])&&!/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(normalizeLicenseNumber(afterValues[7])))fail('registry_gap_plan_invalid');
  const issue=clean(afterValues[8])?normalizeDate(afterValues[8]):null,expiry=clean(afterValues[9])?normalizeDate(afterValues[9]):null;
  if(clean(afterValues[8])&&!issue||clean(afterValues[9])&&!expiry||issue&&expiry&&expiry<issue)fail('registry_gap_plan_invalid');
  if(requestedUpdates.some((update)=>['M','N'].includes(update.column))&&clean(afterValues[12])&&clean(afterValues[13])
    &&afterValues[12].split('\n').length!==afterValues[13].split('\n').length)fail('registry_gap_plan_invalid');
  const columns=new Set(['E','G','H','I','J','L',...requestedUpdates.map((update)=>update.column)]);
  const expectedCells=Object.fromEntries([...columns].sort().map((column)=>[`${column}${input.rowNumber}`,comparable(column.charCodeAt(0)-65,afterValues[column.charCodeAt(0)-65])]));
  return {version:1,spreadsheetId:google.spreadsheetId,sheetName:google.sheetName,sheetId:google.sheetId,rowNumber:input.rowNumber,
    authorization:auth(input.authorization,input.rowNumber),expectedRowValues,requestedUpdates,afterValues,expectedCells};
}
function displayed(cell={}){
  if(cell.formattedValue!=null)return text(cell.formattedValue);
  const value=cell.effectiveValue??cell.userEnteredValue??{};
  if(value.stringValue!=null)return value.stringValue;
  if(value.numberValue!=null){
    if(['DATE','DATE_TIME'].includes((cell.effectiveFormat??cell.userEnteredFormat)?.numberFormat?.type)){
      const date=new Date((value.numberValue-25569)*DAY);return Number.isFinite(+date)?date.toISOString().slice(0,10):'';
    }
    return String(value.numberValue);
  }
  return value.boolValue==null?'':String(value.boolValue).toUpperCase();
}
function object(value){return value&&Object.keys(value).length?clone(value):null;}
function snapshot(cell={}){return {entered:object(cell.userEnteredValue),effective:object(cell.effectiveValue),displayed:displayed(cell),
  note:cell.note??'',validation:object(cell.dataValidation),format:object(cell.userEnteredFormat),dateFormatted:!needsDateFormat(cell)};}
const protectedCell=(cell={})=>cell.userEnteredValue?.formulaValue!=null||cell.note!=null&&String(cell.note)!=='';
function empty(cell={}){
  const values=[cell.userEnteredValue,cell.effectiveValue];
  return displayed(cell)===''&&values.every((value)=>!value||!Object.keys(value).length||Object.keys(value).length===1&&value.stringValue==='');
}
const serial=(date)=>Date.parse(`${date}T00:00:00Z`)/DAY+25569;
function needsDateFormat(cell){return !['DATE','DATE_TIME'].includes((cell.effectiveFormat??cell.userEnteredFormat)?.numberFormat?.type);}
function targetMetadata(before,dateFormat){
  return {note:before.note,validation:before.validation,format:dateFormat?{...(before.format??{}),numberFormat:{type:'DATE',pattern:'dd.mm.yyyy'}}:before.format};
}
function metadata(value){return {note:value.note,validation:value.validation,format:value.format};}
function allowedRow(values,plan){
  const targets=new Map((plan.updates??[]).map((update)=>[COLS[update.column],update]));
  return Array.from({length:17},(_,index)=>index).every((index)=>{
    const actual=comparable(index,values[index]);const before=comparable(index,plan.expectedRowValues[index]);
    return actual===before||targets.has(index)&&actual===comparable(index,targets.get(index).after);
  });
}
async function read(google,plan){
  let context,cells;try{context=await google.context();}catch{fail('registry_gap_read_failed',plan.hash);}
  if(!Array.isArray(context?.values))fail('registry_gap_read_failed',plan.hash);
  const start=context.startRow??1;
  const current=context.values[plan.rowNumber-start];
  if(!Array.isArray(current)||!allowedRow(current,plan))fail('registry_gap_conflict',plan.hash,'registry_gap_row_moved');
  const matches=context.values.filter((values)=>Array.isArray(values)&&allowedRow(values,plan));
  if(matches.length>1&&plan.authorization.explicitRow!==plan.rowNumber)fail('registry_gap_conflict',plan.hash,'registry_gap_row_ambiguous');
  try{cells=await google.readRow(plan.rowNumber);}catch{fail('registry_gap_read_failed',plan.hash);}
  if(!Array.isArray(cells)||!allowedRow(cells.map(displayed),plan))fail('registry_gap_conflict',plan.hash);
  return {cells,snapshots:Array.from({length:17},(_,index)=>snapshot(cells[index]))};
}

export async function prepareRegistryGapPlan(google,input){
  const base=spec(google,input);const current=await read(google,{...base,updates:[]});
  const updates=[];
  for(const proposal of base.requestedUpdates){
    const index=COLS[proposal.column],cell=current.cells[index];
    if(comparable(index,displayed(cell))===comparable(index,proposal.after))continue;
    if(protectedCell(cell))fail('registry_gap_cell_protected');
    if(!empty(cell))fail('registry_gap_conflict');
    updates.push({...proposal,before:'',...(DATES.has(proposal.column)?{setDateFormat:needsDateFormat(cell)}:{})});
  }
  const targetIndexes=new Set(updates.map((update)=>COLS[update.column]));
  const unsigned={...base,updates,beforeSnapshots:current.snapshots,
    nonTargetRowHash:digest(current.snapshots.map((value,index)=>targetIndexes.has(index)?null:value))};
  return {...unsigned,hash:digest(unsigned)};
}
function validate(google,input){
  if(typeof input?.hash!=='string'||!/^[a-f0-9]{64}$/u.test(input.hash))fail('registry_gap_plan_invalid');
  const {hash:signature,...unsigned}=input;if(digest(unsigned)!==signature)fail('registry_gap_plan_invalid');
  const base=spec(google,{rowNumber:input.rowNumber,expectedRowValues:input.expectedRowValues,updates:input.requestedUpdates,authorization:input.authorization});
  if(Object.keys(base).some((key)=>digest(input[key])!==digest(base[key]))||!Array.isArray(input.beforeSnapshots)||input.beforeSnapshots.length!==17
    ||!Array.isArray(input.updates)||!/^[a-f0-9]{64}$/u.test(input.nonTargetRowHash??''))fail('registry_gap_plan_invalid');
  const seen=new Set();
  for(const update of input.updates){
    const requested=base.requestedUpdates.find((proposal)=>proposal.column===update.column);
    if(!requested||seen.has(update.column)||update.before!==''||update.after!==requested.after
      ||(DATES.has(update.column)?typeof update.setDateFormat!=='boolean':update.setDateFormat!=null))fail('registry_gap_plan_invalid');
    seen.add(update.column);
    const before=input.beforeSnapshots[COLS[update.column]];
    if(before?.displayed!==''||DATES.has(update.column)&&update.setDateFormat===before.dateFormatted)fail('registry_gap_plan_invalid');
  }
  if(digest(input.updates.map((update)=>update.column))!==digest(base.requestedUpdates
    .filter((update)=>base.expectedRowValues[COLS[update.column]]==='').map((update)=>update.column)))fail('registry_gap_plan_invalid');
  const targets=new Set(input.updates.map((update)=>COLS[update.column]));
  if(digest(input.beforeSnapshots.map((value,index)=>targets.has(index)?null:value))!==input.nonTargetRowHash)fail('registry_gap_plan_invalid');
  return clone(input);
}
function inspect(plan,current){
  const indexes=new Set(plan.updates.map((update)=>COLS[update.column]));
  if(digest(current.snapshots.map((value,index)=>indexes.has(index)?null:value))!==plan.nonTargetRowHash)fail('registry_gap_conflict',plan.hash);
  const pending=[];
  for(const update of plan.updates){
    const index=COLS[update.column],cell=current.cells[index],now=current.snapshots[index],before=plan.beforeSnapshots[index];
    if(protectedCell(cell))fail('registry_gap_cell_protected',plan.hash);
    if(digest(now)===digest(before)){if(!empty(cell))fail('registry_gap_conflict',plan.hash);pending.push(update);continue;}
    const entered=cell.userEnteredValue;
    const valueMatches=DATES.has(update.column)?entered?.numberValue===serial(update.after)
      &&['DATE','DATE_TIME'].includes((cell.effectiveFormat??cell.userEnteredFormat)?.numberFormat?.type):entered?.stringValue===update.after;
    if(!valueMatches||comparable(index,displayed(cell))!==comparable(index,update.after)
      ||digest(metadata(now))!==digest(targetMetadata(before,update.setDateFormat)))fail('registry_gap_conflict',plan.hash);
  }
  return pending;
}
function receipt(google,plan,current,appliedCells){
  if(inspect(plan,current).length)fail('registry_gap_readback_pending',plan.hash);
  const cells=Object.fromEntries(Object.keys(plan.expectedCells).map((cell)=>{
    const index=cell.charCodeAt(0)-65;return [cell,comparable(index,displayed(current.cells[index]))];
  }));
  if(Object.entries(plan.expectedCells).some(([cell,value])=>cells[cell]!==value))fail('registry_gap_readback_pending',plan.hash);
  return {verified:true,planHash:plan.hash,spreadsheetId:plan.spreadsheetId,sheetName:plan.sheetName,sheetId:plan.sheetId,
    rowNumber:plan.rowNumber,verifiedAt:new Date(typeof google.now==='function'?google.now():Date.now()).toISOString(),
    action:appliedCells.length?'update':'noop',appliedCells,cells};
}

export async function verifyRegistryGapPlan(google,input){
  const plan=validate(google,input);
  try{return receipt(google,plan,await read(google,plan),[]);}
  catch(error){
    if(['registry_gap_conflict','registry_gap_cell_protected'].includes(error.code))fail('registry_gap_readback_pending',plan.hash,error.code);
    throw error;
  }
}
export async function applyRegistryGapPlan(google,input){
  const plan=validate(google,input);let current=await read(google,plan);let pending=inspect(plan,current);
  if(!pending.length)return receipt(google,plan,current,[]);
  current=await read(google,plan);pending=inspect(plan,current);
  if(!pending.length)return receipt(google,plan,current,[]);
  const requests=pending.map((update)=>{
    const cell={userEnteredValue:DATES.has(update.column)?{numberValue:serial(update.after)}:{stringValue:update.after}};
    let fields='userEnteredValue';
    if(update.setDateFormat){cell.userEnteredFormat={numberFormat:{type:'DATE',pattern:'dd.mm.yyyy'}};fields+=',userEnteredFormat.numberFormat';}
    return {updateCells:{start:{sheetId:plan.sheetId,rowIndex:plan.rowNumber-1,columnIndex:COLS[update.column]},rows:[{values:[cell]}],fields}};
  });
  try{await google.request(':batchUpdate',{body:{requests,includeSpreadsheetInResponse:false}});}catch{fail('registry_gap_write_unconfirmed',plan.hash);}
  return receipt(google,plan,await read(google,plan),pending.map((update)=>`${update.column}${plan.rowNumber}`));
}
