/** SOURCE_AUTHORED / NOT_INSTALLED / NOT_RUN.
 * Genuine source collector, not a durable preview, issuance or KSeF authority.
 * Caller owns an already-open managed tenant transaction and its finalizers.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Actor} from './domain';
import {ensure} from './errors';
import {tokenHash} from './security';
import {localInvoicesAvailable} from './local-invoices';
import {b2bDropshipBillToInTx} from './b2b-dropship-guards';
import {b2bFa3Party,b2bFa3Date,validateB2bFa3Draft,b2bFa3DraftHash,type B2bFa3Draft} from './fa3-draft-model';

type Row=Record<string,any>;
const uuid=z.uuid().transform(v=>v.toLowerCase());
const integerVersion=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n);
const declaration=z.strictObject({cash_method:z.literal(false),self_billing:z.literal(false),reverse_charge:z.literal(false),split_payment:z.literal(false),exemption:z.literal(false),new_transport:z.literal(false),triangular:z.literal(false),margin:z.literal(false),jst:z.literal(false),vat_group:z.literal(false),advance:z.literal(false)});
export const b2bFa3NativeRequest=z.strictObject({
  client_key:uuid,order_id:uuid,order_version:integerVersion,seller_series_id:uuid,sale_date:b2bFa3Date,
  buyer:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('ordinary_explicit'),party:b2bFa3Party,confirmed:z.literal(true)}),
    z.strictObject({kind:z.literal('dropship_frozen')}),
  ]),
  shipping_vat:z.union([z.literal(0),z.literal(5),z.literal(8),z.literal(23)]),
  zero_basis:z.array(z.strictObject({item_id:uuid.nullable(),basis:z.string().min(1).max(512)})).max(101),
  ordinary_scope:declaration,confirmed_ordinary_domestic_business_sale:z.literal(true),
});
export type B2bFa3NativeRequest=z.infer<typeof b2bFa3NativeRequest>;
export type B2bFa3NativeActor=Readonly<Actor & {apiKeyId?:string}>;
const actors=new WeakMap<B2bFa3NativeActor,string>();
export function b2bFa3NativeRequestActor(req:{actor:Actor;apiKeyId?:string;currentUser?:{id:string;tenant_id:string};headers:{authorization?:string};cookies:Record<string,string|undefined>},sessionName:string):B2bFa3NativeActor{
  ensure(req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId,401,'Brak rzeczywistej tożsamości żądania B2B');
  const key=req.apiKeyId??req.actor.apiKeyId;
  const raw=key?req.headers.authorization?.replace(/^Bearer /,''):req.cookies[sessionName]??req.headers.authorization?.replace(/^Bearer /,'');
  ensure(raw,401,'Brak natywnej sesji lub klucza B2B');
  const a=Object.freeze({...req.actor,...(key?{apiKeyId:key}:{})});actors.set(a,tokenHash(raw));return a;
}
function canonical(v:unknown):unknown{return v instanceof Date?v.toISOString():Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;}
export function b2bFa3NativeManifestHash(v:unknown){const encoded=JSON.stringify(canonical(v));ensure(typeof encoded==='string',422,'Brak pełnej wartości manifestu B2B');return createHash('sha256').update(encoded).digest('hex');}
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
type Context={tenant:string;root:string;started:string;role:string;owner:string};
async function context(c:PoolClient,a:B2bFa3NativeActor):Promise<Context>{
  const x=(await c.query(`SELECT current_setting('app.tenant_id',true) tenant,pg_current_xact_id()::text root,
    transaction_timestamp()::text started,current_user role,session_user owner,
    pg_get_userbyid(relowner) relation_owner FROM pg_class WHERE oid='public.local_invoice_series'::regclass`)).rows[0];
  ensure(x&&x.tenant===a.tenantId&&x.owner!=='dyna_app'&&x.owner===x.relation_owner&&[x.owner,'dyna_app'].includes(x.role),403,'Niezgodny klient, właściciel lub tenant draftu B2B');
  return{tenant:x.tenant,root:x.root,started:x.started,role:x.role,owner:x.owner};
}
async function ownerRead<T>(c:PoolClient,a:B2bFa3NativeActor,fn:()=>Promise<T>):Promise<T>{
  const x=await context(c,a);let failed=false;
  try{if(x.role==='dyna_app')await c.query('RESET ROLE');const value=await fn();const y=await context(c,a);ensure(y.root===x.root&&y.started===x.started,409,'Draft B2B wymaga tej samej otwartej transakcji');return value;}
  catch(e){failed=true;throw e;}
  finally{try{await c.query("SELECT set_config('app.tenant_id',$1,true)",[x.tenant]);if(x.role==='dyna_app')await c.query('SET LOCAL ROLE dyna_app');}catch(e){if(!failed)throw e;}}
}
async function authority(c:PoolClient,a:B2bFa3NativeActor,pin:boolean){
  const h=actors.get(a);ensure(h,401,'Brak zaufanego kontekstu żądania draftu B2B');
  ensure(await localInvoicesAvailable(c),503,'Brak pełnego natywnego źródła sprzedawcy');
  const present=(await c.query(`SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) tables,
    to_regprocedure('public.b2b_dropship_installed()') IS NOT NULL helper
    FROM unnest(ARRAY['orders','order_items','order_merge_claims','return_cases','documents','invoice_plans','odoo_invoice_exports',
      'b2b_dropship_supplier_orders','b2b_dropship_orders','b2b_dropship_quotes']) name`)).rows[0];
  ensure(present?.tables&&present.helper,503,'Niepełne natywne relacje źródła B2B');
  // Native request/session/account/MFA and exact documents:read/orders:read/documents:write;
  // no supplier impersonation, body actor or privileged missing-context fallback.
  await c.query('SELECT public.local_invoice_identity($1,$2,$3,true,$4)',[a.userId,a.apiKeyId??null,h,pin]);
  const g=(await c.query('SELECT public.local_invoice_access($1,$2,true,$3) g',[a.userId,a.apiKeyId??null,pin])).rows[0]?.g;
  ensure(g?.key_valid,401,'Klucz draftu wygasł lub został wycofany');ensure(g?.allowed,403,'Brak bieżącego prawa przygotowania dokumentu B2B');
}
function party(v:Row){const address=z.object({country:z.literal('PL'),street:z.string().min(1).max(200),postal_code:z.string().min(1).max(30),city:z.string().min(1).max(100)}).parse(v.address);return b2bFa3Party.parse({kind:'business',name:v.name,tax_id:v.tax_id,address:{country:address.country,line1:address.street,line2:address.postal_code+' '+address.city}});}
function money(v:unknown){const s=String(v);ensure(/^(0|[1-9][0-9]*)$/.test(s),422,'Brak historycznej nieujemnej kwoty');return BigInt(s);}
type Source={order:Row;items:Row[];series:Row;command:Row;bridge:Row|null;dropship:Row|null;quote:Row|null};
async function load(c:PoolClient,a:B2bFa3NativeActor,b:B2bFa3NativeRequest,lock:boolean):Promise<Source>{
  // Own supplier RLS probe is mandatory BEFORE owner bridge/cross-tenant query.
  ensure((await c.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2',[a.tenantId,b.order_id])).rowCount,404,'Brak własnego źródła zamówienia B2B');
  const reference=(await c.query('SELECT buyer_tenant_id,dropship_order_id FROM b2b_dropship_supplier_orders WHERE tenant_id=$1 AND order_id=$2',[a.tenantId,b.order_id])).rows[0];
  if(lock){
    // Same upstream cancellation lock before catalog/link/business rows. IDs derive
    // only from the genuine own immutable supplier bridge, never request body.
    if(reference)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['b2b.dropship.proof:'+reference.buyer_tenant_id]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['local-invoice:'+a.tenantId]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['order.merge.proof:'+a.tenantId]);
  }
  return ownerRead(c,a,async()=>{
    const order=(await c.query('SELECT to_jsonb(o)||jsonb_build_object(\'version\',o.version::text) row FROM orders o WHERE(tenant_id,id)=($1,$2)'+(lock?' FOR UPDATE':''),[a.tenantId,b.order_id])).rows[0]?.row;
    ensure(order,404,'Brak własnego źródła zamówienia B2B');
    const series=(await c.query('SELECT to_jsonb(s) row FROM local_invoice_series s WHERE(tenant_id,id)=($1,$2)'+(lock?' FOR SHARE':''),[a.tenantId,b.seller_series_id])).rows[0]?.row;
    ensure(series,404,'Brak własnej zamrożonej serii sprzedawcy');
    const command=(await c.query('SELECT to_jsonb(s) row FROM local_invoice_series_commands s WHERE(tenant_id,series_id)=($1,$2)'+(lock?' FOR SHARE':''),[a.tenantId,b.seller_series_id])).rows[0]?.row;
    ensure(command&&command.request_hash===series.request_hash,503,'Niepełna rzeczywista definicja sprzedawcy');
    const items=(await c.query('SELECT to_jsonb(i) row FROM order_items i WHERE(tenant_id,order_id)=($1,$2) ORDER BY id LIMIT 101'+(lock?' FOR SHARE':''),[a.tenantId,b.order_id])).rows.map(r=>r.row);
    ensure(items.length>=1&&items.length<=100,422,'Draft wymaga pełnych 1–100 pozycji');
    const bridge=(await c.query('SELECT to_jsonb(sb) row FROM b2b_dropship_supplier_orders sb WHERE(tenant_id,order_id)=($1,$2)'+(lock?' FOR SHARE':''),[a.tenantId,b.order_id])).rows[0]?.row??null;
    ensure((bridge?.buyer_tenant_id??null)===(reference?.buyer_tenant_id??null)&&(bridge?.dropship_order_id??null)===(reference?.dropship_order_id??null),409,'Powiązanie dostawcy zmieniło się przed blokadą');
    let dropship:Row|null=null,quote:Row|null=null;
    if(bridge){
      // Only a row reachable through the own immutable supplier bridge is read.
      // Keep app.tenant_id as supplier; never pretend to be buyer/member there.
      const d=(await c.query(`SELECT jsonb_build_object('id',d.id,'tenant_id',d.tenant_id,'version',d.version::text,'state',d.state,
        'link_id',d.link_id,'quote_id',d.quote_id,'customer_order_id',d.customer_order_id,
        'supplier_tenant_id',d.supplier_tenant_id,'supplier_order_id',d.supplier_order_id) row FROM b2b_dropship_orders d
        WHERE(d.tenant_id,d.id,d.supplier_tenant_id,d.supplier_order_id)=($1,$2,$3,$4)`+(lock?' FOR SHARE':''),[bridge.buyer_tenant_id,bridge.dropship_order_id,a.tenantId,b.order_id])).rows[0]?.row;
      ensure(d&&d.state==='ordered',409,'Brak rzeczywistego aktywnego rodzica dropshippingu');dropship=d;
      quote=(await c.query(`SELECT jsonb_build_object('id',q.id,'tenant_id',q.tenant_id,'customer_order_id',q.customer_order_id,
        'supplier_tenant_id',q.supplier_tenant_id,'scope_hash',q.scope_hash,'bill_to',q.snapshot#>'{wholesale,bill_to}') row
        FROM b2b_dropship_quotes q WHERE(q.tenant_id,q.id,q.customer_order_id,q.supplier_tenant_id)=($1,$2,$3,$4)`+(lock?' FOR SHARE':''),[d.tenant_id,d.quote_id,d.customer_order_id,a.tenantId])).rows[0]?.row;
      ensure(quote&&b2bFa3NativeManifestHash(quote.bill_to)===b2bFa3NativeManifestHash(bridge.bill_to),503,'Bill-to nie odpowiada prawdziwej zamrożonej wycenie');
    }
    ensure(!(await c.query(`SELECT 1 FROM order_merge_claims WHERE(tenant_id,source_order_id)=($1,$2)
      UNION ALL SELECT 1 FROM return_cases WHERE(tenant_id,order_id)=($1,$2)
      UNION ALL SELECT 1 FROM documents WHERE(tenant_id,order_id)=($1,$2) AND kind IN('invoice','correction') LIMIT 1`,[a.tenantId,b.order_id])).rowCount,409,'Źródło scalone, zwrócone lub już udokumentowane wymaga innego procesu');
    ensure(!(await c.query(`SELECT 1 FROM invoice_plans WHERE(tenant_id,order_id)=($1,$2) AND kind='invoice' AND mode='external' AND state NOT IN('preview','cancelled')
      UNION ALL SELECT 1 FROM odoo_invoice_exports WHERE(tenant_id,order_id)=($1,$2) AND mode='external' AND state NOT IN('preview','cancelled') LIMIT 1`,[a.tenantId,b.order_id])).rowCount,409,'Źródło ma już zatwierdzone wystawienie zewnętrzne');
    return{order,items,series,command,bridge,dropship,quote};
  });
}
function build(source:Source,b:B2bFa3NativeRequest,shippingId:string):B2bFa3Draft{
  const {order:o,series:s,items}=source;
  ensure(o.version===b.order_version&&o.fulfillment_kind==='sale'&&['shipped','delivered'].includes(o.status),409,'Źródło B2B zmieniło się albo nie jest wydaną sprzedażą');
  ensure(o.currency==='PLN'&&o.address?.country==='PL',422,'Pierwszy draft obsługuje krajowe PL/PLN');
  ensure(s.definition?.seller_vat_status==='active_domestic',422,'Brak jawnej podstawy sprzedawcy krajowego');
  let buyer:any,basis:B2bFa3Draft['source']['buyer_basis'];
  if(source.bridge){
    ensure(b.buyer.kind==='dropship_frozen'&&source.dropship,422,'Dostawca musi użyć prawdziwego zamrożonego bill-to');
    buyer=party(source.bridge.bill_to);basis={kind:'native_b2b_bill_to',binding_id:source.dropship.id,binding_version:source.dropship.version,snapshot_hash:b2bFa3NativeManifestHash({bridge:source.bridge,parent:source.dropship,quote:source.quote})};
  }else{
    ensure(b.buyer.kind==='ordinary_explicit'&&o.source==='manual'&&o.b2b_account_id===null&&o.b2b_snapshot===null,422,'Portal B2B/import wymaga odrębnej prawdziwej tożsamości bill-to; brak zwykłego fallbacku');
    buyer=b.buyer.party;basis={kind:'ordinary_explicit',confirmed_bill_to_hash:b2bFa3NativeManifestHash(b.buyer)};
  }
  ensure(b.sale_date>=String(o.created_at).slice(0,10),422,'Data sprzedaży wyprzedza rzeczywiste zamówienie');
  const zero=new Map<string,string>();for(const x of b.zero_basis){const id=x.item_id??'shipping';ensure(!zero.has(id),422,'Powtórzona podstawa stawki0');zero.set(id,x.basis);}
  const amounts=(gross:bigint,rate:number)=>{ensure([0,5,8,23].includes(rate),422,'Brak obsługiwanej historycznej stawki');const den=100n+BigInt(rate),vat=(2n*gross*BigInt(rate)+den)/(2n*den);return{gross_minor:gross.toString(),net_minor:(gross-vat).toString(),vat_minor:vat.toString()};};
  const lines:B2bFa3Draft['lines']=items.map((i,n)=>{const q=money(i.quantity),p=money(i.price),g=money(i.line_total),r=Number(i.vat);ensure(q>0n,422,'Pusta historyczna pozycja');const delta=p*q-g;return{ordinal:n+1,line_id:i.id,kind:'item',source_item_id:i.id,name:i.name,unit:'szt.',quantity:q.toString(),unit_gross_minor:p.toString(),discount_gross_minor:(delta>0n?delta:0n).toString(),rounding_gross_minor:(delta<0n?-delta:0n).toString(),vat_code:(r===0?'0 KR':String(r)) as B2bFa3Draft['lines'][number]['vat_code'],zero_domestic_basis:r===0?(zero.get(i.id)??null):null,...amounts(g,r)};});
  const shipping=money(o.shipping_cost);lines.push({ordinal:lines.length+1,line_id:shippingId,kind:'shipping',source_item_id:null,name:'Dostawa',unit:'usł.',quantity:'1',unit_gross_minor:shipping.toString(),discount_gross_minor:'0',rounding_gross_minor:'0',vat_code:b.shipping_vat===0?'0 KR':String(b.shipping_vat) as B2bFa3Draft['lines'][number]['vat_code'],zero_domestic_basis:b.shipping_vat===0?(zero.get('shipping')??null):null,...amounts(shipping,b.shipping_vat)});
  for(const [id]of zero)ensure(lines.some(l=>(l.source_item_id??'shipping')===id&&l.vat_code==='0 KR'),422,'Podstawa0 nie należy do faktycznej pozycji0');
  const sum=(field:'gross_minor'|'net_minor'|'vat_minor')=>lines.reduce((n,l)=>n+BigInt(l[field]),0n).toString();
  return validateB2bFa3Draft({schema:'b2b-fa3-draft/v1',state:'draft',currency:'PLN',invoice_kind:'VAT',tax_method:'gross_line_half_up',seller:b2bFa3Party.parse({kind:'business',name:s.definition.seller.name,tax_id:s.definition.seller.tax_id,address:{country:s.definition.seller.country,line1:s.definition.seller.street,line2:s.definition.seller.postal_code+' '+s.definition.seller.city}}),buyer,source:{tenant_id:o.tenant_id,order_id:o.id,order_version:o.version,item_ids:items.map(i=>i.id),order_total_minor:money(o.total).toString(),shipping_gross_minor:shipping.toString(),buyer_basis:basis},sale_date:b.sale_date,ordinary_scope:b.ordinary_scope,lines,totals:{gross_minor:sum('gross_minor'),net_minor:sum('net_minor'),vat_minor:sum('vat_minor')}});
}
declare const handleBrand:unique symbol;
export type B2bFa3NativeHandle=Readonly<{[handleBrand]:true}>;
type Custody={c:PoolClient;a:B2bFa3NativeActor;context:Context;request:B2bFa3NativeRequest;source:Source;draft:B2bFa3Draft;manifest:Row};
const handles=new WeakMap<B2bFa3NativeHandle,Custody>();
export async function prepareB2bFa3NativeDraftInTx(c:PoolClient,a:B2bFa3NativeActor,input:unknown):Promise<B2bFa3NativeHandle>{
  const b=b2bFa3NativeRequest.parse(input);await c.query("SET LOCAL TimeZone='UTC'");await authority(c,a,false);await ownerRead(c,a,()=>c.query('SELECT public.fa3_draft_require($1,$2,$3,true,false)',[a.userId,a.apiKeyId??null,b2bFa3NativeIdentityHash(a)]));const x=await context(c,a);
  const source=await load(c,a,b,true),draft=build(source,b,randomUUID());
  const nativeBillTo=await b2bDropshipBillToInTx(c,b.order_id);ensure(b2bFa3NativeManifestHash(nativeBillTo)===b2bFa3NativeManifestHash(source.bridge?.bill_to??null),503,'Natywny helper bill-to nie odpowiada dokładnej relacji');
  const manifest={protocol:'b2b-fa3-native-draft/v1',tenant_id:a.tenantId,actor_id:a.userId,api_key_id:a.apiKeyId??null,request:b,source,seller_basis:{series_id:source.series.id,command_id:source.command.id,request_hash:source.series.request_hash,definition_hash:b2bFa3NativeManifestHash(source.series.definition)},draft_hash:b2bFa3DraftHash(draft)};
  const token=Object.freeze({}) as B2bFa3NativeHandle;handles.set(token,{c,a,context:x,request:b,source,draft,manifest});return token;
}
/** Terminal for a collector-only transaction. Future persistent coordinator must
 * run after all its graph/FK/sibling waits, then no hydration/DML until COMMIT. */
export async function finalizeB2bFa3NativeDraftInTx(c:PoolClient,a:B2bFa3NativeActor,t:B2bFa3NativeHandle){
  const s=handles.get(t);ensure(s&&s.c===c&&s.a===a,403,'Obca lub zużyta zgoda draftu B2B');const x=await context(c,a);ensure(x.root===s.context.root&&x.started===s.context.started,409,'Inna transakcja draftu B2B');
  const source=await load(c,a,s.request,false);ensure(b2bFa3NativeManifestHash(source)===b2bFa3NativeManifestHash(s.source),409,'Pełne źródło draftu zmieniło się');
  const today=(await c.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS current_day")).rows[0].current_day;ensure(s.draft.sale_date<=today,422,'Data sprzedaży jest w przyszłości');
  await authority(c,a,true); // All actual membership/session/key waits.
  ensure(await localInvoicesAvailable(c),503,'Metadane sprzedawcy zmieniły się po oczekiwaniu');
  await authority(c,a,false); // Native final DB-clock expiry/MFA/scopes after metadata.
  handles.delete(t);
  return{state:'draft_candidate_not_persisted' as const,draft:clone(s.draft),draft_hash:b2bFa3DraftHash(s.draft),manifest:clone(s.manifest),manifest_hash:b2bFa3NativeManifestHash(s.manifest),xml_mapping_ready:s.draft.lines.every(l=>l.rounding_gross_minor==='0'),ksef_state:'not_submitted' as const,issued:false as const};
}
/** Rollback-only revocation; no SQL abandonment or fake persistent receipt. */
export function discardB2bFa3NativeDraft(c:PoolClient,a:B2bFa3NativeActor,t:B2bFa3NativeHandle){const s=handles.get(t);if(s)ensure(s.c===c&&s.a===a,403,'Obcy klient rollback draftu B2B');handles.delete(t);}

/** Internal only: opaque same-client/actor custody, never expose source/identity through HTTP. */
export function b2bFa3NativeIdentityHash(a:B2bFa3NativeActor){const h=actors.get(a);ensure(h,401,'Brak zaufanej tożsamości B2B');return h;}
export function b2bFa3NativePreparedInTx(c:PoolClient,a:B2bFa3NativeActor,t:B2bFa3NativeHandle){const s=handles.get(t);ensure(s&&s.c===c&&s.a===a,403,'Obca zgoda B2B');return {request:clone(s.request),draft:clone(s.draft),shipping_id:s.draft.lines.at(-1)!.line_id};}
