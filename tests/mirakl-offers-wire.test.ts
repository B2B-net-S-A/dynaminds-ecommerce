/** Actual Fastify/reader/client plus a test-only loopback HTTP receiver.
 * No PG, public network, credentials or provider/sandbox acceptance. The
 * explicit transport translates only this fixed synthetic Mirakl origin. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import Fastify from 'fastify';
import {registerMiraklReadRoutes} from '../server/mirakl-read-routes';
import type {MiraklReadRepository,MiraklAccountCache} from '../server/mirakl-channel';
import {Problem} from '../server/errors';

test('ordinary OF21 API sends exact explicit page requests over local HTTP with a shared cooldown and no replay',{timeout:15000},async()=>{
 const tenant='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002',channelId='00000000-0000-4000-8000-000000000003';
 const origin='https://wire-controlled.mirakl.net',secret='SYNTHETIC_KEY_LOCAL_TEST_ONLY';
 const seen:Array<{method:string;url:URL;authorization:string|undefined}>=[];
 const receiver=createServer((req,res)=>{
  const u=new URL(req.url!,'http://127.0.0.1');seen.push({method:req.method!,url:u,authorization:req.headers.authorization});
  res.setHeader('content-type','application/json');
  if(u.pathname==='/api/account')return res.end(JSON.stringify({shop_id:2000,shop_name:'Wire fixture',currency_iso_code:'PLN',shop_state:'OPEN',model:'MARKETPLACE'}));
  if(u.pathname!=='/api/offers'){res.statusCode=404;return res.end('{}');}
  const offset=Number(u.searchParams.get('offset'));
  if(offset===102){res.statusCode=429;res.setHeader('retry-after','61');return res.end('{"private":"not returned to UI"}');}
  res.end(JSON.stringify({offers:[{offer_id:101+offset,shop_sku:'SKU /ą',product_sku:'PRODUCT',product_title:'Local wire page',currency_iso_code:'PLN',price:12.34,quantity:3,active:true,state_code:'11'}],total_count:102}));
 });
 await new Promise<void>((yes,no)=>{receiver.once('error',no);receiver.listen(0,'127.0.0.1',yes);});
 const address=receiver.address();assert(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
 const app=Fastify({logger:false}),cache=new Map<string,MiraklAccountCache>(),budgets=new Map<string,number>(),claims:string[]=[];
 const repository:MiraklReadRepository={async readAccount(k){return cache.get(k)??null;},async storeAccount({entry}){cache.set(entry.accountKey,structuredClone(entry));},
  async reserveRead(q){claims.push(q.operation);const until=budgets.get(q.budgetKey)??0;if(until>q.now)return{retryAt:until};budgets.set(q.budgetKey,q.notBefore);return{claimId:'local-'+claims.length};},
  async deferRead(q){budgets.set(q.budgetKey,Math.max(budgets.get(q.budgetKey)??0,q.notBefore));}};
 app.addHook('onRequest',async req=>{Object.assign(req,{actor:{tenantId:tenant,userId:user,role:'admin',source:'manual'},currentUser:{id:user,tenant_id:tenant,role:'admin'},cookies:{session:'SYNTHETIC_SESSION'}});});
 app.setErrorHandler((e,_req,reply)=>{const p=e as Problem;reply.code(p instanceof Problem?p.status:500).send({error:p.message,code:p.code});});
 registerMiraklReadRoutes(app,{sessionName:'session',readOnly:false,externalReadsEnabled:true,repository,
  currentChannel:async(actor,id)=>{assert.equal(actor.tenantId,tenant);assert.equal(actor.userId,user);assert.equal(id,channelId);return{id:channelId,tenant_id:tenant,provider:'mirakl',mode:'sandbox',settings:{instance_url:origin,shop_id:'2000',currency:'PLN'},credentials:'synthetic-encrypted'};},
  decryptCredentials:()=>({api_key:secret}),transport:async(url,init)=>{
   const requested=new URL(url);assert.equal(requested.origin,origin);assert(['/api/account','/api/offers'].includes(requested.pathname));assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');
   const response=await fetch(new URL(requested.pathname+requested.search,base),init);
   // Reframe only the test receiver's response; production origin checks stay
   // intact and never permit a loopback Mirakl instance or redirected response.
   return new Response(response.body,{status:response.status,headers:response.headers});
  }});
 const url=(offset?:number)=>'/api/integrations/'+channelId+'/mirakl/offers-preview?max=1&sku='+encodeURIComponent('SKU /ą')+(offset===undefined?'':'&offset='+offset);
 try{
  for(const offset of [undefined,100,101]){
   const result=await app.inject({url:url(offset)});assert.equal(result.statusCode,200,result.body);const body=result.json();
   assert.equal(body.result.offset,offset??0);assert.equal(body.result.data[0].offer_id,101+(offset??0));assert.equal(body.result.has_more,(offset??0)<101);
   assert.equal(body.provider_acceptance,false);assert.equal(body.read_only,true);assert(!result.body.includes(secret));
  }
  assert.equal(seen.length,4,'one cached A01 plus exactly three manual OF21 pages');
  assert.deepEqual(seen.slice(1).map(r=>r.url.searchParams.get('offset')),['0','100','101']);
  for(const request of seen){assert.equal(request.method,'GET');assert.equal(request.authorization,secret);assert.equal(request.url.searchParams.get('shop_id'),'2000');}
  for(const request of seen.slice(1)){assert.equal(request.url.searchParams.get('sku'),'SKU /ą');assert.equal(request.url.searchParams.get('max'),'1');}
  const refused=await app.inject({url:url(10001)});assert.equal(refused.statusCode,422);assert.equal(seen.length,4);
  const limited=await app.inject({url:url(102)});assert.equal(limited.statusCode,429);assert.equal(seen.length,5);
  const deferred=await app.inject({url:url(0)});assert.equal(deferred.statusCode,429);assert.equal(seen.length,5,'durable repository cooldown blocks a subsequent view; transport never retries');
  assert.deepEqual(claims,['A01','OF21','OF21','OF21','OF21','OF21']);
 }finally{await app.close();receiver.closeAllConnections();await new Promise<void>((yes,no)=>receiver.close(e=>e?no(e):yes()));}
});
