import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';

const money = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(n => BigInt(n) <= BigInt(Number.MAX_SAFE_INTEGER));
const line = z.strictObject({ item_id:z.uuid(), original_quantity:z.number().int().positive(), issued_quantity:z.number().int().nonnegative(), cancelled_quantity:z.number().int().nonnegative(), original_gross_minor:money, issued_gross_minor:money, cancelled_gross_minor:money });
const schema = z.strictObject({ protocol:z.literal('partial_commercial_sale204/v1'), order_id:z.uuid(), plan_id:z.uuid(), release_id:z.uuid().nullable(), closed:z.boolean(), original_total_minor:money, cancelled_credit_minor:money, commercial_total_minor:money, shipping_minor:money, lines:z.array(line).min(1).max(500) });
export type CommercialSaleScope = z.infer<typeof schema>;

/** Integer allocation agrees with Native138's cumulative return-credit rule.
 * Cancelled units are the suffix; they never consume a second rounding remainder. */
export function commercialLineAmounts(total:bigint, quantity:number, issued:number) {
 ensure(total>=0n&&Number.isSafeInteger(quantity)&&quantity>0&&Number.isSafeInteger(issued)&&issued>=0&&issued<=quantity,409,'Niespójny zakres ilości handlowych');
 const gross=total*BigInt(issued)/BigInt(quantity);
 return {issued:gross,cancelled:total-gross};
}
export function parseCommercialSaleScope(value:unknown,orderId:string):CommercialSaleScope {
 const s=schema.parse(value);
 ensure(s.order_id===orderId&&new Set(s.lines.map(l=>l.item_id)).size===s.lines.length,503,'Niespójne pochodzenie zakresu sprzedaży');
 let cancelled=0n,original=0n;
 for(const l of s.lines){
  ensure(l.issued_quantity+l.cancelled_quantity<=l.original_quantity&&(!s.closed||l.issued_quantity+l.cancelled_quantity===l.original_quantity),503,'Niepełne pochodzenie ilości sprzedaży');
  const a=commercialLineAmounts(BigInt(l.original_gross_minor),l.original_quantity,l.original_quantity-l.cancelled_quantity);
  ensure(a.cancelled===BigInt(l.cancelled_gross_minor),503,'Niespójny kredyt anulowanych pozycji');
  const issued=commercialLineAmounts(BigInt(l.original_gross_minor),l.original_quantity,l.issued_quantity).issued;
  ensure(issued===BigInt(l.issued_gross_minor),503,'Niespójna kwota wydanych pozycji');
  cancelled+=a.cancelled;original+=BigInt(l.original_gross_minor);
 }
 ensure(cancelled<=BigInt(s.original_total_minor)&&BigInt(s.commercial_total_minor)+BigInt(s.cancelled_credit_minor)===BigInt(s.original_total_minor),503,'Niespójna suma zakresu sprzedaży');
 ensure(!s.lines.some(l=>l.cancelled_quantity>0)||(s.closed&&s.release_id!==null),503,'Anulowane pozycje wymagają trwałego zwolnienia');
 const allCancelled=s.closed&&s.lines.every(l=>l.issued_quantity===0);
 ensure(original<=BigInt(s.original_total_minor)&&(allCancelled?BigInt(s.shipping_minor)===0n:original+BigInt(s.shipping_minor)===BigInt(s.original_total_minor)),503,'Niespójne historyczne koszty dostawy');
 ensure(BigInt(s.cancelled_credit_minor)===cancelled+(allCancelled?BigInt(s.original_total_minor)-original:0n),503,'Niespójna dostawa lub kredyt sprzedaży');
 return s;
}
/** Same managed client and tenant; no owner bridge, mutation or independent pool. */
export async function commercialSaleScopeInTx(c:PoolClient,orderId:string):Promise<CommercialSaleScope|null> {
 const meta=(await c.query("SELECT to_regprocedure('public.partial_sale204_scope(uuid)') IS NOT NULL scope,EXISTS(SELECT FROM order_parcel_plans WHERE tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND order_id=$1 AND payload->>'protocol'='commercial_v1') present",[orderId])).rows[0];
 if(!meta.present)return null;
 ensure(meta.scope,503,'Częściowy zakres sprzedaży wymaga migracji204');
 const r=(await c.query('SELECT public.partial_sale204_scope($1) scope',[orderId])).rows[0];
 return parseCommercialSaleScope(r.scope,orderId);
}
export async function assertCommercialSaleClosedInTx(c:PoolClient,orderId:string) {
 const s=await commercialSaleScopeInTx(c,orderId);
 ensure(!s||s.closed,409,'Najpierw wydaj albo anuluj wszystkie paczki handlowe');
 return s;
}
/** Unsupported builders must refuse before preparing or dispatching fiscal data. */
export async function assertNoPartialCommercialInvoiceInTx(c:PoolClient,orderId:string) {
 const s=await commercialSaleScopeInTx(c,orderId);
 ensure(!s||(s.closed&&s.lines.every(l=>l.cancelled_quantity===0)),409,'Ten rodzaj dokumentu nie obsługuje częściowo anulowanego lub otwartego planu handlowego');
}


/** Read projection only. Native204 remains the authority for every writer.
 * Requires the already managed tenantReadTx snapshot; never changes transaction/role,
 * obtains a row lock, calls an owner-only validator, or falls back after a SQL error. */
export async function commercialSaleScopeReadonlyInTx(c:PoolClient,orderId:string):Promise<CommercialSaleScope|null> {
 const mode=(await c.query("SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,current_user role,nullif(current_setting('app.tenant_id',true),'') tenant")).rows[0];
 ensure(mode?.ro==='on'&&mode.isolation==='repeatable read'&&mode.role==='dyna_app'&&z.uuid().safeParse(mode.tenant).success,503,'Zakres sprzedaży wymaga własnej migawki tylko do odczytu');
 const tenant=mode.tenant as string;
 const plans=(await c.query('SELECT id,tenant_id,order_id,payload FROM order_parcel_plans WHERE tenant_id=$1 AND order_id=$2 ORDER BY id LIMIT 2',[tenant,orderId])).rows;
 ensure(plans.length<=1,503,'Niejednoznaczny plan zakresu sprzedaży');
 if(!plans.length||plans[0].payload?.protocol!=='commercial_v1')return null;
 const p=plans[0];
 const guarded=(await c.query('SELECT public.partial_sale204_valid() valid,public.order_parcel_commercial_guards() commercial,public.order_parcel_release_guards() release')).rows[0];
 ensure(guarded?.valid===true&&guarded.commercial===true&&guarded.release===true,503,'Brak dokładnych zabezpieczeń zakresu sprzedaży204');
 const o=(await c.query('SELECT id,tenant_id,fulfillment_kind,currency,total,shipping_cost FROM orders WHERE tenant_id=$1 AND id=$2',[tenant,orderId])).rows[0];
 ensure(o&&o.tenant_id===tenant&&o.id===orderId&&p.tenant_id===tenant&&p.order_id===orderId&&o.fulfillment_kind==='sale'&&o.currency===p.payload?.source?.order?.currency,503,'Niespójne własne pochodzenie zakresu sprzedaży');
 ensure(Array.isArray(p.payload.parcels)&&p.payload.parcels.length>=2&&p.payload.parcels.length<=50,503,'Nieprawidłowy plan paczek handlowych');
 // Exact SELECT predicates from Native136 commercial_validate, without owner-only EXECUTE.
 ensure((await c.query("SELECT ((SELECT count(*) FROM order_parcel_commercial_origins WHERE tenant_id=$1::uuid AND plan_id=$2::uuid) IS DISTINCT FROM(SELECT count(*) FROM jsonb_array_elements($3::jsonb->'parcels') parcel CROSS JOIN LATERAL jsonb_array_elements(parcel->'items')) OR EXISTS(SELECT 1 FROM order_parcel_commercial_origins o WHERE o.tenant_id=$1::uuid AND o.plan_id=$2::uuid AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb->'parcels'->o.parcel_index->'items') it WHERE it=o.snapshot AND (it->>'quantity')::integer=o.quantity AND it->>'item_id'=o.item_id::text))) invalid FROM (SELECT $1::uuid t,$2::uuid pid,$3::jsonb payload) parameters",[tenant,p.id,p.payload])).rows[0]?.invalid===false,503,'Niespójna walidacja pochodzenia handlowego136/1');
 ensure((await c.query("SELECT (EXISTS(SELECT 1 FROM order_parcel_commercial_origins o LEFT JOIN order_parcel_dispatches d ON(d.tenant_id,d.plan_id,d.parcel_index)=(o.tenant_id,o.plan_id,o.parcel_index) LEFT JOIN order_parcel_origin_issues issue ON(issue.tenant_id,issue.origin_id)=(o.tenant_id,o.id) WHERE o.tenant_id=$1::uuid AND o.plan_id=$2::uuid AND((d.id IS NULL) IS DISTINCT FROM(issue.dispatch_id IS NULL) OR issue.dispatch_id IS DISTINCT FROM d.id OR (d.id IS NOT NULL AND issue.quantity IS DISTINCT FROM o.quantity)))) invalid FROM (SELECT $1::uuid t,$2::uuid pid,$3::jsonb payload) parameters",[tenant,p.id,p.payload])).rows[0]?.invalid===false,503,'Niespójna walidacja pochodzenia handlowego136/2');
 ensure((await c.query("SELECT (EXISTS(SELECT 1 FROM order_parcel_dispatches d JOIN order_parcel_commercial_origins o ON(o.tenant_id,o.plan_id,o.parcel_index)=(d.tenant_id,d.plan_id,d.parcel_index) CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'components') part WHERE d.tenant_id=$1::uuid AND d.plan_id=$2::uuid AND d.receipt->'wms' IS NOT NULL AND d.receipt->'wms'<>'null'::jsonb AND o.quantity::bigint*(part->>'quantity')::bigint IS DISTINCT FROM(SELECT coalesce(sum(m.quantity),0) FROM order_parcel_origin_fragments m WHERE m.tenant_id=$1::uuid AND m.origin_id=o.id AND m.dispatch_id=d.id AND m.product_id=(part->>'product_id')::uuid)) OR EXISTS(SELECT 1 FROM order_parcel_dispatches d JOIN wms_issue_fragments f ON(f.tenant_id,f.operation_id)=(d.tenant_id,d.id) WHERE d.tenant_id=$1::uuid AND d.plan_id=$2::uuid AND f.quantity::bigint IS DISTINCT FROM(SELECT coalesce(sum(m.quantity),0) FROM order_parcel_origin_fragments m WHERE m.tenant_id=$1::uuid AND m.dispatch_id=d.id AND m.fragment_id=f.id)) OR EXISTS(SELECT 1 FROM order_parcel_origin_fragments m JOIN order_parcel_dispatches d ON(d.tenant_id,d.id)=(m.tenant_id,m.dispatch_id) WHERE d.tenant_id=$1::uuid AND d.plan_id=$2::uuid AND (d.receipt->'wms' IS NULL OR d.receipt->'wms'='null'::jsonb))) invalid FROM (SELECT $1::uuid t,$2::uuid pid,$3::jsonb payload) parameters",[tenant,p.id,p.payload])).rows[0]?.invalid===false,503,'Niespójna walidacja pochodzenia handlowego136/3');
 const releases=(await c.query('SELECT id,tenant_id,plan_id,order_id,payload FROM order_parcel_releases WHERE tenant_id=$1 AND plan_id=$2 ORDER BY id LIMIT 2',[tenant,p.id])).rows;
 ensure(releases.length<=1,503,'Niejednoznaczne zwolnienie planu');
 const r=releases[0];
 if(r){
  ensure(r.tenant_id===tenant&&r.plan_id===p.id&&r.order_id===orderId&&Array.isArray(r.payload?.pending)&&Array.isArray(r.payload?.products),503,'Niespójne pochodzenie zwolnienia');
  // Exact SELECT predicates from Native137 release_terminal (no role or lock changes).
  ensure((await c.query("SELECT ((SELECT count(*) FROM order_parcel_allocations WHERE tenant_id=$1::uuid AND plan_id=$2::uuid)<>jsonb_array_length($3::jsonb->'parcels') OR EXISTS(SELECT 1 FROM order_parcel_allocations l JOIN shipments s ON(s.tenant_id,s.id,s.order_id)=(l.tenant_id,l.shipment_id,l.order_id) WHERE l.tenant_id=$1::uuid AND l.plan_id=$2::uuid AND(l.payload IS DISTINCT FROM $3::jsonb->'parcels'->l.index OR(s.carrier,s.mode,s.tracking_number,s.cod_expected) IS DISTINCT FROM(l.payload->>'carrier',l.payload->>'mode',l.payload->>'tracking_number',(l.payload->>'cod_minor')::int) OR(s.dispatched_at IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE(d.tenant_id,d.plan_id,d.parcel_index)=(l.tenant_id,l.plan_id,l.index))))) invalid FROM (SELECT $1::uuid t,$2::uuid pid,$3::jsonb p,$4::uuid oid,$5::jsonb e) parameters",[tenant,p.id,p.payload,orderId,r.payload])).rows[0]?.invalid===false,503,'Niespójne zamknięcie zwolnienia137/1');
  ensure((await c.query("SELECT ( $5::jsonb->'pending' IS DISTINCT FROM(SELECT coalesce(jsonb_agg(value ORDER BY(value->>'index')::int),'[]') FROM jsonb_array_elements($3::jsonb->'parcels') x WHERE NOT EXISTS(SELECT 1 FROM order_parcel_dispatches d WHERE d.tenant_id=$1::uuid AND d.plan_id=$2::uuid AND d.parcel_index=(x.value->>'index')::int))) invalid FROM (SELECT $1::uuid t,$2::uuid pid,$3::jsonb p,$4::uuid oid,$5::jsonb e) parameters",[tenant,p.id,p.payload,orderId,r.payload])).rows[0]?.invalid===false,503,'Niespójne zamknięcie zwolnienia137/2');
  ensure((await c.query("SELECT ( EXISTS(SELECT 1 FROM reservation_locations WHERE tenant_id=$1::uuid AND order_id=$4::uuid AND quantity<>consumed_quantity+released_quantity) OR EXISTS(SELECT 1 FROM wms_reservation_layers WHERE tenant_id=$1::uuid AND order_id=$4::uuid AND(quantity<>consumed_quantity+released_quantity OR state IS DISTINCT FROM(CASE WHEN released_quantity>0 THEN 'released' ELSE 'consumed' END)))) invalid FROM (SELECT $1::uuid t,$2::uuid pid,$3::jsonb p,$4::uuid oid,$5::jsonb e) parameters",[tenant,p.id,p.payload,orderId,r.payload])).rows[0]?.invalid===false,503,'Niespójne zamknięcie zwolnienia137/3');
  const bad=(await c.query(`SELECT EXISTS(SELECT 1 FROM reservations res WHERE res.tenant_id=$1 AND res.order_id=$4 AND (
   res.consumed_quantity IS DISTINCT FROM (SELECT coalesce(sum((v->>'quantity')::int),0) FROM order_parcel_dispatches d JOIN order_parcel_allocations l ON(l.tenant_id,l.plan_id,l.index)=(d.tenant_id,d.plan_id,d.parcel_index) CROSS JOIN LATERAL jsonb_array_elements(l.payload->'products') v WHERE d.tenant_id=$1 AND d.plan_id=$2 AND v->>'product_id'=res.product_id::text AND v->>'warehouse_id'=res.warehouse_id::text)
   OR res.released_quantity IS DISTINCT FROM coalesce((SELECT (pr->>'quantity')::int FROM jsonb_array_elements($3::jsonb->'products') pr WHERE pr->>'product_id'=res.product_id::text AND pr->>'warehouse_id'=res.warehouse_id::text),0)
   OR res.quantity<>res.consumed_quantity+res.released_quantity
   OR res.state IS DISTINCT FROM CASE WHEN res.released_quantity>0 THEN 'released' ELSE 'consumed' END)) invalid`,[tenant,p.id,r.payload,orderId])).rows[0];
  ensure(bad?.invalid===false,503,'Niespójna ilość rezerwacji po zwolnieniu');
 }
 const items=(await c.query('SELECT id,tenant_id,order_id,quantity,line_total,vat FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY id LIMIT 501',[tenant,orderId])).rows;
 const origins=(await c.query(`SELECT c.id,c.tenant_id,c.plan_id,c.order_id,c.item_id,c.parcel_index,c.quantity,c.snapshot,x.quantity issued,x.dispatch_id,
  EXISTS(SELECT FROM order_parcel_dispatches d WHERE(d.tenant_id,d.id,d.plan_id,d.order_id,d.parcel_index)=(c.tenant_id,x.dispatch_id,c.plan_id,c.order_id,c.parcel_index)) dispatch_present
  FROM order_parcel_commercial_origins c LEFT JOIN order_parcel_origin_issues x ON(x.tenant_id,x.origin_id)=(c.tenant_id,c.id)
  WHERE c.tenant_id=$1 AND c.plan_id=$2 ORDER BY c.item_id,c.parcel_index LIMIT 501`,[tenant,p.id])).rows;
 return projectReadonlyCommercialSale({tenant,orderId,order:o,plan:p,release:r??null,items,origins});
}

type ReadonlyRows={tenant:string;orderId:string;order:Record<string,any>;plan:Record<string,any>;release:Record<string,any>|null;items:Record<string,any>[];origins:Record<string,any>[]};
/** Pure projection of an already validated, same-snapshot Native136/137 relational cut.
 * This DTO is display data only; writers always re-enter the authoritative Native204 RPC. */
export function projectReadonlyCommercialSale({tenant,orderId,order:o,plan:p,release:r,items,origins}:ReadonlyRows):CommercialSaleScope {
 const check=(ok:unknown)=>ensure(ok,503,'Niespójne historyczne ilości zakresu sprzedaży');
 const integer=(value:unknown,min=0)=>{check(Number.isSafeInteger(value)&&Number(value)>=min);return Number(value);};
 const amount=(value:unknown)=>{check((typeof value==='string'||typeof value==='number')&&/^(0|[1-9][0-9]*)$/.test(String(value)));const n=BigInt(String(value));check(n<=BigInt(Number.MAX_SAFE_INTEGER));return n;};
 check(z.uuid().safeParse(tenant).success&&z.uuid().safeParse(orderId).success&&o.tenant_id===tenant&&o.id===orderId&&o.fulfillment_kind==='sale'&&p.tenant_id===tenant&&p.order_id===orderId&&p.payload?.protocol==='commercial_v1'&&p.payload.source?.order?.currency===o.currency);
 check(items.length>=1&&items.length<=500&&origins.length>=1&&origins.length<=500&&new Set(items.map(i=>i.id)).size===items.length&&new Set(origins.map(i=>i.id)).size===origins.length);
 const indices=new Set<number>();
 if(r){
  check(r.tenant_id===tenant&&r.plan_id===p.id&&r.order_id===orderId&&Array.isArray(r.payload?.pending));
  for(const pending of r.payload.pending){const n=integer(pending.index);check(n<50&&!indices.has(n));indices.add(n);}
 }
 let closed=true,credit=0n,subtotal=0n,issuedTotal=0;
 const covered=new Set<string>();
 const lines=items.map(i=>{
  check(i.tenant_id===tenant&&i.order_id===orderId&&z.uuid().safeParse(i.id).success);
  const quantity=integer(i.quantity,1),total=amount(i.line_total);let q=0,issued=0,cancelled=0;
  for(const origin of origins.filter(x=>x.item_id===i.id)){
   check(origin.tenant_id===tenant&&origin.plan_id===p.id&&origin.order_id===orderId);
   const count=integer(origin.quantity,1),index=integer(origin.parcel_index);check(index<50);
   const snapshot=origin.snapshot;
   check(snapshot&&String(snapshot.original_quantity)===String(quantity)&&String(snapshot.line_total)===String(i.line_total)&&String(snapshot.vat)===String(i.vat)&&snapshot.currency===o.currency&&String(snapshot.quantity)===String(count));
   q+=count;covered.add(origin.id);
   if(origin.issued!==null){check(integer(origin.issued,1)===count&&!indices.has(index)&&origin.dispatch_present===true);issued+=count;}
   else if(indices.has(index))cancelled+=count;
   else closed=false;
  }
  check(q===quantity&&issued+cancelled<=q);
  const g=commercialLineAmounts(total,quantity,issued).issued;
  const cg=commercialLineAmounts(total,quantity,quantity-cancelled).cancelled;
  credit+=cg;subtotal+=total;issuedTotal+=issued;
  return{item_id:i.id,original_quantity:quantity,issued_quantity:issued,cancelled_quantity:cancelled,original_gross_minor:String(total),issued_gross_minor:String(g),cancelled_gross_minor:String(cg)};
 });
 const total=amount(o.total),shipping=amount(o.shipping_cost);
 check(covered.size===origins.length&&subtotal+shipping===total&&credit<=total&&(!r||closed));
 if(closed&&issuedTotal===0)credit=total;
 return parseCommercialSaleScope({protocol:'partial_commercial_sale204/v1',order_id:orderId,plan_id:p.id,release_id:r?.id??null,closed,original_total_minor:String(total),cancelled_credit_minor:String(credit),commercial_total_minor:String(total-credit),shipping_minor:String(closed&&issuedTotal===0?0n:shipping),lines},orderId);
}
