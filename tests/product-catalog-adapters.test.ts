import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogCreate, productCatalogConsent, productCatalogFacts } from './product-catalogs-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: async () => { ++providerCalls; throw Error('No external provider in native catalog adapter tests'); } }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
async function secondCatalog(f: any) {
  const p = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201)).preview;
  return (await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), 201)).catalog;
}
async function newProduct(f: any, catalog: any, extra: any = {}) {
  return f.ok('/products', 'POST', { catalog_id: catalog.id, warehouse_id: f.spare.id, sku: 'PC157-' + randomUUID(), name: 'Own second pool physical product', kind: 'simple', price: 1000, quantity: 0, location: 'PC157', ...extra }, 201);
}
async function stock(f: any, id: string) {
  return (await f.ok('/products/' + id)).stock.find((s: any) => s.warehouse_id === f.spare.id);
}

test('two price-list births queue behind a real catalog lock and enroll exactly once without shared-lock upgrade deadlock', async () => {
  const f = await productCatalogFixture(app);
  const before = (await f.ok('/product-catalogs/' + f.defaultCatalog.id)).catalog;
  const blocker = await pool.connect();
  const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  const requests: Promise<any>[] = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + f.tenant]);
    requests.push(...['A', 'B'].map(s => f.request('/price-lists', 'POST', { name: 'Concurrent own birth ' + s + ' ' + randomUUID(), currency: 'PLN' })));
    let waiting = 0;
    for (let n = 0; n < 100; ++n) {
      waiting = Number((await pool.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory' AND $1::int=ANY(pg_blocking_pids(pid))", [blockerPid])).rows[0].n);
      if (waiting >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 2, 'Both actual API transactions must wait before the blocker releases');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  const results = await Promise.all(requests);
  for (const result of results) assert.equal(result.statusCode, 201, result.body);
  const ids = results.map(r => r.json().id);
  assert.equal(new Set(ids).size, 2);
  const after = (await f.ok('/product-catalogs/' + f.defaultCatalog.id)).catalog;
  assert.equal(BigInt(after.version), BigInt(before.version) + 2n);
  assert(ids.every(id => after.price_list_ids.includes(id)));
  assert.equal(Number((await pool.query('SELECT count(*) n FROM product_catalog_price_lists WHERE tenant_id=$1 AND catalog_id=$2 AND price_list_id=ANY($3::uuid[])', [f.tenant, f.defaultCatalog.id, ids])).rows[0].n), 2);
});

test('legacy CSV freezes explicit catalog and rejects aliases from another pool without changing its product', async () => {
  const f = await productCatalogFixture(app), catalog = await secondCatalog(f);
  const code = 'PC157-CSV-' + randomUUID();
  const p = await f.ok('/catalog/imports/preview', 'POST', { catalog_id: catalog.id, warehouse_id: f.spare.id, csv: 'sku;name;price;quantity\n' + code + ';Own scoped CSV;12.50;4' });
  assert.equal(p.valid, true);
  const result = await f.ok('/catalog/imports/' + p.id + '/apply', 'POST');
  assert.equal(result.created, 1);
  const own = (await f.ok('/products?catalog_id=' + catalog.id)).data;
  assert.equal(own.length, 1); assert.equal(own[0].sku, code); assert.equal(own[0].catalog_id, catalog.id);
  assert.equal((await stock(f, own[0].id)).on_hand, 4);
  const defaultPool = (await f.ok('/products?catalog_id=' + f.defaultCatalog.id)).data;
  assert(!defaultPool.some((p: any) => p.id === own[0].id));
  const oldCode = f.product.sku;
  const current = await f.ok('/products/' + f.product.id);
  await f.ok('/products/' + current.id, 'PATCH', { ...current, sku: 'PC157-RENAMED-' + randomUUID() });
  const accepted = await productCatalogFacts(f.tenant);
  const bad = await f.request('/catalog/imports/preview', 'POST', { catalog_id: catalog.id, warehouse_id: f.spare.id, csv: 'sku;name;price\n' + oldCode + ';Wrong pool alias;99.99' });
  assert.equal(bad.statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
});

test('CSV and mapped XML file imports select one pool and reject explicit cross-pool product/parent identities atomically', async () => {
  const f = await productCatalogFixture(app), catalog = await secondCatalog(f);
  const base = { client_key: randomUUID(), catalog_id: catalog.id, warehouse_id: f.spare.id, currency: 'PLN', mode: 'create', identity: 'sku', format: 'csv', content: 'sku,name,price_minor\nPC157-FILE-' + randomUUID() + ',Own file pool,1250' };
  const p = await f.ok('/catalog/file-imports/preview', 'POST', base, 201);
  assert.equal(p.preview.ready, true); assert.equal(p.preview.config.catalog_id, catalog.id);
  const body = { client_key: randomUUID(), scope_hash: p.preview.scope_hash, confirmed: true };
  const execution = await f.ok('/catalog/file-imports/previews/' + p.preview.id + '/execute', 'POST', body, 201);
  const created = await f.ok('/products/' + execution.rows[0].product_id);
  assert.equal(created.catalog_id, catalog.id);
  const accepted = await productCatalogFacts(f.tenant);
  assert.equal((await f.ok('/catalog/file-imports/previews/' + p.preview.id + '/execute', 'POST', body)).reused, true);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  const wrong = await f.request('/catalog/file-imports/preview', 'POST', { ...base, client_key: randomUUID(), mode: 'update', identity: 'id', content: 'id,name\n' + f.product.id + ',Cross pool explicit identity' });
  assert.equal(wrong.statusCode, 409); assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  const xml = await f.ok('/catalog/file-imports/preview', 'POST', { ...base, client_key: randomUUID(), format: 'xml', mode: 'update', content: '<feed><item code="' + created.sku + '"><name>Own mapped XML changed</name></item></feed>', mapping: {}, xml_mapping: { record_path: '/feed/item', fields: { sku: { path: '@code', value_type: 'text' }, name: { path: 'name', value_type: 'text' } } } }, 201);
  assert.equal(xml.preview.ready, true);
  await f.ok('/catalog/file-imports/previews/' + xml.preview.id + '/execute', 'POST', { client_key: randomUUID(), scope_hash: xml.preview.scope_hash, confirmed: true }, 201);
  assert.equal((await f.ok('/products/' + created.id)).name, 'Own mapped XML changed');
});

test('new nondefault catalog stock, assigned pricing, paid reservation, picking, parcel, document and partial return work OFF and ON', async () => {
  for (const on of [false, true]) {
    const f = await productCatalogFixture(app, on), catalog = await secondCatalog(f), product = await newProduct(f, catalog);
    if (on) {
      const policy = (await f.ok('/wms-lots')).policy;
      await f.ok('/wms-lots/receipts', 'POST', { client_key: randomUUID(), policy_version: String(policy.version), warehouse_id: f.spare.id, stock_versions: [{ product_id: product.id, warehouse_id: f.spare.id, version: String((await stock(f, product.id)).version) }], note: 'Own nondefault pool receipt', confirmed: true, lines: [{ product_id: product.id, location: 'PC157', quantity: 4, lot_code: 'PC157-' + randomUUID(), unit_cost_minor: '101', currency: 'PLN' }] }, 201);
    } else {
      const receipt = await f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: f.spare.id, lines: [{ product_id: product.id, quantity: 4, location: 'PC157' }] }, 201);
      await f.ok('/warehouse-documents/' + receipt.id + '/post', 'POST', { version: receipt.version });
    }
    assert.equal((await stock(f, product.id)).on_hand, 4);
    await f.ok('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version, items: [{ product_id: product.id, price: 1501 }] });
    const wrongList = await f.ok('/price-lists', 'POST', { name: 'Own unassigned new list ' + randomUUID(), currency: 'PLN', fallback: true }, 201);
    const beforeBad = await productCatalogFacts(f.tenant);
    assert.equal((await f.request('/pricing/quote', 'POST', { price_list_id: wrongList.id, product_ids: [product.id] })).statusCode, 409);
    assert.equal((await f.request('/orders', 'POST', { customer_name: 'Own rejected pool WH', email: 'reject@example.test', warehouse_id: f.warehouse, items: [{ product_id: product.id, quantity: 1 }] })).statusCode, 409);
    await assert.rejects(tenantTx(f.tenant, c => c.query('INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,0)', [f.tenant, f.warehouse, product.id])), (e: any) => e.code === '23514');
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeBad);
    let order = await f.ok('/orders', 'POST', { customer_name: 'Own nondefault buyer', email: 'catalog157@example.test', warehouse_id: f.spare.id, price_list_id: f.list.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0, address: { street: 'Testowa 157', city: 'Warszawa', postal_code: '00-157', country: 'PL', phone: '500000157' }, items: [{ product_id: product.id, quantity: 2 }] }, 201);
    order = await f.ok('/orders/' + order.id); assert.equal(order.total, 3002); assert.equal((await stock(f, product.id)).reserved, 2);
    await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: order.total, currency: 'PLN', method: 'other', reference: 'Synthetic local test declaration', confirmed: true });
    await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
    if (on) {
      const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations');
      for (const a of allocations.data) for (let i = 0; i < a.quantity; ++i) await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: product.sku, location: a.location, layer_id: a.layer_id });
    } else for (let i = 0; i < 2; ++i) await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: product.sku, location: 'PC157' });
    await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
    await f.ok('/orders/' + order.id + '/ship-demo', 'POST', {});
    order = await f.ok('/orders/' + order.id); assert.equal(order.status, 'shipped'); assert.equal((await stock(f, product.id)).on_hand, 2);
    const document = await f.ok('/orders/' + order.id + '/documents', 'POST', { kind: 'invoice' });
    assert(document.id); // Local demo document; no fiscal provider claim.
    let rma = await f.ok('/orders/' + order.id + '/returns', 'POST', { client_key: randomUUID(), reason: 'Own nondefault partial inspection', shipping_refund: 0, items: [{ item_id: order.items[0].id, quantity: 1 }] }, 201);
    rma = await f.ok('/returns/' + rma.id);
    const receive: any = { version: Number(rma.version), note: 'Own nondefault catalog return', shipping_refund: 0, items: [{ item_id: rma.items[0].item_id, accepted: 1, restocked: 1 }] };
    if (on) {
      const issued = (await pool.query('SELECT id,product_id,value_minor FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY id', [f.tenant, order.id])).rows;
      assert.equal(issued.length, 1); assert.equal(issued[0].value_minor, '202');
      receive.wms_lots = { client_key: randomUUID(), policy_version: String((await f.ok('/wms-lots')).policy.version), stock_versions: [{ product_id: product.id, warehouse_id: f.spare.id, version: String((await stock(f, product.id)).version) }], picks: [{ issue_fragment_id: issued[0].id, quantity: 1, location: 'PC157' }] };
    }
    const accepted = await f.ok('/returns/' + rma.id + '/receive', 'POST', receive); assert.equal(accepted.refund_amount, 1501);
    assert.equal((await stock(f, product.id)).on_hand, 3); assert.equal((await stock(f, product.id)).reserved, 0);
    const snapshot = await productCatalogFacts(f.tenant);
    await f.ok('/returns/' + rma.id + '/receive', 'POST', receive);
    assert.deepEqual(await productCatalogFacts(f.tenant), snapshot);
    assert.equal((await f.ok('/products/' + product.id)).catalog_id, catalog.id);
  }
  assert.equal(providerCalls, 0);
});

test('a requested return to another empty warehouse retains that historical receiving assignment', async () => {
  const f = await productCatalogFixture(app);
  const item = f.order.items.find((i: any) => i.line_total !== 1000);
  const requested = await f.ok('/orders/' + f.order.id + '/returns', 'POST', { client_key: randomUUID(), warehouse_id: f.spare.id, reason: 'Own already promised alternate receiving site', shipping_refund: 0, items: [{ item_id: item.id, quantity: 1 }] }, 201);
  assert.equal((await f.ok('/returns/' + requested.id)).warehouse_id, f.spare.id);
  const head = (await f.ok('/product-catalogs/' + f.defaultCatalog.id)).catalog;
  const p = (await f.ok('/product-catalogs/previews', 'POST', { client_key: randomUUID(), kind: 'update', catalog_id: head.id, version: String(head.version), settings: { name: head.name, active: head.active, languages: head.languages, default_language: head.default_language, warehouse_ids: [f.warehouse], price_list_ids: head.price_list_ids } }, 201)).preview;
  assert.equal(p.ready, false); assert(p.blockers.includes('WH_HISTORY:' + f.spare.id));
  const accepted = await productCatalogFacts(f.tenant);
  assert.equal((await f.request('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p))).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
});
