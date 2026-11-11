import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';
import * as S from '../server/b2b-catalog-scope';
import * as A from '../server/b2b-catalog-scope-adapters';

// These tests require the repository's disposable host-native test harness.
// Never connect to the primary database or an external B2B/provider service.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  assert((await pool.query("SELECT 1 FROM migrations WHERE name='143_catalog_export_catalogs'")).rowCount);
  if (!(await pool.query("SELECT to_regprocedure('public.b2b_catalog_scope_installed()') marker")).rows[0].marker) {
    await pool.query(await readFile(resolve('server/144_b2b_catalog_scopes.sql'), 'utf8'));
  }
  assert.equal(await S.b2bCatalogScopeAvailable(), true);
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw new Error('Adapter test forbids providers'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
const status = (expected: number) => (error: any) => error.status === expected;
async function inTx<T>(tenant: string, body: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query("SET LOCAL statement_timeout='5s'");
    await c.query("SET LOCAL TimeZone='UTC'");
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    return await body(c);
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
async function contextIsRestored(c: PoolClient, tenant: string) {
  assert.deepEqual((await c.query("SELECT current_user role,current_setting('app.tenant_id') tenant")).rows[0], { role: 'dyna_app', tenant });
}
async function fixture() {
  const f = await productCatalogFixture(app);
  const preview = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201)).preview;
  const selected = (await f.ok('/product-catalogs/previews/' + preview.id + '/commit', 'POST', productCatalogConsent(preview), 201)).catalog;
  const products: any[] = [];
  for (let index = 0; index < 3; index++) products.push(await f.ok('/products', 'POST', {
    sku: 'ADAPTER-' + randomUUID(), name: 'Selected historical name ' + index, kind: 'simple',
    price: 1100 + index, vat: 23, quantity: 0, warehouse_id: f.spare.id, catalog_id: selected.id,
  }, 201));
  await f.ok('/price-lists/' + f.list.id + '/items', 'PUT', { version: f.list.version,
    items: [...products.map((p, index) => ({ product_id: p.id, price: 2100 + index })), { product_id: f.product.id, price: 9900 }] });
  const accountBody = { name: 'Own adapter account', email: randomUUID() + '@example.test', warehouse_id: f.warehouse,
    price_list_id: f.list.id, payment_mode: 'prepaid', address: { street: 'Adapter 159', city: 'Warszawa', postal_code: '00-159', country: 'PL' } };
  const created = await f.ok('/b2b/accounts', 'POST', accountBody, 201);
  const account = await f.ok('/b2b/accounts/' + created.id, 'PATCH', { ...accountBody, version: created.version, active: true, confirmed: true });
  return { ...f, selected, products, account, accountBody };
}
async function configureSupplier(f: Awaited<ReturnType<typeof fixture>>, language = 'pl') {
  const p = (await S.previewB2BSupplierCatalogScope(f.actor, f.account.id, {
    client_key: randomUUID(), account_version: String(f.account.version), catalog_id: f.selected.id,
    catalog_version: f.selected.version, warehouse_id: f.spare.id, price_list_id: f.list.id, language,
  })).preview;
  return S.commitB2BCatalogScope(f.actor, p.id, productCatalogConsent(p));
}
async function linkFixtures(supplier: Awaited<ReturnType<typeof fixture>>, buyer: Awaited<ReturnType<typeof fixture>>) {
  const invite = await supplier.ok('/b2b/accounts/' + supplier.account.id + '/network-invite', 'POST', {
    version: supplier.account.version, recipient_email: 'admin@demo.local', confirmed: true,
  });
  return buyer.ok('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true });
}

test('legacy default remains a real isolated catalog, with transaction-bound frames and restored role', async () => {
  const f = await fixture(), before = await productCatalogFacts(f.tenant);
  let oldFrame!: A.B2BSupplierCatalogFrame;
  await inTx(f.tenant, async c => {
    const frame = await A.guardSupplierB2BCatalogScopeInTx(c, { tenantId: f.tenant, accountId: f.account.id }); oldFrame = frame;
    assert.equal(frame.mode, 'legacy_default'); assert.equal(frame.catalog_id, f.defaultCatalog.id);
    assert.match(frame.catalog_version, /^[1-9][0-9]*$/); assert.equal(frame.operation_id, null); assert.equal(frame.scope_version, null);
    const page = await A.readB2BSupplierCatalogPageInTx(c, frame, { limit: 500 });
    assert.deepEqual(page.data.map(p => p.id), [f.product.id]); assert.equal(page.data[0].price, 9900);
    assert.equal(page.data[0].available, 7); assert.equal(page.next, null);
    await assert.rejects(A.readB2BSupplierCatalogPageInTx(c, frame, { ids: [f.products[0].id] }), status(404));
    await assert.rejects(A.assertB2BCatalogFrameFreshInTx(c, { ...frame }), status(409));
    await assert.rejects(A.guardSupplierB2BCatalogScopeInTx(c, { tenantId: randomUUID(), accountId: f.account.id }), status(403));
    await assert.rejects(A.guardSupplierB2BCatalogScopeInTx(c, { tenantId: f.tenant, accountId: randomUUID() }), status(404));
    await contextIsRestored(c, f.tenant);
  });
  await inTx(f.tenant, async c => { await assert.rejects(A.assertB2BCatalogFrameFreshInTx(c, oldFrame), status(409)); });
  assert.deepEqual(await productCatalogFacts(f.tenant), before); assert.equal(providerCalls, 0);
});

test('configured supplier uses exact catalog/list/warehouse/language, complete pagination, and bounded selection', async () => {
  const f = await fixture(), product = await f.ok('/products/' + f.products[0].id);
  const translation = (await f.ok('/product-translation-bulk-edit/previews', 'POST', { client_key: randomUUID(), locales: ['en'], rows: [{
    product_id: product.id, product_version: product.version, translation_version: null, locale: 'en', operation: 'set',
    patch: { name: 'Actual English adapter product', description: 'Actual translated description' },
  }] }, 201)).preview;
  await f.ok('/product-translation-bulk-edit/previews/' + translation.id + '/execute', 'POST', {
    client_key: randomUUID(), scope_hash: translation.scope_hash, confirmed: true, ack_missing_translations: false,
  }, 201);
  const configured = await configureSupplier(f, 'en'), before = await productCatalogFacts(f.tenant);
  await inTx(f.tenant, async c => {
    const frame = await A.guardSupplierB2BCatalogScopeInTx(c, { tenantId: f.tenant, accountId: f.account.id });
    assert.equal(frame.mode, 'catalog_scope_v1'); assert.equal(frame.catalog_id, f.selected.id);
    assert.equal(frame.operation_id, configured.operation.id); assert.equal(frame.warehouse_id, f.spare.id); assert.equal(frame.language, 'en');
    const rows: any[] = []; let after: string | undefined;
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      const page = await A.readB2BSupplierCatalogPageInTx(c, frame, { limit: 1, ...(after ? { after } : {}) });
      rows.push(...page.data); if (!page.next) break; after = page.next;
    }
    assert.deepEqual(rows.map(row => row.id), f.products.map(p => p.id).sort()); assert.equal(new Set(rows.map(row => row.id)).size, 3);
    for (const [index, p] of f.products.entries()) {
      const row = rows.find(row => row.id === p.id); assert.equal(row.price, 2100 + index); assert.equal(row.available, 0);
    }
    assert.equal(rows.find(row => row.id === product.id).name, 'Actual English adapter product');
    const search = await A.readB2BSupplierCatalogPageInTx(c, frame, { search: 'Actual English' }); assert.deepEqual(search.data.map(p => p.id), [product.id]);
    await assert.rejects(A.readB2BSupplierCatalogPageInTx(c, frame, { ids: [f.product.id] }), status(404));
    await assert.rejects(A.readB2BSupplierCatalogPageInTx(c, frame, { ids: f.products.map(p => p.id), limit: 1 }), status(422));
    await assert.rejects(A.assertB2BCatalogProductsInTx(c, frame, [product.id, product.id.toUpperCase()]), (error: any) => error.name === 'ZodError');
    await assert.rejects(A.assertB2BCatalogProductsInTx(c, frame, Array.from({ length: 501 }, () => randomUUID())), (error: any) => error.name === 'ZodError');
    await contextIsRestored(c, f.tenant);
  });
  assert.deepEqual(await productCatalogFacts(f.tenant), before);
});

test('persisted pair validates buyer pool and source stamp; rollback protects all facts including forged snapshots', async () => {
  const supplier = await fixture(), buyer = await fixture(), link = await linkFixtures(supplier, buyer);
  // Both unconfigured sides may use an exact historical snapshot, but only
  // their actual default pools, never the selected nondefault products.
  await inTx(buyer.tenant, async c => {
    const pair = await A.guardB2BCatalogPairInTx(c, { tenantId: buyer.tenant, linkId: link.id });
    const snapshot = await A.b2bCatalogSourceSnapshotInTx(c, pair, supplier.product.id);
    const { catalog_scope: _scope, ...historical } = snapshot;
    await A.assertB2BCatalogSourceSnapshotInTx(c, pair, supplier.product.id, historical);
    await assert.rejects(A.b2bCatalogSourceSnapshotInTx(c, pair, supplier.products[0].id), status(404));
    await contextIsRestored(c, buyer.tenant);
  });
  await configureSupplier(supplier);
  const p = (await S.previewB2BBuyerCatalogScope(buyer.actor, link.id, { client_key: randomUUID(), link_version: String(link.version),
    target_catalog_id: buyer.selected.id, target_catalog_version: buyer.selected.version })).preview;
  await S.commitB2BCatalogScope(buyer.actor, p.id, productCatalogConsent(p));
  const originalBuyer = await productCatalogFacts(buyer.tenant), originalSupplier = await productCatalogFacts(supplier.tenant);
  await inTx(buyer.tenant, async c => {
    const pair = await A.guardB2BCatalogPairInTx(c, { tenantId: buyer.tenant, linkId: link.id, purpose: 'bind_product' });
    assert.equal(pair.buyer.target_catalog_id, buyer.selected.id); assert.equal(pair.supplier.tenant_id, supplier.tenant);
    await A.assertB2BBuyerCatalogWarehouseInTx(c, pair.buyer, buyer.spare.id);
    await assert.rejects(A.assertB2BBuyerCatalogWarehouseInTx(c, pair.buyer, buyer.warehouse), status(409));
    await assert.rejects(A.assertB2BBuyerCatalogWarehouseInTx(c, pair.buyer, supplier.spare.id), status(404));
    await assert.rejects(A.assertB2BBuyerCatalogWarehouseInTx(c, pair.buyer, 'bad', true), status(423));
    await assert.rejects(A.guardB2BCatalogPairInTx(c, { tenantId: 'bad', linkId: 'bad', purpose: 'create_product', readOnly: true }), status(423));
    await assert.rejects(A.guardB2BCatalogPairInTx(c, { tenantId: supplier.tenant, linkId: link.id }), status(403));
    await assert.rejects(A.guardBuyerB2BCatalogScopeInTx(c, { tenantId: buyer.tenant, linkId: supplier.account.id }), status(404));
    const snapshot = await A.b2bCatalogSourceSnapshotInTx(c, pair, supplier.products[0].id);
    await A.assertB2BCatalogSourceSnapshotInTx(c, pair, supplier.products[0].id, snapshot);
    const { catalog_scope: _scope, ...unstamped } = snapshot;
    await assert.rejects(A.assertB2BCatalogSourceSnapshotInTx(c, pair, supplier.products[0].id, unstamped), status(409));
    await assert.rejects(A.assertB2BCatalogSourceSnapshotInTx(c, pair, supplier.products[0].id, { ...snapshot, price: snapshot.price + 1 }), status(409));
    const itemId = randomUUID();
    await c.query(`INSERT INTO b2b_catalog_items(id,tenant_id,link_id,source_product_id,product_id,snapshot,fingerprint)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [itemId, buyer.tenant, link.id, supplier.products[0].id, buyer.products[0].id,
      JSON.stringify(snapshot), createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')]);
    assert.equal((await A.assertB2BBuyerCatalogItemsInTx(c, pair, [itemId]))[0].id, itemId);
    await c.query("UPDATE b2b_catalog_items SET snapshot=jsonb_set(snapshot,'{price}','999999'::jsonb) WHERE id=$1", [itemId]);
    await assert.rejects(A.assertB2BBuyerCatalogItemsInTx(c, pair, [itemId]), status(409));
    await contextIsRestored(c, buyer.tenant);
  });
  assert.deepEqual(await productCatalogFacts(buyer.tenant), originalBuyer);
  assert.deepEqual(await productCatalogFacts(supplier.tenant), originalSupplier); assert.equal(providerCalls, 0);
});

test('saved item history retains old price and stock, while fresh writes and configured quotes remain strict', async () => {
  for (const configured of [false, true]) {
    const supplier = await fixture(), buyer = await fixture(), link = await linkFixtures(supplier, buyer);
    if (configured) {
      await configureSupplier(supplier);
      const p = (await S.previewB2BBuyerCatalogScope(buyer.actor, link.id, { client_key: randomUUID(),
        link_version: String(link.version), target_catalog_id: buyer.selected.id, target_catalog_version: buyer.selected.version })).preview;
      await S.commitB2BCatalogScope(buyer.actor, p.id, productCatalogConsent(p));
    }
    const source = configured ? supplier.products[0] : supplier.product;
    const target = configured ? buyer.products[0] : buyer.product;
    const wrongSource = configured ? supplier.product : supplier.products[0];
    const wrongTarget = configured ? buyer.product : buyer.products[0];
    const warehouse = configured ? supplier.spare.id : supplier.warehouse;
    const saved = await inTx(buyer.tenant, async c => {
      const pair = await A.guardB2BCatalogPairInTx(c, { tenantId: buyer.tenant, linkId: link.id });
      return A.b2bCatalogSourceSnapshotInTx(c, pair, source.id);
    });
    const currentList = (await pool.query('SELECT version FROM price_lists WHERE tenant_id=$1 AND id=$2',
      [supplier.tenant, supplier.list.id])).rows[0];
    await supplier.ok('/price-lists/' + supplier.list.id + '/items', 'PUT', {
      version: Number(currentList.version), items: [{ product_id: source.id, price: saved.price + 137 }],
    });
    const receipt = await supplier.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: warehouse,
      lines: [{ product_id: source.id, quantity: 1, location: 'ADAPTER-HISTORY' }] }, 201);
    await supplier.ok('/warehouse-documents/' + receipt.id + '/post', 'POST', { version: receipt.version });
    const beforeBuyer = await productCatalogFacts(buyer.tenant), beforeSupplier = await productCatalogFacts(supplier.tenant);
    let priorPair!: A.B2BCatalogPair;
    await inTx(buyer.tenant, async c => {
      const pair = await A.guardB2BCatalogPairInTx(c, { tenantId: buyer.tenant, linkId: link.id }); priorPair = pair;
      const live = await A.b2bCatalogSourceSnapshotInTx(c, pair, source.id);
      assert.equal(live.price, saved.price + 137); assert.equal(live.available, saved.available + 1);
      async function insert(sourceId: string, targetId: string | null, published = true) {
        const id = randomUUID();
        await c.query(`INSERT INTO b2b_catalog_items(id,tenant_id,link_id,source_product_id,product_id,snapshot,fingerprint,published)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [id, buyer.tenant, link.id, sourceId, targetId,
          JSON.stringify(saved), createHash('sha256').update(JSON.stringify(saved)).digest('hex'), published]);
        return id;
      }
      const id = await insert(source.id, target.id);
      const historical = (await A.assertB2BBuyerCatalogItemPoolsInTx(c, pair, [id]))[0];
      assert.deepEqual(historical.snapshot, saved);
      await assert.rejects(A.assertB2BBuyerCatalogItemsInTx(c, pair, [id]), status(409));
      if (configured) await assert.rejects(A.assertB2BBuyerCatalogItemsInTx(c, pair, [id], true, true), status(409));
      else assert.equal((await A.assertB2BBuyerCatalogItemsInTx(c, pair, [id], true, true))[0].id, id);
      await assert.rejects(A.assertB2BBuyerCatalogItemPoolsInTx(c, { ...pair }, [id]), status(409));
      await assert.rejects(A.assertB2BBuyerCatalogItemPoolsInTx(c, pair, [randomUUID()]), status(404));
      await c.query('UPDATE b2b_catalog_items SET published=false,product_id=NULL WHERE id=$1', [id]);
      assert.equal((await A.assertB2BBuyerCatalogItemPoolsInTx(c, pair, [id]))[0].published, false);
      await assert.rejects(A.assertB2BBuyerCatalogItemsInTx(c, pair, [id], false, true), status(404));
      await c.query('UPDATE b2b_catalog_items SET published=true,product_id=$2,source_product_id=$3 WHERE id=$1', [id, target.id, wrongSource.id]);
      await assert.rejects(A.assertB2BBuyerCatalogItemPoolsInTx(c, pair, [id]), status(404));
      await c.query('UPDATE b2b_catalog_items SET product_id=$2,source_product_id=$3 WHERE id=$1', [id, wrongTarget.id, source.id]);
      await assert.rejects(A.assertB2BBuyerCatalogItemPoolsInTx(c, pair, [id]), status(404));
      await c.query('UPDATE b2b_catalog_items SET product_id=$2 WHERE id=$1', [id, target.id]);
      // Activity is a write criterion. A saved row remains readable after
      // either product is deactivated; these fixture mutations roll back.
      await c.query('UPDATE products SET active=false WHERE tenant_id=$1 AND id=$2', [buyer.tenant, target.id]);
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [supplier.tenant]);
      await c.query('UPDATE products SET active=false WHERE tenant_id=$1 AND id=$2', [supplier.tenant, source.id]);
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [buyer.tenant]);
      assert.deepEqual((await A.assertB2BBuyerCatalogItemPoolsInTx(c, pair, [id]))[0].snapshot, saved);
      await contextIsRestored(c, buyer.tenant);
    });
    await inTx(buyer.tenant, async c => {
      await assert.rejects(A.assertB2BBuyerCatalogItemPoolsInTx(c, priorPair, [randomUUID()]), status(409));
    });
    assert.deepEqual(await productCatalogFacts(buyer.tenant), beforeBuyer);
    assert.deepEqual(await productCatalogFacts(supplier.tenant), beforeSupplier);
  }
  assert.equal(providerCalls, 0);
});

test('genuine supplier configuration waits for an adapter catalog lock; later frames refuse exact stale resources', async () => {
  const f = await fixture();
  const p = (await S.previewB2BSupplierCatalogScope(f.actor, f.account.id, { client_key: randomUUID(),
    account_version: String(f.account.version), catalog_id: f.selected.id, catalog_version: f.selected.version,
    warehouse_id: f.spare.id, price_list_id: f.list.id, language: 'pl' })).preview;
  const holder = await pool.connect(); let outcome: Promise<any> | undefined;
  let frame!: A.B2BSupplierCatalogFrame;
  try {
    await holder.query('BEGIN'); await holder.query('SET LOCAL ROLE dyna_app');
    await holder.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    frame = await A.guardSupplierB2BCatalogScopeInTx(holder, { tenantId: f.tenant, accountId: f.account.id });
    const original = await productCatalogFacts(f.tenant);
    outcome = S.commitB2BCatalogScope(f.actor, p.id, productCatalogConsent(p));
    // Attach rejection handling immediately; cleanup always settles the writer.
    outcome.catch(() => undefined);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const wait = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock' AND query LIKE '%b2b_catalog_scope_commit%'`, [pid]);
      if (wait.rowCount) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(blocked, 'The genuine config writer must demonstrably wait for this adapter transaction');
    assert.deepEqual(await productCatalogFacts(f.tenant), original);
    await A.readB2BSupplierCatalogPageInTx(holder, frame);
    await holder.query('ROLLBACK');
    const committed = await outcome; assert.equal(committed.scope.catalog_id, f.selected.id);
    await inTx(f.tenant, async c => {
      await assert.rejects(A.guardSupplierB2BCatalogScopeInTx(c, { tenantId: f.tenant, accountId: f.account.id, expected: frame }), status(409));
      await assert.rejects(A.assertB2BCatalogFrameFreshInTx(c, frame), status(409));
      await contextIsRestored(c, f.tenant);
    });
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined); holder.release();
    if (outcome) await outcome;
  }
});
