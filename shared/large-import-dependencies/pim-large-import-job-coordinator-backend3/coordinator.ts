/** Export-only durable orchestration ports. No default stores, applications, workers, or network. */
import {createHash} from 'node:crypto';
import {retainAndChunkImport,type Batch,type Manifest,type Spec} from '../pim-large-import-stream-foundation-ui2/stream';
import type {CatalogFileImportInput} from '../../../server/catalog-file-import-schema';
import {digest,canonicalDigest,need,serializeNativeBatch,type CoreConfig} from './native-batches';

export type Ref={id:string;sha256:string;byte_count:number};
export type Principal={tenantId:string;userId:string;apiKeyId:string|null};
export type Head={id:string;actor_id:string;scope_hash:string;total:number;ready:boolean;config:unknown;preview_id?:string;state?:string};
export type CoreRow={index:number;product_id:string|null;identity_value:string|null;errors:string[];[key:string]:unknown};
export type CorePage={head:Head;rows:CoreRow[];next:string|null;witness:Ref};
export type CoreAck={head:Head;witness:Ref;reused:boolean};
export type PimAck={id:string;scope_hash:string;body:unknown;witness:Ref};
export type PimStage={ready:boolean;intake:unknown;unmapped:unknown;request?:unknown;sources?:unknown;errors?:unknown;witness:Ref};
type CoreState={previewKey:string;executeKey:string;request:CatalogFileImportInput;identities:string[];preview?:{ack:CoreAck;pages:CorePage[]};consent?:string;execution?:{ack:CoreAck;pages:CorePage[]}};
type PimAttempt={number:number;mapping:unknown;stageKey:string;previewKey:string;applyKey:string;stage?:PimStage;preview?:PimAck;previewAttempted:boolean;consent?:string;applyAttempted:boolean;applied?:PimAck};
export type Event={sequence:number;kind:string;batch:number|null;witnesses:Ref[]};
export type Job={schema:'large-import-job/v1';id:string;revision:number;principal:Principal;raw:Ref;manifest:Manifest;parsing_spec:Spec;plan_hash:string;approved:boolean;core:CoreState[];pim:Record<number,PimAttempt[]>;events:Event[]};
export type Lease={load():Promise<Job>;save(next:Job,expectedRevision:number):Promise<void>};
export type Store={createIfAbsent(job:Job):Promise<Job>;withLease<T>(jobId:string,work:(lease:Lease)=>Promise<T>):Promise<T>};
export type Ports<Authority>={
 authority(authority:Authority):Promise<Principal>;
 blob:{readRaw(ref:Ref):AsyncIterable<Uint8Array>;readBatch(ref:string):Promise<Batch>};
 jobs:Store;
 /** Advisory current native quotas. Native098 remains transaction authority; replay is never blocked by this port. */
 capacity(authority:Authority,request:CatalogFileImportInput):Promise<{admissible:boolean;witness:Ref}>;
 core:{preview(authority:Authority,request:CatalogFileImportInput):Promise<CoreAck>;previewPage(authority:Authority,id:string,cursor:string|null):Promise<CorePage>;execute(authority:Authority,id:string,body:{client_key:string;scope_hash:string;confirmed:true}):Promise<CoreAck>;executionPage(authority:Authority,id:string,cursor:string|null):Promise<CorePage>};
 /** Real authenticated Stage/preview/apply adapter. Never constructs actors or guesses product IDs. */
 pim:{stage(authority:Authority,body:{core_request:CatalogFileImportInput;preview:Head;execution_id:string;typed_mapping:unknown;client_key:string}):Promise<PimStage>;preview(authority:Authority,request:unknown,clientKey:string):Promise<PimAck>;apply(authority:Authority,id:string,body:{client_key:string;scope_hash:string;confirmed:true}):Promise<PimAck>};
};
const detached=<T>(x:T):T=>structuredClone(x);
const uuid=(s:string)=>need(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s),'uuid');
function ref(r:Ref){need(typeof r.id==='string'&&r.id.length>0&&/^[a-f0-9]{64}$/.test(r.sha256)&&Number.isSafeInteger(r.byte_count)&&r.byte_count>=0,'receipt-ref');}
function principal(p:Principal){uuid(p.tenantId);uuid(p.userId);if(p.apiKeyId!==null)uuid(p.apiKeyId);}
/** UUIDv5, persisted before first business attempt; no wall-clock/random retry keys. */
export function phaseKey(jobId:string,planHash:string,batch:number,phase:string){uuid(jobId);const ns=Buffer.from(jobId.replaceAll('-',''),'hex'),h=createHash('sha1').update(ns).update(JSON.stringify([planHash,batch,phase])).digest().subarray(0,16);h[6]=(h[6]&15)|80;h[8]=(h[8]&63)|128;const x=h.toString('hex');return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20)}`;}
function manifestShape(m:Manifest){
 need(m.schema==='large-core-import-file/v1'&&m.raw.completed_eof===true&&m.raw.parse_valid===true,'valid-eof-required');
 need(/^[a-f0-9]{64}$/.test(m.raw.sha256)&&Number.isSafeInteger(m.raw.byte_count)&&m.raw.byte_count>0,'raw-seal');
 need(Number.isSafeInteger(m.records)&&m.records>0&&m.records<=100000&&m.batches.length===m.total_batches&&m.batches.length>0,'manifest-count');
 let ordinal=0,end=0;const ids=new Set<string>(),refs=new Set<string>();
 for(const [i,b]of m.batches.entries()){
  need(b.index===i&&b.rows>=1&&b.rows<=500&&b.record_spans.length===b.rows&&b.normalized_bytes<=2097152&&b.normalized_bytes>0,'batch-bounds');
  need(/^[a-f0-9]{64}$/.test(b.id)&&!ids.has(b.id)&&typeof b.ref==='string'&&b.ref&&!refs.has(b.ref),'batch-identity');ids.add(b.id);refs.add(b.ref);
  for(const s of b.record_spans){need(s.ordinal===ordinal++&&Number.isSafeInteger(s.byte_start)&&Number.isSafeInteger(s.byte_end)&&s.byte_start>=end&&s.byte_end>s.byte_start&&s.byte_end<=m.raw.byte_count&&Number.isSafeInteger(s.line_start)&&Number.isSafeInteger(s.line_end)&&s.line_start>=1&&s.line_end>=s.line_start&&/^[a-f0-9]{64}$/.test(s.raw_sha256),'record-span');end=s.byte_end;}
 }need(ordinal===m.records,'manifest-records');
}
async function verifyRaw(raw:Ref,m:Manifest,stream:AsyncIterable<Uint8Array>){
 ref(raw);need(raw.sha256===m.raw.sha256&&raw.byte_count===m.raw.byte_count,'raw-ref-seal');
 const spans=m.batches.flatMap(b=>b.record_spans),whole=createHash('sha256');let offset=0,index=0,record=createHash('sha256');
 for await(const part of stream){need(part instanceof Uint8Array,'raw-chunk');whole.update(part);let local=0;
  while(index<spans.length&&spans[index].byte_start<offset+part.length){const s=spans[index],start=Math.max(s.byte_start-offset,local,0),end=Math.min(s.byte_end-offset,part.length);if(end>start)record.update(part.subarray(start,end));if(s.byte_end<=offset+part.length){need(record.digest('hex')===s.raw_sha256,'record-sha');record=createHash('sha256');index++;local=Math.max(end,0);}else break;}
  offset+=part.length;need(offset<=raw.byte_count,'raw-overrun');
 }need(offset===raw.byte_count&&index===spans.length&&whole.digest('hex')===raw.sha256,'raw-sha-eof');
}
/** Semantic custody: derive records from the original bytes, never from a caller-supplied manifest. */
async function verifyParsed<A>(ports:Ports<A>,raw:Ref,manifest:Manifest,spec:Spec){
 need(spec.format===manifest.format,'parser-format');
 const derived=await retainAndChunkImport(ports.blob.readRaw(raw),detached(spec),{
  appendOriginal:async()=>{},
  putBatch:async batch=>{const descriptor=manifest.batches[batch.index];need(descriptor,'parser-extra-batch');const stored=await ports.blob.readBatch(descriptor.ref);need(digest(batch)===digest(stored),'raw-canonical-record-binding');return descriptor.ref;},
  sealOriginal:async seal=>need(canonicalDigest(seal)===canonicalDigest(manifest.raw),'parser-raw-seal'),
  commitManifest:async generated=>need(canonicalDigest(generated)===canonicalDigest(manifest),'parser-complete-manifest'),
 });
 need(canonicalDigest(derived)===canonicalDigest(manifest),'parser-derived-manifest');
}
async function pages(read:(cursor:string|null)=>Promise<CorePage>,expected:Head,identities:string[],done:boolean){
 const result:CorePage[]=[],rows:CoreRow[]=[];let cursor:string|null=null;
 do{const page:CorePage=detached(await read(cursor));ref(page.witness);need(canonicalDigest(page.head)===canonicalDigest(expected),'core-head-drift');need(page.rows.length>=1&&page.rows.length<=100,'core-page-count');for(const r of page.rows){need(r.index===rows.length&&r.index<identities.length&&r.identity_value===identities[r.index]&&Array.isArray(r.errors)&&r.errors.every(e=>typeof e==='string'),'core-row-binding');if(done){need(r.errors.length===0&&r.product_id!==null,'core-real-product');uuid(r.product_id);}rows.push(r);}const next:string|null=page.next;need(next===null||next===String(rows.length)&&rows.length<identities.length,'core-cursor');result.push(page);cursor=next;need(result.length<=5,'core-page-limit');}while(cursor!==null);
 need(rows.length===identities.length&&expected.total===rows.length,'core-complete-rows');return result;
}
export function createLargeImportCoordinator<A>(ports:Ports<A>){
 async function authenticated(a:A){const p=detached(await ports.authority(a));principal(p);return p;}
 async function withJob<T>(a:A,id:string,work:(j:Job,save:(kind:string,batch:number|null,witnesses?:Ref[])=>Promise<void>)=>Promise<T>){
  const p=await authenticated(a);return ports.jobs.withLease(id,async lease=>{const j=detached(await lease.load());need(j.id===id&&canonicalDigest(j.principal)===canonicalDigest(p),'job-authority');const save=async(kind:string,batch:number|null,witnesses:Ref[]=[])=>{witnesses.forEach(ref);const old=j.revision;j.revision++;j.events.push({sequence:j.events.length,kind,batch,witnesses:detached(witnesses)});await lease.save(detached(j),old);};return work(j,save);});
 }
 const coreAt=(j:Job,n:number)=>{need(Number.isSafeInteger(n)&&n>=0&&n<j.core.length,'batch-index');return j.core[n];};
 const approved=(j:Job)=>need(j.approved,'whole-file-consent-required');
 const previousDone=(j:Job,n:number)=>need(j.core.slice(0,n).every(x=>x.execution),'ordered-core-prefix-required');
 const attempt=(j:Job,n:number)=>{coreAt(j,n);const p=j.pim[n]?.at(-1);need(p,'pim-attempt-required');return p;};
 return {
  async prepare(a:A,input:{jobId:string;raw:Ref;manifest:Manifest;spec:Spec;config:CoreConfig}){
   input=detached(input);uuid(input.jobId);const owner=await authenticated(a),m=detached(input.manifest);manifestShape(m);await verifyRaw(input.raw,m,ports.blob.readRaw(input.raw));await verifyParsed(ports,input.raw,m,input.spec);
   const hash=digest({manifest:m,raw:input.raw,parsing_spec:input.spec,config:input.config}),core:CoreState[]=[],identities=new Set<string>();
   for(const d of m.batches){const b=detached(await ports.blob.readBatch(d.ref));need(b.index===d.index&&b.id===d.id&&digest(b.records.map(r=>r.span))===digest(d.record_spans)&&Buffer.byteLength(JSON.stringify(b.records),'utf8')===d.normalized_bytes&&digest({index:b.index,records:b.records})===b.id,'batch-content-binding');const previewKey=phaseKey(input.jobId,hash,d.index,'core-preview'),native=serializeNativeBatch(m,b,input.config,previewKey);for(const identity of native.identities){need(!identities.has(identity),'whole-file-duplicate-identity');identities.add(identity);}core.push({previewKey,executeKey:phaseKey(input.jobId,hash,d.index,'core-execute'),request:native.request,identities:native.identities});}
   const job:Job={schema:'large-import-job/v1',id:input.jobId,revision:0,principal:owner,raw:detached(input.raw),manifest:m,parsing_spec:detached(input.spec),plan_hash:hash,approved:false,core,pim:{},events:[]};
   const actual=detached(await ports.jobs.createIfAbsent(job));need(actual.plan_hash===hash&&canonicalDigest(actual.principal)===canonicalDigest(owner),'job-id-conflict');return actual;
  },
  async approve(a:A,id:string,planHash:string){return withJob(a,id,async(j,save)=>{need(j.plan_hash===planHash,'whole-file-consent-scope');if(!j.approved){j.approved=true;await save('whole-file-approved',null);}return detached(j);});},
  async previewCore(a:A,id:string,n:number){return withJob(a,id,async(j,save)=>{approved(j);previousDone(j,n);const c=coreAt(j,n);if(c.preview)return detached(c.preview);/* Persist attempt BEFORE native call: failures/crashes retry exact immutable key/body. */await save('core-preview-attempt',n);const capacity=await ports.capacity(a,detached(c.request));ref(capacity.witness);await save('capacity-observed',n,[capacity.witness]);const ack=detached(await ports.core.preview(a,detached(c.request)));ref(ack.witness);uuid(ack.head.id);const {content:_content,client_key:_key,...config}=c.request;need(ack.head.actor_id===j.principal.userId&&ack.head.total===c.identities.length&&typeof ack.head.ready==='boolean'&&/^[a-f0-9]{64}$/.test(ack.head.scope_hash)&&canonicalDigest(ack.head.config)===canonicalDigest(config),'core-preview-owner');const detail=await pages(cursor=>ports.core.previewPage(a,ack.head.id,cursor),ack.head,c.identities,false);c.preview={ack,pages:detail};await save('core-preview-observed',n,[ack.witness,...detail.map(x=>x.witness)]);return detached(c.preview);});},
  async consentCore(a:A,id:string,n:number,previewId:string,scopeHash:string){return withJob(a,id,async(j,save)=>{approved(j);const c=coreAt(j,n);need(c.preview?.ack.head.ready&&c.preview.ack.head.id===previewId&&c.preview.ack.head.scope_hash===scopeHash,'core-consent-scope');c.consent=scopeHash;await save('core-consent',n);});},
  async executeCore(a:A,id:string,n:number){return withJob(a,id,async(j,save)=>{approved(j);previousDone(j,n);const c=coreAt(j,n);if(c.execution)return detached(c.execution);need(c.preview&&c.consent===c.preview.ack.head.scope_hash,'core-native-consent-required');await save('core-execute-attempt',n);const ack=detached(await ports.core.execute(a,c.preview.ack.head.id,{client_key:c.executeKey,scope_hash:c.consent,confirmed:true}));ref(ack.witness);need(ack.head.state==='done'&&ack.head.preview_id===c.preview.ack.head.id&&ack.head.scope_hash===c.consent&&ack.head.actor_id===j.principal.userId,'core-execution-binding');const detail=await pages(cursor=>ports.core.executionPage(a,ack.head.id,cursor),ack.head,c.identities,true);c.execution={ack,pages:detail};await save('core-execution-observed',n,[ack.witness,...detail.map(x=>x.witness)]);return detached(c.execution);});},
  async newPimAttempt(a:A,id:string,n:number,mapping:unknown){return withJob(a,id,async(j,save)=>{approved(j);need(coreAt(j,n).execution,'pim-requires-durable-core');const list=j.pim[n]??=[];need(!list.at(-1)?.applied,'pim-batch-already-applied');const prior=list.at(-1);need(!prior?.applyAttempted,'pim-uncertain-apply-retry-required');need(!prior?.previewAttempted||prior.preview,'pim-uncertain-preview-retry-required');const number=list.length,phase=`pim-${number}-${digest(mapping)}`,previewKey=phaseKey(id,j.plan_hash,n,phase+'-preview');const p:PimAttempt={number,mapping:detached(mapping),stageKey:previewKey,previewKey,previewAttempted:false,applyAttempted:false,applyKey:phaseKey(id,j.plan_hash,n,phase+'-apply')};list.push(p);j.pim[n]=list;await save('pim-attempt-created',n);return detached(p);});},
  async stagePim(a:A,id:string,n:number){return withJob(a,id,async(j,save)=>{approved(j);const c=coreAt(j,n),p=attempt(j,n);need(c.execution&&c.preview,'pim-durable-receipt');if(p.stage)return detached(p.stage);await save('pim-stage-attempt',n);const stage=detached(await ports.pim.stage(a,{core_request:detached(c.request),preview:detached(c.preview.ack.head),execution_id:c.execution.ack.head.id,typed_mapping:detached(p.mapping),client_key:p.stageKey}));ref(stage.witness);need(stage.ready===true||stage.ready===false,'pim-stage-shape');need(stage.ready?stage.request!==undefined&&stage.sources!==undefined:stage.request===undefined&&stage.sources===undefined,'pim-stage-ready-branch');p.stage=stage;await save('pim-stage-observed',n,[stage.witness]);return detached(stage);});},
  async previewPim(a:A,id:string,n:number){return withJob(a,id,async(j,save)=>{const p=attempt(j,n);need(p.stage?.ready&&p.stage.request!==undefined,'pim-ready-required');need(typeof p.stage.request==='object'&&p.stage.request!==null&&Object.hasOwn(p.stage.request,'client_key')&&(p.stage.request as {client_key:unknown}).client_key===p.previewKey,'pim-request-key');if(p.preview)return detached(p.preview);p.previewAttempted=true;await save('pim-preview-attempt',n);const ack=detached(await ports.pim.preview(a,detached(p.stage.request),p.previewKey));ref(ack.witness);uuid(ack.id);need(/^[a-f0-9]{64}$/.test(ack.scope_hash),'pim-preview-scope');p.preview=ack;await save('pim-preview-observed',n,[ack.witness]);return detached(ack);});},
  async consentPim(a:A,id:string,n:number,previewId:string,scopeHash:string){return withJob(a,id,async(j,save)=>{const p=attempt(j,n);need(p.preview?.id===previewId&&p.preview.scope_hash===scopeHash,'pim-consent-scope');p.consent=scopeHash;await save('pim-consent',n);});},
  async applyPim(a:A,id:string,n:number){return withJob(a,id,async(j,save)=>{const p=attempt(j,n);if(p.applied)return detached(p.applied);need(p.preview&&p.consent===p.preview.scope_hash,'pim-native-consent-required');p.applyAttempted=true;await save('pim-apply-attempt',n);const ack=detached(await ports.pim.apply(a,p.preview.id,{client_key:p.applyKey,scope_hash:p.consent,confirmed:true}));ref(ack.witness);need(ack.scope_hash===p.consent,'pim-apply-scope');p.applied=ack;await save('pim-apply-observed',n,[ack.witness]);return detached(ack);});},
  async inspect(a:A,id:string){return withJob(a,id,async j=>detached(j));},
 };
}
