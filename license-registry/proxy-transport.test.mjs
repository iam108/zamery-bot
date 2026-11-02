import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {requestPinnedHttps,PinnedTransportError} from './proxy-transport.mjs';
import {runApiHelper,redactApiText} from './api-network-helper.mjs';

const ip='54.173.229.123';
const proxyUrl=`http://fixie:TEST%40PROXY%3ASECRET@${ip}:80`;
const key='k'.repeat(40);
const basic=Buffer.from('fixie:TEST@PROXY:SECRET').toString('base64');
const options={proxyUrl,operation:'fsrar',body:new URLSearchParams({key,inn:'9705148570'}).toString()};
function network({status=200,chunks=[Buffer.from('{"items":[]}')],connectStatus='HTTP/1.1 200 Connection established',
  connectHeaders='',stall=false,originAuthorized=true,proxyAuthorized=true,tlsFailure=false,incomplete=false}={}){
  const calls={tcp:[],tls:[],requests:[],connect:[],bodies:[],sockets:[]};
  class Socket extends EventEmitter{
    constructor(authorized=true){super();this.remoteAddress=ip;this.authorized=authorized;this.destroyed=false;calls.sockets.push(this);}
    write(data){calls.connect.push(String(data));queueMicrotask(()=>this.emit('data',Buffer.from(connectStatus+'\r\n'+connectHeaders+'\r\n')));}
    destroy(){this.destroyed=true;}
    unshift(data){this.unshifted=data;}
  }
  const proxy=new Socket(proxyAuthorized);const origin=new Socket(originAuthorized);
  const dependencies={
    tcpConnect(opts){calls.tcp.push(opts);if(!stall)queueMicrotask(()=>proxy.emit('connect'));return proxy;},
    tlsConnect(opts){
      calls.tls.push(opts);const socket=opts.socket?origin:proxy;
      queueMicrotask(()=>tlsFailure?socket.emit('error',new Error(proxyUrl+' '+key)):socket.emit('secureConnect'));
      return socket;
    },
    httpRequest(opts,callback){
      calls.requests.push(opts);let provided;
      opts.agent.createConnection({},(_error,socket)=>{provided=socket;});assert.equal(provided,origin);
      const request=new EventEmitter();request.destroy=()=>{request.destroyed=true;};
      request.end=(body)=>{
        calls.bodies.push(body);const response=new EventEmitter();response.statusCode=status;response.complete=!incomplete;
        response.destroy=()=>{response.destroyed=true;};
        queueMicrotask(()=>{
          callback(response);
          for(const chunk of chunks){if(response.destroyed)break;response.emit('data',chunk);}
          if(!response.destroyed)response.emit('end');
        });
      };
      return request;
    },
  };
  return {calls,dependencies};
}

test('pinned HTTP CONNECT keeps API credentials in verified origin TLS and does not resolve another proxy',async()=>{
  const {calls,dependencies}=network();const result=await requestPinnedHttps(options,dependencies);
  assert.equal(result.status,200);assert.equal(result.body.toString(),'{"items":[]}');
  assert.deepEqual(result.route,{expectedIp:ip,proxyProtocol:'http:',proxyRemoteIp:ip,originAuthorized:true});
  assert.equal(calls.tcp.length,1);assert.equal(calls.tcp[0].host,ip);assert.equal(calls.tcp[0].port,80);
  assert.equal(calls.tls.length,1);assert.equal(calls.tls[0].servername,'api-fns.ru');assert.equal(calls.tls[0].rejectUnauthorized,true);
  assert.ok(calls.connect[0].startsWith('CONNECT api-fns.ru:443 HTTP/1.1\r\n'));
  assert.ok(calls.connect[0].includes(`Proxy-Authorization: Basic ${basic}\r\n`));
  assert.ok(!calls.connect[0].includes(key));
  const request=calls.requests[0];assert.equal(request.host,'api-fns.ru');assert.equal(request.path,'/api/fsrar');assert.equal(request.method,'POST');
  assert.equal(request.headers['Proxy-Authorization'],undefined);assert.equal(request.headers.Authorization,undefined);
  assert.equal(request.headers['Content-Length'],Buffer.byteLength(options.body));assert.equal(calls.bodies[0],options.body);
  assert.ok(calls.sockets.every((socket)=>socket.destroyed));
});

test('optional HTTPS proxy verifies its DNS certificate separately from the origin certificate',async()=>{
  const {calls,dependencies}=network();
  const result=await requestPinnedHttps({...options,proxyUrl:proxyUrl.replace('http:','https:').replace(':80',':443'),
    proxyServerName:'criterium.usefixie.com'},dependencies);
  assert.equal(calls.tcp.length,0);assert.equal(calls.tls.length,2);
  assert.equal(calls.tls[0].host,ip);assert.equal(calls.tls[0].port,443);
  assert.equal(calls.tls[0].servername,'criterium.usefixie.com');assert.equal(calls.tls[0].rejectUnauthorized,true);
  assert.equal(calls.tls[1].servername,'api-fns.ru');assert.equal(calls.tls[1].rejectUnauthorized,true);
  assert.equal(result.route.proxyAuthorized,true);assert.equal(result.route.originAuthorized,true);
});

test('stat and the read-only egress diagnostic use only their fixed host, method and path',async()=>{
  for(const [operation,host,method,path]of[['stat','api-fns.ru','POST','/api/stat'],['egress','api.ipify.org','GET','/?format=json']]){
    const {calls,dependencies}=network();
    await requestPinnedHttps({proxyUrl,operation,...(operation==='stat'?{body:'key=synthetic'}:{})},dependencies);
    assert.equal(calls.requests[0].host,host);assert.equal(calls.requests[0].method,method);assert.equal(calls.requests[0].path,path);
    assert.equal(calls.tls[0].servername,host);
  }
  const {calls,dependencies}=network();
  for(const operation of ['https://evil.example','/api/user','__proto__',undefined]){
    await assert.rejects(requestPinnedHttps({...options,operation},dependencies),{code:'operation_invalid'});
  }
  assert.equal(calls.tcp.length,0);
});

test('TLS failures, rejected tunnels, oversized headers and bodies, redirects and incomplete responses fail safely',async()=>{
  for(const [settings,code]of[
    [{tlsFailure:true},'proxy_connection_failed'],[{originAuthorized:false},'origin_tls_unverified'],
    [{connectStatus:'HTTP/1.1 407 Proxy Authentication Required'},'proxy_connect_rejected'],
    [{connectHeaders:'X: '+('x'.repeat(8200))},'proxy_header_limit'],
    [{status:302},'redirect_rejected'],[{chunks:[Buffer.alloc(2000001)]},'response_too_large'],
    [{incomplete:true},'response_incomplete'],
  ]){
    const {dependencies}=network(settings);
    await assert.rejects(requestPinnedHttps(options,dependencies),(error)=>{
      assert.ok(error instanceof PinnedTransportError);assert.equal(error.code,code);
      assert.ok(!JSON.stringify(error).includes(key));assert.ok(!JSON.stringify(error).includes('TEST'));
      assert.ok(!error.message.includes('fixie:'));return true;
    });
  }
  const {calls,dependencies}=network({proxyAuthorized:false});
  await assert.rejects(requestPinnedHttps({...options,proxyUrl:proxyUrl.replace('http:','https:'),
    proxyServerName:'criterium.usefixie.com'},dependencies),{code:'proxy_tls_unverified'});
  assert.equal(calls.connect.length,0);
});

test('the total deadline covers a proxy that never connects and always closes its socket',async()=>{
  const {calls,dependencies}=network({stall:true});
  await assert.rejects(requestPinnedHttps({...options,timeoutMs:10},dependencies),{code:'request_timeout'});
  assert.equal(calls.sockets[0].destroyed,true);assert.equal(calls.requests.length,0);
});

test('helper sends exact form fields, keeps the key in a restricted file and preserves provider status',async()=>{
  const args=['--key-file','/private/test-key','--method','fsrar','--inn','9705148570','--kpp','770501001'];
  let requestOptions;let reads=0;
  const result=await runApiHelper(args,{FSRAR_PROXY_URL:proxyUrl},{stat:async()=>({mode:0o100600}),
    readFile:async(path)=>{reads++;assert.equal(path,'/private/test-key');return key+'\n';},
    request:async(opts)=>{requestOptions=opts;return {status:200,body:Buffer.from('{"items":[]}')};}});
  assert.deepEqual(result,{http_status:200,response:{items:[]},attempted:true});assert.equal(reads,1);
  assert.equal(requestOptions.operation,'fsrar');assert.equal(requestOptions.timeoutMs,20000);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requestOptions.body)),{key,inn:'9705148570',kpp:'770501001'});
  assert.ok(!JSON.stringify(args).includes(key));assert.ok(!JSON.stringify(result).includes(key));
});

test('helper never transmits with unsafe key permissions, malformed keys or unsupported arguments',async()=>{
  let calls=0;const request=async()=>{calls++;throw new Error('must not send');};
  const args=['--key-file','/private/test-key','--method','stat'];
  for(const dependencies of[
    {stat:async()=>({mode:0o100644}),readFile:async()=>key,request},
    {stat:async()=>({mode:0o100600}),readFile:async()=>'bad-key',request},
  ])assert.deepEqual(await runApiHelper(args,{FSRAR_PROXY_URL:proxyUrl},dependencies),{attempted:false,transport_error:'fsrar_transport_error'});
  const dependencies={stat:async()=>({mode:0o100600}),readFile:async()=>key,request};
  for(const invalid of[[...args,'--url','https://evil.example'],['--key-file','/private/test-key','--method','delete'],
    ['--key-file','/private/test-key','--method','fsrar','--inn','bad']]){
    assert.equal((await runApiHelper(invalid,{FSRAR_PROXY_URL:proxyUrl},dependencies)).attempted,false);
  }
  assert.equal(calls,0);
});

test('provider text, nested JSON and transport errors cannot expose API or proxy secrets',async()=>{
  const secrets=[key,proxyUrl,'TEST@PROXY:SECRET','TEST%40PROXY%3ASECRET',basic];
  assert.ok(secrets.every((secret)=>!redactApiText(secrets.join(' '),key,proxyUrl).includes(secret)));
  const args=['--key-file','/private/test-key','--method','stat'];
  const dependencies={stat:async()=>({mode:0o100600}),readFile:async()=>key};
  for(const raw of[JSON.stringify({error:secrets.join(' '),nested:[{[key]:proxyUrl}]}),secrets.join(' ')]){
    const result=await runApiHelper(args,{FSRAR_PROXY_URL:proxyUrl},{...dependencies,request:async()=>({status:403,body:Buffer.from(raw)})});
    assert.equal(result.http_status,403);assert.ok(secrets.every((secret)=>!JSON.stringify(result).includes(secret)));
  }
  const result=await runApiHelper(args,{FSRAR_PROXY_URL:proxyUrl},{...dependencies,request:async()=>{throw new Error(secrets.join(' '));}});
  assert.deepEqual(result,{attempted:true,transport_error:'fsrar_transport_error'});
});
