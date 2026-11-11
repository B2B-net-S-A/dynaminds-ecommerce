import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { processB2bCatalog } from '../server/b2b-network';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';
import * as S from '../server/b2b-catalog-scope';
import { withHistoricalCatalogModules } from './catalog-export-historical-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  assert((await pool.query("SELECT 1 FROM migrations WHERE name='143_catalog_export_catalogs'")).rowCount);
  if (!(await pool.query("SELECT to_regprocedure('public.b2b_catalog_scope_installed()') marker")).rows[0].marker)
    await pool.query(await readFile(resolve('server/144_b2b_catalog_scopes.sql'), 'utf8'));
  assert.equal(await S.b2bCatalogScopeAvailable(), true);
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw new Error('Scoped dropship test forbids provider calls'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
async function catalog(f: Awaited<ReturnType<typeof productCatalogFixture>>) {
  const p = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201)).preview;
  return (await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), 201)).catalog;
}
async function receipt(f: Awaited<ReturnType<typeof productCatalogFixture>>, id: string, warehouse: string, quantity: number) {
  const d = await f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: warehouse, reference: 'Own scoped B2B test',
    note: '', lines: [{ product_id: id, quantity, location: 'SCOPE-01' }] }, 201);
  await f.ok('/warehouse-documents/' + d.id + '/post', 'POST', { version: d.version });
}
async function supplierConfig(f: any) {
  const account = (await pool.query('SELECT * FROM b2b_accounts WHERE tenant_id=$1 AND id=$2', [f.supplier.tenant, f.account.id])).rows[0];
  const p = (await S.previewB2BSupplierCatalogScope(f.supplier.actor, f.account.id, {
    client_key: randomUUID(), account_version: String(account.version), catalog_id: f.supplierCatalog.id,
    catalog_version: f.supplierCatalog.version, warehouse_id: f.supplier.spare.id, price_list_id: f.supplier.list.id, language: 'pl',
  })).preview;
  return S.commitB2BCatalogScope(f.supplier.actor, p.id, productCatalogConsent(p));
}
async function fixture(configured = true) {
  const supplier = await productCatalogFixture(app), buyer = await productCatalogFixture(app);
  const supplierCatalog = await catalog(supplier), buyerCatalog = await catalog(buyer);
  const supplierWarehouse = configured ? supplier.spare.id : supplier.warehouse;
  const buyerWarehouse = configured ? buyer.spare.id : buyer.warehouse;
  const source = await supplier.ok('/products', 'POST', {
    name: 'Actual scoped supplier product', sku: 'SCOPED-DS-' + randomUUID(), kind: 'simple', price: 1900, vat: 23,
    quantity: 0, warehouse_id: supplierWarehouse, catalog_id: configured ? supplierCatalog.id : supplier.defaultCatalog.id,
  }, 201);
  await receipt(supplier, source.id, supplierWarehouse, 10);
  await supplier.ok('/price-lists/' + supplier.list.id + '/items', 'PUT', {
    version: supplier.list.version, items: [{ product_id: source.id, price: 700 }],
  });
  const accountBody = { name: 'Own scoped dropship buyer', email: randomUUID() + '@example.test',
    warehouse_id: supplierWarehouse, price_list_id: supplier.list.id,
    address: { street: 'Supplier 159', city: 'Poznań', postal_code: '60-159', country: 'PL' },
    min_total: 0, min_quantity: 1, quantity_step: 1, shipping_cost: 0, payment_mode: 'prepaid' };
  const initial = await supplier.ok('/b2b/accounts', 'POST', accountBody, 201);
  const account = await supplier.ok('/b2b/accounts/' + initial.id, 'PATCH', { ...accountBody, version: initial.version, active: true, confirmed: true });
  const invite = await supplier.ok('/b2b/accounts/' + account.id + '/network-invite', 'POST', {
    version: account.version, recipient_email: 'admin@demo.local', confirmed: true,
  });
  const link = await buyer.ok('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true });
  const f = { supplier, buyer, supplierCatalog, buyerCatalog, source, account, link, buyerWarehouse,
    base: '/b2b/network/links/' + link.id, path: '/b2b/network/links/' + link.id + '/dropshipping' };
  if (configured) {
    await supplierConfig(f);
    const p = (await S.previewB2BBuyerCatalogScope(buyer.actor, link.id, { client_key: randomUUID(), link_version: String(link.version),
      target_catalog_id: buyerCatalog.id, target_catalog_version: buyerCatalog.version })).preview;
    await S.commitB2BCatalogScope(buyer.actor, p.id, productCatalogConsent(p));
  }
  const run = await buyer.ok(f.base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true });
  // Only this own run's genuine worker lease is processed. No global scheduler.
  for (let page = 0; page < 5; page++) {
    const current = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE tenant_id=$1 AND id=$2', [buyer.tenant, run.id])).rows[0];
    if (current.state === 'done') break;
    assert.equal(current.state, 'queued');
    const job = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$3,locked_at=now() WHERE tenant_id=$1 AND id=$2 AND state='pending' RETURNING *",
      [buyer.tenant, current.job_id, randomUUID()])).rows[0];
    assert(job, 'Own actual refresh job must be pending and uniquely claimed');
    await processB2bCatalog(job);
    await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$3",
      [buyer.tenant, job.id, job.lease_token]);
  }
  assert.equal((await pool.query('SELECT state FROM b2b_catalog_runs WHERE tenant_id=$1 AND id=$2', [buyer.tenant, run.id])).rows[0].state, 'done');
  const item = (await buyer.ok(f.base + '/catalog')).data.find((i: any) => i.source_product_id === source.id);
  assert(item);
  const imported = await buyer.ok(f.base + '/catalog/' + item.id + '/product', 'POST', {
    version: item.version, sku: 'SCOPED-LOCAL-' + randomUUID(), sale_price: 2500, warehouse_id: buyerWarehouse, confirmed: true,
  });
  const local = await buyer.ok('/products/' + imported.product_id);
  assert.equal(local.catalog_id, configured ? buyerCatalog.id : buyer.defaultCatalog.id);
  await receipt(buyer, local.id, buyerWarehouse, 6);
  const order = await buyer.ok('/orders', 'POST', { customer_name: 'Own scoped customer', email: 'scoped@example.test',
    address: { street: 'Customer 159', city: 'Gdańsk', postal_code: '80-159', country: 'PL', phone: '500000159' },
    warehouse_id: buyerWarehouse, currency: 'PLN', payment_mode: 'prepaid', shipping_cost: 0,
    items: [{ product_id: local.id, quantity: 2 }] }, 201);
  return { ...f, item, local, order: await buyer.ok('/orders/' + order.id) };
}
function quoteBody(f: Awaited<ReturnType<typeof fixture>>) {
  return { client_key: randomUUID(), customer_order_id: f.order.id, items: [{ customer_item_id: f.order.items[0].id,
    quantity: 1, mappings: [{ product_id: f.local.id, catalog_item_id: f.item.id }] }] };
}
const consent = (q: any) => ({ client_key: randomUUID(), scope_hash: q.scope_hash, confirmed: true, confirmed_receiver: true });
async function facts(f: Awaited<ReturnType<typeof fixture>>) {
  return { supplier: await productCatalogFacts(f.supplier.tenant), buyer: await productCatalogFacts(f.buyer.tenant) };
}

test('scoped genuine mappings produce one supplier order/custody transfer; replay keeps exact facts and proof private', async () => {
  const f = await fixture(), body = quoteBody(f);
  const source = await f.buyer.ok(f.path + '/sources/' + f.order.id);
  assert.equal(source.source.lines[0].components[0].mappings[0].catalog_item_id, f.item.id);
  const q = (await f.buyer.ok(f.path + '/quotes', 'POST', body, 201)).quote;
  assert.equal(q.wholesale.total_minor, '700'); assert(!JSON.stringify(q).includes('catalog_scope'));
  const raw = (await pool.query('SELECT snapshot FROM b2b_dropship_quotes WHERE tenant_id=$1 AND id=$2', [f.buyer.tenant, q.id])).rows[0].snapshot;
  assert.equal(raw.catalog_scope.supplier.catalog_id, f.supplierCatalog.id);
  assert.equal(raw.catalog_scope.buyer.target_catalog_id, f.buyerCatalog.id);
  const input = consent(q), accepted = await f.buyer.ok(f.path + '/quotes/' + q.id + '/checkout', 'POST', input, 201);
  const supplierOrder = await f.supplier.ok('/orders/' + accepted.order.supplier_order_id);
  assert.equal(supplierOrder.warehouse_id, f.supplier.spare.id); assert.equal(supplierOrder.items[0].product_id, f.source.id);
  assert.equal(supplierOrder.items[0].quantity, 1); assert.equal(supplierOrder.total, 700);
  const before = await facts(f);
  const replay = await f.buyer.ok(f.path + '/quotes/' + q.id + '/checkout', 'POST', input);
  assert.equal(replay.reused, true); assert.equal(replay.order.id, accepted.order.id);
  assert.deepEqual(await facts(f), before); assert.equal(providerCalls, 0);
});

test('foreign buyer pool/source mapping and forged normalized source are refused without quote or stock effects', async () => {
  const f = await fixture();
  const wrongOrder = await f.buyer.ok('/orders', 'POST', { customer_name: 'Wrong pool', email: 'wrong@example.test',
    address: { street: 'Wrong 159', city: 'Warszawa', postal_code: '00-159', country: 'PL', phone: '500000159' },
    warehouse_id: f.buyer.warehouse, currency: 'PLN', payment_mode: 'prepaid', shipping_cost: 0,
    items: [{ product_id: f.buyer.product.id, quantity: 1 }] }, 201);
  const before = await facts(f);
  assert.equal((await f.buyer.request(f.path + '/sources/' + wrongOrder.id)).statusCode, 404);
  const listed = await f.buyer.ok(f.path + '/sources?limit=100'); assert(!listed.data.some((o: any) => o.id === wrongOrder.id));
  assert.equal((await f.buyer.request(f.path + '/quotes', 'POST', { ...quoteBody(f), customer_order_id: wrongOrder.id,
    items: [{ customer_item_id: wrongOrder.items[0].id, quantity: 1, mappings: [{ product_id: f.buyer.product.id, catalog_item_id: f.item.id }] }] })).statusCode, 404);
  assert.deepEqual(await facts(f), before);
  // Intentional test-only own-row corruption tests independent current-source
  // correspondence; finally restores the exact bytes, never a new baseline.
  const original = (await pool.query('SELECT snapshot FROM b2b_catalog_items WHERE tenant_id=$1 AND id=$2', [f.buyer.tenant, f.item.id])).rows[0].snapshot;
  try {
    await pool.query("UPDATE b2b_catalog_items SET snapshot=jsonb_set(snapshot,'{price}','123456'::jsonb) WHERE tenant_id=$1 AND id=$2", [f.buyer.tenant, f.item.id]);
    const forged = await facts(f);
    assert.equal((await f.buyer.request(f.path + '/quotes', 'POST', quoteBody(f))).statusCode, 409);
    assert.deepEqual(await facts(f), forged);
  } finally { await pool.query('UPDATE b2b_catalog_items SET snapshot=$3 WHERE tenant_id=$1 AND id=$2', [f.buyer.tenant, f.item.id, JSON.stringify(original)]); }
  assert.deepEqual(await facts(f), before);
});

test('fresh checkout refuses stale scope/list after quote; historical quote exact replay is still readable', async () => {
  const f = await fixture(), body = quoteBody(f);
  const q = (await f.buyer.ok(f.path + '/quotes', 'POST', body, 201)).quote;
  const list = (await pool.query('SELECT version FROM price_lists WHERE tenant_id=$1 AND id=$2', [f.supplier.tenant, f.supplier.list.id])).rows[0];
  await f.supplier.ok('/price-lists/' + f.supplier.list.id + '/items', 'PUT', {
    version: list.version, items: [{ product_id: f.source.id, price: 701 }],
  });
  const before = await facts(f);
  assert.equal((await f.buyer.request(f.path + '/quotes/' + q.id + '/checkout', 'POST', consent(q))).statusCode, 409);
  const replay = await f.buyer.ok(f.path + '/quotes', 'POST', body); assert.equal(replay.reused, true); assert.equal(replay.quote.id, q.id);
  assert.deepEqual(await facts(f), before);
});

test('accepted legacy checkout replay and genuine cancellation survive a later supplier scope birth', async () => {
  const f = await fixture(false), q = (await f.buyer.ok(f.path + '/quotes', 'POST', quoteBody(f), 201)).quote;
  const input = consent(q), result = await f.buyer.ok(f.path + '/quotes/' + q.id + '/checkout', 'POST', input, 201);
  await supplierConfig(f);
  const before = await facts(f);
  const replay = await f.buyer.ok(f.path + '/quotes/' + q.id + '/checkout', 'POST', input);
  assert.equal(replay.reused, true); assert.equal(replay.order.id, result.order.id); assert.deepEqual(await facts(f), before);
  const cancel = { client_key: randomUUID(), version: result.order.version, reason: 'Own historical scope compatibility', confirmed: true };
  const cancelled = await f.buyer.ok(f.path + '/orders/' + result.order.id + '/cancel', 'POST', cancel);
  assert.equal(cancelled.order.state, 'cancelled');
  assert.equal((await f.supplier.ok('/orders/' + result.order.supplier_order_id)).status, 'cancelled');
  const after = await facts(f); const again = await f.buyer.ok(f.path + '/orders/' + result.order.id + '/cancel', 'POST', cancel);
  assert.equal(again.reused, true); assert.equal(again.order.state, 'cancelled'); assert.deepEqual(await facts(f), after);
  assert.equal(providerCalls, 0);
});

test('genuinely absent142 and144 retains historical source reads; partial144 still fails closed', async () => {
  const f = await fixture(false), before = await facts(f);
  const original = await f.buyer.ok(f.path + '/sources/' + f.order.id);
  const originalList = await f.buyer.ok(f.path + '/sources?limit=100');
  // Serial disposable fixture: keep all OIDs/rows/ACLs, hide complete modules
  // and disable only their birth guards. No business write runs while hidden.
  const c = await pool.connect(); let hidden = false;
  const functions = (await c.query(`SELECT oid,proname,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname LIKE 'b2b_catalog_scope_%' ORDER BY oid`)).rows;
  const relations = (await c.query(`SELECT oid,relname,relkind FROM pg_class WHERE relnamespace='public'::regnamespace
    AND relkind IN('r','i') AND(relname LIKE 'b2b_catalog_scope_%' OR relname LIKE 'b2b_catalog_bindings%'
      OR relname LIKE 'b2b_supplier_catalog_scopes%'
      OR relname LIKE 'b2b_buyer_catalog_scopes%') ORDER BY oid`)).rows;
  const runColumns = (await c.query(`SELECT attname FROM pg_attribute WHERE attrelid='public.b2b_catalog_runs'::regclass
    AND NOT attisdropped AND attname IN('catalog_scope','catalog_scope_hash','api_key_id') ORDER BY attnum`)).rows;
  const triggers = (await c.query(`SELECT t.tgrelid::regclass::text relation,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal AND p.pronamespace='public'::regnamespace AND(p.proname LIKE 'product_catalog_%'
      OR p.proname LIKE 'catalog_export_catalogs_%' OR p.proname LIKE 'b2b_catalog_scope_%') ORDER BY t.oid`)).rows;
  const ident = (value: string) => { assert.match(value, /^[a-z][a-z0-9_]*$/); return '"' + value + '"'; };
  assert(relations.filter(table => table.relkind === 'r').length >= 5); assert(functions.length >= 15);
  try {
    await c.query('BEGIN');
    for (const trigger of triggers) await c.query(`ALTER TABLE ${trigger.relation} DISABLE TRIGGER ${ident(trigger.tgname)}`);
    for (const fn of functions) {
      const sig = (await c.query('SELECT $1::oid::regprocedure::text sig', [fn.oid])).rows[0].sig;
      await c.query(`ALTER FUNCTION ${sig} RENAME TO ${ident('qa159_hidden_fn_' + fn.oid)}`);
    }
    for (const table of relations) await c.query(`ALTER ${table.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident(table.relname)} RENAME TO ${ident('qa159_hidden_table_' + table.oid)}`);
    for (const column of runColumns) await c.query(`ALTER TABLE b2b_catalog_runs RENAME COLUMN ${ident(column.attname)} TO ${ident('qa159_hidden_' + column.attname)}`);
    await c.query('COMMIT'); hidden = true;
    await withHistoricalCatalogModules(pool, async () => {
      assert.deepEqual(await f.buyer.ok(f.path + '/sources/' + f.order.id), original);
      assert.deepEqual(await f.buyer.ok(f.path + '/sources?limit=100'), originalList);
      // Restore exactly one marker, leaving the module incomplete. It must
      // never activate the unrestricted historical branch.
      const marker = functions.find(fn => fn.proname === 'b2b_catalog_scope_installed'); assert(marker);
      const sig = (await c.query('SELECT $1::oid::regprocedure::text sig', [marker.oid])).rows[0].sig;
      await c.query(`ALTER FUNCTION ${sig} RENAME TO b2b_catalog_scope_installed`);
      try { assert.equal((await f.buyer.request(f.path + '/sources/' + f.order.id)).statusCode, 503); }
      finally { await c.query(`ALTER FUNCTION b2b_catalog_scope_installed() RENAME TO ${ident('qa159_hidden_fn_' + marker.oid)}`); }
    });
  } finally {
    try {
      await c.query('ROLLBACK');
      if (hidden) {
        await c.query('BEGIN');
        for (const column of runColumns) await c.query(`ALTER TABLE b2b_catalog_runs RENAME COLUMN ${ident('qa159_hidden_' + column.attname)} TO ${ident(column.attname)}`);
        for (const table of relations) await c.query(`ALTER ${table.relkind === 'i' ? 'INDEX' : 'TABLE'} ${ident('qa159_hidden_table_' + table.oid)} RENAME TO ${ident(table.relname)}`);
        for (const fn of functions) {
          const sig = (await c.query('SELECT $1::oid::regprocedure::text sig', [fn.oid])).rows[0].sig;
          await c.query(`ALTER FUNCTION ${sig} RENAME TO ${ident(fn.proname)}`);
        }
        for (const trigger of triggers) {
          const action = trigger.tgenabled === 'D' ? 'DISABLE' : trigger.tgenabled === 'A' ? 'ENABLE ALWAYS' : trigger.tgenabled === 'R' ? 'ENABLE REPLICA' : 'ENABLE';
          await c.query(`ALTER TABLE ${trigger.relation} ${action} TRIGGER ${ident(trigger.tgname)}`);
        }
        await c.query('COMMIT');
        assert.deepEqual((await c.query(`SELECT oid,proname,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=ANY($1::oid[]) ORDER BY oid`, [functions.map(fn => fn.oid)])).rows, functions);
      }
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  }
  assert.deepEqual(await facts(f), before); assert.equal(providerCalls, 0);
});
