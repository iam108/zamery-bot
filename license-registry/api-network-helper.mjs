#!/usr/bin/env node
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {requestPinnedHttps,PinnedTransportError} from './proxy-transport.mjs';

function optionsOf(args){
  const result={};
  for(let index=0;index<args.length;index+=2){
    const name=args[index];const value=args[index+1];
    if(!['--key-file','--method','--inn','--kpp'].includes(name)||typeof value!=='string'
      ||value.startsWith('--')||Object.hasOwn(result,name))throw new Error('invalid_arguments');
    result[name]=value;
  }
  if(!result['--key-file']||!['stat','fsrar'].includes(result['--method']))throw new Error('invalid_arguments');
  if(result['--method']==='fsrar'&&!/^\d{10}(?:\d{2})?$/u.test(result['--inn']||''))throw new Error('invalid_arguments');
  if(result['--kpp']&&!/^\d{9}$/u.test(result['--kpp']))throw new Error('invalid_arguments');
  if(result['--method']==='stat'&&(result['--inn']||result['--kpp']))throw new Error('invalid_arguments');
  return result;
}

export function redactApiText(value,key='',proxyUrl=''){
  const secrets=[key,proxyUrl];
  try{
    const proxy=new URL(proxyUrl);
    const user=decodeURIComponent(proxy.username);const password=decodeURIComponent(proxy.password);
    secrets.push(decodeURIComponent(proxyUrl),proxy.password,password,Buffer.from(user+':'+password).toString('base64'));
  }catch{}
  let text=String(value);
  for(const secret of [...new Set(secrets.filter(Boolean))].sort((a,b)=>b.length-a.length))text=text.split(secret).join('[REDACTED]');
  return text;
}
function sanitizePayload(value,key,proxyUrl){
  if(typeof value==='string')return redactApiText(value,key,proxyUrl);
  if(Array.isArray(value))return value.map((item)=>sanitizePayload(item,key,proxyUrl));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>
    [redactApiText(name,key,proxyUrl),sanitizePayload(item,key,proxyUrl)]));
  return value;
}

export async function runApiHelper(args,env,{readFile=fs.readFile,stat=fs.stat,request=requestPinnedHttps}={}){
  let attempted=false;
  try{
    const options=optionsOf(args);const keyFile=options['--key-file'];
    if((await stat(keyFile)).mode&0o077)throw new Error('key_permissions');
    const key=(await readFile(keyFile,'utf8')).trim();
    if(!/^[A-Za-z0-9_-]{40}$/u.test(key))throw new Error('key_invalid');
    const fields=new URLSearchParams({key});
    if(options['--method']==='fsrar'){
      fields.set('inn',options['--inn']);if(options['--kpp'])fields.set('kpp',options['--kpp']);
    }
    attempted=true;
    const response=await request({proxyUrl:env.FSRAR_PROXY_URL,proxyServerName:env.FSRAR_PROXY_SERVER_NAME,
      operation:options['--method'],body:fields.toString(),timeoutMs:20000});
    const raw=response.body.toString('utf8');let payload;
    try{payload=sanitizePayload(JSON.parse(raw),key,env.FSRAR_PROXY_URL);}
    catch{payload={non_json_response:redactApiText(raw,key,env.FSRAR_PROXY_URL).slice(0,1500)};}
    return {http_status:response.status,response:payload,attempted:true};
  }catch(error){
    return {attempted,transport_error:'fsrar_transport_error',
      ...(error instanceof PinnedTransportError?{transport_code:error.code}:{})};
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  console.log(JSON.stringify(await runApiHelper(process.argv.slice(2),process.env)));
}
