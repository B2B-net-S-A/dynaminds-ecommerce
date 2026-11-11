/** Actual producer composition for the internal Root phase. No default pools, authority, profile, quota policy or activation. */
import assert from'node:assert/strict';import{createHash}from'node:crypto';
import type{FastifyRequest}from'fastify';import type{Actor}from'../../../server/domain';
import{createHookedLargeImportRuntime}from'../../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/runtime';
import{createDedicatedMetadataTransport,type Ports as TransportPorts}from'../../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import{createMetadataMutationHooks,type MutationHooks}from'../../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/hooks';
import{createBoundRawPort,type BoundRawPort}from'../../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/raw-port';
import{createQuotaRawStore}from'../../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/store';
import{createPrivateWitnessStore}from'../../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/witness';
import{createPublicationAuthorityFactory}from'../../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/authority';
import type{NativeQuota}from'../../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/publisher';
import{createNativeResourceGroupBroker,attachNativeResourceGroups}from'../pim-large-import173-bounded-native-groups-backend/groups';
import{createUploadQuotaBroker,type Inventory}from'../pim-large-import-upload-quota-broker-backend3/broker';
import{createNativePimDriver,type DriverPorts}from'../pim-large-import-native-pim-driver-ui/driver';
import{createCoreEligibilityProducer,type Backend as EligibilityBackend}from'../pim-large-import-core-eligibility-backend/producer';
import{createCoreCapacityProducer}from'./capacity';import{createNativeCoreDriver,type NativeCoreModule}from'./core-driver';
import{createOwnedBusinessQuotaKeeper}from'./owned-keeper';import type{PortsKeeper}from'../pim-large-import-quota-terminal-reconcile-backend2/keeper';
import{createBusinessPhase,type PhaseInput}from'./flow';import{phaseKey}from'../pim-large-import-job-coordinator-backend5/coordinator';
export type ActualBusinessModule=NativeCoreModule&EligibilityBackend&Parameters<typeof createCoreCapacityProducer>[1];
/** Structural contract of Root createRouteTasks; registration happens synchronously before work. */
export type OwnedBusinessTasks={run<T>(label:string,work:()=>Promise<T>):Promise<T>;isShuttingDown():boolean};
export type CompositionPorts={
 tasks:OwnedBusinessTasks;
 /** Independently compiled/certified NEW12/38 graph, not installed12/34 handle. Must check exact adopted source graph before invocation. */
 assertBusinessSourceAndNativeProfile():Promise<void>;
 transport:TransportPorts;keeper:PortsKeeper;root:string;
 native:ActualBusinessModule;
 pim:Omit<DriverPorts,'evidence'>;
 coreAvailable():boolean;
 validateCatalog(actor:Actor,id:string):Promise<void>;
 /** Not called for ready close; required for genuine unknown inventory/reconciliation, never supplied positive fake facts. */
 inventory(actor:Actor,kind:'job'|'review'):Inventory;
 /** Saved full raw HTTP/native snapshots are the proof; this observer is diagnostic only. */
 observeOperation(operation:string):void;
};
const principal=(a:Actor)=>({tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:a.role});
/** Factory/import does not connect, execute, create files or mint readiness. Root explicitly calls engine commands. */
function constructInternalBusinessEngine(input:CompositionPorts){
 const config={...input.transport},prepared=new WeakMap<Actor,{original:FastifyRequest;raw:BoundRawPort;mutations:MutationHooks}>(),publication=createPublicationAuthorityFactory(config),module={...input.native};
 const runtime=createHookedLargeImportRuntime(config,(actor,original)=>{const p=prepared.get(actor);assert(p&&p.original===original,'business-private-runtime-prepared');return{raw:p.raw,mutations:p.mutations};});
 return createBusinessPhase(runtime,async(actor,original,phase:PhaseInput)=>{
  await input.assertBusinessSourceAndNativeProfile();assert(typeof module.inspectCoreBatchEligibilityInTx==='function'&&typeof module.inspectCoreImportCapacityInTx==='function','business-actual-core-exports');await input.validateCatalog(actor,phase.catalogId);
  const{scope,ports}=runtime.metadataBinding(actor);
  const fresh=async()=>{let c:Awaited<ReturnType<typeof ports.connect>>|undefined,failed=false,first:unknown;try{c=await ports.connect(scope);await ports.admit(c,scope);}catch(e){failed=true;first=e;}finally{if(c)try{await c.end();}catch(e){try{ports.cleanupFailure(e);}catch{}if(!failed){failed=true;first=e;}}}if(failed)throw first;};
  const makeQuota=(kind:'job'|'review')=>{const broker=createUploadQuotaBroker(config),captured=broker.capture(original);assert.deepEqual(principal(captured),principal(actor));return broker.bind(captured,kind==='job'?phase.jobAllocation:phase.reviewAllocation,input.inventory(actor,kind));};
  const job=makeQuota('job'),review=makeQuota('review');await job.quotas.reserve(job.captured,0);await review.quotas.reserve(review.captured,0);
  const groupBroker=createNativeResourceGroupBroker(config),groupActor=groupBroker.capture(original);
  assert.deepEqual(principal(groupActor),principal(actor),'business-group-original-principal');
  const grouped=new WeakMap<typeof job,NativeQuota>();
  const nativeQuota=(q:typeof job):NativeQuota=>{
   assert(q===job||q===review,'business-original-allocation-broker');
   const existing=grouped.get(q);if(existing)return existing;
   const allocation=q===job?phase.jobAllocation:phase.reviewAllocation;
   const scalar={intent:q.intent,settle:q.settle,snapshot:q.snapshot,
    unknown:()=>q.quotas.close({id:allocation.reservationId},{outcome:'unknown',acknowledged_bytes:0,raw:null})};
   const actual=attachNativeResourceGroups(scalar,groupBroker.bind(groupActor,allocation));
   grouped.set(q,actual);return actual;
  };
  const jobHook=createMetadataMutationHooks({quota:nativeQuota(job),admit:fresh,cleanupFailure:config.cleanupFailure}),reviewHook=createMetadataMutationHooks({quota:nativeQuota(review),admit:fresh,cleanupFailure:config.cleanupFailure});
  const mutations:MutationHooks={perform:async(op,key,resources,write,inspect)=>{const value=await(op==='review-append-bindings'?reviewHook:jobHook).perform(op,key,resources,write,inspect);input.observeOperation(op);return value;},prepareCleanup:jobHook.prepareCleanup,cleanup:async(...args)=>{await jobHook.cleanup(...args);input.observeOperation('job-lease-release');}};
  const pub=(kind:'job'|'review')=>{const owned=kind==='job'?phase.jobAllocation:phase.reviewAllocation,q=kind==='job'?job:review,authority=publication.bind(actor,original,owned,ports);return{root:input.root,publication:authority,cleanupFailure:config.cleanupFailure,authorize:async(a:Actor)=>{assert.equal(a,actor,'business-publication-original-actor');const x=await q.snapshot();assert(x.reservation.id===owned.reservationId&&x.reservation.tenant_id===actor.tenantId&&x.reservation.actor_id===actor.userId&&x.reservation.api_key_id===(actor.apiKeyId??null));return{scope:{tenantId:actor.tenantId,actorId:actor.userId,apiKeyId:actor.apiKeyId??null},reservationId:owned.reservationId,quota:nativeQuota(q)};}};};
  const raw=createBoundRawPort(createQuotaRawStore({...pub('job'),validateCatalog:input.validateCatalog}),actor),witness=createPrivateWitnessStore(pub('review'));prepared.set(actor,{original,raw,mutations});
  const save=async(_kind:string,bytes:Uint8Array)=>{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),ref=await witness.save(actor,phase.witnessId,value);const saved=await witness.read(actor,phase.witnessId,ref.sha256);assert.equal(createHash('sha256').update(JSON.stringify(saved)).digest('hex'),ref.sha256,'business-actual-witness-readback');assert.equal(ref.sha256,createHash('sha256').update(bytes).digest('hex'),'business-exact-native-witness');input.observeOperation('private-witness-append');return ref;};
  const capacity=createCoreCapacityProducer(config,module,{save}),eligibility=createCoreEligibilityProducer(config,module,{save});const ca=capacity.capture(original),ea=eligibility.capture(original);assert.deepEqual(principal(ca),principal(actor));assert.deepEqual(principal(ea),principal(actor));const cap=capacity.bind(ca),eligible=eligibility.bind(ea);
  const core=createNativeCoreDriver(module,{available:input.coreAvailable,readOnly:input.pim.service.readOnly,evidence:{save}}).bind(actor,original,phase.catalogId),pim=createNativePimDriver({...input.pim,evidence:{save}}).bind(actor,original,phase.catalogId);
  const bound=runtime.bind(actor,raw,{authority:async a=>{assert.equal(a,actor);await fresh();return scope;},capacity:async(a,q)=>{assert.equal(a,actor);return cap(ca,q);},validateCoreBatch:async(a,q)=>{assert.equal(a,actor);return eligible(ea,q);},core,pim});
  const keeper=createOwnedBusinessQuotaKeeper(input.keeper),ja=keeper.capture(original),ra=keeper.capture(original);assert.deepEqual(principal(ja),principal(actor));assert.deepEqual(principal(ra),principal(actor));
  const jkeep=keeper.bind(ja,phase.jobAllocation,phase.jobId),rkeep=keeper.bind(ra,phase.reviewAllocation,phase.jobId);
  // Witness lock deletion was physically performed by the publisher. Only actual original absent-lock release receipts remove its conservative charge.
  const reviewKeeper={...rkeep,closeKnown:async(key:string)=>{const snapshot=await review.snapshot();for(const resource of snapshot.resources){if(/^blob:fs:witnesses:[a-f0-9-]{36}:lock:[a-f0-9-]{36}$/.test(resource.resource_key)&&resource.state!=='released')await rkeep.releaseWitnessLock(resource.resource_key,phaseKey(phase.jobId,createHash('sha256').update(resource.resource_key).digest('hex'),0,'business-witness-lock-release'));}return rkeep.closeKnown(key);}};
  return{coordinator:bound.coordinator,jobKeeper:jkeep,reviewKeeper};
 });
}

type BusinessEngine=ReturnType<typeof constructInternalBusinessEngine>;
/** Fixed source-owned command wrappers; no new handle/Actor/callback authority. */
function beginTrackedBusinessConstruction(input:CompositionPorts){
 const tasks=input.tasks,run=tasks.run,isShuttingDown=tasks.isShuttingDown;
 assert(typeof run==='function'&&typeof isShuttingDown==='function','business-owned-task-ledger-required');
 assert(!isShuttingDown(),'business-owned-task-ledger-closing');
 let constructed:BusinessEngine|undefined;
 const construction=run('business:construction',async()=>{constructed=constructInternalBusinessEngine(input);return constructed;});
 // Root ledger records construction failure; this prevents an unobserved rejection before first command.
 void construction.catch(()=>{});
 function command<K extends keyof BusinessEngine>(name:K):BusinessEngine[K]{
  return ((...args:Parameters<BusinessEngine[K]>)=>run('business:'+name,async()=>{
   // Preserve original method synchronous capture/detach before its first await.
   const actual=constructed??await construction;
   const invoke=actual[name] as (...values:Parameters<BusinessEngine[K]>)=>ReturnType<BusinessEngine[K]>;
   return invoke(...args);
  })) as BusinessEngine[K];
 }
 const engine:BusinessEngine=Object.freeze({open:command('open'),prepare:command('prepare'),approveFile:command('approveFile'),
  previewAll:command('previewAll'),approveWholeCore:command('approveWholeCore'),executeBatch:command('executeBatch'),
  recoverCore:command('recoverCore'),stagePim:command('stagePim'),previewPim:command('previewPim'),
  applyPim:command('applyPim'),recoverPim:command('recoverPim'),inspect:command('inspect'),finish:command('finish')});
 return{engine,construction};
}
/** Existing synchronous command-wrapper API; original command capture ordering is unchanged. */
export function createInternalBusinessEngine(input:CompositionPorts):BusinessEngine{
 return beginTrackedBusinessConstruction(input).engine;
}
/** Source-owned completion barrier; no caller Promise, JSON-ready fact or new ledger task. */
export async function createReadyInternalBusinessEngine(input:CompositionPorts):Promise<BusinessEngine>{
 const{engine,construction}=beginTrackedBusinessConstruction(input);
 await construction;
 return engine;
}

/** Root-facing second-phase constructor: only real CLOSED first-lane evidence, then genuine source/DB transition binding. */
export async function createAcceptedInternalBusinessEngine(input:CompositionPorts&{
 firstPhase:{result:import('./first-phase.mjs').Ref;peer:import('./first-phase.mjs').Ref};
 /** Root-owned saved baseline+current12/38 installation/adoption verification; no boolean readiness shortcut. */
 verifyAcceptedFirstPhase(fact:import('./first-phase.mjs').AcceptedPhysicalPhase):Promise<void>;
}){
 return input.tasks.run('business:accepted-construction',async()=>{
 const{admitClosedPhysicalPhase}=await import('./first-phase.mjs');
 const refs=structuredClone(input.firstPhase),accepted=await admitClosedPhysicalPhase(refs.result,refs.peer);
 await input.verifyAcceptedFirstPhase(accepted);await input.assertBusinessSourceAndNativeProfile();
 return{accepted,engine:await createReadyInternalBusinessEngine(input)};
 });
}
