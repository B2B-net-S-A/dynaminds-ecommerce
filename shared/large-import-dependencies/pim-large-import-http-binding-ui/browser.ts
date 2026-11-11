/** Browser-only HTTP client. No Node/runtime imports, cookies/API credentials storage or generated native product IDs. */
import type {CoordinatorClient,Admission} from '../pim-large-import-complete-file-review-ui2/adapter';
import {createCompleteReviewAdapter} from '../pim-large-import-complete-file-review-ui2/adapter';
import type {Command,Job,CoreReview,ReadyUpload} from './contracts';
import type {CoreConfig} from '../pim-large-import-job-coordinator-backend5/native-batches';
import type {Spec} from '../pim-large-import-stream-foundation-ui2/stream';
import type {Context} from '../pim-large-import-complete-file-review-ui2/model';
import {hydrateSnapshot,type LoadProgress} from './hydrate';
import type {Summary,FramePage} from './snapshot';
export type Scope={context:Context;catalogId:string;jobId:string|null;available:boolean;canManage:boolean;externalWriteBlocked:boolean};
export type FetchPort=(input:string,init:RequestInit)=>Promise<Response>;
const eq=(a:Scope,b:Scope)=>a.catalogId===b.catalogId&&a.jobId===b.jobId&&a.context.tenantId===b.context.tenantId&&a.context.userId===b.context.userId&&a.context.apiKeyId===b.context.apiKeyId;
const uuid=(s:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s))throw Error('Nieprawidłowy identyfikator');return s.toLowerCase();};
export class ImportHttpError extends Error{constructor(public status:number,message:string,public code?:string){super(message);}}
/** Real browser default fetch is used only after an explicit caller action. Inject transport in controls. */
export function createLargeImportHttp(latest:()=>Scope,fetchPort:FetchPort=(input,init)=>fetch(input,init)){
 let live=true,generation=0;const active=new Set<AbortController>();
 const snapshot=(write:boolean)=>{const s=structuredClone(latest());if(!live||!s.available||write&&(!s.canManage||s.externalWriteBlocked))throw Error('Moduł lub uprawnienia są niedostępne');uuid(s.catalogId);if(s.jobId!==null)uuid(s.jobId);uuid(s.context.tenantId);uuid(s.context.userId);return s;};
 async function request<T>(suffix:string,method:string,body?:unknown,raw?:{file:Blob;spec:Spec;key:string},signal?:AbortSignal):Promise<T>{const s=snapshot(method!=='GET'),g=generation,c=new AbortController(),cancel=()=>c.abort();active.add(c);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)c.abort();
  const current=()=>{const n=latest();if(!live||g!==generation||!eq(s,n)||!n.available||method!=='GET'&&(!n.canManage||n.externalWriteBlocked))throw Error('Zakres odczytu został zmieniony');};
  try{const headers:Record<string,string>={'X-Workspace-ID':s.context.tenantId};let payload:BodyInit|undefined;if(raw){headers['Content-Type']='application/octet-stream';payload=raw.file;suffix+='?'+new URLSearchParams({upload_key:uuid(raw.key),spec:JSON.stringify(raw.spec)});}else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}current();
   const response=await fetchPort('/api/product-catalogs/'+uuid(s.catalogId)+'/large-import'+suffix,{method,credentials:'same-origin',headers,signal:c.signal,...(payload!==undefined?{body:payload}:{})});const value=await response.json();current();if(!response.ok){if(value.code==='MFA_REQUIRED'&&typeof window!=='undefined')window.dispatchEvent(new CustomEvent('dyna:mfa-required',{detail:{workspace:s.context.tenantId}}));throw new ImportHttpError(response.status,value.detail??'Nie można potwierdzić importu',value.code);}return value as T;
  }finally{active.delete(c);signal?.removeEventListener('abort',cancel);}
 }
 const path=(job:string)=>{const id=uuid(job);if(latest().jobId!==id)throw Error('Inne bieżące zadanie');return '/jobs/'+id;},batch=(job:string,n:number,phase:'core'|'pim')=>{if(!Number.isSafeInteger(n)||n<0||n>=100000)throw Error('Nieprawidłowa partia');return path(job)+'/'+phase+'/'+n;};
 let onProgress:(p:LoadProgress)=>void=()=>{};
 const inspectSnapshot=async(id:string,signal?:AbortSignal)=>{const summary=await request<Summary>(path(id),'GET',undefined,undefined,signal);if(summary?.job_header?.id!==uuid(id))throw Error('Nagłówek dotyczy innego zadania');return hydrateSnapshot(summary,(token,cursor)=>request<FramePage>(path(id)+'/frames?'+new URLSearchParams({token:JSON.stringify(token),cursor:String(cursor)}),'GET',undefined,undefined,signal),p=>onProgress(p));};
 const reviewAfter=async(id:string,suffix:string,body:unknown)=>{const ack=await request<{revision:number;aggregate_scope_hash:string;approved_scope_hash:string|null}>(path(id)+suffix,'POST',body),v=await inspectSnapshot(id);if(!v.review||v.review.revision!==ack.revision||v.review.aggregate_scope_hash!==ack.aggregate_scope_hash||v.review.approved_scope_hash!==ack.approved_scope_hash)throw Error('Brak dokładnego trwałego potwierdzenia zakresu');return v.review;};
 const client:CoordinatorClient={inspectCoreReview:id=>inspectSnapshot(id),previewCore:(id,n)=>request(batch(id,n,'core')+'/preview','POST',{}),reviewCoreFile:id=>reviewAfter(id,'/core-review/refresh',{}),consentCoreFile:(id,h)=>reviewAfter(id,'/core-review/consent',{scope_hash:h,confirmed:true}),consentCore:(id,n,p,h)=>request(batch(id,n,'core')+'/consent','POST',{preview_id:p,scope_hash:h,confirmed:true}),executeCore:async(id,n)=>{const ack=await request(batch(id,n,'core')+'/execute','POST',{confirmed:true});const v=await inspectSnapshot(id),r=v.job.core[n]?.execution;if(!r||JSON.stringify(r.ack)!==JSON.stringify(ack))throw Error('Brak pełnego potwierdzenia partii');return r;},resolveExact:(id,command)=>request(path(id)+'/recover','POST',{command,confirmed:true})};
 return {client,onProgress(callback:(p:LoadProgress)=>void){onProgress=callback;return()=>{if(onProgress===callback)onProgress=()=>{};};},completeReview:(latestAdmission:()=>Admission)=>createCompleteReviewAdapter(client,latestAdmission),
  /** Caller supplies ONE stable upload key; lost ACK is inspected with that key, never auto re-uploaded. Original Blob is passed directly. */
  retain(file:Blob,spec:Spec,key:string,signal?:AbortSignal){return request<ReadyUpload>('/uploads','POST',undefined,{file,spec:structuredClone(spec),key},signal);},
  inspectUpload:(key:string)=>request<ReadyUpload>('/uploads/'+uuid(key),'GET'),
  prepare:async(blobId:string,jobId:string,config:CoreConfig)=>{const ack=await request<{id:string;revision:number;plan_hash:string;approved:boolean}>('/jobs','POST',{blob_id:uuid(blobId),job_id:uuid(jobId),config});if(ack?.id!==uuid(jobId)||!Number.isSafeInteger(ack.revision)||ack.revision<0||!/^[a-f0-9]{64}$/.test(ack.plan_hash)||typeof ack.approved!=='boolean')throw Error('Nieprawidłowe potwierdzenie przygotowania');const job=(await inspectSnapshot(jobId)).job;if(job.id!==ack.id||job.revision<ack.revision||job.plan_hash!==ack.plan_hash||ack.approved&&!job.approved)throw Error('Odczyt nie potwierdza oryginalnego przygotowania');return job;},
  inspect:async(id:string,signal?:AbortSignal)=>(await inspectSnapshot(id,signal)).job,
  approveFile:(id:string,planHash:string,confirmed:boolean)=>{if(confirmed!==true)throw Error('Brak zgody na plik');return request(path(id)+'/file-consent','POST',{plan_hash:planHash,confirmed:true});},
  page:async(id:string,n:number,phase:'preview'|'execution',cursor?:string)=>{const s=await request<Summary>(path(id),'GET');return request(batch(id,n,'core')+'/rows?'+new URLSearchParams({phase,token:JSON.stringify(s.token),...(cursor?{cursor}:{})}),'GET');},
  newPimAttempt:(id:string,n:number,mapping:unknown)=>request(batch(id,n,'pim')+'/attempt','POST',{mapping}),
  stagePim:(id:string,n:number)=>request(batch(id,n,'pim')+'/stage','POST',{}),previewPim:(id:string,n:number)=>request(batch(id,n,'pim')+'/preview','POST',{}),
  consentPim:(id:string,n:number,previewId:string,scopeHash:string,confirmed:boolean)=>{if(confirmed!==true)throw Error('Brak zgody PIM');return request(batch(id,n,'pim')+'/consent','POST',{preview_id:previewId,scope_hash:scopeHash,confirmed:true});},
  applyPim:(id:string,n:number,confirmed:boolean)=>{if(confirmed!==true)throw Error('Brak zgody PIM');return request(batch(id,n,'pim')+'/apply','POST',{confirmed:true});},
  /** Scope/unmount cancels owned reads. Cancellation NEVER resolves or releases existing RAM write custody. */
  deactivate(){live=false;generation++;for(const c of active)c.abort();},activate(){if(!live){live=true;generation++;}},
 };
}
export type LargeImportHttp=ReturnType<typeof createLargeImportHttp>;
