import {useEffect,useRef,useState} from 'react';
import {api} from './api';
type Step='order-stage'|'listing-sync'|'cancel-status';
type Marker={request_id:string;state:'sent'|'unknown'|'acknowledged';source_order_id?:number;plan_id?:string;job_id?:string;delivery_id?:string;body_hash?:string};
type FailedSyncProof={request_id:string;job_id:string;plan_id:string};
type ImportedOrder={id:string;number:string;status:string};
type Flow={failed_before_write?:{'listing-sync'?:FailedSyncProof};imported_order:ImportedOrder|null;scope:'local_simulation';provider_verified:false;channel_id:string;product_id:string;listing_id:string;steps:Partial<Record<Step,Marker>>;jobs:{id:string;kind:string;state:string;attempts:number;max_attempts:number;lease_active:boolean}[]};
type Attempt={v:1;context:string;product:string;channel:string;listing?:string;imported_order_id?:string;steps:Partial<Record<Step,Marker>>};
type Props={tenantId:string;userId:string;productId:string;admin:boolean;readOnly:boolean;externalWriteBlocked:boolean};
const steps:Step[]=['order-stage','listing-sync','cancel-status'];
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const key=(context:string,product:string)=>'dyna:local-woo-flow:v1:'+context+':'+product;
function marker(v:unknown):asserts v is Marker{
 const m=v as Marker; if(!m||!uuid(m.request_id)||!['sent','unknown','acknowledged'].includes(m.state)
  ||['plan_id','job_id','delivery_id'].some(k=>m[k as keyof Marker]!==undefined&&!uuid(m[k as keyof Marker]))
  ||m.source_order_id!==undefined&&(!Number.isSafeInteger(m.source_order_id)||m.source_order_id<=0)
  ||m.body_hash!==undefined&&!/^[a-f0-9]{64}$/.test(m.body_hash))throw Error('Niepełne tożsamości próby Woo. Nie ponawiaj zapisu.');
}
export function parseLocalWooAttempt(raw:string|null,context:string,product:string):Attempt|null{
 if(raw===null)return null;const a=JSON.parse(raw) as Attempt;
 if(!a||a.v!==1||a.context!==context||a.product!==product||!uuid(a.product)||!uuid(a.channel)||a.listing!==undefined&&!uuid(a.listing)||a.imported_order_id!==undefined&&!uuid(a.imported_order_id)||!a.steps||Object.keys(a.steps).some(k=>!steps.includes(k as Step)))throw Error('Niepełny zapis próby Woo. Zachowaj klucze i uzgodnij wynik.');
 Object.values(a.steps).forEach(marker);return a;
}
export function mergeLocalWooReadback(a:Attempt,value:unknown):{attempt:Attempt;flow:Flow}{
 const f=value as Flow;
 if(!f||f.scope!=='local_simulation'||f.provider_verified!==false||f.channel_id!==a.channel||f.product_id!==a.product||!uuid(f.listing_id)||a.listing!==undefined&&a.listing!==f.listing_id||!f.steps||Object.keys(f.steps).some(k=>!steps.includes(k as Step))||!Array.isArray(f.jobs))throw Error('Odczyt nie odpowiada własnej ofercie DEMO.');
 if(f.imported_order!==null&&(!f.imported_order||!uuid(f.imported_order.id)||typeof f.imported_order.number!=='string'||f.imported_order.number.length<1||f.imported_order.number.length>160||typeof f.imported_order.status!=='string'||f.imported_order.status.length<1||f.imported_order.status.length>80))throw Error('Niepełny odczyt lokalnego zamówienia.');
 if(a.imported_order_id!==undefined&&a.imported_order_id!==f.imported_order?.id)throw Error('Tożsamość lokalnego zamówienia zmieniła się. Zachowano poprzedni zapis.');
 if(f.failed_before_write!==undefined){const proof=f.failed_before_write;if(!proof||Array.isArray(proof)||typeof proof!=='object'||Object.keys(proof).some(k=>k!=='listing-sync'))throw Error('Niepełny odczyt zakończenia synchronizacji.');const m=proof['listing-sync'];if(m!==undefined&&(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).sort().join(',')!=='job_id,plan_id,request_id'||![m.request_id,m.job_id,m.plan_id].every(uuid)))throw Error('Niepełne tożsamości zakończenia synchronizacji.');}
 for(const m of Object.values(f.steps))marker(m);
 for(const j of f.jobs)if(!uuid(j.id)||!['webhook.stage','offer.write','order.status.write'].includes(j.kind)||!Number.isSafeInteger(Number(j.attempts))||!Number.isSafeInteger(Number(j.max_attempts))||typeof j.lease_active!=='boolean')throw Error('Niepełny odczyt własnego zadania.');
 const next:Attempt={...a,listing:f.listing_id,...(f.imported_order?{imported_order_id:f.imported_order.id}:{}),steps:{...a.steps}};
 for(const step of steps){const old=a.steps[step],found=f.steps[step];
  if(!old&&!found)continue;
  if(!found&&old){next.steps[step]={...old,state:old.state==='acknowledged'?'acknowledged':'unknown'};continue;}
  if(!found)continue; // Absence cannot grant resend.
  if(old&&(found.request_id!==old.request_id||['plan_id','job_id','delivery_id','source_order_id','body_hash'].some(k=>old[k as keyof Marker]!==undefined&&old[k as keyof Marker]!==found[k as keyof Marker])))throw Error('Oryginalne IDs zmieniły się. Zachowano poprzedni zapis.');
  if(found.state==='acknowledged'){
   const job=f.jobs.filter(j=>j.id===found.job_id);const kind=step==='order-stage'?'webhook.stage':step==='listing-sync'?'offer.write':'order.status.write';
   if(step==='order-stage'&&(!found.source_order_id||!found.delivery_id||!found.body_hash)||step!=='order-stage'&&!found.plan_id||!found.job_id||job.length!==1||job[0].kind!==kind||job[0].state!=='done'||Number(job[0].attempts)!==1||Number(job[0].max_attempts)!==1||job[0].lease_active)throw Error('Brak dokładnego zakończenia własnego zadania.');
  }
  next.steps[step]={...found,state:old?.state==='acknowledged'?'acknowledged':found.state};
 }
 return{attempt:next,flow:f};
}
export function canSendLocalWooCancellation(f:Flow|null):boolean{return Boolean(f?.steps['order-stage']?.state==='acknowledged'&&f.imported_order&&uuid(f.imported_order.id)&&f.imported_order.status==='cancelled');}
export function hasFailedSyncProof(a:Attempt|null,f:Flow|null):boolean{
 if(!a||!f)return false;
 const old=a.steps['listing-sync'],found=f.steps['listing-sync'],proof=f.failed_before_write?.['listing-sync'];
 if(!old||!found||!proof||old.state!=='unknown'||found.state!=='unknown'||![old.request_id,old.plan_id,old.job_id].every(uuid))return false;
 if(['request_id','plan_id','job_id'].some(k=>old[k as keyof Marker]!==found[k as keyof Marker]||old[k as keyof Marker]!==proof[k as keyof FailedSyncProof]))return false;
 const jobs=f.jobs.filter(j=>j.id===proof.job_id);
 return jobs.length===1&&jobs[0].kind==='offer.write'&&jobs[0].state==='failed'&&Number(jobs[0].attempts)===1&&Number(jobs[0].max_attempts)===1&&!jobs[0].lease_active;
}
export function canCancelAfterFailedSync(a:Attempt|null,f:Flow|null):boolean{
 if(!a||!f||!hasFailedSyncProof(a,f)||!canSendLocalWooCancellation(f)||a.steps['order-stage']?.state!=='acknowledged'||a.steps['cancel-status']||f.steps['cancel-status'])return false;
 return ![a.steps,f.steps].some(s=>Object.entries(s).some(([step,m])=>step!=='listing-sync'&&m.state!=='acknowledged'));
}
function uncertainSteps(a:Attempt|null,f:Flow|null){return [a?.steps??{},f?.steps??{}].some(s=>Object.values(s).some(m=>m.state!=='acknowledged'));}

export function LocalWooFlow(p:Props){
 const context=p.tenantId+':'+p.userId,identity=context+':'+p.productId;
 const [attempt,setAttempt]=useState<Attempt|null>(null),[channels,setChannels]=useState<{id:string;name:string}[]>([]),[channel,setChannel]=useState(''),[flow,setFlow]=useState<Flow|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),generation=useRef(0),current=useRef(identity),flight=useRef<number|null>(null),access=useRef(false);
 current.current=identity;access.current=p.admin&&!p.readOnly&&!p.externalWriteBlocked;
 const visible=(epoch:number)=>alive.current&&current.current===identity&&generation.current===epoch;
 const load=()=>parseLocalWooAttempt(localStorage.getItem(key(context,p.productId)),context,p.productId);
 const save=(a:Attempt)=>localStorage.setItem(key(a.context,a.product),JSON.stringify(a));
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 useEffect(()=>{generation.current++;flight.current=null;setBusy(false);setFlow(null);setChannels([]);setError('');setLoaded(false);setAttempt(null);setChannel('');try{if(![p.tenantId,p.userId,p.productId].every(uuid))throw Error('Brak właściwego produktu lub firmy.');const a=load();setAttempt(a);setChannel(a?.channel??'');setLoaded(true);}catch(e){setError(e instanceof Error?e.message:'Nie można odczytać zachowanej próby.');}},[identity]);
 async function sameActor(epoch:number){if(!visible(epoch)||!p.admin||p.readOnly)throw Error('Kontekst zmienił się.');const me=await api('/auth/me');if(!visible(epoch)||me.restore_preview||me.user?.tenant_id!==p.tenantId||me.user?.id!==p.userId||me.user?.role!=='admin')throw Error('Wymagana aktualna sesja administratora tej firmy.');}
 async function lock<T,>(work:()=>Promise<T>){if(!navigator.locks?.request)throw Error('Brak bezpiecznej blokady kart. Zapis jest niedostępny.');return navigator.locks.request(key(context,p.productId),{mode:'exclusive'},work);}
 async function get(a:Attempt,epoch:number){await sameActor(epoch);const result=await api('/integrations/'+a.channel+'/local-woo-flow');await sameActor(epoch);return mergeLocalWooReadback(a,result);}
 async function operate(work:(epoch:number)=>Promise<void>){if(!loaded||flight.current!==null)return;const epoch=generation.current;flight.current=epoch;setBusy(true);setError('');try{await work(epoch);}catch(e){if(visible(epoch))setError(e instanceof Error?e.message:'Wynik niepewny. Odczytaj bez ponawiania.');}finally{if(flight.current===epoch){flight.current=null;if(visible(epoch))setBusy(false);}}}
 async function find(){await operate(async epoch=>{await sameActor(epoch);const result=await api('/integrations');await sameActor(epoch);if(!Array.isArray(result.channels))throw Error('Niepełna lista kanałów.');const own=result.channels.filter((c:any)=>uuid(c.id)&&c.provider==='woocommerce'&&c.mode==='sandbox'&&c.settings?.simulation===true&&c.settings.local_offer_source==='scoped-woocommerce-offer/v1'&&c.settings.local_offer_actor_id===p.userId&&c.sync_enabled===false);if(visible(epoch))setChannels(own.map((c:any)=>({id:c.id,name:String(c.name??'Własna oferta DEMO')})));});}
 async function read(){await operate(async epoch=>{await lock(async()=>{const a=load()??{v:1 as const,context,product:p.productId,channel,steps:{}};if(!uuid(a.channel))throw Error('Wybierz własny kanał DEMO.');const result=await get(a,epoch);if(!visible(epoch))throw Error('Widok zmienił się.');save(result.attempt);setAttempt(result.attempt);setFlow(result.flow);});});}
 async function send(step:Step){
  await operate(async epoch=>{const pending:{sent:Attempt|null}={sent:null};
   try{await lock(async()=>{
    await sameActor(epoch);if(!access.current||!visible(epoch))throw Error('Zapis zablokowany.');
    const a=load()??{v:1 as const,context,product:p.productId,channel,steps:{}};if(!uuid(a.channel))throw Error('Wybierz własny kanał.');
    // The local marker only permits a fresh GET, never a write or replay.
    const mayReadForCancellation=step==='cancel-status'&&a.steps['order-stage']?.state==='acknowledged'&&Object.entries(a.steps).every(([s,m])=>m.state==='acknowledged'||s==='listing-sync'&&m.state==='unknown'&&[m.request_id,m.plan_id,m.job_id].every(uuid));
    if(a.steps[step]||uncertainSteps(a,null)&&!mayReadForCancellation)throw Error('Etap już wysłany lub wynik niepewny. Użyj tylko odczytu.');
    const prior=await get(a,epoch);const cancellationException=step==='cancel-status'&&canCancelAfterFailedSync(prior.attempt,prior.flow);
    if(prior.flow.steps[step]||uncertainSteps(prior.attempt,prior.flow)&&!cancellationException)throw Error('Zapisany etap blokuje ponowienie. Odczytaj jego oryginalny wynik.');
    if(step==='cancel-status'&&!canSendLocalWooCancellation(prior.flow))throw Error('Najpierw potwierdź import i anulowanie własnego zamówienia przez odczyt. Status nie został wysłany.');
    if(!access.current||!visible(epoch))throw Error('Widok zmienił się.');
    const request_id=crypto.randomUUID();const sent:Attempt={...prior.attempt,steps:{...prior.attempt.steps,[step]:{request_id,state:'sent'}}};pending.sent=sent;save(sent);setAttempt(sent); // Before the only POST.
    const response=await api('/integrations/'+a.channel+'/local-woo-flow/steps','POST',{request_id,step});
    await sameActor(epoch);const confirmed=mergeLocalWooReadback(sent,response);
    if(confirmed.attempt.steps[step]?.state!=='acknowledged')throw Error('Etap nie jest potwierdzony. Nie ponawiaj.');
    const stored=load();if(!stored||stored.steps[step]?.request_id!==request_id)throw Error('Zapis próby zmienił się.');
    save(confirmed.attempt);if(visible(epoch)){setAttempt(confirmed.attempt);setFlow(confirmed.flow);}
   });}catch(first){if(pending.sent){const original=pending.sent;try{await lock(async()=>{const stored=load();if(stored&&stored.steps[step]?.request_id===original.steps[step]?.request_id&&stored.steps[step]?.state!=='acknowledged'){const unknown:Attempt={...stored,steps:{...stored.steps,[step]:{...stored.steps[step]!,state:'unknown'}}};save(unknown);if(visible(epoch))setAttempt(unknown);}});}catch{}}throw first;}
  });
 }
 const failedSyncProven=hasFailedSyncProof(attempt,flow),otherUncertain=[attempt?.steps??{},flow?.steps??{}].some(s=>Object.entries(s).some(([step,m])=>m.state!=='acknowledged'&&(step!=='listing-sync'||!failedSyncProven)));
 const uncertain=uncertainSteps(attempt,flow),baseDisabled=busy||!loaded||!access.current||!flow||flow.product_id!==p.productId,disabled=baseDisabled||uncertain,cancellationDisabled=baseDisabled||(uncertain&&!canCancelAfterFailedSync(attempt,flow));
 return <section className="catalog-section local-demo-woo"><h3>Lokalny obieg oferty Woo — DEMO</h3><p>Wyłącznie własny kanał lokalnej oferty. Zapis zamówienia tworzy źródło staging; mapowanie i import odbywają się istniejącą ścieżką. Bez połączenia z WooCommerce ani potwierdzenia dostawcy.</p>
 <div className="ops-buttons"><button type="button" className="button" disabled={busy||!loaded||!p.admin||p.readOnly} onClick={()=>void find()}>Znajdź własne kanały DEMO</button>
 <label>Kanał lokalnej oferty<select value={channel} disabled={busy||Boolean(attempt)} onChange={e=>{setChannel(e.target.value);setFlow(null);}}><option value="">Wybierz kanał</option>{channels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}{attempt&&!channels.some(c=>c.id===attempt.channel)&&<option value={attempt.channel}>Zachowana własna próba</option>}</select></label>
 <button type="button" className="button" disabled={busy||!loaded||!channel||!p.admin||p.readOnly} onClick={()=>void read()}>Odczytaj oryginalny wynik</button></div>
 {flow&&<p role="status">Potwierdzono własną ofertę DEMO. Dostawca niezweryfikowany.</p>}
 <div className="ops-buttons"><button type="button" className="button" disabled={disabled||Boolean(flow?.steps['order-stage'])||Boolean(attempt?.steps['order-stage'])} onClick={()=>void send('order-stage')}>Zapisz nowe zamówienie źródłowe DEMO</button><button type="button" className="button" disabled={disabled||Boolean(flow?.steps['listing-sync'])||Boolean(attempt?.steps['listing-sync'])} onClick={()=>void send('listing-sync')}>Synchronizuj cenę i stan oferty DEMO</button><button type="button" className="button" disabled={cancellationDisabled||!canSendLocalWooCancellation(flow)||Boolean(flow?.steps['cancel-status'])||Boolean(attempt?.steps['cancel-status'])} onClick={()=>void send('cancel-status')}>Przekaż status anulowania DEMO</button></div>
 {failedSyncProven&&<p className="notice" role="status">Synchronizacja zakończyła się przed zapisem oferty. Jej oryginalna próba pozostaje niepotwierdzona i nie może być ponowiona.{canCancelAfterFailedSync(attempt,flow)&&' Możesz osobno przekazać status własnego anulowanego zamówienia; przed wysłaniem sprawdzimy ten stan ponownie.'}</p>}
 {otherUncertain&&<p className="notice" role="status">Wysłana próba może być w toku. Odświeżenie nie ponawia POST. Zachowaj oryginalne klucze i użyj wyłącznie odczytu.</p>}
 {flow&&<ul>{Object.entries(flow.steps).map(([s,m])=><li key={s}>{s==='order-stage'?'Źródło zamówienia':s==='listing-sync'?'Stan i cena oferty':'Status istniejącego anulowania'}: {m.state==='acknowledged'?'Potwierdzono':m.state==='sent'?'W toku':'Wynik niepewny'}</li>)}</ul>}
 {flow?.steps['order-stage']?.state==='acknowledged'&&<p className="notice" role="status">Źródło zamówienia #{flow.steps['order-stage'].source_order_id} zapisano. Aby utworzyć lokalne zamówienie, wybierz Integracje → ten sam kanał → „Import bez mapowania pól”, wskaż własny magazyn i kliknij „Importuj #{flow.steps['order-stage'].source_order_id}”. Sprawdź istniejące powiązanie SKU; poprawnego powiązania nie zmieniaj.</p>}
 {flow?.imported_order&&<p>Lokalne zamówienie: {flow.imported_order.number} · {flow.imported_order.status}. Przekazanie statusu jest dostępne dopiero po odczycie potwierdzonego anulowania.</p>}
 <details><summary>Szczegóły zachowanej próby</summary><p>Produkt: {p.productId}</p>{attempt&&<><p>Kanał: {attempt.channel}</p>{Object.entries(attempt.steps).map(([s,m])=><p key={s}>{s}: request {m.request_id} · job {m.job_id??'brak potwierdzonego ID'} · plan {m.plan_id??'—'} · delivery {m.delivery_id??'—'} · zamówienie źródłowe {m.source_order_id??'—'}</p>)}</>}</details>
 {error&&<p className="notice error" role="alert">{error}</p>}
 {channel&&uuid(channel)&&<CurrentWooSync key={identity+':'+channel} {...p} channelId={channel}/>}
 <p>Ten panel nie anuluje zamówienia i nie wykonuje zwrotu. Przekazuje tylko status uprzednio potwierdzonego anulowania własnego importowanego zamówienia; nie anuluje go ani nie wykonuje refundu.</p></section>;
}

type SyncPredecessor={kind:'initial'}|{kind:'legacy'|'current';request_id:string;plan_id:string;job_id:string};
type SyncDesired={price:number;currency:'PLN';stock:number};
type SyncResult={scope:'local_simulation';desired_applied:true;requested_payload:unknown;verified_payload:unknown};
type SyncHistory={request_id:string;plan_id:string;job_id:string;sequence:number;desired:SyncDesired};
type SyncFact={request_id:string;plan_id:string;job_id:string;state:'acknowledged'|'failed_before_write'|'unsettled';job_state:string;plan_state:string;phase:string;lease_active:boolean;result:SyncResult|null};
type SyncRequest={request_id:string;state:'preview_pending'|'failed_before_queue';can_queue:false;plan_id:null;job_id:null;result:null}|{schema:'local-woo-current-sync/v1';request_id:string;plan_id:string;product_id:string;listing_id:string;warehouse_id:string;predecessor:SyncPredecessor;desired:SyncDesired;state:'preview'|'acknowledged'|'failed_before_write'|'unsettled';can_queue:boolean;job_id:string|null;result:SyncResult|null};
type SyncHead={scope:'local_simulation';provider_verified:false;channel_id:string;product_id:string;listing_id:string;can_preview:boolean;predecessor:SyncPredecessor;current:SyncFact|null;pending_preview:{request_id:string}|null;history:SyncHistory[];request?:SyncRequest};
type SyncAttempt={v:1;context:string;product:string;channel:string;request_id:string;sent_kind:'preview'|'queue';stage:'sent'|'unknown'|'preview'|'acknowledged'|'failed_before_write'|'failed_before_queue';predecessor:SyncPredecessor;plan_id?:string;job_id?:string};
const syncStates=['sent','unknown','preview','acknowledged','failed_before_write','failed_before_queue'];
const syncKey=(context:string,product:string,channel:string)=>'dyna:local-woo-current-sync:v1:'+context+':'+product+':'+channel;
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const equal=(a:unknown,b:unknown):boolean=>{
 if(Object.is(a,b))return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
 if(!object(a)||!object(b))return false;
 const keys=Object.keys(a).sort();return keys.join(',')===Object.keys(b).sort().join(',')&&keys.every(k=>equal(a[k],b[k]));
};
function predecessor(v:unknown):v is SyncPredecessor{
 if(!object(v))return false;
 return v.kind==='initial'?Object.keys(v).join(',')==='kind':['legacy','current'].includes(String(v.kind))&&Object.keys(v).sort().join(',')==='job_id,kind,plan_id,request_id'&&[v.request_id,v.plan_id,v.job_id].every(uuid);
}
function desired(v:unknown):v is SyncDesired{return object(v)&&v.currency==='PLN'&&Number.isSafeInteger(v.price)&&Number(v.price)>=0&&Number.isSafeInteger(v.stock)&&Number(v.stock)>=0&&Object.keys(v).sort().join(',')==='currency,price,stock';}
function result(v:unknown):v is SyncResult{return object(v)&&v.scope==='local_simulation'&&v.desired_applied===true&&object(v.requested_payload)&&object(v.verified_payload)&&equal(v.requested_payload,v.verified_payload);}
export function parseCurrentWooAttempt(raw:string|null,context:string,product:string,channel:string):SyncAttempt|null{
 if(raw===null)return null;const a=JSON.parse(raw) as SyncAttempt;
 if(!object(a)||a.v!==1||a.context!==context||a.product!==product||a.channel!==channel||![a.product,a.channel,a.request_id].every(uuid)||!syncStates.includes(a.stage)||!['preview','queue'].includes(a.sent_kind)||!predecessor(a.predecessor)||a.plan_id!==undefined&&!uuid(a.plan_id)||a.job_id!==undefined&&!uuid(a.job_id)||Object.keys(a).some(k=>!['v','context','product','channel','request_id','sent_kind','stage','predecessor','plan_id','job_id'].includes(k))||a.sent_kind==='queue'&&!a.plan_id||a.stage==='preview'&&(!a.plan_id||a.sent_kind!=='preview')||['acknowledged','failed_before_write'].includes(a.stage)&&(!a.plan_id||!a.job_id||a.sent_kind!=='queue')||a.stage==='failed_before_queue'&&a.sent_kind!=='preview')throw Error('Niepełny zapis pierwotnej synchronizacji. Nie ponawiaj zapisu.');
 return a;
}
export function parseCurrentWooRead(value:unknown,product:string,channel:string,a:SyncAttempt|null=null):SyncHead{
 const f=value as SyncHead;
 if(!object(f)||f.scope!=='local_simulation'||f.provider_verified!==false||f.product_id!==product||f.channel_id!==channel||!uuid(f.listing_id)||!predecessor(f.predecessor)||typeof f.can_preview!=='boolean'||!Array.isArray(f.history)||f.pending_preview!==null&&(!object(f.pending_preview)||!uuid(f.pending_preview.request_id)||Object.keys(f.pending_preview).join(',')!=='request_id'))throw Error('Odczyt nie odpowiada własnej bieżącej ofercie DEMO.');
 const ids=new Set<string>();for(const [i,h] of f.history.entries()){if(!object(h)||![h.request_id,h.plan_id,h.job_id].every(uuid)||h.sequence!==i+1||!desired(h.desired)||[h.request_id,h.plan_id,h.job_id].some(id=>ids.has(id)))throw Error('Niepełna historia synchronizacji.');for(const id of [h.request_id,h.plan_id,h.job_id])ids.add(id);}
 const last=f.history.at(-1);
 if(f.current!==null){const c=f.current;if(!object(c)||![c.request_id,c.plan_id,c.job_id].every(uuid)||!['acknowledged','failed_before_write','unsettled'].includes(c.state)||typeof c.lease_active!=='boolean'||[c.job_state,c.plan_state,c.phase].some(v=>typeof v!=='string'||v.length>80)||!last||!['request_id','plan_id','job_id'].every(k=>c[k as keyof SyncFact]===last[k as keyof SyncHistory])||!equal(f.predecessor,{kind:'current',request_id:c.request_id,plan_id:c.plan_id,job_id:c.job_id}))throw Error('Niepełne powiązanie ostatniego zadania.');
  if(c.state==='acknowledged'&&(c.lease_active||c.job_state!=='done'||c.plan_state!=='done'||c.phase!=='done'||!result(c.result)))throw Error('Brak dokładnego zakończenia synchronizacji.');
  if(c.state==='failed_before_write'&&(c.lease_active||c.job_state!=='failed'||!['conflict','failed'].includes(c.plan_state)||c.phase!=='ready'||c.result!==null))throw Error('Brak potwierdzenia zakończenia przed zapisem.');
 }else if(last||f.predecessor.kind==='current')throw Error('Brak ostatniego zadania.');
 if(f.can_preview&&(f.current?.state==='unsettled'||f.pending_preview))throw Error('Niepewna próba nadal blokuje nowy zapis.');
 if(f.request!==undefined){const r=f.request;if(!object(r)||!a||r.request_id!==a.request_id)throw Error('Odczyt zmienił oryginalny klucz.');
  if(r.state==='preview_pending'||r.state==='failed_before_queue'){
   if(r.plan_id!==null||r.job_id!==null||r.result!==null||r.can_queue!==false||a.plan_id!==undefined||a.sent_kind!=='preview'||Object.keys(r).sort().join(',')!=='can_queue,job_id,plan_id,request_id,result,state'||r.state==='preview_pending'&&f.pending_preview?.request_id!==r.request_id||r.state==='failed_before_queue'&&f.pending_preview?.request_id===r.request_id)throw Error('Niepełny wynik pierwotnego podglądu.');
  }else{
   if(!('schema' in r))throw Error('Niepełny podgląd.');
   if(r.schema!=='local-woo-current-sync/v1'||!uuid(r.plan_id)||r.product_id!==product||r.listing_id!==f.listing_id||!uuid(r.warehouse_id)||!desired(r.desired)||!predecessor(r.predecessor)||!equal(r.predecessor,a.predecessor)||a.plan_id!==undefined&&a.plan_id!==r.plan_id||a.job_id!==undefined&&a.job_id!==r.job_id||typeof r.can_queue!=='boolean'||!['preview','acknowledged','failed_before_write','unsettled'].includes(r.state))throw Error('Oryginalny plan synchronizacji zmienił się.');
   if(r.state==='preview'){if(r.job_id!==null||r.result!==null||f.history.some(h=>h.request_id===r.request_id)||r.can_queue&&(!f.can_preview||!equal(f.predecessor,r.predecessor)))throw Error('Niepełny podgląd synchronizacji.');}
   else {const h=f.history.find(h=>h.request_id===r.request_id);if(!uuid(r.job_id)||!h||h.plan_id!==r.plan_id||h.job_id!==r.job_id||!equal(h.desired,r.desired)||r.can_queue||r.state==='acknowledged'&&!result(r.result)||r.state==='failed_before_write'&&r.result!==null||f.current?.request_id===r.request_id&&(f.current.state!==r.state||!equal(f.current.result,r.result)))throw Error('Brak dokładnego wyniku własnego zadania.');}
  }
 }
 return f;
}
export function mergeCurrentWooAttempt(a:SyncAttempt,f:SyncHead):SyncAttempt{
 const r=f.request;if(!r||r.request_id!==a.request_id)throw Error('Brak odczytu pierwotnej próby.');
 if(r.state==='preview_pending')return {...a,stage:'unknown'};
 if(r.state==='failed_before_queue')return {...a,stage:'failed_before_queue'};
 // A preview read after a queue was sent cannot prove zero queue effects.
 if(a.sent_kind==='queue'&&r.state==='preview')return {...a,stage:'unknown'};
 if(!('schema' in r))throw Error('Brak pełnego oryginalnego podglądu.');
 return {...a,plan_id:r.plan_id,predecessor:r.predecessor,...(r.job_id?{job_id:r.job_id,sent_kind:'queue' as const}:{}),stage:r.state==='unsettled'?'unknown':r.state};
}
export function canPreviewCurrentWoo(a:SyncAttempt|null,f:SyncHead|null):boolean{
 if(!f?.can_preview)return false;if(!a)return true;
 const r=f.request;if(!r||r.request_id!==a.request_id)return false;
 return a.sent_kind==='preview'?['preview','failed_before_queue'].includes(r.state):['acknowledged','failed_before_write'].includes(r.state);
}
export function CurrentWooSync(p:Props&{channelId:string}){
 const context=p.tenantId+':'+p.userId,identity=context+':'+p.productId+':'+p.channelId,storage=syncKey(context,p.productId,p.channelId);
 const [a,setA]=useState<SyncAttempt|null>(null),[data,setData]=useState<SyncHead|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),epoch=useRef(0),flight=useRef<number|null>(null),current=useRef(identity),access=useRef(p);current.current=identity;access.current=p;
 const visible=(n:number)=>alive.current&&current.current===identity&&epoch.current===n;
 const load=()=>parseCurrentWooAttempt(localStorage.getItem(storage),context,p.productId,p.channelId);
 const save=(v:SyncAttempt)=>{const raw=JSON.stringify(v);localStorage.setItem(storage+':request:'+v.request_id,raw);if(localStorage.getItem(storage+':request:'+v.request_id)!==raw)throw Error('Nie zapisano klucza próby.');localStorage.setItem(storage,raw);if(localStorage.getItem(storage)!==raw)throw Error('Nie zapisano pierwotnej próby.');};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 useEffect(()=>{epoch.current++;flight.current=null;setBusy(false);setData(null);setA(null);setError('');setLoaded(false);try{if(![p.tenantId,p.userId,p.productId,p.channelId].every(uuid))throw Error('Brak własnego kanału i produktu.');setA(load());setLoaded(true);}catch(e){setError(e instanceof Error?e.message:'Nie można odczytać zachowanej próby.');}},[identity]);
 async function same(n:number,writing=false){const live=access.current;if(!visible(n)||!live.admin||writing&&(live.readOnly||live.externalWriteBlocked))throw Error('Kontekst lub możliwość zapisu zmieniły się.');const me=await api('/auth/me');const now=access.current;if(!visible(n)||!now.admin||me.user?.id!==p.userId||me.user?.tenant_id!==p.tenantId||me.user?.role!=='admin'||writing&&(now.readOnly||now.externalWriteBlocked||me.restore_preview))throw Error('Wymagana aktualna własna sesja administratora.');}
 async function tab<T,>(work:()=>Promise<T>){if(!navigator.locks?.request)throw Error('Brak blokady kart. Dostępny jest wyłącznie odczyt przez zwykłe API.');return navigator.locks.request(storage,{mode:'exclusive'},work);}
 async function operate(work:(n:number)=>Promise<void>){if(!loaded||flight.current!==null)return;const n=epoch.current;flight.current=n;setBusy(true);setError('');try{await tab(()=>work(n));}catch(e){if(visible(n))setError(e instanceof Error?e.message:'Wynik niepewny. Odczytaj bez ponawiania.');}finally{if(flight.current===n){flight.current=null;if(visible(n))setBusy(false);}}}
 const url='/integrations/'+p.channelId+'/local-woo-flow/current-sync';
 async function get(n:number,saved:SyncAttempt|null){await same(n);const head=parseCurrentWooRead(await api(url),p.productId,p.channelId);await same(n);if(!saved)return head;
  const full=parseCurrentWooRead(await api(url+'/'+saved.request_id),p.productId,p.channelId,saved);await same(n);if(!full.request)throw Error('Brak pierwotnego wyniku. Zachowaj klucz bez ponawiania.');return full;
 }
 function held(n:number,original:SyncAttempt){if(!visible(n)||!equal(load(),original))throw Error('Pierwotna próba lub aktor zmienili się.');}
 function unknown(n:number,original:SyncAttempt){try{held(n,original);const next={...original,stage:'unknown' as const};save(next);setA(next);}catch{/* A storage failure leaves the durable sent fence intact. */}}
 async function read(){await operate(async n=>{let saved=load();let f=await get(n,saved);
  if(!saved&&f.pending_preview){saved={v:1,context,product:p.productId,channel:p.channelId,request_id:f.pending_preview.request_id,sent_kind:'preview',stage:'unknown',predecessor:f.predecessor};if(!visible(n))throw Error('Widok zmienił się.');save(saved);setA(saved);f=await get(n,saved);}
  if(!visible(n))throw Error('Widok zmienił się.');if(saved){held(n,saved);const next=mergeCurrentWooAttempt(saved,f);save(next);setA(next);}setData(f);
 });}
 async function preview(){await operate(async n=>{await same(n,true);const previous=load(),f=await get(n,previous);if(!canPreviewCurrentWoo(previous,f))throw Error('Pierwotna próba wymaga odczytu. Nowy klucz jej nie omija.');await same(n,true);if(!equal(load(),previous))throw Error('Zachowana próba zmieniła się.');
  const sent:SyncAttempt={v:1,context,product:p.productId,channel:p.channelId,request_id:crypto.randomUUID(),sent_kind:'preview',stage:'sent',predecessor:f.predecessor};save(sent);setA(sent);setData(null);
  try{const value=parseCurrentWooRead(await api(url+'/previews','POST',{request_id:sent.request_id}),p.productId,p.channelId,sent);await same(n,true);held(n,sent);if(value.request?.state!=='preview')throw Error('Brak potwierdzonego podglądu. Nie ponawiaj.');const next=mergeCurrentWooAttempt(sent,value);save(next);setA(next);setData(value);}catch(first){unknown(n,sent);throw first;}
 });}
 async function queue(){await operate(async n=>{await same(n,true);const saved=load();if(!saved||saved.sent_kind!=='preview'||saved.stage!=='preview'||!saved.plan_id)throw Error('Najpierw odczytaj dokładny nowy podgląd.');const f=await get(n,saved);if(f.request?.state!=='preview'||!f.request.can_queue)throw Error('Podgląd nie pozwala na zapis. Odczytaj pierwotny wynik.');await same(n,true);held(n,saved);
  const sent:SyncAttempt={...saved,sent_kind:'queue',stage:'sent'};save(sent);setA(sent);setData(null);
  try{const value=parseCurrentWooRead(await api(url+'/queue','POST',{request_id:sent.request_id,plan_id:sent.plan_id,predecessor:sent.predecessor}),p.productId,p.channelId,sent);await same(n,true);held(n,sent);if(value.request?.state!=='acknowledged')throw Error('Brak potwierdzenia zakończenia. Odczytaj oryginał.');const next=mergeCurrentWooAttempt(sent,value);save(next);setA(next);setData(value);}catch(first){unknown(n,sent);throw first;}
 });}
 const writable=loaded&&!busy&&p.admin&&!p.readOnly&&!p.externalWriteBlocked;
 const pricePLN=(grosze:number)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:'PLN'}).format(grosze/100);
 const latestStatus=(s:SyncFact['state'])=>s==='acknowledged'?'Zakończono synchronizację':s==='failed_before_write'?'Nie zapisano oferty':'Wymaga odczytu wyniku';
 const status=(s:SyncRequest['state'])=>s==='acknowledged'?'potwierdzono lokalny zapis':s==='failed_before_write'?'zakończono przed zapisem oferty':s==='failed_before_queue'?'podgląd zakończono przed kolejką':s==='preview'?'podgląd oczekuje na zatwierdzenie':'wynik w toku lub niepewny — tylko odczyt';
 return <section className="catalog-section"><h4>Bieżąca synchronizacja ceny i stanu DEMO</h4><p>Przygotuj podgląd bieżących danych produktu, sprawdź cenę i stan, a następnie osobno zatwierdź zapis. Kolejny podgląd wymaga znanego zakończenia poprzedniej próby.</p>
 <div className="ops-buttons"><button type="button" className="button" disabled={!loaded||busy||!p.admin} onClick={()=>void read()}>Odczytaj bieżące i zachowane wyniki</button><button type="button" className="button" disabled={!writable||!canPreviewCurrentWoo(a,data)} onClick={()=>void preview()}>Przygotuj nowy podgląd ceny i stanu</button><button type="button" className="button" disabled={!writable||a?.sent_kind!=='preview'||a.stage!=='preview'||data?.request?.state!=='preview'||!data.request.can_queue} onClick={()=>void queue()}>Zatwierdź synchronizację z podglądu</button></div>
 {data?.current&&<p role="status">{latestStatus(data.current.state)} · lokalna symulacja.</p>}
 {data?.request&&<p role="status">{'desired' in data.request&&<>Podgląd: {pricePLN(data.request.desired.price)} · stan {data.request.desired.stock}. </>}{status(data.request.state)}</p>}
 {(a?.stage==='sent'||a?.stage==='unknown'||data?.current?.state==='unsettled'||data?.pending_preview)&&<p className="notice" role="status">Nie ponawiaj wysłanej próby. Odczyt korzysta wyłącznie z jej oryginalnego klucza; brak wyniku nie odblokuje nowego zapisu.</p>}
 {a&&<details><summary>Pierwotna próba synchronizacji</summary><p>Żądanie {a.request_id} · plan {a.plan_id??'oczekuje na odczyt'} · zadanie {a.job_id??'brak potwierdzonego ID'}.</p></details>}
 {data?.history.length!==undefined&&data.history.length>0&&<details><summary>Historia synchronizacji</summary><ul>{data.history.map(h=><li key={h.request_id}>Próba {h.sequence}: {pricePLN(h.desired.price)} · stan {h.desired.stock} · żądanie {h.request_id} · zadanie {h.job_id}</li>)}</ul></details>}
 {error&&<p className="notice error" role="alert">{error}</p>}<p>Wyłącznie lokalna symulacja. Nie potwierdza synchronizacji z prawdziwym WooCommerce.</p></section>;
}
