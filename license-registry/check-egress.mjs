#!/usr/bin/env node
// One diagnostic request using exactly the same pinned transport as API-ФНС.
import {isIP} from 'node:net';
import {requestPinnedHttps,PinnedTransportError} from './proxy-transport.mjs';

const result={type:'fixie_egress_probe',ok:false};
try{
  const response=await requestPinnedHttps({proxyUrl:process.env.FSRAR_PROXY_URL,
    proxyServerName:process.env.FSRAR_PROXY_SERVER_NAME,operation:'egress'});
  Object.assign(result,response.route);
  if(response.status!==200)throw new Error();
  const ip=JSON.parse(response.body.toString('utf8')).ip;
  if(typeof ip!=='string'||isIP(ip)!==4)throw new Error();
  result.observedIp=ip;result.ok=ip===result.expectedIp;
}catch(error){
  if(error instanceof PinnedTransportError){Object.assign(result,error.route);result.errorCode=error.code;}
  result.errorClass=error?.constructor?.name||'Error';
}
console.log(JSON.stringify(result));
process.exitCode=result.ok?0:1;
