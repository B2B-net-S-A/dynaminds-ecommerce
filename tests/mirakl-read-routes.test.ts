/** Controlled Fastify injection: no DB, factory, actual account or acceptance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createHash} from 'node:crypto';
import {registerMiraklReadRoutes,type MiraklReadRoutesPort} from '../server/mirakl-read-routes';
import {Problem} from '../server/errors';
import {miraklChannelConnectionHash} from '../server/mirakl-channel';
import type {MiraklAccountCache,MiraklReadRepository} from '../server/mirakl-channel';
const tenant='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002',id='00000000-0000-4000-8000-000000000003';
const secret='PRIVATE_MIRAKL_NOT_IN_OUTPUT',token='CONTROLLED_SESSION_COOKIE';
const settings={instance_url:'https://route-controlled.mirakl.net',shop_id:'2000',currency:'PLN'};
const account={shop_id:2000,shop_name:'Controlled shop',currency_iso_code:'PLN',shop_state:'OPEN',model:'MARKETPLACE'};
const offer={offer_id:101,shop_sku:'SKU',product_sku:'P',product_title:'Controlled',currency_iso_code:'PLN',price:1,quantity:2,active:true,state_code:'11'};
const window={start_update_date:'2026-10-01T00:00:00Z',end_update_date:'2026-10-02T00:00:00Z'};
const route=(name:string,q:Record<string,string>={})=>`/api/integrations/${id}/mirakl/${name}`+(Object.keys(q).length?'?'+new URLSearchParams(q):'');
function fixture(patch:Partial<MiraklReadRoutesPort>={},context:Record<string,unknown>={}){
 const app=Fastify({logger:false});let guards=0,decrypts=0,revoked=false,missing=false;
 const calls:URL[]=[],claims:string[]=[],cache=new Map<string,MiraklAccountCache>();
 const channel={id,tenant_id:tenant,provider:'mirakl',mode:'live',settings:{...settings},credentials:'encrypted-generation-a'};
 let onReserve:()=>void=()=>{},onHttp:(path:string)=>void=()=>{};
 let orders:unknown[]=[],ordersTotal=0,offers:unknown[]=[offer],offersTotal=1;
 const repo:MiraklReadRepository={async readAccount(k){return cache.get(k)??null;},
  async reserveRead(q){claims.push(q.operation);onReserve();return{claimId:'controlled-'+claims.length};},
  async storeAccount({entry}){cache.set(entry.accountKey,structuredClone(entry));},async deferRead(){}};
 app.addHook('onRequest',async req=>{Object.assign(req,{actor:{tenantId:tenant,userId:user,role:'admin',source:'manual'},
  currentUser:{id:user,tenant_id:tenant,role:'admin'},cookies:{session:token},...context});});
 app.setErrorHandler((error,req,reply)=>{const e=error as Problem;reply.code(e instanceof Problem?e.status:500).send({error:e.message,code:e.code});});
 const port:MiraklReadRoutesPort={sessionName:'session',readOnly:false,externalReadsEnabled:true,repository:repo,
  async currentChannel(actor,channelId){guards++;assert.deepEqual(actor,{tenantId:tenant,userId:user,
   sessionHash:createHash('sha256').update(token).digest('hex')});assert.equal(channelId,id);
   if(revoked)throw new Problem(403,'Current session revoked');return missing?null:structuredClone(channel);},
  decryptCredentials(ciphertext){decrypts++;assert.equal(ciphertext,channel.credentials);return{api_key:secret};},
  transport:async(url,init)=>{calls.push(new URL(url));assert.equal((init.headers as Record<string,string>).Authorization,secret);
   const p=new URL(url).pathname;onHttp(p);return new Response(JSON.stringify(p==='/api/account'?account
    :p==='/api/orders'?{orders,total_count:ordersTotal}:{offers,total_count:offersTotal}),{headers:{'content-type':'application/json'}});},...patch};
 const controller=registerMiraklReadRoutes(app,port);
 app.post('/legacy/:id',req=>controller.readAccount(req));
 return {app,channel,repo,port,calls,claims,cache,get guards(){return guards;},get decrypts(){return decrypts;},
  setRevoked:()=>{revoked=true;},setMissing:()=>{missing=true;},reserveHook:(f:()=>void)=>{onReserve=f;},httpHook:(f:(path:string)=>void)=>{onHttp=f;},setOrders:(rows:unknown[],total=rows.length)=>{orders=structuredClone(rows);ordersTotal=total;},setOffers:(rows:unknown[],total=rows.length)=>{offers=structuredClone(rows);offersTotal=total;}};
}

test('actual Fastify GET account/orders/offers use the durable reader and return explicit limited status without writes',async()=>{
 const h=fixture();try{assert.equal(h.calls.length,0);
  for(const url of [route('account'),route('orders-preview',window),route('offers-preview',{max:'1',sku:'SKU /ą'})]){
   const r=await h.app.inject({url});assert.equal(r.statusCode,200,r.body);const b=r.json();
   assert.equal(b.channel_id,id);assert.equal(b.read_only,true);assert.equal(b.account_verified,false);
   assert.equal(b.provider_acceptance,false);assert.equal(b.stages_orders,false);assert.equal(b.imports_orders,false);
   assert.equal(b.status,'CODE_NOT_CONNECTED_NOT_ACCOUNT_ACCEPTED');
   assert(!r.body.includes(secret)&&!r.body.includes(token)&&!r.body.includes('sessionHash')&&!r.body.includes('encrypted-generation'));
  }
  assert.deepEqual(h.calls.map(u=>u.pathname),['/api/account','/api/orders','/api/offers']);
  assert.deepEqual(h.claims,['A01','OR11','OF21']);assert(h.guards>=12);
  const u=h.calls[1];assert.equal(u.searchParams.get('shop_id'),'2000');assert.equal(u.searchParams.get('offset'),'0');assert.equal(u.searchParams.get('max'),'50');
  assert.equal(h.calls[2].searchParams.get('sku'),'SKU /ą');
 }finally{await h.app.close();}
});

test('bounded strict URL input rejects unknown/duplicate/invalid windows, page numbers, foreign IDs and SKU before repository or HTTP',async()=>{
 const h=fixture();try{
  const bad=[route('account',{shop_id:'999'}),route('orders-preview'),route('orders-preview',{...window,max:'101'}),
   route('orders-preview',{...window,offset:'10001'}),route('orders-preview',{...window,offset:'01'}),
   route('orders-preview',{...window,end_update_date:'2026-12-01T00:00:00Z'}),
   route('orders-preview',{...window,start_update_date:'2026-02-30T00:00:00Z'}),
   route('orders-preview',{...window,actor_id:user}),route('offers-preview',{max:'0'}),route('offers-preview',{sku:''}),
   ...['-1','10001','01','1.5'].map(offset=>route('offers-preview',{offset})),route('offers-preview',{connection_hash:'foreign'}),route('offers-preview',{sku:'x\ny'}),route('offers-preview',{max:'1'})+'&max=2',
   route('account').replace(id,'not-a-uuid')];
  for(const url of bad){const r=await h.app.inject({url});assert.equal(r.statusCode,422,url+' '+r.body);}
  assert.equal(h.guards,0);assert.equal(h.calls.length,0);assert.equal(h.decrypts,0);
  assert.equal((await h.app.inject({method:'POST',url:route('orders-preview',window)})).statusCode,404);
 }finally{await h.app.close();}
});

test('OF21 ordinary API reads the requested page beyond100 with bounded offset and no automatic continuation',async()=>{
 const h=fixture();try{
  h.setOffers([{...offer,offer_id:202}],102);
  const r=await h.app.inject({url:route('offers-preview',{offset:'100',max:'1',sku:'SKU /ą'})});assert.equal(r.statusCode,200,r.body);
  const b=r.json();assert.equal(b.result.offset,100);assert.equal(b.result.data[0].offer_id,202);assert.equal(b.result.has_more,true);
  assert.equal(b.provider_acceptance,false);assert.equal(b.read_only,true);assert.equal(b.imports_orders,false);
  assert.deepEqual(h.claims,['A01','OF21']);assert.equal(h.calls.length,2);assert.equal(h.calls[1].searchParams.get('offset'),'100');assert.equal(h.calls[1].searchParams.get('shop_id'),'2000');assert.equal(h.calls[1].searchParams.get('sku'),'SKU /ą');
  const count=h.calls.length;const invalid=await h.app.inject({url:route('offers-preview',{offset:'1'})+'&offset=2'});assert.equal(invalid.statusCode,422);assert.equal(h.calls.length,count);
 }finally{await h.app.close();}
});

test('OF21 late-page response is withheld after current IAM or connection generation changes',async()=>{
 for(const mode of ['revoked','changed'] as const){const h=fixture();try{
  h.setOffers([offer],101);h.httpHook(p=>{if(p==='/api/offers'){if(mode==='revoked')h.setRevoked();else h.channel.credentials='encrypted-generation-b';}});
  const r=await h.app.inject({url:route('offers-preview',{offset:'100',max:'1'})});assert.equal(r.statusCode,mode==='revoked'?403:409,r.body);
  assert(!r.body.includes('Controlled'));assert.deepEqual(h.claims,['A01','OF21']);assert.equal(h.calls.length,2);
 }finally{await h.app.close();}}
});

test('OF21 page continuation carries the observed generation and refuses a reconfigured channel before provider HTTP',async()=>{
 const h=fixture();try{
  h.setOffers([offer],102);const first=await h.app.inject({url:route('offers-preview',{max:'1'})});assert.equal(first.statusCode,200);
  const generation=first.json().connection_hash;assert.equal(generation,miraklChannelConnectionHash(h.channel));
  const next=await h.app.inject({url:route('offers-preview',{offset:'100',max:'1',connection_hash:generation})});assert.equal(next.statusCode,200);assert.equal(next.json().connection_hash,generation);
  const count=h.calls.length,claimCount=h.claims.length;h.channel.credentials='encrypted-generation-b';
  const stale=await h.app.inject({url:route('offers-preview',{offset:'101',max:'1',connection_hash:generation})});assert.equal(stale.statusCode,409);
  assert.equal(h.calls.length,count);assert.equal(h.claims.length,claimCount);assert(!stale.body.includes('Controlled'));
 }finally{await h.app.close();}
});

test('standalone routes require matching actual manual admin session; forged actor/query context cannot authorize',async()=>{
 for(const context of [{actor:{tenantId:tenant,userId:user,role:'viewer'}},{currentUser:{id:user,tenant_id:tenant,role:'operator'}},
  {currentUser:{id:user,tenant_id:'00000000-0000-4000-8000-000000000099',role:'admin'}},{cookies:{}},
  {actor:{tenantId:tenant,userId:user,role:'admin',apiKeyId:'key'}},{apiScopes:[]},
  {actor:{tenantId:tenant,userId:user,role:'admin',source:'api'}},{currentUser:{id:user,tenant_id:tenant,role:'admin',api_key_id:'key'}}]){
  const h=fixture({},context);try{const r=await h.app.inject({url:route('account')});assert.equal(r.statusCode,403,r.body);
   assert.equal(h.guards,0);assert.equal(h.calls.length,0);}finally{await h.app.close();}
 }
 const h=fixture();try{const r=await h.app.inject({url:route('account'),headers:{authorization:'Bearer '+token}});assert.equal(r.statusCode,403);assert.equal(h.guards,0);}finally{await h.app.close();}
});

test('read-only restore, disabled external access and missing durable dependencies stop before channel/decryption/network',async()=>{
 for(const [patch,status]of [[{readOnly:true},423],[{externalReadsEnabled:false},503],[{repository:undefined},503],[{transport:undefined},503]] as const){
  const h=fixture(patch);try{const r=await h.app.inject({url:route('account')});assert.equal(r.statusCode,status,r.body);
   assert.equal(h.guards,0);assert.equal(h.calls.length,0);assert.equal(h.decrypts,0);}finally{await h.app.close();}
 }
});

test('current IAM and exact channel tenant/provider remain authoritative before every read',async()=>{
 for(const mutate of [(h:ReturnType<typeof fixture>)=>h.setRevoked(),(h:ReturnType<typeof fixture>)=>h.setMissing(),
  (h:ReturnType<typeof fixture>)=>{h.channel.tenant_id='foreign';},(h:ReturnType<typeof fixture>)=>{h.channel.id='foreign';},
  (h:ReturnType<typeof fixture>)=>{h.channel.provider='shopify';}]){
  const h=fixture();try{mutate(h);const r=await h.app.inject({url:route('account')});assert([403,404].includes(r.statusCode),r.body);
   assert.equal(h.calls.length,0);assert.equal(h.decrypts,0);}finally{await h.app.close();}
 }
});

test('configuration generation recheck blocks HTTP after reservation and rejects results after remote response',async()=>{
 const first=fixture();try{first.reserveHook(()=>{first.channel.credentials='encrypted-generation-b';});
  const r=await first.app.inject({url:route('account')});assert.equal(r.statusCode,409,r.body);assert.equal(first.calls.length,0);
  assert.equal(first.claims.length,1);assert.equal(first.cache.size,0);
 }finally{await first.app.close();}
 const second=fixture();try{second.httpHook(()=>{second.channel.settings.shop_id='2001';});
  const r=await second.app.inject({url:route('account')});assert.equal(r.statusCode,409,r.body);assert.equal(second.calls.length,1);
  assert.equal(second.cache.size,0);assert(!r.body.includes('Controlled shop'));
 }finally{await second.app.close();}
});

test('revocation after HTTP prevents cache write and data release; provider cooldown is exposed without replay',async()=>{
 const h=fixture();try{h.httpHook(()=>h.setRevoked());const r=await h.app.inject({url:route('account')});
  assert.equal(r.statusCode,403,r.body);assert.equal(h.cache.size,0);assert(!r.body.includes('Controlled shop'));
 }finally{await h.app.close();}
 const retry=fixture({transport:async()=>new Response('{}',{status:429,headers:{'retry-after':'123'}})});
 try{const r=await retry.app.inject({url:route('account')});assert.equal(r.statusCode,429,r.body);assert.equal(r.json().code,'MIRAKL_READ_DEFERRED');assert.equal(retry.claims.length,1);}
 finally{await retry.app.close();}
});

test('legacy test controller reuses the same bounded account authority without injection recursion or account acceptance',async()=>{
 const h=fixture();try{const r=await h.app.inject({method:'POST',url:'/legacy/'+id});assert.equal(r.statusCode,200,r.body);
  assert.equal(r.json().provider_acceptance,false);assert.equal(h.calls.length,1);assert(h.guards>=4);
  const extra=await h.app.inject({method:'POST',url:'/legacy/'+id+'?actor_id='+user});assert.equal(extra.statusCode,422);
 }finally{await h.app.close();}
});


const stagedInbound='00000000-0000-4000-8000-000000000004';
const sourceOrder=()=>({order_id:'SOURCE-ORDER-1',currency_iso_code:'PLN',order_state:'SHIPPING',
 last_updated_date:'2026-10-01T12:00:00Z',order_tax_mode:'TAX_INCLUDED',
 customer:{firstname:'Jan',lastname:'Kontrolowany',shipping_address:{street_1:'Kontrolowana 1',city:'Warszawa',zip_code:'00-001',country_iso_code:'POL'}},
 customer_directly_pays_seller:false,payment_workflow:'PAY_ON_ACCEPTANCE',customer_debited_date:'2026-10-01T11:00:00Z',
 fully_refunded:false,has_incident:false,price:20.1,shipping_price:4.9,total_price:25,
 order_lines:[{order_line_id:'SOURCE-LINE-1',offer_id:101,offer_sku:'SKU',product_title:'Controlled',quantity:2,
 price:20.1,shipping_price:4.9,total_price:25,order_line_state:'SHIPPING',cancelations:[],refunds:[],fees:[]}]});
const stageBody={...window,max:1,offset:2};
const stagedResult=()=>({data:[{id:stagedInbound,state:'staged',source_hash:'a'.repeat(64)}]});

test('trusted stage POST reads the real controlled OR11 projection before exactly one injected stage call and explicit limited envelope',async()=>{
 let stageCalls=0;
 const h=fixture({async stageOrders(actor,channelId,connectionHash,rows){stageCalls++;
  assert.deepEqual(actor,{tenantId:tenant,userId:user,sessionHash:createHash('sha256').update(token).digest('hex')});
  assert.equal(channelId,id);assert.equal(connectionHash,miraklChannelConnectionHash(h.channel));
  assert.deepEqual(rows,[{...sourceOrder(),id:'SOURCE-ORDER-1'}]);
  assert.deepEqual(h.calls.map(u=>u.pathname),['/api/account','/api/orders']);
  return stagedResult();
 }});
 h.setOrders([sourceOrder()],4);
 try{
  assert.equal(stageCalls,0);assert.equal(h.calls.length,0);
  const r=await h.app.inject({method:'POST',url:route('orders-stage'),payload:stageBody});assert.equal(r.statusCode,200,r.body);
  assert.deepEqual(r.json(),{channel_id:id,scope:'external_read_local_stage',stages_orders:true,imports_orders:false,
   account_verified:false,provider_acceptance:false,offset:2,total_count:4,has_more:true,...stagedResult()});
  assert.equal(stageCalls,1);assert.deepEqual(h.claims,['A01','OR11']);
  const query=h.calls[1].searchParams;assert.equal(query.get('max'),'1');assert.equal(query.get('offset'),'2');
  assert.equal(query.get('shop_id'),'2000');assert.equal(query.get('order_tax_mode'),'TAX_INCLUDED');
  assert.equal(query.get('start_update_date'),window.start_update_date);assert.equal(query.get('end_update_date'),window.end_update_date);
  assert(!r.body.includes(secret)&&!r.body.includes(token)&&!r.body.includes('SOURCE-ORDER-1')&&!r.body.includes('sessionHash'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stageCalls,1);assert.equal(h.calls.length,2,'has_more does not launch the next page');
 }finally{await h.app.close();}
});

test('stage rejects arbitrary raw/source/actor/connection fields, query pollution, malformed numbers and unbounded windows before any authority or provider access',async()=>{
 let stageCalls=0;const h=fixture({async stageOrders(){stageCalls++;return stagedResult();}});
 try{
  const bodies=[{...stageBody,data:[sourceOrder()]},{...stageBody,raw:sourceOrder()},{...stageBody,actor:{tenantId:tenant,userId:user}},
   {...stageBody,connectionHash:'a'.repeat(64)},{...stageBody,channel_id:id},{...stageBody,max:'1'},{...stageBody,offset:'2'},
   {...stageBody,max:0},{...stageBody,max:101},{...stageBody,max:1.5},{...stageBody,offset:-1},{...stageBody,offset:10001},
   {...stageBody,start_update_date:'2026-02-30T00:00:00Z'},{...stageBody,end_update_date:window.start_update_date},
   {...stageBody,end_update_date:'2026-12-01T00:00:00Z'},{}];
  for(const payload of bodies){const r=await h.app.inject({method:'POST',url:route('orders-stage'),payload});assert.equal(r.statusCode,422,r.body);}
  const query=await h.app.inject({method:'POST',url:route('orders-stage',{actor_id:user}),payload:stageBody});assert.equal(query.statusCode,422,query.body);
  assert.equal(stageCalls,0);assert.equal(h.guards,0);assert.equal(h.decrypts,0);assert.equal(h.calls.length,0);assert.equal(h.claims.length,0);
 }finally{await h.app.close();}
});

test('stage rejects disabled/missing port and actual non-admin/read-only session before providers or local admission',async()=>{
 for(const [patch,status]of [[{},503],[{readOnly:true},423],[{externalReadsEnabled:false},503],[{repository:undefined},503],[{transport:undefined},503]] as const){
  let stageCalls=0;const h=fixture({...('readOnly' in patch||'externalReadsEnabled' in patch||'repository' in patch||'transport' in patch?{async stageOrders(){stageCalls++;return stagedResult();}}:{}),...patch});
  try{const r=await h.app.inject({method:'POST',url:route('orders-stage'),payload:stageBody});assert.equal(r.statusCode,status,r.body);assert.equal(h.guards,0);assert.equal(stageCalls,0);assert.equal(h.calls.length,0);}finally{await h.app.close();}
 }
 let stageCalls=0;const h=fixture({async stageOrders(){stageCalls++;return stagedResult();}},{currentUser:{id:user,tenant_id:tenant,role:'viewer'}});
 try{const r=await h.app.inject({method:'POST',url:route('orders-stage'),payload:stageBody});assert.equal(r.statusCode,403,r.body);assert.equal(stageCalls,0);assert.equal(h.calls.length,0);}finally{await h.app.close();}
});

test('revoked IAM and connection generation changed after actual OR11 response prevent stage callback entirely',async()=>{
 for(const change of ['revoke','credentials','settings'] as const){
  let stageCalls=0;const h=fixture({async stageOrders(){stageCalls++;return stagedResult();}});h.setOrders([sourceOrder()],4);
  h.httpHook(p=>{if(p!=='/api/orders')return;if(change==='revoke')h.setRevoked();else if(change==='credentials')h.channel.credentials='encrypted-generation-b';else h.channel.settings.shop_id='2001';});
  try{const r=await h.app.inject({method:'POST',url:route('orders-stage'),payload:stageBody});assert.equal(r.statusCode,change==='revoke'?403:409,r.body);assert.equal(stageCalls,0);assert.equal(h.calls.length,2);assert(!r.body.includes('SOURCE-ORDER-1'));}finally{await h.app.close();}
 }
});

test('callback refusal, unknown acknowledgement and post-stage revocation never fabricate success or automatically repeat provider/staging work',async()=>{
 for(const outcome of ['callback_failure','ack_lost','revoked_after_stage'] as const){
  let stageCalls=0;const h=fixture({async stageOrders(){stageCalls++;if(outcome==='callback_failure')throw new Problem(503,'Controlled unknown staging outcome');if(outcome==='revoked_after_stage')h.setRevoked();return stagedResult();}});h.setOrders([sourceOrder()],4);
  if(outcome==='ack_lost')h.app.addHook('onSend',async(_req,reply,payload)=>{if(reply.statusCode===200)throw new Problem(503,'Controlled ACK lost after staging');return payload;});
  try{const r=await h.app.inject({method:'POST',url:route('orders-stage'),payload:stageBody});assert.equal(r.statusCode,outcome==='revoked_after_stage'?403:503,r.body);
   assert.equal(stageCalls,1);assert.equal(h.calls.length,2);assert.equal(r.json().stages_orders,undefined);assert.equal(r.json().provider_acceptance,undefined);assert(!r.body.includes(stagedInbound));
   await new Promise(resolve=>setImmediate(resolve));assert.equal(stageCalls,1);assert.equal(h.calls.length,2);
  }finally{await h.app.close();}
 }
});

test('empty valid window stages an empty page once and numeric defaults match the first-page contract',async()=>{
 let stageCalls=0;const h=fixture({async stageOrders(_actor,_id,_hash,rows){stageCalls++;assert.deepEqual(rows,[]);return{data:[]};}});
 try{const r=await h.app.inject({method:'POST',url:route('orders-stage'),payload:window});assert.equal(r.statusCode,200,r.body);
  assert.deepEqual(r.json(),{channel_id:id,scope:'external_read_local_stage',stages_orders:true,imports_orders:false,account_verified:false,provider_acceptance:false,offset:0,total_count:0,has_more:false,data:[]});
  assert.equal(h.calls[1].searchParams.get('offset'),'0');assert.equal(h.calls[1].searchParams.get('max'),'50');assert.equal(stageCalls,1);assert.equal(h.calls.length,2);
 }finally{await h.app.close();}
});

test('manual exact-ID readback uses own shop and current authority; missing/group scope never imports or claims provider acceptance',async()=>{
 let staged=0;const h=fixture({async stageOrders(){staged++;throw new Error('readback must not stage');}});
 h.setOrders([sourceOrder()]);try{
  const r=await h.app.inject({url:route('orders-readback',{order_ids:'SOURCE-ORDER-1,MISSING'})});assert.equal(r.statusCode,200,r.body);const b=r.json();
  assert.equal(b.scope,'external_read');assert.equal(b.provider_acceptance,false);assert.equal(b.stages_orders,false);assert.equal(b.imports_orders,false);assert.equal(staged,0);
  assert.deepEqual(b.result.group_missing_order_ids,['MISSING']);assert.equal(b.result.readback_complete,false);assert.equal(b.result.readback_scope,'single_group');
  assert.deepEqual(h.claims,['A01','OR11']);assert.equal(h.calls[1].searchParams.get('shop_id'),'2000');assert.equal(h.calls[1].searchParams.get('order_ids'),'SOURCE-ORDER-1,MISSING');
  assert(!h.calls[1].searchParams.has('start_update_date'));assert(!r.body.includes(secret)&&!r.body.includes(token));
 }finally{await h.app.close();}
 const groups=fixture();try{const ids=Array.from({length:100},(_,i)=>String(i+1));const r=await groups.app.inject({url:route('orders-readback',{order_ids:ids.join(','),group:'1'})});assert.equal(r.statusCode,200,r.body);
  assert.equal(r.json().result.group_count,3);assert.equal(r.json().result.group_index,1);assert.equal(r.json().result.next_group,2);assert.equal(r.json().result.readback_complete,false);
  assert.equal(groups.calls[1].searchParams.get('order_ids'),ids.slice(36,69).join(','));await new Promise(resolve=>setImmediate(resolve));assert.equal(groups.calls.length,2);
 }finally{await groups.app.close();}
});

test('exact-ID route rejects malformed/duplicate/polluted/local-limit input before authority and provides explicit local-limit code',async()=>{
 const h=fixture();try{
  for(const url of [route('orders-readback'),route('orders-readback',{order_ids:''}),route('orders-readback',{order_ids:'A,A'}),route('orders-readback',{order_ids:'A,,B'}),
   route('orders-readback',{order_ids:'A',group:'1'}),route('orders-readback',{order_ids:'A',group:'00'}),route('orders-readback',{order_ids:'A',max:'1'}),
   route('orders-readback',{order_ids:'A',shop_id:'OTHER'}),route('orders-readback',{order_ids:'A',...window}),route('orders-readback',{order_ids:'A'})+'&order_ids=B']){
   const r=await h.app.inject({url});assert.equal(r.statusCode,422,r.body);
  }
  const limit=await h.app.inject({url:route('orders-readback',{order_ids:'ą'.repeat(51)})});assert.equal(limit.statusCode,422);assert.equal(limit.json().code,'MIRAKL_EXACT_IDS_LOCAL_LIMIT');
  assert.equal(h.guards,0);assert.equal(h.decrypts,0);assert.equal(h.claims.length,0);assert.equal(h.calls.length,0);
  assert.equal((await h.app.inject({method:'POST',url:route('orders-readback',{order_ids:'A'}),payload:{}})).statusCode,404);
 }finally{await h.app.close();}
});

test('exact-ID route retains session/tenant/generation authority before and after its remote result',async()=>{
 const revoked=fixture();try{revoked.httpHook(p=>{if(p==='/api/orders')revoked.setRevoked();});const r=await revoked.app.inject({url:route('orders-readback',{order_ids:'A'})});assert.equal(r.statusCode,403);assert(!r.body.includes('group_missing_order_ids'));assert.equal(revoked.calls.length,2);}finally{await revoked.app.close();}
 const changed=fixture();try{assert.equal((await changed.app.inject({url:route('account')})).statusCode,200);changed.reserveHook(()=>{changed.channel.credentials='encrypted-generation-b';});const r=await changed.app.inject({url:route('orders-readback',{order_ids:'A'})});assert.equal(r.statusCode,409);assert.equal(changed.calls.length,1);}finally{await changed.app.close();}
 const foreign=fixture();try{foreign.channel.tenant_id='FOREIGN';const r=await foreign.app.inject({url:route('orders-readback',{order_ids:'A'})});assert.equal(r.statusCode,404);assert.equal(foreign.calls.length,0);}finally{await foreign.app.close();}
 for(const patch of [{readOnly:true},{externalReadsEnabled:false}]){const h=fixture(patch);try{const r=await h.app.inject({url:route('orders-readback',{order_ids:'A'})});assert.equal(r.statusCode,patch.readOnly?423:503);assert.equal(h.calls.length,0);}finally{await h.app.close();}}
});

test('exact-ID route refuses unrequested records instead of releasing or staging unrelated order data',async()=>{
 const h=fixture();h.setOrders([sourceOrder()]);try{const r=await h.app.inject({url:route('orders-readback',{order_ids:'DIFFERENT'})});assert.equal(r.statusCode,502,r.body);assert(!r.body.includes('SOURCE-ORDER-1'));assert.equal(h.calls.length,2);}finally{await h.app.close();}
});
