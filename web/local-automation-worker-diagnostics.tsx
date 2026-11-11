/** Read-only presentation of the already authorized own-rule status response. */
type Cycle={started_at:string;finished_at:string;outcome:string;error_code:string|null};
type Runtime={state:'NOT_STARTED'|'RUNNING'|'DRAINING'|'AMBIGUOUS_RUNTIME';started:boolean|null;draining:boolean|null;current_busy:boolean|null;last_cycle:Cycle|null;ram_only:true;paused:boolean|null;pause_scope:'RULE_CONFIGURATION_ONLY_NOT_DRAIN_ACK';last_cycle_scope:'RECENT_OWN_RULE_VISIT_NOT_DURABLE_HISTORY'};
type Readback={kind:'unread'}|{kind:'unavailable'}|{kind:'unconfirmed'}|{kind:'known';runtime:Runtime};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x:Record<string,unknown>,wanted:string[])=>Object.keys(x).sort().join(',')===[...wanted].sort().join(',');
const outcomeLabels:Record<string,string>={
 NO_UNATTEMPTED_JOB:'Podczas ostatniej kontroli nie znaleziono nowego zadania do rozpoczęcia.',
 PROCESSOR_RETURNED_REQUIRES_HISTORY_READBACK:'Procesor zakończył obsługę próby. Wynik sprawdź w historii reguły.',
 ATTEMPT_FAILED_NO_RETRY:'Próba zakończyła się błędem. Sprawdź skutki w historii; nie jest ponawiana automatycznie.',
 CLAIM_NOT_CONFIRMED:'Nie potwierdzono rozpoczęcia zadania. Sprawdź historię przed kolejnym działaniem.',
 DISCOVERY_REFUSED:'Nie udało się sprawdzić kolejki tej reguły.',
};
const errorCodes=new Set(['23503','23505','23514','40001','40P01','55P03','57014']);
const timestamp=(x:unknown):x is string=>{
 if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(x))return false;
 const time=Date.parse(x);return Number.isFinite(time)&&new Date(time).toISOString().slice(0,19)===x.slice(0,19);
};
export function readLocalAutomationWorkerDiagnostic(status:unknown,ruleId:string):Readback{
 if(status===null||status===undefined)return{kind:'unread'};
 if(!object(status)||!uuid(ruleId)||status.rule_id!==ruleId||typeof status.processor_running!=='boolean')return{kind:'unconfirmed'};
 if(!Object.hasOwn(status,'runtime'))return{kind:'unavailable'};
 const r=status.runtime;
 if(!object(r)||!keys(r,['state','started','draining','current_busy','last_cycle','ram_only','paused','pause_scope','last_cycle_scope'])||r.ram_only!==true||r.pause_scope!=='RULE_CONFIGURATION_ONLY_NOT_DRAIN_ACK'||r.last_cycle_scope!=='RECENT_OWN_RULE_VISIT_NOT_DURABLE_HISTORY')return{kind:'unconfirmed'};
 if(!['NOT_STARTED','RUNNING','DRAINING','AMBIGUOUS_RUNTIME'].includes(String(r.state)))return{kind:'unconfirmed'};
 if(r.state==='NOT_STARTED'){
  if(r.started!==false||r.draining!==false||r.current_busy!==false||r.last_cycle!==null||r.paused!==null)return{kind:'unconfirmed'};
 }else if(r.state==='AMBIGUOUS_RUNTIME'){
  if(status.processor_running!==true||r.started!==null||r.draining!==null||r.current_busy!==null||r.last_cycle!==null||r.paused!==null)return{kind:'unconfirmed'};
 }else{
  if(status.processor_running!==true||r.started!==true||r.draining!==(r.state==='DRAINING')||typeof r.current_busy!=='boolean')return{kind:'unconfirmed'};
  if(r.state==='DRAINING'?r.paused!==null:typeof r.paused!=='boolean')return{kind:'unconfirmed'};
  if(r.state==='RUNNING'&&(!['ENABLED','NOT_CONFIGURED','DISABLED_OR_RULE_CHANGED'].includes(String(status.state))||r.paused!==(status.state!=='ENABLED')))return{kind:'unconfirmed'};
 }
 if(r.last_cycle!==null){
  const c=r.last_cycle;
  if(!object(c)||!keys(c,['started_at','finished_at','outcome','error_code'])||!timestamp(c.started_at)||!timestamp(c.finished_at)||Date.parse(c.finished_at)<Date.parse(c.started_at)||typeof c.outcome!=='string'||!Object.hasOwn(outcomeLabels,c.outcome)||!(c.error_code===null||typeof c.error_code==='string'&&errorCodes.has(c.error_code)))return{kind:'unconfirmed'};
  if(['NO_UNATTEMPTED_JOB','PROCESSOR_RETURNED_REQUIRES_HISTORY_READBACK'].includes(c.outcome)&&c.error_code!==null)return{kind:'unconfirmed'};
 }
 return{kind:'known',runtime:r as Runtime};
}
const stateLabels={NOT_STARTED:'Procesor nie został uruchomiony w tym odczycie.',RUNNING:'Procesor działa.',DRAINING:'Procesor kończy pracę.',AMBIGUOUS_RUNTIME:'Nie można potwierdzić jednego procesora.'};
export function LocalAutomationWorkerDiagnostics({status,ruleId}:{status:unknown;ruleId:string}){
 const value=readLocalAutomationWorkerDiagnostic(status,ruleId);
 return <section aria-label="Praca procesora tej reguły">
  <h5>Praca procesora tej reguły</h5>
  {value.kind==='unread'?<p>Odczytaj status, aby sprawdzić bieżącą pracę procesora.</p>
   :value.kind==='unavailable'?<p>Ten serwer nie udostępnia diagnostyki procesora. Nie można potwierdzić jego bieżącej pracy.</p>
   :value.kind==='unconfirmed'?<p role="status">Nie można potwierdzić diagnostyki tej reguły. Odczytaj status ponownie.</p>
   :<>
    <p role="status">{stateLabels[value.runtime.state]}</p>
    {value.runtime.state==='RUNNING'&&<p>{value.runtime.paused?'Obsługa nowych zdarzeń tej reguły jest wyłączona.':'Obsługa nowych zdarzeń tej reguły jest włączona.'}</p>}
    <p>{value.runtime.current_busy===true?'Procesor nadal obsługuje tę regułę.':value.runtime.current_busy===false?'Procesor w tej chwili nie obsługuje tej reguły.':'Nie ustalono, czy ta reguła jest teraz obsługiwana.'}</p>
    {value.runtime.state==='DRAINING'&&<p>Kończenie pracy nie potwierdza jeszcze zakończenia wszystkich rozpoczętych zadań.</p>}
    {value.runtime.state==='RUNNING'&&value.runtime.paused&&<p>Wyłączenie nowych zdarzeń nie potwierdza zakończenia rozpoczętej pracy.</p>}
    {value.runtime.last_cycle?<p>Ostatnia zapamiętana kontrola: {new Date(value.runtime.last_cycle.finished_at).toLocaleString('pl-PL')}. {outcomeLabels[value.runtime.last_cycle.outcome]}</p>
     :<p>Brak zapamiętanej kontroli tej reguły w bieżącym uruchomieniu.</p>}
    <p>To obserwacja bieżącego uruchomienia, a nie pełna historia. Brak wpisu po restarcie lub usunięciu starszych wpisów nie dowodzi, że reguła nigdy nie działała.</p>
   </>}
 </section>;
}
