import {LocalWooOrderImport} from './local-woo-order-import';
import {LocalWooReadLanes} from './local-woo-read-lanes';
import {LocalWooStockReconcile} from './local-woo-stock-reconcile';
import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from './api';
import {isLocalWooOrigin,MAX_LOCAL_WOO_STORES} from '../shared/local-woo-origins';
export type LocalWooContext={tenantId:string;userId:string;admin:boolean;readOnly:boolean;externalWriteBlocked?:boolean};
type Channel={scope:'local_https_fixture';provider_verified:false;fixture_id:string;channel_id:string;origin:string;provider:'woocommerce';mode:'sandbox';status:string;enrolled:boolean;name:string|null};
type JobCut={scope:'local_https_fixture';channel_id:string;observational_only?:boolean;job:{id:string;kind:string;state:string;attempts:number;max_attempts:number;lease_active:boolean};plan:null|{id:string;state:string;phase:string};once_intent_recorded:boolean};
type Marker={v:1;context:string;subject:string;phase:'sent'|'unknown'|'acknowledged';name?:string;job_id?:string};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const base='/local-fixtures/woocommerce/channels';
const identity=(p:LocalWooContext)=>p.tenantId+':'+p.userId;
const markerKey=(context:string,subject:string)=>'dyna:configured-woo:v1:'+context+':'+subject;
export function readWooMarker(raw:string|null,context:string,subject:string):Marker|null{
 if(raw===null)return null;const m=JSON.parse(raw);
 if(!m||m.v!==1||m.context!==context||m.subject!==subject||!['sent','unknown','acknowledged'].includes(m.phase)||(m.name!==undefined&&(typeof m.name!=='string'||m.name.length<2||m.name.length>120))||(m.job_id!==undefined&&!uuid(m.job_id))||Object.keys(m).some(k=>!['v','context','subject','phase','name','job_id'].includes(k)))throw Error('Niepełny zapis wcześniejszej próby. Zachowaj dane i odczytaj wynik bez ponawiania.');
 return m;
}
function channelSummary(v:any,expected?:Pick<Channel,'channel_id'|'fixture_id'|'origin'>){
 if(!v||v.scope!=='local_https_fixture'||v.provider_verified!==false||!uuid(v.fixture_id)||!uuid(v.channel_id)||!isLocalWooOrigin(v.origin)||v.provider!=='woocommerce'||v.mode!=='sandbox'||typeof v.status!=='string'||!v.status||v.status.length>80||expected&&['channel_id','fixture_id','origin'].some(k=>v[k]!==expected[k as keyof typeof expected]))throw Error('Niepotwierdzony własny lokalny sklep Woo.');
 return v;
}
export function readConfiguredWooList(v:any):Channel[]{
 if(!v||v.scope!=='local_https_fixture'||v.provider_verified!==false||!Array.isArray(v.data)||v.data.length>MAX_LOCAL_WOO_STORES)throw Error('Niepełna lista skonfigurowanych sklepów.');
 const channels=new Set(),fixtures=new Set(),origins=new Set();
 return v.data.map((x:any)=>{channelSummary(x);if(typeof x.enrolled!=='boolean'||x.enrolled&&(typeof x.name!=='string'||x.name.length<2||x.name.length>120)||!x.enrolled&&x.name!==null||channels.has(x.channel_id)||fixtures.has(x.fixture_id)||origins.has(x.origin))throw Error('Niezgodna lista własnych sklepów.');channels.add(x.channel_id);fixtures.add(x.fixture_id);origins.add(x.origin);return x;});
}
export function readLocalWooJob(v:any,channelId:string,jobId:string):JobCut{
 if(!v||v.observational_only!==undefined&&typeof v.observational_only!=='boolean'||v.observational_only===true&&v.job?.kind!=='offer.write'||v.scope!=='local_https_fixture'||v.channel_id!==channelId||v.job?.id!==jobId||!['offer.write','orders.sync','order.status.write','catalog.fetch'].includes(v.job.kind)||!['pending','running','done','failed'].includes(v.job.state)||!Number.isSafeInteger(v.job.attempts)||v.job.attempts<0||!Number.isSafeInteger(v.job.max_attempts)||v.job.max_attempts<1||v.job.attempts>v.job.max_attempts||typeof v.job.lease_active!=='boolean'||typeof v.once_intent_recorded!=='boolean'||v.plan!==null&&(!uuid(v.plan?.id)||typeof v.plan.state!=='string'||typeof v.plan.phase!=='string'))throw Error('Odczyt nie odpowiada własnemu zadaniu tego sklepu.');
 return v;
}
export function freshLocalWooJob(cut:JobCut){
 return cut.observational_only!==true&&cut.job.state==='pending'&&cut.job.attempts===0&&!cut.job.lease_active&&!cut.once_intent_recorded&&
  (cut.job.kind==='orders.sync'?cut.plan===null:cut.plan?.state==='queued'&&cut.plan.phase===(cut.job.kind==='catalog.fetch'?'products':'ready'));
}
export function freshLocalWooObservation(cut:JobCut){return cut.observational_only===true&&cut.job.kind==='offer.write'&&cut.job.state==='pending'&&cut.job.attempts===0&&!cut.job.lease_active&&!cut.once_intent_recorded&&cut.plan?.state==='queued'&&['verify','write_started'].includes(cut.plan.phase);}
async function tabLock<T>(key:string,work:()=>Promise<T>){
 if(!navigator.locks?.request)throw Error('Ta przeglądarka nie zapewnia blokady kart. Odczyt jest dostępny; zapis wymaga obsługi blokady kart.');
 return navigator.locks.request(key,{mode:'exclusive'},work);
}
function useOwned(p:LocalWooContext,subject:string){
 const scope=identity(p)+':'+p.admin+':'+p.readOnly+':'+!!p.externalWriteBlocked+':'+subject,live=useRef(scope),alive=useRef(true),epoch=useRef(0),flight=useRef(false);live.current=scope;
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 useEffect(()=>{epoch.current++;flight.current=false;setBusy(false);setError('');},[scope]);
 const current=(e:number)=>alive.current&&epoch.current===e&&live.current===scope;
 async function actor(e:number,write=false){
  if(!current(e)||!p.admin||write&&(p.readOnly||p.externalWriteBlocked))throw Error('Widok lub uprawnienia zmieniły się.');
  const me=await api('/auth/me');if(!current(e)||me.user?.tenant_id!==p.tenantId||me.user?.id!==p.userId||me.user?.role!=='admin'||me.user.api_key_id!=null||write&&me.restore_preview)throw Error('Wymagana aktualna własna sesja administratora.');
 }
 async function work(fn:(e:number)=>Promise<void>){if(flight.current)return;const e=epoch.current;flight.current=true;setBusy(true);setError('');try{await fn(e);}catch(err){if(current(e))setError(err instanceof Error?err.message:'Nie potwierdzono wyniku.');}finally{if(current(e)){flight.current=false;setBusy(false);}}}
 return{scope,epoch,current,actor,work,busy,error,setError};
}
export function ConfiguredWooStores(p:LocalWooContext&{refresh:number;onChanged:()=>void;onOpenOffers:(id:string)=>void;onOpenOrders:(id:string)=>void;onOpenSync:(id:string)=>void}){
 const o=useOwned(p,'stores'),[page,setPage]=useState<{scope:string;rows:Channel[]}|null>(null),[names,setNames]=useState<Record<string,string>>({}),[unavailable,setUnavailable]=useState(false),[remembered,setRemembered]=useState<Record<string,Marker|null>>({});
 const rows=page?.scope===o.scope?page.rows:[],context=identity(p);
 async function read(){await o.work(async e=>{
  setPage(null);setUnavailable(false);await o.actor(e);
  try{const values=readConfiguredWooList(await api(base));if(!o.current(e))return;const markers:Record<string,Marker|null>={};for(const ch of values)markers[ch.channel_id]=readWooMarker(window.localStorage.getItem(markerKey(context,ch.channel_id)),context,ch.channel_id);setRemembered(markers);setPage({scope:o.scope,rows:values});}
  catch(error){if(error instanceof ApiError&&error.status===404){if(o.current(e))setUnavailable(true);return;}throw error;}
 });}
 useEffect(()=>{setPage(null);setNames({});setRemembered({});setUnavailable(false);if(p.admin)void read();},[o.scope,p.refresh]);
 async function enroll(ch:Channel){await o.work(async e=>tabLock(markerKey(context,ch.channel_id),async()=>{
  await o.actor(e,true);const key=markerKey(context,ch.channel_id);if(readWooMarker(window.localStorage.getItem(key),context,ch.channel_id))throw Error('Ta próba została już wysłana. Odczytaj listę sklepów; nie ponawiaj podłączenia.');
  const name=(names[ch.channel_id]??'').trim();if(name.length<2||name.length>120)throw Error('Nazwa sklepu wymaga od 2 do 120 znaków.');
  const current=readConfiguredWooList(await api(base)).find(x=>x.channel_id===ch.channel_id);if(!current||current.enrolled)throw Error('Kanał już istnieje lub konfiguracja zmieniła się. Odczytaj listę.');channelSummary(current,ch);await o.actor(e,true);
  const sent:Marker={v:1,context,subject:ch.channel_id,name,phase:'sent'};window.localStorage.setItem(key,JSON.stringify(sent));if(o.current(e))setRemembered(v=>({...v,[ch.channel_id]:sent}));
  try{const ack=channelSummary(await api(base+'/'+ch.channel_id,'POST',{name}),ch);if(!o.current(e))return;const confirmed:Marker={...sent,phase:'acknowledged'};window.localStorage.setItem(key,JSON.stringify(confirmed));setRemembered(v=>({...v,[ch.channel_id]:confirmed}));setPage(v=>v?.scope===o.scope?{...v,rows:v.rows.map(row=>row.channel_id===ch.channel_id?{...row,...ack,enrolled:true,name}:row)}:v);p.onChanged();}
  catch(error){const unknown:Marker={...sent,phase:'unknown'};try{window.localStorage.setItem(key,JSON.stringify(unknown));}catch{}if(o.current(e))setRemembered(v=>({...v,[ch.channel_id]:unknown}));throw error;}
 }));}
 if(!p.admin)return <p>Dostęp do skonfigurowanych lokalnych sklepów ma ich administrator.</p>;
 return <section className="panel"><div className="panel-heading"><div><h2>Lokalne sklepy WooCommerce</h2><p>Własne oficjalne sklepy przez lokalne HTTPS. Oferty i zamówienia korzystają z API tych sklepów; odbiór konta zewnętrznego sprzedawcy pozostaje osobnym zakresem.</p></div><button className="button" disabled={o.busy} onClick={()=>void read()}>Odśwież sklepy</button></div>
  {unavailable&&<p role="status">Skonfigurowane sklepy lokalne nie są dostępne w tym uruchomieniu. Administrator konfiguruje je podczas startu aplikacji.</p>}
  {o.busy&&<p role="status">Odczytywanie lub podłączanie sklepu…</p>}{o.error&&<p role="alert">{o.error}</p>}
  {page?.scope===o.scope&&!rows.length&&<p>Brak własnych sklepów skonfigurowanych dla tego administratora.</p>}
  {rows.map(ch=><article key={ch.channel_id} className="info-body"><h3>{ch.name??'Niepodłączony sklep'}</h3><p>{ch.origin} · {ch.enrolled?'Podłączony':'Gotowy do podłączenia'} · lokalny Woo/API</p>
   {!ch.enrolled&&<><label>Nazwa sklepu<input aria-label={'Nazwa sklepu '+ch.origin} maxLength={120} value={names[ch.channel_id]??''} disabled={o.busy||!!remembered[ch.channel_id]||p.readOnly||p.externalWriteBlocked} onChange={e=>setNames(v=>({...v,[ch.channel_id]:e.target.value}))}/></label><button className="button" disabled={o.busy||!!remembered[ch.channel_id]||p.readOnly||p.externalWriteBlocked||(names[ch.channel_id]??'').trim().length<2} onClick={()=>void enroll(ch)}>Podłącz sklep</button></>}
   {remembered[ch.channel_id]&&!ch.enrolled&&<p role="status">Wysłano wcześniejszą próbę. Odczytaj listę sklepów, aby ustalić wynik bez ponawiania POST.</p>}
   {ch.enrolled&&<LocalWooOrderImport key={context+':import:'+ch.channel_id} {...p} channelId={ch.channel_id}/>}
   {ch.enrolled&&<LocalWooReadLanes key={context+':'+ch.channel_id} {...p} channelId={ch.channel_id}/>}
   {ch.enrolled&&<LocalWooStockReconcile key={context+':stock:'+ch.channel_id} {...p} channelId={ch.channel_id}/>}
   {ch.enrolled&&<div className="inline-actions"><button className="button" disabled={o.busy} onClick={()=>p.onOpenOffers(ch.channel_id)}>Oferty, ceny i stany</button><button className="button" disabled={o.busy} onClick={()=>p.onOpenSync(ch.channel_id)}>Pobieranie i zadania</button><button className="button" disabled={o.busy} onClick={()=>p.onOpenOrders(ch.channel_id)}>Kolejka importu zamówień</button></div>}
  </article>)}
 </section>;
}
export function LocalWooJobControl(p:LocalWooContext&{channelId:string;jobId:string;onChanged?:()=>void}){
 const o=useOwned(p,p.channelId+':'+p.jobId),[cut,setCut]=useState<{scope:string;value:JobCut}|null>(null),[marker,setMarker]=useState<Marker|null>(null),context=identity(p),subject=p.channelId+':'+p.jobId,key=markerKey(context,subject),value=cut?.scope===o.scope?cut.value:null;
 const route=base+'/'+p.channelId+'/jobs/'+p.jobId;
 useEffect(()=>{setCut(null);setMarker(null);try{if(!uuid(p.channelId)||!uuid(p.jobId))throw Error('Niepełna tożsamość zadania.');setMarker(readWooMarker(window.localStorage.getItem(key),context,subject));}catch(e){o.setError((e as Error).message);}},[o.scope]);
 async function get(e:number){await o.actor(e);const v=readLocalWooJob(await api(route),p.channelId,p.jobId);if(!o.current(e))throw Error('Widok zmienił się.');setCut({scope:o.scope,value:v});return v;}
 async function run(observation=false){await o.work(async e=>tabLock(key,async()=>{
  await o.actor(e,true);if(readWooMarker(window.localStorage.getItem(key),context,subject))throw Error('Wykonanie zostało już wysłane. Dostępny jest wyłącznie odczyt oryginalnego wyniku.');
  const fresh=await get(e);if(!(observation?freshLocalWooObservation(fresh):freshLocalWooJob(fresh)))throw Error('Zadanie nie jest nową, nierozpoczętą próbą. Nie ponawiaj wykonania.');await o.actor(e,true);
  const sent:Marker={v:1,context,subject,phase:'sent'};window.localStorage.setItem(key,JSON.stringify(sent));setMarker(sent);
  try{const v=readLocalWooJob(await api(route+'/run-once','POST',{}),p.channelId,p.jobId);if(!o.current(e))return;if((v.observational_only===true)!==observation||!v.once_intent_recorded)throw Error('Brak potwierdzenia oryginalnej intencji wykonania.');const ack:Marker={...sent,phase:'acknowledged'};window.localStorage.setItem(key,JSON.stringify(ack));setMarker(ack);setCut({scope:o.scope,value:v});p.onChanged?.();}
  catch(error){const unknown:Marker={...sent,phase:'unknown'};try{window.localStorage.setItem(key,JSON.stringify(unknown));}catch{}if(o.current(e))setMarker(unknown);throw error;}
 }));}
 return <div className="ops-result"><button className="button small-btn" disabled={!p.admin||o.busy} onClick={()=>void o.work(async e=>{await get(e);})}>Odczytaj zadanie lokalnego Woo</button><button className="button small-btn" disabled={!p.admin||p.readOnly||p.externalWriteBlocked||o.busy||!!marker||!value||!freshLocalWooJob(value)} onClick={()=>void run()}>Wykonaj nowe zadanie raz</button>
  {value?.observational_only===true&&<button className="button small-btn" disabled={!p.admin||p.readOnly||p.externalWriteBlocked||o.busy||!!marker||!freshLocalWooObservation(value)} onClick={()=>void run(true)}>Uzgodnij wynik samym odczytem raz</button>}
  {value?.observational_only===true&&<p>Serwer potwierdził zadanie uzgodnienia obserwowanego stanu. Wykonanie pobiera stan istniejącej oferty bez ponawiania jej zapisu.</p>}
  {value&&<p role="status">{value.job.state==='done'?'Zakończone':value.job.state==='failed'?'Nieudane — wymaga ustalenia wyniku':value.job.state==='running'?'W trakcie':'Oczekujące'} · próby {value.job.attempts}/{value.job.max_attempts}{value.once_intent_recorded?' · wykonanie już wysłano':''}</p>}
  {marker&&value?.job.state!=='done'&&<p role="status">Wysłano próbę wykonania. Odświeżenie nie ponawia zapisu; odczytaj oryginalny wynik.</p>}{o.error&&<p role="alert">{o.error}</p>}
 </div>;
}

export function LocalWooOrderQueueButton(p:LocalWooContext&{channelId:string;onChanged:()=>void}){
 const o=useOwned(p,'queue:'+p.channelId),context=identity(p),subject='queue:'+p.channelId,key=markerKey(context,subject),[marker,setMarker]=useState<Marker|null>(null),[message,setMessage]=useState('');
 useEffect(()=>{setMarker(null);setMessage('');try{setMarker(readWooMarker(window.localStorage.getItem(key),context,subject));}catch(e){o.setError((e as Error).message);}},[o.scope]);
 async function queue(){await o.work(async e=>tabLock(key,async()=>{
  await o.actor(e,true);const previous=readWooMarker(window.localStorage.getItem(key),context,subject);
  if(previous){
   if(previous.phase!=='acknowledged'||!previous.job_id)throw Error('Niepotwierdzona wcześniejsza próba. Odczytaj istniejące zadania; nie twórz następnej kolejki.');
   const cut=readLocalWooJob(await api(base+'/'+p.channelId+'/jobs/'+previous.job_id),p.channelId,previous.job_id);
   if(cut.job.state!=='done'||cut.job.lease_active||!cut.once_intent_recorded)throw Error('Poprzedni odczyt nie został zakończony. Najpierw odczytaj lub wykonaj to zadanie.');
   window.localStorage.setItem(key+':previous:'+previous.job_id,JSON.stringify(previous));
  }
  await o.actor(e,true);const sent:Marker={v:1,context,subject,phase:'sent'};window.localStorage.setItem(key,JSON.stringify(sent));setMarker(sent);
  try{const ack=await api('/integrations/'+p.channelId+'/sync','POST',{});if(!uuid(ack.id)||typeof ack.reused!=='boolean')throw Error('Niepotwierdzona tożsamość zleconego odczytu.');if(!o.current(e))return;const confirmed:Marker={...sent,phase:'acknowledged',job_id:ack.id};window.localStorage.setItem(key,JSON.stringify(confirmed));setMarker(confirmed);setMessage(ack.reused?'Kanał ma już oczekujące zadanie. Odczytaj je poniżej.':'Zlecono nowe pobranie. Odczytaj zadanie poniżej, a następnie wykonaj je raz.');p.onChanged();}
  catch(error){const unknown:Marker={...sent,phase:'unknown'};try{window.localStorage.setItem(key,JSON.stringify(unknown));}catch{}if(o.current(e))setMarker(unknown);throw error;}
 }));}
 return <div><button className="button primary" disabled={!p.admin||p.readOnly||p.externalWriteBlocked||o.busy||marker?.phase==='sent'||marker?.phase==='unknown'} onClick={()=>void queue()}>Zleć pobranie zamówień lokalnego Woo</button>{message&&<p role="status">{message}</p>}{marker&&marker.phase!=='acknowledged'&&<p role="status">Wynik zlecenia jest niepewny. Odczyt listy zadań nie ponawia żądania.</p>}{o.error&&<p role="alert">{o.error}</p>}</div>;
}
