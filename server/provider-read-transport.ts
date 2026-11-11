/** Explicit provider reads only. No config, app, credential store, retries or cookie jar. */
import {lookup} from 'node:dns/promises';
import {validateOrdinaryConnectorAccess,validateOrdinaryConnectorRequest,ConnectorPolicyError,type OrdinaryConnectorAccessConfiguration} from './ordinary-connector-policy';
export type {OrdinaryConnectorAccessConfiguration} from './ordinary-connector-policy';
import {amazonBase} from './amazon';
import {mcfPreviewInput,mcfId} from './amazon-mcf-api';
import {request as httpsRequest,type RequestOptions} from 'node:https';
import {isIP} from 'node:net';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {isPublicSupplierFeedAddress,supplierRemoteFeedUrl} from './supplier-remote-fetch-transport';

export const PROVIDER_READ_LIMITS=Object.freeze({wire_bytes:4*1024*1024,decoded_bytes:4*1024*1024,header_bytes:16384,deadline_ms:20000,connect_ms:5000,idle_ms:5000,inflight:2,calls_per_minute:30});
type Code='POLICY'|'METHOD'|'BODY'|'URL'|'ROUTE'|'HEADERS'|'RATE_LIMIT'|'ABORTED'|'DEADLINE'|'DNS'|'ADDRESS'|'TLS'|'PEER'|'CONNECT_TIMEOUT'|'IDLE_TIMEOUT'|'NETWORK'|'REDIRECT'|'RESPONSE_HEADERS'|'STATUS'|'ENCODING'|'WIRE_LIMIT'|'DECODED_LIMIT'|'INCOMPLETE';
export class ProviderReadError extends Error{
 constructor(public readonly code:Code){super(`Provider read transport: ${code}`);this.name='ProviderReadError';}
}
export type ProviderReadRoute={origin:string;path:string;queryKeys?:readonly string[];methods?:readonly ('GET'|'HEAD')[]};
export type ProviderReadPolicy={routes:readonly ProviderReadRoute[]};
export type ProviderReadDependencies={resolve?:(host:string)=>Promise<Array<{address:string;family:number}>>;request?:typeof httpsRequest;timeouts?:Partial<{deadline_ms:number;connect_ms:number;idle_ms:number}>};
export type ProviderReadTransport=(url:string,init:RequestInit)=>Promise<Response>;
const fail=(code:Code)=>new ProviderReadError(code);
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const methodOverride=(key:string)=>['method','httpmethod','httpmethodoverride','xhttpmethod','xhttpmethodoverride','xmethodoverride','methodoverride'].includes(key.toLowerCase().replace(/[-_]/g,''));
function routePolicy(policy:ProviderReadPolicy){
 if(!policy||!Array.isArray(policy.routes)||policy.routes.length===0||policy.routes.length>64)throw fail('POLICY');
 return policy.routes.map((input:ProviderReadRoute)=>{
  let origin:URL;try{origin=supplierRemoteFeedUrl(input.origin);}catch{throw fail('POLICY');}
  if(origin.origin!==input.origin||origin.pathname!=='/'||origin.search||typeof input.path!=='string'||input.path.length>1024||!input.path.startsWith('/'))throw fail('POLICY');
  const trailingSlash=input.path.endsWith('/'),parts=input.path.split('/').slice(1);
  if(trailingSlash)parts.pop();
  if(parts.length===0||parts.some(p=>!p||p==='.'||p==='..'||!/^:[A-Za-z][A-Za-z0-9_]*$|^[A-Za-z0-9._~-]+$/.test(p)))throw fail('POLICY');
  if(input.queryKeys!==undefined&&!Array.isArray(input.queryKeys)||input.methods!==undefined&&!Array.isArray(input.methods))throw fail('POLICY');
  const keys=[...(input.queryKeys??[])],methods=[...(input.methods??['GET','HEAD'])];
  if(keys.length>32||new Set(keys).size!==keys.length||keys.some(k=>!/^[A-Za-z0-9_.-]{1,80}$/.test(k)||methodOverride(k))||methods.length===0||methods.length>2||new Set(methods).size!==methods.length||methods.some(m=>m!=='GET'&&m!=='HEAD'))throw fail('POLICY');
  return {origin:origin.origin,path:new RegExp('^/'+parts.map(p=>p.startsWith(':')?'[A-Za-z0-9_-]{1,160}':escape(p)).join('/')+(trailingSlash?'/':'')+'$'),keys:new Set(keys),methods:new Set(methods)};
 });
}
function safeHeaders(init:RequestInit,url:URL){
 let parsed:Headers;try{parsed=new Headers(init.headers);}catch{throw fail('HEADERS');}
 const headers:Record<string,string>={Host:url.host,Accept:'*/*','Accept-Encoding':'identity'};
 for(const [name,value]of parsed){
  if(/^(?:host|cookie2?|connection|proxy-.*|forwarded|x-forwarded-.*|x-real-ip|x-http-method.*|x-method-override|x-original-.*|x-rewrite-.*|content-length|transfer-encoding|te|trailer|upgrade|accept-encoding)$/i.test(name)||!/^[\x20-\x7e]*$/.test(value)||value.length>8192)throw fail('HEADERS');
  headers[name]=value;
 }
 if(Object.keys(headers).length>64||Object.entries(headers).reduce((n,[k,v])=>n+Buffer.byteLength(k+v)+4,0)>PROVIDER_READ_LIMITS.header_bytes)throw fail('HEADERS');
 return headers;
}
function peerMatches(peer:string|undefined,pinned:string){
 if(!peer)return false;
 if(isIP(pinned)===4){if(peer.startsWith('::ffff:'))peer=peer.slice(7);return peer===pinned;}
 try{return new URL('https://['+peer+']/').hostname===new URL('https://['+pinned+']/').hostname;}catch{return false;}
}

/** Fixed read-only MCF capability: private specialization of the same bounded DNS/TLS engine. */
export type AmazonMcfReadConfiguration={mode:'live'|'sandbox';region:'eu'|'na'|'fe'};
declare const mcfReadBrand:unique symbol;
export type AmazonMcfReadTransport=ProviderReadTransport&{readonly[mcfReadBrand]:true};
const mcfReadCapabilities=new WeakMap<object,Readonly<AmazonMcfReadConfiguration>>();
export function inspectAmazonMcfReadTransport(value:unknown):Readonly<AmazonMcfReadConfiguration>{
 if(typeof value!=='function'||!mcfReadCapabilities.has(value))throw fail('POLICY');return mcfReadCapabilities.get(value)!;
}
function mcfConfiguration(input:AmazonMcfReadConfiguration){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='mode,region'||!['live','sandbox'].includes(input.mode)||!['eu','na','fe'].includes(input.region))throw fail('POLICY');
 return Object.freeze({mode:input.mode,region:input.region});
}
function mcfRequestBody(url:URL,init:RequestInit,scope:Readonly<AmazonMcfReadConfiguration>):string|undefined{
 const method=init.method??'GET',origin=amazonBase(scope.mode,scope.region),path='/fulfillment/outbound/2026-07-04';
 let headers:Headers;try{headers=new Headers(init.headers);}catch{throw fail('HEADERS');}
 const token=url.href==='https://api.amazon.com/auth/o2/token';
 const allowed=token?['content-type','accept']:['accept','content-type','x-amz-access-token','x-amz-date','user-agent','x-amzn-fulfillment-service-id'];
 if([...headers.keys()].some(k=>!allowed.includes(k)))throw fail('HEADERS');
 if(headers.get('accept')!=='application/json')throw fail('HEADERS');
 if(token){
  if(method!=='POST')throw fail('METHOD');
  if(typeof init.body!=='string'||Buffer.byteLength(init.body)>32768)throw fail('BODY');
  if(!/^application\/x-www-form-urlencoded(?:;charset=UTF-8)?$/i.test(headers.get('content-type')??''))throw fail('HEADERS');
  const params=new URLSearchParams(init.body),keys=[...params.keys()].sort();
  if(keys.join(',')!=='client_id,client_secret,grant_type,refresh_token'||params.get('grant_type')!=='refresh_token')throw fail('BODY');
  for(const key of['client_id','client_secret','refresh_token'])if(!/^[^\s\x00-\x1f\x7f]{1,2048}$/.test(params.get(key)??''))throw fail('BODY');
  return init.body;
 }
 if(url.origin!==origin)throw fail('ROUTE');
 if(!headers.has('x-amz-access-token')||!/^[^\s\x00-\x1f\x7f]{1,2048}$/.test(headers.get('x-amz-access-token')!))throw fail('HEADERS');
 if(url.pathname===path+'/previews'&&!url.search){
  if(method!=='POST')throw fail('METHOD');
  if(typeof init.body!=='string'||Buffer.byteLength(init.body)>32768)throw fail('BODY');
  if(headers.get('content-type')!=='application/json')throw fail('HEADERS');
  try{mcfPreviewInput.parse(JSON.parse(init.body));}catch{throw fail('BODY');}
  return init.body;
 }
 const prefix=path+'/orders/';
 if(method!=='GET'||!url.pathname.startsWith(prefix)||url.search!=='?shipments=INCLUDE')throw fail('ROUTE');
 if(init.body!==undefined&&init.body!==null)throw fail('BODY');
 try{const tail=url.pathname.slice(prefix.length),id=decodeURIComponent(tail);mcfId.parse(id);if(encodeURIComponent(id)!==tail)throw fail('ROUTE');}catch{throw fail('ROUTE');}
 return undefined;
}
/** No DNS, HTTP, configuration IO or credential loading during construction. */
export function createAmazonMcfReadTransport(input:AmazonMcfReadConfiguration,dependencies:ProviderReadDependencies={}):AmazonMcfReadTransport{
 const scope=mcfConfiguration(input),transport=createBoundedProviderTransport(undefined,dependencies,scope) as AmazonMcfReadTransport;
 mcfReadCapabilities.set(transport,scope);return transport;
}

/** Explicit trusted provider/mode/store capability; never constructed from an HTTP request. */
declare const ordinaryConnectorBrand:unique symbol;
export type OrdinaryConnectorTransport=ProviderReadTransport&{readonly[ordinaryConnectorBrand]:true};
const connectorCapabilities=new WeakMap<object,Readonly<OrdinaryConnectorAccessConfiguration>>();
export function inspectOrdinaryConnectorTransport(value:unknown):Readonly<OrdinaryConnectorAccessConfiguration>{if(typeof value!=='function'||!connectorCapabilities.has(value))throw fail('POLICY');return connectorCapabilities.get(value)!;}
export function createOrdinaryConnectorTransport(input:OrdinaryConnectorAccessConfiguration,dependencies:ProviderReadDependencies={}):OrdinaryConnectorTransport{
 let scope:Readonly<OrdinaryConnectorAccessConfiguration>;try{scope=validateOrdinaryConnectorAccess(input);}catch{throw fail('POLICY');}
 const transport=createBoundedProviderTransport(undefined,dependencies,undefined,scope) as OrdinaryConnectorTransport;connectorCapabilities.set(transport,scope);return transport;
}

export function createProviderReadTransport(policy:ProviderReadPolicy,dependencies:ProviderReadDependencies={}):ProviderReadTransport{
 return createBoundedProviderTransport(policy,dependencies);
}
function createBoundedProviderTransport(policy:ProviderReadPolicy|undefined,dependencies:ProviderReadDependencies, mcf?:Readonly<AmazonMcfReadConfiguration>,connector?:Readonly<OrdinaryConnectorAccessConfiguration>):ProviderReadTransport{
 dependencies={...dependencies};
 const routes=mcf||connector?[]:routePolicy(policy!),time=(key:'deadline_ms'|'connect_ms'|'idle_ms')=>{const n=dependencies.timeouts?.[key]??PROVIDER_READ_LIMITS[key];if(!Number.isInteger(n)||n<=0||n>PROVIDER_READ_LIMITS[key])throw fail('POLICY');return n;};
 const deadlineMs=time('deadline_ms'),connectMs=time('connect_ms'),idleMs=time('idle_ms');let inflight=0;let calls:number[]=[];
 return async(urlText,init={})=>{
  const signal=init.signal;
  const method=init.method??'GET';if(!mcf&&!connector){if(method!=='GET'&&method!=='HEAD')throw fail('METHOD');if(init.body!==undefined&&init.body!==null)throw fail('BODY');}
  let url:URL;try{url=supplierRemoteFeedUrl(urlText);}catch{throw fail('URL');}
  let connectorRequest:ReturnType<typeof validateOrdinaryConnectorRequest>|undefined;try{if(connector)connectorRequest=validateOrdinaryConnectorRequest(url,init,connector);}catch(e){if(e instanceof ConnectorPolicyError)throw fail(e.code);throw fail('POLICY');}
  const requestBody=mcf?mcfRequestBody(url,init,mcf):connectorRequest?.body;
  if(!mcf&&!connector&&([...url.searchParams.keys()].some(methodOverride)||!routes.some(r=>r.origin===url.origin&&r.methods.has(method as 'GET'|'HEAD')&&r.path.test(url.pathname)&&[...url.searchParams.keys()].every(k=>r.keys.has(k)))))throw fail('ROUTE');
  const headers=safeHeaders(init,url);if(signal?.aborted)throw fail('ABORTED');
  const now=performance.now();calls=calls.filter(t=>now-t<60000);if(inflight>=PROVIDER_READ_LIMITS.inflight||calls.length>=PROVIDER_READ_LIMITS.calls_per_minute)throw fail('RATE_LIMIT');calls.push(now);inflight++;
  const controller=new AbortController(),abort=()=>controller.abort(fail('ABORTED')),timer=setTimeout(()=>controller.abort(fail('DEADLINE')),deadlineMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const reason=()=>controller.signal.reason instanceof ProviderReadError?controller.signal.reason:fail('ABORTED');
  try{
   const host=url.hostname.replace(/^\[|\]$/g,''),addresses=await new Promise<Array<{address:string;family:number}>>((resolve,reject)=>{
    if(controller.signal.aborted){reject(reason());return;}
    const onAbort=()=>reject(reason());controller.signal.addEventListener('abort',onAbort,{once:true});
    const query=isIP(host)?Promise.resolve([{address:host,family:isIP(host)}]):Promise.resolve().then(()=>(dependencies.resolve??(h=>lookup(h,{all:true,verbatim:true})))(host));
    query.then(resolve,()=>reject(fail('DNS'))).finally(()=>controller.signal.removeEventListener('abort',onAbort));
   });
   if(!addresses.length||addresses.length>64||addresses.some(a=>a.family!==isIP(a.address)||!isPublicSupplierFeedAddress(a.address)))throw fail('ADDRESS');
   if(controller.signal.aborted)throw reason();const pinned=addresses[0]!;
   return await new Promise<Response>((resolve,reject)=>{
    let req:import('node:http').ClientRequest|undefined,res:import('node:http').IncomingMessage|undefined,decoder:ReturnType<typeof createGunzip>|undefined,settled=false,verified=false,connectTimer:ReturnType<typeof setTimeout>|undefined;
    const finish=(error?:ProviderReadError,result?:Response)=>{if(settled)return;settled=true;clearTimeout(connectTimer);controller.signal.removeEventListener('abort',onAbort);if(error){res?.destroy();decoder?.destroy();req?.destroy();reject(error);}else resolve(result!);};
    const onAbort=()=>finish(reason());controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted){onAbort();return;}
    const options:RequestOptions={protocol:'https:',hostname:pinned.address,family:pinned.family,port:443,path:url.pathname+url.search,method,headers,agent:false,rejectUnauthorized:true,servername:isIP(host)?'':host,checkServerIdentity:(_hostname,cert)=>checkServerIdentity(host,cert),maxHeaderSize:PROVIDER_READ_LIMITS.header_bytes};
    connectTimer=setTimeout(()=>finish(fail('CONNECT_TIMEOUT')),connectMs);
    try{
     req=(dependencies.request??httpsRequest)(options,response=>{res=response;void(async()=>{
      if(!verified)throw fail('PEER');if(response.rawHeaders.reduce((n,h)=>n+Buffer.byteLength(h)+4,0)>PROVIDER_READ_LIMITS.header_bytes)throw fail('RESPONSE_HEADERS');
      const status=response.statusCode;if(!Number.isInteger(status)||status!<200||status!>599)throw fail('STATUS');if(status!>=300&&status!<400&&status!==304&&!(status===303&&connectorRequest?.manual303))throw fail('REDIRECT');
      const noBody=method==='HEAD'||status===204||status===205||status===304,encoding=response.headers['content-encoding']??'identity';if(!noBody&&encoding!=='identity'&&encoding!=='gzip')throw fail('ENCODING');
      const length=response.headers['content-length'];if(length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)))throw fail('INCOMPLETE');if(!noBody&&length!==undefined&&BigInt(length)>BigInt(PROVIDER_READ_LIMITS.wire_bytes))throw fail('WIRE_LIMIT');
      let wire=0,decoded=0;const chunks:Buffer[]=[];
      const bound=new Transform({transform(chunk:Buffer,_encoding,callback){wire+=chunk.length;if(wire>PROVIDER_READ_LIMITS.wire_bytes){callback(fail('WIRE_LIMIT'));return;}if(noBody&&wire){callback(fail('INCOMPLETE'));return;}callback(null,chunk);}});
      const sink=new Writable({write(chunk:Buffer,_encoding,callback){decoded+=chunk.length;if(decoded>PROVIDER_READ_LIMITS.decoded_bytes){callback(fail('DECODED_LIMIT'));return;}chunks.push(Buffer.from(chunk));callback();}});
      if(!noBody&&encoding==='gzip'){decoder=createGunzip();await pipeline(response,bound,decoder,sink);}else await pipeline(response,bound,sink);
      if(!response.complete||!noBody&&length!==undefined&&BigInt(length)!==BigInt(wire))throw fail('INCOMPLETE');
      const responseHeaders=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)if(!/^(?:set-cookie|content-encoding|content-length|transfer-encoding|connection)$/i.test(response.rawHeaders[i]!))responseHeaders.append(response.rawHeaders[i]!,response.rawHeaders[i+1]!);
      if(!noBody)responseHeaders.set('content-length',String(decoded));
      finish(undefined,new Response(noBody?null:new Uint8Array(Buffer.concat(chunks,decoded)),{status,headers:responseHeaders}));
     })().catch(e=>finish(e instanceof ProviderReadError?e:fail('INCOMPLETE')));});
     req.on('error',()=>finish(fail('NETWORK')));req.setTimeout(idleMs,()=>finish(fail('IDLE_TIMEOUT')));
     req.on('socket',socket=>{const tls=socket as TLSSocket;const connected=()=>{if(settled)return;if(!tls.encrypted||!tls.authorized){finish(fail('TLS'));return;}if(!peerMatches(tls.remoteAddress,pinned.address)){finish(fail('PEER'));return;}verified=true;clearTimeout(connectTimer);if(requestBody===undefined)req!.end();else req!.end(requestBody);};if(tls.encrypted&&!tls.connecting&&tls.authorized)connected();else tls.once('secureConnect',connected);});
    }catch{finish(fail('NETWORK'));}
   });
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);inflight--;}
 };
}
