#!/usr/bin/env node
// One diagnostic request through a pinned TLS proxy. No keys or state are read.
import tls from 'node:tls';
import http from 'node:http';
import {isIP,createConnection} from 'node:net';
import {once} from 'node:events';

function fail(code){const error=new Error();error.code=code;throw error;}
function connectTunnel(socket,authorization){
  return new Promise((resolve,reject)=>{
    let buffered=Buffer.alloc(0);
    const cleanup=()=>{socket.off('data',data);socket.off('error',error);socket.off('end',ended);};
    const error=(cause)=>{cleanup();reject(cause);};
    const ended=()=>error(Object.assign(new Error(),{code:'PROXY_CLOSED'}));
    const data=(chunk)=>{
      buffered=Buffer.concat([buffered,chunk]);
      if(buffered.length>8192)return error(Object.assign(new Error(),{code:'HEADER_LIMIT'}));
      const boundary=buffered.indexOf('\r\n\r\n');
      if(boundary<0)return;
      cleanup();
      const status=buffered.subarray(0,boundary).toString('ascii').split('\r\n')[0];
      if(!/^HTTP\/1\.[01] 200\b/u.test(status))return reject(Object.assign(new Error(),{code:'CONNECT_REJECTED'}));
      if(buffered.length>boundary+4)socket.unshift(buffered.subarray(boundary+4));
      resolve();
    };
    socket.on('data',data);socket.once('error',error);socket.once('end',ended);
    socket.write('CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\n'
      +`Proxy-Authorization: Basic ${authorization}\r\n\r\n`);
  });
}

function readIp(socket){
  return new Promise((resolve,reject)=>{
    // HTTP handles framing/chunked responses; TLS is already established below it.
    const agent=new http.Agent({keepAlive:false});
    agent.createConnection=(_options,callback)=>{callback(null,socket);};
    const request=http.request({host:'api.ipify.org',port:443,method:'GET',path:'/?format=json',agent,
      headers:{Host:'api.ipify.org',Accept:'application/json',Connection:'close'}},(response)=>{
      let bytes=0;const chunks=[];
      response.on('data',(chunk)=>{
        bytes+=chunk.length;
        if(bytes>4096){request.destroy(Object.assign(new Error(),{code:'BODY_LIMIT'}));return;}
        chunks.push(chunk);
      });
      response.once('error',reject);
      response.once('end',()=>{
        try{
          if(response.statusCode!==200)fail('ORIGIN_STATUS');
          const ip=JSON.parse(Buffer.concat(chunks).toString('utf8')).ip;
          if(typeof ip!=='string'||isIP(ip)!==4)fail('INVALID_IP_RESPONSE');
          resolve(ip);
        }catch(error){reject(error);}
      });
    });
    request.once('error',reject);request.end();
  });
}

async function main(){
  const result={type:'fixie_egress_probe',ok:false};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  let proxySocket;let originSocket;
  try{
    const proxy=new URL(process.env.FSRAR_PROXY_URL||'');
    const serverName=process.env.FSRAR_PROXY_SERVER_NAME||'';
    if(!['http:','https:'].includes(proxy.protocol)||isIP(proxy.hostname)!==4||!proxy.username||!proxy.password
      ||proxy.pathname!=='/'||proxy.search||proxy.hash||(proxy.protocol==='https:'&&(isIP(serverName)
      ||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/iu.test(serverName))))fail('INVALID_PROXY_CONFIGURATION');
    result.expectedIp=proxy.hostname;
    result.proxyProtocol=proxy.protocol;
    proxySocket=proxy.protocol==='https:'
      ?tls.connect({host:proxy.hostname,port:Number(proxy.port||443),servername:serverName,
        rejectUnauthorized:true,signal:controller.signal})
      :createConnection({host:proxy.hostname,port:Number(proxy.port||80),signal:controller.signal});
    await once(proxySocket,proxy.protocol==='https:'?'secureConnect':'connect');
    result.proxyRemoteIp=proxySocket.remoteAddress;
    if(proxy.protocol==='https:'){
      result.proxyAuthorized=proxySocket.authorized;
      if(!proxySocket.authorized)fail('PROXY_TLS_UNVERIFIED');
    }
    const authorization=Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
    await connectTunnel(proxySocket,authorization);
    originSocket=tls.connect({socket:proxySocket,servername:'api.ipify.org',rejectUnauthorized:true,signal:controller.signal});
    await once(originSocket,'secureConnect');
    result.originAuthorized=originSocket.authorized;
    if(!originSocket.authorized)fail('ORIGIN_TLS_UNVERIFIED');
    result.observedIp=await readIp(originSocket);
    result.ok=result.observedIp===result.expectedIp;
  }catch(error){
    // Never emit exception messages, URLs, headers, or credential-bearing objects.
    result.errorClass=error?.constructor?.name||'Error';
  }finally{
    clearTimeout(timer);originSocket?.destroy();proxySocket?.destroy();
  }
  console.log(JSON.stringify(result));
  return result.ok?0:1;
}

process.exitCode=await main();
