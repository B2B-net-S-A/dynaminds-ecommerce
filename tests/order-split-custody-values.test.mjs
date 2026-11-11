/** Actual pure exports; unit-by-unit physical oracle, never DB/Native proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderSplitCustody as plan, OrderSplitCustodyError, ORDER_SPLIT_CUSTODY_LIMITS as C } from '../server/order-split-custody-values.ts';
const id = n => `${n.toString(16).padStart(8,'0')}-a000-4000-8000-000000000001`;
const tenant=id(1), order=id(2), warehouse=id(3), product=id(4), item=id(5), slotA=id(11), slotB=id(12);
const clone = v => structuredClone(v);
function fixture(wms=false, q=6) {
  const source={schema:'order-split-source/v1',order:{id:order,tenant_id:tenant,version:'7',source:'manual',fulfillment_kind:'sale',status:'new',warehouse_id:warehouse,currency:'PLN',payment_mode:'prepaid',shipping_cost:0,total:q*100,channel_id:null,external_id:null,b2b_account_id:null,unsupported_business_fields:false},
    items:[{id:item,order_id:order,product_id:product,product_kind:'simple',quantity:q,price:100,vat:0,line_total:q*100,components:[{product_id:product,quantity:1}],scanned:0,consumed_quantity:0,released_quantity:0}],
    financial:{payment_entries:0,source_payment_checks:0,import_allocations:0,payment_import_receipts:0,source_payment_jobs:0,payment_import_attempts:0,balance:{currency:'PLN',payment_mode:'prepaid',received:0,refunded:0,credit:0,return_credit:0,cancelled_credit:0,net:0,overpayment:0,collected:0,remitted:0,fees:0,courier_due:0,nominal:q*100,amount_due:q*100}},
    blockers:Object.fromEntries(['documents','invoice_plans','corrections','returns','exchanges','shipments','provider_attempts','parcel_plans','active_picking_waves','active_packing_sessions','merge_lineage','split_lineage','external_intents','non_active_reservations','physical_scans','consumed_quantity','released_quantity'].map(k=>[k,0]))};
  const request={client_key:id(10),source_order_id:order,expected_source_version:'7',children:[{slot_id:slotB,name:'B',delivery_minor:0,items:[{source_item_id:item,quantity:1}]},{slot_id:slotA,name:'A',delivery_minor:0,items:[{source_item_id:item,quantity:2}]}]};
  const physical={tenant_id:tenant,order_id:order,product_id:product,warehouse_id:warehouse,quantity:q,consumed_quantity:0,released_quantity:0};
  const custody={schema:'order-split-physical-source/v1',tenant_id:tenant,source_order_id:order,warehouse_id:warehouse,wms_enabled:wms,
    reservations:[{...physical,state:'active'}],picks:[{id:id(6),tenant_id:tenant,order_id:order,product_id:product,sku:'SKU',name:'Źródłowa nazwa',ean:'123',quantity:q,scanned:0}],
    locations:[{...physical,location:'A',quantity:q-3,scanned:0},{...physical,location:'B',quantity:3,scanned:0}],layers:[],layer_metadata:[]};
  if(wms){
    custody.layers=[{...physical,location:'A',layer_id:id(102),quantity:q-3,scanned:0,state:'active'},{...physical,location:'B',layer_id:id(103),quantity:1,scanned:0,state:'active'},{...physical,location:'B',layer_id:id(101),quantity:2,scanned:0,state:'active'}];
    custody.layer_metadata=[{layer_id:id(103),product_id:product,lot_id:id(203),fifo_sequence:'3',expiry_date:null},{layer_id:id(102),product_id:product,lot_id:id(202),fifo_sequence:'2',expiry_date:'2026-01-01'},{layer_id:id(101),product_id:product,lot_id:id(201),fifo_sequence:'1',expiry_date:'2027-12-31'}];
  }
  return {source,request,custody};
}
const run=f=>plan(f.source,f.request,f.custody);
const quantities = rows => rows.map(r=>r.quantity);
function refused(f,code){assert.throws(()=>run(f),e=>e instanceof OrderSplitCustodyError&&e.code===code);}
function byCell(rows,layer=false){const m=new Map();for(const r of rows){const k=JSON.stringify([r.product_id,r.warehouse_id,r.location,...(layer?[r.layer_id]:[])]);m.set(k,(m.get(k)??0)+r.quantity);}return [...m].sort(([a],[b])=>a.localeCompare(b));}

test('WMS OFF partitions existing bins with canonical slots and retained source; never allocates new stock or IDs',()=>{
  const f=fixture(),before=clone(f),v=run(f);
  assert.deepEqual(f,before);assert.deepEqual(v.targets.map(t=>t.slot_id),[slotA,slotB,null]);
  assert.deepEqual(v.targets.map(t=>t.locations.map(r=>[r.location,r.quantity])),[[['A',2]],[['A',1]],[['B',3]]]);
  assert.deepEqual(v.targets.map(t=>quantities(t.reservations)),[[2],[1],[3]]);
  assert.deepEqual(byCell(v.targets.flatMap(t=>t.locations)),byCell(f.custody.locations));
  assert.equal(v.integration_ready,false);assert.equal(v.native_admission,false);assert.equal(v.stock_mutation_planned,false);
  for(const t of v.targets){assert.equal(t.layers.length,0);for(const p of t.picks){assert.equal(p.source_pick_id,id(6));assert(!('id'in p));assert(!('order_id'in p));}}
  assert(Object.isFrozen(v.targets[0].locations[0]));assert.throws(()=>{v.targets[0].locations[0].quantity=100;});
});

test('WMS ON uses actual FIFO sequence before layer/location; preserves each reserved layer, lot and expiry',()=>{
  const f=fixture(true),v=run(f);
  assert.deepEqual(v.targets.map(t=>t.layers.map(r=>[r.layer_id,r.location,r.quantity])),[[[id(101),'B',2]],[[id(102),'A',1]],[[id(102),'A',2],[id(103),'B',1]]]);
  assert.deepEqual(byCell(v.targets.flatMap(t=>t.layers),true),byCell(f.custody.layers,true));
  assert.deepEqual(byCell(v.targets.flatMap(t=>t.locations)),byCell(f.custody.locations));
  for(const row of v.targets.flatMap(t=>t.layers)){const m=f.custody.layer_metadata.find(m=>m.layer_id===row.layer_id);assert.equal(row.lot_id,m.lot_id);assert.equal(row.expiry_date,m.expiry_date);assert.equal(row.fifo_sequence,m.fifo_sequence);}
  // Earlier expiry is not FEFO and does not override immutable FIFO sequence.
  assert.equal(v.targets[0].layers[0].expiry_date,'2027-12-31');
});

test('unordered physical rows produce the same immutable plan and hashes; tied FIFO uses layer UUID then location C',()=>{
  const f=fixture(true);f.custody.layer_metadata[0].fifo_sequence='2';
  const a=run(f),other=clone(f);for(const field of ['reservations','picks','locations','layers','layer_metadata'])other.custody[field].reverse();
  assert.deepEqual(run(other),a);
  assert.deepEqual(a.targets[2].layers.map(r=>r.layer_id),[id(102),id(103)]);
  const g=fixture();g.custody.locations=[{...g.custody.locations[0],location:'Ż',quantity:3},{...g.custody.locations[1],location:'z',quantity:3}];
  assert.equal(run(g).targets[0].locations[0].location,'z');
});

test('different commercial lines of the same product share ONE physical pool without losing source item provenance',()=>{
  const f=fixture(true);f.source.items[0].quantity=2;f.source.items[0].line_total=200;
  f.source.items.push({...clone(f.source.items[0]),id:id(51),quantity:4,price:101,line_total:404});
  f.source.order.total=604;f.source.financial.balance.nominal=f.source.financial.balance.amount_due=604;
  f.request.children=[{slot_id:slotA,name:'A',delivery_minor:0,items:[{source_item_id:item,quantity:1},{source_item_id:id(51),quantity:1}]},{slot_id:slotB,name:'B',delivery_minor:0,items:[{source_item_id:id(51),quantity:1}]}];
  const v=run(f);assert.deepEqual(v.source_quantities,[{product_id:product,quantity:6}]);
  assert.deepEqual(v.targets.map(t=>quantities(t.reservations)),[[2],[1],[3]]);
  assert.deepEqual(v.targets[0].commercial_items.map(i=>i.source_item_id),[item,id(51)]);
  assert.deepEqual(byCell(v.targets.flatMap(t=>t.layers),true),byCell(f.custody.layers,true));
});

test('one layer reserved in two locations partitions by location C without inventing a second lot',()=>{
  const f=fixture(true);f.custody.layers=f.custody.locations.map(r=>({...r,layer_id:id(101),state:'active'}));
  f.custody.layer_metadata=[f.custody.layer_metadata.find(m=>m.layer_id===id(101))];
  const v=run(f);assert.deepEqual(v.targets.map(t=>t.layers.map(r=>[r.layer_id,r.location,r.quantity])),[[[id(101),'A',2]],[[id(101),'A',1]],[[id(101),'B',3]]]);
  assert.deepEqual(byCell(v.targets.flatMap(t=>t.layers),true),byCell(f.custody.layers,true));
});

test('multiple products retain separate reservation pools and a result may omit one product entirely',()=>{
  const f=fixture(),other=id(41),otherItem=id(51);
  f.source.items.push({...clone(f.source.items[0]),id:otherItem,product_id:other,components:[{product_id:other,quantity:1}]});
  f.source.order.total=1200;f.source.financial.balance.nominal=f.source.financial.balance.amount_due=1200;
  for(const kind of ['reservations','picks','locations'])f.custody[kind].push(...clone(f.custody[kind]).map(r=>({...r,product_id:other,...(kind==='picks'?{id:id(46)}:{})})));
  f.request.children[1].items.push({source_item_id:otherItem,quantity:1});
  const v=run(f);assert.deepEqual(v.targets.map(t=>t.reservations.map(r=>[r.product_id,r.quantity])),[[[product,2],[other,1]],[[product,1]],[[product,3],[other,5]]]);
  assert.deepEqual(byCell(v.targets.flatMap(t=>t.locations)),byCell(f.custody.locations));
});

test('independent indivisible-unit oracle checks 90 FIFO partitions and the retained remainder',()=>{
  let cases=0;
  for(let q=4;q<=15;q++)for(let first=1;first<=q-2;first++){
    const f=fixture(true,q);f.request.children[1].items[0].quantity=first;
    const v=run(f),second=1;
    const units=[...Array(2).fill(id(101)+'@B'),...Array(q-3).fill(id(102)+'@A'),id(103)+'@B'];
    const cuts=[units.slice(0,first),units.slice(first,first+second),units.slice(first+second)];
    assert.deepEqual(v.targets.map(t=>t.layers.flatMap(r=>Array(r.quantity).fill(r.layer_id+'@'+r.location))),cuts);
    assert.deepEqual(v.targets.map(t=>t.reservations.reduce((n,r)=>n+r.quantity,0)),[first,second,q-first-second]);cases++;
  }
  assert.equal(cases,90);
});

test('zero quantity, scan, consumed/released or nonactive counters cannot enter a transfer plan',()=>{
  for(const list of ['reservations','picks','locations','layers'])for(const field of ['quantity','scanned','consumed_quantity','released_quantity','state']){
    const f=fixture(true);if(!(field in f.custody[list][0]))continue;
    f.custody[list][0][field]=field==='quantity'?0:field==='state'?'transferred':1;refused(f,'INVALID_PHYSICAL_SOURCE');
  }
});

test('foreign/missing/duplicate rows and broken product, location or layer sums are refused',()=>{
  for(const list of ['reservations','picks','locations','layers'])for(const field of ['tenant_id','order_id','product_id','warehouse_id']){
    const f=fixture(true);if(!(field in f.custody[list][0]))continue;f.custody[list][0][field]=id(999);refused(f,'FOREIGN_PHYSICAL_ROW');
  }
  for(const [mutate,code] of [
    [f=>f.custody.reservations.pop(),'INCOMPLETE_PRODUCT_CUSTODY'],
    [f=>f.custody.picks.push(clone(f.custody.picks[0])),'DUPLICATE_PICK'],
    [f=>f.custody.locations.push(clone(f.custody.locations[0])),'DUPLICATE_LOCATION'],
    [f=>f.custody.layers.push(clone(f.custody.layers[0])),'DUPLICATE_LAYER_CELL'],
    [f=>f.custody.layer_metadata.pop(),'MISSING_OR_FOREIGN_LAYER_METADATA'],
    [f=>f.custody.layer_metadata.push({...clone(f.custody.layer_metadata[0]),layer_id:id(900)}),'UNUSED_LAYER_METADATA'],
    [f=>f.custody.reservations[0].quantity--,'PRODUCT_QUANTITY_MISMATCH'],
    [f=>f.custody.locations[0].quantity--,'LOCATION_QUANTITY_MISMATCH'],
    [f=>f.custody.layers[0].quantity--,'LAYER_QUANTITY_MISMATCH'],
    [f=>{f.custody.layers[0].location='B';},'LAYER_LOCATION_MISMATCH'],
  ]){const f=fixture(true);mutate(f);refused(f,code);}
});

test('WMS mode, metadata identity, bigint sequence, date and bounds are explicit, never inferred',()=>{
  const off=fixture(true);off.custody.wms_enabled=false;refused(off,'WMS_MODE_MISMATCH');
  const on=fixture();on.custody.wms_enabled=true;refused(on,'LAYER_QUANTITY_MISMATCH');
  for(const change of [{fifo_sequence:'0'},{fifo_sequence:'9223372036854775808'},{expiry_date:'2026-02-31'},{extra:true}]){const f=fixture(true);Object.assign(f.custody.layer_metadata[0],change);refused(f,'INVALID_PHYSICAL_SOURCE');}
  const foreign=fixture(true);foreign.custody.layer_metadata[0].product_id=id(999);refused(foreign,'MISSING_OR_FOREIGN_LAYER_METADATA');
  const lot=fixture(true);lot.custody.layer_metadata[0].lot_id=lot.custody.layer_metadata[1].lot_id;refused(lot,'INCONSISTENT_LOT_METADATA');
  const rows=fixture();rows.custody.picks=Array.from({length:C.source_rows_per_kind+1},()=>rows.custody.picks[0]);refused(rows,'INVALID_PHYSICAL_SOURCE');
});

test('commercial over-allocation and VAT-not-ready are not converted into executable physical plans',()=>{
  const f=fixture();f.request.children[1].items[0].quantity=7;assert.throws(()=>run(f),/OVER_ALLOCATION/);
  const g=fixture(false,6);g.source.items[0].price=1;g.source.items[0].vat=23;g.source.items[0].line_total=6;g.source.order.total=6;g.source.financial.balance.nominal=g.source.financial.balance.amount_due=6;
  refused(g,'COMMERCIAL_ALLOCATION_NOT_READY');
});
