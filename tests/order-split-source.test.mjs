/** Actual capture export/schema/calculator, controlled current-TX query port.
 * No database, factory, request admission or Native acceptance is represented. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformWithOxc } from 'vite';
import { orderSplitSourceFrame, orderSplitUuid, orderSplitVersion, ORDER_SPLIT_LIMITS as L } from '../server/order-splits-schema.ts';
import { calculateOrderSplit } from '../server/order-splits-values.ts';
import { calculateOrderSplitCustody, orderSplitPhysicalSnapshot, ORDER_SPLIT_CUSTODY_LIMITS as C } from '../server/order-split-custody-values.ts';
const raw = fs.readFileSync(new URL('../server/order-split-source.ts', import.meta.url),'utf8');
const code = (await transformWithOxc(raw.replace(/^import .*;\n/gm, '').replaceAll('export ', ''), 'capture-controlled.ts')).code;
const id = n => `${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant = id(1), order = id(2), warehouse = id(3), product = id(4), item = id(5);
const zero = {payment_entries:'0',source_payment_checks:'0',import_allocations:'0',payment_import_receipts:'0',source_payment_jobs:'0',payment_import_attempts:'0',documents:'0',invoice_plans:'0',corrections:'0',returns:'0',exchanges:'0',shipments:'0',provider_attempts:'0',parcel_plans:'0',active_picking_waves:'0',active_packing_sessions:'0',merge_lineage:'0',external_intents:'0',custom_fields:'0',physical_scans:'0',inactive_layers:'0',location_consumed:'0',location_released:'0',layer_consumed:'0',layer_released:'0'};
const input = {tenantId:tenant,orderId:order,expectedVersion:'7'};
const request = {client_key:id(6),source_order_id:order,expected_source_version:'7',children:[{slot_id:id(7),name:'Child',delivery_minor:0,items:[{source_item_id:item,quantity:1}]}]};
function harness(options = {}) {
  const calls = [], context = {role:'dyna_app',tenant,read_only:'off',xid:'101',started:'current TX',pid:'81'};
  const base={tenant_id:tenant,order_id:order,product_id:product,warehouse_id:warehouse,quantity:3,consumed_quantity:0,released_quantity:0};
  const physical={reservations:options.reservations??[{...base,state:'active'}],
    picks:options.picks??[{id:id(31),tenant_id:tenant,order_id:order,product_id:product,quantity:3,scanned:0,sku:'SKU',name:'Product',ean:'123'}],
    locations:options.locations??[{...base,location:'A',scanned:0}],
    layers:options.layers??(options.wms?[{...base,location:'A',layer_id:id(41),state:'active',scanned:0}]:[]),
    layer_metadata:options.layerMetadata??(options.wms?[{layer_id:id(41),product_id:product,lot_id:id(51),fifo_sequence:'9223372036854775807',expiry_date:'2028-01-01'}]:[])};
  let contexts = 0;
  const c = {async query(sql,args) {
    const stage = /split:([\w-]+)/.exec(sql)?.[1]; calls.push(stage);
    if (stage === 'context') { contexts++; return {rows:[{...context,...options.context,...(contexts > 1 ? options.end : {})}]}; }
    if (stage === 'fences') { assert.deepEqual(args,['catalog:'+tenant]); assert.match(sql,/pg_advisory_xact_lock_shared\(982376\)/); return {rows:[{}]}; }
    if (stage === 'namespace') { assert.match(sql,/pg_class[\s\S]*pg_proc[\s\S]*pg_namespace/); return {rows:[{present:options.namespace ?? false}]}; }
    if(stage==='physical-policy-lock'){assert.deepEqual(args,['wms.policy:'+tenant]);assert.match(sql,/pg_advisory_xact_lock_shared/);return{rows:[{}]};}
    if(stage==='physical-policy'){
      if(/\bFOR\s+(?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)\b/i.test(sql))throw Object.assign(Error('Read-only policy privileges'),{code:'42501'});
      assert.deepEqual(args,[tenant]);assert.match(sql,/WHERE tenant_id=\$1 LIMIT 2$/);return{rows:options.policyRows??(options.wms?[{enabled:true}]:[])};
    }
    if(stage==='physical-operations-lock'){assert.deepEqual(args,['wms.operations:'+tenant]);assert.match(sql,/pg_advisory_xact_lock_shared\(hashtextextended/);return{rows:[{}]};}
    assert.deepEqual(args,[tenant,order]);
    if (stage === 'order') { assert.match(sql,/WHERE tenant_id=\$1 AND id=\$2 FOR UPDATE/); return {rows:[{id:order,tenant_id:tenant,version:'7',source:'manual',fulfillment_kind:'sale',status:'new',warehouse_id:warehouse,currency:'PLN',payment_mode:'prepaid',shipping_cost:2,total:371,channel_id:null,external_id:null,b2b_account_id:null,unsupported_business_fields:false,...options.order}]}; }
    if (stage === 'line-bound') return {rows:[{n:'1',bytes:'500',...options.size}]};
    if (stage === 'items') { assert.match(sql,/i\.tenant_id=\$1 AND i\.order_id=\$2[\s\S]*LIMIT 10001 FOR UPDATE OF i/); return {rows:[{id:item,order_id:order,product_id:product,product_kind:'simple',quantity:3,price:123,vat:23,line_total:369,components:[{product_id:product,quantity:1}],scanned:0,...options.item}]}; }
    if (stage === 'reservations') return {rows:physical.reservations};
    if(stage==='physical-bound'){
      assert.match(sql,/wms_cost_layers l JOIN wms_lots o ON\(o.tenant_id,o.id,o.product_id\)=\(l.tenant_id,l.lot_id,l.product_id\)/);
      const counts=Object.fromEntries(Object.entries(physical).flatMap(([k,v])=>[[k,String(v.length)],[k+'_bytes',String(Buffer.byteLength(JSON.stringify(v)))]]));return{rows:[{...counts,...options.physicalBound}]};
    }
    if(stage==='physical-picks'){assert.match(sql,/order_pick_items r WHERE tenant_id=\$1 AND order_id=\$2.*LIMIT 10001 FOR UPDATE OF r/);return{rows:physical.picks};}
    if(stage==='physical-locations'){assert.match(sql,/reservation_locations.*LIMIT 10001 FOR UPDATE OF r/);return{rows:physical.locations};}
    if(stage==='physical-layers'){assert.match(sql,/wms_reservation_layers.*LIMIT 10001 FOR UPDATE OF r/);return{rows:physical.layers};}
    if(stage==='physical-metadata'){
      if(/\bFOR\s+(?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)\b/i.test(sql))throw Object.assign(Error('Read-only immutable metadata privileges'),{code:'42501'});
      assert.match(sql,/l.fifo_sequence::text AS fifo_sequence,o.expiry_date::text AS expiry_date/);
      assert.match(sql,/r.tenant_id=\$1 AND r.order_id=\$2 AND \(r.layer_id,r.product_id\)=\(l.id,l.product_id\)/);
      assert.match(sql,/ORDER BY l.id LIMIT 10001$/);return{rows:physical.layer_metadata};
    }
    if (stage === 'physical-shape') return {rows:[{inconsistent:options.inconsistent ?? false}]};
    if (stage === 'counts') {
      assert.match(sql,/payment_import_execution_rows x JOIN payment_import_rows r/);
      assert.match(sql,/r\.allocation->>'order_id'=\$2::text/);
      assert(!sql.includes("e.state='done'"), 'queued and failed selections must remain visible');
      assert(!sql.includes('dpd_shipping_plans'), 'DPD is actual shipping_plans provider, not a fabricated table');
      return {rows:[{...zero,...options.counts}]};
    }
    if (stage === 'private-counts') return {rows:[{invoice_plans:'0',corrections:'0',...options.privateCounts}]};
    if (stage === 'buyer') return {rows:[{state:{version:'0',...options.buyer}}]};
    throw Error('Unexpected capture query: '+stage);
  }};
  const balance = async (client, oid) => { assert.equal(client,c); assert.equal(oid,order); calls.push('balance'); return {currency:'PLN',payment_mode:'prepaid',received:0,refunded:0,credit:0,return_credit:0,cancelled_credit:0,net:0,overpayment:0,collected:0,remitted:0,fees:0,courier_due:0,nominal:371,amount_due:371,...options.balance}; };
  const api = new Function('orderSplitSourceFrame','orderSplitUuid','orderSplitVersion','L','orderMergeOriginalPaymentBalanceInTx','fa3DraftOwnerInTx','orderSplitPhysicalSnapshot','C',(options.code??code)+';return {captureOrderSplitSourceInTx,captureOrderSplitSourcesInTx,OrderSplitCaptureError};')(orderSplitSourceFrame,orderSplitUuid,orderSplitVersion,L,balance,async(client,fn)=>{assert.equal(client,c); calls.push('private-owner');return fn();},orderSplitPhysicalSnapshot,C);
  return {run:()=>api.captureOrderSplitSourceInTx(c,input),bundle:()=>api.captureOrderSplitSourcesInTx(c,input),calls};
}
test('controlled simple manual source produces a complete calculable frame; existing active reservation is normal', async()=>{
  const h=harness(), frame=await h.run();
  assert.equal(calculateOrderSplit(frame,request).ready,true);
  assert.equal(frame.financial.source_payment_checks,0); assert.equal(frame.blockers.split_lineage,0);
  assert.deepEqual(h.calls,['context','fences','private-owner','namespace','order','line-bound','items','reservations','physical-shape','counts','private-owner','private-counts','buyer','balance','context']);
  assert(!('serial_bindings' in frame.blockers)); assert(!('customer_name' in frame.order));
});
test('exact tenant/current transaction and locked current version refuse context/actor shortcuts',async()=>{
  for(const opts of [{context:{role:'postgres'}},{context:{tenant:id(9)}},{context:{read_only:'on'}},{end:{xid:'102'}},{order:{version:'8'}},{order:{tenant_id:id(9)}}])
    await assert.rejects(harness(opts).run());
});
test('durable queued import, unchanged source check, failed source job and reversed ledger remain history despite net zero',async()=>{
  for(const key of ['payment_import_attempts','source_payment_checks','source_payment_jobs','payment_entries','payment_import_receipts','import_allocations']) {
    const frame=await harness({counts:{[key]:'1'}}).run();
    assert.throws(()=>calculateOrderSplit(frame,request),/FINANCIAL_HISTORY_UNSUPPORTED/);
  }
});
test('unknown split namespace, bounds, missing/mismatched physical custody and malformed counts never turn into trusted zeros',async()=>{
  for(const opts of [{namespace:true},{inconsistent:true},{size:{n:'10001'}},{size:{bytes:String(L.source_bytes+1)}},{reservations:[]},{reservations:[{product_id:product,warehouse_id:warehouse,quantity:2,state:'active',consumed_quantity:0,released_quantity:0}]},{counts:{payment_entries:'9007199254740993'}},{counts:{payment_entries:null}}])
    await assert.rejects(harness(opts).run());
});
test('source sidecar/custom fields and actual physical activity are preserved as explicit blockers',async()=>{
  for(const opts of [{buyer:{version:'1'}},{counts:{custom_fields:'1'}}]) {
    const frame=await harness(opts).run(); assert.throws(()=>calculateOrderSplit(frame,request),/UNSUPPORTED_SOURCE_BINDING/);
  }
  for(const key of ['physical_scans','inactive_layers','location_consumed','location_released','layer_consumed','layer_released','active_packing_sessions','active_picking_waves']) {
    const frame=await harness({counts:{[key]:'1'}}).run();
    assert.throws(()=>calculateOrderSplit(frame,request),/SOURCE_HISTORY_OR_PARTIAL_FULFILLMENT/);
  }
});

test('released-only location/layer observations remain released facts, not mislabeled consumed units',async()=>{
  for(const key of ['location_released','layer_released']) {
    const frame=await harness({counts:{[key]:'2'}}).run();
    assert.equal(frame.blockers.consumed_quantity,0); assert.equal(frame.blockers.released_quantity,2);
    assert.throws(()=>calculateOrderSplit(frame,request),/SOURCE_HISTORY_OR_PARTIAL_FULFILLMENT/);
  }
});

test('new bundle captures complete actual OFF and ON physical arrays from the same TX and feeds the real planner',async()=>{
  for(const wms of [false,true]){
    const h=harness({wms}),v=await h.bundle(),p=calculateOrderSplitCustody(v.source,request,v.physical);
    assert.equal(p.integration_ready,false);assert.equal(v.physical.wms_enabled,wms);
    assert.equal(v.physical.reservations[0].tenant_id,tenant);assert.equal(v.physical.picks[0].id,id(31));
    assert.deepEqual(p.targets.map(t=>t.reservations[0].quantity),[1,2]);
    assert(h.calls.indexOf('physical-policy-lock')<h.calls.indexOf('order'));
    if(wms)assert(h.calls.indexOf('physical-policy')<h.calls.indexOf('physical-operations-lock')&&h.calls.indexOf('physical-operations-lock')<h.calls.indexOf('order'));
    else assert(!h.calls.includes('physical-operations-lock'));
    assert(h.calls.indexOf('physical-bound')<h.calls.indexOf('physical-picks'));
    assert.deepEqual(h.calls.slice(-6),['physical-bound','physical-picks','physical-locations','physical-layers','physical-metadata','context']);
    if(wms){assert.equal(v.physical.layer_metadata[0].fifo_sequence,'9223372036854775807');assert.equal(p.targets[0].layers[0].lot_id,id(51));assert.equal(p.targets[1].layers[0].expiry_date,'2028-01-01');}
    else{assert.deepEqual(v.physical.layers,[]);assert.deepEqual(v.physical.layer_metadata,[]);}
  }
});

test('bundle refuses foreign, partial, inconsistent or nonpristine physical rows rather than fabricating empty facts',async()=>{
  const h=harness({wms:true}),good=await h.bundle();
  const cases=[
    {physicalBound:{picks:'2'}}, {physicalBound:{layers:'2'}},
    {picks:[{...good.physical.picks[0],tenant_id:id(90)}]},
    {locations:[{...good.physical.locations[0],order_id:id(90)}]},
    {layers:[{...good.physical.layers[0],warehouse_id:id(90)}]},
    {picks:[]}, {locations:[]}, {layerMetadata:[]},
    {locations:[{...good.physical.locations[0],quantity:2}]},
    {layers:[{...good.physical.layers[0],quantity:2}]},
    {layerMetadata:[{...good.physical.layer_metadata[0],product_id:id(90)}]},
    {picks:[{...good.physical.picks[0],scanned:1}]},
    {locations:[{...good.physical.locations[0],released_quantity:1}]},
    {layers:[{...good.physical.layers[0],state:'transferred'}]},
    {policyRows:[{enabled:true},{enabled:true}]},
  ];
  for(const opts of cases)await assert.rejects(harness({wms:true,...opts}).bundle());
  await assert.rejects(harness({layers:good.physical.layers,layerMetadata:good.physical.layer_metadata}).bundle(),/WMS_MODE_MISMATCH/);
});

test('physical row/byte bounds refuse before bulk capture, late context drift remains fatal',async()=>{
  for(const opts of [{physicalBound:{picks:String(C.source_rows_per_kind+1)}},{physicalBound:{locations_bytes:String(C.input_bytes+1)}}]){
    const h=harness(opts);await assert.rejects(h.bundle());assert(!h.calls.includes('physical-picks'));
  }
  await assert.rejects(harness({end:{pid:'82'}}).bundle(),/TRANSACTION_CONTEXT_CHANGED/);
});

test('ordinary SELECT-only WMS metadata permissions reject both former FOR SHARE queries with42501',async()=>{
  for(const [before,after] of [['WHERE tenant_id=$1 LIMIT 2','WHERE tenant_id=$1 LIMIT 2 FOR SHARE'],['ORDER BY l.id LIMIT 10001','ORDER BY l.id LIMIT 10001 FOR SHARE OF l,o']]){
    assert(code.includes(before));const mutant=code.replace(before,after);
    await assert.rejects(harness({wms:true,code:mutant}).bundle(),e=>e.code==='42501');
  }
});
