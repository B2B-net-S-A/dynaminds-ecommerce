/** Source-only mutation integration. Actual quota3 ports; no pool, fabricated principal or clock. */
import assert from 'node:assert/strict';import {AsyncLocalStorage} from 'node:async_hooks';import {createHash} from 'node:crypto';
import {executeWriteGroup,type Resource,type Observed,type QuotaGroupPort,type GroupInput} from '../pim-large-import-write-hook-registry-backend/group';
import {assertSharedOriginalWriter,requireSharedMutationFrame,type SharedOriginalWriter} from '../../../server/large-import/shared-session-writer';
import {runOriginalWriter,runOriginalWriterCleanup,type OriginalWriterBinding} from '../../../server/large-import/original-writer-participation';
import type {Operation} from '../pim-large-import-write-hook-registry-backend/inventory';
export type ResourceInput={kind:Resource['kind'];key:string;text:string};
export const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
export function retained(kind:Resource['kind'],key:string,text:string):Resource{assert(kind!=='raw');return{kind,key:`${kind}:${key}`,payload_text:text,byte_count:Buffer.byteLength(text),sha256:sha(text)};}
export function observed(r:Resource,witness:Observed['witness']):Observed{return{...structuredClone(r),state:'settled',witness:structuredClone(witness)};}
export type MutationHooks={
 perform<T>(operation:Operation,key:string,resources:Resource[],write:()=>Promise<void>,inspect:()=>Promise<{value:T;resources:Observed[]}>):Promise<T>;
 /** Allocate exact cleanup record while authority is still valid, BEFORE lease claim. */
 prepareCleanup(key:string,resource:Resource):Promise<void>;
 /** Uses only that previously allocated no-growth cleanup. Release is mandatory after revocation. */
 cleanup(key:string,resource:Resource,write:()=>Promise<void>,inspect:()=>Promise<Observed>):Promise<void>;
};
export type ExecutedCleanupFacts={key:string;resource:Resource;intent_before_write:true;exact_readback:Observed;quota_settled:boolean};
const cleanupObservations=new AsyncLocalStorage<ExecutedCleanupFacts[]>();
export async function observeExecutedCleanups<T>(work:()=>Promise<T>){const results:ExecutedCleanupFacts[]=[];let value:T|undefined,error:unknown,failed=false;try{value=await cleanupObservations.run(results,work);}catch(e){failed=true;error=e;}return{value,error,failed,results:structuredClone(results)};}
const ownedHooks=new WeakSet<object>(),hookWriters=new WeakMap<object,OriginalWriterBinding>(),sharedHookWriters=new WeakMap<object,SharedOriginalWriter>();
export function inspectOwnedHookSharedWriter(hooks:MutationHooks){assertOwnedMetadataMutationHooks(hooks);return sharedHookWriters.get(hooks);}
export function inspectOwnedHookWriter(hooks:MutationHooks){assertOwnedMetadataMutationHooks(hooks);return hookWriters.get(hooks);}
export function assertOwnedMetadataMutationHooks(value:MutationHooks){assert(ownedHooks.has(value),'hook-authentic-mutation-hooks');}
export function createMetadataMutationHooks(input:{quota:QuotaGroupPort;admit():Promise<void>;cleanupFailure(e:unknown):void;writer?:OriginalWriterBinding;sharedWriter?:SharedOriginalWriter}):MutationHooks{
 const sharedWriter=input.sharedWriter;if(sharedWriter)assertSharedOriginalWriter(sharedWriter);const writer=input.writer,quota={...input.quota},admit=input.admit,diagnostic=input.cleanupFailure,prepared=new Map<string,Resource>(),active=new Set<string>();
 const report=(e:unknown)=>{try{diagnostic(e);}catch{}};
 const hooks:MutationHooks={
  async perform(operation,key,resources,write,inspect){requireSharedMutationFrame(false,sharedWriter);const snapshot=structuredClone(resources);assert(!active.has(key),'hook-overlapping-group');active.add(key);try{
   const result=await executeWriteGroup({operation,group_key:key,resources:snapshot},quota,{admit:async()=>{requireSharedMutationFrame(false,sharedWriter);await admit();requireSharedMutationFrame(false,sharedWriter);},write:async()=>{requireSharedMutationFrame(false,sharedWriter);await write();requireSharedMutationFrame(false,sharedWriter);},inspect:async()=>{requireSharedMutationFrame(false,sharedWriter);const result=await inspect();requireSharedMutationFrame(false,sharedWriter);return{complete:true,group_key:key,...result};}});return result.value;
  }finally{active.delete(key);}},
  async prepareCleanup(key,resource){requireSharedMutationFrame(false,sharedWriter);resource=structuredClone(resource);assert(!prepared.has(key),'hook-cleanup-already-prepared');await admit();requireSharedMutationFrame(false,sharedWriter);const row=await quota.intent(structuredClone(resource)) as any;requireSharedMutationFrame(false,sharedWriter);
   assert(row?.state==='intent'&&row.resource_key===resource.key&&row.kind===resource.kind&&String(row.byte_count)===String(resource.byte_count)&&row.sha256===resource.sha256&&row.payload_text===resource.payload_text,'hook-cleanup-intent');prepared.set(key,resource);
  },
  async cleanup(key,resource,write,inspect){requireSharedMutationFrame(true,sharedWriter);resource=structuredClone(resource);assert(JSON.stringify(prepared.get(key))===JSON.stringify(resource),'hook-cleanup-preallocated-only');let failed=false,first:unknown;
   // No new quota capacity/authority is created. Actual SQL must be same private lease token/fence and strictly no-growth.
   try{requireSharedMutationFrame(true,sharedWriter);await write();requireSharedMutationFrame(true,sharedWriter);const fact=await inspect();requireSharedMutationFrame(true,sharedWriter);assert(fact.key===resource.key&&fact.sha256===resource.sha256&&fact.byte_count===resource.byte_count&&fact.state==='settled','hook-cleanup-readback');
    let quotaSettled=false;try{await admit();requireSharedMutationFrame(true,sharedWriter);await quota.settle(fact);requireSharedMutationFrame(true,sharedWriter);quotaSettled=true;}catch(e){report(e);/* Charge remains conservative/pending until genuine reauthentication reconciliation. */}cleanupObservations.getStore()?.push({key,resource:structuredClone(resource),intent_before_write:true,exact_readback:structuredClone(fact),quota_settled:quotaSettled});
   }catch(e){failed=true;first=e;try{await quota.unknown();}catch(e){report(e);}}
   finally{prepared.delete(key);}if(failed)throw first;
  },
 };
 if(writer){for(const name of ['perform','prepareCleanup','cleanup'] as const){const method=hooks[name];Object.defineProperty(hooks,name,{value:(...args:unknown[])=>(name==='cleanup'?runOriginalWriterCleanup:runOriginalWriter)(writer,()=>Reflect.apply(method,hooks,args)),enumerable:true,writable:false,configurable:false});}hookWriters.set(hooks,writer);}
 if(sharedWriter)sharedHookWriters.set(hooks,sharedWriter);ownedHooks.add(hooks);return hooks;
}

/** Fixed existing job/review split; no caller-provided evaluator or observation assertion. */
export function combineMetadataMutationHooks(job:MutationHooks,review:MutationHooks):MutationHooks{
 assertOwnedMetadataMutationHooks(job);assertOwnedMetadataMutationHooks(review);assert(job!==review,'hook-distinct-job-review-hooks');const writer=hookWriters.get(job);assert.equal(hookWriters.get(review),writer,'hook-same-original-writer');const sharedWriter=sharedHookWriters.get(job);assert.equal(sharedHookWriters.get(review),sharedWriter,'hook-same-shared-original-writer');
 const combined:MutationHooks={perform:(op,key,resources,write,inspect)=>(op==='review-append-bindings'?review:job).perform(op,key,resources,write,inspect),prepareCleanup:(...args)=>job.prepareCleanup(...args),cleanup:(...args)=>job.cleanup(...args)};
 if(writer)hookWriters.set(combined,writer);if(sharedWriter)sharedHookWriters.set(combined,sharedWriter);ownedHooks.add(combined);return combined;
}
