import {useEffect,useRef,useState,type ChangeEvent,type ReactNode} from 'react';
import {api,ApiError} from './api';
type Props={channelId:string;tenantId:string;userId:string;admin:boolean;readOnly:boolean};
type Kind='account'|'offers'|'orders'|'readback';
type Observation={key:string;ticket:number;kind:Kind;result:any;connectionHash?:string;offerPreviousOffsets?:number[]};
class ReadError extends Error{}
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text=(v:unknown,max=200):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const currency=(v:unknown):v is string=>typeof v==='string'&&['PLN','EUR','USD','GBP','CZK'].includes(v);
const amount=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0)&&/^(0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(String(v))&&v<=21474836.47;
const iso=(v:unknown):v is string=>{
 if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v)||!Number.isFinite(Date.parse(v)))return false;
 const day=new Date(v.slice(0,10)+'T00:00:00Z');return Number.isFinite(day.getTime())&&day.toISOString().slice(0,10)===v.slice(0,10);
};
function validEnvelope(v:any,channel:string,kind:Kind){
 if(!v||v.channel_id!==channel||!['live','sandbox'].includes(v.mode)||v.scope!=='external_read'||v.read_only!==true||v.account_verified!==false||v.provider_acceptance!==false||v.status!=='CODE_NOT_CONNECTED_NOT_ACCOUNT_ACCEPTED'||v.stages_orders!==false||v.imports_orders!==false)return false;
 if(v.connection_hash!==undefined&&(typeof v.connection_hash!=='string'||!/^[a-f0-9]{64}$/.test(v.connection_hash)))return false;
 const r=v.result;
 if(kind==='account')return r&&integer(r.shop_id,1)&&text(r.shop_name)&&currency(r.currency_iso_code)&&text(r.shop_state,80)&&r.model==='MARKETPLACE';
 if(kind==='readback')return r&&Array.isArray(r.data)&&r.data.length<=100&&r.data.every(validOrderRow);
 if(!r||!Array.isArray(r.data)||r.data.length>100||!integer(r.offset,0,10000)||!integer(r.total_count,0,1000000)||typeof r.has_more!=='boolean'||r.offset+r.data.length>r.total_count||r.has_more!==(r.offset+r.data.length<r.total_count)||(r.has_more&&r.data.length===0))return false;
 if(new Set(r.data.map((row:any)=>kind==='offers'?row?.offer_id:row?.order_id)).size!==r.data.length)return false;
 return r.data.every((row:any)=>row&&currency(row.currency_iso_code)&&(kind==='offers'
  ?integer(row.offer_id,1)&&text(row.shop_sku,160)&&text(row.product_sku,160)&&text(row.product_title)&&amount(row.price)&&integer(row.quantity,0,10000000)&&typeof row.active==='boolean'&&text(row.state_code,80)
  :text(row.order_id,160)&&text(row.order_state,80)&&iso(row.last_updated_date)&&amount(row.total_price)));
}
const validOrderRow=(row:any)=>row&&text(row.order_id,160)&&currency(row.currency_iso_code)&&text(row.order_state,80)&&iso(row.last_updated_date)&&amount(row.total_price);
type IdPlan={ids:string[];groups:string[][]};
// Mirror only the backend's conservative grouping budget, never normalize IDs.
function idPlan(raw:string):IdPlan|null{
 const ids=raw.split('\n');if(ids.length<1||ids.length>100||new Set(ids).size!==ids.length)return null;
 const groups:string[][]=[];let group:string[]=[],bytes=0;
 for(const id of ids){
  if(!text(id,160)||id.includes(','))return null;
  const encoded=new TextEncoder().encode(id),size=encoded.byteLength;
  if(size>100||new TextDecoder('utf-8',{fatal:true}).decode(encoded)!==id)return null;
  if(bytes+(group.length?1:0)+size>100){groups.push(group);group=[];bytes=0;}
  bytes+=(group.length?1:0)+size;group.push(id);
 }
 groups.push(group);return{ids,groups};
}
const sameIds=(value:any,expected:string[])=>Array.isArray(value)&&value.length===expected.length&&value.every((id:unknown,i:number)=>id===expected[i]);
function validReadback(r:any,plan:IdPlan,index:number){
 const group=plan.groups[index];if(!group||!r||!sameIds(r.requested_order_ids,plan.ids)||!sameIds(r.group_order_ids,group)||r.group_index!==index||r.group_count!==plan.groups.length||!Array.isArray(r.data)||r.data.length>group.length||r.total_count!==r.data.length)return false;
 const seen=new Set<string>();for(const row of r.data){if(!validOrderRow(row)||row.id!==row.order_id||!group.includes(row.order_id)||seen.has(row.order_id))return false;seen.add(row.order_id);}
 const missing=group.filter(id=>!seen.has(id)),hasMore=index+1<plan.groups.length;
 return sameIds(r.group_missing_order_ids,missing)&&r.has_more_groups===hasMore&&r.next_group===(hasMore?index+1:null)&&r.readback_scope==='single_group'&&r.readback_complete===(plan.groups.length===1&&missing.length===0);
}
const states:Record<string,string>={OPEN:'Otwarty',OPENED:'Otwarty',CLOSED:'Zamknięty',SUSPENDED:'Zawieszony',WAITING_ACCEPTANCE:'Oczekuje na akceptację',WAITING_DEBIT:'Oczekuje na płatność',SHIPPING:'W przygotowaniu',SHIPPED:'Wysłane',RECEIVED:'Odebrane',CANCELED:'Anulowane',CANCELLED:'Anulowane',REFUNDED:'Zwrócone środki'};
const state=(v:string)=>Object.hasOwn(states,v)?states[v]:'Stan nierozpoznany';
const price=(n:number,c:string)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:c}).format(n);
function TableRegion({label,children}:{label:string;children:ReactNode}){
 return <div role="region" aria-label={label} tabIndex={0} style={{maxWidth:'100%',overflowX:'auto'}}>{children}</div>;
}
export function MiraklReadsPanel(p:Props){
 const [offersMax,setOffersMax]=useState('50'),[sku,setSku]=useState(''),[ordersMax,setOrdersMax]=useState('50'),[offset,setOffset]=useState('0'),[start,setStart]=useState(''),[end,setEnd]=useState('');
 const [readbackIds,setReadbackIds]=useState(''),[readbackGroup,setReadbackGroup]=useState('1');
 const plannedIds=idPlan(readbackIds);
 const principal=[p.channelId,p.tenantId,p.userId,p.admin,p.readOnly].join(':');
 const key=JSON.stringify([principal,offersMax,sku,ordersMax,offset,start,end,readbackIds,readbackGroup]);
 const [observation,setObservation]=useState<Observation|null>(null),[failure,setFailure]=useState<{key:string;ticket:number;message:string}|null>(null),[busy,setBusy]=useState<{key:string;ticket:number}|null>(null),[capability,setCapability]=useState<{principal:string;epoch:number;available:boolean}|null>(null);
 const current=useRef(key),ticket=useRef(0),alive=useRef(true),flight=useRef<number|null>(null),allowed=useRef(false);
 const previousPrincipal=useRef(principal),principalEpoch=useRef(0);
 if(previousPrincipal.current!==principal){previousPrincipal.current=principal;principalEpoch.current++;}
 if(current.current!==key){current.current=key;ticket.current++;flight.current=null;}
 allowed.current=p.admin===true&&p.readOnly===false&&[p.channelId,p.tenantId,p.userId].every(uuid);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++;flight.current=null;};},[]);
 const own=(n:number)=>alive.current&&current.current===key&&ticket.current===n&&allowed.current;
 const result=allowed.current&&observation?.key===key&&observation.ticket===ticket.current?observation:null;
 const error=allowed.current&&failure?.key===key&&failure.ticket===ticket.current?failure.message:null;
 const unavailable=capability?.principal===principal&&capability.epoch===principalEpoch.current&&capability.available===false;
 const working=busy?.key===key&&busy.ticket===ticket.current;
 const disabled=!allowed.current||working||unavailable;
 const clear=()=>{ticket.current++;flight.current=null;setObservation(null);setFailure(null);setBusy(null);};
 async function sameActor(n:number){
  if(!own(n))throw new ReadError('Sesja lub widok zmieniły się.');
  const me=await api('/auth/me');
  if(!own(n)||me.restore_preview!==false||(Object.hasOwn(me,'read_only')&&me.read_only!==false)||me.user?.tenant_id!==p.tenantId||me.user?.id!==p.userId||me.user?.role!=='admin')throw new ReadError('Odczyt wymaga bieżącej sesji administratora tej firmy.');
 }
 async function recheckAvailability(){
  if(!allowed.current||working||flight.current!==null||!unavailable)return;
  clear();const n=++ticket.current;flight.current=n;setBusy({key,ticket:n});
  try{
   await sameActor(n);const health=await api('/health');if(!own(n))return;
   const available=health.mirakl_reads_available===true;
   setCapability({principal,epoch:principalEpoch.current,available});
   if(!available)throw new ReadError('Odczyty Mirakl są niedostępne w tym uruchomieniu.');
   // Availability is local runtime state. A provider read still needs another click.
  }catch(e){if(own(n))setFailure({key,ticket:n,message:e instanceof ReadError?e.message:'Nie udało się sprawdzić dostępności odczytów Mirakl.'});}
  finally{if(flight.current===n){flight.current=null;if(current.current===key&&alive.current)setBusy(null);}}
 }
 async function read(kind:Kind,offerPage:{offset:number;previousOffsets:number[];connectionHash?:string}={offset:0,previousOffsets:[]}){
  if(disabled||flight.current!==null)return;
  clear();const n=++ticket.current;flight.current=n;setBusy({key,ticket:n});
  try{
   let query='';
   if(kind==='offers'){if(!/^(?:[1-9]|[1-9]\d|100)$/.test(offersMax)||sku.length>160||/[\x00-\x1f\x7f]/.test(sku)||!integer(offerPage.offset,0,10000))throw new ReadError('Podaj limit od 1 do 100 i poprawne SKU.');query='?'+new URLSearchParams({max:offersMax,...(sku?{sku}:{}),...(offerPage.offset?{offset:String(offerPage.offset)}:{}),...(offerPage.connectionHash?{connection_hash:offerPage.connectionHash}:{})});}
   if(kind==='orders'){const span=Date.parse(end)-Date.parse(start);if(!iso(start)||!iso(end)||!(span>0&&span<=31*86400000)||!/^(?:[1-9]|[1-9]\d|100)$/.test(ordersMax)||!/^(?:0|[1-9]\d{0,3}|10000)$/.test(offset))throw new ReadError('Podaj daty ISO ze strefą czasu, zakres do 31 dni, limit od 1 do 100 i pozycję od 0 do 10000.');query='?'+new URLSearchParams({start_update_date:start,end_update_date:end,max:ordersMax,offset});}
   if(kind==='readback'){if(!plannedIds||!/^(?:[1-9]|[1-9]\d|100)$/.test(readbackGroup)||!plannedIds.groups[Number(readbackGroup)-1])throw new ReadError('Podaj od 1 do 100 różnych identyfikatorów, po jednym w wierszu, bez przecinków, pustych wierszy i znaków sterujących. Każdy identyfikator może mieć do 100 bajtów UTF-8.');query='?'+new URLSearchParams({order_ids:plannedIds.ids.join(','),group:String(Number(readbackGroup)-1)});}
   await sameActor(n);const health=await api('/health');if(!own(n))return;
   if(health.mirakl_reads_available!==true){setCapability({principal,epoch:principalEpoch.current,available:false});throw new ReadError('Odczyty Mirakl są niedostępne w tym uruchomieniu.');}
   setCapability({principal,epoch:principalEpoch.current,available:true});
   // This is the only provider-facing request; every action is a deliberate click.
   const value=await api('/integrations/'+p.channelId+'/mirakl/'+(kind==='account'?'account':kind==='readback'?'orders-readback':kind+'-preview')+query);
   await sameActor(n);if(!validEnvelope(value,p.channelId,kind))throw new ReadError('Nie potwierdzono odpowiedzi dla tego kanału.');
   if(kind==='offers'&&offerPage.connectionHash!==undefined&&value.connection_hash!==offerPage.connectionHash)throw new ReadError('Połączenie zmieniło się. Rozpocznij nowy odczyt ofert.');
   if((kind==='offers'||kind==='orders')&&(value.result.offset!==(kind==='offers'?offerPage.offset:Number(offset))||value.result.data.length>Number(kind==='offers'?offersMax:ordersMax)))throw new ReadError('Nie potwierdzono zakresu strony tego odczytu.');
   if(kind==='readback'&&(!plannedIds||!validReadback(value.result,plannedIds,Number(readbackGroup)-1)))throw new ReadError('Nie potwierdzono identyfikatorów i zakresu grupy tego odczytu.');
   if(own(n))setObservation({key,ticket:n,kind,result:value.result,...(kind==='offers'?{offerPreviousOffsets:[...offerPage.previousOffsets],connectionHash:value.connection_hash}:{})});
  }catch(e){if(own(n))setFailure({key,ticket:n,message:e instanceof ApiError?(e.status===429?'Odczyt odroczony przez dostawcę. Odczekaj przed kolejną ręczną próbą.':'Nie udało się potwierdzić odczytu Mirakl. Sprawdź sesję i konfigurację kanału.'):e instanceof ReadError?e.message:'Nie potwierdzono odczytu Mirakl.'});}
  finally{if(flight.current===n){flight.current=null;if(current.current===key&&alive.current)setBusy(null);}}
 }
 const change=(set:(v:string)=>void)=>(e:ChangeEvent<HTMLInputElement>)=>{clear();set(e.target.value);};
 return <section className="ops-result" aria-label="Odczyty Mirakl">
  <h4>Odczyty Mirakl</h4><p>Pobierz dane na żądanie. Podgląd nie importuje zamówień i nie potwierdza odbioru konta u dostawcy.</p>
  {!allowed.current&&<p>Odczyty wymagają administratora własnej firmy i aktywnego trybu pracy.</p>}
  {unavailable&&<><p>Odczyty Mirakl są niedostępne w tym uruchomieniu.</p>
   <button type="button" disabled={!allowed.current||working} onClick={()=>void recheckAvailability()}>Sprawdź ponownie dostępność</button>
  </>}
  <button type="button" disabled={disabled} onClick={()=>void read('account')}>Odczytaj konto</button>
  <fieldset><legend>Oferty — wybrana strona</legend>
   <label>Limit ofert<input aria-label="Limit ofert" inputMode="numeric" value={offersMax} onChange={change(setOffersMax)}/></label>
   <label>SKU oferty<input aria-label="SKU oferty" value={sku} onChange={change(setSku)}/></label>
   <button type="button" disabled={disabled} onClick={()=>void read('offers')}>Odczytaj oferty</button>
  </fieldset>
  <fieldset><legend>Zamówienia — dokładne identyfikatory</legend>
   <label>Identyfikatory zamówień<textarea aria-label="Identyfikatory zamówień" rows={5} maxLength={16099} value={readbackIds} onChange={e=>{clear();setReadbackIds(e.target.value);setReadbackGroup('1');}}/></label>
   <p>Wpisz od 1 do 100 różnych identyfikatorów, po jednym w wierszu. Zachowaj dokładną pisownię. Listę podzielimy na grupy, które odczytujesz osobno.</p>
   <label>Grupa identyfikatorów<select aria-label="Grupa identyfikatorów" value={readbackGroup} disabled={!plannedIds} onChange={e=>{clear();setReadbackGroup(e.target.value);}}>
    {(plannedIds?.groups??[[]]).map((_,i)=><option key={i} value={String(i+1)}>Grupa {i+1} z {plannedIds?.groups.length??1}</option>)}
   </select></label>
   {plannedIds&&<p>Zaplanowano {plannedIds.ids.length} identyfikatorów w {plannedIds.groups.length} grupach. Wybrana grupa: {readbackGroup}.</p>}
   <button type="button" disabled={disabled} onClick={()=>void read('readback')}>Odczytaj wybraną grupę</button>
  </fieldset>
  <fieldset><legend>Zamówienia — wybrany zakres</legend>
   <label>Od (ISO ze strefą)<input aria-label="Zamówienia od" placeholder="2026-10-01T00:00:00Z" value={start} onChange={change(setStart)}/></label>
   <label>Do (ISO ze strefą)<input aria-label="Zamówienia do" placeholder="2026-10-02T00:00:00Z" value={end} onChange={change(setEnd)}/></label>
   <label>Limit zamówień<input aria-label="Limit zamówień" inputMode="numeric" value={ordersMax} onChange={change(setOrdersMax)}/></label>
   <label>Pozycja początkowa<input aria-label="Pozycja początkowa" inputMode="numeric" value={offset} onChange={change(setOffset)}/></label>
   <button type="button" disabled={disabled} onClick={()=>void read('orders')}>Odczytaj zamówienia</button>
  </fieldset>
  {working&&<p role="status">Trwa odczyt…</p>}{error&&<p role="alert">{error}</p>}
  {result?.kind==='account'&&<TableRegion label="Tabela konta Mirakl"><table><caption>Odczyt konta</caption><tbody>
   <tr><th>Nazwa sklepu</th><td>{result.result.shop_name}</td></tr><tr><th>Numer sklepu</th><td>{result.result.shop_id}</td></tr>
   <tr><th>Waluta</th><td>{result.result.currency_iso_code}</td></tr><tr><th>Stan sklepu</th><td>{state(result.result.shop_state)}</td></tr>
  </tbody></table></TableRegion>}
  {result&&result.kind!=='account'&&result.kind!=='readback'&&<><p role="status">Pokazano {result.result.data.length} z {result.result.total_count} pozycji; początek: {result.result.offset}.</p>
   {result.result.data.length===0?<p>Brak pozycji w tym odczycie.</p>:<TableRegion label={result.kind==='offers'?'Tabela ofert Mirakl':'Tabela zamówień Mirakl'}>{result.kind==='offers'?<table><caption>Podgląd ofert</caption><thead><tr><th>SKU oferty</th><th>Produkt</th><th>Ilość</th><th>Cena</th><th>Aktywna</th></tr></thead><tbody>{result.result.data.map((r:any)=><tr key={r.offer_id}><td>{r.shop_sku}</td><td>{r.product_title}</td><td>{r.quantity}</td><td>{price(r.price,r.currency_iso_code)}</td><td>{r.active?'Tak':'Nie'}</td></tr>)}</tbody></table>:<table><caption>Podgląd zamówień</caption><thead><tr><th>Numer zamówienia</th><th>Stan</th><th>Ostatnia zmiana</th><th>Wartość</th></tr></thead><tbody>{result.result.data.map((r:any)=><tr key={r.order_id}><td>{r.order_id}</td><td>{state(r.order_state)}</td><td>{new Date(r.last_updated_date).toLocaleString('pl-PL')}</td><td>{price(r.total_price,r.currency_iso_code)}</td></tr>)}</tbody></table>}</TableRegion>}
   {result.result.has_more&&<p>Są dalsze pozycje. Kolejna strona nie jest pobierana automatycznie.</p>}
   {result.kind==='offers'&&<>
    <nav aria-label="Strony ofert">
     <button type="button" disabled={disabled||!result.connectionHash||!result.offerPreviousOffsets?.length} onClick={()=>{const previous=result.offerPreviousOffsets??[];if(previous.length&&result.connectionHash)void read('offers',{offset:previous[previous.length-1],previousOffsets:previous.slice(0,-1),connectionHash:result.connectionHash});}}>Poprzednia strona ofert</button>
     <button type="button" disabled={disabled||!result.connectionHash||!result.result.has_more||result.result.offset+result.result.data.length>10000} onClick={()=>{if(result.connectionHash&&result.result.has_more&&result.result.offset+result.result.data.length<=10000)void read('offers',{offset:result.result.offset+result.result.data.length,previousOffsets:[...(result.offerPreviousOffsets??[]),result.result.offset],connectionHash:result.connectionHash});}}>Następna strona ofert</button>
    </nav>
    {result.result.has_more&&result.result.offset+result.result.data.length>10000&&<p>Osiągnięto lokalny limit paginacji. Zawęź odczyt filtrem SKU.</p>}
    {result.result.has_more&&!result.connectionHash&&<p>Kolejne strony są niedostępne w tym uruchomieniu.</p>}
    <p>Każda strona jest osobnym odczytem; zmiany ofert u dostawcy mogą zmienić ich kolejność.</p>
   </>}
  </>}
  {result?.kind==='readback'&&<>
   <p role="status">Grupa {result.result.group_index+1} z {result.result.group_count}: zwrócono {result.result.total_count} z {result.result.group_order_ids.length} żądanych identyfikatorów tej grupy.</p>
   {result.result.data.length>0&&<TableRegion label="Tabela wskazanych zamówień Mirakl"><table><caption>Odczyt wskazanych zamówień</caption><thead><tr><th>Numer zamówienia</th><th>Stan</th><th>Ostatnia zmiana</th><th>Wartość</th></tr></thead><tbody>{result.result.data.map((r:any)=><tr key={r.order_id}><td>{r.order_id}</td><td>{state(r.order_state)}</td><td>{new Date(r.last_updated_date).toLocaleString('pl-PL')}</td><td>{price(r.total_price,r.currency_iso_code)}</td></tr>)}</tbody></table></TableRegion>}
   {result.result.group_missing_order_ids.length>0&&<><p>Niezwrócone identyfikatory — brak obserwacji w tej odpowiedzi nie oznacza usunięcia zamówienia.</p><ul aria-label="Niezwrócone identyfikatory">{result.result.group_missing_order_ids.map((id:string)=><li key={id}>{id} — niezwrócone</li>)}</ul></>}
   <p>{result.result.readback_complete?'Dostawca zwrócił wszystkie wskazane identyfikatory w tej jednej grupie.':result.result.group_count>1?'Ten wynik obejmuje tylko wybraną grupę. Nie potwierdza kompletności całego odczytu.':'Ten wynik nie potwierdza wszystkich wskazanych identyfikatorów.'}</p>
   {result.result.has_more_groups&&<p>Następna grupa: {result.result.next_group+1}. Wybierz ją i uruchom osobny odczyt; nie jest pobierana automatycznie.</p>}
  </>}
 </section>;
}
