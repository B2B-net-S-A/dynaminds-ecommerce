import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {buildApp} from '../server/app';
import {pool} from '../server/db';
import {seed} from './fixtures';
import {stocktakeAdjustmentFixture} from './stocktake-adjustments-fixture';
import {sourceCatalogStockControl,previewCatalogStockControl,commitCatalogStockControl} from '../server/catalog-stock-control';
import {inventoryBulkEditOperationKey} from '../server/inventory-bulk-edit';
import {bootstrap151169,install152169,facts169,own169,raw169,physicalExact169,consent169,sort169,wait169,type Facts,type Row} from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Requires root's certified mixed086 publisher.
// Actual native counts precede moves, including reversed input and two moves
// of one product. No fake149 parent, physical SQL fixture or second writer.
let app:Awaited<ReturnType<typeof buildApp>>,providerCalls=0;
const primaryKeys=new Map<string,string[]>();
before(async()=>{
  await bootstrap151169();await seed();await install152169();
  for(const r of(await pool.query(`SELECT t.relname name,array_agg(a.attname::text ORDER BY k.ordinality) columns
    FROM pg_constraint p JOIN pg_class t ON t.oid=p.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum,ordinality)
    JOIN pg_attribute a ON(a.attrelid,a.attnum)=(t.oid,k.attnum)
    WHERE p.contype='p' AND n.nspname='public' GROUP BY t.relname ORDER BY t.relname`)).rows)primaryKeys.set(r.name,r.columns);
  app=await buildApp({integrationTransport:async()=>{providerCalls++;throw Error('No provider in mixed086 count169');}});
});
after(async()=>{try{assert.equal(providerCalls,0);await app?.close();}finally{await pool.end();}});
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
const ids=(rows:Row[])=>rows.map(r=>r.id).sort();
const omit=(r:Row,fields:string[])=>Object.fromEntries(Object.entries(r).filter(([k])=>!fields.includes(k)));
function added(a:Facts,b:Facts,table:string){
  const pk=primaryKeys.get(table);assert(pk?.length,'Actual persisted compound PK '+table);
  const key=(r:Row)=>JSON.stringify(pk.map(k=>{assert(Object.hasOwn(r,k));return r[k];}));
  const old=raw169(a,table),now=raw169(b,table),keys=new Set(old.map(key));
  assert.equal(keys.size,old.length);assert.equal(new Set(now.map(key)).size,now.length);
  assert.deepEqual(b[table].filter(x=>keys.has(key(x.row))),a[table],'All original rows retained '+table);
  return now.filter(r=>!keys.has(key(r)));
}
async function fixture(){
  const f=await stocktakeAdjustmentFixture(app,false),catalog=one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[f.tenant])).rows).catalog_id as string;
  const publicSource=await f.ok('/catalog-stock-control/catalogs/'+catalog+'/source');
  assert.equal(publicSource.writers_available,false);assert.equal(publicSource.activation_available,false);
  const before=await facts169(),context={writersAvailable:true},{source}=await sourceCatalogStockControl(f.actor,catalog,context);
  assert.equal(source.ready,true,JSON.stringify(source.blockers));
  const {preview}=await previewCatalogStockControl(f.actor,catalog,{client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,
    policy_version:source.snapshot.policy.version,warehouse_policy_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.series.version}))},context);
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),context)).operation.after.strict,true);
  physicalExact169(before,await facts169());return{...f,catalog};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function key(f:Fixture,scopes:string[]){
  const k=await f.ok('/developer/keys','POST',{name:'Own native mixed086 authority',scopes},201);
  assert.deepEqual(one((await pool.query('SELECT scopes FROM api_keys WHERE(tenant_id,id)=($1,$2)',[f.tenant,k.id])).rows).scopes.slice().sort(),scopes.slice().sort());return k;
}
async function prepare(f:Fixture,k?:Row,pureMoves=false){
  const baseline=await facts169(),stock=own169(baseline,'stock',f.tenant),products=own169(baseline,'products',f.tenant);
  const row=(p:Row,location:string,operation:'count'|'move',quantity:number,destination?:string)=>({product_id:p.id,
    product_version:one(products.filter(x=>x.id===p.id)).version,stock_version:String(one(stock.filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id)).version),
    location,operation,quantity,...(operation==='move'?{destination}: {})});
  const [p0,p1,p2]=f.products;
  // Counts are deliberately last. The third product has two independently
  // funded moves; an incoming move is never needed to finance its outgoing.
  const input=pureMoves?[row(p2,'A-01','move',1,'B-02'),row(p2,'B-02','move',1,'A-01')]:[row(p0,'A-01','move',1,'B-02'),row(p1,'B-02','move',1,'A-01'),
    row(p2,'A-01','move',1,'B-02'),row(p2,'B-02','move',1,'A-01'),row(p0,'B-02','count',3),row(p1,'A-01','count',1)];
  const {preview}=await f.ok('/inventory-bulk-edit/previews','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,
    note:'Whole native086 counts and multiple independent moves, reversed input',rows:input},201,k);
  assert.equal(preview.ready,true);assert.equal(preview.total,input.length);assert.equal(preview.changed,input.length);assert.equal(preview.unchanged,0);
  physicalExact169(baseline,await facts169());
  const frozen=(await f.ok('/inventory-bulk-edit/previews/'+preview.id+'/rows','GET',undefined,200,k)).data as Row[];
  assert.equal(frozen.length,input.length);assert.deepEqual(frozen.map(r=>r.index),input.map((_,i)=>i));
  const final=[[1,4],[2,1],[2,2]];
  for(const [i,p] of f.products.entries())for(const r of frozen.filter(r=>r.product_id===p.id)){
    assert.equal(r.before.quantity,2);assert.equal(r.after.quantity,final[i][r.location==='A-01'?0:1]);
    assert.equal(r.after.warehouse_on_hand,final[i][0]+final[i][1]);assert.equal(BigInt(r.after.stock_version),BigInt(r.before.stock_version)+2n);
  }
  return{input,frozen,preview,body:consent169(preview),path:'/inventory-bulk-edit/previews/'+preview.id+'/execute'};
}
type Prepared=Awaited<ReturnType<typeof prepare>>;
const binTuple=(r:Row)=>[r.product_id,r.location,r.delta];
function moveMaps(f:Fixture,d:Prepared,a:Facts,b:Facts,native:Row,receipt:Row){
  const maps=added(a,b,'catalog_stock_count_move_maps'),nativeRows=added(a,b,'inventory_bulk_edit_execution_rows'),bins=added(a,b,'stock_location_movements'),operations=added(a,b,'stock_location_operations');
  const indices=d.input.flatMap((r,index)=>r.operation==='move'?[index]:[]);assert.equal(maps.length,indices.length);
  assert.deepEqual(maps.map(m=>m.source_index).sort((x,y)=>x-y),indices);
  for(const mapping of maps){const row=one(nativeRows.filter(r=>r.index===mapping.source_index)),input=d.input[mapping.source_index],op=one(operations.filter(o=>o.id===mapping.operation_id));
    assert.equal(mapping.receipt_id,receipt.id);assert.equal(mapping.inventory_execution_id,native.id);assert.equal(row.operation,'move');
    assert.deepEqual(row.operation_ids,[op.id]);assert.equal(op.idempotency_key,inventoryBulkEditOperationKey(d.preview.id,d.body.client_key,row.index));
    const out=one(bins.filter(j=>j.id===mapping.out_bin_movement_id)),into=one(bins.filter(j=>j.id===mapping.in_bin_movement_id));
    for(const journal of[out,into]){assert.equal(journal.operation_id,op.id);assert.equal(journal.kind,'move');assert.equal(journal.product_id,row.product_id);assert.equal(journal.warehouse_id,f.warehouse.id);}
    assert.equal(out.location,input.location);assert.equal(out.delta,-input.quantity);assert.equal(into.location,input.destination);assert.equal(into.delta,input.quantity);
  }
  assert.deepEqual(maps.flatMap(m=>[m.out_bin_movement_id,m.in_bin_movement_id]).sort(),ids(bins.filter(j=>j.kind==='move')),'Complete paired native move witnesses; none is a PW/RW count');
}
function prove(f:Fixture,d:Prepared,a:Facts,b:Facts,result:Row,k?:Row){
  const append=new Set(['audit_events','purchasing_stock_changes','stock_movements','stock_location_movements','stock_location_operations',
    'inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows','catalog_stock_control_series','catalog_stock_control_counters',
    'catalog_stock_control_effect_admissions','catalog_stock_control_effects','catalog_stock_control_effect_journals',
    'catalog_stock_count_admissions','catalog_stock_count_receipts','catalog_stock_count_documents','catalog_stock_count_rows',
    'catalog_stock_count_native_maps','catalog_stock_count_stock_maps','catalog_stock_count_bin_maps','catalog_stock_count_layer_maps','catalog_stock_count_move_maps']);
  assert.deepEqual(Object.keys(b),Object.keys(a));
  for(const name of Object.keys(a)){
    assert.deepEqual(b[name].filter(x=>x.row.tenant_id!==f.tenant),a[name].filter(x=>x.row.tenant_id!==f.tenant),'Literal foreign/global/session retention '+name);
    if(append.has(name))assert(added(a,b,name).every(r=>r.tenant_id===f.tenant));
    else if(!['stock','stock_locations'].includes(name))assert.deepEqual(b[name],a[name],'No undeclared effects '+name);
  }
  const native=one(added(a,b,'inventory_bulk_edit_executions')),nativeRows=added(a,b,'inventory_bulk_edit_execution_rows').sort((x,y)=>x.index-y.index);
  assert.equal(native.id,result.execution.id);assert.equal(native.preview_id,d.preview.id);assert.equal(native.actor_id,f.user);
  assert.equal(native.client_key,d.body.client_key);assert.equal(native.scope_hash,d.body.scope_hash);assert.equal(native.total,6);assert.equal(native.changed,6);
  assert.deepEqual(nativeRows.map(r=>r.index),[0,1,2,3,4,5]);const operations=added(a,b,'stock_location_operations');assert.equal(operations.length,6);
  for(const row of nativeRows){const frozen=d.frozen[row.index];assert.equal(row.operation,frozen.input.operation);assert.equal(row.status,'changed');
    assert.deepEqual(row.before,frozen.before);assert.deepEqual(row.after,frozen.after);assert.equal(BigInt(row.before_stock_version),BigInt(row.before.stock_version));
    assert.equal(BigInt(row.after_stock_version),BigInt(row.after.stock_version));assert.equal(row.operation_ids.length,1);
    const op=one(operations.filter(o=>o.id===row.operation_ids[0]));assert.equal(op.idempotency_key,inventoryBulkEditOperationKey(d.preview.id,d.body.client_key,row.index));
    assert.equal(op.result.id,op.id);assert.equal(op.result.kind,row.operation);
  }
  assert.deepEqual(nativeRows.flatMap(r=>r.operation_ids).sort(),ids(operations),'Every actual operation belongs to one native row');
  const bins=added(a,b,'stock_location_movements'),stockJournals=added(a,b,'stock_movements');assert.equal(bins.length,10);assert.equal(stockJournals.length,2);
  const expected=d.input.flatMap(r=>r.operation==='count'?[{product_id:r.product_id,location:r.location,delta:r.quantity-2}]:
    [{product_id:r.product_id,location:r.location,delta:-r.quantity},{product_id:r.product_id,location:r.destination,delta:r.quantity}]);
  assert.deepEqual(sort169(bins.map(binTuple)),sort169(expected.map(binTuple)));assert(bins.every(r=>r.warehouse_id===f.warehouse.id));
  for(const row of nativeRows){const own=bins.filter(j=>j.operation_id===row.operation_ids[0]),input=d.input[row.index];
    assert.equal(own.length,input.operation==='count'?1:2);assert(own.every(j=>j.kind===input.operation&&j.product_id===row.product_id));
    if(input.operation==='move')assert.deepEqual(sort169(own.map(binTuple)),sort169([
      [row.product_id,input.location,-input.quantity],[row.product_id,input.destination,input.quantity]]));
  }
  assert.deepEqual(sort169(stockJournals.map(j=>[j.product_id,j.delta])),sort169(d.input.filter(r=>r.operation==='count').map(r=>[r.product_id,r.quantity-2])));
  assert(stockJournals.every(j=>j.kind==='location_count'&&j.warehouse_id===f.warehouse.id));
  assert.equal(added(a,b,'purchasing_stock_changes').length,8,'Six actual099 updates plus two count100 stock INSERTs');
  const final=[[1,4],[2,1],[2,2]];
  for(const [i,p] of f.products.entries()){
    const old=one(own169(a,'stock',f.tenant).filter(s=>s.product_id===p.id)),now=one(own169(b,'stock',f.tenant).filter(s=>s.product_id===p.id));
    assert.deepEqual(omit(now,['on_hand','available','version']),omit(old,['on_hand','available','version']));assert.equal(now.on_hand,final[i][0]+final[i][1]);
    assert.equal(now.available,now.on_hand-now.reserved);assert.equal(BigInt(now.version),BigInt(old.version)+2n);
    for(const location of['A-01','B-02']){const oldBin=one(own169(a,'stock_locations',f.tenant).filter(s=>s.product_id===p.id&&s.location===location)),
      bin=one(own169(b,'stock_locations',f.tenant).filter(s=>s.product_id===p.id&&s.location===location));assert.deepEqual(omit(bin,['quantity']),omit(oldBin,['quantity']));
      assert.equal(bin.quantity,final[i][location==='A-01'?0:1]);}
  }
  assert.equal(own169(b,'stock_locations',f.tenant).length,own169(a,'stock_locations',f.tenant).length);
  const admission=one(added(a,b,'catalog_stock_count_admissions')),receipt=one(added(a,b,'catalog_stock_count_receipts')),
    generic=one(added(a,b,'catalog_stock_control_effect_admissions')),effect=one(added(a,b,'catalog_stock_control_effects'));
  assert.equal(admission.id,generic.id);assert.equal(receipt.id,admission.count_receipt_id);assert.equal(receipt.admission_id,admission.id);
  assert.equal(receipt.inventory_execution_id,native.id);assert.equal(receipt.stock_file_execution_id,null);assert.equal(admission.source_id,d.preview.id);
  assert.equal(admission.protocol,'inventory_bulk');assert.deepEqual(admission.request,d.body);assert.equal(admission.actor_id,f.user);assert.equal(admission.api_key_id,k?.id??null);
  assert.equal(admission.sealed,true);assert.equal(generic.sealed,true);assert.equal(String(admission.txid),String(generic.txid));
  assert.equal(generic.source_kind,'inventory_import');assert.equal(generic.source_id,receipt.id);assert.equal(effect.admission_id,admission.id);
  assert.equal(effect.count_receipt_id,receipt.id);assert.equal(effect.location_operation_id,null,'One opaque native parent; no second per-move admission');
  const witness=added(a,b,'catalog_stock_control_effect_journals');assert.equal(witness.length,12);
  for(const [kind,table,field] of[['stock','stock_movements','stock_movement_id'],['bin','stock_location_movements','location_movement_id']] as const){
    const entries=witness.filter(w=>w.kind===kind);assert.deepEqual(entries.map(w=>w.journal_id).sort(),ids(added(a,b,table)));
    assert(entries.every(w=>w.admission_id===admission.id&&w[field]===w.journal_id));}
  assert.deepEqual([...receipt.proof.stock_movement_ids].sort(),ids(stockJournals));assert.deepEqual([...receipt.proof.location_movement_ids].sort(),ids(bins));
  assert.deepEqual(receipt.proof.layer_movement_ids,[]);assert.deepEqual(effect.proof,receipt.proof,'Whole parent certifies moves as well as counts');
  moveMaps(f,d,a,b,native,receipt);
  const documents=added(a,b,'catalog_stock_count_documents'),countRows=added(a,b,'catalog_stock_count_rows');assert.equal(documents.length,2);assert.equal(countRows.length,2);
  const countBins=bins.filter(j=>j.kind==='count');assert.equal(countBins.length,2);assert.deepEqual(countRows.map(r=>r.bin_movement_id).sort(),ids(countBins));
  assert.equal(added(a,b,'catalog_stock_control_series').length,2);assert.equal(added(a,b,'catalog_stock_control_counters').length,2);
  for(const document of documents){assert.equal(document.receipt_id,receipt.id);assert.equal(document.warehouse_id,f.warehouse.id);
    const series=one(own169(b,'catalog_stock_control_series',f.tenant).filter(s=>s.id===document.series_id));assert.equal(series.kind,document.kind);
    assert.equal(document.number,`${series.prefix}/${document.year}/${String(document.sequence).padStart(6,'0')}`);
    const counter=one(own169(b,'catalog_stock_control_counters',f.tenant).filter(c=>c.series_id===series.id&&c.year===document.year));
    assert.equal(String(counter.value),'1');assert.equal(String(document.sequence),'1');assert.equal(document.payload.quantity,'1');assert.equal(document.payload.row_count,1);
    const row=one(countRows.filter(r=>r.document_id===document.id));assert.equal(row.ordinal,0);assert.equal(row.delta,document.kind==='PW'?1:-1);
    assert.deepEqual(binTuple(row),binTuple(one(countBins.filter(j=>j.id===row.bin_movement_id))));
  }
  const maps=added(a,b,'catalog_stock_count_native_maps');assert.equal(maps.length,2);
  for(const row of countRows){const map=one(maps.filter(m=>m.row_id===row.id));assert.equal(map.inventory_execution_id,native.id);assert.equal(map.stock_file_execution_id,null);
    assert.equal(map.quantity,1);assert.equal(map.inventory_row_index,map.source_index);assert.equal(nativeRows[map.source_index].operation,'count');
    assert.equal(nativeRows[map.source_index].product_id,row.product_id);assert.equal(nativeRows[map.source_index].location,row.location);}
  const stockMaps=added(a,b,'catalog_stock_count_stock_maps');assert.equal(stockMaps.length,2);
  for(const map of stockMaps){const row=one(countRows.filter(r=>r.id===map.row_id)),j=one(stockJournals.filter(s=>s.id===map.stock_movement_id));
    assert.equal(map.quantity,1);assert.equal(j.product_id,row.product_id);assert.equal(j.delta,row.delta);}
  assert.deepEqual(stockMaps.map(m=>m.stock_movement_id).sort(),ids(stockJournals));
  assert.equal(added(a,b,'catalog_stock_count_bin_maps').length,0);assert.equal(added(a,b,'catalog_stock_count_layer_maps').length,0);
  const heads=result.execution.stock_count_documents as Row[];assert.equal(heads.length,2);assert.deepEqual(heads.map(h=>h.id).sort(),ids(documents));
  for(const head of heads){const saved=one(documents.filter(d=>d.id===head.id));assert.equal(head.protocol,'inventory_bulk');assert.equal(head.source_id,d.preview.id);
    assert.equal(head.quantity,'1');assert.equal(head.row_count,1);assert.equal(head.wms_enabled,false);
    for(const field of['id','receipt_id','warehouse_id','kind','number','series_id','year'])assert.equal(head[field],saved[field]);
    assert.equal(head.sequence,String(saved.sequence));assert(!Object.keys(head).some(k=>/cost|value|layer|payload/.test(k)));}
}
async function replayReads(f:Fixture,d:Prepared,result:Row,accepted:Facts,k?:Row){
  const replay=await f.ok(d.path,'POST',d.body,200,k);assert.equal(replay.reused,true);assert.equal(replay.execution.id,result.execution.id);
  assert.deepEqual(replay.execution.stock_count_documents,result.execution.stock_count_documents);assert.deepEqual(await facts169(),accepted);
  const detail=await f.ok('/inventory-bulk-edit/executions/'+result.execution.id,'GET',undefined,200,k);
  assert.deepEqual(detail.execution.stock_count_documents,result.execution.stock_count_documents);
  const history=await f.ok('/inventory-bulk-edit/executions','GET',undefined,200,k);assert.deepEqual(one(history.data.filter((e:Row)=>e.id===result.execution.id)).stock_count_documents,result.execution.stock_count_documents);
  const rows=await f.ok('/inventory-bulk-edit/executions/'+result.execution.id+'/rows','GET',undefined,200,k);assert.equal(rows.data.length,d.input.length);assert.equal(rows.meta.cursor,null);
  assert.deepEqual(await facts169(),accepted,'Exact replay/history/full rows never add a move, count or number');
  for(const body of[{...d.body,scope_hash:'0'.repeat(64)},{...d.body,client_key:randomUUID()}]){
    const denied=await f.request(d.path,'POST',body,k);assert.equal(denied.statusCode,409,denied.body);assert.deepEqual(await facts169(),accepted);}
}
test('strict086 genuine mixed count and multiple-move group retain one whole native graph and count-only PW/RW with exact replay',async()=>{
  const f=await fixture(),k=await key(f,['products:read','inventory:read','inventory:write']),d=await prepare(f,k),before=await facts169();
  const result=await f.ok(d.path,'POST',d.body,201,k),accepted=await facts169();assert.equal(result.reused,false);prove(f,d,before,accepted,result,k);
  await replayReads(f,d,result,accepted,k);
});
test('strict086 pure multiple moves certify the real whole parent and balanced bin pairs without PW/RW or a fabricated numbered MM',async()=>{
  const f=await fixture(),d=await prepare(f,undefined,true),a=await facts169(),result=await f.ok(d.path,'POST',d.body,201),b=await facts169();
  assert.equal(result.reused,false);assert.deepEqual(result.execution.stock_count_documents,[]);
  const append=new Set(['audit_events','purchasing_stock_changes','stock_location_movements','stock_location_operations',
    'inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows','catalog_stock_control_effect_admissions','catalog_stock_control_effects',
    'catalog_stock_control_effect_journals','catalog_stock_count_admissions','catalog_stock_count_receipts','catalog_stock_count_move_maps']);
  assert.deepEqual(Object.keys(b),Object.keys(a));
  for(const table of Object.keys(a)){assert.deepEqual(b[table].filter(x=>x.row.tenant_id!==f.tenant),a[table].filter(x=>x.row.tenant_id!==f.tenant));
    if(append.has(table))assert(added(a,b,table).every(r=>r.tenant_id===f.tenant));else if(table!=='stock')assert.deepEqual(b[table],a[table],'Pure group cannot create count rows/counters, MM documents, stock/bin births or WMS '+table);}
  const p=f.products[2];for(const old of own169(a,'stock',f.tenant)){
    const now=one(own169(b,'stock',f.tenant).filter(s=>s.product_id===old.product_id&&s.warehouse_id===old.warehouse_id));
    assert.deepEqual(omit(now,['version']),omit(old,['version']));assert.equal(BigInt(now.version),BigInt(old.version)+(old.product_id===p.id?2n:0n));}
  const native=one(added(a,b,'inventory_bulk_edit_executions')),rows=added(a,b,'inventory_bulk_edit_execution_rows').sort((x,y)=>x.index-y.index);
  assert.equal(native.id,result.execution.id);assert.equal(native.preview_id,d.preview.id);assert.equal(native.actor_id,f.user);assert.equal(native.client_key,d.body.client_key);
  assert.equal(native.total,2);assert.equal(native.changed,2);assert.equal(rows.length,2);assert.equal(added(a,b,'stock_location_operations').length,2);
  for(const r of rows){assert.equal(r.operation,'move');assert.equal(r.product_id,p.id);assert.deepEqual(r.before,d.frozen[r.index].before);assert.deepEqual(r.after,d.frozen[r.index].after);
    assert.equal(BigInt(r.before_stock_version),BigInt(r.before.stock_version));assert.equal(BigInt(r.after_stock_version),BigInt(r.after.stock_version));assert.equal(r.operation_ids.length,1);}
  const receipt=one(added(a,b,'catalog_stock_count_receipts')),admission=one(added(a,b,'catalog_stock_count_admissions')),
    generic=one(added(a,b,'catalog_stock_control_effect_admissions')),effect=one(added(a,b,'catalog_stock_control_effects'));
  assert.equal(receipt.inventory_execution_id,native.id);assert.equal(receipt.stock_file_execution_id,null);assert.equal(receipt.admission_id,admission.id);
  assert.equal(admission.count_receipt_id,receipt.id);assert.equal(admission.source_id,d.preview.id);assert.equal(admission.protocol,'inventory_bulk');
  assert.deepEqual(admission.request,d.body);assert.equal(admission.actor_id,f.user);assert.equal(admission.api_key_id,null);assert.equal(admission.sealed,true);
  assert.equal(generic.id,admission.id);assert.equal(generic.source_kind,'inventory_import');assert.equal(generic.source_id,receipt.id);assert.equal(generic.sealed,true);
  assert.equal(String(generic.txid),String(admission.txid));assert.equal(effect.count_receipt_id,receipt.id);assert.equal(effect.admission_id,admission.id);
  assert.equal(effect.location_operation_id,null);assert.deepEqual(effect.proof,receipt.proof);
  const bins=added(a,b,'stock_location_movements');assert.equal(bins.length,4);assert.deepEqual(receipt.proof.stock_movement_ids,[]);assert.deepEqual(receipt.proof.layer_movement_ids,[]);
  assert.deepEqual(receipt.proof.location_movement_ids.slice().sort(),ids(bins));assert.equal(added(a,b,'purchasing_stock_changes').length,2);
  const witness=added(a,b,'catalog_stock_control_effect_journals');assert.equal(witness.length,4);assert(witness.every(w=>w.kind==='bin'&&w.admission_id===admission.id&&w.journal_id===w.location_movement_id));
  assert.deepEqual(witness.map(w=>w.journal_id).sort(),ids(bins));moveMaps(f,d,a,b,native,receipt);
  await replayReads(f,d,result,b);
});
test('strict mixed086 readonly key and malformed consent cannot partially count, move or allocate a document number',async()=>{
  const f=await fixture(),d=await prepare(f),readonly=await key(f,['products:read','inventory:read']),before=await facts169();
  for(const body of[{...d.body,confirmed:false},{...d.body,allow_partial:true}]){const response=await f.request(d.path,'POST',body);
    assert.equal(response.statusCode,422,response.body);assert.deepEqual(await facts169(),before);}
  const denied=await f.request(d.path,'POST',d.body,readonly);assert.equal(denied.statusCode,403,denied.body);assert.deepEqual(await facts169(),before);
});
test('terminal SQL failure after actual mixed086 native parent and whole receipt rolls back both counts, all moves and both numbers',async()=>{
  const f=await fixture(),d=await prepare(f),before=await facts169(),original=Client.prototype.query;
  let observed=false;const failure:{code?:string;message:string}[]=[];
  Client.prototype.query=function(this:Client,...args:any[]){
    const result=(original as any).apply(this,args),sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(typeof sql==='string'&&sql.startsWith('SELECT public.catalog_stock_count_finish')&&result?.then)
      return result.then(async(reply:Row)=>{assert.equal(reply.rows[0].receipt.documents.length,2);
        const native=await(original as any).call(this,"SELECT count(*)::int n FROM public.inventory_bulk_edit_executions WHERE tenant_id=$1 AND preview_id=$2 AND xmin=pg_current_xact_id()::text::xid",[f.tenant,d.preview.id]);
        assert.equal(native.rows[0].n,1);const operations=await(original as any).call(this,"SELECT count(*)::int n FROM public.inventory_bulk_edit_execution_rows WHERE tenant_id=$1 AND preview_id=$2 AND xmin=pg_current_xact_id()::text::xid",[f.tenant,d.preview.id]);
        assert.equal(operations.rows[0].n,6);observed=true;
        try{await(original as any).call(this,"DO $$BEGIN RAISE EXCEPTION 'COUNT169_MIXED_TERMINAL_FAILURE' USING ERRCODE='23514';END$$");}
        catch(error){const e=error as Error&{code?:string};failure.push({code:e.code,message:e.message});throw error;}
        assert.fail('Expected actual SQL failure');
      });
    return result;
  } as typeof Client.prototype.query;
  try{const response=await f.request(d.path,'POST',d.body);assert.equal(response.statusCode,409,response.body);assert.equal(observed,true);
    assert.equal(failure.length,1);assert.equal(failure[0].code,'23514');assert.match(failure[0].message,/COUNT169_MIXED_TERMINAL_FAILURE/);
    assert.deepEqual(await facts169(),before,'Entire native parent/PW/RW/currentTX graph fails atomically after actual finish');
  }finally{Client.prototype.query=original;}
});

test('strict mixed086 real native wait then committed key revocation rolls back the complete count/move group with only the intentional IAM change',async()=>{
  const f=await fixture(),k=await key(f,['products:read','inventory:read','inventory:write']),d=await prepare(f,k),baseline=await facts169();
  const originalKey=one(own169(baseline,'api_keys',f.tenant).filter(r=>r.id===k.id));assert.equal(originalKey.revoked_at,null);
  const blocker=await pool.connect(),authority=await pool.connect();
  let pending:ReturnType<Fixture['request']>|undefined;
  try{
    await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['inventory.bulk:'+f.tenant]);
    const blockerPid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending=f.request(d.path,'POST',d.body,k);
    const requestPid=await wait169(blockerPid,/SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/i);
    assert.notEqual(requestPid,blockerPid,'The actual authenticated mixed group reached its native086 lock after COUNTprepare');
    assert.deepEqual(await facts169(),baseline,'No partial native/strict graph is committed while the real source waits');
    // A genuine late key change must be possible before the terminal PIN.
    // Bound the owner intrusion so an accidental early IAM lock fails this
    // test instead of silently waiting for the source blocker forever.
    await authority.query("SET statement_timeout='3000ms'");
    const changed=await authority.query('UPDATE public.api_keys SET revoked_at=clock_timestamp() WHERE(tenant_id,id)=($1,$2) RETURNING id',[f.tenant,k.id]);
    assert.equal(changed.rowCount,1);
    const withdrawn=await facts169(),withdrawnKey=one(own169(withdrawn,'api_keys',f.tenant).filter(r=>r.id===k.id));
    assert.equal(typeof withdrawnKey.revoked_at,'string');assert.deepEqual(withdrawnKey,{...originalKey,revoked_at:withdrawnKey.revoked_at});
    assert.deepEqual(withdrawn.api_keys.filter(r=>r.row.id!==k.id),baseline.api_keys.filter(r=>r.row.id!==k.id));
    assert.deepEqual(withdrawn,{...baseline,api_keys:withdrawn.api_keys},'Only the exact committed own-key revocation changed global rows');
    await blocker.query('COMMIT');
    const response=await pending;assert.equal(response.statusCode,401,response.body);
    assert.deepEqual(await facts169(),withdrawn,'Late denial leaves no count/move/native parent, receipt, audit, counter, map, marker or session');
  }finally{
    await blocker.query('ROLLBACK').catch(()=>{});blocker.release();
    if(pending)await pending.catch(()=>{});
    try{await authority.query('UPDATE public.api_keys SET revoked_at=$3::timestamptz WHERE(tenant_id,id)=($1,$2)',[f.tenant,k.id,originalKey.revoked_at]);}
    finally{await authority.query('RESET statement_timeout').catch(()=>{});authority.release();}
  }
  assert.deepEqual(await facts169(),baseline,'Exact own-key repair restores all original global rows including sessions');
});

test('two identical actual mixed086 requests overlap at native and COUNTprepare locks and publish one complete group with one201 and one200',async()=>{
  const f=await fixture(),k=await key(f,['products:read','inventory:read','inventory:write']),d=await prepare(f,k),baseline=await facts169();
  const blocker=await pool.connect();
  let first:ReturnType<Fixture['request']>|undefined,second:ReturnType<Fixture['request']>|undefined;
  try{
    await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['inventory.bulk:'+f.tenant]);
    const blockerPid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    first=f.request(d.path,'POST',d.body,k);
    const firstPid=await wait169(blockerPid,/SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/i);
    second=f.request(d.path,'POST',d.body,k);
    const secondPid=await wait169(firstPid,/SELECT public\.catalog_stock_count_prepare\(/i);
    assert.notEqual(firstPid,secondPid,'Both independent actual HTTP requests are simultaneously serialized at their real source/strict boundaries');
    assert.deepEqual(await facts169(),baseline,'Neither overlapping command can commit a partial group before releasing the native lock');
    await blocker.query('COMMIT');
    const responses=await Promise.all([first,second]);assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,201]);
    const created=responses.find(r=>r.statusCode===201),reused=responses.find(r=>r.statusCode===200);assert(created);assert(reused);
    const fresh=created.json(),replay=reused.json();assert.equal(fresh.reused,false);assert.equal(replay.reused,true);
    assert.equal(replay.execution.id,fresh.execution.id);assert.equal(replay.execution.preview_id,d.preview.id);
    assert.equal(replay.execution.scope_hash,d.body.scope_hash);assert.deepEqual(replay.execution.stock_count_documents,fresh.execution.stock_count_documents);
    const accepted=await facts169();
    // Reuse the complete oracle: one native execution, six operation rows,
    // two count journals, ten bins, four moves, one receipt/effect, and two
    // count-only PW/RW with literal foreign/global retention. A second
    // orphan or unused admission would fail the same exact cardinalities.
    prove(f,d,baseline,accepted,fresh,k);
    await replayReads(f,d,fresh,accepted,k);
  }finally{
    await blocker.query('ROLLBACK').catch(()=>{});blocker.release();
    await Promise.all([first,second].filter((p):p is NonNullable<typeof p>=>!!p).map(p=>p.catch(()=>{})));
  }
});
