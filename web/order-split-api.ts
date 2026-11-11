/** Preparatory ordinary HTTP client. No endpoint registration or split acceptance.
 * Uses the shared workspace transport, including its epoch rejection. The parent
 * MUST abort signal on unmount/principal/readOnly changes, as for a scoped view.
 * Custody preserves original serialized intent; api() sends its exact logical
 * JSON body, not the original wire whitespace. No automatic mutation retry.
 * api() parses JSON itself: this layer makes no streaming/content-type claim. */
import {api} from './api';
import {
  assertHeldSplitIntent, clearSplitIntent, readSplitIntent, retainSplitIntent,
  splitActor, validateSplitIntent, verifySplitCommand, withSplitCustodyLock,
  type SplitAuthorization, type SplitIntent,
} from './order-split-custody';
import {ORDER_SPLIT_LIMITS as L,orderSplitUuid} from '../server/order-splits-schema';

export type OrderSplitRequestAuthority = {
  tenant_id: string; user_id: string; role: string; readOnly: boolean; signal: AbortSignal;
};
export type SplitReviewBasis = {currency:string;shipping_cost:number;items:{id:string;name:string;sku:string;quantity:number;price:number;line_total:number}[]};
export type SplitCommercialItem = {source_item_id:string;target_item_id:string;product_id:string;name:string;sku:string;quantity:number;price:number;vat:number;gross_minor:number;net_minor:number;vat_minor:number;price_adjustment_minor:number;original_quantity:number;original_gross_minor:number;original_net_minor:number;original_vat_minor:number};
type ReviewMoney = {items_gross_minor:number;items_net_minor:number;items_vat_minor:number;delivery_minor:number;total_minor:number};
export type SplitCommercialReview = {schema:'order-split-commercial-review/v1';currency:string;ready:boolean;shipping_tax:'not_allocated';conflicts:{code:'VAT_ROUNDING_CONFLICT'|'INVOICE_LINE_ROUNDING_CONFLICT';source_item_id:string;slot_id:string|null}[];original:ReviewMoney;results:(ReviewMoney&{kind:'child'|'retained_source';slot_id:string|null;order_id:string;name:string|null;items:SplitCommercialItem[]})[]};
/** Storage observer only, after full verification but BEFORE pending custody is
 * cleared. Synchronous failure keeps the original pending intent. Not authority. */
export type SplitVerifiedPersistence = (head:Readonly<Record<string,any>>)=>undefined;
export type SplitLineageBasis={execution_id:string;source_order_id:string;order_id:string;slot_id:string|null};
export type SplitLineageRead={execution_id:string;source_order_id:string;children:{slot_id:string;order_id:string}[]};
const prefix = '/order-splits';
const fail = () => {throw Error('Nie potwierdzono wyniku podziału. Zachowano oryginalną próbę; odczytaj jej wynik.');};
const need: (v:unknown)=>asserts v = (v) => {if (!v) fail();};
const exact = (v: any, fields: string[]) => need(v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join('|') === [...fields].sort().join('|'));
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const canonical = (v: any): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' :
  v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const deepFreeze = <T,>(v:T):T => {if(v&&typeof v==='object'){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v);}return v;};
const headFields = ['id','source_order_id','source_version','source_result_version','scope_hash','children'];
function head(value: any, kind: SplitIntent['kind']) {
  exact(value, [...headFields, ...(kind === 'preview' ? ['ready'] : ['preview_id','state'])]);
  need(Array.isArray(value.children) && value.children.length > 0 && value.children.length < L.results);
  for (const child of value.children) exact(child, ['slot_id','order_id']);
  return value;
}
function command(value: any, intent: SplitIntent) {
  exact(value, ['tenant_id','actor_id','api_key_id','operation','client_key','request',intent.kind === 'preview' ? 'preview' : 'execution']);
  const [tenant, user] = intent.actor.split(':'), body = JSON.parse(intent.serialized);
  need(value.tenant_id === tenant && value.actor_id === user && value.api_key_id === null &&
    value.operation === intent.kind && value.client_key === body.client_key && canonical(value.request) === canonical(body));
  head(value[intent.kind === 'preview' ? 'preview' : 'execution'], intent.kind);
  // All detailed identity, exact request and quantity/delivery checks are shared
  // with the existing custody verifier once the complete pages have arrived.
  return value;
}
function commercial(value:any,intent:SplitIntent,h:any,basis:SplitReviewBasis):SplitCommercialReview {
  exact(value,['schema','currency','ready','shipping_tax','conflicts','original','results']);
  need(value.schema==='order-split-commercial-review/v1'&&value.currency===basis.currency&&value.ready===h.ready&&value.shipping_tax==='not_allocated'&&Array.isArray(value.results)&&Array.isArray(value.conflicts));
  need(basis.shipping_cost===intent.source.shipping_cost&&basis.items.length===intent.source.items.length);
  const original=new Map(basis.items.map(i=>[i.id,i])),source=new Map(intent.source.items.map(i=>[i.id,i.quantity]));need(original.size===basis.items.length);
  for(const i of basis.items)need(source.get(i.id)===i.quantity&&count(i.price,L.unit_price_minor)&&count(i.line_total,L.money_minor)&&typeof i.name==='string'&&typeof i.sku==='string');
  const plan=JSON.parse(intent.serialized),children=new Map(plan.children.map((c:any)=>[c.slot_id,c])),bindings=new Map(h.children.map((c:any)=>[c.slot_id,c.order_id]));
  const orderedSlots=[...children.keys()].sort(),offsets=new Map<string,number>(),expectedConflicts:any[]=[];
  const lineVat=(gross:bigint,rate:number)=>{const d=100n+BigInt(rate);return(2n*gross*BigInt(rate)+d)/(2n*d);};
  need(value.results.length===children.size+1);const seenSlots=new Set(),seenOrders=new Set(),seenItems=new Set(),resultRefs=new Set<string>(),lineSums=new Map<string,{q:bigint;g:bigint;n:bigint;v:bigint;on:number;ov:number;product:string;vat:number}>();let retained=0,rows=0;
  const sums={g:0n,n:0n,v:0n,shipping:0n};
  const money=(m:any)=>{for(const k of ['items_gross_minor','items_net_minor','items_vat_minor','total_minor'])need(count(m[k],L.money_minor));need(count(m.delivery_minor,L.delivery_minor)&&m.items_net_minor+m.items_vat_minor===m.items_gross_minor&&m.items_gross_minor+m.delivery_minor===m.total_minor);};
  for(const [index,r] of value.results.entries()){
    exact(r,['kind','slot_id','order_id','name','items','items_gross_minor','items_net_minor','items_vat_minor','delivery_minor','total_minor']);money(r);need(uuid(r.order_id)&&!seenOrders.has(r.order_id));seenOrders.add(r.order_id);
    need(r.slot_id===(index===orderedSlots.length?null:orderedSlots[index]));let wanted:Map<string,number>;
    if(r.kind==='retained_source'){
      need(r.slot_id===null&&r.order_id===intent.source.id&&r.name===null&&++retained===1);wanted=new Map();
      for(const i of intent.source.items){const moved=plan.children.reduce((n:number,c:any)=>n+c.items.filter((a:any)=>a.source_item_id===i.id).reduce((s:number,a:any)=>s+a.quantity,0),0);if(i.quantity>moved)wanted.set(i.id,i.quantity-moved);}
      need(r.delivery_minor===intent.source.shipping_cost-plan.children.reduce((n:number,c:any)=>n+c.delivery_minor,0));
    }else{
      const child:any=children.get(r.slot_id);need(r.kind==='child'&&child&&!seenSlots.has(r.slot_id)&&bindings.get(r.slot_id)===r.order_id&&child.name===r.name&&child.delivery_minor===r.delivery_minor);seenSlots.add(r.slot_id);wanted=new Map(child.items.map((i:any)=>[i.source_item_id,i.quantity]));
    }
    need(Array.isArray(r.items)&&r.items.length===wanted.size&&r.items.length>0);let g=0n,n=0n,v=0n;const seenSource=new Set();
    for(const a of r.items){
      exact(a,['source_item_id','target_item_id','product_id','name','sku','quantity','price','vat','gross_minor','net_minor','vat_minor','price_adjustment_minor','original_quantity','original_gross_minor','original_net_minor','original_vat_minor']);
      const old=original.get(a.source_item_id);need(old&&wanted.get(a.source_item_id)===a.quantity&&!seenSource.has(a.source_item_id)&&uuid(a.target_item_id)&&uuid(a.product_id)&&!seenItems.has(a.target_item_id));seenSource.add(a.source_item_id);seenItems.add(a.target_item_id);resultRefs.add(String(r.slot_id)+':'+a.source_item_id);
      need(a.name===old.name&&a.sku===old.sku&&a.price===old.price&&[0,5,8,23].includes(a.vat)&&a.original_quantity===old.quantity&&a.original_gross_minor===old.line_total);
      for(const k of ['gross_minor','net_minor','vat_minor','original_net_minor','original_vat_minor'])need(count(a[k],L.money_minor));
      need(a.net_minor+a.vat_minor===a.gross_minor&&a.original_net_minor+a.original_vat_minor===old.line_total&&Number.isSafeInteger(a.price_adjustment_minor)&&BigInt(a.price_adjustment_minor)===BigInt(a.gross_minor)-BigInt(a.price)*BigInt(a.quantity));
      const G=BigInt(old.line_total),Q=BigInt(old.quantity),originalVat=lineVat(G,a.vat),N=G-originalVat,start=offsets.get(a.source_item_id)??0,end=start+a.quantity;
      const g0=G*BigInt(start)/Q,g1=G*BigInt(end)/Q;
      need(end<=old.quantity&&BigInt(a.original_net_minor)===N&&BigInt(a.original_vat_minor)===originalVat&&BigInt(a.gross_minor)===g1-g0&&BigInt(a.net_minor)===(G===0n?0n:N*g1/G-N*g0/G));offsets.set(a.source_item_id,end);
      if(BigInt(a.vat_minor)!==lineVat(BigInt(a.gross_minor),a.vat))expectedConflicts.push({code:'VAT_ROUNDING_CONFLICT',source_item_id:a.source_item_id,slot_id:r.slot_id});
      if(BigInt(a.price_adjustment_minor)>=BigInt(a.quantity))expectedConflicts.push({code:'INVOICE_LINE_ROUNDING_CONFLICT',source_item_id:a.source_item_id,slot_id:r.slot_id});
      if(r.kind==='retained_source')need(a.target_item_id===a.source_item_id);
      const t=lineSums.get(a.source_item_id)??{q:0n,g:0n,n:0n,v:0n,on:a.original_net_minor,ov:a.original_vat_minor,product:a.product_id,vat:a.vat};need(t.on===a.original_net_minor&&t.ov===a.original_vat_minor&&t.product===a.product_id&&t.vat===a.vat);t.q+=BigInt(a.quantity);t.g+=BigInt(a.gross_minor);t.n+=BigInt(a.net_minor);t.v+=BigInt(a.vat_minor);lineSums.set(a.source_item_id,t);g+=BigInt(a.gross_minor);n+=BigInt(a.net_minor);v+=BigInt(a.vat_minor);
    }
    rows+=r.items.length;need(rows<=L.allocation_rows&&g===BigInt(r.items_gross_minor)&&n===BigInt(r.items_net_minor)&&v===BigInt(r.items_vat_minor));sums.g+=g;sums.n+=n;sums.v+=v;sums.shipping+=BigInt(r.delivery_minor);
  }
  need(retained===1&&seenSlots.size===children.size&&lineSums.size===original.size);
  for(const i of basis.items){const t=lineSums.get(i.id);need(t&&t.q===BigInt(i.quantity)&&t.g===BigInt(i.line_total)&&t.n===BigInt(t.on)&&t.v===BigInt(t.ov));}
  exact(value.original,['items_gross_minor','items_net_minor','items_vat_minor','delivery_minor','total_minor']);money(value.original);
  need(sums.g===BigInt(value.original.items_gross_minor)&&sums.n===BigInt(value.original.items_net_minor)&&sums.v===BigInt(value.original.items_vat_minor)&&sums.shipping===BigInt(intent.source.shipping_cost)&&value.original.delivery_minor===intent.source.shipping_cost);
  need(value.conflicts.length<=2*L.allocation_rows&&value.ready===(value.conflicts.length===0));const conflicts=new Set();
  for(const c of value.conflicts){exact(c,['code','source_item_id','slot_id']);need(['VAT_ROUNDING_CONFLICT','INVOICE_LINE_ROUNDING_CONFLICT'].includes(c.code)&&original.has(c.source_item_id)&&(c.slot_id===null||children.has(c.slot_id))&&resultRefs.has(String(c.slot_id)+':'+c.source_item_id));const k=canonical(c);need(!conflicts.has(k));conflicts.add(k);}
  need(canonical([...conflicts].sort())===canonical(expectedConflicts.map(canonical).sort()));
  return deepFreeze(structuredClone(value));
}

export function createOrderSplitApi(authority: OrderSplitRequestAuthority) {
  need(authority && uuid(authority.tenant_id) && uuid(authority.user_id) &&
    typeof authority.role === 'string' && typeof authority.readOnly === 'boolean' &&
    authority.signal && typeof authority.signal.throwIfAborted === 'function');
  const context = Object.freeze({...authority}), actor = splitActor(context.tenant_id + ':' + context.user_id);
  const store = () => globalThis.localStorage;
  function current() {context.signal.throwIfAborted();}
  async function request<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    current();
    try {
      const result = await api<T>(path, method, body, {}, context.signal, (_data, response) => {
        need(response.workspace === context.tenant_id);
      });
      current(); need(size(result) <= L.output_bytes); return result;
    } catch {current(); return fail();}
  }
  async function authorization(write=true): Promise<SplitAuthorization> {
    current(); need(['admin','operator','viewer'].includes(context.role));
    const health = await request('/health');
    need(health?.order_splits_available === true && typeof health.restore_preview==='boolean');
    const me = await request('/auth/me');
    need(me?.user?.tenant_id === context.tenant_id && me.user.id === context.user_id &&
      me.user.role === context.role && typeof me.restore_preview==='boolean'&&me.restore_preview===health.restore_preview);
    const canWrite=!context.readOnly&&['admin','operator'].includes(me.user.role)&&me.restore_preview===false;need(!write||canWrite);
    current(); return {actor, can_write: canWrite, read_only:context.readOnly, restore_preview:me.restore_preview};
  }
  async function pages(path: string, total: number, kind: 'source'|'children') {
    const result: any[] = [], seen = new Set<string>(); let cursor: string|null = null, rows = 0, bytes = 0;
    // More than one empty page or an unfinished/looping cursor is never a result.
    for (let index = 0; index <= total; index++) {
      const page: any = await request(path + (cursor === null ? '' : '?cursor=' + encodeURIComponent(cursor)));
      exact(page, ['data','meta']); exact(page.meta, ['total','cursor']);
      need(page.meta.total === total && Array.isArray(page.data) && page.data.length <= L.source_lines);
      for (const row of page.data) {
        if (kind === 'source') exact(row, ['source_item_id','before_quantity','remaining_quantity']);
        else {
          exact(row, ['slot_id','order_id','delivery_minor','items']); need(Array.isArray(row.items) && row.items.length <= L.allocation_rows);
          for (const item of row.items) exact(item, ['source_item_id','quantity']);
        }
      }
      bytes += size(page); rows += page.data.length;
      need(bytes <= L.output_bytes && rows <= total);
      result.push({requested_cursor: cursor, ...page});
      const next = page.meta.cursor;
      need(next === null || typeof next === 'string' && next.length > 0 && next.length <= 4096 && !seen.has(next));
      if (next === null) {need(rows === total); return result;}
      need(page.data.length > 0 && rows < total); seen.add(next); cursor = next;
    }
    return fail();
  }
  async function evidence(intent:SplitIntent,acknowledged?:any){
    const key = JSON.parse(intent.serialized).client_key;
    const original = command(await request(prefix + '/commands/' + key + '?operation=' + intent.kind), intent);
    const h = original[intent.kind === 'preview' ? 'preview' : 'execution'];
    need(uuid(h.id));
    if (acknowledged) need(canonical(acknowledged) === canonical(h));
    const resource = prefix + '/' + (intent.kind === 'preview' ? 'previews' : 'executions') + '/' + h.id;
    const source = await request(resource + '/source');
    exact(source, ['order_id','version','item_count','shipping_cost']);
    need(count(source.item_count, L.source_lines) && source.item_count === intent.source.items.length);
    const sourcePages = await pages(resource + '/source-items', source.item_count, 'source');
    const childrenPages = await pages(resource + '/children', JSON.parse(intent.kind === 'preview' ? intent.serialized : intent.preview!.serialized).children.length, 'children');
    const readback = {source, source_pages: sourcePages, children_pages: childrenPages};
    verifySplitCommand(original, intent, readback);
    current();return{original,readback,h};
  }
  async function reconcile(intent: SplitIntent, acknowledged?: any,persist?:SplitVerifiedPersistence) {
    assertHeldSplitIntent(store(), intent);const {original,readback,h}=await evidence(intent,acknowledged);
  if(persist){need(typeof persist==='function');current();const returned:unknown=persist(deepFreeze(structuredClone(h)));if(returned&&typeof (returned as any).then==='function')void Promise.resolve(returned).catch(()=>{});need(returned===undefined);current();}
    return clearSplitIntent(store(), intent, original, readback, ()=>authorization());
  }
  return Object.freeze({
    /** Current-order lineage is a separate ordinary read permission. Original
     * command/head recovery remains author-scoped. Backend proves the complete
     * persisted graph; this DTO validator binds navigation to the current event. */
    async lineage(basis:SplitLineageBasis):Promise<Readonly<SplitLineageRead>>{
      exact(basis,['execution_id','source_order_id','order_id','slot_id']);
      const id=(v:unknown)=>typeof v==='string'&&orderSplitUuid.safeParse(v).success&&v===v.toLowerCase();
      need(id(basis.execution_id)&&id(basis.source_order_id)&&id(basis.order_id)&&
        (basis.slot_id===null?basis.order_id===basis.source_order_id:id(basis.slot_id)&&basis.order_id!==basis.source_order_id));
      current();await authorization(false);
      const dto=await request(prefix+'/orders/'+basis.order_id+'/lineage');
      need(size(dto)<=65536);exact(dto,['schema','order_id','lineage']);
      need(dto.schema==='order-split-lineage/v1'&&dto.order_id===basis.order_id&&dto.lineage!==null);
      const value=dto.lineage;exact(value,['execution_id','source_order_id','children']);
      need(value.execution_id===basis.execution_id&&value.source_order_id===basis.source_order_id&&
        Array.isArray(value.children)&&value.children.length>0&&value.children.length<L.results);
      const slots=new Set<string>(),orders=new Set<string>();
      for(const c of value.children){
        exact(c,['slot_id','order_id']);
        need(id(c.slot_id)&&id(c.order_id)&&c.order_id!==basis.source_order_id&&!slots.has(c.slot_id)&&!orders.has(c.order_id));slots.add(c.slot_id);orders.add(c.order_id);
      }
      if(basis.slot_id!==null)need(value.children.some((c:any)=>c.slot_id===basis.slot_id&&c.order_id===basis.order_id));
      await authorization(false);current();
      return deepFreeze(structuredClone(value));
    },
    /** One explicit write, only after custody was durably retained/read back. */
    async submit(value: SplitIntent,persist?:SplitVerifiedPersistence) {
      const intent = validateSplitIntent(value, actor);
      return withSplitCustodyLock(actor, async () => {
        current(); await authorization();
        retainSplitIntent(store(), intent); assertHeldSplitIntent(store(), intent); current();
        const acknowledged = head(await request(prefix + (intent.kind === 'preview' ? '/previews' : '/executions'), 'POST', JSON.parse(intent.serialized)), intent.kind);
        return reconcile(intent, acknowledged,persist);
      });
    },
    /** Explicit user action after refresh/unknown ACK. Never POSTs or replaces a key. */
    async recover(persist?:SplitVerifiedPersistence) {
      return withSplitCustodyLock(actor, async () => {
        current(); const intent = readSplitIntent(store(), actor); need(intent);
        await authorization(); return reconcile(intent!,undefined,persist);
      });
    },
    /** Explicit completed-result read; no retained intent is added/cleared. */
    async inspect(value:SplitIntent){const intent=validateSplitIntent(value,actor);return withSplitCustodyLock(actor,async()=>{current();need(readSplitIntent(store(),actor)===null);await authorization(false);const e=await evidence(intent);await authorization(false);return deepFreeze(structuredClone(e.h));});},
    async reviewPreview(value:SplitIntent,basis:SplitReviewBasis){const intent=validateSplitIntent(value,actor);need(intent.kind==='preview');return withSplitCustodyLock(actor,async()=>{current();need(readSplitIntent(store(),actor)===null);await authorization(false);const e=await evidence(intent);const review=commercial(await request(prefix+'/previews/'+e.h.id+'/commercial'),intent,e.h,basis);const final=await authorization(false);return deepFreeze({head:structuredClone(e.h),commercial:review,can_write:final.can_write});});},
  });
}
