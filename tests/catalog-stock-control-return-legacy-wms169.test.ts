import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { bootstrap151169, install152169, fixture169, facts169, own169, raw169,
  physicalExact169, consent169, type Fixture169, type Facts, type Row } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_EXECUTED. Root runs in an exclusively owned numeric DB.
// Real status-origin RMA -> ordinary receive endpoint, never private parents or
// synthetic physical journals. Public BO writer capability remains false.
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providerCalls++; throw new Error('No provider calls in legacy WMS return regression');
  } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
const ids = (rows: Row[]) => rows.map(r => r.id).sort();
function added(a: Facts, b: Facts, table: string) {
  const old = new Set(raw169(a, table).map(r => r.id));
  assert.deepEqual(b[table].filter(r => old.has(r.row.id)), a[table], 'Every old journal/parent retained: ' + table);
  return raw169(b, table).filter(r => !old.has(r.id));
}
async function activate(f: Fixture169) {
  const publicReply = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicReply.writers_available, false); assert.equal(publicReply.activation_available, false);
  const beforeRows = await facts169(), context = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, context);
  assert.equal(source.ready, true, JSON.stringify(source.blockers));
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  assert.equal(preview.ready, true);
  assert.equal((await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context)).operation.after.strict, true);
  physicalExact169(beforeRows, await facts169());
}
async function fixture(on: boolean) {
  const f = await fixture169(app, on);
  const product = on ? await f.ok('/products', 'POST', {
    catalog_id: f.primary.id, name: 'Actual legacy-origin zero/known/unknown bundle', sku: 'LEGACY169-' + randomUUID(),
    kind: 'bundle', price: 1501, vat: 23, warehouse_id: f.warehouse.id, quantity: 0,
    components: f.products.map(p => ({ product_id: p.id, quantity: 1 })),
  }, 201) : f.products[0];
  let order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own legacy-origin buyer', email: 'legacy169@example.test',
    address: { street: 'Own legacy169', city: 'Warszawa', postal_code: '00-169', country: 'PL', phone: '500000169' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: product.id, quantity: 1 }],
  }, 201);
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', {
    client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: 1501, currency: 'PLN',
    method: 'other', reference: 'Local declaration', confirmed: true,
  });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  if (on) {
    const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(allocations.meta.cursor, null); assert.equal(allocations.data.length, 3);
    for (const allocation of allocations.data) {
      const component = f.products.find(p => p.id === allocation.product_id); assert(component);
      assert.equal(allocation.quantity, 1);
      await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: component.sku, location: allocation.location, layer_id: allocation.layer_id,
      });
    }
  } else await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: product.sku, location: 'A-01' });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  await f.ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  order = await f.ok('/orders/' + order.id);
  await activate(f); // Requested RMA is deliberately created AFTER BO.
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'return_initiated' }));
  const listed = await f.ok('/orders/' + order.id + '/returns');
  const head = one(listed.cases);
  const rma = await f.ok('/returns/' + head.id);
  assert.equal(rma.legacy, true); assert.equal(rma.state, 'requested');
  const body = { version: Number(rma.version), note: 'Actual legacy-origin explicit return', shipping_refund: 0,
    items: rma.items.map((i: Row) => ({ item_id: i.item_id, accepted: i.requested, restocked: i.requested })) };
  return { ...f, product, order, rma, body };
}

test('strict ON legacy-origin RMA ordinary receive uses real WMS fragments and one typed PZ; 0/NULL and exact replay preserved', async () => {
  const f = await fixture(true), initial = await facts169();
  // Ordinary no-lot input may not infer WMS picks. (The status path is the legacy ON command, tested below.)
  assert.equal((await f.request('/returns/' + f.rma.id + '/receive', 'POST', f.body)).statusCode, 409);
  assert.deepEqual(await facts169(), initial);
  const fragments = own169(initial, 'wms_issue_fragments', f.tenant).filter(r => r.order_id === f.order.id);
  assert.equal(fragments.length, 3); assert(fragments.every(r => r.quantity === 1));
  const policy = one(own169(initial, 'wms_policies', f.tenant)); assert.equal(policy.enabled, true);
  const body = { ...f.body, wms_lots: { client_key: randomUUID(), policy_version: String(policy.version),
    stock_versions: f.products.map(p => ({ product_id: p.id, warehouse_id: f.warehouse.id,
      version: String(one(own169(initial, 'stock', f.tenant).filter(s => s.product_id === p.id && s.warehouse_id === f.warehouse.id)).version) })),
    picks: fragments.map(r => ({ issue_fragment_id: r.id, quantity: 1, location: 'A-01' })),
  } };
  const result = await f.ok('/returns/' + f.rma.id + '/receive', 'POST', body);
  assert.equal(result.legacy, true); assert.equal(result.state, 'refund_pending'); assert.equal(result.refund_amount, 1501);
  assert.equal(result.settlement, null); assert.deepEqual(result.receipt, body);
  const accepted = await facts169();
  assert.deepEqual(Object.keys(accepted), Object.keys(initial));
  for (const table of Object.keys(initial)) assert.deepEqual(
    accepted[table].filter(x => x.row.tenant_id !== f.tenant), initial[table].filter(x => x.row.tenant_id !== f.tenant),
    'Every foreign/global row and session retained: ' + table);
  for (const table of ['sessions', 'order_items', 'payment_entries', 'documents', 'reservations', 'reservation_locations',
    'wms_lots', 'wms_cost_layers', 'wms_issue_fragments', 'wms_policies']) assert.deepEqual(accepted[table], initial[table], table);
  for (const table of ['stock', 'stock_locations', 'wms_layer_positions']) {
    const outside = (r: Row) => !(r.tenant_id === f.tenant && r.warehouse_id === f.warehouse.id &&
      f.products.some(p => p.id === r.product_id) && (table === 'stock' || r.location === 'A-01'));
    assert.deepEqual(accepted[table].filter(x => outside(x.row)), initial[table].filter(x => outside(x.row)),
      'Every physical cell outside the actual received fragments unchanged: ' + table);
  }
  for (const table of ['orders', 'return_cases', 'return_items']) {
    const outside = (r: Row) => table === 'orders' ? r.id !== f.order.id :
      table === 'return_cases' ? r.id !== f.rma.id : r.return_id !== f.rma.id;
    assert.deepEqual(accepted[table].filter(x => outside(x.row)), initial[table].filter(x => outside(x.row)),
      'Every unrelated native order/RMA unchanged: ' + table);
  }
  const admission = one(own169(accepted, 'catalog_stock_return_admissions', f.tenant));
  const receipt = one(own169(accepted, 'catalog_stock_return_receipts', f.tenant));
  const document = one(own169(accepted, 'catalog_stock_return_documents', f.tenant));
  const rows = own169(accepted, 'catalog_stock_return_rows', f.tenant);
  assert.equal(admission.protocol, 'rma'); assert.equal(admission.return_id, f.rma.id); assert.equal(admission.sealed, true);
  assert.equal(admission.actor_id, f.user); assert.equal(admission.api_key_id, null); assert.deepEqual(admission.frame.request, body);
  assert.equal(receipt.id, admission.id); assert.equal(receipt.return_id, f.rma.id); assert.equal(receipt.assistant_receipt_id, null);
  assert.equal(document.receipt_id, receipt.id); assert.equal(document.return_id, f.rma.id); assert.equal(document.warehouse_id, f.warehouse.id);
  assert.equal(document.payload.kind, 'PZ'); assert.equal(document.payload.wms_enabled, true);
  assert.equal(document.payload.quantity, '3'); assert.equal(document.payload.row_count, 3); assert.equal(rows.length, 3);
  const series = one(own169(accepted, 'catalog_stock_control_series', f.tenant).filter(s => s.id === document.series_id));
  assert.equal(series.kind, 'PZ'); assert.equal(document.number, `${series.prefix}/${document.year}/000001`);
  assert.equal(String(one(own169(accepted, 'catalog_stock_control_counters', f.tenant).filter(c => c.series_id === series.id && c.year === document.year)).value), '1');
  assert.deepEqual(result.stock_receipts, [document.payload]);
  const physical = added(initial, accepted, 'stock_movements'), bins = added(initial, accepted, 'stock_location_movements');
  const op = one(added(initial, accepted, 'wms_operations')), layers = added(initial, accepted, 'wms_layer_movements');
  const returned = added(initial, accepted, 'wms_return_fragments'), maps = own169(accepted, 'catalog_stock_return_layer_maps', f.tenant);
  assert.equal(physical.length, 3); assert.equal(bins.length, 3); assert.equal(layers.length, 3); assert.equal(returned.length, 3); assert.equal(maps.length, 3);
  assert.equal(op.id, receipt.wms_operation_id); assert.equal(op.kind, 'return'); assert.equal(op.return_id, f.rma.id);
  assert.equal(op.order_id, f.order.id); assert.equal(op.warehouse_document_id, null);
  assert.deepEqual([...receipt.proof.stock_movement_ids].sort(), ids(physical));
  assert.deepEqual([...receipt.proof.location_movement_ids].sort(), ids(bins));
  assert.deepEqual(rows.map(r => r.bin_movement_id).sort(), ids(bins));
  assert.equal(maps.filter(m => m.payload.unit_cost_minor === '0').length, 1);
  assert.equal(maps.filter(m => m.payload.unit_cost_minor === '1000').length, 1);
  assert.equal(maps.filter(m => m.payload.unit_cost_minor === null).length, 1);
  for (const [ordinal, row] of rows.sort((a, b) => a.ordinal - b.ordinal).entries()) {
    assert.equal(row.ordinal, ordinal); assert.equal(row.document_id, document.id); assert.equal(row.quantity, 1); assert.equal(row.location, 'A-01');
    const journal = one(bins.filter(j => j.id === row.bin_movement_id));
    assert.equal(journal.kind, 'stock_in'); assert.equal(journal.delta, 1); assert.equal(journal.product_id, row.product_id);
    assert.equal(journal.warehouse_id, row.warehouse_id); assert.equal(journal.location, row.location);
    const aggregate = one(physical.filter(j => j.product_id === row.product_id));
    assert.equal(aggregate.kind, 'return'); assert.equal(aggregate.delta, 1); assert.equal(aggregate.return_id, f.rma.id);
    assert.equal(aggregate.order_id, f.order.id); assert.equal(aggregate.warehouse_id, row.warehouse_id);
    const stockMap = one(own169(accepted, 'catalog_stock_return_stock_maps', f.tenant).filter(m => m.row_id === row.id));
    assert.equal(stockMap.stock_movement_id, aggregate.id); assert.equal(stockMap.quantity, 1);
    const map = one(maps.filter(m => m.row_id === row.id)), fragment = one(returned.filter(r => r.id === map.fragment_id));
    const issued = one(fragments.filter(r => r.id === fragment.issue_fragment_id));
    const layer = one(own169(initial, 'wms_cost_layers', f.tenant).filter(l => l.id === issued.layer_id));
    const movement = one(layers.filter(j => j.id === map.layer_movement_id));
    assert.equal(fragment.layer_id, issued.layer_id); assert.equal(fragment.quantity, 1);
    assert.equal(map.payload.issue_fragment_id, issued.id); assert.equal(map.payload.layer_id, layer.id); assert.equal(map.payload.lot_id, layer.lot_id);
    const cost = layer.unit_cost_minor === null ? null : String(layer.unit_cost_minor);
    assert.equal(map.payload.unit_cost_minor, cost); assert.equal(map.payload.value_minor, cost);
    assert.equal(movement.operation_id, op.id); assert.equal(movement.layer_id, layer.id); assert.equal(movement.delta, 1);
    assert.equal(movement.value_delta, cost === null ? null : Number(cost));
    const oldStock = one(own169(initial, 'stock', f.tenant).filter(s => s.product_id === row.product_id && s.warehouse_id === row.warehouse_id));
    const stock = one(own169(accepted, 'stock', f.tenant).filter(s => s.product_id === row.product_id && s.warehouse_id === row.warehouse_id));
    assert.equal(stock.on_hand, oldStock.on_hand + 1); assert.equal(stock.reserved, oldStock.reserved);
    assert.equal(stock.available, stock.on_hand - stock.reserved); assert.equal(Number(stock.version), Number(oldStock.version) + 1);
    const oldBin = one(own169(initial, 'stock_locations', f.tenant).filter(s => s.product_id === row.product_id && s.warehouse_id === row.warehouse_id && s.location === row.location));
    const bin = one(own169(accepted, 'stock_locations', f.tenant).filter(s => s.product_id === row.product_id && s.warehouse_id === row.warehouse_id && s.location === row.location));
    assert.equal(bin.quantity, oldBin.quantity + 1);
    const beforePosition = one(own169(initial, 'wms_layer_positions', f.tenant).filter(s => s.layer_id === layer.id && s.warehouse_id === row.warehouse_id && s.location === row.location));
    const position = one(own169(accepted, 'wms_layer_positions', f.tenant).filter(s => s.layer_id === layer.id && s.warehouse_id === row.warehouse_id && s.location === row.location));
    assert.equal(position.quantity, beforePosition.quantity + 1); assert.equal(position.reserved, beforePosition.reserved);
  }
  await f.ok('/returns/' + f.rma.id + '/receive', 'POST', body);
  assert.deepEqual(await facts169(), accepted, 'Exact legacy-origin WMS replay allocates no number or second physical/financial/session write');
  assert.equal((await f.request('/returns/' + f.rma.id + '/receive', 'POST', { ...body, note: 'Another request' })).statusCode, 409);
  assert.deepEqual(await facts169(), accepted);
});

test('strict ON legacy-origin status return_received completes the RMA through the WMS command once; no second physical write', async () => {
  const f = await fixture(true), initial = await facts169();
  const status = async () => legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + f.order.id + '/status', { status: 'return_received' });
  // Allowed on purpose: transitionDirectLegacyOnReturnInTx (server/legacy-return-on-command.ts) receives the one requested legacy RMA.
  await f.ok('/orders/' + f.order.id + '/status', 'PATCH', await status());
  const accepted = await facts169(), rma = await f.ok('/returns/' + f.rma.id);
  assert.equal(rma.state, 'refund_pending'); assert.equal(rma.refund_amount, 1501);
  for (const table of Object.keys(initial)) assert.deepEqual(
    accepted[table].filter(x => x.row.tenant_id !== f.tenant), initial[table].filter(x => x.row.tenant_id !== f.tenant),
    'Every foreign/global row and session retained: ' + table);
  const fragments = own169(initial, 'wms_issue_fragments', f.tenant).filter(r => r.order_id === f.order.id);
  assert.equal(fragments.length, 3);
  const admission = one(own169(accepted, 'catalog_stock_return_admissions', f.tenant));
  const receipt = one(own169(accepted, 'catalog_stock_return_receipts', f.tenant));
  const document = one(own169(accepted, 'catalog_stock_return_documents', f.tenant));
  const rows = own169(accepted, 'catalog_stock_return_rows', f.tenant);
  assert.equal(admission.protocol, 'legacy_status'); assert.equal(admission.return_id, f.rma.id); assert.equal(admission.sealed, true);
  assert.equal(receipt.id, admission.id); assert.equal(document.receipt_id, receipt.id);
  assert.equal(document.payload.kind, 'PZ'); assert.equal(document.payload.wms_enabled, true);
  assert.equal(document.payload.quantity, '3'); assert.equal(rows.length, 3);
  // Stock comes in through the WMS command: one return operation, one returned fragment and layer movement per issued unit.
  const op = one(added(initial, accepted, 'wms_operations'));
  assert.equal(op.id, receipt.wms_operation_id); assert.equal(op.kind, 'return'); assert.equal(op.return_id, f.rma.id); assert.equal(op.order_id, f.order.id);
  const physical = added(initial, accepted, 'stock_movements'), bins = added(initial, accepted, 'stock_location_movements');
  const returned = added(initial, accepted, 'wms_return_fragments'), layers = added(initial, accepted, 'wms_layer_movements');
  assert.equal(physical.length, 3); assert.equal(bins.length, 3); assert.equal(returned.length, 3); assert.equal(layers.length, 3);
  assert.deepEqual(returned.map(r => r.issue_fragment_id).sort(), ids(fragments));
  assert(layers.every(m => m.operation_id === op.id && m.delta === 1));
  assert.deepEqual([...receipt.proof.stock_movement_ids].sort(), ids(physical));
  assert.deepEqual([...receipt.proof.location_movement_ids].sort(), ids(bins));
  for (const p of f.products) {
    const aggregate = one(physical.filter(j => j.product_id === p.id));
    assert.equal(aggregate.kind, 'return'); assert.equal(aggregate.delta, 1); assert.equal(aggregate.return_id, f.rma.id);
    const oldStock = one(own169(initial, 'stock', f.tenant).filter(s => s.product_id === p.id && s.warehouse_id === f.warehouse.id));
    const stock = one(own169(accepted, 'stock', f.tenant).filter(s => s.product_id === p.id && s.warehouse_id === f.warehouse.id));
    assert.equal(stock.on_hand, oldStock.on_hand + 1); assert.equal(stock.reserved, oldStock.reserved);
  }
  // No double movement: neither a repeated status nor the ordinary receive with the same picks writes again.
  assert.equal((await f.request('/orders/' + f.order.id + '/status', 'PATCH', await status())).statusCode, 409);
  assert.deepEqual(await facts169(), accepted);
  const policy = one(own169(accepted, 'wms_policies', f.tenant));
  const current = await f.ok('/returns/' + f.rma.id);
  const body = { ...f.body, version: Number(current.version), wms_lots: { client_key: randomUUID(), policy_version: String(policy.version),
    stock_versions: f.products.map(p => ({ product_id: p.id, warehouse_id: f.warehouse.id,
      version: String(one(own169(accepted, 'stock', f.tenant).filter(s => s.product_id === p.id && s.warehouse_id === f.warehouse.id)).version) })),
    picks: fragments.map(r => ({ issue_fragment_id: r.id, quantity: 1, location: 'A-01' })),
  } };
  assert.equal((await f.request('/returns/' + f.rma.id + '/receive', 'POST', body)).statusCode, 409);
  assert.deepEqual(await facts169(), accepted, 'Received once: no second number, PZ, stock, bin or layer write');
});

test('strict OFF legacy-origin ordinary receive stays refused; genuine legacy_status completion still posts one PZ', async () => {
  const f = await fixture(false), beforeRows = await facts169();
  assert.equal((await f.request('/returns/' + f.rma.id + '/receive', 'POST', f.body)).statusCode, 409);
  assert.deepEqual(await facts169(), beforeRows);
  await f.ok('/orders/' + f.order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + f.order.id + '/status', { status: 'return_received' }));
  const accepted = await facts169(), rma = await f.ok('/returns/' + f.rma.id);
  assert.equal(rma.state, 'refund_pending');
  const admission = one(own169(accepted, 'catalog_stock_return_admissions', f.tenant));
  const receipt = one(own169(accepted, 'catalog_stock_return_receipts', f.tenant));
  const document = one(own169(accepted, 'catalog_stock_return_documents', f.tenant));
  assert.equal(admission.protocol, 'legacy_status'); assert.equal(admission.sealed, true); assert.equal(receipt.id, admission.id);
  assert.equal(receipt.wms_operation_id, null); assert.equal(document.payload.wms_enabled, false); assert.equal(document.payload.quantity, '1');
  assert.equal(added(beforeRows, accepted, 'stock_movements').length, 1); assert.equal(added(beforeRows, accepted, 'stock_location_movements').length, 1);
  for (const table of Object.keys(beforeRows).filter(t => t.startsWith('wms_'))) assert.deepEqual(accepted[table], beforeRows[table]);
  assert.deepEqual(await facts169(), accepted, 'Post-read state unchanged');
});
