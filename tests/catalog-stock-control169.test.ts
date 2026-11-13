import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { bootstrap151169,install152169,fixture169,prepare169,allRows169,facts169,physicalExact169,raw169,own169,integer169,sort169,prefix169,consent169,type Row,type Facts,type Fixture169 } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Missing real writer certification deliberately fails
// these business tests: availability flags alone cannot stand in for BO/cycle.
let app:Awaited<ReturnType<typeof buildApp>>,providerCalls=0;
const transport=async()=>{providerCalls++;throw Error('No providers in local catalog-control proof');};
let migrationBefore:Facts,migrationAfter:Facts;
before(async()=>{
  await bootstrap151169(); await seed(); app=await buildApp({integrationTransport:transport});
  await fixture169(app,true); // Authentic nonempty stock/bins/layers and both catalog pools before152.
  await app.close(); migrationBefore=await facts169(); await install152169(); migrationAfter=await facts169();
  app=await buildApp({integrationTransport:transport});
});
after(async()=>{try{assert.equal(providerCalls,0);await app?.close();}finally{await pool.end();}});

test('152 migration retains every nonempty151 global physical/commercial/session row; no historical BO',async()=>{
  for(const [name,old] of Object.entries(migrationBefore)) {
    const now=name==='migrations'?migrationAfter[name].filter(r=>r.row.name!=='152_catalog_stock_control'):migrationAfter[name];
    assert.deepEqual(now,old,'No old-row update/backfill: '+name);
  }
  assert.equal(raw169(migrationAfter,'migrations').filter(r=>r.name==='152_catalog_stock_control').length,1);
  physicalExact169(migrationBefore,migrationAfter);
  const newNames=Object.keys(migrationAfter).filter(n=>!Object.hasOwn(migrationBefore,n));
  // The sealed 152 SQL: 14 control tables (with catalog_stock_control_xid_claims), 8 return, 10 count, 3 legacy group.
  assert.equal(newNames.length,35);
  assert.equal(newNames.filter(n=>n.startsWith('catalog_stock_control_')).length,14);
  assert.equal(newNames.filter(n=>n.startsWith('catalog_stock_return_')).length,8);
  assert.equal(newNames.filter(n=>n.startsWith('catalog_stock_count_')).length,10);
  assert.equal(newNames.filter(n=>n.startsWith('catalog_stock_legacy_group_')).length,3);
  assert(newNames.every(n=>n.startsWith('catalog_stock_control_')||n.startsWith('catalog_stock_return_')||n.startsWith('catalog_stock_count_')||n.startsWith('catalog_stock_legacy_group_')));
  for(const n of newNames) assert.equal(migrationAfter[n].length,n.endsWith('_manifest')?1:0,'No BO for historic activity: '+n);
  assert(raw169(migrationBefore,'wms_cost_layers').some(l=>l.unit_cost_minor===null));
});

function rowScope(rows:Row[],f:Fixture169) {
  for(const r of rows) {
    assert(f.products.some(p=>p.id===r.product_id),'Own selected catalog pool only');
    assert(f.warehouses.some(w=>w.id===r.warehouse_id));
    assert.notEqual(r.product_id,f.other.id); assert.equal(r.location,'A-01');
    assert.equal(Number.isSafeInteger(r.quantity),true); assert(r.quantity>=0);
  }
}
async function activated(f:Fixture169) {
  const p=await prepare169(f),before=await facts169();
  const previewRows=await allRows169(f,prefix169+'/previews/'+p.preview.id+'/rows'); rowScope(previewRows,f);
  assert.equal(previewRows.length,p.preview.row_count); assert.equal(previewRows.length,p.source.snapshot.row_count);
  const r=await f.ok(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit,201),op=r.operation;
  assert(op); assert.equal(op.catalog_id,f.primary.id); assert.equal(op.preview_id,p.preview.id); assert.equal(op.client_key,p.commit.client_key);
  assert.equal(op.before.strict,false); assert.equal(op.after.strict,true); assert.equal(integer169(op.after.version),integer169(op.before.version)+1n);
  assert.equal(op.after.operation_id,op.id); assert.deepEqual(op.snapshot,p.preview.snapshot);
  const after=await facts169(); physicalExact169(before,after);
  assert.equal(op.documents.length,f.warehouses.length,'A frozen BO for each assigned WH, including physical zero');
  const documentRows:Row[]=[];
  for(const doc of op.documents) {
    assert.equal(doc.kind,'BO'); assert.equal(doc.operation_id,op.id); assert.equal(doc.catalog_id,f.primary.id);
    assert(f.warehouses.some(w=>w.id===doc.warehouse.id)); assert.equal(doc.sequence,'1');
    assert(doc.number.endsWith('/'+doc.year+'/000001')); assert.equal(doc.year,new Date(doc.created_at).getUTCFullYear());
    const detail=await f.ok(prefix169+'/documents/'+doc.id); assert.deepEqual(detail.document,doc);
    const rows=await allRows169(f,prefix169+'/documents/'+doc.id+'/rows');
    assert.equal(rows.length,doc.row_count); assert(rows.every(x=>x.warehouse_id===doc.warehouse.id));
    assert.equal(rows.reduce((n,x)=>n+BigInt(x.quantity),0n),integer169(doc.summary.physical_quantity));
    documentRows.push(...rows);
  }
  for(const r of documentRows) assert.deepEqual(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='ordinal'&&k!=='source_ordinal')),Object.fromEntries(Object.entries(previewRows[r.source_ordinal]).filter(([k])=>k!=='ordinal')),'Document local ordinal resolves exact global approved row');
  assert.deepEqual(documentRows.map(r=>r.source_ordinal).sort((a:number,b:number)=>a-b),previewRows.map(r=>r.ordinal).sort((a:number,b:number)=>a-b),'Each global row is present exactly once across WH BO documents');
  const readAfter=await facts169(); assert.deepEqual(readAfter,after,'Detail and all pages are pure reads');
  const replay=await f.ok(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit);
  assert.equal(replay.reused,true); assert.deepEqual(replay.operation,op); assert.deepEqual(await facts169(),after,'Replay creates no number, evidence or physical movement');
  return {p,op,rows:previewRows,before,after};
}

test('OFF existing5 BO preserves bins/stock/version/journals and excludes other catalog7 on same WH',async()=>{
  const f=await fixture169(app),a=await activated(f);
  assert.equal(a.rows.length,1); assert.equal(a.rows[0].quantity,5); assert.equal(a.rows[0].reserved,0);
  assert.equal(a.rows[0].layer_id,null); assert.equal(a.rows[0].lot_id,null); assert.equal(a.rows[0].position_version,null);
  assert.equal(a.op.snapshot.wms_enabled,false); assert.equal(a.op.snapshot.summary.physical_quantity,'5');
  for(const r of a.rows) for(const k of ['unit_cost_minor','value_minor','currency','exponent']) assert.equal(Object.hasOwn(r,k),false,'OFF does not manufacture cost: '+k);
  assert.equal(own169(a.after,'stock',f.tenant).find(r=>r.product_id===f.other.id&&r.warehouse_id===f.warehouse.id)?.on_hand,7);
});
test('ON BO binds preexisting actual layer/lot/position with known0/1000/NULL; never creates second opening',async()=>{
  const f=await fixture169(app,true),a=await activated(f);
  assert.equal(a.rows.length,3); assert.equal(a.op.snapshot.wms_enabled,true);
  assert.equal(a.op.snapshot.summary.physical_quantity,'15'); assert.equal(a.op.snapshot.summary.known_quantity,'10');
  assert.equal(a.op.snapshot.summary.zero_cost_quantity,'5'); assert.equal(a.op.snapshot.summary.unknown_quantity,'5'); assert.equal(a.op.snapshot.summary.known_value_minor,'5000');
  for(const r of a.rows) {
    const product=f.products.find(p=>p.id===r.product_id)!;
    const layer=own169(a.before,'wms_cost_layers',f.tenant).find(l=>l.id===r.layer_id);assert(layer);
    const position=own169(a.before,'wms_layer_positions',f.tenant).find(p=>p.layer_id===r.layer_id&&p.warehouse_id===r.warehouse_id&&p.location===r.location);assert(position);
    assert.equal(r.lot_id,layer.lot_id); assert.equal(r.unit_cost_minor,product.cost); assert.equal(r.unit_cost_minor,layer.unit_cost_minor===null?null:String(layer.unit_cost_minor));
    assert.equal(r.position_version,String(position.version)); assert.equal(r.quantity,position.quantity);
    assert.equal(r.value_minor,product.cost===null?null:String(BigInt(product.cost)*5n));
  }
});
test('BO0 is a real numbered immutable zero balance, never NOP physical writes or fake valued stock',async()=>{
  const f=await fixture169(app,false,0),a=await activated(f);
  assert.equal(a.op.snapshot.summary.physical_quantity,'0');assert.equal(a.rows.length,0);
  assert(a.op.documents.length>0);assert(a.op.documents.every((d:Row)=>d.summary.physical_quantity==='0'));
});
test('activation preview CAS rejects actual supported receipt drift, then fresh preview snapshots updated balance',async()=>{
  const f=await fixture169(app),p=await prepare169(f);
  const d=await f.ok('/warehouse-documents','POST',{kind:'receipt',warehouse_id:f.warehouse.id,lines:[{product_id:f.products[0].id,quantity:2,location:'A-01'}],reference:'Real receipt between BO preview and consent',note:''},201);
  await f.ok('/warehouse-documents/'+d.id+'/post','POST',{version:d.version});
  const before=await facts169();assert.equal((await f.request(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit)).statusCode,409);
  assert.deepEqual(await facts169(),before,'Failed consent preserves exact graph and no BO/counter');
  const a=await activated(f);assert.equal(a.op.snapshot.summary.physical_quantity,'7');
});
test('changed consent body/key or different preview cannot replay an existing BO operation',async()=>{
  const f=await fixture169(app),a=await activated(f),before=await facts169();
  for(const b of [{...a.p.commit,scope_hash:'0'.repeat(64)},{...a.p.commit,client_key:randomUUID()}])
    assert.equal((await f.request(prefix169+'/previews/'+a.p.preview.id+'/commit','POST',b)).statusCode,409);
  assert.deepEqual(await facts169(),before);
});

test('two catalog BOs on two shared WH allocate distinct consecutive system numbers and retain each own pool',async()=>{
  const f=await fixture169(app),a=await activated(f),p=await prepare169(f,f.secondary),before=await facts169();
  const rows=await allRows169(f,prefix169+'/previews/'+p.preview.id+'/rows');
  assert.equal(rows.length,1);assert.equal(rows[0].product_id,f.other.id);assert.equal(rows[0].quantity,7);
  const second=(await f.ok(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit,201)).operation;
  assert.equal(second.catalog_id,f.secondary.id);assert.equal(second.documents.length,2);assert.equal(second.snapshot.summary.physical_quantity,'7');
  for(const d of second.documents){const original=a.op.documents.find((x:Row)=>x.warehouse.id===d.warehouse.id);assert(original);assert.equal(d.series_id,original.series_id);assert.equal(d.sequence,'2');assert.notEqual(d.number,original.number);}
  physicalExact169(before,await facts169());
  assert.deepEqual((await f.ok(prefix169+'/operations/'+a.op.id)).operation,a.op,'Later BO does not rewrite first frozen receipt');
});

test('101 authentic selected catalog products produce every full BO page and complete documents without truncation',async()=>{
  const f=await fixture169(app);
  for(let i=0;i<100;i++)f.products.push(await f.ok('/products','POST',{catalog_id:f.primary.id,name:'Own full BO row '+i,sku:'FULL169-'+randomUUID(),price:1,vat:23,warehouse_id:f.warehouse.id,quantity:1,location:'A-01'},201));
  const a=await activated(f);assert.equal(a.rows.length,101);assert.equal(a.op.snapshot.summary.physical_quantity,'105');
  const first=await f.ok(prefix169+'/previews/'+a.p.preview.id+'/rows?limit=100');assert.equal(first.data.length,100);assert.equal(first.meta.cursor,100);assert.equal(first.meta.total,101);
  const last=await f.ok(prefix169+'/previews/'+a.p.preview.id+'/rows?limit=100&cursor=100');assert.equal(last.data.length,1);assert.equal(last.meta.cursor,null);
  assert.deepEqual([...first.data,...last.data],a.rows);
});

for(const on of [false,true]) test(`${on?'ON':'OFF'} strict catalog genuine PZ→MM→WZ→PW/RW retains one physical writer and actual document provenance`,async()=>{
  const f=await fixture169(app,on);
  if(!on) f.products.push(await f.ok('/products','POST',{catalog_id:f.primary.id,name:'Own second counted169',sku:'COUNT169-'+randomUUID(),price:1501,vat:23,warehouse_id:f.warehouse.id,quantity:5,location:'A-01'},201));
  await activated(f);const before=await facts169(),product=f.products[0];
  const create=async(kind:string,warehouse:string,quantity:number,destination?:string)=>{
    if(on) {
      const stockVersion=async(warehouse_id:string)=>({warehouse_id,product_id:product.id,version:String((await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',[f.tenant,warehouse_id,product.id])).rows[0]?.version??0)});
      let result:Row;
      if(kind==='receipt')result=await f.ok('/wms-lots/receipts','POST',{client_key:randomUUID(),policy_version:'1',warehouse_id:warehouse,stock_versions:[await stockVersion(warehouse)],lines:[{product_id:product.id,location:'A-01',quantity,lot_code:'Strict PZ169-'+randomUUID(),unit_cost_minor:'0',currency:'PLN'}],note:'Genuine supported ON PZ169',confirmed:true},201);
      else {
        const p=(await f.ok('/wms-lots/movement-previews','POST',{client_key:randomUUID(),policy_version:'1',kind,product_id:product.id,warehouse_id:warehouse,location:'A-01',quantity,...(destination?{destination_warehouse_id:destination,destination_location:'A-01'}:{}),stock_versions:await Promise.all([warehouse,...(destination?[destination]:[])].map(stockVersion)),note:'Genuine supported ON '+kind+'169'},201)).preview;
        assert.equal(p.ready,true);const b=consent169(p);
        result=await f.ok('/wms-lots/movement-previews/'+p.id+'/execute','POST',b,201);
        const saved=await facts169();const replay=await f.ok('/wms-lots/movement-previews/'+p.id+'/execute','POST',b);
        assert.equal(replay.reused,true);assert.deepEqual(replay.operation,result.operation);assert.deepEqual(await facts169(),saved,'Same WMS execution replay creates no second movement or number');
      }
      assert(result.operation?.warehouse_document_id,'Actual WMS operation must have its real parent document');
      const d=await f.ok('/warehouse-documents/'+result.operation.warehouse_document_id);assert.equal(d.status,'posted');return d;
    }
    const line:Row={product_id:product.id,quantity,location:'A-01'};
    const d=await f.ok('/warehouse-documents','POST',{kind,warehouse_id:warehouse,...(destination?{destination_id:destination}:{}),lines:[line],reference:'Strict actual cycle169',note:''},201);
    await f.ok('/warehouse-documents/'+d.id+'/post','POST',{version:d.version});return d;
  };
  const pz=await create('receipt',f.warehouse.id,2);
  const mm=await create('transfer',f.warehouse.id,3,f.warehouses[1].id);
  const wz=await create('issue',f.warehouses[1].id,2);
  const after=await facts169();
  const stock=own169(after,'stock',f.tenant);
  assert.equal(stock.find(s=>s.product_id===product.id&&s.warehouse_id===f.warehouse.id)?.on_hand,4);
  assert.equal(stock.find(s=>s.product_id===product.id&&s.warehouse_id===f.warehouses[1].id)?.on_hand,1);
  const oldIds=new Set(raw169(before,'stock_movements').map(r=>r.id));
  const movement=own169(after,'stock_movements',f.tenant).filter(r=>!oldIds.has(r.id));
  assert.equal(movement.length,4,'PZ one, MM exact pair, WZ one: no second decrement');
  for(const d of [pz,mm,wz]) assert(movement.some(r=>r.warehouse_document_id===d.id));
  assert.equal(movement.reduce((n,r)=>n+BigInt(r.delta),0n),0n,'+2 PZ -2 WZ; MM conserves global quantity');
  assert.equal(own169(after,'stock',f.tenant).find(s=>s.product_id===f.other.id&&s.warehouse_id===f.warehouse.id)?.on_hand,7);
  // Genuine counting/review and ordinary separate PW/RW consent after the cycle.
  const path=on?'/wms-lots/stocktakes':'/stocktakes';
  const born=await f.ok(path,'POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,name:'Strict real PW/RW count169',blind:false,...(on?{policy_version:'1'}:{})},on?201:200);
  const h=on?born.stocktake:born,detail=await f.ok(path+'/'+h.id+(on?'/lines':'')),lines:Row[]=on?detail.data:detail.lines;
  const selected=lines.find(l=>l.product_id===product.id);assert(selected);
  const measured=lines.map(l=>({id:l.id,version:String(l.version),...(on?{basis_token:l.basis_token}:{expected_stock_version:String(l.current_stock_version)}),quantity:Number(l.current_quantity)+(l.id===selected.id?1:-1)}));
  assert(measured.every(l=>l.quantity>=0));
  await f.ok(path+'/'+h.id+'/counts','POST',{client_key:randomUUID(),note:'Actual bins both positive/negative',lines:measured},on?201:200);
  const current=await f.ok(path+'/'+h.id);let review:Row;
  if(on) review=(await f.ok(path+'/'+h.id+'/reviews','POST',{client_key:randomUUID(),version:String(current.stocktake.version),note:'Real review169',surplus:[{line_id:selected.id,unit_cost_minor:'0',currency:'PLN'}]},201)).review;
  else review=await f.ok(path+'/'+h.id+'/review','POST',{version:String(current.version)});
  const series:Record<string,Row>={};for(const kind of ['PW','RW']) series[kind]=(await f.ok('/stocktake-adjustments/series','POST',{client_key:randomUUID(),kind,name:'Strict '+kind,prefix:kind+'169'+randomUUID().slice(0,6).toUpperCase()},201)).series;
  const preview=(await f.ok('/stocktake-adjustments/previews','POST',{client_key:randomUUID(),source_kind:on?'wms':'quantity',stocktake_id:h.id,version:on?String(review.stocktake_version):String(review.version),...(on?{review_id:review.id,scope_hash:review.scope_hash}:{review_hash:review.review_hash}),pw_series_id:series.PW.id,...(lines.length>1?{rw_series_id:series.RW.id}:{})},201)).preview;
  const result=await f.ok('/stocktake-adjustments/previews/'+preview.id+'/post','POST',consent169(preview),201);
  assert(result.documents.some((d:Row)=>d.kind==='PW'));
  if(lines.length>1) assert(result.documents.some((d:Row)=>d.kind==='RW'));
  if(on){assert.equal(result.receipt.snapshot.summary.known_pw_minor,'0');assert.equal(result.receipt.snapshot.summary.known_rw_minor,'1000');assert.equal(result.receipt.snapshot.summary.unknown_rw_quantity,'1');}
  const final=await facts169();assert.equal(own169(final,'stock',f.tenant).find(s=>s.product_id===f.other.id&&s.warehouse_id===f.warehouse.id)?.on_hand,7);
  const pure=await facts169();await f.ok(prefix169+'/catalogs/'+f.primary.id+'/source');assert.deepEqual(await facts169(),pure);
});
