import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts } from './product-catalogs-fixture';
import { warehouseInventoryPoliciesAvailable } from '../server/warehouse-inventory-policies';
import { listProducts } from '../server/catalog';
import { inventoryQuery, listInventory } from '../server/inventory';
import { b2bCatalogPage } from '../server/b2b';
import { offerInput, desiredOffer } from '../server/offers';

// Root executes only in its disposable host-native test database. No providers,
// raw stock seeding, shipment workers or primary instance operations.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_[a-zA-Z0-9_]+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  assert.equal(await warehouseInventoryPoliciesAvailable(), true);
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('No provider in warehouse sellability tests'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
type Fixture = Awaited<ReturnType<typeof productCatalogFixture>>;

async function receipt(f: Fixture, on: boolean, warehouse: string, lines: Array<{ product_id: string; quantity: number; cost: string }>) {
  if (on) {
    const versions = [];
    for (const line of lines) {
      const detail = await f.ok('/products/' + line.product_id);
      const stock = detail.stock.find((s: any) => s.warehouse_id === warehouse);
      versions.push({ warehouse_id: warehouse, product_id: line.product_id, version: String(stock?.version ?? '0') });
    }
    const result = await f.ok('/wms-lots/receipts', 'POST', {
      client_key: randomUUID(), policy_version: '1', warehouse_id: warehouse,
      stock_versions: versions, confirmed: true, note: 'Genuine local custody fixture PZ',
      lines: lines.map(line => ({ product_id: line.product_id, quantity: line.quantity,
        location: 'SELL161', lot_code: 'SELL-' + randomUUID(), unit_cost_minor: line.cost, currency: 'PLN' })),
    }, 201);
    assert.equal(result.reused, false);
    assert.equal(result.operation.kind, 'receipt');
  } else {
    const document = await f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: warehouse,
      reference: 'Genuine local custody fixture PZ', lines: lines.map(line => ({ product_id: line.product_id, quantity: line.quantity, location: 'SELL161' })) }, 201);
    const posted = await f.ok('/warehouse-documents/' + document.id + '/post', 'POST', { version: document.version });
    assert.equal(posted.status, 'posted');
  }
}
async function sellabilityFixture(on: boolean) {
  const f = await productCatalogFixture(app, on);
  const p = (await f.ok('/warehouse-inventory-policies/warehouses/' + f.spare.id + '/previews', 'POST', {
    client_key: randomUUID(), version: '0', usage: 'custody', enabled: true,
  }, 201)).preview;
  assert.equal(p.ready, true);
  const policy = (await f.ok('/warehouse-inventory-policies/previews/' + p.id + '/commit', 'POST', {
    client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true,
  }, 201)).operation.after;
  assert.deepEqual(policy, { usage: 'custody', enabled: true, version: '1' });
  const products = [];
  for (const name of ['A', 'B']) products.push(await f.ok('/products', 'POST', {
    name: 'Own sellability ' + name, sku: 'SELL161-' + randomUUID(), kind: 'simple',
    price: 777, vat: 23, quantity: 0, warehouse_id: f.warehouse, location: 'SELL161',
  }, 201));
  const [a, b] = products;
  const bundle = await f.ok('/products', 'POST', { name: 'Own sellability A1 B2 bundle', sku: 'SELL161-X-' + randomUUID(),
    kind: 'bundle', price: 1554, vat: 23, quantity: 0, warehouse_id: f.warehouse,
    components: [{ product_id: a.id, quantity: 1 }, { product_id: b.id, quantity: 2 }] }, 201);
  await receipt(f, on, f.warehouse, [{ product_id: a.id, quantity: 5, cost: '0' }, { product_id: b.id, quantity: 12, cost: '101' }]);
  await receipt(f, on, f.spare.id, [{ product_id: a.id, quantity: 7, cost: '0' }, { product_id: b.id, quantity: 16, cost: '101' }]);
  const list = await f.ok('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version,
    items: [{ product_id: a.id, price: 777 }, { product_id: bundle.id, price: 1554 }] });
  const address = { street: 'Testowa 161', city: 'Warszawa', postal_code: '00-161', country: 'PL', phone: '500000161' };
  const accounts = [];
  for (const warehouse_id of [f.warehouse, f.spare.id]) {
    const body = { name: 'Own sellability B2B', email: randomUUID() + '@example.test', warehouse_id, price_list_id: f.list.id, address };
    const created = await f.ok('/b2b/accounts', 'POST', body, 201);
    accounts.push(await f.ok('/b2b/accounts/' + created.id, 'PATCH', { ...body, version: created.version, active: true, confirmed: true }));
  }
  return { ...f, a, b, bundle, policy, accounts, address, priceListVersion: list.version };
}
function noCosts(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!['unit_cost_minor', 'value_minor', 'known_minor', 'cost_minor', 'content_encrypted', 'password_hash'].includes(key), 'Restricted reader must not receive financial/private field: ' + key);
    noCosts(child);
  }
}
function redactedWmsCosts(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!['content_encrypted', 'password_hash', 'credentials_encrypted', 'lease_token', 'lease_token_hash'].includes(key), 'Restricted WMS reader must not receive private field: ' + key);
    if (['unit_cost_minor', 'value_minor', 'value_delta', 'known_minor', 'unknown_quantity', 'known_quantity', 'known_delta_minor', 'unknown_delta_quantity', 'cost_minor'].includes(key))
      assert.equal(child, null, 'Restricted WMS financial field must be null, including fixture costs 0 and 101: ' + key);
    else redactedWmsCosts(child);
  }
}

for (const on of [false, true]) test(`genuine ${on ? 'ON' : 'OFF'} receipts preserve custody physically and exclude simple/bundle from sale in every reader`, async () => {
  const f = await sellabilityFixture(on);
  const ids = [f.a.id, f.b.id, f.bundle.id];
  const beforeRows = await productCatalogFacts(f.tenant);
  // Actual backend-local function counters, not a latency or general scale claim.
  await tenantTx(f.tenant, async c => {
    await c.query('RESET ROLE'); await c.query("SET LOCAL track_functions='all'");
    const calls = async () => Number((await c.query(`SELECT coalesce((SELECT calls FROM pg_stat_xact_user_functions
      WHERE funcid='public.warehouse_inventory_policy(uuid,uuid)'::regprocedure),0)::text calls`)).rows[0].calls);
    const warehouseCount = Number((await c.query('SELECT count(*)::int count FROM warehouses WHERE tenant_id=$1', [f.tenant])).rows[0].count);
    assert.equal(warehouseCount, 2, 'Performance fixture has exactly sale and custody warehouses');
    const baseline = await calls(); await c.query('SET LOCAL ROLE dyna_app');
    const products = await listProducts(c, { search: '', limit: 100 });
    assert.equal(products.meta.has_more, false);
    await c.query('RESET ROLE'); const afterProducts = await calls();
    assert.equal(afterProducts - baseline, 2, 'Product and recipe cells share exactly one policy call per warehouse');
    await c.query('SET LOCAL ROLE dyna_app'); await listInventory(c, inventoryQuery.parse({ limit: 100 }));
    await c.query('RESET ROLE'); const afterInventory = await calls();
    assert.equal(afterInventory - afterProducts, 2, 'Inventory rows share exactly one policy call per warehouse');
    await c.query('SET LOCAL ROLE dyna_app');
  });
  for (const [warehouse, expectedA, expectedB, expectedBundle] of [[null, 5, 12, 5], [f.warehouse, 5, 12, 5], [f.spare.id, 0, 0, 0]] as const) {
    const result = await f.ok('/products?limit=100' + (warehouse ? '&warehouse_id=' + warehouse : ''));
    for (const [id, quantity] of [[f.a.id, expectedA], [f.b.id, expectedB], [f.bundle.id, expectedBundle]])
      assert.equal(result.data.find((p: any) => p.id === id)?.available, quantity, 'Selected/combined simple and bundle sellable count');
    assert.equal(result.meta.has_more, false);
    if (!warehouse) assert.equal(result.data.find((p: any) => p.id === f.a.id).on_hand, 12, 'Physical aggregate still contains custody stock');
  }
  const inventory = await f.ok('/inventory?warehouse_id=' + f.spare.id + '&limit=100');
  for (const [id, physical] of [[f.a.id, 7], [f.b.id, 16]]) {
    const row = inventory.data.find((p: any) => p.product_id === id);
    assert(row); assert.equal(row.on_hand, physical); assert.equal(row.reserved, 0);
    assert.equal(row.available, physical); assert.equal(row.physical_available, physical); assert.equal(row.sellable_available, 0);
    assert.equal(row.inventory_usage, 'custody'); assert.equal(row.inventory_enabled, true); assert.equal(row.inventory_policy_version, '1');
  }
  const snapshot = await f.ok('/inventory/snapshot?warehouse_id=' + f.spare.id + '&product_ids=' + [f.a.id, f.b.id].join(','));
  assert.equal(snapshot.meta.found, 2); assert(snapshot.data.every((row: any) => row.sellable_available === 0 && row.physical_available > 0));

  // Actual persisted price-list/account read, first legacy default then explicit
  // supplier sidecar. No simulated provider or portal inventory projection.
  for (const [index, account] of f.accounts.entries()) {
    const page = () => tenantTx(f.tenant, async c => b2bCatalogPage(c, (await c.query('SELECT * FROM b2b_accounts WHERE id=$1', [account.id])).rows[0], { ids: [f.a.id, f.bundle.id] }));
    const legacy = await page(); assert.equal(legacy.next, null);
    assert.deepEqual(legacy.data.map((p: any) => [p.id, p.price, p.available]).sort(),
      [[f.a.id, 777, index === 0 ? 5 : 0], [f.bundle.id, 1554, index === 0 ? 5 : 0]].sort());
    const head = (await f.ok('/product-catalogs/options')).catalogs.find((p: any) => p.is_default);
    const preview = (await f.ok('/b2b/accounts/' + account.id + '/catalog-scope/previews', 'POST', {
      client_key: randomUUID(), account_version: String(account.version), catalog_id: head.id, catalog_version: head.version,
      warehouse_id: account.warehouse_id, price_list_id: f.list.id, language: head.default_language,
    }, 201)).preview;
    await f.ok('/b2b/catalog-scope/previews/' + preview.id + '/commit', 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 201);
    assert.deepEqual((await page()).data, legacy.data);
  }
  const frozen = await productCatalogFacts(f.tenant);
  // Separate read-only phases after the intentional scope config receipts.
  const preview = await f.ok('/catalog/exports/preview', 'POST', { format: 'csv', columns: ['id', 'sku', 'inventory_json'],
    headers: {}, spreadsheet_safe: false, selection: 'selected', ids, warehouse_ids: [f.warehouse, f.spare.id] });
  const aExport = preview.sample.find((p: any) => p.product_id === f.a.id).inventory_json;
  assert.equal(aExport.find((s: any) => s.warehouse_id === f.spare.id).on_hand, 7);
  assert.equal(aExport.find((s: any) => s.warehouse_id === f.spare.id).available, 0);
  const bundleExport = preview.sample.find((p: any) => p.product_id === f.bundle.id).inventory_json;
  assert.equal(bundleExport.find((s: any) => s.warehouse_id === f.spare.id).available, 0);
  assert.equal(bundleExport.find((s: any) => s.warehouse_id === f.warehouse).available, 5);
  for (const p of [f.a, f.bundle]) {
    const input = (wh: string) => offerInput.parse({ product_id: p.id, warehouse_id: wh, operation: 'sync', stock: true, price: false });
    const custody = await tenantTx(f.tenant, c => desiredOffer(c, f.actor, input(f.spare.id)));
    assert.equal(custody.quantity, 0);
    assert.deepEqual(custody.snapshot.warehouse_inventory_policy, { warehouse_id: f.spare.id, ...f.policy });
    assert(custody.snapshot.stocks.every((s: any) => s.on_hand > 0), 'Zero offer must not erase physical stock snapshot');
    assert.equal((await tenantTx(f.tenant, c => desiredOffer(c, f.actor, input(f.warehouse)))).quantity, 5);
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), frozen);
  // Only sidecar configuration/audits changed during the intentional config.
  for (const name of Object.keys(beforeRows)) if (!name.startsWith('b2b_catalog_scope_') && name !== 'b2b_supplier_catalog_scopes' && name !== 'audit_events') {
    if (name !== 'b2b_accounts') { assert.deepEqual(frozen[name], beforeRows[name], name); continue; }
    assert.equal(frozen[name].length, beforeRows[name].length);
    for (const old of beforeRows[name]) {
      const current: Record<string, unknown> | undefined = frozen[name].find(r => r.row.id === old.row.id)?.row;
      assert(current);
      assert.equal(typeof current.version, 'number');
      assert.equal(typeof current.updated_at, 'string');
      assert.equal(current.version, old.row.version + 1, 'First explicit scope has its exact account CAS effect');
      assert(typeof current.updated_at === 'string' && Date.parse(current.updated_at) >= Date.parse(old.row.updated_at));
      assert.deepEqual(current, { ...old.row, version: old.row.version + 1, updated_at: current.updated_at });
    }
  }

  for (const p of [f.a, f.bundle]) {
    const denied = await f.request('/orders', 'POST', { source: 'manual', customer_name: 'Own custody refusal', email: 'custody@example.test',
      address: f.address, warehouse_id: f.spare.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
      items: [{ product_id: p.id, quantity: 1 }] });
    assert.equal(denied.statusCode, 409); assert.deepEqual(await productCatalogFacts(f.tenant), frozen, 'No order/reservation/payment/audit can survive rejected custody sale');
  }
  if (on) {
    const key = await f.ok('/developer/keys', 'POST', { name: 'Own cost-restricted sellability reader', scopes: ['inventory:read'], expires_days: 1 }, 201);
    const protectedRows = await productCatalogFacts(f.tenant);
    const positions = await f.ok('/wms-lots/positions?warehouse_id=' + f.spare.id, 'GET', undefined, 200, key);
    assert.equal(positions.can_read_value, false); assert.equal(positions.meta.cursor, null);
    assert.equal(positions.data.filter((r: any) => ids.includes(r.product_id)).length, 2);
    redactedWmsCosts(positions);
    assert.deepEqual(await productCatalogFacts(f.tenant), protectedRows);
  }
  const copy = await buildApp({ readOnly: true, previewPort: 4197,
    integrationTransport: async () => { providerCalls++; throw Error('No provider in readonly sellability test'); } });
  try {
    assert.equal((await copy.inject({ url: '/api/warehouse-inventory-policies/options', headers: { cookie: f.cookie } })).statusCode, 401);
    const login = await copy.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(login.statusCode, 200);
    const switched = await copy.inject({ method: 'POST', url: '/api/workspaces/switch',
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: { tenant_id: f.tenant } });
    assert.equal(switched.statusCode, 200);
    const headers = { cookie: String(switched.headers['set-cookie']).split(';')[0] };
    const currentRows = await productCatalogFacts(f.tenant);
    const options = await copy.inject({ url: '/api/warehouse-inventory-policies/options?limit=50', headers });
    assert.equal(options.statusCode, 200); assert.equal(options.json().read_only, true); assert.equal(options.json().can_manage, false);
    assert.deepEqual(options.json().warehouses.find((w: any) => w.id === f.spare.id).policy, f.policy);
    noCosts(options.json());
    const copyStock = await copy.inject({ url: '/api/inventory?warehouse_id=' + f.spare.id, headers });
    assert.equal(copyStock.statusCode, 200);
    assert.equal(copyStock.json().data.find((r: any) => r.product_id === f.a.id).physical_available, 7);
    assert.equal(copyStock.json().data.find((r: any) => r.product_id === f.a.id).sellable_available, 0);
    assert.deepEqual(await productCatalogFacts(f.tenant), currentRows);
  } finally { await copy.close(); }
  assert.equal(providerCalls, 0);
});

test('real whole146 absence uses legacy physical quantities, but installed ledger and disabled guards fail503 without business effects', async () => {
  const f = await sellabilityFixture(false), rows = await productCatalogFacts(f.tenant), c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    await c.query('ALTER TABLE stock DISABLE TRIGGER warehouse_inventory_policy_source_guard');
    await assert.rejects(warehouseInventoryPoliciesAvailable(c), (e: any) => e.status === 503);
    await c.query('ROLLBACK');
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    const functions = (await c.query("SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'warehouse_inventory_policy_%' OR proname='warehouse_inventory_policy') ORDER BY oid")).rows;
    assert(functions.length > 0);
    for (const fn of functions) {
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO qa161_absent_policy_${fn.oid}`);
    }
    const triggers = (await c.query("SELECT oid,tgrelid,tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'warehouse_inventory_policy_%'")).rows;
    for (const tr of triggers) {
      const relation = (await c.query('SELECT $1::oid::regclass::text relation', [tr.tgrelid])).rows[0].relation;
      await c.query(`ALTER TRIGGER ${tr.tgname} ON ${relation} RENAME TO qa161_absent_policy_trigger_${tr.oid}`);
    }
    for (const table of ['warehouse_inventory_policies', 'warehouse_inventory_policy_revisions', 'warehouse_inventory_policy_previews', 'warehouse_inventory_policy_operations', 'warehouse_inventory_policy_admissions'])
      await c.query(`ALTER TABLE ${table} RENAME TO qa161_absent_${table}`);
    assert.equal((await c.query("SELECT name FROM migrations WHERE name='146_warehouse_inventory_policies'")).rowCount, 1);
    await assert.rejects(warehouseInventoryPoliciesAvailable(c), (e: any) => e.status === 503);
    await c.query("UPDATE migrations SET name='qa161_absent_146_warehouse_inventory_policies' WHERE name='146_warehouse_inventory_policies'");
    assert.equal(await warehouseInventoryPoliciesAvailable(c), false);
    await c.query('SET LOCAL ROLE dyna_app');
    const legacy = await listProducts(c, { search: '', warehouse_id: f.spare.id, limit: 100 });
    assert.equal(legacy.data.find((p: any) => p.id === f.a.id).available, 7);
    assert.equal(legacy.data.find((p: any) => p.id === f.bundle.id).available, 7);
  } finally { await c.query('ROLLBACK'); c.release(); }
  assert.equal(await warehouseInventoryPoliciesAvailable(), true);
  assert.deepEqual(await productCatalogFacts(f.tenant), rows);
});
