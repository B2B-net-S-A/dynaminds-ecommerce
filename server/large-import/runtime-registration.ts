import {registerFinalizationStatus,type FinalizationStatusPort} from './finalization-status-routes';
/** Real registered runtime composition. Export-only: no pool, listen, actor creation or fallback runtime. */
import assert from 'node:assert/strict';
import {assertRegisteredFilesystem,type RegisteredFilesystem} from './registered-filesystem';
import type {ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/api';
import {z} from 'zod';
import type {Actor} from '../domain';
import {assertOriginalMetadataBinding} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import {ensure} from '../errors';
import {createLargeImportApplication as createBase,type NativeDrivers as BaseDrivers} from './base-application';
import {createRegisteredRuntimeFactory,type HookFactory} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/runtime';
import {assertBoundRawPort,type BoundRawPort} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/raw-port';
import type {MutationHooks} from '../../shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/hooks';
import {createNativePimDriver,type DriverPorts} from '../../shared/large-import-dependencies/pim-large-import-native-pim-driver-ui/driver';
import {createOwnedDoneCoreList} from '../../shared/large-import-dependencies/pim-large-import-native-pim-driver-ui/owned-list';
import {registerOwnedDoneCoreList} from '../../shared/large-import-dependencies/pim-large-import-native-pim-driver-ui/list-routes';
import type {ReadPorts} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/readonly-store';
import {createOwnedJobHistory} from './owned-job-history';
import {registerOwnedJobHistory} from './job-history-routes';
type ActorPorts=Awaited<ReturnType<BaseDrivers['forActor']>>;
type OriginalRequest=Parameters<BaseDrivers['forActor']>[1];
type OriginalMetadataBinding=Parameters<BaseDrivers['forActor']>[2];
export type PreparedActorPorts=Omit<ActorPorts,'raw'|'business'>&{
 filesystem:RegisteredFilesystem;raw:BoundRawPort;mutations:MutationHooks;
 /** Genuine actual CORE/eligibility/current authority/clock/keys; PIM is supplied exclusively by the real service adapter below. */
 business:Omit<ActorPorts['business'],'pim'>;
 pim:DriverPorts;
};
export type RegistrationPorts=Pick<BaseDrivers,'startup'|'transport'|'registry'>&{
 /** Prepare actual owned ports only; receives the genuine captured metadata Actor and SAME original authenticated request. */
 forActor(actor:Actor,original:OriginalRequest,metadataBinding:OriginalMetadataBinding):Promise<PreparedActorPorts>;
 /** Required genuine current173 read capture/admit, dedicated RR client and certified owner gate. */
 reader:ReadPorts;
 tenantAvailability?:BaseDrivers['tenantAvailability'];
 finalizationStatus?:FinalizationStatusPort;
};
/** Synchronously snapshot preparation inputs, before any readiness/profile await. Private bridge owns same raw/hooks/request. */
export function createActorBridge(prepare:RegistrationPorts['forActor'],readOnly:boolean,startup:ReviewedStartup){
 const producer=prepare,seen=new WeakSet<Actor>(),held=new WeakMap<Actor,{original:OriginalRequest;raw:BoundRawPort;mutations:MutationHooks}>();
 const hooks:HookFactory=(a,r)=>{const p=held.get(a);assert(p&&p.original===r,'registered-original-request-bridge');assertBoundRawPort(p.raw,a);return{raw:p.raw,mutations:p.mutations};};
 const forActor:BaseDrivers['forActor']=async(a,r,metadataBinding)=>{
  assertOriginalMetadataBinding(metadataBinding.ports,r,a);
  assert(!seen.has(a),'registered-actor-preparation-reused');seen.add(a);const principal={tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:a.role},cookies=Object.setPrototypeOf(structuredClone(r.cookies),Object.getPrototypeOf(r.cookies)),authorization=r.headers.authorization;assert.deepEqual({tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:a.role},{tenantId:r.actor.tenantId,userId:r.actor.userId,apiKeyId:r.actor.apiKeyId??null,role:r.actor.role},'registered-original-principal');
  const catalog=z.object({catalog_id:z.uuid()}).parse(r.params).catalog_id;
  const p=await producer(a,r,metadataBinding);assertOriginalMetadataBinding(metadataBinding.ports,r,a);assert.deepEqual({tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:a.role},principal,'registered-principal-changed');assert.deepEqual(r.cookies,cookies,'registered-cookie-custody-changed');assert.equal(r.headers.authorization,authorization,'registered-key-custody-changed');assertBoundRawPort(p.raw,a);assertRegisteredFilesystem(p.filesystem,a,r,startup,p.raw);assert(p.mutations&&typeof p.mutations.perform==='function'&&typeof p.mutations.prepareCleanup==='function'&&typeof p.mutations.cleanup==='function','registered-required-mutation-hooks');
  assert.equal(z.object({catalog_id:z.uuid()}).parse(r.params).catalog_id,catalog,'registered-catalog-custody-changed');
  assert(!Object.hasOwn(p.business,'pim'),'registered-no-pim-fallback');ensure(p.pim.service.readOnly===readOnly,503,'Inny tryb kopii PIM');
  const pim=createNativePimDriver(p.pim).bind(a,r,catalog);
  // No metadata Actor is supplied to PIM private custody: its driver captures from original request separately.
  held.set(a,{original:r,raw:p.raw,mutations:p.mutations});
  return{raw:p.raw,business:{...p.business,pim},upload:p.upload,uploads:p.uploads,witness:p.witness,...(p.finalize?{finalize:p.finalize}:{})};
 };
 return{hooks,forActor};
}
export async function createRegisteredLargeImportApplication(input:RegistrationPorts|undefined,readOnly:boolean){
 let base:Awaited<ReturnType<typeof createBase>>,readPorts:ReadPorts|undefined,finalizationStatus:FinalizationStatusPort|undefined;
 if(!input)base=await createBase(undefined,readOnly);
 else{
  const startup=input.startup,transport={...input.transport},registry=input.registry,prepare=input.forActor,reader={...input.reader};
  ensure(typeof prepare==='function'&&typeof reader.capture==='function'&&typeof reader.connect==='function'&&typeof reader.admit==='function'&&typeof reader.cleanupFailure==='function',503,'Brak rzeczywistych portów zapisów lub własnego odczytu');
  const bridge=createActorBridge(prepare,readOnly,startup);
  // ONLY this reviewed factory: rejects fabricated handles and remains false without exact native wiring/inventory proof.
  const runtimeFactory=await createRegisteredRuntimeFactory(registry,bridge.hooks);
  if(runtimeFactory===false)base=await createBase(undefined,readOnly);
  else{base=await createBase({startup,transport,registry,runtimeFactory,forActor:bridge.forActor,reader,...(input.tenantAvailability?{tenantAvailability:input.tenantAvailability}:{})},readOnly);readPorts=reader;finalizationStatus=input.finalizationStatus;}
 }
 const originalRegister=base.register,available=base.available,independentCreates=base.independentCreates;
 const reader=readPorts?createOwnedDoneCoreList(readPorts):{async list(){throw Error('registered-reader-unavailable');}};
 const history=readPorts?createOwnedJobHistory(readPorts):{async list(){throw Error('registered-history-unavailable');}};
 return{available,independentCreates,tenantAvailability:base.tenantAvailability,async register(app:Parameters<typeof originalRegister>[0]){
  await originalRegister(app);
  await registerOwnedDoneCoreList(app,{certified:async()=>available&&!!readPorts,reader});
  await registerOwnedJobHistory(app,{certified:async()=>available&&!!readPorts,reader:history});
  await registerFinalizationStatus(app,{certified:async()=>available&&!!readPorts,read:finalizationStatus});
 }};
}
