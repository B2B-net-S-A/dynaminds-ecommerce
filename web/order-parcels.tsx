import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './order-parcels.css';
import {PhysicalParcelWzPanel,physicalParcelWzLocked,subscribePhysicalParcelWzLock} from './physical-parcel-wz';

export type OrderParcelsProps = {
  orderId: string;
  contextKey: string;
  readOnly: boolean;
  externalWriteBlocked?: boolean;
  refresh?: number;
  onChanged?: () => void;
  onLockedChange?: (locked: boolean) => void;
};
type Attempt = { context: string; owner: string; kind: 'preview' | 'confirm' | 'dispatch' | 'release_preview' | 'release'; path: string; body: string; evidence: unknown };
let actorContext = '', epoch = 0;
let pending: Attempt | null = null, inFlight = false;
let outcome: { attempt: Attempt; reply: unknown } | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(fn => fn());
export function resetOrderParcelsContext(contextKey: string) {
  if (actorContext === contextKey) return;
  actorContext = contextKey; epoch++; pending = null; inFlight = false; outcome = null; knownRejections.clear(); publish();
}
export function getOrderParcelsLocked(contextKey: string) {
  return (actorContext === contextKey && Boolean(pending || inFlight)) || physicalParcelWzLocked(contextKey);
}
export function subscribeOrderParcelsLock(contextKey: string, callback: (locked: boolean) => void) {
  const notify = () => callback(getOrderParcelsLocked(contextKey));
  listeners.add(notify);
  const offPhysical=subscribePhysicalParcelWzLock(contextKey,notify);
  return () => { listeners.delete(notify); offPhysical(); };
}
function purgeAccess(contextKey: string) {
  if (actorContext !== contextKey) return;
  epoch++; pending = null; inFlight = false; outcome = null; publish();
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function canonical(v:unknown):unknown {return Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical((v as Record<string,unknown>)[k])])):v;}
const same = (a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
async function verifyActor(contextKey: string) {
  const parts = contextKey.split(':');
  const r = await api<{user: {tenant_id: string; id: string; role: string}}>('/auth/me');
  if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['true','false'].includes(parts[3]) || !r.user || `${r.user.tenant_id}:${r.user.id}:${r.user.role}` !== parts.slice(0,3).join(':')) throw new ApiError('Kontekst realizacji zmienił się. Otwórz zamówienie ponownie.',403);
}

type Flags = { available: boolean; read_only: boolean; current_role: string | null; can_read: boolean; can_write: boolean };
type Position = { location: string; quantity: number; scanned?: number; consumed_quantity?: number };
type Layer = { layer_id: string; location: string; quantity: number; scanned?: number; consumed_quantity?: number };
type PhysicalProduct = { product_id: string; sku: string; name: string; quantity: number; consumed_quantity: number; released_quantity?: number; remaining: number; scanned: number; locations: Position[]; layers: Layer[] };
type CommercialLine = { item_id:string; product_id:string; sku:string; name:string; quantity:number; line_total:number; vat:number; currency:string; components:{product_id:string;quantity:number}[];origin_available?:boolean;issued?:number|null;cancelled?:number|null;pending?:number|null };
type ParcelItem = CommercialLine & { original_quantity:number };
type Source = {
  order: { id: string; number: string; version: string; status: string; warehouse_id: string; payment_mode: string; currency: string };
  receiver: { name: string; email?: string; address: { street: string; postal_code: string; city: string; country: string; locker_code?: string } };
  products: PhysicalProduct[];
  commercial_available?: boolean; commercial_lines?: CommercialLine[];
  shipments: { id: string; carrier: string; mode: string; tracking_number: string; cod_expected: number; dispatched_at: string | null }[];
  cod_due: number; active_plan_id: string | null; can_preview: boolean; unavailable_reason: string | null; wms_enabled: boolean;
};
type ParcelProduct = { product_id: string; warehouse_id: string; quantity: number; locations: Position[]; lot_holds: Layer[] };
type Parcel = { index: number; source_kind: 'demo' | 'existing'; shipment_id: string; carrier: string; mode: string; tracking_number: string; cod_minor: number; products: ParcelProduct[]; items?:ParcelItem[] };
type Preview = {
  id: string; kind: 'preview'; order_id: string; order_version: string; scope_hash: string; source: Source;
  protocol?:'commercial_v1';
  parcels: Parcel[]; summary: { parcels: number; products: number; physical_quantity: number; cod_minor: number };
  expires_at: string; created_at: string; applied_plan_id: string | null; can_apply: boolean;
};
type Plan = Omit<Preview, 'kind' | 'expires_at' | 'applied_plan_id' | 'can_apply'> & {
  kind: 'plan'; preview_id: string;
  progress: { index: number; shipment_id: string; state: 'pending' | 'dispatched' | 'cancelled'; dispatch_id: string | null; release_id?:string|null }[];
  origins?:{origin_id:string;parcel_index:number;shipment_id:string;item_id:string;quantity:number;issued_quantity:number;cancelled_quantity:number;components:CommercialLine['components'];dispatch_id:string|null}[];
  order_status: string; current_order_version: string; complete: boolean;
};
type ReleaseSource = {plan_id:string;order_id:string;order_version:string;pending:{index:number;shipment_id:string;items:ParcelItem[]}[];products:ParcelProduct[];wms_enabled:boolean;summary:{pending_parcels:number;commercial_quantity:number;physical_quantity:number;issued_parcels:number};released_id:string|null;can_release:boolean};
type ReleasePreview = ReleaseSource & {id:string;scope_hash:string;created_at:string;expires_at:string};
type Release = {id:string;preview_id:string;plan_id:string;order_id:string;scope_hash:string;created_at:string;order_status:'shipped'|'cancelled';receipt:{operation_id:string;cancelled:ReleaseSource['pending'];products:ParcelProduct[];summary:ReleaseSource['summary'];physical_movement:false}};
type ReleaseReply = Flags & {source?:ReleaseSource;preview?:ReleasePreview;release?:Release;reused?:boolean};
type Reply = Flags & { source?: Source; preview?: Preview; plan?: Plan; release_preview?:ReleasePreview;release?:Release;dispatch?: { id: string; plan_id: string; parcel_index: number; shipment_id: string; scope_hash: string; created_at: string }; reused?: boolean };
type Head = { id: string; kind: 'preview' | 'plan'; order_id:string; scope_hash:string; created_at: string; summary: Preview['summary'] };
type Draft = { key: string; source_kind: 'demo' | 'existing'; shipment_id: string; quantities: Record<string,string>; cod: string };
type InputParcel = {source_kind:Draft['source_kind'];shipment_id?:string;items?:{item_id:string;quantity:number}[];products?:{product_id:string;quantity:number}[];cod_minor:number};
const prefix = '/order-parcels';
const releasePrefix = '/order-parcel-releases';
const knownRejections = new Set<string>();
const attemptLabel = (kind:Attempt['kind']) => ({preview:'Przygotowanie podglądu podziału',confirm:'Zapis całego planu',dispatch:'Wydanie jednej paczki',release_preview:'Przygotowanie podglądu anulowania',release:'Anulowanie całej niewydanej reszty'})[kind];
function flags(r: Flags) {
  if (!r || ['available','read_only','can_read','can_write'].some(k=>typeof r[k as keyof Flags]!=='boolean') || (r.current_role!==null && !['admin','operator','viewer'].includes(r.current_role))) throw Error('Niepełny odczyt dostępu do podziału paczek.');
}
function positions(ps: Position[], max: number) {
  if (!Array.isArray(ps) || ps.length>10000 || ps.some(p=>!p || !p.location || !integer(p.quantity,1,max)) || ps.reduce((n,p)=>n+p.quantity,0)>max) throw Error('Niepełny zakres lokalizacji paczki.');
}
function checkSource(s: Source, orderId: string) {
  if (!s || s.order?.id!==orderId || !uuid(s.order.warehouse_id) || !version(s.order.version) || !s.order.number || !s.order.currency || !s.receiver?.name || !s.receiver.address || !Array.isArray(s.products) || s.products.length>500 || new Set(s.products.map(p=>p.product_id)).size!==s.products.length || !integer(s.cod_due,0,2147483647) || typeof s.can_preview!=='boolean' || typeof s.wms_enabled!=='boolean' || (s.active_plan_id!==null && !uuid(s.active_plan_id)) || !Array.isArray(s.shipments) || s.shipments.length>1000 || new Set(s.shipments.map(v=>v.id)).size!==s.shipments.length) throw Error('Niepełny własny zakres realizacji zamówienia.');
  for (const p of s.products) {
    const released=p.released_quantity??0;
    if (!uuid(p.product_id) || !p.sku || !p.name || !integer(p.quantity,1,100000000) || !integer(p.consumed_quantity,0,p.quantity) || !integer(released,0,p.quantity-p.consumed_quantity) || p.remaining!==p.quantity-p.consumed_quantity-released || !integer(p.scanned,0,p.quantity) || !Array.isArray(p.layers)) throw Error('Niepełna fizyczna ilość produktu.');
    positions(p.locations,p.quantity);
    if (p.layers.length>10000 || p.layers.some(v=>!uuid(v.layer_id) || !v.location || !integer(v.quantity,1,p.quantity))) throw Error('Niepełny zakres partii produktu.');
  }
  if (s.shipments.some(v=>!uuid(v.id) || !v.tracking_number || !integer(v.cod_expected,0,2147483647))) throw Error('Niepełna tożsamość przesyłki.');
  if(s.commercial_available!==undefined && typeof s.commercial_available!=='boolean')throw Error('Niepełny dostęp do pozycji sprzedaży.');
  if(s.commercial_available || s.commercial_lines?.length){
    if(!Array.isArray(s.commercial_lines) || !s.commercial_lines.length || s.commercial_lines.length>500 || new Set(s.commercial_lines.map(v=>v.item_id)).size!==s.commercial_lines.length)throw Error('Niepełny zakres oryginalnych pozycji sprzedaży.');
    const physical=new Map<string,number>();
    for(const line of s.commercial_lines){
      if(!uuid(line.item_id) || !uuid(line.product_id) || !line.sku || !line.name || line.currency!==s.order.currency || !integer(line.quantity,1,1000000) || !integer(line.line_total,0,Number.MAX_SAFE_INTEGER) || !integer(line.vat,0,100) || !Array.isArray(line.components) || !line.components.length || line.components.length>500 || new Set(line.components.map(v=>v.product_id)).size!==line.components.length || line.components.some(v=>!uuid(v.product_id) || !integer(v.quantity,1,1000000)))throw Error('Niepełna historyczna pozycja sprzedaży lub skład zestawu.');
      for(const component of line.components)physical.set(component.product_id,(physical.get(component.product_id)??0)+line.quantity*component.quantity);
      if(line.origin_available!==undefined && (typeof line.origin_available!=='boolean' || (line.origin_available? !integer(line.issued,0,line.quantity) || !integer(line.cancelled,0,line.quantity) || !integer(line.pending,0,line.quantity) || line.issued+line.cancelled+line.pending!==line.quantity : line.issued!==null || line.cancelled!==null || line.pending!==null)))throw Error('Niepełne ilości wydane, anulowane i oczekujące pozycji sprzedaży.');
    }
    if(physical.size!==s.products.length || s.products.some(v=>physical.get(v.product_id)!==v.quantity))throw Error('Skład pozycji sprzedaży nie odpowiada pełnej fizycznej rezerwacji.');
  }
}
function checkFrozen(p: Preview | Plan, orderId: string) {
  checkSource(p.source,orderId);
  if (!uuid(p.id) || p.order_id!==orderId || !version(p.order_version) || p.source.order.version!==p.order_version || !sha(p.scope_hash) || !Number.isFinite(Date.parse(p.created_at)) || !Array.isArray(p.parcels) || !integer(p.parcels.length,2,50) || new Set(p.parcels.map(v=>v.shipment_id)).size!==p.parcels.length) throw Error('Niepełny trwały podział paczek.');
  const totals = new Map<string,number>();
  const commercialTotals = new Map<string,number>();
  if(p.protocol!==undefined && p.protocol!=='commercial_v1')throw Error('Nieobsługiwany zapis podziału pozycji.');
  if(p.protocol==='commercial_v1' && !p.source.commercial_lines?.length)throw Error('Brak oryginalnych pozycji zapisanego podziału.');
  let cod = 0, total = 0, entries = 0;
  for (const [i,parcel] of p.parcels.entries()) {
    if (parcel.index!==i || !uuid(parcel.shipment_id) || !['demo','existing'].includes(parcel.source_kind) || !parcel.tracking_number || !parcel.carrier || !parcel.mode || !integer(parcel.cod_minor,0,2147483647) || !Array.isArray(parcel.products) || !parcel.products.length || parcel.products.length>500 || new Set(parcel.products.map(v=>v.product_id)).size!==parcel.products.length) throw Error('Niepełny manifest paczki.');
    cod += parcel.cod_minor;
    if(p.protocol==='commercial_v1'){
      if(!Array.isArray(parcel.items) || !parcel.items.length || new Set(parcel.items.map(v=>v.item_id)).size!==parcel.items.length)throw Error('Niepełne pozycje sprzedaży paczki.');
      const recipe=new Map<string,number>();
      for(const item of parcel.items){
        const original=p.source.commercial_lines!.find(v=>v.item_id===item.item_id);
        if(!original || item.product_id!==original.product_id || item.currency!==original.currency || !integer(item.quantity,1,original.quantity) || item.original_quantity!==original.quantity || item.sku!==original.sku || item.name!==original.name || item.line_total!==original.line_total || item.vat!==original.vat || !same(item.components,original.components))throw Error('Paczka nie odpowiada historycznej pozycji sprzedaży.');
        commercialTotals.set(item.item_id,(commercialTotals.get(item.item_id)??0)+item.quantity);
        for(const c of item.components)recipe.set(c.product_id,(recipe.get(c.product_id)??0)+c.quantity*item.quantity);
      }
      if(recipe.size!==parcel.products.length || parcel.products.some(v=>recipe.get(v.product_id)!==v.quantity))throw Error('Paczka musi zawierać pełny skład wybranych jednostek sprzedaży.');
    }
    for (const product of parcel.products) {
      const original = p.source.products.find(v=>v.product_id===product.product_id);
      if (!original || product.warehouse_id!==p.source.order.warehouse_id || !integer(product.quantity,1,original.quantity)) throw Error('Paczka nie odpowiada oryginalnej fizycznej rezerwacji.');
      positions(product.locations,product.quantity);
      if (!Array.isArray(product.lot_holds) || product.lot_holds.length>10000 || product.lot_holds.some(v=>!uuid(v.layer_id) || !v.location || !integer(v.quantity,1,product.quantity))) throw Error('Niepełny podział partii paczki.');
      entries++;total += product.quantity; totals.set(product.product_id,(totals.get(product.product_id)??0)+product.quantity);
    }
  }
  if (p.source.products.some(v=>totals.get(v.product_id)!==v.quantity) || !p.summary || p.summary.parcels!==p.parcels.length || p.summary.products!==entries || entries>500 || p.summary.physical_quantity!==total || p.summary.cod_minor!==cod || cod!==p.source.cod_due) throw Error('Podział nie obejmuje dokładnie całej fizycznej rezerwacji i pobrania.');
  if(p.protocol==='commercial_v1' && p.source.commercial_lines!.some(v=>commercialTotals.get(v.item_id)!==v.quantity))throw Error('Podział nie obejmuje dokładnie każdej oryginalnej pozycji sprzedaży.');
  if (p.kind==='preview') {
    if (typeof p.can_apply!=='boolean' || !Number.isFinite(Date.parse(p.expires_at)) || (p.applied_plan_id!==null && !uuid(p.applied_plan_id))) throw Error('Niepełny stan podglądu.');
  } else {
    if (!uuid(p.preview_id) || !version(p.current_order_version) || typeof p.complete!=='boolean' || !Array.isArray(p.progress) || p.progress.length!==p.parcels.length || p.progress.some((v,i)=>v.index!==i || v.shipment_id!==p.parcels[i].shipment_id || !['pending','dispatched','cancelled'].includes(v.state) || (v.state==='dispatched'?!uuid(v.dispatch_id):v.dispatch_id!==null) || (v.state==='cancelled'?!uuid(v.release_id):v.release_id!=null)) || p.complete!==p.progress.every(v=>v.state!=='pending')) throw Error('Niepełny postęp realizacji paczek.');
    if(p.protocol==='commercial_v1'){
      const expected=p.parcels.flatMap(parcel=>(parcel.items??[]).map(item=>({parcel,item})));
      if(!Array.isArray(p.origins) || p.origins.length!==expected.length || new Set(p.origins.map(v=>v.origin_id)).size!==p.origins.length || p.origins.some(o=>{const e=expected.find(v=>v.parcel.index===o.parcel_index && v.item.item_id===o.item_id);return !e || !uuid(o.origin_id) || o.shipment_id!==e.parcel.shipment_id || o.quantity!==e.item.quantity || !same(o.components,e.item.components) || o.issued_quantity!==(p.progress[o.parcel_index].state==='dispatched'?o.quantity:0) || o.cancelled_quantity!==(p.progress[o.parcel_index].state==='cancelled'?o.quantity:0) || o.dispatch_id!==p.progress[o.parcel_index].dispatch_id;}))throw Error('Niepełne pochodzenie wydanych pozycji sprzedaży.');
    }
  }
}
function amount(value: string, allowZero=true) {
  if (!/^(?:0|[1-9][0-9]{0,7})(?:[.,][0-9]{1,2})?$/.test(value)) return null;
  const [whole,decimal=''] = value.replace(',','.').split('.');
  const minor = BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0'));
  return minor<=2147483647n && (allowZero || minor>0n) ? Number(minor) : null;
}
function checkReleaseSource(s:ReleaseSource,orderId:string,plan:Plan){
  if(!s || s.order_id!==orderId || s.plan_id!==plan.id || plan.protocol!=='commercial_v1' || !version(s.order_version) || typeof s.can_release!=='boolean' || typeof s.wms_enabled!=='boolean' || (s.released_id!==null && !uuid(s.released_id)) || !Array.isArray(s.pending) || !s.pending.length || s.pending.length>50 || new Set(s.pending.map(p=>p.index)).size!==s.pending.length || !Array.isArray(s.products) || !s.products.length || s.products.length>500 || new Set(s.products.map(p=>p.product_id)).size!==s.products.length)throw Error('Niepełny zakres anulowania niewydanych paczek.');
  const productTotals=new Map<string,number>();let units=0;
  for(const pendingParcel of s.pending){
    const original=plan.parcels[pendingParcel.index];
    if(!original || original.shipment_id!==pendingParcel.shipment_id || !same(pendingParcel.items,original.items))throw Error('Anulowanie nie odpowiada zapisanym pozycjom paczki.');
    units+=pendingParcel.items.reduce((n,item)=>n+item.quantity,0);
    for(const product of original.products)productTotals.set(product.product_id,(productTotals.get(product.product_id)??0)+product.quantity);
  }
  let physical=0;
  for(const product of s.products){
    if(product.warehouse_id!==plan.source.order.warehouse_id || !uuid(product.product_id) || productTotals.get(product.product_id)!==product.quantity)throw Error('Niepełna rezerwacja zwalnianych produktów.');
    positions(product.locations,product.quantity);
    if(product.locations.reduce((n,p)=>n+p.quantity,0)!==product.quantity || !Array.isArray(product.lot_holds) || product.lot_holds.some(p=>!uuid(p.layer_id) || !p.location || !integer(p.quantity,1,product.quantity)))throw Error('Niepełne lokalizacje zwolnienia.');
    if(s.wms_enabled && product.lot_holds.reduce((n,p)=>n+p.quantity,0)!==product.quantity || !s.wms_enabled && product.lot_holds.length)throw Error('Niepełny zakres partii zwolnienia.');
    physical+=product.quantity;
  }
  if(s.products.length!==productTotals.size || !s.summary || s.summary.pending_parcels!==s.pending.length || s.summary.commercial_quantity!==units || s.summary.physical_quantity!==physical || s.summary.issued_parcels+s.pending.length!==plan.parcels.length)throw Error('Niepełne sumy całej niewydanej reszty.');
}
function checkReleasePreview(p:ReleasePreview,orderId:string,plan:Plan){
  checkReleaseSource(p,orderId,plan);
  if(!uuid(p.id) || !sha(p.scope_hash) || !Number.isFinite(Date.parse(p.created_at)) || !Number.isFinite(Date.parse(p.expires_at)))throw Error('Niepełny trwały podgląd anulowania.');
}
function money(n: number,currency: string) { return `${Math.floor(n/100)},${String(n%100).padStart(2,'0')} ${currency}`; }
function reason(value:string) {
  return ({SCANS_INCOMPLETE:'Najpierw zeskanuj pełne ilości i lokalizacje zamówienia.',SHIPPING_ALREADY_STARTED:'Realizacja wysyłki już się rozpoczęła. Ten zakres nie może otrzymać nowego planu.',RESERVATIONS_NOT_PRISTINE:'Rezerwacje zostały już częściowo wykorzystane albo zmienione.',ORDER_NOT_PACKED:'Najpierw zakończ kompletację i spakuj zamówienie.',PLAN_EXISTS:'To zamówienie ma już zapisany plan paczek.',EXTERNAL_OR_MERGED_ORDER:'Ten lokalny proces nie obsługuje zamówień z integracji ani połączeń zamówień.',PREPAYMENT_INCOMPLETE:'Przed wydaniem zamówienia przedpłaconego uzupełnij płatność.'} as Record<string,string>)[value] ?? (/^[A-Z_]+$/.test(value)?'Ten zakres nie jest teraz dostępny do nowego podziału. Odczytaj bieżący plan lub popraw kompletację.':value);
}
function PhysicalTable({source}:{source:Source}) {
  return <div className="op-table"><table><thead><tr><th>Produkt fizyczny</th><th>Cały zakres</th><th>Skany</th><th>Wydano</th><th>Zwolniono po anulowaniu</th><th>Pozostało</th></tr></thead><tbody>{source.products.map(p=><tr key={p.product_id}><td>{p.sku}<br/>{p.name}</td><td>{p.quantity}</td><td>{p.scanned}</td><td>{p.consumed_quantity}</td><td>{p.released_quantity??0}</td><td>{p.remaining}</td></tr>)}</tbody></table></div>;
}
function CommercialTable({source,plan}:{source:Source;plan?:Plan|null}){
  if(!source.commercial_available)return null;
  return <div className="op-table"><table><thead><tr><th>Oryginalna pozycja sprzedaży</th><th>Kwota całej pozycji / VAT</th><th>Sprzedano</th><th>Wydano</th><th>Anulowano niewydane</th><th>Czeka na wydanie</th></tr></thead><tbody>{source.commercial_lines!.map((line,i)=>{
    const count=(state:string)=>plan?.parcels.reduce((n,p)=>n+(plan.progress[p.index]?.state===state?(p.items?.find(v=>v.item_id===line.item_id)?.quantity??0):0),0);
    const value=(name:'issued'|'cancelled'|'pending',state:string)=>line.origin_available===false?'Brak przypisania historycznego':line.origin_available===true?line[name]:plan?.protocol==='commercial_v1'?count(state):'Odczytaj plan';
    return <tr key={line.item_id}><td>Pozycja {i+1} · {line.sku}<br/>{line.name}<small>Pełna jednostka: {line.components.map(c=>`${source.products.find(p=>p.product_id===c.product_id)?.sku??c.product_id} × ${c.quantity}`).join(', ')}</small></td><td>{money(line.line_total,source.order.currency)} / {line.vat}%</td><td>{line.quantity}</td><td>{value('issued','dispatched')}</td><td>{value('cancelled','cancelled')}</td><td>{value('pending','pending')}</td></tr>;
  })}</tbody></table></div>;
}
function Manifest({value}:{value:Preview|Plan}) {
  const r=value.source.receiver;
  return <><p>Odbiorca planu: {r.name}{r.email?` · ${r.email}`:''}<br/>{r.address.street} · {r.address.postal_code} {r.address.city} · {r.address.country}{r.address.locker_code?` · punkt ${r.address.locker_code}`:''}</p>{value.parcels.map(p=><section className="op-parcel" key={p.shipment_id}><h4>Paczka {p.index+1} · {p.tracking_number}</h4><p>{p.carrier} · {p.mode==='demo'?'DEMO — lokalna realizacja':p.mode} · pobranie {money(p.cod_minor,value.source.order.currency)}</p>{value.protocol==='commercial_v1' && <div className="op-table"><table><thead><tr><th>Pozycja sprzedaży</th><th>Pełne jednostki w paczce</th><th>Oryginalna ilość / kwota całej pozycji / VAT</th></tr></thead><tbody>{p.items!.map(item=><tr key={item.item_id}><td>Pozycja {value.source.commercial_lines!.findIndex(v=>v.item_id===item.item_id)+1} · {item.sku}<br/>{item.name}</td><td>{item.quantity}</td><td>{item.original_quantity} / {money(item.line_total,value.source.order.currency)} / {item.vat}%</td></tr>)}</tbody></table></div>}<div className="op-table"><table><thead><tr><th>Produkt fizyczny</th><th>Ilość w paczce</th><th>Lokalizacje / partie wydania</th></tr></thead><tbody>{p.products.map(item=>{const original=value.source.products.find(v=>v.product_id===item.product_id)!;return <tr key={item.product_id}><td>{original.sku}<br/>{original.name}</td><td>{item.quantity}</td><td>{item.locations.map((v,i)=><div key={i}>{v.location} · {v.quantity}</div>)}{item.lot_holds.map((v,i)=><div key={i}>Partia {v.layer_id} · {v.location} · {v.quantity}</div>)}</td></tr>;})}</tbody></table></div></section>)}</>;
}

export function OrderParcelsPanel(props: OrderParcelsProps) {
  const liveExternalWriteBlocked = useRef(props.externalWriteBlocked); liveExternalWriteBlocked.current = props.externalWriteBlocked;
  const identity = `${props.contextKey}:${props.readOnly}:${props.orderId}`, owner = `${props.contextKey}:${props.orderId}`;
  const scope = useRef(identity); scope.current = identity;
  const refreshVersion = props.refresh ?? 0;
  const handledRefresh = useRef({identity,refresh:refreshVersion});
  const [refreshFailed,setRefreshFailed] = useState(false);
  const queuedRefresh = handledRefresh.current.identity!==identity || handledRefresh.current.refresh!==refreshVersion;
  const refreshFence = useRef(false); refreshFence.current = queuedRefresh || refreshFailed;
  const alive = useRef(false), generation = useRef(0), handled = useRef<unknown>(null);
  const [,redraw] = useState(0);
  const [source,setSource] = useState<Source|null>(null), [accessFlags,setAccessFlags] = useState<Flags|null>(null), [loaded,setLoaded] = useState('');
  const [loadedEpoch,setLoadedEpoch] = useState(-1), [reading,setReading] = useState(false), [error,setError] = useState(''), [success,setSuccess] = useState('');
  const [draft,setDraft] = useState<Draft[]>([]), [preview,setPreview] = useState<Preview|null>(null), [plan,setPlan] = useState<Plan|null>(null);
  const [releaseSource,setReleaseSource]=useState<ReleaseSource|null>(null),[releasePreview,setReleasePreview]=useState<ReleasePreview|null>(null),[release,setRelease]=useState<Release|null>(null),[releaseConsent,setReleaseConsent]=useState(false);
  const [consent,setConsent] = useState(false), [dispatchConsent,setDispatchConsent] = useState<number|null>(null), [retryConsent,setRetryConsent] = useState(false);
  const [history,setHistory] = useState<Head[]>([]), [historyKind,setHistoryKind] = useState<'preview'|'plan'>('plan'), [cursor,setCursor] = useState<string|null>(null);
  const cursors = useRef(new Set<string>());
  const active = actorContext===props.contextKey;
  const ownPending = active && pending?.owner===owner ? pending : null;
  const busy = reading || (active && inFlight), locked = getOrderParcelsLocked(props.contextKey);
  const visible = loaded===identity && loadedEpoch===epoch && active;
  const writable = visible && !!accessFlags?.available && accessFlags.can_write && !accessFlags.read_only && !props.readOnly;
  const blocked = !writable || busy || locked || !!props.externalWriteBlocked || refreshFence.current;
  const current = (n:number,e:number,id=identity) => alive.current && scope.current===id && generation.current===n && actorContext===props.contextKey && epoch===e;
  function clearReview() { setPreview(null); setConsent(false); setDispatchConsent(null);setReleaseSource(null);setReleasePreview(null);setReleaseConsent(false); setSuccess(''); }
  function purge() {setSource(null);setAccessFlags(null);setDraft([]);setPreview(null);setPlan(null);setHistory([]);setCursor(null);setConsent(false);setDispatchConsent(null);setRetryConsent(false);setReleaseSource(null);setReleasePreview(null);setRelease(null);setReleaseConsent(false);cursors.current.clear();}
  function fail(err:unknown) {
    if (err instanceof ApiError && [401,403].includes(err.status)) {purgeAccess(props.contextKey);purge();setLoaded('');setLoadedEpoch(-1);}
    setError(err instanceof Error ? err.message : 'Nie udało się odczytać realizacji paczek.');
  }
  async function access():Promise<Reply> {
    await verifyActor(props.contextKey);
    const r=await api<Reply>(`${prefix}/orders/${props.orderId}/source`);flags(r);
    if(r.available && !r.can_read)throw new ApiError('Brak bieżącego dostępu do paczek.',403);
    if(r.available) {if(!r.source)throw Error('Brak pełnego źródła podziału.');checkSource(r.source,props.orderId);}
    await verifyActor(props.contextKey);
    return r;
  }
  async function read<T>(run:(r:Reply)=>Promise<T>|T):Promise<T|null> {
    if(busy)return null;
    const id=identity,n=++generation.current,e=epoch;setReading(true);setError('');
    try {
      const a=await access();if(!current(n,e,id))return null;
      const value=await run(a);const last=await access();if(!current(n,e,id))return null;
      if(!last.available)purge();setAccessFlags(last);setSource(last.source??null);setLoaded(id);setLoadedEpoch(e);return value;
    } catch(err) {if(current(n,e,id))fail(err);return null;}
    finally {if(alive.current && scope.current===id && generation.current===n)setReading(false);}
  }
  async function refresh() {
    const ticket={identity,refresh:refreshVersion};handledRefresh.current=ticket;
    setRefreshFailed(false);clearReview();
    const r=await read(v=>v);
    let ok=!!r;
    if(r?.source?.active_plan_id)ok=await detail('plan',r.source.active_plan_id);
    else if(r)setPlan(null);
    if(alive.current && scope.current===identity && handledRefresh.current===ticket)setRefreshFailed(!ok);
    return ok;
  }
  function consume(r:Reply) {
    clearReview();
    if(r.preview) {setPlan(null);setPreview(r.preview);setSuccess(r.preview.applied_plan_id?'Podgląd ma już zapisany plan.':'Podgląd zapisany. Sprawdź każdą paczkę przed osobną zgodą.');}
    if(r.plan) {setPlan(r.plan);setDraft([]);setSuccess(r.dispatch?'Wydanie tej paczki zapisane. Odczytaj pozostały zakres.':'Plan zapisany. Każdą paczkę wydajesz osobno.');}
    if(r.release_preview){setReleasePreview(r.release_preview);setSuccess('Podgląd anulowania zapisany. Sprawdź cały niewydany zakres przed osobną zgodą.');}
    if(r.release){setRelease(r.release);setSuccess('Anulowano niewydane paczki i zwolniono ich rezerwacje. Wydane paczki pozostają w historii. Nie wykonano wypłaty.');}
  }
  async function validate(r:Reply,a:Attempt) {
    flags(r);if(!r.available || !r.can_read)throw Error('Brak pełnego wyniku zapisanej próby.');
    const body=JSON.parse(a.body);
    if(a.kind==='release_preview'){
      const expected=a.evidence as {source:ReleaseSource;plan:Plan};
      if(!r.release_preview)throw Error('Brak trwałego podglądu anulowania.');
      checkReleasePreview(r.release_preview,props.orderId,expected.plan);
      if(r.release_preview.order_version!==body.order_version || r.release_preview.plan_id!==expected.source.plan_id || !same(r.release_preview.pending,expected.source.pending) || !same(r.release_preview.products,expected.source.products) || !same(r.release_preview.summary,expected.source.summary))throw Error('Podgląd anulowania nie odpowiada zachowanej niewydanej reszcie.');
      return;
    }
    if(a.kind==='release'){
      const expected=a.evidence as ReleasePreview,value=r.release;
      if(!value || !uuid(value.id) || value.receipt?.operation_id!==value.id || value.preview_id!==expected.id || value.plan_id!==expected.plan_id || value.order_id!==props.orderId || value.scope_hash!==body.scope_hash || value.scope_hash!==expected.scope_hash || !Number.isFinite(Date.parse(value.created_at)) || value.order_status!==(expected.summary.issued_parcels>0?'shipped':'cancelled') || value.receipt.physical_movement!==false || !same(value.receipt.cancelled,expected.pending) || !same(value.receipt.products,expected.products) || !same(value.receipt.summary,expected.summary))throw Error('Brak dokładnego potwierdzenia zwolnienia niewydanej reszty.');
      return;
    }
    if(a.kind==='preview') {
      if(!r.preview)throw Error('Brak trwałego podglądu.');checkFrozen(r.preview,props.orderId);
      if(r.preview.protocol!==body.protocol || r.preview.order_version!==body.order_version || r.preview.parcels.length!==body.parcels.length || r.preview.parcels.some((p,i)=>{
        const wanted=body.parcels[i];
        const unitsMatch=body.protocol==='commercial_v1'?p.items!==undefined && p.items.length===wanted.items.length && p.items.every(v=>wanted.items.some((x:{item_id:string;quantity:number})=>x.item_id===v.item_id && x.quantity===v.quantity)):p.products.length===wanted.products.length && p.products.every(v=>wanted.products.some((x:{product_id:string;quantity:number})=>x.product_id===v.product_id && x.quantity===v.quantity));
        return p.source_kind!==wanted.source_kind || (p.source_kind==='existing' && p.shipment_id!==wanted.shipment_id) || p.cod_minor!==wanted.cod_minor || !unitsMatch;
      }))throw Error('Podgląd nie odpowiada dokładnej zachowanej próbie.');
    } else {
      if(!r.plan)throw Error('Brak trwałego planu.');checkFrozen(r.plan,props.orderId);
      const expected=a.evidence as Preview|Plan;checkFrozen(expected,props.orderId);
      if(r.plan.scope_hash!==body.scope_hash || r.plan.scope_hash!==expected.scope_hash || !same(r.plan.parcels,expected.parcels) || !same(r.plan.source,expected.source) || !same(r.plan.summary,expected.summary) || (a.kind==='confirm' && r.plan.preview_id!==expected.id) || (a.kind==='dispatch' && r.plan.id!==expected.id))throw Error('Wynik nie odpowiada zatwierdzonemu zakresowi paczek.');
      if(a.kind==='dispatch') {
        const index=Number(a.path.split('/').at(-2));
        if(!r.dispatch || !uuid(r.dispatch.id) || r.dispatch.plan_id!==r.plan.id || r.dispatch.parcel_index!==index || r.dispatch.shipment_id!==r.plan.parcels[index]?.shipment_id || r.dispatch.scope_hash!==body.scope_hash || r.plan.progress[index]?.dispatch_id!==r.dispatch.id || r.plan.progress[index]?.state!=='dispatched')throw Error('Brak dokładnego potwierdzenia wydania tej paczki.');
      }
    }
  }
  async function write(a:Attempt,retry=false) {
    if(!writable || busy || (!retry && refreshFence.current) || (retry?pending!==a || a.owner!==owner:locked || props.externalWriteBlocked) || a.context!==props.contextKey)return;
    const id=identity,n=++generation.current,e=epoch;setError('');setRetryConsent(false);
    inFlight=true;publish();let sent=false;
    try {
      const f=await access();if(actorContext!==a.context || epoch!==e || props.readOnly || f.read_only || !f.available || !f.can_write || !['admin','operator'].includes(f.current_role??''))throw new ApiError('Brak aktualnego uprawnienia do realizacji paczek.',403);
      if(!retry && refreshFence.current)throw Error('Najpierw odczytaj aktualny zakres paczek.');
      if(!retry && liveExternalWriteBlocked.current)throw Error('Zapis paczek jest zablokowany przez inną zachowaną próbę.');
      if(!retry)pending=a;sent=true;publish();
      const raw=await api<Reply|ReleaseReply>(a.path,'POST',JSON.parse(a.body));
      const r:Reply=a.kind==='release_preview'?{...raw,preview:undefined,source:undefined,release_preview:(raw as ReleaseReply).preview}:a.kind==='release'?{...raw,source:undefined,preview:undefined}:raw as Reply;
      await validate(r,a);
      if(r.release){const fresh=await api<Reply>(`${prefix}/plans/${r.release.plan_id}`);flags(fresh);if(!fresh.can_read || !fresh.plan || fresh.plan.id!==r.release.plan_id)throw Error('Niepełny odczyt planu po anulowaniu.');checkFrozen(fresh.plan,props.orderId);if(r.release.receipt.cancelled.some(p=>fresh.plan!.progress[p.index].release_id!==r.release!.id || fresh.plan!.progress[p.index].state!=='cancelled'))throw Error('Plan nie potwierdza anulowania wszystkich niewydanych paczek.');r.plan=fresh.plan;}
      const last=await access();
      if(actorContext!==a.context || epoch!==e)return;
      if(!last.available || !last.can_write || last.read_only)throw new ApiError('Dostęp zmienił się po zapisie. Sprawdź trwałą historię.',403);
      pending=null;outcome={attempt:a,reply:r};
      if(alive.current && scope.current===id && generation.current===n) {handled.current=r;setAccessFlags(last);setSource(last.source??null);setLoaded(id);setLoadedEpoch(e);consume(r);if(!['preview','release_preview'].includes(a.kind))props.onChanged?.();}
    } catch(err) {
      if(actorContext===a.context && epoch===e) {
        const known=err instanceof ApiError && err.status>=400 && err.status<500 && ![408,429].includes(err.status);
        if((!retry && !sent) || (sent && known))pending=null;
        if(known && a.kind==='confirm')knownRejections.add((a.evidence as Preview).id);
        if(known && a.kind==='release')knownRejections.add((a.evidence as ReleasePreview).id);
        if(alive.current && scope.current===id && generation.current===n) {setConsent(false);setDispatchConsent(null);setReleaseConsent(false);fail(err);}
      }
    } finally {if(actorContext===a.context && epoch===e) {inFlight=false;publish();}}
  }
  function newDraft():Draft {return {key:crypto.randomUUID(),source_kind:'demo',shipment_id:'',quantities:{},cod:''};}
  function changeDraft(index:number,change:Partial<Draft>) {setDraft(v=>v.map((p,i)=>i===index?{...p,...change}:p));clearReview();setError('');}
  function editor() {if(blocked || !source?.can_preview)return;clearReview();setPlan(null);setDraft([newDraft(),newDraft()]);}
  const commercial=source?.commercial_available===true;
  const editableLines=commercial?(source!.commercial_lines??[]).map((v,i)=>({id:v.item_id,sku:v.sku,name:v.name,quantity:v.quantity,line_total:v.line_total,vat:v.vat,ordinal:i+1})):source?.products.map((v,i)=>({id:v.product_id,sku:v.sku,name:v.name,quantity:v.quantity,line_total:undefined,vat:undefined,ordinal:i+1}))??[];
  const errors:string[]=[];
  const input:InputParcel[]=draft.map((p,i)=>{
    const units: {id:string;quantity:number}[]=[];
    for(const product of editableLines) {
      const raw=p.quantities[product.id]??'';
      if(raw==='')continue;
      if(!/^(?:0|[1-9][0-9]{0,7})$/.test(raw) || !integer(Number(raw),0,Math.min(product.quantity,1000000)))errors.push(`Paczka ${i+1}: podaj poprawną ilość ${product.sku}, najwyżej ${Math.min(product.quantity,1000000)}.`);
      else if(Number(raw)>0)units.push({id:product.id,quantity:Number(raw)});
    }
    const cod=source?.order.payment_mode==='cod'?amount(p.cod):0;
    if(cod===null)errors.push(`Paczka ${i+1}: podaj jawną kwotę pobrania, także 0.`);
    if(!units.length)errors.push(`Paczka ${i+1}: wybierz co najmniej jedną ${commercial?'pełną jednostkę pozycji sprzedaży':'fizyczną ilość'}.`);
    if(p.source_kind==='existing' && !source?.shipments.some(s=>s.id===p.shipment_id && !s.dispatched_at))errors.push(`Paczka ${i+1}: wybierz własną niewydaną przesyłkę.`);
    const existing=p.source_kind==='existing'?source?.shipments.find(s=>s.id===p.shipment_id):null;
    if(existing && cod!==null && cod!==existing.cod_expected)errors.push(`Paczka ${i+1}: pobranie istniejącej przesyłki musi pozostać ${money(existing.cod_expected,source!.order.currency)}.`);
    return {source_kind:p.source_kind,...(p.source_kind==='existing'?{shipment_id:p.shipment_id}:{}),...(commercial?{items:units.map(v=>({item_id:v.id,quantity:v.quantity}))}:{products:units.map(v=>({product_id:v.id,quantity:v.quantity}))}),cod_minor:cod??0};
  });
  if(draft.length && source) {
    if(input.reduce((n,p)=>n+(p.items?.length??p.products?.length??0),0)>500)errors.push('Pełny podział może zawierać najwyżej 500 pozycji.');
    for(const p of editableLines)if(input.reduce((n,parcel)=>n+(commercial?parcel.items?.find(v=>v.item_id===p.id)?.quantity??0:parcel.products?.find(v=>v.product_id===p.id)?.quantity??0),0)!==p.quantity)errors.push(`Pozycja ${p.ordinal} · ${p.sku}: rozdziel dokładnie ${p.quantity} jednostek między wszystkie paczki.`);
    if(input.reduce((n,p)=>n+p.cod_minor,0)!==source.cod_due)errors.push(`Pobranie wszystkich paczek musi wynosić ${money(source.cod_due,source.order.currency)}.`);
    const selected=input.filter(p=>p.source_kind==='existing').map(p=>p.shipment_id);if(new Set(selected).size!==selected.length)errors.push('Jedna przesyłka nie może wystąpić w dwóch paczkach.');
    if(source.shipments.some(s=>!selected.includes(s.id)))errors.push('Uwzględnij w planie każdą już istniejącą przesyłkę zamówienia.');
  }
  function prepare() {
    if(blocked || !source?.can_preview || !integer(input.length,2,50) || errors.length)return;
    void write({context:props.contextKey,owner,kind:'preview',path:`${prefix}/orders/${props.orderId}/previews`,body:JSON.stringify({client_key:crypto.randomUUID(),order_version:source.order.version,...(commercial?{protocol:'commercial_v1'}:{}),parcels:input}),evidence:source});
  }
  function confirm() {
    if(blocked || !preview || !preview.can_apply || preview.applied_plan_id || knownRejections.has(preview.id) || Date.parse(preview.expires_at)<=Date.now() || !consent)return;
    void write({context:props.contextKey,owner,kind:'confirm',path:`${prefix}/previews/${preview.id}/apply`,body:JSON.stringify({client_key:crypto.randomUUID(),scope_hash:preview.scope_hash,confirmed:true}),evidence:preview});
  }
  function dispatch(index:number) {
    if(blocked || !plan || plan.complete || plan.order_status!=='packed' || plan.progress[index]?.state!=='pending' || dispatchConsent!==index)return;
    void write({context:props.contextKey,owner,kind:'dispatch',path:`${prefix}/plans/${plan.id}/parcels/${index}/dispatch`,body:JSON.stringify({client_key:crypto.randomUUID(),scope_hash:plan.scope_hash,confirmed:true}),evidence:plan});
  }
  async function readRemainder(){
    if(!plan || plan.protocol!=='commercial_v1')return;
    const expected=plan;
    const r=await read(async()=>{const value=await api<ReleaseReply>(`${releasePrefix}/plans/${expected.id}/source`);flags(value);if(!value.can_read || !value.source)throw Error('Brak pełnego zakresu niewydanej reszty.');checkReleaseSource(value.source,props.orderId,expected);return value;});
    if(r?.source){setReleaseSource(r.source);setReleasePreview(null);setReleaseConsent(false);setError('');}
  }
  function prepareRelease(){
    if(blocked || !plan || !releaseSource?.can_release || releaseSource.released_id)return;
    setReleaseConsent(false);
    void write({context:props.contextKey,owner,kind:'release_preview',path:`${releasePrefix}/plans/${plan.id}/previews`,body:JSON.stringify({client_key:crypto.randomUUID(),order_version:releaseSource.order_version}),evidence:{source:releaseSource,plan}});
  }
  function confirmRelease(){
    if(blocked || !releasePreview || !releasePreview.can_release || releasePreview.released_id || knownRejections.has(releasePreview.id) || Date.parse(releasePreview.expires_at)<=Date.now() || !releaseConsent)return;
    void write({context:props.contextKey,owner,kind:'release',path:`${releasePrefix}/previews/${releasePreview.id}/release`,body:JSON.stringify({client_key:crypto.randomUUID(),scope_hash:releasePreview.scope_hash,confirmed:true}),evidence:releasePreview});
  }
  async function releaseDetail(id:string){
    const expected=plan;
    const r=await read(async()=>{const value=await api<ReleaseReply>(`${releasePrefix}/releases/${id}`);flags(value);if(!value.can_read || !value.release || value.release.id!==id || value.release.order_id!==props.orderId || !expected || value.release.plan_id!==expected.id || !sha(value.release.scope_hash) || !Number.isFinite(Date.parse(value.release.created_at)) || value.release.receipt?.physical_movement!==false || value.release.receipt.operation_id!==id)throw Error('Niepełne potwierdzenie anulowania.');checkReleaseSource({plan_id:expected.id,order_id:props.orderId,order_version:expected.current_order_version,pending:value.release.receipt.cancelled,products:value.release.receipt.products,summary:value.release.receipt.summary,wms_enabled:expected.source.wms_enabled,released_id:id,can_release:false},props.orderId,expected);return value;});
    if(r?.release)setRelease(r.release);
  }
  async function detail(kind:'preview'|'plan',id:string) {
    const r=await read(async()=>{const value=await api<Reply>(`${prefix}/${kind==='preview'?'previews':'plans'}/${id}`);flags(value);const result=kind==='preview'?value.preview:value.plan;if(!value.can_read || !result || result.id!==id || result.kind!==kind)throw Error('Niepełny trwały wynik własnego podziału.');checkFrozen(result,props.orderId);return value;});
    if(r)consume(r);
    return !!r;
  }
  async function loadHistory(kind:'preview'|'plan',next:string|null=null) {
    const r=await read(async()=>{const v=await api<Flags&{data:Head[];next_cursor:string|null}>(`${prefix}/orders/${props.orderId}/history?`+new URLSearchParams({kind,limit:'50',...(next?{cursor:next}:{})}));flags(v);if(!v.can_read || !Array.isArray(v.data) || v.data.length>50 || new Set(v.data.map(h=>h.id)).size!==v.data.length || v.data.some(h=>!uuid(h.id) || h.kind!==kind || h.order_id!==props.orderId || !sha(h.scope_hash) || !Number.isFinite(Date.parse(h.created_at)) || !integer(h.summary?.parcels,2,50)) || (v.next_cursor!==null && (!uuid(v.next_cursor) || v.next_cursor===next || cursors.current.has(v.next_cursor))))throw Error('Niepełna strona historii paczek.');return v;});
    if(r) {if(!next)cursors.current.clear();if(r.next_cursor)cursors.current.add(r.next_cursor);setHistory(r.data);setHistoryKind(kind);setCursor(r.next_cursor);}
  }
  useEffect(()=>{alive.current=true;resetOrderParcelsContext(props.contextKey);const off=subscribeOrderParcelsLock(props.contextKey,locked=>{redraw(v=>v+1);props.onLockedChange?.(locked);});return()=>{alive.current=false;generation.current++;off();};},[props.contextKey]);
  useEffect(()=>{handledRefresh.current={identity,refresh:refreshVersion};setRefreshFailed(false);generation.current++;purge();setReading(false);setLoaded('');setLoadedEpoch(-1);handled.current=null;setError('');setSuccess('');void refresh();},[identity]);
  useEffect(()=>{if(loadedEpoch!==-1 && loadedEpoch!==epoch)purge();if(active && outcome?.attempt.owner===owner && handled.current!==outcome.reply) {handled.current=outcome.reply;consume(outcome.reply as Reply);}},[active,epoch,outcome,owner,loadedEpoch]);
  // Read only when the same-order parent snapshot advances; never replay a pending write.
  useEffect(()=>{if(active && loaded===identity && !busy && !locked && queuedRefresh)void refresh();},[identity,refreshVersion,active,loaded,busy,locked]);
  useEffect(()=>{const timer=window.setInterval(()=>redraw(v=>v+1),5000);return()=>window.clearInterval(timer);},[]);
  return <section className="panel order-parcels" aria-label="Podział zamówienia na paczki">
    <div className="op-heading"><div><h3>Podział zamówienia na paczki</h3><p>Sprawdź zakres planu i przypisanie towaru do paczek. Każda paczka wymaga osobnego potwierdzenia wydania.</p></div><button className="button" disabled={busy} onClick={()=>void refresh()}>Odczytaj realizację paczek</button></div>
    {(queuedRefresh || refreshFailed) && <p className="notice" role="status">Zakres paczek wymaga aktualnego odczytu. Nowe zapisy są zablokowane.</p>}
    {error && <p className="error" role="alert">{error}</p>}{success && <p role="status">{success}</p>}
    {!visible?<p>Odczytaj aktualny dostęp i pełny zakres zamówienia.</p>:!accessFlags?.available?<p>Ta kopia nie udostępnia podziału ilości między paczki.</p>:<>
      {(props.readOnly || accessFlags.read_only || !accessFlags.can_write) && <p>Widok tylko do odczytu. Przygotowanie i wydanie paczek są zablokowane.</p>}
      {source && <><h4>{source.order.number} · {commercial?'zakres pozycji sprzedaży':'fizyczny zakres realizacji'}</h4><CommercialTable source={source} plan={plan}/><PhysicalTable source={source}/><p>{plan && plan.protocol!=='commercial_v1'?'Ten plan dzieli fizyczne składniki między paczki. Przypisanie składników do historycznych pozycji zamówienia znajduje się poniżej.':commercial?'Każda pozycja sprzedaży zachowuje własną ilość, kwotę i historyczny skład. Zestaw dzielisz wyłącznie na pełne jednostki.':'Starszy zakres pokazuje wyłącznie rezerwacje fizyczne; nie przypisujemy ich do nieudokumentowanych pozycji sprzedaży.'}</p>{!source.active_plan_id && source.unavailable_reason && <p>{reason(source.unavailable_reason)}</p>}</>}
      {locked && <div className="op-pending"><p>Wynik próby może być nieznany. Zachowano dokładną treść i klucz. Odczyt historii nie usuwa blokady.</p>{ownPending?<><p>{attemptLabel(ownPending.kind)} · własne zamówienie {source?.order.number??props.orderId}</p><label className="op-check"><input type="checkbox" checked={retryConsent} disabled={!writable || busy} onChange={e=>setRetryConsent(e.target.checked)}/>Potwierdzam ręczne ponowienie tej samej próby</label><button className="button" disabled={!writable || busy || !retryConsent} onClick={()=>void write(ownPending,true)}>Ponów dokładnie zachowaną próbę</button></>:<p>Otwórz zamówienie właściciela zachowanej próby. Nowe operacje pozostają zablokowane.</p>}</div>}
      {source?.can_preview && !source.active_plan_id && <button className="button" disabled={blocked} onClick={editor}>Rozdziel ilości na paczki</button>}
      {!!draft.length && !plan && <fieldset disabled={blocked}><p>Wpisz ilości każdej paczki. Puste pole nie przydziela pozycji; 0 oznacza jawną ilość zero. Wszystkie ilości muszą dokładnie pokrywać {commercial?'każdą oryginalną pozycję sprzedaży':'pełną rezerwację'}.</p>{draft.map((p,i)=><div className="op-parcel" key={p.key}><h4>Paczka {i+1}</h4><div className="op-grid"><label>Źródło przesyłki<select value={p.source_kind} onChange={e=>changeDraft(i,{source_kind:e.target.value as Draft['source_kind'],shipment_id:''})}><option value="demo">Nowa przesyłka DEMO</option><option value="existing">Istniejąca własna przesyłka</option></select></label>{p.source_kind==='existing' && <label>Przesyłka<select value={p.shipment_id} onChange={e=>changeDraft(i,{shipment_id:e.target.value})}><option value="">Wybierz przesyłkę</option>{source?.shipments.filter(s=>!s.dispatched_at).map(s=><option key={s.id} value={s.id}>{s.tracking_number} · {s.carrier} · {s.mode}</option>)}</select></label>}{source?.order.payment_mode==='cod' && <label>Pobranie tej paczki · {source.order.currency}<input aria-label={`Pobranie paczki ${i+1}`} inputMode="decimal" value={p.cod} onChange={e=>changeDraft(i,{cod:e.target.value})}/></label>}</div><div className="op-table"><table><thead><tr><th>{commercial?'Pozycja sprzedaży':'Produkt fizyczny'}</th>{commercial && <th>Kwota całej pozycji / VAT</th>}<th>Pełna ilość</th><th>Ilość tej paczki</th></tr></thead><tbody>{editableLines.map(product=><tr key={product.id}><td>{commercial?`Pozycja ${product.ordinal} · `:''}{product.sku}<br/>{product.name}</td>{commercial && <td>{money(product.line_total!,source!.order.currency)} / {product.vat}%</td>}<td>{product.quantity}</td><td><input aria-label={commercial?`Paczka ${i+1} pozycja ${product.ordinal} ${product.sku}`:`Paczka ${i+1} ${product.sku}`} inputMode="numeric" value={p.quantities[product.id]??''} onChange={e=>changeDraft(i,{quantities:{...p.quantities,[product.id]:e.target.value}})}/></td></tr>)}</tbody></table></div><button className="button" disabled={draft.length<=2} onClick={()=>{setDraft(v=>v.filter((_,n)=>n!==i));clearReview();}}>Usuń paczkę</button></div>)}<div className="op-actions"><button className="button" disabled={draft.length>=50} onClick={()=>{setDraft(v=>[...v,newDraft()]);clearReview();}}>Dodaj paczkę</button><button className="button primary" disabled={!!errors.length} onClick={prepare}>Przygotuj pełny podgląd podziału</button></div>{!!errors.length && <ul>{errors.map((v,i)=><li key={i}>{v}</li>)}</ul>}<p>DEMO tworzy lokalny zakres bez nadania u przewoźnika. Podgląd nie wydaje towaru.</p></fieldset>}
      {preview && <div className="op-review"><h4>Podgląd całego podziału</h4><p>{preview.summary.parcels} paczek · {preview.summary.physical_quantity} fizycznych jednostek · ważny do {date(preview.expires_at)}</p><Manifest value={preview}/>{preview.applied_plan_id?<button className="button" disabled={busy} onClick={()=>void detail('plan',preview.applied_plan_id!)}>Odczytaj zapisany plan</button>:<><p>Zapis planu utworzy wybrane przesyłki DEMO, ale nie wyda towaru. Każde wydanie wymaga osobnej zgody.</p>{knownRejections.has(preview.id) && <p className="error">Ten podgląd został odrzucony. Odczytaj bieżący zakres i przygotuj nowy podgląd.</p>}<label className="op-check"><input type="checkbox" checked={consent} disabled={blocked || !preview.can_apply || knownRejections.has(preview.id) || Date.parse(preview.expires_at)<=Date.now()} onChange={e=>setConsent(e.target.checked)}/>Sprawdziłem wszystkie ilości, przesyłki i pobrania. Potwierdzam zapis całego planu.</label><button className="button primary" disabled={blocked || !consent || !preview.can_apply || knownRejections.has(preview.id) || Date.parse(preview.expires_at)<=Date.now()} onClick={confirm}>Zapisz cały plan paczek</button></>}</div>}
      {plan && <div className="op-review">
        <h4>Realizacja zapisanego planu</h4>
        <p>Zamówienie: {plan.order_status==='packed'?'Spakowane — pozostałe paczki czekają na wydanie':plan.complete?plan.progress.every(p=>p.state==='dispatched')?'Wszystkie paczki wydane':'Realizacja paczek zakończona':plan.order_status} · wydano {plan.progress.filter(p=>p.state==='dispatched').length} z {plan.parcels.length} paczek · anulowano {plan.progress.filter(p=>p.state==='cancelled').length} · oczekuje {plan.progress.filter(p=>p.state==='pending').length}</p>
        <Manifest value={plan}/>
        {plan.protocol!=='commercial_v1' && <PhysicalParcelWzPanel contextKey={props.contextKey} readOnly={props.readOnly} orderId={props.orderId} planId={plan.id} externalWriteBlocked={busy || (active && Boolean(pending || inFlight)) || !!props.externalWriteBlocked} onChanged={props.onChanged}/>}
        {plan.progress.map(p=><div className="op-parcel" key={p.shipment_id}>
          <h4>Paczka {p.index+1} · {plan.parcels[p.index].tracking_number}</h4>
          {p.state==='dispatched'?<p>Wydanie zapisane. Tej paczki nie wydawaj ponownie.</p>:p.state==='cancelled'?<><p>Niewydany zakres anulowany. Rezerwację zwolniono; tej paczki nie można wydać.</p><button className="button" disabled={busy} onClick={()=>void releaseDetail(p.release_id!)}>Odczytaj potwierdzenie anulowania</button></>:<>
            <p>Wydanie zużyje tylko ilości tej paczki. Pozostałe rezerwacje pozostaną do następnych wydań.</p>
            <label className="op-check"><input type="checkbox" aria-label={`Potwierdzam wydanie paczki ${p.index+1}`} checked={dispatchConsent===p.index} disabled={blocked || plan.order_status!=='packed'} onChange={e=>setDispatchConsent(e.target.checked?p.index:null)}/>Potwierdzam rzeczywiste wydanie paczki {p.index+1}{plan.parcels[p.index].mode==='demo'?' w lokalnym trybie DEMO':''}.</label>
            <button className="button primary" disabled={blocked || plan.order_status!=='packed' || dispatchConsent!==p.index} onClick={()=>dispatch(p.index)}>Wydaj paczkę {p.index+1}</button>
          </>}
        </div>)}
        <button className="button" disabled={busy} onClick={()=>void detail('plan',plan.id)}>Odczytaj aktualny postęp planu</button>
        {plan.protocol==='commercial_v1' && !plan.complete && plan.source.order.payment_mode==='prepaid' && <div className="op-release">
          <h4>Anulowanie niewydanej reszty</h4>
          <p>Obejmuje wszystkie paczki, które nadal czekają na wydanie. Zwolnienie rezerwacji nie przyjmuje towaru i nie zwraca środków klientowi.</p>
          <button className="button" disabled={busy} onClick={()=>void readRemainder()}>Odczytaj niewydaną resztę</button>
          {releaseSource && <><p>Niewydane paczki: {releaseSource.summary.pending_parcels} · pełne jednostki sprzedaży: {releaseSource.summary.commercial_quantity} · fizyczne sztuki: {releaseSource.summary.physical_quantity}</p><button className="button" disabled={blocked || !releaseSource.can_release || !!releaseSource.released_id} onClick={prepareRelease}>Przygotuj podgląd anulowania reszty</button></>}
        </div>}
      </div>}
      {releasePreview && <div className="op-review op-release"><h4>Pełny podgląd anulowania niewydanej reszty</h4>
        <p>Ważny do {date(releasePreview.expires_at)}. Wydane paczki: {releasePreview.summary.issued_parcels} · anulowane zostaną {releasePreview.summary.pending_parcels} niewydane paczki.</p>
        {releasePreview.pending.map(p=><section key={p.shipment_id}><h5>Paczka {p.index+1}</h5>{p.items.map(item=><p key={item.item_id}>{item.sku} · {item.name} · {item.quantity} pełnych jednostek · historyczna kwota całej pozycji {money(item.line_total,source?.order.currency??item.currency)} / VAT {item.vat}%</p>)}</section>)}
        <div className="op-table"><table><thead><tr><th>Produkt fizyczny</th><th>Zwolnij rezerwację</th><th>Lokalizacje / partie</th></tr></thead><tbody>{releasePreview.products.map(p=><tr key={p.product_id}><td>{source?.products.find(v=>v.product_id===p.product_id)?.sku}<br/>{source?.products.find(v=>v.product_id===p.product_id)?.name}</td><td>{p.quantity}</td><td>{p.locations.map(l=><div key={l.location}>{l.location} · {l.quantity}</div>)}{p.lot_holds.map(l=><div key={`${l.layer_id}:${l.location}`}>Partia {l.layer_id} · {l.location} · {l.quantity}</div>)}</td></tr>)}</tbody></table></div>
        <p>Stan fizyczny i historyczne skany pozostaną zachowane. Zmniejszą się wyłącznie rezerwacje niewydanych ilości. Nie powstanie przyjęcie magazynowe ani wypłata.</p>
        {releasePreview.released_id?<button className="button" disabled={busy} onClick={()=>void releaseDetail(releasePreview.released_id!)}>Odczytaj potwierdzenie anulowania</button>:<>
          {knownRejections.has(releasePreview.id) && <p className="error">Ten zakres został odrzucony. Odczytaj plan i przygotuj świeży podgląd anulowania.</p>}
          <label className="op-check"><input type="checkbox" checked={releaseConsent} disabled={blocked || !releasePreview.can_release || knownRejections.has(releasePreview.id) || Date.parse(releasePreview.expires_at)<=Date.now()} onChange={e=>setReleaseConsent(e.target.checked)}/>Sprawdziłem wszystkie niewydane pozycje. Potwierdzam anulowanie całej niewydanej reszty i zwolnienie rezerwacji.</label>
          <button className="button primary" disabled={blocked || !releaseConsent || !releasePreview.can_release || knownRejections.has(releasePreview.id) || Date.parse(releasePreview.expires_at)<=Date.now()} onClick={confirmRelease}>Anuluj niewydaną resztę</button>
        </>}
      </div>}
      {release && <div className="op-review op-release"><h4>Zapisane anulowanie niewydanej reszty</h4><p>{date(release.created_at)} · anulowano {release.receipt.summary.pending_parcels} paczek i {release.receipt.summary.commercial_quantity} pełnych jednostek sprzedaży. Wydane paczki: {release.receipt.summary.issued_parcels}.</p><p>Nie wykonano ruchu fizycznego ani wypłaty. Końcowy status: {release.order_status==='shipped'?'wydany zakres pozostaje wysłany':'zamówienie anulowane'}.</p><button className="button" disabled={busy} onClick={()=>void detail('plan',release.plan_id)}>Odczytaj plan po anulowaniu</button></div>}
      <div className="op-history"><h4>Historia podziału</h4><div className="op-actions"><button className="button" disabled={busy} onClick={()=>void loadHistory('preview')}>Odczytaj podglądy podziału</button><button className="button" disabled={busy} onClick={()=>void loadHistory('plan')}>Odczytaj zapisane plany</button></div>{history.map(h=><div key={h.id} className="op-history-row"><span>{date(h.created_at)} · {h.kind==='plan'?'Plan':'Podgląd'} · paczki {h.summary.parcels}</span><button className="button" disabled={busy} onClick={()=>void detail(h.kind,h.id)}>Odczytaj pełny podział</button></div>)}{cursor && <button className="button" disabled={busy} onClick={()=>void loadHistory(historyKind,cursor)}>Następna strona historii podziału</button>}</div>
    </>}
  </section>;
}
