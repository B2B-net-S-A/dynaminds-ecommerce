import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { PRODUCT_CATALOG_LIMITS } from '../server/product-catalogs-schema';
import { seed } from './fixtures';
import {
  productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent,
} from './product-catalogs-fixture';

// Root alone executes this against the disposable native test database. This is
// a bounded single-tenant capacity check, not a concurrency or load benchmark.
assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { throw Error('Capacity tests cannot call providers'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

function businessEqual(beforeRows: Record<string, unknown[]>, afterRows: Record<string, unknown[]>) {
  assert.deepEqual(Object.keys(afterRows), Object.keys(beforeRows));
  for (const name of Object.keys(beforeRows)) {
    if (name === 'product_catalogs' || name.startsWith('product_catalog_') || name === 'audit_events') continue;
    assert.deepEqual(afterRows[name], beforeRows[name], name);
  }
}
const sqlRefusal = (message: string) => (e: unknown) =>
  e instanceof Error && 'code' in e && e.code === '23514' && e.message === message;

test('one own tenant supports 100 catalogs, 100 warehouse/list assignments and 64 languages; each first excess rolls back exactly', async t => {
  const limits = PRODUCT_CATALOG_LIMITS;
  assert.equal(limits.max_catalogs, 100); assert.equal(limits.max_warehouses, 100);
  assert.equal(limits.max_price_lists, 100); assert.equal(limits.max_languages, 64); assert.equal(limits.page, 50);
  const f = await productCatalogFixture(app);
  const started = performance.now();
  const measurements: Record<string, number> = {};
  const resourceStart = performance.now();
  let options = await f.ok('/product-catalogs/options');
  assert.equal(options.available, true); assert.equal(options.catalogs.length, 1);
  const warehouseIds: string[] = options.warehouses.map((w: { id: string }) => w.id);
  const listIds: string[] = options.price_lists.map((p: { id: string }) => p.id);
  assert(warehouseIds.length > 0 && warehouseIds.length < limits.max_warehouses);
  assert(listIds.length > 0 && listIds.length < limits.max_price_lists);
  // Every successful resource birth uses the existing ordinary public API and
  // its real default-catalog bootstrap; no assignment rows are seeded directly.
  while (warehouseIds.length < limits.max_warehouses) {
    const w = await f.ok('/warehouses', 'POST', {
      name: 'Own capacity warehouse ' + warehouseIds.length,
      code: 'CAP-' + randomUUID().slice(0, 8),
    }, 200);
    warehouseIds.push(w.id);
  }
  while (listIds.length < limits.max_price_lists) {
    const p = await f.ok('/price-lists', 'POST', {
      name: 'Own capacity price list ' + listIds.length, currency: 'PLN',
    }, 201);
    listIds.push(p.id);
  }
  assert.equal(new Set(warehouseIds).size, 100); assert.equal(new Set(listIds).size, 100);
  measurements.resource_birth_ms = performance.now() - resourceStart;
  options = await f.ok('/product-catalogs/options');
  assert.equal(options.warehouses.length, 100); assert.equal(options.price_lists.length, 100);
  const defaultHead = options.catalogs.find((c: { is_default: boolean }) => c.is_default);
  assert(defaultHead); assert.equal(defaultHead.warehouse_ids.length, 100); assert.equal(defaultHead.price_list_ids.length, 100);
  assert.deepEqual([...defaultHead.warehouse_ids].sort(), [...warehouseIds].sort());
  assert.deepEqual([...defaultHead.price_list_ids].sort(), [...listIds].sort());
  const resourceBaseline = await productCatalogFacts(f.tenant);

  const languages = ['pl', ...Array.from({ length: 63 }, (_, i) => 'pl-x' + String(i).padStart(2, '0'))];
  const fullBody = productCatalogCreate(f, {
    name: 'Own capacity full assignments', languages, default_language: 'pl',
    warehouse_ids: warehouseIds, price_list_ids: listIds,
  });
  // The independently callable private validator accepts the exact boundary;
  // the actual graph is still created only through preview and explicit commit.
  await pool.query('SELECT product_catalog_settings($1::jsonb)', [JSON.stringify(fullBody.settings)]);
  const previewStart = performance.now();
  const fullPreviewReply = await f.ok('/product-catalogs/previews', 'POST', fullBody, 201);
  const fullPreview = fullPreviewReply.preview;
  assert.equal(fullPreview.ready, true); assert.deepEqual(fullPreview.blockers, []);
  measurements.full_preview_ms = performance.now() - previewStart;
  measurements.full_preview_json_bytes = Buffer.byteLength(JSON.stringify(fullPreviewReply));
  const consent = productCatalogConsent(fullPreview), commitStart = performance.now();
  const fullResult = await f.ok('/product-catalogs/previews/' + fullPreview.id + '/commit', 'POST', consent, 201);
  measurements.full_commit_ms = performance.now() - commitStart;
  const fullHead = (await f.ok('/product-catalogs/' + fullResult.catalog.id)).catalog;
  assert.equal(fullHead.languages.length, 64);
  assert.deepEqual(fullHead.languages, [...languages].sort());
  assert.deepEqual(fullHead.warehouse_ids, [...warehouseIds].sort());
  assert.deepEqual(fullHead.price_list_ids, [...listIds].sort());
  assert.equal(fullHead.default_language, 'pl');

  const birthStart = performance.now();
  // Default + full-assignment head + 98 independently consented catalog heads.
  for (let index = 2; index < limits.max_catalogs; index++) {
    const p = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f, {
      name: 'Own capacity catalog ' + index,
    }), 201)).preview;
    assert.equal(p.ready, true);
    const made = await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), 201);
    assert.equal(made.catalog.is_default, false); assert.equal(String(made.catalog.version), '1');
  }
  measurements.other_catalog_birth_ms = performance.now() - birthStart;
  await pool.query('SELECT product_catalog_budget($1)', [f.tenant]);
  const listStart = performance.now();
  const first = await f.ok('/product-catalogs?limit=50');
  assert.equal(first.data.length, 50); assert.equal(typeof first.next_cursor, 'string');
  const second = await f.ok('/product-catalogs?limit=50&cursor=' + first.next_cursor);
  assert.equal(second.data.length, 50); assert.equal(second.next_cursor, null);
  const heads = [...first.data, ...second.data];
  assert.equal(new Set(heads.map(c => c.id)).size, 100);
  assert.equal(heads.filter(c => c.is_default).length, 1);
  assert(heads.some(c => c.id === fullHead.id));
  options = await f.ok('/product-catalogs/options');
  assert.equal(options.catalogs.length, 100); assert.equal(options.warehouses.length, 100); assert.equal(options.price_lists.length, 100);
  measurements.list_and_options_ms = performance.now() - listStart;
  measurements.options_json_bytes = Buffer.byteLength(JSON.stringify(options));
  const atCapacity = await productCatalogFacts(f.tenant);
  assert.equal(atCapacity.product_catalogs.length, 100);
  assert.equal(atCapacity.product_catalog_previews.length, 99);
  assert.equal(atCapacity.product_catalog_operations.length, 99);
  businessEqual(resourceBaseline, atCapacity);

  // Exact existing consent still replays at the catalog cap without allocating
  // a new head, admission, operation or audit entry.
  const replay = await f.ok('/product-catalogs/previews/' + fullPreview.id + '/commit', 'POST', consent, 200);
  assert.equal(replay.reused, true); assert.deepEqual(replay.operation, fullResult.operation);
  assert.deepEqual(await productCatalogFacts(f.tenant), atCapacity);

  await t.test('catalog 101: valid preview persists but denied commit adds no business/evidence/audit row', async () => {
    const p = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f, {
      name: 'Own capacity catalog 101 refused',
    }), 201)).preview;
    assert.equal(p.ready, true);
    const beforeCommit = await productCatalogFacts(f.tenant);
    const denied = await f.request('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p));
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json().detail, 'Limit historii katalogów');
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeCommit);
  });

  await t.test('resource 101: real warehouse/list birth trigger rolls back the resource and default catalog version', async () => {
    const beforeBirth = await productCatalogFacts(f.tenant);
    // These aborted tenantTx calls exercise the same INSERT and bootstrap used
    // by the existing resource routes, without asserting their unrelated HTTP
    // error mapper contract. They do not bypass the cap with owner DML.
    await assert.rejects(tenantTx(f.tenant, c => c.query(
      'INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)',
      [randomUUID(), f.tenant, 'Own warehouse 101 refused', 'CAP-' + randomUUID().slice(0, 8)],
    )), sqlRefusal('Limit przypisań katalogu'));
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeBirth);
    await assert.rejects(tenantTx(f.tenant, c => c.query(
      "INSERT INTO price_lists(id,tenant_id,name,currency,fallback,adjustment_bps,adjustment_amount) VALUES($1,$2,$3,'PLN',false,0,0)",
      [randomUUID(), f.tenant, 'Own price list 101 refused'],
    )), sqlRefusal('Limit przypisań katalogu'));
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeBirth);
  });

  await t.test('assignment 101 and language 65 fail at both HTTP schema and independent private SQL validator', async () => {
    for (const extra of [
      { warehouse_ids: [...warehouseIds, randomUUID()] },
      { price_list_ids: [...listIds, randomUUID()] },
      { languages: [...languages, 'pl-x63'] },
    ]) {
      const body = { ...fullBody, client_key: randomUUID(), settings: { ...fullBody.settings, ...extra } };
      const beforeInvalid = await productCatalogFacts(f.tenant);
      assert.equal((await f.request('/product-catalogs/previews', 'POST', body)).statusCode, 422);
      assert.deepEqual(await productCatalogFacts(f.tenant), beforeInvalid);
      await assert.rejects(pool.query('SELECT product_catalog_settings($1::jsonb)', [JSON.stringify(body.settings)]), sqlRefusal('Niepoprawne przypisania katalogu'));
      assert.deepEqual(await productCatalogFacts(f.tenant), beforeInvalid);
    }
    const beforePage = await productCatalogFacts(f.tenant);
    assert.equal((await f.request('/product-catalogs?limit=51')).statusCode, 422);
    assert.deepEqual(await productCatalogFacts(f.tenant), beforePage);
  });
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::integer FROM product_catalogs WHERE tenant_id=$1) catalogs,
    (SELECT count(*)::integer FROM warehouses WHERE tenant_id=$1) warehouses,
    (SELECT count(*)::integer FROM price_lists WHERE tenant_id=$1) price_lists,
    coalesce((SELECT sum(pg_column_size(p)) FROM product_catalog_previews p WHERE tenant_id=$1),0)
      +coalesce((SELECT sum(pg_column_size(p)) FROM product_catalog_operations p WHERE tenant_id=$1),0)
      +coalesce((SELECT sum(pg_column_size(p)) FROM product_catalog_admissions p WHERE tenant_id=$1),0) history_bytes`, [f.tenant])).rows[0];
  assert.equal(counts.catalogs, 100); assert.equal(counts.warehouses, 100); assert.equal(counts.price_lists, 100);
  assert(BigInt(counts.history_bytes) < BigInt(limits.tenant_bytes));
  businessEqual(resourceBaseline, await productCatalogFacts(f.tenant));
  measurements.total_ms = performance.now() - started;
  // Contains only aggregate metrics; no actor IDs, credentials, rows or bodies.
  t.diagnostic(JSON.stringify({ kind: 'CATALOG_BOUNDED_CAPACITY', catalogs: 100, warehouses: 100, price_lists: 100,
    languages_in_full_catalog: 64, catalog_list_pages: 2, history_bytes: Number(counts.history_bytes), ...measurements }));
});
