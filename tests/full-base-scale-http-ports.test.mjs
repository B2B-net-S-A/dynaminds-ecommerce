import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createFullBaseScaleOperations,validateFullBaseScaleHttpFixture,SCALE_HTTP_PORT_SOURCE_PINS,SCALE_HTTP_PORT_LIMITATIONS,inspectScaleReturnReceiveReadback,SCALE_HTTP_PORT_COVERAGE,createPreparedScaleHttpOperationBindings,SCALE_HTTP_FULL_PROFILE_BLOCKERS} from '../scripts/full-base-scale-http-ports.mjs';
import {validateScaleOperationPorts,SCALE_SLOTS,SCALE_OPERATIONS} from '../scripts/full-base-scale-executor.mjs';
import {runFullBaseScaleDriver,FULL_BASE_SCALE_PROFILE_SHA256} from '../scripts/full-base-scale-driver.mjs';
const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`,hash='a'.repeat(64),origin='http://127.0.0.1:4103',sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const bindings=SCALE_SLOTS.map((slot,i)=>({slot,tenant_id:id(i+1),user_id:id(i+10)}));
 const f={schema:'dynaminds-full-base-scale-http-fixture/v1',source_pins:{...SCALE_HTTP_PORT_SOURCE_PINS},tenants:bindings.map((b,i)=>{const n=1000*(i+1),order=id(n+1),product=id(n+2),warehouse=id(n+3),item=id(n+4);return{...b,cookie:'synthetic-cookie-'+b.slot,cases:{
  order_list:[{query:{limit:50,status:'new'},expected:{min_rows:1,max_rows:50}},{query:{limit:50,after:'prepared-history-cursor'},expected:{min_rows:0,max_rows:50}}],
  catalog_search:[{query:{limit:50,search:'SKU',warehouse_id:warehouse},expected:{min_rows:1,max_rows:50}},{query:{limit:50,search:'genuine-no-hit'},expected:{min_rows:0,max_rows:0}}],
  order_detail:[{order_id:order,expected:{version:'3',status:'paid',total:123}}],
  order_create:[{client_key:id(n+10),body:{customer_name:'Synthetic owned buyer',email:'owned@example.invalid',warehouse_id:warehouse,source:'manual',currency:'PLN',payment_mode:'prepaid',address:{street:'Test1',city:'Test',postal_code:'00-001',country:'PL',phone:''},shipping_cost:0,items:[{product_id:product,quantity:1}],note:'Synthetic scale'},expected:{total:123}}],
  reserve_and_status:[{order_id:order,client_key:id(n+11),body:{status:'picking',expected_version:'3'},expected:{total:123}}],
  payment_or_document:[{kind:'payment_receipt',order_id:order,client_key:id(n+12),body:{client_key:id(n+12),version:3,kind:'receipt',amount:123,fee:0,currency:'PLN',method:'bank_transfer',reference:'Synthetic payment',note:'',confirmed:true},expected:{amount_due:0,net:123}},{kind:'native_invoice_issue',order_id:order,preview_id:id(n+20),client_key:id(n+13),body:{client_key:id(n+13),scope_hash:hash,confirmed:true,local_only:true},expected:{gross_minor:'123'}},{kind:'invoice230_issue',order_id:order,preview_id:id(n+25),client_key:id(n+17),body:{client_key:id(n+17),scope_hash:hash,confirmed:true,local_only:true},expected:{gross_minor:'123'}}],
  stock_operation:[{client_key:id(n+14),body:{protocol:'wms_adjustment090',preview_id:id(n+21),client_key:id(n+14),scope_hash:hash,confirmed:true},expected:{product_id:product,warehouse_id:warehouse,policy_version:'2',signed_delta:1}}],
  return_receive:[{return_id:id(n+22),order_id:order,client_key:id(n+15),body:{version:2,shipping_refund:0,note:'Synthetic accepted return',items:[{item_id:item,accepted:1,restocked:1}]},expected:{refund_amount:123,receipt_sequence:1}},{return_id:id(n+23),order_id:order,client_key:id(n+16),body:{version:'2',shipping_refund:0,note:'Synthetic WMS return',items:[{item_id:item,accepted:1,restocked:1}],wms_lots:{client_key:id(n+16),policy_version:'2',stock_versions:[{warehouse_id:warehouse,product_id:product,version:'3'}],picks:[{issue_fragment_id:id(n+24),quantity:1,location:'A-1'}]}},expected:{refund_amount:123,receipt_sequence:2}}],
 }};})};return{bindings,fixture:f};
}
function setup(){const f=fixture();return{...f,ports:createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}})};}
const task=(slot,op,n=0)=>({request_id:'controlled:'+slot+':'+op+':'+n,tenant_slot:slot,operation:op,sequence:n,client:0,phase:'steady12',measured:true});
function order(t,c,{create=false,status='paid',version='3'}={}){return{id:create?id(9999):c.order_id,tenant_id:t.tenant_id,version,status,total:123,shipping_cost:0,items:[{id:id(9000),product_id:t.cases.order_create[0].body.items[0].product_id,quantity:1,line_total:123}],events:[],payment:{amount_due:0,net:123},returns:{cases:[]},...(create?{...t.cases.order_create[0].body,items:[{id:id(9000),product_id:t.cases.order_create[0].body.items[0].product_id,quantity:1,line_total:123}]}:{})};}
function response(t,op,c){
 if(op==='order_list')return{http_status:200,data:{data:[{id:id(999),tenant_id:t.tenant_id,version:'1',status:'new',total:123}],meta:{has_more:false,cursor:null}}};
 if(op==='catalog_search')return{http_status:200,data:{data:[{id:id(998),tenant_id:t.tenant_id,sku:'SKU-1',name:'Product'}],meta:{has_more:false,cursor:null}}};
 if(['order_create','order_detail','reserve_and_status'].includes(op))return{http_status:op==='order_create'?201:200,data:order(t,c,{create:op==='order_create',status:op==='order_create'?'new':op==='reserve_and_status'?'picking':'paid',version:op==='reserve_and_status'?'4':'3'})};
 if(op==='payment_or_document'&&c.kind==='payment_receipt')return{http_status:200,data:{reused:false,payment_entry_id:id(997),balance:{amount_due:0,net:123},data:[{id:id(997),tenant_id:t.tenant_id,order_id:c.order_id,...c.body,request:{...structuredClone(c.body),version:Number(c.body.version),reference:c.body.reference.trim(),note:c.body.note.trim()}}],next:null}};
 if(op==='payment_or_document'&&c.kind==='invoice230_issue')return{http_status:201,data:{reused:false,invoice230:true,document:{id:id(992),order_id:c.order_id,number:'FV-S/FV/2026/000001',kind:'invoice',mode:'invoice230',data:{local_only:true,preview_id:c.preview_id,scope_hash:c.body.scope_hash,totals:{gross_minor:'123'}}},record:{series_id:id(991),year:2026,sequence:1}}};
 if(op==='payment_or_document')return{http_status:201,data:{reused:false,document:{id:id(996),order_id:c.order_id,number:'FV/1/2026',kind:'invoice',mode:'local_invoice',data:{local_only:true,totals:{gross_minor:'123'}}},receipt:{id:id(995),document_id:id(996),preview_id:c.preview_id,scope_hash:c.body.scope_hash}}};
 if(op==='stock_operation')return{http_status:201,data:{reused:false,correction_protocol:'wms_adjustment090',operation:{id:id(994),kind:'adjustment',policy_version:'2'},result:{signed_delta:1,layers:[{layer_id:id(993),product_id:c.expected.product_id,warehouse_id:c.expected.warehouse_id,quantity:1}]}}};
 return{http_status:200,data:{reused:false,receive_receipt:{return_id:c.return_id,receipt_sequence:c.expected.receipt_sequence},id:c.return_id,tenant_id:t.tenant_id,order_id:c.order_id,version:'3',received_at:'2026-10-18T01:00:00.000Z',acceptance_kind:'physical',refund_amount:123,receipt_sequence:c.expected.receipt_sequence,items:c.body.items,receipt:{...structuredClone(c.body),version:Number(c.body.version),note:c.body.note.trim()}}};
}
function roundtrip(ports,t,op,index=0,patch){const p=ports[t.slot][op],q=task(t.slot,op,index),c=t.cases[op][index],request=p.prepare(q),r=response(t,op,c);patch?.(r);return{request,result:p.complete({task:q,...r})};}
test('the dataURL-loaded partial bindings are inert and source-pinned; full driver capability is refused',async()=>{
 for(const[name,digest]of Object.entries(SCALE_HTTP_PORT_SOURCE_PINS))assert.equal(sha(fs.readFileSync(new URL('../'+name,import.meta.url))),digest,name);
 const bytes=fs.readFileSync(new URL('../scripts/full-base-scale-http-ports.mjs',import.meta.url)),m=await import('data:text/javascript;base64,'+bytes.toString('base64')),f=fixture();assert(validateScaleOperationPorts(m.createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}})));assert.throws(()=>m.createFullBaseScaleOperations({origin,bindings:f.bindings,context:{fixture:f.fixture}}),/FULL_PROFILE_CAPABILITY_INCOMPLETE/);assert(SCALE_HTTP_PORT_LIMITATIONS.some(x=>x.includes('acceptance')));
});
test('40 implemented variant slots bind ordinary HTTP and atomic outcomes without claiming full profile coverage',()=>{
 const {ports,fixture:f}=setup();let n=0;for(const t of f.tenants)for(const op of Object.keys(SCALE_OPERATIONS)){
  const{request:r,result}=roundtrip(ports,t,op);assert.equal(result.outcome,'success');assert.equal(typeof result.then,'undefined');assert.equal(r.headers.cookie,t.cookie);assert(r.path.startsWith('/api/'));assert.equal(r.client_key,SCALE_OPERATIONS[op]==='write'?t.cases[op][0].client_key:null);if(r.client_key)assert.equal(r.headers['idempotency-key'],r.client_key);n++;
 }assert.equal(n,40);assert.equal(SCALE_HTTP_PORT_COVERAGE.full_profile_binding,false);assert.equal(SCALE_HTTP_PORT_COVERAGE.supported_variant_slots,40);assert(SCALE_HTTP_FULL_PROFILE_BLOCKERS.length>=1);
});
test('native invoice and WMS RMA variants retain exact prepared scope and body with atomic fresh evidence',()=>{
 const{ports,fixture:f}=setup(),t=f.tenants[0];for(const op of['payment_or_document','return_receive']){roundtrip(ports,t,op);const{request:r,result}=roundtrip(ports,t,op,1);assert.equal(result.outcome,'success');assert.deepEqual(r.body,t.cases[op][1].body);assert(op==='payment_or_document'?r.path===`/api/local-invoices/previews/${t.cases[op][1].preview_id}/issue`:r.path===`/api/returns/${t.cases[op][1].return_id}/receive`);}
});
test('finite commands, failed outcomes and lost ACK keep original custody and never recycle a queue',()=>{
 const{ports,fixture:f}=setup(),t=f.tenants[0],p=ports.A.order_create,q=task('A','order_create');const r=p.prepare(q);assert.deepEqual(r.body,t.cases.order_create[0].body);r.body.items[0].quantity=99;assert.equal(t.cases.order_create[0].body.items[0].quantity,1);assert.throws(()=>p.prepare(q),/single-original/);assert.throws(()=>p.prepare(task('A','order_create',1)),/QUEUE_EXHAUSTED/);assert.throws(()=>p.complete({task:q,http_status:503,data:{}}),/fresh-http/);assert.throws(()=>p.complete({task:q,...response(t,'order_create',t.cases.order_create[0])}),/pending/);
});
test('foreign task, tenant/order, totals/quantities/version and reused native writes cannot be accepted',()=>{
 const cases=[['order_detail',r=>r.data.tenant_id=id(999)],['order_detail',r=>r.data.id=id(999)],['order_detail',r=>r.data.version='4'],['order_create',r=>r.data.items[0].quantity=2],['order_create',r=>r.data.items[0].line_total=122],['reserve_and_status',r=>r.data.version='3'],['stock_operation',r=>r.data.reused=true],['stock_operation',r=>r.data.result.layers[0].product_id=id(999)]];
 for(const[op,patch]of cases){const{ports,fixture:f}=setup();assert.throws(()=>roundtrip(ports,f.tenants[0],op,0,patch),op);}
 const{ports,fixture:f}=setup(),q=task('A','order_detail');ports.A.order_detail.prepare(q);assert.throws(()=>ports.A.order_detail.complete({task:{...q,tenant_slot:'B'},...response(f.tenants[0],'order_detail',f.tenants[0].cases.order_detail[0])}),/scope/);
});
test('prepared fixture refuses stale sources, incomplete ops, foreign identities, conflicting keys and unsupported variants',()=>{
 const mutations=[f=>f.source_pins['server/app.ts']='b'.repeat(64),f=>f.tenants.pop(),f=>delete f.tenants[0].cases.stock_operation,f=>f.tenants[0].tenant_id=id(999),f=>f.tenants[0].cases.stock_operation[0].body.scope_hash='bad',f=>f.tenants[0].cases.payment_or_document[0].body.client_key=id(999),f=>f.tenants[0].cases.payment_or_document[0].kind='external_invoice',f=>f.tenants[0].cases.stock_operation[0].expected.signed_delta=0,f=>f.tenants[0].cases.reserve_and_status[0].body.status='packed',f=>f.tenants[0].cases.return_receive[1].body.wms_lots.client_key=id(999)];for(const mutate of mutations){const{fixture:f,bindings}=fixture();mutate(f);assert.throws(()=>validateFullBaseScaleHttpFixture(f,bindings));}
 const{fixture:f,bindings}=fixture();f.tenants[0].cases.order_create[0].client_key=f.tenants[0].cases.reserve_and_status[0].client_key;assert.throws(()=>validateFullBaseScaleHttpFixture(f,bindings),/reused-client-key/);
});
test('fixture captures immutable request data and refuses getters/extra credentials without invoking them',()=>{
 const{fixture:f,bindings}=fixture();let getters=0;Object.defineProperty(f,'extra',{enumerable:true,get(){getters++;return 1;}});assert.throws(()=>validateFullBaseScaleHttpFixture(f,bindings),/data-only/);assert.equal(getters,0);const other=fixture();other.fixture.tenants[0].cases.order_create[0].body.password='not-allowed';assert.throws(()=>validateFullBaseScaleHttpFixture(other.fixture,other.bindings),/unknown-password/);
 const s=setup(),q=task('A','order_detail');s.fixture.tenants[0].cases.order_detail[0].order_id=id(999);assert.equal(s.ports.A.order_detail.prepare(q).path,'/api/orders/'+id(1001));
});
test('list pagination, own identities, search/no-hit response constraints stay enforced',()=>{
 for(const[op,patch]of[['order_list',r=>r.data.meta.cursor='unexpected'],['order_list',r=>r.data.data[0].tenant_id=id(999)],['catalog_search',r=>r.data.data.push(r.data.data[0])]]){const s=setup();assert.throws(()=>roundtrip(s.ports,s.fixture.tenants[0],op,0,patch));}
 const s=setup(),t=s.fixture.tenants[0];roundtrip(s.ports,t,'catalog_search');const q=task('A','catalog_search',1),request=s.ports.A.catalog_search.prepare(q);assert(request.path.includes('search=genuine-no-hit'));assert.deepEqual(s.ports.A.catalog_search.complete({task:q,http_status:200,data:{data:[],meta:{has_more:false,cursor:null}}}),{outcome:'success',reason:null});
});
test('native invoice scope/gross/preview identity and return physical receipt are required',()=>{
 for(const patch of[r=>r.data.reused=true,r=>r.data.receipt.preview_id=id(999),r=>r.data.receipt.scope_hash='b'.repeat(64),r=>r.data.document.data.totals.gross_minor='124']){const s=setup(),t=s.fixture.tenants[0];roundtrip(s.ports,t,'payment_or_document');assert.throws(()=>roundtrip(s.ports,t,'payment_or_document',1,patch));}
});
test('the real driver refuses the known incomplete full-family module before health, marker or business HTTP',async()=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'dyna-scale-http-ports-'));
 try{const f=fixture(),modulePath=fileURLToPath(new URL('../scripts/full-base-scale-http-ports.mjs',import.meta.url)),moduleBytes=fs.readFileSync(modulePath),profilePath=fileURLToPath(new URL('../docs/parity/acceptance-profile.v1.json',import.meta.url)),profileBytes=fs.readFileSync(profilePath),plan={schema:'dynaminds-full-base-scale-http-plan/v1',run_id:id(100),origin,expected_revision:hash,expected_schema:'209_order_merge_delivery_inheritance',profile:{path:profilePath,bytes:profileBytes.length,sha256:FULL_BASE_SCALE_PROFILE_SHA256},operation_module:{path:modulePath,bytes:moduleBytes.length,sha256:sha(moduleBytes)},bindings:f.bindings,context:{fixture:f.fixture}},file=path.join(dir,'plan.private.json'),bytes=Buffer.from(JSON.stringify(plan));assert(bytes.length<=65536);fs.writeFileSync(file,bytes,{mode:0o600});let calls=0;
 const result=await runFullBaseScaleDriver(['--run',file,sha(bytes),path.join(dir,'out')],{fetcher:async()=>{calls++;throw Error('no network may precede capability refusal');}});assert.equal(result.status,'NOT_RUN_INCOMPLETE_OPERATION_PORTS');assert.equal(result.network_requests,0);assert.equal(result.scale_acceptance,false);assert.equal(calls,0);assert(!fs.existsSync(file+'.attempt.private.json'));assert(!fs.existsSync(path.join(dir,'out')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a different retained key cannot turn the same acknowledged business order into a new successful creation',()=>{
 const f=fixture(),t=f.fixture.tenants[0],second={...structuredClone(t.cases.order_create[0]),client_key:id(7777)};t.cases.order_create.push(second);const ports=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}});roundtrip(ports,t,'order_create');assert.throws(()=>roundtrip(ports,t,'order_create',1),/reused-prior-business-effect/);
});

test('original return readback compares full parsed receipt including WMS and never grants freshness',()=>{
 const {fixture:f}=fixture(),t=f.tenants[0];for(const c of t.cases.return_receive){const d=response(t,'return_receive',c).data;assert.deepEqual(inspectScaleReturnReceiveReadback(c,d,t.tenant_id),{receipt_matches:true,freshness:'UNPROVEN',write_acceptance:false,scale_acceptance:false});for(const mutate of[d=>delete d.receipt,d=>d.receipt.note='another operator input',d=>d.receipt.items[0].restocked=0,d=>d.receipt.version=99,d=>d.receipt.extra=true,d=>d.tenant_id=id(999),d=>d.received_at=null]){const changed=structuredClone(d);mutate(changed);assert.throws(()=>inspectScaleReturnReceiveReadback(c,changed,t.tenant_id));}}
 const c=t.cases.return_receive[1],d=response(t,'return_receive',c).data;for(const mutate of[d=>d.receipt.wms_lots.client_key=id(999),d=>d.receipt.wms_lots.stock_versions[0].version='99',d=>d.receipt.wms_lots.picks[0].location='WRONG',d=>d.receipt.wms_lots.picks[0].issue_fragment_id=id(999),d=>d.receipt.wms_lots.picks[0].quantity=2,d=>delete d.receipt.wms_lots]){const changed=structuredClone(d);mutate(changed);assert.throws(()=>inspectScaleReturnReceiveReadback(c,changed,t.tenant_id));}
});
test('catalog alias-only matches are legal server-filtered results and order query bounds match actual source',()=>{
 const s=setup(),t=s.fixture.tenants[0];assert.equal(roundtrip(s.ports,t,'catalog_search',0,r=>{r.data.data[0].sku='CURRENT-CODE';r.data.data[0].name='Current product';r.data.data[0].product_sku_edit_available=true;}).result.outcome,'success');
 for(const[k,max]of[['tag',40],['status',100]]){const f=fixture();f.fixture.tenants[0].cases.order_list[0].query[k]='X'.repeat(max);assert(validateFullBaseScaleHttpFixture(f.fixture,f.bindings));f.fixture.tenants[0].cases.order_list[0].query[k]+='X';assert.throws(()=>validateFullBaseScaleHttpFixture(f.fixture,f.bindings));}
});

test('RMA prepared subset follows actual parsed note/location and string WMS decimal contracts including stock zero',()=>{
 const make=()=>{const f=fixture();return{...f,c:f.fixture.tenants[0].cases.return_receive[1]};};
 const valid=make();valid.c.body.version='2';valid.c.body.note='  Three words  ';valid.c.body.wms_lots.stock_versions[0].version='0';assert(validateFullBaseScaleHttpFixture(valid.fixture,valid.bindings));const d=response(valid.fixture.tenants[0],'return_receive',valid.c).data;assert.equal(d.receipt.note,'Three words');assert.equal(d.receipt.version,2);assert.equal(inspectScaleReturnReceiveReadback(valid.c,d,valid.bindings[0].tenant_id).freshness,'UNPROVEN');
 for(const mutate of[c=>c.body.note=' a ',c=>c.body.wms_lots.policy_version=2,c=>c.body.wms_lots.policy_version='0',c=>c.body.wms_lots.stock_versions[0].version=0,c=>c.body.wms_lots.stock_versions[0].version='-1',c=>c.body.wms_lots.stock_versions[0].version='9223372036854775808',c=>c.body.wms_lots.picks[0].location=' A ',c=>c.body.wms_lots.picks[0].location=' ',c=>c.body.version='9007199254740992']){const f=make();mutate(f.c);assert.throws(()=>validateFullBaseScaleHttpFixture(f.fixture,f.bindings));}
});

test('first historical payment or RMA outcome is never a fresh sample, and old responses without atomic flags refuse',()=>{
 for(const op of['payment_or_document','return_receive'])for(const mutate of[r=>r.data.reused=true,r=>delete r.data.reused]){const s=setup();assert.throws(()=>roundtrip(s.ports,s.fixture.tenants[0],op,0,mutate),/fresh-atomic/);}
});
test('payment success requires the exact atomic entry UUID and complete parsed ledger request plus business readback',()=>{
 for(const mutate of[r=>delete r.data.payment_entry_id,r=>r.data.payment_entry_id=id(999),r=>r.data.data[0].tenant_id=id(999),r=>r.data.data[0].order_id=id(999),r=>r.data.data[0].client_key=id(999),r=>delete r.data.data[0].request,r=>r.data.data[0].request.version=99,r=>r.data.data[0].request.amount=999,r=>r.data.data[0].request.client_key=id(999),r=>r.data.balance.net=0,r=>r.data.data.push(structuredClone(r.data.data[0]))]){const s=setup();assert.throws(()=>roundtrip(s.ports,s.fixture.tenants[0],'payment_or_document',0,mutate));}
});
test('RMA fresh outcome binds exact durable sequenced identity and full receipt, including every original WMS selection',()=>{
 for(const mutate of[r=>delete r.data.receive_receipt,r=>r.data.receive_receipt=null,r=>r.data.receive_receipt.return_id=id(999),r=>r.data.receive_receipt.receipt_sequence=0,r=>r.data.receive_receipt.receipt_sequence=99,r=>r.data.receive_receipt.extra=true,r=>r.data.receipt.note='Changed request',r=>r.data.receipt.items[0].restocked=0]){const s=setup();assert.throws(()=>roundtrip(s.ports,s.fixture.tenants[0],'return_receive',0,mutate));}
 for(const mutate of[r=>r.data.reused=true,r=>r.data.receipt.wms_lots.client_key=id(999),r=>r.data.receipt.wms_lots.stock_versions[0].version='99',r=>r.data.receipt.wms_lots.picks[0].location='FOREIGN']){const s=setup(),t=s.fixture.tenants[0];roundtrip(s.ports,t,'return_receive');assert.throws(()=>roundtrip(s.ports,t,'return_receive',1,mutate));}
});
test('payment/RMA lost ACK retains original request custody and cannot authorize automatic preparation or POST retry',()=>{
 for(const op of['payment_or_document','return_receive']){const s=setup(),t=s.fixture.tenants[0],p=s.ports.A[op],q=task('A',op),r=p.prepare(q),original=structuredClone(r);assert.throws(()=>p.prepare(q),/single-original-task/);assert.deepEqual(r,original);const historical=response(t,op,t.cases[op][0]);historical.data.reused=true;assert.throws(()=>p.complete({task:q,...historical}),/fresh-atomic/);assert.throws(()=>p.complete({task:q,...response(t,op,t.cases[op][0])}),/pending/);}
});

function negativeStockCase(){
 const f=fixture(),t=f.fixture.tenants[0],c=t.cases.stock_operation[0];
 c.expected.signed_delta=-3;c.expected.fragments=[
  {layer_id:id(8101),lot_id:id(8201),lot_code:'LOT-Ł',location:'A-1',quantity:2,unit_cost_minor:'17',value_minor:'34',currency:'PLN'},
  {layer_id:id(8102),lot_id:id(8202),lot_code:'OPENING',location:'A-1',quantity:1,unit_cost_minor:null,value_minor:null,currency:'PLN'},
 ];
 const data={reused:false,correction_protocol:'wms_adjustment090',operation:{id:id(8300),kind:'adjustment',policy_version:c.expected.policy_version,warehouse_document_id:id(8400)},result:{fragments:c.expected.fragments.map((r,i)=>({...structuredClone(r),id:id(8500+i),product_id:c.expected.product_id})),valuation:{currency:'PLN',quantity:'3',known_minor:'34',unknown_quantity:'1',known_quantity:'2'}}};
 return{...f,t,c,data};
}
function negativeStockRoundtrip(change){
 const f=negativeStockCase();change?.(f);const ports=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}),q=task('A','stock_operation'),request=ports.A.stock_operation.prepare(q);
 return{f,request,result:ports.A.stock_operation.complete({task:q,http_status:201,data:f.data})};
}
test('prepared negative WMS issue binds signed total, exact existing layers and known/unknown valuation without inventing positive DTO fields',()=>{
 const {f,request,result}=negativeStockRoundtrip();assert.equal(result.outcome,'success');assert.equal(request.path,'/api/inventory/adjust');assert.deepEqual(request.body,f.c.body);assert.equal(f.c.expected.signed_delta,-3);assert(!('signed_delta' in f.data.result));assert(!('layers' in f.data.result));
 assert.equal(negativeStockRoundtrip(f=>f.data.result.fragments.reverse()).result.outcome,'success','fragment roster compares identities, not presentation order');
 assert(SCALE_HTTP_FULL_PROFILE_BLOCKERS.length===7);assert.equal(SCALE_HTTP_PORT_COVERAGE.full_profile_binding,false);assert(SCALE_HTTP_PORT_COVERAGE.blocked_variants.includes('financial_partner_acceptance'));
});
test('negative WMS fixture refuses absent/duplicate layers, wrong sign totals, malformed exact costs and unsupported extra scope',()=>{
 for(const mutate of[
  f=>delete f.c.expected.fragments,f=>f.c.expected.fragments=[],f=>f.c.expected.signed_delta=3,f=>f.c.expected.signed_delta=-4,
  f=>f.c.expected.fragments.push(structuredClone(f.c.expected.fragments[0])),f=>f.c.expected.fragments[0].quantity=-2,
  f=>f.c.expected.fragments[0].value_minor='35',f=>f.c.expected.fragments[1].value_minor='0',f=>f.c.expected.fragments[0].unit_cost_minor=17,
  f=>f.c.expected.fragments[0].location=' A-1 ',f=>f.c.expected.fragments[0].currency='EUR',f=>f.c.expected.fragments[0].extra=true,
 ]){const f=negativeStockCase();mutate(f);assert.throws(()=>validateFullBaseScaleHttpFixture(f.fixture,f.bindings));}
});
test('negative WMS readback refuses replay, foreign identities, quantity/cost/lot/location drift and missing durable warehouse document',()=>{
 for(const mutate of[
  f=>f.data.reused=true,f=>delete f.data.reused,f=>f.data.operation.id='bad',f=>f.data.operation.kind='transfer',
  f=>f.data.operation.policy_version='3',f=>delete f.data.operation.warehouse_document_id,f=>f.data.operation.warehouse_document_id='bad',
  f=>f.data.result.fragments[0].id='bad',f=>f.data.result.fragments[1].id=f.data.result.fragments[0].id,
  f=>f.data.result.fragments[0].product_id=id(999),f=>f.data.result.fragments[0].layer_id=id(999),f=>f.data.result.fragments[0].lot_id=id(999),
  f=>f.data.result.fragments[0].lot_code='OTHER',f=>f.data.result.fragments[0].location='B-1',f=>f.data.result.fragments[0].quantity=1,
  f=>f.data.result.fragments[0].unit_cost_minor='18',f=>f.data.result.fragments[0].value_minor='36',f=>f.data.result.fragments[1].unit_cost_minor='0',
  f=>f.data.result.fragments.pop(),f=>f.data.result.signed_delta=-3,f=>f.data.result.layers=[],f=>f.data.result.valuation.known_minor='35',
  f=>f.data.result.valuation.unknown_quantity=null,
 ])assert.throws(()=>negativeStockRoundtrip(mutate));
});
test('negative adjustment loses no custody on missing ACK and cannot recycle original command or count old operation as new',()=>{
 const f=negativeStockCase(),c=structuredClone(f.c);c.client_key=id(8600);c.body.client_key=c.client_key;c.body.preview_id=id(8601);f.t.cases.stock_operation.push(c);
 const ports=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}),p=ports.A.stock_operation,q=task('A','stock_operation');p.prepare(q);assert.throws(()=>p.prepare(q),/single-original/);assert.throws(()=>p.complete({task:q,http_status:503,data:{}}),/fresh-http/);assert.throws(()=>p.complete({task:q,http_status:201,data:f.data}),/pending/);
 const q2=task('A','stock_operation',1);p.prepare(q2);assert.equal(p.complete({task:q2,http_status:201,data:f.data}).outcome,'success');assert.throws(()=>p.prepare(task('A','stock_operation',2)),/QUEUE_EXHAUSTED/);
 const g=negativeStockCase(),second=structuredClone(g.c);second.client_key=id(8700);second.body.client_key=second.client_key;second.body.preview_id=id(8701);g.t.cases.stock_operation.push(second);const p2=createPreparedScaleHttpOperationBindings({origin,bindings:g.bindings,context:{fixture:g.fixture}}).A.stock_operation;
 for(const i of[0,1]){const q=task('A','stock_operation',i);p2.prepare(q);if(i===0)assert.equal(p2.complete({task:q,http_status:201,data:g.data}).outcome,'success');else assert.throws(()=>p2.complete({task:q,http_status:201,data:g.data}),/reused-prior-business-effect/);}
});
test('negative fixture matches the actual ordinary issue fragment builder and durable record result shape',()=>{
 const source=fs.readFileSync(new URL('../server/wms-lots.ts',import.meta.url),'utf8');
 const issue=source.slice(source.indexOf('export async function issueWmsLotsInTx('),source.indexOf('export type WmsReturnScope'));
 const push=issue.match(/fragments\.push\((\{[\s\S]*?\n    \})\);/);assert(push,'actual issue fragment builder required');
 const build=Function('b','row','id','value','return ('+push[1]+');');
 const f=negativeStockCase(),fragments=f.c.expected.fragments.map((row,i)=>build({product_id:f.c.expected.product_id},row,id(8500+i),{known_minor:row.value_minor}));
 assert.deepEqual(fragments,f.data.result.fragments,'actual ordinary builder includes exactly the prepared lot/cost fields and new fragment identity');
 const result=issue.match(/recordOperation\(c, a, context, op, (\{[\s\S]*?\n  \})\)/);assert(result,'actual durable issue result required');
 const actual=Function('fragments','rows','wmsValueSummary','return ('+result[1]+');')(fragments,f.c.expected.fragments,()=>structuredClone(f.data.result.valuation));
 assert.deepEqual(actual,f.data.result);assert(!Object.hasOwn(actual,'signed_delta'));assert(!Object.hasOwn(actual,'layers'));
 assert(source.includes("else if (kind === 'issue' || r.quantity < 0)"));assert(source.includes('result: r.result, reused: false'));
});

for(const reuse of['warehouse-document','issue-fragment'])test('negative WMS refuses cross-command '+reuse+' reuse with a new operation and registers no partial effect set',()=>{
  const f=negativeStockCase();for(const n of[8800,8900]){const c=structuredClone(f.c);c.client_key=id(n);c.body.client_key=c.client_key;c.body.preview_id=id(n+1);f.t.cases.stock_operation.push(c);}
  const p=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}).A.stock_operation;
  const run=(index,data)=>{const q=task('A','stock_operation',index);p.prepare(q);return p.complete({task:q,http_status:201,data});};
  assert.equal(run(0,f.data).outcome,'success');
  const invalid=structuredClone(f.data);invalid.operation.id=id(9001);invalid.operation.warehouse_document_id=id(9002);invalid.result.fragments.forEach((r,i)=>r.id=id(9003+i));
  if(reuse==='warehouse-document')invalid.operation.warehouse_document_id=f.data.operation.warehouse_document_id;
  else invalid.result.fragments[1].id=f.data.result.fragments[1].id;
  assert.throws(()=>run(1,invalid),/reused-prior-business-effect/,reuse+' must refuse even when operation UUID is new');
  // Reuse the otherwise NEW identities from the refused response. If an earlier
  // key had been registered before finding the duplicate, this clean result
  // would incorrectly fail. No HTTP retry is performed: this is command #3.
  const valid=structuredClone(invalid);if(reuse==='warehouse-document')valid.operation.warehouse_document_id=id(9102);else valid.result.fragments[1].id=id(9103);
  assert.equal(run(2,valid).outcome,'success','failed duplicate check must register none of its new identities');
});

function transferCase(){
 const f=fixture(),t=f.fixture.tenants[0],prior=t.cases.stock_operation[0];
 const fragments=[{layer_id:id(10101),lot_id:id(10201),lot_code:'LOT-Ł',location:'A-1',quantity:2,unit_cost_minor:'17',currency:'PLN',fifo_sequence:'1'},{layer_id:id(10102),lot_id:id(10202),lot_code:'OPENING',location:'A-1',quantity:1,unit_cost_minor:null,currency:'PLN',fifo_sequence:'2'}];
 const c={kind:'wms_transfer',client_key:prior.client_key,preview_id:prior.body.preview_id,body:{client_key:prior.client_key,scope_hash:hash,confirmed:true},expected:{product_id:prior.expected.product_id,warehouse_id:prior.expected.warehouse_id,destination_warehouse_id:id(10300),destination_location:'B-1',policy_version:'2',quantity:3,fragments}};
 t.cases.stock_operation=[c];const data={reused:false,available:true,read_only:false,can_transfer:true,operation:{id:id(10400),kind:'transfer',warehouse_document_id:id(10500),policy_version:'2'},result:{fragments:structuredClone(fragments),source_warehouse_id:c.expected.warehouse_id,destination_warehouse_id:c.expected.destination_warehouse_id,destination_location:c.expected.destination_location,valuation:{currency:'PLN',quantity:'3',known_minor:'34',unknown_quantity:'1',known_quantity:'2'}}};return{...f,t,c,data};
}
function transferRoundtrip(mutate){const f=transferCase();mutate?.(f);const p=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}).A.stock_operation,q=task('A','stock_operation'),request=p.prepare(q);return{f,request,result:p.complete({task:q,http_status:201,data:f.data})};}
test('prepared inter-warehouse transfer binds the real execute route and exact positive-quantity FIFO fragments, not issue/receipt fields',()=>{
 const {f,request,result}=transferRoundtrip();assert.equal(result.outcome,'success');assert.equal(request.path,'/api/wms-lots/movement-previews/'+f.c.preview_id+'/execute');assert.deepEqual(request.body,f.c.body);assert(!('protocol' in request.body));assert(!('signed_delta' in f.data.result));assert(f.data.result.fragments.every(r=>!('id' in r)&&!('product_id' in r)&&!('value_minor' in r)));
 assert.equal(transferRoundtrip(f=>f.data.result.fragments.reverse()).result.outcome,'success');assert.equal(SCALE_HTTP_FULL_PROFILE_BLOCKERS.length,7);assert.equal(SCALE_HTTP_PORT_COVERAGE.full_profile_binding,false);
});
test('transfer fixture refuses malformed source/destination, zero/negative quantity, duplicate layers and invented execute/fragment fields',()=>{
 for(const mutate of[
  f=>f.c.preview_id='bad',f=>f.c.kind='bin_move',f=>f.c.body.protocol='wms_adjustment090',f=>f.c.body.client_key=id(999),f=>f.c.body.scope_hash='bad',
  f=>f.c.expected.destination_warehouse_id=f.c.expected.warehouse_id,f=>f.c.expected.destination_location=' B ',f=>f.c.expected.quantity=0,f=>f.c.expected.quantity=-3,f=>f.c.expected.quantity=4,
  f=>f.c.expected.policy_version='0',f=>f.c.expected.fragments=[],f=>f.c.expected.fragments.push(structuredClone(f.c.expected.fragments[0])),f=>f.c.expected.fragments[1].location='A-2',
  f=>f.c.expected.fragments[0].fifo_sequence=1,f=>f.c.expected.fragments[0].unit_cost_minor='9223372036854775807',f=>f.c.expected.fragments[0].product_id=f.c.expected.product_id,
 ]){const f=transferCase();mutate(f);assert.throws(()=>validateFullBaseScaleHttpFixture(f.fixture,f.bindings));}
});
test('transfer result refuses historical/reused operations, wrong documents/policy/warehouses, any fragment drift and redacted/inexact valuation',()=>{
 for(const mutate of[
  f=>f.data.reused=true,f=>delete f.data.reused,f=>f.data.operation.id='bad',f=>f.data.operation.kind='bin_move',f=>f.data.operation.policy_version='3',f=>delete f.data.operation.warehouse_document_id,
  f=>f.data.result.source_warehouse_id=id(999),f=>f.data.result.destination_warehouse_id=id(999),f=>f.data.result.destination_location='C-1',
  f=>f.data.result.fragments[0].layer_id=id(999),f=>f.data.result.fragments[0].lot_id=id(999),f=>f.data.result.fragments[0].lot_code='OTHER',f=>f.data.result.fragments[0].location='OTHER',
  f=>f.data.result.fragments[0].quantity=1,f=>f.data.result.fragments[0].unit_cost_minor='18',f=>f.data.result.fragments[0].currency='EUR',f=>f.data.result.fragments[0].fifo_sequence='3',
  f=>f.data.result.fragments[0].id=id(999),f=>f.data.result.fragments[0].product_id=f.c.expected.product_id,f=>f.data.result.fragments[0].value_minor='34',
  f=>f.data.result.fragments.pop(),f=>f.data.result.valuation.known_minor='35',f=>f.data.result.valuation.known_quantity=null,
 ])assert.throws(()=>transferRoundtrip(mutate));
});
for(const reuse of['operation','warehouse-document'])test('transfer '+reuse+' identity cannot be reused by a second original command; registry remains atomic',()=>{
 const f=transferCase();for(const n of[10600,10700]){const c=structuredClone(f.c);c.client_key=id(n);c.body.client_key=c.client_key;c.preview_id=id(n+1);f.t.cases.stock_operation.push(c);}
 const p=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}).A.stock_operation;
 const run=(index,data)=>{const q=task('A','stock_operation',index);p.prepare(q);return p.complete({task:q,http_status:201,data});};assert.equal(run(0,f.data).outcome,'success');
 const invalid=structuredClone(f.data);invalid.operation.id=id(10800);invalid.operation.warehouse_document_id=id(10801);if(reuse==='operation')invalid.operation.id=f.data.operation.id;else invalid.operation.warehouse_document_id=f.data.operation.warehouse_document_id;
 assert.throws(()=>run(1,invalid),/reused-prior-business-effect/);const valid=structuredClone(invalid);if(reuse==='operation')valid.operation.id=id(10900);else valid.operation.warehouse_document_id=id(10901);assert.equal(run(2,valid).outcome,'success');assert.throws(()=>p.prepare(task('A','stock_operation',3)),/QUEUE_EXHAUSTED/);
});
test('transfer missing ACK keeps exact body/key consumed and cannot cause automatic retry',()=>{
 const f=transferCase(),p=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}).A.stock_operation,q=task('A','stock_operation'),request=p.prepare(q);assert.deepEqual(request.body,f.c.body);assert.throws(()=>p.prepare(q),/single-original/);assert.throws(()=>p.complete({task:q,http_status:503,data:{}}),/fresh-http/);assert.throws(()=>p.complete({task:q,http_status:201,data:f.data}),/pending/);assert.throws(()=>p.prepare(task('A','stock_operation',1)),/QUEUE_EXHAUSTED/);
});
test('transfer result fixture follows the actual ordinary native transfer result builder with existing fragment identities only',()=>{
 const source=fs.readFileSync(new URL('../server/wms-lots.ts',import.meta.url),'utf8'),body=source.slice(source.indexOf('export async function transferWmsLotsInTx('),source.indexOf('export async function issueWmsLotsInTx(')),match=body.match(/const result = (\{[\s\S]*?\n  \});/);assert(match,'actual transfer result builder required');
 const f=transferCase(),actual=Function('rows','b','wmsValueSummary','return ('+match[1]+');')(f.c.expected.fragments,{warehouse_id:f.c.expected.warehouse_id,destination_warehouse_id:f.c.expected.destination_warehouse_id,destination_location:f.c.expected.destination_location},()=>structuredClone(f.data.result.valuation));assert.deepEqual(actual,f.data.result);
 const routes=fs.readFileSync(new URL('../server/wms-lots-routes.ts',import.meta.url),'utf8');assert(routes.includes("'/movement-previews/:id/execute'"));assert(routes.includes('reply.code(result.reused ? 200 : 201)'));assert(routes.includes('S.wmsExecuteInput.parse(req.body)'));
});
test('transfer warehouse document cannot reuse a prior negative-adjustment document in the shared tenant effect registry',()=>{
 const f=negativeStockCase(),g=transferCase(),c=g.c;c.client_key=id(11100);c.body.client_key=c.client_key;f.t.cases.stock_operation.push(c);
 const p=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}).A.stock_operation;
 const first=task('A','stock_operation');p.prepare(first);assert.equal(p.complete({task:first,http_status:201,data:f.data}).outcome,'success');
 g.data.operation.warehouse_document_id=f.data.operation.warehouse_document_id;const second=task('A','stock_operation',1);p.prepare(second);assert.throws(()=>p.complete({task:second,http_status:201,data:g.data}),/reused-prior-business-effect/);
});

// Derive the immutable result from the authored139 builder and148 patch,
// then apply the actual public case-field projection (undefined fields omit on HTTP).
const destinationStoredResultPairs=(()=>{
 const base=fs.readFileSync(new URL('../server/139_return_assistant.sql',import.meta.url),'utf8');
 const patch=fs.readFileSync(new URL('../server/148_return_destinations.sql',import.meta.url),'utf8');
 const expression=base.match(/p\.payload,jsonb_build_object\(([^;]+?)\)\);/)[1];
 const suffix=patch.match(/THEN jsonb_build_object\(''id'',rc\.id,''number'',rc\.number,''receipt_sequence'',rc\.receipt_sequence\)/)[0].replaceAll("''", "'");
 const pairs=[...expression.matchAll(/'([^']+)',rc\.([a-z_]+)(::text)?/g),...suffix.matchAll(/'([^']+)',rc\.([a-z_]+)(::text)?/g)].map(m=>({key:m[1],column:m[2],asText:!!m[3]}));
 assert.deepEqual(pairs.map(p=>p.key),['state','version','refund_amount','refunded_shipping','received_at','receipt','decision_note','id','number','receipt_sequence']);assert(pairs.find(p=>p.key==='version').asText);
 return pairs;
})();
const destinationPublicCaseFields=Function('return ('+fs.readFileSync(new URL('../server/return-destinations.ts',import.meta.url),'utf8').match(/const caseFields = (\[[^;]+\]);/)[1]+');')();
function destinationStoredResult(r){return Object.fromEntries(destinationStoredResultPairs.map(p=>[p.key,p.asText?String(r[p.column]):r[p.column]]));}
function destinationPublicResult(stored){return JSON.parse(JSON.stringify(Object.fromEntries(destinationPublicCaseFields.map(k=>[k,stored[k]]))));}
function destinationCase({reject=false,wms=false}={}){
 const f=fixture(),t=f.fixture.tenants[0],old=t.cases.return_receive[0],product=t.cases.order_create[0].body.items[0].product_id,warehouse=t.cases.stock_operation[0].expected.warehouse_id,custody=id(12100),session=id(12101),preview=id(12102),item=old.body.items[0].item_id;
 const effects=reject?['reject']:['sale','custody','reject'];
 const parts=effects.map((effect,i)=>({part_id:id(12200+i),item_id:item,quantity:reject?3:1,status:{status_id:id(12300+i),version:'1',revision_id:id(12400+i),active:true,name:effect,color:'#aabbcc',decision:effect==='reject'?'reject':'accept',inventory_effect:effect==='reject'?'none':effect,warehouse_id:effect==='reject'?null:effect==='sale'?warehouse:custody,warehouse_policy_version:effect==='reject'?null:'1',default_location:effect==='reject'?null:'A1'},refund_minor:effect==='reject'?0:100,components:[{product_id:product,quantity:1}]}));
 const arrivals=parts.filter(p=>p.status.decision==='accept').map(p=>({part_id:p.part_id,item_id:item,product_id:product,warehouse_id:p.status.warehouse_id,location:'A1',quantity:1,effect:p.status.inventory_effect}));
 const summary={accepted:reject?0:2,restocked_to_sale:reject?0:1,received_into_custody:reject?0:1,rejected:reject?3:1,commercial_credit_minor:reject?0:201,shipping_refund_minor:reject?0:1};
 const core={version:2,...(reject?{decision:'reject'}:{shipping_refund:1,items:[{item_id:item,accepted:2,restocked:1}]}),note:'Prepared destination inspection'};
 const request={protocol:'destinations_v1',client_key:id(12500),return_version:'2',session_id:session,session_version:'3',note:core.note,shipping_refund:summary.shipping_refund_minor,parts:parts.map(p=>({part_id:p.part_id,item_id:item,quantity:p.quantity,status_id:p.status.status_id,status_version:p.status.version})),locations:arrivals.map(a=>({part_id:a.part_id,product_id:product,location:a.location,confirmed:true})),stock_versions:arrivals.map(a=>({warehouse_id:a.warehouse_id,product_id:product,version:'0'})),...(wms&&!reject?{wms_lots:{policy_version:'1',picks:arrivals.map(a=>({part_id:a.part_id,issue_fragment_id:id(12600),quantity:1,location:a.location}))}}:{})};
 const publicFragments=wms?arrivals.map(a=>({...a,issue_fragment_id:id(12600),layer_id:id(12601),currency:'PLN'})):[];
 const decisions=[{item_id:item,accepted:summary.accepted,restocked:summary.restocked_to_sale,custody:summary.received_into_custody,rejected:summary.rejected,refund_minor:reject?0:200}];
 const before={id:old.return_id,number:'RMA/1',state:'requested',version:'2',warehouse_id:warehouse,requested_shipping:1,refund_amount:0,refunded_shipping:0,received_at:null,decision_note:'',receipt_sequence:0};
 const source={order_id:old.order_id,return_id:old.return_id,currency:'PLN',requested_shipping_refund:1,stocks:arrivals.map(a=>({warehouse_id:a.warehouse_id,product_id:product,exists:false,version:'0',on_hand:0,reserved:0})),lines:[{item_id:item,ordered_quantity:3,requested:3,prior_accepted:0,line_total_minor:300,components:[{product_id:product,quantity:1}]}],warehouse_policies:[{warehouse_id:warehouse,usage:'sale',enabled:true,version:'1'},{warehouse_id:custody,usage:'custody',enabled:true,version:'1'}],wms:{enabled:wms,policy_version:wms?'1':'0',issue_fragments:wms?[{id:id(12600),product_id:product,layer_id:id(12601),order_id:old.order_id,eligible_item_ids:[item],quantity:3,returned_quantity:0,currency:'PLN',available:3}]:[]}};
 const snapshot={protocol:'destinations_v1',session:{id:session,return_id:old.return_id,order_id:old.order_id,version:'3'},return_case:before,order:{id:old.order_id,currency:'PLN'},source,request,plan:{protocol:'destinations_v1',order_id:old.order_id,return_id:old.return_id,currency:'PLN',parts,decisions,arrivals,fragments:publicFragments,stock_effects:arrivals.map(a=>({warehouse_id:a.warehouse_id,product_id:product,quantity:1,effect:a.effect,before:{exists:false,version:'0',on_hand:0,reserved:0,physical_available:0,sellable_available:0},after:{on_hand:1,reserved:0,physical_available:1,sellable_available:a.effect==='sale'?1:0}})),summary}};
 const p={id:preview,session_id:session,return_id:old.return_id,order_id:old.order_id,scope_hash:hash,kind:'preview',protocol:'destinations_v1',created_at:'2026-10-18T01:00:00Z',expires_at:'2026-10-18T01:15:00Z',action:reject?'reject':'receive',request,core_input:core,summary,snapshot,operation_id:null,can_receive:true};
 const c={kind:'return_destinations',client_key:old.client_key,return_id:old.return_id,order_id:old.order_id,preview_id:preview,body:{client_key:old.client_key,scope_hash:hash,confirmed:true,lease_token:id(12700)},expected:{preview:p,receipt_sequence:reject?0:1}};
 t.cases.return_receive=[c];const r={...structuredClone(before),tenant_id:t.tenant_id,order_id:old.order_id,version:'3',state:reject?'rejected':'refund_pending',decision_note:core.note,receipt_sequence:reject?0:1,refund_amount:summary.commercial_credit_minor,refunded_shipping:summary.shipping_refund_minor,received_at:reject?null:'2026-10-18T01:01:00.123Z',acceptance_kind:reject?null:'physical',receipt:reject?null:structuredClone(core),items:decisions.map(d=>({item_id:d.item_id,accepted:d.accepted,restocked:d.restocked,refund_amount:d.refund_minor}))};
 const storedResult=destinationStoredResult({...r,received_at:reject?null:'2026-10-18T01:01:00.123456+00:00'}),result=destinationPublicResult(storedResult);
 const operation={id:id(12800),preview_id:preview,session_id:session,return_id:old.return_id,order_id:old.order_id,scope_hash:hash,kind:'operation',protocol:'destinations_v1',created_at:'2026-10-18T01:01:00Z',action:p.action,request:{client_key:c.client_key,scope_hash:hash,confirmed:true},snapshot:structuredClone(snapshot),core_input:structuredClone(core),summary:structuredClone(summary),result};return{...f,t,c,storedResult,data:{reused:false,operation,return_case:r}};
}
function destinationRoundtrip(options,mutate){const f=destinationCase(options);mutate?.(f);const p=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}).A.return_receive,q=task('A','return_receive'),request=p.prepare(q);return{f,request,result:p.complete({task:q,http_status:201,data:f.data})};}
for(const wms of[false,true])test('destinations '+(wms?'ON':'OFF')+' accepts genuine prepared mixed sale/custody/reject with atomic148 and sequenced physical RMA readback',()=>{
 const {f,request,result}=destinationRoundtrip({wms});assert.equal(result.outcome,'success');assert.equal(request.path,'/api/return-destinations/previews/'+f.c.preview_id+'/receive');assert.deepEqual(request.body,f.c.body);assert.equal(f.data.return_case.receipt_sequence,1);assert.equal(f.data.return_case.refund_amount,201);assert.equal(f.data.operation.summary.received_into_custody,1);
});
for(const wms of[false,true])test('reject-only destinations '+(wms?'ON':'OFF')+' is only a fresh148 inspection, with zero finance/arrivals and no169/RMAreceipt',()=>{
 const {f,result}=destinationRoundtrip({reject:true,wms});assert.equal(result.outcome,'success');assert.equal(f.data.return_case.receipt_sequence,0);assert.equal(f.data.return_case.receipt,null);assert.equal(f.data.return_case.received_at,null);assert.equal(f.data.operation.summary.accepted,0);assert.equal(f.data.operation.summary.commercial_credit_minor,0);
});
test('destinations refuses historical/missing atomic result, foreign identity, source/core/summary/WMS snapshot drift and incomplete money/quantity result',()=>{
 for(const mutate of[
  f=>f.data.reused=true,f=>delete f.data.reused,f=>f.data.operation.id='bad',f=>f.data.operation.preview_id=id(999),f=>f.data.operation.session_id=id(999),f=>f.data.operation.return_id=id(999),f=>f.data.operation.order_id=id(999),f=>f.data.operation.request.client_key=id(999),
  f=>f.data.operation.core_input.items[0].restocked=0,f=>f.data.operation.snapshot.plan.fragments[0].issue_fragment_id=id(999),f=>f.data.operation.summary.received_into_custody=0,
  f=>f.data.return_case.tenant_id=id(999),f=>f.data.return_case.version='4',f=>f.data.return_case.receipt_sequence=0,f=>f.data.return_case.receipt.note='Wrong original',f=>f.data.return_case.acceptance_kind='partner',f=>f.data.return_case.received_at=null,
  f=>f.data.return_case.items[0].accepted=1,f=>f.data.return_case.items[0].restocked=0,f=>f.data.return_case.items[0].refund_amount=0,f=>f.data.return_case.refund_amount=200,f=>f.data.operation.result.refunded_shipping=0,
 ])assert.throws(()=>destinationRoundtrip({wms:true},mutate));
});
test('destinations compares PG microseconds/zone to the public JS millisecond projection without invented result fields',()=>{
 for(const raw of['2026-10-18T01:01:00.123456+00:00','2026-10-18 03:01:00.123999+02:00','2026-10-18T01:01:00.123Z'])assert.equal(destinationRoundtrip({},f=>{f.data.operation.result.received_at=raw;}).result.outcome,'success');
 for(const mutate of[
  f=>f.data.operation.result.received_at='2026-10-18T01:01:00.124+00:00',f=>f.data.operation.result.received_at=null,f=>f.data.operation.result.received_at='invalid',f=>f.data.operation.result.received_at='2026-10-18T01:01:00.123',
  f=>f.data.operation.result.version=3,f=>delete f.data.operation.result.id,f=>f.data.operation.result.warehouse_id=f.data.return_case.warehouse_id,f=>f.data.operation.result.requested_shipping=1,
  f=>f.data.return_case.warehouse_id=id(999),f=>f.data.return_case.requested_shipping=2,
  f=>{f.data.operation.result.received_at='2026-02-30T01:01:00.123+00:00';f.data.return_case.received_at='2026-03-02T01:01:00.123Z';},
 ])assert.throws(()=>destinationRoundtrip({},mutate));
});
test('destinations prepared binding independently refuses inconsistent decision/credit/recipe/warehouse quantities and exposed lease in public snapshot',()=>{
 for(const mutate of[
  f=>f.c.expected.preview.snapshot.plan.decisions[0].refund_minor=199,f=>f.c.expected.preview.summary.accepted=3,f=>f.c.expected.preview.snapshot.plan.arrivals[0].quantity=2,
  f=>f.c.expected.preview.snapshot.source.lines[0].line_total_minor=303,f=>f.c.expected.preview.snapshot.source.warehouse_policies[1].usage='sale',
  f=>f.c.expected.preview.request.parts[0].quantity=2,f=>f.c.expected.preview.request.lease_token=id(999),f=>f.c.expected.receipt_sequence=0,
  f=>f.c.expected.preview.snapshot.plan.parts[0].refund_minor=99,f=>f.c.expected.preview.snapshot.plan.stock_effects[1].after.sellable_available=1,f=>f.c.expected.preview.snapshot.plan.fragments[0].quantity=2,f=>f.c.expected.preview.snapshot.plan.fragments[0].issue_fragment_id=id(999),
 ]){const f=destinationCase({wms:true});mutate(f);assert.throws(()=>validateFullBaseScaleHttpFixture(f.fixture,f.bindings));}
});
test('reject-only cannot masquerade as physical acceptance, receive a sequence or refund or stock arrival',()=>{
 for(const mutate of[f=>f.data.return_case.receipt={},f=>f.data.return_case.received_at='2026-10-18T01:01:00Z',f=>f.data.return_case.receipt_sequence=1,f=>f.data.return_case.acceptance_kind='physical',f=>f.data.return_case.refund_amount=1,f=>f.data.operation.result.refund_amount=1])assert.throws(()=>destinationRoundtrip({reject:true},mutate));
 const f=destinationCase({reject:true});f.c.expected.preview.snapshot.plan.arrivals.push({quantity:1});assert.throws(()=>validateFullBaseScaleHttpFixture(f.fixture,f.bindings));
});
test('destinations exact original body is single-use after missing ACK, and old148/repeated accepted or rejected result identities never become fresh',()=>{
 for(const reject of[false,true]){
  const f=destinationCase({reject});const second=structuredClone(f.c);second.client_key=id(13100);second.body.client_key=second.client_key;second.preview_id=id(13101);second.expected.preview.id=second.preview_id;f.t.cases.return_receive.push(second);
  const p=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}).A.return_receive,q=task('A','return_receive');p.prepare(q);assert.throws(()=>p.prepare(q),/single-original/);assert.throws(()=>p.complete({task:q,http_status:503,data:{}}),/fresh-http/);assert.throws(()=>p.complete({task:q,http_status:201,data:f.data}),/pending/);
  const q2=task('A','return_receive',1);p.prepare(q2);const r=structuredClone(f.data);r.operation.preview_id=second.preview_id;r.operation.request.client_key=second.client_key;assert.equal(p.complete({task:q2,http_status:201,data:r}).outcome,'success');assert.throws(()=>p.prepare(task('A','return_receive',2)),/QUEUE_EXHAUSTED/);
  for(const reuse of['operation','business']){
   const g=destinationCase({reject}),c=structuredClone(g.c);c.client_key=id(13200);c.body.client_key=c.client_key;c.preview_id=id(13201);c.expected.preview.id=c.preview_id;g.t.cases.return_receive.push(c);
   const port=createPreparedScaleHttpOperationBindings({origin,bindings:g.bindings,context:{fixture:g.fixture}}).A.return_receive;
   const first=task('A','return_receive');port.prepare(first);assert.equal(port.complete({task:first,http_status:201,data:g.data}).outcome,'success');
   const next=task('A','return_receive',1);port.prepare(next);const d=structuredClone(g.data);d.operation.preview_id=c.preview_id;d.operation.request.client_key=c.client_key;if(reuse==='business')d.operation.id=id(13300);assert.throws(()=>port.complete({task:next,http_status:201,data:d}),/reused-prior-business-effect/);
  }
 }
});
test('destinations public operation fixture matches the actual operationView builder without exposing lease or fabricating169receipt for rejection',()=>{
 const text=fs.readFileSync(new URL('../server/return-destinations.ts',import.meta.url),'utf8'),body=text.slice(text.indexOf('async function operationView('),text.indexOf('export async function returnDestinationsOptions(')),match=body.match(/return (\{[\s\S]*?\n    snapshot:[\s\S]*?\});/);assert(match,'actual public operation builder required');
 const caseFields=Function('return ('+text.match(/const caseFields = (\[[^;]+\]);/)[1]+');')(),build=Function('r','p','pick','iso','caseFields','return ('+match[1].replace('r.return_id as string','r.return_id')+');'),pick=(r,keys)=>Object.fromEntries(keys.map(k=>[k,r[k]]));
 for(const reject of[false,true]){const f=destinationCase({reject}),r={...f.data.operation,client_key:f.c.client_key,payload:{action:f.c.expected.preview.action,receive_input:f.c.expected.preview.core_input,plan:{summary:f.c.expected.preview.summary}},result:f.storedResult};assert.deepEqual(JSON.parse(JSON.stringify(build(r,f.c.expected.preview,pick,v=>v,caseFields))),f.data.operation);assert(!Object.hasOwn(f.data.operation.result,'warehouse_id'));assert(!Object.hasOwn(f.data.operation.result,'requested_shipping'));assert.equal(typeof f.data.operation.result.version,'string');assert(!Object.hasOwn(f.data.operation.request,'lease_token'));}
 assert(text.includes('reused: eid !== proposed'));assert(text.includes("p.payload.action === 'reject' ? null : await prepareReturnCompletionInTx"));
});

test('230 invoice variant: the pinned native /issue alias issues a prepared 230 preview into FV-S with fresh exact evidence',()=>{
 // Load and dataset invoices go through the 230 preview: the sealed 157 budget refuses a company's 2001st local invoice for life.
 const{ports,fixture:f}=setup(),t=f.tenants[0];roundtrip(ports,t,'payment_or_document');roundtrip(ports,t,'payment_or_document',1);
 const{request:r,result}=roundtrip(ports,t,'payment_or_document',2);assert.equal(result.outcome,'success');assert.deepEqual(r.body,t.cases.payment_or_document[2].body);
 assert.equal(r.path,`/api/local-invoices/previews/${t.cases.payment_or_document[2].preview_id}/issue`);assert.equal(r.method,'POST');
 for(const patch of[r=>r.data.reused=true,r=>delete r.data.invoice230,r=>r.data.document.mode='local_invoice',r=>r.data.document.number='FV/1/2026',r=>r.data.document.data.preview_id=id(999),
  r=>r.data.document.data.scope_hash='b'.repeat(64),r=>r.data.document.data.totals.gross_minor='124',r=>r.data.document.data.local_only=false,r=>r.data.record.sequence=0,r=>r.data.document.order_id=id(999),r=>r.http_status=200]){
  const s=setup(),u=s.fixture.tenants[0];roundtrip(s.ports,u,'payment_or_document');roundtrip(s.ports,u,'payment_or_document',1);assert.throws(()=>roundtrip(s.ports,u,'payment_or_document',2,patch));
 }
});
function manualOffCase(){
 const f=fixture(),t=f.fixture.tenants[1],pv=id(9101),ck=id(9102),product=id(9103),wh=id(9104),location='A-04';
 t.cases.stock_operation=[{kind:'manual_off',client_key:ck,preview_id:pv,body:{client_key:ck,scope_hash:hash,confirmed:true},expected:{product_id:product,warehouse_id:wh,location,delta:-1}}];
 const data={reused:false,available:true,read_only:false,current_role:'admin',can_read:true,receipt:{id:id(9105),preview_id:pv,client_key:ck,protocol:'manual_off_pw_rw_v1',scope_hash:hash,created_at:'2026-10-29T21:07:38.678150Z',
  request:{client_key:id(9106),revision:hash,product_id:product,warehouse_id:wh,location,delta:-1,note:'Korekta testu obciążenia'},
  document:{id:id(9105),kind:'RW',number:'RW-M/2026/000001',sequence:'1',year:2026,series_id:id(9109),warehouse_id:wh,rows:[{ordinal:0,product_id:product,sku:'SC-B-1',name:'P',location,delta:-1,quantity:1}]},
  journals:{stock_movement_id:id(9107),location_movement_id:id(9108)}}};
 return{...f,t,data};
}
test('stock_operation manual OFF (tenants without WMS lots): the prepared PW/RW preview is applied once and only the exact fresh receipt is a success',()=>{
 const run=(change)=>{const f=manualOffCase();const ports=createPreparedScaleHttpOperationBindings({origin,bindings:f.bindings,context:{fixture:f.fixture}}),q=task('B','stock_operation'),request=ports.B.stock_operation.prepare(q);
  change?.(f.data);return{request,complete:()=>ports.B.stock_operation.complete({task:q,http_status:201,data:f.data})};};
 const ok=run();
 assert.equal(ok.request.method,'POST');assert.equal(ok.request.path,`/api/inventory/manual-corrections/previews/${id(9101)}/apply`);
 assert.deepEqual(ok.request.body,{client_key:id(9102),scope_hash:hash,confirmed:true});
 assert.equal(ok.complete().outcome,'success');
 for(const change of[d=>{d.reused=true;},d=>{d.receipt.document.kind='PW';},d=>{d.receipt.request.delta=1;},d=>{d.receipt.preview_id=id(1);},d=>{d.receipt.protocol='wms_adjustment090';},
  d=>{d.receipt.request.product_id=id(2);},d=>{d.receipt.request.location='B-01';},d=>{d.receipt.document.rows[0].delta=-2;},d=>{d.receipt.client_key=id(3);},d=>{delete d.receipt.journals;}])
  assert.throws(()=>run(change).complete());
 // the case itself: exact fields only, a nonzero delta, a location
 for(const change of[c=>{c.expected.delta=0;},c=>{c.body.extra=1;},c=>{c.expected.location='';},c=>{delete c.preview_id;}]){const f=manualOffCase();change(f.t.cases.stock_operation[0]);assert.throws(()=>validateFullBaseScaleHttpFixture(f.fixture,f.bindings));}
});
