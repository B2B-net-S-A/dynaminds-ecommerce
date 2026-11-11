/** Source-owned process-local exclusion only. No census completeness, native IAM, policy or readiness authority. */
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import type {FastifyRequest} from 'fastify';
import type {Actor} from '../domain';
import {recheckReviewedStartupEvidence,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import {assertOriginalMetadataBinding} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import type {OriginalMetadataBinding} from './original-metadata';

declare const participantBrand:unique symbol,bindingBrand:unique symbol,readBrand:unique symbol;
export type OwnedWriterParticipant={readonly [participantBrand]:true};
export type OriginalWriterBinding={readonly [bindingBrand]:true};
export type OwnedWriterReadLease={readonly [readBrand]:true};
type RootFact={dev:bigint;ino:bigint;mode:bigint;uid:bigint};
type Frame={record:WriterRecord;child?:Promise<unknown>};
type WriterRecord={owner:Owner;binding:Bound;active:boolean;failed:boolean;first?:unknown;pending:Set<Promise<unknown>>;done:Promise<void>;resolve():void};
type Owner={startup:ReviewedStartup;roots:readonly string[];facts:RootFact[];state:'open'|'sealed'|'closed';generation:bigint;read?:Read;writer?:WriterRecord;closing?:Promise<void>};
type Bound={owner:Owner;actor:Actor;original:FastifyRequest;metadata:OriginalMetadataBinding;check():void};
type Read={owner:Owner;generation:bigint;active:boolean};
const owners=new WeakMap<object,Owner>(),bindings=new WeakMap<object,Bound>(),reads=new WeakMap<object,Read>();
const originals=new WeakMap<Owner,WeakMap<object,OriginalWriterBinding>>(),rootOwners=new Map<string,Owner>();
const frames=new AsyncLocalStorage<Frame>();
const opaque=()=>Object.freeze(Object.create(null)) as object;
function rootFact(path:string):RootFact{const s=lstatSync(path,{bigint:true});assert(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&511n)===448n&&s.uid===BigInt(process.getuid!())&&realpathSync(path)===path,'writer-owned-canonical-root');return{dev:s.dev,ino:s.ino,mode:s.mode,uid:s.uid};}
function rootsUnchanged(owner:Owner){owner.roots.forEach((root,i)=>assert.deepEqual(rootFact(root),owner.facts[i],'writer-root-replaced'));}
function ownerOf(value:OwnedWriterParticipant){const owner=owners.get(value);assert(owner,'writer-authentic-owner');return owner;}
function boundOf(value:OriginalWriterBinding){const bound=bindings.get(value);assert(bound,'writer-authentic-original-binding');return bound;}
export async function createOwnedWriterParticipant(startup:ReviewedStartup,rawRoot:string,controlPlaneRoot:string):Promise<OwnedWriterParticipant>{
 // Authenticity/full release bytes only; fresh producer handles are not native-generation approved yet.
 const heldStartup=startup,heldRawRoot=rawRoot,heldControlRoot=controlPlaneRoot;
 const roots=[resolve(heldRawRoot),resolve(heldControlRoot)];assert(roots.every((p,i)=>p===[rawRoot,controlPlaneRoot][i]),'writer-exact-canonical-root-path');
 assert(roots[0]!==roots[1]&&!roots[0].startsWith(roots[1]+'/')&&!roots[1].startsWith(roots[0]+'/'),'writer-distinct-roots');
 const facts=roots.map(rootFact);
 await recheckReviewedStartupEvidence(heldStartup); // Actual private Startup WeakMap; no native SQL/activation/readiness.
 assert.deepEqual(roots.map(rootFact),facts,'writer-root-changed-during-startup-evidence');
 assert(roots.every(root=>!rootOwners.has(root)),'writer-root-already-owned');
 const owner:Owner={startup,roots:Object.freeze(roots),facts,state:'open',generation:0n};roots.forEach(root=>rootOwners.set(root,owner));originals.set(owner,new WeakMap());
 const handle=opaque() as OwnedWriterParticipant;owners.set(handle,owner);return handle;
}
export function bindOriginalWriter(participant:OwnedWriterParticipant,actor:Actor,original:FastifyRequest,metadata:OriginalMetadataBinding):OriginalWriterBinding{
 const owner=ownerOf(participant);assert(owner.state==='open','writer-owner-sealed');assertOriginalMetadataBinding(metadata.ports,original,actor);assert.deepEqual(metadata.scope,{tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null},'writer-original-metadata-scope');metadata=Object.freeze({scope:Object.freeze({...metadata.scope}),ports:metadata.ports});
 const old=originals.get(owner)!.get(original);if(old){const b=boundOf(old);assert(b.actor===actor&&b.metadata.ports===metadata.ports,'writer-original-already-bound-differently');b.check();return old;}
 const method=original.method,url=original.url,params=original.params,query=original.query,paramsCopy=structuredClone(params),queryCopy=structuredClone(query);
 const stream=method==='POST'&&!!query&&typeof query==='object'&&Object.hasOwn(query,'upload_key'),body=stream?original.body:structuredClone(original.body),actorRef=original.actor,currentRef=original.currentUser,scopesRef=original.apiScopes;
 const actorCopy=structuredClone(actor),requestActorCopy=structuredClone(original.actor),currentCopy=structuredClone(original.currentUser),scopesCopy=structuredClone(original.apiScopes);
 const check=()=>{rootsUnchanged(owner);assertOriginalMetadataBinding(metadata.ports,original,actor);assert.deepEqual(actor,actorCopy,'writer-actor-changed');assert(original.actor===actorRef&&original.currentUser===currentRef&&original.apiScopes===scopesRef,'writer-original-principal-reference');assert.deepEqual(original.actor,requestActorCopy);assert.deepEqual(original.currentUser,currentCopy);assert.deepEqual(original.apiScopes,scopesCopy);assert(original.method===method&&original.url===url&&original.params===params&&original.query===query,'writer-original-request-reference');assert.deepEqual(structuredClone(original.params),paramsCopy);assert.deepEqual(structuredClone(original.query),queryCopy);if(stream)assert.equal(original.body,body,'writer-original-stream');else assert.deepEqual(structuredClone(original.body),body,'writer-original-body');};
 const handle=opaque() as OriginalWriterBinding;bindings.set(handle,{owner,actor,original,metadata,check});originals.get(owner)!.set(original,handle);return handle;
}
export function assertOriginalWriterBinding(value:OriginalWriterBinding,actor:Actor,original:object){const b=boundOf(value);assert(b.actor===actor&&b.original===original,'writer-exact-original-actor');b.check();}
export function reserveOwnedWriterRead(participant:OwnedWriterParticipant):OwnedWriterReadLease{
 const owner=ownerOf(participant);assert(owner.state==='open'&&!owner.writer&&!owner.read,'writer-read-busy-or-sealed');rootsUnchanged(owner);
 const read:Read={owner,generation:owner.generation,active:true},handle=opaque() as OwnedWriterReadLease;owner.read=read;reads.set(handle,read);return handle;
}
export function releaseOwnedWriterRead(handle:OwnedWriterReadLease){const read=reads.get(handle);assert(read?.active&&read.owner.read===read,'writer-authentic-active-read');read.active=false;read.owner.read=undefined;}
/** Consumes exclusion lease synchronously before the first preparation effect; not a census or IAM verdict. */
export function transferOwnedWriterRead<T>(lease:OwnedWriterReadLease,binding:OriginalWriterBinding,work:()=>Promise<T>):Promise<T>{
 const read=reads.get(lease),b=boundOf(binding);assert(read?.active&&read.owner===b.owner&&read.owner.read===read&&read.generation===b.owner.generation,'writer-exact-current-read-transfer');b.check();assert(b.owner.state==='open'&&!b.owner.writer,'writer-transfer-busy-or-sealed');read.active=false;b.owner.read=undefined;return runOriginalWriter(binding,work);
}
function run<T>(binding:OriginalWriterBinding,work:()=>Promise<T>,cleanup:boolean):Promise<T>{
 const b=boundOf(binding),owner=b.owner,parent=frames.getStore();let record:WriterRecord,outer=false;
 if(parent){assert(parent.record.active&&parent.record.owner===owner&&parent.record.binding===b&&owner.writer===parent.record,'writer-stale-or-foreign-context');assert(!parent.child,'writer-overlapping-nested-work');record=parent.record;if(!cleanup)b.check();else rootsUnchanged(owner);}
 else{assert(!cleanup,'writer-cleanup-requires-held-command');assert(owner.state==='open'&&!owner.read&&!owner.writer,'writer-mutation-busy-or-sealed');b.check();let resolveDone!:()=>void;const done=new Promise<void>(resolve=>{resolveDone=resolve;});record={owner,binding:b,active:true,failed:false,pending:new Set(),done,resolve:resolveDone};owner.writer=record;owner.generation++;outer=true;}
 const frame:Frame={record};
 const promise=frames.run(frame,async()=>{let value:T|undefined,failed=false,first:unknown;try{value=await work();if(!cleanup)b.check();else rootsUnchanged(owner);}catch(e){failed=true;first=e;if(!record.failed){record.failed=true;record.first=e;}}finally{if(outer){while(record.pending.size)await Promise.allSettled([...record.pending]);record.active=false;assert(owner.writer===record);owner.writer=undefined;record.resolve();}}if(outer&&record.failed)throw record.first;if(failed)throw first;return value as T;});
 if(!outer){record.pending.add(promise);parent!.child=promise;void promise.then(()=>{record.pending.delete(promise);if(parent!.child===promise)parent!.child=undefined;},()=>{record.pending.delete(promise);if(parent!.child===promise)parent!.child=undefined;});}
 return promise;
}
/** Internal readonly first-cause observation for the SAME active held original; never a readiness or native authority. */
export function inspectHeldOriginalWriterFailure(binding:OriginalWriterBinding){const b=boundOf(binding),r=b.owner.writer;if(!r||!r.active||r.binding!==b)return undefined;return Object.freeze({failed:r.failed,first:r.first});}
export function runOriginalWriter<T>(binding:OriginalWriterBinding,work:()=>Promise<T>):Promise<T>{return run(binding,work,false);}
/** ONLY existing held command cleanup; original preallocated private resource guards remain mandatory. */
export function runOriginalWriterCleanup<T>(binding:OriginalWriterBinding,work:()=>Promise<T>):Promise<T>{return run(binding,work,true);}
export function assertOwnedWriterIdle(participant:OwnedWriterParticipant){const owner=ownerOf(participant);assert(!owner.writer&&!owner.read,'writer-owner-busy');}
export function sealOwnedWriterParticipant(participant:OwnedWriterParticipant){const owner=ownerOf(participant);assertOwnedWriterIdle(participant);assert(owner.state==='open','writer-already-sealed');owner.state='sealed';}
export function closeOwnedWriterParticipant(participant:OwnedWriterParticipant):Promise<void>{const owner=ownerOf(participant);if(owner.closing)return owner.closing;owner.state='sealed';if(owner.read){owner.read.active=false;owner.read=undefined;}owner.closing=(async()=>{if(owner.writer)await owner.writer.done;owner.state='closed';owner.roots.forEach(root=>{assert(rootOwners.get(root)===owner);rootOwners.delete(root);});})();return owner.closing;}
export function inspectOwnedWriterParticipant(participant:OwnedWriterParticipant){const o=ownerOf(participant);return Object.freeze({generation:o.generation.toString(),state:o.state,writing:!!o.writer,reading:!!o.read,global_writer_fence:false as const,authorizes_commands:false as const});}
