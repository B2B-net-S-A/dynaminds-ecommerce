// SOURCE_AUTHORED_NOT_RUN. Root alone executes actual isolated PG/API fixtures.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { Problem } from '../server/errors';
import { catalogStockCountDocumentList, catalogStockCountDocumentDetail, catalogStockCountQuery,
  catalogStockCountRowsQuery, type CatalogStockCountPublicRow } from '../server/catalog-stock-count-query';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import { stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';
import { seed, DEMO_TENANT } from './fixtures';
import { bootstrap151169, install152169, facts169, own169, consent169, type Row } from './catalog-stock-control169-fixture';
import type { CatalogStockControlActor, CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';

let app:Awaited<ReturnType<typeof buildApp>>,providers=0;
let absent:Awaited<ReturnType<typeof catalogStockCountDocumentList>>;
before(async()=>{await bootstrap151169();await seed();
  const user=(await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id as string;
  const old=await facts169();
  absent=await catalogStockCountDocumentList({tenantId:DEMO_TENANT,userId:user,source:'manual'},{});
  assert.deepEqual(await facts169(),old,'Genuine pre152 absence read has no side effects');
  await install152169();app=await buildApp({
  integrationTransport:async()=>{providers++;throw Error('No COUNT query providers');}});});
after(async()=>{try{await app?.close();assert.equal(providers,0);}finally{await pool.end();}});
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
async function rejects(work:()=>Promise<unknown>,status:number){await assert.rejects(work,(e:unknown)=>e instanceof Problem&&e.status===status);}
const forbidden=new Set(['nonce','proof','frame','request','snapshot','admission_id','actor_id','api_key_id',
  'scope_hash','rows_sha256','input_hash','unit_cost_minor','value_minor','currency','exponent']);
function safe(value:unknown){
  if(Array.isArray(value)){for(const x of value)safe(x);return;}
  if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){assert(!forbidden.has(k),k);safe(v);}
}
async function fixture(on=false) {
  const f=await stocktakeAdjustmentFixture(app,on);
  const catalog=one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[f.tenant])).rows).catalog_id as string;
  const context={writersAvailable:true};
  const {source}=await sourceCatalogStockControl(f.actor,catalog,context);assert.equal(source.ready,true);
  const {preview}=await previewCatalogStockControl(f.actor,catalog,{client_key:randomUUID(),
    catalog_version:source.snapshot.catalog.version,policy_version:source.snapshot.policy.version,
    warehouse_policy_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.series.version})),
  },context);
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),context)).operation.after.strict,true);
  let result:Row;
  if(!on){
    const facts=await facts169(),stocks=own169(facts,'stock',f.tenant),products=own169(facts,'products',f.tenant);
    const rows=f.products.flatMap(p=>['A-01','B-02'].map(location=>({product_id:p.id,
      product_version:one(products.filter(x=>x.id===p.id)).version,
      stock_version:String(one(stocks.filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id)).version),
      location,operation:'count',quantity:location==='A-01'?1:3})));
    const prepared=await f.ok('/inventory-bulk-edit/previews','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,
      note:'Real COUNT quantity query fixture',rows},201);assert.equal(prepared.preview.ready,true);
    result=await f.ok('/inventory-bulk-edit/previews/'+prepared.preview.id+'/execute','POST',consent169(prepared.preview),201);
  }else{
    const facts=await facts169(),positions=own169(facts,'wms_layer_positions',f.tenant),layers=own169(facts,'wms_cost_layers',f.tenant);
    const lot=(id:string,location:string)=>one(layers.filter(l=>l.id===one(positions.filter(p=>p.product_id===id&&p.location===location)).layer_id)).lot_id;
    const content='SKU;Q;LOT;LOC;COST;CUR\n'+f.products.flatMap(p=>[
      `${p.sku};1;${lot(p.id,'A-01')};A-01;;`,`${p.sku};3;${lot(p.id,'B-02')};B-02;${p.cost??'1000'};PLN`]).join('\n');
    const prepared=await f.ok('/stock-file-imports/previews','POST',{client_key:randomUUID(),file_name:'count-query169.csv',
      note:'Real ON0/1000/NULL query fixture',content,definition:{format:'csv',xml_mode:'positions',delimiter:';',
        identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'},
      targets:[{warehouse_id:f.warehouse.id,quantity_scope:'position',default_location:'A-01',
        mapping:{quantity:'Q',location:'LOC',lot_id:'LOT',unit_cost_minor:'COST',currency:'CUR'}}],resolutions:[]},201);
    assert.equal(prepared.preview.summary.invalid,0);assert.equal(prepared.preview.summary.conflicts,0);
    result=await f.ok('/stock-file-imports/previews/'+prepared.preview.id+'/execute','POST',{
      ...consent169(prepared.preview),ack_unknown_loss_warehouse_ids:[f.warehouse.id],ack_surplus_warehouse_ids:[f.warehouse.id]},201);
  }
  const documents=result.execution.stock_count_documents as Row[];assert.equal(documents.length,2);
  return{...f,result,documents};
}
async function full(a:CatalogStockControlActor,id:string) {
  const rows:CatalogStockCountPublicRow[]=[];let cursor:string|undefined;
  do{const reply=await catalogStockCountDocumentDetail(a,id,{limit:1,...(cursor?{cursor}:{})});
    assert.equal(reply.can_read_value,false);assert.equal(reply.value_state,'not_projected');safe(reply);
    assert.equal(reply.meta.total,3);rows.push(...reply.data);cursor=reply.meta.cursor??undefined;
  }while(cursor);
  assert.deepEqual(rows.map(r=>r.ordinal),[0,1,2]);return rows;
}

test('strict list and rows query refuse malformed IDs, bounds and unknown fields',()=>{
  for(const q of [{limit:0},{limit:51},{warehouse_id:'bad'},{protocol:'fake'},{other:true}])assert.equal(catalogStockCountQuery.safeParse(q).success,false);
  assert.equal(catalogStockCountRowsQuery.safeParse({cursor:'!',limit:1}).success,false);
});

test('genuine historical module absence is explicitly neutral, without backfill',()=>{
  assert.equal(absent.available,false);assert.equal(absent.can_read_value,false);
  assert.equal(absent.value_state,'not_projected');assert.deepEqual(absent.data,[]);assert.equal(absent.meta.cursor,null);
});

test('real086 frozen heads tie paging and full rows preserve global read purity',async()=>{
  const f=await fixture(),before=await facts169();
  const first=await catalogStockCountDocumentList(f.actor,{limit:1});assert.equal(first.data.length,1);assert(first.meta.cursor);
  const second=await catalogStockCountDocumentList(f.actor,{limit:1,cursor:first.meta.cursor});assert.equal(second.meta.cursor,null);
  assert.notEqual(first.data[0].id,second.data[0].id);assert.equal(first.data[0].created_at,second.data[0].created_at);
  assert.deepEqual([first.data[0].id,second.data[0].id].sort(),f.documents.map(d=>d.id).sort());
  const selected=await catalogStockCountDocumentList(f.actor,{protocol:'inventory_bulk',execution_id:f.result.execution.id,warehouse_id:f.warehouse.id,kind:'PW'});
  assert.equal(selected.data.length,1);assert.equal(selected.data[0].quantity,'3');assert.equal(selected.data[0].row_count,3);
  const rows=await full(f.actor,selected.data[0].id);assert(rows.every(r=>r.delta===1&&r.bin_movement_id!==null&&r.layer_movement_id===null));
  const privateRows=own169(before,'catalog_stock_count_rows',f.tenant).filter(r=>r.document_id===selected.data[0].id).sort((a,b)=>a.ordinal-b.ordinal);
  assert.deepEqual(rows.map(r=>({id:r.id,delta:r.delta,product_id:r.product_id,bin:r.bin_movement_id})),privateRows.map(r=>({id:r.id,delta:r.delta,product_id:r.product_id,bin:r.bin_movement_id})));
  safe(first);safe(second);assert.deepEqual(await facts169(),before,'Every global row/session unchanged by all reads');
});

test('foreign identities and cursor actor/filter/tamper reuse are refused',async()=>{
  const f=await fixture(),other=await fixture(),before=await facts169();
  const first=await catalogStockCountDocumentList(f.actor,{limit:1});assert(first.meta.cursor);
  await rejects(()=>catalogStockCountDocumentDetail(other.actor,f.documents[0].id),404);
  await rejects(()=>catalogStockCountDocumentList(f.actor,{warehouse_id:other.warehouse.id}),404);
  await rejects(()=>catalogStockCountDocumentList(other.actor,{limit:1,cursor:first.meta.cursor!}),409);
  await rejects(()=>catalogStockCountDocumentList(f.actor,{limit:2,cursor:first.meta.cursor!}),409);
  await rejects(()=>catalogStockCountDocumentList(f.actor,{limit:1,cursor:first.meta.cursor!.slice(0,-2)+'xx'}),422);
  await rejects(()=>catalogStockCountDocumentList(f.actor,{execution_id:other.result.execution.id}),404);
  const rowPage=await catalogStockCountDocumentDetail(f.actor,f.documents[0].id,{limit:1});assert(rowPage.meta.cursor);
  await rejects(()=>catalogStockCountDocumentDetail(f.actor,f.documents[1].id,{limit:1,cursor:rowPage.meta.cursor!}),409);
  assert.deepEqual(await facts169(),before);
});

test('viewer and quantity API key read frozen rows; missing read scope and revocation deny',async()=>{
  const f=await fixture();
  const key=await f.ok('/developer/keys','POST',{name:'COUNT quantity query',scopes:['products:read','inventory:read']},201);
  const bad=await f.ok('/developer/keys','POST',{name:'COUNT incomplete reader',scopes:['products:read']},201);
  const actor={...f.actor,apiKeyId:key.id,source:'api' as const},before=await facts169();
  assert.equal((await catalogStockCountDocumentList(actor,{})).data.length,2);
  await full(actor,f.documents[0].id);
  await rejects(()=>catalogStockCountDocumentList({...actor,apiKeyId:bad.id},{}),403);
  assert.deepEqual(await facts169(),before);
  await pool.query("UPDATE memberships SET role='viewer' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);
  try{const v=await catalogStockCountDocumentDetail({...f.actor,role:'viewer'},f.documents[0].id);assert.equal(v.current_role,'viewer');safe(v);}
  finally{await pool.query("UPDATE memberships SET role='admin' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);}
  await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id]);
  const revoked=await facts169();await rejects(()=>catalogStockCountDocumentList(actor,{}),401);assert.deepEqual(await facts169(),revoked);
});

test('real115 ON signed layer rows retain private0/NULL without exposing value fields',async()=>{
  const f=await fixture(true),before=await facts169(),list=await catalogStockCountDocumentList(f.actor,{protocol:'stock_file'});
  assert.equal(list.data.length,2);const rw=one(list.data.filter(d=>d.kind==='RW'));
  const rows=await full(f.actor,rw.id);assert(rows.every(r=>r.delta===-1&&r.bin_movement_id===null&&r.layer_movement_id&&r.stocktake_line_id&&r.stocktake_posting_id));
  const frozen=own169(before,'catalog_stock_count_rows',f.tenant).filter(r=>r.document_id===rw.id);
  assert.equal(frozen.length,3);assert.deepEqual(frozen.map(r=>r.payload.unit_cost_minor).sort(),[null,'0','1000'].sort());
  assert.deepEqual(rows.map(r=>r.id).sort(),frozen.map(r=>r.id).sort());safe(list);assert.deepEqual(await facts169(),before);
});

test('missing private manifest is503 without read-side repair or row changes',async()=>{
  const f=await fixture();
  await pool.query('ALTER TABLE catalog_stock_count_manifest RENAME TO catalog_stock_count_manifest_query_hidden');
  try{const before=await facts169();await rejects(()=>catalogStockCountDocumentList(f.actor,{}),503);assert.deepEqual(await facts169(),before);}
  finally{await pool.query('ALTER TABLE catalog_stock_count_manifest_query_hidden RENAME TO catalog_stock_count_manifest');}
});
