// SOURCE_AUTHORED_NOT_RUN. Real native086 sources and managed terminal SQL.
// Root owns execution in a fresh numeric scratch DB. No fake grant, enlistment,
// physical SQL fixture, manifest rewrite or synthetic successful SQL response.
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {buildApp} from '../server/app';
import {pool} from '../server/db';
import {seed} from './fixtures';
import {adjustmentActor,stocktakeAdjustmentFixture} from './stocktake-adjustments-fixture';
import {sourceCatalogStockControl,previewCatalogStockControl,commitCatalogStockControl} from '../server/catalog-stock-control';
import type {CatalogStockControlWarehouse} from '../server/catalog-stock-control-schema';
import {bootstrap151169,install152169,facts169,own169,consent169,physicalExact169,type Row} from './catalog-stock-control169-fixture';

let app:Awaited<ReturnType<typeof buildApp>>,providerCalls=0;
const options={integrationTransport:async()=>{providerCalls++;throw Error('Terminal COUNT fixture forbids provider transport');}};
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
type Fixture=Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>;
type Prepared=Awaited<ReturnType<typeof prepare>>;
let historical:Fixture,historicalSource:Prepared,historicalResult:Row;
before(async()=>{
  await bootstrap151169();await seed();app=await buildApp(options);
  historical=await stocktakeAdjustmentFixture(app,false);historicalSource=await prepare(historical);
  historicalResult=await historical.ok(historicalSource.path,'POST',historicalSource.body,201);
  assert.equal((await pool.query("SELECT to_regclass('public.catalog_stock_count_receipts') r")).rows[0].r,null);
  // HTTP module capabilities are fixed at startup. Restart this own app after
  // installing152, and bind requests to it while preserving the original
  // historical execution, preview, request body and authenticated staff actor.
  await app.close();await install152169();app=await buildApp(options);
  historical={...historical,...await adjustmentActor(app,historical.tenant)};
  assert((await pool.query("SELECT to_regprocedure('public.catalog_stock_count_terminal_require()') r")).rows[0].r);
});
after(async()=>{try{assert.equal(providerCalls,0);await app?.close();}finally{await pool.end();}});

async function activate(f:Fixture){
  const catalog=one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[f.tenant])).rows).catalog_id as string;
  const publicSource=await f.ok('/catalog-stock-control/catalogs/'+catalog+'/source');
  assert.equal(publicSource.writers_available,false);assert.equal(publicSource.activation_available,false);
  const beforeRows=await facts169(),context={writersAvailable:true};
  const {source}=await sourceCatalogStockControl(f.actor,catalog,context);
  assert.equal(source.ready,true,JSON.stringify(source.blockers));
  const {preview}=await previewCatalogStockControl(f.actor,catalog,{
    client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,policy_version:source.snapshot.policy.version,
    warehouse_policy_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.series.version})),
  },context);
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),context)).operation.after.strict,true);
  physicalExact169(beforeRows,await facts169());
}
async function prepare(f:Fixture,pureMoves=false){
  const beforeRows=await facts169(),p=f.products[0],product=one(own169(beforeRows,'products',f.tenant).filter(r=>r.id===p.id)),
    stock=one(own169(beforeRows,'stock',f.tenant).filter(r=>r.product_id===p.id&&r.warehouse_id===f.warehouse.id));
  const basis={product_id:p.id,product_version:product.version,stock_version:String(stock.version)};
  const rows=pureMoves?[
    {...basis,operation:'move',location:'A-01',destination:'B-02',quantity:1},
    {...basis,operation:'move',location:'B-02',destination:'A-01',quantity:1},
  ]:[{...basis,operation:'count',location:'A-01',quantity:1}];
  const {preview}=await f.ok('/inventory-bulk-edit/previews','POST',{
    client_key:randomUUID(),warehouse_id:f.warehouse.id,note:'Genuine managed COUNT terminal source',rows,
  },201);
  assert.equal(preview.ready,true);assert.equal(preview.changed,rows.length);
  physicalExact169(beforeRows,await facts169());
  return{preview,body:consent169(preview),path:'/inventory-bulk-edit/previews/'+preview.id+'/execute'};
}
type SqlEvent={sql:string;args:any[];result:Row};
// Observe the real Promise response without replacing any permission result.
function observe(work:(event:SqlEvent)=>void|Promise<void>){
  const original=Client.prototype.query;
  Client.prototype.query=function(this:Client,...args:any[]){
    const result=(original as any).apply(this,args),sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    return typeof sql==='string'&&result?.then?result.then(async(reply:Row)=>{await work({sql,args,result:reply});return reply;}):result;
  } as typeof Client.prototype.query;
  return()=>{Client.prototype.query=original;};
}
async function replayTerminal(f:Fixture,d:Prepared,result:Row,expectedHeads:number){
  const baseline=await facts169();let nullPrepare=0,terminal=0,batch=0;
  const restore=observe(e=>{
    if(e.sql.startsWith('SELECT public.catalog_stock_count_prepare(')){
      const source=JSON.parse(e.args[1][2]);if(source.source_id===d.preview.id){assert.equal(e.result.rows[0].admission,null);nullPrepare++;}
    }
    if(e.sql.trim()==='SELECT public.catalog_stock_count_terminal_require()')terminal++;
    if(e.sql.includes('FROM jsonb_to_recordset($1::jsonb)')&&e.sql.includes('key_scopes')){
      const actor=one(e.result.rows.filter((r:Row)=>r.tenant_id===f.tenant&&r.user_id===f.user));
      assert.equal(actor.role,'admin');assert.equal(actor.key_id,null);batch++;
    }
  });
  try{
    const replay=await f.ok(d.path,'POST',d.body,200);
    assert.equal(replay.reused,true);assert.equal(replay.execution.id,result.execution.id);
    assert.equal(replay.execution.stock_count_documents.length,expectedHeads);
    assert.deepEqual(replay.execution.stock_count_documents,result.execution.stock_count_documents??[]);
    assert.equal(nullPrepare,1,'Actual historical/saved COUNT prepare returned NULL, not a fake token');
    assert.equal(terminal,1,'NULL/replay keeps exactly one full schema terminal obligation');
    assert.equal(batch,1,'The real managed final current-state batch is still reached');
    assert.deepEqual(await facts169(),baseline,'Exact all-table global/session/number/physical purity on replay');
  }finally{restore();}
}

test('genuine pre152 native086 historical replay under strict BO retains NULL terminal obligation without backfill',async()=>{
  await activate(historical);await replayTerminal(historical,historicalSource,historicalResult,0);
  const cap=await facts169();
  for(const table of ['catalog_stock_count_admissions','catalog_stock_count_receipts','catalog_stock_count_documents','catalog_stock_count_rows'])
    assert.deepEqual(own169(cap,table,historical.tenant),[],'No historical publisher backfill '+table);
});
test('exact saved169 native086 replay keeps fresh terminal schema and final batch after NULL prepare, without a second number',async()=>{
  const f=await stocktakeAdjustmentFixture(app,false);await activate(f);const d=await prepare(f);
  const result=await f.ok(d.path,'POST',d.body,201);assert.equal(result.execution.stock_count_documents.length,1);
  await replayTerminal(f,d,result,1);
});
test('pure real086 moves with zero PW/RW heads still refuse actual metadata damage at the final schema gate and roll back everything',async()=>{
  const f=await stocktakeAdjustmentFixture(app,false);await activate(f);const d=await prepare(f,true),baseline=await facts169();
  const helper='public.catalog_stock_count_statement_guard()',acl=one((await pool.query('SELECT to_jsonb(p) metadata FROM pg_proc p WHERE oid=$1::regprocedure',[helper])).rows).metadata;
  let finished=false,terminalReached=false,damaged=false;
  const original=Client.prototype.query;
  Client.prototype.query=function(this:Client,...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(typeof sql==='string'&&sql.trim()==='SELECT public.catalog_stock_count_terminal_require()'){
      assert.equal(finished,true,'The real native parent and zero-head COUNT receipt completed before the final gate');
      assert.equal(terminalReached,false);terminalReached=true;
      // Change real metadata using a separate owner connection, at the precise
      // terminal boundary. No fake SQL result or invented IAM waiter is used.
      return pool.query('GRANT EXECUTE ON FUNCTION '+helper+' TO dyna_app').then(()=>{
        damaged=true;return(original as any).apply(this,args);
      });
    }
    const reply=(original as any).apply(this,args);
    if(typeof sql==='string'&&sql.startsWith('SELECT public.catalog_stock_count_finish(')&&reply?.then)
      return reply.then((result:Row)=>{
        assert.equal(typeof result.rows[0].receipt.receipt_id,'string');assert.match(result.rows[0].receipt.receipt_id,/^[a-f0-9-]{36}$/);
        assert.deepEqual(result.rows[0].receipt.documents,[]);finished=true;return result;
      });
    return reply;
  } as typeof Client.prototype.query;
  try{
    const response=await f.request(d.path,'POST',d.body);assert.equal(response.statusCode,503,response.body);
    assert.equal(finished,true);assert.equal(terminalReached,true);assert.equal(damaged,true);
    assert.deepEqual(await facts169(),baseline,'Zero numbered heads cannot skip the final schema refusal/whole rollback');
  }finally{
    Client.prototype.query=original;
    await pool.query('REVOKE EXECUTE ON FUNCTION '+helper+' FROM dyna_app');
  }
  assert.deepEqual(one((await pool.query('SELECT to_jsonb(p) metadata FROM pg_proc p WHERE oid=$1::regprocedure',[helper])).rows).metadata,acl);
  assert.deepEqual(await facts169(),baseline,'Literal original metadata ACL and every table restored, not re-based');
});

// Deliberately not a multi-actor expiry PASS: native086 and115 pin each actual
// writer's key within its own workflow. A second sequential native body can
// wait there before existing catalog finalization, so its refusal would not
// establish the new after-all-siblings final-clock boundary. The capacity suite
// independently observes real final-batch expiry after successful native SQL.
// A later sibling-only actor must come from a real supported production source;
// this suite does not inject enlistment/extra grants merely to manufacture it.
