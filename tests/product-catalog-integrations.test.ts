import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../server/app';
import {migrate,pool,tenantTx} from '../server/db';
import {encrypt} from '../server/security';
import {processCatalogSource} from '../server/catalog-source';
import {processSupplierRead} from '../server/supplier-catalog';
import type {IntegrationContext} from '../server/channel-access';
import {seed} from './fixtures';
import {productCatalogFixture,productCatalogFacts,productCatalogCreate,productCatalogConsent} from './product-catalogs-fixture';

// Root runs only on the disposable native database. Provider HTTP below is explicitly simulated.
assert.equal(process.env.DYNA_TEST,'true');
const db=new URL(process.env.DATABASE_URL??'');
assert(['127.0.0.1','localhost','[::1]'].includes(db.hostname));
assert.match(db.pathname,/^\/dynaminds_test_\d+$/);
let app:Awaited<ReturnType<typeof buildApp>>;
before(async()=>{await migrate();await seed();app=await buildApp({integrationTransport:async()=>{throw Error('Unconfigured provider transport is forbidden in catalog integration tests');}});});
after(async()=>{try{await app?.close();}finally{await pool.end();}});

async function independentCatalog(f:any){
 const p=(await f.ok('/product-catalogs/previews','POST',productCatalogCreate(f),201)).preview;
 return(await f.ok('/product-catalogs/previews/'+p.id+'/commit','POST',productCatalogConsent(p),201)).catalog;
}
const remote=(id:number,extra:Record<string,unknown>={})=>({id,type:'simple',sku:'SOURCE-'+randomUUID(),name:'Controlled provider position '+id,status:'publish',regular_price:'12.34',tax_status:'taxable',tax_class:'',manage_stock:true,stock_quantity:5,attributes:[],images:[],...extra});
async function claimOwn(tenant:string,id:string,kind:string){
 const rows=(await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$4,locked_at=now() WHERE(tenant_id,id,kind)=($1,$2,$3) AND state='pending' RETURNING *",[tenant,id,kind,randomUUID()])).rows;
 assert.equal(rows.length,1,'Exactly the selected own pending job must be claimed');return rows[0];
}
async function wooRead(f:any,products:any[],variants:Record<string,any[]>={}){
 const channel=randomUUID();
 // Explicit synthetic connection metadata, like catalog-source.test.ts; no DNS or socket is opened.
 // The ordinary start/read/apply engines and their persisted jobs are used below.
 await tenantTx(f.tenant,c=>c.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Controlled catalog provider HTTP','sandbox',$3,$4)",[channel,f.tenant,encrypt({consumer_key:'test-only',consumer_secret:'test-only'}),JSON.stringify({store_url:'https://shop.example',simulation:false})]));
 const calls:{method:string;path:string}[]=[];
 const ctx:IntegrationContext={transport:async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'https://shop.example');assert.equal(init.method??'GET','GET');calls.push({method:init.method??'GET',path:u.pathname});
  let value:unknown;
  if(u.pathname.includes('/settings/general/'))value={value:'PLN'};
  else if(u.pathname.includes('/settings/tax/'))value={value:'yes'};
  else{
   assert.equal(u.searchParams.get('orderby'),'id');assert.equal(u.searchParams.get('order'),'asc');
   const m=u.pathname.match(/\/products\/(\d+)\/variations$/);assert(m||u.pathname.endsWith('/products'),'Unexpected controlled WooCommerce endpoint');
   value=Number(u.searchParams.get('page')??1)===1?(m?(variants[m[1]]??[]):products):[];
  }
  return new Response(JSON.stringify(value),{status:200});
 }};
 let run=await f.ok('/integrations/'+channel+'/catalog-source-runs','POST',{client_key:randomUUID(),warehouse_id:f.spare.id,vat:23,import_stock:false});
 for(let n=0;run.state==='queued'&&n<6;n++){
  await processCatalogSource(await claimOwn(f.tenant,run.job_id,'catalog.fetch'),ctx);
  run=(await pool.query('SELECT * FROM catalog_source_runs WHERE(tenant_id,id)=($1,$2)',[f.tenant,run.id])).rows[0];
 }
 assert.equal(run.state,'ready');assert(calls.length>0&&calls.every(c=>c.method==='GET'));
 const view=await f.ok('/catalog-source-runs/'+run.id+'?limit=100');
 assert.equal(view.data.length,products.length+Object.values(variants).reduce((n,a)=>n+a.length,0));
 return {run,rows:view.data,calls};
}
const applyItem=(r:any,catalogId?:string)=>({id:r.id,source_hash:r.source_hash,expected_product_id:r.candidate_id??null,expected_version:r.candidate_version??null,...(catalogId?{catalog_id:catalogId}:{})});

test('implicit current SKU and old SKU alias in another catalog reject the whole staged import after a tentative group insert',async()=>{
 for(const alias of [false,true]){
  const f=await productCatalogFixture(app),target=await independentCatalog(f);
  let existing=await f.ok('/products','POST',{sku:'FOREIGN-POOL-'+randomUUID(),name:'Own different catalog position',price:2500,quantity:0,warehouse_id:f.spare.id,catalog_id:target.id},201);
  const originalSku=existing.sku;
  if(alias){existing=await f.ok('/products/'+existing.id,'PATCH',{name:existing.name,price:existing.price,vat:existing.vat,ean:existing.ean,sku:'RENAMED-'+randomUUID(),version:existing.version});
   assert.equal(existing.catalog_id,target.id);assert.equal(existing.id,(await pool.query('SELECT product_id FROM product_sku_aliases WHERE(tenant_id,sku)=($1,$2)',[f.tenant,originalSku])).rows[0].product_id);
  }
  const staged=await wooRead(f,[remote(101,{type:'variable',sku:'TENTATIVE-GROUP-'+randomUUID(),variations:[]}),remote(102,{sku:alias?originalSku:existing.sku})]);
  const queriedSku=alias?originalSku:existing.sku;
  const matched=staged.rows.find((r:any)=>r.external_id==='102');
  assert.equal(matched.candidate_id,null,'Unselected GET resolves the default catalog, never another pool');
  for(const field of ['candidate_sku','candidate_version','candidate_kind','candidate_parent_id','candidate_price','candidate_on_hand','candidate_reserved'])assert.equal(matched[field],null,'Wrong-pool candidate projection '+field);
  const beforeReads=await productCatalogFacts(f.tenant);
  const wrongCandidate=await f.ok('/catalog-source-runs/'+staged.run.id+'/candidate?sku='+encodeURIComponent(queriedSku));
  assert.equal(wrongCandidate.product,null);assert.equal(wrongCandidate.catalog_conflict,true);
  const selected=await f.ok('/catalog-source-runs/'+staged.run.id+'?limit=100&catalog_id='+target.id);
  assert.equal(selected.catalog_id,target.id);assert.equal(selected.run.id,staged.run.id);assert.equal(selected.data.length,2);
  const selectedMatch=selected.data.find((r:any)=>r.external_id==='102');assert.equal(selectedMatch.candidate_id,existing.id);assert.equal(selectedMatch.candidate_version,existing.version);assert.equal(selectedMatch.candidate_sku,existing.sku);assert.equal(selectedMatch.candidate_price,2500);assert.equal(selectedMatch.candidate_on_hand,0);assert.equal(selectedMatch.candidate_reserved,0);
  const selectedCandidate=await f.ok('/catalog-source-runs/'+staged.run.id+'/candidate?sku='+encodeURIComponent(queriedSku)+'&catalog_id='+target.id);
  assert.equal(selectedCandidate.product.id,existing.id);assert.equal(selectedCandidate.product.catalog_id,target.id);assert.equal(selectedCandidate.catalog_conflict,false);
  assert.deepEqual(selected.data.map((r:any)=>[r.id,r.source_hash,r.source]).sort(),staged.rows.map((r:any)=>[r.id,r.source_hash,r.source]).sort(),'Selecting a catalog changes only candidate presentation');
  assert.deepEqual(await productCatalogFacts(f.tenant),beforeReads,'Scoped GET run/candidate endpoints never write');
  const before=await productCatalogFacts(f.tenant);
  const denied=await f.request('/catalog-source-runs/'+staged.run.id+'/apply','POST',{items:staged.rows.map((r:any)=>applyItem(r))});
  assert.equal(denied.statusCode,409);assert.deepEqual(await productCatalogFacts(f.tenant),before,'No product, group, alias, listing, audit, job or source-row write survives refusal');
 }
});

test('explicit same-catalog group and variants commit to the selected catalog; prior applied replay survives archive without any row change',async()=>{
 const f=await productCatalogFixture(app),target=await independentCatalog(f);
 const staged=await wooRead(f,[remote(201,{type:'variable',sku:'ASSIGNED-GROUP-'+randomUUID(),variations:[202,203]})],{'201':[remote(202,{sku:'ASSIGNED-V1-'+randomUUID()}),remote(203,{sku:'ASSIGNED-V2-'+randomUUID(),regular_price:'17.01'})]});
 const body={items:staged.rows.map((r:any)=>applyItem(r,target.id))};
 const result=await f.ok('/catalog-source-runs/'+staged.run.id+'/apply','POST',body);
 assert.equal(result.created,3);assert.equal(result.linked,0);
 const group=result.data.find((r:any)=>r.kind==='group');assert(group);
 for(const row of result.data){const p=await f.ok('/products/'+row.product_id);assert.equal(p.catalog_id,target.id);assert.equal(p.parent_id??null,row.kind==='variant'?group.product_id:null);if(row.kind==='variant'){assert.equal(p.stock.length,1);assert.equal(p.stock[0].warehouse_id,f.spare.id);assert.equal(p.stock[0].on_hand,0);}}
 const links=(await pool.query('SELECT product_id,parent_external_id FROM listings WHERE tenant_id=$1 AND channel_id=$2 ORDER BY product_id',[f.tenant,staged.run.channel_id])).rows;
 assert.equal(links.length,2);assert(links.every(r=>r.parent_external_id==='201'));
 const beforeReads=await productCatalogFacts(f.tenant);
 const selected=await f.ok('/catalog-source-runs/'+staged.run.id+'?limit=100&catalog_id='+target.id);
 assert.equal(selected.catalog_id,target.id);assert.equal(selected.data.length,3);
 const parentEntry=selected.data.find((r:any)=>r.kind==='group');assert(parentEntry);
 for(const row of selected.data){const applied=result.data.find((r:any)=>r.entry_id===row.id);assert(applied);assert.equal(row.candidate_id,applied.product_id);assert.equal(row.candidate_kind,applied.kind);assert.equal(row.candidate_parent_id??null,row.kind==='variant'?group.product_id:null);if(row.kind==='variant'){assert.equal(row.parent_entry_id,parentEntry.id);assert.equal(row.parent_state,'applied');}
  const candidate=await f.ok('/catalog-source-runs/'+staged.run.id+'/candidate?sku='+encodeURIComponent(row.source.sku)+'&catalog_id='+target.id);assert.equal(candidate.catalog_conflict,false);assert.equal(candidate.product.id,applied.product_id);assert.equal(candidate.product.catalog_id,target.id);
 }
 const defaultView=await f.ok('/catalog-source-runs/'+staged.run.id+'?limit=100');assert(defaultView.data.every((r:any)=>r.candidate_id===null),'Default preview never joins selected-catalog products');
 assert.deepEqual(await productCatalogFacts(f.tenant),beforeReads,'Applied preview/candidate metadata do not alter stored source rows');
 const current=(await f.ok('/product-catalogs/'+target.id)).catalog;
 const p=(await f.ok('/product-catalogs/previews','POST',{client_key:randomUUID(),kind:'update',catalog_id:target.id,version:current.version,settings:{...current.settings,active:false}},201)).preview;
 await f.ok('/product-catalogs/previews/'+p.id+'/commit','POST',productCatalogConsent(p),201);
 const beforeReplay=await productCatalogFacts(f.tenant);
 const replay=await f.ok('/catalog-source-runs/'+staged.run.id+'/apply','POST',body);
 assert.equal(replay.created,0);assert.equal(replay.linked,0);assert.equal(replay.data.length,3);assert(replay.data.every((r:any)=>r.reused));
 assert.deepEqual(await productCatalogFacts(f.tenant),beforeReplay,'Exact historic applied request bypasses fresh active-catalog admission and changes no business/audit row');
});

test('supplier controlled HTTP read creates a zero-stock product in the explicit catalog and assigned warehouse; unassigned warehouse rolls back',async()=>{
 const f=await productCatalogFixture(app),target=await independentCatalog(f);
 const supplier=await f.ok('/suppliers','POST',{name:'Controlled supplier source',code:'SUP-'+randomUUID()},201);
 const channel=await f.ok('/integrations','POST',{provider:'bigbuy',name:'Explicit simulated HTTP transport',mode:'sandbox',credentials:{api_key:'test-'+randomUUID()},settings:{}});
 const source=await f.ok('/supplier-sources','POST',{channel_id:channel.id,supplier_id:supplier.id,currency:'EUR'});
 const started=await f.ok('/supplier-sources/'+source.id+'/reads','POST',{client_key:randomUUID(),remote_product_id:'301'});
 const calls:string[]=[];
 const ctx:IntegrationContext={transport:async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.sandbox.bigbuy.eu');assert.equal(init.method??'GET','GET');calls.push(u.pathname);
  const resource=u.pathname.split('/')[3];assert.equal(u.pathname.split('/')[4],'301.json');
  const value=resource==='product'?{id:301,sku:'CONTROLLED-301',attributes:false,active:1,wholesalePrice:'12.34'}:resource==='productinformation'?{id:301,isoCode:'pl',name:'Controlled supplier 301',description:'Synthetic provider contract, not provider acceptance'}:resource==='productimages'?{id:301,images:[]}:resource==='productstockbyhandlingdays'?{id:301,sku:'CONTROLLED-301',stocks:[{quantity:8,minHandlingDays:0,maxHandlingDays:1}]}:undefined;
  assert(value,'Unexpected controlled BigBuy resource');return new Response(JSON.stringify(value),{status:200});
 }};
 for(let n=0;n<4;n++){
  const r=(await pool.query('SELECT * FROM supplier_catalog_reads WHERE(tenant_id,id)=($1,$2)',[f.tenant,started.id])).rows[0];assert.equal(r.state,'queued');
  await processSupplierRead(await claimOwn(f.tenant,r.job_id,'supplier.read'),ctx);
 }
 const read=(await pool.query('SELECT state,phase FROM supplier_catalog_reads WHERE(tenant_id,id)=($1,$2)',[f.tenant,started.id])).rows[0];assert.equal(read.state,'success');assert.equal(read.phase,4);assert.equal(calls.length,4);
 const view=await f.ok('/supplier-catalog?source_id='+source.id);assert.equal(view.data.length,1);const item=view.data[0];
 const body={version:item.version,sku:'LOCAL-SUP-'+randomUUID(),price:1701,vat:23,catalog_id:target.id,warehouse_id:f.warehouse};
 const beforeDenied=await productCatalogFacts(f.tenant);
 assert.equal((await f.request('/supplier-catalog/'+item.id+'/product','POST',body)).statusCode,409);
 assert.deepEqual(await productCatalogFacts(f.tenant),beforeDenied);
 const product=await f.ok('/supplier-catalog/'+item.id+'/product','POST',{...body,warehouse_id:f.spare.id});
 const actual=await f.ok('/products/'+product.id);assert.equal(actual.catalog_id,target.id);assert.equal(actual.price,1701);assert.equal(actual.stock.length,1);assert.equal(actual.stock[0].warehouse_id,f.spare.id);assert.equal(actual.stock[0].on_hand,0);assert.equal(actual.stock[0].reserved,0);
 const linked=(await f.ok('/supplier-catalog?source_id='+source.id)).data[0];assert.equal(linked.product_id,product.id);assert.equal(linked.version,item.version+1);
 const movements=(await pool.query('SELECT * FROM stock_movements WHERE(tenant_id,product_id)=($1,$2)',[f.tenant,product.id])).rows;
 assert.equal(movements.length,1,'Product birth retains its ordinary zero-quantity initialization movement');
 assert.equal(movements[0].tenant_id,f.tenant);assert.equal(movements[0].product_id,product.id);assert.equal(movements[0].warehouse_id,f.spare.id);
 assert.equal(movements[0].kind,'initial');assert.equal(movements[0].delta,0);assert.equal(movements[0].order_id,null);
 assert.equal(movements.reduce((quantity,m)=>quantity+m.delta,0),0,'Provider availability must not become received stock');
 assert.equal(movements.filter(m=>m.delta!==0).length,0,'No nonzero stock movement may arise from supplier availability');
});


test('foreign catalog UUIDs and another tenant old SKU alias cannot enter scoped candidate/read/apply graphs',async()=>{
 const f=await productCatalogFixture(app),other=await productCatalogFixture(app),target=await independentCatalog(f);
 let foreign=await other.ok('/products','POST',{sku:'OTHER-TENANT-ALIAS-'+randomUUID(),name:'Other tenant isolated identity',price:901,warehouse_id:other.warehouse,quantity:0},201);
 const alias=foreign.sku;foreign=await other.ok('/products/'+foreign.id,'PATCH',{name:foreign.name,price:foreign.price,vat:foreign.vat,ean:foreign.ean,version:foreign.version,sku:'OTHER-TENANT-CURRENT-'+randomUUID()});
 assert.equal((await pool.query('SELECT product_id FROM product_sku_aliases WHERE(tenant_id,sku)=($1,$2)',[other.tenant,alias])).rows[0].product_id,foreign.id);
 const staged=await wooRead(f,[remote(401,{sku:alias})]);assert.equal(staged.rows[0].candidate_id,null);
 const beforeOwn=await productCatalogFacts(f.tenant),beforeOther=await productCatalogFacts(other.tenant);
 const selected=await f.ok('/catalog-source-runs/'+staged.run.id+'?catalog_id='+target.id);assert.equal(selected.catalog_id,target.id);assert.equal(selected.data[0].candidate_id,null);
 const candidate=await f.ok('/catalog-source-runs/'+staged.run.id+'/candidate?sku='+encodeURIComponent(alias)+'&catalog_id='+target.id);assert.equal(candidate.product,null);assert.equal(candidate.catalog_conflict,false,'A foreign alias is absent, not an own-catalog conflict');
 for(const path of ['/catalog-source-runs/'+staged.run.id+'?catalog_id='+other.defaultCatalog.id,'/catalog-source-runs/'+staged.run.id+'/candidate?sku='+encodeURIComponent(alias)+'&catalog_id='+other.defaultCatalog.id])assert.equal((await f.request(path)).statusCode,404);
 assert.equal((await f.request('/catalog-source-runs/'+staged.run.id+'/apply','POST',{items:staged.rows.map((r:any)=>applyItem(r,other.defaultCatalog.id))})).statusCode,404);
 assert.equal((await other.request('/catalog-source-runs/'+staged.run.id+'?catalog_id='+other.defaultCatalog.id)).statusCode,404);
 assert.deepEqual(await productCatalogFacts(f.tenant),beforeOwn);assert.deepEqual(await productCatalogFacts(other.tenant),beforeOther);
});
