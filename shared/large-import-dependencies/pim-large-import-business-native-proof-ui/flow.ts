/** Genuine coordinator5 phase2 engine. Ports are actual Root-owned native bindings, never browser-supplied Actor/IDs. */
import assert from 'node:assert/strict';
import type {Actor} from '../../../server/domain';
import type {FastifyRequest} from 'fastify';
import type {Ref,Job} from '../pim-large-import-job-coordinator-backend5/coordinator';
import type {CoreConfig} from '../pim-large-import-job-coordinator-backend5/native-batches';
import type {Manifest,Spec} from '../pim-large-import-stream-foundation-ui2/stream';
import type {createHookedLargeImportRuntime} from '../pim-large-import173-runtime-fs-integration-backend2/runtime';
import type {OwnedRequest} from '../pim-large-import-upload-quota-broker-backend3/broker';
import type {createOwnedBusinessQuotaKeeper} from './owned-keeper';
import type {Invocation} from './coverage';import{coverageMatrix}from'./coverage';
export type Runtime=ReturnType<typeof createHookedLargeImportRuntime>;
export type Coordinator=ReturnType<Runtime['bind']>['coordinator'];
export type PhaseInput={jobId:string;catalogId:string;retained:{raw:Ref;manifest:Manifest;spec:Spec};config:CoreConfig;uploadAllocation:OwnedRequest;jobAllocation:OwnedRequest;reviewAllocation:OwnedRequest;witnessId:string;jobCloseKey:string;reviewCloseKey:string};
export type Approval={file_plan_hash:string;whole_core_scope_hash:string;batch_core:{index:number;preview_id:string;scope_hash:string}[];pim:{index:number;mapping:unknown;preview_id?:string;scope_hash?:string}[]};
/** Separate explicit commands; engine NEVER supplies consent from a preview or executes on prepare. */
type Keeper=ReturnType<ReturnType<typeof createOwnedBusinessQuotaKeeper>['bind']>;
export type BoundBusiness={coordinator:Coordinator;jobKeeper:Keeper;reviewKeeper:Keeper};
export function createBusinessPhase(runtime:Runtime,bind:(actor:Actor,original:FastifyRequest,input:PhaseInput)=>Promise<BoundBusiness>){
 const custody=new WeakMap<object,{actor:Actor;coordinator:Coordinator;input:PhaseInput;original:FastifyRequest;jobKeeper:Keeper;reviewKeeper:Keeper}>();
 const get=(handle:object)=>{const x=custody.get(handle);assert(x,'business-private-handle');return x;};
 return{
 async open(original:FastifyRequest,input0:PhaseInput){const input=structuredClone(input0);const ids=[input.uploadAllocation,input.jobAllocation,input.reviewAllocation].flatMap(x=>[x.requestId,x.reservationId]);assert(new Set(ids).size===6,'business-distinct-owned-allocations');assert(input.uploadAllocation.kind==='upload'&&input.jobAllocation.kind==='job'&&input.reviewAllocation.kind==='review'&&input.jobAllocation.ceiling.raw===0&&input.reviewAllocation.ceiling.raw===0,'business-owned-kind');assert(input.witnessId!==input.jobId&&ids.every(id=>id!==input.witnessId),'business-separate-witness');const actor=runtime.capture(original),before={tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null,role:actor.role};const bound=await bind(actor,original,input),coordinator=bound.coordinator;assert.deepEqual({tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null,role:actor.role},before,'business-capture-changed');const handle=Object.freeze({schema:'private-business-phase/v1'});custody.set(handle,{actor,coordinator,input,original,jobKeeper:bound.jobKeeper,reviewKeeper:bound.reviewKeeper});return handle;},
 async prepare(handle:object){const x=get(handle);return x.coordinator.prepare(x.actor,{jobId:x.input.jobId,...x.input.retained,config:x.input.config});},
 async approveFile(handle:object,planHash:string,confirmed:boolean){assert(confirmed===true,'business-file-explicit-consent');const x=get(handle);return x.coordinator.approve(x.actor,x.input.jobId,planHash);},
 async previewAll(handle:object){const x=get(handle),j=await x.coordinator.inspect(x.actor,x.input.jobId);assert(j.approved,'business-file-consent-required');for(let n=0;n<j.core.length;n++)await x.coordinator.previewCore(x.actor,j.id,n);return x.coordinator.reviewCoreFile(x.actor,j.id);},
 async approveWholeCore(handle:object,scopeHash:string,confirmed:boolean){assert(confirmed===true,'business-whole-core-explicit-consent');const x=get(handle);return x.coordinator.consentCoreFile(x.actor,x.input.jobId,scopeHash);},
 async executeBatch(handle:object,index:number,previewId:string,scopeHash:string,confirmed:boolean){assert(confirmed===true,'business-core-batch-explicit-consent');const x=get(handle);await x.coordinator.consentCore(x.actor,x.input.jobId,index,previewId,scopeHash);return x.coordinator.executeCore(x.actor,x.input.jobId,index);},
 async recoverCore(handle:object,index:number){const x=get(handle);return x.coordinator.executeCore(x.actor,x.input.jobId,index);},
 async stagePim(handle:object,index:number,mapping:unknown){const x=get(handle);const j=await x.coordinator.inspect(x.actor,x.input.jobId),prior=j.pim[index]?.at(-1);if(prior){assert.deepEqual(prior.mapping,mapping,'business-original-pim-mapping');}else await x.coordinator.newPimAttempt(x.actor,j.id,index,structuredClone(mapping));return x.coordinator.stagePim(x.actor,j.id,index);},
 async previewPim(handle:object,index:number){const x=get(handle);return x.coordinator.previewPim(x.actor,x.input.jobId,index);},
 async applyPim(handle:object,index:number,id:string,scopeHash:string,confirmed:boolean){assert(confirmed===true,'business-pim-separate-explicit-consent');const x=get(handle);await x.coordinator.consentPim(x.actor,x.input.jobId,index,id,scopeHash);return x.coordinator.applyPim(x.actor,x.input.jobId,index);},
 async recoverPim(handle:object,index:number){const x=get(handle);return x.coordinator.applyPim(x.actor,x.input.jobId,index);},
 async inspect(handle:object){const x=get(handle);return x.coordinator.inspectCoreReview(x.actor,x.input.jobId);},
 async finish(handle:object,observed:readonly Invocation[]){const x=get(handle),j:Job=await x.coordinator.inspect(x.actor,x.input.jobId);assert(j.core.every((c,n)=>c.execution&&j.pim[n]?.at(-1)?.applied)&&Object.values(j.pim).flat().every(p=>!p.previewAttempted||p.preview)&&Object.values(j.pim).flat().every(p=>!p.applyAttempted||p.applied),'business-original-outcome-open');const known={job:await x.jobKeeper.closeKnown(x.input.jobCloseKey),review:await x.reviewKeeper.closeKnown(x.input.reviewCloseKey)};return{schema:'internal-business173-native-flow/v1',job:j,known_close:known,hooks:coverageMatrix(observed),business_native_budget:'ROOT_FULL_CURRENT_SNAPSHOT_REQUIRED',public_application_ready:false};},
 };
}
