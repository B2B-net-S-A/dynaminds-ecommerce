/** Ordinary HTTP ports for the scale driver. Import-inert, synchronous, no IO.
 * A prepared fixture supplies real owned IDs, versions, sessions and preview scopes.
 * Its finite command queues are consumed once, including on a lost ACK. These are
 * request/DTO bindings, not authenticated tenant, ledger or scale acceptance.
 * Fresh payment/RMA effects require the new atomic outcome fields. Historical
 * replay and older responses without that proof never count as a fresh write.
 */
import assert from 'node:assert/strict';
export const SCALE_HTTP_PORT_LIMITATIONS=Object.freeze([
 'Finite prepared commands; exhaustion fails before HTTP. No seeding, refresh, retry or recovery.',
 'Session tenant/user fields are declarations compared with plan bindings; ordinary identity proof remains external.',
 'Native invoice issue and WMS adjustment execute require already prepared, unexpired genuine previews.',
 'Status measurement uses eligible paid-to-picking transition; reservation was performed by ordinary order creation.',
 'Stock binding admits prepared positive/negative WMS adjustments and inter-warehouse transfers, and for tenants without WMS lots prepared manual OFF PW/RW corrections; full physical reconciliation remains unavailable.',
 'Payment/RMA success requires atomic reused:false and exact durable effect identity; older/missing flags and historical reused:true are refused.',
 'Ordinary receipt inspection alone grants no freshness; prepared destinations uses its distinct atomic148 outcome, accepted169sequence or reject-only no-receipt history.',
 'Catalog search follows the server SKU/name/EAN/alias predicate; this port does not infer alias ownership from omitted DTO fields.',
 'No full profile mix, five-tenant isolation, physical/financial reconciliation, workers or scale acceptance is granted.',
]);
// Exact code inspected to derive these route/schema/DTO bindings; not installed release authority.
// SourceRateLimit29 re-pins app.ts after review: the per-address limit is read from DYNA_RATE_LIMIT_PER_MIN
// (default 600) through rate-limit-config.ts and reported in /api/health; routes, DTOs and auth hook unchanged.
// RequestLifetime29 re-pins app.ts after review: the error handler's tracked Promise resolves to the reply (no
// second empty reply), the release logger is the reply-warning sink and /api/health adds reply_warnings and
// ordinary_requests.late_hook_failures; routes, DTOs, error bodies and auth hook unchanged.
// ManualOff29 pins the manual OFF PW/RW correction (169) for tenants without WMS lots: source, preview, apply.
// ManualOff281 re-pins server/manual-inventory-off.ts after review: when the prepared 281 manual_off_verdict_ family is
// installed with the 248/255 functions it calls (one to_regprocedure probe per transaction) the service calls its owner-only copies of the guarded 169 functions
// instead of the sealed ones (valid, frame, preview, preview_can_apply, apply); otherwise the sealed ones, as before (was
// a864e682…004e8ad). Routes, DTOs, request bodies, response fields, error mapping and transaction order unchanged.
// WooStockReconcile30 re-pins app.ts after review: one import and one registerLocalWooStockLaneRoutes call (operator
// reconciliation of the Woo stock lane under /api/local-fixtures/woocommerce/channels/:channelId/stock-lane); measured
// scale routes, DTOs, error mapping and auth hook unchanged (was 09fbbf50…5b940ca).
// DbErrors30 re-pins app.ts after review: the error handler answers a lost database connection (57P01/57P02/57P03,
// class 08, socket reset/refused, pg "Connection terminated unexpectedly") with 503 and the Polish
// DB_UNAVAILABLE_DETAIL (code-only warn log), and /api/health adds db_connection_errors and
// db_connection_errors_by_source; routes, DTOs, other error bodies and auth hook unchanged (was 155cbed3…8729d7).
// UwagiV3 re-pins app.ts, domain.ts, payments.ts and wms-lots.ts after review (11.11.2026, CI quarantine; was
// b32aa074…837ca7, cff5ac7f…126f2c, f2f7db44…f43fbab35, previous wms-lots pin). Changes behind the measured routes:
// GET /api/orders `status` now filters the derived fulfilment stage (ready_to_ship, else the raw status;
// server/order-list-query.ts), so a returned row still carries a requested raw status as the order_list port
// asserts, but rows with a printed label leave paid/picking/packed; the order card adds fulfilment_stage,
// payment_state and section values (order_detail reads only version/status); POST /api/orders creates COD as
// 'paid' while prepaid stays 'new' (the order_create port prepares prepaid only); PATCH status no longer lets
// COD/trade-credit orders skip 'paid' (new→picking), picking refuses a hand-released reservation, packed may add
// the DEMO label when that setting is on. New routes only otherwise (filter-options, status-counts, channel-data,
// demo-label, order sections). payments.ts: two exports. wms-lots.ts: order-line resize and an optional product
// filter on release (unchanged without it). Not re-measured by a live scale run.
// Public snapshot re-pins app.ts and domain.ts (11.11.2026): one comment line each, a client name replaced by
// "uwaga klienta" before publication; code unchanged (was 566a0705…a69cb2, c6fe9e41…3d8b5).
// Re-pins app.ts (12.11.2026): without the startup gate buildApp runs preflightPim/preflightNestedPim in one READ ONLY
// transaction with SET LOCAL statement_timeout='120s' instead of on the pool's 8 s session; no HTTP route or port
// changes (was 24b0277c…87473b). Not re-measured by a live scale run.
// Re-pins app.ts and domain.ts (12.11.2026, migration 268): the label download refuses a cancelled label, the DEMO
// label takes over a cancelled row and the order detail adds replaced_labels; no scale HTTP route or port changes
// (was 964d0852…0e0edf, accaef7c…c1c2a8). Not re-measured by a live scale run.
// Re-pins app.ts (13.11.2026): the error handler answers 503 "Niekompletny moduł bazy danych…" for 55000/42883 raised
// inside guard_verdict() (server/guard-verdict-errors.ts) instead of 500; no HTTP route or port changes
// (was 4d6d77f2…c17bb4). Not re-measured by a live scale run.
export const SCALE_HTTP_PORT_SOURCE_PINS=Object.freeze({
 "server/app.ts": "43c509929f40d35d420f6276c7595b25b7c96ccaf65b8dccff601ae96c2b5bd4",
 "server/domain.ts": "97c9165aba2352f24edbbd20bcecf76124eeceb2494dba80391d67b02de58b76",
 "server/catalog-routes.ts": "626a78aaa0e141792979c1030b7df3895df39ba1a0a87a612360bb0ec2976b1d",
 "server/catalog.ts": "7fe1988a3e4a5c178181ac89cb124c5bd7418007f00bc475fb88ff26d0eb2c61",
 "server/order-status-input.ts": "efafe589485baeba5da294d305d40979a57af99597d025bb5fab6fc8330115e6",
 "server/payment-routes.ts": "e937e60d54b21a3f614352da5ffbffba8fdf73b12c80d1560cf75c6bf9bce766",
 "server/payments.ts": "7b4d88e289d7ceac13a4907cade0bc8c20a0a74bbb46a4d6a515efedd77538cf",
 "server/local-invoice-routes.ts": "27164482373e4ce081f89fb4667453e968f4069cec5800246eb0cbbd50c82ccc",
 "server/local-invoice-values.ts": "ffdffffcc9a020b087374285167e1d3df7ebc3f5a0d52fe2dfef08820298fa49",
 "server/local-invoices.ts": "83aa0ff0094d12e6cb20779ab3f7db92ac653c60eebf264984957b76c769820f",
 "server/local-invoice-issue-alias.ts": "e04b2c88da79bbaeea335006a3efb948112b08cd90032cd06f37f1c7a694cc7d",
 "server/tax226-routes.ts": "e88a491030873f3ebd45410f086f7154068c8917239a9196ced8429a2a567981",
 "server/tax226-local-invoices.ts": "ebcf2f5ff6156c92499427109775e8195e49ef60015a9b5bb2e4c246869cdde6",
 "server/inventory-correction-schema.ts": "0a42341e0b5fd4fec5a33174850e1f6bf92e10e82c43cf7f48a41dee7475d016",
 "server/inventory-correction.ts": "f6f2527c7a0904d5decf7392cc4b7726dda75bc83f5ef8ecb335117a8849465a",
 "server/wms-lots-routes.ts": "527190883fd318202bb9b02654cb09b4f1bfeacea2c7ec96289e4661c5564012",
 "server/wms-lots.ts": "fb381a403cbfc0cad1b9970b759dd6d932d23a3c481873fecdc3d346585fd6b4",
 "server/return-destinations.ts": "c514fd6de722755258ea0de284a784bdb511415ca36b95d211f16588152ab26c",
 "server/return-destinations-routes.ts": "da6ddd26d98ec1b34733161ea92f28b4e6435315168df802c9147d8e7005337b",
 "server/return-destinations-schema.ts": "9822ecf3495a688d303528c8fe076fcf22e278662fa938841902d5ea503a6ca0",
 "server/return-destinations-plan.ts": "a6e66eacc990b0b9919e28f7626b89eefab22c0520abec295344e2fad276ec97",
 "server/return-destinations-core.ts": "e1ef4fd6d959749181dbd58666be8af38957c9d7680fdfe77b542deba54a1073",
 "server/return-routes.ts": "43c1fdfd2a3586c1fe9f08bef36ad7346c68fcc2c1d8ace4bcd09f28488cd9b0",
 "server/returns.ts": "41f1d29ff26f5def0975b1a1629cc9b4665f3214d11e143afc9765526c2b8989",
 "server/wms-lots-schema.ts": "632ebeb70b4c78bab422bc51c4bb65d84bb271f10c9505ef4b87c63f876b2dc8",
 "server/wms-lots-workflow-schema.ts": "4a2857824c644e7ad2f585239302cde7a474909e3bf07d3fef827fa58adc827d",
 "server/return-acceptance.ts": "1456a6a4cebcd7cec8f5ffd7efecf84b3793079a87f3bda4909c8438ce032b16",
 "server/manual-inventory-off.ts": "d8172934d8b12e3c9d3849daef321f999e2b9dde656750d2146efa75b2d6c81d",
 "server/manual-inventory-off-routes.ts": "f257283e46e929172baa93ff9b183d7c08aaefe800030175c608ac774379b88e",
 "server/169_manual_inventory_off.sql": "4cbf0d955d5bef53b8385836779d6ec50fb5d12520d5c0def95eee8b0da054ce"
});
export const SCALE_HTTP_PORT_COVERAGE=Object.freeze({structural_slots:40,supported_variant_slots:40,blocked_variants:Object.freeze(['financial_partner_acceptance']),full_profile_binding:false,scale_acceptance:false});
const slots=['A','B','C','D','E'],ops=['order_list','catalog_search','order_detail','order_create','reserve_and_status','payment_or_document','stock_operation','return_receive'];
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const decimal=(v,min=0n)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)>=min&&BigInt(v)<=9223372036854775807n;
const coercedVersion=v=>version(v)&&Number.isSafeInteger(Number(v))&&Number(v)>0;
const version=v=>(typeof v==='number'&&integer(v,1,Number.MAX_SAFE_INTEGER))||(typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n);
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort(),'fixture-exact-fields');};
const fields=(v,required,optional=[])=>{assert(v&&typeof v==='object'&&!Array.isArray(v));for(const k of required)assert(Object.hasOwn(v,k),'fixture-missing-'+k);for(const k of Object.keys(v))assert([...required,...optional].includes(k),'fixture-unknown-'+k);};
const text=(v,min,max)=>typeof v==='string'&&v.length>=min&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
function safeJson(v,depth=0){assert(depth<=20,'fixture-json-depth');if(v===null||typeof v==='boolean')return;if(typeof v==='string'){assert(v.length<=8192);return;}if(typeof v==='number'){assert(Number.isFinite(v));return;}assert(v&&typeof v==='object'&&(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null),'fixture-json-only');const ds=Object.getOwnPropertyDescriptors(v);for(const k of Reflect.ownKeys(ds)){assert(typeof k==='string','fixture-json-symbol');if(Array.isArray(v)&&k==='length')continue;const d=ds[k];assert(d.enumerable&&Object.hasOwn(d,'value'),'fixture-json-data-only');if(Array.isArray(v))assert(/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length);safeJson(d.value,depth+1);}if(Array.isArray(v))assert.equal(Object.keys(v).length,v.length);}
const countRows=e=>{fields(e,['min_rows','max_rows']);assert(integer(e.min_rows,0,50)&&integer(e.max_rows,e.min_rows,50));};
function query(q,op){fields(q,['limit'],op==='order_list'?['status','tag','search','after']:['search','warehouse_id','catalog_id','after','sellable']);assert.equal(q.limit,50);for(const[k,v]of Object.entries(q)){if(k==='limit')continue;if(['warehouse_id','catalog_id'].includes(k))assert(uuid(v));else if(k==='sellable')assert(['true','false'].includes(v));else if(k==='after'&&op==='catalog_search')assert(uuid(v));else assert(text(v,0,k==='after'?300:k==='tag'?40:k==='status'?100:200));}if(op==='catalog_search')assert(Object.hasOwn(q,'search'));}
const stockFragmentFields=['layer_id','lot_id','lot_code','location','quantity','unit_cost_minor','value_minor','currency'];
const stockFragmentKey=f=>f.layer_id+':'+f.location;
function negativeStockFragments(expected){
 const rows=expected.fragments;assert(Array.isArray(rows)&&rows.length>=1&&rows.length<=100,'prepared-negative-fragments-required');
 const seen=new Set();let quantity=0,known=0n,unknown=0;let currency=null;
 for(const f of rows){
  exact(f,stockFragmentFields);assert(uuid(f.layer_id)&&uuid(f.lot_id)&&text(f.lot_code,1,100)&&text(f.location,1,80)&&f.location===f.location.trim()&&integer(f.quantity,1,1000000));
  assert(['PLN','EUR','USD','GBP','CZK'].includes(f.currency));currency??=f.currency;assert.equal(f.currency,currency,'single-policy-currency-required');
  const key=stockFragmentKey(f);assert(!seen.has(key),'duplicate-negative-layer-position');seen.add(key);quantity+=f.quantity;
  if(f.unit_cost_minor===null){assert.equal(f.value_minor,null);unknown+=f.quantity;}
  else{assert(decimal(f.unit_cost_minor)&&decimal(f.value_minor));const value=BigInt(f.unit_cost_minor)*BigInt(f.quantity);assert.equal(value,BigInt(f.value_minor),'exact-negative-fragment-value');known+=value;}
 }
 assert(quantity===-expected.signed_delta&&known<=9223372036854775807n,'negative-fragment-total-must-match-signed-delta');
 return{currency,quantity:String(quantity),known_minor:String(known),unknown_quantity:String(unknown),known_quantity:String(quantity-unknown)};
}
const transferFragmentFields=['layer_id','lot_id','lot_code','location','quantity','unit_cost_minor','currency','fifo_sequence'];
function transferStockFragments(expected){
 const rows=expected.fragments;assert(Array.isArray(rows)&&rows.length>=1&&rows.length<=100,'prepared-transfer-fragments-required');
 const seen=new Set();let quantity=0,known=0n,unknown=0;let currency=null;
 assert.equal(new Set(rows.map(f=>f.location)).size,1,'transfer-preview-has-one-source-location');
 for(const f of rows){
  exact(f,transferFragmentFields);assert(uuid(f.layer_id)&&uuid(f.lot_id)&&text(f.lot_code,1,100)&&text(f.location,1,80)&&f.location===f.location.trim()&&integer(f.quantity,1,1000000)&&decimal(f.fifo_sequence,1n));
  assert(['PLN','EUR','USD','GBP','CZK'].includes(f.currency));currency??=f.currency;assert.equal(f.currency,currency,'single-policy-currency-required');
  const key=stockFragmentKey(f);assert(!seen.has(key),'duplicate-transfer-layer-position');seen.add(key);quantity+=f.quantity;
  if(f.unit_cost_minor===null)unknown+=f.quantity;else{assert(decimal(f.unit_cost_minor));known+=BigInt(f.unit_cost_minor)*BigInt(f.quantity);}
 }
 assert.equal(quantity,expected.quantity,'transfer-fragment-total-required');assert(known<=9223372036854775807n,'transfer-value-int64-required');
 return{currency,quantity:String(quantity),known_minor:String(known),unknown_quantity:String(unknown),known_quantity:String(quantity-unknown)};
}
const destinationResultFields=['id','number','state','version','refund_amount','refunded_shipping','received_at','decision_note','receipt_sequence'];
function destinationTimestampMillis(value){
 if(value===null)return null;
 assert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value),'destination-timestamp-with-zone-required');
 const millis=Date.parse(value);assert(Number.isFinite(millis),'valid-destination-timestamp-required');
 const zone=value.match(/([+-])(\d{2}):(\d{2})$/),offset=zone?(Number(zone[2])*60+Number(zone[3]))*(zone[1]==='+'?1:-1):0;
 assert.equal(new Date(millis+offset*60000).toISOString().slice(0,19),value.slice(0,19).replace(' ','T'),'valid-destination-calendar-required');return millis;
}
const destinationSummaryFields=['accepted','restocked_to_sale','received_into_custody','rejected','commercial_credit_minor','shipping_refund_minor'];
const byKey=(rows,key)=>new Map(rows.map(r=>[key(r),r]));
const sameRows=(actual,expected,key)=>{assert.equal(new Set(actual.map(key)).size,actual.length,'unique-destination-roster');assert.deepEqual([...byKey(actual,key)].sort(),[...byKey(expected,key)].sort(),'exact-destination-roster');};
function destinationPreview(c){
 const p=c.expected.preview,s=p?.snapshot,plan=s?.plan,source=s?.source;
 exact(p,['id','session_id','return_id','order_id','scope_hash','kind','protocol','created_at','expires_at','action','request','core_input','summary','snapshot','operation_id','can_receive']);
 assert(p.id===c.preview_id&&p.return_id===c.return_id&&p.order_id===c.order_id&&uuid(p.session_id)&&p.scope_hash===c.body.scope_hash&&p.kind==='preview'&&p.protocol==='destinations_v1'&&['receive','reject'].includes(p.action)&&p.operation_id===null&&p.can_receive===true);
 assert(Number.isFinite(Date.parse(p.created_at))&&Number.isFinite(Date.parse(p.expires_at))&&Date.parse(p.expires_at)>Date.parse(p.created_at));
 assert(s&&s.protocol==='destinations_v1'&&s.session?.id===p.session_id&&s.session.return_id===c.return_id&&s.session.order_id===c.order_id&&s.return_case?.id===c.return_id&&s.order?.id===c.order_id&&s.return_case.state==='requested'&&version(s.return_case.version)&&s.return_case.receipt_sequence===0);
 assert(source&&source.return_id===c.return_id&&source.order_id===c.order_id&&source.currency==='PLN'&&Array.isArray(source.lines)&&source.lines.length>=1&&source.lines.length<=100&&typeof source.wms?.enabled==='boolean');
 assert(plan&&plan.protocol==='destinations_v1'&&plan.return_id===c.return_id&&plan.order_id===c.order_id&&plan.currency===source.currency);exact(p.summary,destinationSummaryFields);assert.deepEqual(plan.summary,p.summary);assert.deepEqual(p.request,s.request);assert(uuid(p.request.client_key)&&!Object.hasOwn(p.request,'lease_token'));assert.equal(p.request.protocol,'destinations_v1');assert.equal(p.request.session_id,p.session_id);assert.equal(p.request.session_version,s.session.version);assert.equal(p.request.return_version,String(s.return_case.version));assert(Array.isArray(p.request.parts)&&Array.isArray(p.request.locations));sameRows(p.request.parts,plan.parts.map(part=>({part_id:part.part_id,item_id:part.item_id,quantity:part.quantity,status_id:part.status.status_id,status_version:part.status.version})),r=>r.part_id);
 for(const k of destinationSummaryFields)assert(integer(p.summary[k]));
 assert(Array.isArray(plan.parts)&&plan.parts.length>=1&&plan.parts.length<=200&&Array.isArray(plan.decisions)&&Array.isArray(plan.arrivals)&&plan.arrivals.length<=500&&Array.isArray(plan.fragments)&&plan.fragments.length<=500&&Array.isArray(plan.stock_effects)&&plan.stock_effects.length<=500);
 const seen=new Set(),parts=byKey(plan.parts,r=>r.part_id),lines=byKey(source.lines,r=>r.item_id);assert.equal(parts.size,plan.parts.length);assert.equal(lines.size,source.lines.length);
 const decisions=[],arrivals=[];let accepted=0,restocked=0,custody=0,rejected=0,credit=0;
 for(const l of source.lines){assert(uuid(l.item_id)&&integer(l.ordered_quantity,1,100000)&&integer(l.requested,1,100000)&&integer(l.prior_accepted)&&integer(l.line_total_minor)&&Array.isArray(l.components)&&l.components.length>=1&&l.components.length<=100);const own=plan.parts.filter(r=>r.item_id===l.item_id);let a=0,r=0,cu=0,re=0,total=0;
  for(const part of own){assert(uuid(part.part_id)&&integer(part.quantity,1,100000)&&part.status?.active===true);seen.add(part.part_id);total+=part.quantity;const st=part.status,priorAccepted=a;assert.deepEqual(part.components,l.components);
   if(st.decision==='reject'){assert.equal(st.inventory_effect,'none');assert.equal(st.warehouse_id,null);assert.equal(part.refund_minor,0);re+=part.quantity;}
   else{assert.equal(st.decision,'accept');assert.equal(part.refund_minor,Number(BigInt(l.line_total_minor)*BigInt(l.prior_accepted+priorAccepted+part.quantity)/BigInt(l.ordered_quantity)-BigInt(l.line_total_minor)*BigInt(l.prior_accepted+priorAccepted)/BigInt(l.ordered_quantity)),'exact-part-financial-allocation');assert(['sale','custody'].includes(st.inventory_effect)&&uuid(st.warehouse_id));const policy=source.warehouse_policies.find(w=>w.warehouse_id===st.warehouse_id);assert(policy&&policy.enabled===true&&policy.usage===st.inventory_effect&&policy.version===st.warehouse_policy_version);a+=part.quantity;if(st.inventory_effect==='sale')r+=part.quantity;else cu+=part.quantity;
    for(const component of l.components){assert(uuid(component.product_id)&&integer(component.quantity,1,100000));const location=p.request.locations.find(x=>x.part_id===part.part_id&&x.product_id===component.product_id);assert(location&&location.confirmed===true&&text(location.location,1,80));assert(integer(part.quantity*component.quantity,1,10000000));arrivals.push({part_id:part.part_id,item_id:l.item_id,product_id:component.product_id,warehouse_id:st.warehouse_id,location:location.location,quantity:part.quantity*component.quantity,effect:st.inventory_effect});}
   }
  }
  assert.equal(total,l.requested);assert(a+l.prior_accepted<=l.ordered_quantity);const refund=Number(BigInt(l.line_total_minor)*BigInt(l.prior_accepted+a)/BigInt(l.ordered_quantity)-BigInt(l.line_total_minor)*BigInt(l.prior_accepted)/BigInt(l.ordered_quantity));decisions.push({item_id:l.item_id,accepted:a,restocked:r,custody:cu,rejected:re,refund_minor:refund});accepted+=a;restocked+=r;custody+=cu;rejected+=re;credit+=refund;
 }
 assert.equal(seen.size,parts.size);sameRows(plan.decisions,decisions,r=>r.item_id);sameRows(plan.arrivals,arrivals,r=>r.part_id+':'+r.product_id);assert.equal(p.request.locations.length,arrivals.length);
 assert(integer(source.requested_shipping_refund)&&integer(p.request.shipping_refund,0,source.requested_shipping_refund));
 const cells=new Map();for(const a of arrivals){const key=a.warehouse_id+':'+a.product_id,prior=cells.get(key);if(prior){assert.equal(prior.effect,a.effect);prior.quantity+=a.quantity;}else cells.set(key,{warehouse_id:a.warehouse_id,product_id:a.product_id,quantity:a.quantity,effect:a.effect});}
 assert(Array.isArray(source.stocks)&&Array.isArray(p.request.stock_versions));const effects=[];for(const cell of cells.values()){
  const old=source.stocks.find(x=>x.warehouse_id===cell.warehouse_id&&x.product_id===cell.product_id),cas=p.request.stock_versions.find(x=>x.warehouse_id===cell.warehouse_id&&x.product_id===cell.product_id);assert(old&&cas&&decimal(old.version)&&cas.version===old.version&&integer(old.on_hand)&&integer(old.reserved,0,old.on_hand)&&typeof old.exists==='boolean');if(!old.exists)assert(old.version==='0'&&old.on_hand===0&&old.reserved===0);if(cell.effect==='custody')assert.equal(old.reserved,0);
  effects.push({...cell,before:{exists:old.exists,version:old.version,on_hand:old.on_hand,reserved:old.reserved,physical_available:old.on_hand-old.reserved,sellable_available:cell.effect==='sale'?old.on_hand-old.reserved:0},after:{on_hand:old.on_hand+cell.quantity,reserved:old.reserved,physical_available:old.on_hand+cell.quantity-old.reserved,sellable_available:cell.effect==='sale'?old.on_hand+cell.quantity-old.reserved:0}});
 }assert.equal(p.request.stock_versions.length,cells.size);assert.equal(source.stocks.length,cells.size);sameRows(plan.stock_effects,effects,r=>r.warehouse_id+':'+r.product_id);
 if(source.wms.enabled){const used=new Map(),covered=new Map();for(const fragment of plan.fragments){exact(fragment,['part_id','item_id','product_id','warehouse_id','location','quantity','effect','issue_fragment_id','layer_id','currency']);const a=arrivals.find(a=>a.part_id===fragment.part_id&&a.product_id===fragment.product_id),issue=source.wms.issue_fragments.find(i=>i.id===fragment.issue_fragment_id);assert(a&&issue&&integer(fragment.quantity,1)&&issue.order_id===c.order_id&&issue.product_id===a.product_id&&issue.layer_id===fragment.layer_id&&issue.eligible_item_ids.includes(a.item_id)&&issue.currency===source.currency&&fragment.currency===source.currency);for(const k of['item_id','warehouse_id','location','effect'])assert.equal(fragment[k],a[k]);const n=(used.get(issue.id)??0)+fragment.quantity;assert(n<=issue.quantity-issue.returned_quantity);used.set(issue.id,n);const key=a.part_id+':'+a.product_id;covered.set(key,(covered.get(key)??0)+fragment.quantity);}
  for(const a of arrivals)assert.equal(covered.get(a.part_id+':'+a.product_id),a.quantity,'full-original-WMS-arrival-coverage');
 }else assert.equal(plan.fragments.length,0);
 const summary={accepted,restocked_to_sale:restocked,received_into_custody:custody,rejected,commercial_credit_minor:credit+p.request.shipping_refund,shipping_refund_minor:p.request.shipping_refund};assert.deepEqual(p.summary,summary);
 const core=p.core_input;assert(coercedVersion(core.version)&&Number(core.version)===Number(s.return_case.version)&&text(core.note,3,2000)&&core.note===core.note.trim()&&core.note===p.request.note);
 if(p.action==='receive'){assert(accepted>0&&integer(c.expected.receipt_sequence,1));exact(core,['version','shipping_refund','note','items']);assert.equal(core.shipping_refund,summary.shipping_refund_minor);sameRows(core.items,decisions.map(r=>({item_id:r.item_id,accepted:r.accepted,restocked:r.restocked})),r=>r.item_id);}
 else{assert.equal(c.expected.receipt_sequence,0);assert.equal(accepted,0);assert.equal(summary.commercial_credit_minor,0);assert.equal(summary.shipping_refund_minor,0);assert.equal(plan.arrivals.length,0);assert.equal(plan.stock_effects.length,0);assert.equal(plan.fragments.length,0);exact(core,['version','decision','note']);assert.equal(core.decision,'reject');}
 return p;
}
function completeDestination(c,d,tenant){
 const p=destinationPreview(c),o=d?.operation,r=d?.return_case;assert(d?.reused===false&&o&&uuid(o.id),'fresh-atomic-destination-operation-required');
 for(const[k,v]of Object.entries({kind:'operation',protocol:'destinations_v1',preview_id:c.preview_id,return_id:c.return_id,order_id:c.order_id,session_id:p.session_id,scope_hash:c.body.scope_hash,action:p.action}))assert.equal(o[k],v);
 assert.deepEqual(o.request,{client_key:c.client_key,scope_hash:c.body.scope_hash,confirmed:true});for(const k of['snapshot','core_input','summary'])assert.deepEqual(o[k],p[k],'entire-prepared-destination-'+k);
 assert(r&&r.id===c.return_id&&r.tenant_id===tenant&&r.order_id===c.order_id&&BigInt(r.version)===BigInt(p.core_input.version)+1n&&r.decision_note===p.core_input.note);assert(decimal(o.result?.version,1n),'durable-result-string-version-required');exact(o.result,destinationResultFields);const caseResult=Object.fromEntries(destinationResultFields.map(k=>[k,r[k]]));assert.deepEqual({...o.result,received_at:destinationTimestampMillis(o.result.received_at)},{...caseResult,received_at:destinationTimestampMillis(caseResult.received_at)},'durable-destination-result-matches-case');
 assert.equal(r.warehouse_id,p.snapshot.return_case.warehouse_id,'destination-case-warehouse-required');assert.equal(r.requested_shipping,p.snapshot.return_case.requested_shipping,'destination-case-requested-shipping-required');
 assert.equal(r.refund_amount,p.summary.commercial_credit_minor);assert.equal(r.refunded_shipping,p.summary.shipping_refund_minor);assert.equal(r.receipt_sequence,c.expected.receipt_sequence);
 if(p.action==='receive'){assert.equal(r.state,'refund_pending');assert.equal(r.acceptance_kind,'physical');assert(typeof r.received_at==='string'&&Number.isFinite(Date.parse(r.received_at)));assert.deepEqual(r.receipt,p.core_input,'entire-destination-core-receipt');}
 else{assert.equal(r.state,'rejected');assert.equal(r.acceptance_kind,null);assert.equal(r.receipt,null);assert.equal(r.received_at,null);}
 assert(Array.isArray(r.items));sameRows(r.items.map(i=>({item_id:i.item_id,accepted:i.accepted,restocked:i.restocked,refund_minor:i.refund_amount})),p.snapshot.plan.decisions.map(i=>({item_id:i.item_id,accepted:i.accepted,restocked:i.restocked,refund_minor:i.refund_minor})),r=>r.item_id);
}
function validateCommand(op,c){
 assert(c&&typeof c==='object');
 if(op==='order_list'||op==='catalog_search'){exact(c,['query','expected']);query(c.query,op);countRows(c.expected);return;}
 if(op==='order_detail'){exact(c,['order_id','expected']);assert(uuid(c.order_id));exact(c.expected,['version','status','total']);assert(version(c.expected.version)&&text(c.expected.status,1,40)&&integer(c.expected.total));return;}
 const common=['client_key','body','expected'];
 if(op==='order_create'){
  exact(c,common);fields(c.body,['customer_name','email','warehouse_id','source','currency','payment_mode','address','shipping_cost','items','note']);assert(text(c.body.customer_name,2,200)&&text(c.body.email,3,254)&&c.body.email.includes('@'));assert(uuid(c.body.warehouse_id)&&c.body.source==='manual'&&c.body.currency==='PLN'&&c.body.payment_mode==='prepaid');assert(integer(c.body.shipping_cost,0,1000000)&&text(c.body.note,0,2000));exact(c.body.address,['street','city','postal_code','country','phone']);for(const[k,v]of Object.entries(c.body.address))assert(text(v,0,k==='phone'?30:k==='postal_code'?20:k==='country'?2:200));assert.equal(c.body.address.country.length,2);assert(Array.isArray(c.body.items)&&c.body.items.length>=1&&c.body.items.length<=20);const seen=new Set();for(const i of c.body.items){exact(i,['product_id','quantity']);assert(uuid(i.product_id)&&integer(i.quantity,1,20)&&!seen.has(i.product_id));seen.add(i.product_id);}exact(c.expected,['total']);assert(integer(c.expected.total,c.body.shipping_cost));
 }else if(op==='reserve_and_status'){
  exact(c,[...common,'order_id']);assert(uuid(c.order_id));exact(c.body,['status','expected_version']);assert.equal(c.body.status,'picking','only-prepared-paid-to-picking');assert(version(c.body.expected_version));exact(c.expected,['total']);assert(integer(c.expected.total));
 }else if(op==='payment_or_document'){
  assert(['payment_receipt','native_invoice_issue','invoice230_issue'].includes(c.kind),'unsupported-payment-document-variant');exact(c,[...common,'kind','order_id',...(c.kind!=='payment_receipt'?['preview_id']:[])]);assert(uuid(c.order_id));
  if(c.kind==='payment_receipt'){
   exact(c.body,['client_key','version','kind','amount','fee','currency','method','reference','note','confirmed']);assert(uuid(c.body.client_key)&&coercedVersion(c.body.version)&&c.body.kind==='receipt'&&integer(c.body.amount,1)&&c.body.fee===0&&c.body.currency==='PLN'&&['bank_transfer','cash','card','other'].includes(c.body.method)&&text(c.body.reference,3,200)&&text(c.body.reference.trim(),3,200)&&text(c.body.note,0,2000)&&c.body.confirmed===true);exact(c.expected,['amount_due','net']);assert(integer(c.expected.amount_due)&&integer(c.expected.net));
  }else{assert(uuid(c.preview_id));exact(c.body,['client_key','scope_hash','confirmed','local_only']);assert(uuid(c.body.client_key)&&hash(c.body.scope_hash)&&c.body.confirmed===true&&c.body.local_only===true);exact(c.expected,['gross_minor']);assert(typeof c.expected.gross_minor==='string'&&/^(0|[1-9][0-9]*)$/.test(c.expected.gross_minor));}
 }else if(op==='stock_operation'&&c.kind==='wms_transfer'){
  exact(c,[...common,'kind','preview_id']);assert(uuid(c.preview_id));exact(c.body,['client_key','scope_hash','confirmed']);assert(uuid(c.body.client_key)&&hash(c.body.scope_hash)&&c.body.confirmed===true);
  exact(c.expected,['product_id','warehouse_id','destination_warehouse_id','destination_location','policy_version','quantity','fragments']);assert(uuid(c.expected.product_id)&&uuid(c.expected.warehouse_id)&&uuid(c.expected.destination_warehouse_id)&&c.expected.warehouse_id!==c.expected.destination_warehouse_id&&text(c.expected.destination_location,1,80)&&c.expected.destination_location===c.expected.destination_location.trim()&&decimal(c.expected.policy_version,1n)&&integer(c.expected.quantity,1,1000000));transferStockFragments(c.expected);
 }else if(op==='stock_operation'&&c.kind==='manual_off'){
  exact(c,[...common,'kind','preview_id']);assert(uuid(c.preview_id));exact(c.body,['client_key','scope_hash','confirmed']);assert(uuid(c.body.client_key)&&hash(c.body.scope_hash)&&c.body.confirmed===true);
  exact(c.expected,['product_id','warehouse_id','location','delta']);assert(uuid(c.expected.product_id)&&uuid(c.expected.warehouse_id)&&text(c.expected.location,1,80)&&c.expected.location===c.expected.location.trim()&&integer(c.expected.delta,-1000000,1000000)&&c.expected.delta!==0,'nonzero-prepared-manual-OFF-correction');
 }else if(op==='stock_operation'){
  exact(c,common);exact(c.body,['protocol','preview_id','client_key','scope_hash','confirmed']);assert(c.body.protocol==='wms_adjustment090'&&uuid(c.body.preview_id)&&uuid(c.body.client_key)&&hash(c.body.scope_hash)&&c.body.confirmed===true);exact(c.expected,['product_id','warehouse_id','policy_version','signed_delta',...(c.expected.signed_delta<0?['fragments']:[])]);assert(uuid(c.expected.product_id)&&uuid(c.expected.warehouse_id)&&decimal(c.expected.policy_version,1n)&&integer(c.expected.signed_delta,-1000000,1000000)&&c.expected.signed_delta!==0,'nonzero-prepared-WMS-adjustment');if(c.expected.signed_delta<0)negativeStockFragments(c.expected);
 }else if(op==='return_receive'&&c.kind==='return_destinations'){
  exact(c,[...common,'kind','return_id','order_id','preview_id']);assert(uuid(c.return_id)&&uuid(c.order_id)&&uuid(c.preview_id));exact(c.body,['client_key','scope_hash','confirmed','lease_token']);assert(uuid(c.body.client_key)&&hash(c.body.scope_hash)&&c.body.confirmed===true&&uuid(c.body.lease_token));exact(c.expected,['preview','receipt_sequence']);destinationPreview(c);
 }else if(op==='return_receive'){
  exact(c,[...common,'return_id','order_id']);assert(uuid(c.return_id)&&uuid(c.order_id));fields(c.body,['version','shipping_refund','note','items'],['wms_lots']);assert(coercedVersion(c.body.version)&&integer(c.body.shipping_refund,0,1000000)&&text(c.body.note,3,2000)&&text(c.body.note.trim(),3,2000));assert(Array.isArray(c.body.items)&&c.body.items.length>=1&&c.body.items.length<=100);const seen=new Set();for(const i of c.body.items){exact(i,['item_id','accepted','restocked']);assert(uuid(i.item_id)&&integer(i.accepted,0,100000)&&integer(i.restocked,0,i.accepted)&&!seen.has(i.item_id));seen.add(i.item_id);}if(c.body.wms_lots){const w=c.body.wms_lots;exact(w,['client_key','policy_version','stock_versions','picks']);assert(uuid(w.client_key)&&decimal(w.policy_version,1n));assert(Array.isArray(w.stock_versions)&&w.stock_versions.length>=1&&w.stock_versions.length<=500);for(const s of w.stock_versions){exact(s,['warehouse_id','product_id','version']);assert(uuid(s.warehouse_id)&&uuid(s.product_id)&&decimal(s.version));}assert(Array.isArray(w.picks)&&w.picks.length<=500);for(const p of w.picks){exact(p,['issue_fragment_id','quantity','location']);assert(uuid(p.issue_fragment_id)&&integer(p.quantity,1,1000000)&&text(p.location,1,80)&&p.location===p.location.trim());}}
  exact(c.expected,['refund_amount','receipt_sequence']);assert(integer(c.expected.refund_amount)&&integer(c.expected.receipt_sequence,1));
 }else assert.fail('unsupported-operation');
 assert(uuid(c.client_key)&&c.client_key[14]==='4','canonical-v4-client-key-required');if(Object.hasOwn(c.body,'client_key'))assert.equal(c.body.client_key,c.client_key);if(c.body.wms_lots)assert.equal(c.body.wms_lots.client_key,c.client_key);
}
/** Exact fixture API. No promise, function, credentials provider or source-code execution. */
export function validateFullBaseScaleHttpFixture(input,bindings){
 safeJson(input);assert(Buffer.byteLength(JSON.stringify(input))<=60000,'finite-fixture-exceeds-current-plan-context-budget');exact(input,['schema','source_pins','tenants']);assert.equal(input.schema,'dynaminds-full-base-scale-http-fixture/v1');assert.deepEqual(input.source_pins,SCALE_HTTP_PORT_SOURCE_PINS,'source-bound-http-contract');assert(Array.isArray(bindings)&&bindings.length===5);for(const k of['tenant_id','user_id'])assert.equal(new Set(bindings.map(b=>b[k])).size,5,'distinct-declared-fixture-identities-required');assert(Array.isArray(input.tenants)&&input.tenants.length===5);
 const allKeys=new Set();for(let i=0;i<5;i++){const t=input.tenants[i],b=bindings[i];exact(t,['slot','tenant_id','user_id','cookie','cases']);assert.equal(t.slot,slots[i]);assert.equal(b.slot,t.slot);assert(uuid(t.tenant_id)&&uuid(t.user_id));assert.equal(t.tenant_id,b.tenant_id);assert.equal(t.user_id,b.user_id);assert(text(t.cookie,1,8192),'ordinary-session-required');exact(t.cases,ops);for(const op of ops){const cases=t.cases[op];assert(Array.isArray(cases)&&cases.length>=1&&cases.length<=100,'all-eight-nonempty-finite-case-queues-required');for(const c of cases){validateCommand(op,c);if(c.client_key){const key=t.tenant_id+':'+c.client_key;assert(!allKeys.has(key),'fixture-reused-client-key');allKeys.add(key);}}}}
 return structuredClone(input);
}
function request(op,c,cookie){
 let method='GET',path,body=null;if(op==='order_list'||op==='catalog_search'){const q=new URLSearchParams();for(const[k,v]of Object.entries(c.query))q.set(k,String(v));path='/api/'+(op==='order_list'?'orders':'products')+'?'+q.toString();}
 else if(op==='order_detail')path='/api/orders/'+c.order_id;
 else{method=op==='reserve_and_status'?'PATCH':'POST';body=structuredClone(c.body);path=op==='order_create'?'/api/orders':op==='reserve_and_status'?'/api/orders/'+c.order_id+'/status':op==='payment_or_document'?c.kind==='payment_receipt'?'/api/orders/'+c.order_id+'/payments':'/api/local-invoices/previews/'+c.preview_id+'/issue':op==='stock_operation'?(c.kind==='wms_transfer'?'/api/wms-lots/movement-previews/'+c.preview_id+'/execute':c.kind==='manual_off'?'/api/inventory/manual-corrections/previews/'+c.preview_id+'/apply':'/api/inventory/adjust'):c.kind==='return_destinations'?'/api/return-destinations/previews/'+c.preview_id+'/receive':'/api/returns/'+c.return_id+'/receive';}
 return{method,path,headers:{cookie,...(body?{'content-type':'application/json','idempotency-key':c.client_key}:{})},body,client_key:body?c.client_key:null};
}
function amount(v){assert(integer(v),'safe-minor-amount-required');return v;}
function ownedOrder(d,tenant,id){assert(d&&uuid(d.id)&&d.tenant_id===tenant&&(!id||d.id===id),'own-order-response-required');assert(version(d.version)&&text(d.status,1,40));assert(Array.isArray(d.items)&&d.items.length>=1&&d.items.length<=100&&Array.isArray(d.events)&&d.events.length<=1000&&d.payment&&d.returns,'full-ordinary-order-detail-required');amount(d.total);amount(d.shipping_cost);const seen=new Set();let sum=0;for(const i of d.items){assert(uuid(i.id)&&uuid(i.product_id)&&integer(i.quantity,1)&&integer(i.line_total)&&!seen.has(i.id));seen.add(i.id);sum+=i.line_total;}assert.equal(sum+d.shipping_cost,d.total,'native-total-readback');}
/** Bounded original-receipt inspection only. A matching historical result is NOT
 * proof that this run created it. Completion also requires the atomic outcome. */
export function inspectScaleReturnReceiveReadback(c,d,tenant){
 safeJson(c);safeJson(d);validateCommand('return_receive',c);assert(uuid(tenant));
 assert(d&&d.id===c.return_id&&d.order_id===c.order_id&&d.tenant_id===tenant&&version(d.version)&&BigInt(d.version)>BigInt(c.body.version));
 assert(typeof d.received_at==='string'&&Number.isFinite(Date.parse(d.received_at))&&d.acceptance_kind==='physical');
 assert.equal(d.refund_amount,c.expected.refund_amount);assert.equal(d.receipt_sequence,c.expected.receipt_sequence);
 assert(Array.isArray(d.items)&&d.items.length===c.body.items.length);for(const i of c.body.items){const rows=d.items.filter(r=>r.item_id===i.item_id);assert.equal(rows.length,1);assert.equal(rows[0].accepted,i.accepted);assert.equal(rows[0].restocked,i.restocked);}
 // receiveInput coerces version to number and trims note; all other supplied
 // fields are already canonical and are preserved in the archived parsed body.
 const parsed={...structuredClone(c.body),version:Number(c.body.version),note:c.body.note.trim()};assert(Number.isSafeInteger(parsed.version));
 assert.deepEqual(d.receipt,parsed,'original-full-return-receipt-must-match-request');
 return Object.freeze({receipt_matches:true,freshness:'UNPROVEN',write_acceptance:false,scale_acceptance:false});
}
function complete(op,c,tenant,{http_status:status,data:d}){
 assert(status===((op==='order_create'||op==='payment_or_document'&&c.kind!=='payment_receipt'||op==='stock_operation'||op==='return_receive'&&c.kind==='return_destinations')?201:200),'fresh-http-status-required');
 if(op==='order_list'||op==='catalog_search'){
  assert(d&&Array.isArray(d.data)&&d.data.length>=c.expected.min_rows&&d.data.length<=c.expected.max_rows&&d.meta&&typeof d.meta.has_more==='boolean');assert(d.meta.has_more?typeof d.meta.cursor==='string'&&d.meta.cursor.length>0:d.meta.cursor===null);const seen=new Set();for(const row of d.data){assert(uuid(row.id)&&row.tenant_id===tenant&&!seen.has(row.id));seen.add(row.id);if(op==='order_list'){assert(version(row.version)&&text(row.status,1,40));amount(row.total);if(c.query.status)assert(c.query.status.split(',').includes(row.status));}else{assert(text(row.sku,1,200)&&text(row.name,1,500));}}
 }else if(op==='order_detail'||op==='order_create'||op==='reserve_and_status'){
  ownedOrder(d,tenant,op==='order_create'?null:c.order_id);assert.equal(d.total,c.expected.total);
  if(op==='order_detail'){assert.equal(String(d.version),String(c.expected.version));assert.equal(d.status,c.expected.status);}
  else if(op==='reserve_and_status'){assert.equal(d.status,c.body.status);assert(BigInt(d.version)>BigInt(c.body.expected_version),'status-version-must-advance');}
  else{assert.equal(d.status,'new');for(const k of['customer_name','email','warehouse_id','currency','payment_mode','shipping_cost'])assert.equal(d[k],c.body[k]);assert.deepEqual(d.items.map(i=>({product_id:i.product_id,quantity:i.quantity})).sort((a,b)=>a.product_id.localeCompare(b.product_id)),[...c.body.items].sort((a,b)=>a.product_id.localeCompare(b.product_id)));}
 }else if(op==='payment_or_document'&&c.kind==='payment_receipt'){
  assert(d&&d.reused===false&&uuid(d.payment_entry_id),'fresh-atomic-payment-outcome-required');
  assert(Array.isArray(d.data)&&d.data.length<=50&&d.balance);const entries=d.data.filter(e=>e.client_key===c.client_key);assert.equal(entries.length,1,'own-payment-entry-required');const e=entries[0];assert(e.id===d.payment_entry_id&&e.tenant_id===tenant&&e.order_id===c.order_id,'exact-atomic-payment-identity-required');
  const parsed={...structuredClone(c.body),version:Number(c.body.version),reference:c.body.reference.trim(),note:c.body.note.trim()};assert(Number.isSafeInteger(parsed.version));assert.deepEqual(e.request,parsed,'original-entire-payment-request-required');for(const k of['amount','fee','kind','currency','method','reference','note'])assert.equal(e[k],parsed[k]);assert.equal(d.balance.amount_due,c.expected.amount_due);assert.equal(d.balance.net,c.expected.net);
 }else if(op==='payment_or_document'&&c.kind==='invoice230_issue'){
  // 230 preview issued by the native /issue alias (tax-issue) into its own FV-S sub-series: no 157 receipt, the 230 record instead.
  assert(d&&d.reused===false&&d.invoice230===true&&d.document?.mode==='invoice230'&&d.document.kind==='invoice'&&uuid(d.document.id)&&d.document.order_id===c.order_id&&text(d.document.number,1,100)&&d.document.number.startsWith('FV-S/'),'fresh-230-invoice-required');
  assert.equal(d.document.data?.preview_id,c.preview_id);assert.equal(d.document.data.scope_hash,c.body.scope_hash);assert.equal(d.document.data.totals?.gross_minor,c.expected.gross_minor);assert.equal(d.document.data.local_only,true);
  assert(d.record&&uuid(d.record.series_id)&&Number.isSafeInteger(d.record.sequence)&&d.record.sequence>=1&&Number.isSafeInteger(d.record.year),'230-record-required');
 }else if(op==='payment_or_document'){
  assert(d&&d.reused===false&&d.document?.mode==='local_invoice'&&d.document.kind==='invoice'&&uuid(d.document.id)&&d.document.order_id===c.order_id&&text(d.document.number,1,100));const r=d.receipt;assert(r&&uuid(r.id)&&r.document_id===d.document.id&&r.preview_id===c.preview_id&&r.scope_hash===c.body.scope_hash);assert.equal(d.document.data?.totals?.gross_minor,c.expected.gross_minor);assert.equal(d.document.data.local_only,true);
 }else if(op==='stock_operation'&&c.kind==='wms_transfer'){
  assert(d&&d.reused===false&&uuid(d.operation?.id)&&d.operation.kind==='transfer'&&uuid(d.operation.warehouse_document_id),'fresh-native-transfer-required');assert.equal(d.operation.policy_version,c.expected.policy_version);
  assert(d.result&&Array.isArray(d.result.fragments)&&d.result.fragments.length===c.expected.fragments.length);for(const[k,v]of Object.entries({source_warehouse_id:c.expected.warehouse_id,destination_warehouse_id:c.expected.destination_warehouse_id,destination_location:c.expected.destination_location}))assert.equal(d.result[k],v,'exact-transfer-destination-required');
  for(const f of d.result.fragments)exact(f,transferFragmentFields);
  const sorted=rows=>rows.slice().sort((a,b)=>stockFragmentKey(a)<stockFragmentKey(b)?-1:stockFragmentKey(a)>stockFragmentKey(b)?1:0);
  assert.deepEqual(sorted(d.result.fragments),sorted(c.expected.fragments),'exact-prepared-transfer-fragments-required');assert.deepEqual(d.result.valuation,transferStockFragments(c.expected),'complete-transfer-valuation-required');
 }else if(op==='stock_operation'&&c.kind==='manual_off'){
  // Fresh receipt of exactly this preview and consent key; its request, PW/RW document row and both native journals.
  const r=d?.receipt,e=c.expected;assert(d&&d.reused===false&&r&&uuid(r.id)&&r.protocol==='manual_off_pw_rw_v1'&&r.preview_id===c.preview_id&&r.client_key===c.client_key&&r.scope_hash===c.body.scope_hash,'fresh-manual-OFF-receipt-required');
  for(const k of['product_id','warehouse_id','location','delta'])assert.equal(r.request?.[k],e[k],'exact-manual-OFF-request-required');
  const doc=r.document;assert(doc&&doc.id===r.id&&doc.kind===(e.delta>0?'PW':'RW')&&text(doc.number,1,100)&&doc.warehouse_id===e.warehouse_id&&Array.isArray(doc.rows)&&doc.rows.length===1,'manual-OFF-document-required');
  const row=doc.rows[0];assert(row.product_id===e.product_id&&row.location===e.location&&row.delta===e.delta&&row.quantity===Math.abs(e.delta),'exact-manual-OFF-document-row-required');
  assert(uuid(r.journals?.stock_movement_id)&&uuid(r.journals.location_movement_id),'manual-OFF-native-journals-required');
 }else if(op==='stock_operation'){
  assert(d&&d.reused===false&&d.correction_protocol==='wms_adjustment090'&&uuid(d.operation?.id)&&d.operation.kind==='adjustment');assert.equal(d.operation.policy_version,c.expected.policy_version);if(c.expected.signed_delta>0){assert.equal(d.result?.signed_delta,c.expected.signed_delta);assert(Array.isArray(d.result.layers)&&d.result.layers.length===1&&uuid(d.result.layers[0].layer_id));assert.equal(d.result.layers[0].product_id,c.expected.product_id);assert.equal(d.result.layers[0].warehouse_id,c.expected.warehouse_id);assert.equal(d.result.layers[0].quantity,c.expected.signed_delta);}
  else{
   assert(uuid(d.operation.warehouse_document_id),'negative-adjustment-own-warehouse-document-required');assert(d.result&&Array.isArray(d.result.fragments)&&d.result.fragments.length===c.expected.fragments.length,'negative-fragment-count-required');
   // Native issue DTO has positive fragment quantities, not a signed_delta field.
   // The negative direction comes from the prepared scope and their exact sum.
   assert(!Object.hasOwn(d.result,'signed_delta')&&!Object.hasOwn(d.result,'layers'),'ordinary-negative-issue-shape-required');
   const ids=new Set(),actual=d.result.fragments.map(f=>{assert(f&&uuid(f.id)&&!ids.has(f.id)&&f.product_id===c.expected.product_id,'own-unique-issued-fragment-required');ids.add(f.id);return Object.fromEntries(stockFragmentFields.map(k=>[k,f[k]]));});
   const sorted=rows=>rows.slice().sort((a,b)=>stockFragmentKey(a)<stockFragmentKey(b)?-1:stockFragmentKey(a)>stockFragmentKey(b)?1:0);
   assert.deepEqual(sorted(actual),sorted(c.expected.fragments),'exact-prepared-negative-fragments-required');
   assert.deepEqual(d.result.valuation,negativeStockFragments(c.expected),'complete-negative-valuation-required');
  }

 }else if(op==='return_receive'&&c.kind==='return_destinations'){
  completeDestination(c,d,tenant);
 }else if(op==='return_receive'){
  inspectScaleReturnReceiveReadback(c,d,tenant);assert(d.reused===false,'fresh-atomic-return-outcome-required');exact(d.receive_receipt,['return_id','receipt_sequence']);assert(d.receive_receipt.return_id===c.return_id&&integer(d.receive_receipt.receipt_sequence,1)&&d.receive_receipt.receipt_sequence===d.receipt_sequence&&d.receive_receipt.receipt_sequence===c.expected.receipt_sequence,'exact-atomic-return-identity-required');
 }
 return{outcome:'success',reason:null};
}
/** Partial binding API:40variant slots, never full frozen-profile acceptance. */
export function createPreparedScaleHttpOperationBindings({origin,bindings,context}){
 const url=new URL(origin);assert(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number(url.port)>=4101&&Number(url.port)<=4199&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&url.origin===origin,'owned-local-preview-only');exact(context,['fixture']);const fixture=validateFullBaseScaleHttpFixture(context.fixture,bindings),pending=new Map(),seenRequests=new Set(),freshEffects=new Set();let issued=0;const result={};
 for(const t of fixture.tenants){result[t.slot]={};for(const op of ops){let next=0;result[t.slot][op]={
  prepare(task){assert(task&&task.tenant_slot===t.slot&&task.operation===op&&text(task.request_id,1,120)&&!seenRequests.has(task.request_id),'single-original-task-required');assert(issued<100000,'bounded-port-request-registry');const cases=t.cases[op],write=op!=='order_list'&&op!=='catalog_search'&&op!=='order_detail';assert(!write||next<cases.length,'PREPARED_COMMAND_QUEUE_EXHAUSTED:'+t.slot+':'+op);const c=cases[next++%cases.length];seenRequests.add(task.request_id);issued++;pending.set(task.request_id,{op,c,task:structuredClone(task)});return request(op,c,t.cookie);},
  complete(response){const p=pending.get(response?.task?.request_id);assert(p&&p.op===op,'original-pending-task-required');assert.deepEqual(response.task,p.task,'original-task-scope-required');pending.delete(response.task.request_id);const result=complete(op,p.c,t.tenant_id,response);let effects=[];if(op==='order_create')effects=['order:'+response.data.id];else if(op==='payment_or_document')effects=[p.c.kind==='payment_receipt'?'payment:'+response.data.payment_entry_id:'document:'+response.data.document.id];else if(op==='stock_operation'&&p.c.kind==='manual_off')effects=['manual-off:'+response.data.receipt.id,'stock-movement:'+response.data.receipt.journals.stock_movement_id];else if(op==='stock_operation'){effects=['wms:'+response.data.operation.id];if(p.c.kind==='wms_transfer')effects.push('warehouse-document:'+response.data.operation.warehouse_document_id);else if(p.c.expected.signed_delta<0)effects.push('warehouse-document:'+response.data.operation.warehouse_document_id,...response.data.result.fragments.map(f=>'issue-fragment:'+f.id));}else if(op==='return_receive'){if(p.c.kind==='return_destinations'){effects=['return-destination:'+response.data.operation.id];if(p.c.expected.preview.action==='receive')effects.push('return:'+p.c.return_id+':'+response.data.return_case.receipt_sequence);else effects.push('return-reject:'+p.c.return_id+':'+response.data.return_case.version);}else effects=['return:'+response.data.receive_receipt.return_id+':'+response.data.receive_receipt.receipt_sequence];}const keys=effects.map(effect=>t.tenant_id+':'+effect);assert(freshEffects.size+keys.length<=100000,'bounded-business-effect-registry');for(const key of keys)assert(!freshEffects.has(key),'new-command-reused-prior-business-effect');for(const key of keys)freshEffects.add(key);return result;},
 };}}
 return result;
}

/** Missing implementation, fixture lifecycle and actual external gates cannot be
 * replaced with caller-supplied booleans. This full-profile entry point remains
 * NOT_RUN before an attempt marker, health read or any business request. */
export const SCALE_HTTP_FULL_PROFILE_BLOCKERS=Object.freeze([
 'read-case-and-variant-ratios-not-enforced',
 'reserve-status-contention-and-all-transitions-not-bound',
 'stock-current-versions-and-hot-SKU-mix-not-bound',
 'full-return-variant-mix-and-physical-financial-reconciliation-not-bound',
 'payment-document-equal-mix-and-reconciliation-not-enforced',
 'finite-hour-and-preview-lifecycle-not-implemented',
 'ordinary-five-tenant-identity-dataset-worker-import-sync-gates-unverified',
]);
export function createFullBaseScaleOperations(input){
 validateFullBaseScaleHttpFixture(input?.context?.fixture,input?.bindings);
 assert.fail('FULL_PROFILE_CAPABILITY_INCOMPLETE:'+SCALE_HTTP_FULL_PROFILE_BLOCKERS.join(','));
}
