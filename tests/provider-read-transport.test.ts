import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import type {RequestOptions,request} from 'node:https';
import {gzipSync} from 'node:zlib';
import {createProviderReadTransport,createAmazonMcfReadTransport,inspectAmazonMcfReadTransport,ProviderReadError,PROVIDER_READ_LIMITS} from '../server/provider-read-transport';

const policy={routes:[{origin:'https://provider.example',path:'/v1/products/:id',queryKeys:['cursor']}]};
const url='https://provider.example/v1/products/123?cursor=private';
const code=(expected:string)=>(e:unknown)=>{assert(e instanceof ProviderReadError);assert.equal(e.code,expected);assert.equal(e.message,'Provider read transport: '+expected);assert(!('cause'in e));return true;};
type Model={status?:number;body?:Buffer[];headers?:Record<string,string>;peer?:string;authorized?:boolean;complete?:boolean;hang?:boolean;hangConnect?:boolean;networkError?:boolean;idleFire?:boolean};
function model(input:Model={}){
 const seen:RequestOptions[]=[];let ends=0,destroyed=0;const sentBodies:unknown[]=[];
 const make=((options:RequestOptions,callback:(res:IncomingMessage)=>void)=>{
  seen.push(options);let idle:ReturnType<typeof setTimeout>|undefined;const req=Object.assign(new EventEmitter(),{end:()=>{},destroy:()=>{destroyed++;clearTimeout(idle);},setTimeout:(n:number,cb:()=>void)=>{if(input.idleFire)idle=setTimeout(cb,n);}});
  req.end=(body?:unknown)=>{ends++;sentBodies.push(body);queueMicrotask(()=>{
   if(input.networkError){req.emit('error',Error('secret token/network URL'));return;}
   const response=(input.hang?new Readable({read(){}}):Readable.from(input.body??[Buffer.from('{"data":[]}')])) as Readable&{statusCode:number;headers:Record<string,string>;rawHeaders:string[];complete:boolean};
   response.statusCode=input.status??200;response.headers=input.headers??{'content-type':'application/json'};response.rawHeaders=Object.entries(response.headers).flat();response.complete=input.complete??true;callback(response as unknown as IncomingMessage);
  });};
  queueMicrotask(()=>{const socket=Object.assign(new EventEmitter(),{encrypted:true,authorized:input.authorized??true,connecting:true,remoteAddress:input.peer??'8.8.8.8'});req.emit('socket',socket);if(!input.hangConnect){socket.connecting=false;socket.emit('secureConnect');}});
  return req;
 }) as unknown as typeof request;
 return {seen,sentBodies,counts:()=>({ends,destroyed}),deps:{resolve:async()=>[{address:'8.8.8.8',family:4}],request:make}};
}

test('explicit GET/HEAD routes and query keys only, no body or unsafe headers; no network on refusal',async()=>{
 const m=model(),read=createProviderReadTransport(policy,m.deps);
 for(const [u,init,c]of [
  [url,{method:'POST'},'METHOD'],[url,{method:'GET',body:'write'},'BODY'],
  ['https://elsewhere.example/v1/products/123',{},'ROUTE'],['https://provider.example/delete/123',{},'ROUTE'],
  ['https://provider.example/v1/products/123?_method=POST',{},'ROUTE'],['http://provider.example/v1/products/123',{},'URL'],
  [url,{headers:{Cookie:'dyna_session=private'}},'HEADERS'],[url,{headers:{Cookie2:'private'}},'HEADERS'],[url,{headers:{'X-Http-Method-Override':'DELETE'}},'HEADERS'],[url,{headers:{Host:'internal'}},'HEADERS'],
 ]as Array<[string,RequestInit,string]>)await assert.rejects(read(u,init),code(c));
 assert.equal(m.seen.length,0);
 for(const alias of ['_method','method','HTTP_METHOD','X-HTTP-Method-Override','x_method_override']){
  assert.throws(()=>createProviderReadTransport({routes:[{origin:'https://provider.example',path:'/v1/products/:id',queryKeys:[alias]}]},m.deps),code('POLICY'));
  await assert.rejects(read('https://provider.example/v1/products/123?'+new URLSearchParams({[alias]:'DELETE'}),{}),code('ROUTE'));
 }assert.equal(m.seen.length,0);
 assert.throws(()=>createProviderReadTransport({routes:[{origin:'https://provider.example',path:'/v1/*'}]}),code('POLICY'));
});

test('TLS host/SNI and actual peer checked before auth/query dispatch, one pinned request',async()=>{
 const m=model(),read=createProviderReadTransport(policy,m.deps),response=await read(url,{headers:{Authorization:'Bearer secret','Content-Type':'application/json'}});
 assert.deepEqual(await response.json(),{data:[]});assert.equal(m.counts().ends,1);assert.equal(m.seen.length,1);
 assert.equal(m.seen[0]!.hostname,'8.8.8.8');assert.equal(m.seen[0]!.servername,'provider.example');assert.equal(m.seen[0]!.rejectUnauthorized,true);assert.equal(m.seen[0]!.agent,false);
 assert.equal(m.seen[0]!.path,'/v1/products/123?cursor=private');assert.equal((m.seen[0]!.headers as Record<string,string>).authorization,'Bearer secret');
 for(const [input,c]of [[{authorized:false},'TLS'],[{peer:'127.0.0.1'},'PEER']]as Array<[Model,string]>){const bad=model(input);await assert.rejects(createProviderReadTransport(policy,bad.deps)(url,{headers:{Authorization:'secret'}}),code(c));assert.equal(bad.counts().ends,0);assert.equal(bad.counts().destroyed,1);}
});

test('mixed public/private or reserved DNS refuses before any socket; credential-looking upstream errors are sanitized',async()=>{
 const m=model();for(const address of ['10.0.0.1','169.254.169.254','168.63.129.16','::ffff:8.8.8.8','2002:0808:0808::']){
  const read=createProviderReadTransport(policy,{...m.deps,resolve:async()=>[{address:'8.8.8.8',family:4},{address,family:address.includes(':')?6:4}]});await assert.rejects(read(url,{}),code('ADDRESS'));
 }assert.equal(m.seen.length,0);
 const broken=model({networkError:true});await assert.rejects(createProviderReadTransport(policy,broken.deps)(url,{}),code('NETWORK'));
});

test('redirects are refused, 429 remains an ordinary bounded Response without automatic retries or cookie storage',async()=>{
 const redirect=model({status:302,headers:{location:'https://internal.example/?token=secret'}});await assert.rejects(createProviderReadTransport(policy,redirect.deps)(url,{}),code('REDIRECT'));assert.equal(redirect.seen.length,1);
 const throttled=model({status:429,headers:{'retry-after':'60','set-cookie':'secret'},body:[Buffer.from('{"error":"rate"}')]}),res=await createProviderReadTransport(policy,throttled.deps)(url,{});assert.equal(res.status,429);assert.equal(res.headers.get('retry-after'),'60');assert.equal(res.headers.has('set-cookie'),false);assert.equal(throttled.seen.length,1);
});

test('HEAD and 304 return no body; HEAD representation length does not cause a body-size refusal',async()=>{
 const m=model({body:[],headers:{'content-length':'999999999'}}),r=await createProviderReadTransport(policy,m.deps)(url,{method:'HEAD'});assert.equal(await r.text(),'');
 const n=model({status:304,body:[]}),v=await createProviderReadTransport(policy,n.deps)(url,{});assert.equal(v.status,304);assert.equal(await v.text(),'');
});

test('wire and decompressed gzip caps plus incomplete length reject without returning partial bytes',async()=>{
 const cases:Array<[Model,string]>=[
  [{headers:{'content-length':String(PROVIDER_READ_LIMITS.wire_bytes+1)}},'WIRE_LIMIT'],
  [{body:[Buffer.alloc(PROVIDER_READ_LIMITS.wire_bytes+1)]},'WIRE_LIMIT'],
  [{headers:{'content-encoding':'gzip'},body:[gzipSync(Buffer.alloc(PROVIDER_READ_LIMITS.decoded_bytes+1))]},'DECODED_LIMIT'],
  [{headers:{'x-overlarge':'x'.repeat(PROVIDER_READ_LIMITS.header_bytes+1)}},'RESPONSE_HEADERS'],
  [{headers:{'content-length':'99'},body:[Buffer.from('short')]},'INCOMPLETE'],[{complete:false},'INCOMPLETE'],[{headers:{'content-encoding':'br'}},'ENCODING'],
 ];for(const [input,c]of cases){const m=model(input);await assert.rejects(createProviderReadTransport(policy,m.deps)(url,{}),code(c));}
 const body=Buffer.from('{"decoded":true}'),gzip=model({headers:{'content-encoding':'gzip'},body:[gzipSync(body)]}),res=await createProviderReadTransport(policy,gzip.deps)(url,{});assert.deepEqual(await res.json(),{decoded:true});assert.equal(res.headers.has('content-encoding'),false);assert.equal(res.headers.get('content-length'),String(body.length));
});

test('deadline, caller abort and connect timeout destroy requests; no retry, canceled DNS never opens a socket',async()=>{
 for(const [input,timeouts,c]of [[{hang:true},{deadline_ms:15},'DEADLINE'],[{hangConnect:true},{connect_ms:10},'CONNECT_TIMEOUT'],[{hang:true,idleFire:true},{idle_ms:5},'IDLE_TIMEOUT']]as Array<[Model,{deadline_ms?:number;connect_ms?:number;idle_ms?:number},string]>){const m=model(input);await assert.rejects(createProviderReadTransport(policy,{...m.deps,timeouts})(url,{}),code(c));assert.equal(m.counts().destroyed,1);}
 const m=model({hang:true}),controller=new AbortController(),promise=createProviderReadTransport(policy,m.deps)(url,{signal:controller.signal});setTimeout(()=>controller.abort(),10);await assert.rejects(promise,code('ABORTED'));assert.equal(m.counts().destroyed,1);
 const dns=model(),abort=new AbortController(),slow=createProviderReadTransport(policy,{...dns.deps,resolve:()=>new Promise(()=>{})})(url,{signal:abort.signal});abort.abort();await assert.rejects(slow,code('ABORTED'));assert.equal(dns.seen.length,0);
});

test('inflight and rolling rate caps fail closed, policy copied and cannot gain paths after construction',async()=>{
 const m=model({hang:true}),read=createProviderReadTransport(policy,m.deps),a=new AbortController(),b=new AbortController();
 const first=read(url,{signal:a.signal}),second=read(url,{signal:b.signal});const firstError=assert.rejects(first,code('ABORTED')),secondError=assert.rejects(second,code('ABORTED'));await assert.rejects(read(url,{}),code('RATE_LIMIT'));a.abort();b.abort();await Promise.all([firstError,secondError]);
 const n=model(),policyCopy={routes:[{...policy.routes[0]!,queryKeys:['cursor']}]},limited=createProviderReadTransport(policyCopy,n.deps);policyCopy.routes.push({origin:'https://elsewhere.example',path:'/new',queryKeys:[]});await assert.rejects(limited('https://elsewhere.example/new',{}),code('ROUTE'));
 for(let i=0;i<30;i++)await limited(url,{});await assert.rejects(limited(url,{}),code('RATE_LIMIT'));assert.equal(n.seen.length,30);
});


test('explicit final slash matches exactly; doubled/interior empty or dot segments still refuse',async()=>{
 const m=model(),read=createProviderReadTransport({routes:[{origin:'https://provider.example',path:'/api/exchangerates/rates/a/eur/',methods:['GET'],queryKeys:['format']}]},m.deps);
 await read('https://provider.example/api/exchangerates/rates/a/eur/?format=json',{method:'GET'});assert.equal(m.seen.length,1);assert.equal(m.seen[0]!.path,'/api/exchangerates/rates/a/eur/?format=json');
 await assert.rejects(read('https://provider.example/api/exchangerates/rates/a/eur?format=json',{}),code('ROUTE'));
 for(const path of ['/', '//', '/api//rates/', '/api/rates//', '/api/./rates/', '/api/../rates/'])assert.throws(()=>createProviderReadTransport({routes:[{origin:'https://provider.example',path}]},m.deps),code('POLICY'));
 const plain=createProviderReadTransport({routes:[{origin:'https://provider.example',path:'/plain'}]},m.deps);
 await assert.rejects(plain('https://provider.example/plain/',{}),code('ROUTE'));assert.equal(m.seen.length,1);
});

const mcfScope={mode:'sandbox' as const,region:'eu' as const},mcfOrigin='https://sandbox.sellingpartnerapi-eu.amazon.com',mcfBase=mcfOrigin+'/fulfillment/outbound/2026-07-04';
const tokenHeaders={Accept:'application/json','Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},tokenBody=new URLSearchParams({grant_type:'refresh_token',client_id:'controlled-client',client_secret:'controlled-secret',refresh_token:'controlled-refresh'}).toString();
const previewBody=JSON.stringify({origin:{countryCode:'DE'},destination:{deliveryAddress:{name:'QA',addressLine1:'Test1',postalCode:'00-001',countryCode:'PL'}},lineItems:[{product:{productIdentifier:{amazonSku:'A1'}},amount:{unit:'EACHES',value:'2'}}]}),mcfHeaders={Accept:'application/json','Content-Type':'application/json','x-amz-access-token':'controlled-access'};
test('MCF capability is genuine fixedmode/region and ordinary transport still refuses POST',async()=>{const m=model(),cap=createAmazonMcfReadTransport(mcfScope,m.deps);assert.deepEqual(inspectAmazonMcfReadTransport(cap),mcfScope);assert.throws(()=>inspectAmazonMcfReadTransport(async()=>new Response('{}')),code('POLICY'));for(const bad of [{mode:'sandbox',region:'eu',origin:'https://evil.example'},{mode:'other',region:'eu'},null])assert.throws(()=>createAmazonMcfReadTransport(bad as any,m.deps),code('POLICY'));assert.throws(()=>createProviderReadTransport(undefined as any,m.deps),code('POLICY'));await assert.rejects(createProviderReadTransport(policy,m.deps)('https://api.amazon.com/auth/o2/token',{method:'POST',headers:tokenHeaders,body:tokenBody}),code('METHOD'));assert.equal(m.seen.length,0);});
test('MCF LWArefresh exact body sent once only AFTER actual modeled TLS/peer verification',async()=>{const m=model();await createAmazonMcfReadTransport(mcfScope,m.deps)('https://api.amazon.com/auth/o2/token',{method:'POST',headers:tokenHeaders,body:tokenBody});assert.equal(m.sentBodies[0],tokenBody);assert.equal(m.counts().ends,1);assert.equal(m.seen[0]!.servername,'api.amazon.com');const bad=model({authorized:false});await assert.rejects(createAmazonMcfReadTransport(mcfScope,bad.deps)('https://api.amazon.com/auth/o2/token',{method:'POST',headers:tokenHeaders,body:tokenBody}),code('TLS'));assert.equal(bad.counts().ends,0);});
test('MCF preview validated read POST and exact encodedorderGET use same bounded engine',async()=>{const m=model(),read=createAmazonMcfReadTransport(mcfScope,m.deps);await read(mcfBase+'/previews',{method:'POST',headers:mcfHeaders,body:previewBody});assert.equal(m.sentBodies[0],previewBody);await read(mcfBase+'/orders/A%2F1?shipments=INCLUDE',{method:'GET',headers:mcfHeaders});assert.equal(m.sentBodies[1],undefined);assert.equal(m.seen[1]!.method,'GET');});
test('MCF denies create/cancel/SHIP/unknown fields, arbitrary hosts/modes/queries before DNS',async()=>{const m=model(),read=createAmazonMcfReadTransport(mcfScope,m.deps);for(const [url,init]of[[mcfBase+'/orders',{method:'POST',headers:mcfHeaders,body:previewBody}],[mcfBase+'/orders/A/cancel',{method:'PUT',headers:mcfHeaders,body:'{}'}],[mcfBase+'/previews',{method:'POST',headers:mcfHeaders,body:JSON.stringify({...JSON.parse(previewBody),action:'SHIP'})}],[mcfBase+'/previews?extra=1',{method:'POST',headers:mcfHeaders,body:previewBody}],['https://sellingpartnerapi-eu.amazon.com/fulfillment/outbound/2026-07-04/previews',{method:'POST',headers:mcfHeaders,body:previewBody}],['https://evil.example/auth/o2/token',{method:'POST',headers:tokenHeaders,body:tokenBody}],[mcfBase+'/orders/A?shipments=INCLUDE&method=POST',{method:'GET',headers:mcfHeaders}]])await assert.rejects(read(url as string,init as RequestInit));assert.equal(m.seen.length,0);});
test('LWA authorizationcode/duplicate keys/empty secrets/oversized or binary body refused before socket',async()=>{const m=model(),read=createAmazonMcfReadTransport(mcfScope,m.deps);for(const body of[tokenBody+'&grant_type=refresh_token',tokenBody.replace('refresh_token','authorization_code'),tokenBody.replace('controlled-secret',''),Buffer.from(tokenBody),'x'.repeat(32769)])await assert.rejects(read('https://api.amazon.com/auth/o2/token',{method:'POST',headers:tokenHeaders,body:body as BodyInit}),code('BODY'));assert.equal(m.seen.length,0);});
test('MCF refuses cookies/method override/host/extra auth headers and mismatched content type',async()=>{const m=model(),read=createAmazonMcfReadTransport(mcfScope,m.deps);for(const headers of[{...mcfHeaders,Cookie:'private'},{...mcfHeaders,'X-HTTP-Method-Override':'PUT'},{...mcfHeaders,Host:'internal'},{...mcfHeaders,Authorization:'Bearer wrong'},{...mcfHeaders,'Content-Type':'text/plain'}])await assert.rejects(read(mcfBase+'/previews',{method:'POST',headers,body:previewBody}),code('HEADERS'));assert.equal(m.seen.length,0);});
test('MCF shares original publicaddress/redirect/byte/deadline protections without retries',async()=>{const m=model();await assert.rejects(createAmazonMcfReadTransport(mcfScope,{...m.deps,resolve:async()=>[{address:'127.0.0.1',family:4}]})(mcfBase+'/previews',{method:'POST',headers:mcfHeaders,body:previewBody}),code('ADDRESS'));assert.equal(m.seen.length,0);const redirect=model({status:302,headers:{location:'https://evil.example'}});await assert.rejects(createAmazonMcfReadTransport(mcfScope,redirect.deps)(mcfBase+'/previews',{method:'POST',headers:mcfHeaders,body:previewBody}),code('REDIRECT'));assert.equal(redirect.counts().ends,1);const large=model({headers:{'content-length':String(PROVIDER_READ_LIMITS.wire_bytes+1)}});await assert.rejects(createAmazonMcfReadTransport(mcfScope,large.deps)(mcfBase+'/previews',{method:'POST',headers:mcfHeaders,body:previewBody}),code('WIRE_LIMIT'));});
test('MCF capabilities snapshotmode/region and have same thirtycall ceiling',async()=>{const m=model(),scope={...mcfScope},read=createAmazonMcfReadTransport(scope,m.deps);scope.region='na' as any;assert.equal(inspectAmazonMcfReadTransport(read).region,'eu');for(let i=0;i<30;i++)await read(mcfBase+'/orders/A?shipments=INCLUDE',{method:'GET',headers:mcfHeaders});await assert.rejects(read(mcfBase+'/orders/A?shipments=INCLUDE',{method:'GET',headers:mcfHeaders}),code('RATE_LIMIT'));assert.equal(m.counts().ends,30);});
import {prepareOrdinaryAmazonMcfReads} from '../server/ordinary-provider-reads';
import {parseOrdinaryLocalCliArgs} from '../server/ordinary-local-cli';
test('ordinary MCF capability default optout stays inert and readonly/localWoo refuse before any resource',()=>{for(const context of[{readOnly:false,localWooFixture:false},{readOnly:true,localWooFixture:false},{readOnly:false,localWooFixture:true}])assert.equal(prepareOrdinaryAmazonMcfReads(undefined,context),undefined);for(const context of[{readOnly:true,localWooFixture:false},{readOnly:false,localWooFixture:true}])assert.throws(()=>prepareOrdinaryAmazonMcfReads(mcfScope,context));const cap=prepareOrdinaryAmazonMcfReads(mcfScope,{readOnly:false,localWooFixture:false})!;assert.deepEqual(inspectAmazonMcfReadTransport(cap),mcfScope);});
test('ordinary CLI sandboxEU only is explicit; default and unrelated local flags remain independent',()=>{const base=['/controlled/selection.json','a'.repeat(64),'4197'];const plain=parseOrdinaryLocalCliArgs(base);assert.equal('amazonMcfReads' in plain.options,false);const p=parseOrdinaryLocalCliArgs([...base,'--amazon-mcf-sandbox-eu','--nbp-eur','--scoped-automation','--verified-stock-writers']);assert.deepEqual(p.options.amazonMcfReads,{mode:'sandbox',region:'eu'});assert.equal(p.options.nbpRates?.maxAgeDays,7);assert.equal(p.options.scopedAutomationEnabled,true);for(const flags of[['--amazon-mcf-live-eu'],['--amazon-mcf-sandbox-na'],['--amazon-mcf-sandbox-eu','--amazon-mcf-sandbox-eu']])assert.throws(()=>parseOrdinaryLocalCliArgs([...base,...flags]));});
