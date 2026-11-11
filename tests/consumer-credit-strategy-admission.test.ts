/** Controlled admission policy only; no Native, database, HTTP or writer authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {assertLegacyConsumerCreditWriteAdmission as admit} from '../server/consumer-credit-strategy-admission';
import {localInvoiceRequestHash} from '../server/local-invoice-values';
import {Problem} from '../server/errors';
const actor={tenantId:randomUUID(),userId:randomUUID(),role:'admin' as const},resource=randomUUID(),order=randomUUID();
const body=()=>({client_key:randomUUID()});
function fixture(){
 const events:string[]=[];let context={owner:'postgres',role:'postgres',tenant:actor.tenantId},destination=false,missing=false,originals:Record<string,unknown>[]=[];
 const query=async(sql:string,args?:unknown[])=>{
  if(sql.startsWith('SELECT session_user')){events.push('context');return{rows:[context]};}
  if(sql==='SELECT public.local_invoice_locks()'){events.push('native-locks');return{rows:[]};}
  if(sql.includes('SELECT d.order_id')||sql.startsWith('SELECT order_id')){events.push('target');assert.equal(args?.[0],actor.tenantId);assert.equal(args?.[1],resource);return{rows:missing?[]:[{order_id:order}]};}
  if(sql.includes('FOR UPDATE')){events.push('order-lock');assert.deepEqual(args,[actor.tenantId,order]);return{rows:[{id:order}]};}
  if(sql.startsWith('SELECT * FROM public.local_consumer_credit_')){events.push('original');assert.equal(args?.[0],actor.tenantId);return{rows:originals};}
  if(sql.includes('return_destination_admissions')){events.push('destination');assert.deepEqual(args,[actor.tenantId,order]);assert(events.indexOf('order-lock')<events.indexOf('destination'));return{rows:[{present:destination}]};}
  assert.fail('Unexpected admission SQL');
 };
 return{client:{query} as unknown as Pick<PoolClient,'query'>,events,
  destination(value:boolean){destination=value;},original(row:Record<string,unknown>){originals=[row];},
  context(value:typeof context){context=value;},missing(){missing=true;}};
}
const status=(n:number)=>(e:unknown)=>e instanceof Problem&&e.status===n;
test('any genuine148 family blocks a new legacy command independently of169 or successor installation',async()=>{
 for(const operation of ['preview','issue'] as const){const f=fixture();f.destination(true);await assert.rejects(()=>admit(f.client,actor,operation,resource,body()),status(409));assert.deepEqual(f.events,['context','native-locks','target','order-lock','original','destination']);}
});
test('ordinary history with no destinations still reaches the unchanged Native command after the same lock order',async()=>{
 const f=fixture();await admit(f.client,actor,'preview',resource,body());assert.deepEqual(f.events,['context','native-locks','target','order-lock','original','destination']);
});
test('only exact own original replay may pass after a destination inspection; changed actor, resource, API key or request never passes',async()=>{
 for(const operation of ['preview','issue'] as const){
  const b=body(),row={order_id:order,original_document_id:resource,preview_id:resource,actor_id:actor.userId,api_key_id:null,request:b,request_hash:localInvoiceRequestHash(actor.tenantId,actor.userId,null,'consumer-credit-'+operation,resource,b)};
  const f=fixture();f.destination(true);f.original(row);await admit(f.client,actor,operation,resource,b);assert(!f.events.includes('destination'));
  for(const change of [{actor_id:randomUUID()},{order_id:randomUUID()},{api_key_id:randomUUID()},{request:{...b,extra:true}},{request_hash:'0'.repeat(64)},operation==='preview'?{original_document_id:randomUUID()}:{preview_id:randomUUID()}]){
   const bad=fixture();bad.destination(true);bad.original({...row,...change});await assert.rejects(()=>admit(bad.client,actor,operation,resource,b),status(409));
  }
 }
});
test('foreign context or missing own target refuses before acquiring or examining foreign order history',async()=>{
 const foreign=fixture();foreign.context({owner:'postgres',role:'postgres',tenant:randomUUID()});await assert.rejects(()=>admit(foreign.client,actor,'preview',resource,body()),status(403));assert.deepEqual(foreign.events,['context']);
 const absent=fixture();absent.missing();await assert.rejects(()=>admit(absent.client,actor,'issue',resource,body()),status(404));assert.deepEqual(absent.events,['context','native-locks','target']);
});
