import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import https from 'node:https';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import Fastify from 'fastify';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import {Problem,ensure} from '../server/errors';
import {collectShopifyCompetitorObservations as collect,normalizeShopifyVariant as normalize,
 collectAndImportShopifyObservations as importCollection,storefrontRoot,publicShopAddress,
 shopifyCompetitorSource,readPublicShopifyJson,type ShopifyPublicRead,type ObservationCollectorService} from '../server/competitor-shopify-collector';
type Service=ObservationCollectorService<Record<string,unknown>,{reused:boolean}>;
const source={product_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source_namespace:'shopify:competitors',
 shop_root:'https://competitor.example/en-pl/',handle:'red-coat',remote_product_id:'100',variant_id:'201',
 currency:'PLN' as const,delivery_gross_minor:'499',gross_prices_confirmed:true as const,fixed_delivery_confirmed:true as const};
const input={client_key:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',profile_version:3,sources:[source],local_observations_confirmed:true};
const product={id:100,handle:'red-coat',variants:[{id:201,price:10001,available:true},{id:202,price:199,available:false}]};
const stamp='2026-10-12T12:00:00.000000Z';
const result=(body:unknown,cookies:string[]=[])=>({body,bytes:Buffer.byteLength(JSON.stringify(body)),cookies});
const read:ShopifyPublicRead=async url=>result(url.pathname.endsWith('cart.js')?{currency:'PLN',token:'never-return-cart-token'}:product);
function service(overrides:Partial<Service>={}){
 const s={options:async()=>({available:true,can_write:true,read_only:false}),
  getProfile:async()=>({list:{active:true,currency:'PLN'},profile:{version:3,source_namespace:source.source_namespace,own_seller_id:'shopify:own.example'}}),
  importBatch:async(_r:unknown,_l:string,b:any)=>({id:'native-batch-id',reused:false,observations:b.observations}),...overrides};
 return s as unknown as Service;
}
const req={} as Parameters<Service['options']>[0];
test('selected variant maps exact price, product/variant and storefront seller; no unverified shipping inference',()=>{
 const row=normalize(source,product,'PLN',stamp);
 assert.deepEqual(row,{product_id:source.product_id,source_namespace:source.source_namespace,
  offer_id:'shopify:'+createHash('sha256').update('https://competitor.example').digest('hex')+':100:201',seller_id:'shopify:competitor.example',currency:'PLN',price_gross_minor:'10001',
  delivery_gross_minor:'499',available:true,observed_at:stamp});
 assert.equal(normalize({...source,variant_id:'202'},product,'PLN',stamp).available,false);
 assert.equal(normalize(source,{...product,variants:[{id:201,price:0,available:false}]},'PLN',stamp).price_gross_minor,'0');
 assert.notEqual(row.offer_id,normalize({...source,shop_root:'https://other.example/'},product,'PLN',stamp).offer_id);
});
test('no floating point conversion, rounded tax assumption, unsafe ID or variant substitution',()=>{
 for(const price of [1.1,-1,100000001,'10001',NaN])assert.throws(()=>normalize(source,{...product,variants:[{id:201,price,available:true}]},'PLN',stamp));
 assert.throws(()=>normalize(source,{...product,id:9007199254740992},'PLN',stamp));
 assert.throws(()=>normalize(source,{...product,id:999},'PLN',stamp));
 assert.throws(()=>normalize(source,{...product,handle:'other'},'PLN',stamp));
 assert.throws(()=>normalize(source,{...product,variants:[{id:202,price:1,available:true}]},'PLN',stamp));
 assert.throws(()=>normalize(source,{...product,variants:[product.variants[0],product.variants[0]]},'PLN',stamp));
 assert.throws(()=>normalize(source,{...product,variants:Array.from({length:251},(_,i)=>({id:i+1,price:1,available:true}))},'PLN',stamp));
 assert.throws(()=>normalize(source,product,'EUR',stamp));
 for(const currency of ['JPY','KWD'])assert.throws(()=>shopifyCompetitorSource.parse({...source,currency}));
 for(const flag of ['gross_prices_confirmed','fixed_delivery_confirmed'])assert.throws(()=>shopifyCompetitorSource.parse({...source,[flag]:false}));
});
test('strict locale root blocks arbitrary URLs, IPs, userinfo, query, fragments, encoded paths and insecure schemes',()=>{
 for(const url of ['http://shop.example/','https://127.0.0.1/','https://[::1]/','https://x:y@shop.example/',
  'https://shop.example/?url=http://127.0.0.1','https://shop.example/#secret','https://shop.example/api/',
  'https://shop.example/en/../admin/','https://shop.local/','https://shop.example/%2fen/','https://shop.example:123/'])assert.throws(()=>storefrontRoot(url));
 assert.equal(storefrontRoot(source.shop_root).pathname,'/en-pl/');
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','198.18.0.1',
  '192.0.2.1','198.51.100.1','203.0.113.1','::ffff:127.0.0.1','::1','fe80::1','fc00::1','2001:db8::1','2002::1'])assert.equal(publicShopAddress(address),false,address);
 for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicShopAddress(address),true,address);
});
test('same-origin anonymous session in RAM, three documented GET reads, no token/cookies/body or live-proof field returned',async()=>{
 const calls:{url:string;cookie:string}[]=[];
 const collected=await collect([source],async(u,cookie)=>{calls.push({url:u.toString(),cookie});
  return result(u.pathname.endsWith('cart.js')?{currency:'PLN',token:'private-cart-token'}:product,['anon=private-session; HttpOnly; Secure']);});
 assert.deepEqual(calls.map(c=>c.url),['https://competitor.example/en-pl/cart.js','https://competitor.example/en-pl/products/red-coat.js','https://competitor.example/en-pl/cart.js']);
 assert.equal(calls[0].cookie,'');assert.equal(calls[1].cookie,'anon=private-session');
 assert.equal(collected.requests,3);assert.equal(collected.origin,'public_shopify_ajax_with_configured_delivery');
 assert.match(collected.observations[0].observed_at,/\.\d{6}Z$/);
 for(const secret of ['private-cart-token','private-session','verified_read','provider_verified'])assert(!JSON.stringify(collected).includes(secret));
});
test('currency drift, malformed cookies/response length, unavailable/password/rate-limit read fail atomically and never retry',async()=>{
 let calls=0;
 await assert.rejects(collect([source],async u=>{calls++;return result(u.pathname.endsWith('cart.js')?{currency:calls===3?'EUR':'PLN'}:product);}),/Waluta sklepu zmieniła/);
 assert.equal(calls,3);
 for(const data of [{...result({currency:'PLN'}),bytes:1048577},result({currency:'PLN'},['auth=bad\r\nHeader: x'])])
  await assert.rejects(collect([source],async()=>data));
 for(const code of [429,403,404,502]){calls=0;await assert.rejects(collect([source],async()=>{calls++;throw new Problem(code,'refused');}));assert.equal(calls,1);}
});
test('source/currency/profile/own-seller and readonly/current IAM refusals occur before public network read',async()=>{
 let calls=0;const noRead:ShopifyPublicRead=async()=>{calls++;return result({});};
 const cases=[service({options:async()=>({read_only:true}) as any}),service({options:async()=>({available:true,can_write:false}) as any}),
  service({getProfile:async()=>({list:{active:true,currency:'EUR'},profile:{version:3,source_namespace:source.source_namespace}}) as any}),
  service({getProfile:async()=>({list:{active:true,currency:'PLN'},profile:{version:4,source_namespace:source.source_namespace}}) as any}),
  service({getProfile:async()=>({list:{active:true,currency:'PLN'},profile:{version:3,source_namespace:source.source_namespace,own_seller_id:'shopify:competitor.example'}}) as any})];
 for(const s of cases)await assert.rejects(importCollection(s,req,'list',input,noRead));assert.equal(calls,0);
});
test('existing service receives strict batch exactly once; role change after network and partial collection refuse',async()=>{
 let imports=0;let saved:any;
 const s=service({importBatch:async(_req,_id,b)=>{imports++;saved=b;return {reused:false} as any;}});
 await importCollection(s,req,'list',input,read);assert.equal(imports,1);assert.equal(saved.local_observations_confirmed,true);
 assert.equal(saved.profile_version,3);assert.equal(saved.client_key,input.client_key);assert.equal(saved.observations[0].price_gross_minor,'10001');
 await assert.rejects(importCollection(service({importBatch:async()=>{throw new Problem(403,'current role revoked');}}),req,'list',input,read),/current role revoked/);
 imports=0;await assert.rejects(importCollection(s,req,'list',{...input,sources:[source,{...source,variant_id:'999'}]},read));assert.equal(imports,0);
});
test('finite configured products replace pagination; duplicates and more than ten sources are refused before transport',async()=>{
 let calls=0;const counter:ShopifyPublicRead=async(...args)=>{calls++;return read(...args);};
 await assert.rejects(collect([source,source],counter));
 await assert.rejects(collect(Array.from({length:11},()=>source),counter));assert.equal(calls,0);
});
// Execute the ACTUAL family route module in Fastify. Only the native service
// constructor/provider transport are injected; do not import db.ts or mint IAM.
// These are HTTP wiring/source tests, not native account or live-provider proof.
function registeredApi(s:Service,readOnly=false,provider:ShopifyPublicRead=read){
 const code=transformSync(readFileSync(new URL('../server/competitor-observations-routes.ts',import.meta.url),'utf8'),
  {format:'cjs',loader:'ts',target:'es2022'}).code;
 const module:{exports:{registerCompetitorObservationRoutes?:(app:any,context:any)=>void}}={exports:{}};
 const modules:Record<string,unknown>={'zod':{z},'./errors':{ensure},
  './competitor-observations':{createCompetitorObservationService:()=>s},
  './competitor-shopify-collector':{collectAndImportShopifyObservations:(a:Service,b:Record<string,unknown>,c:string,d:unknown)=>importCollection(a,b,c,d,provider)}};
 new Function('module','require',code)(module,(key:string)=>{assert(Object.hasOwn(modules,key),'Unexpected runtime import');return modules[key];});
 const app=Fastify();app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof Problem?e.status:e instanceof z.ZodError?422:(e as {statusCode?:number}).statusCode??500).send({code:e instanceof Problem?e.code:null}));
 module.exports.registerCompetitorObservationRoutes!(app,{readOnly});return app;
}
const endpoint='/api/price-lists/cccccccc-cccc-4ccc-8ccc-cccccccccccc/competitor-observations/collect/shopify';
test('actual family endpoint normalizes and imports once; service reused flag controls HTTP201/200',async()=>{
 for(const reused of [false,true]){
  let imports=0;const app=registeredApi(service({importBatch:async(_req,_id,b:any)=>{imports++;assert.equal(b.observations[0].seller_id,'shopify:competitor.example');return {reused};}}));
  try{const r=await app.inject({method:'POST',url:endpoint,payload:input});assert.equal(r.statusCode,reused?200:201);
   assert.equal(imports,1);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.json().delivery_origin,'operator_configured');
  }finally{await app.close();}
 }
});
test('actual endpoint readonly is423 before malformed JSON; missing consent/unknown query/oversize never fetch or import',async()=>{
 let fetched=0,imports=0;const s=service({importBatch:async()=>{imports++;return {reused:false};}});
 const reader:ShopifyPublicRead=async(...args)=>{fetched++;return read(...args);};
 const ro=registeredApi(s,true,reader),app=registeredApi(s,false,reader);
 try{
  assert.equal((await ro.inject({method:'POST',url:endpoint,headers:{'content-type':'application/json'},payload:'broken'})).statusCode,423);
  for(const key of ['local_observations_confirmed','gross_prices_confirmed','fixed_delivery_confirmed']){
   const b=structuredClone(input) as any;if(key==='local_observations_confirmed')delete b[key];else delete b.sources[0][key];
   assert.equal((await app.inject({method:'POST',url:endpoint,payload:b})).statusCode,422);
  }
  assert.equal((await app.inject({method:'POST',url:endpoint+'?unknown=1',payload:input})).statusCode,422);
  assert.equal((await app.inject({method:'POST',url:endpoint,payload:{...input,extra:'x'.repeat(70000)}})).statusCode,413);
  assert.equal(fetched,0);assert.equal(imports,0);
 }finally{await ro.close();await app.close();}
});
test('actual endpoint delegates current IAM before read and at final import; transport429 never calls batch write',async()=>{
 let fetched=0,imports=0;const reader:ShopifyPublicRead=async(...args)=>{fetched++;return read(...args);};
 const viewer=registeredApi(service({options:async()=>({available:true,read_only:false,can_write:false})}),false,reader);
 const revoked=registeredApi(service({importBatch:async()=>{imports++;throw new Problem(403,'current authorization refused');}}),false,reader);
 const rate=registeredApi(service({importBatch:async()=>{imports++;return {reused:false};}}),false,async()=>{throw new Problem(429,'rate limited','SHOPIFY_RATE_LIMITED');});
 try{
  assert.equal((await viewer.inject({method:'POST',url:endpoint,payload:input})).statusCode,403);assert.equal(fetched,0);
  assert.equal((await revoked.inject({method:'POST',url:endpoint,payload:input})).statusCode,403);assert.equal(fetched,3);assert.equal(imports,1);
  const r=await rate.inject({method:'POST',url:endpoint,payload:input});assert.equal(r.statusCode,429);assert.equal(r.json().code,'SHOPIFY_RATE_LIMITED');assert.equal(imports,1);
 }finally{await viewer.close();await revoked.close();await rate.close();}
});
test('default transport refuses private/arbitrary URL before DNS; HTTP unauthorized/foreign context never performs public read',async()=>{
 for(const url of ['https://127.0.0.1/cart.js','https://shop.example/admin','https://user:secret@shop.example/cart.js','https://shop.example/cart.js?private=1'])
  await assert.rejects(readPublicShopifyJson(new URL(url),'',new AbortController().signal));
 let calls=0;const noRead:ShopifyPublicRead=async()=>{calls++;throw new Error('unexpected public read');};
 for(const status of [401,404]){const app=registeredApi(service({options:async()=>{throw new Problem(status,'not authorized');}}),false,noRead);
  try{assert.equal((await app.inject({method:'POST',url:endpoint,payload:input})).statusCode,status);}finally{await app.close();}}
 assert.equal(calls,0);
});
test('actual default transport pins validated DNS, disables pooled sockets and explicitly verifies TLS; body limits/status are enforced',async()=>{
 const originalLookup=dns.promises.lookup,originalRequest=https.request;
 let options:any,status=200,body='{"currency":"PLN"}',address='8.8.8.8',requests=0;
 try{
  dns.promises.lookup=(async()=>[{address,family:4}]) as any;
  https.request=((_url:URL,opts:any,callback:(res:any)=>void)=>{
   requests++;options=opts;const req=new EventEmitter() as EventEmitter&{end:()=>void};
   req.end=()=>callback(Object.assign(Readable.from([Buffer.from(body)]),{statusCode:status,headers:{'content-type':'application/json'}}));return req;
  }) as any;syncBuiltinESMExports();
  const r=await readPublicShopifyJson(new URL('https://shop.example/cart.js'),'',new AbortController().signal);
  assert.deepEqual(r.body,{currency:'PLN'});assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'shop.example');assert.equal(options.method,'GET');
  options.lookup('shop.example',{},(error:unknown,ip:string,family:number)=>{assert.equal(error,null);assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
  status=429;await assert.rejects(readPublicShopifyJson(new URL('https://shop.example/cart.js'),'',new AbortController().signal),(e:unknown)=>e instanceof Problem&&e.status===429&&e.code==='SHOPIFY_RATE_LIMITED');
  status=200;body='x'.repeat(1048577);await assert.rejects(readPublicShopifyJson(new URL('https://shop.example/cart.js'),'',new AbortController().signal),/przekracza limit/);
  body='broken';await assert.rejects(readPublicShopifyJson(new URL('https://shop.example/cart.js'),'',new AbortController().signal),/Nieprawidłowy JSON/);
  const before=requests;address='127.0.0.1';await assert.rejects(readPublicShopifyJson(new URL('https://shop.example/cart.js'),'',new AbortController().signal));assert.equal(requests,before);
 }finally{dns.promises.lookup=originalLookup;https.request=originalRequest;syncBuiltinESMExports();}
});
