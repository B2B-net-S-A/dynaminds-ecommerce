/** Private filesystem publication. Import/factory performs no IO and supplies no authority. */
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {lstat,realpath,mkdir,open,link,unlink,readdir} from 'node:fs/promises';
import {join,resolve,dirname,relative} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {withOwnedFileHandle} from './file-handle';
import {validateResource,type Resource,type Observed} from '../pim-large-import-write-hook-registry-backend/group';
export type Scope={tenantId:string;actorId:string;apiKeyId:string|null};
export type Namespace='blobs'|'uploads'|'witnesses';
export type Target={namespace:Namespace;id:string;name:string};
export type NativeQuota={intent(r:Resource):Promise<unknown>;settle(r:Observed):Promise<unknown>;unknown():Promise<void>;snapshot():Promise<{reservation:{id:string;tenant_id:string;actor_id:string;api_key_id:string|null}}>} ;
export type OwnedQuota={reservationId:string;scope:Scope;quota:NativeQuota};
export type Ports<A>={root:string;authorize(a:A,action:'publish'|'read'):Promise<OwnedQuota>;cleanupFailure(e:unknown):void;fault?:(phase:'pending-written'|'destination-linked')=>Promise<void>};
export type Publication={target:Target;bytes:Uint8Array;resource:Resource};
/** Opaque local capability, never serialized, submitted by a browser, or reconstructed after a crash. */
export type Prepared=Readonly<{kind:'prepared-private-files/v1';replay:boolean}>;
export const digest=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
const uuid=(s:string)=>assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s),'fs-canonical-uuid');
export function metadataResource(kind:'blob'|'event',key:string,text:string):Resource{return{kind,key,byte_count:Buffer.byteLength(text),sha256:digest(text),payload_text:text};}
export function fileResource(t:Target,b:Uint8Array):Resource{
 target(t);if(t.name.endsWith('.part')){assert(t.namespace==='blobs','fs-only-blob-parts');return{kind:'raw',key:`raw:${t.id}:${Number(t.name.slice(0,16))}`,byte_count:b.length,sha256:digest(b)};}
 const kind=t.namespace==='witnesses'?'event':'blob';return metadataResource(kind,`${kind}:fs:${t.namespace}:${t.id}:${t.name.replace('.','-')}`,Buffer.from(b).toString('utf8'));
}
function target(t:Target){assert(['blobs','uploads','witnesses'].includes(t.namespace),'fs-namespace');uuid(t.id);assert(/^(owner\.json|seal\.json|quarantine\.json|claim\.json|ready\.json|unknown\.json|[0-9]{16}\.part|[a-f0-9]{64}\.json)$/.test(t.name),'fs-target-name');if(t.name.endsWith('.part'))assert(t.namespace==='blobs','fs-only-blob-parts');if(t.namespace==='witnesses')assert(/^[a-f0-9]{64}\.json$/.test(t.name),'fs-witness-sha-name');}
export async function readPrivate(path:string,max=8*1024*1024,cleanupFailure:(e:unknown)=>void=()=>{}){
 const before=await lstat(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o777)===0o600&&before.size<=max,'fs-private-file');if(process.getuid)assert(before.uid===process.getuid(),'fs-os-owner');const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 return withOwnedFileHandle(f,async()=>{const first=await f.stat();assert(first.ino===before.ino&&first.dev===before.dev,'fs-file-replaced');const b=Buffer.alloc(before.size);let at=0;while(at<b.length){const n=await f.read(b,at,b.length-at,at);assert(n.bytesRead>0,'fs-short-file');at+=n.bytesRead;}assert((await f.read(Buffer.alloc(1),0,1,at)).bytesRead===0,'fs-file-grew');const after=await f.stat(),last=await lstat(path);assert(after.nlink===1&&after.size===before.size&&(after.mode&0o777)===0o600&&last.ino===before.ino&&last.dev===before.dev&&!last.isSymbolicLink(),'fs-file-changed');return b;},cleanupFailure);
}
async function directory(p:string){const x=await lstat(p);assert(x.isDirectory()&&!x.isSymbolicLink()&&(x.mode&0o777)===0o700&&await realpath(p)===p,'fs-private-directory');if(process.getuid)assert(x.uid===process.getuid(),'fs-os-owner');return x;}
async function sync(p:string,cleanupFailure:(e:unknown)=>void=()=>{}){const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);await withOwnedFileHandle(f,()=>f.sync(),cleanupFailure);}
const identical=(a:Resource,b:Resource)=>a.kind===b.kind&&a.key===b.key&&a.byte_count===b.byte_count&&a.sha256===b.sha256&&a.payload_text===b.payload_text;
function native(n:any,r:Resource,tenant:string,reservation:string){assert(n?.tenant_id===tenant&&n.reservation_id===reservation&&n.resource_key===r.key&&n.kind===r.kind&&String(n.byte_count)===String(r.byte_count)&&n.sha256===r.sha256&&n.payload_text===(r.payload_text??null)&&['intent','settled'].includes(n.state),'fs-owned-native-intent');return n.state as 'intent'|'settled';}
export function createPrivateQuotaPublisher<A>(input:Ports<A>){
 const root=input.root;assert(root===resolve(root),'fs-canonical-root');const authorize=input.authorize,diagnostic=input.cleanupFailure,fault=input.fault;let rootIdentity:{ino:number;dev:number}|undefined;
 const report=(e:unknown)=>{try{diagnostic(e);}catch{}};
 const readOwned=(p:string,max?:number)=>readPrivate(p,max,report);
 const syncOwned=(p:string)=>sync(p,report);
 const owned=async(a:A,action:'read'|'publish')=>{assert(a&&typeof a==='object','fs-original-authority');const x=await authorize(a,action),scope=structuredClone(x.scope);assert(Object.keys(scope).sort().join(',')==='actorId,apiKeyId,tenantId','fs-exact-public-principal');uuid(scope.tenantId);uuid(scope.actorId);if(scope.apiKeyId!==null)uuid(scope.apiKeyId);uuid(x.reservationId);return{scope,reservationId:x.reservationId,quota:x.quota};};
 const paths=(s:Scope,t:Target)=>{const tenant=join(root,s.tenantId),actor=join(tenant,s.actorId),credential=join(actor,s.apiKeyId===null?'sessions':'key-'+s.apiKeyId),area=join(credential,t.namespace),dir=join(area,t.id),parent=t.name.endsWith('.part')?join(dir,'parts'):dir;return{tenant,actor,credential,area,dir,parent,file:join(parent,t.name),dirs:[tenant,actor,credential,area,dir,...(parent!==dir?[parent]:[])]};};
 const rootGuard=async()=>{const x=await directory(root);if(rootIdentity)assert(x.ino===rootIdentity.ino&&x.dev===rootIdentity.dev,'fs-root-replaced');else rootIdentity={ino:x.ino,dev:x.dev};};
 const guards=async(s:Scope,t:Target)=>{await rootGuard();const p=paths(s,t);for(const d of p.dirs)await directory(d);return p;};
 const pending=async(dir:string)=>{assert(!(await readdir(dir)).some(n=>n.startsWith('.pending-')),'fs-pending-publication-refuses');const parts=join(dir,'parts');try{await directory(parts);assert(!(await readdir(parts)).some(n=>n.startsWith('.pending-')),'fs-pending-publication-refuses');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
 const observed=(r:Resource,id:string,b:Uint8Array):Observed=>({...r,state:'settled',witness:{id,sha256:digest(b),byte_count:b.length}});
 const inspectFile=async(s:Scope,p:Publication,allowPending=false)=>{const x=await guards(s,p.target);if(!allowPending)await pending(x.dir);const b=await readOwned(x.file);assert(b.length===p.resource.byte_count&&digest(b)===p.resource.sha256,'fs-exact-published-bytes');await guards(s,p.target);return observed(p.resource,`private-file/v1:${s.tenantId}:${s.actorId}:${s.apiKeyId??'session'}:${p.target.namespace}:${p.target.id}:${p.target.name}`,b);};
 async function publish(path:string,b:Uint8Array){const parent=dirname(path),temp=join(parent,`.pending-${randomUUID()}`),f=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await withOwnedFileHandle(f,async()=>{await f.writeFile(b);await f.sync();},report);await fault?.('pending-written');await link(temp,path);await fault?.('destination-linked');await unlink(temp);await syncOwned(parent);}
 type Held={owner:A;x:Awaited<ReturnType<typeof owned>>;items:Publication[];external:Resource[];states:Map<string,string>;directoryFacts:Observed[];lockResource:Resource;lockFact:Observed|undefined;lockPath:string;lockIdentity:{ino:number;dev:number}|undefined;written:boolean;released:boolean;completed:boolean;allowPending:boolean};
 const permits=new WeakMap<object,Held>();
 async function verifyLock(h:Held){assert(h.lockIdentity&&h.lockFact,'fs-deferred-lock-not-active');const st=await lstat(h.lockPath),b=await readOwned(h.lockPath,4096);assert(st.ino===h.lockIdentity.ino&&st.dev===h.lockIdentity.dev&&b.length===h.lockResource.byte_count&&digest(b)===h.lockResource.sha256,'fs-exact-owned-lock');}
 const held=(p:Prepared)=>{const h=permits.get(p);assert(h&&!h.released,'fs-private-prepared-permit');return h;};
 async function release(p:Prepared){const h=held(p);if(!h.lockIdentity){h.released=true;return;}const st=await lstat(h.lockPath),b=await readOwned(h.lockPath,4096);assert(st.ino===h.lockIdentity.ino&&st.dev===h.lockIdentity.dev&&b.length===h.lockResource.byte_count&&digest(b)===h.lockResource.sha256,'fs-exact-owned-lock');await unlink(h.lockPath);await syncOwned(dirname(h.lockPath));h.released=true;}
 async function unknown(h:Held){try{await h.x.quota.unknown();}catch(e){report(e);}}
 return{
  /** All quota/native admission happens here, BEFORE the caller starts/locks its metadata transaction. */
  async prepare(a:A,publications:readonly Publication[],external:readonly Resource[]=[],deferredQuarantine=false):Promise<Prepared>{
   const items=publications.map(p=>({target:structuredClone(p.target),resource:structuredClone(p.resource),bytes:new Uint8Array(p.bytes)})),others=structuredClone(external) as Resource[];
   assert(items.length>0&&items.length<=1024,'fs-publication-count');const first=items[0].target;for(const p of items){target(p.target);validateResource(p.resource);assert(p.target.id===first.id&&p.target.namespace===first.namespace,'fs-one-owned-directory');assert(p.bytes.length<=8*1024*1024&&p.bytes.length===p.resource.byte_count&&digest(p.bytes)===p.resource.sha256&&identical(p.resource,fileResource(p.target,p.bytes)),'fs-path-resource-binding');if(p.target.namespace==='witnesses')assert(p.target.name===digest(p.bytes)+'.json','fs-witness-content-name');}for(const r of others)validateResource(r);
   const x=await owned(a,'publish'),dirPlans=new Map<string,Resource>();for(const p of items)for(const d of paths(x.scope,p.target).dirs){const text=JSON.stringify({schema:'private-directory-allocation/v1',path:relative(root,d),mode:448});dirPlans.set(d,metadataResource('blob',`blob:fs:directory:${digest(relative(root,d))}`,text));}
   const nonce=randomUUID(),lockText=JSON.stringify({schema:'private-import-lock/v1',id:nonce}),lockResource=metadataResource('blob',`blob:fs:${first.namespace}:${first.id}:lock:${nonce}`,lockText),resources=[...dirPlans.values(),lockResource,...items.map(p=>p.resource),...others],keys=new Set<string>();for(const r of resources){assert(!keys.has(r.key),'fs-duplicate-resource');keys.add(r.key);}
   const states=new Map<string,string>(),directoryFacts:Observed[]=[];let lockPath:string|undefined,lockIdentity:{ino:number;dev:number}|undefined;
   const allowPending=items.length===1&&first.namespace==='blobs'&&first.name==='quarantine.json';assert(!deferredQuarantine||(allowPending&&others.length===0),'fs-defer-only-preallocated-quarantine');
   try{
    // No mkdir, lock, raw or publication bytes precede ALL exact independently committed intents.
    const snapshot=await x.quota.snapshot();assert(snapshot.reservation.id===x.reservationId&&snapshot.reservation.tenant_id===x.scope.tenantId&&snapshot.reservation.actor_id===x.scope.actorId&&snapshot.reservation.api_key_id===x.scope.apiKeyId,'fs-native-reservation-owner');
    for(const r of resources)states.set(r.key,native(await x.quota.intent(structuredClone(r)),r,x.scope.tenantId,x.reservationId));
    await rootGuard();for(const [d,r]of dirPlans){await directory(dirname(d));if(states.get(r.key)==='intent')try{await mkdir(d,{mode:0o700});await syncOwned(dirname(d));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}const st=await directory(d),text=JSON.stringify({path:relative(root,d),mode:st.mode&0o777,uid:st.uid,ino:st.ino,dev:st.dev});directoryFacts.push(observed(r,`private-directory/v1:${digest(relative(root,d))}`,Buffer.from(text)));}
    const base=paths(x.scope,first);if(!allowPending)await pending(base.dir);lockPath=join(base.dir,'writer.lock');
    // WX final lock, not temp publication: on crash it remains exact retained evidence and refuses new writers.
    let lockFact:Observed|undefined;
    if(!deferredQuarantine){const f=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const st=await f.stat();lockIdentity={ino:st.ino,dev:st.dev};await withOwnedFileHandle(f,async()=>{await f.writeFile(lockText);await f.sync();},report);await syncOwned(base.dir);lockFact=observed(lockResource,`private-lock/v1:${x.scope.tenantId}:${nonce}`,await readOwned(lockPath,4096));}
    const replay=items.every(p=>states.get(p.resource.key)==='settled')&&others.every(r=>states.get(r.key)==='settled');
    // Partial raw/PG settlement requires authoritative recovery, never a new callback.
    if(others.length)assert(replay||[...items.map(p=>p.resource),...others].every(r=>states.get(r.key)==='intent'),'fs-mixed-group-requires-recovery');
    const permit=Object.freeze({kind:'prepared-private-files/v1' as const,replay});permits.set(permit,{owner:a,x,items,external:others,states,directoryFacts,lockResource,lockFact,lockPath,lockIdentity,written:false,released:false,completed:false,allowPending});return permit;
   }catch(e){try{await x.quota.unknown();}catch(err){report(err);}if(lockPath&&lockIdentity)try{const st=await lstat(lockPath);assert(st.ino===lockIdentity.ino&&st.dev===lockIdentity.dev,'fs-prepare-lock-replaced');await unlink(lockPath);await syncOwned(dirname(lockPath));}catch(err){report(err);}throw e;}
  },
  /** Activate ONLY an earlier quarantine allocation. No new quota/admission client or crash-lock takeover. */
  async activateQuarantine(p:Prepared){const h=held(p);assert(h.allowPending&&!h.lockIdentity,'fs-preallocated-quarantine-only');await guards(h.x.scope,h.items[0].target);const f=await open(h.lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const st=await f.stat();h.lockIdentity={ino:st.ino,dev:st.dev};await withOwnedFileHandle(f,async()=>{await f.writeFile(h.lockResource.payload_text!);await f.sync();},report);await syncOwned(dirname(h.lockPath));h.lockFact=observed(h.lockResource,`private-lock/v1:${h.x.scope.tenantId}:${h.lockResource.key.split(':').at(-1)}`,await readOwned(h.lockPath,4096));},
  /** Only FS work on a held permit. No authority/native quota/second-client calls inside metadata BEGIN. */
  async write(p:Prepared){const h=held(p);await verifyLock(h);assert(!h.written&&!h.completed,'fs-one-prepared-write');h.written=true;try{for(const item of h.items){if(h.states.get(item.resource.key)==='settled'){await inspectFile(h.x.scope,item,h.allowPending);continue;}await guards(h.x.scope,item.target);if(!h.allowPending)await pending(paths(h.x.scope,item.target).dir);await publish(paths(h.x.scope,item.target).file,item.bytes);}}catch(e){throw e;}},
  /** Actual FS readback while the SAME private lock remains held; no native calls inside read TX. */
  async inspect(p:Prepared){const h=held(p);await verifyLock(h);assert(h.written||p.replay,'fs-readback-before-write');const facts:Observed[]=[];for(const item of h.items)facts.push(await inspectFile(h.x.scope,item,h.allowPending));return facts;},
  async readHeld(p:Prepared,name:string){const h=held(p);await verifyLock(h);const t={...h.items[0].target,name};target(t);const pathsHere=await guards(h.x.scope,t);if(!h.allowPending)await pending(pathsHere.dir);return new Uint8Array(await readOwned(pathsHere.file));},
  async existsHeld(p:Prepared,name:string){const h=held(p);await verifyLock(h);const t={...h.items[0].target,name};target(t);try{const x=await guards(h.x.scope,t);if(!h.allowPending)await pending(x.dir);await readOwned(x.file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
  async listHeld(p:Prepared,parts=false){const h=held(p);await verifyLock(h);const t={...h.items[0].target,name:parts?'0000000000000000.part':'owner.json'},x=paths(h.x.scope,t);await guards(h.x.scope,h.items[0].target);if(!h.allowPending)await pending(x.dir);try{await directory(x.parent);}catch(e){if(parts&&(e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}const names=await readdir(x.parent);assert(names.length<=1030,'fs-file-count');for(const name of names){if(!parts&&(name==='parts'||name==='writer.lock'))continue;target({...t,name});await readOwned(join(x.parent,name));}return names;},
  /** Caller-owned PG driver supplies actual committed row readbacks. This endpoint does not fabricate/replay PG. */
  async complete(p:Prepared,actualRows:readonly Observed[]=[]){const h=held(p);await verifyLock(h);assert(!h.completed,'fs-one-completion');const rows=structuredClone(actualRows) as Observed[];assert(rows.length===h.external.length,'fs-complete-external-count');const keys=new Set<string>();for(const r of rows){const expected=h.external.find(x=>x.key===r.key);assert(expected&&identical(expected,r)&&r.state==='settled'&&!keys.has(r.key)&&typeof r.witness?.id==='string'&&r.witness.id.length>0&&/^[a-f0-9]{64}$/.test(r.witness.sha256)&&Number.isSafeInteger(r.witness.byte_count)&&r.witness.byte_count>=0,'fs-actual-external-row-binding');keys.add(r.key);}try{const files=[];for(const item of h.items)files.push(await inspectFile(h.x.scope,item,h.allowPending));for(const r of [...h.directoryFacts,h.lockFact!,...files,...rows])await h.x.quota.settle(structuredClone(r));h.completed=true;return files;}catch(e){await unknown(h);throw e;}},
  /** Always call finally. Revocation permits only deletion of this exact transient lock, never raw/evidence bytes. */
  release,
  async fail(p:Prepared){await unknown(held(p));},
  /** Prepare outside metadata BEGIN. Read-only private closure performs FS IO only; caller's same-client admitted TX is the current checkpoint. */
  async bindReader(a:A,namespace:Namespace,id:string){const t={namespace,id,name:'owner.json'};target(t);const x=await owned(a,'read');await guards(x.scope,t);return Object.freeze({
   scope:()=>structuredClone(x.scope),
   read:async(name:string)=>{const z={namespace,id,name};target(z);const p=await guards(x.scope,z);await pending(p.dir);const b=await readOwned(p.file);await guards(x.scope,z);return new Uint8Array(b);},
   exists:async(name:string)=>{const z={namespace,id,name};target(z);try{const p=await guards(x.scope,z);await pending(p.dir);await readOwned(p.file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
   list:async(parts=false)=>{const z={namespace,id,name:parts?'0000000000000000.part':'owner.json'};target(z);const p=await guards(x.scope,z);await pending(p.dir);const names=await readdir(p.parent);assert(names.length<=1030,'fs-file-count');for(const name of names){if(!parts&&(name==='parts'||name==='writer.lock'))continue;target({...z,name});await readOwned(join(p.parent,name));}return names;},
  });},
  async scope(a:A){return structuredClone((await owned(a,'read')).scope);},
  async list(a:A,namespace:Namespace,id:string,parts=false){const t:Target={namespace,id,name:parts?'0000000000000000.part':'owner.json'};target(t);const x=await owned(a,'read'),p=await guards(x.scope,t);await pending(p.dir);const names=await readdir(p.parent);assert(names.length<=1030,'fs-file-count');for(const name of names){if(name==='parts'&&!parts)continue;if(name==='writer.lock'&&!parts){await readOwned(join(p.parent,name),4096);continue;}target({namespace,id,name});await readOwned(join(p.parent,name));}return names;},
  async read(a:A,t:Target){t=structuredClone(t);target(t);const x=await owned(a,'read'),p=await guards(x.scope,t);await pending(p.dir);const b=await readOwned(p.file);await guards(x.scope,t);return new Uint8Array(b);},
  async exists(a:A,t:Target){t=structuredClone(t);target(t);const x=await owned(a,'read');try{const p=await guards(x.scope,t);await pending(p.dir);await readOwned(p.file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
 };
}
