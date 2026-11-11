import {useCallback,useEffect,useRef,useState} from 'react';
import {api,ApiError} from './api';
/** Migration 252 (L4 Mirakl): OR11 order schedule, offer and fulfilment writes with their outcome, webhook endpoint. */
type Props={channelId:string;admin:boolean;readOnly:boolean};
type Operation={id:string;kind:'offers'|'accept'|'tracking'|'ship';target:string;state:string;outcome:string|null;attempts:number;import_id:string|null;result:any;reason:string|null;created_at:string;updated_at:string};
type State={simulation:boolean;writes_enabled:boolean;reads_enabled:boolean;schedule:any|null;operations:Operation[];webhook:{id:string;enabled:boolean;version:number}|null;events:{event_id:string;event_type:string;outcome:string;received_at:string}[]};
type Product={id:string;sku:string;name:string;price:number};
const kinds:Record<Operation['kind'],string>={offers:'Oferty (OF24)',accept:'Akceptacja (OR21)',tracking:'Numer przesyłki (OR23)',ship:'Wysyłka (OR24)'};
const states:Record<string,string>={queued:'W kolejce',sending:'Wysyłanie',sent:'Przyjęte — import w toku',uncertain:'Bez potwierdzenia — uzgadnianie odczytem',applied:'Zapisane',partial:'Zapisane częściowo',failed:'Nieudane'};
const outcomes:Record<string,string>={acknowledged:'potwierdzone odpowiedzią',import_report:'raport importu',reconciled:'uzgodnione odczytem',replayed:'wysłane ponownie po odczycie',refused:'odrzucone',conflict:'konflikt stanu'};
const scheduleStates:Record<string,string>={idle:'Czeka na kolejny termin',queued:'Odczyt w toku',deferred:'Odroczony przez wspólny limit OR11',failed:'Zatrzymany'};
const when=(v:string|null)=>v?new Date(v).toLocaleString('pl-PL'):'—';
const zl=(minor:number)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:'PLN'}).format(minor/100);
export function Mirakl262Panel(p:Props){
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [interval,setIntervalMinutes]=useState('15'),[products,setProducts]=useState<Product[]>([]),[picked,setPicked]=useState<string[]>([]);
 const [orderId,setOrderId]=useState(''),[action,setAction]=useState<'accept'|'tracking'|'ship'>('accept'),[carrier,setCarrier]=useState(''),[tracking,setTracking]=useState('');
 const [hookPath,setHookPath]=useState('');
 // Set on every mount: React's development double mount runs the cleanup once before the real mount.
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const base='/integrations/'+p.channelId+'/mirakl262';
 const load=useCallback(async()=>{
  try{const s=await api<State>(base);if(alive.current){setState(s);if(s.schedule)setIntervalMinutes(String(s.schedule.interval_minutes));}}
  catch(e){if(alive.current)setError(e instanceof ApiError?e.message:'Nie udało się odczytać stanu operacji Mirakl.');}
 },[base]);
 useEffect(()=>{if(!p.admin)return;void load();api<{data:Product[]}>('/products?limit=50').then(r=>{if(alive.current)setProducts(r.data??[]);}).catch(()=>{});},[p.admin,load]);
 async function act(work:()=>Promise<unknown>,done:string){
  if(p.readOnly||busy)return;setBusy(true);setError('');setNotice('');
  try{await work();if(alive.current)setNotice(done);await load();}
  catch(e){if(alive.current)setError(e instanceof ApiError?e.message:'Operacja Mirakl nie powiodła się.');}
  finally{if(alive.current)setBusy(false);}
 }
 if(!p.admin)return <section className="ops-result"><p>Harmonogram i zapisy Mirakl wymagają administratora.</p></section>;
 const s=state?.schedule,disabled=busy||p.readOnly;
 return <section className="ops-result" aria-label="Harmonogram i zapisy Mirakl">
  <h4>Harmonogram, oferty i realizacja</h4>
  {state?.simulation&&<p className="sim" role="note"><strong>SYMULACJA</strong> lokalnej instancji Mirakl — żadne dane nie trafiają do operatora.</p>}
  {state&&!state.writes_enabled&&<p role="note">Zapisy do operatora są wyłączone: wymagają umowy i dostępu zapisu od operatora marketplace (czeka na dostawcę).</p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <fieldset><legend>Harmonogram zamówień (OR11)</legend>
   <p>Zamówienia z okna od ostatniego odczytu trafiają do kolejki importu; zatwierdzasz je jak dotąd. Wspólny limit OR11 instancji to jeden odczyt na 15 minut.</p>
   <label>Co ile minut<input aria-label="Co ile minut" inputMode="numeric" value={interval} onChange={e=>setIntervalMinutes(e.target.value)}/></label>
   <button type="button" className="button small-btn" disabled={disabled} onClick={()=>void act(()=>api(base+'/schedule','PUT',{enabled:true,interval_minutes:Number(interval),...(s?{version:s.version}:{})}),'Harmonogram zapisany')}>{s?.enabled?'Zapisz harmonogram':'Włącz harmonogram'}</button>
   {s?.enabled&&<button type="button" className="button small-btn" disabled={disabled} onClick={()=>void act(()=>api(base+'/schedule','PUT',{enabled:false,interval_minutes:s.interval_minutes,version:s.version}),'Harmonogram wyłączony')}>Wyłącz</button>}
   {s?.enabled&&<button type="button" className="button small-btn" disabled={disabled||s.state==='failed'} onClick={()=>void act(()=>api(base+'/schedule/run','POST',{}),'Odczyt zaplanowany na teraz')}>Odczytaj teraz</button>}
   {s&&<table aria-label="Stan harmonogramu"><tbody>
    <tr><th>Stan</th><td>{!s.enabled?'Wyłączony':s.state==='deferred'&&s.reason?s.reason:(scheduleStates[s.state]??s.state)+(s.reason?' — '+s.reason:'')}</td></tr>
    <tr><th>Ostatnie okno do</th><td>{when(s.watermark)}</td></tr>
    {s.state!=='deferred'&&<tr><th>Następny odczyt</th><td>{when(s.next_run_at)}</td></tr>}
    <tr><th>Strony / zamówienia w kolejce</th><td>{s.pages} / {s.staged}{s.page_offset!==null?(s.page_total!==null?` (bieżące okno: ${s.page_offset} z ${s.page_total})`:' (bieżące okno w toku)'):''}</td></tr>
   </tbody></table>}
  </fieldset>
  <fieldset><legend>Ceny i stany ofert (OF24)</legend>
   <p>Wysyła cenę i dostępny stan wybranych produktów do istniejących ofert o tym samym SKU. Wynik importu odczytujemy z raportu Mirakl.</p>
   <div role="group" aria-label="Produkty do wysłania" style={{maxHeight:180,overflowY:'auto'}}>
    {products.map(x=><label key={x.id} style={{display:'block'}}><input type="checkbox" checked={picked.includes(x.id)} onChange={e=>setPicked(e.target.checked?[...picked,x.id]:picked.filter(v=>v!==x.id))}/> {x.sku} — {x.name} ({zl(x.price)})</label>)}
   </div>
   <button type="button" className="button small-btn" disabled={disabled||!picked.length||picked.length>100} onClick={()=>void act(()=>api(base+'/offers','POST',{client_key:crypto.randomUUID(),product_ids:picked}),'Oferty dodane do kolejki zapisu')}>Wyślij {picked.length||''} ofert</button>
   {state?.simulation&&<button type="button" className="button small-btn" disabled={disabled} onClick={()=>void act(()=>api(base+'/simulation/seed','POST',{product_ids:picked.slice(0,20)}),'SYMULACJA: dodano oferty i dwa zamówienia w lokalnej instancji')}>SYMULACJA: przygotuj oferty i zamówienia</button>}
  </fieldset>
  <fieldset><legend>Realizacja zamówienia (OR21 / OR23 / OR24)</legend>
   <label>Numer zamówienia Mirakl<input aria-label="Numer zamówienia Mirakl" value={orderId} onChange={e=>setOrderId(e.target.value)}/></label>
   <label>Działanie<select aria-label="Działanie" value={action} onChange={e=>setAction(e.target.value as typeof action)}>
    <option value="accept">Akceptuj wszystkie pozycje</option><option value="tracking">Przekaż numer przesyłki</option><option value="ship">Potwierdź wysyłkę</option></select></label>
   {action==='tracking'&&<><label>Przewoźnik (kod lub nazwa)<input aria-label="Przewoźnik" value={carrier} onChange={e=>setCarrier(e.target.value)}/></label>
    <label>Numer przesyłki<input aria-label="Numer przesyłki" value={tracking} onChange={e=>setTracking(e.target.value)}/></label></>}
   <button type="button" className="button small-btn" disabled={disabled||!orderId.trim()} onClick={()=>void act(()=>api(base+'/fulfillment','POST',{client_key:crypto.randomUUID(),action,order_id:orderId.trim(),
    ...(action==='tracking'?{tracking:/^[A-Za-z0-9_-]+$/.test(carrier)?{carrier_code:carrier,tracking_number:tracking.trim()}:{carrier_name:carrier.trim(),tracking_number:tracking.trim()}}:{})}),'Zapis realizacji dodany do kolejki')}>Zleć</button>
  </fieldset>
  <h5>Zapisy</h5>
  {!state?.operations.length?<p>Brak zapisów dla tego kanału.</p>:<div role="region" aria-label="Tabela zapisów Mirakl" tabIndex={0} style={{maxWidth:'100%',overflowX:'auto'}}><table><thead><tr><th>Rodzaj</th><th>Cel</th><th>Stan</th><th>Szczegóły</th><th>Zmiana</th><th></th></tr></thead><tbody>
   {state.operations.map(o=><tr key={o.id}><td>{kinds[o.kind]}</td><td>{o.kind==='offers'?`${o.result?.lines_read??''} SKU`:o.target}</td>
    <td>{states[o.state]??o.state}{o.outcome?` (${outcomes[o.outcome]??o.outcome})`:''}</td>
    <td>{o.reason??''}{o.result?.errors?.length?` Błędy: ${o.result.errors.map((e:any)=>e.shop_sku).join(', ')}`:''}{o.import_id?` Import ${o.import_id}.`:''}</td>
    <td>{when(o.updated_at)}</td>
    <td>{o.state==='uncertain'&&<button type="button" className="button small-btn" disabled={disabled} onClick={()=>void act(()=>api(base+'/operations/'+o.id+'/reconcile','POST',{}),'Uzgodnienie zaplanowane na teraz')}>Uzgodnij teraz</button>}</td></tr>)}
  </tbody></table></div>}
  <button type="button" className="button small-btn" disabled={busy} onClick={()=>void load()}>Odśwież</button>
  <fieldset><legend>Powiadomienia operatora (webhook)</legend>
   <p>Powiadomienie tylko przyspiesza odczyt OR11 — dane zamówienia zawsze pochodzą z odczytu. Adres zawiera sekret; pokazujemy go raz.</p>
   <button type="button" className="button small-btn" disabled={disabled} onClick={()=>void act(async()=>{const r=await api<{path:string}>(base+'/webhook','POST',{});if(alive.current)setHookPath(location.origin+r.path);},state?.webhook?'Nowy adres utworzony; poprzedni przestał działać':'Adres powiadomień utworzony')}>{state?.webhook?'Utwórz nowy adres (unieważnia poprzedni)':'Utwórz adres powiadomień'}</button>
   {hookPath&&<p><label>Adres do panelu operatora<input aria-label="Adres powiadomień" readOnly value={hookPath} onFocus={e=>e.currentTarget.select()} style={{width:'100%'}}/></label></p>}
   {!!state?.events.length&&<ul aria-label="Ostatnie powiadomienia">{state.events.map(e=><li key={e.event_id}>{when(e.received_at)} — {e.event_type} ({e.outcome==='sync_requested'?'odczyt przyspieszony':'zapisane'})</li>)}</ul>}
  </fieldset>
 </section>;
}
