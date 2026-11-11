/** Root-only QA151 evidence. GET + native RR READ ONLY; no fixture/replay/receipt writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const root='<workspace>/app';
const base='http://127.0.0.1:4100/api';
const schema='135_order_parcel_completion_fix';
const revision=process.env.QA_EXPECTED_REVISION??'';
const statePath=resolve(root,'data/order-parcels-stage151.json');
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const hash=(v:unknown)=>sha(JSON.stringify(v));
const uuid=(v:unknown):string=>{assert.equal(typeof v,'string');assert.match(v as string,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);return v as string;};
let pool:Pool|undefined,step='preflight';
async function regular(path:string,mode?:number){const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());if(mode!==undefined)assert.equal(s.mode&0o777,mode);return s;}
async function absent(path:string){try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive report already exists');}
async function json(r:Response){assert.equal(r.status,200,'Read-only GET must succeed; do not refresh expired cookies');const b=Buffer.from(await r.arrayBuffer());assert(b.length<=8*1024*1024);return JSON.parse(b.toString('utf8'));}
async function get(a:any,path:string){assert(path.startsWith('/')&&!path.includes('://'));return json(await fetch(base+path,{method:'GET',headers:{cookie:a.cookie,'X-Workspace-ID':a.tenant_id},redirect:'error',signal:AbortSignal.timeout(10000),cache:'no-store'}));}
async function health(){const h=await json(await fetch(base+'/health',{redirect:'error',signal:AbortSignal.timeout(10000),cache:'no-store'}));assert.equal(h.status,'ok');assert.equal(h.revision,revision);assert.equal(h.schema_revision,schema);assert.equal(h.mode,'local');assert.equal(h.restore_preview,false);assert.equal(h.background_workers_enabled,false);assert.equal(h.order_parcels_available,true);return h;}
async function snapshot(c:PoolClient,a:any,names:string[]){const result:Record<string,{count:number;sha256:string}>={};for(const name of names){assert.match(name,/^[a-z_][a-z0-9_]*$/);const key=['users','tenants'].includes(name)?'id':'tenant_id';const rows=(await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`,[name==='users'?a.user_id:a.tenant_id])).rows;result[name]={count:rows.length,sha256:hash(rows)};}return result;}
async function ownRows(c:PoolClient,table:string,tenant:string){assert.match(table,/^[a-z_][a-z0-9_]*$/);return(await c.query(`SELECT * FROM "${table}" WHERE tenant_id=$1 ORDER BY id`,[tenant])).rows;}
function keyed(rows:any[],key:string,value:string){const found=rows.filter(r=>r[key]===value);assert.equal(found.length,1);return found[0];}
function requestParcels(parcels:any[]){return parcels.map(p=>({...p,products:[...p.products].sort((x,y)=>x.product_id.localeCompare(y.product_id))}));}
function checkActor(a:any,on:boolean){assert.equal(a.complete,true);assert.equal(a.on,on);assert.equal(a.label,on?'ON':'OFF');for(const k of ['tenant_id','user_id','warehouse_id','order_id','customer_item_id','sale_product_id'])uuid(a[k]);assert.equal(typeof a.cookie,'string');assert(a.cookie.startsWith('dyna_session=')&&!/[\r\n]/.test(a.cookie));assert.equal(a.components.length,on?2:1);assert.equal(new Set(a.components.map((p:any)=>p.id)).size,a.components.length);for(const [i,p]of a.components.entries()){uuid(p.id);assert(p.sku.startsWith('QA151-'));assert.equal(p.recipe_quantity,on&&i===1?2:1);assert.equal(p.initial_quantity,5*p.recipe_quantity);assert.equal(p.unit_cost_minor,on?(i===0?0:1000):317);}assert(a.setup_checkpoint&&a.source_born?.order&&a.source?.source);}

async function actorEvidence(c:PoolClient,a:any,phase:string,publicReads:any,names:string[]){
  const issuedUnits=phase==='after-plan'?0:phase==='after-first'?1:3;
  const dispatchCount=phase==='after-plan'?0:phase==='after-first'?1:2;
  const expectedStatus=issuedUnits===3?'shipped':'packed';
  const t=a.tenant_id,o=a.order_id;
  const orders=(await c.query('SELECT * FROM orders WHERE tenant_id=$1 ORDER BY id',[t])).rows;
  assert.equal(orders.length,1);const order=orders[0];assert.equal(order.id,o);assert.equal(order.status,expectedStatus);assert.equal(order.total,30000);assert.equal(order.shipping_cost,0);assert.equal(order.currency,'PLN');
  const items=(await c.query('SELECT * FROM order_items WHERE tenant_id=$1 ORDER BY id',[t])).rows;
  assert.equal(items.length,1);assert.equal(items[0].id,a.customer_item_id);assert.equal(items[0].product_id,a.sale_product_id);assert.equal(items[0].quantity,3);
  // Immutable commercial recipe and picking history must stay at the original three units.
  const bornItem=a.source_born.order.items.find((v:any)=>v.id===a.customer_item_id);assert(bornItem);assert.equal(publicReads.order.items.length,1);assert.equal(publicReads.order.items[0].id,a.customer_item_id);assert.equal(publicReads.order.items[0].quantity,3);assert.equal(publicReads.order.items[0].scanned,3);
  assert.equal(publicReads.order.total,30000);assert.equal(publicReads.order.payment.received,30000);assert.equal(publicReads.order.payment.amount_due,0);
  const previewRows=await ownRows(c,'order_parcel_previews',t),plans=await ownRows(c,'order_parcel_plans',t),dispatches=await ownRows(c,'order_parcel_dispatches',t);
  assert.equal(previewRows.length,1);assert.equal(plans.length,1);assert.equal(dispatches.length,dispatchCount);
  const plan=plans[0],p=previewRows[0];assert.equal(plan.preview_id,p.id);assert.equal(plan.order_id,o);assert.equal(plan.scope_hash,p.scope_hash);assert.deepEqual(plan.payload,p.payload);assert.deepEqual(requestParcels(p.request.parcels),requestParcels(a.preview_draft.parcels));assert.equal(p.payload.parcels.length,2);
  assert.equal(publicReads.source.source.active_plan_id,plan.id);assert.equal(publicReads.plan.plan.id,plan.id);assert.equal(publicReads.plan.plan.complete,issuedUnits===3);assert.equal(publicReads.plan.plan.order_status,expectedStatus);assert.deepEqual(publicReads.plan.plan.parcels,plan.payload.parcels);
  const allocations=(await c.query('SELECT * FROM order_parcel_allocations WHERE tenant_id=$1 ORDER BY index',[t])).rows;
  assert.equal(allocations.length,2);
  const admissions=(await c.query('SELECT * FROM order_parcel_admissions WHERE tenant_id=$1 ORDER BY operation_id',[t])).rows;
  assert.equal(admissions.length,1+dispatchCount,'Immutable admissions remain as private evidence');
  assert.equal(new Set(admissions.map(r=>String(r.transaction_id))).size,admissions.length,'Each explicit UI write has its own transaction');
  for(const cert of admissions){assert.equal(cert.order_id,o);assert.equal(cert.plan_id,plan.id);assert.equal(cert.actor_id,a.user_id);assert.equal(cert.api_key_id,null);assert.equal(cert.scope_hash,plan.scope_hash);assert.match(String(cert.transaction_id),/^[0-9]+$/);assert.equal(cert.kind,cert.operation_id===plan.id?'apply':'dispatch');}
  const applyAdmission=keyed(admissions,'operation_id',plan.id);assert.equal(applyAdmission.kind,'apply');assert.equal(applyAdmission.parcel_index,null);assert.deepEqual(applyAdmission.payload,plan.payload);assert.deepEqual(applyAdmission.before_snapshot,plan.payload.snapshot);
  const shipments=(await c.query('SELECT * FROM shipments WHERE tenant_id=$1 ORDER BY id',[t])).rows;assert.equal(shipments.length,2);
  for(const [index,parcel]of plan.payload.parcels.entries()){
    assert.equal(parcel.index,index);assert.equal(parcel.source_kind,'demo');assert.equal(parcel.mode,'demo');assert.equal(parcel.cod_minor,0);assert.equal(parcel.products.length,a.components.length);assert.equal(allocations[index].shipment_id,parcel.shipment_id);assert.deepEqual(allocations[index].payload,parcel);
    const ship=keyed(shipments,'id',parcel.shipment_id);assert.equal(ship.order_id,o);assert.equal(ship.mode,'demo');assert.equal(ship.tracking_number,parcel.tracking_number);assert.equal(ship.cod_expected,0);assert.equal(Boolean(ship.dispatched_at),index<dispatchCount);
    assert.equal(publicReads.plan.plan.progress[index].state,index<dispatchCount?'dispatched':'pending');
    for(const comp of a.components){const item=keyed(parcel.products,'product_id',comp.id);assert.equal(item.warehouse_id,a.warehouse_id);assert.equal(item.quantity,(index===0?1:2)*comp.recipe_quantity);assert.deepEqual(item.locations,[{location:'QA151-01',quantity:item.quantity}]);if(a.on){assert.equal(item.lot_holds.length,1);const original=a.allocations.find((r:any)=>r.product_id===comp.id);assert.equal(item.lot_holds[0].layer_id,original.layer_id);assert.equal(item.lot_holds[0].location,'QA151-01');assert.equal(item.lot_holds[0].quantity,item.quantity);}else assert.deepEqual(item.lot_holds,[]);}
  }
  const reservations=(await c.query('SELECT * FROM reservations WHERE tenant_id=$1 ORDER BY product_id',[t])).rows;
  const bins=(await c.query('SELECT * FROM stock_locations WHERE tenant_id=$1 ORDER BY product_id,location',[t])).rows;
  const locations=(await c.query('SELECT * FROM reservation_locations WHERE tenant_id=$1 ORDER BY product_id,location',[t])).rows;
  const stock=(await c.query('SELECT * FROM stock WHERE tenant_id=$1 ORDER BY product_id',[t])).rows;
  const picks=(await c.query('SELECT * FROM order_pick_items WHERE tenant_id=$1 ORDER BY product_id',[t])).rows;
  assert.equal(reservations.length,a.components.length);assert.equal(locations.length,a.components.length);assert.equal(picks.length,a.components.length);
  const physical:any[]=[];
  for(const comp of a.components){
    const original=3*comp.recipe_quantity,consumed=issuedUnits*comp.recipe_quantity,remaining=original-consumed;
    const r=keyed(reservations,'product_id',comp.id),l=keyed(locations,'product_id',comp.id),s=keyed(stock,'product_id',comp.id),bin=keyed(bins,'product_id',comp.id),pick=keyed(picks,'product_id',comp.id);
    assert.equal(r.order_id,o);assert.equal(r.warehouse_id,a.warehouse_id);assert.equal(r.quantity,original);assert.equal(r.consumed_quantity,consumed);assert.equal(r.state,remaining===0?'consumed':'active');assert.equal(l.quantity,original);assert.equal(l.scanned,original);assert.equal(l.consumed_quantity,consumed);assert.equal(l.location,'QA151-01');assert.equal(pick.quantity,original);assert.equal(pick.scanned,original);
    assert.equal(s.on_hand,comp.initial_quantity-consumed);assert.equal(s.reserved,remaining);assert.equal(s.available,comp.initial_quantity-original);assert.equal(bin.quantity,s.on_hand);assert.equal(bin.location,'QA151-01');assert.equal(bin.quantity-(l.quantity-l.consumed_quantity),s.available);
    const read=keyed(publicReads.source.source.products,'product_id',comp.id);assert.equal(read.quantity,original);assert.equal(read.consumed_quantity,consumed);assert.equal(read.remaining,remaining);assert.equal(read.scanned,original);
    physical.push({product_id:comp.id,original_quantity:original,consumed_quantity:consumed,remaining_quantity:remaining,on_hand:s.on_hand,reserved:s.reserved,available:s.available,location_quantity:bin.quantity});
  }
  for(const s of stock.filter((s:any)=>!a.components.some((p:any)=>p.id===s.product_id))){assert.equal(s.product_id,a.sale_product_id);assert.equal(s.on_hand,0);assert.equal(s.reserved,0);}
  for(const s of bins.filter((s:any)=>!a.components.some((p:any)=>p.id===s.product_id))){assert.equal(s.product_id,a.sale_product_id);assert.equal(s.quantity,0);}
  const movements=(await c.query("SELECT * FROM stock_movements WHERE tenant_id=$1 AND kind='shipment' ORDER BY id",[t])).rows;
  const binMovements=(await c.query("SELECT * FROM stock_location_movements WHERE tenant_id=$1 AND kind='shipment' ORDER BY id",[t])).rows;
  assert.equal(movements.length,dispatchCount*a.components.length);assert.equal(binMovements.length,movements.length);
  for(const table of ['stock_movements','stock_location_movements','wms_operations','wms_layer_movements']){const kind=table.startsWith('wms_')?'dispatch':'shipment';const bornRows=(await c.query(`SELECT to_jsonb(q) row FROM "${table}" q WHERE tenant_id=$1 AND kind<>$2 ORDER BY 1`,[t,kind])).rows;assert.deepEqual({count:bornRows.length,sha256:hash(bornRows)},a.setup_checkpoint[table],'Original physical journal remains exact: '+table);}
  const wmsOps=(await c.query("SELECT * FROM wms_operations WHERE tenant_id=$1 AND kind='dispatch' ORDER BY id",[t])).rows;
  const fragments=(await c.query('SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 ORDER BY id',[t])).rows;
  const layerMovements=(await c.query("SELECT * FROM wms_layer_movements WHERE tenant_id=$1 AND kind='dispatch' ORDER BY id",[t])).rows;
  assert.equal(wmsOps.length,a.on?dispatchCount:0);assert.equal(fragments.length,a.on?dispatchCount*a.components.length:0);assert.equal(layerMovements.length,fragments.length);
  assert.equal(new Set(dispatches.map(d=>d.id)).size,dispatchCount);assert.equal(new Set(wmsOps.map(d=>d.id)).size,wmsOps.length);
  for(const d of dispatches){
    assert.equal(d.plan_id,plan.id);assert.equal(d.order_id,o);assert(d.parcel_index<dispatchCount);assert.equal(d.scope_hash,plan.scope_hash);const parcel=plan.payload.parcels[d.parcel_index];assert.equal(d.shipment_id,parcel.shipment_id);assert.equal(d.receipt.operation_id,d.id);assert.equal(d.receipt.stock_movements.length,a.components.length);assert.equal(d.receipt.location_movements.length,a.components.length);assert.equal(publicReads.plan.plan.progress[d.parcel_index].dispatch_id,d.id);
    const cert=keyed(admissions,'operation_id',d.id);assert.equal(cert.kind,'dispatch');assert.equal(cert.parcel_index,d.parcel_index);assert.deepEqual(cert.payload.parcel,parcel);assert.deepEqual(cert.payload.request,d.request);assert.equal(cert.payload.request_hash,d.request_hash);assert.deepEqual(cert.before_snapshot,d.before_snapshot);assert.equal(d.actor_id,cert.actor_id);assert.equal(d.api_key_id,cert.api_key_id);assert.equal(d.client_key,d.request.client_key);
    const predecessor=d.parcel_index===0?applyAdmission.before_snapshot:dispatches.find(v=>v.parcel_index===d.parcel_index-1)?.after_snapshot;assert(predecessor);assert.deepEqual(d.before_snapshot,predecessor,'Successive quantities derive from prior actual stock evidence');
    const witnesses=[...d.receipt.stock_movements.map((m:any)=>({table:'stock_movements',id:m.id})),...d.receipt.location_movements.map((m:any)=>({table:'stock_location_movements',id:m.id})),...(d.receipt.wms?.fragment_ids??[]).map((id:string)=>({table:'wms_issue_fragments',id}))];const sortedWitnesses=(rows:any[])=>[...rows].sort((x,y)=>x.table.localeCompare(y.table)||x.id.localeCompare(y.id));assert.deepEqual(sortedWitnesses(cert.payload.witnesses),sortedWitnesses(witnesses),'Retained certificate binds the exact actual receipt journal IDs');
    const apiDispatch=keyed(publicReads.plan.dispatches,'id',d.id);assert.equal(apiDispatch.parcel_index,d.parcel_index);assert.equal(apiDispatch.shipment_id,d.shipment_id);assert.deepEqual(apiDispatch.receipt,d.receipt);
    for(const product of parcel.products){const m=keyed(d.receipt.stock_movements,'product_id',product.product_id),actual=keyed(movements,'id',m.id),bm=keyed(d.receipt.location_movements,'product_id',product.product_id),actualBin=keyed(binMovements,'id',bm.id);assert.equal(m.quantity,product.quantity);assert.equal(m.warehouse_id,a.warehouse_id);assert.equal(actual.product_id,product.product_id);assert.equal(actual.warehouse_id,a.warehouse_id);assert.equal(actual.delta,-product.quantity);assert.equal(actual.order_id,o);assert.equal(actual.note,'parcel:'+d.id);assert.equal(bm.quantity,product.quantity);assert.equal(actualBin.product_id,product.product_id);assert.equal(actualBin.warehouse_id,a.warehouse_id);assert.equal(actualBin.delta,-product.quantity);assert.equal(actualBin.operation_id,d.id);assert.equal(actualBin.order_id,o);assert.equal(actualBin.location,'QA151-01');}
    if(a.on){assert.equal(d.receipt.wms.operation_id,d.id);const op=keyed(wmsOps,'id',d.id);assert.equal(op.client_key,d.id);assert.equal(op.order_id,o);assert.equal(op.request.plan_id,plan.id);assert.equal(op.request.parcel_index,d.parcel_index);const fs=fragments.filter(f=>f.operation_id===d.id);assert.deepEqual([...d.receipt.wms.fragment_ids].sort(),fs.map(f=>f.id).sort());assert.equal(fs.length,a.components.length);for(const f of fs){const comp=keyed(a.components,'id',f.product_id),quantity=(d.parcel_index===0?1:2)*comp.recipe_quantity,original=a.allocations.find((v:any)=>v.product_id===f.product_id);assert.equal(f.order_id,o);assert.equal(f.warehouse_id,a.warehouse_id);assert.equal(f.layer_id,original.layer_id);assert.equal(f.location,'QA151-01');assert.equal(f.quantity,quantity);assert.equal(f.unit_cost_minor,String(comp.unit_cost_minor));assert.equal(f.value_minor,String(quantity*comp.unit_cost_minor));assert.equal(f.currency,'PLN');const move=layerMovements.filter(m=>m.operation_id===d.id&&m.product_id===f.product_id&&m.layer_id===f.layer_id);assert.equal(move.length,1);assert.equal(move[0].delta,-quantity);assert.equal(move[0].value_delta,String(-quantity*comp.unit_cost_minor));}}
    else assert.equal(d.receipt.wms,null);
  }
  const holds=(await c.query('SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 ORDER BY product_id',[t])).rows;
  const positions=(await c.query('SELECT * FROM wms_layer_positions WHERE tenant_id=$1 ORDER BY product_id',[t])).rows;
  const layers=(await c.query('SELECT * FROM wms_cost_layers WHERE tenant_id=$1 ORDER BY product_id',[t])).rows;
  assert.equal(holds.length,a.on?2:0);assert.equal(positions.length,a.on?2:0);assert.equal(layers.length,a.on?2:0);
  if(a.on)for(const comp of a.components){const h=keyed(holds,'product_id',comp.id),pos=keyed(positions,'product_id',comp.id),layer=keyed(layers,'product_id',comp.id),original=3*comp.recipe_quantity,consumed=issuedUnits*comp.recipe_quantity;assert.equal(h.quantity,original);assert.equal(h.scanned,original);assert.equal(h.consumed_quantity,consumed);assert.equal(h.state,consumed===original?'consumed':'active');assert.equal(pos.quantity,comp.initial_quantity-consumed);assert.equal(pos.reserved,original-consumed);assert.equal(pos.layer_id,h.layer_id);assert.equal(layer.id,h.layer_id);assert.equal(layer.unit_cost_minor,String(comp.unit_cost_minor));assert.equal(layer.currency,'PLN');}
  const snap=await snapshot(c,a,names);
  for(const table of ['products','order_items','order_pick_items','payment_entries','documents','warehouse_documents','warehouse_document_lines','purchase_orders','purchase_order_lines','purchase_receipts','purchase_receipt_lines','wms_cost_layers','wms_lots']){assert(a.setup_checkpoint[table],'Required baseline table: '+table);assert.deepEqual(snap[table],a.setup_checkpoint[table],'Original commercial/cash/purchase evidence unchanged: '+table);}
  if(issuedUnits===0)for(const table of ['stock','stock_locations','reservations','reservation_locations','stock_movements','stock_location_movements','wms_operations','wms_layer_positions','wms_reservation_layers','wms_layer_movements','wms_issue_fragments'])assert.deepEqual(snap[table],a.setup_checkpoint[table],'Apply is stock-neutral: '+table);
  return {label:a.label,tenant_id:t,order_id:o,plan_id:plan.id,preview_id:p.id,wms_enabled:a.on,order_status:expectedStatus,commercial_quantity:3,issued_commercial_units:issuedUnits,parcel_count:2,dispatched_parcels:dispatchCount,retained_admission_count:admissions.length,distinct_write_transactions:true,physical,stock_movements:movements.length,location_movements:binMovements.length,wms_dispatch_operations:wmsOps.length,wms_issue_fragments:fragments.map(f=>({id:f.id,operation_id:f.operation_id,product_id:f.product_id,quantity:f.quantity,unit_cost_minor:f.unit_cost_minor,value_minor:f.value_minor,currency:f.currency})),known_zero_cost_preserved:a.on,own_tables:names.length,snapshot:snap,snapshot_sha256:hash(snap)};
}

async function main(){
  const phase=process.argv[2];assert(['after-plan','after-first','after-all','after-restart'].includes(phase));assert.equal(resolve(process.cwd()),root);assert.equal(resolve(dirname(fileURLToPath(import.meta.url)),'..'),root);assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(root,'.local.json'));assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.notEqual(process.env.DYNA_TEST,'true');assert.match(revision,/^[a-f0-9]{40}$/);
  await regular(resolve(root,'.local.json'),0o600);await regular(statePath,0o600);
  const output=resolve(root,`docs/order-parcels-native151-${phase}.json`);await absent(output);
  const originalBytes=await readFile(statePath),s=JSON.parse(originalBytes.toString('utf8'));
  assert.equal(s.stage,151);assert.equal(s.schema_revision,'134_order_parcels');assert.match(s.runtime_revision,/^[a-f0-9]{40}$/);assert.equal(s.complete,true);assert.equal(s.pending,null);assert.equal(s.phase,'READY_BEFORE_PARCEL_PREVIEW');checkActor(s.off,false);checkActor(s.on,true);assert.notEqual(s.off.tenant_id,s.on.tenant_id);assert.notEqual(s.off.user_id,s.on.user_id);assert.notEqual(s.off.order_id,s.on.order_id);
  step='health-and-own-GETs';await health();
  const reads:any[]=[];
  for(const a of [s.off,s.on]){const me=await get(a,'/auth/me');assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.role,'admin');const source=await get(a,`/order-parcels/orders/${a.order_id}/source`);assert.equal(source.available,true);assert.equal(source.read_only,false);assert.equal(source.can_read,true);assert.equal(source.source.order.id,a.order_id);uuid(source.source.active_plan_id);const plan=await get(a,`/order-parcels/plans/${source.source.active_plan_id}`),order=await get(a,`/orders/${a.order_id}`);assert.equal(plan.can_read,true);assert.equal(plan.plan.order_id,a.order_id);reads.push({source,plan,order});}
  // Import DB only after native config and no-write preflight have succeeded.
  pool=(await import('../server/db')).pool;const u=new URL(pool.options.connectionString!);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55432');assert.equal(u.pathname,'/dynaminds');
  step='native-repeatable-read';const c=await pool.connect();let evidence:any[]=[];
  try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");assert.deepEqual((await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0],{role:'postgres',db:'dynaminds',host:'127.0.0.1',port:55432});const names=(await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(r=>r.table_name as string);assert.deepEqual(names,Object.keys(s.off.setup_checkpoint));assert.deepEqual(names,Object.keys(s.on.setup_checkpoint));for(const [i,a]of [s.off,s.on].entries())evidence.push(await actorEvidence(c,a,phase,reads[i],names));await c.query('COMMIT');}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
  step='immutable-input-and-report';assert.deepEqual(await readFile(statePath),originalBytes);await regular(statePath,0o600);await health();
  if(phase==='after-restart'){
    const prior=JSON.parse(await readFile(resolve(root,'docs/order-parcels-native151-after-all.json'),'utf8'));
    assert.equal(prior.status,'NATIVE_QUANTITY_EVIDENCE_PASS');assert.equal(prior.phase,'after-all');assert.equal(prior.schema_revision,schema);assert.equal(prior.setup_file_sha256,sha(originalBytes));assert.notEqual(prior.revision,revision,'Restart proof requires the explicitly adopted new runtime revision');
    for(const actual of evidence){const before=keyed(prior.firms,'tenant_id',actual.tenant_id);assert.deepEqual(actual.snapshot,before.snapshot,'Every owned business row persists exactly across runtime restart');assert.deepEqual(actual.wms_issue_fragments,before.wms_issue_fragments);assert.equal(actual.plan_id,before.plan_id);assert.equal(actual.preview_id,before.preview_id);}
  }
  const f=await open(output,'wx',0o644);try{await f.writeFile(JSON.stringify({stage:151,status:'NATIVE_QUANTITY_EVIDENCE_PASS',phase,revision,schema_revision:schema,setup_revision:s.runtime_revision,setup_file_sha256:sha(originalBytes),firms:evidence,read_only_sql:true,ordinary_GET_only:true,sessions_excluded:true,setup_file_unchanged:true,provider_verified:false,bank_verified:false,physical_print_verified:false,chrome_human_verified:false,full_goal_complete:false},null,2)+'\n');await f.sync();}finally{await f.close();}
  console.log(JSON.stringify({status:'NATIVE_QUANTITY_EVIDENCE_PASS',phase,firms:2,dispatched_parcels:evidence.map(r=>r.dispatched_parcels)}));
}
main().catch(()=>{console.error(JSON.stringify({status:'QA151_EVIDENCE_FAILED',step,details:'PRIVATE_DETAILS_WITHHELD',mutations:0}));process.exitCode=1;}).finally(()=>pool?.end());
