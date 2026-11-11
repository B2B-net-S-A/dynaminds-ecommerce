/** Source-only private-request PostgreSQL quota broker. No default client, app, filesystem, workers or autorun. */
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import type {Actor} from '../../../server/domain';
import {createDedicatedMetadataTransport,type Ports as TransportPorts} from '../pim-large-import173-composed-runtime-backend/transport';
import type {Client} from '../pim-large-import173-composed-runtime-backend/storage';
import {quotaTransaction as transaction} from './transaction';
import type {Captured,QuotaReservation} from '../pim-large-import-authenticated-upload-ui/upload';
type Request=Parameters<ReturnType<typeof createDedicatedMetadataTransport>['capture']>[0];
export type Ceiling={raw:number;metadata:number;objects:number};
export type Kind='raw'|'blob'|'batch'|'job'|'review'|'event';
export type Resource={key:string;kind:Kind;byte_count:number;sha256:string;payload_text?:string};
export type OwnedRequest={requestId:string;reservationId:string;privateToken:string;kind:'upload'|'job'|'review';ceiling:Ceiling};
export type Observed=Resource&{state:'settled'|'quarantined';witness:{id:string;sha256:string;byte_count:number}};
export type Inventory={
 /** Complete private-store and metadata inventory, INCLUDING pending/quarantine/orphan records; never just acknowledged_bytes. */
 inspect(requestId:string,reservationId:string):Promise<{complete:boolean;pending:boolean;resources:Observed[];witness:{id:string;sha256:string;byte_count:number}}>;
};
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex'),clone=<T>(v:T):T=>structuredClone(v),same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const hex=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function resource(r:Resource){assert(r&&/^(raw|blob|batch|job|review|event):[a-z0-9:-]{1,160}$/.test(r.key)&&r.key.split(':')[0]===r.kind&&count(r.byte_count)&&hex(r.sha256),'quota-resource-shape');if(r.kind==='raw')assert(r.payload_text===undefined,'quota-raw-no-text');else assert(typeof r.payload_text==='string'&&Buffer.byteLength(r.payload_text)===r.byte_count&&sha(r.payload_text)===r.sha256,'quota-exact-metadata-text');}
function witness(r:Observed['witness']){assert(r&&typeof r.id==='string'&&r.id.length>0&&count(r.byte_count)&&hex(r.sha256),'quota-actual-inventory-witness');}
/** Genuine request capture and credential remains private. SQL repeats actual173 admission under the same session role. */
export function createUploadQuotaBroker(ports:TransportPorts){
 const transport=createDedicatedMetadataTransport(ports),facts=new WeakMap<Actor,string>();
 return{capture(request:Request){const actor=transport.capture(request),raw=actor.apiKeyId?request.headers.authorization?.replace(/^Bearer /,''):(request.cookies[ports.sessionName]??request.headers.authorization?.replace(/^Bearer /,''));assert(raw);facts.set(actor,sha(raw));return actor;},
  bind(actor:Actor,request:OwnedRequest,inventory:Inventory){
   request=clone(request);assert(facts.has(actor),'quota-original-actor-required');assert(uuid(request.requestId)&&uuid(request.reservationId)&&typeof request.privateToken==='string'&&request.privateToken.length>=32,'quota-private-request-identity');assert(['upload','job','review'].includes(request.kind)&&count(request.ceiling.raw)&&count(request.ceiling.metadata)&&count(request.ceiling.objects)&&request.ceiling.objects>0,'quota-ceiling');
   const {scope,ports:metadata}=transport.bind(actor),digest=facts.get(actor)!,tokenHash=sha(request.privateToken),auth=[actor.userId,actor.tenantId,actor.apiKeyId??null,actor.role,digest],captured:Captured={principal:clone(scope),authorityStamp:sha(JSON.stringify({scope,request:request.requestId,tokenHash}))};
   let reserved=false;
   const invoke=async<T>(work:(c:Client)=>Promise<T>):Promise<T>=>{let c:Client|undefined,failed=false,first:unknown,out:T|undefined;try{c=await metadata.connect(scope);out=await transaction(c,async()=>{await metadata.admit(c!,scope);const x=await work(c!);await metadata.admit(c!,scope);return x;},metadata.cleanupFailure);}catch(e){failed=true;first=e;}finally{if(c)try{await c.end();}catch(e){try{metadata.cleanupFailure(e);}catch{}if(!failed){failed=true;first=e;}}}if(failed)throw first;return out!;};
   const call=async(c:Client,name:string,args:unknown[])=>{assert(['reserve','intent','settle','close','snapshot'].includes(name));const v=[...auth,...args],sql=`SELECT public.large_import_quota_${name}173(${v.map((_,i)=>'$'+(i+1)).join(',')}) fact`,row=(await c.query(sql,v)).rows[0];assert(row&&row.fact,'quota-native-return');return clone(row.fact);};
   const owned=(v:QuotaReservation)=>assert(v&&v.id===request.reservationId,'quota-reservation-custody');
   const snapshot=()=>invoke(c=>call(c,'snapshot',[request.reservationId,tokenHash]));
   const checkInventory=async()=>{const retained=clone(await inventory.inspect(request.requestId,request.reservationId));witness(retained.witness);assert(retained.complete===true&&retained.pending===false&&Array.isArray(retained.resources),'quota-complete-private-inventory-required');const keys=new Set<string>();for(const x of retained.resources){resource(x);witness(x.witness);assert(['settled','quarantined'].includes(x.state)&&!keys.has(x.key),'quota-inventory-state-or-duplicate');keys.add(x.key);}return retained;};
   return{captured:clone(captured),
    quotas:{
     async reserve(c:Captured,maxBytes:number):Promise<QuotaReservation>{c=clone(c);assert(same(c,captured)&&maxBytes===request.ceiling.raw,'quota-captured-ceiling-binding');const row=await invoke(c=>call(c,'reserve',[request.reservationId,request.requestId,tokenHash,request.kind,request.ceiling.raw,request.ceiling.metadata,request.ceiling.objects]));assert(row.id===request.reservationId&&row.request_id===request.requestId,'quota-native-reservation-binding');assert(row.state==='open'&&row.reused===false,'quota-existing-request-requires-exact-registry-recovery-no-upload-rerun');reserved=true;return{id:request.reservationId};},
     async close(q:QuotaReservation,result:{outcome:'ready'|'quarantined'|'unknown';acknowledged_bytes:number;raw:unknown}){owned(q);assert(count(result.acknowledged_bytes)&&result.acknowledged_bytes<=request.ceiling.raw,'quota-acknowledged-range');if(result.outcome==='unknown'){await invoke(c=>call(c,'close',[q.id,tokenHash,'unknown',null,null]));return;}
      const observed=await checkInventory(),native=await snapshot();assert(Array.isArray(native.resources),'quota-native-resource-inventory');const wanted=[...observed.resources].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);assert(native.resources.length===wanted.length,'quota-orphan-or-untracked-retained-resource');for(let i=0;i<wanted.length;i++){const a=native.resources[i],b=wanted[i];assert(a.resource_key===b.key&&a.kind===b.kind&&String(a.byte_count)===String(b.byte_count)&&a.sha256===b.sha256&&a.state===b.state,'quota-native-private-resource-equality');}
      const proof=sha(JSON.stringify({schema:'quota-inventory/v1',request_id:request.requestId,reservation_id:q.id,resources:wanted.map(r=>({key:r.key,kind:r.kind,byte_count:r.byte_count,sha256:r.sha256,state:r.state,payload_text:r.payload_text??null}))}));await invoke(c=>call(c,'close',[q.id,tokenHash,result.outcome,proof,wanted.map(r=>r.key)]));
     },
    },
    /** Call before each physical/metadata operation. Same intent never authorizes a second unknown write. */
    async intent(r:Resource){assert(reserved,'quota-reservation-before-mutation');r=clone(r);resource(r);return invoke(c=>call(c,'intent',[request.reservationId,tokenHash,r.key,r.kind,r.byte_count,r.sha256,r.payload_text??null]));},
    /** Actual immutable byte/text inspection required; no caller acknowledged byte guess. */
    async settle(r:Observed){r=clone(r);resource(r);witness(r.witness);assert(['settled','quarantined'].includes(r.state));return invoke(c=>call(c,'settle',[request.reservationId,tokenHash,r.key,r.byte_count,r.sha256,r.state==='quarantined']));},

    /** The supplied operation must be the exact owned raw/metadata write, never arbitrary caller work. */
    async perform<T>(r:Resource,write:()=>Promise<T>,inspect:()=>Promise<Observed>){
     assert(reserved,'quota-reservation-before-mutation');r=clone(r);resource(r);const receipt=await invoke(c=>call(c,'intent',[request.reservationId,tokenHash,r.key,r.kind,r.byte_count,r.sha256,r.payload_text??null]));
     if(receipt.state!=='intent'){const found=clone(await inspect());resource(found);witness(found.witness);assert(found.key===r.key&&found.kind===r.kind&&found.byte_count===r.byte_count&&found.sha256===r.sha256&&found.state===receipt.state,'quota-replayed-owned-inspection');return{performed:false as const,resource:found};}
     let failed=false,first:unknown,value:T|undefined;
     try{value=await write();const found=clone(await inspect());resource(found);witness(found.witness);assert(found.key===r.key&&found.kind===r.kind&&found.byte_count===r.byte_count&&found.sha256===r.sha256&&found.state==='settled','quota-written-owned-inspection');await invoke(c=>call(c,'settle',[request.reservationId,tokenHash,r.key,r.byte_count,r.sha256,false]));}catch(e){failed=true;first=e;}
     if(failed){try{await invoke(c=>call(c,'close',[request.reservationId,tokenHash,'unknown',null,null]));}catch(e){try{metadata.cleanupFailure(e);}catch{}}throw first;}
     return{performed:true as const,value};
    },
    /** Lost write/close ACK recovery retains the original key, token, resource shape and pending facts. */
    async reconcile(){const observed=await checkInventory(),native=await snapshot();assert(Array.isArray(native.resources)&&native.resources.length===observed.resources.length,'quota-recovery-full-inventory');for(const r of observed.resources){const n=native.resources.find((x:any)=>x.resource_key===r.key);assert(n&&n.kind===r.kind&&String(n.byte_count)===String(r.byte_count)&&n.sha256===r.sha256,'quota-recovery-exact-resource');if(native.reservation.state!=='retained')await invoke(c=>call(c,'settle',[request.reservationId,tokenHash,r.key,r.byte_count,r.sha256,r.state==='quarantined']));}return snapshot();},snapshot,
   };
  },
 };
}
