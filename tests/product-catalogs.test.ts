import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';

// Authored for root's isolated native harness. No provider or primary DB proof implied.
assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: async () => { throw Error('Catalog tests cannot call providers'); } }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
const prefix = '/product-catalogs';
async function preview(f: any, body: any, key?: any) { return (await f.ok(prefix + '/previews', 'POST', body, 201, key)).preview; }
async function commit(f: any, p: any, body = productCatalogConsent(p)) { return f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', body, 201); }
function businessEqual(a: Record<string, any[]>, b: Record<string, any[]>) {
  assert.deepEqual(Object.keys(a), Object.keys(b));
  for (const name of Object.keys(a)) if (!name.startsWith('product_catalog_') && name !== 'product_catalogs' && name !== 'audit_events') assert.deepEqual(b[name], a[name], name);
}
async function updateBody(f: any, catalog: any, extra: any = {}) {
  const head = (await f.ok(prefix + '/' + catalog.id)).catalog;
  return { client_key: randomUUID(), kind: 'update', catalog_id: head.id, version: String(head.version), settings: {
    name: head.name, active: head.active, languages: head.languages, default_language: head.default_language,
    warehouse_ids: head.warehouse_ids, price_list_ids: head.price_list_ids, ...extra,
  } };
}
async function waitOn(c: PoolClient) {
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const rows = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rows;
    if (rows.some(r => /product_catalog/i.test(r.query))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Catalog commit must really wait on own locked catalog');
}

test('OFF and ON create/commit preserve actual stock, costs, recipes, aliases, orders and RMA; exact replay has no new rows', async () => {
  for (const on of [false, true]) {
    const f = await productCatalogFixture(app, on), beforeRows = await productCatalogFacts(f.tenant);
    const body = productCatalogCreate(f, { languages: ['pt-br', 'pl', 'en'] });
    const p = await preview(f, body); assert.equal(p.ready, true); assert.deepEqual(p.blockers, []);
    const afterPreview = await productCatalogFacts(f.tenant);
    const replayPreview = await f.ok(prefix + '/previews', 'POST', body);
    assert.equal(replayPreview.reused, true); assert.deepEqual(replayPreview.preview, p);
    assert.deepEqual(await productCatalogFacts(f.tenant), afterPreview);
    const consent = productCatalogConsent(p), result = await commit(f, p, consent);
    assert.equal(result.reused, false); assert.equal(String(result.catalog.version), '1');
    assert.equal(result.catalog.is_default, false);
    assert.deepEqual([...result.catalog.languages].sort(), ['en', 'pl', 'pt-br']);
    const accepted = await productCatalogFacts(f.tenant);
    const replay = await f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', consent);
    assert.equal(replay.reused, true); assert.deepEqual(replay.operation, result.operation);
    assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
    assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', { ...consent, scope_hash: '0'.repeat(64) })).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(f.tenant), accepted); businessEqual(beforeRows, accepted);
    const order = await f.ok('/orders/' + f.order.id), rma = await f.ok('/returns/' + f.rma.id);
    assert.deepEqual(order.items, f.order.items); assert.equal(rma.state, 'requested');
  }
});

test('two complete previews from one catalog version permit one commit and reject the stale whole graph', async () => {
  const f = await productCatalogFixture(app), initial = await preview(f, productCatalogCreate(f)), initialConsent = productCatalogConsent(initial), made = await commit(f, initial, initialConsent);
  const body = await updateBody(f, made.catalog, { name: 'Own first CAS winner' });
  const a = await preview(f, body), b = await preview(f, { ...body, client_key: randomUUID(), settings: { ...body.settings, name: 'Own stale CAS loser' } });
  const winner = await commit(f, a), accepted = await productCatalogFacts(f.tenant);
  assert.equal(String(winner.catalog.version), '2');
  assert.equal((await f.request(prefix + '/previews/' + b.id + '/commit', 'POST', productCatalogConsent(b))).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  const historic = await f.ok(prefix + '/operations/' + made.operation.id);
  assert.equal(String(historic.operation.after.version), '1');
  const oldReplay = await f.ok(prefix + '/previews/' + initial.id + '/commit', 'POST', initialConsent);
  assert.equal(oldReplay.reused, true); assert.deepEqual(oldReplay.operation, made.operation);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
});

test('catalog configuration cannot detach genuine OFF/ON active holds or invent stock in an unassigned warehouse', async () => {
  for (const on of [false, true]) {
    const f = await productCatalogFixture(app, on);
    const order = await f.ok('/orders', 'POST', { customer_name: 'Own still held catalog order', email: 'catalog-hold@example.test', warehouse_id: f.warehouse, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0, items: [{ product_id: f.product.id, quantity: 1 }] }, 201);
    const held = (await pool.query("SELECT product_id,quantity,state FROM reservations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id", [f.tenant, order.id])).rows;
    assert.equal(held.length, on ? 2 : 1); assert(held.every(r => r.state === 'active' && r.quantity > 0));
    const p = await preview(f, await updateBody(f, f.defaultCatalog, { warehouse_ids: [f.spare.id] }));
    assert.equal(p.ready, false); assert(p.blockers.includes('WH_STOCK:' + f.warehouse));
    const beforeRows = await productCatalogFacts(f.tenant);
    assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p))).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
    const second = (await commit(f, await preview(f, productCatalogCreate(f)))).catalog;
    const beforeProduct = await productCatalogFacts(f.tenant);
    const bad = await f.request('/products', 'POST', { name: 'Own forbidden physical source', sku: 'PC-WH-' + randomUUID(), catalog_id: second.id, warehouse_id: f.warehouse, kind: 'simple', quantity: 0, price: 0 });
    assert.equal(bad.statusCode, 409); assert.deepEqual(await productCatalogFacts(f.tenant), beforeProduct);
  }
});

test('foreign warehouse/list/catalog and preview IDs cannot partially configure or disclose another firm', async () => {
  const a = await productCatalogFixture(app), b = await productCatalogFixture(app);
  const beforeA = await productCatalogFacts(a.tenant), beforeB = await productCatalogFacts(b.tenant);
  for (const extra of [{ warehouse_ids: [a.spare.id, b.warehouse] }, { price_list_ids: [a.list.id, b.list.id] }]) {
    assert.equal((await a.request(prefix + '/previews', 'POST', productCatalogCreate(a, extra))).statusCode, 404);
    assert.deepEqual(await productCatalogFacts(a.tenant), beforeA); assert.deepEqual(await productCatalogFacts(b.tenant), beforeB);
  }
  const p = await preview(a, productCatalogCreate(a)), own = await productCatalogFacts(a.tenant);
  assert.equal((await b.request(prefix + '/previews/' + p.id)).statusCode, 404);
  assert.equal((await b.request(prefix + '/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p))).statusCode, 404);
  const update = { client_key: randomUUID(), kind: 'update', catalog_id: a.defaultCatalog.id, version: '1', settings: productCatalogCreate(b).settings };
  assert.equal((await b.request(prefix + '/previews', 'POST', update)).statusCode, 404);
  assert.deepEqual(await productCatalogFacts(a.tenant), own); assert.deepEqual(await productCatalogFacts(b.tenant), beforeB);
});

test('invalid default language, duplicate resource bindings, overbound locale list and false consent are all-or-none', async () => {
  const f = await productCatalogFixture(app), initial = await productCatalogFacts(f.tenant);
  for (const extra of [{ languages: ['en'], default_language: 'pl' }, { languages: ['PL???'] }, { languages: Array.from({ length: 65 }, (_, i) => 'en-x' + String(i).padStart(2, '0')) }, { warehouse_ids: [f.spare.id, f.spare.id] }, { price_list_ids: [f.list.id, f.list.id] }, { warehouse_ids: Array.from({ length: 101 }, () => randomUUID()) }, { price_list_ids: Array.from({ length: 101 }, () => randomUUID()) }]) {
    assert.equal((await f.request(prefix + '/previews', 'POST', productCatalogCreate(f, extra))).statusCode, 422);
    assert.deepEqual(await productCatalogFacts(f.tenant), initial);
  }
  const p = await preview(f, productCatalogCreate(f)), beforeConsent = await productCatalogFacts(f.tenant);
  assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', { ...productCatalogConsent(p), confirmed: false })).statusCode, 422);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeConsent);
});

test('current admin and key must survive the actual catalog row wait before committing any configuration', async () => {
  for (const revokedKey of [false, true]) {
    const f = await productCatalogFixture(app), made = await commit(f, await preview(f, productCatalogCreate(f)));
    const key = revokedKey ? await f.ok('/developer/keys', 'POST', { name: 'Own catalogs late wait key', scopes: ['products:read', 'products:write'] }, 201) : undefined;
    const p = await preview(f, await updateBody(f, made.catalog, { name: 'Own held version' }), key);
    const beforeRows = await productCatalogFacts(f.tenant), held = await pool.connect();
    let pending: ReturnType<typeof f.request> | undefined;
    try {
      await held.query('BEGIN'); await held.query('SELECT id FROM product_catalogs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, made.catalog.id]);
      pending = f.request(prefix + '/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), key);
      await waitOn(held);
      if (key) await pool.query('UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
      else await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
      await held.query('ROLLBACK'); assert.equal((await pending).statusCode, key ? 401 : 403);
    } finally {
      await held.query('ROLLBACK'); held.release(); await pending?.catch(() => undefined);
      if (key) await pool.query('UPDATE api_keys SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
      else await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  }
});

test('raw app writes cannot rewrite catalog membership or cross catalog variant/bundle relations', async () => {
  const f = await productCatalogFixture(app), second = (await commit(f, await preview(f, productCatalogCreate(f)))).catalog;
  const beforeRows = await productCatalogFacts(f.tenant);
  await assert.rejects(tenantTx(f.tenant, c => c.query('UPDATE products SET catalog_id=$1 WHERE tenant_id=$2 AND id=$3', [second.id, f.tenant, f.product.id])), (e: any) => e.code === '23514');
  for (const table of ['product_catalogs', 'product_catalog_warehouses', 'product_catalog_price_lists', 'product_catalog_languages', 'product_catalog_previews', 'product_catalog_operations', 'product_catalog_admissions']) {
    await assert.rejects(tenantTx(f.tenant, c => c.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.tenant])), (e: any) => e.code === '42501');
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  const cross = await f.request('/products', 'POST', { name: 'Own invalid mixed recipe', sku: 'PC-' + randomUUID(), kind: 'bundle', price: 1000, vat: 23, catalog_id: second.id, warehouse_id: f.spare.id, quantity: 0, components: [{ product_id: f.product.id, quantity: 1 }] });
  assert.equal(cross.statusCode, 409); assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  const group = await f.ok('/products', 'POST', { name: 'Own catalog group', sku: 'PC-G-' + randomUUID(), kind: 'group', catalog_id: second.id, warehouse_id: f.spare.id, quantity: 0, price: 0 }, 201);
  const groupBefore = await productCatalogFacts(f.tenant);
  const variant = await f.request('/products', 'POST', { name: 'Own invalid cross catalog variant', sku: 'PC-V-' + randomUUID(), kind: 'variant', catalog_id: f.defaultCatalog.id, parent_id: group.id, warehouse_id: f.warehouse, quantity: 0, price: 0 });
  assert.equal(variant.statusCode, 409); assert.deepEqual(await productCatalogFacts(f.tenant), groupBefore);
});

test('removing a warehouse with actual stock or WMS layers blocks configuration and preserves historical RMA sources', async () => {
  for (const on of [false, true]) {
    const f = await productCatalogFixture(app, on);
    const body = await updateBody(f, f.defaultCatalog, { warehouse_ids: [f.spare.id] });
    const p = await preview(f, body); assert.equal(p.ready, false);
    assert(p.blockers.includes('WH_STOCK:' + f.warehouse));
    assert(p.blockers.includes('WH_HISTORY:' + f.warehouse));
    if (on) assert(p.blockers.includes('WH_WMS:' + f.warehouse));
    const beforeRows = await productCatalogFacts(f.tenant);
    assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p))).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
    const actual = await f.ok('/returns/' + f.rma.id); assert.deepEqual(actual.items, f.rma.items);
  }
});

test('an empty physical warehouse with a genuine open purchase still cannot be detached from its catalog', async () => {
  const f = await productCatalogFixture(app), empty = await f.ok('/warehouses', 'POST', { name: 'Own other empty source', code: 'PC-E-' + randomUUID().slice(0, 8) });
  const created = await commit(f, await preview(f, productCatalogCreate(f, { warehouse_ids: [f.spare.id, empty.id] })));
  const product = await f.ok('/products', 'POST', { name: 'Own future purchase catalog position', sku: 'PC-PO-' + randomUUID(), kind: 'simple', catalog_id: created.catalog.id, warehouse_id: f.spare.id, quantity: 0, price: 0 }, 201);
  const supplier = await f.ok('/suppliers', 'POST', { name: 'Own catalog stock supplier', code: 'PC-' + randomUUID() }, 201);
  const draft = await f.ok('/purchase-orders', 'POST', { supplier_id: supplier.id, warehouse_id: f.spare.id, currency: 'PLN', lines: [{ product_id: product.id, quantity: 2, unit_cost: 1000 }] }, 201);
  const purchase = await f.ok('/purchase-orders/' + draft.id + '/place', 'POST', { version: draft.version });
  assert.equal(purchase.state, 'ordered');
  const stocks = (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [f.tenant, product.id])).rows;
  assert.equal(stocks.length, 1);
  assert(stocks.every(row => row.on_hand === 0 && row.reserved === 0));
  assert.equal((await pool.query('SELECT count(*)::int n FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2', [f.tenant, product.id])).rows[0].n, 0);
  const p = await preview(f, await updateBody(f, created.catalog, { warehouse_ids: [empty.id] }));
  assert.equal(p.ready, false); assert(p.blockers.includes('WH_OPEN_PO:' + f.spare.id));
  const beforeRows = await productCatalogFacts(f.tenant);
  assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p))).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});
