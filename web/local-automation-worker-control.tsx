import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {AutomaticEffects} from './automation-local-effects';
import {LocalAutomationWorkerDiagnostics} from './local-automation-worker-diagnostics';
import {AutomationUnresolvedEffects,readUnresolvedEffectsPage} from './automation-unresolved-effects';
type Attempt={v:1;context:string;rule:string;client_key:string;version:string;enabled:boolean;phase:'sent'|'unknown'|'confirmed'};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const version=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d*$/.test(v);
const prefix=(context:string,rule:string)=>'dyna:automatic-rule:v1:'+context+':'+rule;
export function parseWorkerAttempt(raw:string|null,context:string,rule:string):Attempt|null{
 if(raw===null)return null;const a=JSON.parse(raw);
 if(!a||a.v!==1||a.context!==context||a.rule!==rule||!uuid(a.rule)||!uuid(a.client_key)||!version(a.version)||typeof a.enabled!=='boolean'||!['sent','unknown','confirmed'].includes(a.phase))throw Error('Niepełny zapis zmiany reguły. Nie ponawiaj zapisu.');
 return a;
}
export function workerReadbackConfirms(a:Attempt,status:any):boolean{
 const setting=status?.activation;
 return status?.rule_id===a.rule&&version(status.version)&&status.version===String(BigInt(a.version)+1n)&&setting?.schema==='owned-automatic-rule/v1'&&setting.owner_id===a.context.split(':')[1]&&setting.client_key===a.client_key&&setting.enabled===a.enabled&&setting.rule_version===status.version&&typeof setting.enabled_at==='string'&&Number.isFinite(Date.parse(setting.enabled_at));
}
export function mergeWorkerReadback(a:Attempt,remembered:Attempt|null,status:any):Attempt{
 // A GET never makes a missing or different sent marker eligible for another POST.
 if(!remembered||remembered.client_key!==a.client_key||remembered.context!==a.context||remembered.rule!==a.rule||remembered.version!==a.version||remembered.enabled!==a.enabled)throw Error('Próba zmieniła się w innej karcie. Odczytaj ją ponownie.');
 return {...remembered,phase:workerReadbackConfirms(remembered,status)?'confirmed':remembered.phase==='confirmed'?'confirmed':'unknown'};
}
export function supportsLocalAutomaticRule(rule:any){
 const actions=rule?.definition?.actions;
 return rule?.trigger!=='customer_message.received'&&Array.isArray(actions)&&actions.length>0&&actions.every((a:any)=>(['add_note','add_tag','remove_tag','set_workflow','set_status','sync_local_woo_stock'].includes(a.type)||(a.type==='email'&&a.mode==='smtp'&&a.confirm_external===false)));
}
function effectsCoverageText(status:any):string|null{
 if(!status)return null;
 const c=status.child_effects_coverage,fields=['scope','run_limit','runs_truncated','per_kind_limit','stock_truncated','email_truncated','reconciliation_scope'];
 const object=c!==null&&typeof c==='object'&&!Array.isArray(c);
 const shortened=object&&['runs_truncated','stock_truncated','email_truncated'].some(k=>c[k]===true);
 const confirmed=object&&typeof status.reconciliation_required==='boolean'&&Object.keys(c).length===fields.length&&fields.every(k=>Object.hasOwn(c,k))&&
  c.scope==='RECENT_OWN_RULE_RUNS'&&c.run_limit===25&&c.per_kind_limit===500&&c.reconciliation_scope==='ALL_OWN_RULE_RUNS'&&
  ['runs_truncated','stock_truncated','email_truncated'].every(k=>typeof c[k]==='boolean');
 if(!confirmed)return(shortened?'Lista efektów jest skrócona. ':'')+'Zakres historii efektów nie został potwierdzony.';
 return shortened?'Lista efektów jest skrócona. Status uzgodnienia obejmuje całą historię tej reguły.':null;
}
export function LocalAutomationWorkerControl(p:{contextKey:string;rule:any;admin:boolean;readOnly:boolean;onChanged:()=>void}){
 const [tenant,user]=p.contextKey.split(':'),scope=p.contextKey+':'+p.rule.id;
 const [attempt,setAttempt]=useState<Attempt|null>(null),[observation,setObservation]=useState<{scope:string;value:any}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
 const [unresolvedPage,setUnresolvedPage]=useState<{scope:string;value:unknown}|null>(null),unresolvedCursors=useRef(new Set<string>());
 const current=useRef(scope),generation=useRef(0),alive=useRef(true),flight=useRef<number|null>(null),access=useRef(false);
 current.current=scope;access.current=p.admin&&!p.readOnly;
 // Hide an earlier principal/rule's readback in this render, before effects clear it.
 const status=observation?.scope===scope&&access.current?observation.value:null;
 const setStatus=(value:any)=>{setUnresolvedPage(null);unresolvedCursors.current.clear();setObservation(value===null?null:{scope,value});};
 const visible=(epoch:number)=>alive.current&&current.current===scope&&generation.current===epoch;
 const load=()=>parseWorkerAttempt(localStorage.getItem(prefix(p.contextKey,p.rule.id)),p.contextKey,p.rule.id);
 const save=(a:Attempt)=>localStorage.setItem(prefix(a.context,a.rule),JSON.stringify(a));
 const locked=async<T,>(fn:()=>Promise<T>)=>{
  if(!navigator.locks?.request)throw Error('Ta przeglądarka nie zapewnia blokady kart. Zapis jest niedostępny.');
  return navigator.locks.request(prefix(p.contextKey,p.rule.id),{mode:'exclusive'},fn);
 };
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 useEffect(()=>{generation.current++;flight.current=null;setBusy(false);setLoaded(false);setStatus(null);setError('');setAttempt(null);try{if(!uuid(tenant)||!uuid(user)||!uuid(p.rule.id))throw Error('Brak kontekstu własnej reguły.');setAttempt(load());setLoaded(true);}catch(e){setError(e instanceof Error?e.message:'Nie można odczytać próby.');}},[scope,p.admin,p.readOnly]);
 async function sameActor(epoch:number){
  if(!visible(epoch)||!access.current)throw Error('Widok lub uprawnienia zmieniły się.');
  const me=await api('/auth/me');
  if(!visible(epoch)||!access.current||me.restore_preview||me.user?.tenant_id!==tenant||me.user?.id!==user||me.user?.role!=='admin')throw Error('Wymagana bieżąca sesja administratora tej firmy.');
 }
 async function getStatus(epoch:number,cursor?:string){
  await sameActor(epoch);const value=await api('/automations/'+p.rule.id+'/local-worker'+(cursor?'?'+new URLSearchParams({reconciliation_after:cursor}):''));await sameActor(epoch);
  if(value.rule_id!==p.rule.id||!version(value.version)||typeof value.processor_running!=='boolean'||!Array.isArray(value.jobs))throw Error('Niepotwierdzony status tej reguły.');
  return value;
 }
 async function readOlder(cursor:string){
  if(!loaded||!access.current||!status||flight.current!==null)return;
  try{const page=readUnresolvedEffectsPage(unresolvedPage?.scope===scope?unresolvedPage.value:status.unresolved_effects);if(!page.has_more||page.next_cursor!==cursor||unresolvedCursors.current.has(cursor))throw Error('Odczytaj status, aby ponownie sprawdzić listę prób.');}
  catch(e){setError(e instanceof Error?e.message:'Niepotwierdzona strona prób.');return;}
  const epoch=generation.current;flight.current=epoch;setBusy(true);setError('');
  try{
   const value=await getStatus(epoch,cursor),page=readUnresolvedEffectsPage(value.unresolved_effects);
   if(page.has_more&&(page.next_cursor===cursor||unresolvedCursors.current.has(page.next_cursor!)))throw Error('Niepotwierdzona kolejność stron prób. Odczytaj status ponownie.');
   if(visible(epoch)){unresolvedCursors.current.add(cursor);setUnresolvedPage({scope,value:page});}
  }catch(e){if(visible(epoch)){setStatus(null);setError(e instanceof Error?e.message:'Nie potwierdzono starszych prób.');}}
  finally{if(flight.current===epoch){flight.current=null;if(visible(epoch))setBusy(false);}}
 }
 async function read(){
  if(!loaded||!access.current||flight.current!==null)return;const epoch=generation.current;flight.current=epoch;setBusy(true);setError('');setStatus(null);
  try{const value=await getStatus(epoch);await locked(async()=>{if(!visible(epoch))throw Error('Widok zmienił się.');const a=load();if(a){const next=mergeWorkerReadback(a,load(),value);save(next);if(visible(epoch))setAttempt(next);}if(visible(epoch))setStatus(value);});}
  catch(e){if(visible(epoch))setError(e instanceof Error?e.message:'Nie potwierdzono statusu.');}
  finally{if(flight.current===epoch){flight.current=null;if(visible(epoch))setBusy(false);}}
 }
 async function configure(enabled:boolean){
  if(!loaded||!access.current||!status||flight.current!==null)return;const epoch=generation.current;flight.current=epoch;setBusy(true);setError('');setStatus(null);const sent:{attempt:Attempt|null}={attempt:null};
  try{await locked(async()=>{
   await sameActor(epoch);if(!visible(epoch))throw Error('Widok zmienił się.');const previous=load();
   if(previous&&previous.phase!=='confirmed')throw Error('Poprzedni zapis jest niepewny. Najpierw odczytaj status.');
   if(previous){localStorage.setItem(prefix(previous.context,previous.rule)+':archive:'+previous.client_key,JSON.stringify(previous));}
   if(!version(status.version))throw Error('Odczytaj aktualną wersję reguły.');
   sent.attempt={v:1,context:p.contextKey,rule:p.rule.id,client_key:crypto.randomUUID(),version:status.version,enabled,phase:'sent'};
   save(sent.attempt);if(visible(epoch))setAttempt(sent.attempt); // durable marker precedes the only POST.
   const a:Attempt=sent.attempt;
   const ack=await api('/automations/'+a.rule+'/local-worker','POST',{client_key:a.client_key,version:a.version,enabled:a.enabled});
   if(ack.status!=='AUTOMATIC_RULE_CONFIGURATION_ACKNOWLEDGED'||!workerReadbackConfirms(a,{rule_id:ack.rule_id,version:ack.version,activation:ack.activation}))throw Error('Niepotwierdzony zapis. Użyj odczytu bez ponawiania.');
   save({...a,phase:'confirmed'});if(visible(epoch))setAttempt({...a,phase:'confirmed'});
   const value=await getStatus(epoch),next=mergeWorkerReadback(a,load(),value);save(next);
   if(visible(epoch)){setAttempt(next);setStatus(value);p.onChanged();}
  });}catch(e){const original=sent.attempt;if(original){try{await locked(async()=>{const last=load();if(last&&last.client_key===original.client_key&&last.phase!=='confirmed'){const unknown:Attempt={...last,phase:'unknown'};save(unknown);if(visible(epoch))setAttempt(unknown);}});}catch{} }if(visible(epoch))setError(e instanceof Error?e.message:'Wynik niepewny. Odczytaj status bez ponawiania.');}
  finally{if(flight.current===epoch){flight.current=null;if(visible(epoch))setBusy(false);}}
 }
 const latest=status?.version===String(p.rule.version);
 const coverageText=effectsCoverageText(status);
 const own=p.rule.actor_id===user,supported=supportsLocalAutomaticRule(p.rule),uncertain=attempt?.phase==='sent'||attempt?.phase==='unknown',disabled=busy||!loaded||!access.current;
 return <div className="ops-result automatic-worker-control">
  <h4>Automatyczne wykonanie w tej firmie</h4>
  <p>Po włączeniu procesor obsługuje nowe zdarzenia tej wersji reguły. Starsza kolejka i próby o niepewnym wyniku nie są ponawiane. Edycja reguły wymaga ponownego włączenia.</p>
  {!supported&&<p>Procesor obsługuje notatkę, tagi, etap i własny status, stan skonfigurowanego lokalnego Woo oraz email przez lokalny odbiornik SMTP .test. SMS, symulacja email i zewnętrzna wysyłka nie są tu wykonywane.</p>}
  {!own&&<p>Włączanie jest dostępne tylko administratorowi będącemu autorem tej reguły.</p>}
  <button type="button" className="button small-btn" disabled={disabled} onClick={()=>void read()}>Odczytaj status</button>
  <button type="button" className="button small-btn" disabled={disabled||!own||!supported||!p.rule.enabled||!latest||!status?.processor_running||uncertain||status?.activation?.enabled===true} onClick={()=>void configure(true)}>Włącz dla nowych zdarzeń</button>
  <button type="button" className="button small-btn" disabled={disabled||!own||!latest||!status||uncertain||status.activation?.enabled!==true} onClick={()=>void configure(false)}>Wyłącz automatyczne wykonanie</button>
  {status&&<p role="status">{status.state==='ENABLED'?'Włączone':status.state==='PROCESSOR_STOPPED'?'Procesor nie został uruchomiony':status.state==='NOT_CONFIGURED'?'Domyślnie wyłączone':'Wyłączone lub reguła została zmieniona'} · wersja {status.version}{status.reconciliation_required?' · Niepewne rozpoczęte zadania wymagają uzgodnienia skutków.':''}</p>}
  {status?.processor_running===false&&<p role="note">Procesor reguł automatycznych nie działa dla tej firmy. Uruchom go w panelu „Nadzór workerów” na tej stronie (działa do restartu procesu) albo uruchom aplikację lokalną z opcją --scoped-automation.</p>}
  {status?.jobs?.map((j:any,i:number)=><p key={i}>{j.kind}: {j.state} · {j.count} zadań · liczba prób {j.attempts}</p>)}
  <LocalAutomationWorkerDiagnostics status={status} ruleId={p.rule.id}/>
  {coverageText&&<p role="status" aria-label="Zakres historii efektów">{coverageText}</p>}
  <AutomaticEffects effects={status?.child_effects}/>
  {status&&<AutomationUnresolvedEffects contextKey={p.contextKey} value={unresolvedPage?.scope===scope?unresolvedPage.value:status.unresolved_effects} busy={busy} onOlder={cursor=>void readOlder(cursor)}/>}
  {uncertain&&<p role="status">Zapis został wysłany i może być w toku. Odświeżenie nie ponawia POST; użyj wyłącznie odczytu.</p>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
