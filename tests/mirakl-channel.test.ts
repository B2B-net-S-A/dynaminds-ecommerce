import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMiraklChannelReader, miraklChannelConnectionHash, parseMiraklSettings,
  parseMiraklCredentials, safeMiraklPublicSettings, MiraklReadDeferred,
  type MiraklReadRepository, type MiraklAccountCache} from '../server/mirakl-channel';
import {Problem} from '../server/errors';
import type {Transport} from '../server/integrations';

const secret = 'SECRET_PRIVATE_MIRAKL';
const settings = {instance_url:'https://controlled.mirakl.net',shop_id:'2000',currency:'PLN' as const};
const channel = {id:'channel-a',tenant_id:'tenant-a',provider:'mirakl',mode:'live',settings,credentials:'encrypted-generation-a'};
const account = {shop_id:2000,shop_name:'Controlled shop',currency_iso_code:'PLN',shop_state:'OPEN',model:'MARKETPLACE'};
const window = {start_update_date:'2026-10-01T00:00:00Z',end_update_date:'2026-10-02T00:00:00Z'};
const offer = {offer_id:101,shop_sku:'SKU',product_sku:'P',product_title:'Controlled',currency_iso_code:'PLN',price:1,quantity:1,active:true,state_code:'11'};
const json = (value:unknown,status=200,headers:Record<string,string>={}) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const redacted = (e:unknown) => e instanceof Problem && !JSON.stringify({message:e.message,code:e.code}).includes(secret);
function harness(response:(u:URL)=>Response = u => u.pathname === '/api/account' ? json(account)
  : u.pathname === '/api/orders' ? json({orders:[],total_count:0}) : json({offers:[offer],total_count:1})) {
  let time = Date.parse('2026-10-17T00:00:00Z'), guards = 0;
  const cache = new Map<string,MiraklAccountCache>(), budgets = new Map<string,number>();
  const claims:Parameters<MiraklReadRepository['reserveRead']>[0][] = [], requests:URL[] = [];
  const cooldowns:Parameters<MiraklReadRepository['deferRead']>[0][] = [];
  const repo:MiraklReadRepository = {
    async readAccount(key) {return structuredClone(cache.get(key) ?? null);},
    async reserveRead(value) {claims.push(value); const until=budgets.get(value.budgetKey) ?? 0;
      if (until > value.now) return {retryAt:until}; budgets.set(value.budgetKey,value.notBefore); return {claimId:'claim-'+claims.length};},
    async storeAccount({entry}) {cache.set(entry.accountKey,structuredClone(entry));},
    async deferRead(value) {cooldowns.push(value);budgets.set(value.budgetKey,Math.max(budgets.get(value.budgetKey)??0,value.notBefore));},
  };
  const transport:Transport = async u => {requests.push(new URL(u));return response(new URL(u));};
  const make = (changes:Partial<Parameters<typeof createMiraklChannelReader>[0]> = {}) => createMiraklChannelReader({channel,
    credentials:{api_key:secret},repository:repo,transport,guard:async()=>{guards++;},now:()=>time,...changes});
  return {make,repo,cache,budgets,claims,requests,cooldowns,get guards(){return guards;},advance:(n:number)=>{time+=n;}};
}

test('inert strict settings, public projection, generation and tenant/channel binding', () => {
  const h=harness(), r=h.make(); assert.equal(h.requests.length,0); assert.equal(h.claims.length,0);
  assert.equal(r.connectionHash,miraklChannelConnectionHash(channel)); assert.deepEqual(safeMiraklPublicSettings(settings),settings);
  assert.equal(JSON.stringify(r).includes(secret),false);
  for(const patch of [{id:'b'},{tenant_id:'b'},{credentials:'encrypted-b'},{mode:'sandbox'},
    {settings:{...settings,shop_id:'2001'}}]) assert.notEqual(miraklChannelConnectionHash({...channel,...patch}),r.connectionHash);
  assert.throws(()=>parseMiraklSettings({...settings,api_key:secret}),redacted);
  assert.throws(()=>parseMiraklCredentials({api_key:secret,token:'x'}),redacted);
  assert.throws(()=>h.make({repository:undefined as never}),redacted);
});

test('durable A01 cache survives new readers, revalidated own identity; every actual HTTP read reserves',async()=>{
  const h=harness(); await h.make().account(); await h.make().account(); await h.make().readOffers();
  assert.deepEqual(h.requests.map(u=>u.pathname),['/api/account','/api/offers']);
  assert.deepEqual(h.claims.map(c=>c.operation),['A01','OF21']);
  assert.equal(h.claims[0].notBefore-h.claims[0].now,86400000);
  assert.equal(h.cache.size,1); assert.ok(h.guards>=12);
  const entry=[...h.cache.values()][0]; entry.account.shop_id=2001;
  await assert.rejects(h.make().readOffers(),redacted); assert.equal(h.requests.length,2);
});

test('A01 cache expires across a long-lived reader and can never bypass the shared budget',async()=>{
  const h=harness(), r=h.make(); await r.account(); h.advance(86400000); await r.account();
  assert.equal(h.requests.length,2); assert.equal(h.claims.length,2);
  const entry=[...h.cache.values()][0]; entry.expiresAt=entry.observedAt+1;
  h.advance(2); await assert.rejects(r.account(),e=>e instanceof MiraklReadDeferred);
  assert.equal(h.requests.length,2);
});

test('global instance-operation keys ignore tenant/channel/account while cache identity binds private key',async()=>{
  const h=harness(); await h.make().account();
  await assert.rejects(h.make({channel:{...channel,id:'channel-b',tenant_id:'tenant-b',settings:{...settings,shop_id:'2001'}},
    credentials:{api_key:'ANOTHER_PRIVATE_KEY'}}).account(),e=>e instanceof MiraklReadDeferred);
  assert.equal(h.requests.length,1); assert.equal(h.claims[0].budgetKey,h.claims[1].budgetKey);
  assert.notEqual(h.claims[0].accountKey,h.claims[1].accountKey);
});

test('OR11 reserves all page reads, preserves window/offset and refuses malformed arguments before HTTP',async()=>{
  const h=harness(),r=h.make(); await r.account();
  const page=await r.readOrderPage({window,max:1,offset:0}); assert.deepEqual(page,{data:[],offset:0,total_count:0,has_more:false});
  assert.deepEqual(h.claims.map(c=>c.operation),['A01','OR11']);
  assert.equal(h.claims[1].notBefore-h.claims[1].now,900000);
  assert.equal(h.requests[1].searchParams.get('start_update_date'),window.start_update_date);
  await assert.rejects(r.readOrderPage({window,max:1,offset:0}),e=>e instanceof MiraklReadDeferred && e.seconds===900);
  const before=h.requests.length;
  for(const request of [{window,offset:-1},{window,offset:0,max:101},{window,offset:0,shop_id:'999'}])
    assert.throws(()=>r.readOrderPage(request as never),redacted);
  assert.equal(h.requests.length,before);
});

test('explicit OF21 pages each acquire the existing durable budget and keep offset/SKU across new readers',async()=>{
  const h=harness(u=>u.pathname==='/api/account'?json(account):json({offers:[{...offer,offer_id:101+Number(u.searchParams.get('offset'))}],total_count:102}));
  const page=await h.make().readOffers({max:1,offset:100,sku:'SKU /ą'});
  assert.equal(page.offset,100);assert.equal(page.data[0].offer_id,201);assert.equal(page.has_more,true);
  assert.equal(h.requests[1].searchParams.get('offset'),'100');assert.equal(h.requests[1].searchParams.get('sku'),'SKU /ą');
  await h.make().readOffers({max:1,offset:101,sku:'SKU /ą'});
  assert.deepEqual(h.claims.map(c=>c.operation),['A01','OF21','OF21']);assert.equal(h.requests.length,3);
  assert.equal(h.requests[2].searchParams.get('offset'),'101');assert.equal(h.claims[1].budgetKey,h.claims[2].budgetKey);
  const before=[h.requests.length,h.claims.length,h.guards];
  for(const query of [{offset:-1},{offset:10001},{offset:0.5},{offset:'100'},{offset:100,shop_id:'foreign'}])
    assert.throws(()=>h.make().readOffers(query as never),redacted);
  assert.deepEqual([h.requests.length,h.claims.length,h.guards],before,'invalid page stops before IAM/repository/HTTP');
});

test('OF21 next-page cooldown is durable and cannot cause a hidden replay or return to page zero',async()=>{
  const h=harness(u=>u.pathname==='/api/account'?json(account):json({},429,{'retry-after':'1800'}));
  await assert.rejects(h.make().readOffers({offset:100,max:1}),e=>e instanceof MiraklReadDeferred&&e.seconds===1800);
  await assert.rejects(h.make().readOffers({offset:101,max:1}),e=>e instanceof MiraklReadDeferred&&e.seconds===1800);
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].searchParams.get('offset'),'100');assert.equal(h.cooldowns[0].operation,'OF21');
});

test('Retry-After is durably persisted without automatic replay and later calls defer',async()=>{
  const h=harness(u=>u.pathname==='/api/account'?json(account):json({private:secret},429,{'retry-after':'1800'}));
  await assert.rejects(h.make().readOffers(),e=>e instanceof MiraklReadDeferred && e.seconds===1800);
  assert.equal(h.cooldowns.length,1);assert.equal(h.cooldowns[0].operation,'OF21');
  await assert.rejects(h.make().readOffers(),e=>e instanceof MiraklReadDeferred && e.seconds===1800);
  assert.equal(h.requests.length,2);
});

test('current authorization fences cache, post-reservation HTTP and results; no unknown replay',async()=>{
  const h=harness(); let checks=0;
  await assert.rejects(h.make({guard:async()=>{if(++checks===3)throw new Problem(409,'stopped','STALE_LEASE');}}).account(),
    e=>e instanceof Problem && e.status===409 && e.code==='STALE_LEASE');
  assert.equal(h.requests.length,0); assert.equal(h.claims.length,1);
  await assert.rejects(h.make().account(),e=>e instanceof MiraklReadDeferred);
  const h2=harness(); await h2.make().account();
  await assert.rejects(h2.make({guard:async()=>{throw new Problem(403,'stopped');}}).readOffers(),redacted);
  assert.equal(h2.requests.length,1);
});

test('repo/cache failures and hostile transport diagnostics are redacted and retain reservations',async()=>{
  const h=harness();
  await assert.rejects(h.make({transport:async()=>{throw new Problem(502,secret,secret);}}).account(),redacted);
  await assert.rejects(h.make().account(),e=>e instanceof MiraklReadDeferred); assert.equal(h.requests.length,0);
  const h2=harness(); h2.repo.storeAccount=async()=>{throw new Error(secret);};
  await assert.rejects(h2.make().account(),redacted); await assert.rejects(h2.make().account(),e=>e instanceof MiraklReadDeferred);
  assert.equal(h2.requests.length,1);
  const h3=harness(); await h3.make().account(); const entry=[...h3.cache.values()][0]; entry.expiresAt=Number.NaN;
  await assert.rejects(h3.make().account(),redacted);assert.equal(h3.requests.length,1);
});

test('transport Response accessors cannot smuggle remote Problem codes through local admission errors',async()=>{
  for(const field of ['status','headers','get']) {
    const h=harness();
    const response=json({private:secret},429,{'retry-after':'120'});
    const error=new Problem(502,secret,secret);
    if(field==='get') Object.defineProperty(response,'headers',{value:{get:()=>{throw error;}}});
    else Object.defineProperty(response,field,{get:()=>{throw error;}});
    await assert.rejects(h.make({transport:async()=>response}).account(),redacted);
    assert.equal(h.claims.length,1);assert.equal(h.cooldowns.length,0);
    await assert.rejects(h.make().account(),e=>e instanceof MiraklReadDeferred);
    assert.equal(h.requests.length,0,'an unknown reserved read never replays HTTP');
  }
});

test('exact-ID groups reuse durable OR11 budget/A01 cache; continuation cannot bypass cooldown or restart fences',async()=>{
 const h=harness(),ids=Array.from({length:100},(_,i)=>String(i+1));
 const first=await h.make().readOrdersByIds({order_ids:ids});assert.equal(first.group_count,3);assert.equal(first.next_group,1);assert.equal(first.readback_complete,false);
 assert.deepEqual(h.claims.map(c=>c.operation),['A01','OR11']);assert.equal(h.requests[1].searchParams.get('order_ids'),ids.slice(0,36).join(','));
 await assert.rejects(h.make().readOrdersByIds({order_ids:ids,group:1}),e=>e instanceof MiraklReadDeferred&&e.seconds===900);
 assert.equal(h.requests.length,2);
 await assert.rejects(h.make({channel:{...channel,id:'other-channel',tenant_id:'other-tenant'}}).readOrdersByIds({order_ids:ids,group:1}),e=>e instanceof MiraklReadDeferred&&e.seconds===900);
 assert.equal(h.requests.length,2,'another tenant/channel with the same instance cannot obtain a new OR11 group quota');
 h.advance(900000);
 const second=await h.make().readOrdersByIds({order_ids:ids,group:1});assert.equal(second.group_index,1);assert.equal(second.next_group,2);assert.equal(h.requests.length,3);
 assert.equal(h.requests[2].searchParams.get('order_ids'),ids.slice(36,69).join(','));assert.equal(h.claims[1].budgetKey,h.claims[4].budgetKey);assert.equal(h.cache.size,1);
 // Window reads share the exact same OR11 fence; grouping is not a new quota.
 await assert.rejects(h.make().readOrderPage({window,offset:0}),e=>e instanceof MiraklReadDeferred);assert.equal(h.requests.length,3);
});

test('invalid exact-ID filters stop before guard/repository; request mutation cannot change the admitted group',async()=>{
 const h=harness();for(const bad of [{order_ids:['A','A']},{order_ids:['A,B']},{order_ids:['A'],group:1},{order_ids:['ą'.repeat(51)]}])assert.throws(()=>h.make().readOrdersByIds(bad),redacted);
 assert.equal(h.guards,0);assert.equal(h.claims.length,0);assert.equal(h.requests.length,0);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const ids=['UNCHANGED'];
 const read=h.make({guard:async()=>{await gate;}}).readOrdersByIds({order_ids:ids});ids[0]='MUTATED';release();await read;
 assert.equal(h.requests.at(-1)!.searchParams.get('order_ids'),'UNCHANGED');
});

test('exact-ID response429 persists the existing OR11 Retry-After and revoked IAM after reservation prevents HTTP',async()=>{
 const h=harness(u=>u.pathname==='/api/account'?json(account):json({},429,{'retry-after':'1800'}));
 await assert.rejects(h.make().readOrdersByIds({order_ids:['A']}),e=>e instanceof MiraklReadDeferred&&e.seconds===1800);
 assert.equal(h.cooldowns[0].operation,'OR11');assert.equal(h.cooldowns.length,1);
 await assert.rejects(h.make().readOrdersByIds({order_ids:['A']}),e=>e instanceof MiraklReadDeferred&&e.seconds===1800);assert.equal(h.requests.length,2);
 const stopped=harness();await stopped.make().account();let revoked=false;const reserve=stopped.repo.reserveRead.bind(stopped.repo);
 stopped.repo.reserveRead=async value=>{const slot=await reserve(value);if(value.operation==='OR11')revoked=true;return slot;};
 await assert.rejects(stopped.make({guard:async()=>{if(revoked)throw new Problem(403,'revoked');}}).readOrdersByIds({order_ids:['A']}),e=>e instanceof Problem&&e.status===403);
 assert.equal(stopped.requests.length,1);assert.equal(stopped.claims.at(-1)!.operation,'OR11');
});
