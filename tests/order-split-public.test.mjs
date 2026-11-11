/** Real public projection exports, controlled saved-record inputs only.
 * Shapes follow Native210 a20ffa31 SQL; no PG/Native/API acceptance is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import path from 'node:path';
const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const P=await vite.ssrLoadModule(path.resolve('server/order-split-public.ts'));
const C=await vite.ssrLoadModule(path.resolve('web/order-split-custody.ts'));
await vite.close();
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,copy=v=>structuredClone(v);
const ctx={tenant_id:id(1),actor_id:id(2),api_key_id:null};
function generated(seed,label){const h=createHash('sha256').update('order.split210:'+seed+':'+label).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function fixture(){
 const tenant=id(1),source=id(3),line=id(4),product=id(5),pid=id(10),eid=id(11),slot=id(12),child=generated(pid,'order:'+slot);
 const request={client_key:id(20),source_order_id:source,expected_source_version:'17',children:[{slot_id:slot,name:'Osobna paczka',delivery_minor:3,items:[{source_item_id:line,quantity:1}]}]};
 const order={id:source,tenant_id:tenant,version:17,currency:'PLN',shipping_cost:7,total:3408,customer_name:'PRIVATE_CUSTOMER',email:'PRIVATE_EMAIL',address:{street:'PRIVATE_ADDRESS'},portal_token:'PRIVATE_TOKEN',pricing_snapshot:{private:'PRIVATE_PRICE_CONTEXT'}};
 const original={id:line,tenant_id:tenant,order_id:source,product_id:product,name:'Zamrożony produkt',sku:'HIST-1',quantity:2,price:1701,vat:23,line_total:3401,product_kind:'simple',components:[{product_id:product,quantity:1}],scanned:0};
 const snapshot={order,items:[original],custody:{layers:[{private_cost:'PRIVATE_STOCK_COST'}]},wms_enabled:false,layer_metadata:[]};
 const allocation=(retained)=>({source_item_id:line,target_item_id:retained?line:generated(pid,'item:'+slot+':'+line),product_id:product,quantity:1,price:1701,vat:23,from_quantity:retained?1:0,to_quantity:retained?2:1,gross_minor:retained?1701:1700,net_minor:retained?1383:1382,vat_minor:318,price_adjustment_minor:retained?0:-1,original_quantity:2,original_price:1701,original_gross_minor:3401,original_net_minor:2765,original_vat_minor:636});
 const results=[false,true].map((retained,index)=>({kind:retained?'retained_source':'child',slot_id:retained?null:slot,order_id:retained?source:child,name:retained?null:request.children[0].name,delivery_minor:retained?4:3,items:[allocation(retained)],result_index:index,items_gross_minor:retained?1701:1700,items_net_minor:retained?1383:1382,items_vat_minor:318,total_minor:retained?1705:1703}));
 const preview={tenant_id:tenant,id:pid,actor_id:id(2),api_key_id:null,credential_hash:'PRIVATE_CREDENTIAL_HASH',identity_snapshot:{session:'PRIVATE_IDENTITY'},client_key:request.client_key,request,source_order_id:source,source_version:'17',scope_hash:'a'.repeat(64),snapshot,plan:{schema:'order-split210-commercial-plan/v1',ready:true,conflicts:[],results,shipping_tax:'not_allocated',custody:{cost:'PRIVATE_PLAN_COST'}}};
 const source_rows=[{tenant_id:tenant,preview_id:pid,source_item_id:line,source_order_id:source,row_data:copy(original)}];
 const after={orders:results.map(r=>({...copy(order),id:r.order_id,version:r.slot_id===null?18:1,total:r.total_minor,shipping_cost:r.delivery_minor,portal_token:r.slot_id===null?order.portal_token:'PRIVATE_CHILD_TOKEN'})),items:results.map(r=>{const {product_kind,...item}=copy(original);return {...item,id:r.items[0].target_item_id,order_id:r.order_id,quantity:1,line_total:r.items[0].gross_minor};}),custody:{cost:'PRIVATE_AFTER_COST'}};
 const execution={tenant_id:tenant,id:eid,preview_id:pid,actor_id:id(2),api_key_id:null,credential_hash:'PRIVATE_EXEC_CREDENTIAL',identity_snapshot:{private:'PRIVATE_EXEC_IDENTITY'},client_key:id(21),request:{client_key:id(21),preview_id:pid,scope_hash:preview.scope_hash,confirmed:true},source_order_id:source,source_version:'17',result_source_version:'18',scope_hash:preview.scope_hash,before_frame:copy(snapshot),after_frame:after};
 const targets=results.map(r=>({tenant_id:tenant,execution_id:eid,preview_id:pid,result_index:r.result_index,slot_id:r.slot_id,order_id:r.order_id,source_order_id:source,name:r.name,delivery_minor:r.delivery_minor,total_minor:r.total_minor}));
 const allocations=results.flatMap(r=>r.items.map(a=>({tenant_id:tenant,execution_id:eid,preview_id:pid,result_index:r.result_index,source_item_id:a.source_item_id,target_item_id:a.target_item_id,product_id:a.product_id,quantity:a.quantity,from_quantity:a.from_quantity,to_quantity:a.to_quantity,gross_minor:a.gross_minor,net_minor:a.net_minor,vat_minor:a.vat_minor,payload:copy(a)})));
 return{preview,source_rows,execution,targets,allocations};
}
const publicPreview=f=>P.projectOrderSplitPreview(ctx,{preview:f.preview,source_rows:f.source_rows});
const publicExecute=f=>P.projectOrderSplitExecution(ctx,f);
function syncExecution(f){
 const p=f.preview,e=f.execution;e.before_frame=copy(p.snapshot);
 f.targets=p.plan.results.map(r=>({tenant_id:p.tenant_id,execution_id:e.id,preview_id:p.id,result_index:r.result_index,slot_id:r.slot_id,order_id:r.order_id,source_order_id:p.source_order_id,name:r.name,delivery_minor:r.delivery_minor,total_minor:r.total_minor}));
 f.allocations=p.plan.results.flatMap(r=>r.items.map(a=>({tenant_id:p.tenant_id,execution_id:e.id,preview_id:p.id,result_index:r.result_index,source_item_id:a.source_item_id,target_item_id:a.target_item_id,product_id:a.product_id,quantity:a.quantity,from_quantity:a.from_quantity,to_quantity:a.to_quantity,gross_minor:a.gross_minor,net_minor:a.net_minor,vat_minor:a.vat_minor,payload:copy(a)})));
 e.after_frame={orders:p.plan.results.map(r=>({...copy(p.snapshot.order),id:r.order_id,version:r.slot_id===null?18:1,total:r.total_minor,shipping_cost:r.delivery_minor})),items:p.plan.results.flatMap(r=>r.items.map(a=>{const {product_kind,...original}=p.snapshot.items.find(i=>i.id===a.source_item_id);return {...copy(original),id:a.target_item_id,order_id:r.order_id,quantity:a.quantity,line_total:a.gross_minor};})),custody:{private_cost:'PRIVATE_AFTER_COST'}};
}
function custody(intentKind,f,out){
 const p=f.preview,intent={schema:'order-split-custody/v1',actor:ctx.tenant_id+':'+ctx.actor_id,kind:intentKind,serialized:JSON.stringify(intentKind==='preview'?p.request:f.execution.request),source:{id:p.source_order_id,version:p.source_version,shipping_cost:p.snapshot.order.shipping_cost,items:p.snapshot.items.map(i=>({id:i.id,quantity:i.quantity}))},...(intentKind==='execute'?{preview:{id:p.id,scope_hash:p.scope_hash,serialized:JSON.stringify(p.request),children:out.head.children}}:{})};
 const page=(data)=>[{requested_cursor:null,data,meta:{total:data.length,cursor:null}}];
 return C.verifySplitCommand(out.command,intent,{source:out.source,source_pages:page(out.source_items),children_pages:page(out.children)});
}
test('historical3401 line remains exact, public DTOs satisfy actual browser custody without current-order reads',()=>{
 const f=fixture(),before=copy(f),p=publicPreview(f),e=publicExecute(f);
 assert.deepEqual(custody('preview',f,p),p.head);assert.deepEqual(custody('execute',f,e),e.head);
 assert.deepEqual(p.commercial.results.map(r=>r.items.map(i=>[i.quantity,i.price,i.gross_minor,i.net_minor,i.vat_minor,i.price_adjustment_minor])),[[[1,1701,1700,1382,318,-1]],[[1,1701,1701,1383,318,0]]]);
 assert.deepEqual(p.commercial.original,{items_gross_minor:3401,items_net_minor:2765,items_vat_minor:636,delivery_minor:7,total_minor:3408});
 assert.deepEqual(p.source,{order_id:id(3),version:'17',item_count:1,shipping_cost:4});assert.equal(e.source.version,'18');assert.equal(p.head.ready,true);assert.equal(e.head.state,'done');
 assert.equal(p.commercial.shipping_tax,'not_allocated');assert.deepEqual(f,before);assert.equal(Object.isFrozen(e.commercial.results[0].items[0]),true);assert.throws(()=>e.children[0].items.pop());
});
test('public output has exact safe levels and never copies raw header, plan, credentials, custody or private context',()=>{
 for(const out of [publicPreview(fixture()),publicExecute(fixture())]){
  assert.deepEqual(Object.keys(out).sort(),['command','head','source','source_items','children','commercial'].sort());
  const encoded=JSON.stringify(out);assert.equal(encoded.includes('PRIVATE_'),false);
  for(const forbidden of ['credential_hash','identity_snapshot','portal_token','customer_name','email','address','before_frame','after_frame','snapshot','custody','pricing_snapshot'])assert.equal(encoded.includes('"'+forbidden+'"'),false,forbidden);
  assert.equal(encoded.includes('Zamrożony produkt'),true);assert.equal(encoded.includes('Osobna paczka'),true);
 }
});
test('foreign browser context/actor/key or original request binding refuses without leaking inputs in errors',()=>{
 for(const mutate of [f=>f.preview.tenant_id=id(99),f=>f.preview.actor_id=id(99),f=>f.preview.api_key_id=id(99),f=>f.preview.client_key=id(99),f=>f.preview.request.client_key=id(99),f=>f.preview.request.source_order_id=id(99),f=>f.preview.request.expected_source_version='18',f=>f.preview.request.private='PRIVATE_UNKNOWN',f=>f.preview.scope_hash='bad']){
  const f=fixture();mutate(f);assert.throws(()=>publicPreview(f),e=>e instanceof P.OrderSplitPublicError&&!e.message.includes('PRIVATE_'));
 }
 assert.throws(()=>P.projectOrderSplitPreview({...ctx,api_key_id:id(99)},fixture()));
});
test('source archive must be complete exact original rows with own IDs; removed current source row is still auditable',()=>{
 for(const mutate of [f=>f.source_rows.pop(),f=>f.source_rows.push(copy(f.source_rows[0])),f=>f.source_rows[0].preview_id=id(99),f=>f.source_rows[0].tenant_id=id(99),f=>f.source_rows[0].source_order_id=id(99),f=>f.source_rows[0].source_item_id=id(99),f=>f.source_rows[0].row_data.quantity=3,f=>f.preview.snapshot.items.push(copy(f.preview.snapshot.items[0])),f=>f.preview.snapshot.items[0].tenant_id=id(99),f=>f.preview.snapshot.order.tenant_id=id(99)]){
  const f=fixture();mutate(f);assert.throws(()=>publicPreview(f));
 }
 // Fully moved original line remains in saved source_rows, not a fake zero-qty
 // current item. Add a separate retained line and move the first line in full.
 const f=fixture(),first=f.preview.snapshot.items[0],other={...copy(first),id:id(6),product_id:id(7),quantity:1,price:123,line_total:123};
 f.preview.snapshot.items.push(other);f.source_rows.push({...copy(f.source_rows[0]),source_item_id:other.id,row_data:copy(other)});f.preview.snapshot.order.total+=123;
 f.preview.request.children[0].items[0].quantity=2;const [child,retained]=f.preview.plan.results;
 child.items[0]={...child.items[0],quantity:2,to_quantity:2,gross_minor:3401,net_minor:2765,vat_minor:636,price_adjustment_minor:-1};child.items_gross_minor=3401;child.items_net_minor=2765;child.items_vat_minor=636;child.total_minor=3404;
 retained.items=[{...copy(child.items[0]),source_item_id:other.id,target_item_id:other.id,product_id:other.product_id,quantity:1,price:123,from_quantity:0,to_quantity:1,gross_minor:123,net_minor:100,vat_minor:23,price_adjustment_minor:0,original_quantity:1,original_price:123,original_gross_minor:123,original_net_minor:100,original_vat_minor:23}];retained.items_gross_minor=123;retained.items_net_minor=100;retained.items_vat_minor=23;retained.total_minor=127;
 const out=publicPreview(f);assert.deepEqual(out.source_items,[{source_item_id:id(4),before_quantity:2,remaining_quantity:0},{source_item_id:id(6),before_quantity:1,remaining_quantity:1}]);assert.equal(out.source.item_count,2);
 syncExecution(f);const executed=publicExecute(f);assert.deepEqual(custody('execute',f,executed),executed.head);assert.equal(f.execution.after_frame.items.some(i=>i.order_id===id(3)&&i.id===id(4)),false);assert.equal(executed.source_items[0].remaining_quantity,0);
});
test('multiple UUID-slotted children preserve all three exact123/100/23 results and source shipping quantity',()=>{
 const f=fixture(),p=f.preview,i=p.snapshot.items[0];i.quantity=3;i.price=123;i.line_total=369;p.snapshot.order.total=370;p.snapshot.order.shipping_cost=1;f.source_rows[0].row_data=copy(i);
 p.request.children[0].delivery_minor=1;p.request.children.push({slot_id:id(13),name:'Kolejna paczka',delivery_minor:0,items:[{source_item_id:i.id,quantity:1}]});
 const template=p.plan.results[0].items[0];p.plan.results=[0,1,2].map(index=>{const retained=index===2,slot=retained?null:p.request.children[index].slot_id;return {kind:retained?'retained_source':'child',slot_id:slot,order_id:retained?p.source_order_id:generated(p.id,'order:'+slot),name:retained?null:p.request.children[index].name,delivery_minor:index===0?1:0,result_index:index,items:[{...copy(template),target_item_id:retained?i.id:generated(p.id,'item:'+slot+':'+i.id),quantity:1,price:123,from_quantity:index,to_quantity:index+1,gross_minor:123,net_minor:100,vat_minor:23,price_adjustment_minor:0,original_quantity:3,original_price:123,original_gross_minor:369,original_net_minor:300,original_vat_minor:69}],items_gross_minor:123,items_net_minor:100,items_vat_minor:23,total_minor:index===0?124:123};});
 syncExecution(f);const out=publicExecute(f);assert.equal(out.children.length,2);assert.deepEqual(out.commercial.results.map(r=>[r.items_gross_minor,r.items_net_minor,r.items_vat_minor,r.delivery_minor]),[[123,100,23,1],[123,100,23,0],[123,100,23,0]]);assert.deepEqual(custody('execute',f,out),out.head);
 const bad=copy(f);[bad.targets[0].slot_id,bad.targets[1].slot_id]=[bad.targets[1].slot_id,bad.targets[0].slot_id];assert.throws(()=>publicExecute(bad));
});
test('zero historical gross is valid without dividing by zero or inventing tax and still conserves shipping',()=>{
 const f=fixture(),i=f.preview.snapshot.items[0];i.price=0;i.line_total=0;f.preview.snapshot.order.total=7;f.source_rows[0].row_data=copy(i);
 for(const r of f.preview.plan.results){Object.assign(r.items[0],{price:0,gross_minor:0,net_minor:0,vat_minor:0,price_adjustment_minor:0,original_price:0,original_gross_minor:0,original_net_minor:0,original_vat_minor:0});Object.assign(r,{items_gross_minor:0,items_net_minor:0,items_vat_minor:0,total_minor:r.delivery_minor});}
 syncExecution(f);const out=publicExecute(f);assert.equal(out.commercial.original.total_minor,7);assert.equal(out.commercial.original.items_vat_minor,0);assert.deepEqual(out.commercial.results.map(r=>r.total_minor),[3,4]);assert.equal(out.head.state,'done');
});
test('slot/order/item IDs, canonical allocation intervals and each saved amount/provenance are bound independently',()=>{
 const mutations=[f=>f.preview.plan.results.pop(),f=>f.preview.plan.results[0].slot_id=id(99),f=>f.preview.plan.results[0].order_id=id(99),f=>f.preview.plan.results[0].name='wrong',f=>f.preview.plan.results[0].items[0].target_item_id=id(99),f=>f.preview.plan.results[0].items[0].product_id=id(99),f=>f.preview.plan.results[0].items[0].quantity=2,f=>f.preview.plan.results[0].items[0].price=1700,f=>f.preview.plan.results[0].items[0].vat=8,f=>f.preview.plan.results[1].items[0].from_quantity=0,f=>f.preview.plan.results[0].items[0].gross_minor++,f=>f.preview.plan.results[0].items[0].net_minor++,f=>f.preview.plan.results[0].items[0].original_net_minor++,f=>f.preview.plan.results[0].items[0].price_adjustment_minor=0,f=>f.preview.plan.results[0].items[0].private='PRIVATE_UNKNOWN',f=>f.preview.plan.results[0].items_net_minor++,f=>f.preview.plan.results[0].total_minor++,f=>f.preview.snapshot.order.total++,f=>f.preview.plan.results[1].delivery_minor++];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>publicPreview(f));}
});
test('moving a cent between results while keeping global gross and VAT sums cannot bypass original interval allocation',()=>{
 const f=fixture(),[a,b]=f.preview.plan.results;
 a.items[0].gross_minor++;a.items[0].net_minor++;a.items[0].price_adjustment_minor++;a.items_gross_minor++;a.items_net_minor++;a.total_minor++;
 b.items[0].gross_minor--;b.items[0].net_minor--;b.items[0].price_adjustment_minor--;b.items_gross_minor--;b.items_net_minor--;b.total_minor--;
 assert.throws(()=>publicPreview(f));
});
test('actual Native conflict details keep preview not-ready; a claimed ready execution is refused',()=>{
 const f=fixture(),o=f.preview.snapshot.order,i=f.preview.snapshot.items[0];i.quantity=3;i.price=1;i.line_total=3;o.total=10;f.source_rows[0].row_data=copy(i);
 const [a,b]=f.preview.plan.results;a.items[0]={...a.items[0],price:1,quantity:1,from_quantity:0,to_quantity:1,gross_minor:1,net_minor:0,vat_minor:1,price_adjustment_minor:0,original_quantity:3,original_price:1,original_gross_minor:3,original_net_minor:2,original_vat_minor:1};
 b.items[0]={...a.items[0],target_item_id:i.id,quantity:2,from_quantity:1,to_quantity:3,gross_minor:2,net_minor:2,vat_minor:0};
 for(const r of [a,b]){r.items_gross_minor=r.items[0].gross_minor;r.items_net_minor=r.items[0].net_minor;r.items_vat_minor=r.items[0].vat_minor;r.total_minor=r.items_gross_minor+r.delivery_minor;}
 f.preview.plan.conflicts=[{code:'VAT_ROUNDING_CONFLICT',source_item_id:i.id,slot_id:a.slot_id}];f.preview.plan.ready=false;
 const out=publicPreview(f);assert.equal(out.head.ready,false);assert.deepEqual(out.commercial.conflicts,f.preview.plan.conflicts);assert.throws(()=>publicExecute(f));
 f.preview.plan.ready=true;assert.throws(()=>publicPreview(f));f.preview.plan.ready=false;f.preview.plan.conflicts=[];assert.throws(()=>publicPreview(f));
});
test('execution requires exact original preview/body/actor, complete targets and allocations, immutable before/after budgets',()=>{
 const mutations=[f=>f.execution.tenant_id=id(99),f=>f.execution.actor_id=id(99),f=>f.execution.api_key_id=id(99),f=>f.execution.preview_id=id(99),f=>f.execution.request.scope_hash='b'.repeat(64),f=>f.execution.request.client_key=id(99),f=>f.execution.result_source_version='19',f=>f.execution.before_frame.order.total++,f=>f.targets.pop(),f=>f.targets.push(copy(f.targets[0])),f=>f.targets[0].execution_id=id(99),f=>f.targets[0].preview_id=id(99),f=>f.targets[0].order_id=id(99),f=>f.targets[0].total_minor++,f=>f.allocations.pop(),f=>f.allocations.push(copy(f.allocations[0])),f=>f.allocations[0].tenant_id=id(99),f=>f.allocations[0].source_item_id=id(99),f=>f.allocations[0].net_minor++,f=>f.allocations[0].payload.gross_minor++,f=>f.execution.after_frame.orders.pop(),f=>f.execution.after_frame.orders[0].total++,f=>f.execution.after_frame.orders[0].version=2,f=>f.execution.after_frame.items[0].line_total++,f=>f.execution.after_frame.items[0].order_id=id(99),f=>f.execution.after_frame.items.push(copy(f.execution.after_frame.items[0]))];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>publicExecute(f));}
 const shuffled=fixture();shuffled.targets.reverse();shuffled.allocations.reverse();shuffled.execution.after_frame.orders.reverse();shuffled.execution.after_frame.items.reverse();assert.equal(publicExecute(shuffled).head.state,'done');
});
test('actual JSON-number snapshot versions are distinct from pg bigint columns; unsafe/rounded values refuse',()=>{
 for(const value of ['17',17.1,Number.MAX_SAFE_INTEGER+1,null]){const f=fixture();f.preview.snapshot.order.version=value;assert.throws(()=>publicPreview(f));}
 const f=fixture();f.preview.source_version='9007199254740993';f.preview.request.expected_source_version=f.preview.source_version;f.preview.snapshot.order.version=9007199254740993;assert.throws(()=>publicPreview(f));
});
test('row/byte budgets and malformed shapes refuse safely without copying opaque input into an error',()=>{
 for(const mutate of [f=>f.preview.snapshot.items=[],f=>f.preview.plan.results[0].items=[],f=>f.preview.plan.conflicts=[{code:'PRIVATE_CONFLICT'}],f=>f.preview.snapshot.order.customer_name='PRIVATE_'.repeat(1200000),f=>f.preview.plan.results[0].items[0].quantity=0,f=>f.preview.snapshot.items[0].quantity=100001]){const f=fixture();mutate(f);assert.throws(()=>publicPreview(f),e=>e instanceof P.OrderSplitPublicError&&!e.message.includes('PRIVATE_'));}
 for(const value of [null,{},[],{preview:null,source_rows:[]}])assert.throws(()=>P.projectOrderSplitPreview(ctx,value));
});
