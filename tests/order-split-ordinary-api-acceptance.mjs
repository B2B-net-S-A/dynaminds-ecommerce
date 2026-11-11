/** Inert ordinary split API acceptance, initial unpaid WMS OFF/ON only.
 * Run/import with node --import tsx. No DB, fixture creation, feature activation
 * or automatic retry. Public custody is not a complete SQL stock/layer oracle. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {validateSplitIntent,verifySplitCommand} from '../web/order-split-custody.ts';
import {ORDER_SPLIT_LIMITS as L,orderSplitPreviewInput} from '../server/order-splits-schema.ts';
import {validateFreshSplitCustomer,validateOrderSplitDedicatedOrigin} from '../tools/parity/order-split-ordinary-fixture.mjs';
import {localInvoiceLineAmounts} from '../server/local-invoice-values.ts';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const prefix='/api/order-splits',MAX=L.output_bytes;
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>assert.deepEqual(canonical(a),canonical(b));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const copy=v=>freeze(structuredClone(v));
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));same(Object.keys(v).sort(),keys.slice().sort());};
const int=(v,max=2147483647)=>assert(Number.isSafeInteger(v)&&v>=0&&v<=max);
export function validateOrderSplitOrdinaryProfile(v){
 exact(v,['baseUrl','expectedRevision','expectedSchema']);validateOrderSplitDedicatedOrigin(v.baseUrl);assert(SHA.test(v.expectedRevision));
 // A future registered schema must be provided from the independently reviewed
 // release, never copied from health. No current210 schema is claimed here.
 assert(typeof v.expectedSchema==='string'&&/^210_[a-z0-9_]{1,100}$/.test(v.expectedSchema));return copy(v);
}
export function validateOrderSplitOrdinaryFixture(v){
 exact(v,['schema','evidence','purpose','tenant_id','actor_id','warehouse_id','wms_mode','source_order_id','source_version','children','ui_reserved_order_ids']);
 assert.equal(v.schema,'dynaminds-order-split-ordinary-fixture/v2');assert.equal(v.evidence,'genuine_http_manual_unpaid_fresh_order');assert.equal(v.purpose,'ordinary_api');
 for(const k of ['tenant_id','actor_id','warehouse_id','source_order_id'])assert(UUID.test(v[k]));assert(['OFF','ON'].includes(v.wms_mode));
 assert(Array.isArray(v.ui_reserved_order_ids)&&v.ui_reserved_order_ids.length>0&&v.ui_reserved_order_ids.length<=100&&v.ui_reserved_order_ids.every(x=>UUID.test(x)&&x!==v.source_order_id));assert.equal(new Set(v.ui_reserved_order_ids).size,v.ui_reserved_order_ids.length);
 const body={client_key:'00000000-0000-4000-8000-000000000001',source_order_id:v.source_order_id,expected_source_version:v.source_version,children:v.children};same(orderSplitPreviewInput.parse(body),body);assert(Buffer.byteLength(JSON.stringify(v))<=L.request_bytes);return copy(v);
}
function pristine(o,f){
 assert(o&&o.id===f.source_order_id&&o.tenant_id===f.tenant_id&&String(o.version)===f.source_version);
 assert.equal(o.source,'manual');assert.equal(o.status,'new');assert.equal(o.fulfillment_kind,'sale');assert.equal(o.payment_mode,'prepaid');assert.equal(o.currency,'PLN');assert.equal(o.warehouse_id,f.warehouse_id);
 assert.equal(o.wms_lots_enabled===true,f.wms_mode==='ON');assert(!o.merge_claim&&!o.dropshipping&&!o.invoice_committed&&!o.shipping_active);
 for(const k of ['documents','shipments'])assert(Array.isArray(o[k])&&o[k].length===0);assert(Array.isArray(o.returns?.cases)&&o.returns.cases.length===0);assert(o.payment&&o.payment.net===0);
 assert(Array.isArray(o.items)&&o.items.length>0&&o.items.length<=100);const ids=new Set();let gross=0;
 for(const i of o.items){assert(UUID.test(i.id)&&UUID.test(i.product_id)&&!ids.has(i.id));ids.add(i.id);int(i.quantity,L.quantity);assert(i.quantity>0);int(i.price,L.unit_price_minor);int(i.line_total);assert([0,5,8,23].includes(i.vat));assert.equal(i.scanned,0);assert(typeof i.name==='string'&&typeof i.sku==='string');same(i.components,[{product_id:i.product_id,quantity:1}]);gross+=i.line_total;}
 int(o.shipping_cost,L.delivery_minor);int(o.total);assert.equal(gross+o.shipping_cost,o.total);
}
function publicCustody(o){
 assert(Array.isArray(o.picking_items)&&o.picking_items.length<=100);const totals=new Map();for(const i of o.items)totals.set(i.product_id,(totals.get(i.product_id)??0)+i.quantity);
 const seen=new Set(),out=new Map();for(const p of o.picking_items){assert(UUID.test(p.product_id)&&!seen.has(p.product_id));seen.add(p.product_id);assert.equal(p.quantity,totals.get(p.product_id));assert.equal(p.scanned,0);assert(Array.isArray(p.locations)&&p.locations.length<=1000);let total=0;const locations=new Set();for(const r of p.locations){assert(r.tenant_id===o.tenant_id&&r.order_id===o.id&&r.product_id===p.product_id&&r.warehouse_id===o.warehouse_id&&r.state==='active');assert(typeof r.location==='string'&&!locations.has(r.location));locations.add(r.location);int(r.quantity);assert.equal(r.scanned,0);assert.equal(r.consumed_quantity,0);assert.equal(r.released_quantity,0);total+=r.quantity;out.set(JSON.stringify([p.product_id,o.warehouse_id,r.location]),r.quantity);}assert.equal(total,p.quantity);}
 assert.equal(seen.size,totals.size);return out;
}
const receiverHash=o=>sha(JSON.stringify(canonical(validateFreshSplitCustomer({customer_name:o.customer_name,email:o.email,address:o.address}))));
function originalEvidence(o,f){
 pristine(o,f);return copy({id:o.id,tenant_id:o.tenant_id,version:String(o.version),warehouse_id:o.warehouse_id,currency:o.currency,payment_mode:o.payment_mode,wms_lots_enabled:o.wms_lots_enabled===true,total:o.total,shipping_cost:o.shipping_cost,items:o.items.map(i=>({id:i.id,product_id:i.product_id,name:i.name,sku:i.sku,quantity:i.quantity,price:i.price,vat:i.vat,line_total:i.line_total})),receiver_sha256:receiverHash(o),public_custody:[...publicCustody(o)].sort()});
}
async function freshBuyer(get,o){
 const access=await get('/api/orders/'+o.id+'/buyer-address-access');exact(access,['available','read_only','can_manage','order_version','policy_version','enabled','delivery_kind','classification_origin','delivery_version','effective_delivery','reason','last_change']);
 assert.equal(access.available,true);assert.equal(access.read_only,false);assert.equal(typeof access.can_manage,'boolean');assert.equal(access.order_version,String(o.version));assert.equal(access.policy_version,'0');assert.equal(access.enabled,false);assert.equal(access.delivery_kind,'unknown');assert.equal(access.classification_origin,'unknown');assert.equal(access.delivery_version,'0');assert.equal(access.effective_delivery,null);assert.equal(access.reason,'access_disabled');assert.equal(access.last_change,null);
 const history=await get('/api/orders/'+o.id+'/buyer-address-history');exact(history,['data','next_cursor']);same(history.data,[]);assert.equal(history.next_cursor,null);
}
function retainedState(value,p,f){
 assert(Buffer.byteLength(JSON.stringify(value))<=MAX);exact(value,['schema','origin','revision','schema_revision','tenant_id','actor_id','pending','commands','failures','trace']);assert.equal(value.schema,'order-split-ordinary-progress/v2');assert.equal(validateOrderSplitDedicatedOrigin(value.origin),p.baseUrl);assert.equal(value.revision,p.expectedRevision);assert.equal(value.schema_revision,p.expectedSchema);assert.equal(value.tenant_id,f.tenant_id);assert.equal(value.actor_id,f.actor_id);exact(value.pending,['operation','client_key']);assert(Array.isArray(value.commands)&&value.commands.length>=1&&value.commands.length<=2);assert(Array.isArray(value.failures)&&Array.isArray(value.trace));
 const keys=new Set();let original;
 for(const [i,c]of value.commands.entries()){
  exact(c,['operation','client_key','resource','serialized','request_body','intent','source_evidence','acknowledged_http_status','acknowledged_body_sha256','acknowledged_body_bytes','resolved']);assert.equal(c.operation,i===0?'preview':'execute');assert(UUID.test(c.client_key)&&!keys.has(c.client_key));keys.add(c.client_key);assert.equal(c.resource,prefix+(c.operation==='preview'?'/previews':'/executions'));assert.equal(c.serialized,JSON.stringify(c.request_body));assert.equal(c.request_body.client_key,c.client_key);assert.equal(typeof c.resolved,'boolean');
  assert(c.acknowledged_http_status===null||Number.isInteger(c.acknowledged_http_status)&&c.acknowledged_http_status>=100&&c.acknowledged_http_status<=599);assert(c.acknowledged_body_sha256===null||SHA.test(c.acknowledged_body_sha256));assert(c.acknowledged_body_bytes===null||Number.isSafeInteger(c.acknowledged_body_bytes)&&c.acknowledged_body_bytes>=0&&c.acknowledged_body_bytes<=MAX);
  const intent=validateSplitIntent(c.intent,f.tenant_id+':'+f.actor_id);assert.equal(intent.kind,c.operation);assert.equal(intent.serialized,c.serialized);assert.equal(intent.source.id,f.source_order_id);assert.equal(intent.source.version,f.source_version);if(i===0)same(c.request_body.children,f.children);
  const b=c.source_evidence;exact(b,['id','tenant_id','version','warehouse_id','currency','payment_mode','wms_lots_enabled','total','shipping_cost','items','receiver_sha256','public_custody']);assert.equal(b.id,f.source_order_id);assert.equal(b.tenant_id,f.tenant_id);assert.equal(b.version,f.source_version);assert.equal(b.warehouse_id,f.warehouse_id);assert.equal(b.currency,'PLN');assert.equal(b.payment_mode,'prepaid');assert.equal(b.wms_lots_enabled,f.wms_mode==='ON');assert(SHA.test(b.receiver_sha256));int(b.total);int(b.shipping_cost,L.delivery_minor);assert(Array.isArray(b.items)&&b.items.length>0&&b.items.length<=100);
  const ids=new Set();let total=0;for(const item of b.items){exact(item,['id','product_id','name','sku','quantity','price','vat','line_total']);assert(UUID.test(item.id)&&UUID.test(item.product_id)&&!ids.has(item.id));ids.add(item.id);assert(typeof item.name==='string'&&typeof item.sku==='string');int(item.quantity,L.quantity);assert(item.quantity>0);int(item.price,L.unit_price_minor);int(item.line_total);assert([0,5,8,23].includes(item.vat));total+=item.line_total;}assert.equal(total+b.shipping_cost,b.total);same(intent.source,{id:b.id,version:b.version,shipping_cost:b.shipping_cost,items:b.items.map(item=>({id:item.id,quantity:item.quantity}))});
  assert(Array.isArray(b.public_custody)&&b.public_custody.length<=100000);const seen=new Set(),totals=new Map();for(const entry of b.public_custody){assert(Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&!seen.has(entry[0]));seen.add(entry[0]);const k=JSON.parse(entry[0]);assert(Array.isArray(k)&&k.length===3&&UUID.test(k[0])&&k[1]===f.warehouse_id&&typeof k[2]==='string');int(entry[1],L.product_units);assert(entry[1]>0);totals.set(k[0],(totals.get(k[0])??0)+entry[1]);}const expectedTotals=new Map();for(const item of b.items)expectedTotals.set(item.product_id,(expectedTotals.get(item.product_id)??0)+item.quantity);same([...totals].sort(),[...expectedTotals].sort());
  if(original)same(b,original);else original=b;
  if(i===1){const first=value.commands[0];assert.equal(first.resolved,true);assert.equal(intent.preview.serialized,first.serialized);}
 }
 const last=value.commands.at(-1);assert.equal(last.resolved,false);same(value.pending,{operation:last.operation,client_key:last.client_key});return copy(value);
}
async function verifyResultOrders(get,review,before,f){
 const physicalAfter=new Map();for(const r of review.commercial.results){
  const o=await get('/api/orders/'+r.order_id);assert.equal(o.id,r.order_id);assert.equal(o.tenant_id,f.tenant_id);for(const k of ['warehouse_id','currency','payment_mode'])same(o[k],before[k]);assert.equal(o.warehouse_id,f.warehouse_id);assert.equal(receiverHash(o),before.receiver_sha256);await freshBuyer(get,o);
  assert.equal(o.source,'manual');assert.equal(o.status,'new');assert.equal(o.total,r.total_minor);assert.equal(o.shipping_cost,r.delivery_minor);assert.equal(o.payment?.net,0);assert.equal(o.wms_lots_enabled===true,f.wms_mode==='ON');assert.equal(o.items.length,r.items.length);
  for(const a of r.items){const item=o.items.find(i=>i.id===a.target_item_id);assert(item);for(const[k,v]of Object.entries({product_id:a.product_id,quantity:a.quantity,price:a.price,vat:a.vat,line_total:a.gross_minor}))same(item[k],v);}
  for(const[k,q]of publicCustody(o))physicalAfter.set(k,(physicalAfter.get(k)??0)+q);
 }
 same([...physicalAfter].sort(),before.public_custody);
}

function commercial(value,intent,head,before){
 exact(value,['schema','currency','ready','shipping_tax','conflicts','original','results']);assert.equal(value.schema,'order-split-commercial-review/v1');assert.equal(value.currency,before.currency);assert.equal(value.ready,intent.kind==='preview'?head.ready:true);assert.equal(value.shipping_tax,'not_allocated');same(value.conflicts,[]);assert.equal(value.ready,true,'Initial positive acceptance cannot substitute a refused VAT allocation');
 const plan=JSON.parse(intent.kind==='preview'?intent.serialized:intent.preview.serialized),ordered=[...plan.children].sort((a,b)=>a.slot_id.localeCompare(b.slot_id)),bind=new Map(head.children.map(c=>[c.slot_id,c.order_id])),originals=new Map(before.items.map(i=>[i.id,i])),offsets=new Map(),targets=new Set(),seenRows=new Set();assert(Array.isArray(value.results)&&value.results.length===ordered.length+1);
 let G=0,N=0,V=0,D=0;const originalNet=before.items.reduce((n,i)=>n+Number(localInvoiceLineAmounts(i.line_total,i.vat).net_minor),0);
 for(const [index,r]of value.results.entries()){
  exact(r,['kind','slot_id','order_id','name','items','items_gross_minor','items_net_minor','items_vat_minor','delivery_minor','total_minor']);const retained=index===ordered.length,c=ordered[index];
  assert.equal(r.kind,retained?'retained_source':'child');assert.equal(r.slot_id,retained?null:c.slot_id);assert.equal(r.order_id,retained?before.id:bind.get(c.slot_id));assert.equal(r.name,retained?null:c.name);assert.equal(r.delivery_minor,retained?before.shipping_cost-plan.children.reduce((n,x)=>n+x.delivery_minor,0):c.delivery_minor);
  const quantities=new Map(retained?before.items.map(i=>[i.id,i.quantity-plan.children.reduce((n,x)=>n+x.items.filter(a=>a.source_item_id===i.id).reduce((s,a)=>s+a.quantity,0),0)]).filter(([,q])=>q>0):c.items.map(a=>[a.source_item_id,a.quantity]));assert(Array.isArray(r.items)&&r.items.length===quantities.size);let g=0,n=0,v=0;const rows=new Set();
  for(const a of r.items){exact(a,['source_item_id','target_item_id','product_id','name','sku','quantity','price','vat','gross_minor','net_minor','vat_minor','price_adjustment_minor','original_quantity','original_gross_minor','original_net_minor','original_vat_minor']);const o=originals.get(a.source_item_id);assert(o&&!rows.has(o.id)&&UUID.test(a.target_item_id)&&!targets.has(a.target_item_id));rows.add(o.id);targets.add(a.target_item_id);assert.equal(a.quantity,quantities.get(o.id));for(const k of ['product_id','name','sku','price','vat'])same(a[k],o[k]);assert.equal(a.original_quantity,o.quantity);assert.equal(a.original_gross_minor,o.line_total);
   const money=localInvoiceLineAmounts(o.line_total,o.vat),gross=BigInt(o.line_total),net=BigInt(money.net_minor),start=offsets.get(o.id)??0,end=start+a.quantity,g0=gross*BigInt(start)/BigInt(o.quantity),g1=gross*BigInt(end)/BigInt(o.quantity);assert(end<=o.quantity);offsets.set(o.id,end);assert.equal(a.original_net_minor,Number(net));assert.equal(a.original_vat_minor,Number(money.vat_minor));assert.equal(a.gross_minor,Number(g1-g0));assert.equal(a.net_minor,Number(gross===0n?0n:net*g1/gross-net*g0/gross));assert.equal(a.vat_minor,a.gross_minor-a.net_minor);assert.equal(a.price_adjustment_minor,a.gross_minor-a.price*a.quantity);assert.equal(a.vat_minor,Number(localInvoiceLineAmounts(a.gross_minor,a.vat).vat_minor));assert(a.price_adjustment_minor<a.quantity);if(retained)assert.equal(a.target_item_id,o.id);g+=a.gross_minor;n+=a.net_minor;v+=a.vat_minor;seenRows.add(o.id);
  }
  for(const [k,x]of Object.entries({items_gross_minor:g,items_net_minor:n,items_vat_minor:v,total_minor:g+r.delivery_minor}))assert.equal(r[k],x);G+=g;N+=n;V+=v;D+=r.delivery_minor;
 }
 assert.equal(seenRows.size,before.items.length);for(const i of before.items)assert.equal(offsets.get(i.id),i.quantity);same(value.original,{items_gross_minor:G,items_net_minor:N,items_vat_minor:V,delivery_minor:D,total_minor:G+D});assert.equal(G,before.total-before.shipping_cost);assert.equal(N,originalNet);assert.equal(D,before.shipping_cost);return value;
}
// File fsync alone does not persist its directory entry. Both the fresh run
// directory and its custody files must be durable before any network request.
async function syncDirectory(directory){
 const h=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 let first;try{const s=await h.stat();assert(s.isDirectory()&&s.uid===process.getuid());await h.sync();}catch(e){first=e;throw e;}finally{try{await h.close();}catch(e){if(!first)throw e;}}
}
/** All missing inputs return before filesystem/transport. Output directory is
 * fresh0700; its exclusive attempt prevents silent re-execution. Each business
 * POST has an append-only durable exact body/key before dispatch. */
export async function runOrderSplitOrdinaryAcceptance(options={}){return runAcceptance(options,null);}
/** Explicit original-key GET-only reconciliation. Auth POSTs are the sole
 * exception; this never executes/continues a split or mutates the old journal. */
export async function reconcileOrderSplitOrdinaryAcceptance(options={}){const {retainedAttempt,...rest}=options;assert(retainedAttempt,'Original retained attempt is required');return runAcceptance(rest,retainedAttempt);}
async function runAcceptance({profile:input,fixture:given,login,outputDirectory,onProgress,fetcher,signal}={},retained){
 const missing=Object.entries({profile:input,fixture:given,login,outputDirectory}).filter(([,x])=>x==null).map(([k])=>k);if(missing.length)return copy({status:'PREPARED_NOT_RUN',missing,network_requests:0,split_acceptance:false});
 const p=validateOrderSplitOrdinaryProfile(input),f=validateOrderSplitOrdinaryFixture(given),recovery=retained===null?null:retainedState(retained,p,f);exact(login,['email','password']);assert(typeof login.email==='string'&&login.email.length<=254&&login.email.includes('@')&&typeof login.password==='string'&&login.password.length>=8&&login.password.length<=1024);assert(path.isAbsolute(outputDirectory)&&path.resolve(outputDirectory)===outputDirectory);assert.equal(await fs.realpath(path.dirname(outputDirectory)),path.dirname(outputDirectory));assert(fetcher===undefined||typeof fetcher==='function');assert(onProgress===undefined||typeof onProgress==='function');
 await fs.mkdir(outputDirectory,{mode:0o700});await syncDirectory(path.dirname(outputDirectory));const attempt=await fs.open(path.join(outputDirectory,'attempt.private.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await attempt.writeFile(JSON.stringify({schema:'order-split-ordinary-attempt/v2',origin:p.baseUrl,schema_revision:p.expectedSchema,revision:p.expectedRevision,tenant_id:f.tenant_id,source_order_id:f.source_order_id,mode:recovery?'original_key_get_only_reconciliation':'new_explicit_acceptance'})+'\n');await attempt.sync();}finally{await attempt.close();}
 const journal=await fs.open(path.join(outputDirectory,'events.private.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await syncDirectory(outputDirectory);}catch(e){try{await journal.close();}catch{}throw e;}
 const commands=recovery?structuredClone(recovery.commands):[],trace=[],failures=[];let pending=recovery?structuredClone(recovery.pending):null,cookie='',requests=0,bytes=0,failed=false;
 const progress=()=>copy({schema:'order-split-ordinary-progress/v2',origin:p.baseUrl,schema_revision:p.expectedSchema,revision:p.expectedRevision,tenant_id:f.tenant_id,actor_id:f.actor_id,pending,commands,failures,trace});
 async function emit(event){const v=copy({...event,progress:progress()}),raw=JSON.stringify(v)+'\n';bytes+=Buffer.byteLength(raw);assert(bytes<=8*1024*1024);await journal.writeFile(raw);await journal.sync();if(onProgress)await onProgress(v);}
 async function request(resource,method='GET',body,command){
  assert(resource.startsWith('/api/')&&!resource.includes('..'));assert(!recovery||method==='GET'||method==='POST'&&['/api/auth/login','/api/workspaces/switch'].includes(resource),'Reconciliation permits business GET only');const ctrl=new AbortController(),abort=()=>ctrl.abort();signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,120000);let response,raw,reason='transport_failure';
  try{requests++;response=await (fetcher??fetch)(new URL(resource,p.baseUrl).href,{method,headers:{...(cookie?{cookie,'X-Workspace-ID':f.tenant_id}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:ctrl.signal});if(command)command.acknowledged_http_status=response.status;reason='unexpected_origin';assert(response.url===''||new URL(response.url).origin===p.baseUrl);trace.push({method,resource,status:response.status});if(command)command.acknowledged_http_status=response.status;
   reason='missing_response_stream';const reader=response.body?.getReader();assert(reader);const chunks=[];let n=0;try{for(;;){reason='response_read_failure';const x=await reader.read();if(x.done)break;n+=x.value.length;reason='response_oversize';assert(n<=MAX);chunks.push(x.value);}}finally{try{await reader.cancel();}catch{}reader.releaseLock();}raw=Buffer.concat(chunks);if(command){command.acknowledged_body_sha256=sha(raw);command.acknowledged_body_bytes=raw.length;}reason='unexpected_content_type';assert(/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type')??''));reason='invalid_utf8';const decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw);reason='invalid_json';const value=JSON.parse(decoded);reason='unexpected_status';if(response.status!==200)throw Error('HTTP_STATUS');return{value,response};
  }catch(e){let diagnostic=null;if(raw)try{const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));diagnostic={};for(const k of ['code','write_outcome'])if(typeof v?.[k]==='string'&&/^[A-Za-z0-9_]{1,100}$/.test(v[k]))diagnostic[k]=v[k];}catch{}const failure={method,resource,status:response?.status??null,reason,diagnostic,kind:response?'http_or_protocol_failure':'unconfirmed_transport',body_sha256:raw?sha(raw):null,body_bytes:raw?.length??null};failures.push(failure);await emit({phase:'http_failure',...failure});throw Error('HTTP_RESULT_UNCONFIRMED_NO_RETRY');}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);ctrl.abort();if(response?.body&&!response.body.locked)try{await response.body.cancel();}catch{}}
 }
 const get=async r=>(await request(r)).value;
 async function authority(){const h=await get('/api/health');assert.equal(h.status,'ok');assert.equal(h.revision,p.expectedRevision);assert.equal(h.schema_revision,p.expectedSchema);assert.equal(h.order_splits_available,true);assert.equal(h.restore_preview,false);const m=await get('/api/auth/me');assert.equal(m.restore_preview,false);assert.notEqual(m.read_only,true);assert.equal(m.user?.tenant_id,f.tenant_id);assert.equal(m.user.id,f.actor_id);assert(['admin','operator'].includes(m.user.role));}
 function cookieOf(r){const values=r.headers.getSetCookie?.()??[];assert(values.length>0);cookie=values.map(x=>x.split(';')[0]).join('; ');assert(cookie&&!/[\r\n]/.test(cookie));}
 async function write(kind,body,intent,sourceEvidence){assert(!recovery);await authority();const command={operation:kind,client_key:body.client_key,resource:prefix+(kind==='preview'?'/previews':'/executions'),serialized:JSON.stringify(body),request_body:copy(body),intent:copy(intent),source_evidence:sourceEvidence,acknowledged_http_status:null,acknowledged_body_sha256:null,acknowledged_body_bytes:null,resolved:false};commands.push(command);pending={operation:kind,client_key:body.client_key};await emit({phase:'before_original_command_dispatch',operation:kind,client_key:body.client_key,serialized:command.serialized,request_body:body});const response=await request(command.resource,'POST',body,command);return{head:response.value,command};}
 async function pages(base,suffix,total){const result=[],seen=new Set();let cursor=null,rows=0,size=0;for(let n=0;n<=total;n++){const q=cursor===null?'?limit=100':'?limit=100&cursor='+encodeURIComponent(cursor),p=await get(base+'/'+suffix+q);exact(p,['data','meta']);exact(p.meta,['total','cursor']);assert.equal(p.meta.total,total);assert(Array.isArray(p.data)&&p.data.length<=100);rows+=p.data.length;size+=Buffer.byteLength(JSON.stringify(p));assert(rows<=total&&size<=MAX);result.push({requested_cursor:cursor,...p});const next=p.meta.cursor;assert(next===null||typeof next==='string'&&next.length>0&&next.length<=2048&&!seen.has(next));if(next===null){assert.equal(rows,total);return result;}assert(p.data.length>0&&rows<total);seen.add(next);cursor=next;}assert.fail('Incomplete pages');}
 async function evidence(intent,ack){const body=JSON.parse(intent.serialized),kind=intent.kind,command=await get(prefix+'/commands/'+body.client_key+'?operation='+kind),h=command[kind==='preview'?'preview':'execution'];if(ack!==undefined)same(h,ack);assert(UUID.test(h?.id)&&h.source_order_id===f.source_order_id&&Array.isArray(h.children)&&h.children.length===f.children.length);assert(h.children.every(c=>!f.ui_reserved_order_ids.includes(c.order_id)),'API and UI fixtures must remain distinct');const base=prefix+'/'+(kind==='preview'?'previews':'executions')+'/'+h.id;same(await get(base+'/head'),h);const source=await get(base+'/source');const readback={source,source_pages:await pages(base,'source-items',intent.source.items.length),children_pages:await pages(base,'children',f.children.length)};verifySplitCommand(command,intent,readback);return{head:h,commercial:await get(base+'/commercial')};}
 try{
  const health=await get('/api/health');assert.equal(health.status,'ok');assert.equal(health.revision,p.expectedRevision);assert.equal(health.schema_revision,p.expectedSchema);assert.equal(health.restore_preview,false);
  if(health.order_splits_available!==true){await emit({phase:'not_run_missing_split_readiness'});return copy({status:'NOT_RUN_NATIVE210_UNAVAILABLE',network_requests:requests,split_acceptance:false});}
  await emit({phase:'before_auth_login',method:'POST',resource:'/api/auth/login'});cookieOf((await request('/api/auth/login','POST',login)).response);await emit({phase:'before_workspace_switch',method:'POST',resource:'/api/workspaces/switch',request_body:{tenant_id:f.tenant_id}});cookieOf((await request('/api/workspaces/switch','POST',{tenant_id:f.tenant_id})).response);await authority();
  if(recovery){
   const first=commands[0],last=commands.at(-1),before=first.source_evidence;
   const pe=await evidence(first.intent);commercial(pe.commercial,first.intent,pe.head,before);
   let result=pe;
   if(last.operation==='execute'){
    same({id:pe.head.id,scope_hash:pe.head.scope_hash,children:pe.head.children},{id:last.intent.preview.id,scope_hash:last.intent.preview.scope_hash,children:last.intent.preview.children});
    const ee=await evidence(last.intent);commercial(ee.commercial,last.intent,ee.head,before);same(ee.commercial,pe.commercial);await verifyResultOrders(get,ee,before,f);result=ee;
   }else{const current=await get('/api/orders/'+f.source_order_id);pristine(current,f);same(originalEvidence(current,f),before);await freshBuyer(get,current);}
   await authority();last.resolved=true;pending=null;await emit({phase:'original_command_reconciled_get_only',operation:last.operation,client_key:last.client_key,result_id:result.head.id});
   return copy({status:fetcher?'PASS_CONTROLLED_GET_ONLY_RECONCILIATION':'PASS_ORIGINAL_COMMAND_GET_ONLY_RECONCILIATION',origin:p.baseUrl,revision:p.expectedRevision,schema_revision:p.expectedSchema,warehouse_id:f.warehouse_id,wms_mode:f.wms_mode,operation:last.operation,result_id:result.head.id,network_requests:requests,business_posts:0,original_journal_mutated:false,continued_execution:false,physical_transfer_acceptance:false,sql_stock_layer_oracle_performed:false,ui_acceptance:false,full_split_acceptance:false});
  }
  const before=await get('/api/orders/'+f.source_order_id);pristine(before,f);await freshBuyer(get,before);const sourceEvidence=originalEvidence(before,f);
  const previewBody=orderSplitPreviewInput.parse({client_key:randomUUID(),source_order_id:f.source_order_id,expected_source_version:f.source_version,children:f.children});const source={id:before.id,version:f.source_version,shipping_cost:before.shipping_cost,items:before.items.map(i=>({id:i.id,quantity:i.quantity}))};const intent=validateSplitIntent({schema:'order-split-custody/v1',actor:f.tenant_id+':'+f.actor_id,kind:'preview',serialized:JSON.stringify(previewBody),source},f.tenant_id+':'+f.actor_id);
  const pResult=await write('preview',previewBody,intent,sourceEvidence),pe=await evidence(intent,pResult.head);commercial(pe.commercial,intent,pe.head,before);await authority();pResult.command.resolved=true;pending=null;await emit({phase:'original_preview_verified',preview_id:pe.head.id});
  const fresh=await get('/api/orders/'+f.source_order_id);pristine(fresh,f);same(originalEvidence(fresh,f),sourceEvidence);await freshBuyer(get,fresh);
  const executeBody={client_key:randomUUID(),preview_id:pe.head.id,scope_hash:pe.head.scope_hash,confirmed:true};const execution=validateSplitIntent({...intent,kind:'execute',serialized:JSON.stringify(executeBody),preview:{id:pe.head.id,scope_hash:pe.head.scope_hash,serialized:intent.serialized,children:pe.head.children}},intent.actor);
  const eResult=await write('execute',executeBody,execution,sourceEvidence),ee=await evidence(execution,eResult.head);same(ee.commercial,pe.commercial);
  await verifyResultOrders(get,ee,sourceEvidence,f);const again=await evidence(execution,eResult.head);same(again,ee);await authority();eResult.command.resolved=true;pending=null;await emit({phase:'original_execution_verified',execution_id:ee.head.id});
  return copy({status:fetcher?'PASS_CONTROLLED_API':'PASS_ORDINARY_API_ONLY',origin:p.baseUrl,revision:p.expectedRevision,schema_revision:p.expectedSchema,wms_mode:f.wms_mode,source_order_id:before.id,preview_id:pe.head.id,execution_id:ee.head.id,children:ee.head.children,network_requests:requests,public_quantity_money_location_readback:true,buyer_address_fresh_history_readback:true,warehouse_id:f.warehouse_id,physical_transfer_acceptance:false,sql_stock_layer_oracle_performed:false,ui_acceptance:false,full_split_acceptance:false});
 }catch(e){failed=true;try{await emit({phase:'failed_no_retry'});}catch{}const error=Error('ORDER_SPLIT_ACCEPTANCE_FAILED_NO_RETRY');error.acceptanceProgress=progress();throw error;}
 finally{try{await journal.close();}catch{if(!failed)throw Error('PRIVATE_JOURNAL_CLOSE_FAILED');}}
}
