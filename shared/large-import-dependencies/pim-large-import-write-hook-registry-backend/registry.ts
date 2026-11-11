/** Server-only source candidate. No default pool, credential construction, SQL or startup side effects. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {OPERATIONS,HOOKS,NATIVE_DRIVERS,RETAINED_AREAS,type Operation,type Hook,type NativeDriver} from './inventory';
import {executeWriteGroup,type GroupInput,type GroupDriver,type QuotaGroupPort} from './group';
export type Ref={path:string;sha256:string};
export type SourceBinding={id:string;sources:Ref[];manifest:Ref;source_peer:Ref};
export type MutationBinding<A extends object,R extends object>={
 source:SourceBinding;operations:Operation[];
 /** Wrap ACTUAL call sites. The source peer/native proof must verify this wrapper is used, not merely present. */
 bind(actor:A,originalRequest:R):{
  quota:QuotaGroupPort;admit():Promise<void>;
  plan(operation:Operation,input:unknown):Promise<GroupInput>;
  write(operation:Operation,input:unknown):Promise<void>;
  inspect(operation:Operation,input:unknown):Promise<Awaited<ReturnType<GroupDriver<unknown>['inspect']>>>;
 };
};
export type NativeBinding={source:SourceBinding;driver:NativeDriver};
export type Readiness={ready:true;hooks:readonly Hook[];independentCreates:boolean;source_bindings_sha256:string;native_proof:Ref;inventory:Ref};
declare const registryBrand:unique symbol;
export type WriteHookRegistry={readonly [registryBrand]:true};
type Held={bindings_hash:string;sources:SourceBinding[];operations:Map<Operation,string>;native:Map<NativeDriver,string>;evidence?:Ref;inventory():Promise<Ref>};
const registries=new WeakMap<object,Held>();
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
function ref(r:Ref){assert(r&&isAbsolute(r.path)&&r.path===resolve(r.path)&&/^[a-f0-9]{64}$/.test(r.sha256),'hook-canonical-ref');}
async function bytes(r:Ref,privateMode=false){ref(r);const stat=await lstat(r.path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'hook-regular-single-link');if(privateMode)assert((stat.mode&0o777)===0o600,'hook-private-evidence');assert(stat.size<=32*1024*1024,'hook-bounded-evidence');const b=await readFile(r.path);assert(sha(b)===r.sha256,'hook-ref-sha');const after=await lstat(r.path);assert(after.dev===stat.dev&&after.ino===stat.ino&&after.size===stat.size&&after.mtimeMs===stat.mtimeMs&&after.mode===stat.mode&&after.nlink===1,'hook-evidence-changed-during-read');return b;}
const json=async(r:Ref,privateMode=false)=>JSON.parse((await bytes(r,privateMode)).toString('utf8'));
function exactSet(a:unknown,wanted:readonly string[]){assert(Array.isArray(a)&&a.every(x=>typeof x==='string')&&a.length===wanted.length&&new Set(a).size===a.length&&wanted.every(x=>a.includes(x)),'hook-exact-inventory');}
function sameRef(a:Ref,b:Ref){return a.path===b.path&&a.sha256===b.sha256;}
function sourceBinding(b:SourceBinding){assert(/^[a-z0-9:-]{1,100}$/.test(b.id)&&b.sources.length>0,'hook-source-binding');ref(b.manifest);ref(b.source_peer);const paths=new Set<string>();for(const r of b.sources){ref(r);assert(!paths.has(r.path),'hook-source-duplicate');paths.add(r.path);}}
async function checkSource(s:SourceBinding){const manifest=await json(s.manifest),peer=await json(s.source_peer);assert(peer.status==='SOURCE_ACK_NOT_RUN'&&peer.pins_sha256===s.manifest.sha256&&Array.isArray(peer.blockers)&&peer.blockers.length===0,'hook-canonical-source-peer');assert(Array.isArray(manifest.files),'hook-source-manifest');for(const r of s.sources){assert(manifest.files.some((x:Ref)=>sameRef(x,r)),'hook-source-not-in-manifest');await bytes(r);}}
/** Returned registry exposes no JSON readiness setter. Only its exact closed bindings can be inspected. */
export function createWriteHookRegistry<A extends object,R extends object>(input:{
 capture(originalRequest:R):A;
 mutations:MutationBinding<A,R>[];native:NativeBinding[];
 /** Fresh complete actual inventory, all pending/orphan/quarantine categories included. */
 inventory():Promise<Ref>;
 /** Future genuine saved native wiring peer, not a caller-provided ready flag. Absent => unavailable. */
 evidence?:Ref;
}){
 const capture=input.capture,inventory=input.inventory,evidence=input.evidence?structuredClone(input.evidence):undefined;
 if(evidence)ref(evidence);
 const byOperation=new Map<Operation,{source:SourceBinding;bind:MutationBinding<A,R>['bind']}>(),byNative=new Map<NativeDriver,SourceBinding>(),sources:SourceBinding[]=[];
 for(const b of input.mutations){const s=structuredClone(b.source);sourceBinding(s);sources.push(s);assert(typeof b.bind==='function'&&b.operations.length>0,'hook-mutation-binding');for(const op of [...b.operations]){assert(Object.hasOwn(OPERATIONS,op)&&!byOperation.has(op),'hook-duplicate-or-unknown-operation');byOperation.set(op,{source:s,bind:b.bind});}}
 for(const b of input.native){const s=structuredClone(b.source);sourceBinding(s);sources.push(s);assert(NATIVE_DRIVERS.includes(b.driver)&&!byNative.has(b.driver),'hook-native-driver-binding');byNative.set(b.driver,s);}
 const unique=new Map<string,SourceBinding>();for(const s of sources){const old=unique.get(s.id);assert(!old||JSON.stringify(old)===JSON.stringify(s),'hook-conflicting-source-id');unique.set(s.id,s);}
 const descriptors={schema:'large-import-write-hook-bindings/v1',sources:[...unique.values()].sort((a,b)=>a.id.localeCompare(b.id)),operations:[...byOperation].map(([operation,b])=>({operation,binding_id:b.source.id})).sort((a,b)=>a.operation.localeCompare(b.operation)),native_drivers:[...byNative].map(([driver,s])=>({driver,binding_id:s.id})).sort((a,b)=>a.driver.localeCompare(b.driver))};
 const handle=Object.freeze({}) as WriteHookRegistry;
 registries.set(handle,{bindings_hash:sha(JSON.stringify(descriptors)),sources:[...unique.values()],operations:new Map([...byOperation].map(([op,b])=>[op,b.source.id])),native:new Map([...byNative].map(([op,b])=>[op,b.id])),evidence,inventory});
 const actors=new WeakMap<A,R>();
 return {registry:handle,bindings:structuredClone(descriptors),
  capture(originalRequest:R){assert(originalRequest&&typeof originalRequest==='object','hook-original-request');const actor=capture(originalRequest);assert(actor&&typeof actor==='object','hook-original-actor');assert(!actors.has(actor),'hook-capture-reused-actor');actors.set(actor,originalRequest);return actor;},
  bind(actor:A){const originalRequest=actors.get(actor);assert(originalRequest,'hook-captured-original-actor-required');const bound=new Map<string,ReturnType<MutationBinding<A,R>['bind']>>();
   for(const b of byOperation.values())if(!bound.has(b.source.id)){const raw=b.bind(actor,originalRequest);bound.set(b.source.id,{quota:{intent:raw.quota.intent,settle:raw.quota.settle,unknown:raw.quota.unknown},admit:raw.admit,plan:raw.plan,write:raw.write,inspect:raw.inspect});}
   return {async execute(operation:Operation,inputValue:unknown){const selected=byOperation.get(operation);assert(selected,'hook-operation-not-registered');const b=bound.get(selected.source.id)!;
    // structuredClone detaches Uint8Array/Buffer bytes synchronously before planner awaits.
    const owned=structuredClone(inputValue);await b.admit();const plan=structuredClone(await b.plan(operation,structuredClone(owned)));assert(plan.operation===operation,'hook-plan-operation');
    return executeWriteGroup(plan,b.quota,{admit:b.admit,write:()=>b.write(operation,structuredClone(owned)),inspect:()=>b.inspect(operation,structuredClone(owned))});
   }};
  },
 };
}
/** Activation consumes private independently verified native facts. The candidate has no such installed evidence yet. */
export async function inspectReadiness(registry:WriteHookRegistry):Promise<Readiness|false>{
 const held=registries.get(registry);assert(held,'hook-private-registry-handle');
 if(held.operations.size!==Object.keys(OPERATIONS).length||held.native.size!==NATIVE_DRIVERS.length||!held.evidence)return false;
 // Pin all actual registered implementations through their own exact manifest and canonical source peer.
 for(const s of held.sources)await checkSource(s);
 const report=await json(held.evidence,true);
 assert(report.status==='SAVED_WRITE_HOOK_WIRING_VERIFIED'&&report.runtime_pass===true&&report.source_bindings_sha256===held.bindings_hash,'hook-native-wiring-proof');
 const checker=structuredClone(report.checker_source) as SourceBinding;sourceBinding(checker);await checkSource(checker);
 // The independently reviewed checker is a future required producer. No synthetic successful checker is shipped here.
 assert(report.aliases_failed_to_pass===false&&report.error===null&&Array.isArray(report.cleanup_errors)&&report.cleanup_errors.length===0&&report.all_clients_closed===true,'hook-native-proof-closure');
 const result=await json(report.result,true),terminal=await json(report.terminal,true);
 assert(result.status==='ROOT_LARGE_IMPORT_WRITE_HOOKS_CLOSED_PASS'&&result.error===null&&result.source_bindings_sha256===held.bindings_hash&&result.all_clients_closed===true&&Array.isArray(result.cleanup_errors)&&result.cleanup_errors.length===0,'hook-native-result');
 assert(terminal.ok===true&&terminal.exit_code===0&&sameRef(terminal.result,report.result)&&Array.isArray(terminal.artifacts),'hook-native-terminal');
 exactSet(result.operation_coverage.map((r:any)=>r.operation),Object.keys(OPERATIONS));exactSet(result.native_drivers.map((r:any)=>r.driver),NATIVE_DRIVERS);
 for(const coverage of [...result.operation_coverage,...result.native_drivers]){
  const expectedId:string|undefined=coverage.operation?held.operations.get(coverage.operation):held.native.get(coverage.driver);assert(expectedId===coverage.binding_id,'hook-native-callback-binding');
  const names=coverage.operation?['intent_before_write','exact_readback','uncertain_ack_no_repeat']:['native_authority'];
  for(const name of names){const r=coverage[name] as Ref;ref(r);assert(terminal.artifacts.some((x:Ref)=>sameRef(x,r)),'hook-unindexed-native-witness');const witness=await json(r,true);
   assert(witness.schema==='large-import-write-hook-native-witness/v1'&&witness.binding_id===expectedId&&witness.operation===(coverage.operation??null)&&witness.driver===(coverage.driver??null)&&witness.predicate===name&&witness.verified===true,'hook-native-witness-shape');
  }
 }
 const inventoryRef=structuredClone(await held.inventory());const inventory=await json(inventoryRef,true);
 assert(inventory.schema==='large-import-retained-inventory/v1'&&inventory.complete===true&&inventory.quiescent===true&&inventory.pending===false&&inventory.unattributed===false&&inventory.source_bindings_sha256===held.bindings_hash,'hook-complete-retained-inventory');
 exactSet(inventory.areas,RETAINED_AREAS);assert(Array.isArray(inventory.resources),'hook-retained-resources');
 const ids=new Set<string>();for(const r of inventory.resources){assert(typeof r.id==='string'&&!ids.has(r.id)&&RETAINED_AREAS.includes(r.area)&&Number.isSafeInteger(r.byte_count)&&r.byte_count>=0&&/^[a-f0-9]{64}$/.test(r.sha256)&&r.quota_charged===true,'hook-retained-unaccounted-resource');ids.add(r.id);ref(r.witness);await bytes(r.witness,true);}
 assert(sameRef(report.inventory,inventoryRef)&&typeof result.independentCreates==='boolean','hook-current-inventory-proof-binding');
 // Rehash every consumed fact after asynchronous inventory verification. No Ref-path aliasing.
 for(const r of [held.evidence,report.result,report.terminal,inventoryRef,...terminal.artifacts])await bytes(r,true);
 for(const s of [...held.sources,checker]){await bytes(s.manifest);await bytes(s.source_peer);for(const r of s.sources)await bytes(r);}
 if(inventory.legacy_quarantines!==undefined){assert(inventory.legacy_quarantine_not_usable===true&&Array.isArray(inventory.legacy_quarantines));if(inventory.legacy_quarantines.length)assert(inventory.quarantine_scope?.usable===false&&inventory.quarantine_scope.outcomes_resolved===false&&Array.isArray(inventory.quarantine_scope.blocked_tenants)&&inventory.legacy_outcomes_resolved===false&&inventory.active_inventory_complete===true);for(const q of inventory.legacy_quarantines)assert(q.classification==='LEGACY_QUARANTINED_UNUSABLE'&&q.usable===false&&q.attributed===false&&!inventory.resources.some((r:any)=>r.id.startsWith(q.tenantId+':')),'hook-no-legacy-usable-resource');}
 return {ready:true,...(inventory.legacy_quarantines?.length?{readiness_scope:'ACTIVE_ATTRIBUTED_TENANTS_EXCLUDING_LEGACY_QUARANTINE' as const,excluded_tenants:Object.freeze([...inventory.quarantine_scope.blocked_tenants])}:{}),hooks:Object.freeze([...HOOKS]),independentCreates:result.independentCreates,source_bindings_sha256:held.bindings_hash,native_proof:structuredClone(held.evidence),inventory:inventoryRef};
}

/** Closed actual installed path catalogue. No legacy plan/write/inspect callbacks or registry.execute surrogate. */
export const FIXED_INSTALLED_SOURCE_PATHS=["server/large-import/legacy-quarantine.ts", "shared/large-import-dependencies/pim-large-import-http-binding-ui/readonly-store.ts", "shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/closed-proof.ts", "shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/terminal-quarantine.ts", "server/large-import/ordinary-installed-ports.ts", "shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/registry.ts","server/large-import/registered-filesystem.ts", "shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/installed-checker.ts", "shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/installed-census.ts", "shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/group.ts", "shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/publisher.ts", "shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/hooks.ts", "shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/runtime.ts", "shared/large-import-dependencies/pim-large-import173-runtime-fs-integration-backend2/storage.ts", "shared/large-import-dependencies/pim-large-import173-upload-once-replay-backend/upload-service.ts", "shared/large-import-dependencies/pim-large-import173-upload-once-replay-backend/reconcile.ts", "shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/authority.ts", "shared/large-import-dependencies/pim-large-import-core-eligibility-backend/producer.ts", "shared/large-import-dependencies/pim-large-import-business-native-proof-ui/core-driver.ts", "shared/large-import-dependencies/pim-large-import-native-pim-driver-ui/driver.ts", "shared/large-import-dependencies/pim-large-import-quota-terminal-reconcile-backend2/close-inspection.ts", "shared/large-import-dependencies/pim-large-import-business-native-proof-ui/owned-inspection.ts", "server/large-import/owned-allocation-custody.ts", "server/large-import/unallocated-upload-retirement.ts", "shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/terminal-absent.ts","server/large-import/charged-unknown-inspection.ts","server/large-import/quota-renewal-inspection.ts"] as const;
export async function createFixedInstalledWriteHookRegistry(input:{source:SourceBinding;inventory():Promise<Ref>;evidence?:Ref}){
 const source=structuredClone(input.source),inventory=input.inventory,evidence=input.evidence?structuredClone(input.evidence):undefined;assert(typeof inventory==='function','hook-fixed-inventory-callback');if(evidence)ref(evidence);sourceBinding(source);assert(source.id==='installed:fixed-engine-v1','hook-fixed-engine-id');assert(source.sources.length===FIXED_INSTALLED_SOURCE_PATHS.length,'hook-fixed-engine-complete-source');for(const path of FIXED_INSTALLED_SOURCE_PATHS)assert(source.sources.filter(r=>r.path.endsWith('/'+path)).length===1,'hook-fixed-engine-exact-path');await checkSource(source);
 const operations=new Map(Object.keys(OPERATIONS).map(op=>[op as Operation,source.id])),native=new Map(NATIVE_DRIVERS.map(driver=>[driver,source.id]));const descriptors={schema:'large-import-write-hook-bindings/v1',sources:[source],operations:[...operations].map(([operation,binding_id])=>({operation,binding_id})).sort((a,b)=>a.operation.localeCompare(b.operation)),native_drivers:[...native].map(([driver,binding_id])=>({driver,binding_id})).sort((a,b)=>a.driver.localeCompare(b.driver))};
 const registry=Object.freeze({}) as WriteHookRegistry;registries.set(registry,{bindings_hash:sha(JSON.stringify(descriptors)),sources:[source],operations,native,evidence,inventory});return Object.freeze({registry,bindings:structuredClone(descriptors)});
}
