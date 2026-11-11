import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from './api';
import type {LocalWooContext} from './configured-woo';
type Outcome='EFFECT_CONFIRMED'|'SUPERSEDED'|'FAILED';
type Kind='offer.sync'|'offer.write';
type Summary={channel_id:string;dispatch_id:string;job_id:string;kind:Kind;plan_id:string|null;job_state:'running'|'failed'|'done';plan_state:string|null;plan_phase:string|null;remote_id:string|null;parent_external_id:string|number|null};
const phases={eligibility:'Sprawdzanie zgody na synchronizację',claim:'Rozpoczynanie wykonania',prepare:'Przygotowanie zapisu',processor:'Przetwarzanie ofert',provider_read:'Odczyt z WooCommerce',provider_write:'Zapis do WooCommerce',after_write:'Po wysłaniu zapisu do WooCommerce',completion:'Potwierdzanie zakończenia'};
const categories={POSTGRES:'baza danych',PROBLEM:'odmowa reguły aplikacji',HTTP:'odpowiedź HTTP',ERROR:'błąd wykonania',THROWN_VALUE:'nierozpoznany błąd'};
type Category=keyof typeof categories;
type Failure={status:'RETAINED_FAILURE';phase:keyof typeof phases;detected_at:string;dispatch_id:string|null;job_id:string|null;kind:Kind|null;error_category:Category;error_class:string|null;sqlstate:string|null;http_status:number|null;provider_http_status:number|null;error_fingerprint:string;plan_phase:string|null;provider_requests:number;provider_writes:number;failure_handler_failed:boolean;automatic_retry:false;source:'audit'|'memory'};
type Diagnostic={status:'NO_RETAINED_CAUSE';dispatch_id:string;automatic_retry:false}|Failure;
type Status={channel_id:string;blocked:boolean;reconciliation_required:boolean;in_progress:boolean;dispatch:Summary|null;diagnostic:Diagnostic|null;processor_running:boolean};
type Stock={manage_stock:true;stock_quantity:number;backorders:'no'};
type Observed={manage_stock:boolean;stock_quantity:number|null;backorders:string|null};
type Ready=Summary&{status:'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW';planned:Stock|null;observed:Observed|null;observation_sha256:string|null;observation_error:null|{error_category:Category;http_status:number|null;provider_http_status:number|null};matches_plan:boolean|null;allowed_outcomes:Outcome[];expected_snapshot_sha256:string;diagnostic:Diagnostic;original_outcome:'UNCONFIRMED';operation:'RECONCILE_WITHOUT_RETRY';automatic_retry:false};
type Preview={status:'NO_UNACKNOWLEDGED_DISPATCH';channel_id:string;blocked:boolean;automatic_retry:false}|(Summary&{status:'DISPATCH_IN_PROGRESS';automatic_retry:false})|Ready;
type Body={client_key:string;dispatch_id:string;expected_snapshot_sha256:string;observation_sha256:string|null;outcome:Outcome;confirmed:true};
type Target={dispatch_id:string;job_id:string;plan_id:string|null;kind:Kind};
type Ack={status:'LOCAL_WOO_STOCK_DISPATCH_RECONCILED';channel_id:string;dispatch_id:string;job_id:string;plan_id:string|null;kind:Kind;client_key:string;outcome:Outcome;expected_snapshot_sha256:string;observation_sha256:string|null;job_state:'failed'|'done';plan_state:string|null;original_outcome:'UNCONFIRMED';automatic_retry:false};
type Marker={v:1;context:string;channel:string;target:Target;body:Body;phase:'sent'|'unknown'};
const outcomes:Outcome[]=['EFFECT_CONFIRMED','SUPERSEDED','FAILED'],outcomeLabel:Record<Outcome,string>={EFFECT_CONFIRMED:'Potwierdź skutek zapisu',SUPERSEDED:'Zastąp aktualnym stanem WooCommerce',FAILED:'Zakończ bez potwierdzenia'};
const doneLabel:Record<Outcome,string>={EFFECT_CONFIRMED:'skutek zapisu potwierdzony odczytem WooCommerce',SUPERSEDED:'zapis zastąpiony aktualnym stanem WooCommerce',FAILED:'zapis zakończony bez potwierdzenia'};
const uuid=(v:any):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v),digest=(v:any):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),timestamp=(v:any)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const remote=(v:any)=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v)||Number.isSafeInteger(v)&&v>0,status=(v:any,min:number)=>v===null||Number.isInteger(v)&&v>=min&&v<=599;
const exact=(v:any,list:string[])=>!!v&&typeof v==='object'&&Object.keys(v).sort().join(',')===[...list].sort().join(',');
const identity=(p:LocalWooContext)=>p.tenantId+':'+p.userId,storage=(context:string,channel:string)=>'dyna:local-woo-stock-reconcile:v1:'+context+':'+channel;
const SUMMARY=['channel_id','dispatch_id','job_id','kind','plan_id','job_state','plan_state','plan_phase','remote_id','parent_external_id'];
const FAILURE=['status','phase','detected_at','dispatch_id','job_id','kind','error_category','error_class','sqlstate','http_status','provider_http_status','error_fingerprint','plan_phase','provider_requests','provider_writes','failure_handler_failed','automatic_retry','source'];
function summary(v:any,channel:string):Summary{
 if(!v||v.channel_id!==channel||!uuid(v.dispatch_id)||!uuid(v.job_id)||!['offer.sync','offer.write'].includes(v.kind)||!['running','failed','done'].includes(v.job_state))throw Error('Niepotwierdzony zapis tego sklepu.');
 if(v.kind==='offer.sync'?v.plan_id!==null||v.plan_state!==null||v.plan_phase!==null||v.remote_id!==null||v.parent_external_id!==null:!uuid(v.plan_id)||!['queued','failed','done'].includes(v.plan_state)||!['ready','write_started','verify','done'].includes(v.plan_phase)||!remote(v.remote_id)||!(v.parent_external_id===null||remote(v.parent_external_id)))throw Error('Niepotwierdzony zapis tego sklepu.');
 return v;
}
/** Only a sanitized cause bound to this dispatch; never a message, body or credential. */
export function readLocalWooStockDiagnostic(v:any,dispatchId:string|null):Diagnostic{
 if(!v||v.automatic_retry!==false)throw Error('Niepotwierdzona diagnostyka zapisu.');
 if(v.status==='NO_RETAINED_CAUSE'&&exact(v,['status','dispatch_id','automatic_retry'])&&dispatchId!==null&&v.dispatch_id===dispatchId)return v;
 if(v.status!=='RETAINED_FAILURE'||!exact(v,FAILURE)||!Object.hasOwn(phases,v.phase)||!timestamp(v.detected_at)||!(v.dispatch_id===null||uuid(v.dispatch_id))||dispatchId!==null&&v.dispatch_id!==dispatchId||!(v.job_id===null||uuid(v.job_id))||!(v.kind===null||['offer.sync','offer.write'].includes(v.kind))||!Object.hasOwn(categories,v.error_category)||!(v.error_class===null||typeof v.error_class==='string'&&/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(v.error_class))||!(v.sqlstate===null||typeof v.sqlstate==='string'&&/^[0-9A-Z]{5}$/.test(v.sqlstate))||!status(v.http_status,400)||!status(v.provider_http_status,100)||!digest(v.error_fingerprint)||!(v.plan_phase===null||typeof v.plan_phase==='string'&&/^[a-z_]{1,32}$/.test(v.plan_phase))||!Number.isSafeInteger(v.provider_requests)||!Number.isSafeInteger(v.provider_writes)||v.provider_writes<0||v.provider_writes>v.provider_requests||typeof v.failure_handler_failed!=='boolean'||!['audit','memory'].includes(v.source))throw Error('Niepotwierdzona diagnostyka zapisu.');
 if((v.error_category==='POSTGRES')!==(v.sqlstate!==null)||v.error_category==='POSTGRES'&&v.http_status!==null||v.error_category==='HTTP'&&v.http_status===null||['ERROR','THROWN_VALUE'].includes(v.error_category)&&v.http_status!==null)throw Error('Niepotwierdzona diagnostyka zapisu.');
 return v;
}
export function readLocalWooStockStatus(v:any,channel:string):Status{
 if(!exact(v,['scope','provider_verified','channel_id','blocked','reconciliation_required','in_progress','dispatch','diagnostic','automatic_retry','processor_running'])||v.scope!=='selected_local_stock'||v.provider_verified!==false||v.automatic_retry!==false||v.channel_id!==channel||typeof v.blocked!=='boolean'||typeof v.reconciliation_required!=='boolean'||typeof v.in_progress!=='boolean'||typeof v.processor_running!=='boolean'||v.in_progress&&!v.reconciliation_required||(v.dispatch!==null)!==v.reconciliation_required)throw Error('Niepotwierdzony stan synchronizacji stanów.');
 if(v.dispatch){if(!exact(v.dispatch,SUMMARY))throw Error('Niepotwierdzony stan synchronizacji stanów.');summary(v.dispatch,channel);readLocalWooStockDiagnostic(v.diagnostic,v.dispatch.dispatch_id);}
 else if(v.diagnostic!==null&&(!v.blocked||readLocalWooStockDiagnostic(v.diagnostic,null).status!=='RETAINED_FAILURE'||v.diagnostic.source!=='memory'))throw Error('Niepotwierdzony stan synchronizacji stanów.');
 const{scope:_scope,provider_verified:_verified,automatic_retry:_retry,...rest}=v;return rest;
}
function planned(v:any):v is Stock{return exact(v,['manage_stock','stock_quantity','backorders'])&&v.manage_stock===true&&Number.isSafeInteger(v.stock_quantity)&&v.stock_quantity>=0&&v.backorders==='no';}
export function readLocalWooStockPreview(v:any,channel:string):Preview{
 const bad='Niepotwierdzony podgląd uzgodnienia.';if(!v||v.automatic_retry!==false)throw Error(bad);
 if(v.status==='NO_UNACKNOWLEDGED_DISPATCH'){if(!exact(v,['status','channel_id','blocked','automatic_retry'])||v.channel_id!==channel||typeof v.blocked!=='boolean')throw Error(bad);return v;}
 if(v.status==='DISPATCH_IN_PROGRESS'){if(!exact(v,[...SUMMARY,'status','automatic_retry']))throw Error(bad);summary(v,channel);return v;}
 if(v.status!=='LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW'||!exact(v,[...SUMMARY,'status','planned','observed','observation_sha256','observation_error','matches_plan','allowed_outcomes','expected_snapshot_sha256','diagnostic','original_outcome','operation','automatic_retry'])||!digest(v.expected_snapshot_sha256)||v.original_outcome!=='UNCONFIRMED'||v.operation!=='RECONCILE_WITHOUT_RETRY')throw Error(bad);
 summary(v,channel);readLocalWooStockDiagnostic(v.diagnostic,v.dispatch_id);
 const o=v.observed,e=v.observation_error,seen=o!==null;
 if(v.kind==='offer.sync'?v.planned!==null||seen||v.observation_sha256!==null||e!==null||v.matches_plan!==null:!planned(v.planned))throw Error(bad);
 if(seen&&(!exact(o,['manage_stock','stock_quantity','backorders'])||typeof o.manage_stock!=='boolean'||!(o.stock_quantity===null||Number.isSafeInteger(o.stock_quantity))||!(o.backorders===null||typeof o.backorders==='string'&&/^[a-z_]{1,16}$/.test(o.backorders))||!digest(v.observation_sha256)||e!==null||v.matches_plan!==(o.manage_stock===true&&o.stock_quantity===v.planned.stock_quantity&&o.backorders==='no')))throw Error(bad);
 if(!seen&&(v.observation_sha256!==null||v.matches_plan!==null||v.kind==='offer.write'&&(!exact(e,['error_category','http_status','provider_http_status'])||!Object.hasOwn(categories,e.error_category)||!status(e.http_status,400)||!status(e.provider_http_status,100))))throw Error(bad);
 const a=v.allowed_outcomes;
 if(!Array.isArray(a)||new Set(a).size!==a.length||a.some((x:any)=>!outcomes.includes(x))||v.kind==='offer.sync'&&a.some((x:any)=>x!=='FAILED')||a.includes('EFFECT_CONFIRMED')&&!(seen&&(v.matches_plan||v.plan_state==='done'))||a.includes('SUPERSEDED')&&!(seen&&v.matches_plan===false)||v.plan_state==='done'&&a.includes('FAILED'))throw Error(bad);
 return v;
}
/** The fresh preview must be exactly what the operator decided on; otherwise nothing is sent. */
export function sameLocalWooStockPreview(seen:Ready,fresh:Preview,outcome:Outcome):Ready{
 if(fresh.status!=='LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW'||fresh.dispatch_id!==seen.dispatch_id||fresh.job_id!==seen.job_id||fresh.plan_id!==seen.plan_id||fresh.kind!==seen.kind||fresh.expected_snapshot_sha256!==seen.expected_snapshot_sha256||fresh.observation_sha256!==seen.observation_sha256||!seen.allowed_outcomes.includes(outcome)||!fresh.allowed_outcomes.includes(outcome))throw Error('Stan zmienił się — odczytaj ponownie.');
 return fresh;
}
const BODY=['client_key','dispatch_id','expected_snapshot_sha256','observation_sha256','outcome','confirmed'];
function body(b:any):b is Body{return exact(b,BODY)&&uuid(b.client_key)&&uuid(b.dispatch_id)&&digest(b.expected_snapshot_sha256)&&outcomes.includes(b.outcome)&&b.confirmed===true&&(b.outcome==='FAILED'?b.observation_sha256===null:digest(b.observation_sha256));}
export function readLocalWooStockMarker(raw:string|null,context:string,channel:string):Marker|null{
 const bad='Zachowaj zapisane uzgodnienie i odczytaj jego wynik bez ponawiania.';
 if(raw===null)return null;if(raw.length>4096)throw Error(bad);let m:any;try{m=JSON.parse(raw);}catch{throw Error(bad);}const t=m?.target;
 if(!exact(m,['v','context','channel','target','body','phase'])||m.v!==1||m.context!==context||m.channel!==channel||!['sent','unknown'].includes(m.phase)||!body(m.body)||!exact(t,['dispatch_id','job_id','plan_id','kind'])||t.dispatch_id!==m.body.dispatch_id||!uuid(t.job_id)||!['offer.sync','offer.write'].includes(t.kind)||(t.kind==='offer.sync'?t.plan_id!==null||m.body.outcome!=='FAILED':!uuid(t.plan_id)))throw Error(bad);
 return m;
}
export function readLocalWooStockReconcileAck(v:any,m:Marker):Ack{
 const b=m.body,plan=b.outcome==='EFFECT_CONFIRMED'?'done':b.outcome==='SUPERSEDED'?'conflict':'failed';
 if(!exact(v,['status','channel_id','dispatch_id','job_id','plan_id','kind','client_key','outcome','expected_snapshot_sha256','observation_sha256','job_state','plan_state','original_outcome','automatic_retry'])||v.status!=='LOCAL_WOO_STOCK_DISPATCH_RECONCILED'||v.channel_id!==m.channel||v.dispatch_id!==b.dispatch_id||v.job_id!==m.target.job_id||v.plan_id!==m.target.plan_id||v.kind!==m.target.kind||v.client_key!==b.client_key||v.outcome!==b.outcome||v.expected_snapshot_sha256!==b.expected_snapshot_sha256||v.observation_sha256!==b.observation_sha256||!(b.outcome==='FAILED'?['failed','done'].includes(v.job_state):v.job_state==='done')||v.plan_state!==(m.target.kind==='offer.sync'?null:plan)||v.original_outcome!=='UNCONFIRMED'||v.automatic_retry!==false)throw Error('Nie potwierdzono wyniku uzgodnienia.');
 return v;
}
/** null = the server holds no ACK for this exact command (result stays unknown). */
export function readLocalWooStockObservation(v:any,m:Marker):Ack|null{
 if(!exact(v,['status','channel_id','client_key','ack','automatic_retry'])||v.channel_id!==m.channel||v.client_key!==m.body.client_key||v.automatic_retry!==false)throw Error('Niepotwierdzona tożsamość uzgodnienia.');
 if(v.status==='RECONCILE_RESULT_UNKNOWN'&&v.ack===null)return null;
 if(v.status!=='RECONCILE_RESULT_ACKNOWLEDGED')throw Error('Niepotwierdzony wynik uzgodnienia.');return readLocalWooStockReconcileAck(v.ack,m);
}
const sameBody=(a:Body,b:Body)=>BODY.every(k=>a[k as keyof Body]===b[k as keyof Body]);
export function LocalWooStockReconcile(p:LocalWooContext&{channelId:string}){
 const context=identity(p),scope=context+':'+p.channelId+':'+p.admin+':'+p.readOnly+':'+!!p.externalWriteBlocked,key=storage(context,p.channelId);
 const live=useRef(scope),epoch=useRef(0),alive=useRef(true),flight=useRef(false);live.current=scope;
 const[state,setState]=useState<{scope:string;value:Status}|null>(null),[preview,setPreview]=useState<{scope:string;value:Preview}|null>(null),[confirmed,setConfirmed]=useState(false),[marker,setMarker]=useState<Marker|null>(null),[unknownSeen,setUnknownSeen]=useState(false),[done,setDone]=useState<Outcome|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unavailable,setUnavailable]=useState(false);
 const value=state?.scope===scope?state.value:null,shown=preview?.scope===scope?preview.value:null,current=(e:number)=>alive.current&&epoch.current===e&&live.current===scope;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 useEffect(()=>{epoch.current++;flight.current=false;setState(null);setPreview(null);setConfirmed(false);setMarker(null);setUnknownSeen(false);setDone(null);setBusy(false);setError('');setUnavailable(false);},[scope]);
 async function actor(e:number,write=false){if(!current(e)||!p.admin||write&&(p.readOnly||p.externalWriteBlocked))throw Error('Widok lub uprawnienia zmieniły się.');const me=await api('/auth/me');if(!current(e)||me.user?.id!==p.userId||me.user.tenant_id!==p.tenantId||me.user.role!=='admin'||me.user.api_key_id!=null||write&&me.restore_preview)throw Error('Wymagana aktualna sesja administratora tej firmy.');}
 async function run(work:(e:number)=>Promise<void>){if(flight.current)return;flight.current=true;const e=epoch.current;setBusy(true);setError('');try{await work(e);}catch(err){if(current(e))setError(err instanceof Error?err.message:'Nie potwierdzono wyniku.');}finally{if(current(e)){flight.current=false;setBusy(false);}}}
 function lock(work:()=>Promise<void>){if(!navigator.locks?.request)throw Error('Uzgodnienie wymaga przeglądarki obsługującej blokadę kart.');return navigator.locks.request(key,{mode:'exclusive'},work);}
 const base='/local-fixtures/woocommerce/channels/'+p.channelId+'/stock-lane';
 async function get(e:number){await actor(e);const v=readLocalWooStockStatus(await api(base),p.channelId);await actor(e);if(!current(e))throw Error('Widok zmienił się.');return v;}
 async function load(){await run(async e=>{setState(null);setPreview(null);setConfirmed(false);setUnknownSeen(false);setDone(null);setUnavailable(false);
  let v:Status;try{v=await get(e);}catch(err){if(err instanceof ApiError&&err.status===404){if(current(e))setUnavailable(true);return;}throw err;}
  const m=readLocalWooStockMarker(localStorage.getItem(key),context,p.channelId);if(current(e)){setMarker(m);setState({scope,value:v});}
 });}
 async function readPreview(){await run(async e=>{setPreview(null);setConfirmed(false);await actor(e);const v=readLocalWooStockPreview(await api(base+'/reconciliation-preview'),p.channelId);await actor(e);if(current(e))setPreview({scope,value:v});});}
 async function after(e:number,ack:Ack){if(!current(e))return;setMarker(null);setUnknownSeen(false);setPreview(null);setConfirmed(false);setDone(ack.outcome);const v=await get(e);if(current(e))setState({scope,value:v});}
 async function reconcile(outcome:Outcome){await run(async e=>lock(async()=>{
  await actor(e,true);const previous=readLocalWooStockMarker(localStorage.getItem(key),context,p.channelId);if(previous){if(current(e))setMarker(previous);throw Error('Wcześniejsze uzgodnienie ma niepewny wynik. Odczytaj wynik uzgodnienia; nie ponawiaj.');}
  const seen=preview?.scope===scope?preview.value:null;if(!confirmed||seen?.status!=='LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW'||!seen.allowed_outcomes.includes(outcome))throw Error('Potwierdź wybrane uzgodnienie.');
  const fresh=readLocalWooStockPreview(await api(base+'/reconciliation-preview'),p.channelId);await actor(e,true);
  try{sameLocalWooStockPreview(seen,fresh,outcome);}catch(err){if(current(e)){setPreview(null);setConfirmed(false);}throw err;}
  const b:Body={client_key:crypto.randomUUID(),dispatch_id:seen.dispatch_id,expected_snapshot_sha256:seen.expected_snapshot_sha256,observation_sha256:outcome==='FAILED'?null:seen.observation_sha256,outcome,confirmed:true};
  const sent:Marker={v:1,context,channel:p.channelId,target:{dispatch_id:seen.dispatch_id,job_id:seen.job_id,plan_id:seen.plan_id,kind:seen.kind},body:b,phase:'sent'};
  // Durable before dispatch: an uncertain result is observed with this exact body, never re-sent.
  localStorage.setItem(key,JSON.stringify(sent));if(current(e))setMarker(sent);
  try{const ack=readLocalWooStockReconcileAck(await api(base+'/reconcile','POST',b),sent);localStorage.removeItem(key);await after(e,ack);}
  catch(err){
   // A 4xx is the server's own refusal before commit; anything else may have committed.
   if(err instanceof ApiError&&err.status>=400&&err.status<500){localStorage.removeItem(key);if(current(e)){setMarker(null);setPreview(null);setConfirmed(false);}if(err.status===409)throw Error('Stan zmienił się — odczytaj ponownie podgląd. Zapis nie został ponowiony.');throw err;}
   const unknown:Marker={...sent,phase:'unknown'};localStorage.setItem(key,JSON.stringify(unknown));if(current(e))setMarker(unknown);throw err;
  }
 }));}
 async function observe(){await run(async e=>lock(async()=>{
  await actor(e);const m=readLocalWooStockMarker(localStorage.getItem(key),context,p.channelId);if(!m){const v=await get(e);if(current(e)){setMarker(null);setState({scope,value:v});}return;}
  const ack=readLocalWooStockObservation(await api(base+'/reconcile/observe','POST',m.body),m);await actor(e);
  if(!ack){if(current(e))setUnknownSeen(true);throw Error('Brak zapisanego potwierdzenia uzgodnienia. Wynik pozostaje nieznany; nie ponawiaj zapisu.');}
  const last=readLocalWooStockMarker(localStorage.getItem(key),context,p.channelId);if(!last||!sameBody(last.body,m.body))throw Error('W innej karcie zmieniono uzgodnienie. Odczytaj stan.');
  localStorage.removeItem(key);await after(e,ack);
 }));}
 async function discard(){await run(async e=>lock(async()=>{
  await actor(e,true);const m=readLocalWooStockMarker(localStorage.getItem(key),context,p.channelId);if(!m||!unknownSeen)throw Error('Najpierw odczytaj wynik uzgodnienia.');
  localStorage.setItem(key+':archive:'+m.body.client_key,JSON.stringify(m));localStorage.removeItem(key);if(current(e)){setMarker(null);setUnknownSeen(false);setPreview(null);setConfirmed(false);}
 }));}
 const blocked=busy||!p.admin||p.readOnly||!!p.externalWriteBlocked,d=value?.diagnostic;
 if(!p.admin)return null;
 if(unavailable)return <p role="status">Synchronizacja stanów nie jest dostępna w tym uruchomieniu aplikacji.</p>;
 return <section aria-label="Synchronizacja stanów — uzgodnienie" className="info-body"><h4>Synchronizacja stanów — uzgodnienie</h4>
  <p>Gdy wynik zapisu stanu do WooCommerce jest niepewny, synchronizacja stanów tego sklepu zatrzymuje się do uzgodnienia. Uzgodnienie nie ponawia zapisu.</p>
  <button className="button" disabled={busy} onClick={()=>void load()}>Odczytaj stan synchronizacji stanów</button>
  {value&&<p role="status">{value.in_progress?'Zapis w toku — poczekaj na jego wynik.':value.reconciliation_required?'Wymaga uzgodnienia — synchronizacja stanów zatrzymana.':value.blocked?'Zatrzymany po błędzie; brak zapisu wymagającego uzgodnienia.':'Brak zapisu wymagającego uzgodnienia.'}{value.processor_running?'':' Procesor synchronizacji stanów nie został uruchomiony.'}</p>}
  {d?.status==='RETAINED_FAILURE'&&<div aria-label="Zachowana diagnostyka zapisu"><p>Faza: {phases[d.phase]}.</p><p>Kategoria: {categories[d.error_category]}.{d.http_status!==null?' Kod HTTP: '+d.http_status+'.':''}{d.provider_http_status!==null?' Kod WooCommerce: '+d.provider_http_status+'.':''}</p><p>Wysłane zapisy do WooCommerce: {d.provider_writes}.</p></div>}
  {d?.status==='NO_RETAINED_CAUSE'&&<p>Nie zachowano przyczyny tego niepotwierdzonego zapisu.</p>}
  {value?.reconciliation_required&&!value.in_progress&&<button className="button" disabled={busy||!!marker} onClick={()=>void readPreview()}>Odczytaj stan w WooCommerce</button>}
  {shown?.status==='NO_UNACKNOWLEDGED_DISPATCH'&&<p role="status">Brak zapisu wymagającego uzgodnienia.</p>}
  {shown?.status==='DISPATCH_IN_PROGRESS'&&<p role="status">Zapis jest w toku. Uzgodnienie będzie możliwe po jego zakończeniu.</p>}
  {shown?.status==='LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW'&&<section aria-label="Podgląd uzgodnienia stanu">
   {shown.planned?<><p>Planowany stan: {shown.planned.stock_quantity} szt.</p><p>Stan w WooCommerce: {shown.observed?shown.observed.manage_stock?(shown.observed.stock_quantity??'bez liczby')+' szt.':'bez zarządzania stanem':'nie odczytano'}.</p>
    {shown.observation_error&&<p>Nie udało się odczytać oferty w WooCommerce{shown.observation_error.provider_http_status!==null?' (kod WooCommerce: '+shown.observation_error.provider_http_status+')':''}.</p>}
    {shown.matches_plan!==null&&<p>{shown.matches_plan?'Stan w WooCommerce odpowiada planowi.':'Stan w WooCommerce różni się od planu.'}</p>}</>:<p>Przegląd ofert bez zapisu do WooCommerce.</p>}
   <p>Uzgodnienie nie ponawia zapisu. Zapisuje wyłącznie wybrany wynik pierwotnej, niepotwierdzonej próby.</p>
   {shown.allowed_outcomes.length?<><label><input type="checkbox" aria-label="Potwierdzam uzgodnienie bez ponawiania zapisu" checked={confirmed} disabled={blocked||!!marker} onChange={e=>setConfirmed(e.target.checked)}/>Rozumiem, że uzgodnienie nie ponawia zapisu.</label>
    {shown.allowed_outcomes.map(o=><button key={o} className="button" disabled={blocked||!confirmed||!!marker} onClick={()=>void reconcile(o)}>{outcomeLabel[o]}</button>)}</>:<p role="status">Brak dopuszczalnego wyniku bez odczytu oferty. Odczytaj stan w WooCommerce ponownie.</p>}
  </section>}
  {value&&marker&&!busy&&<p role="status">Uzgodnienie ma niepewny wynik. Zachowano jego dane; nie ponawiaj uzgodnienia. <button className="button" disabled={busy} onClick={()=>void observe()}>Odczytaj wynik uzgodnienia</button></p>}
  {value&&marker&&unknownSeen&&!busy&&<p>Serwer nie potwierdził tego uzgodnienia. <button className="button" disabled={blocked} onClick={()=>void discard()}>Porzuć niepotwierdzoną próbę uzgodnienia</button> Porzucenie nie cofa ani nie ponawia zapisu; przed kolejnym uzgodnieniem odczytaj stan ponownie.</p>}
  {done&&<p role="status">Uzgodniono: {doneLabel[done]}. Pierwotnego wyniku zapisu nie potwierdzono automatycznie.</p>}
  {busy&&<p role="status">Trwa odczyt lub zapis uzgodnienia…</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
