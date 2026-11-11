/** Server-side view framing only. Job/v1 and CoreReview are preserved; no native keys or consents are generated. */
import {createHash} from 'node:crypto';
import {Problem,ensure} from '../../../server/errors';
import type {Job,CoreReview} from './contracts';
export type Token={job_revision:number;review_revision:number|null;scope_hash:string|null;job_hash:string;review_hash:string|null};
export type Frame={kind:'manifest'|'event'|'core'|'core_page'|'core_row'|'pim'|'review_batch'|'review_page'|'review_row';batch:number;page?:number;ordinal?:number;value:unknown};
export type Summary={schema:'large-import-http-snapshot/v1';token:Token;job_header:Omit<Job,'core'|'pim'|'events'|'manifest'>&{manifest:Omit<Job['manifest'],'batches'>};review_header:Omit<CoreReview,'batches'>|null;total_frames:number;core_rows:number;review_rows:number};
export type FramePage={schema:'large-import-http-frames/v1';token:Token;start:number;frames:Frame[];next:string|null};
export const NETWORK_PAGE_BYTES=4*1024*1024;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function snapshotView(job:Job,review:CoreReview|null){
 const token:Token={job_revision:job.revision,review_revision:review?.revision??null,scope_hash:review?.aggregate_scope_hash??null,job_hash:hash(job),review_hash:review?hash(review):null},frames:Frame[]=[];let coreRows=0,reviewRows=0;
 job.manifest.batches.forEach((value,batch)=>frames.push({kind:'manifest',batch,value}));job.events.forEach((value,batch)=>frames.push({kind:'event',batch,value}));
 job.core.forEach((c,batch)=>{const {preview,execution,...base}=c;frames.push({kind:'core',batch,value:{...base,...(preview?{preview:{ack:preview.ack}}:{}),...(execution?{execution:{ack:execution.ack}}:{})}});
  for(const [phase,p]of [[0,preview],[1,execution]] as const)if(p)p.pages.forEach((pg,n)=>{const {rows,...base}=pg;frames.push({kind:'core_page',batch,page:phase*10+n,value:{...base,row_count:rows.length}});rows.forEach((value,ordinal)=>{frames.push({kind:'core_row',batch,page:phase*10+n,ordinal,value});coreRows++;});});
 });
 for(const [key,value]of Object.entries(job.pim))frames.push({kind:'pim',batch:Number(key),value});
 review?.batches.forEach((b,batch)=>{const {preview,...base}=b;frames.push({kind:'review_batch',batch,value:{...base,preview:{ack:preview.ack}}});preview.pages.forEach((pg,page)=>{const {rows,...base}=pg;frames.push({kind:'review_page',batch,page,value:{...base,row_count:rows.length}});rows.forEach((value,ordinal)=>{frames.push({kind:'review_row',batch,page,ordinal,value});reviewRows++;});});});
 const {core,pim,events,manifest,...head}=job,{batches,...manifestHead}=manifest;let reviewHead:Summary['review_header']=null;if(review){const {batches,...h}=review;reviewHead=h;}
 const summary:Summary={schema:'large-import-http-snapshot/v1',token,job_header:{...head,manifest:manifestHead},review_header:reviewHead,total_frames:frames.length,core_rows:coreRows,review_rows:reviewRows};
 ensure(Buffer.byteLength(JSON.stringify(summary))<=NETWORK_PAGE_BYTES,413,'Nagłówek podglądu przekracza limit odpowiedzi');
 return {summary,page(expected:Token,cursor:number):FramePage{ensure(hash(expected)===hash(token),409,'Podgląd zmienił się podczas odczytu');ensure(Number.isSafeInteger(cursor)&&cursor>=0&&cursor<frames.length,422,'Nieprawidłowy kursor');const selected:Frame[]=[];let bytes=2048;
  for(let n=cursor;n<frames.length&&selected.length<100;n++){const frame=frames[n],size=Buffer.byteLength(JSON.stringify(frame))+1;ensure(size<=NETWORK_PAGE_BYTES-2048,413,'Pojedynczy pełny wiersz lub rekord przekracza limit strony');if(bytes+size>NETWORK_PAGE_BYTES)break;selected.push(frame);bytes+=size;}
  ensure(selected.length>0,413,'Strona przekracza limit odpowiedzi');const next=cursor+selected.length;return {schema:'large-import-http-frames/v1',token,start:cursor,frames:selected,next:next<frames.length?String(next):null};
 }};
}
