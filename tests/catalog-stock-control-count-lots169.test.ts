import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../server/app';
import {pool} from '../server/db';
import {seed} from './fixtures';
import {adjustmentActor} from './stocktake-adjustments-fixture';
import {sourceCatalogStockControl,previewCatalogStockControl,commitCatalogStockControl} from '../server/catalog-stock-control';
import {bootstrap151169,install152169,facts169,own169,raw169,physicalExact169,consent169,type Row,type Facts} from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN: expected genuine ON115 opposing-lot support after
// root embeds the reviewed alternate COUNT fragment. Public BO readiness false.
// No fake149 source, raw physical fixture or manufactured aggregate journal.
let app:Awaited<ReturnType<typeof buildApp>>,providerCalls=0;
const primaryKeys=new Map<string,string[]>();
before(async()=>{
  await bootstrap151169();await seed();await install152169();
  for(const r of(await pool.query(`SELECT t.relname name,array_agg(a.attname::text ORDER BY k.ordinality) columns
    FROM pg_constraint p JOIN pg_class t ON t.oid=p.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum,ordinality)
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
    WHERE p.contype='p' AND n.nspname='public' GROUP BY t.relname ORDER BY t.relname`)).rows)primaryKeys.set(r.name,r.columns);
  app=await buildApp({integrationTransport:async()=>{providerCalls++;throw Error('No provider in count-lot169');}});
});
after(async()=>{try{assert.equal(providerCalls,0);await app?.close();}finally{await pool.end();}});
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
const omit=(r:Row,fields:string[])=>Object.fromEntries(Object.entries(r).filter(([k])=>!fields.includes(k)));
const ids=(rows:Row[])=>rows.map(r=>r.id).sort();
function added(a:Facts,b:Facts,table:string){
  const pk=primaryKeys.get(table);assert(pk?.length,'Actual primary key '+table);
  const key=(r:Row)=>JSON.stringify(pk.map(k=>{assert(Object.hasOwn(r,k));return r[k];}));
  const old=raw169(a,table),now=raw169(b,table),keys=new Set(old.map(key));assert.equal(keys.size,old.length);
  assert.equal(new Set(now.map(key)).size,now.length);assert.deepEqual(b[table].filter(x=>keys.has(key(x.row))),a[table],'Literal old rows '+table);
  return now.filter(r=>!keys.has(key(r)));
}

async function fixture(){
  const tenant=randomUUID();await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own count opposing lots169','enterprise')",[tenant]);
  const f=await adjustmentActor(app,tenant),warehouse=await f.ok('/warehouses','POST',{name:'Own opposing-lot warehouse',code:'LOT-'+randomUUID().slice(0,8)});
  const products:Row[]=[];
  for(const cost of['0','1000',null]){
    const p=await f.ok('/products','POST',{name:'Measured own lots '+String(cost),sku:'LOT169-'+randomUUID(),price:1501,vat:23,
      warehouse_id:warehouse.id,quantity:2,location:'A-01'},201);products.push({...p,cost});
  }
  const stocks=own169(await facts169(),'stock',tenant);
  const opening=(await f.ok('/wms-lots/opening-previews','POST',{client_key:randomUUID(),policy_version:'0',currency:'PLN',
    note:'Genuine opening0/1000/NULL before strict BO',lines:products.map(p=>({warehouse_id:warehouse.id,product_id:p.id,location:'A-01',quantity:2,
      stock_version:String(one(stocks.filter(s=>s.product_id===p.id)).version),lot_code:'LOSS-'+randomUUID(),unit_cost_minor:p.cost}))},201)).preview;
  assert.equal(opening.ready,true);await f.ok('/wms-lots/opening-previews/'+opening.id+'/activate','POST',{
    ...consent169(opening),ack_unknown_costs:true},201);
  // Opening accepts one lot per existing bin; a second lot is added by the
  // genuine WMS receipt, not by splitting unsupported opening lines or SQL.
  const opened=await facts169();
  await f.ok('/wms-lots/receipts','POST',{client_key:randomUUID(),policy_version:'1',warehouse_id:warehouse.id,
    stock_versions:products.map(p=>({product_id:p.id,warehouse_id:warehouse.id,version:String(one(own169(opened,'stock',tenant).filter(s=>s.product_id===p.id)).version)})),
    lines:products.map(p=>({product_id:p.id,location:'A-01',quantity:2,lot_code:'GAIN-'+randomUUID(),unit_cost_minor:'500',currency:'PLN'})),
    note:'Actual second lot in each same physical bin before BO',confirmed:true},201);
  const physical=await facts169(),layers=own169(physical,'wms_cost_layers',tenant),lots=own169(physical,'wms_lots',tenant);
  assert.equal(layers.length,6);assert.equal(lots.length,6);assert.equal(own169(physical,'stock_locations',tenant).length,3);
  for(const p of products){
    const ownLayers=layers.filter(l=>l.product_id===p.id);assert.equal(ownLayers.length,2);
    p.loss=one(ownLayers.filter(l=>one(lots.filter(x=>x.id===l.lot_id)).lot_code.startsWith('LOSS-')));
    p.gain=one(ownLayers.filter(l=>one(lots.filter(x=>x.id===l.lot_id)).lot_code.startsWith('GAIN-')));
    assert.equal(p.loss.unit_cost_minor===null?null:String(p.loss.unit_cost_minor),p.cost);
    assert.equal(String(p.gain.unit_cost_minor),'500');assert.equal(one(own169(physical,'stock',tenant).filter(s=>s.product_id===p.id)).on_hand,4);
  }
  const catalog=one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[tenant])).rows).catalog_id as string;
  const publicSource=await f.ok('/catalog-stock-control/catalogs/'+catalog+'/source');assert.equal(publicSource.writers_available,false);
  assert.equal(publicSource.activation_available,false);
  const context={writersAvailable:true},source=(await sourceCatalogStockControl(f.actor,catalog,context)).source;
  assert.equal(source.ready,true,JSON.stringify(source.blockers));
  const preview=(await previewCatalogStockControl(f.actor,catalog,{client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,
    policy_version:source.snapshot.policy.version,warehouse_policy_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.series.version}))},context)).preview;
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),context)).operation.after.strict,true);
  physicalExact169(physical,await facts169());return{...f,warehouse,products,catalog};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
async function prepare(f:Fixture,format:'csv'|'xml'){
  const records=f.products.flatMap(p=>[{SKU:p.sku,Q:'1',LOT:p.loss.lot_id,COST:'',CUR:''},
    {SKU:p.sku,Q:'3',LOT:p.gain.lot_id,COST:p.cost??'1000',CUR:'PLN'}]);
  const content=format==='csv'?'SKU;Q;LOT;COST;CUR\n'+records.map(r=>[r.SKU,r.Q,r.LOT,r.COST,r.CUR].join(';')).join('\n')
    :'<dynaminds-stock-counts version="1">'+records.map(r=>'<row>'+Object.entries(r).map(([k,v])=>`<field name="${k}">${xml(v)}</field>`).join('')+'</row>').join('')+'</dynaminds-stock-counts>';
  const before=await facts169();
  const {preview}=await f.ok('/stock-file-imports/previews','POST',{client_key:randomUUID(),file_name:'opposing-lots.'+format,
    note:'Separate real lots decrease and increase while physical bin total stays4',content,
    definition:{format,xml_mode:'positions',delimiter:';',identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'},
    targets:[{warehouse_id:f.warehouse.id,quantity_scope:'position',default_location:'A-01',mapping:{quantity:'Q',lot_id:'LOT',unit_cost_minor:'COST',currency:'CUR'}}],resolutions:[]},201);
  assert.equal(preview.summary.positions,6);assert.equal(preview.summary.changed,6);assert.equal(preview.summary.invalid,0);assert.equal(preview.summary.conflicts,0);
  physicalExact169(before,await facts169());
  const rows=(await f.ok('/stock-file-imports/previews/'+preview.id+'/rows')).rows as Row[];
  assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.index)).size,6);
  for(const p of f.products){const own=rows.filter(r=>r.product_id===p.id);assert.equal(own.length,2);
    assert(own.every(r=>r.location==='A-01'&&r.before.quantity===2));assert.deepEqual(own.map(r=>r.input.quantity).sort(),[1,3]);}
  const body={...consent169(preview),ack_unknown_loss_warehouse_ids:[f.warehouse.id],ack_surplus_warehouse_ids:[f.warehouse.id]};
  return{preview,rows,body,path:'/stock-file-imports/previews/'+preview.id+'/execute'};
}
type Prepared=Awaited<ReturnType<typeof prepare>>;

function prove(f:Fixture,d:Prepared,a:Facts,b:Facts,result:Row){
  const append=new Set(['audit_events','purchasing_stock_changes','wms_operations','wms_cost_layers','wms_layer_movements',
    'wms_stocktakes','wms_stocktake_lines','wms_stocktake_scope_layers','wms_stocktake_measurements','wms_stocktake_measurement_layers',
    'wms_stocktake_reviews','wms_stocktake_review_rows','wms_stocktake_postings','stock_file_import_executions','stock_file_import_admissions','stock_file_import_core_witnesses',
    'catalog_stock_control_series','catalog_stock_control_counters','catalog_stock_control_effect_admissions','catalog_stock_control_effects','catalog_stock_control_effect_journals',
    'catalog_stock_count_admissions','catalog_stock_count_receipts','catalog_stock_count_documents','catalog_stock_count_rows',
    'catalog_stock_count_stock_maps','catalog_stock_count_layer_maps','catalog_stock_count_native_maps']);
  for(const name of Object.keys(a)){
    assert.deepEqual(b[name].filter(x=>x.row.tenant_id!==f.tenant),a[name].filter(x=>x.row.tenant_id!==f.tenant),'Foreign/global/session retention '+name);
    if(append.has(name))assert(added(a,b,name).every(r=>r.tenant_id===f.tenant));
    else if(!['stock','wms_layer_positions'].includes(name))assert.deepEqual(b[name],a[name],'No undeclared row or second writer '+name);
  }
  assert.deepEqual(b.stock_locations,a.stock_locations,'Net0: actual bin quantity and every field are unchanged');
  assert.deepEqual(b.stock_movements,a.stock_movements,'Net0: no invented stock movement');
  assert.deepEqual(b.stock_location_movements,a.stock_location_movements,'Net0: no invented bin movement');
  for(const old of own169(a,'stock',f.tenant)){
    const now=one(own169(b,'stock',f.tenant).filter(s=>s.product_id===old.product_id&&s.warehouse_id===old.warehouse_id));
    assert.deepEqual(omit(now,['version']),omit(old,['version']));assert.equal(BigInt(now.version),BigInt(old.version)+1n,'One native WMS batched UPDATE, even net0');
  }
  assert.equal(added(a,b,'purchasing_stock_changes').length,1,'Only actual099 stock UPDATE; no nonzero100 stock journal');
  const layers=added(a,b,'wms_cost_layers'),journals=added(a,b,'wms_layer_movements');assert.equal(layers.length,3);assert.equal(journals.length,6);
  const op=one(added(a,b,'wms_operations')),posting=one(added(a,b,'wms_stocktake_postings'));
  assert.equal(posting.operation_id,op.id);assert.equal(op.warehouse_document_id,null);
  const native=one(added(a,b,'stock_file_import_executions'));assert.equal(native.id,result.execution.id);assert.equal(native.preview_id,d.preview.id);
  assert.deepEqual(native.payload.execute_request,d.body);assert.equal(native.payload.links.length,1);
  assert.equal(native.payload.links[0].posting_id,posting.id);assert.equal(native.payload.links[0].operation_id,op.id);
  assert.equal(added(a,b,'stock_file_import_core_witnesses').length,2);assert.equal(added(a,b,'wms_stocktake_lines').length,6);
  const admission=one(added(a,b,'catalog_stock_count_admissions')),receipt=one(added(a,b,'catalog_stock_count_receipts'));
  assert.equal(admission.count_receipt_id,receipt.id);assert.equal(receipt.admission_id,admission.id);
  assert.equal(receipt.stock_file_execution_id,native.id);assert.equal(receipt.inventory_execution_id,null);
  assert.equal(admission.source_id,d.preview.id);assert.equal(admission.protocol,'stock_file');assert.deepEqual(admission.request,d.body);
  assert.equal(admission.sealed,true);assert.equal(admission.actor_id,f.user);assert.equal(admission.api_key_id,null);
  const effect=one(added(a,b,'catalog_stock_control_effects'));assert.equal(effect.admission_id,admission.id);assert.equal(effect.count_receipt_id,receipt.id);
  const witnesses=added(a,b,'catalog_stock_control_effect_journals');assert.equal(witnesses.length,6);
  assert(witnesses.every(r=>r.kind==='layer'&&r.admission_id===admission.id));assert.deepEqual(witnesses.map(r=>r.layer_movement_id).sort(),ids(journals));
  assert.equal(added(a,b,'catalog_stock_count_stock_maps').length,0,'No fabricated net aggregate allocation');
  assert.equal(added(a,b,'catalog_stock_count_bin_maps').length,0,'Signed lot rows need no fabricated net0 bin allocation');
  const documents=added(a,b,'catalog_stock_count_documents'),rows=added(a,b,'catalog_stock_count_rows');assert.equal(documents.length,2);assert.equal(rows.length,6);
  assert.deepEqual(documents.map(doc=>doc.kind).sort(),['PW','RW']);assert.equal(added(a,b,'catalog_stock_control_series').length,2);
  assert.equal(added(a,b,'catalog_stock_control_counters').length,2);
  for(const doc of documents){assert.equal(doc.warehouse_id,f.warehouse.id);assert.equal(doc.receipt_id,receipt.id);
    const series=one(own169(b,'catalog_stock_control_series',f.tenant).filter(s=>s.id===doc.series_id));assert.equal(series.kind,doc.kind);
    assert.equal(doc.number,`${series.prefix}/${doc.year}/${String(doc.sequence).padStart(6,'0')}`);
    const ownRows=rows.filter(r=>r.document_id===doc.id).sort((x,y)=>x.ordinal-y.ordinal);assert.deepEqual(ownRows.map(r=>r.ordinal),[0,1,2]);
    assert(ownRows.every(r=>r.delta===(doc.kind==='PW'?1:-1)&&r.bin_movement_id===null));}
  const layerMaps=added(a,b,'catalog_stock_count_layer_maps'),nativeMaps=added(a,b,'catalog_stock_count_native_maps');assert.equal(layerMaps.length,6);assert.equal(nativeMaps.length,6);
  for(const row of rows){
    const mapping=one(layerMaps.filter(m=>m.row_id===row.id)),journal=one(journals.filter(j=>j.id===mapping.layer_movement_id));
    assert.equal(row.layer_movement_id,journal.id);assert.equal(row.stocktake_posting_id,posting.id);
    const line=one(added(a,b,'wms_stocktake_lines').filter(l=>l.id===row.stocktake_line_id));
    assert.equal(line.stocktake_id,posting.stocktake_id);assert.equal(line.product_id,row.product_id);assert.equal(line.location,row.location);
    assert.equal(mapping.quantity,1);assert.equal(journal.product_id,row.product_id);assert.equal(journal.warehouse_id,row.warehouse_id);
    assert.equal(journal.location,row.location);assert.equal(journal.delta,row.delta);assert.equal(journal.operation_id,op.id);
    const product=one(f.products.filter(p=>p.id===row.product_id)),expectedCost=row.delta<0?product.cost:product.cost??'1000';
    const layer=one(own169(b,'wms_cost_layers',f.tenant).filter(l=>l.id===journal.layer_id));
    assert.equal(layer.unit_cost_minor===null?null:String(layer.unit_cost_minor),expectedCost);assert.equal(mapping.payload.unit_cost_minor,expectedCost);
    assert.equal(mapping.payload.value_minor,expectedCost);assert.equal(mapping.payload.layer_id,layer.id);assert.equal(mapping.payload.lot_id,layer.lot_id);
    assert.equal(journal.value_delta===null?null:String(journal.value_delta),expectedCost===null?null:String(BigInt(expectedCost)*BigInt(row.delta)));
    assert.equal(layer.lot_id,row.delta<0?product.loss.lot_id:product.gain.lot_id);
    const nativeMap=one(nativeMaps.filter(m=>m.row_id===row.id));assert.equal(nativeMap.quantity,1);assert.equal(nativeMap.stock_file_execution_id,native.id);
    assert.equal(row.source_index,nativeMap.source_index);assert.equal(row.payload.layer_movement_id,journal.id);assert.equal(row.payload.line_id,line.id);
    assert.equal(nativeMap.inventory_execution_id,null);const source=one(native.payload.rows.filter((r:Row)=>r.index===nativeMap.source_index));
    assert.equal(source.product_id,row.product_id);assert.equal(source.warehouse_id,row.warehouse_id);assert.equal(source.location,row.location);
    assert.equal(source.lot.id,layer.lot_id);assert.equal(line.lot_id,layer.lot_id);assert.equal(source.line_id,line.id);
    assert.equal(source.input.quantity-source.before.quantity,row.delta);
    const actual=one(op.result.rows.filter((r:Row)=>r.line_id===line.id));assert.equal(actual.product_id,row.product_id);
    assert.equal(actual.location,row.location);assert.equal(actual.lot_id,layer.lot_id);assert.equal(actual.delta,row.delta);
    const fragment=one(actual.fragments);assert.equal(fragment.id,journal.id);assert.equal(fragment.layer_id,layer.id);
    assert.equal(fragment.quantity,1);assert.equal(fragment.delta,row.delta);assert.equal(fragment.unit_cost_minor,expectedCost);
    assert.equal(fragment.value_delta===null?null:String(fragment.value_delta),journal.value_delta===null?null:String(journal.value_delta));
  }
  assert.deepEqual(layerMaps.map(m=>m.layer_movement_id).sort(),ids(journals));
  assert.equal(journals.filter(j=>j.value_delta===null).length,1,'Unknown original shortage stays unknown, never zero');
  assert.equal(journals.filter(j=>j.value_delta!==null&&BigInt(j.value_delta)===0n).length,2,'Known zero exists in both directions');
  for(const [sign,value] of[[1,2000n],[-1,-1000n]] as const)
    assert.equal(journals.filter(j=>Math.sign(j.delta)===sign&&j.value_delta!==null).reduce((n,j)=>n+BigInt(j.value_delta),0n),value);
  const oldPositions=own169(a,'wms_layer_positions',f.tenant),positions=own169(b,'wms_layer_positions',f.tenant);
  for(const old of oldPositions){const p=one(f.products.filter(p=>p.id===old.product_id)),loss=old.layer_id===p.loss.id?1:0;
    const now=one(positions.filter(r=>r.layer_id===old.layer_id));assert.deepEqual(omit(now,['quantity','version']),omit(old,['quantity','version']));
    assert.equal(now.quantity,old.quantity-loss);assert.equal(BigInt(now.version),BigInt(old.version)+BigInt(loss));}
  const oldLayers=new Set(oldPositions.map(p=>p.layer_id)),newPositions=positions.filter(p=>!oldLayers.has(p.layer_id));assert.equal(newPositions.length,3);
  assert(newPositions.every(p=>p.quantity===1&&p.reserved===0&&p.location==='A-01'&&p.warehouse_id===f.warehouse.id));
  for(const p of f.products){const own=positions.filter(r=>r.product_id===p.id);assert.equal(own.reduce((n,r)=>n+r.quantity,0),4);
    assert.equal(own.filter(r=>one(own169(b,'wms_cost_layers',f.tenant).filter(l=>l.id===r.layer_id)).lot_id===p.loss.lot_id).reduce((n,r)=>n+r.quantity,0),1);
    assert.equal(own.filter(r=>one(own169(b,'wms_cost_layers',f.tenant).filter(l=>l.id===r.layer_id)).lot_id===p.gain.lot_id).reduce((n,r)=>n+r.quantity,0),3);}
  const heads=result.execution.stock_count_documents as Row[];assert.equal(heads.length,2);assert.deepEqual(heads.map(h=>h.id).sort(),ids(documents));
  for(const head of heads){assert.equal(head.protocol,'stock_file');assert.equal(head.source_id,d.preview.id);assert.equal(head.warehouse_id,f.warehouse.id);
    const doc=one(documents.filter(x=>x.id===head.id));assert.equal(head.receipt_id,receipt.id);assert.equal(head.kind,doc.kind);
    assert.equal(head.number,doc.number);assert.equal(head.series_id,doc.series_id);assert.equal(head.year,doc.year);assert.equal(head.sequence,String(doc.sequence));
    assert.equal(head.created_at,new Date(doc.payload.created_at).toISOString());assert.equal(doc.payload.quantity,'3');assert.equal(doc.payload.row_count,3);
    assert.equal(head.quantity,'3');assert.equal(head.row_count,3);assert.equal(head.wms_enabled,true);
    assert(!Object.keys(head).some(k=>/cost|value|layer|journal|payload/.test(k)),'Public heads remain quantity only');}
}

for(const format of['csv','xml'] as const)test(`strict ON115 ${format} opposing actual lots in one bin publishes signed PW/RW despite net0, exact0/NULL provenance and replay`,async()=>{
  const f=await fixture(),d=await prepare(f,format),before=await facts169();
  const result=await f.ok(d.path,'POST',d.body,201),accepted=await facts169();assert.equal(result.reused,false);prove(f,d,before,accepted,result);
  const replay=await f.ok(d.path,'POST',d.body,200);assert.equal(replay.reused,true);assert.equal(replay.execution.id,result.execution.id);
  assert.deepEqual(replay.execution.stock_count_documents,result.execution.stock_count_documents);assert.deepEqual(await facts169(),accepted,'No second native or PW/RW writer/replay number');
  const detail=await f.ok('/stock-file-imports/executions/'+result.execution.id);assert.deepEqual(detail.execution.stock_count_documents,result.execution.stock_count_documents);
  const rows=await f.ok('/stock-file-imports/executions/'+result.execution.id+'/rows');assert.equal(rows.rows.length,6);assert.equal(rows.next_cursor,null);
  assert.deepEqual(await facts169(),accepted,'Native history reads preserve every global row/session');
  const altered=await f.request(d.path,'POST',{...d.body,ack_surplus_warehouse_ids:[]});assert.equal(altered.statusCode,409,altered.body);
  assert.deepEqual(await facts169(),accepted,'Different replay consent never changes native or strict graph');
});
