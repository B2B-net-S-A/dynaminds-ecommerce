/** Controlled historical projection of actual TS source. No PG/Native/HTTP business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCipheriv,createHash} from 'node:crypto';
import {transformSync} from 'esbuild';
import {authenticateOrderMergeDeliverySource,projectOrderMergeDeliverySnapshot} from '../server/order-merge-delivery-inheritance.ts';
import {ensure} from '../server/errors.ts';
const key='ab'.repeat(32),sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const id=n=>`${n.toString(16).padStart(8,'0')}-b000-4000-8000-000000000001`,tenant=id(1);
const code=readFileSync(new URL('../server/order-merges.ts',import.meta.url),'utf8');
const start=code.indexOf('export function orderMergeOriginDeliveryFrames('),end=code.indexOf('\nfunction cursor(',start);
assert(start>=0&&end>start);
const js=transformSync(code.slice(start,end).replace('export function','function'),{loader:'ts',format:'cjs'}).code;
const frames=new Function('ensure','orderMergeHash','projectOrderMergeDeliverySnapshot','localConfig',js+';return orderMergeOriginDeliveryFrames;')(ensure,v=>sha(canonical(v)),projectOrderMergeDeliverySnapshot,{encryptionKey:key});
const receiver={recipient_name:'Zamrożony odbiorca',street:'Historyczna 11',city:'Łódź',postal_code:'90-001',country:'PL',phone:'+48123456789'};
function order(n){return{id:id(n),tenant_id:tenant,version:'17',customer_name:'Pierwotny odbiorca',email:'source@example.test',address:{street:'Pierwotna 5',city:'Warszawa',postal_code:'00-001',country:'PL',phone:''}};}
function state(){const text=canonical(receiver),iv=Buffer.alloc(12,9),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv),body=Buffer.concat([cipher.update(text),cipher.final()]),encrypted=Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');return{version:'4',delivery_version:'1',enabled:true,delivery_kind:'address',classification_origin:'operator_confirmed',delivery_override_encrypted:encrypted,override_byte_count:Buffer.byteLength(text),override_sha256:sha(encrypted),last_receipt_id:id(90)};}
function origin(){const orders=[order(2),order(3)],delivery=orders.map(o=>authenticateOrderMergeDeliverySource({order:o,state:state(),buyer_basis_hash:sha('basis'+o.id)},key).snapshot);return{execution_id:id(10),parent_execution_id:id(10),header:structuredClone(orders[0]),items:[],parent_snapshot:{orders,buyer_delivery_frames:delivery}};}
const rejects=x=>assert.throws(()=>frames(tenant,x),e=>e.status===503);
test('historical origin receiver comes from its immutable execution ciphertext, including after later source changes',()=>{
 const x=origin(),before=structuredClone(x),result=frames(tenant,x);
 assert.deepEqual(projectOrderMergeDeliverySnapshot(x.header,result[0],key).delivery,receiver);
 const currentSource=order(2);currentSource.address.street='Późniejszy adres';
 assert.notDeepEqual(currentSource,x.header);assert.deepEqual(x,before);
 assert(!JSON.stringify(result).includes(receiver.street));
});
test('pre209 origin explicitly lacks historical classification; null/empty newer roster cannot masquerade as legacy',()=>{
 const old=origin();delete old.parent_snapshot.buyer_delivery_frames;assert.equal(frames(tenant,old),undefined);
 for(const value of [null,[],{},'not-a-roster']){const x=origin();x.parent_snapshot.buyer_delivery_frames=value;rejects(x);}
});
test('foreign execution, header, tenant and malformed/duplicate roster refuse historical projection',()=>{
 for(const change of [
  x=>x.parent_execution_id=id(11),x=>x.parent_snapshot=null,x=>x.header.id=id(55),
  x=>x.header.address.street='Inny adres',x=>x.parent_snapshot.orders[1].tenant_id=id(88),
  x=>x.parent_snapshot.buyer_delivery_frames.pop(),
  x=>x.parent_snapshot.buyer_delivery_frames[1]=structuredClone(x.parent_snapshot.buyer_delivery_frames[0]),
  x=>x.parent_snapshot.buyer_delivery_frames[1].order_id=id(99),
  x=>x.parent_snapshot.buyer_delivery_frames[0].extra='unexpected',
  x=>x.parent_snapshot.buyer_delivery_frames[0].effective_hash='0'.repeat(64),
 ]){const x=origin();change(x);rejects(x);}
});
test('history refuses real AES-GCM corruption despite a recomputed ciphertext digest, also in a nonselected sibling',()=>{
 for(const index of [0,1]){const x=origin(),s=x.parent_snapshot.buyer_delivery_frames[index].state,b=Buffer.from(s.delivery_override_encrypted,'base64');b[12]^=1;s.delivery_override_encrypted=b.toString('base64');s.override_sha256=sha(s.delivery_override_encrypted);rejects(x);}
});
test('lineage query binds origin.execution_id to immutable before_snapshot, never a current sidecar SQL reader',()=>{
 const start=code.indexOf('export async function orderMergeLineage('),body=code.slice(start);
 assert.match(body,/LEFT JOIN order_merge_executions e ON\(e\.tenant_id,e\.id\)=\(o\.tenant_id,o\.execution_id\)/);
 assert.match(body,/e\.before_snapshot parent_snapshot/);
 assert.match(body,/orderMergeOriginDeliveryFrames\(a\.tenantId,original\)/);
 assert.match(body,/buyer_delivery_frames: originDeliveryFrames/);
 assert.doesNotMatch(body,/buyer_address_current_state|buyer_address_buyer_basis/);
});

// Exercise the actual asynchronous recovery verifier, not a JS imitation of SQL admission.
const buyerCode=readFileSync(new URL('../server/buyer-address.ts',import.meta.url),'utf8');
const recoveryStart=buyerCode.indexOf('  async function recoveredInheritance('),recoveryEnd=buyerCode.indexOf('\n  const totals =',recoveryStart);
assert(recoveryStart>=0&&recoveryEnd>recoveryStart);
const recoveryJs=transformSync(buyerCode.slice(recoveryStart,recoveryEnd),{loader:'ts',format:'cjs'}).code;
const {createOrderMergeDeliveryInheritanceEvidence,readOrderMergeDeliveryInheritanceEvidence}=await import('../server/order-merge-delivery-inheritance.ts');
function recoveryFixture(){
 const orders=[order(2),order(3)].map((o,index)=>({...o,portal_enabled:true,portal_expires_at:'2030-01-01T00:00:00.000Z',portal_token:(index?'03':'02').repeat(24)}));
 const sources=orders.map((o,index)=>({order:o,state:{...state(),last_receipt_id:id(90+index)},buyer_basis_hash:sha('basis'+o.id)}));
 const sourceFrames=sources.map(s=>authenticateOrderMergeDeliverySource(s,key).snapshot),target={...structuredClone(orders[0]),id:id(4),version:1,portal_token:'04'.repeat(24)};
 const execution=id(10),mergePreview=id(11),preview=id(12),receipt=id(13),actor=id(14),client=id(15),scope=sha('merge scope'),request=sha('exact execution request');
 const env=createOrderMergeDeliveryInheritanceEvidence({tenant_id:tenant,execution_id:execution,merge_preview_id:mergePreview,scope_hash:scope,source:sources[0],target_order_id:target.id},key);
 const before={version:'0',delivery_version:'0',enabled:false,delivery_kind:'unknown',classification_origin:'unknown',delivery_override_encrypted:null,override_byte_count:null,override_sha256:null,last_receipt_id:null};
 const after={...sources[0].state,version:'1',delivery_version:'1',enabled:false,last_receipt_id:receipt},snapshot={orders,buyer_delivery_frames:sourceFrames};
 const started='2020-01-01T00:00:00.000000Z',created='2020-01-01T00:00:01.000123Z',expires='2020-01-01T00:15:01.000123Z';
 const proof={tenant_id:tenant,execution_id:execution,source_order_id:orders[0].id,target_order_id:target.id,merge_preview_id:mergePreview,actor_id:actor,api_key_id:null,preview_id:preview,receipt_id:receipt,
  scope_hash:scope,request_hash:request,sidecar_scope_hash:sha('166 scope'),source_frames:sourceFrames,source_state:sources[0].state,source_buyer_basis_hash:sources[0].buyer_basis_hash,target_buyer_basis_hash:sha('basis'+target.id),before_state:before,after_state:after,target_order_version:'1',
  evidence_encrypted:env.encrypted,evidence_byte_count:env.byte_count,evidence_sha256:env.sha256,root_xid:'12345',transaction_started_at:started,created_at:created,expires_at:expires,
  parent_id:execution,parent_preview:mergePreview,parent_actor:actor,parent_key:null,parent_main:orders[0].id,parent_target:target.id,parent_client_key:client,parent_sources:orders.map(o=>o.id),parent_scope:scope,parent_request:request,parent_mode:'technical_merge',parent_state:'done',parent_before:snapshot,target_header:target,
  merge_snapshot:structuredClone(snapshot),merge_actor:actor,merge_key:null,merge_main:orders[0].id,merge_target:target.id,merge_sources:orders.map(o=>o.id),merge_scope:scope,merge_ready:true,merge_expires_at:'2020-01-01T00:02:00.000000Z'};
 const row={id:receipt,tenant_id:tenant,order_id:target.id,preview_id:preview,client_key:client,kind:'merge_inherit',actor_id:actor,api_key_id:null,token_digest:null,scope_hash:proof.sidecar_scope_hash,request_hash:request,buyer_basis_hash:proof.target_buyer_basis_hash,before_state:structuredClone(before),after_state:structuredClone(after),before_order_version:1,after_order_version:1,changed:true,evidence_encrypted:env.encrypted,evidence_byte_count:env.byte_count,evidence_sha256:env.sha256,recovery_created_at:created,recovery_top_xid:'12345',recovery_transaction_started_at:started};
 return{proof,row,sources,proofRows:1,queries:[]};
}
async function validateRecovery(f){
 const c={async query(sql,args){f.queries.push({sql,args});
  if(sql.includes('FROM order_merge_delivery209_receipts r'))return{rows:Array.from({length:f.proofRows},()=>f.proof)};
  if(sql.includes('SELECT buyer_address_hash('))return{rows:[{hash:sha('basis'+args[1])}]};
  if(sql.startsWith('SELECT after_state,buyer_basis_hash,changed FROM buyer_address_receipts')){const s=f.sources.find(s=>s.order.id===args[1]&&s.state.last_receipt_id===args[2]);return{rows:s?[{after_state:s.state,buyer_basis_hash:s.buyer_basis_hash,changed:true}]:[]};}
  throw new Error('Unexpected query in read-only recovery verifier');
 }};
 const fn=new Function('c','encryptionKey','ensure','canonical','readOrderMergeDeliveryInheritanceEvidence','authenticateOrderMergeDeliverySource',recoveryJs+';return recoveredInheritance;')(c,key,ensure,canonical,readOrderMergeDeliveryInheritanceEvidence,authenticateOrderMergeDeliverySource);
 await fn(f.row);
}
test('actual recovery verifier accepts historical immutable parent proof without using current expiry or credentials',async()=>{
 const f=recoveryFixture();await validateRecovery(f);
 assert(f.queries.length>=6);assert(f.queries.every(q=>!q.sql.includes('credential_hash')));
 assert(f.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE|ALTER|SET|BEGIN|COMMIT)/i.test(q.sql)));
 const preview=recoveryFixture();preview.row={...preview.row,id:preview.proof.preview_id,reserved_receipt_id:preview.proof.receipt_id,expected_order_version:'1'};delete preview.row.preview_id;delete preview.row.before_order_version;delete preview.row.after_order_version;delete preview.row.recovery_top_xid;delete preview.row.recovery_transaction_started_at;await validateRecovery(preview);
});
test('actual recovery verifier refuses concrete foreign parent/context/basis/own-receipt substitutions',async()=>{
 const changes=[
  f=>f.proof.parent_actor=id(50),f=>f.proof.parent_scope=sha('other'),f=>f.proof.parent_id=id(51),
  f=>f.proof.merge_ready=false,f=>f.proof.parent_before.buyer_delivery_frames.pop(),
  f=>f.proof.target_header.customer_name='Podmieniony odbiorca',f=>f.proof.target_header.portal_token=f.proof.parent_before.orders[0].portal_token,
  f=>f.proof.source_state={...f.proof.source_state,version:'5'},f=>f.proof.target_buyer_basis_hash=sha('foreign basis'),
  f=>f.row.client_key=id(52),f=>f.row.preview_id=id(53),f=>f.row.before_order_version=2,
  f=>f.proofRows=0,f=>f.proofRows=2,
 ];
 for(const change of changes){const f=recoveryFixture();change(f);await assert.rejects(()=>validateRecovery(f),e=>e.status===503);}
});
test('actual recovery verifier requires exact receipt root/stamps and original merge-preview expiry, including submillisecond drift',async()=>{
 for(const change of [
  f=>f.row.recovery_top_xid='12346',f=>delete f.row.recovery_top_xid,
  f=>f.row.recovery_transaction_started_at='2020-01-01T00:00:00.000001Z',
  f=>f.row.recovery_created_at='2020-01-01T00:00:01.000124Z',
  f=>f.proof.merge_expires_at=f.proof.created_at,
  f=>f.proof.merge_expires_at='2019-12-31T23:59:59.000000Z',
  f=>f.proof.transaction_started_at='2020-01-01T00:00:02.000000Z',
  f=>f.proof.expires_at='2020-01-01T00:16:01.000123Z',
 ]){const f=recoveryFixture();change(f);await assert.rejects(()=>validateRecovery(f),e=>e.status===503);}
});
