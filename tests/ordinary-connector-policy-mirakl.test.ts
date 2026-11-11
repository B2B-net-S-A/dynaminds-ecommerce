import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import type {RequestOptions,request} from 'node:https';
import {createOrdinaryConnectorTransport,inspectOrdinaryConnectorTransport,ProviderReadError} from '../server/provider-read-transport';
import {validateOrdinaryConnectorAccess,validateOrdinaryConnectorRequest,ConnectorPolicyError} from '../server/ordinary-connector-policy';
import {bindOrdinaryConnectorTransport,ordinaryConnectorOrigins} from '../server/ordinary-connector-routing';
import {assertOrdinaryConnectorJobExecution} from '../server/ordinary-connector-jobs';
import {Mirakl} from '../server/mirakl';

// Controlled HTTP/TLS fixtures, no external account calls or sandbox assertion.
const origin='https://selected-instance.mirakl.net',secret='CONTROLLED_PRIVATE_API_KEY';
const selected=()=>({providers:[{provider:'mirakl' as const,instanceUrl:origin,shopId:'2000',access:'read' as const}]});
const headers={Accept:'application/json',Authorization:secret};
const window={start_update_date:'2026-10-01T00:00:00Z',end_update_date:'2026-10-02T00:00:00Z'};
const ordersQuery=()=>({shop_id:'2000',max:'100',offset:'0',...window,order_tax_mode:'TAX_INCLUDED',sort:'dateCreated',order:'asc'});
const url=(path='/api/account',query:Record<string,string>={shop_id:'2000'})=>origin+path+'?'+new URLSearchParams(query);
const policyCode=(expected:string)=>(error:unknown)=>error instanceof ConnectorPolicyError&&error.code===expected;
const transportCode=(expected:string)=>(error:unknown)=>error instanceof ProviderReadError&&error.code===expected&&error.message==='Provider read transport: '+expected&&!('cause'in error);
function model(input:{peer?:string;authorized?:boolean;status?:number;networkError?:boolean}={}){
 const seen:RequestOptions[]=[],sent:unknown[]=[];let dns=0;
 const make=((options:RequestOptions,callback:(res:IncomingMessage)=>void)=>{
  seen.push(options);
  const req=Object.assign(new EventEmitter(),{end:(_body?:unknown)=>{},destroy:()=>{},setTimeout:()=>{}});
  req.end=(body?:unknown)=>{sent.push(body);queueMicrotask(()=>{
   if(input.networkError){req.emit('error',Error(secret+' PRIVATE_BODY'));return;}
   const pathname=new URL(options.path! as string,origin).pathname;
   const data=pathname==='/api/account'?{shop_id:2000,shop_name:'Controlled',currency_iso_code:'PLN',shop_state:'OPEN',model:'MARKETPLACE'}
    :pathname==='/api/orders'?{orders:[],total_count:0}:{offers:[],total_count:0};
   const res=Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]),{statusCode:input.status??200,headers:{'content-type':'application/json'},rawHeaders:['content-type','application/json'],complete:true});
   callback(res as unknown as IncomingMessage);
  });};
  queueMicrotask(()=>{const socket=Object.assign(new EventEmitter(),{encrypted:true,authorized:input.authorized??true,connecting:true,remoteAddress:input.peer??'8.8.8.8'});req.emit('socket',socket);socket.connecting=false;socket.emit('secureConnect');});
  return req;
 }) as unknown as typeof request;
 return{seen,sent,dns:()=>dns,deps:{resolve:async()=>{dns++;return[{address:'8.8.8.8',family:4}];},request:make}};
}

test('Mirakl capability selects exact instance and own shop; no mode/write/wildcards/private hosts or aliases',()=>{
 const configuration=selected(),scope=validateOrdinaryConnectorAccess(configuration);
 configuration.providers[0].instanceUrl='https://mutated.mirakl.net';configuration.providers[0].shopId='999';
 assert.deepEqual(scope,selected());assert(Object.isFrozen(scope));assert(Object.isFrozen(scope.providers));assert(Object.isFrozen(scope.providers[0]));
 for(const changed of [{access:'write'},{mode:'sandbox'},{instanceUrl:'https://*.mirakl.net'},{instanceUrl:'https://mirakl.net'},
  {instanceUrl:origin+'/'},{instanceUrl:origin+':443'},{instanceUrl:origin+'/api'},{instanceUrl:origin+'?x=1'},
  {instanceUrl:origin+'#x'},{instanceUrl:'https://user:pass@selected-instance.mirakl.net'},
  {instanceUrl:'https://selected-instance.mirakl.net.evil.example'},{instanceUrl:'https://a.b.mirakl.net'},
  {instanceUrl:'http://selected-instance.mirakl.net'},{instanceUrl:'https://127.0.0.1'},{instanceUrl:'https://localhost'},
  {shopId:'0'},{shopId:'01'},{shopId:'9007199254740992'},{shopId:2000},{api_key:secret}])
  assert.throws(()=>validateOrdinaryConnectorAccess({providers:[{...selected().providers[0],...changed}]} as any),policyCode('POLICY'));
 assert.throws(()=>validateOrdinaryConnectorAccess({providers:[...selected().providers,...selected().providers]}),policyCode('POLICY'));
 for(const key of ['instanceUrl','shopId','access']){const p:Record<string,unknown>={...selected().providers[0]};delete p[key];assert.throws(()=>validateOrdinaryConnectorAccess({providers:[p]} as any),policyCode('POLICY'));}
});

test('only three GET endpoints and required exact own shop are allowed; a second explicitly selected shop works',()=>{
 const scope=validateOrdinaryConnectorAccess({providers:[...selected().providers,{...selected().providers[0],shopId:'3000'}]});
 const check=(u:string,init:RequestInit={})=>validateOrdinaryConnectorRequest(new URL(u),{headers,...init},scope);
 assert.deepEqual(check(url()),{body:undefined,manual303:false});check(url('/api/account',{shop_id:'3000'}));
 check(url('/api/orders',ordersQuery()));check(url('/api/offers',{shop_id:'2000',max:'1',offset:'10000',sku:'SKU /+% ą'}));
 for(const u of [url('/api/account',{}),url('/api/account',{shop_id:'4000'}),url().replace(origin,'https://unselected.mirakl.net'),
  url('/api/account/'),url('/api/%61ccount'),url('/api/orders/ORDER-1'),url('/api/shops'),url('/api/products'),
  url('/api/account',{shop_id:'2000',max:'1'}),url()+'&shop_id=2000',url()+'&_method=POST'])
  assert.throws(()=>check(u),policyCode('ROUTE'));
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD','get'])assert.throws(()=>check(url(),{method}));
 assert.throws(()=>check(url(),{body:'{}'}),policyCode('BODY'));
});

test('orders enforce bounded canonical page numbers and documented fixed query grammar',()=>{
 const scope=validateOrdinaryConnectorAccess(selected());
 const check=(q:Record<string,string>)=>validateOrdinaryConnectorRequest(new URL(url('/api/orders',q)),{headers},scope);
 for(const [key,value]of [['max','0'],['max','101'],['max','01'],['max','1.0'],['max','1e1'],['offset','-1'],['offset','10001'],['offset','00'],['offset','+1'],
  ['order_tax_mode','TAX_EXCLUDED'],['sort','lastUpdated'],['order','desc'],['start_update_date','2026-02-30T00:00:00Z'],
  ['start_update_date','2026-10-01'],['end_update_date',window.start_update_date],['end_update_date','2026-12-01T00:00:00Z']])
  assert.throws(()=>check({...ordersQuery(),[key!]:value!}),policyCode('ROUTE'));
 for(const key of Object.keys(ordersQuery())){const q=ordersQuery() as Record<string,string>;delete q[key];assert.throws(()=>check(q),policyCode('ROUTE'));}
 assert.throws(()=>check({...ordersQuery(),cursor:'foreign'}),policyCode('ROUTE'));
 check({...ordersQuery(),max:'1',offset:'10000',start_update_date:'2026-10-01T02:00:00+02:00',end_update_date:'2026-11-01T00:00:00Z'});
});

test('offers enforce explicit page grammar and bounded optional SKU without arbitrary filters',()=>{
 const scope=validateOrdinaryConnectorAccess(selected()),query={shop_id:'2000',max:'50',offset:'0'};
 const check=(q:Record<string,string>)=>validateOrdinaryConnectorRequest(new URL(url('/api/offers',q)),{headers},scope);
 const invalid:Record<string,string>[]=[{...query,sku:''},{...query,sku:'x'.repeat(161)},{...query,sku:'x\ny'},{...query,offset:'10001'},
  {...query,max:'101'},{...query,order:'asc'},{...query,shop_id:'02000'},{shop_id:'2000',max:'50'},{shop_id:'2000',offset:'0'}];
 for(const q of invalid)
  assert.throws(()=>check(q),policyCode('ROUTE'));
 check({...query,sku:'x'.repeat(160)});
});

test('raw API key and exact JSON accept only; arbitrary headers and body refused before DNS',async()=>{
 const m=model(),transport=createOrdinaryConnectorTransport(selected(),m.deps);
 const invalid:Record<string,string>[]=[{Accept:'application/json'},{...headers,Authorization:'Bearer '+secret},{...headers,Authorization:'Basic abc'},
  {...headers,Authorization:''},{...headers,Authorization:'x'.repeat(4097)},{...headers,Accept:'*/*'},
  {Authorization:secret},{...headers,'Content-Type':'application/json'},{...headers,Cookie:'private'},
  {...headers,'User-Agent':'unexpected'},{...headers,'X-HTTP-Method-Override':'PUT'},{...headers,Host:'private'}];
 for(const h of invalid)
  await assert.rejects(transport(url(),{headers:h}),transportCode('HEADERS'));
 await assert.rejects(transport(url(),{headers,body:'{}'}),transportCode('BODY'));
 assert.equal(m.dns(),0);assert.equal(m.seen.length,0);
});

test('actual Mirakl client A01/OR11/OF21 requests pass shared pinned TLS transport with raw key and no body',async()=>{
 const m=model(),transport=createOrdinaryConnectorTransport(selected(),m.deps);
 const client=new Mirakl({instance_url:origin,shop_id:'2000',currency:'PLN'},{api_key:secret},transport);
 assert.equal(m.seen.length,0);await client.account();await client.ordersPage({window,max:100},0);await client.offers({max:1,sku:'SKU /+% ą'});
 assert.deepEqual(m.seen.map(o=>new URL(o.path! as string,origin).pathname),['/api/account','/api/orders','/api/offers']);
 for(const options of m.seen){assert.equal(options.method,'GET');assert.equal(options.hostname,'8.8.8.8');assert.equal(options.servername,'selected-instance.mirakl.net');assert.equal(options.rejectUnauthorized,true);assert.equal((options.headers as Record<string,string>).authorization,secret);assert.equal(new URL(options.path! as string,origin).searchParams.get('shop_id'),'2000');}
 assert.deepEqual(m.sent,[undefined,undefined,undefined]);
});

test('private DNS, TLS mismatch, redirects and credential-looking network errors retain existing fail-closed protections',async()=>{
 const privateModel=model();await assert.rejects(createOrdinaryConnectorTransport(selected(),{...privateModel.deps,resolve:async()=>[{address:'127.0.0.1',family:4}]})(url(),{headers}),transportCode('ADDRESS'));assert.equal(privateModel.seen.length,0);
 for(const [input,code]of [[{authorized:false},'TLS'],[{peer:'127.0.0.1'},'PEER'],[{status:302},'REDIRECT'],[{networkError:true},'NETWORK']] as const){
  const m=model(input);await assert.rejects(createOrdinaryConnectorTransport(selected(),m.deps)(url(),{headers}),transportCode(code));
  if(code==='TLS'||code==='PEER')assert.equal(m.sent.length,0);else assert.equal(m.sent.length,1);
 }
});

test('exact selected instance owns routing once; failure, foreign shop and writes never fall through',async()=>{
 let dns=0,fallback=0;
 const connector=createOrdinaryConnectorTransport(selected(),{resolve:async()=>{dns++;throw Error(secret);}});
 assert.deepEqual(ordinaryConnectorOrigins(connector),[origin]);assert.deepEqual(inspectOrdinaryConnectorTransport(connector),selected());
 const route=bindOrdinaryConnectorTransport(async()=>{fallback++;return new Response('local');},connector)!;
 await assert.rejects(route(url(),{headers}),transportCode('DNS'));
 await assert.rejects(route(url('/api/account',{shop_id:'999'}),{headers}),transportCode('ROUTE'));
 await assert.rejects(route(url(),{headers,method:'POST'}),transportCode('ROUTE'));
 assert.equal(dns,1);assert.equal(fallback,0);
 assert.throws(()=>assertOrdinaryConnectorJobExecution({mode:'sandbox_manual_once'},connector,false,true),/sandbox-capability-required/);
 const other=bindOrdinaryConnectorTransport(undefined,connector)!;
 assert.throws(()=>other('https://unselected.mirakl.net/api/account?shop_id=2000',{headers}),transportCode('ROUTE'));
});
