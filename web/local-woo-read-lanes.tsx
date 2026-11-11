import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from './api';
import type {LocalWooContext} from './configured-woo';
type Kind='orders.sync'|'catalog.fetch';
type Control={kind:Kind;version:string;enabled:boolean;interval_seconds:number;warehouse_id:string;next_at:string|null};
type Cursor={before_at:string;before_id:string};
type Occurrence={id:string;kind:Kind;state:'queued'|'running'|'done'|'blocked'|'aborted';scheduled_for:string;created_at_text:string};
type Cut={controls:Control[];history:{data:Occurrence[];next:Cursor|null};processor_running:boolean};
type Command={client_key:string;kind:Kind;expected_version:string;enabled:boolean;interval_seconds:number;warehouse_id:string};
type Marker={v:1;context:string;channel:string;body:Command;phase:'sent'|'unknown'|'acknowledged'|'cancelled'};
const kinds:Kind[]=['orders.sync','catalog.fetch'],label=(k:Kind)=>k==='orders.sync'?'Zamówienia':'Katalog produktów';
const uuid=(v:any):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v),positive=(v:any)=>typeof v==='string'&&/^[1-9]\d{0,14}$/.test(v),timestamp=(v:any)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const identity=(p:LocalWooContext)=>p.tenantId+':'+p.userId,storage=(context:string,channel:string,k:Kind)=>'dyna:local-woo-reads:v1:'+context+':'+channel+':'+k;
function cursor(v:any):Cursor|null{if(v===null)return null;if(!v||!uuid(v.before_id)||!timestamp(v.before_at)||Object.keys(v).sort().join(',')!=='before_at,before_id')throw Error('Niepełna strona historii.');return v;}
function occurrence(v:any,p:LocalWooContext,channel:string):Occurrence{
 if(!v||!uuid(v.id)||v.tenant_id!==p.tenantId||v.channel_id!==channel||v.owner_id!==p.userId||!kinds.includes(v.kind)||!['queued','running','done','blocked','aborted'].includes(v.state)||v.state==='aborted'&&v.kind!=='orders.sync'||!positive(String(v.control_version))||!positive(String(v.authorized_version))||!timestamp(v.scheduled_for)||!timestamp(v.created_at_text))throw Error('Niepotwierdzona historia tego sklepu.');return v;
}
export function readLocalWooReadLanes(v:any,p:LocalWooContext,channel:string):Cut{
 if(v?.scope!=='selected_local_reads'||v.provider_verified!==false||v.automatic_retry!==false||typeof v.processor_running!=='boolean'||!Array.isArray(v.controls)||v.controls.length>2||!Array.isArray(v.history?.data)||v.history.data.length>25)throw Error('Niepotwierdzona konfiguracja odczytów.');
 const seen=new Set();const controls=v.controls.map((c:any)=>{if(!c||c.tenant_id!==p.tenantId||c.channel_id!==channel||c.owner_id!==p.userId||!kinds.includes(c.kind)||seen.has(c.kind)||!positive(String(c.version))||typeof c.enabled!=='boolean'||!Number.isInteger(c.interval_seconds)||c.interval_seconds<60||c.interval_seconds>86400||!uuid(c.warehouse_id)||!(c.next_at===null||timestamp(c.next_at))||c.enabled&&c.next_at===null)throw Error('Niepotwierdzona konfiguracja odczytów.');seen.add(c.kind);return c;});
 const rows=v.history.data.map((o:any)=>occurrence(o,p,channel));if(new Set(rows.map((o:any)=>o.id)).size!==rows.length)throw Error('Powtórzona pozycja historii.');return{controls,history:{data:rows,next:cursor(v.history.next)},processor_running:v.processor_running};
}
export function readLocalWooReadMarker(raw:string|null,context:string,channel:string,k:Kind):Marker|null{
 if(raw===null)return null;if(raw.length>4096)throw Error('Zachowaj wcześniejszą próbę i odczytaj status bez ponawiania.');const m=JSON.parse(raw),b=m?.body;
 if(!m||m.v!==1||m.context!==context||m.channel!==channel||!['sent','unknown','acknowledged','cancelled'].includes(m.phase)||Object.keys(m).sort().join(',')!=='body,channel,context,phase,v'||!b||b.kind!==k||!uuid(b.client_key)||typeof b.enabled!=='boolean'||typeof b.expected_version!=='string'||!/^(0|[1-9]\d{0,14})$/.test(b.expected_version)||!uuid(b.warehouse_id)||!Number.isInteger(b.interval_seconds)||b.interval_seconds<60||b.interval_seconds>86400||Object.keys(b).sort().join(',')!=='client_key,enabled,expected_version,interval_seconds,kind,warehouse_id')throw Error('Zachowaj wcześniejszą próbę i odczytaj status bez ponawiania.');return m;
}
const terminal=(m:Marker)=>m.phase==='acknowledged'||m.phase==='cancelled';
const sameCommand=(left:Command,right:Command)=>Object.keys(left).sort().join(',')===Object.keys(right).sort().join(',')&&Object.entries(left).every(([k,v])=>right[k as keyof Command]===v);
export function readLocalWooReadCommandAck(ack:any,body:Command,channel:string):'acknowledged'|'cancelled'{
 if(!ack||ack.channel_id!==channel||ack.kind!==body.kind||typeof ack.version!=='string'||ack.automatic_retry!==false)throw Error('Nie potwierdzono wyniku polecenia.');
 if(ack.status==='LOCAL_WOO_READ_CONFIGURATION_ACKNOWLEDGED'&&ack.version===String(BigInt(body.expected_version)+1n)&&ack.enabled===body.enabled)return 'acknowledged';
 if(ack.status==='LOCAL_WOO_READ_COMMAND_CANCELLED'&&ack.client_key===body.client_key&&ack.version===(body.expected_version==='0'?'1':body.expected_version)&&typeof ack.enabled==='boolean'&&Object.keys(ack).sort().join(',')==='automatic_retry,channel_id,client_key,enabled,kind,status,version')return 'cancelled';
 throw Error('Nie potwierdzono wyniku polecenia.');
}
const failurePhases={eligibility:'Sprawdzanie terminu odczytu',claim:'Rozpoczynanie wykonania',processor:'Przetwarzanie odczytu',credentials:'Sprawdzanie dostępu do sklepu',provider_read:'Odczyt ze sklepu',stage:'Zapisywanie pobranych danych',completion:'Potwierdzanie zakończenia'};
type FailureDiagnostic={status:'NO_RETAINED_CAUSE';occurrence_id:string;automatic_retry:false}|{status:'RETAINED_FAILURE';occurrence_id:string;automatic_retry:false;phase:keyof typeof failurePhases;detected_at:string;job_id:string|null;dispatch_id:string|null;error_category:'POSTGRES'|'HTTP'|'ERROR'|'THROWN_VALUE';sqlstate:string|null;http_status:number|null;error_fingerprint:string;source:'memory'|'audit'};
export function readLocalWooReadFailureDiagnostic(v:any,o:any):FailureDiagnostic{
 if(!v||v.occurrence_id!==o.id||v.automatic_retry!==false)throw Error('Niepotwierdzona diagnostyka odczytu.');
 if(v.status==='NO_RETAINED_CAUSE'&&Object.keys(v).sort().join(',')==='automatic_retry,occurrence_id,status')return v;
 if(v.status!=='RETAINED_FAILURE'||Object.keys(v).sort().join(',')!=='automatic_retry,detected_at,dispatch_id,error_category,error_fingerprint,http_status,job_id,occurrence_id,phase,source,sqlstate,status'||!Object.hasOwn(failurePhases,v.phase)||!timestamp(v.detected_at)||!(v.job_id===null||uuid(v.job_id)&&v.job_id===o.job_id)||!(v.dispatch_id===null||uuid(v.dispatch_id))||!['POSTGRES','HTTP','ERROR','THROWN_VALUE'].includes(v.error_category)||!(v.sqlstate===null||typeof v.sqlstate==='string'&&/^[A-Z0-9]{5}$/.test(v.sqlstate))||!(v.http_status===null||Number.isInteger(v.http_status)&&v.http_status>=400&&v.http_status<=599)||typeof v.error_fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(v.error_fingerprint)||!['memory','audit'].includes(v.source))throw Error('Niepotwierdzona diagnostyka odczytu.');
 if(v.error_category==='POSTGRES'?(v.sqlstate===null||v.http_status!==null):v.error_category==='HTTP'?(v.http_status===null||v.sqlstate!==null):v.sqlstate!==null||v.http_status!==null)throw Error('Niepotwierdzona diagnostyka odczytu.');
 return v;
}
function failureReason(d:Extract<FailureDiagnostic,{status:'RETAINED_FAILURE'}>){
 if(d.error_category==='POSTGRES')return d.sqlstate==='57014'?'Zapytanie do bazy zostało przerwane.':'Nie udało się zakończyć operacji w bazie danych.';
 if(d.error_category==='HTTP')return 'Operacja została odrzucona lub nie potwierdzono odpowiedzi.';
 return 'Wykonanie przerwano bez rozpoznanego kodu błędu.';
}
type AbortBody={client_key:string;expected_snapshot_sha256:string;confirmed:true};
type AbortPreview={status:'LOCAL_WOO_READ_ABORT_PREVIEW';channel_id:string;occurrence_id:string;kind:'orders.sync';control_version:string;job_id:string;dispatch_id:string;expected_snapshot_sha256:string;original_outcome:'UNCONFIRMED';operation:'ABORT_WITHOUT_RETRY';automatic_retry:false};
type AbortMarker={v:1;context:string;channel:string;preview:AbortPreview;body:AbortBody;phase:'sent'|'unknown'|'acknowledged'};
const abortStorage=(context:string,channel:string)=>'dyna:local-woo-read-abort:v1:'+context+':'+channel+':orders.sync';
const digest=(v:any):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function readLocalWooReadAbortPreview(v:any,channel:string,id:string):AbortPreview{
 if(!v||Object.keys(v).sort().join(',')!=='automatic_retry,channel_id,control_version,dispatch_id,expected_snapshot_sha256,job_id,kind,occurrence_id,operation,original_outcome,status'||v.status!=='LOCAL_WOO_READ_ABORT_PREVIEW'||v.channel_id!==channel||v.occurrence_id!==id||!uuid(id)||v.kind!=='orders.sync'||!positive(v.control_version)||!uuid(v.job_id)||!uuid(v.dispatch_id)||!digest(v.expected_snapshot_sha256)||v.original_outcome!=='UNCONFIRMED'||v.operation!=='ABORT_WITHOUT_RETRY'||v.automatic_retry!==false)throw Error('Niepotwierdzony podgląd uzgodnienia.');return v;
}
export function readLocalWooReadAbortMarker(raw:string|null,context:string,channel:string):AbortMarker|null{
 if(raw===null)return null;if(raw.length>4096)throw Error('Zachowaj zapisane uzgodnienie i odczytaj jego wynik.');const m=JSON.parse(raw),b=m?.body;
 if(!m||m.v!==1||m.context!==context||m.channel!==channel||!['sent','unknown','acknowledged'].includes(m.phase)||Object.keys(m).sort().join(',')!=='body,channel,context,phase,preview,v'||!b||Object.keys(b).sort().join(',')!=='client_key,confirmed,expected_snapshot_sha256'||!uuid(b.client_key)||b.confirmed!==true||!digest(b.expected_snapshot_sha256))throw Error('Zachowaj zapisane uzgodnienie i odczytaj jego wynik.');
 readLocalWooReadAbortPreview(m.preview,channel,m.preview?.occurrence_id);if(m.preview.expected_snapshot_sha256!==b.expected_snapshot_sha256)throw Error('Niepotwierdzona tożsamość uzgodnienia.');return m;
}
export function readLocalWooReadAbortAck(v:any,m:AbortMarker){
 if(!v||Object.keys(v).sort().join(',')!=='automatic_retry,channel_id,client_key,control_version,dispatch_id,dispatch_state,enabled,expected_snapshot_sha256,job_id,job_state,kind,occurrence_id,occurrence_state,original_outcome,status'||v.status!=='LOCAL_WOO_READ_ATTEMPT_ABORTED'||v.channel_id!==m.channel||v.occurrence_id!==m.preview.occurrence_id||v.kind!=='orders.sync'||v.job_id!==m.preview.job_id||v.dispatch_id!==m.preview.dispatch_id||v.client_key!==m.body.client_key||v.expected_snapshot_sha256!==m.body.expected_snapshot_sha256||v.control_version!==m.preview.control_version||v.enabled!==false||v.job_state!=='failed'||v.occurrence_state!=='aborted'||v.dispatch_state!=='started'||v.original_outcome!=='UNCONFIRMED'||v.automatic_retry!==false)throw Error('Nie potwierdzono zakończenia próby.');return v;
}
const sameAbort=(a:AbortBody,b:any)=>!!b&&Object.keys(b).sort().join(',')==='client_key,confirmed,expected_snapshot_sha256'&&a.client_key===b.client_key&&a.confirmed===b.confirmed&&a.expected_snapshot_sha256===b.expected_snapshot_sha256;
export function LocalWooReadLanes(p:LocalWooContext&{channelId:string}){
 const context=identity(p),scope=context+':'+p.channelId+':'+p.admin+':'+p.readOnly+':'+!!p.externalWriteBlocked;
 const live=useRef(scope),epoch=useRef(0),alive=useRef(true),flight=useRef(false);live.current=scope;
 const[cut,setCut]=useState<{scope:string;value:Cut}|null>(null),[warehouses,setWarehouses]=useState<{id:string;name:string}[]>([]),[markers,setMarkers]=useState<Partial<Record<Kind,Marker|null>>>({}),[draft,setDraft]=useState<Partial<Record<Kind,{seconds:number;warehouse:string}>>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unavailable,setUnavailable]=useState(false),[detail,setDetail]=useState<any>(null),[abortMarker,setAbortMarker]=useState<AbortMarker|null>(null),[abortPreview,setAbortPreview]=useState<{scope:string;value:AbortPreview}|null>(null),[abortConfirmed,setAbortConfirmed]=useState(false);
 const value=cut?.scope===scope?cut.value:null,current=(e:number)=>alive.current&&epoch.current===e&&live.current===scope;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 async function actor(e:number,write=false){if(!current(e)||!p.admin||write&&(p.readOnly||p.externalWriteBlocked))throw Error('Widok lub uprawnienia zmieniły się.');const me=await api('/auth/me');if(!current(e)||me.user?.id!==p.userId||me.user.tenant_id!==p.tenantId||me.user.role!=='admin'||me.user.api_key_id!=null||write&&me.restore_preview)throw Error('Wymagana aktualna sesja administratora tej firmy.');}
 async function run(work:(e:number)=>Promise<void>){if(flight.current)return;flight.current=true;const e=epoch.current;setBusy(true);setError('');try{await work(e);}catch(err){if(current(e)){setError(err instanceof Error?err.message:'Nie potwierdzono wyniku.');}}finally{if(current(e)){flight.current=false;setBusy(false);}}}
 const base='/local-fixtures/woocommerce/channels/'+p.channelId+'/read-lanes';
 async function get(e:number,next:Cursor|null=null){await actor(e);const q=next?'?'+new URLSearchParams(next):'',v=readLocalWooReadLanes(await api(base+q),p,p.channelId);await actor(e);if(!current(e))throw Error('Widok zmienił się.');return v;}
 async function load(){await run(async e=>{setCut(null);setDetail(null);setAbortPreview(null);setAbortConfirmed(false);setUnavailable(false);await actor(e);
  let v:Cut;try{v=await get(e);}catch(err){if(err instanceof ApiError&&err.status===404){if(current(e))setUnavailable(true);return;}throw err;}
  const ws=await api('/warehouses');await actor(e);if(!Array.isArray(ws.data)||ws.data.some((w:any)=>!uuid(w.id)||typeof w.name!=='string')||new Set(ws.data.map((w:any)=>w.id)).size!==ws.data.length)throw Error('Niepotwierdzone magazyny tej firmy.');
  const remembered:Partial<Record<Kind,Marker|null>>={},next:Partial<Record<Kind,{seconds:number;warehouse:string}>>={};for(const k of kinds){remembered[k]=readLocalWooReadMarker(localStorage.getItem(storage(context,p.channelId,k)),context,p.channelId,k);const c=v.controls.find(c=>c.kind===k);next[k]={seconds:c?.interval_seconds??60,warehouse:c?.warehouse_id??ws.data[0]?.id??''};}
  if(current(e)){setMarkers(remembered);setAbortMarker(readLocalWooReadAbortMarker(localStorage.getItem(abortStorage(context,p.channelId)),context,p.channelId));setDraft(next);setWarehouses(ws.data);setCut({scope,value:v});}
 });}
 useEffect(()=>{epoch.current++;flight.current=false;setCut(null);setDetail(null);setAbortMarker(null);setAbortPreview(null);setAbortConfirmed(false);setMarkers({});setDraft({});setWarehouses([]);setBusy(false);setError('');setUnavailable(false);},[scope]);
 async function configure(k:Kind,enabled:boolean){await run(async e=>{
  const key=storage(context,p.channelId,k);if(!navigator.locks?.request)throw Error('Zapis wymaga przeglądarki obsługującej blokadę kart.');
  await navigator.locks.request(key,{mode:'exclusive'},async()=>{
   await actor(e,true);const pendingAbort=readLocalWooReadAbortMarker(localStorage.getItem(abortStorage(context,p.channelId)),context,p.channelId);if(k==='orders.sync'&&pendingAbort&&pendingAbort.phase!=='acknowledged'){if(current(e))setAbortMarker(pendingAbort);throw Error('Uzgodnienie ma niepewny wynik. Odczytaj wynik bez ponawiania.');}const previous=readLocalWooReadMarker(localStorage.getItem(key),context,p.channelId,k);if(previous&&!terminal(previous))throw Error('Wcześniejsze polecenie ma niepewny wynik. Odczytaj status; nie ponawiaj zapisu.');
   const fresh=await get(e),c=fresh.controls.find(c=>c.kind===k),d=draft[k];if(!d||!Number.isInteger(d.seconds)||d.seconds<60||d.seconds>86400||!warehouses.some(w=>w.id===d.warehouse))throw Error('Wybierz własny magazyn i odstęp od 60 do 86400 sekund.');
   if(enabled&&!fresh.processor_running)throw Error('Procesor automatycznych odczytów nie został uruchomiony.');
   // Pause always retains the source settings of the acknowledged configuration.
   const body:Command={client_key:crypto.randomUUID(),kind:k,expected_version:String(c?.version??0),enabled,interval_seconds:!enabled&&c?c.interval_seconds:d.seconds,warehouse_id:!enabled&&c?c.warehouse_id:d.warehouse};await actor(e,true);
   const sent:Marker={v:1,context,channel:p.channelId,body,phase:'sent'};if(previous)localStorage.setItem(key+':archive:'+previous.body.client_key,JSON.stringify(previous));localStorage.setItem(key,JSON.stringify(sent));if(current(e))setMarkers(v=>({...v,[k]:sent}));
   try{const phase=readLocalWooReadCommandAck(await api(base,'POST',body),body,p.channelId);
    // An ACK remains in the original principal's storage even when the screen changed.
    if(phase==='cancelled')localStorage.setItem(key+':archive:'+sent.body.client_key,JSON.stringify(sent));
    const confirmed:Marker={...sent,phase};localStorage.setItem(key,JSON.stringify(confirmed));if(!current(e))return;setMarkers(v=>({...v,[k]:confirmed}));const updated=await get(e);if(current(e))setCut({scope,value:updated});
   }catch(err){const last=readLocalWooReadMarker(localStorage.getItem(key),context,p.channelId,k);if(!last||!terminal(last)){const unknown:Marker={...sent,phase:'unknown'};localStorage.setItem(key,JSON.stringify(unknown));if(current(e))setMarkers(v=>({...v,[k]:unknown}));}throw err;}
  });
 });}
 async function observe(k:Kind){await run(async e=>{
  const key=storage(context,p.channelId,k);if(!navigator.locks?.request)throw Error('Odczyt wyniku wymaga przeglądarki obsługującej blokadę kart.');
  await navigator.locks.request(key,{mode:'exclusive'},async()=>{
  await actor(e);const marker=readLocalWooReadMarker(localStorage.getItem(key),context,p.channelId,k);if(!marker)throw Error('Nie ma niepotwierdzonego polecenia.');if(terminal(marker)){const updated=await get(e);if(current(e)){setMarkers(v=>({...v,[k]:marker}));setCut({scope,value:updated});}return;}
  const result=await api(base+'/commands/observe','POST',marker.body);await actor(e);
  const same=result?.command&&sameCommand(result.command,marker.body);
  if(!same||result.channel_id!==p.channelId||result.kind!==k||result.client_key!==marker.body.client_key||result.automatic_retry!==false)throw Error('Nie potwierdzono tożsamości wcześniejszego polecenia.');
  if(result.status==='COMMAND_RESULT_UNKNOWN'&&result.ack===null)throw Error('Brak zapisanego potwierdzenia tego polecenia. Wynik pozostaje nieznany; nie ponawiaj zapisu.');
  const phase=readLocalWooReadCommandAck(result.ack,marker.body,p.channelId);if(result.status!==(phase==='cancelled'?'COMMAND_RESULT_CANCELLED':'COMMAND_RESULT_ACKNOWLEDGED'))throw Error('Niepotwierdzony zapisany wynik polecenia.');
  const last=readLocalWooReadMarker(localStorage.getItem(key),context,p.channelId,k);if(!last||!sameCommand(last.body,marker.body))throw Error('W innej karcie zmieniono polecenie. Odczytaj status.');
  if(phase==='cancelled')localStorage.setItem(key+':archive:'+marker.body.client_key,JSON.stringify(marker));
  const confirmed:Marker={...marker,phase};localStorage.setItem(key,JSON.stringify(confirmed));if(current(e)){setMarkers(v=>({...v,[k]:confirmed}));const updated=await get(e);if(current(e))setCut({scope,value:updated});}
  });
 });}
 async function cancel(k:Kind){await run(async e=>{
  const key=storage(context,p.channelId,k);if(!navigator.locks?.request)throw Error('Anulowanie wymaga przeglądarki obsługującej blokadę kart.');
  await navigator.locks.request(key,{mode:'exclusive'},async()=>{
   await actor(e,true);const marker=readLocalWooReadMarker(localStorage.getItem(key),context,p.channelId,k);if(!marker)throw Error('Nie ma niepotwierdzonego polecenia.');
   if(terminal(marker)){const updated=await get(e);if(current(e)){setMarkers(v=>({...v,[k]:marker}));setCut({scope,value:updated});}return;}
   // The unchanged original command is the durable cancellation identity; never generate another key.
   const phase=readLocalWooReadCommandAck(await api(base+'/commands/cancel','POST',marker.body),marker.body,p.channelId);
   const last=readLocalWooReadMarker(localStorage.getItem(key),context,p.channelId,k);if(!last||!sameCommand(last.body,marker.body))throw Error('W innej karcie zmieniono polecenie. Odczytaj status.');
   localStorage.setItem(key+':archive:'+marker.body.client_key,JSON.stringify(marker));const confirmed:Marker={...marker,phase};localStorage.setItem(key,JSON.stringify(confirmed));
   if(current(e)){setMarkers(v=>({...v,[k]:confirmed}));const updated=await get(e);if(current(e))setCut({scope,value:updated});}
  });
 });}
 async function previewAbort(o:Occurrence){await run(async e=>{setAbortPreview(null);setAbortConfirmed(false);await actor(e);if(o.kind!=='orders.sync'||o.state!=='running')throw Error('Ta próba nie kwalifikuje się do uzgodnienia.');const v=readLocalWooReadAbortPreview(await api(base+'/occurrences/'+o.id+'/abort-preview'),p.channelId,o.id);await actor(e);if(current(e))setAbortPreview({scope,value:v});});}
 async function afterAbort(e:number,m:AbortMarker){if(!current(e))return;setAbortMarker(m);setAbortPreview(null);setAbortConfirmed(false);setDetail(null);const updated=await get(e);if(current(e))setCut({scope,value:updated});}
 async function abortAttempt(){await run(async e=>{
  if(!navigator.locks?.request)throw Error('Uzgodnienie wymaga przeglądarki obsługującej blokadę kart.');
  await navigator.locks.request(storage(context,p.channelId,'orders.sync'),{mode:'exclusive'},async()=>{
   await actor(e,true);const key=abortStorage(context,p.channelId),previous=readLocalWooReadAbortMarker(localStorage.getItem(key),context,p.channelId),config=readLocalWooReadMarker(localStorage.getItem(storage(context,p.channelId,'orders.sync')),context,p.channelId,'orders.sync');
   if(previous&&previous.phase!=='acknowledged'){if(current(e))setAbortMarker(previous);throw Error('Uzgodnienie ma niepewny wynik. Odczytaj wynik bez ponawiania.');}if(config&&!terminal(config))throw Error('Najpierw odczytaj wynik wcześniejszego polecenia ustawień.');
   if(!abortConfirmed||abortPreview?.scope!==scope)throw Error('Potwierdź zakończenie wybranej próby.');const preview=abortPreview.value,fresh=readLocalWooReadAbortPreview(await api(base+'/occurrences/'+preview.occurrence_id+'/abort-preview'),p.channelId,preview.occurrence_id);await actor(e,true);
   if(Object.keys(preview).some(k=>fresh[k as keyof AbortPreview]!==preview[k as keyof AbortPreview])){setAbortPreview(null);setAbortConfirmed(false);throw Error('Stan próby zmienił się. Odczytaj podgląd ponownie.');}
   const body:AbortBody={client_key:crypto.randomUUID(),expected_snapshot_sha256:preview.expected_snapshot_sha256,confirmed:true},sent:AbortMarker={v:1,context,channel:p.channelId,preview,body,phase:'sent'};
   if(previous)localStorage.setItem(key+':archive:'+previous.body.client_key,JSON.stringify(previous));localStorage.setItem(key,JSON.stringify(sent));if(current(e))setAbortMarker(sent);
   try{readLocalWooReadAbortAck(await api(base+'/occurrences/'+preview.occurrence_id+'/abort','POST',body),sent);const confirmed:AbortMarker={...sent,phase:'acknowledged'};localStorage.setItem(key,JSON.stringify(confirmed));await afterAbort(e,confirmed);}
   catch(err){const last=readLocalWooReadAbortMarker(localStorage.getItem(key),context,p.channelId);if(!last||last.phase!=='acknowledged'){const unknown:AbortMarker={...sent,phase:'unknown'};localStorage.setItem(key,JSON.stringify(unknown));if(current(e))setAbortMarker(unknown);}throw err;}
  });
 });}
 async function observeAbort(){await run(async e=>{
  if(!navigator.locks?.request)throw Error('Odczyt uzgodnienia wymaga przeglądarki obsługującej blokadę kart.');
  await navigator.locks.request(storage(context,p.channelId,'orders.sync'),{mode:'exclusive'},async()=>{
   await actor(e);const key=abortStorage(context,p.channelId),m=readLocalWooReadAbortMarker(localStorage.getItem(key),context,p.channelId);if(!m)throw Error('Brak zachowanego uzgodnienia.');if(m.phase==='acknowledged'){await afterAbort(e,m);return;}
   const result=await api(base+'/occurrences/'+m.preview.occurrence_id+'/abort/observe','POST',m.body);await actor(e);
   if(!result||Object.keys(result).sort().join(',')!=='ack,automatic_retry,channel_id,client_key,command,occurrence_id,status'||result.channel_id!==p.channelId||result.occurrence_id!==m.preview.occurrence_id||result.client_key!==m.body.client_key||result.automatic_retry!==false||!sameAbort(m.body,result.command))throw Error('Niepotwierdzona tożsamość uzgodnienia.');
   if(result.status==='ABORT_RESULT_UNKNOWN'&&result.ack===null)throw Error('Brak zapisanego potwierdzenia uzgodnienia. Wynik pozostaje nieznany; nie ponawiaj zapisu.');if(result.status!=='ABORT_RESULT_ACKNOWLEDGED')throw Error('Niepotwierdzony wynik uzgodnienia.');readLocalWooReadAbortAck(result.ack,m);
   const last=readLocalWooReadAbortMarker(localStorage.getItem(key),context,p.channelId);if(!last||!sameAbort(m.body,last.body))throw Error('W innej karcie zmieniono uzgodnienie.');const confirmed:AbortMarker={...m,phase:'acknowledged'};localStorage.setItem(key,JSON.stringify(confirmed));await afterAbort(e,confirmed);
  });
 });}
 async function older(){const next=value?.history.next;if(!next)return;await run(async e=>{const v=await get(e,next);if(current(e))setCut({scope,value:v});});}
 async function show(o:Occurrence,next:Cursor|null=null){await run(async e=>{setDetail(null);setAbortPreview(null);setAbortConfirmed(false);await actor(e);const d=await api(base+'/occurrences/'+o.id+(next?'?'+new URLSearchParams(next):''));await actor(e);occurrence(d.occurrence,p,p.channelId);if(d.scope!=='selected_local_reads'||d.provider_verified!==false||d.automatic_retry!==false||d.occurrence.id!==o.id||typeof d.reconciliation_required!=='boolean'||d.occurrence.state==='aborted'&&d.reconciliation_required||!Array.isArray(d.dispatches?.data)||d.dispatches.data.length>25)throw Error('Niepotwierdzone szczegóły odczytu.');for(const r of d.dispatches.data)if(!uuid(r.id)||r.occurrence_id!==o.id||!['started','acknowledged'].includes(r.state)||Object.hasOwn(r,'lease_token')||!/^[a-f0-9]{64}$/.test(r.before_hash)||!(r.after_hash===null||/^[a-f0-9]{64}$/.test(r.after_hash))||!timestamp(r.created_at_text))throw Error('Niepotwierdzona historia wykonania.');cursor(d.dispatches.next);const diagnostic=readLocalWooReadFailureDiagnostic(d.diagnostic,d.occurrence);if(current(e))setDetail({scope,value:{...d,diagnostic}});});}
 const shownDetail=detail?.scope===scope?detail.value:null,shownAbortPreview=abortPreview?.scope===scope?abortPreview.value:null,abortUnknown=!!abortMarker&&abortMarker.phase!=='acknowledged';
 const changed=!!value,blocked=busy||!p.admin||p.readOnly||!!p.externalWriteBlocked;
 if(!p.admin)return null;
 return <section aria-label="Automatyczne pobieranie sklepu" className="info-body"><h4>Automatyczne pobieranie</h4>
  <p>Pobieraj zamówienia do kolejki importu i katalog do przeglądu. Zatwierdzenie importu pozostaje osobną czynnością. Ta funkcja nie zmienia stanów ani cen w sklepie.</p>
  <button className="button" disabled={busy} onClick={()=>void load()}>Odczytaj ustawienia i historię</button>
  {unavailable&&<p role="status">Automatyczne odczyty nie są dostępne w tym uruchomieniu aplikacji.</p>}
  {value&&<p role="status">{value.processor_running?'Procesor odczytów działa.':'Procesor odczytów nie został uruchomiony.'}</p>}
  {changed&&kinds.map(k=>{const c=value.controls.find(c=>c.kind===k),d=draft[k],m=markers[k],unknown=m&&!terminal(m),reconciling=k==='orders.sync'&&abortUnknown;return <div key={k}><fieldset disabled={blocked}><legend>{label(k)}</legend><p>{c?.enabled?'Włączone':'Wstrzymane'}{c?.next_at?' · następny odczyt: '+new Date(c.next_at).toLocaleString('pl-PL'):''}</p>
   <label>Co ile sekund — {label(k)}<input aria-label={'Odstęp '+label(k)} type="number" min={60} max={86400} value={d?.seconds??60} disabled={busy||!!unknown||!!c?.enabled} onChange={e=>setDraft(v=>({...v,[k]:{seconds:Number(e.target.value),warehouse:v[k]?.warehouse??''}}))}/></label>
   <label>Magazyn — {label(k)}<select aria-label={'Magazyn '+label(k)} value={d?.warehouse??''} disabled={busy||!!unknown||!!c?.enabled} onChange={e=>setDraft(v=>({...v,[k]:{seconds:v[k]?.seconds??60,warehouse:e.target.value}}))}><option value="">Wybierz magazyn</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
   <button className="button" disabled={blocked||reconciling||!!unknown||!!c?.enabled||!value.processor_running||!d?.warehouse} onClick={()=>void configure(k,true)}>{c?'Wznów':'Włącz'} — {label(k)}</button>
   <button className="button" disabled={blocked||reconciling||!!unknown||!c?.enabled} onClick={()=>void configure(k,false)}>Wstrzymaj — {label(k)}</button>
   {unknown&&<p role="status">Wcześniejsze polecenie ma niepewny wynik. Zachowano jego dane. Odczytaj status bez ponawiania zapisu.</p>}
  </fieldset>{unknown&&<><button className="button" disabled={busy} onClick={()=>void observe(k)}>Odczytaj wynik — {label(k)}</button><button className="button" disabled={blocked} onClick={()=>void cancel(k)}>Anuluj niepotwierdzone polecenie — {label(k)}</button><p>Anulowanie nie cofa wcześniej potwierdzonych ustawień. Nie uruchamia ponownie polecenia.</p></>}{m?.phase==='cancelled'&&<p role="status">Nie wykonano polecenia; zachowano dotychczasowe ustawienia.</p>}</div>;})}
  {value&&<><p>Wstrzymanie zatrzymuje kolejne odczyty. Rozpoczęty odczyt może jeszcze kończyć pracę; wynik sprawdź w historii.</p><h5>Historia odczytów</h5>{!value.history.data.length&&<p>Brak zapisanych odczytów.</p>}{value.history.data.map(o=><p key={o.id}>{label(o.kind)} · {new Date(o.scheduled_for).toLocaleString('pl-PL')} · {{queued:'Oczekuje',running:'Rozpoczęty — sprawdź wynik',done:'Zakończony',blocked:'Wymaga uzgodnienia',aborted:'Zakończony administracyjnie — wynik pierwotny niepotwierdzony'}[o.state]} <button className="button" disabled={busy} onClick={()=>void show(o)}>Szczegóły odczytu</button></p>)}{value.history.next&&<button className="button" disabled={busy} onClick={()=>void older()}>Starsze odczyty</button>}</>}
  {value&&abortUnknown&&<p role="status">Uzgodnienie ma niepewny wynik. Zachowano jego dane; nie ponawiaj zakończenia próby. <button className="button" disabled={busy} onClick={()=>void observeAbort()}>Odczytaj wynik uzgodnienia</button></p>}
  {value&&abortMarker?.phase==='acknowledged'&&<p role="status">Próbę zakończono administracyjnie; pierwotnego wyniku nie potwierdzono. Wznowienie odczytów wymaga osobnej zgody.</p>}
  {shownAbortPreview&&<section aria-label="Potwierdzenie zakończenia próby"><p>Zakończenie dotyczy wyłącznie wybranej niepotwierdzonej próby zamówień. Nie ponowi odczytu ani nie cofnie wcześniej zapisanych danych. Ustawienia pozostaną wstrzymane.</p><label><input type="checkbox" aria-label="Potwierdzam zakończenie niepotwierdzonej próby" checked={abortConfirmed} disabled={blocked||abortUnknown} onChange={e=>setAbortConfirmed(e.target.checked)}/>Rozumiem, że pierwotnego wyniku nie potwierdzono.</label><button className="button" disabled={blocked||abortUnknown||!abortConfirmed} onClick={()=>void abortAttempt()}>Potwierdź zakończenie próby</button></section>}
  {shownDetail&&<section aria-label="Szczegóły automatycznego odczytu"><h5>Szczegóły odczytu</h5>{shownDetail.occurrence.state==='aborted'&&<p role="status">Próbę zakończono administracyjnie; pierwotnego wyniku nie potwierdzono.</p>}{shownDetail.occurrence.kind==='orders.sync'&&shownDetail.occurrence.state==='running'&&shownDetail.reconciliation_required&&<button className="button" disabled={busy||abortUnknown} onClick={()=>void previewAbort(shownDetail.occurrence)}>Zakończ niepotwierdzoną próbę</button>}{shownDetail.reconciliation_required&&<p role="status">Wynik wymaga uzgodnienia. Nie uruchamiaj tego odczytu ponownie.</p>}{shownDetail.diagnostic.status==='RETAINED_FAILURE'?<div aria-label="Zachowana diagnostyka odczytu"><p>Faza: {failurePhases[shownDetail.diagnostic.phase as keyof typeof failurePhases]}.</p><p>{failureReason(shownDetail.diagnostic)}{shownDetail.diagnostic.sqlstate?' Kod bazy: '+shownDetail.diagnostic.sqlstate+'.':''}{shownDetail.diagnostic.http_status?' Kod HTTP: '+shownDetail.diagnostic.http_status+'.':''}</p><p>Wykryto: {new Date(shownDetail.diagnostic.detected_at).toLocaleString('pl-PL')}.</p></div>:shownDetail.reconciliation_required&&<p role="status">Nie zachowano przyczyny tego niepotwierdzonego wykonania. Nie ponawiaj odczytu.</p>}{shownDetail.dispatches.data.map((r:any)=><p key={r.id}>{new Date(r.created_at_text).toLocaleString('pl-PL')} · {r.state==='acknowledged'?'Potwierdzono zakończenie etapu':'Rozpoczęto — brak potwierdzenia zakończenia'}</p>)}{shownDetail.dispatches.next&&<button className="button" disabled={busy} onClick={()=>void show(shownDetail.occurrence,shownDetail.dispatches.next)}>Starsze etapy odczytu</button>}</section>}
  {busy&&<p role="status">Trwa odczyt lub zapis ustawień…</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
