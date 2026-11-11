/** Browser-only completion predicates. A complete Job never proves its quota pair is closed. */
import type {Job} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/contracts';
import {hasCompleteCoreForPim} from './pim/panel';
export type FinalizationInput={revision:number;plan_hash:string;pim_batches:number[];confirmed:true};
export type FinalizationAck={schema:'large-import-finalized/v1';id:string;revision:number;plan_hash:string;finalized:true};
const need=(v:unknown,message:string)=>{if(!v)throw Error(message);};
export function finalizationInput(job:Job,desired:number[]):FinalizationInput{
 need(hasCompleteCoreForPim(job),'Najpierw odczytaj pełne potwierdzenia zapisu wszystkich partii Core.');
 need(Number.isSafeInteger(job.revision)&&job.revision>=0&&/^[a-f0-9]{64}$/.test(job.plan_hash),'Brak aktualnej rewizji lub planu importu.');
 const batches=[...desired].sort((a,b)=>a-b);need(new Set(batches).size===batches.length&&batches.every(n=>Number.isSafeInteger(n)&&n>=0&&n<job.core.length),'Nieprawidłowy wybór partii PIM.');
 for(const [key,list]of Object.entries(job.pim)){
  const n=Number(key);need(Number.isSafeInteger(n)&&String(n)===key&&n>=0&&n<job.core.length&&list.length>0,'Nieprawidłowa historia parametrów.');
  need(batches.includes(n),'Uwzględnij każdą rozpoczętą partię PIM.');
  need(list.every(a=>(!a.previewAttempted||!!a.preview)&&(!a.applyAttempted||!!a.applied)),'Odczytaj i rozstrzygnij wcześniejsze niepotwierdzone próby PIM.');
  const a=list.at(-1)!;need(a.applyAttempted&&a.applied&&a.preview&&a.consent===a.preview.scope_hash&&a.applied.scope_hash===a.preview.scope_hash,'Najpierw zapisz aktualną wybraną próbę PIM.');
 }
 for(const n of batches)need(job.pim[n]?.at(-1)?.applied,'Wybrana partia PIM nie ma potwierdzonego zapisu.');
 return{revision:job.revision,plan_hash:job.plan_hash,pim_batches:batches,confirmed:true};
}
export function decodeFinalizationAck(raw:unknown,id:string,expected:FinalizationInput):FinalizationAck{
 need(raw&&typeof raw==='object'&&!Array.isArray(raw),'Brak potwierdzenia zakończenia importu.');const r=raw as FinalizationAck;
 need(JSON.stringify(Object.keys(r).sort())===JSON.stringify(['finalized','id','plan_hash','revision','schema']),'Nieprawidłowe potwierdzenie zakończenia importu.');
 need(r.schema==='large-import-finalized/v1'&&r.id===id&&r.revision===expected.revision&&r.plan_hash===expected.plan_hash&&r.finalized===true,'Potwierdzenie dotyczy innego zadania, planu lub rewizji.');return structuredClone(r);
}
export type FinalizationStatus={schema:'large-import-finalization-status/v1';id:string;revision:number;plan_hash:string;job:{state:'open'|'retained'|'unknown';outcome:null|'ready'|'absent'};review:{state:'open'|'retained'|'unknown';outcome:null|'ready'|'absent'};finalized:boolean;can_continue:boolean;blockers:string[]};
export function decodeFinalizationStatus(raw:unknown,id:string):FinalizationStatus{
 need(raw&&typeof raw==='object'&&!Array.isArray(raw),'Brak trwałego stanu zakończenia importu.');const s=raw as FinalizationStatus;
 need(JSON.stringify(Object.keys(s).sort())===JSON.stringify(['blockers','can_continue','finalized','id','job','plan_hash','review','revision','schema']),'Nieprawidłowy stan zakończenia importu.');
 need(s.schema==='large-import-finalization-status/v1'&&s.id===id&&Number.isSafeInteger(s.revision)&&s.revision>=0&&/^[a-f0-9]{64}$/.test(s.plan_hash),'Stan dotyczy innego zadania.');
 for(const pair of [s.job,s.review])need(pair&&JSON.stringify(Object.keys(pair).sort())===JSON.stringify(['outcome','state'])&&(pair.state==='open'&&pair.outcome===null||pair.state==='retained'&&(pair.outcome==='ready'||pair.outcome==='absent')||pair.state==='unknown'&&(pair.outcome===null||pair.outcome==='absent')),'Nieprawidłowy stan rezerwacji importu.');
 const known=['JOB_IN_PROGRESS','BUSINESS_OUTCOME_UNKNOWN','RESERVATION_UNKNOWN','PENDING_RESOURCES','ORIGINAL_NOT_DRAINED','LEASE_EXPIRED'];
 need(typeof s.finalized==='boolean'&&typeof s.can_continue==='boolean'&&Array.isArray(s.blockers)&&s.blockers.every(x=>known.includes(x))&&new Set(s.blockers).size===s.blockers.length,'Nieprawidłowe ograniczenia zakończenia.');
 const bothReady=s.job.state==='retained'&&s.job.outcome==='ready'&&s.review.state==='retained'&&s.review.outcome==='ready',expectedFinalized=bothReady&&s.blockers.length===0;need(s.finalized===expectedFinalized&&(!s.finalized||!s.can_continue)&&(!s.can_continue||s.blockers.length===0&&s.job.state!=='unknown'&&s.review.state!=='unknown'&&s.job.outcome!=='absent'&&s.review.outcome!=='absent'),'Niespójne potwierdzenie zakończenia importu.');return structuredClone(s);
}
