/** Actual Base journal family service + registry on CLOSED native ports.
 * The real 221 SQL/RLS/native events are covered by base-wire-journal.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createBaseWireJournalService, createBaseWireJournalFamily, BASE_WIRE_JOURNAL_METHODS, BASE_WIRE_JOURNAL_EVENT_TYPES, BASE_WIRE_JOURNAL_STAGES,
  BASE_WIRE_JOURNAL_PAGE, baseWireJournalScope, isBaseWireJournalWrite, type BaseWireJournalEntry, type BaseWireJournalFilter } from '../server/base-wire-journal';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { stages } from '../server/operation-schema';
import type { Actor } from '../server/domain';

const uid=(n:number)=>`74000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=(t:number):Actor=>({tenantId:uid(t),userId:uid(10+t),role:'viewer',apiKeyId:uid(20+t),source:'api'});
type Row=BaseWireJournalEntry&{tenant:string;allocated:boolean};
function fixture(opts:{allocateOnRead?:boolean;rows?:Row[];corrupt?:boolean}={}) {
  const rows=opts.rows??[],calls:{tenant:string;writing:boolean;op:string;filter?:BaseWireJournalFilter}[]=[];
  const service=createBaseWireJournalService({allocateOnRead:opts.allocateOnRead??true,
    transaction:async(a,writing,work)=>work({writing,tenant:a.tenantId} as any),
    native:(c:any,a)=>({
      allocate:async()=>{calls.push({tenant:a.tenantId,writing:c.writing,op:'allocate'});for(const r of rows)if(r.tenant===a.tenantId)r.allocated=true;},
      entries:async f=>{calls.push({tenant:a.tenantId,writing:c.writing,op:'entries',filter:f});
        const out=rows.filter(r=>r.tenant===a.tenantId&&r.allocated&&r.log_id>f.after&&(!f.types||f.types.includes(r.log_type))&&(f.order_public_id===undefined||r.order_public_id===f.order_public_id))
          .sort((x,y)=>x.log_id-y.log_id).slice(0,f.limit).map(({tenant:_t,allocated:_a,...e})=>e);
        return opts.corrupt?out.reverse():out;},
    })});
  return {service,calls,rows};
}
const row=(tenant:number,log_id:number,log_type=1,order=500,object_id=0,allocated=false):Row=>({tenant:uid(tenant),log_id,order_public_id:order,log_type,object_id,date:1761200000+log_id,allocated});

test('journal scope: orders:read only, never a write; unknown method refused',()=>{
  assert.deepEqual(BASE_WIRE_JOURNAL_METHODS.map(m=>[baseWireJournalScope(m),isBaseWireJournalWrite(m)]),[['orders:read',false]]);
  assert.throws(()=>baseWireJournalScope('getOrders'),(e:any)=>e.status===400);
  const family=createBaseWireJournalFamily({service:{execute:async()=>({})},available:true});
  assert.equal(family.label,'dziennika');assert.equal(family.nativeCredentialCustody,undefined);assert.equal(family.available,true);
  assert.equal(createBaseWireJournalFamily({service:{execute:async()=>({})},available:'yes' as any}).available,false);
});
test('event table: Base log types from native kinds; stage list pinned to operation-schema',()=>{
  assert.deepEqual([...BASE_WIRE_JOURNAL_STAGES],[...stages]);
  const byKind=Object.fromEntries(BASE_WIRE_JOURNAL_EVENT_TYPES.map(r=>[r.kind,[r.log_type,r.object]]));
  assert.deepEqual(byKind['order.created'],[1,'none']);assert.deepEqual(byKind['payment.receipt'],[3,'none']);
  assert.deepEqual(byKind['order.merged'],[5,'merged_order']);assert.deepEqual(byKind['order.shipped'],[9,'package']);
  assert.deepEqual(byKind['order.parcel.dispatched'],[9,'package']);assert.deepEqual(byKind['order.delivery_address_changed'],[11,'none']);
  for(const k of ['order.note_added','order.tags_changed','order.fields_changed'])assert.deepEqual(byKind[k],[16,'none']);
  assert.deepEqual(byKind['order.workflow_changed'],[18,'status']);assert.deepEqual(byKind['order.packed'],[18,'none']);
  // order.paid is the native stage promotion (18), the receipt itself is 3; item scans, returns and refunds have no Base log type.
  assert.deepEqual(byKind['order.paid'],[18,'none']);
  for(const k of ['item.scanned','return.requested','payment.refund','order.split'])assert.equal(byKind[k],undefined);
  assert.equal(new Set(BASE_WIRE_JOURNAL_EVENT_TYPES.map(r=>r.kind)).size,BASE_WIRE_JOURNAL_EVENT_TYPES.length);
  assert(Object.isFrozen(BASE_WIRE_JOURNAL_EVENT_TYPES)&&BASE_WIRE_JOURNAL_EVENT_TYPES.every(r=>Object.isFrozen(r)));
});
test('getJournalList allocates in a writing transaction, then reads in a read-only one; both id spellings',async()=>{
  const f=fixture({rows:[row(1,3,1,500),row(1,7,18,500,12),row(2,5,1,900)]});
  const r=await f.service.execute(actor(1),'getJournalList',{});
  assert.deepEqual(r,{logs:[{log_id:3,id:3,order_id:500,log_type:1,object_id:0,date:1761200003},{log_id:7,id:7,order_id:500,log_type:18,object_id:12,date:1761200007}]});
  assert.deepEqual(f.calls.map(c=>[c.op,c.writing,c.tenant]),[['allocate',true,uid(1)],['entries',false,uid(1)]]);
  assert.deepEqual(f.calls[1].filter,{after:0,types:undefined,order_public_id:undefined,limit:BASE_WIRE_JOURNAL_PAGE});
  // Second tenant sees only its own row.
  assert.deepEqual(((await f.service.execute(actor(2),'getJournalList',{})).logs as any[]).map(l=>l.log_id),[5]);
});
test('last_log_id is exclusive, filters map to the port, empty logs_types means all, order_id 0 means none',async()=>{
  const f=fixture({rows:[row(1,1,1,500),row(1,2,3,500),row(1,3,18,501),row(1,4,7,500,44)]});
  const ids=async(p:any)=>((await f.service.execute(actor(1),'getJournalList',p)).logs as any[]).map(l=>l.log_id);
  assert.deepEqual(await ids({last_log_id:2}),[3,4]);assert.deepEqual(await ids({last_log_id:'2'}),[3,4]);
  assert.deepEqual(await ids({logs_types:[7,3,7]}),[2,4]);assert.deepEqual(await ids({logs_types:[]}),[1,2,3,4]);
  assert.deepEqual(await ids({order_id:501}),[3]);assert.deepEqual(await ids({order_id:0}),[1,2,3,4]);assert.deepEqual(await ids({order_id:999}),[]);
  assert.deepEqual(f.calls.filter(c=>c.op==='entries').map(c=>c.filter!.types)[2],[7,3]);
});
test('getJournalList returns at most 100 entries; continuation from the last log_id has no gaps or duplicates',async()=>{
  const rows=Array.from({length:250},(_,i)=>row(1,10+i*2));const f=fixture({rows});
  const seen:number[]=[];let last=0;
  for(;;){const logs=(await f.service.execute(actor(1),'getJournalList',{last_log_id:last})).logs as any[];
    assert(logs.length<=100);seen.push(...logs.map(l=>l.log_id));if(logs.length<100)break;last=logs.at(-1).log_id;}
  assert.deepEqual(seen,rows.map(r=>r.log_id));
});
test('a read-only copy never allocates; a non-ascending native page is refused as 503',async()=>{
  const f=fixture({allocateOnRead:false,rows:[row(1,1,1,500,0,true),row(1,2,1,500)]});
  assert.deepEqual(((await f.service.execute(actor(1),'getJournalList',{})).logs as any[]).map(l=>l.log_id),[1]);
  assert.deepEqual(f.calls.map(c=>c.op),['entries']);
  const bad=fixture({corrupt:true,rows:[row(1,1),row(1,2)]});
  await assert.rejects(bad.service.execute(actor(1),'getJournalList',{}),(e:any)=>e.status===503);
});
test('invalid input is refused before any transaction',async()=>{
  const f=fixture();
  for(const p of [{x:1},{last_log_id:-1},{last_log_id:1.5},{last_log_id:Number.MAX_SAFE_INTEGER+1},{last_log_id:'01'},{logs_types:[0]},{logs_types:[23]},
    {logs_types:'7'},{logs_types:Array(23).fill(1)},{order_id:-3},{order_id:'x'}])
    await assert.rejects(f.service.execute(actor(1),'getJournalList',p as any),(e:any)=>e.name==='ZodError',JSON.stringify(p));
  assert.equal(f.calls.length,0);
});
test('connector.php: getJournalList works on a read-only copy with orders:read and the Base envelope',async()=>{
  const f=fixture({rows:[row(1,1,1,500,0,true)]}),scopes:string[]=[];
  const app=Fastify();
  registerBaseWireRoutes(app,{readOnly:true,families:[createBaseWireJournalFamily({service:f.service,available:true})],
    authenticate:async(_token,scope)=>{scopes.push(scope);return {id:uid(11),tenant_id:uid(1),role:'viewer',api_key_id:uid(21),scopes:[scope]};}});
  const call=(method:string,parameters:unknown)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'dyna_api_closed'},
    payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()});
  const r=await call('getJournalList',{last_log_id:0});assert.equal(r.statusCode,200,r.body);
  assert.deepEqual(r.json(),{status:'SUCCESS',logs:[{log_id:1,id:1,order_id:500,log_type:1,object_id:0,date:1761200001}]});
  assert.deepEqual(scopes,['orders:read']);
  const bad=await call('getJournalList',{logs_types:[99]});assert.equal(bad.statusCode,422);assert.equal(bad.json().status,'ERROR');
  await app.close();
});
