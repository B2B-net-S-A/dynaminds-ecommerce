import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';
import { processB2bCatalog } from '../server/b2b-network';
import * as S from '../server/b2b-catalog-scope';

assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost','127.0.0.1','[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  assert((await pool.query("SELECT 1 FROM migrations WHERE name='143_catalog_export_catalogs'")).rowCount);
  if (!(await pool.query("SELECT to_regprocedure('public.b2b_catalog_scope_installed()') r")).rows[0].r)
    await pool.query(await readFile(resolve('server/144_b2b_catalog_scopes.sql'),'utf8'));
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('No provider in local B2B scope tests'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function catalog(f: Awaited<ReturnType<typeof productCatalogFixture>>) {
  const p = (await f.ok('/product-catalogs/previews','POST',productCatalogCreate(f),201)).preview;
  return (await f.ok('/product-catalogs/previews/'+p.id+'/commit','POST',productCatalogConsent(p),201)).catalog;
}
async function fixture() {
  const supplier = await productCatalogFixture(app), buyer = await productCatalogFixture(app);
  const publishedCatalog = await catalog(supplier), target = await catalog(buyer);
  const product = await supplier.ok('/products','POST',{ catalog_id:publishedCatalog.id,sku:'SCOPED-'+randomUUID(),name:'Selected supplier product',price:1000,quantity:7,warehouse_id:supplier.spare.id },201);
  const wrong = await supplier.ok('/products','POST',{ sku:'OTHER-'+randomUUID(),name:'Default supplier product',price:1000,quantity:9,warehouse_id:supplier.warehouse },201);
  const priced = await supplier.ok('/price-lists/'+supplier.list.id+'/items','PUT',{ version:supplier.list.version,items:[{product_id:product.id,price:777},{product_id:wrong.id,price:999}] });
  const body = { name:'Scoped local supplier',email:randomUUID()+'@example.test',warehouse_id:supplier.warehouse,price_list_id:supplier.list.id,
    address:{street:'Own159',city:'Warszawa',postal_code:'00-159',country:'PL'},payment_mode:'prepaid' };
  const born = await supplier.ok('/b2b/accounts','POST',body,201);
  const active = await supplier.ok('/b2b/accounts/'+born.id,'PATCH',{...body,version:born.version,active:true,confirmed:true});
  const p = (await S.previewB2BSupplierCatalogScope(supplier.actor,born.id,{client_key:randomUUID(),account_version:String(active.version),catalog_id:publishedCatalog.id,catalog_version:publishedCatalog.version,warehouse_id:supplier.spare.id,price_list_id:supplier.list.id,language:'pl'})).preview;
  const configured = await S.commitB2BCatalogScope(supplier.actor,p.id,{client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true});
  const invitation = await supplier.ok('/b2b/accounts/'+born.id+'/network-invite','POST',{version:Number(configured.operation.after.version),recipient_email:'admin@demo.local',confirmed:true});
  const link = await buyer.ok('/b2b/network/accept','POST',{token:invitation.token,confirmed:true});
  const bp = (await S.previewB2BBuyerCatalogScope(buyer.actor,link.id,{client_key:randomUUID(),link_version:String(link.version),target_catalog_id:target.id,target_catalog_version:target.version})).preview;
  await S.commitB2BCatalogScope(buyer.actor,bp.id,{client_key:randomUUID(),scope_hash:bp.scope_hash,confirmed:true});
  const local = await buyer.ok('/products','POST',{catalog_id:target.id,sku:'LOCAL-'+randomUUID(),name:'Own target item',price:1000,quantity:0,warehouse_id:buyer.spare.id},201);
  return {supplier,buyer,product,wrong,target,publishedCatalog,local,base:'/b2b/network/links/'+link.id,link,listVersion:priced.version};
}
async function refresh(f: Awaited<ReturnType<typeof fixture>>) {
  const body = {client_key:randomUUID(),confirmed:true},run = await f.buyer.ok(f.base+'/refresh','POST',body);
  const job = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE tenant_id=$1 AND id=$3 AND state='pending' RETURNING *",[f.buyer.tenant,randomUUID(),run.job_id])).rows[0];
  assert(job); return {body,run,job};
}
function noInternal(value: unknown) {
  const walk = (x:any):void => { if (!x || typeof x!=='object') return; for(const [key,v] of Object.entries(x)) { assert(!['catalog_scope','catalog_scope_hash','api_key_id','request_hash','txid'].includes(key),key);walk(v); } };walk(value);
}

test('scoped publication, target product creation and full private run proof; supplier availability issues no buyer stock', async () => {
  const f = await fixture(),{run,job,body} = await refresh(f);
  noInternal(run);
  const proof = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE tenant_id=$1 AND id=$2',[f.buyer.tenant,run.id])).rows[0];
  assert.equal(proof.catalog_scope.buyer.target_catalog_id,f.target.id);assert.equal(proof.catalog_scope.supplier.catalog_id,f.publishedCatalog.id);
  assert.equal(proof.catalog_scope.supplier.price_list_version,String(f.listVersion));assert.equal(proof.catalog_scope_hash,job.payload.catalog_scope_hash);
  await processB2bCatalog(job);
  const page = await f.buyer.ok(f.base+'/catalog');
  assert.deepEqual(page.target_catalog,{id:f.target.id,name:f.target.name,version:f.target.version});
  assert.equal(page.data.length,1);assert.equal(page.data[0].source_product_id,f.product.id);assert.equal(page.data[0].snapshot.price,777);assert.equal(page.data[0].snapshot.available,7);noInternal(page);
  const before = await productCatalogFacts(f.buyer.tenant);
  const copied = await f.buyer.ok(f.base+'/catalog/'+page.data[0].id+'/product','POST',{version:page.data[0].version,sku:'COPY-'+randomUUID(),sale_price:1200,warehouse_id:f.buyer.spare.id,confirmed:true});
  const p = (await pool.query('SELECT catalog_id FROM products WHERE tenant_id=$1 AND id=$2',[f.buyer.tenant,copied.product_id])).rows[0];assert.equal(p.catalog_id,f.target.id);
  const stock = (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',[f.buyer.tenant,copied.product_id])).rows;assert(stock.every(s=>s.on_hand===0&&s.reserved===0));
  assert.equal((await productCatalogFacts(f.buyer.tenant)).orders.length,before.orders.length);
  const accepted = await productCatalogFacts(f.buyer.tenant),replay = await f.buyer.ok(f.base+'/refresh','POST',body);
  assert.equal(replay.id,run.id);assert.deepEqual(await productCatalogFacts(f.buyer.tenant),accepted);assert.equal(providerCalls,0);
  const c = await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.buyer.tenant]);
    await assert.rejects(c.query('UPDATE b2b_catalog_runs SET catalog_scope_hash=$2 WHERE id=$1',[run.id,'0'.repeat(64)]),(e:any)=>e.code==='23514');
  }finally{await c.query('ROLLBACK');c.release();}
  const deletion = await pool.connect();try{await deletion.query('BEGIN');await deletion.query('SET LOCAL ROLE dyna_app');await deletion.query("SELECT set_config('app.tenant_id',$1,true)",[f.buyer.tenant]);
    await assert.rejects(deletion.query('DELETE FROM b2b_catalog_runs WHERE id=$1',[run.id]),(e:any)=>e.code==='23514');
  }finally{await deletion.query('ROLLBACK');deletion.release();}
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant),accepted);
});

test('catalog drift between queue and publication rejects all item/staging effects; original refresh replay survives drift', async () => {
  const f = await fixture(),{run,job,body} = await refresh(f);
  const p = (await f.supplier.ok('/product-catalogs/previews','POST',{client_key:randomUUID(),kind:'update',catalog_id:f.publishedCatalog.id,version:f.publishedCatalog.version,
    settings:{name:f.publishedCatalog.name+' changed',active:true,languages:f.publishedCatalog.languages,default_language:f.publishedCatalog.default_language,warehouse_ids:f.publishedCatalog.warehouse_ids,price_list_ids:f.publishedCatalog.price_list_ids}},201)).preview;
  await f.supplier.ok('/product-catalogs/previews/'+p.id+'/commit','POST',productCatalogConsent(p),201);
  //142 rewrites all assignment rows even for a rename.144's three resource FKs
  //must be deferred so this genuine unchanged-resource configuration succeeds.
  const scope = (await pool.query('SELECT catalog_id,warehouse_id,price_list_id,language FROM b2b_supplier_catalog_scopes WHERE tenant_id=$1 AND account_id=$2',[f.supplier.tenant,f.link.account_id])).rows[0];
  assert.deepEqual(scope,{catalog_id:f.publishedCatalog.id,warehouse_id:f.supplier.spare.id,price_list_id:f.supplier.list.id,language:'pl'});
  const foreignKeys = (await pool.query("SELECT condeferrable,condeferred FROM pg_constraint WHERE conrelid='b2b_supplier_catalog_scopes'::regclass AND confrelid=ANY(ARRAY['product_catalog_warehouses'::regclass,'product_catalog_price_lists'::regclass,'product_catalog_languages'::regclass])")).rows;
  assert.equal(foreignKeys.length,3);assert(foreignKeys.every(fk=>fk.condeferrable&&fk.condeferred));
  const before = await productCatalogFacts(f.buyer.tenant),other = await productCatalogFacts(f.supplier.tenant);
  await assert.rejects(processB2bCatalog(job),(e:any)=>e.status===409);
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant),before);assert.deepEqual(await productCatalogFacts(f.supplier.tenant),other);
  assert.equal((await f.buyer.ok(f.base+'/refresh','POST',body)).id,run.id);assert.deepEqual(await productCatalogFacts(f.buyer.tenant),before);
});

test('bind requires own target simple/variant and persists actor/key/body-bound exact receipt before source freshness', async () => {
  const f = await fixture(),{job} = await refresh(f);await processB2bCatalog(job);
  const item = (await f.buyer.ok(f.base+'/catalog')).data[0],path=f.base+'/catalog/'+item.id+'/bind';
  const keyScopes=['products:read','products:write','purchasing:read','purchasing:write'];
  const key = await f.buyer.ok('/developer/keys','POST',{name:'Bind own',scopes:keyScopes},201),second = await f.buyer.ok('/developer/keys','POST',{name:'Other bind key',scopes:keyScopes},201);
  const body={client_key:randomUUID(),version:item.version,product_id:f.local.id,confirmed:true},before=await productCatalogFacts(f.buyer.tenant);
  for(const product_id of [f.buyer.product.id,f.product.id]) assert.equal((await f.buyer.request(path,'POST',{...body,client_key:randomUUID(),product_id},key)).statusCode,404);
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant),before);
  const result=await f.buyer.ok(path,'POST',body,201,key);assert.equal(result.reused,false);assert.equal(result.binding.item_id,item.id);assert.equal(result.binding.product_id,f.local.id);assert.equal(result.binding.item_version_before,item.version);assert.equal(result.binding.item_version_after,item.version+1);noInternal(result);
  const accepted=await productCatalogFacts(f.buyer.tenant);
  assert.deepEqual(accepted.stock,before.stock);assert.deepEqual(accepted.stock_movements,before.stock_movements);assert.deepEqual(accepted.orders,before.orders);
  assert.equal((await f.buyer.request(path,'POST',body,second)).statusCode,409);
  assert.equal((await f.buyer.request(path,'POST',{...body,version:body.version+1},key)).statusCode,409);
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant),accepted);
  await f.supplier.ok('/b2b/accounts/'+f.link.account_id,'PATCH',{name:'Scoped local supplier',email:randomUUID()+'@example.test',warehouse_id:f.supplier.spare.id,price_list_id:f.supplier.list.id,address:{street:'Own159',city:'Warszawa',postal_code:'00-159',country:'PL'},payment_mode:'prepaid',version:Number((await pool.query('SELECT version FROM b2b_accounts WHERE tenant_id=$1 AND id=$2',[f.supplier.tenant,f.link.account_id])).rows[0].version),active:false,confirmed:true});
  const replay=await f.buyer.ok(path,'POST',body,200,key);assert.equal(replay.reused,true);assert.deepEqual(replay.binding,result.binding);assert.deepEqual(await productCatalogFacts(f.buyer.tenant),accepted);
  const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.buyer.tenant]);
    await assert.rejects(c.query('SELECT * FROM b2b_catalog_bindings'),(e:any)=>e.code==='42501');
  }finally{await c.query('ROLLBACK');c.release();}
});
