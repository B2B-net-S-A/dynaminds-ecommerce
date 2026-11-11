import type {Job,CoreAck,CorePage,Ref,Lease,Store,Ports} from './coordinator';
import {canonicalDigest,need} from './native-batches';
export type Eligibility={eligible:boolean;authority_revision:string;source_hash:string;sources:Ref[];quota_witness:Ref};
export type Resolution={ordinal:number;product_id:string;operation:'create'|'update'|'unchanged'};
export type ReviewedBatch={index:number;preview_id:string;scope_hash:string;preview_key:string;execute_key:string;request_hash:string;rows_hash:string;resolution:Resolution[];eligibility:Eligibility;preview:{ack:CoreAck;pages:CorePage[]}};
export type CoreReview={schema:'large-import-core-review/v1';revision:number;source_plan_hash:string;raw:Job['raw'];parsing_spec:Job['parsing_spec'];batches:ReviewedBatch[];aggregate_scope_hash:string;approved_scope_hash:string|null};
export type ReviewLease={load():Promise<CoreReview|null>;save(next:CoreReview,expectedRevision:number|null):Promise<void>};
export type Lease4=Lease&{review:ReviewLease};
export type Store4=Omit<Store,'withLease'>&{withLease<T>(jobId:string,work:(lease:Lease4)=>Promise<T>):Promise<T>};
export type Ports4<A>=Omit<Ports<A>,'jobs'>&{jobs:Store4;
 /** Genuine authenticated source/IAM/quota read, bound to the full native preview. No fabricated actor or optimistic boolean. */
 validateCoreBatch(authority:A,input:{index:number;request:Job['core'][number]['request'];preview:{ack:CoreAck;pages:CorePage[]}}):Promise<Eligibility>;
};
const detached=<T>(v:T):T=>structuredClone(v),hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function witness(r:Ref){need(r&&typeof r.id==='string'&&r.id.length>0&&hex(r.sha256)&&Number.isSafeInteger(r.byte_count)&&r.byte_count>=0,'core-review-witness');}
function uuid(s:unknown){need(typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s),'core-review-product-id');}
export function unresolvedCore(j:Job,n:number){return !j.core[n].execution&&j.events.some(e=>e.kind==='core-execute-attempt'&&e.batch===n);}
export function reviewHash(r:Omit<CoreReview,'aggregate_scope_hash'|'approved_scope_hash'|'revision'>|CoreReview){return canonicalDigest({schema:r.schema,source_plan_hash:r.source_plan_hash,raw:r.raw,parsing_spec:r.parsing_spec,batches:r.batches.map(b=>({index:b.index,preview_id:b.preview_id,scope_hash:b.scope_hash,preview_key:b.preview_key,execute_key:b.execute_key,request_hash:b.request_hash,rows_hash:b.rows_hash,resolution:b.resolution,source_hash:b.eligibility.source_hash,authority_revision:b.eligibility.authority_revision}))});}
export function requireBoundReview(j:Job,r:CoreReview|null){
 need(r&&r.schema==='large-import-core-review/v1'&&Number.isSafeInteger(r.revision)&&r.revision>=0,'whole-core-review-required');need(r.source_plan_hash===j.plan_hash&&canonicalDigest(r.raw)===canonicalDigest(j.raw)&&canonicalDigest(r.parsing_spec)===canonicalDigest(j.parsing_spec)&&r.batches.length===j.core.length&&r.aggregate_scope_hash===reviewHash(r),'whole-core-review-binding');
 for(const [i,c]of j.core.entries()){const b=r.batches[i];need(c.preview&&c.preview.ack.head.ready===true&&b.index===i&&b.preview_id===c.preview.ack.head.id&&b.scope_hash===c.preview.ack.head.scope_hash&&b.preview_key===c.previewKey&&b.execute_key===c.executeKey&&b.request_hash===canonicalDigest(c.request)&&b.rows_hash===canonicalDigest(c.preview.pages.flatMap(p=>p.rows)),'whole-core-preview-binding');}
 return r;
}
/** Every batch must have complete genuine native pages before any execute is admitted. */
export async function collectCoreReview<A>(j:Job,old:CoreReview|null,a:A,ports:Ports4<A>,read:(n:number)=>Promise<{ack:CoreAck;pages:CorePage[]}>):Promise<CoreReview>{
 const batches:ReviewedBatch[]=[],ids=new Map<string,{batch:number;operation:'create'|'update'|'unchanged'}>(),links:{batch:number;target:string}[]=[];let ordinal=0;
 for(const [n,c]of j.core.entries()){
  need(c.preview&&c.preview.ack.head.ready===true,'whole-core-every-ready-preview-required');
  const preview=detached(await read(n)),rows=preview.pages.flatMap(p=>p.rows);need(canonicalDigest(rows)===canonicalDigest(c.preview.pages.flatMap(p=>p.rows)),'whole-core-preview-rows-changed');
  const resolution:Resolution[]=[];for(const row of rows){need(row.errors.length===0&&(row.operation==='create'||row.operation==='update'||row.operation==='unchanged'),'whole-core-invalid-or-unsupported-row');uuid(row.product_id);const product_id=row.product_id!;need(!ids.has(product_id),'whole-core-duplicate-product');ids.set(product_id,{batch:n,operation:row.operation});resolution.push({ordinal:ordinal++,product_id,operation:row.operation});const after=row.after as any;need(after&&typeof after==='object'&&!Array.isArray(after)&&after.id===product_id,'whole-core-full-native-after-required');if(row.operation==='create')need(row.before===null&&row.resolved_product_id===null,'whole-core-create-before');else{const before=row.before as any;need(before&&typeof before==='object'&&before.id===product_id&&row.resolved_product_id===product_id,'whole-core-existing-before');}
   // Native references come from full projected after, never guessed from SKU text.
   if(after.parent_id!==null&&after.parent_id!==undefined){uuid(after.parent_id);links.push({batch:n,target:after.parent_id});}
   need(Array.isArray(after.components),'whole-core-components-required');for(const component of after.components){need(component&&typeof component==='object','whole-core-component');uuid(component.product_id);links.push({batch:n,target:component.product_id});}
  }
  let eligibility:Eligibility;if(c.execution){need(old,'whole-core-historical-review-required');eligibility=detached(old.batches[n].eligibility);}else{need(!unresolvedCore(j,n),'whole-core-unknown-execute-retry-required');eligibility=detached(await ports.validateCoreBatch(a,{index:n,request:detached(c.request),preview:detached(preview)}));need(eligibility.eligible===true,'whole-core-current-source-or-authority-refusal');}
  need(typeof eligibility.authority_revision==='string'&&eligibility.authority_revision.length>0&&hex(eligibility.source_hash)&&Array.isArray(eligibility.sources)&&eligibility.sources.length>0,'whole-core-native-eligibility-proof');eligibility.sources.forEach(witness);witness(eligibility.quota_witness);
  batches.push({index:n,preview_id:preview.ack.head.id,scope_hash:preview.ack.head.scope_hash,preview_key:c.previewKey,execute_key:c.executeKey,request_hash:canonicalDigest(c.request),rows_hash:canonicalDigest(rows),resolution,eligibility,preview});
 }
 need(ordinal===j.manifest.records,'whole-core-record-count');for(const link of links){const target=ids.get(link.target);need(!target||target.batch===link.batch,'whole-core-cross-batch-dependency-open');}
 const body={schema:'large-import-core-review/v1' as const,source_plan_hash:j.plan_hash,raw:detached(j.raw),parsing_spec:detached(j.parsing_spec),batches};return {...body,revision:(old?.revision??-1)+1,aggregate_scope_hash:reviewHash(body),approved_scope_hash:null};
}
