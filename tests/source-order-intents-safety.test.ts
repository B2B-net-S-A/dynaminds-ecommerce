import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LightMyRequestResponse } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { processB2bCatalog } from '../server/b2b-network';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';
import {
  externalImportAdmissionInTx, normalizeExternalImportOrder, prepareB2bExternalImportInTx,
} from '../server/b2b-external-order-imports';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let transport = shopifyFulfillmentFixture();
let buyer = '', supplier = '', buyerWarehouse = '', supplierWarehouse = '';
let buyerUser = '', supplierUser = '', buyerCookie = '', supplierCookie = '', ip = 1;
const request = (path: string, method: any = 'GET', payload?: any, auth = buyerCookie, target = app!) =>
  target.inject({ url: '/api' + path, method, payload, headers: { cookie: auth }, remoteAddress: '127.0.188.' + ip });
const publicRequest = (token:string,path:string,method:any='GET',payload?:any) =>
  app!.inject({url:'/api/v1'+path,method,payload,headers:{authorization:'Bearer '+token,'X-Workspace-ID':buyer},remoteAddress:'127.0.188.'+ip});
const readScopes = ['products:read','inventory:read','orders:read','purchasing:read','integrations:read'];
const writeScopes = [...readScopes,'inventory:write','orders:write','purchasing:write','integrations:write'];
async function ok(path: string, method: any = 'GET', payload?: any, auth = buyerCookie): Promise<Row> {
  const r = await request(path, method, payload, auth);
  assert(r.statusCode < 300, `${path}: ${r.statusCode} ${r.body.slice(0, 600)}`);
  return r.json();
}
async function enter(email: string, tenant: string, target = app!) {
  const login = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(login.statusCode, 200);
  const switched = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, String(login.headers['set-cookie']).split(';')[0], target);
  assert.equal(switched.statusCode, 200);
  return String(switched.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: (...args: Parameters<typeof transport.transport>) => transport.transport(...args),
    logging: process.env.SOURCE_ORDER_INTENT_TEST_LOG === 'true',
  });
  buyerUser = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0].id;
  supplierUser = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  transport = shopifyFulfillmentFixture();
  buyer = randomUUID(); supplier = randomUUID();
  buyerWarehouse = randomUUID(); supplierWarehouse = randomUUID();
  for (const [tenant, user, warehouse, label] of [
    [buyer, buyerUser, buyerWarehouse, 'Buyer'], [supplier, supplierUser, supplierWarehouse, 'Supplier'],
  ]) {
    await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'enterprise')", [tenant, 'Own127B ' + label]);
    await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, user]);
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$3)', [warehouse, tenant, label]);
  }
  buyerCookie = await enter('other@demo.local', buyer);
  supplierCookie = await enter('admin@demo.local', supplier);
});
after(async () => {
  try { await app?.close(); } finally { await pool.end(); }
});
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function snapshot(physicalOnly = false, iamWithdrawal = false, tenants = [buyer, supplier]) {
  const physical = [
    'stock','stock_locations','stock_location_movements','stock_location_operations','stock_movements',
    'reservations','reservation_locations','order_pick_items','warehouse_documents','warehouse_document_lines',
    'wms_operations','wms_lots','wms_cost_layers','wms_layer_positions','wms_reservation_layers',
    'wms_layer_movements','wms_issue_fragments','wms_return_fragments','shipments',
  ];
  const names = physicalOnly ? physical : (await pool.query(
    "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'sessions' ORDER BY 1",
  )).rows.map((r: Row) => r.table_name).filter((name:string)=>
    // Withdrawal is the explicit fixture mutation; all business evidence and history quotas remain exact.
    !iamWithdrawal || !['memberships','workspace_usage','api_keys'].includes(name));
  const c = await pool.connect(), result: Record<string, string> = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      result[name] = hash((await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`, [physicalOnly ? [buyer] : tenants])).rows);
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {}); c.release();
  }
}
const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });
function sourceRaw() {
  const raw = structuredClone(transport.state.raw), first = raw.lineItems.nodes[0];
  raw.lineItems.nodes = [
    { ...structuredClone(first), quantity:2,currentQuantity:2,unfulfilledQuantity:2,originalTotalSet:money('20.00'),discountAllocations:[],taxLines:[] },
    { ...structuredClone(first),id:'gid://shopify/LineItem/980013',quantity:1,currentQuantity:1,unfulfilledQuantity:1,originalTotalSet:money('17.00'),discountAllocations:[],taxLines:[] },
  ];
  raw.shippingLines.nodes[0].taxLines = [];
  raw.totalPriceSet = money('42.00'); raw.currentTotalPriceSet = money('42.00');
  raw.totalReceivedSet = money('10.00'); raw.totalTaxSet = money('0.00');
  raw.displayFinancialStatus = 'PARTIALLY_PAID';
  return raw;
}
async function enableWms() {
  const { preview } = await ok('/wms-lots/opening-previews','POST', {
    client_key:randomUUID(),policy_version:'0',currency:'PLN',note:'Own127B empty opening',lines:[],
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate','POST', {
    client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true,ack_unknown_costs:false,
  });
}
async function setup(on = false, rawOverride?: (raw:ReturnType<typeof sourceRaw>)=>void): Promise<Row> {
  const source = await ok('/products','POST', {
    sku:'OWN127B-SUP-'+randomUUID(),name:'Own source supplier',price:700,vat:23,quantity:20,warehouse_id:supplierWarehouse,
  },supplierCookie);
  const list = await ok('/price-lists','POST',{name:'Own127B list '+randomUUID(),currency:'PLN'},supplierCookie);
  await ok('/price-lists/'+list.id+'/items','PUT',{version:list.version,items:[{product_id:source.id,price:700}]},supplierCookie);
  const accountBody = {
    name:'Own127B buyer',email:'own127b-'+randomUUID()+'@example.test',warehouse_id:supplierWarehouse,price_list_id:list.id,
    address:{street:'Own warehouse1',city:'Poznań',postal_code:'60-001',country:'PL'},
    min_total:0,min_quantity:1,quantity_step:1,shipping_cost:0,payment_mode:'prepaid',
  };
  const account = await ok('/b2b/accounts','POST',accountBody,supplierCookie);
  const enabled = await ok('/b2b/accounts/'+account.id,'PATCH',{...accountBody,version:account.version,active:true,confirmed:true},supplierCookie);
  const invitation = await ok('/b2b/accounts/'+account.id+'/network-invite','POST', {
    version:enabled.version,recipient_email:'other@demo.local',confirmed:true,
  },supplierCookie);
  const link = await ok('/b2b/network/accept','POST',{token:invitation.token,confirmed:true});
  const base = '/b2b/network/links/'+link.id;
  const run = await ok(base+'/refresh','POST',{client_key:randomUUID(),confirmed:true});
  for (let attempt=0;attempt<5;attempt++) {
    const current = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1',[run.id])).rows[0];
    if (current.state==='done') break;
    assert.equal(current.state,'queued');
    const job = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",[current.job_id,randomUUID()])).rows[0];
    await processB2bCatalog(job);
    await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",[job.id,job.lease_token]);
  }
  assert.equal((await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1',[run.id])).rows[0].state,'done');
  const item = (await ok(base+'/catalog')).data.find((i:Row)=>i.source_product_id===source.id);
  assert(item);
  const mapped = await ok(base+'/catalog/'+item.id+'/product','POST', {
    version:item.version,sku:'OWN127B-LOCAL-'+randomUUID(),sale_price:29999,warehouse_id:buyerWarehouse,confirmed:true,
  });
  const product = await ok('/products/'+mapped.product_id);
  if (on) await enableWms();
  const raw = sourceRaw(); rawOverride?.(raw); transport.state.raw = raw;
  const channel = await ok('/integrations','POST', {
    provider:'shopify',name:'Own127B source '+randomUUID(),mode:'sandbox',
    settings:{store_url:'https://own127b-'+randomUUID()+'.myshopify.com'},credentials:{access_token:'own-synthetic-not-real-token'},
  });
  await ok('/integrations/'+channel.id+'/mappings','POST',{external_id:'gid://shopify/ProductVariant/701',sku:product.sku});
  const inbound = (await ok('/integrations/'+channel.id+'/stage-orders','POST',{data:[raw]})).data[0];
  const body = {
    client_key:randomUUID(),warehouse_id:buyerWarehouse,expected_source_hash:inbound.source_hash,
    allocations:raw.lineItems.nodes.map((i:Row)=>({remote_line_id:i.id,local_quantity:0,external_quantity:i.quantity,unassigned_quantity:0,link_id:link.id})),
  };
  return {source,product,channel,inbound,raw,body,link,item,base};
}
async function preview(f: Row) {
  const response = await request('/imports/'+f.inbound.id+'/external-intent-previews','POST',f.body);
  assert.equal(response.statusCode,201,response.body);
  return response.json().preview as Row;
}
const executeBody = (p:Row) => ({client_key:randomUUID(),version:1 as const,scope_hash:p.scope_hash,confirmed:true as const});
const execute = (p:Row,body=executeBody(p),auth=buyerCookie) => request('/import-external-intent-previews/'+p.id+'/execute','POST',body,auth);
async function waitOn(holder:PoolClient, pattern:RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // 30 s, not 4 s: the execution prepares the whole import before the held row; on a loaded runner that took 10–12 s.
  const until = Date.now()+30000;
  while (Date.now()<until) {
    const waits = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[pid])).rows;
    if (waits.some((r:Row)=>pattern.test(r.query))) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('The real source-intent execution never waited on the held row');
}

for (const on of [false,true]) test(`genuine Shopify source import preserves same-SKU 10/17 historic prices, partial payment and external-only physical absence with exact replay, WMS ${on?'ON':'OFF'}`,async()=>{
  const f = await setup(on), physical = await snapshot(true), p = await preview(f), body = executeBody(p);
  assert.equal(p.rows.length,2);
  assert.equal(new Set(p.rows.map((r:Row)=>r.customer_item_id)).size,2);
  const responses = await Promise.all([execute(p,body),execute(p,body)]);
  assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,201]);
  const result = responses.find(r=>r.statusCode===201)!.json();
  assert(result.intent && result.order);
  assert.equal(result.order.total,4200);
  assert.equal(result.order.status,'new');
  assert.equal(result.order.items.length,2);
  const bindings = (await pool.query('SELECT * FROM order_source_lines WHERE tenant_id=$1 AND source_order_id=$2 ORDER BY remote_line_id',[buyer,result.order.id])).rows;
  assert.equal(bindings.length,2);
  for (const [index,amount,quantity,price] of [[0,2000,2,1000],[1,1700,1,1700]]) {
    const binding = bindings[index], item = result.order.items.find((i:Row)=>i.id===binding.source_item_id);
    assert(item); assert.equal(item.product_id,f.product.id); assert.equal(item.quantity,quantity);
    assert.equal(item.line_total,amount); assert.equal(item.price,price); assert.equal(item.vat,23);
    assert.equal(binding.source_hash,f.inbound.source_hash);
    assert.equal(binding.inbound_id,f.inbound.id); assert.equal(binding.channel_id,f.channel.id);
    const allocation = result.intent.items.find((i:Row)=>i.customer_item_id===item.id);
    assert(allocation); assert.equal(allocation.local_quantity,0); assert.equal(allocation.external_quantity,quantity);
  }
  assert.equal(result.order.payment.received,1000); assert.equal(result.order.payment.amount_due,3200);
  assert.deepEqual((await pool.query('SELECT kind,amount,method FROM payment_entries WHERE tenant_id=$1 AND order_id=$2',[buyer,result.order.id])).rows,
    [{kind:'receipt',amount:1000,method:'source_import'}]);
  assert.equal(result.order.picking_items.length,0);
  assert.deepEqual(await snapshot(true),physical);
  const beforeRetry = await snapshot();
  const replay = await execute(p,body);
  assert.equal(replay.statusCode,200,replay.body); assert.equal(replay.json().reused,true);
  assert.equal(replay.json().order.id,result.order.id);
  assert.deepEqual(await snapshot(),beforeRetry);
});

for (const on of [false, true])
  test(`genuine mixed bundle source import reserves only local recipe and preserves repeated-SKU historic prices and unassigned intent, WMS ${on ? 'ON' : 'OFF'}`, async () => {
    const f = await setup(false);
    const a = await ok('/products', 'POST', {
      sku: 'OWN127B-COMP-A-' + randomUUID(), name: 'Own mixed component A',
      price: 8000, vat: 23, quantity: 7, warehouse_id: buyerWarehouse,
    });
    const b = await ok('/products', 'POST', {
      sku: 'OWN127B-COMP-B-' + randomUUID(), name: 'Own mixed component B',
      price: 9000, vat: 23, quantity: 7, warehouse_id: buyerWarehouse,
    });
    const recipe = [
      { product_id: a.id, quantity: 2 }, { product_id: b.id, quantity: 1 },
    ].sort((x, y) => x.product_id.localeCompare(y.product_id));
    const bundle = await ok('/products', 'POST', {
      sku: 'OWN127B-MIXED-BUNDLE-' + randomUUID(), name: 'Own mixed imported bundle',
      price: 29999, vat: 23, quantity: 0, warehouse_id: buyerWarehouse,
      kind: 'bundle', components: recipe,
    });
    await ok('/integrations/' + f.channel.id + '/mappings', 'POST', {
      external_id: 'gid://shopify/ProductVariant/701', sku: bundle.sku,
    });
    if (on) {
      const scope = await ok('/wms-lots/opening-scope');
      assert.equal(scope.meta.cursor, null, 'The entire opening scope must be supplied');
      assert.deepEqual(scope.active_blockers, []);
      assert.equal(scope.data.length, 2);
      assert.deepEqual(scope.data.map((row: Row) => row.product_id).sort(), [a.id, b.id].sort());
      assert(scope.data.every((row: Row) => row.warehouse_id === buyerWarehouse && row.quantity === 7));
      const { preview: opening } = await ok('/wms-lots/opening-previews', 'POST', {
        client_key: randomUUID(), policy_version: '0', currency: 'PLN',
        note: 'Own127B complete mixed component opening',
        lines: scope.data.map((row: Row) => ({
          warehouse_id: row.warehouse_id, product_id: row.product_id,
          location: row.location, quantity: row.quantity, stock_version: row.stock_version,
          lot_code: row.product_id === a.id ? 'OWN127B-A' : 'OWN127B-B',
          unit_cost_minor: row.product_id === a.id ? '150' : '250',
        })),
      });
      assert.equal(opening.ready, true);
      assert.equal(String(opening.known_minor), '2800');
      assert.equal(String(opening.unknown_quantity), '0');
      await ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', {
        client_key: randomUUID(), scope_hash: opening.scope_hash,
        confirmed: true, ack_unknown_costs: false,
      });
    }
    f.body.allocations = [
      { remote_line_id: f.raw.lineItems.nodes[0].id, local_quantity: 1,
        external_quantity: 1, unassigned_quantity: 0, link_id: f.link.id },
      { remote_line_id: f.raw.lineItems.nodes[1].id, local_quantity: 0,
        external_quantity: 0, unassigned_quantity: 1, link_id: null },
    ];
    const supplierBefore = await snapshot(false, false, [supplier]);
    const physicalBefore = await snapshot(true);
    const p = await preview(f);
    assert.equal(p.rows.length, 2);
    assert.equal(new Set(p.rows.map((row: Row) => row.customer_item_id)).size, 2);
    assert.deepEqual(await snapshot(true), physicalBefore, 'Preview cannot reserve or issue stock');
    const body = executeBody(p), response = await execute(p, body);
    assert.equal(response.statusCode, 201, response.body);
    const result = response.json();
    assert.equal(result.order.total, 4200);
    assert.equal(result.order.shipping_cost, 500);
    assert.equal(result.order.payment.received, 1000);
    assert.equal(result.order.payment.amount_due, 3200);
    assert.equal(result.order.items.length, 2);
    const bindings = (await pool.query(
      'SELECT * FROM order_source_lines WHERE tenant_id=$1 AND source_order_id=$2 ORDER BY remote_line_id',
      [buyer, result.order.id],
    )).rows;
    assert.equal(bindings.length, 2);
    const normalizedRecipe = (rows: Row[]) => rows.map(({ product_id, quantity }) => ({ product_id, quantity }))
      .sort((x, y) => x.product_id.localeCompare(y.product_id));
    for (const [index, amount, quantity, price] of [[0, 2000, 2, 1000], [1, 1700, 1, 1700]]) {
      const binding = bindings.find((row: Row) => row.remote_line_id === f.raw.lineItems.nodes[index].id);
      assert(binding);
      const item = result.order.items.find((row: Row) => row.id === binding.source_item_id);
      const planned = p.rows.find((row: Row) => row.remote_line_id === binding.remote_line_id);
      assert(item && planned);
      assert.equal(item.id, planned.customer_item_id);
      assert.equal(item.product_id, bundle.id);
      assert.equal(item.sku, bundle.sku);
      assert.equal(item.quantity, quantity);
      assert.equal(item.price, price);
      assert.equal(item.line_total, amount);
      assert.equal(item.vat, 23);
      assert.equal(binding.quantity, quantity);
      assert.equal(binding.line_total, amount);
      assert.equal(binding.product_id, bundle.id);
      assert.equal(binding.source_hash, f.inbound.source_hash);
      assert.equal(binding.inbound_id, f.inbound.id);
      assert.equal(binding.channel_id, f.channel.id);
      assert.deepEqual(normalizedRecipe(item.components), recipe);
      assert.deepEqual(normalizedRecipe(planned.components), recipe);
      const allocation = result.intent.items.find((row: Row) => row.customer_item_id === item.id);
      assert(allocation);
      assert.deepEqual(normalizedRecipe(allocation.components), recipe);
      assert.deepEqual(
        [allocation.local_quantity, allocation.external_quantity, allocation.unassigned_quantity, allocation.link_id],
        index === 0 ? [1, 1, 0, f.link.id] : [0, 0, 1, null],
      );
      assert.equal(allocation.committed_quantity, 0);
      assert.equal(allocation.dispatched_quantity, 0);
    }
    assert.equal(result.order.items.reduce((sum: number, item: Row) => sum + item.quantity, 0), 3);
    const expectedLocal = recipe.map(({ product_id, quantity }) => ({ product_id, quantity, scanned: 0 }));
    assert.deepEqual(normalizedRecipe(result.order.picking_items), recipe);
    assert(result.order.picking_items.every((item: Row) => item.scanned === 0));
    assert.deepEqual((await pool.query(
      'SELECT product_id,quantity,scanned FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
      [buyer, result.order.id],
    )).rows, expectedLocal);
    assert.deepEqual((await pool.query(
      'SELECT product_id,quantity,state FROM reservations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
      [buyer, result.order.id],
    )).rows, recipe.map((row) => ({ ...row, state: 'active' })));
    assert.deepEqual((await pool.query(
      'SELECT product_id,quantity,scanned FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,location',
      [buyer, result.order.id],
    )).rows, expectedLocal);
    assert.deepEqual((await pool.query(
      'SELECT product_id,on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=ANY($3::uuid[]) ORDER BY product_id',
      [buyer, buyerWarehouse, [a.id, b.id]],
    )).rows, recipe.map(({ product_id, quantity }) => ({ product_id, on_hand: 7, reserved: quantity, available: 7 - quantity })));
    const physicalAfter = await snapshot(true);
    for (const table of [
      'stock_locations', 'stock_location_movements', 'stock_location_operations', 'stock_movements',
      'warehouse_documents', 'warehouse_document_lines', 'wms_lots', 'wms_cost_layers',
      'wms_layer_movements', 'wms_issue_fragments', 'wms_return_fragments', 'shipments',
    ]) assert.equal(physicalAfter[table], physicalBefore[table], `${table}: import cannot issue/restock/reprice`);
    const layers = (await pool.query(
      'SELECT product_id,quantity,scanned,state FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,layer_id',
      [buyer, result.order.id],
    )).rows;
    assert.deepEqual(layers, on ? expectedLocal.map((row) => ({ ...row, state: 'active' })) : []);
    if (on) assert.deepEqual((await pool.query(
      'SELECT product_id,quantity,reserved FROM wms_layer_positions WHERE tenant_id=$1 ORDER BY product_id,layer_id',
      [buyer],
    )).rows, recipe.map(({ product_id, quantity }) => ({ product_id, quantity: 7, reserved: quantity })));
    assert.deepEqual((await pool.query(
      'SELECT kind,amount,method FROM payment_entries WHERE tenant_id=$1 AND order_id=$2',
      [buyer, result.order.id],
    )).rows, [{ kind: 'receipt', amount: 1000, method: 'source_import' }]);
    assert.deepEqual((await pool.query(
      `SELECT c.state,c.actual_order_id,c.intent_id,e.order_id,e.intent_id execution_intent_id
       FROM b2b_external_import_certificates c JOIN b2b_external_import_executions e
       ON e.tenant_id=c.tenant_id AND e.certificate_id=c.id WHERE c.tenant_id=$1 AND c.preview_id=$2`,
      [buyer, p.id],
    )).rows, [{ state: 'complete', actual_order_id: result.order.id, intent_id: result.intent.id,
      order_id: result.order.id, execution_intent_id: result.intent.id }]);
    assert.deepEqual(await snapshot(false, false, [supplier]), supplierBefore, 'Import must not create supplier orders or effects');
    const beforeRetry = await snapshot(), replay = await execute(p, body);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().reused, true);
    assert.equal(replay.json().order.id, result.order.id);
    assert.deepEqual(await snapshot(), beforeRetry);
  });

test('fully paid genuine Shopify source preserves one source-import receipt and paid status without phantom physical effects or confirmation cash',async()=>{
  const f = await setup(false,raw=>{
    raw.totalReceivedSet = money('42.00');
    raw.displayFinancialStatus = 'PAID';
  });
  const physical = await snapshot(true), p = await preview(f), body = executeBody(p);
  assert.equal(transport.state.raw.displayFinancialStatus,'PAID');
  assert.equal(p.source.payment.paid_amount,4200);
  const response = await execute(p,body);
  assert.equal(response.statusCode,201,response.body);
  const result = response.json();
  assert.equal(result.order.total,4200);
  assert.equal(result.order.status,'paid');
  assert.equal(result.order.payment.received,4200);
  assert.equal(result.order.payment.amount_due,0);
  assert.equal(result.order.items.length,2);
  assert.deepEqual(result.order.items.map((i:Row)=>i.line_total).sort((a:number,b:number)=>a-b),[1700,2000]);
  assert.equal(result.order.picking_items.length,0);
  assert.deepEqual((await pool.query('SELECT kind,amount,method FROM payment_entries WHERE tenant_id=$1 AND order_id=$2 ORDER BY id',[buyer,result.order.id])).rows,
    [{kind:'receipt',amount:4200,method:'source_import'}]);
  assert.deepEqual(await snapshot(true),physical);
  const beforeRetry = await snapshot(), replay = await execute(p,body);
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().reused,true);
  assert.equal(replay.json().order.id,result.order.id);
  assert.equal(replay.json().order.payment.received,4200);
  assert.deepEqual(await snapshot(),beforeRetry);
});

test('role withdrawal while the real source-import product lock waits rolls back order, source payment, bindings and intent evidence',async()=>{
  const f = await setup(), p = await preview(f), before = await snapshot(false,true);
  const holder = await pool.connect(); let pending:ReturnType<typeof execute>|undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[f.product.id]);
    pending = execute(p);
    await waitOn(holder,/products|b2b_external_import_prepare/i);
    const withdrawal = await pool.connect();
    try {
      await withdrawal.query('BEGIN'); await withdrawal.query("SET LOCAL statement_timeout='1500ms'");
      await withdrawal.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[buyer,buyerUser]);
      await withdrawal.query('COMMIT');
    } finally { await withdrawal.query('ROLLBACK');withdrawal.release(); }
    await holder.query('ROLLBACK');
    const response = await pending;
    assert.equal(response.statusCode,403,response.body);
    assert.deepEqual(await snapshot(false,true),before);
  } finally {
    await holder.query('ROLLBACK');holder.release();if(pending)await pending;
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2",[buyer,buyerUser]);
  }
});

test('current API key revoke, expiry and integration-write loss during actual product waits deny import and roll back every business effect',async()=>{
  const f = await setup();
  for (const mutation of ['revoke','expiry','scope'] as const) {
    const credential = await ok('/developer/keys','POST',{name:'Own127B late '+mutation,scopes:writeScopes});
    assert(credential.id && credential.token);
    const previewResponse = await publicRequest(credential.token,'/imports/'+f.inbound.id+'/external-intent-previews','POST',{
      ...f.body,client_key:randomUUID(),
    });
    assert.equal(previewResponse.statusCode,201,previewResponse.body);
    const p = previewResponse.json().preview, before = await snapshot(false,true);
    const holder = await pool.connect(); let pending:ReturnType<typeof publicRequest>|undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[f.product.id]);
      pending = publicRequest(credential.token,'/import-external-intent-previews/'+p.id+'/execute','POST',executeBody(p));
      await waitOn(holder,/products|b2b_external_import_prepare/i);
      const withdrawal = await pool.connect();
      try {
        await withdrawal.query('BEGIN');
        await withdrawal.query("SET LOCAL statement_timeout='1500ms'");
        if (mutation==='revoke') await withdrawal.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[buyer,credential.id]);
        else if (mutation==='expiry') await withdrawal.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[buyer,credential.id]);
        else await withdrawal.query('UPDATE api_keys SET scopes=$3::text[] WHERE tenant_id=$1 AND id=$2',[buyer,credential.id,writeScopes.filter(s=>s!=='integrations:write')]);
        await withdrawal.query('COMMIT');
      } finally { await withdrawal.query('ROLLBACK');withdrawal.release(); }
      await holder.query('ROLLBACK');
      const denied = await pending;
      assert.equal(denied.statusCode,mutation==='scope'?403:401,denied.body);
      assert.equal(denied.headers['cache-control'],'no-store');
      assert.deepEqual(await snapshot(false,true),before);
    } finally {
      await holder.query('ROLLBACK');holder.release();if(pending)await pending;
    }
  }
});

function assertNoFinancialProjection(value:any,path='response') {
  if (Array.isArray(value)) { value.forEach((x,index)=>assertNoFinancialProjection(x,path+'['+index+']'));return; }
  if (!value || typeof value!=='object') return;
  for (const [key,child] of Object.entries(value)) {
    const financial = key.endsWith('_minor') || [
      'total','shipping_cost','paid_amount','price','unit_price','line_total','payment_balance',
      'received','refunded','amount_due','amount_paid','amount','balance','net','credit',
    ].includes(key);
    // Page metadata is a count, not the financial total in source/order snapshots.
    if (financial && !(key==='total' && path.endsWith('.meta'))) assert(child==null,'Financial field disclosed at '+path+'.'+key);
    assertNoFinancialProjection(child,path+'.'+key);
  }
}

test('viewer and operator source, frozen preview and history projections contain no nested source or historical financial amounts and cause no writes',async()=>{
  const f = await setup(), p = await preview(f);
  assert.equal(p.source.total,4200);
  assert.equal(p.rows[0].line_total,2000);
  const viewer = (await pool.query("SELECT id FROM users WHERE email='viewer@demo.local'")).rows[0];
  assert(viewer);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'viewer')",[buyer,viewer.id]);
  for (const role of ['viewer','operator']) {
    await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2',[buyer,viewer.id,role]);
    const cookie = await enter('viewer@demo.local',buyer), before = await snapshot();
    for (const path of [
      '/imports/'+f.inbound.id+'/external-intent-source',
      '/import-external-intent-previews/'+p.id,
      '/import-external-intent-previews',
    ]) {
      const response = await request(path,'GET',undefined,cookie);
      assert.equal(response.statusCode,200,response.body);
      assert.equal(response.headers['cache-control'],'no-store');
      const result = response.json();
      assert.equal(result.can_read_value,false);
      assert.equal(result.can_manage,false);
      assertNoFinancialProjection(result);
      if (path.endsWith('/external-intent-source')) assert.equal(result.source.lines.length,2);
      if (path.endsWith('/'+p.id)) assert.equal(result.preview.rows.length,2);
      if (path==='/import-external-intent-previews') assert(result.data.some((row:Row)=>row.id===p.id));
    }
    assert.deepEqual(await snapshot(),before);
  }
});

test('genuine current-transaction source certificate cannot certify a previously imported source order or expose private certificate rows',async()=>{
  const f = await setup();
  const document = await ok('/warehouse-documents','POST', {
    kind:'receipt',warehouse_id:buyerWarehouse,reference:'Own127B prior ordinary import',note:'',
    lines:[{product_id:f.product.id,quantity:3,location:'OWN127B-PRIOR'}],
  });
  await ok('/warehouse-documents/'+document.id+'/post','POST',{version:document.version});
  const ordinary = await ok('/imports/'+f.inbound.id+'/commit','POST', {
    warehouse_id:buyerWarehouse,expected_hash:f.inbound.source_hash,
  });
  assert.equal(ordinary.items.length,2);
  const raw = structuredClone(f.raw);
  raw.id = 'gid://shopify/Order/7801272'; raw.name = '#OWN127B-SECOND';
  raw.lineItems.nodes[0].id = 'gid://shopify/LineItem/78012721';
  raw.lineItems.nodes[1].id = 'gid://shopify/LineItem/78012722';
  transport.state.raw = raw;
  f.raw = raw;
  f.inbound = (await ok('/integrations/'+f.channel.id+'/stage-orders','POST',{data:[raw]})).data[0];
  f.body = {
    ...f.body,client_key:randomUUID(),expected_source_hash:f.inbound.source_hash,
    allocations:raw.lineItems.nodes.map((i:Row)=>({remote_line_id:i.id,local_quantity:0,external_quantity:i.quantity,unassigned_quantity:0,link_id:f.link.id})),
  };
  const p = await preview(f), before = await snapshot();
  let preparedReached = false;
  await assert.rejects(tenantTx(buyer,async c=>{
    const actor = {tenantId:buyer,userId:buyerUser,role:'admin' as const,source:'manual' as const};
    await externalImportAdmissionInTx(c,actor);
    const inbound = (await c.query('SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE',[f.inbound.id])).rows[0];
    const channel = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE',[f.channel.id])).rows[0];
    const prepared = await prepareB2bExternalImportInTx(c,actor,inbound,channel,
      normalizeExternalImportOrder(channel,inbound.raw),buyerWarehouse,{...executeBody(p),preview_id:p.id});
    assert.match(prepared.certificate_id,/^[0-9a-f-]{36}$/);
    assert.equal((await c.query('SELECT b2b_external_import_admitted($1) admitted',[p.id])).rows[0].admitted,true);
    preparedReached = true;
    await c.query('SELECT b2b_external_import_certify($1,$2)',[prepared.certificate_id,ordinary.id]);
  },{purchasingAdmission:true,wmsAdmission:'read'}),(error:any)=>error.code==='23514');
  assert(preparedReached,'A real valid prepared certificate must precede the forged attachment');
  assert.deepEqual(await snapshot(),before);
  await assert.rejects(tenantTx(buyer,c=>c.query('SELECT * FROM b2b_external_import_certificates')),
    (error:any)=>error.code==='42501');
});

test('source/PIM drift and exact-key collisions reject atomically rather than changing approved historic amounts or allocations',async()=>{
  const f = await setup(), p = await preview(f);
  await ok('/products/'+f.product.id,'PATCH',{
    ...f.product,name:'Own PIM snapshot changed after source approval',
  });
  const changed = await snapshot();
  const stale = await execute(p);
  assert.equal(stale.statusCode,409,stale.body);
  assert.deepEqual(await snapshot(),changed);
  f.body = {...f.body,client_key:randomUUID()};
  const fresh = await preview(f), body = executeBody(fresh);
  const response = await execute(fresh,body);
  assert.equal(response.statusCode,201,response.body);
  const approved = await snapshot();
  const collision = await execute(fresh,{...body,scope_hash:'0'.repeat(64)});
  assert.equal(collision.statusCode,409,collision.body);
  assert.deepEqual(await snapshot(),approved);
  const pReplay = await request('/imports/'+f.inbound.id+'/external-intent-previews','POST',{
    ...f.body,allocations:f.body.allocations.map((r:Row)=>({...r,external_quantity:0,unassigned_quantity:r.external_quantity,link_id:null})),
  });
  assert.equal(pReplay.statusCode,409,pReplay.body);
  assert.deepEqual(await snapshot(),approved);
});

test('read-only source handlers deny malformed writes before parse and genuine missing110 leaves ordinary source replay and manual109 available; a torn 110 table refuses startup',async()=>{
  const f = await setup(), p = await preview(f), response = await execute(p);
  assert.equal(response.statusCode,201,response.body);
  const order = response.json().order;
  let before = await snapshot();
  let readonly:Awaited<ReturnType<typeof buildApp>>|undefined;
  try {
    readonly = await buildApp({readOnly:true,integrationTransport:transport.transport});
    const mainSession = await request('/import-external-intent-previews/'+p.id,'GET',undefined,buyerCookie,readonly);
    assert.equal(mainSession.statusCode,401,'The main session cannot authenticate to the readonly copy');
    const readonlyCookie = await enter('other@demo.local',buyer,readonly);
    // Authenticate the copy before measuring read-only business effects.
    before = await snapshot();
    for (const path of ['/imports/'+f.inbound.id+'/external-intent-previews','/import-external-intent-previews/'+p.id+'/execute']) {
      const denied: LightMyRequestResponse = await readonly.inject({url:'/api'+path,method:'POST',payload:'{"invalid":',headers:{cookie:readonlyCookie,'content-type':'application/json'}});
      assert.equal(denied.statusCode,423,denied.body);
      assert.equal(denied.headers['cache-control'],'no-store');
    }
    const read = await request('/import-external-intent-previews/'+p.id,'GET',undefined,readonlyCookie,readonly);
    assert.equal(read.statusCode,200,read.body); assert.equal(read.json().read_only,true);
    assert.deepEqual(await snapshot(),before);
  } finally { await readonly?.close(); }
  // Rename one capability function only in this guarded isolated DB; restore unconditionally.
  const renamed = 'b2b_external_import_certify_own_unavailable';
  await pool.query('ALTER FUNCTION b2b_external_import_certify(uuid,uuid) RENAME TO '+renamed);
  let legacy:Awaited<ReturnType<typeof buildApp>>|undefined;
  try {
    legacy = await buildApp({integrationTransport:transport.transport});
    const unsupported = await request('/import-external-intent-previews/'+p.id,'GET',undefined,buyerCookie,legacy);
    assert.equal(unsupported.statusCode,503,unsupported.body);
    const manual = await request('/b2b/external-order-intents/options','GET',undefined,buyerCookie,legacy);
    assert.equal(manual.statusCode,200,manual.body); assert.equal(manual.json().available,true);
    const replay = await request('/imports/'+f.inbound.id+'/commit','POST',{
      warehouse_id:buyerWarehouse,expected_hash:f.inbound.source_hash,
    },buyerCookie,legacy);
    assert.equal(replay.statusCode,200,replay.body); assert.equal(replay.json().id,order.id);
    assert.deepEqual(await snapshot(),before);
  } finally {
    try { await legacy?.close(); }
    finally { await pool.query('ALTER FUNCTION '+renamed+'(uuid,uuid) RENAME TO b2b_external_import_certify'); }
  }
  // A torn 110 table cannot exist on a migrated database: pim_dictionary_valid() covers it, so the application does
  // not start (503 incomplete PIM module) and nothing is written; the installed 109 manual path is not reachable torn.
  await pool.query('ALTER TABLE b2b_external_import_certificates RENAME TO b2b_external_import_certificates_own_unavailable');
  try {
    const physical = await snapshot(true);
    await assert.rejects(() => buildApp({integrationTransport:transport.transport}),
      (e:any) => e?.status===503 && /Niekompletny moduł PIM/.test(e.message));
    assert.deepEqual(await snapshot(true),physical);
  } finally {
    await pool.query('ALTER TABLE b2b_external_import_certificates_own_unavailable RENAME TO b2b_external_import_certificates');
  }
});
