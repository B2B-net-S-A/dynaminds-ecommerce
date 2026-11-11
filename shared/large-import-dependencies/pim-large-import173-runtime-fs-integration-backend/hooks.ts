/** Source-only mutation integration. Actual quota3 ports; no pool, fabricated principal or clock. */
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {executeWriteGroup,type Resource,type Observed,type QuotaGroupPort,type GroupInput} from '../pim-large-import-write-hook-registry-backend/group';
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
export function createMetadataMutationHooks(input:{quota:QuotaGroupPort;admit():Promise<void>;cleanupFailure(e:unknown):void}):MutationHooks{
 const quota={...input.quota},admit=input.admit,diagnostic=input.cleanupFailure,prepared=new Map<string,Resource>(),active=new Set<string>();
 const report=(e:unknown)=>{try{diagnostic(e);}catch{}};
 return{
  async perform(operation,key,resources,write,inspect){const snapshot=structuredClone(resources);assert(!active.has(key),'hook-overlapping-group');active.add(key);try{
   const result=await executeWriteGroup({operation,group_key:key,resources:snapshot},quota,{admit,write,inspect:async()=>{const result=await inspect();return{complete:true,group_key:key,...result};}});return result.value;
  }finally{active.delete(key);}},
  async prepareCleanup(key,resource){resource=structuredClone(resource);assert(!prepared.has(key),'hook-cleanup-already-prepared');await admit();const row=await quota.intent(structuredClone(resource)) as any;
   assert(row?.state==='intent'&&row.resource_key===resource.key&&row.kind===resource.kind&&String(row.byte_count)===String(resource.byte_count)&&row.sha256===resource.sha256&&row.payload_text===resource.payload_text,'hook-cleanup-intent');prepared.set(key,resource);
  },
  async cleanup(key,resource,write,inspect){resource=structuredClone(resource);assert(JSON.stringify(prepared.get(key))===JSON.stringify(resource),'hook-cleanup-preallocated-only');let failed=false,first:unknown;
   // No new quota capacity/authority is created. Actual SQL must be same private lease token/fence and strictly no-growth.
   try{await write();const fact=await inspect();assert(fact.key===resource.key&&fact.sha256===resource.sha256&&fact.byte_count===resource.byte_count&&fact.state==='settled','hook-cleanup-readback');
    try{await admit();await quota.settle(fact);}catch(e){report(e);/* Charge remains conservative/pending until genuine reauthentication reconciliation. */}
   }catch(e){failed=true;first=e;try{await quota.unknown();}catch(e){report(e);}}
   finally{prepared.delete(key);}if(failed)throw first;
  },
 };
}
