import {useEffect,useRef,useState} from 'react';
import {api} from './api';
type Props={contextKey:string;order:any;plan:any;write:boolean;disabled:boolean;onChanged:()=>void};
type Stage='bind'|'quote'|'buy';
type Attempt={v:1;context:string;orderId:string;planId:string;requestId:string;sent:Record<Stage,boolean>;bindConfirmed:boolean;jobIds:string[];shipmentId?:string};
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
const key=(context:string,orderId:string,planId:string)=>'dyna:local-carrier:v1:'+context+':'+orderId+':'+planId;
function decode(raw:string,context:string):Attempt{
 const a=JSON.parse(raw);if(a.v!==1||a.context!==context||![a.orderId,a.planId,a.requestId].every(uuid)
  ||typeof a.bindConfirmed!=='boolean'||!a.sent||Object.keys(a.sent).sort().join(',')!=='bind,buy,quote'
  ||Object.values(a.sent).some(v=>typeof v!=='boolean')||!Array.isArray(a.jobIds)||a.jobIds.length>2
  ||a.jobIds.some((id:unknown)=>!uuid(id))||new Set(a.jobIds).size!==a.jobIds.length
  ||(a.shipmentId!==undefined&&!uuid(a.shipmentId)))throw Error('Niepełny zapis próby. Zachowano go; nie ponawiaj etapów.');
 return a;
}
function load(context:string,orderId:string,planId:string){const raw=localStorage.getItem(key(context,orderId,planId));if(!raw)return null;const a=decode(raw,context);if(a.orderId!==orderId||a.planId!==planId)throw Error('Zapis dotyczy innego planu; nie nadpisano go.');return a;}
function save(a:Attempt){localStorage.setItem(key(a.context,a.orderId,a.planId),JSON.stringify(a));}
/** Sent flags are monotonic. Missing GET markers can never authorize the same POST again. */
export function mergeLocalCarrierReadback(a:Attempt,v:any):Attempt{
 if(v.scope!=='local_simulation'||v.request_id!==a.requestId||v.order_id!==a.orderId||v.plan_id!==a.planId||v.plan?.id!==a.planId)
  throw Error('Odczyt nie dotyczy zapamiętanej próby.');
 if(!Array.isArray(v.jobs)||v.jobs.length>2||v.jobs.some((j:any)=>!uuid(j.id)||j.kind!=='shipping')||new Set(v.jobs.map((j:any)=>j.id)).size!==v.jobs.length)
  throw Error('Niepełne tożsamości własnych zadań.');
 const ids=v.jobs.map((j:any)=>j.id);if(a.jobIds.some(id=>!ids.includes(id)))throw Error('Odczyt zmienił zapamiętane zadania.');
 const shipment=v.shipment?.id;if(shipment!==undefined&&shipment!==null&&(!uuid(shipment)||(a.shipmentId&&a.shipmentId!==shipment)))throw Error('Odczyt zmienił zapamiętaną przesyłkę.');
 return {...a,sent:{...a.sent},bindConfirmed:true,jobIds:ids.sort(),...(uuid(shipment)?{shipmentId:shipment}:{})};
}
export function canRunLocalCarrierStage(a:Attempt|null,facts:any,stage:'quote'|'buy'){
 if(!a?.bindConfirmed||a.sent[stage]||facts?.plan_id!==a.planId||facts.request_id!==a.requestId||facts.order_id!==a.orderId)return false;
 if(stage==='quote')return facts.plan?.state==='preview'&&facts.plan.phase==='ready'&&facts.plan.job_id===null;
 const job=facts.jobs?.find((j:any)=>j.id===facts.plan?.job_id);
 return facts.plan?.state==='buy_queued'&&facts.plan.phase==='buy_ready'&&job?.kind==='shipping'
  &&job.action==='buy'&&job.state==='pending'&&Number(job.attempts)===0;
}
export function LocalCarrierDemo(p:Props){
 const [tenantId,userId,role,readonly]=p.contextKey.split(':'),context=tenantId+':'+userId,orderId=p.order.id,planId=p.plan.id;
 const validContext=uuid(tenantId)&&uuid(userId)&&['admin','operator'].includes(role)&&readonly==='false'&&p.contextKey.split(':').length===4;
 const screen=p.contextKey+':'+orderId+':'+planId,current=useRef({screen,version:0});
 if(current.current.screen!==screen)current.current={screen,version:current.current.version+1};
 const version=current.current.version,here=()=>current.current.screen===screen&&current.current.version===version;
 const flight=useRef<number|null>(null),[loaded,setLoaded]=useState(false),[attempt,setAttempt]=useState<Attempt|null>(null),
  [facts,setFacts]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{current.current={screen,version};flight.current=null;setBusy(false);setLoaded(false);setAttempt(null);setFacts(null);setError('');
  try{setAttempt(load(context,orderId,planId));setLoaded(true)}catch(e){setError(e instanceof Error?e.message:'Nie można odczytać zapisu; nie ponawiaj.')}
  return ()=>{if(here())current.current={screen:'',version};};
 },[screen]);
 const locked=busy||!loaded||!p.write||p.disabled||!validContext||p.plan.simulation!=='true';
 const stillHere=()=>{if(!here())throw Error('Sesja, firma lub zamówienie zmieniły się. Zachowano pierwotną próbę.');};
 async function sameActor(){stillHere();const me=await api('/auth/me');stillHere();if(me.restore_preview||me.user?.id!==userId||me.user?.tenant_id!==tenantId||me.user?.role!==role)throw Error('Wymagana bieżąca sesja administratora lub operatora tej firmy.');}
 async function consumeReadback(a:Attempt,writeDurable:boolean){await sameActor();const v=await api('/orders/'+a.orderId+'/local-carrier/'+a.requestId);stillHere();
  const persisted=load(context,orderId,planId);if(!persisted||persisted.requestId!==a.requestId||persisted.planId!==a.planId)throw Error('Zapamiętana próba zmieniła się.');
  mergeLocalCarrierReadback(persisted,v);await sameActor();
  const latest=load(context,orderId,planId);if(!latest||latest.requestId!==a.requestId)throw Error('Próba zmieniła się podczas odczytu.');
  const next=mergeLocalCarrierReadback(latest,v);if(writeDurable)save(next);setAttempt(next);setFacts(v);
 }
 async function read(a:Attempt){
  if(navigator.locks)return navigator.locks.request(key(context,orderId,planId),{mode:'exclusive'},()=>consumeReadback(a,true));
  return consumeReadback(a,false); // unsupported locking permits observation only, never a durable write or POST.
 }
 async function readOwn(){if(!attempt||busy||!loaded||!validContext||flight.current!==null)return;flight.current=version;setBusy(true);setError('');try{await read(attempt)}catch(e){if(here())setError(e instanceof Error?e.message:'Nie potwierdzono odczytu.')}finally{if(flight.current===version)flight.current=null;if(here())setBusy(false)}}
 async function post(stage:Stage){
  if(locked||flight.current!==null||(stage==='bind'?(!!attempt||!uuid(planId)):!canRunLocalCarrierStage(attempt,facts,stage)))return;
  flight.current=version;setBusy(true);setError('');let a=attempt;
  try{
   if(!navigator.locks)throw Error('Ta przeglądarka nie obsługuje bezpiecznej blokady kart. Zachowano próbę; dostępny jest tylko odczyt.');
   await navigator.locks.request(key(context,orderId,planId),{mode:'exclusive'},async()=>{
   await sameActor();const durable=load(context,orderId,planId);
   if(stage==='bind'){if(durable)throw Error('Zapamiętano inną próbę. Użyj jej odczytu.');
    if(p.plan.actor_id!==userId||p.plan.order_id!==orderId||p.plan.state!=='preview'||p.plan.phase!=='ready'||p.plan.job_id||p.plan.shipment_id)throw Error('Wymagany własny nieuruchomiony podgląd DEMO.');
    a={v:1,context,orderId,planId,requestId:crypto.randomUUID(),sent:{bind:false,quote:false,buy:false},bindConfirmed:false,jobIds:[]};
   }else{
    if(!a||!durable||durable.requestId!==a.requestId||durable.planId!==a.planId||durable.sent[stage])throw Error('Etap jest już wysłany lub tożsamość próby się zmieniła. Nie ponawiaj.');
    a=durable;
   }
   a={...a!,sent:{...a!.sent,[stage]:true}};save(a);setAttempt(a); // Durable fence BEFORE the only POST; storage failure prevents it.
   const url='/api/orders/'+a.orderId+'/local-carrier/'+a.requestId+'/'+(stage==='bind'?'bind':'run');
   const response=await fetch(url,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'X-Workspace-ID':tenantId,'Content-Type':'application/json'},body:JSON.stringify(stage==='bind'?{plan_id:a.planId}:{action:stage})});
   const v=await response.json();stillHere();
   if(v.request_id!==a.requestId||v.order_id!==a.orderId||(v.plan_id!==undefined&&v.plan_id!==null&&v.plan_id!==a.planId))throw Error('Odpowiedź dotyczy innej próby; nie nadpisano tożsamości.');
   if(!response.ok)throw Error('HTTP '+response.status+'. Etap mógł rozpocząć się; użyj tylko odczytu.');
   if(stage==='bind'){if(v.status!=='BOUND'||v.scope!=='local_simulation')throw Error('Brak potwierdzenia powiązania.');}
   else if(v.status!=='OWNED_LOCAL_CARRIER_STAGE_DONE'||v.stage!==stage||v.scope!=='local_simulation')throw Error('Brak potwierdzenia zakończenia etapu.');
   await consumeReadback(a,true);stillHere();p.onChanged(); // already owns this key's Web Lock; never reacquire it.
   });
  }catch(e){if(here())setError(e instanceof Error?e.message:'Niepewny wynik. Zachowano marker wysłania; nie ponawiaj.');}
  finally{if(flight.current===version)flight.current=null;if(here())setBusy(false)}
 }
 const quoteSent=!!attempt?.sent.quote,buySent=!!attempt?.sent.buy;
 return <div className="ops-result local-carrier-demo">
  <h3>Lokalne wykonanie InPost DEMO</h3>
  <p>Bez płatnej przesyłki i bez połączenia z przewoźnikiem. Powiąż ten podgląd przed wyceną. Po wycenie wybierz ofertę i potwierdź zakup w zwykłym panelu powyżej; następnie odczytaj próbę i wykonaj jej zakup.</p>
  <p>Etykieta, nadanie i tracking pozostają w istniejących przyciskach. Druk wymaga aktywnego stanowiska, drukarki i rzeczywistego uprawnienia. Zamówienie musi spełniać warunki płatności, spakowania i rezerwacji.</p>
  {!validContext&&<p>Wymagana zwykła sesja administratora lub operatora tej firmy, bez podglądu tylko do odczytu.</p>}
  <div className="ops-buttons">{!attempt&&<button type="button" className="button" disabled={locked||p.plan.state!=='preview'||p.plan.phase!=='ready'||!!p.plan.job_id||p.plan.actor_id!==userId}
   onClick={()=>void post('bind')}>Powiąż ten podgląd z lokalną próbą</button>}
  {attempt&&<><p>Zapamiętano własną próbę dla tego planu. Wysłanych etapów nie można powtórzyć.</p>
   <button type="button" className="button" disabled={locked||!canRunLocalCarrierStage(attempt,facts,'quote')} onClick={()=>void post('quote')}>Wykonaj lokalną wycenę raz</button>
   <button type="button" className="button" disabled={locked||!canRunLocalCarrierStage(attempt,facts,'buy')} onClick={()=>void post('buy')}>Wykonaj lokalny zakup raz</button>
   <button type="button" className="button" disabled={busy||!loaded||!validContext} onClick={()=>void readOwn()}>Odczytaj tę samą próbę</button>
   {(quoteSent||buySent)&&<p className="muted">Po niepewnej odpowiedzi użyj wyłącznie odczytu. Brak markera w GET nie odblokowuje wysłanego etapu.</p>}</>}</div>
  {facts&&<p>Plan: {facts.plan?.state} · faza: {facts.plan?.phase} · przesyłka: {facts.shipment?.status??'brak'}.</p>}
  {error&&<p className="notice import-error" role="alert">{error}</p>}
 </div>;
}
