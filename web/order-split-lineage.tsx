/** Read-only navigation from durable current-order events. The dedicated
 * order-scoped GET retains ordinary order permissions; no browser custody is needed. */
import {useEffect,useRef,useState} from 'react';
import {date} from './api';
import {createOrderSplitApi,type SplitLineageBasis,type SplitLineageRead} from './order-split-api';
import {orderSplitUuid} from '../server/order-splits-schema';

type Props={orderId:string;contextKey:string;events:unknown;readOnly:boolean;onOpenOrder:(id:string)=>void};
type EventBasis=SplitLineageBasis&{event_id:string;created_at:string};
const uuid=(v:unknown):v is string=>typeof v==='string'&&v===v.toLowerCase()&&orderSplitUuid.safeParse(v).success;
const need=(v:unknown)=>{if(!v)throw Error('Niekompletna historia podziału');};
function eventBasis(events:unknown,tenant:string,order:string):EventBasis|null{
  need(Array.isArray(events)&&events.length<=10000);
  // Source210 kinds only; the native 222 parent event is plain 'order.split' (own panel).
  const rows=(events as any[]).filter(e=>typeof e?.kind==='string'&&e.kind.startsWith('order.split.'));
  if(!rows.length)return null;
  // The current model refuses repeated splits. Ambiguous/future history must
  // not create a guessed edge or choose the last entry by its timestamp.
  need(rows.length===1&&new TextEncoder().encode(JSON.stringify(rows)).length<=16384);
  const e=rows[0],d=e.detail;
  need(uuid(e.id)&&e.tenant_id===tenant&&e.order_id===order&&
    typeof e.created_at==='string'&&e.created_at.length<=64&&Number.isFinite(Date.parse(e.created_at))&&
    d&&typeof d==='object'&&!Array.isArray(d)&&Object.keys(d).sort().join('|')==='execution_id|slot_id|source_order_id'&&
    uuid(d.execution_id)&&uuid(d.source_order_id));
  need(e.kind==='order.split.source'?d.source_order_id===order&&d.slot_id===null:
    e.kind==='order.split.child'&&d.source_order_id!==order&&uuid(d.slot_id));
  return{event_id:e.id,created_at:e.created_at,execution_id:d.execution_id,source_order_id:d.source_order_id,order_id:order,slot_id:d.slot_id};
}
export function OrderSplitLineage(props:Props){
  try{
    const parts=props.contextKey.split(':');need(parts.length===3&&uuid(parts[0])&&uuid(parts[1])&&['admin','operator','viewer'].includes(parts[2])&&uuid(props.orderId)&&typeof props.readOnly==='boolean');
    const basis=eventBasis(props.events,parts[0],props.orderId);if(!basis)return null;
    return <Lineage key={JSON.stringify([props.contextKey,props.readOnly,basis])} {...props} basis={basis} tenant={parts[0]} user={parts[1]} role={parts[2]}/>;
  }catch{return <section aria-label="Powiązania podziału zamówienia" className="panel"><h2>Powiązania podziału</h2><p role="alert">Nie można potwierdzić zapisanej historii podziału tego zamówienia. Nie pokazano niezweryfikowanych powiązań.</p></section>;}
}
function Lineage({basis,tenant,user,role,...props}:Props&{basis:EventBasis;tenant:string;user:string;role:string}){
  const controller=useRef<AbortController|null>(null),alive=useRef(false),flight=useRef(false);
  const [result,setResult]=useState<Readonly<SplitLineageRead>|null>(null),[busy,setBusy]=useState(false),[unavailable,setUnavailable]=useState(false);
  // StrictMode replays effects in the actual app. Each setup owns a fresh
  // controller; its cleanup cannot permanently abort the next setup's reads.
  useEffect(()=>{const own=new AbortController();controller.current=own;alive.current=true;return()=>{alive.current=false;own.abort();if(controller.current===own)controller.current=null;};},[]);
  async function read(){
    const own=controller.current;if(flight.current||!own||own.signal.aborted)return;flight.current=true;setBusy(true);setUnavailable(false);setResult(null);
    try{
      const client=createOrderSplitApi({tenant_id:tenant,user_id:user,role,readOnly:props.readOnly,signal:own.signal});
      const {execution_id,source_order_id,order_id,slot_id}=basis;
      const value=await client.lineage({execution_id,source_order_id,order_id,slot_id});
      if(alive.current&&!own.signal.aborted)setResult(value);
    }catch{if(alive.current&&!own.signal.aborted)setUnavailable(true);}
    finally{flight.current=false;if(alive.current&&!own.signal.aborted)setBusy(false);}
  }
  return <section aria-label="Powiązania podziału zamówienia" className="panel">
    <h2>Powiązania podziału</h2>
    <p>{basis.slot_id===null?'To zamówienie zachowuje pozostałe pozycje po podziale.':'To zamówienie utworzono przez podział.'} <time dateTime={basis.created_at}>{date(basis.created_at)}</time></p>
    {basis.slot_id!==null&&<button type="button" className="button" onClick={()=>props.onOpenOrder(basis.source_order_id)}>Otwórz zamówienie źródłowe</button>}
    <div className="actions"><button type="button" className="button" disabled={busy} onClick={()=>void read()}>Odczytaj wszystkie wyniki podziału</button></div>
    {busy&&<p role="status">Odczytywanie zapisanych powiązań…</p>}
    {unavailable&&<p role="status">Lista wyników jest niedostępna lub nie można jej potwierdzić w bieżącej sesji. Nie pokazano niezweryfikowanych powiązań. Odczyt nie ponawia podziału.</p>}
    {result&&<ul aria-label="Zapisane wyniki podziału">
      <li>{props.orderId===result.source_order_id?<strong>Bieżące zamówienie — pozostałe pozycje</strong>:<button type="button" className="button" onClick={()=>props.onOpenOrder(result.source_order_id)}>Otwórz zamówienie z pozostałymi pozycjami</button>}</li>
      {result.children.map((c,i)=><li key={c.slot_id}>{c.order_id===props.orderId?<strong>Bieżące zamówienie — wynik {i+1}</strong>:<button type="button" className="button" onClick={()=>props.onOpenOrder(c.order_id)}>Otwórz wynik podziału {i+1}</button>}</li>)}
    </ul>}
  </section>;
}
