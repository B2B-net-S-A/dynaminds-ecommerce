import {inspectRetirementControlSidecars} from '../../../server/large-import/unallocated-upload-retirement';
/** Existing absent receipt inspection only. No keeper, quota release, write or readiness capability. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readPrivate} from '../pim-large-import173-runtime-fs-integration-backend2/publisher';
import type {Client} from '../pim-large-import173-runtime-fs-integration-backend2/storage';
import {absentPaths} from '../pim-large-import173-absent-prefix-reconcile-backend/absence-inspection';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const count=(v:unknown)=>{const n=Number(v);assert(Number.isSafeInteger(n)&&n>=0,'absent-safe-count');return n;};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
type Scope={tenantId:string;actorId:string;apiKeyId:string|null};
const ownedFacts=new WeakMap<object,unknown>();
export function inspectOwnedTerminalAbsent(value:object){const fact=ownedFacts.get(value);assert(fact,'absent-authentic-fresh-inspection');return structuredClone(fact);}
/** Pure receipt predicate; it cannot mint a fresh inspector result. */
export function assertRetainedAbsentReceipt(scope:Scope,reservation:any,resources:any[]){
 for(const id of [scope.tenantId,scope.actorId,reservation?.id,reservation?.request_id])assert(uuid(id),'absent-canonical-identity');
 assert(scope.apiKeyId===null||uuid(scope.apiKeyId));
 assert(reservation.tenant_id===scope.tenantId&&reservation.actor_id===scope.actorId&&reservation.api_key_id===scope.apiKeyId,'absent-native-owner');
 assert(reservation.kind==='upload'&&reservation.state==='retained'&&reservation.outcome==='absent'&&typeof reservation.closed_at==='string'&&Number.isFinite(Date.parse(reservation.closed_at)),'absent-retained-original');
 const paths=absentPaths(scope,reservation.request_id);assert(resources.length===6&&Buffer.byteLength(JSON.stringify(resources))<=2*1024*1024,'absent-exact-resource-budget');
 const keys=new Set<string>(),directoryRows:any[]=[];let evidence:any,evidenceRow:any;
 for(const r of resources){
  assert(r.tenant_id===scope.tenantId&&r.reservation_id===reservation.id&&typeof r.resource_key==='string'&&!keys.has(r.resource_key),'absent-resource-owner-unique');keys.add(r.resource_key);
  assert(typeof r.payload_text==='string'&&Buffer.byteLength(r.payload_text)===count(r.byte_count)&&sha(r.payload_text)===r.sha256,'absent-original-byte-hash');
  if(r.resource_key.startsWith('blob:fs:directory:')){
   const p=JSON.parse(r.payload_text);assert.deepEqual(Object.keys(p).sort(),['mode','path','schema']);
   assert(r.kind==='blob'&&r.state==='released'&&p.schema==='private-directory-allocation/v1'&&p.mode===448&&paths.includes(p.path)&&r.resource_key==='blob:fs:directory:'+sha(p.path),'absent-exact-released-directory');directoryRows.push(r);
  }else{
   const m=/^event:upload-absent-close:([a-f0-9-]{36})$/.exec(r.resource_key);assert(m&&uuid(m[1])&&r.kind==='event'&&r.state==='settled'&&!evidenceRow,'absent-original-receipt-key');
   evidenceRow=r;evidence=JSON.parse(r.payload_text);assert.deepEqual(Object.keys(evidence).sort(),['inventory_text','receipt','schema']);
   assert(evidence.schema==='quota-absent-close-evidence/v1'&&typeof evidence.inventory_text==='string'&&Buffer.byteLength(evidence.inventory_text)<=1048576,'absent-bounded-immutable-proof');
   const receipt=evidence.receipt;assert.deepEqual(Object.keys(receipt).sort(),['client_key','inventory_sha256','native_time','released_directory_count','request_id','reservation_id','schema','tenant_id']);
   assert(receipt.schema==='quota-absent-close-receipt/v1'&&receipt.client_key===m[1]&&receipt.tenant_id===scope.tenantId&&receipt.reservation_id===reservation.id&&receipt.request_id===reservation.request_id&&receipt.released_directory_count===5&&receipt.inventory_sha256===sha(evidence.inventory_text)&&receipt.inventory_sha256===reservation.inventory_sha256,'absent-immutable-receipt-binding');
   assert(typeof receipt.native_time==='string'&&Number.isFinite(Date.parse(receipt.native_time))&&Date.parse(receipt.native_time)<=Date.parse(reservation.closed_at),'absent-native-close-time');
  }
 }
 assert(evidenceRow&&directoryRows.length===5&&new Set(directoryRows.map(r=>JSON.parse(r.payload_text).path)).size===5,'absent-five-released-paths');
 const proof=JSON.parse(evidence.inventory_text);assert.deepEqual(Object.keys(proof).sort(),['fs_cut','metadata_cut','request_id','reservation_id','resources','schema','scope']);
 assert(proof.schema==='private-upload-absent-close/v1'&&proof.request_id===reservation.request_id&&proof.reservation_id===reservation.id);assert.deepEqual(proof.scope,scope);
 const original=directoryRows.map(r=>({resource_key:r.resource_key,kind:r.kind,byte_count:count(r.byte_count),sha256:r.sha256,state:'intent',payload_text:r.payload_text})).sort((a,b)=>a.resource_key<b.resource_key?-1:a.resource_key>b.resource_key?1:0);
 assert.deepEqual(proof.resources,original,'absent-original-intents-now-released');assert.deepEqual(proof.metadata_cut,{blobs:0,jobs:0,reviews:0});
 assert(Array.isArray(proof.fs_cut)&&proof.fs_cut.length===6&&proof.fs_cut[0]?.path==='.'&&proof.fs_cut[0].state==='present'&&proof.fs_cut[0].kind==='directory'&&proof.fs_cut[0].mode===448,'absent-historical-root-cut');
 assert.deepEqual(proof.fs_cut.slice(1),paths.map(path=>({path,state:'absent'})),'absent-original-five-absence-cuts');
 assert(count(reservation.raw_charge)===0&&count(reservation.metadata_charge)===2*count(evidenceRow.byte_count)&&count(reservation.objects_charge)===2,'absent-original-retained-charges');
 const effectiveCharge={raw:0,metadata:count(reservation.metadata_charge),objects:2};for(const k of ['raw','metadata','objects'] as const)assert(effectiveCharge[k]<=count(reservation[k+'_ceiling']));
 return{paths,effectiveCharge,receipt_sha256:evidenceRow.sha256,inventory_sha256:reservation.inventory_sha256,resource_keys:[...keys].sort()};
}
/** Same owner RR READ ONLY client and original canonical custody. Full census handles other allocations independently. */
export async function inspectTerminalAbsentReadOnly(c:Client,root:string,controlRoot:string,scope0:Scope,reservationId:string){
 const scope=structuredClone(scope0);assert(uuid(reservationId));
 const context=(await c.query("SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation")).rows[0];assert(context?.ro==='on'&&context.isolation==='repeatable read','absent-owner-repeatable-read-only');
 const reservation=(await c.query('SELECT to_jsonb(r) fact FROM public.large_import_quota_reservations173 r WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid AND id=$4',[scope.tenantId,scope.actorId,scope.apiKeyId,reservationId])).rows[0]?.fact;
 const resources=(await c.query('SELECT to_jsonb(r) fact FROM public.large_import_quota_resources173 r WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY resource_key COLLATE "C"',[scope.tenantId,reservationId])).rows.map(r=>r.fact);
 const receipt=assertRetainedAbsentReceipt(scope,reservation,resources);
 const stamp=(s:any)=>['dev','ino','uid','gid','mode','nlink','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
 async function directory(path:string){assert(path===resolve(path)&&await realpath(path)===path,'absent-canonical-private-directory');const s=await lstat(path,{bigint:true});assert(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&511n)===448n&&s.uid===BigInt(process.getuid!()),'absent-private-directory-owner');return stamp(s);}
 const rootStamp=await directory(root),controlStamp=await directory(controlRoot),names=(await readdir(controlRoot)).sort();const recordNames=await inspectRetirementControlSidecars(controlRoot,names);let own:any,ownPath:string|undefined,ownBytes:Buffer|undefined;
 for(const name of recordNames){const bytes=await readPrivate(join(controlRoot,name),32768),r=JSON.parse(bytes.toString('utf8'));if(r.key?.tenantId===scope.tenantId&&r.allocations?.upload?.reservationId===reservationId){assert(!own,'absent-duplicate-control');own=r;ownPath=join(controlRoot,name);ownBytes=bytes;assert(r.schema==='large-import-private-allocation/v1'&&JSON.stringify(r)===bytes.toString('utf8')&&sha(JSON.stringify(r.key))+'.json'===name,'absent-canonical-saved-custody');}}
 assert(own&&own.key.kind==='upload'&&own.key.userId===scope.actorId&&own.key.apiKeyId===scope.apiKeyId&&own.key.publicId===reservation.request_id&&uuid(own.key.catalogId)&&uuid(own.witnessId)&&Object.keys(own.allocations).join(',')==='upload','absent-original-control-principal');
 const allocation=own.allocations.upload;assert(allocation.kind==='upload'&&allocation.requestId===reservation.request_id&&allocation.reservationId===reservationId&&typeof allocation.privateToken==='string'&&/^[a-f0-9]{64}$/.test(allocation.privateToken)&&sha(allocation.privateToken)===reservation.token_hash,'absent-original-private-allocation');
 assert.deepEqual(allocation.ceiling,{raw:count(reservation.raw_ceiling),metadata:count(reservation.metadata_ceiling),objects:count(reservation.objects_ceiling)},'absent-original-ceilings');
 const parentCuts:any[]=[];
 async function absentRequest(){
  // Shared tenant/actor parents may now exist for unrelated requests; never call them absent or release them again.
  for(const path of receipt.paths.slice(0,-1)){try{const s=await lstat(join(root,path));assert(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&511)===448&&s.uid===process.getuid!()&&await realpath(join(root,path))===join(root,path),'absent-shared-parent-private');parentCuts.push({path,state:'shared-parent-present',dev:s.dev,ino:s.ino});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;parentCuts.push({path,state:'absent'});}}
  try{await lstat(join(root,receipt.paths[4]));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('absent-original-request-republished');
 }
 await absentRequest();const firstParents=parentCuts.splice(0);
 const guard=(await c.query("SELECT prosrc FROM pg_proc WHERE oid='public.large_import_quota_publication_pin_many173(uuid,uuid,uuid,text,text,uuid,text,jsonb)'::regprocedure")).rows[0]?.prosrc;assert(typeof guard==='string'&&guard.includes("IF NOT FOUND OR b.state IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'Publication reservation is not active/owned'"),'absent-original-late-publication-denied');
 await absentRequest();assert.deepEqual(parentCuts,firstParents,'absent-parent-cut-changed');assert(await directory(root)===rootStamp&&await directory(controlRoot)===controlStamp);assert.deepEqual((await readdir(controlRoot)).sort(),names);assert((await readPrivate(ownPath!,32768)).equals(ownBytes!),'absent-custody-changed');
 const result=Object.freeze({schema:'attributed-terminal-absent/v1',classification:'ATTRIBUTED_TERMINAL_ABSENT_ORIGINAL_DENIED',usable:false,tenant_id:scope.tenantId,reservation_id:reservationId,request_id:reservation.request_id,native_state:'retained',outcome:'absent',effectiveCharge:receipt.effectiveCharge,receipt_sha256:receipt.receipt_sha256,inventory_sha256:receipt.inventory_sha256,original_late_publication_denied:true,native_state_modified:false,quota_released:false});
 ownedFacts.set(result,{...result,accounted_resource_keys:receipt.resource_keys,current_request_directory_absent:true,shared_parent_cut_sha256:sha(JSON.stringify(firstParents))});return result;
}
