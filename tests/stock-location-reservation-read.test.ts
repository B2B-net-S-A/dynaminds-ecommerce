/** Actual registered route with controlled transaction/transport ports.
 * Returned rows are fixed independent examples, never calculated by inspecting
 * SQL. PostgreSQL arithmetic/cast parity requires Root's separate VALUES probe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Fastify from 'fastify';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import {ensure, Problem} from '../server/errors';
import {productNotDeletedSQL} from '../server/product-deletions';

const id=(n:number)=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),foreignTenant=id(2),warehouse=id(10),foreignWarehouse=id(11),product=id(20);
const route='/api/stock-locations';
const compiled=transformSync(readFileSync(new URL('../server/stock-location-routes.ts',import.meta.url),'utf8'),{
  loader:'ts',format:'cjs',target:'es2022',
}).code;
type ReadRow={tenant_id:string;warehouse_id:string;product_id:string;location:string;quantity:number;
  sku:string;name:string;version:string;reserved:number;available:number};
const row=(values:Partial<ReadRow>={}):ReadRow=>({tenant_id:tenant,warehouse_id:warehouse,product_id:product,
  location:'A-01',quantity:8,sku:'PARCEL-SKU',name:'Partial parcel',version:'2',reserved:3,available:5,...values});

async function fixture(options:{tenant?:string;rows?:ReadRow[];fail?:Error}={}){
  const app=Fastify({logger:false});
  const selectedTenant=options.tenant??tenant;
  const transactions:{tenant:string;queries:{text:string;values:any[]}[];outcome:string;closed:boolean}[]=[];
  let writeCalls=0;
  async function readTx(t:string,work:any){
    const tx={tenant:t,queries:[] as {text:string;values:any[]}[],outcome:'open',closed:false};transactions.push(tx);
    const client={query:async(text:string,values:any[]=[])=>{
      tx.queries.push({text,values:structuredClone(values)});
      if(text==='SELECT id FROM warehouses WHERE id=$1'){
        const owns=t===tenant?values[0]===warehouse:values[0]===foreignWarehouse;
        return{rows:owns?[{id:values[0]}]:[],rowCount:owns?1:0};
      }
      assert(text.startsWith('SELECT l.*,p.sku,p.name,s.version,'),'Unexpected read query');
      if(options.fail)throw options.fail;
      // A controlled DB response, not an interpreter or mirror of the SQL.
      const rows=structuredClone(options.rows??[row()]);
      return{rows,rowCount:rows.length};
    }};
    try{const result=await work(client);tx.outcome='commit';return result;}
    catch(error){tx.outcome='rollback';throw error;}
    finally{tx.closed=true;}
  }
  const module={exports:{} as any};
  new Function('module','require',compiled)(module,(key:string)=>{
    if(key==='zod')return{z};
    if(key==='./errors')return{ensure};
    // Controlled 225 capability: a copy with product_deletions225, no extra statement.
    if(key==='./product-deletions')return{productDeletionsAvailable:async()=>true,productNotDeletedSQL};
    if(key==='./db')return{tenantTx:async()=>{writeCalls++;throw Error('Unexpected write transaction');}};
    if(key==='./stock-locations')return{locationMove:z.any(),locationCount:z.any(),locationOperation:async()=>{
      writeCalls++;throw Error('Unexpected stock mutation');
    }};
    throw Error('Unexpected route dependency '+key);
  });
  app.addHook('onRequest',async req=>{(req as any).actor={tenantId:selectedTenant,userId:id(3),role:'viewer'};});
  app.setErrorHandler((error:any,_req,reply)=>{
    reply.code(error instanceof Problem?error.status:error instanceof z.ZodError?422:500).send({error:error.message});
  });
  module.exports.registerStockLocationRoutes(app,readTx);
  await app.ready();
  return{app,transactions,get writeCalls(){return writeCalls;},
    get:(query:Record<string,string>={})=>app.inject({method:'GET',url:route+'?'+new URLSearchParams({warehouse_id:warehouse,...query})}),
  };
}

/** Root may import this to bind its independent real PostgreSQL VALUES probe.
 * Captures SQL emitted by the actual handler; it does not run that SQL.
 */
export async function captureStockLocationReservationReadSql(){
  const f=await fixture({rows:[]});
  try{
    const response=await f.get({product_id:product});assert.equal(response.statusCode,200);
    const statements=f.transactions.flatMap(t=>t.queries);
    assert.equal(statements.length,2);
    return{schema:'dynaminds-stock-location-reservation-read-query/v1',
      warehouse_query:statements[0],locations_query:statements[1],
      fixtures:{tenant,warehouse,product,location:'A-01'},
      counterexample:{physical_before:10,reserved_original:5,parcel_shipped:2,
        physical_after:8,parent_state:'active',expected_reserved:3,expected_available:5},
      legacy_case:{consumed_quantity_column_present:false,physical_quantity:10,
        active_quantity:5,expected_reserved:5,expected_available:5},
      SQL_executed:false,network_requests:0};
  }finally{await f.app.close();}
}

test('registered GET preserves a partial-parcel remaining-reservation DTO through a read transaction',async()=>{
  const f=await fixture();
  try{
    const response=await f.get({product_id:product});assert.equal(response.statusCode,200);
    assert.deepEqual(response.json(),{data:[row()],meta:{cursor:null}});
    assert.equal(f.transactions.length,1);assert.equal(f.transactions[0].tenant,tenant);
    assert.equal(f.transactions[0].outcome,'commit');assert.equal(f.transactions[0].closed,true);
    assert.equal(f.writeCalls,0);
  }finally{await f.app.close();}
});

test('captured actual query uses the backward-compatible remaining active hold and exact bin correlation',async()=>{
  const captured=await captureStockLocationReservationReadSql(),sql=captured.locations_query.text;
  // SQL contract assertion supplements transport tests. It is not PG execution.
  assert(sql.includes("sum(a.quantity-coalesce((to_jsonb(a)->>'consumed_quantity')::integer,0)) AS quantity"));
  assert(sql.includes("r.state='active'"));
  assert(sql.includes('(a.tenant_id,a.warehouse_id,a.product_id,a.location)=(l.tenant_id,l.warehouse_id,l.product_id,l.location)'));
  assert(sql.includes('(l.quantity-coalesce(h.quantity,0))::int AS available'));
  assert(sql.includes(productNotDeletedSQL(true)),'a deleted product (225) leaves the bin list');
  assert.deepEqual(captured.locations_query.values,[warehouse,product,'',null,null,26]);
  assert.equal(captured.SQL_executed,false);
});

test('filters and tuple cursor are bound unchanged and the 25+1 page uses the final visible bin',async()=>{
  const rows=Array.from({length:26},(_,n)=>row({location:`A-${String(n).padStart(2,'0')}`}));
  const f=await fixture({rows});
  try{
    const after=Buffer.from(JSON.stringify([product,'A-before'])).toString('base64url');
    const response=await f.get({product_id:product,q:'PARCEL',limit:'25',after});assert.equal(response.statusCode,200);
    assert.deepEqual(response.json().data,rows.slice(0,25));
    assert.deepEqual(JSON.parse(Buffer.from(response.json().meta.cursor,'base64url').toString()),[product,'A-24']);
    assert.deepEqual(f.transactions[0].queries[1].values,[warehouse,product,'PARCEL',product,'A-before',26]);
    assert.equal(f.writeCalls,0);
  }finally{await f.app.close();}
});

test('viewer read keeps all stock quantity fields, including zero remaining holds',async()=>{
  const data=[row({quantity:5,reserved:0,available:5}),row({product_id:id(21),location:'B-02',quantity:10,reserved:5,available:5})];
  const f=await fixture({rows:data});
  try{
    const response=await f.get();assert.equal(response.statusCode,200);
    assert.deepEqual(response.json().data,data);assert.equal(f.writeCalls,0);
  }finally{await f.app.close();}
});

test('foreign warehouse refuses before location projection and uses the current tenant port',async()=>{
  const f=await fixture({tenant:foreignTenant});
  try{
    const response=await f.get();assert.equal(response.statusCode,404);
    assert.equal(f.transactions[0].tenant,foreignTenant);assert.equal(f.transactions[0].queries.length,1);
    assert.equal(f.transactions[0].outcome,'rollback');assert.equal(f.transactions[0].closed,true);
    assert.equal(f.writeCalls,0);
  }finally{await f.app.close();}
});

test('malformed cursor never executes the location aggregate',async()=>{
  const f=await fixture();
  try{
    const response=await f.get({after:'not-a-json-tuple'});assert.equal(response.statusCode,422);
    assert.equal(f.transactions[0].queries.length,1);assert.equal(f.transactions[0].outcome,'rollback');
    assert.equal(f.transactions[0].closed,true);assert.equal(f.writeCalls,0);
  }finally{await f.app.close();}
});

test('projection failure propagates and closes the read transaction without falling back to a write',async()=>{
  const f=await fixture({fail:Error('controlled projection failure')});
  try{
    const response=await f.get();assert.equal(response.statusCode,500);
    assert.equal(f.transactions[0].outcome,'rollback');assert.equal(f.transactions[0].closed,true);
    assert.equal(f.writeCalls,0);
  }finally{await f.app.close();}
});
