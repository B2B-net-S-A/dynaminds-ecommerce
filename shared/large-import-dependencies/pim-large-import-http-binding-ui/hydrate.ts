/** Browser-safe exact framing receiver. No crypto/Node import, no mutation of input records or consent. */
import type {Summary,FramePage,Token} from './snapshot';
import type {Job,CoreReview} from './contracts';
import {same} from '../pim-large-import-complete-file-review-ui2/model';
export type LoadProgress={loaded_frames:number;total_frames:number;loaded_core_rows:number;total_core_rows:number;loaded_review_rows:number;total_review_rows:number;complete:boolean};
const need=(v:unknown,m:string)=>{if(!v)throw Error(m);};
/** The existing strict UI decoder validates the completed Job/CoreReview before exposing approval controls. */
export async function hydrateSnapshot(summary:Summary,read:(token:Token,cursor:number)=>Promise<FramePage>,progress:(p:LoadProgress)=>void=()=>{}){
 need(summary.schema==='large-import-http-snapshot/v1'&&Number.isSafeInteger(summary.total_frames)&&summary.total_frames>0&&summary.total_frames<=10_000_000&&Number.isSafeInteger(summary.core_rows)&&summary.core_rows>=0&&Number.isSafeInteger(summary.review_rows)&&summary.review_rows>=0,'Nieprawidłowy nagłówek odczytu');
 const t=summary.token,h=summary.job_header,r=summary.review_header;
 need(t&&Number.isSafeInteger(t.job_revision)&&t.job_revision>=0&&h?.revision===t.job_revision&&/^[a-f0-9]{64}$/.test(t.job_hash),'Nagłówek nie odpowiada natywnej rewizji');
 need(r?Number.isSafeInteger(t.review_revision)&&t.review_revision!>=0&&r.revision===t.review_revision&&r.aggregate_scope_hash===t.scope_hash&&/^[a-f0-9]{64}$/.test(t.review_hash??''):t.review_revision===null&&t.scope_hash===null&&t.review_hash===null,'Nagłówek przeglądu nie odpowiada rewizji');
 const job:any={...structuredClone(summary.job_header),manifest:{...structuredClone(summary.job_header.manifest),batches:[]},core:[],events:[],pim:{}},review:any=summary.review_header?{...structuredClone(summary.review_header),batches:[]}:null;
 let cursor=0,coreRows=0,reviewRows=0;const expectedRows=new Map<string,number>();
 const emit=(complete:boolean)=>progress({loaded_frames:cursor,total_frames:summary.total_frames,loaded_core_rows:coreRows,total_core_rows:summary.core_rows,loaded_review_rows:reviewRows,total_review_rows:summary.review_rows,complete});emit(false);
 for(;;){const page=await read(summary.token,cursor);need(page.schema==='large-import-http-frames/v1'&&same(page.token,summary.token)&&page.start===cursor&&Array.isArray(page.frames)&&page.frames.length>0&&page.frames.length<=100,'Strona nie odpowiada zapisanej rewizji');
  for(const f of page.frames){need(Number.isSafeInteger(f.batch)&&f.batch>=0,'Nieprawidłowa partia');const v=structuredClone(f.value),n=f.page;
   switch(f.kind){case'manifest':need(f.batch===job.manifest.batches.length,'Niepełny manifest');job.manifest.batches.push(v);break;
    case'event':need(f.batch===job.events.length,'Niepełne zdarzenia');job.events.push(v);break;
    case'core':need(f.batch===job.core.length,'Niepełne partie');for(const k of ['preview','execution'])if((v as any)[k])(v as any)[k].pages=[];job.core.push(v);break;
    case'core_page':case'review_page':{need(Number.isSafeInteger(n)&&n!>=0&&n!<=14,'Nieprawidłowa strona');const target=f.kind==='core_page'?job.core[f.batch]?.[n!>=10?'execution':'preview']:review?.batches[f.batch]?.preview,pageNo=f.kind==='core_page'?n!%10:n!;need(target&&pageNo===target.pages.length,'Niepełne strony');const {row_count,...head}=v as any;need(Number.isSafeInteger(row_count)&&row_count>0&&row_count<=100,'Niepełny zakres strony');target.pages.push({...head,rows:[]});expectedRows.set(f.kind+':'+f.batch+':'+n,row_count);break;}
    case'core_row':case'review_row':{const target=f.kind==='core_row'?job.core[f.batch]?.[n!>=10?'execution':'preview']?.pages[n!%10]:review?.batches[f.batch]?.preview.pages[n!];need(target&&f.ordinal===target.rows.length,'Niepełne wiersze');target.rows.push(v);f.kind==='core_row'?coreRows++:reviewRows++;break;}
    case'pim':need(!Object.hasOwn(job.pim,f.batch),'Powtórzona próba');job.pim[f.batch]=v;break;
    case'review_batch':need(review&&f.batch===review.batches.length,'Niepełny przegląd');(v as any).preview.pages=[];review.batches.push(v);break;
    default:throw Error('Nieznany rekord odczytu');
   }
  }
  cursor+=page.frames.length;need(cursor<=summary.total_frames,'Nadmiar rekordów');emit(false);if(page.next===null)break;need(page.next===String(cursor)&&cursor<summary.total_frames,'Nieprawidłowy kursor');
 }
 need(cursor===summary.total_frames&&coreRows===summary.core_rows&&reviewRows===summary.review_rows&&job.core.length===job.manifest.total_batches&&job.manifest.batches.length===job.manifest.total_batches,'Niepełny odczyt całego planu');
 for(const [key,count]of expectedRows){const [kind,b,p]=key.split(':'),n=Number(p),row=kind==='core_page'?job.core[Number(b)]?.[n>=10?'execution':'preview']?.pages[n%10]:review?.batches[Number(b)]?.preview.pages[n];need(row?.rows.length===count,'Niepełny natywny zakres wierszy');}
 emit(true);return {job:job as Job,review:review as CoreReview|null};
}
