import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent, productCatalogSettings } from './product-catalogs-fixture';
import { processB2bCatalog } from '../server/b2b-network';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  if (!(await pool.query("SELECT to_regprocedure('public.b2b_catalog_scope_installed()') r")).rows[0].r)
    await pool.query(await readFile(resolve('server/144_b2b_catalog_scopes.sql'), 'utf8'));
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('No provider in scoped commerce gate'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

test('actual buyer portal publishes only configured catalog and rejects stale quotes while completed checkout replays', async () => {
  const f = await productCatalogFixture(app);
  const definition = productCatalogCreate(f), preview = (await f.ok('/product-catalogs/previews', 'POST', definition, 201)).preview;
  const selected = (await f.ok('/product-catalogs/previews/' + preview.id + '/commit', 'POST', productCatalogConsent(preview), 201)).catalog;
  const p = await f.ok('/products', 'POST', { sku: 'SCOPED-PORTAL-' + randomUUID(), name: 'Own selected catalog product',
    kind: 'simple', price: 1500, vat: 23, quantity: 5, warehouse_id: f.spare.id, catalog_id: selected.id }, 201);
  await f.ok('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version,
    items: [{ product_id: p.id, price: 2100 }, { product_id: f.product.id, price: 9900 }] });
  const accountBody = { name: 'Own scoped portal buyer', email: randomUUID() + '@example.test',
    warehouse_id: f.warehouse, price_list_id: f.list.id, payment_mode: 'prepaid',
    address: { street: 'Scope 159', city: 'Warszawa', postal_code: '00-159', country: 'PL' } };
  let account = await f.ok('/b2b/accounts', 'POST', accountBody, 201);
  const scopePreview = (await f.ok('/b2b/accounts/' + account.id + '/catalog-scope/previews', 'POST', {
    client_key: randomUUID(), account_version: String(account.version), catalog_id: selected.id,
    catalog_version: selected.version, warehouse_id: f.spare.id, price_list_id: f.list.id, language: 'pl',
  }, 201)).preview;
  await f.ok('/b2b/catalog-scope/previews/' + scopePreview.id + '/commit', 'POST', productCatalogConsent(scopePreview), 201);
  account = (await f.ok('/b2b/accounts?search=' + encodeURIComponent(accountBody.email))).data[0];
  account = await f.ok('/b2b/accounts/' + account.id, 'PATCH', { ...accountBody, warehouse_id: f.spare.id,
    version: account.version, active: true, confirmed: true });
  const invitation = await f.ok('/b2b/accounts/' + account.id + '/invite', 'POST', { version: account.version, confirmed: true });
  const root = '/api/public/b2b/' + account.id, password = 'OwnPortal!159Password';
  const activation = await app.inject({ url: root + '/activate', method: 'POST', payload: { token: invitation.invitation.split('#invite=')[1], password } });
  assert.equal(activation.statusCode, 200, activation.body);
  const login = await app.inject({ url: root + '/login', method: 'POST', payload: { email: accountBody.email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = (path: string, method: any = 'GET', payload?: any) => app.inject({ url: root + path, method, payload, headers: { cookie } });
  const catalog = await request('/catalog'); assert.equal(catalog.statusCode, 200, catalog.body);
  assert.deepEqual(catalog.json().data.map((row: any) => row.id), [p.id]);
  assert.equal(catalog.json().data[0].price, 2100); assert.equal(catalog.json().data[0].available, 5);
  assert.equal(JSON.stringify(catalog.json()).includes('catalog_scope'), false);
  const before = await productCatalogFacts(f.tenant);
  const refused = await request('/quotes', 'POST', { client_key: randomUUID(), items: [{ product_id: f.product.id, quantity: 1 }] });
  assert.equal(refused.statusCode, 404, refused.body); assert.deepEqual(await productCatalogFacts(f.tenant), before);
  const cart = { client_key: randomUUID(), items: [{ product_id: p.id, quantity: 1 }] };
  const first = await request('/quotes', 'POST', cart); assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().total, 2100); assert.equal(Object.hasOwn(first.json().pricing, 'catalog_scope'), false);
  const persisted = (await pool.query('SELECT pricing FROM b2b_quotes WHERE id=$1', [first.json().id])).rows[0].pricing;
  assert.equal(persisted.catalog_scope.catalog_id, selected.id);
  const checkout = await request('/quotes/' + first.json().id + '/checkout', 'POST', { confirmed: true });
  assert.equal(checkout.statusCode, 200, checkout.body);
  const order = (await pool.query('SELECT warehouse_id,price_list_id FROM orders WHERE id=$1', [checkout.json().id])).rows[0];
  assert.deepEqual(order, { warehouse_id: f.spare.id, price_list_id: f.list.id });
  assert.equal((await pool.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [p.id, f.spare.id])).rows[0].reserved, 1);
  const completedQuote = await request('/quotes', 'POST', cart);
  assert.equal(completedQuote.statusCode, 200, completedQuote.body);
  assert.deepEqual(completedQuote.json(), { ...first.json(), order_id: checkout.json().id });
  const pending = await request('/quotes', 'POST', { ...cart, client_key: randomUUID() }); assert.equal(pending.statusCode, 200, pending.body);
  const changed = (await f.ok('/product-catalogs/previews', 'POST', { client_key: randomUUID(), kind: 'update',
    catalog_id: selected.id, version: selected.version,
    settings: productCatalogSettings(f, { name: 'Changed scoped portal definition' }),
  }, 201)).preview;
  const renamed = await f.request('/product-catalogs/previews/' + changed.id + '/commit', 'POST', productCatalogConsent(changed));
  assert.equal(renamed.statusCode, 201, renamed.body);
  const afterChange = await productCatalogFacts(f.tenant);
  const stale = await request('/quotes/' + pending.json().id + '/checkout', 'POST', { confirmed: true });
  assert.equal(stale.statusCode, 409, stale.body); assert.deepEqual(await productCatalogFacts(f.tenant), afterChange);
  const repeated = await request('/quotes/' + first.json().id + '/checkout', 'POST', { confirmed: true });
  assert.equal(repeated.statusCode, 200, repeated.body); assert.deepEqual(repeated.json(), checkout.json());
  assert.deepEqual(await productCatalogFacts(f.tenant), afterChange);
  const quoteReplay = await request('/quotes', 'POST', cart); assert.equal(quoteReplay.statusCode, 200);
  assert.deepEqual(quoteReplay.json(), completedQuote.json());
  assert.deepEqual(await productCatalogFacts(f.tenant), afterChange); assert.equal(providerCalls, 0);
});

test('actual scoped network refresh and durable bind feed buyer quote and one supplier reservation; stale proof rolls back', async () => {
  const supplier = await productCatalogFixture(app), buyer = await productCatalogFixture(app);
  const createCatalog = async (f: typeof supplier) => {
    const preview = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201)).preview;
    return (await f.ok('/product-catalogs/previews/' + preview.id + '/commit', 'POST', productCatalogConsent(preview), 201)).catalog;
  };
  const sourceCatalog = await createCatalog(supplier), targetCatalog = await createCatalog(buyer);
  const sourceProduct = await supplier.ok('/products', 'POST', { sku: 'OWN-NET-SOURCE-' + randomUUID(), name: 'Own scoped wholesale product',
    kind: 'simple', price: 1100, vat: 23, quantity: 4, warehouse_id: supplier.spare.id, catalog_id: sourceCatalog.id }, 201);
  const localProduct = await buyer.ok('/products', 'POST', { sku: 'OWN-NET-TARGET-' + randomUUID(), name: 'Own target product',
    kind: 'simple', price: 3500, vat: 23, quantity: 0, warehouse_id: buyer.spare.id, catalog_id: targetCatalog.id }, 201);
  await supplier.ok('/price-lists/' + supplier.list.id + '/items', 'PUT', { version: supplier.list.version,
    items: [{ product_id: sourceProduct.id, price: 2100 }, { product_id: supplier.product.id, price: 9900 }] });
  const accountBody = { name: 'Own scoped network buyer', email: randomUUID() + '@example.test',
    warehouse_id: supplier.warehouse, price_list_id: supplier.list.id, payment_mode: 'prepaid',
    address: { street: 'Network 159', city: 'Warszawa', postal_code: '00-159', country: 'PL' } };
  let account = await supplier.ok('/b2b/accounts', 'POST', accountBody, 201);
  const scopePreview = (await supplier.ok('/b2b/accounts/' + account.id + '/catalog-scope/previews', 'POST', {
    client_key: randomUUID(), account_version: String(account.version), catalog_id: sourceCatalog.id,
    catalog_version: sourceCatalog.version, warehouse_id: supplier.spare.id, price_list_id: supplier.list.id, language: 'pl',
  }, 201)).preview;
  await supplier.ok('/b2b/catalog-scope/previews/' + scopePreview.id + '/commit', 'POST', productCatalogConsent(scopePreview), 201);
  account = (await supplier.ok('/b2b/accounts?search=' + encodeURIComponent(accountBody.email))).data[0];
  account = await supplier.ok('/b2b/accounts/' + account.id, 'PATCH', { ...accountBody, warehouse_id: supplier.spare.id,
    version: account.version, active: true, confirmed: true });
  const invitation = await supplier.ok('/b2b/accounts/' + account.id + '/network-invite', 'POST', {
    version: account.version, recipient_email: 'admin@demo.local', confirmed: true });
  const link = await buyer.ok('/b2b/network/accept', 'POST', { token: invitation.token, confirmed: true });
  const root = '/b2b/network/links/' + link.id;
  const targetPreview = (await buyer.ok(root + '/catalog-scope/previews', 'POST', {
    client_key: randomUUID(), link_version: String(link.version), target_catalog_id: targetCatalog.id,
    target_catalog_version: targetCatalog.version,
  }, 201)).preview;
  await buyer.ok('/b2b/catalog-scope/previews/' + targetPreview.id + '/commit', 'POST', productCatalogConsent(targetPreview), 201);
  const run = await buyer.ok(root + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true });
  assert.equal(Object.hasOwn(run, 'catalog_scope'), false);
  for (let index = 0; index < 5; index++) {
    const job = (await pool.query("UPDATE jobs SET state='running',lease_token=$2,locked_at=now() WHERE id=$1 AND state='pending' RETURNING *",
      [run.job_id, randomUUID()])).rows[0];
    if (!job) break;
    await processB2bCatalog(job);
  }
  assert.equal((await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0].state, 'done');
  const page = await buyer.ok(root + '/catalog');
  assert.deepEqual(page.data.map((item: any) => item.source_product_id), [sourceProduct.id]);
  assert.equal(page.target_catalog.id, targetCatalog.id);
  assert.equal(JSON.stringify(page).includes('catalog_scope'), false);
  const item = page.data[0], bind = { client_key: randomUUID(), version: item.version, product_id: localProduct.id, confirmed: true };
  const bound = await buyer.ok(root + '/catalog/' + item.id + '/bind', 'POST', bind, 201);
  assert.equal(bound.binding.product_id, localProduct.id); assert.equal(bound.binding.quantity, 0);
  const afterBind = await productCatalogFacts(buyer.tenant);
  const repeated = await buyer.ok(root + '/catalog/' + item.id + '/bind', 'POST', bind);
  assert.equal(repeated.reused, true); assert.deepEqual(repeated.binding, bound.binding);
  assert.deepEqual(await productCatalogFacts(buyer.tenant), afterBind);
  const quoteBody = { client_key: randomUUID(), warehouse_id: buyer.spare.id, items: [{ item_id: item.id, quantity: 1 }] };
  const beforeRefusal = await productCatalogFacts(buyer.tenant);
  const wrongWarehouse = await buyer.request(root + '/quotes', 'POST', { ...quoteBody, warehouse_id: buyer.warehouse });
  assert.equal(wrongWarehouse.statusCode, 409, wrongWarehouse.body);
  assert.deepEqual(await productCatalogFacts(buyer.tenant), beforeRefusal);
  const quote = await buyer.ok(root + '/quotes', 'POST', quoteBody);
  assert.equal(quote.summary.total_gross, 2100); assert.equal(Object.hasOwn(quote.summary, 'catalog_scope'), false);
  const order = await buyer.ok(root + '/quotes/' + quote.id + '/checkout', 'POST', { confirmed: true });
  assert.equal(order.warehouse_id, buyer.spare.id);
  assert.equal((await pool.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [sourceProduct.id, supplier.spare.id])).rows[0].reserved, 1);
  assert.equal((await pool.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [localProduct.id, buyer.spare.id])).rows[0].reserved, 0);
  const afterOrder = await productCatalogFacts(buyer.tenant), supplierAfter = await productCatalogFacts(supplier.tenant);
  const replay = await buyer.ok(root + '/quotes/' + quote.id + '/checkout', 'POST', { confirmed: true });
  assert.equal(replay.id, order.id); assert.deepEqual(await productCatalogFacts(buyer.tenant), afterOrder);
  assert.deepEqual(await productCatalogFacts(supplier.tenant), supplierAfter);
  // The first checkout changed supplier availability. The old imported item
  // cannot be a new quote until refresh reconciles it against the real source.
  const stale = await buyer.request(root + '/quotes', 'POST', { ...quoteBody, client_key: randomUUID() });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.deepEqual(await productCatalogFacts(buyer.tenant), afterOrder);
  assert.deepEqual(await productCatalogFacts(supplier.tenant), supplierAfter); assert.equal(providerCalls, 0);
});
