import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFacts } from './product-catalogs-fixture';
import { returnAssistantFixture } from './return-assistant-fixture';

// Source authored for root's disposable host PostgreSQL harness, never primary.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_[a-zA-Z0-9_]+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0, ip = 0;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('No provider in valuation tests'); } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const fields = ['quantity', 'physical_quantity', 'known_quantity', 'unknown_quantity', 'known_minor',
  'reserved_quantity', 'physical_available', 'sellable_quantity', 'sellable_available', 'zero_cost_quantity'] as const;
const consent = (p: Row) => ({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });

async function actor(tenant: string, email = 'admin@demo.local') {
  const remoteAddress = '127.163.0.' + ++ip;
  const user = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='admin'", [tenant, user]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'DynaDemo!2026' }, remoteAddress });
  assert.equal(login.statusCode, 200);
  const switched = await app.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress });
  assert.equal(switched.statusCode, 200); const cookie = String(switched.headers['set-cookie']).split(';')[0];
  const request = (path: string, method: any = 'GET', body?: any, key?: Row) => app.inject({
    method, url: '/api' + (key ? '/v1' : '') + path, payload: body, remoteAddress,
    headers: { ...(key ? { authorization: 'Bearer ' + key.token } : { cookie }), ...(path === '/orders' && method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) },
  });
  const ok = async (path: string, method: any = 'GET', body?: any, status = 200, key?: Row): Promise<Row> => {
    const r = await request(path, method, body, key); assert.equal(r.statusCode, status, `${method} ${path}`); return r.json();
  };
  return { tenant, user, request, ok };
}
type Reader = { tenant: string; ok: (path: string, method?: any, body?: any, status?: number) => Promise<Row> };
async function policy(f: { ok: (path: string, method?: any, body?: any, status?: number) => Promise<any> }, warehouse: string, usage: 'sale' | 'custody', enabled: boolean) {
  const p = (await f.ok(`/warehouse-inventory-policies/warehouses/${warehouse}/previews`, 'POST', { client_key: randomUUID(), version: '0', usage, enabled }, 201)).preview;
  assert.equal(p.ready, true);
  return (await f.ok(`/warehouse-inventory-policies/previews/${p.id}/commit`, 'POST', consent(p), 201)).operation.after;
}
async function fixture(on = true) {
  const tenant = randomUUID(); await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own valuation163','enterprise')", [tenant]);
  const f = await actor(tenant), warehouses: Row[] = [];
  for (const label of ['sale', 'custody', 'disabled']) warehouses.push(await f.ok('/warehouses', 'POST', { name: 'Own valuation ' + label, code: 'V163-' + randomUUID().slice(0, 8) }));
  await policy(f, warehouses[1].id, 'custody', true); await policy(f, warehouses[2].id, 'sale', false);
  const products: Row[] = [];
  for (const cost of ['0', '1000', null]) products.push({ ...await f.ok('/products', 'POST', { name: 'Own valuation cost ' + String(cost), sku: 'V163-' + randomUUID(), kind: 'simple', price: 1000, vat: 23, quantity: 0, warehouse_id: warehouses[0].id, location: 'V163' }, 201), cost });
  const catalog = (await f.ok('/product-catalogs/' + products[0].catalog_id)).catalog;
  const cp = (await f.ok('/product-catalogs/previews', 'POST', { client_key: randomUUID(), kind: 'update', catalog_id: catalog.id, version: String(catalog.version), settings: {
    name: catalog.name, active: catalog.active, languages: catalog.languages, default_language: catalog.default_language,
    warehouse_ids: warehouses.map(w => w.id).sort(), price_list_ids: catalog.price_list_ids,
  } }, 201)).preview; assert.equal(cp.ready, true); await f.ok('/product-catalogs/previews/' + cp.id + '/commit', 'POST', consent(cp), 201);
  // 146 deliberately allows disabling only an empty warehouse. Ordinary PZ
  // requires enabled=true, so a populated disabled warehouse cannot be forged
  // by this fixture. Keep its genuine zero position in the metadata report.
  const receivingWarehouses = warehouses.slice(0, 2);
  for (const warehouse of receivingWarehouses) {
    const doc = await f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: warehouse.id, reference: 'Own physical valuation opening', lines: products.map((p, n) => ({ product_id: p.id, quantity: n + 2, location: 'V163' })) }, 201);
    await f.ok('/warehouse-documents/' + doc.id + '/post', 'POST', { version: doc.version });
  }
  const disabledDoc = await f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: warehouses[2].id,
    reference: 'Own disabled warehouse must refuse ordinary intake', lines: [{ product_id: products[1].id, quantity: 1, location: 'V163' }] }, 201);
  const beforeDisabledPost = await productCatalogFacts(tenant);
  assert.equal((await f.request('/warehouse-documents/' + disabledDoc.id + '/post', 'POST', { version: disabledDoc.version })).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(tenant), beforeDisabledPost, 'Disabled PZ does not produce stock, positions or journal');
  if (on) {
    const opening = (await f.ok('/wms-lots/opening-previews', 'POST', { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Own genuine zero known and unknown opening', lines: await Promise.all(receivingWarehouses.flatMap(w => products.map(async (p, n) => ({
      warehouse_id: w.id, product_id: p.id, location: 'V163', quantity: n + 2,
      stock_version: String((await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [tenant, w.id, p.id])).rows[0].version), lot_code: 'V163-' + randomUUID(), unit_cost_minor: p.cost,
    })))) }, 201)).preview; assert.equal(opening.ready, true);
    await f.ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', { ...consent(opening), ack_unknown_costs: true }, 201);
  }
  return { ...f, warehouses, products, on };
}
function classified(reply: Row) {
  assert.equal(reply.can_read_value, true); const v = reply.valuation;
  assert.equal(v.warehouse_policy_available, true); assert(Number.isFinite(Date.parse(v.snapshot_at)));
  assert.deepEqual(v.usage_buckets.map((b: Row) => b.usage).sort(), ['custody', 'sale']);
  assert.equal(new Set(v.warehouses.map((w: Row) => w.warehouse_id)).size, v.warehouses.length);
  for (const group of [v, ...v.warehouses.map((w: Row) => w.valuation), ...v.usage_buckets.map((b: Row) => b.valuation)]) {
    for (const name of fields) assert.match(group[name], /^(0|[1-9][0-9]*)$/);
    assert.equal(group.quantity, group.physical_quantity); assert.equal(group.totalquantity, group.quantity);
    assert.equal(BigInt(group.known_quantity) + BigInt(group.unknown_quantity), BigInt(group.quantity));
    assert.equal(BigInt(group.physical_available) + BigInt(group.reserved_quantity), BigInt(group.quantity));
    assert(BigInt(group.zero_cost_quantity) <= BigInt(group.known_quantity));
    assert(BigInt(group.sellable_available) <= BigInt(group.sellable_quantity));
    assert.equal(group.currency, 'PLN'); assert.equal(group.exponent, 2);
  }
  for (const name of fields) {
    assert.equal(v.warehouses.reduce((n: bigint, w: Row) => n + BigInt(w.valuation[name]), 0n), BigInt(v[name]));
    assert.equal(v.usage_buckets.reduce((n: bigint, b: Row) => n + BigInt(b.valuation[name]), 0n), BigInt(v[name]));
    for (const b of v.usage_buckets) assert.equal(v.warehouses.filter((w: Row) => w.policy.usage === b.usage).reduce((n: bigint, w: Row) => n + BigInt(w.valuation[name]), 0n), BigInt(b.valuation[name]));
  }
  return v;
}
function facts(v: Row) { const { snapshot_at: _time, ...rest } = v; return rest; }
async function transfer(f: Reader, product: string, source: string, destination: string, location: string, quantity: number, verifyReplay = true) {
  const p = (await f.ok('/wms-lots')).policy;
  const layers = (await pool.query(`SELECT layer_id FROM wms_layer_positions
    WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3 AND location=$4 AND quantity>reserved ORDER BY layer_id`,
  [f.tenant, product, source, location])).rows;
  assert(layers.length > 0, 'Select genuine available origin layers, never client costs');
  const preview = (await f.ok('/wms-lots/movement-previews', 'POST', {
    client_key: randomUUID(), policy_version: String(p.version), kind: 'transfer', product_id: product,
    warehouse_id: source, location, quantity, destination_warehouse_id: destination,
    destination_location: 'V163-MM', layer_ids: layers.map(r => r.layer_id),
    stock_versions: await Promise.all([source, destination].map(async warehouse_id => ({
      warehouse_id, product_id: product, version: String((await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [f.tenant, warehouse_id, product])).rows[0].version),
    }))), note: 'Own explicit custody transfer retains original layer cost',
  }, 201)).preview;
  assert.equal(preview.ready, true);
  const body = consent(preview), result = await f.ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', body, 201);
  assert.equal(result.reused, false);
  if (verifyReplay) {
    const after = await productCatalogFacts(f.tenant);
    const replay = await f.ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', body);
    assert.equal(replay.reused, true); assert.equal(replay.operation.id, result.operation.id);
    assert.deepEqual(await productCatalogFacts(f.tenant), after, 'MM exact replay has no second movement');
  }
  return result.operation;
}
async function waitForPin(c: PoolClient, pending: Promise<any>, pattern: RegExp) {
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  void pending.catch(() => undefined); const end = Date.now() + 5000;
  while (Date.now() < end) {
    const wait = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rows;
    if (wait.some(x => pattern.test(x.query))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The real valuation must reach the held final grant lock');
}

test('ON reports actual SALE/CUSTODY/disabled positions and keeps known zero distinct from NULL, with read purity and filters', async () => {
  const f = await fixture(), before = await productCatalogFacts(f.tenant), v = classified(await f.ok('/wms-lots/valuation'));
  assert.equal(v.quantity, '18'); assert.equal(v.known_quantity, '10'); assert.equal(v.zero_cost_quantity, '4'); assert.equal(v.unknown_quantity, '8'); assert.equal(v.known_minor, '6000');
  assert.equal(v.reserved_quantity, '0'); assert.equal(v.physical_available, '18'); assert.equal(v.sellable_quantity, '9'); assert.equal(v.sellable_available, '9');
  for (const [index, w] of f.warehouses.entries()) {
    const row = v.warehouses.find((r: Row) => r.warehouse_id === w.id); assert(row);
    assert.equal(row.name, w.name); assert.equal(row.code, w.code); assert.equal(row.policy.usage, index === 1 ? 'custody' : 'sale'); assert.equal(row.policy.enabled, index !== 2); assert.equal(row.policy.version, index === 0 ? '0' : '1');
    assert.equal(row.valuation.quantity, index === 2 ? '0' : '9'); assert.equal(row.valuation.known_minor, index === 2 ? '0' : '3000'); assert.equal(row.valuation.unknown_quantity, index === 2 ? '0' : '4'); assert.equal(row.valuation.zero_cost_quantity, index === 2 ? '0' : '2'); assert.equal(row.valuation.sellable_available, index === 0 ? '9' : '0');
    const selected = classified(await f.ok('/wms-lots/valuation?warehouse_id=' + w.id)); assert.equal(selected.quantity, index === 2 ? '0' : '9'); assert.equal(selected.warehouses.length, 1); assert.equal(selected.warehouses[0].warehouse_id, w.id);
  }
  const zero = classified(await f.ok('/wms-lots/valuation?product_id=' + f.products[0].id)); assert.equal(zero.known_quantity, '4'); assert.equal(zero.zero_cost_quantity, '4'); assert.equal(zero.known_minor, '0'); assert.equal(zero.unknown_quantity, '0');
  const unknown = classified(await f.ok('/wms-lots/valuation?product_id=' + f.products[2].id)); assert.equal(unknown.known_quantity, '0'); assert.equal(unknown.unknown_quantity, '8'); assert.equal(unknown.known_minor, '0'); assert.equal(unknown.zero_cost_quantity, '0');
  // Preserve the existing empty-filter contract; no foreign warehouse metadata
  // or costs may enter a different tenant's report.
  const foreign = await fixture();
  const foreignWarehouse = classified(await f.ok('/wms-lots/valuation?warehouse_id=' + foreign.warehouses[0].id));
  assert.equal(foreignWarehouse.quantity, '0'); assert.deepEqual(foreignWarehouse.warehouses, []);
  const foreignProduct = classified(await f.ok('/wms-lots/valuation?product_id=' + foreign.products[0].id));
  assert.equal(foreignProduct.quantity, '0'); assert.equal(foreignProduct.warehouses.length, 3);
  assert(!JSON.stringify(foreignProduct).includes(foreign.warehouses[0].id));
  assert.deepEqual(await productCatalogFacts(f.tenant), before, 'All valuation/filter GETs leave every own business row unchanged');
});

test('one RR classification remains coherent while a genuine MM completes during its held final IAM wait', async () => {
  const f = await fixture(), mover = await actor(f.tenant, 'operator@demo.local'); assert.notEqual(f.user, mover.user);
  const before = classified(await f.ok('/wms-lots/valuation')), held = await pool.connect(); let pending: Promise<any> | undefined, movement: Row | undefined;
  try {
    await held.query('BEGIN'); await held.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [f.tenant, f.user]);
    pending = f.request('/wms-lots/valuation'); await waitForPin(held, pending, /wms_current_role/);
    // A distinct real admin performs ordinary preview/consent. If the report
    // holds warehouse/stock/WMS locks, this cannot finish while IAM is held.
    movement = await transfer(mover, f.products[1].id, f.warehouses[1].id, f.warehouses[0].id, 'V163', 1, false);
    await held.query('COMMIT'); const reply = await pending; assert.equal(reply.statusCode, 200);
    const snapshot = classified(reply.json()); assert.deepEqual(facts(snapshot), facts(before));
    assert(movement, 'The distinct administrator must finish the genuine MM before the grant is released');
    assert.equal(typeof movement.created_at, 'string'); assert(Number.isFinite(Date.parse(movement.created_at)));
    assert(Date.parse(snapshot.snapshot_at) <= Date.parse(movement.created_at));
  } finally { await held.query('ROLLBACK').catch(() => undefined); held.release(); if (pending) await pending.catch(() => undefined); }
  const current = classified(await f.ok('/wms-lots/valuation'));
  assert.equal(current.quantity, '18'); assert.equal(current.known_minor, '6000'); assert.equal(current.sellable_quantity, '10');
  assert.equal(current.usage_buckets.find((x: Row) => x.usage === 'custody').valuation.known_minor, '2000');
  assert.equal(current.usage_buckets.find((x: Row) => x.usage === 'sale').valuation.known_minor, '4000');
  const readBefore = await productCatalogFacts(f.tenant); await f.ok('/wms-lots/valuation'); assert.deepEqual(await productCatalogFacts(f.tenant), readBefore);
});

test('OFF remains an explicit unavailable-cost409, never fabricated zero-cost ON valuation', async () => {
  const f = await fixture(false), before = await productCatalogFacts(f.tenant);
  const denied = await f.request('/wms-lots/valuation'); assert.equal(denied.statusCode, 409); assert.equal(denied.json().valuation, undefined);
  const inventory = await f.ok('/inventory?warehouse_id=' + f.warehouses[1].id);
  assert.equal(inventory.data.length, 3); assert.equal(inventory.data.reduce((n: number, r: Row) => n + r.physical_available, 0), 9); assert(inventory.data.every((r: Row) => r.sellable_available === 0));
  assert.deepEqual(await productCatalogFacts(f.tenant), before);
});

test('a genuine SALE reservation changes available quantities without changing physical cost or custody availability', async () => {
  const f = await fixture();
  const order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own valuation reservation', email: 'valuation163@example.test',
    address: { street: 'Testowa 163', city: 'Warszawa', postal_code: '00-163', country: 'PL', phone: '500000163' },
    warehouse_id: f.warehouses[0].id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: f.products[1].id, quantity: 1 }],
  }, 201);
  const current = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', {
    client_key: randomUUID(), version: Number(current.version), kind: 'receipt', amount: current.total,
    currency: 'PLN', method: 'other', reference: 'Own local reservation declaration', confirmed: true,
  });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  const before = await productCatalogFacts(f.tenant), v = classified(await f.ok('/wms-lots/valuation'));
  assert.equal(v.quantity, '18'); assert.equal(v.known_minor, '6000'); assert.equal(v.reserved_quantity, '1');
  assert.equal(v.physical_available, '17'); assert.equal(v.sellable_quantity, '9'); assert.equal(v.sellable_available, '8');
  const custody = v.warehouses.find((x: Row) => x.warehouse_id === f.warehouses[1].id).valuation;
  assert.equal(custody.reserved_quantity, '0'); assert.equal(custody.physical_available, '9'); assert.equal(custody.sellable_available, '0');
  assert.deepEqual(await productCatalogFacts(f.tenant), before, 'Report cannot consume or release the active reservation');
});

test('quantity-only key cannot receive value metadata; current compound key and admin role are required', async () => {
  const f = await fixture();
  // 013 deliberately revokes every key on admin demotion. Exercise the role
  // through the session before creating keys, rather than fabricating a403
  // expectation for a credential which has correctly become revoked401.
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  try { assert.equal((await f.request('/wms-lots/valuation')).statusCode, 403); }
  finally { await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
  const quantity = await f.ok('/developer/keys', 'POST', { name: 'Own quantity reader', scopes: ['inventory:read'] }, 201), value = await f.ok('/developer/keys', 'POST', { name: 'Own compound value reader', scopes: ['inventory:read', 'purchasing:read'] }, 201);
  const before = await productCatalogFacts(f.tenant), denied = await f.request('/wms-lots/valuation', 'GET', undefined, quantity); assert.equal(denied.statusCode, 403);
  for (const word of ['known_minor', 'unit_cost_minor', 'usage_buckets', f.warehouses[1].id]) assert(!denied.body.includes(word));
  assert.equal(classified(await f.ok('/wms-lots/valuation', 'GET', undefined, 200, value)).known_minor, '6000');
  assert.deepEqual(await productCatalogFacts(f.tenant), before);
});

for (const withdrawal of ['membership', 'scope', 'expiry', 'revocation'] as const) test(`actual final ${withdrawal} wait observes withdrawn value authority and returns no stale classified data`, async () => {
  const keyWait = withdrawal !== 'membership';
  const f = await fixture(), key = keyWait ? await f.ok('/developer/keys', 'POST', { name: 'Own late value key', scopes: ['inventory:read', 'purchasing:read'] }, 201) : undefined;
  const originalKey = key ? (await pool.query('SELECT scopes,expires_at::text,revoked_at::text FROM api_keys WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id])).rows[0] : undefined;
  const before = await productCatalogFacts(f.tenant), held = await pool.connect(); let pending: Promise<any> | undefined;
  try {
    await held.query('BEGIN');
    if (key) await held.query('SELECT id FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, key.id]);
    else await held.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [f.tenant, f.user]);
    pending = f.request('/wms-lots/valuation', 'GET', undefined, key); await waitForPin(held, pending, key ? /wms_key_read_grant/ : /wms_current_role/);
    if (key && withdrawal === 'scope') await held.query("UPDATE api_keys SET scopes=ARRAY['inventory:read'] WHERE tenant_id=$1 AND id=$2", [f.tenant, key.id]);
    else if (key && withdrawal === 'expiry') await held.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [f.tenant, key.id]);
    else if (key) await held.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
    else await held.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    await held.query('COMMIT'); const denied = await pending; assert.equal(denied.statusCode, withdrawal === 'expiry' || withdrawal === 'revocation' ? 401 : 403); assert.equal(denied.json().valuation, undefined); assert(!denied.body.includes('known_minor'));
  } finally {
    await held.query('ROLLBACK').catch(() => undefined); held.release(); if (pending) await pending.catch(() => undefined);
    if (key) await pool.query('UPDATE api_keys SET scopes=$3,expires_at=$4,revoked_at=$5 WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id, originalKey.scopes, originalKey.expires_at, originalKey.revoked_at]);
    else await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), before, 'No business/audit effect from failed read or grant-repair');
});

test('current custody-to-sale valuation after a real148 receipt and MM does not rewrite original return classification, cost or credit', async () => {
  const f = await returnAssistantFixture(app, true), custody = await f.ok('/warehouses', 'POST', {
    name: 'Own returned custody valuation', code: 'V163-R-' + randomUUID().slice(0, 6),
  });
  const product = await f.ok('/products/' + f.product.id), catalog = (await f.ok('/product-catalogs/' + product.catalog_id)).catalog;
  const cp = (await f.ok('/product-catalogs/previews', 'POST', {
    client_key: randomUUID(), kind: 'update', catalog_id: catalog.id, version: String(catalog.version), settings: {
      name: catalog.name, active: catalog.active, languages: catalog.languages, default_language: catalog.default_language,
      warehouse_ids: [...new Set([...catalog.warehouse_ids, custody.id])].sort(), price_list_ids: catalog.price_list_ids,
    },
  }, 201)).preview; assert.equal(cp.ready, true);
  await f.ok('/product-catalogs/previews/' + cp.id + '/commit', 'POST', consent(cp), 201);
  const custodyPolicy = await policy(f, custody.id, 'custody', true);
  const statusPreview = (await f.ok('/return-assistant/statuses/previews', 'POST', {
    client_key: randomUUID(), kind: 'create', settings: {
      name: 'Own custody recovery', color: '#aabbcc', active: true, decision: 'accept', inventory_effect: 'custody',
      warehouse_id: custody.id, warehouse_policy_version: custodyPolicy.version, default_location: 'V163-RETURN',
    },
  }, 201)).preview;
  const status = (await f.ok('/return-assistant/statuses/previews/' + statusPreview.id + '/commit', 'POST', consent(statusPreview), 201)).status;
  const lease = randomUUID();
  let session = (await f.ok('/return-assistant/sessions', 'POST', {
    client_key: randomUUID(), return_number: f.rma.number, station_id: f.station.id,
    station_version: String(f.station.version), lease_token: lease,
  }, 201)).session;
  assert.equal(session.lines.length, 1); assert.equal(session.lines[0].requested, 1);
  session = (await f.ok('/return-assistant/sessions/' + session.id + '/scans', 'POST', {
    client_key: randomUUID(), version: String(session.version), lease_token: lease, code: f.product.sku, item_id: session.lines[0].item_id,
  })).session;
  const source = (await f.ok('/return-destinations/returns/' + f.rma.id + '/source?session_id=' + session.id)).source;
  const line = source.planner_source.lines.find((x: Row) => x.item_id === session.lines[0].item_id), part = randomUUID(); assert(line);
  const targetStocks = line.components.map((component: Row) => {
    const stock = source.planner_source.stocks.find((x: Row) => x.warehouse_id === custody.id && x.product_id === component.product_id); assert(stock);
    return { warehouse_id: custody.id, product_id: component.product_id, version: stock.version };
  });
  const picks = line.components.map((component: Row) => {
    const origin = source.planner_source.wms.issue_fragments.find((x: Row) => x.product_id === component.product_id && x.eligible_item_ids.includes(line.item_id)); assert(origin);
    return { part_id: part, issue_fragment_id: origin.id, quantity: component.quantity, location: 'V163-RETURN' };
  });
  const preview = (await f.ok('/return-destinations/returns/' + f.rma.id + '/previews', 'POST', {
    protocol: 'destinations_v1', client_key: randomUUID(), return_version: source.return_version,
    session_id: session.id, session_version: String(session.version), lease_token: lease, note: 'Own actual custody before transfer', shipping_refund: 0,
    parts: [{ part_id: part, item_id: line.item_id, quantity: 1, status_id: status.id, status_version: status.version }],
    locations: line.components.map((component: Row) => ({ part_id: part, product_id: component.product_id, location: 'V163-RETURN', confirmed: true })),
    stock_versions: targetStocks, wms_lots: { policy_version: source.planner_source.wms.policy_version, picks },
  }, 201)).preview;
  assert.equal(preview.can_receive, true);
  const receipt = (await f.ok('/return-destinations/previews/' + preview.id + '/receive', 'POST', { ...consent(preview), lease_token: lease }, 201)).operation;
  assert.equal(receipt.result.refund_amount, 1000); assert.equal(receipt.result.state, 'refund_pending');
  const beforeMove = classified(await f.ok('/wms-lots/valuation'));
  assert.equal(beforeMove.usage_buckets.find((x: Row) => x.usage === 'custody').valuation.known_minor, '2000');
  const originals = await productCatalogFacts(f.tenant), costProduct = f.components.find(p => p.cost === '1000'); assert(costProduct);
  const scopeTables = ['return_destination_parts', 'return_destination_arrivals', 'return_destination_fragments', 'return_destination_admissions',
    'return_assistant_receipts', 'return_assistant_admissions', 'wms_return_fragments', 'wms_issue_fragments', 'wms_cost_layers', 'wms_lots',
    'orders', 'order_items', 'return_cases', 'return_items', 'payment_entries', 'documents', 'reservations', 'reservation_locations', 'wms_reservation_layers'];
  for (const name of scopeTables) assert(Array.isArray(originals[name]), 'Real schema evidence required: ' + name);
  const originalParts = originals.return_destination_parts.map(x => x.row); assert.equal(originalParts.length, 1);
  assert.equal(originalParts[0].effect, 'custody');
  const fragmentRows = originals.wms_return_fragments.map(x => x.row).filter(x => x.operation_id === receipt.id);
  assert.equal(fragmentRows.length, 2); assert.equal(fragmentRows.reduce((n, r) => n + BigInt(r.value_minor), 0n), 2000n);
  await transfer(f, costProduct.id, custody.id, f.warehouse, 'V163-RETURN', 2);
  const afterMove = classified(await f.ok('/wms-lots/valuation'));
  assert.equal(afterMove.known_minor, beforeMove.known_minor); assert.equal(afterMove.quantity, beforeMove.quantity);
  assert.equal(afterMove.usage_buckets.find((x: Row) => x.usage === 'custody').valuation.known_minor, '0');
  assert.equal(BigInt(afterMove.usage_buckets.find((x: Row) => x.usage === 'sale').valuation.known_minor), BigInt(beforeMove.usage_buckets.find((x: Row) => x.usage === 'sale').valuation.known_minor) + 2000n);
  assert.equal(BigInt(afterMove.sellable_quantity), BigInt(beforeMove.sellable_quantity) + 2n);
  const after = await productCatalogFacts(f.tenant);
  for (const name of scopeTables) assert.deepEqual(after[name], originals[name], 'MM cannot reclassify the original receipt/capacity/refund: ' + name);
  const rma = await f.ok('/returns/' + f.rma.id); assert.equal(rma.refund_amount, 1000); assert.equal(rma.state, 'refund_pending');
  const pure = await productCatalogFacts(f.tenant); await f.ok('/wms-lots/valuation'); assert.deepEqual(await productCatalogFacts(f.tenant), pure);
});
