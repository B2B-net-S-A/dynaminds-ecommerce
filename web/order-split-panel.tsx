/** Unregistered ordinary split panel. Controlled DOM/HTTP tests are not Native
 * acceptance. Parent scopes source/context; no mount fetch or mutation/retry. */
import {useLayoutEffect,useRef,useState} from 'react';
import {OrderSplitAllocationEditor,type OrderSplitAllocationSource} from './order-split-allocation';
import {createOrderSplitApi,type SplitCommercialReview} from './order-split-api';
import {readSplitIntent,splitActor,splitIntentKey,validateSplitIntent,type SplitIntent} from './order-split-custody';
import {ORDER_SPLIT_LIMITS as L,orderSplitUuid,orderSplitVersion} from '../server/order-splits-schema';
import {same as sameJson} from './pim/legacy-files/handoff';
export type OrderSplitPanelProps={source:OrderSplitAllocationSource;contextKey:string;readOnly:boolean;onOpenOrder:(id:string)=>void};
type Head=Record<string,any>;
type Known={schema:'order-split-panel-reference/v1';actor:string;phase:'preview'|'done';preview:SplitIntent;head:Head;execute_serialized:string};
const need=(v:unknown)=>{if(!v)throw Error('Nie potwierdzono zapisanego podglądu.');};
// Saved/returned heads are bounded, validated plain JSON. Object member order
// is transport syntax; array order and every value remain part of the comparison.
const same=(a:unknown,b:unknown)=>need(sameJson(a,b));
const exact=(v:any,keys:string[])=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'));
const referenceKey=(actor:string,order:string)=>'dyna:order-split-panel-reference:v1:'+actor+':'+order;
function execution(k:Known):SplitIntent{
 const h=k.head;return validateSplitIntent({schema:'order-split-custody/v1',actor:k.actor,kind:'execute',serialized:k.execute_serialized,source:k.preview.source,preview:{id:k.phase==='done'?h.preview_id:h.id,scope_hash:h.scope_hash,serialized:k.preview.serialized,children:h.children}},k.actor);
}
function validateKnown(value:unknown,actor:string,order:string):Known{
 const k=value as Known;exact(k,['schema','actor','phase','preview','head','execute_serialized']);need(k.schema==='order-split-panel-reference/v1'&&k.actor===actor&&['preview','done'].includes(k.phase));
 const p=validateSplitIntent(k.preview,actor);need(p.kind==='preview'&&p.source.id===order);exact(k.head,['id','source_order_id','source_version','source_result_version','scope_hash','children',...(k.phase==='preview'?['ready']:['preview_id','state'])]);
 need(k.head.source_order_id===p.source.id&&k.head.source_version===p.source.version&&Array.isArray(k.head.children));execution(k);return structuredClone(k);
}
function known(actor:string,order:string){const raw=localStorage.getItem(referenceKey(actor,order));if(raw===null)return null;need(new TextEncoder().encode(raw).length<=5*L.request_bytes);return validateKnown(JSON.parse(raw),actor,order);}
function persist(actor:string,k:Known){const v=validateKnown(k,actor,k.preview.source.id),raw=JSON.stringify(v);need(new TextEncoder().encode(raw).length<=5*L.request_bytes);localStorage.setItem(referenceKey(actor,k.preview.source.id),raw);need(localStorage.getItem(referenceKey(actor,k.preview.source.id))===raw);}
function previewFrom(intent:SplitIntent):SplitIntent{return intent.kind==='preview'?intent:validateSplitIntent({schema:intent.schema,actor:intent.actor,kind:'preview',serialized:intent.preview!.serialized,source:intent.source},intent.actor);}
function saveVerified(intent:SplitIntent,h:Readonly<Head>):undefined{
 const preview=previewFrom(intent),old=known(intent.actor,intent.source.id);
 if(intent.kind==='preview'){
  if(old&&old.preview.serialized===intent.serialized&&old.phase==='done')return;
  const serialized=old&&old.preview.serialized===intent.serialized?old.execute_serialized:JSON.stringify({client_key:crypto.randomUUID(),preview_id:h.id,scope_hash:h.scope_hash,confirmed:true});
  persist(intent.actor,{schema:'order-split-panel-reference/v1',actor:intent.actor,phase:'preview',preview,head:structuredClone(h),execute_serialized:serialized});
 }else persist(intent.actor,{schema:'order-split-panel-reference/v1',actor:intent.actor,phase:'done',preview,head:structuredClone(h),execute_serialized:intent.serialized});
}
const money=(v:number,currency:string)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency}).format(v/100);
export function OrderSplitPanel(props:OrderSplitPanelProps){
 let actor:string;try{actor=splitActor(props.contextKey);need(['admin','operator','viewer'].includes(props.contextKey.split(':')[2]));const s=props.source;need(s&&orderSplitUuid.safeParse(s.order_id).success&&orderSplitVersion.safeParse(s.version).success&&['PLN','EUR','USD','GBP','CZK'].includes(s.currency)&&Array.isArray(s.items)&&s.items.length>0&&new TextEncoder().encode(JSON.stringify(s)).length<=L.source_bytes);}catch{return <section aria-label="Podział zamówienia"><p role="alert">Brak kompletnych danych zamówienia lub aktualnego kontekstu firmy i operatora.</p></section>;}
 return <Scope key={JSON.stringify([props.contextKey,props.readOnly,props.source])} {...props} actor={actor}/>;
}
function Scope({source,contextKey,readOnly,onOpenOrder,actor}:OrderSplitPanelProps&{actor:string}){
 const [controller]=useState(()=>new AbortController()),alive=useRef(true),running=useRef(false);
 const [client]=useState(()=>createOrderSplitApi({tenant_id:actor.split(':')[0],user_id:actor.split(':')[1],role:contextKey.split(':')[2],readOnly,signal:controller.signal}));
 const snapshot=()=>{try{return{held:readSplitIntent(localStorage,actor),known:known(actor,source.order_id),failed:false};}catch{return{held:null,known:null,failed:true};}};
 const [saved,setSaved]=useState(snapshot),[busy,setBusy]=useState(false),[error,setError]=useState(''),[review,setReview]=useState<{head:Head;commercial:SplitCommercialReview;can_write:boolean}|null>(null),[terminal,setTerminal]=useState<Head|null>(null),[confirmed,setConfirmed]=useState(false),[editing,setEditing]=useState(false),[draft,setDraft]=useState(0);
 const canWrite=!readOnly&&['admin','operator'].includes(contextKey.split(':')[2]);
 function refresh(){if(alive.current)setSaved(snapshot());}
 useLayoutEffect(()=>{alive.current=true;const change=(e:StorageEvent)=>{if(e.key===null||e.key===splitIntentKey(actor)||e.key===referenceKey(actor,source.order_id)){setReview(null);setTerminal(null);setConfirmed(false);setEditing(false);refresh();}};window.addEventListener('storage',change);return()=>{alive.current=false;controller.abort();window.removeEventListener('storage',change);};},[]);
 async function run(fn:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{controller.signal.throwIfAborted();await fn();}catch{if(alive.current&&!controller.signal.aborted){setError('Nie udało się potwierdzić operacji. Odczytaj zachowany oryginalny wynik; nie wykonano automatycznego ponowienia.');setReview(null);setConfirmed(false);}}finally{running.current=false;if(alive.current&&!controller.signal.aborted){refresh();setBusy(false);}}}
 async function show(k:Known){
  if(k.phase==='done'){const h=await client.inspect(execution(k));same(h,k.head);if(alive.current){setTerminal(h);setReview(null);}return;}
  need(k.preview.source.version===source.version);const data=await client.reviewPreview(k.preview,{currency:source.currency,shipping_cost:source.shipping_cost,items:source.items});same(data.head,k.head);
  if(alive.current){setReview(data);setTerminal(null);setConfirmed(false);setEditing(false);}
 }
 async function prepare(body:any){await run(async()=>{
  need(canWrite);const intent=validateSplitIntent({schema:'order-split-custody/v1',actor,kind:'preview',serialized:JSON.stringify(body),source:{id:source.order_id,version:source.version,shipping_cost:source.shipping_cost,items:source.items.map(i=>({id:i.id,quantity:i.quantity}))}},actor);
  await client.submit(intent,h=>saveVerified(intent,h));const k=known(actor,source.order_id);need(k);await show(k!);
 });}
 async function recover(){await run(async()=>{
  const held=readSplitIntent(localStorage,actor);
  if(held){need(canWrite&&held.source.id===source.order_id);await client.recover(h=>saveVerified(held,h));}
  const k=known(actor,source.order_id);need(k);await show(k!);
 });}
 async function execute(){await run(async()=>{
  need(canWrite&&confirmed&&review?.can_write&&review.commercial.ready&&!readSplitIntent(localStorage,actor));const k=known(actor,source.order_id);need(k&&k.phase==='preview');same(k!.head,review!.head);const intent=execution(k!);
  const h=await client.submit(intent,value=>saveVerified(intent,value));if(alive.current){setTerminal(h);setReview(null);setConfirmed(false);setEditing(false);}
 });}
 const locked=busy||saved.failed||!!saved.held,foreign=saved.held&&saved.held.source.id!==source.order_id;
 return <section aria-label="Panel podziału zamówienia" className="card">
  <h3>Podziel zamówienie</h3>
  {readOnly&&<p>Dostępny jest tylko odczyt. Zachowane próby pozostają zablokowane do rozliczenia w oryginalnej zapisywalnej kopii.</p>}
  {error&&<p role="alert">{error}</p>}
  {saved.failed&&<p role="alert">Nie można odczytać zapisu lokalnego. Nowe operacje są zablokowane.</p>}
  {saved.held&&<div role="status"><p>Wynik wcześniejszej próby wymaga sprawdzenia. Zachowano jej oryginalną treść i klucz. Nie wysyłaj jej ponownie.</p>{foreign?<button type="button" className="button" disabled={busy} onClick={()=>onOpenOrder(saved.held!.source.id)}>Otwórz zamówienie z zachowaną próbą</button>:<button type="button" className="button" disabled={busy||!canWrite} onClick={()=>void recover()}>Sprawdź oryginalny wynik</button>}</div>}
  {!saved.held&&saved.known&&!review&&!terminal&&!editing&&<div><p>{saved.known.phase==='done'?'Zachowano odniesienie do wykonanego podziału.':'Zachowano podgląd. Odczytaj go przed potwierdzeniem.'}</p><button type="button" className="button" disabled={busy||saved.failed} onClick={()=>void recover()}>{saved.known.phase==='done'?'Odczytaj wynik podziału':'Odczytaj zapisany podgląd'}</button></div>}
  {review&&!saved.held&&<><Commercial data={review.commercial}/>{!review.commercial.ready&&<p role="alert">Podział wymaga rozwiązania różnic rozliczenia pozycji. Nie można go wykonać.</p>}<label><input type="checkbox" aria-label="Potwierdzam przydział i kwoty podziału" checked={confirmed} disabled={locked||!canWrite||!review.can_write||!review.commercial.ready} onChange={e=>setConfirmed(e.target.checked)}/>Potwierdzam przydział pozycji, kwoty i koszt dostawy.</label><div className="actions"><button type="button" className="button primary" disabled={locked||!canWrite||!review.can_write||!confirmed||!review.commercial.ready} onClick={()=>void execute()}>Wykonaj podział</button><button type="button" className="button" disabled={locked||!canWrite||!review.can_write} onClick={()=>{setReview(null);setConfirmed(false);setEditing(true);setDraft(n=>n+1);}}>Zmień przydział</button></div></>}
  {terminal&&!saved.held&&<div role="status"><p>Podział został potwierdzony. Wyniki odczytano z oryginalnej komendy.</p><button type="button" className="button" disabled={busy} onClick={()=>onOpenOrder(terminal.source_order_id)}>Otwórz zamówienie z pozostałymi pozycjami</button>{terminal.children.map((c:any,i:number)=><button type="button" className="button" key={c.slot_id} disabled={busy} onClick={()=>onOpenOrder(c.order_id)}>Otwórz nowe zamówienie {i+1}</button>)}</div>}
  {!review&&!terminal&&(!saved.known||editing||saved.held)&&<OrderSplitAllocationEditor key={draft} source={source} contextKey={contextKey} readOnly={!canWrite} busy={locked||(!editing&&!!saved.known)} onPreview={prepare}/>}
  {busy&&<p role="status">Sprawdzanie oryginalnego podziału…</p>}
 </section>;
}
function Commercial({data}:{data:SplitCommercialReview}){
 return <section aria-label="Kwoty podziału"><h4>Podgląd podziału</h4><p>Kwoty pozycji pochodzą z zapisanego podglądu. VAT dostawy nie jest tu rozliczony.</p><p>Źródło: netto {money(data.original.items_net_minor,data.currency)}, VAT {money(data.original.items_vat_minor,data.currency)}, brutto {money(data.original.items_gross_minor,data.currency)}, dostawa {money(data.original.delivery_minor,data.currency)}, razem {money(data.original.total_minor,data.currency)}.</p>{data.conflicts.map((c,i)=><p role="alert" key={i}>{c.code==='VAT_ROUNDING_CONFLICT'?'Różnica zaokrąglenia VAT w pozycji.':'Kwota pozycji wymaga obsługi rozliczenia dokumentów.'}</p>)}{data.results.map((r,i)=><Result key={r.order_id} result={r} currency={data.currency} index={i}/>)}</section>;
}
function Result({result:r,currency,index}:{result:SplitCommercialReview['results'][number];currency:string;index:number}){
 const [page,setPage]=useState(0),size=25,rows=r.items.slice(page*size,(page+1)*size);
 return <section aria-label={r.kind==='retained_source'?'Pozostaje w zamówieniu':`Nowe zamówienie ${index+1}`}><h5>{r.kind==='retained_source'?'Pozostaje w zamówieniu':r.name}</h5><p>Netto {money(r.items_net_minor,currency)} · VAT {money(r.items_vat_minor,currency)} · Brutto {money(r.items_gross_minor,currency)} · Dostawa {money(r.delivery_minor,currency)} · Razem {money(r.total_minor,currency)}</p><table><thead><tr><th>Pozycja</th><th>Ilość</th><th>Cena źródłowa</th><th>Netto</th><th>VAT</th><th>Brutto</th></tr></thead><tbody>{rows.map(a=><tr key={a.source_item_id}><td>{a.name}<small>{a.sku}</small></td><td>{a.quantity}</td><td>{money(a.price,currency)}</td><td>{money(a.net_minor,currency)}</td><td>{money(a.vat_minor,currency)}</td><td>{money(a.gross_minor,currency)}</td></tr>)}</tbody></table>{r.items.length>size&&<div><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>Poprzednie pozycje</button><span>{page+1}/{Math.ceil(r.items.length/size)}</span><button type="button" disabled={(page+1)*size>=r.items.length} onClick={()=>setPage(page+1)}>Następne pozycje</button></div>}</section>;
}
