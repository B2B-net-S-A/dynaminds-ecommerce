import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {Problem} from '../server/errors';
import {registerNbpRoutes} from '../server/nbp-routes';
import {prepareOrdinaryNbpRates,type OrdinaryNbpRatesConfiguration} from '../server/ordinary-provider-reads';
import {nbpLatestTableAReadPolicy,type NbpLatestRateInput} from '../server/nbp-exchange-rates';
const configuration:OrdinaryNbpRatesConfiguration={currencies:['EUR'],maxAgeDays:7};
function port(transport:NbpLatestRateInput['transport']){return prepareOrdinaryNbpRates(configuration,nbpLatestTableAReadPolicy('EUR'),transport,{readOnly:false,localWooFixture:false})!;}
const actor={tenantId:'TENANT1',userId:'USER1',role:'operator' as const};
async function fixture(selected:ReturnType<typeof port>|undefined,readOnly=false){
 const app=Fastify({logger:false});app.decorateRequest('actor');
 app.setErrorHandler((e,req,reply)=>reply.code(e instanceof Problem?e.status:500).send({code:e instanceof Problem?e.code:undefined,detail:e instanceof Error?e.message:'Unknown'}));
 app.addHook('onRequest',async req=>{if(req.headers['x-workspace-id']&&req.headers['x-workspace-id']!=='TENANT1')throw new Problem(409,'Workspace changed');if(req.headers.authorization==='fixture session')req.actor={...actor};else if(req.headers.authorization==='fixture api')req.actor={...actor,source:'api',apiKeyId:'KEY1'};});
 registerNbpRoutes(app,{readOnly,port:selected});await app.ready();return app;
}
const headers={authorization:'fixture session','x-workspace-id':'TENANT1'};
const body=()=>JSON.stringify({table:'A',currency:'euro',code:'EUR',rates:[{no:'199/A/NBP/'+new Date().getUTCFullYear(),effectiveDate:new Date().toISOString().slice(0,10),mid:4.3806}]}).replace('4.3806','4.38060000');
test('explicit opt-in consumes exact existing route only; default disabled is inert',()=>{
 assert.equal(prepareOrdinaryNbpRates(undefined,undefined,undefined,{readOnly:true,localWooFixture:true}),undefined);
 const transport=async()=>{throw Error('No network');};
 for(const ctx of [{readOnly:true,localWooFixture:false},{readOnly:false,localWooFixture:true}])assert.throws(()=>prepareOrdinaryNbpRates(configuration,nbpLatestTableAReadPolicy('EUR'),transport,ctx));
 for(const policy of [undefined,{routes:[{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/:code/',methods:['GET'] as const,queryKeys:['format']}]},{routes:[{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/eur',methods:['GET'] as const,queryKeys:['format']}]}])assert.throws(()=>prepareOrdinaryNbpRates(configuration,policy,transport,{readOnly:false,localWooFixture:false}));
 for(const c of [{currencies:['USD'],maxAgeDays:7},{currencies:['EUR'],maxAgeDays:32},{...configuration,other:true}])assert.throws(()=>prepareOrdinaryNbpRates(c,nbpLatestTableAReadPolicy('EUR'),transport,{readOnly:false,localWooFixture:false}));
});
test('normal route capabilities never dispatch; manual signed-in GET retains exact decimal DTO',async()=>{
 const calls:Array<{url:string;init:RequestInit}>=[],selected=port(async(url,init)=>{calls.push({url,init});return new Response(body(),{headers:{'content-type':'application/json'}});}),app=await fixture(selected);
 try{const caps=await app.inject({url:'/api/nbp',headers});assert.deepEqual(caps.json(),{available:true,read_only:false,currencies:['EUR'],max_age_days:7});assert.equal(calls.length,0);const r=await app.inject({url:'/api/nbp/rate?currency=EUR',headers});assert.equal(r.statusCode,200);assert.equal(r.json().source_decimal,'4.38060000');assert.equal(r.json().mid_scaled,'438060000');assert.equal(r.json().scale,8);assert.equal(calls.length,1);assert.equal(calls[0]!.url,'https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json');assert.equal(new Headers(calls[0]!.init.headers).has('Authorization'),false);assert.equal(new Headers(calls[0]!.init.headers).has('Cookie'),false);assert.equal(r.headers['cache-control'],'no-store');}finally{await app.close();}
});
test('unsigned/API-key/foreign-workspace/restore/invalid query and HEAD refuse without dispatch',async()=>{
 let calls=0;const selected=port(async()=>{calls++;throw Error('Never dispatch');});
 const app=await fixture(selected),ro=await fixture(selected,true),off=await fixture(undefined);
 try{
  for(const [h,status]of [[{},401],[{authorization:'fixture api'},403],[{...headers,'x-workspace-id':'TENANT2'},409]]as const)assert.equal((await app.inject({url:'/api/nbp/rate?currency=EUR',headers:h})).statusCode,status);
  for(const q of ['currency=USD','currency=eur','currency=EUR&maxAgeDays=31','currency=EUR&currency=EUR'])assert.equal((await app.inject({url:'/api/nbp/rate?'+q,headers})).statusCode,422);
  assert.equal((await app.inject({method:'HEAD',url:'/api/nbp/rate?currency=EUR',headers})).statusCode,404);
  assert.equal((await ro.inject({url:'/api/nbp/rate?currency=EUR',headers})).statusCode,423);
  assert.equal((await off.inject({url:'/api/nbp/rate?currency=EUR',headers})).statusCode,503);assert.equal(calls,0);
 }finally{await app.close();await ro.close();await off.close();}
});
test('upstream unavailable/limited/malformed errors are safe, single dispatch and never stale success',async()=>{
 for(const [status,want,code]of [[404,404,'NBP_NOT_AVAILABLE'],[429,429,'NBP_RATE_LIMITED'],[500,502,'NBP_HTTP'],[200,502,'NBP_RESPONSE_SCHEMA']]as const){let calls=0;const app=await fixture(port(async()=>{calls++;return new Response('secret token/private upstream',{status,headers:{'content-type':'application/json'}});}));try{const r=await app.inject({url:'/api/nbp/rate?currency=EUR',headers});assert.equal(r.statusCode,want);assert.equal(r.json().code,code);assert(!r.body.includes('secret'));assert.equal(calls,1);}finally{await app.close();}}
});
