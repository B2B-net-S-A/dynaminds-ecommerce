import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, tenantReadTx, tenantTx } from '../server/db';
import { productSchema } from '../server/domain';
import { locationCount } from '../server/stock-locations';
import { catalogStockControlAvailable, sourceCatalogStockControl,
  previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import { seed } from './fixtures';
import { bootstrap151169, install152169, fixture169, facts169, consent169,
  own169, type Row } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Root owns the isolated numeric PG database and runs
// these genuine transactions/routes. No weakened manifest or legacy fallback.
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
const transport = async () => { providerCalls++; throw Error('No provider in degraded COUNT169'); };
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: transport, backgroundWorkersEnabled: false });
});
after(async () => {
  try { assert.equal(providerCalls, 0); await app?.close(); }
  finally { await pool.end(); }
});
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };

test('tenantReadTx enforces actual SQL25006 for stock and product DML with every global row/session unchanged', async () => {
  const f = await fixture169(app, false);
  const baseline = await facts169(), p = f.products[0];
  for (const statement of [
    { sql: 'UPDATE public.stock SET on_hand=on_hand+1 WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      params: [f.tenant, f.warehouse.id, p.id] },
    { sql: 'UPDATE public.products SET name=name||$3 WHERE tenant_id=$1 AND id=$2',
      params: [f.tenant, p.id, ' forbidden readonly edit'] },
  ]) {
    let observedOwnRow = false;
    await assert.rejects(tenantReadTx(f.tenant, async c => {
      const context = one((await c.query(`SELECT current_user role,current_setting('app.tenant_id') tenant,
        current_setting('transaction_read_only') read_only,current_setting('transaction_isolation') isolation`)).rows);
      assert.equal(context.role, 'dyna_app'); assert.equal(context.tenant, f.tenant);
      assert.equal(context.read_only, 'on'); assert.equal(context.isolation, 'repeatable read');
      const row = one((await c.query('SELECT id,tenant_id FROM products WHERE id=$1', [p.id])).rows);
      assert.equal(row.id, p.id); assert.equal(row.tenant_id, f.tenant); observedOwnRow = true;
      await c.query(statement.sql, statement.params);
    }), error => {
      assert.equal((error as { code?: string }).code, '25006', 'Database, not a UI guard, rejects DML');
      return true;
    });
    assert.equal(observedOwnRow, true, 'The denied DML targeted a real visible own product/stock');
    assert.deepEqual(await facts169(), baseline, 'Full rows, journals, counters and sessions unchanged after denied DML');
  }
});

test('renamed086 parent leaves two genuine GETs readable while startup reports unavailable and every managed writer still refuses503', async () => {
  const f = await fixture169(app, false), ctx = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, ctx);
  assert.equal(source.ready, true, JSON.stringify(source.blockers));
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version,
    policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.series.version })),
  }, ctx);
  assert.equal((await commitCatalogStockControl(f.actor, preview.id, consent169(preview), ctx)).operation.after.strict, true);
  const beforeRename = await facts169(), p = f.products[0];
  const stock = one(own169(beforeRename, 'stock', f.tenant).filter(s => s.product_id === p.id && s.warehouse_id === f.warehouse.id));
  const bins = own169(beforeRename, 'stock_locations', f.tenant).filter(s => s.product_id === p.id && s.warehouse_id === f.warehouse.id);
  assert.equal(bins.length, 1, 'Genuine fixture product has one existing positive bin');
  const birth = productSchema.parse({ catalog_id: f.primary.id, name: 'Valid strict zero product awaiting healthy publisher',
    sku: 'DEGRADED169-' + randomUUID(), price: 1000, vat: 23,
    warehouse_id: f.warehouse.id, quantity: 0, location: 'NEW-169' });
  const count = locationCount.parse({ warehouse_id: f.warehouse.id, product_id: p.id, location: bins[0].location,
    quantity: bins[0].quantity + 1, expected_version: String(stock.version), client_key: randomUUID(), note: 'Valid physical count denied by unavailable publisher' });
  let degraded: Awaited<ReturnType<typeof buildApp>> | undefined;
  await pool.query('ALTER TABLE public.inventory_bulk_edit_previews RENAME TO inventory_bulk_edit_previews_hidden_qa169');
  try {
    const baseline = await facts169(); // Explicitly after the intentional rename, including all sessions.
    degraded = await buildApp({ integrationTransport: transport, backgroundWorkersEnabled: false });
    const get = (path: string) => degraded!.inject({ method: 'GET', url: '/api' + path, headers: { cookie: f.cookie } });
    const health = await get('/health'); assert.equal(health.statusCode, 200, health.body);
    assert.equal(health.json().catalog_stock_control_status, 'unavailable');
    assert.equal(health.json().catalog_stock_control_available, false);
    assert.equal(health.json().background_workers_enabled, false);
    assert.equal(health.json().inventory_bulk_edit_available, false);
    const product = await get('/products/' + p.id); assert.equal(product.statusCode, 200, product.body);
    assert.equal(product.json().id, p.id); assert.equal(product.json().tenant_id, f.tenant);
    assert.equal(product.json().stock.find((s: Row) => s.warehouse_id === f.warehouse.id).on_hand, stock.on_hand);
    const locations = await get('/stock-locations?warehouse_id=' + f.warehouse.id + '&product_id=' + p.id);
    assert.equal(locations.statusCode, 200, locations.body); assert.equal(locations.json().meta.cursor, null);
    assert.deepEqual(locations.json().data.map((b: Row) => [b.product_id, b.warehouse_id, b.location, b.quantity]).sort(),
      bins.map(b => [b.product_id, b.warehouse_id, b.location, b.quantity]).sort());
    const metadata = await get('/inventory-bulk-edit'); assert.equal(metadata.statusCode, 200, metadata.body);
    assert.equal(metadata.json().available, false); assert.equal(metadata.json().can_write, false);
    assert.deepEqual(metadata.json().data, []);
    const malformed = await degraded.inject({ method: 'POST', url: '/api/inventory-bulk-edit/previews',
      headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{' });
    assert.equal(malformed.statusCode, 503, malformed.body);
    for (const [path, body] of [['/products', birth], ['/stock-location-counts', count]] as const) {
      const denied: { statusCode: number; body: string } = await degraded.inject({ method: 'POST', url: '/api' + path, headers: { cookie: f.cookie }, payload: body });
      assert.equal(denied.statusCode, 503, denied.body);
      assert.deepEqual(await facts169(), baseline, 'No legacy fallback/physical or PIM writes: ' + path);
    }
    let callbackEntered = false;
    await assert.rejects(tenantTx(f.tenant, async () => { callbackEntered = true; return true; }), error => {
      assert.equal((error as { status?: number }).status, 503); return true;
    });
    assert.equal(callbackEntered, false, 'Full admission refuses before any ordinary writer callback');
    await assert.rejects(catalogStockControlAvailable(pool), error => {
      assert.equal((error as { status?: number }).status, 503); return true;
    });
    assert.deepEqual(await facts169(), baseline, 'Full global rows and all sessions unchanged by startup, reads and denied writers');
  } finally {
    try { await degraded?.close(); }
    finally { await pool.query('ALTER TABLE public.inventory_bulk_edit_previews_hidden_qa169 RENAME TO inventory_bulk_edit_previews'); }
  }
  assert.equal(await catalogStockControlAvailable(pool), true, 'Original guard passes again without manifest rebase or repair');
  assert.deepEqual(await facts169(), beforeRename, 'Restoring only the original name leaves every original row/session exact');
});
