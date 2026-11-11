/** Confirmation predicates only; caller must obtain this data from the actual authenticated scoped GET. */
import type {ReadyUpload,Job} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/contracts';
import type {SavedAttempt,NativeConfirmation} from './attempt-store';
const need=(v:unknown,m:string)=>{if(!v)throw Error(m);};
export function confirmUpload(a:SavedAttempt,u:ReadyUpload){
 need(u?.schema==='retained-large-import-upload/v1'&&u.status==='UPLOAD_RETAINED_READY_NOT_NATIVE_APPROVED'&&/^[a-f0-9-]{36}$/.test(u.blob_id),'Inne potwierdzenie zachowanego pliku');
 need(u.raw?.id==='large-import-raw/v1:'+u.blob_id&&/^[a-f0-9]{64}$/.test(u.raw.sha256)&&u.raw.byte_count===a.fileSize,'Potwierdzenie dotyczy innych bajtów pliku');
 const m=u.manifest;need(m?.schema==='large-core-import-file/v1'&&m.format===a.spec.format&&m.raw.completed_eof===true&&m.raw.parse_valid===true&&m.raw.sha256===u.raw.sha256&&m.raw.byte_count===a.fileSize,'Niepełne źródło zachowanego pliku');
 need(u.spec?.format===a.spec.format&&(a.spec.format==='csv'?u.spec.format==='csv'&&u.spec.delimiter===a.spec.delimiter:u.spec.format==='xml'&&u.spec.recordPath===a.spec.recordPath),'Potwierdzenie dotyczy innego formatu');
 need(Number.isSafeInteger(m.records)&&m.records>0&&Array.isArray(m.batches)&&Number.isSafeInteger(m.total_batches)&&m.total_batches===m.batches.length&&m.batches.every((b,n)=>b.index===n&&Number.isSafeInteger(b.rows)&&b.rows>0&&b.rows<=500)&&m.batches.reduce((n,b)=>n+b.rows,0)===m.records,'Niepełny opis zachowanych partii');
 return u;
}
/** Known queued jobs do not require Core/PIM completion; only genuinely unresolved write attempts refuse rotation. */
export function hasUnresolvedNativeWrites(j:Pick<Job,'core'|'pim'|'events'>){
 return j.core.some((c,n)=>!c.execution&&j.events.some(e=>e.kind==='core-execute-attempt'&&e.batch===n))||Object.values(j.pim).some(list=>list.some(x=>x.previewAttempted&&!x.preview||x.applyAttempted&&!x.applied));
}
export function confirmOriginalJob(a:SavedAttempt,j:Job){
 need(j.id===a.jobId&&j.raw.byte_count===a.fileSize&&j.parsing_spec.format===a.spec.format,'Odczyt dotyczy innego oryginalnego zadania');
 need(a.spec.format==='csv'?j.parsing_spec.format==='csv'&&j.parsing_spec.delimiter===a.spec.delimiter:j.parsing_spec.format==='xml'&&j.parsing_spec.recordPath===a.spec.recordPath,'Zadanie ma inny parser źródła');
 need(j.core.every(batch=>Object.entries(a.config).every(([k,v])=>JSON.stringify((batch.request as unknown as Record<string,unknown>)[k])===JSON.stringify(v))),'Zadanie ma inną oryginalną konfigurację');
 need(Number.isSafeInteger(j.revision)&&j.revision>=0&&/^[a-f0-9]{64}$/.test(j.raw.sha256)&&/^[a-f0-9]{64}$/.test(j.plan_hash)&&typeof j.approved==='boolean','Nieprawidłowa natywna rewizja zadania');
 if(a.native)need(j.revision>=a.native.revision&&j.raw.sha256===a.native.rawSha256&&j.plan_hash===a.native.planHash&&(!a.native.approved||j.approved),'Odczyt cofa lub zmienia potwierdzone oryginalne zadanie');
 return j;
}
/** Only after exact authenticated original GET validation; no grant, consent, or retry authority. */
export function nativeConfirmation(a:SavedAttempt,j:Job):NativeConfirmation{confirmOriginalJob(a,j);return {revision:j.revision,rawSha256:j.raw.sha256,planHash:j.plan_hash,approved:j.approved};}

