import {useEffect,useRef,useState} from 'react';
import {api,date} from './api';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=500;
function requireValue(ok:unknown){if(!ok)throw Error('Niepotwierdzona lista lokalnych połączeń automatyzacji.');}
export function readLocalEffectOptions(v:any,contextKey:string){
 const [tenant,user,...rest]=contextKey.split(':');requireValue(uuid(tenant)&&uuid(user)&&rest.length===0);
 requireValue(v&&Array.isArray(v.channels)&&v.channels.length<=2&&Array.isArray(v.smtp_channels)&&v.smtp_channels.length<=200&&Array.isArray(v.warehouses)&&v.warehouses.length<=200&&typeof v.listings_truncated==='boolean'&&typeof v.processor_running==='boolean');
 const ids=new Set<string>(),listings=new Set<string>(),fixtures=new Set<string>();let count=0;
 for(const c of [...v.warehouses,...v.smtp_channels]){requireValue(uuid(c.id)&&name(c.name)&&!ids.has(c.id));ids.add(c.id);}
 const warehouses=new Set(v.warehouses.map((w:any)=>w.id));
 for(const c of v.channels){requireValue(uuid(c.id)&&name(c.name)&&uuid(c.fixture_id)&&!fixtures.has(c.fixture_id)&&c.owner_id===user&&c.enrolled===true&&!ids.has(c.id)&&Array.isArray(c.listings));ids.add(c.id);fixtures.add(c.fixture_id);
  for(const l of c.listings){count++;requireValue(count<=500&&uuid(l.id)&&!listings.has(l.id)&&uuid(l.product_id)&&name(l.sku)&&warehouses.has(l.warehouse_id));listings.add(l.id);}
 }
 return v;
}
export function LocalWooStockActionFields(p:{contextKey:string;value:any;onChange:(v:any)=>void}){
 const [data,setData]=useState<{scope:string;value:any}|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),current=useRef(p.contextKey);current.current=p.contextKey;
 useEffect(()=>{let live=true;setData(null);setError('');const scope=p.contextKey;
  Promise.resolve().then(()=>api('/automations/local-effects/options')).then(v=>{const value=readLocalEffectOptions(v,scope);if(live&&current.current===scope)setData({scope,value});}).catch(e=>{if(live&&current.current===scope)setError(e.message);});return()=>{live=false;};
 },[p.contextKey,refresh]);
 const options=data?.scope===p.contextKey?data.value:null,channel=options?.channels.find((c:any)=>c.id===p.value.channel_id),listings=channel?.listings.filter((l:any)=>l.warehouse_id===p.value.warehouse_id)??[];
 const change=(extra:any)=>{const {channel_hash,...rest}=p.value;p.onChange({...rest,...extra});};
 return <div className="sms-action-fields">
  <select aria-label="Lokalny sklep akcji stanu" required disabled={!options} value={channel?p.value.channel_id:''} onChange={e=>change({channel_id:e.target.value,listing_id:undefined})}><option value="">Wybierz lokalny sklep Woo</option>{options?.channels.map((c:any)=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
  <select aria-label="Magazyn akcji stanu" required disabled={!options} value={options?.warehouses.some((w:any)=>w.id===p.value.warehouse_id)?p.value.warehouse_id:''} onChange={e=>change({warehouse_id:e.target.value,listing_id:undefined})}><option value="">Wybierz magazyn</option>{options?.warehouses.map((w:any)=><option key={w.id} value={w.id}>{w.name}</option>)}</select>
  <select aria-label="Oferta akcji stanu" disabled={!channel||!p.value.warehouse_id} value={listings.some((l:any)=>l.id===p.value.listing_id)?p.value.listing_id:''} onChange={e=>change({listing_id:e.target.value||undefined})}><option value="">Wszystkie powiązane pozycje zamówienia</option>{listings.map((l:any)=><option key={l.id} value={l.id}>{l.sku}</option>)}</select>
  <small>Synchronizacja samego stanu, bez ceny. Bez wskazania oferty obejmuje powiązane fizyczne pozycje zamówienia w tym magazynie (maksymalnie 200).</small>
  {p.value.channel_id&&!channel&&options&&<p role="alert">Zapisany sklep nie jest obecnie dostępny dla tego administratora. Wybierz bieżące połączenie.</p>}
  {p.value.listing_id&&!listings.some((l:any)=>l.id===p.value.listing_id)&&options&&<p role="alert">Zapisana oferta nie występuje na bieżącej liście. Wybierz ją ponownie; brak na liście nie zmienia zapisanej reguły.</p>}
  {options?.listings_truncated&&<p>Pokazano pierwsze 500 ofert. Zakres wszystkich powiązanych pozycji pozostaje dostępny.</p>}
  {options&&!options.processor_running&&<p>Procesor nie został uruchomiony. Zapisanie reguły nie uruchamia kolejki.</p>}
  {options&&!options.channels.length&&<p>Brak podłączonego lokalnego sklepu. Podłącz go w Integracje → Lokalne sklepy Woo.</p>}
  {error&&<p role="alert">{error}</p>}<button type="button" onClick={()=>setRefresh(n=>n+1)}>Odśwież połączenia akcji</button>
 </div>;
}
const outcomes:Record<string,string>={VERIFIED:'Stan Woo potwierdzony odczytem',PENDING:'Efekt oczekuje',FAILED_BEFORE_DISPATCH:'Błąd przed wysłaniem',ATTEMPTED_RECONCILIATION_REQUIRED:'Rozpoczęta próba wymaga uzgodnienia',UNKNOWN_WRITE_OR_ACK:'Wynik wysłania lub potwierdzenia jest niepewny',SMTP_ACCEPTED_NOT_DELIVERED:'SMTP przyjął wiadomość; doręczenie nie jest potwierdzone'};
const effectErrors:Record<string,string>={
 AUTOMATION_AUTHORITY_CHANGED:'Autor utracił uprawnienia albo reguła została wyłączona lub zmieniona. Nie ponawiaj starego zadania.',
 AUTOMATION_CHANNEL_CHANGED:'Połączenie sklepu zmieniło się. Odczytaj pierwotny plan i wynik.',
 AUTOMATION_STOCK_CHANGED:'Stan lub dane produktu zmieniły się podczas przygotowania. Odczytaj pierwotny plan; nowa operacja wymaga nowego zdarzenia.',
 AUTOMATION_EFFECT_FAILED:'Efekt reguły nie został potwierdzony. Odczytaj pierwotne zadanie i plan bez ponawiania.',
 AUTOMATION_EMAIL_FAILED:'Lokalny email nie został potwierdzony. Sprawdź odbiornik i źródłową regułę; brak automatycznego ponowienia.'
};
export function readAutomaticEffects(v:unknown):any[]{
 if(!Array.isArray(v)||v.length>1000)throw Error('Niepotwierdzona historia efektów.');
 return v.map((e:any)=>{
  if(!e||!['sync_local_woo_stock','email'].includes(e.type)||!Object.hasOwn(outcomes,e.outcome)||typeof e.state!=='string'||!uuid(e.channel_id)||!uuid(e.job_id)||typeof e.parent_acknowledged!=='boolean'||typeof e.reconciliation_required!=='boolean'||e.automatic_retry!==false||typeof e.created_at!=='string'||!Number.isFinite(Date.parse(e.created_at)))throw Error('Niepotwierdzony wynik efektu.');
  if(e.error_code!=null&&!Object.hasOwn(effectErrors,e.error_code))throw Error('Niepotwierdzony kod błędu efektu.');
  if(e.type==='sync_local_woo_stock'&&(!['pending','running','done','failed'].includes(e.state)||!uuid(e.listing_id)||e.error_code==='AUTOMATION_EMAIL_FAILED'||e.outcome!=='VERIFIED'&&e.verified_stock!==null||e.outcome==='SMTP_ACCEPTED_NOT_DELIVERED'||(e.outcome==='VERIFIED'&&(!Number.isSafeInteger(e.verified_stock)||e.verified_stock<0||e.reconciliation_required))))throw Error('Niepotwierdzony wynik stanu Woo.');
  if(e.type==='email'){
   const expected=e.state==='smtp_accepted'?['SMTP_ACCEPTED_NOT_DELIVERED']:e.state==='uncertain'?['UNKNOWN_WRITE_OR_ACK']:e.state==='failed'?['FAILED_BEFORE_DISPATCH']:['draft','invalid','queued','simulated','cancelled'].includes(e.state)?['PENDING','ATTEMPTED_RECONCILIATION_REQUIRED']:[];
   if(!expected.includes(e.outcome)||e.verified_stock!==null||e.listing_id!==null||e.error_code!=null&&e.error_code!=='AUTOMATION_EMAIL_FAILED')throw Error('Niepotwierdzony wynik email.');
  }
  return e;
 });
}
export function AutomaticEffects({effects}:{effects?:unknown}){
 if(effects===undefined)return null;let rows:any[];try{rows=readAutomaticEffects(effects);}catch{return <p role="alert">Nie można potwierdzić historii efektów. Odczytaj ją ponownie; nie ponawiaj wysłania.</p>;}
 if(!rows.length)return null;
 return <section aria-label="Rzeczywiste efekty automatyzacji"><h5>Efekty w sklepie i poczcie</h5><p>Zakończenie reguły i wynik połączenia są potwierdzane osobno. Brak automatycznych ponowień niepewnego wysłania.</p>{rows.map((e,i)=><article key={e.job_id+':'+(e.message_id??e.listing_id??i)}><strong>{e.type==='email'?'Email':'Stan lokalnego Woo'} · {outcomes[e.outcome]}</strong>{e.outcome==='VERIFIED'&&<p>Potwierdzony stan: {e.verified_stock}</p>}{e.error_code&&<p>{effectErrors[e.error_code]}</p>}<small>{date(e.created_at)} · {e.parent_acknowledged?'Zadanie nadrzędne potwierdzone':'Brak potwierdzenia zadania nadrzędnego'}{e.reconciliation_required?' · Wymagany odczyt i uzgodnienie pierwotnej próby':''}</small></article>)}</section>;
}
