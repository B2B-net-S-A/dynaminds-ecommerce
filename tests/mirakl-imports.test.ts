/** Actual imports.ts functions with controlled SQL clients. No App factory, business
 * SQL fixtures, provider calls, genuine tenant transaction or OMS-write acceptance. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Problem} from '../server/errors';
let routes:typeof import('../server/import-routes');
let imported:typeof import('../server/imports'),domain:typeof import('../server/domain'),db:typeof import('../server/db'),directory:string;
const original={config:process.env.DYNA_LOCAL_CONFIG_PATH,url:process.env.DATABASE_URL};
let unexpectedGlobalConnections=0;
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'dyna-mirakl-imports-'));
 const config=join(directory,'controlled.local.json');
 await writeFile(config,JSON.stringify({dbPassword:'CONTROLLED_NOT_REAL',encryptionKey:'0'.repeat(64)}),{mode:0o600});
 process.env.DYNA_LOCAL_CONFIG_PATH=config;
 process.env.DATABASE_URL='postgres://postgres:CONTROLLED_NOT_REAL@127.0.0.1:65000/never_connect';
 imported=await import('../server/imports');routes=await import('../server/import-routes');domain=await import('../server/domain');db=await import('../server/db');
 db.pool.connect=(async()=>{unexpectedGlobalConnections++;throw new Error('No global pool connection is authorized in this test');}) as any;
});
after(async()=>{
 assert.equal(unexpectedGlobalConnections,0);if(db)await db.pool.end();if(directory)await rm(directory,{recursive:true,force:true});
 for(const [name,value]of [['DYNA_LOCAL_CONFIG_PATH',original.config],['DATABASE_URL',original.url]])
  if(value===undefined)delete process.env[name!];else process.env[name!]=value;
});
const tenant=randomUUID(),actor={tenantId:tenant,userId:randomUUID(),role:'admin' as const};
const settings={instance_url:'https://imports-controlled.mirakl.net',shop_id:'2000',currency:'PLN'};
const channel=()=>({id:randomUUID(),tenant_id:tenant,provider:'mirakl',mode:'live',settings:{...settings},credentials:'encrypted-generation-a'});
const line=(id='ORDER-1-L1')=>({order_line_id:id,offer_id:101,offer_sku:'SAME-SKU',product_title:'Controlled product',
 quantity:2,price:20.1,shipping_price:4.9,total_price:25,order_line_state:'SHIPPING',cancelations:[],refunds:[],fees:[]});
const order=(order_id='ORDER-1')=>({order_id,currency_iso_code:'PLN',order_state:'SHIPPING',last_updated_date:'2026-10-01T12:00:00Z',
 order_tax_mode:'TAX_INCLUDED',customer:{firstname:'Jan',lastname:'Testowy',shipping_address:{firstname:'Jan',lastname:'Testowy',
 street_1:'Testowa 1',city:'Warszawa',zip_code:'00-001',country_iso_code:'POL'}},customer_notification_email:'controlled@example.test',
 customer_debited_date:'2026-10-01T11:00:00Z',customer_directly_pays_seller:false,payment_workflow:'PAY_ON_ACCEPTANCE',payment_type:'Visa',
 fully_refunded:false,has_incident:false,price:20.1,shipping_price:4.9,total_price:25,order_lines:[line()]});
type Statement={sql:string;values:any[]};
function sqlClient(admin=true){
 const statements:Statement[]=[];
 const c={query:async(sql:string,values:any[]=[])=>{statements.push({sql,values});
  if(sql.startsWith('INSERT INTO inbound_orders'))return{rows:[{id:values[0],state:values[7],source_hash:values[6]}]};
  if(sql.startsWith('INSERT INTO audit_events'))return{rows:[]};
  if(sql==='SELECT offer_sync_is_admin($1) ok')return{rows:[{ok:admin}]};
  assert.fail('Unexpected controlled SQL: '+sql.slice(0,120));
 }} as unknown as PoolClient;
 return{c,statements};
}
const status=(n:number)=>(e:unknown)=>e instanceof Problem&&e.status===n;
function inbound(ch:ReturnType<typeof channel>,raw:any={...order(),id:'ORDER-1'}){
 raw={...raw,_dyna_mirakl:{connection_hash:imported.importConnectionHash(ch)}};
 return{tenant_id:tenant,channel_id:ch.id,external_id:raw.order_id,raw,
  normalized:imported.normalizeOrder('mirakl',raw,ch.settings),source_hash:imported.importSourceHash(raw)};
}

test('normalizer is actually registered and preserves exact money, original line identities and platform payment',()=>{
 const raw=order();raw.order_lines.push({...line('ORDER-1-L2'),quantity:1,price:10,shipping_price:0,total_price:10});
 raw.price=30.1;raw.total_price=35;
 const canonical=imported.normalizeOrder('mirakl',raw,settings);
 assert.equal(canonical.total,3500);assert.equal(canonical.shipping_cost,490);assert.equal(canonical.paid_amount,3500);
 assert.equal(canonical.paid,true);assert.equal(canonical.payment_mode,'prepaid');assert.equal(canonical.address.country,'PL');
 assert.deepEqual(canonical.items.map(x=>({id:x.remote_line_id,offer:x.external_id,sku:x.sku,quantity:x.quantity,total:x.line_total})),[
  {id:'ORDER-1-L1',offer:'101',sku:'SAME-SKU',quantity:2,total:2010},
  {id:'ORDER-1-L2',offer:'101',sku:'SAME-SKU',quantity:1,total:1000}]);
 assert.deepEqual(canonical.blockers,[]);
 assert.deepEqual(imported.normalizeOrder('mirakl',raw,settings,true),canonical);
 assert.equal(domain.orderSchema.shape.source.parse('mirakl'),'mirakl');
});

test('normalization rejects mismatched currency, imprecise/contradictory money, duplicated lines and unmapped address',()=>{
 for(const patch of [{currency_iso_code:'EUR'},{price:20.101},{total_price:25.01},
  {order_lines:[line(),line()]},{customer:{...order().customer,shipping_address:{...order().customer.shipping_address,country_iso_code:'ZZZ'}}}])
  assert.throws(()=>imported.normalizeOrder('mirakl',{...order(),...patch},settings),status(422));
 assert.throws(()=>imported.normalizeOrder('mirakl',order(),{...settings,currency:'JPY'}),status(422));
});

test('unknown states, corrections, special fulfillment and unconfirmed/direct payments retain blockers without COD invention',()=>{
 const raw={...order(),order_state:'FUTURE_STATE',has_incident:true,fulfillment:{center:'unknown'},customer_directly_pays_seller:true,
  payment_workflow:'FUTURE_WORKFLOW',order_lines:[{...line(),refunds:[{amount:1}],fees:[{kind:'unknown'}]}]};
 const canonical=imported.normalizeOrder('mirakl',raw,settings);
 assert.equal(canonical.paid,false);assert.equal(canonical.paid_amount,0);assert.equal(canonical.payment_mode,'prepaid');
 assert(canonical.blockers.length>=5);assert.equal(canonical.source_status,'FUTURE_STATE');
 const unconfirmed=imported.normalizeOrder('mirakl',{...order(),customer_debited_date:null,payment_workflow:'PAY_ON_DELIVERY'},settings);
 assert.equal(unconfirmed.paid,false);assert.equal(unconfirmed.payment_mode,'prepaid');assert(unconfirmed.blockers.some(x=>x.includes('obciążenia')));
});

test('actual stageOrders persists the full observed source, stable projection/hash, canonical identity and issues using existing staging SQL',async()=>{
 const ch=channel(),h=sqlClient();const raw={...order(),future_operator_field:{keep:'all source metadata'}};
 const original=structuredClone(raw);const result=await imported.stageOrders(h.c,actor,ch,[raw]);
 assert.equal(result.length,1);assert.equal(result[0].state,'staged');assert.deepEqual(raw,original);
 const writes=h.statements.filter(x=>x.sql.startsWith('INSERT INTO inbound_orders'));assert.equal(writes.length,1);
 const values=writes[0].values,source=JSON.parse(values[4]),canonical=JSON.parse(values[5]);
 assert.equal(values[1],tenant);assert.equal(values[2],ch.id);assert.equal(values[3],'ORDER-1');
 assert.deepEqual(source,{...raw,id:'ORDER-1',_dyna_mirakl:{connection_hash:imported.importConnectionHash(ch)}});assert.equal(values[6],imported.importSourceHash(source));
 assert.equal(canonical.items[0].remote_line_id,'ORDER-1-L1');assert.equal(canonical.total,2500);
 assert.deepEqual(JSON.parse(values[8]),[]);assert.equal(h.statements.length,2);
 assert.equal(h.statements[1].values[3],'integration.stage');
 const projected=sqlClient();await imported.stageOrders(projected.c,actor,ch,[{...raw,id:raw.order_id}]);
 assert.equal(projected.statements[0].values[6],values[6]);
});

test('staging retains all semantic blockers and records malformed data as an error without synthesizing a valid canonical order',async()=>{
 const ch=channel(),h=sqlClient();const blocked={...order('BLOCKED'),order_state:'FUTURE_STATE',customer_debited_date:null};
 await imported.stageOrders(h.c,actor,ch,[blocked,{...order('BAD-CURRENCY'),currency_iso_code:'EUR'}]);
 const writes=h.statements.filter(x=>x.sql.startsWith('INSERT INTO inbound_orders'));assert.equal(writes.length,2);
 const blockedCanonical=JSON.parse(writes[0].values[5]);assert.deepEqual(JSON.parse(writes[0].values[8]),blockedCanonical.blockers);
 assert(blockedCanonical.blockers.length>=2);assert.equal(writes[0].values[7],'staged');
 assert.equal(writes[1].values[5],null);assert.equal(writes[1].values[7],'error');
 assert(JSON.parse(writes[1].values[8])[0].includes('waluta'));assert.equal(JSON.parse(writes[1].values[4]).currency_iso_code,'EUR');
});

test('Mirakl staging rejects foreign tenant, duplicate/mismatched IDs and unbounded batches before any SQL',async()=>{
 const ch=channel();for(const [selected,raws]of [
  [{...ch,tenant_id:randomUUID()},[order()]],[ch,[order(),order()]],
  [ch,[{...order(),id:'FOREIGN'}]],[ch,[{...order(),order_id:123}]],
  [ch,[{...order(),order_id:'line\nfeed'}]],[ch,[{...order(),_dyna_mirakl:{connection_hash:'a'.repeat(64)}}]],[ch,Array.from({length:101},(_,i)=>order('O-'+i))],
  [{...ch,settings:{...settings,simulation:true}},[order()]],
 ] as const){const h=sqlClient();await assert.rejects(imported.stageOrders(h.c,actor,selected,[...raws]));assert.equal(h.statements.length,0);}
});

test('ordinary import admission rechecks current admin, own identity/configuration/hash/canonical cut before allowing existing writer',async()=>{
 const ch=channel(),source=inbound(ch),h=sqlClient();
 const result=await imported.miraklImportAdmissionInTx(h.c,actor,ch,source,source.source_hash,imported.importConnectionHash(ch));
 assert.deepEqual(result,source.normalized);assert.deepEqual(h.statements.map(x=>x.sql),['SELECT offer_sync_is_admin($1) ok']);
 const variants=[
  {c:sqlClient(false).c,status:403},{channel:{...ch,tenant_id:randomUUID()},status:403},
  {channel:{...ch,credentials:'encrypted-generation-b'},status:409},
  {hash:undefined,status:409},{connection:undefined,status:409},
  {source:{...source,external_id:'FOREIGN'},status:409},
  {source:{...source,raw:{...source.raw,_dyna_mirakl:{connection_hash:'a'.repeat(64)}},source_hash:imported.importSourceHash({...source.raw,_dyna_mirakl:{connection_hash:'a'.repeat(64)}})},status:409},
  {source:{...source,raw:{...source.raw,payment_type:'changed source'}},status:409},
  {source:{...source,normalized:{...source.normalized,total:2499}},status:409},
 ];
 for(const variant of variants){const v=variant as any;
  await assert.rejects(imported.miraklImportAdmissionInTx(v.c??h.c,actor,v.channel??ch,v.source??source,
   Object.hasOwn(v,'hash')?v.hash:source.source_hash,Object.hasOwn(v,'connection')?v.connection:imported.importConnectionHash(ch)),status(v.status));
 }
});

test('ordinary admission re-normalizes raw blockers and preserves two same-offer lines with distinct original identities',async()=>{
 const ch=channel(),raw={...order(),id:'ORDER-1',order_lines:[line(),{...line('ORDER-1-L2'),quantity:1,price:10,shipping_price:0,total_price:10}],price:30.1,total_price:35};
 const source=inbound(ch,raw),h=sqlClient();
 const accepted=await imported.miraklImportAdmissionInTx(h.c,actor,ch,source,source.source_hash,imported.importConnectionHash(ch));
 assert.deepEqual(accepted.items.map(x=>x.remote_line_id),['ORDER-1-L1','ORDER-1-L2']);
 const blocked=inbound(ch,{...raw,has_incident:true});blocked.normalized.blockers=[];
 await assert.rejects(imported.miraklImportAdmissionInTx(h.c,actor,ch,blocked,blocked.source_hash,imported.importConnectionHash(ch)),status(422));
});


test('ordinary import authority captures the real manual session once and delegates the exact transaction and channel',async()=>{
 const ch=channel(),h=sqlClient(),calls:any[]=[];
 const request={actor:{...actor,source:'session'},currentUser:{id:actor.userId,tenant_id:actor.tenantId,role:'admin'},
  cookies:{custom_session:'PRIVATE_CONTROLLED_TOKEN'},headers:{}} as any;
 const authority=routes.miraklImportAuthorityForRequest(request,{sessionName:'custom_session',
  miraklImportAuthority:async(c,identity,channelId)=>{calls.push({c,identity,channelId});}});
 request.actor.userId=randomUUID();request.cookies.custom_session='CHANGED_AFTER_CAPTURE';
 await authority(h.c,ch.id);
 assert.equal(calls.length,1);assert.equal(calls[0].c,h.c);assert.equal(calls[0].channelId,ch.id);
 assert.equal(calls[0].identity.userId,actor.userId);assert.equal(calls[0].identity.tenantId,actor.tenantId);
 assert.equal(calls[0].identity.sessionHash,(await import('node:crypto')).createHash('sha256').update('PRIVATE_CONTROLLED_TOKEN').digest('hex'));
 assert(Object.isFrozen(calls[0].identity));
});

test('ordinary import refuses missing authority, API principals, malformed sessions and mismatched tenant before delegation',()=>{
 const request=()=>({actor:{...actor,source:'session'},currentUser:{id:actor.userId,tenant_id:actor.tenantId,role:'admin'},
  cookies:{dyna_session:'PRIVATE_CONTROLLED_TOKEN'},headers:{}} as any);
 const port={miraklImportAuthority:async()=>{assert.fail('Admission must not run');}};
 assert.throws(()=>routes.miraklImportAuthorityForRequest(request(),{}),status(503));
 for(const change of [
  (r:any)=>{r.actor.source='api';},(r:any)=>{r.actor.apiKeyId=randomUUID();},
  (r:any)=>{r.headers.authorization='Bearer controlled';},(r:any)=>{r.apiScopes=[];},
  (r:any)=>{r.cookies={};},(r:any)=>{r.currentUser.tenant_id=randomUUID();},
  (r:any)=>{r.currentUser.role='viewer';},
 ]){const r=request();change(r);assert.throws(()=>routes.miraklImportAuthorityForRequest(r,port),status(403));}
});
