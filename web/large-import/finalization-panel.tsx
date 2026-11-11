import React,{useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {Job} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/contracts';
import type {Scope,FetchPort,LargeImportHttp} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/browser';
import {validateJob} from '../../shared/large-import-dependencies/pim-large-import-job-flow-ui2/model';
import {createFinalizationClient} from './finalization-client';
import {finalizationInput,decodeFinalizationStatus,type FinalizationInput,type FinalizationAck,type FinalizationStatus} from './finalization-model';
type Pending={input:FinalizationInput;phase:'reading'|'sending'|'unknown'|'continue'};
const entries=new Map<string,Pending>(),listeners=new Set<()=>void>();let revision=0;
const emit=()=>{revision++;for(const f of listeners)f();};
const key=(s:Scope)=>JSON.stringify([s.context.tenantId,s.context.userId,s.context.apiKeyId,s.catalogId,s.jobId]);
const prefix=(s:Scope['context'])=>JSON.stringify([s.tenantId,s.userId,s.apiKeyId]).slice(0,-1)+',';
/** Completion custody never treats an ordinary Job or a browser marker as terminal proof. */
export const finalizationCustody={subscribe(f:()=>void){listeners.add(f);return()=>{listeners.delete(f);};},snapshot:()=>revision,pending(c:Scope['context'],catalogId:string){for(const [k,v]of entries){if(!k.startsWith(prefix(c)))continue;const scope=JSON.parse(k) as string[];if(scope[3]===catalogId)return{jobId:scope[4]!,phase:v.phase};}return null;},locked(c:Scope['context']){return [...entries.keys()].some(k=>k.startsWith(prefix(c)));}};
const labels:Record<string,string>={JOB_IN_PROGRESS:'Zadanie nadal jest wykonywane.',BUSINESS_OUTCOME_UNKNOWN:'Wynik zapisu wymaga rozstrzygnięcia.',RESERVATION_UNKNOWN:'Nie można potwierdzić oryginalnej pary rezerwacji.',PENDING_RESOURCES:'Trwa rozliczanie zasobów importu.',ORIGINAL_NOT_DRAINED:'Oryginalna operacja jeszcze się nie zakończyła.',LEASE_EXPIRED:'Czas rezerwacji wygasł. Wymagane jest jawne odnowienie oryginalnej pary.'};
type Props={job:Job;http:LargeImportHttp;scope:Scope;blocked:boolean;fetchPort?:FetchPort;onJob(job:Job):void;onFinalized(value:boolean):void};
export function LargeImportFinalization(props:Props){
 const latest=useRef(props);latest.current=props;const scopeKey=key(props.scope),generation=useRef(0),active=useRef(false),flight=useRef<number|null>(null);
 useSyncExternalStore(finalizationCustody.subscribe,finalizationCustody.snapshot,()=>0);
 const client=useMemo(()=>createFinalizationClient(()=>{const p=latest.current;return{...p.scope,externalWriteBlocked:p.scope.externalWriteBlocked||p.blocked};},props.fetchPort),[scopeKey,props.fetchPort]);
 const [status,setStatus]=useState<FinalizationStatus|null>(null),[ack,setAck]=useState<FinalizationAck|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[desired,setDesired]=useState<number[]>([]),[confirmed,setConfirmed]=useState(false);
 const begun=Object.keys(props.job.pim).map(Number),pending=entries.get(scopeKey),selected=[...new Set([...desired,...begun])].sort((a,b)=>a-b),selectionKey=JSON.stringify(selected);
 let problem='';try{finalizationInput(props.job,selected);}catch(e){problem=(e as Error).message;}
 const currentStatus=status?.revision===props.job.revision&&status.plan_hash===props.job.plan_hash?status:null;
 const current=(g:number,write=false)=>{const p=latest.current;if(!active.current||generation.current!==g||key(p.scope)!==scopeKey||!p.scope.available||!p.scope.canManage||p.scope.context.apiKeyId!==null||write&&(p.blocked||p.scope.externalWriteBlocked))throw Error('Zmienił się katalog, użytkownik lub dostęp do zakończenia importu.');};
 async function fresh(g:number){
  current(g);const p=latest.current,id=p.job.id;const j=await p.http.inspect(id);current(g);validateJob(j,p.scope.context,id);if(!j.core.every(c=>c.request.catalog_id===p.scope.catalogId))throw Error('Zadanie należy do innego katalogu.');
  const cut=decodeFinalizationStatus(await client.inspect(id),id);current(g);if(cut.revision!==j.revision||cut.plan_hash!==j.plan_hash)throw Error('Zadanie zmieniło się podczas odczytu. Odczytaj je ponownie.');
  setStatus(cut);latest.current.onJob(j);latest.current.onFinalized(cut.finalized);
  const held=entries.get(scopeKey);if(cut.finalized){entries.delete(scopeKey);emit();}else if(held){held.phase=cut.can_continue?'continue':'unknown';emit();}
  return{job:j,status:cut};
 }
 async function read(){if(flight.current!==null)return;const g=generation.current;flight.current=g;setBusy(true);setConfirmed(false);setError('');try{await fresh(g);}catch(e){if(active.current&&generation.current===g){setStatus(null);setError((e as Error).message);}}finally{if(flight.current===g)flight.current=null;if(active.current&&generation.current===g)setBusy(false);}}
 useLayoutEffect(()=>{active.current=true;generation.current++;client.activate();flight.current=null;setBusy(false);setStatus(null);setAck(null);setDesired([]);setConfirmed(false);setError('');void read();return()=>{active.current=false;generation.current++;client.deactivate();const held=entries.get(scopeKey);if(held&&(held.phase==='sending'||held.phase==='reading')){held.phase='unknown';emit();}};},[client]);
 useEffect(()=>{setConfirmed(false);},[props.job.revision,props.job.plan_hash,selectionKey,props.blocked,props.scope.available,props.scope.canManage]);
 async function finish(){
  const p=latest.current,old=entries.get(scopeKey);if(flight.current!==null||!confirmed||!currentStatus?.can_continue||old?.phase==='unknown'||p.blocked||p.scope.externalWriteBlocked)return;
  const g=generation.current;let sent=false,owned:Pending|undefined;
  try{current(g,true);const expected=finalizationInput(p.job,selected);if(old&&JSON.stringify(old.input)!==JSON.stringify(expected))throw Error('Zachowano inny pierwotny zakres zakończenia. Najpierw odczytaj jego stan.');
   owned=old??{input:structuredClone(expected),phase:'reading'};owned.phase='reading';entries.set(scopeKey,owned);emit();flight.current=g;setBusy(true);setConfirmed(false);setError('');
   const freshRead=await fresh(g);current(g,true);const now=finalizationInput(freshRead.job,expected.pim_batches);if(JSON.stringify(now)!==JSON.stringify(expected))throw Error('Rewizja lub plan zmieniły się. Sprawdź świeży odczyt i potwierdź ponownie.');
   if(freshRead.status.finalized)return;if(!freshRead.status.can_continue)throw Error('Trwały stan nie pozwala zakończyć importu.');
   owned.phase='sending';entries.set(scopeKey,owned);emit();sent=true;const result=await client.finalize(p.job.id,expected);current(g);setAck(result);owned.phase='unknown';emit();
   const after=await fresh(g);if(!after.status.finalized)throw Error('Odpowiedź otrzymano, ale trwały odczyt nie potwierdza jeszcze zakończenia obu rezerwacji.');
  }catch(e){if(owned){if(sent){owned.phase='unknown';entries.set(scopeKey,owned);}else if(!old)entries.delete(scopeKey);else old.phase='continue';emit();}if(active.current&&generation.current===g){if(sent)setStatus(null);setError((sent?'Wynik zakończenia niepotwierdzony. Odczytaj trwały stan; nie wysyłaj pliku ponownie. ':'')+(e as Error).message);}}
  finally{if(flight.current===g)flight.current=null;if(active.current&&generation.current===g)setBusy(false);}
 }
 const disabled=props.blocked||props.scope.externalWriteBlocked||!props.scope.available||!props.scope.canManage||props.scope.context.apiKeyId!==null||busy||!!problem||!currentStatus?.can_continue||pending?.phase==='unknown';
 const half=!!currentStatus&&currentStatus.job.state!==currentStatus.review.state;
 return <section aria-label="Zakończenie dużego importu"><h3>Zakończenie importu</h3><p>Zakończenie zamyka oryginalne rezerwacje zadania i przeglądu. Po zakończeniu nie można dodawać kolejnych zapisów do tego zadania.</p>
 <p>Rewizja {props.job.revision} · {props.job.manifest.total_batches} partii Core</p><details><summary>Potwierdzany plan importu</summary><code>{props.job.plan_hash}</code></details>
 {currentStatus?.finalized?<p role="status">Import zakończony. Świeży odczyt potwierdza zamknięcie obu oryginalnych rezerwacji.</p>:<><fieldset disabled={busy||!!pending||props.blocked}><legend>Partie PIM wymagane przed zakończeniem</legend>{props.job.core.map((_,n)=><label key={n}><input type="checkbox" checked={selected.includes(n)} disabled={begun.includes(n)} onChange={e=>{setConfirmed(false);setDesired(v=>e.target.checked?[...v,n]:v.filter(x=>x!==n));}}/>Partia {n+1}{begun.includes(n)?' · rozpoczęta; wymagane pełne potwierdzenie':' · nie rozpoczęto parametrów'}</label>)}<p>Każda rozpoczęta partia PIM jest obowiązkowa. Niewybrane i nierozpoczęte parametry pozostaną bez dodatkowego importu.</p></fieldset>
 {problem&&<p role="status">{problem}</p>}{half&&<p role="status">Zamknięto jedną z dwóch rezerwacji. Dokończenie dotyczy tej samej oryginalnej pary.</p>}{currentStatus?.blockers.map(b=><p role="status" key={b}>{labels[b]}</p>)}
 {pending?.phase==='unknown'&&<p role="status">Nieznany wynik zakończenia. Najpierw odczytaj trwały stan. Nie ponowiono żadnego zapisu.</p>}
 <label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={e=>setConfirmed(e.target.checked)}/>Potwierdzam zakończenie rewizji {props.job.revision} tego planu po zapisie wszystkich partii Core i wybranych partii PIM.</label><button disabled={disabled||!confirmed} onClick={()=>void finish()}>{half||pending?'Dokończ zakończenie importu':'Zakończ import'}</button></>}
 {ack&&<p role="status">Otrzymano potwierdzenie zakończenia rewizji {ack.revision}. {currentStatus?.finalized?'Trwały stan potwierdzony.':'Oczekuje sprawdzenia trwałego stanu.'}</p>}{error&&<p role="alert">{error}</p>}<button disabled={busy||!props.scope.available||!props.scope.canManage||props.scope.context.apiKeyId!==null} onClick={()=>void read()}>Odczytaj trwały stan zakończenia</button>
 </section>;
}
