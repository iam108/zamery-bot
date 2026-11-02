import tls from 'node:tls';
import http from 'node:http';
import {isIP,createConnection} from 'node:net';
import {once} from 'node:events';

const TARGETS=Object.freeze({
  egress:{host:'api.ipify.org',path:'/?format=json',method:'GET',maxBytes:4096},
  stat:{host:'api-fns.ru',path:'/api/stat',method:'POST',maxBytes:2000000},
  fsrar:{host:'api-fns.ru',path:'/api/fsrar',method:'POST',maxBytes:2000000},
});
const SAFE_CODES=new Set(['proxy_invalid','operation_invalid','body_invalid','proxy_connection_failed',
  'proxy_tls_unverified','proxy_remote_mismatch','proxy_connect_rejected','proxy_header_limit',
  'proxy_closed','origin_tls_unverified','origin_request_failed','response_too_large',
  'response_incomplete','redirect_rejected','request_timeout']);

export class PinnedTransportError extends Error{
  constructor(code,route={}){super(SAFE_CODES.has(code)?code:'origin_request_failed');this.name='PinnedTransportError';this.code=this.message;this.route={...route};}
}
function fail(code){throw new PinnedTransportError(code);}

export function validatePinnedProxy(proxyUrl,proxyServerName){
  try{
    const url=new URL(proxyUrl);
    if(!['http:','https:'].includes(url.protocol)||isIP(url.hostname)!==4||!url.username||!url.password
      ||url.pathname!=='/'||url.search||url.hash)fail('proxy_invalid');
    decodeURIComponent(url.username);decodeURIComponent(url.password);
    if(url.protocol==='https:'&&(typeof proxyServerName!=='string'||isIP(proxyServerName)
      ||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu.test(proxyServerName)))fail('proxy_invalid');
    return url;
  }catch{fail('proxy_invalid');}
}

function connectTunnel(socket,authorization,host){
  return new Promise((resolve,reject)=>{
    let buffered=Buffer.alloc(0);
    const cleanup=()=>{socket.off('data',data);socket.off('error',error);socket.off('end',ended);socket.off('close',ended);};
    const error=()=>{cleanup();reject(new PinnedTransportError('proxy_connection_failed'));};
    const ended=()=>{cleanup();reject(new PinnedTransportError('proxy_closed'));};
    const data=(chunk)=>{
      buffered=Buffer.concat([buffered,chunk]);
      const boundary=buffered.indexOf('\r\n\r\n');
      if((boundary<0&&buffered.length>8192)||boundary>8192){cleanup();reject(new PinnedTransportError('proxy_header_limit'));return;}
      if(boundary<0)return;
      cleanup();
      const status=buffered.subarray(0,boundary).toString('ascii').split('\r\n')[0];
      if(!/^HTTP\/1\.[01] 200\b/u.test(status)){reject(new PinnedTransportError('proxy_connect_rejected'));return;}
      if(buffered.length>boundary+4)socket.unshift(buffered.subarray(boundary+4));
      resolve();
    };
    socket.on('data',data);socket.once('error',error);socket.once('end',ended);socket.once('close',ended);
    socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
  });
}

function readResponse(socket,target,body,httpRequest){
  return new Promise((resolve,reject)=>{
    // A fresh HTTP agent parses framing over the already verified origin TLS.
    // It never opens another connection or forwards proxy authentication.
    const agent=new http.Agent({keepAlive:false});
    agent.createConnection=(_options,callback)=>{callback(null,socket);};
    const headers={Host:target.host,Accept:'application/json',Connection:'close','User-Agent':'Mozilla/5.0'};
    if(target.method==='POST')Object.assign(headers,{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)});
    const request=httpRequest({host:target.host,port:443,method:target.method,path:target.path,agent,headers,maxHeaderSize:8192},(response)=>{
      if(response.statusCode>=300&&response.statusCode<400){
        response.destroy();request.destroy();reject(new PinnedTransportError('redirect_rejected'));return;
      }
      let bytes=0;const chunks=[];
      response.on('data',(chunk)=>{
        bytes+=chunk.length;
        if(bytes>target.maxBytes){request.destroy();response.destroy();reject(new PinnedTransportError('response_too_large'));return;}
        chunks.push(chunk);
      });
      response.once('error',()=>reject(new PinnedTransportError('origin_request_failed')));
      response.once('aborted',()=>reject(new PinnedTransportError('response_incomplete')));
      response.once('end',()=>{
        if(response.complete===false){reject(new PinnedTransportError('response_incomplete'));return;}
        resolve({status:response.statusCode,body:Buffer.concat(chunks)});
      });
    });
    request.once('error',()=>reject(new PinnedTransportError('origin_request_failed')));
    request.end(body||undefined);
  });
}

/** Fixed destinations only: no caller-supplied origin, redirect, or global proxy settings. */
export async function requestPinnedHttps({proxyUrl,proxyServerName,operation,body='',timeoutMs=20000},
  {tcpConnect=createConnection,tlsConnect=tls.connect,httpRequest=http.request}={}){
  const target=Object.hasOwn(TARGETS,operation)?TARGETS[operation]:null;
  if(!target)fail('operation_invalid');
  if(typeof body!=='string'||Buffer.byteLength(body)>8192||(operation==='egress'&&body))fail('body_invalid');
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>20000)fail('operation_invalid');
  const proxy=validatePinnedProxy(proxyUrl,proxyServerName);
  const route={expectedIp:proxy.hostname,proxyProtocol:proxy.protocol};
  const controller=new AbortController();let proxySocket;let originSocket;let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new PinnedTransportError('request_timeout'));},timeoutMs);});
  try{
    const work=(async()=>{
      proxySocket=proxy.protocol==='https:'
        ?tlsConnect({host:proxy.hostname,port:Number(proxy.port||443),servername:proxyServerName,rejectUnauthorized:true,signal:controller.signal})
        :tcpConnect({host:proxy.hostname,port:Number(proxy.port||80),signal:controller.signal});
      // Keep late socket errors contained between awaited phases and on cleanup.
      proxySocket.on('error',()=>{});
      await once(proxySocket,proxy.protocol==='https:'?'secureConnect':'connect');
      const remote=String(proxySocket.remoteAddress||'').replace(/^::ffff:/u,'');
      if(isIP(remote))route.proxyRemoteIp=remote;
      if(remote!==proxy.hostname)fail('proxy_remote_mismatch');
      if(proxy.protocol==='https:'){
        route.proxyAuthorized=proxySocket.authorized;
        if(!proxySocket.authorized)fail('proxy_tls_unverified');
      }
      const authorization=Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
      await connectTunnel(proxySocket,authorization,target.host);
      originSocket=tlsConnect({socket:proxySocket,servername:target.host,rejectUnauthorized:true,signal:controller.signal});
      originSocket.on('error',()=>{});
      await once(originSocket,'secureConnect');
      route.originAuthorized=originSocket.authorized;
      if(!originSocket.authorized)fail('origin_tls_unverified');
      return {...await readResponse(originSocket,target,body,httpRequest),route};
    })();
    return await Promise.race([work,timeout]);
  }catch(error){
    throw new PinnedTransportError(error instanceof PinnedTransportError?error.code:'proxy_connection_failed',route);
  }finally{clearTimeout(timer);originSocket?.destroy();proxySocket?.destroy();}
}
