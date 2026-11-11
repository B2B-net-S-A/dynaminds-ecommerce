/** SOURCE_ONLY / NOT_REGISTERED / NOT_RUN. Complete historical physical169
 * evidence candidate, not a correction admission or a terminal authority grant.
 * Importing this file does not initialize config, a pool, or a provider. */
import type {PoolClient} from 'pg';
import type {B2bFa3NativeActor} from './fa3-draft-source';
import {ensure} from './errors';
import {b2bCorrectionHash} from './b2b-credit-arithmetic';
import {b2bCorrectionSourceInput,prepareB2bCorrectionHistoryInTx,claimB2bCorrectionHistoryCandidateInTx,discardB2bCorrectionHistory,type B2bCorrectionSourceHandle} from './b2b-credit-source';

type Row=Record<string,any>;
type Candidate=Awaited<ReturnType<typeof claimB2bCorrectionHistoryCandidateInTx>>;
const MAX_BYTES=33554432,MAX_ROWS=10000,MAX_MAPS=30000;
const one=(xs:Row[])=>{ensure(xs.length===1,503,'Niepełna kardynalność historycznego169');return xs[0];};
const equal=(a:unknown,b:unknown)=>b2bCorrectionHash(a)===b2bCorrectionHash(b);
const pick=(r:Row,keys:string[])=>Object.fromEntries(keys.map(k=>[k,r[k]]));
const ids=(xs:Row[],key='id')=>xs.map(x=>x[key]).sort();
const bag=(xs:unknown[])=>xs.map(x=>b2bCorrectionHash(x)).sort();
const assertSame=(a:unknown,b:unknown)=>ensure(equal(a,b),503,'Historyczny PZ/map/journal nie odpowiada immutable169');
function natural(v:unknown,positive=false):bigint{const s=String(v);ensure(/^(0|[1-9][0-9]*)$/.test(s)&&BigInt(s)<=9223372036854775807n&&(!positive||BigInt(s)>0n),503,'Niekanoniczna ilość/koszt historycznego169');return BigInt(s);}
function safeJson(x:unknown):void{if(typeof x==='number')ensure(Number.isSafeInteger(x),413,'Historyczny JSON wymaga bezstratnej projekcji integer');else if(Array.isArray(x))x.forEach(safeJson);else if(x&&typeof x==='object')Object.values(x).forEach(safeJson);}
function budget(x:unknown){ensure(Buffer.byteLength(JSON.stringify(x),'utf8')<=MAX_BYTES,413,'Pełny historyczny PZ przekracza32MiB; brak obcięcia');safeJson(x);}
function sum(xs:Row[],key='quantity'){return xs.reduce((s,x)=>s+natural(x[key]),0n);}
function totals(xs:Row[],key:string[],qty:string){const m=new Map<string,bigint>();for(const x of xs){const k=JSON.stringify(key.map(k=>x[k]));m.set(k,(m.get(k)??0n)+natural(x[qty]));}return [...m].filter(([,v])=>v!==0n).map(([k,v])=>[k,v.toString()]).sort();}

/** Native SQL ORDER BY is retained in the input arrays; do not replace locale
 * ordering of location with JS localeCompare or inferred numeric UUID order. */
function intervals(xs:Row[],keys:string[],qty:string){const high=new Map<string,bigint>();return xs.map(x=>{const key=JSON.stringify(keys.map(k=>x[k])),lo=high.get(key)??0n,hi=lo+natural(x[qty],true);high.set(key,hi);return {x,key,lo,hi};});}
function overlaps(left:Row[],right:Row[],keys:string[],rightQty:string,project:(l:Row,r:Row,q:number)=>Row){
 const groups=new Map<string,ReturnType<typeof intervals>>();for(const r of intervals(right,keys,rightQty)){const g=groups.get(r.key)??[];g.push(r);groups.set(r.key,g);}
 const cursors=new Map<string,number>(),out:Row[]=[];for(const l of intervals(left,keys,'quantity')){const rs=groups.get(l.key)??[];let index=cursors.get(l.key)??0;while(index<rs.length&&rs[index].hi<=l.lo)index++;cursors.set(l.key,index);for(let i=index;i<rs.length&&rs[i].lo<l.hi;i++){const r=rs[i],q=(l.hi<r.hi?l.hi:r.hi)-(l.lo>r.lo?l.lo:r.lo);if(q>0n){ensure(q<=2147483647n,503,'Przekroczono natywną ilość mapy169');out.push(project(l.x,r.x,Number(q)));}}}return out;
}
function proveJournals(g:Row){
 const a=g.admission,r=g.receipt,ea=g.effect_admission,e=g.effect;
 ensure(a.sealed===true&&ea.sealed===true&&ea.id===a.id&&ea.source_kind==='return'&&ea.source_id===a.return_id&&ea.txid===a.txid&&ea.actor_id===a.actor_id&&(ea.api_key_id??null)===(a.api_key_id??null)&&e.admission_id===a.id&&e.operation_id===r.wms_operation_id,503,'Niepełny sealed rodzic fizyczny152/169');
 const sets:Record<string,Row[]>={};
 for(const [kind,key,column]of [['stock','stock_movement_ids','stock_movement_id'],['bin','location_movement_ids','location_movement_id'],['layer','layer_movement_ids','layer_movement_id']]){
  const wanted=r.proof[key];ensure(Array.isArray(wanted)&&wanted.length<=MAX_ROWS&&new Set(wanted).size===wanted.length,503,'Niepełny manifest dzienników169');assertSame(wanted,e.proof[key]);
  const before:Row[]=ea.before_frame[kind+'_journals'],after:Row[]=e.after_frame[kind+'_journals'];ensure(Array.isArray(before)&&Array.isArray(after)&&new Set(ids(before)).size===before.length&&new Set(ids(after)).size===after.length,503,'Obcy sealed frame152');
  const old=new Map(before.map(x=>[x.id,x]));for(const x of before)assertSame(one(after.filter(y=>y.id===x.id)),x);
  const born=after.filter(x=>!old.has(x.id));assertSame(ids(born),[...wanted].sort());const links:Row[]=g.journals.filter((x:Row)=>x.kind===kind);assertSame(ids(links,'journal_id'),[...wanted].sort());
  sets[kind]=links.map(link=>{ensure(link[column]===link.journal_id&&['stock_movement_id','location_movement_id','layer_movement_id'].filter(x=>x!==column).every(x=>link[x]===null),503,'Obcy typed journal FK169');const actual=link.actual;ensure(actual&&actual.tenant_id===a.tenant_id,503,'Brak własnego journal169');assertSame(actual,one(born.filter(x=>x.id===actual.id)));return actual;});
 }
 ensure(g.journals.length===Object.values(sets).reduce((n,x)=>n+x.length,0),503,'Nieznany journal kind169');
 ensure(sets.stock.length>0&&sets.bin.length>0,409,'Przyjęcie bez physical169 wymaga odrębnego financial validator');
 for(const j of sets.stock)ensure(j.kind==='return'&&j.order_id===a.order_id&&j.return_id===a.return_id&&natural(j.delta,true)>0n,503,'Obcy stock PZ');
 for(const j of sets.bin)ensure(j.kind==='stock_in'&&natural(j.delta,true)>0n,503,'Obcy bin PZ');
 for(const j of sets.layer)ensure(j.operation_id===r.wms_operation_id&&natural(j.delta,true)>0n,503,'Obcy layer PZ');
 // All source arrays come from native SQL sorted by journal id, independently of
 // effect journal kind order or JSON frame storage order.
 sets.stock.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);sets.layer.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 return sets;
}

function verify(g:Row,f:Candidate['input']['acceptances'][number]){
 const a=g.admission,r=g.receipt,saved=r.snapshot.return_case,items:Row[]=r.snapshot.items,docs:Row[]=g.documents,rows:Row[]=g.rows;
 ensure(a.id===r.id&&a.tenant_id===f.tenant_id&&a.order_id===f.order_id&&a.return_id===f.return_id&&r.order_id===f.order_id&&r.return_id===f.return_id&&f.native_proof.receipt_id===r.id&&f.native_proof.admission_id===a.id&&b2bCorrectionHash(r.snapshot)===f.native_proof.receipt_snapshot_hash,503,'Nie jest tym samym financial receipt169');
 ensure(['rma','legacy_status'].includes(a.protocol)&&['assistant_receipt_id','exchange_id','dropship_admission_id','local_proof_id','parcel_receipt_return_id'].every(k=>r[k]===null),409,'Pełna historia zawiera nieobsługiwany typed protokół');
 ensure(g.current_admission===false,409,'Bieżące przyjęcie nie jest historical proof');
 assertSame(r.snapshot.items,g.items);assertSame(saved.receipt,a.frame.request);
 ensure(saved.state==='refund_pending'&&saved.remedy==='refund'&&saved.receipt_sequence===f.receipt_sequence&&saved.received_at===f.received_at,503,'Obcy financial birth snapshot');
 const sets=proveJournals(g);
 ensure(docs.length===a.numbers.length&&docs.length>0&&new Set(docs.map(d=>d.warehouse_id)).size===docs.length&&rows.length===sets.bin.length&&rows.length<=MAX_ROWS,503,'Niepełne PZ wszystkich magazynów/binów');
 const foreignCheck=[docs,rows,g.stock_maps,g.item_maps,g.layer_maps,g.fragments,g.layers,g.issues];for(const xs of foreignCheck)ensure(xs.every((x:Row)=>x.tenant_id===a.tenant_id),503,'Obcy tenant fizycznego PZ');
 for(const d of docs){const n=one(a.numbers.filter((n:Row)=>n.warehouse_id===d.warehouse_id)),rs=rows.filter(x=>x.document_id===d.id);
  assertSame(pick(d,['warehouse_id','series_id','year','number']),pick(n,['warehouse_id','series_id','year','number']));ensure(String(d.sequence)===String(n.sequence)&&d.receipt_id===r.id&&d.return_id===a.return_id,503,'Obcy numer/rodzic PZ');
  const p=d.payload;assertSame(p,{id:d.id,receipt_id:r.id,return_id:a.return_id,order_id:a.order_id,warehouse_id:d.warehouse_id,kind:'PZ',number:d.number,series_id:d.series_id,year:d.year,sequence:String(d.sequence),row_count:rs.length,quantity:sum(rs).toString(),wms_enabled:r.wms_operation_id!==null,created_at:r.created_at,series:n.series,warehouse:p.warehouse});
  ensure(p.warehouse&&p.warehouse.id===d.warehouse_id&&p.warehouse.tenant_id===a.tenant_id&&rs.length>0,503,'Obcy frozen magazyn PZ');
  rs.forEach((x,i)=>ensure(x.ordinal===i,503,'Niepełna/kolejno obca ordynacja PZ'));
 }
 for(const x of rows){ensure(docs.some(d=>d.id===x.document_id&&d.warehouse_id===x.warehouse_id),503,'Obcy typed row parent');const bin=one(sets.bin.filter(j=>j.id===x.bin_movement_id)),product=one(a.frame.products.filter((p:Row)=>p.id===x.product_id));
  assertSame(pick(x,['warehouse_id','product_id','location']),pick(bin,['warehouse_id','product_id','location']));ensure(natural(x.quantity,true)===natural(bin.delta,true),503,'Inna ilość realnego bin journal');
  assertSame(x.payload,{product_id:x.product_id,sku:product.sku,name:product.name,warehouse_id:x.warehouse_id,location:x.location,quantity:x.quantity,bin_movement_id:x.bin_movement_id});
 }
 assertSame(ids(rows,'bin_movement_id'),ids(sets.bin));assertSame(totals(rows,['warehouse_id','product_id'],'quantity'),totals(a.frame.cells,['warehouse_id','product_id'],'quantity'));
 ensure(g.stock_maps.length+g.item_maps.length+g.layer_maps.length<=MAX_MAPS,413,'Pełne mapy169 przekraczają30000');
 const stockExpected=overlaps(rows,sets.stock,['warehouse_id','product_id'],'delta',(x,j,q)=>({tenant_id:a.tenant_id,row_id:x.id,stock_movement_id:j.id,quantity:q}));assertSame(bag(g.stock_maps),bag(stockExpected));
 for(const j of sets.stock)ensure(sum(g.stock_maps.filter((m:Row)=>m.stock_movement_id===j.id))===natural(j.delta,true),503,'Stock journal niepokryty w całości');
 const recipe:Row[]=[];
 for(const i of items){ensure(Array.isArray(i.components)&&new Set(i.components.map((x:Row)=>x.product_id)).size===i.components.length,409,'Niejednoznaczna wielokrotna receptura wymaga własnego validator');for(const comp of i.components){const quantity=natural(i.restocked)*natural(comp.quantity,true);ensure(quantity<=2147483647n,503,'Overflow native recipe169');if(quantity>0n)recipe.push({item_id:i.item_id,warehouse_id:a.frame.return_case.warehouse_id,product_id:comp.product_id,quantity:Number(quantity)});}}
 const itemExpected=overlaps(rows,recipe,['warehouse_id','product_id'],'quantity',(x,i,q)=>({tenant_id:a.tenant_id,row_id:x.id,return_id:a.return_id,item_id:i.item_id,arrival_id:null,quantity:q}));
 assertSame(bag(g.item_maps.map((m:Row)=>pick(m,['tenant_id','row_id','return_id','item_id','arrival_id','quantity']))),bag(itemExpected));
 // Include zero-restocked/zero-accepted items: they must have exactly zero maps,
 // not be removed from either snapshot or financial receipt history.
 for(const i of items)for(const comp of i.components)ensure(sum(g.item_maps.filter((m:Row)=>m.item_id===i.item_id&&rows.some(x=>x.id===m.row_id&&x.product_id===comp.product_id)))===natural(i.restocked)*natural(comp.quantity,true),503,'Niepełna receptura również dla zerowych ruchów');
 for(const x of rows){ensure(sum(g.stock_maps.filter((m:Row)=>m.row_id===x.id))===natural(x.quantity,true)&&sum(g.item_maps.filter((m:Row)=>m.row_id===x.id))===natural(x.quantity,true),503,'Niepełne mapy stock/item dla wiersza');}
 if(r.wms_operation_id===null){ensure(sets.layer.length===0&&g.layer_maps.length===0&&g.fragments.length===0&&g.layers.length===0&&g.issues.length===0,503,'OFF zawiera wymyślone warstwy');return;}
 const op=g.operation;ensure(op&&op.id===r.wms_operation_id&&op.tenant_id===a.tenant_id&&op.kind==='return'&&op.order_id===a.order_id&&op.return_id===a.return_id&&op.warehouse_document_id===null&&op.purchase_receipt_id===null,503,'Obcy historyczny rodzic WMS');assertSame(op.request,a.frame.request);
 const fragmentGroups=new Map<string,Row[]>();
 const fragmentKey=(x:Row,q:string,v:string)=>b2bCorrectionHash([x.warehouse_id,x.product_id,x.location,x.layer_id,String(x[q]),x[v]===null?null:String(x[v])]);
 for(const f of g.fragments){const key=fragmentKey(f,'quantity','value_minor'),xs=fragmentGroups.get(key)??[];xs.push(f);fragmentGroups.set(key,xs);}
 const duplicate=new Map<string,number>(),matched=new Map<string,Row|null>();
 for(const j of sets.layer){const key=fragmentKey(j,'delta','value_delta'),i=duplicate.get(key)??0;duplicate.set(key,i+1);matched.set(j.id,(fragmentGroups.get(key)??[])[i]??null);const layer=one(g.layers.filter((l:Row)=>l.id===j.layer_id&&l.product_id===j.product_id));const unit=layer.unit_cost_minor===null?null:natural(layer.unit_cost_minor);assertSame(j.value_delta===null?null:String(j.value_delta),unit===null?null:(natural(j.delta,true)*unit).toString());
  const frag=matched.get(j.id);if(!frag)ensure(layer.operation_id===op.id&&unit===null&&j.kind==='legacy_return',503,'Warstwa NULL bez native legacy birth');else{const issue=one(g.issues.filter((i:Row)=>i.id===frag.issue_fragment_id));ensure(frag.operation_id===op.id&&frag.return_id===a.return_id&&frag.order_id===a.order_id&&frag.layer_id===issue.layer_id&&issue.order_id===a.order_id&&issue.product_id===frag.product_id&&issue.warehouse_document_id===null&&natural(frag.quantity,true)<=natural(issue.quantity,true)&&issue.currency===layer.currency,503,'Obcy original issue fragment');assertSame(pick(frag,['warehouse_id','product_id','location','layer_id']),pick(j,['warehouse_id','product_id','location','layer_id']));assertSame(issue.unit_cost_minor===null?null:String(issue.unit_cost_minor),unit===null?null:unit.toString());assertSame(frag.value_minor===null?null:String(frag.value_minor),unit===null?null:(natural(frag.quantity,true)*unit).toString());}
 }
 const layerExpected=overlaps(rows,sets.layer,['warehouse_id','product_id','location'],'delta',(x,j,q)=>{const l=one(g.layers.filter((l:Row)=>l.id===j.layer_id)),frag=matched.get(j.id);return {tenant_id:a.tenant_id,row_id:x.id,layer_movement_id:j.id,fragment_id:frag?.id??null,quantity:q,payload:{layer_id:l.id,lot_id:l.lot_id,issue_fragment_id:frag?.issue_fragment_id??null,unit_cost_minor:l.unit_cost_minor===null?null:String(l.unit_cost_minor),currency:l.currency,exponent:l.exponent,value_minor:l.unit_cost_minor===null?null:(BigInt(q)*natural(l.unit_cost_minor)).toString(),allocation:'quantity_interval'}};});
 assertSame(bag(g.layer_maps),bag(layerExpected));
 for(const x of rows)ensure(sum(g.layer_maps.filter((m:Row)=>m.row_id===x.id))===natural(x.quantity,true),503,'Niepełne warstwy wiersza');
 for(const j of sets.layer)ensure(sum(g.layer_maps.filter((m:Row)=>m.layer_movement_id===j.id))===natural(j.delta,true),503,'Niepełny layer journal');
 for(const frag of g.fragments)ensure(sum(g.layer_maps.filter((m:Row)=>m.fragment_id===frag.id))===natural(frag.quantity,true),503,'Pominięty native return fragment');
 assertSame(ids(g.layers),[...new Set(sets.layer.map(j=>j.layer_id))].sort());assertSame(ids(g.issues),[...new Set(g.fragments.map((f:Row)=>f.issue_fragment_id))].sort());
}

type Context={root:string;started:string;pid:number};
async function context(c:PoolClient,a:B2bFa3NativeActor):Promise<Context>{const r=one((await c.query("SELECT current_setting('app.tenant_id',true) tenant,current_user role,current_setting('TimeZone') timezone,pg_current_xact_id()::text root,transaction_timestamp()::text started,pg_backend_pid() pid")).rows);ensure(r.tenant===a.tenantId&&r.role==='dyna_app'&&r.timezone==='UTC',403,'Brak managed UTC/own tenant');return {root:r.root,started:r.started,pid:r.pid};}

async function physical(c:PoolClient,a:B2bFa3NativeActor,candidate:Candidate){
 const {fa3DraftOwnerInTx}=await import('./fa3-draft-access');
 // The complete financial collector above authenticated EVERY chronology row
 // and exact169/162 discriminator. Only genuine169 parents have PZ/maps.
 // Financial162 rows are retained in input/hash/prior chain, never renumbered.
 const financial=candidate.input.acceptances.filter(f=>f.acceptance_kind==='physical');
 ensure(candidate.input.acceptances.every(f=>(f.acceptance_kind==='physical'&&f.native_proof.kind==='catalog_stock_return169')||(f.acceptance_kind==='financial_no_restock'&&f.native_proof.kind==='financial_return162')),409,'Unsupported full native chronology');
 if(!financial.length)return [];
 const loaded=await fa3DraftOwnerInTx(c,async()=>{
  // Strict native metadata before owner-only historical graph read. No native
  // current-XID validate(receipt) and no xmin/xact-status ownership inference.
  await c.query('SELECT public.catalog_stock_return_require()');
  return one((await c.query(`WITH receipts AS MATERIALIZED(
   SELECT r.*,rc.receipt_sequence history_sequence FROM public.catalog_stock_return_receipts r
   JOIN public.return_cases rc ON(rc.tenant_id,rc.id,rc.order_id)=(r.tenant_id,r.return_id,r.order_id)
   WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[])),
  docs AS MATERIALIZED(SELECT d.* FROM public.catalog_stock_return_documents d JOIN receipts r ON(r.tenant_id,r.id)=(d.tenant_id,d.receipt_id)),
  rr AS MATERIALIZED(SELECT x.*,d.receipt_id FROM public.catalog_stock_return_rows x JOIN docs d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id)),
  sm AS MATERIALIZED(SELECT m.*,x.receipt_id FROM public.catalog_stock_return_stock_maps m JOIN rr x ON(x.tenant_id,x.id)=(m.tenant_id,m.row_id)),
  im AS MATERIALIZED(SELECT m.*,x.receipt_id FROM public.catalog_stock_return_item_maps m JOIN rr x ON(x.tenant_id,x.id)=(m.tenant_id,m.row_id)),
  lm AS MATERIALIZED(SELECT m.*,x.receipt_id FROM public.catalog_stock_return_layer_maps m JOIN rr x ON(x.tenant_id,x.id)=(m.tenant_id,m.row_id)),
  graph AS MATERIALIZED(SELECT coalesce(jsonb_agg(jsonb_build_object(
   'receipt',to_jsonb(r)-'history_sequence','admission',to_jsonb(ad),'effect_admission',to_jsonb(ea),'effect',to_jsonb(e),
   'current_admission',ad.txid=pg_current_xact_id() AND r.created_at=transaction_timestamp(),
   'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.item_id),'[]') FROM public.return_items i WHERE(i.tenant_id,i.return_id)=(r.tenant_id,r.return_id)),
   'operation',(SELECT to_jsonb(op) FROM public.wms_operations op WHERE(op.tenant_id,op.id)=(r.tenant_id,r.wms_operation_id)),
   'journals',(SELECT coalesce(jsonb_agg(to_jsonb(j)||jsonb_build_object('actual',CASE j.kind
    WHEN 'stock' THEN(SELECT to_jsonb(m) FROM public.stock_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.stock_movement_id))
    WHEN 'bin' THEN(SELECT to_jsonb(m) FROM public.stock_location_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.location_movement_id))
    WHEN 'layer' THEN(SELECT to_jsonb(m) FROM public.wms_layer_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.layer_movement_id)) END) ORDER BY j.kind,j.journal_id),'[]')
    FROM public.catalog_stock_control_effect_journals j WHERE(j.tenant_id,j.admission_id)=(r.tenant_id,r.id)),
   'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.warehouse_id,d.id),'[]') FROM docs d WHERE d.receipt_id=r.id),
   'rows',(SELECT coalesce(jsonb_agg(to_jsonb(x)-'receipt_id' ORDER BY x.warehouse_id,x.product_id,x.location,x.bin_movement_id),'[]') FROM rr x WHERE x.receipt_id=r.id),
   'stock_maps',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'receipt_id' ORDER BY m.row_id,m.stock_movement_id),'[]') FROM sm m WHERE m.receipt_id=r.id),
   'item_maps',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'receipt_id' ORDER BY m.row_id,m.item_id,m.id),'[]') FROM im m WHERE m.receipt_id=r.id),
   'layer_maps',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'receipt_id' ORDER BY m.row_id,m.layer_movement_id),'[]') FROM lm m WHERE m.receipt_id=r.id),
   'fragments',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]') FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id)=(r.tenant_id,r.wms_operation_id)),
   'layers',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') FROM public.wms_cost_layers l WHERE l.tenant_id=r.tenant_id AND l.id IN(
    SELECT m.layer_id FROM public.wms_layer_movements m WHERE m.tenant_id=r.tenant_id AND m.id IN(SELECT v::uuid FROM jsonb_array_elements_text(r.proof->'layer_movement_ids') v))),
   'issues',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]') FROM public.wms_issue_fragments i WHERE i.tenant_id=r.tenant_id AND i.id IN(
    SELECT f.issue_fragment_id FROM public.wms_return_fragments f WHERE(f.tenant_id,f.operation_id)=(r.tenant_id,r.wms_operation_id)))
   ) ORDER BY r.history_sequence,r.return_id),'[]') value FROM receipts r
   JOIN public.catalog_stock_return_admissions ad ON(ad.tenant_id,ad.id)=(r.tenant_id,r.id)
   JOIN public.catalog_stock_control_effect_admissions ea ON(ea.tenant_id,ea.id)=(r.tenant_id,r.id)
   JOIN public.catalog_stock_control_effects e ON(e.tenant_id,e.admission_id)=(r.tenant_id,r.id))
  SELECT octet_length(value::text)::text bytes,CASE WHEN octet_length(value::text)<=$3 THEN value ELSE NULL END graph FROM graph`,[a.tenantId,financial.map(f=>f.native_proof.receipt_id),MAX_BYTES])).rows);
 });
 ensure(natural(loaded.bytes)<=BigInt(MAX_BYTES)&&loaded.graph!==null,413,'Pełny fizyczny graph przekracza32MiB; brak obcięcia');budget(loaded.graph);
 const graph:Row[]=loaded.graph;ensure(graph.length===financial.length,503,'Brakuje PZ pełnej chronologicznej historii');
 graph.forEach((g,i)=>verify(g,financial[i]));return graph;
}

declare const brand:unique symbol;
export type B2bHistoricalPzHandle=Readonly<{[brand]:true}>;
type State={c:PoolClient;a:B2bFa3NativeActor;ctx:Context;financial:B2bCorrectionSourceHandle;physical_hash:string;candidate_hash:string};
const custody=new WeakMap<B2bHistoricalPzHandle,State>();
export async function prepareB2bHistoricalPzInTx(c:PoolClient,a:B2bFa3NativeActor,request:unknown):Promise<B2bHistoricalPzHandle>{
 const b=b2bCorrectionSourceInput.parse(request),ctx=await context(c,a),f=await prepareB2bCorrectionHistoryInTx(c,a,b);
 try{const candidate=await claimB2bCorrectionHistoryCandidateInTx(c,a,f),graph=await physical(c,a,candidate),t=Object.freeze({}) as B2bHistoricalPzHandle;custody.set(t,{c,a,ctx,financial:f,physical_hash:b2bCorrectionHash(graph),candidate_hash:b2bCorrectionHash(candidate)});return t;}
 catch(e){discardB2bCorrectionHistory(c,a,f);throw e;}
}
/** Reread all historical rows and current native identity in the same TX before
 * returning an INTERNAL candidate. Future final managed correction PIN is still
 * required; no JSON serializer/HTTP adapter is authorized by this function. */
export async function claimB2bHistoricalPzCandidateInTx(c:PoolClient,a:B2bFa3NativeActor,t:B2bHistoricalPzHandle){
 const s=custody.get(t);ensure(s&&s.c===c&&s.a===a,403,'Obcy historical PZ custody');ensure(equal(await context(c,a),s.ctx),409,'Inna managed transakcja historical PZ');
 const candidate=await claimB2bCorrectionHistoryCandidateInTx(c,a,s.financial),graph=await physical(c,a,candidate);
 ensure(b2bCorrectionHash(candidate)===s.candidate_hash&&b2bCorrectionHash(graph)===s.physical_hash,409,'Zmienił się pełny historical source');
 return {...candidate,state:'historical_financial_and_physical_candidate_not_an_issue_admission' as const,physical_history:{count:graph.length,physical_hash:s.physical_hash,receipts:graph.map(g=>({receipt_id:g.receipt.id,return_id:g.admission.return_id,documents:g.documents.map((d:Row)=>d.id),row_count:g.rows.length,stock_map_count:g.stock_maps.length,item_map_count:g.item_maps.length,layer_map_count:g.layer_maps.length}))}};
}
export function discardB2bHistoricalPz(c:PoolClient,a:B2bFa3NativeActor,t:B2bHistoricalPzHandle){const s=custody.get(t);if(s){ensure(s.c===c&&s.a===a,403,'Obcy historical PZ rollback');discardB2bCorrectionHistory(c,a,s.financial);}custody.delete(t);}
