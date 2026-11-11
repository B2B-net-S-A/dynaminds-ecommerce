import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { bootstrap151169, install152169, fixture169, facts169, own169, raw169,
  consent169, physicalExact169, type Fixture169, type Facts, type Row } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Ordinary HTTP performs fulfillment, RMA and receive.
// Internal BO consent is actual service/SQL, not a public writer-ready claim.
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providerCalls++; throw new Error('No provider in return coordinator169');
  } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const one = (xs: Row[]) => { assert.equal(xs.length, 1); return xs[0]; };
const ids = (xs: Row[]) => xs.map(x => x.id).sort();
function added(a: Facts, b: Facts, table: string) {
  const old = new Set(raw169(a, table).map(x => x.id));
  assert.deepEqual(b[table].filter(x => old.has(x.row.id)), a[table], 'Old append rows exact: ' + table);
  return raw169(b, table).filter(x => !old.has(x.id));
}
async function activate(f: Fixture169) {
  const publicSource = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicSource.activation_available, false); assert.equal(publicSource.writers_available, false);
  const beforeRows = await facts169(), context = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, context);
  assert.equal(source.ready, true); assert.deepEqual(source.blockers, []);
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  assert.equal(preview.ready, true);
  assert.equal((await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context)).operation.after.strict, true);
  physicalExact169(beforeRows, await facts169());
}
async function packed(on: boolean) {
  const f = await fixture169(app, on);
  const product = on ? await f.ok('/products', 'POST', {
    catalog_id: f.primary.id, kind: 'bundle', name: 'Original coordinator bundle', sku: 'COORD169-' + randomUUID(),
    price: 1000, vat: 23, warehouse_id: f.warehouse.id, quantity: 0,
    components: f.products.map(p => ({ product_id: p.id, quantity: 1 })),
  }, 201) : f.products[0];
  let order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own coordinator buyer', email: 'coordinator169@example.test',
    address: { street: 'Own source', city: 'Warszawa', postal_code: '00-169', country: 'PL', phone: '500000169' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: product.id, quantity: 3 }],
    manual_lines: [{ product_id: product.id, quantity: 1, line_total: 1000 }, { product_id: product.id, quantity: 2, line_total: 3401 }],
  }, 201);
  order = await f.ok('/orders/' + order.id);
  assert.equal(order.items.length, 2); assert.equal(new Set(order.items.map((x: Row) => x.id)).size, 2);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version),
    kind: 'receipt', amount: 4401, currency: 'PLN', method: 'other', reference: 'Own local declaration', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  if (on) {
    const page = await f.ok('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(page.meta.cursor, null); assert.equal(page.data.length, 3);
    for (const allocation of page.data) {
      const p = f.products.find(x => x.id === allocation.product_id); assert(p); assert.equal(allocation.quantity, 3);
      for (let n = 0; n < allocation.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: p.sku, location: allocation.location, layer_id: allocation.layer_id,
      });
    }
  } else for (let n = 0; n < 3; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
    client_key: randomUUID(), code: product.sku, location: 'A-01',
  });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  order = await f.ok('/orders/' + order.id);
  return { ...f, product, order };
}
type Fixture = Awaited<ReturnType<typeof packed>> & { rma: Row };
async function requested(f: Awaited<ReturnType<typeof packed>>, kind: 'return' | 'complaint' = 'return') {
  const rma = await f.ok('/orders/' + f.order.id + '/returns', 'POST', {
    client_key: randomUUID(), kind, reason: 'Genuine coordinator intake', shipping_refund: 0,
    items: f.order.items.map((i: Row) => ({ item_id: i.id, quantity: i.quantity })),
  }, 201);
  return { ...f, rma: await f.ok('/returns/' + rma.id) };
}
function physicalGraph(a: Facts, b: Facts, f: Fixture, quantity: number, protocol: string) {
  assert.deepEqual(Object.keys(b), Object.keys(a));
  for (const table of Object.keys(a)) assert.deepEqual(
    b[table].filter(x => x.row.tenant_id !== f.tenant), a[table].filter(x => x.row.tenant_id !== f.tenant),
    'All global/foreign/session rows unchanged: ' + table);
  for (const table of ['sessions', 'payment_entries', 'documents', 'wms_issue_fragments', 'wms_cost_layers', 'wms_lots'])
    assert.deepEqual(b[table], a[table], 'No extra payment, fiscal or original provenance writer: ' + table);
  const admission = one(own169(b, 'catalog_stock_return_admissions', f.tenant));
  const receipt = one(own169(b, 'catalog_stock_return_receipts', f.tenant));
  assert.equal(admission.protocol, protocol); assert.equal(admission.return_id, f.rma.id);
  assert.equal(admission.actor_id, f.user); assert.equal(admission.sealed, true);
  assert.equal(receipt.id, admission.id); assert.equal(receipt.return_id, f.rma.id); assert.equal(receipt.order_id, f.order.id);
  const movements = added(a, b, 'stock_movements'), bins = added(a, b, 'stock_location_movements');
  assert.equal(movements.length, f.products.length); assert.equal(bins.length, f.products.length);
  assert(movements.every(x => x.kind === 'return' && x.order_id === f.order.id && x.return_id === f.rma.id && x.delta === quantity));
  assert(bins.every(x => x.kind === 'stock_in' && x.delta === quantity && x.warehouse_id === f.warehouse.id));
  assert.deepEqual([...receipt.proof.stock_movement_ids].sort(), ids(movements));
  assert.deepEqual([...receipt.proof.location_movement_ids].sort(), ids(bins));
  const document = one(own169(b, 'catalog_stock_return_documents', f.tenant));
  const rows = own169(b, 'catalog_stock_return_rows', f.tenant);
  assert.equal(document.receipt_id, receipt.id); assert.equal(document.return_id, f.rma.id);
  assert.equal(document.payload.kind, 'PZ'); assert.equal(document.payload.quantity, String(quantity * f.products.length));
  assert.equal(document.payload.row_count, f.products.length); assert.equal(document.payload.wms_enabled, f.on);
  const series = one(own169(b, 'catalog_stock_control_series', f.tenant).filter(x => x.id === document.series_id));
  assert.equal(series.kind, 'PZ'); assert.equal(series.warehouse_id, f.warehouse.id);
  assert.equal(document.number, `${series.prefix}/${document.year}/000001`); assert.equal(String(document.sequence), '1');
  const counter = one(own169(b, 'catalog_stock_control_counters', f.tenant).filter(x => x.series_id === series.id && x.year === document.year));
  assert.equal(String(counter.value), '1'); assert.equal(rows.length, bins.length);
  assert.deepEqual(rows.map(x => x.bin_movement_id).sort(), ids(bins));
  for (const p of f.products) {
    const row = one(rows.filter(x => x.product_id === p.id)); assert.equal(row.quantity, quantity);
    const bin = one(bins.filter(x => x.id === row.bin_movement_id)); assert.equal(bin.product_id, p.id);
    assert.equal(row.location, bin.location); assert.equal(row.payload.bin_movement_id, bin.id);
    const oldStock = one(own169(a, 'stock', f.tenant).filter(x => x.product_id === p.id && x.warehouse_id === f.warehouse.id));
    const stock = one(own169(b, 'stock', f.tenant).filter(x => x.product_id === p.id && x.warehouse_id === f.warehouse.id));
    assert.equal(stock.on_hand, oldStock.on_hand + quantity);
    const oldBin = own169(a, 'stock_locations', f.tenant).find(x => x.product_id === p.id && x.warehouse_id === f.warehouse.id && x.location === bin.location);
    const newBin = one(own169(b, 'stock_locations', f.tenant).filter(x => x.product_id === p.id && x.warehouse_id === f.warehouse.id && x.location === bin.location));
    assert.equal(newBin.quantity, (oldBin?.quantity ?? 0) + quantity);
    const itemMaps = own169(b, 'catalog_stock_return_item_maps', f.tenant).filter(x => x.row_id === row.id);
    assert.equal(itemMaps.reduce((n, x) => n + x.quantity, 0), quantity);
    assert(itemMaps.every(x => f.rma.items.some((i: Row) => i.item_id === x.item_id)));
    const stockMaps = own169(b, 'catalog_stock_return_stock_maps', f.tenant).filter(x => x.row_id === row.id);
    assert.equal(stockMaps.reduce((n, x) => n + x.quantity, 0), quantity);
    assert(stockMaps.every(x => movements.some(j => j.id === x.stock_movement_id && j.product_id === p.id)));
  }
  assert.deepEqual(b.stock.filter(x => !f.products.some(p => p.id === x.row.product_id)), a.stock.filter(x => !f.products.some(p => p.id === x.row.product_id)));
  const effect = one(own169(b, 'catalog_stock_control_effects', f.tenant).filter(x => x.admission_id === admission.id));
  assert.deepEqual(effect.proof.stock_movement_ids, receipt.proof.stock_movement_ids);
  if (!f.on) {
    assert.equal(receipt.wms_operation_id, null);
    for (const table of Object.keys(a).filter(x => x.startsWith('wms_'))) assert.deepEqual(b[table], a[table], 'OFF has no WMS writer: ' + table);
  } else {
    const op = one(added(a, b, 'wms_operations'));
    assert.equal(op.id, receipt.wms_operation_id); assert.equal(op.kind, 'return'); assert.equal(op.return_id, f.rma.id);
    const fragments = added(a, b, 'wms_return_fragments'), maps = own169(b, 'catalog_stock_return_layer_maps', f.tenant);
    assert.equal(fragments.length, f.products.length); assert.equal(maps.length, fragments.length);
    assert.equal(maps.filter(x => x.payload.unit_cost_minor === '0').length, 1);
    assert.equal(maps.filter(x => x.payload.unit_cost_minor === null).length, 1);
    for (const map of maps) {
      const fragment = one(fragments.filter(x => x.id === map.fragment_id));
      const issued = one(own169(a, 'wms_issue_fragments', f.tenant).filter(x => x.id === fragment.issue_fragment_id));
      const layer = one(own169(a, 'wms_cost_layers', f.tenant).filter(x => x.id === fragment.layer_id));
      assert.equal(fragment.layer_id, issued.layer_id); assert.equal(fragment.quantity, quantity);
      assert.equal(map.payload.issue_fragment_id, issued.id); assert.equal(map.payload.lot_id, layer.lot_id);
      const cost = layer.unit_cost_minor === null ? null : String(layer.unit_cost_minor);
      assert.equal(map.payload.unit_cost_minor, cost);
      assert.equal(map.payload.value_minor, cost === null ? null : String(BigInt(cost) * BigInt(quantity)));
      const journal = one(added(a, b, 'wms_layer_movements').filter(x => x.id === map.layer_movement_id));
      assert.equal(journal.operation_id, op.id); assert.equal(journal.layer_id, issued.layer_id); assert.equal(journal.delta, quantity);
      assert.equal(journal.value_delta === null ? null : String(journal.value_delta), cost === null ? null : String(BigInt(cost) * BigInt(quantity)));
    }
  }
  return { receipt, document, rows };
}

for (const on of [false, true]) test(`strict ${on ? 'ON' : 'OFF'} commercial parcel138 receives duplicate commercial items once, creates native138 before PZ and preserves exact replay`, async () => {
  let f = await packed(on);
  const expensive = f.order.items.find((i: Row) => i.line_total === 3401); assert(expensive);
  const preview = (await f.ok('/order-parcels/orders/' + f.order.id + '/previews', 'POST', {
    client_key: randomUUID(), order_version: String(f.order.version), protocol: 'commercial_v1', parcels: [
      { source_kind: 'demo', cod_minor: 0, items: f.order.items.map((i: Row) => ({ item_id: i.id, quantity: 1 })) },
      { source_kind: 'demo', cod_minor: 0, items: [{ item_id: expensive.id, quantity: 1 }] },
    ],
  }, 201)).preview;
  const plan = (await f.ok('/order-parcels/previews/' + preview.id + '/apply', 'POST', consent169(preview), 201)).plan;
  // Real dispatch uses the same explicit scope/consent schema as plan apply.
  await f.ok('/order-parcels/plans/' + plan.id + '/parcels/0/dispatch', 'POST', consent169(plan));
  await f.ok('/order-parcels/plans/' + plan.id + '/parcels/1/dispatch', 'POST', consent169(plan));
  f = { ...f, order: await f.ok('/orders/' + f.order.id) };
  const origins: Row[] = f.order.returns.parcel_origins.filter((x: Row) => x.parcel_index === 0);
  assert.equal(origins.length, 2); assert(origins.every(x => x.quantity === 1));
  // Genuine BO rejects pending RMA. Activate after both actual dispatches,
  // before requesting a return; never bypass RETURN_PENDING or reservations.
  await activate(f);
  let rma = await f.ok('/orders/' + f.order.id + '/returns', 'POST', {
    client_key: randomUUID(), reason: 'Two distinct original commercial items from first real parcel', shipping_refund: 0,
    items: origins.map(x => ({ item_id: x.item_id, quantity: 1 })),
    parcel_origins: origins.map(x => ({ item_id: x.item_id, dispatch_id: x.dispatch_id, quantity: 1 })),
  }, 201);
  rma = await f.ok('/returns/' + rma.id);
  const actual: Fixture = { ...f, rma };
  const beforeRows = await facts169();
  const body: Row = { version: Number(rma.version), shipping_refund: 0, note: 'Native parcel receipt before strict PZ',
    items: rma.items.map((i: Row) => ({ item_id: i.item_id, accepted: 1, restocked: 1 })) };
  if (on) {
    const picks = origins.flatMap(x => x.fragments.map((fragment: Row) => ({ issue_fragment_id: fragment.fragment_id, quantity: 1, location: 'A-01' })));
    // Actual first-parcel allocation may share a physical issue fragment across original items.
    const quantities = new Map<string, number>();
    for (const pick of picks) quantities.set(pick.issue_fragment_id, (quantities.get(pick.issue_fragment_id) ?? 0) + pick.quantity);
    body.wms_lots = { client_key: randomUUID(), policy_version: '1',
      stock_versions: f.products.map(p => ({ product_id: p.id, warehouse_id: f.warehouse.id,
        version: String(one(own169(beforeRows, 'stock', f.tenant).filter(x => x.product_id === p.id && x.warehouse_id === f.warehouse.id)).version) })),
      picks: [...quantities].map(([issue_fragment_id, quantity]) => ({ issue_fragment_id, quantity, location: 'A-01' })) };
  }
  const result = await f.ok('/returns/' + rma.id + '/receive', 'POST', body);
  assert.equal(result.refund_amount, 2700); assert.equal(result.refunded_shipping, 0);
  const accepted = await facts169(), graph = physicalGraph(beforeRows, accepted, actual, 2, 'rma');
  const native = one(own169(accepted, 'order_parcel_return_receipts', f.tenant));
  assert.equal(native.return_id, rma.id); assert.equal(native.order_id, f.order.id);
  assert.equal(graph.receipt.parcel_receipt_return_id, native.return_id);
  assert.equal(native.payload.decisions.reduce((n: number, x: Row) => n + x.accepted, 0), 2);
  assert.deepEqual(accepted.order_parcel_origin_issues, beforeRows.order_parcel_origin_issues);
  assert.deepEqual(accepted.order_parcel_origin_fragments, beforeRows.order_parcel_origin_fragments);
  assert.deepEqual(accepted.reservations, beforeRows.reservations);
  assert.deepEqual(accepted.reservation_locations, beforeRows.reservation_locations);
  for (const row of graph.rows) {
    const maps = own169(accepted, 'catalog_stock_return_item_maps', f.tenant).filter(x => x.row_id === row.id);
    assert.deepEqual(maps.map(x => [x.item_id, x.quantity]).sort(), origins.map(x => [x.item_id, 1]).sort(), 'Shared physical row conserves both original item UUIDs');
  }
  assert.deepEqual(await f.ok('/returns/' + rma.id + '/receive', 'POST', body), result);
  assert.deepEqual(await facts169(), accepted, 'No new PZ/number/receipt/journal on replay');
  assert.equal((await f.request('/returns/' + rma.id + '/receive', 'POST', { ...body, note: 'Changed historical body' })).statusCode, 409);
  assert.deepEqual(await facts169(), accepted);
});

test('strict OFF exchange120 completes genuine replacement parent before PZ/flush, reserves replacement without a second physical writer and replays exactly', async () => {
  let f = await packed(false);
  await f.ok('/orders/' + f.order.id + '/ship-demo', 'POST', {});
  f = { ...f, order: await f.ok('/orders/' + f.order.id) };
  await activate(f);
  const actual = await requested(f, 'complaint');
  const input = { version: Number(actual.rma.version), warehouse_id: f.warehouse.id, note: 'Separate actual warranty replacement consent',
    items: actual.rma.items.map((i: Row) => ({ item_id: i.item_id, accepted: i.requested, restocked: i.requested })) };
  const preview = (await f.ok('/returns/' + actual.rma.id + '/exchange-preview', 'POST', input)).preview;
  const body = { ...input, ...consent169(preview) }, beforeRows = await facts169();
  const result = await f.ok('/returns/' + actual.rma.id + '/exchange', 'POST', body, 201);
  assert.equal(result.reused, false); assert.equal(result.return.remedy, 'exchange'); assert.equal(result.return.state, 'closed');
  assert.equal(result.return.refund_amount, 0); assert.equal(result.return.refunded_shipping, 0);
  const accepted = await facts169(), graph = physicalGraph(beforeRows, accepted, actual, 3, 'exchange');
  const exchange = one(own169(accepted, 'return_exchanges', f.tenant));
  assert.equal(graph.receipt.exchange_id, exchange.id); assert.equal(exchange.return_id, actual.rma.id);
  const oldOrderIds = new Set(raw169(beforeRows, 'orders').map(x => x.id));
  const replacement = one(raw169(accepted, 'orders').filter(x => !oldOrderIds.has(x.id)));
  assert.deepEqual(accepted.orders.filter(x => oldOrderIds.has(x.row.id) && x.row.id !== f.order.id),
    beforeRows.orders.filter(x => x.row.id !== f.order.id), 'Every unrelated old order is retained literally');
  const oldOriginal = one(raw169(beforeRows, 'orders').filter(x => x.id === f.order.id));
  const original = one(raw169(accepted, 'orders').filter(x => x.id === f.order.id));
  const received = one(own169(accepted, 'return_cases', f.tenant));
  // Core completes full acceptance with one status UPDATE and changed()'s
  // updated_at UPDATE;010 bumps revision for each. No other field may drift.
  assert.equal(oldOriginal.status, 'shipped'); assert.equal(original.status, 'return_received');
  assert.equal(BigInt(original.version), BigInt(oldOriginal.version) + 2n);
  assert.equal(original.updated_at, received.received_at);
  assert.deepEqual(original, { ...oldOriginal, status: 'return_received', workflow_status_id: null,
    version: original.version, updated_at: received.received_at });
  assert.equal(replacement.id, exchange.replacement_order_id); assert.equal(replacement.id, result.replacement_order.id);
  assert.equal(replacement.fulfillment_kind, 'replacement'); assert.equal(replacement.replacement_return_id, actual.rma.id);
  assert.equal(replacement.total, 0); assert.equal(replacement.shipping_cost, 0); assert.equal(replacement.status, 'paid');
  const mappings = own169(accepted, 'return_exchange_items', f.tenant);
  assert.equal(mappings.length, 2); assert.equal(new Set(mappings.map(x => x.original_item_id)).size, 2);
  assert.equal(mappings.reduce((n, x) => n + x.accepted, 0), 3);
  assert(mappings.every(x => x.exchange_id === exchange.id && x.replacement_order_id === replacement.id));
  assert.equal(one(own169(accepted, 'stock', f.tenant).filter(x => x.product_id === f.product.id && x.warehouse_id === f.warehouse.id)).reserved, 3);
  const replay = await f.ok('/returns/' + actual.rma.id + '/exchange', 'POST', body);
  assert.equal(replay.reused, true); assert.deepEqual(replay.return, result.return); assert.deepEqual(replay.exchange, result.exchange);
  assert.deepEqual(await facts169(), accepted);
  assert.equal((await f.request('/returns/' + actual.rma.id + '/exchange', 'POST', { ...body, note: 'Different exchange consent' })).statusCode, 409);
  assert.deepEqual(await facts169(), accepted);
});

test('strict OFF legacy return_received completes outer order transition before PZ seal; repeated status preserves existing409 and has no effects', async () => {
  let f = await packed(false);
  await f.ok('/orders/' + f.order.id + '/ship-demo', 'POST', {});
  await activate(f);
  await f.ok('/orders/' + f.order.id + '/status', 'PATCH', { status: 'return_initiated' });
  f = { ...f, order: await f.ok('/orders/' + f.order.id) };
  const rma = await f.ok('/returns/' + one(f.order.returns.cases).id);
  assert.equal(rma.legacy, true); assert.equal(rma.state, 'requested');
  const actual: Fixture = { ...f, rma };
  const beforeRows = await facts169();
  const result = await f.ok('/orders/' + f.order.id + '/status', 'PATCH', { status: 'return_received' });
  assert.equal(result.status, 'return_received');
  const accepted = await facts169(), graph = physicalGraph(beforeRows, accepted, actual, 3, 'legacy_status');
  assert.equal(graph.receipt.exchange_id, null); assert.equal(graph.receipt.parcel_receipt_return_id, null);
  assert.equal(one(own169(accepted, 'return_cases', f.tenant)).legacy, true);
  assert.equal(one(own169(accepted, 'return_cases', f.tenant)).refund_amount, 4401);
  assert.equal(one(own169(accepted, 'stock', f.tenant).filter(x => x.product_id === f.product.id && x.warehouse_id === f.warehouse.id)).reserved, 0);
  assert.equal((await f.request('/orders/' + f.order.id + '/status', 'PATCH', { status: 'return_received' })).statusCode, 409);
  assert.deepEqual(await facts169(), accepted, 'Legacy same-status refusal adds no movement, credit, counter or transition event');
  assert.equal((await f.ok('/orders/' + f.order.id)).status, 'return_received');
  assert.deepEqual(await facts169(), accepted, 'Historical GET preserves accepted graph');
});
