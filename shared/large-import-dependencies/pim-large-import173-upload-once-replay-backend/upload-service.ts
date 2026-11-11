/** Existing HTTP callback shape with private claim/quota bridge. No routes, fallback reservation or default Actor. */
import assert from 'node:assert/strict';import {reconcileReadyUpload,verifyRetainedUploadReplay,type ReadyUploadReconciler} from './reconcile';import {AsyncLocalStorage} from 'node:async_hooks';
import {createAuthenticatedLargeImportUpload,snapshotSpec,type Ports,type UploadRequest,type Captured,type QuotaReservation} from '../pim-large-import173-runtime-fs-integration-backend2/upload';
import {createDurableUploadRegistry,type UploadClaim} from '../pim-large-import173-runtime-fs-integration-backend2/registry';
import type {Spec} from '../pim-large-import-stream-foundation-ui2/stream';
export type ReplayUploadPorts<A>=Omit<Ports<A>,'quotas'>&{quotas:Ports<A>['quotas']&{reserveOriginal(c:Captured,maxBytes:number):Promise<{kind:'new'|'retained';reservation:QuotaReservation}>}};
type Outcome=Parameters<Ports<object>['quotas']['close']>[1];
export function createRegisteredUploadService<A extends object>(actor:A,catalogId:string,input:ReplayUploadPorts<A>,registry:ReturnType<typeof createDurableUploadRegistry<A>>,plannedSpec:Spec,reconciler:ReadyUploadReconciler,originalKey:string){
 const spec=snapshotSpec(plannedSpec),ports={...input,quotas:{...input.quotas}},contexts=new AsyncLocalStorage<{claim:UploadClaim;active:boolean;retained:boolean;captured:Captured;reservation:QuotaReservation;outcome?:Outcome;unusedCleanup?:()=>Promise<void>}>();
 const uploader=createAuthenticatedLargeImportUpload({...ports,bytes:{...ports.bytes,prepareCleanup:async(a,handle)=>{const context=contexts.getStore();assert(context?.active,'upload-service-private-cleanup-context');const cleanup=await ports.bytes.prepareCleanup(a,handle);return{publishFailure:cleanup.publishFailure,retainUnused:async()=>{assert(context.active&&!context.unusedCleanup,'upload-service-one-unused-cleanup');context.unusedCleanup=cleanup.retainUnused;}};}},quotas:{
  reserve:async(captured,maxBytes)=>{const context=contexts.getStore();assert(context?.active&&JSON.stringify(captured.principal)===JSON.stringify(context.captured.principal)&&maxBytes===spec.limits!.maxFileBytes,'upload-service-exact-preallocated-quota');return structuredClone(context.reservation);},
  // Candidate upload cannot close ready before the durable registry's final charged ready bytes are committed/read back.
  close:async(reservation,outcome)=>{const context=contexts.getStore();assert(context?.active&&reservation.id===context.reservation.id&&!context.outcome,'upload-service-one-deferred-close');context.outcome=structuredClone(outcome);},
 }});
 const exact=(a:A)=>assert.equal(a,actor,'upload-service-original-actor');const catalog=(id:string)=>assert.equal(id,catalogId,'upload-service-exact-catalog');
 return{
  upload:{async retain(a:A,request:UploadRequest,chunks:AsyncIterable<Uint8Array>,signal?:AbortSignal){exact(a);const current=contexts.getStore();assert(current?.active&&!current.retained,'upload-service-durable-once-required');assert(JSON.stringify(snapshotSpec(request.spec))===JSON.stringify(spec),'upload-service-planned-spec');current.retained=true;return uploader.retain(actor,request,chunks,signal,current.claim);}},
  uploads:{
   async once(key:string,id:string,retain:()=>ReturnType<typeof uploader.retain>){catalog(id);assert.equal(key,originalKey,'upload-original-request-key');const captured=structuredClone(await ports.capture(actor)),admission=structuredClone(await ports.quotas.reserveOriginal(captured,spec.limits!.maxFileBytes!));
    assert(admission.kind==='new'||admission.kind==='retained','upload-original-admission-kind');
    if(admission.kind==='retained'){const original=await registry.inspect(actor,key,id);assert(JSON.stringify(snapshotSpec(original.spec))===JSON.stringify(spec),'upload-replay-exact-planned-spec');await ports.revalidate(actor,captured);await verifyRetainedUploadReplay(reconciler,actor,original);await ports.revalidate(actor,captured);return original;}
    const reservation=admission.reservation;let failed=false,first:unknown,value:Awaited<ReturnType<typeof uploader.retain>>|undefined,deferred:Outcome|undefined,unusedCleanup:(()=>Promise<void>)|undefined;
    try{value=await registry.once(actor,key,id,async claim=>{const current:{claim:UploadClaim;active:boolean;retained:boolean;captured:Captured;reservation:QuotaReservation;outcome?:Outcome;unusedCleanup?:()=>Promise<void>}={claim,active:true,retained:false,captured,reservation};try{const result=await contexts.run(current,retain);assert(current.retained,'upload-service-retention-callback-required');deferred=current.outcome;return result;}finally{unusedCleanup=current.unusedCleanup;current.active=false;}});}catch(e){failed=true;first=e;}
    // Registry ready publication/readback precedes making the unused private allocation unknown. No new intent follows it.
    if(unusedCleanup)try{await unusedCleanup();}catch(e){try{ports.cleanupFailure('quarantine');}catch{}if(!failed){failed=true;first=e;}}
    // Actual Root quota port independently checks all pending/orphan/transient resources before known close.
    const outcome:Outcome=failed?{outcome:'unknown',acknowledged_bytes:0,raw:null}:deferred??{outcome:'ready',acknowledged_bytes:value!.raw.byte_count,raw:structuredClone(value!.manifest.raw)};
    try{if(!failed&&value)await reconcileReadyUpload(reconciler,actor);else await ports.quotas.close(reservation,{...outcome,outcome:'unknown'});}catch(e){try{ports.cleanupFailure('reservation-close');}catch{}if(!failed){failed=true;first=e;}}
    if(failed)throw first;return value!;
   },
   inspect(key:string,id:string){catalog(id);return registry.inspect(actor,key,id);},
   async inspectRetained(key:string,id:string){catalog(id);assert.equal(key,originalKey,'upload-readback-original-request-key');const ready=await registry.inspect(actor,key,id);await verifyRetainedUploadReplay(reconciler,actor,ready);return ready;},
   owned(blob:string,id:string){catalog(id);return registry.owned(actor,blob,id);},
   recoverExact(key:string,id:string){catalog(id);return registry.recoverExact(actor,key,id);},
  },
 };
}
