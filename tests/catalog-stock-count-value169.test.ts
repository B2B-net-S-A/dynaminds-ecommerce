// SOURCE_AUTHORED_NOT_RUN. Root alone executes this isolated actual PG/API suite.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { Problem } from '../server/errors';
import { catalogStockCountDocumentDetail, catalogStockCountDocumentValue, catalogStockCountDocumentExport,
  catalogStockCountValueRowsQuery, catalogStockCountExportQuery } from '../server/catalog-stock-count-query';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { adjustmentActor, stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';
import { bootstrap151169, install152169, facts169, own169, consent169, wait169, type Row } from './catalog-stock-control169-fixture';
import { seed } from './fixtures';

let app:Awaited<ReturnType<typeof buildApp>>,providers=0;
const base='/catalog-stock-control/count-documents';
before(async()=>{await bootstrap151169();await seed();await install152169();
  app=await buildApp({integrationTransport:async()=>{providers++;throw Error('COUNT value suite forbids providers');}});});
after(async()=>{try{await app?.close();assert.equal(providers,0);}finally{await pool.end();}});
const one=(xs:Row[])=>{assert.equal(xs.length,1);return xs[0];};
async function deny(work:()=>Promise<unknown>,status:number){await assert.rejects(work,(e:unknown)=>e instanceof Problem&&e.status===status);}
async function activate(f:Awaited<ReturnType<typeof adjustmentActor>>) {
  const catalog=one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[f.tenant])).rows).catalog_id as string;
  const ctx={writersAvailable:true}; // Test-only genuine consent, no public capability change.
  const {source}=await sourceCatalogStockControl(f.actor,catalog,ctx);assert.equal(source.ready,true);
  const {preview}=await previewCatalogStockControl(f.actor,catalog,{client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,
    policy_version:source.snapshot.policy.version,
    warehouse_policy_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.series.version}))},ctx);
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),ctx)).operation.after.strict,true);
}
async function fixture(on=false) {
  const f=await stocktakeAdjustmentFixture(app,on);await activate(f);let result:Row;
  const facts=await facts169();
  if(!on) {
    const stocks=own169(facts,'stock',f.tenant),products=own169(facts,'products',f.tenant);
    const rows=f.products.flatMap(p=>['A-01','B-02'].map(location=>({product_id:p.id,
      product_version:one(products.filter(x=>x.id===p.id)).version,
      stock_version:String(one(stocks.filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id)).version),
      location,operation:'count',quantity:location==='A-01'?1:3})));
    const p=(await f.ok('/inventory-bulk-edit/previews','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,note:'COUNT value OFF',rows},201)).preview;
    assert.equal(p.ready,true);result=await f.ok('/inventory-bulk-edit/previews/'+p.id+'/execute','POST',consent169(p),201);
  } else {
    const positions=own169(facts,'wms_layer_positions',f.tenant),layers=own169(facts,'wms_cost_layers',f.tenant);
    const lot=(id:string,loc:string)=>one(layers.filter(l=>l.id===one(positions.filter(x=>x.product_id===id&&x.location===loc)).layer_id)).lot_id;
    const content='SKU;Q;LOT;LOC;COST;CUR\n'+f.products.flatMap(p=>[
      `${p.sku};1;${lot(p.id,'A-01')};A-01;;`,`${p.sku};3;${lot(p.id,'B-02')};B-02;${p.cost??'1000'};PLN`]).join('\n');
    const p=(await f.ok('/stock-file-imports/previews','POST',{client_key:randomUUID(),file_name:'count-value169.csv',note:'COUNT frozen0/NULL',content,
      definition:{format:'csv',xml_mode:'positions',delimiter:';',identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'},
      targets:[{warehouse_id:f.warehouse.id,quantity_scope:'position',default_location:'A-01',
        mapping:{quantity:'Q',location:'LOC',lot_id:'LOT',unit_cost_minor:'COST',currency:'CUR'}}],resolutions:[]},201)).preview;
    assert.equal(p.summary.invalid,0);assert.equal(p.summary.conflicts,0);
    result=await f.ok('/stock-file-imports/previews/'+p.id+'/execute','POST',{...consent169(p),
      ack_unknown_loss_warehouse_ids:[f.warehouse.id],ack_surplus_warehouse_ids:[f.warehouse.id]},201);
  }
  const docs=result.execution.stock_count_documents as Row[];assert.equal(docs.length,2);
  return{...f,docs,rw:one(docs.filter(d=>d.kind==='RW')),pw:one(docs.filter(d=>d.kind==='PW'))};
}
function noPrivate(v:unknown,money=false) {
  const forbidden=['nonce','proof','frame','request','snapshot','admission_id','actor_id','api_key_id','scope_hash','rows_sha256','input_hash',
    ...(money?['unit_cost_minor','value_minor','currency','exponent','cost_state','valuation']:[])];
  if(Array.isArray(v))for(const x of v)noPrivate(x,money);
  else if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){assert(!forbidden.includes(k),k);noPrivate(x,money);}
}
function csv(content:string) {
  const records:string[][]=[],row:string[]=[];let cell='',quoted=false;
  for(let i=0;i<content.length;i++){const c=content[i];if(quoted){if(c==='"'){if(content[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=c;}
    else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\r'&&content[i+1]==='\n'){row.push(cell);records.push([...row]);row.length=0;cell='';i++;}else cell+=c;}
  assert.equal(quoted,false);assert.equal(cell,'');assert.equal(row.length,0);
  const columns=records.shift()!;return records.map(r=>{assert.equal(r.length,columns.length);return Object.fromEntries(columns.map((c,i)=>[c,r[i]]));});
}
function xmlRows(content:string) {
  const p=new SaxesParser(),rows:Record<string,string|null>[]=[],stack:string[]=[];let row:Record<string,string|null>|null=null;
  p.on('opentag',n=>{stack.push(n.name);if(n.name==='row')row={};else if(row&&stack.at(-2)==='row')row[n.name]=n.attributes.nil==='true'?null:'';});
  p.on('text',text=>{if(row&&stack.at(-2)==='row'&&row[stack.at(-1)!]!==null)row[stack.at(-1)!]+=text;});
  p.on('closetag',()=>{if(stack.at(-1)==='row'){rows.push(row!);row=null;}stack.pop();});
  p.on('error',e=>{throw e;});p.write(content).close();return rows;
}

test('value/export schemas strictly parse literal false, bounds and unknown fields',()=>{
  assert.equal(catalogStockCountExportQuery.parse({format:'csv',include_values:'false'}).include_values,false);
  assert.equal(catalogStockCountExportQuery.parse({format:'xml'}).include_values,false);
  for(const q of [{format:'pdf'},{format:'csv',include_values:true},{format:'csv',other:'x'}])assert.equal(catalogStockCountExportQuery.safeParse(q).success,false);
  for(const q of [{limit:51},{limit:0},{cursor:'!'},{other:1}])assert.equal(catalogStockCountValueRowsQuery.safeParse(q).success,false);
});
test('OFF explicit authorized value is unavailable, both complete exports invent no costs',async()=>{
  const f=await fixture(),before=await facts169(),v=await catalogStockCountDocumentValue(f.actor,f.rw.id,{limit:1});
  assert.equal(v.can_read_value,true);assert.deepEqual(v.valuation,{state:'unavailable_off',physical_quantity:'3',buckets:[]});
  noPrivate(v.data,true);
  for(const format of ['csv','xml'])for(const include_values of ['true','false']){
    const x=await catalogStockCountDocumentExport(f.actor,f.rw.id,{format,include_values});assert.equal(x.values_included,false);
    assert.equal(x.value_state,'unavailable_off');assert.equal(x.row_count,3);noPrivate(x,true);
    assert(!/unit_cost_minor|value_minor|currency|exponent|cost_state/.test(x.content));
  }
  assert.deepEqual(await facts169(),before,'Every table, counter and session literal unchanged');
});
test('ON frozen zero and NULL full value pages preserve signed native journals and all rows',async()=>{
  const f=await fixture(true),before=await facts169(),rows:Row[]=[];let cursor:string|undefined,summary:unknown;
  do{const v=await catalogStockCountDocumentValue(f.actor,f.rw.id,{limit:1,...(cursor?{cursor}:{})});
    if(summary)assert.deepEqual(v.valuation,summary);summary=v.valuation;noPrivate(v);
    rows.push(...v.data);cursor=v.meta.cursor??undefined;
  }while(cursor);
  assert.deepEqual(rows.map(r=>r.ordinal),[0,1,2]);assert.deepEqual(rows.map(r=>r.unit_cost_minor).sort(),[null,'0','1000'].sort());
  assert.deepEqual(summary,{state:'partial_unknown',physical_quantity:'3',buckets:[{currency:'PLN',exponent:2,
    known_quantity:'2',zero_cost_quantity:'1',unknown_quantity:'1',known_value_minor:'1000',signed_known_value_minor:'-1000'}]});
  const frozen=own169(before,'catalog_stock_count_rows',f.tenant).filter(r=>r.document_id===f.rw.id).sort((a,b)=>a.ordinal-b.ordinal);
  for(const[i,r]of rows.entries()){assert.equal(r.id,frozen[i].id);assert.equal(r.unit_cost_minor,frozen[i].payload.unit_cost_minor);
    const j=one(own169(before,'wms_layer_movements',f.tenant).filter(j=>j.id===r.layer_movement_id));assert.equal(j.delta,r.delta);
    assert.equal(j.value_delta===null?null:String(j.value_delta),r.value_minor===null?null:(-BigInt(r.value_minor)).toString());}
  assert.deepEqual(await facts169(),before);
});
test('value cursor is separate and refuses foreign actor, document, limit and tamper',async()=>{
  const f=await fixture(true),other=await fixture(),before=await facts169();
  const v=await catalogStockCountDocumentValue(f.actor,f.rw.id,{limit:1});assert(v.meta.cursor);
  const q=await catalogStockCountDocumentDetail(f.actor,f.rw.id,{limit:1});assert(q.meta.cursor);
  await deny(()=>catalogStockCountDocumentValue(f.actor,f.rw.id,{limit:1,cursor:q.meta.cursor!}),422);
  await deny(()=>catalogStockCountDocumentDetail(f.actor,f.rw.id,{limit:1,cursor:v.meta.cursor!}),422);
  await deny(()=>catalogStockCountDocumentValue(other.actor,f.rw.id,{limit:1,cursor:v.meta.cursor!}),409);
  await deny(()=>catalogStockCountDocumentValue(other.actor,f.rw.id,{}),404);
  await deny(()=>catalogStockCountDocumentValue(f.actor,f.pw.id,{limit:1,cursor:v.meta.cursor!}),409);
  await deny(()=>catalogStockCountDocumentValue(f.actor,f.rw.id,{limit:2,cursor:v.meta.cursor!}),409);
  await deny(()=>catalogStockCountDocumentValue(f.actor,f.rw.id,{limit:1,cursor:v.meta.cursor!.slice(0,-2)+'xx'}),422);
  assert.deepEqual(await facts169(),before);
});
test('normal/v1 full CSV/XML reproduce frozen values; false removes monetary content and keys',async()=>{
  const f=await fixture(true),key=await f.ok('/developer/keys','POST',{name:'COUNT actual value',scopes:['products:read','inventory:read','purchasing:read']},201);
  const before=await facts169(),frozen=own169(before,'catalog_stock_count_rows',f.tenant).filter(r=>r.document_id===f.rw.id).sort((a,b)=>a.ordinal-b.ordinal);
  for(const format of ['csv','xml']){
    const normal=await f.ok(base+'/'+f.rw.id+'/export?format='+format+'&include_values=true');
    const versioned=await f.ok(base+'/'+f.rw.id+'/export?format='+format+'&include_values=true','GET',undefined,200,key);
    assert.equal(normal.content,versioned.content);assert.equal(normal.values_included,true);noPrivate(normal);
    const rows=format==='csv'?csv(normal.content).filter(r=>r.record_type==='row'):xmlRows(normal.content);assert.equal(rows.length,3);
    for(const[i,r]of rows.entries()){assert.equal(r.product_id,frozen[i].product_id);assert.equal(r.delta,String(frozen[i].delta));
      assert.equal(r.unit_cost_minor,frozen[i].payload.unit_cost_minor===null?(format==='csv'?'':null):frozen[i].payload.unit_cost_minor);
      assert.equal(r.value_minor,frozen[i].payload.value_minor===null?(format==='csv'?'':null):frozen[i].payload.value_minor);
      assert.equal(r.currency,'PLN');assert.equal(r.exponent,'2');}
    const hidden=await f.ok(base+'/'+f.rw.id+'/export?format='+format+'&include_values=false','GET',undefined,200,key);
    assert.equal(hidden.values_included,false);assert.equal(hidden.value_state,'not_requested');noPrivate(hidden,true);
    assert(!/unit_cost_minor|value_minor|currency|exponent|cost_state/.test(hidden.content));
  }
  assert.deepEqual(await facts169(),before);
});
test('quantity keys and normal viewers retain quantity exports but cannot explicitly request values',async()=>{
  const f=await fixture(true),key=await f.ok('/developer/keys','POST',{name:'COUNT only quantities',scopes:['products:read','inventory:read']},201);
  const before=await facts169();
  assert.equal((await f.request(base+'/'+f.rw.id+'/value','GET',undefined,key)).statusCode,403);
  assert.equal((await f.request(base+'/'+f.rw.id+'/export?format=csv&include_values=true','GET',undefined,key)).statusCode,403);
  const hidden=await f.ok(base+'/'+f.rw.id+'/export?format=xml&include_values=false','GET',undefined,200,key);assert.equal(hidden.can_read_value,false);noPrivate(hidden,true);
  assert.deepEqual(await facts169(),before);
  await pool.query("UPDATE memberships SET role='viewer' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);
  try{const viewer=await facts169();assert.equal((await f.request(base+'/'+f.rw.id+'/value')).statusCode,403);
    assert.equal((await f.request(base+'/'+f.rw.id+'/export?format=csv&include_values=false')).statusCode,200);assert.deepEqual(await facts169(),viewer);}
  finally{await pool.query("UPDATE memberships SET role='admin' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);}
});
test('101 genuine native fragments all appear in value pages and complete CSV/XML, without DB writes',async()=>{
  const tenant=randomUUID();await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'COUNT101 actual value','enterprise')",[tenant]);
  const f=await adjustmentActor(app,tenant),wh=await f.ok('/warehouses','POST',{name:'COUNT101 warehouse',code:'C101-'+randomUUID().slice(0,8)});
  const products:Row[]=[],opening:Row[]=[];
  for(let i=0;i<101;i++){
    const cost=["0","1000",null][i%3],p=await f.ok('/products','POST',{name:'Frozen101 '+i,sku:'COUNT101-'+randomUUID(),price:1501,vat:23,warehouse_id:wh.id,quantity:1,location:'A-01'},201);
    const stock=one((await pool.query('SELECT version FROM stock WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3)',[tenant,wh.id,p.id])).rows);
    products.push(p);opening.push({product_id:p.id,warehouse_id:wh.id,location:'A-01',quantity:1,stock_version:String(stock.version),lot_code:'COUNT101-'+randomUUID(),unit_cost_minor:cost});
  }
  const op=(await f.ok('/wms-lots/opening-previews','POST',{client_key:randomUUID(),policy_version:'0',currency:'PLN',note:'101 native cost witnesses',lines:opening},201)).preview;
  assert.equal(op.ready,true);await f.ok('/wms-lots/opening-previews/'+op.id+'/activate','POST',{client_key:randomUUID(),scope_hash:op.scope_hash,confirmed:true,ack_unknown_costs:true},201);
  await activate(f);
  const facts=await facts169(),layers=own169(facts,'wms_cost_layers',tenant),positions=own169(facts,'wms_layer_positions',tenant);
  const content='SKU;Q;LOT;LOC\n'+products.map(p=>`${p.sku};0;${one(layers.filter(l=>l.id===one(positions.filter(x=>x.product_id===p.id)).layer_id)).lot_id};A-01`).join('\n');
  const p=(await f.ok('/stock-file-imports/previews','POST',{client_key:randomUUID(),file_name:'101-value.csv',note:'101 true signed losses',content,
    definition:{format:'csv',xml_mode:'positions',delimiter:';',identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'},
    targets:[{warehouse_id:wh.id,quantity_scope:'position',default_location:'A-01',mapping:{quantity:'Q',location:'LOC',lot_id:'LOT'}}],resolutions:[]},201)).preview;
  assert.equal(p.summary.invalid,0);assert.equal(p.summary.conflicts,0);
  // Bounded server-error diagnostic for this own disposable fixture only. Never
  // retain request objects, headers, credentials, error stacks or PG details.
  const originalLog=app.log.error,messages:string[]=[];
  const failures:{sql_prefix:string;code:string|null;where:string|null}[]=[],originalConnect=pool.connect;
  const wrapped=new Set<PoolClient>(),restoreQueries:(()=>void)[]=[];
  const wrap=(client:PoolClient)=>{
    if(wrapped.has(client))return;wrapped.add(client);const originalQuery=client.query;
    client.query=(function(this:PoolClient,...args:any[]){
      const sql=typeof args[0]==='string'?args[0]:typeof args[0]?.text==='string'?args[0].text:'';
      const capture=(e:unknown)=>{if(e&&typeof e==='object'){
        const error=e as {code?:unknown;where?:unknown};failures.push({sql_prefix:sql.replace(/\s+/g,' ').slice(0,120),
          code:typeof error.code==='string'?error.code:null,where:typeof error.where==='string'?error.where.slice(0,2000):null});
      }};
      // Keep pg's callback overload intact, including pool.query's callback.
      const last=args.length-1;if(typeof args[last]==='function'){
        const callback=args[last];args[last]=function(this:unknown,error:unknown,...rest:unknown[]){if(error)capture(error);return callback.apply(this,[error,...rest]);};
      }
      const result=(originalQuery as any).apply(this,args);
      if(result&&typeof result.then==='function')return result.catch((e:unknown)=>{capture(e);throw e;});return result;
    }) as typeof originalQuery;
    restoreQueries.push(()=>{client.query=originalQuery;});
  };
  pool.connect=(function(this:typeof pool,...args:any[]){
    if(typeof args[0]==='function'){
      const callback=args[0];return(originalConnect as any).call(this,(error:unknown,client:PoolClient,release:unknown)=>{
        if(client)wrap(client);return callback(error,client,release);
      });
    }
    return(originalConnect as any).apply(this,args).then((client:PoolClient)=>{wrap(client);return client;});
  }) as typeof originalConnect;
  app.log.error=((...args:unknown[])=>{
    const event=args[0];if(event&&typeof event==='object'&&'message' in event&&typeof event.message==='string')messages.push(event.message.slice(0,300));
  }) as typeof originalLog;
  let result:Row;
  try {
    const reply=await f.request('/stock-file-imports/previews/'+p.id+'/execute','POST',{...consent169(p),ack_unknown_loss_warehouse_ids:[wh.id],ack_surplus_warehouse_ids:[]});
    assert.equal(reply.statusCode,201,JSON.stringify({stage:'COUNT_101_NATIVE_EXECUTION',status:reply.statusCode,server_messages:messages,sql_failures:failures}));
    result=reply.json();
  } finally {app.log.error=originalLog;pool.connect=originalConnect;for(const restore of restoreQueries)restore();}
  const doc=one(result.execution.stock_count_documents);assert.equal(doc.row_count,101);assert.equal(doc.quantity,'101');
  const before=await facts169();let cursor:string|undefined;const rows:Row[]=[];
  do{const v=await catalogStockCountDocumentValue(f.actor,doc.id,{limit:50,...(cursor?{cursor}:{})});rows.push(...v.data);cursor=v.meta.cursor??undefined;
    assert.deepEqual(v.valuation,{state:'partial_unknown',physical_quantity:'101',buckets:[{currency:'PLN',exponent:2,known_quantity:'68',zero_cost_quantity:'34',unknown_quantity:'33',known_value_minor:'34000',signed_known_value_minor:'-34000'}]});
  }while(cursor);assert.equal(rows.length,101);assert.deepEqual(rows.map(r=>r.ordinal),Array.from({length:101},(_,i)=>i));
  const frozen=own169(before,'catalog_stock_count_rows',tenant).filter(r=>r.document_id===doc.id).sort((a,b)=>a.ordinal-b.ordinal);
  assert.deepEqual(rows.map(r=>r.id),frozen.map(r=>r.id));
  for(const format of ['csv','xml']){const x=await catalogStockCountDocumentExport(f.actor,doc.id,{format,include_values:'true'});
    const parsed=format==='csv'?csv(x.content).filter(r=>r.record_type==='row'):xmlRows(x.content);assert.equal(parsed.length,101);
    assert.deepEqual(parsed.map(r=>r.product_id),frozen.map(r=>r.product_id));assert.equal(x.row_count,101);}
  assert.deepEqual(await facts169(),before,'ALL global rows/sessions/counters immutable after full101 reads');
});
test('observed final native API key PIN denies late purchasing scope loss, revocation and expiry before any export bytes',async()=>{
  const f=await fixture(true);
  for(const mode of ['scope','revoke','expire']){
    const key=await f.ok('/developer/keys','POST',{name:'COUNT held '+mode,scopes:['products:read','inventory:read','purchasing:read']},201);
    const holder=await pool.connect();let pending:ReturnType<typeof f.request>|undefined;
    try{
      await holder.query('BEGIN');const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
      await holder.query('SELECT id FROM api_keys WHERE(tenant_id,id)=($1,$2) FOR UPDATE',[f.tenant,key.id]);
      let settled=false;pending=f.request(base+'/'+f.rw.id+'/export?format=csv&include_values=true','GET',undefined,key);pending.then(()=>{settled=true;},()=>{settled=true;});
      await wait169(pid,/stock_file_import_access/);assert.equal(settled,false,'No earlier data/bytes before terminal native PIN');
      if(mode==='scope')await holder.query("UPDATE api_keys SET scopes=ARRAY['products:read','inventory:read']::text[] WHERE(tenant_id,id)=($1,$2)",[f.tenant,key.id]);
      else if(mode==='revoke')await holder.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id]);
      else await holder.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE(tenant_id,id)=($1,$2)",[f.tenant,key.id]);
      await holder.query('COMMIT');const before=await facts169(),res=await pending;
      assert.equal(res.statusCode,mode==='scope'?403:401);assert(!res.body.includes('record_type'));assert(!res.body.includes('unit_cost_minor'));
      assert.deepEqual(await facts169(),before,'Denied read performs no writes or session changes');
    }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();if(pending)await pending;}
  }
});
test('observed final membership PIN denies late admin demotion and preserves every frozen row',async()=>{
  const f=await fixture(true),holder=await pool.connect();let pending:ReturnType<typeof f.request>|undefined;
  try{
    await holder.query('BEGIN');const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
    await holder.query('SELECT role FROM memberships WHERE(tenant_id,user_id)=($1,$2) FOR UPDATE',[f.tenant,f.user]);
    pending=f.request(base+'/'+f.rw.id+'/value?limit=1');await wait169(pid,/stock_file_import_access/);
    await holder.query("UPDATE memberships SET role='viewer' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);await holder.query('COMMIT');
    const before=await facts169(),reply=await pending;assert.equal(reply.statusCode,403);assert(!reply.body.includes('unit_cost_minor'));
    assert.deepEqual(await facts169(),before);
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();if(pending)await pending;
    await pool.query("UPDATE memberships SET role='admin' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);}
});
