/** Browser-safe authenticated adapter ports only. No URL, store, coordinator runtime or authority fabrication. */
import{decodeState,same,type State,type Ports,type Command,type ResolutionAck,type Context,type Job,type ContinuationFence}from'./model';
import{largeImportLocked}from'../pim-large-import-job-flow-ui2/model';
import type{CoreReview}from'../pim-large-import-job-coordinator-backend5/core-review';
export type CoordinatorClient={
 inspectCoreReview(jobId:string):Promise<{job:Job;review:CoreReview|null}>;
 previewCore(jobId:string,batch:number):Promise<unknown>;
 reviewCoreFile(jobId:string):Promise<CoreReview>;
 consentCoreFile(jobId:string,scopeHash:string):Promise<CoreReview>;
 consentCore(jobId:string,batch:number,previewId:string,scopeHash:string):Promise<void>;
 executeCore(jobId:string,batch:number):Promise<NonNullable<Job['core'][number]['execution']>>;
 /** Genuine durable receipt/original-key resolution, supplied by future authenticated integration. */
 resolveExact(jobId:string,command:Command):Promise<ResolutionAck>;
};
export type Admission={context:Context;jobId:string;available:boolean;independentCreates:boolean;canManage:boolean;externalWriteBlocked:boolean};
const need=(v:unknown,m:string)=>{if(!v)throw Error(m);};
/** Ephemeral view only; durable data remains the unchanged Job/v1 and exact CoreReview sidecar. */
export function reviewView(job:Job,review:CoreReview|null,a:Admission):State{
 const base={schema:'large-import-complete-review/v1' as const,job,capability:{existing_updates:a.available,independent_creates:a.independentCreates,dependency_groups:false as const},reasons:[] as string[],scope:review,unknown:null};
 if(!a.available)return{...base,phase:'unavailable',scope:null,reasons:['Pełny plan natywny nie jest podłączony do trwałego adaptera tej instalacji.']};
 if(!review)return{...base,phase:'planning'};
 const uncertain=job.core.findIndex((b,n)=>!b.execution&&job.events.some(e=>e.kind==='core-execute-attempt'&&e.batch===n));
 if(uncertain>=0){const b=review.batches[uncertain];need(b,'Brak zakresu nierozstrzygniętej próby');return{...base,phase:'unknown',unknown:{id:b.execute_key,batch:uncertain,preview_id:b.preview_id,scope_hash:b.scope_hash,client_key:b.execute_key}};}
 const count=job.core.filter(b=>b.execution).length;
 return{...base,phase:count===job.core.length?'complete':count>0?'partial':review.approved_scope_hash===review.aggregate_scope_hash?'approved':'reviewable'};
}
/** Every awaited step is followed by a latest scope/capability/OTHER-lock fence. Own exact custody is excluded upstream. */
export function createCompleteReviewAdapter(client:CoordinatorClient,latest:()=>Admission):Ports{
 const capture=(id:string,write:boolean)=>{const a=structuredClone(latest());need(a.jobId===id&&a.available&&(!write||a.canManage&&!a.externalWriteBlocked&&!largeImportLocked(a.context)),'Pełny plan lub aktualne uprawnienia nie są dostępne');return a;};
 const fence=(a:Admission,write:boolean,current?:ContinuationFence)=>{current?.();const now=latest();need(same(now.context,a.context)&&now.jobId===a.jobId&&now.available===a.available&&now.independentCreates===a.independentCreates&&now.available&&(!write||now.canManage&&!now.externalWriteBlocked&&!largeImportLocked(now.context)),'Zakres lub blokada nadrzędna uległy zmianie');};
 const inspect=async(id:string)=>{const a=structuredClone(latest());need(a.jobId===id,'Inne zadanie');const value=await client.inspectCoreReview(id);need(same(latest().context,a.context)&&latest().jobId===id&&latest().available===a.available&&latest().independentCreates===a.independentCreates,'Inny zakres odczytu');return decodeState(reviewView(value.job,value.review,a),a.context,id);};
 return{inspect,
  async revalidateReview(id,scopeHash,current){current?.();const a=capture(id,true),before=await client.inspectCoreReview(id);fence(a,true,current);need(before.review?.aggregate_scope_hash===scopeHash,'Inny zachowany zakres');const result=await client.reviewCoreFile(id);fence(a,true,current);need(result.source_plan_hash===before.job.plan_hash,'Inny plan po aktualnym odczycie');return result;},
  async prepare(id,planHash,current){current?.();const a=capture(id,true),initial=await client.inspectCoreReview(id);fence(a,true,current);need(initial.job.plan_hash===planHash&&initial.job.approved&&!initial.job.core.some(b=>b.execution),'Nie można utworzyć pierwotnego planu po zapisie');
   for(let n=0;n<initial.job.core.length;n++){fence(a,true,current);await client.previewCore(id,n);fence(a,true,current);}const review=await client.reviewCoreFile(id);fence(a,true,current);need(review.source_plan_hash===planHash,'Inny plan po odczycie');return review;},
  async approve(id,scopeHash,confirmed,current){current?.();need(confirmed===true,'Brak zgody');const a=capture(id,true);const result=await client.consentCoreFile(id,scopeHash);fence(a,true,current);need(result.aggregate_scope_hash===scopeHash&&result.approved_scope_hash===scopeHash,'Zgoda nie została potwierdzona');return result;},
  async executeBatch(id,scopeHash,batch,previewId,nativeScope,confirmed,current){current?.();need(confirmed===true,'Brak zgody');const a=capture(id,true),before=await client.inspectCoreReview(id);fence(a,true,current);decodeState(reviewView(before.job,before.review,a),a.context,id);const r=before.review,b=r?.batches[batch];need(r&&r.aggregate_scope_hash===scopeHash&&r.approved_scope_hash===scopeHash&&b&&b.preview_id===previewId&&b.scope_hash===nativeScope,'Inny zatwierdzony zakres');await client.consentCore(id,batch,previewId,nativeScope);fence(a,true,current);const result=await client.executeCore(id,batch);fence(a,true,current);need(result?.ack?.head?.state==='done'&&result.ack.head.preview_id===previewId&&result.ack.head.scope_hash===nativeScope&&result.ack.head.actor_id===a.context.userId,'Nie potwierdzono natywnego wykonania');const readback=await client.inspectCoreReview(id);fence(a,true,current);decodeState(reviewView(readback.job,readback.review,a),a.context,id);need(same(readback.job.core[batch]?.execution,result),'Brak pełnego trwałego potwierdzenia wykonania');return result;},
  async resolveExact(id,command,current){current?.();const a=capture(id,true),result=await client.resolveExact(id,structuredClone(command));fence(a,true,current);return result;},
  async retryUnknown(id,attempt,current){current?.();const a=capture(id,true),result=await client.resolveExact(id,{kind:'retry_durable',attempt:structuredClone(attempt)});fence(a,true,current);return result;}
 };
}
