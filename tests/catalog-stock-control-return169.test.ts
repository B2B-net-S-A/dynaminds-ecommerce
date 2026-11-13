import { after, before, test } from 'node:test';
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

// SOURCE_AUTHORED_NOT_RUN. Root runs this alone in a fresh numeric scratch DB.
// No standalone fragment application, direct private authority INSERT, fake
// physical callback or test wrapper: ordinary return HTTP must be integrated.
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providerCalls++; throw new Error('No external transport in strict return169');
  } });
  app.addHook('onError', async (_request, _reply, error) => {
    const e = error as { code?: string; message?: string; table?: string; column?: string; constraint?: string; detail?: string; where?: string };
    if (e.code && /^\d|^[A-Z0-9]{5}$/.test(e.code))
      process.stderr.write('RETURN_SQL_DIAGNOSTIC ' + JSON.stringify({ code: e.code, message: e.message, table: e.table, column: e.column, constraint: e.constraint, detail: e.detail, where: e.where }) + '\n');
  });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const one = (xs: Row[]) => { assert.equal(xs.length, 1); return xs[0]; };
const ids = (xs: Row[]) => xs.map(x => x.id).sort();
function added(a: Facts, b: Facts, name: string): Row[] {
  const old = new Set(raw169(a, name).map(x => x.id));
  assert.deepEqual(b[name].filter(x => old.has(x.row.id)), a[name], 'Literal old append rows: ' + name);
  return raw169(b, name).filter(x => !old.has(x.id));
}
async function activate(f: Fixture169) {
  const publicReply = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicReply.writers_available, false, 'This gate must not enable all public writers');
  assert.equal(publicReply.activation_available, false);
  const beforeRows = await facts169(), context = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, context);
  assert.equal(source.ready, true, JSON.stringify(source.blockers)); assert.deepEqual(source.blockers, []);
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version,
    policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  assert.equal(preview.ready, true);
  const committed = await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context);
  assert.equal(committed.operation.after.strict, true);
  physicalExact169(beforeRows, await facts169());
}

async function fixture(on: boolean, custody = false) {
  const f = await fixture169(app, on);
  let custodyPolicy: Row | undefined;
  if (custody) {
    const p = (await f.ok('/warehouse-inventory-policies/warehouses/' + f.warehouses[1].id + '/previews', 'POST', {
      client_key: randomUUID(), version: '0', usage: 'custody', enabled: true,
    }, 201)).preview;
    custodyPolicy = (await f.ok('/warehouse-inventory-policies/previews/' + p.id + '/commit', 'POST', consent169(p), 201)).operation.after;
  }
  const product = on ? await f.ok('/products', 'POST', {
    catalog_id: f.primary.id, name: 'Actual zero known unknown return bundle', sku: 'RET169-' + randomUUID(),
    kind: 'bundle', price: 1000, vat: 23, warehouse_id: f.warehouse.id, quantity: 0,
    components: f.products.map(p => ({ product_id: p.id, quantity: 1 })),
  }, 201) : f.products[0];
  let order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own strict return buyer', email: 'return169@example.test',
    address: { street: 'Own return169', city: 'Warszawa', postal_code: '00-169', country: 'PL', phone: '500000169' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: product.id, quantity: 3 }],
    manual_lines: [{ product_id: product.id, quantity: 1, line_total: 1000 }, { product_id: product.id, quantity: 2, line_total: 3401 }],
  }, 201);
  order = await f.ok('/orders/' + order.id);
  assert.equal(order.items.length, 2); assert.equal(new Set(order.items.map((i: Row) => i.id)).size, 2);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version),
    kind: 'receipt', amount: 4401, currency: 'PLN', method: 'other', reference: 'Own local declaration', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  if (on) {
    const page = await f.ok('/wms-lots/orders/' + order.id + '/allocations'); assert.equal(page.meta.cursor, null);
    assert.equal(page.data.length, 3);
    for (const allocation of page.data) {
      const component = f.products.find(p => p.id === allocation.product_id); assert(component);
      assert.equal(allocation.quantity, 3);
      for (let n = 0; n < allocation.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: component.sku, location: allocation.location, layer_id: allocation.layer_id,
      });
    }
  } else for (let n = 0; n < 3; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
    client_key: randomUUID(), code: product.sku, location: 'A-01',
  });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  await f.ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  order = await f.ok('/orders/' + order.id);
  // Fulfillment precedes BO; the new requested RMA must not bypass
  // activation's genuine RETURN_PENDING blocker.
  await activate(f);
  let rma = await f.ok('/orders/' + order.id + '/returns', 'POST', {
    client_key: randomUUID(), reason: 'Actual original physical return169', shipping_refund: 0,
    items: order.items.map((i: Row) => ({ item_id: i.id, quantity: i.quantity })),
  }, 201);
  rma = await f.ok('/returns/' + rma.id);
  const station = (await f.ok('/packing/stations', 'POST', {
    client_key: randomUUID(), code: 'RET169-' + randomUUID().slice(0, 8), label: 'Own durable inspection', enabled: true,
  }, 201)).station;
  const statuses: Record<string, Row> = {};
  if (custody) for (const effect of ['sale', 'custody', 'reject']) {
    const rejecting = effect === 'reject';
    const p = (await f.ok('/return-assistant/statuses/previews', 'POST', { client_key: randomUUID(), kind: 'create', settings: {
      name: 'Actual strict ' + effect, color: '#aabbcc', active: true, decision: rejecting ? 'reject' : 'accept',
      inventory_effect: rejecting ? 'none' : effect, warehouse_id: rejecting ? null : effect === 'sale' ? f.warehouse.id : f.warehouses[1].id,
      warehouse_policy_version: rejecting ? null : effect === 'sale' ? '0' : custodyPolicy!.version,
      default_location: rejecting ? null : 'RETURN-' + effect,
    } }, 201)).preview;
    statuses[effect] = (await f.ok('/return-assistant/statuses/previews/' + p.id + '/commit', 'POST', consent169(p), 201)).status;
  }
  return { ...f, product, order, rma, station, statuses };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function scanned(f: Fixture) {
  const lease = randomUUID();
  let session = (await f.ok('/return-assistant/sessions', 'POST', { client_key: randomUUID(),
    return_number: f.rma.number, station_id: f.station.id, station_version: String(f.station.version), lease_token: lease,
  }, 201)).session;
  for (const line of session.lines) for (let n = 0; n < line.requested; n++) session = (
    await f.ok('/return-assistant/sessions/' + session.id + '/scans', 'POST', {
      client_key: randomUUID(), version: String(session.version), lease_token: lease, code: f.product.sku, item_id: line.item_id,
    })).session;
  assert.equal(session.scanned.reduce((n: number, s: Row) => n + s.quantity, 0), 3);
  return { session, lease };
}
function otherRowsExact(a: Facts, b: Facts, f: Fixture) {
  assert.deepEqual(Object.keys(b), Object.keys(a));
  for (const name of Object.keys(a)) assert.deepEqual(b[name].filter(x => x.row.tenant_id !== f.tenant),
    a[name].filter(x => x.row.tenant_id !== f.tenant), 'All foreign/global/session rows exact: ' + name);
  for (const name of ['order_items', 'payment_entries', 'documents', 'reservations', 'reservation_locations', 'wms_issue_fragments', 'wms_lots', 'wms_cost_layers'])
    assert.deepEqual(b[name], a[name], 'No second commercial/financial/provenance writer: ' + name);
  assert.deepEqual(b.stock.filter(x => !f.products.some(p => p.id === x.row.product_id)),
    a.stock.filter(x => !f.products.some(p => p.id === x.row.product_id)));
}
type Arrival = { warehouse_id: string; location: string; quantity: number };
function graph(a: Facts, b: Facts, f: Fixture, arrivals: Arrival[], protocol: string, assistantId: string | null) {
  otherRowsExact(a, b, f);
  const admission = one(own169(b, 'catalog_stock_return_admissions', f.tenant));
  const receipt = one(own169(b, 'catalog_stock_return_receipts', f.tenant));
  assert.equal(admission.return_id, f.rma.id); assert.equal(admission.order_id, f.order.id); assert.equal(admission.actor_id, f.user);
  assert.equal(admission.protocol, protocol); assert.equal(admission.sealed, true); assert.equal(receipt.id, admission.id);
  assert.equal(receipt.return_id, f.rma.id); assert.equal(receipt.order_id, f.order.id); assert.equal(receipt.assistant_receipt_id, assistantId);
  if (assistantId) assert.equal(one(own169(b, 'return_assistant_receipts', f.tenant)).id, assistantId);
  const physical = added(a, b, 'stock_movements');
  const bins = added(a, b, 'stock_location_movements');
  assert.equal(physical.length, arrivals.length * f.products.length); assert.equal(bins.length, physical.length);
  assert(physical.every(x => x.return_id === f.rma.id && x.order_id === f.order.id && x.kind === 'return' && x.delta > 0));
  assert(bins.every(x => x.kind === 'stock_in' && x.delta > 0));
  assert.deepEqual([...receipt.proof.stock_movement_ids].sort(), ids(physical));
  assert.deepEqual([...receipt.proof.location_movement_ids].sort(), ids(bins));
  const docs = own169(b, 'catalog_stock_return_documents', f.tenant), rows = own169(b, 'catalog_stock_return_rows', f.tenant);
  assert.equal(docs.length, arrivals.length); assert.equal(rows.length, bins.length);
  assert.deepEqual(rows.map(x => x.bin_movement_id).sort(), ids(bins), 'Every real bin journal exactly once in immutable PZ');
  for (const arrival of arrivals) {
    const d = one(docs.filter(x => x.warehouse_id === arrival.warehouse_id));
    assert.equal(d.receipt_id, receipt.id); assert.equal(d.return_id, f.rma.id);
    assert.equal(d.payload.kind, 'PZ'); assert.equal(d.payload.row_count, f.products.length);
    assert.equal(d.payload.quantity, String(arrival.quantity * f.products.length)); assert.equal(d.payload.wms_enabled, f.on);
    assert.equal(String(d.sequence), '1'); assert.equal(d.payload.sequence, '1');
    const series = one(own169(b, 'catalog_stock_control_series', f.tenant).filter(x => x.id === d.series_id));
    assert.equal(series.kind, 'PZ'); assert.equal(series.warehouse_id, arrival.warehouse_id);
    assert.equal(d.number, `${series.prefix}/${d.year}/000001`);
    const counter = one(own169(b, 'catalog_stock_control_counters', f.tenant).filter(x => x.series_id === d.series_id && x.year === d.year));
    assert.equal(String(counter.value), '1');
    for (const [ordinal, r] of rows.filter(x => x.document_id === d.id).sort((x, y) => x.ordinal - y.ordinal).entries()) {
      assert.equal(r.ordinal, ordinal); assert.equal(r.location, arrival.location); assert.equal(r.quantity, arrival.quantity);
      assert.equal(r.payload.bin_movement_id, r.bin_movement_id);
      const j = one(bins.filter(x => x.id === r.bin_movement_id));
      assert.equal(j.product_id, r.product_id); assert.equal(j.warehouse_id, r.warehouse_id); assert.equal(j.location, r.location); assert.equal(j.delta, r.quantity);
      const beforeStock = own169(a, 'stock', f.tenant).find(x => x.product_id === r.product_id && x.warehouse_id === r.warehouse_id);
      const afterStock = one(own169(b, 'stock', f.tenant).filter(x => x.product_id === r.product_id && x.warehouse_id === r.warehouse_id));
      assert.equal(afterStock.on_hand, (beforeStock?.on_hand ?? 0) + r.quantity); assert.equal(afterStock.reserved, beforeStock?.reserved ?? 0);
      const sm = own169(b, 'catalog_stock_return_stock_maps', f.tenant).filter(x => x.row_id === r.id);
      assert.equal(sm.reduce((n, x) => n + x.quantity, 0), r.quantity);
      assert(sm.every(x => physical.some(m => m.id === x.stock_movement_id && m.product_id === r.product_id && m.warehouse_id === r.warehouse_id)));
      const im = own169(b, 'catalog_stock_return_item_maps', f.tenant).filter(x => x.row_id === r.id);
      assert.equal(im.reduce((n, x) => n + x.quantity, 0), r.quantity);
      assert(im.every(x => x.return_id === f.rma.id && f.rma.items.some((i: Row) => i.item_id === x.item_id)));
      if (protocol === 'destinations_v1') for (const item of im) {
        const ar = one(own169(b, 'return_destination_arrivals', f.tenant).filter(x => x.id === item.arrival_id));
        assert.equal(ar.receipt_id, assistantId); assert.equal(ar.item_id, item.item_id);
        assert.equal(ar.product_id, r.product_id); assert.equal(ar.warehouse_id, r.warehouse_id); assert.equal(ar.location, r.location);
      } else assert(im.every(x => x.arrival_id === null));
    }
  }
  assert.deepEqual([...new Set(own169(b, 'catalog_stock_return_stock_maps', f.tenant).map(x => x.stock_movement_id))].sort(),
    ids(physical), 'All real aggregate journals are covered; no extra undocumented writer');
  const effects = own169(b, 'catalog_stock_control_effects', f.tenant).filter(x => x.admission_id === admission.id);
  assert.equal(effects.length, 1); assert.deepEqual(effects[0].proof.stock_movement_ids, receipt.proof.stock_movement_ids);
  if (!f.on) {
    assert.equal(receipt.wms_operation_id, null);
    assert.equal(own169(b, 'catalog_stock_return_layer_maps', f.tenant).length, 0);
    for (const name of Object.keys(a).filter(x => x.startsWith('wms_'))) assert.deepEqual(b[name], a[name], 'OFF no invented WMS authority: ' + name);
  } else {
    const op = one(added(a, b, 'wms_operations'));
    assert.equal(op.id, receipt.wms_operation_id); assert.equal(op.kind, 'return'); assert.equal(op.return_id, f.rma.id); assert.equal(op.order_id, f.order.id);
    assert.equal(op.warehouse_document_id, null); assert.equal(op.purchase_receipt_id, null);
    const maps = own169(b, 'catalog_stock_return_layer_maps', f.tenant), fragments = added(a, b, 'wms_return_fragments');
    assert.equal(maps.length, rows.length); assert.equal(fragments.length, rows.length);
    assert.equal(maps.filter(x => x.payload.unit_cost_minor === '0').length, arrivals.length);
    assert.equal(maps.filter(x => x.payload.unit_cost_minor === null).length, arrivals.length);
    for (const map of maps) {
      const row = one(rows.filter(x => x.id === map.row_id)), fragment = one(fragments.filter(x => x.id === map.fragment_id));
      const original = one(own169(a, 'wms_issue_fragments', f.tenant).filter(x => x.id === fragment.issue_fragment_id));
      const layer = one(own169(a, 'wms_cost_layers', f.tenant).filter(x => x.id === fragment.layer_id));
      assert.equal(fragment.layer_id, original.layer_id); assert.equal(fragment.product_id, row.product_id);
      assert.equal(fragment.warehouse_id, row.warehouse_id); assert.equal(fragment.location, row.location); assert.equal(fragment.quantity, map.quantity);
      assert.equal(map.payload.layer_id, layer.id); assert.equal(map.payload.lot_id, layer.lot_id);
      assert.equal(map.payload.issue_fragment_id, original.id);
      assert.equal(map.payload.unit_cost_minor, layer.unit_cost_minor === null ? null : String(layer.unit_cost_minor));
      assert.equal(map.payload.value_minor, layer.unit_cost_minor === null ? null : String(BigInt(layer.unit_cost_minor) * BigInt(map.quantity)));
      const journal = one(added(a, b, 'wms_layer_movements').filter(x => x.id === map.layer_movement_id));
      assert.equal(journal.operation_id, op.id); assert.equal(journal.layer_id, layer.id); assert.equal(journal.delta, map.quantity);
      assert.equal(journal.value_delta, layer.unit_cost_minor === null ? null : Number(layer.unit_cost_minor) * map.quantity);
      const oldPosition = own169(a, 'wms_layer_positions', f.tenant).find(x => x.product_id === row.product_id &&
        x.layer_id === layer.id && x.warehouse_id === row.warehouse_id && x.location === row.location);
      const position = one(own169(b, 'wms_layer_positions', f.tenant).filter(x => x.product_id === row.product_id &&
        x.layer_id === layer.id && x.warehouse_id === row.warehouse_id && x.location === row.location));
      assert.equal(position.quantity, (oldPosition?.quantity ?? 0) + map.quantity);
      assert.equal(position.reserved, oldPosition?.reserved ?? 0);
    }
  }
  return { admission, receipt, docs, rows };
}

async function readReceiptHeads(f: Fixture, docs: Row[], saved: Facts, key?: Row) {
  const heads = docs.map(d => d.payload).sort((a, b) => a.id.localeCompare(b.id));
  const exact = (r: Row) => assert.deepEqual([...r.stock_receipts].sort((a: Row, b: Row) => a.id.localeCompare(b.id)), heads,
    'Actual HTTP returns the saved own PZ heads, without private cost/layer payloads');
  exact(await f.ok('/returns/' + f.rma.id, 'GET', undefined, 200, key));
  exact(one((await f.ok('/orders/' + f.order.id + '/returns', 'GET', undefined, 200, key)).cases.filter((r: Row) => r.id === f.rma.id)));
  exact(one((await f.ok('/orders/' + f.order.id, 'GET', undefined, 200, key)).returns.cases.filter((r: Row) => r.id === f.rma.id)));
  exact(one((await f.ok('/returns?limit=100', 'GET', undefined, 200, key)).data.filter((r: Row) => r.id === f.rma.id)));
  assert.deepEqual(await facts169(), saved, 'All four real RMA/order/list read routes preserve every global row and session');
}

test('strict OFF ordinary RMA with orders:write-only key receives once and documents actual stock/bin journals; exact replay is pure', async () => {
  const f = await fixture(false), cheapLine = f.order.items.find((i: Row) => i.line_total === 1000); assert(cheapLine);
  const cheap = f.rma.items.find((i: Row) => i.item_id === cheapLine.id); assert(cheap);
  const body = { version: Number(f.rma.version), note: 'Actual ordinary receive169', shipping_refund: 0,
    items: f.rma.items.map((i: Row) => ({ item_id: i.item_id, accepted: i.item_id === cheap.item_id ? 1 : 0, restocked: i.item_id === cheap.item_id ? 1 : 0 })) };
  const key = await f.ok('/developer/keys', 'POST', { name: 'Native orders-write return169', scopes: ['orders:write'] }, 201);
  const reader = await f.ok('/developer/keys', 'POST', { name: 'Own read-only PZ heads169', scopes: ['orders:read'] }, 201);
  const foreign = await fixture169(app);
  const beforeRows = await facts169();
  for (const invalid of [
    { ...body, items: body.items.map((i: { item_id: string; accepted: number; restocked: number }) => ({ ...i, restocked: i.accepted + 1 })) },
    { ...body, items: body.items.map((i: { item_id: string; accepted: number; restocked: number }) => ({ ...i, accepted: 100000, restocked: 100000 })) },
  ]) {
    assert.equal((await f.request('/returns/' + f.rma.id + '/receive', 'POST', invalid, key)).statusCode, 422,
      'Strict admission preserves native validation of excessive accepted/restocked quantities');
    assert.deepEqual(await facts169(), beforeRows, 'Invalid strict input allocates no PZ/counter/approval and preserves every row/session');
  }
  const result = await f.ok('/returns/' + f.rma.id + '/receive', 'POST', body, 200, key);
  assert.equal(result.state, 'refund_pending'); assert.equal(result.refund_amount, 1000);
  // Ordinary OFF receive has no WMS picks: actual core's incoming bin is ZWROT.
  const accepted = await facts169(), g = graph(beforeRows, accepted, f, [{ warehouse_id: f.warehouse.id, location: 'ZWROT', quantity: 1 }], 'rma', null);
  assert.equal(g.admission.api_key_id, key.id);
  assert.deepEqual(result.stock_receipts, g.docs.map(d => d.payload));
  await readReceiptHeads(f, g.docs, accepted, reader);
  assert.equal((await foreign.request('/returns/' + f.rma.id)).statusCode, 404);
  assert.equal((await foreign.request('/orders/' + f.order.id + '/returns')).statusCode, 404);
  assert.equal((await foreign.request('/orders/' + f.order.id)).statusCode, 404);
  assert(!(await foreign.ok('/returns?limit=100')).data.some((r: Row) => r.id === f.rma.id));
  assert.deepEqual(await facts169(), accepted, 'Foreign tenant refusals and list never reveal own PZ or alter rows');
  await f.ok('/returns/' + f.rma.id + '/receive', 'POST', body, 200, key);
  assert.deepEqual(await facts169(), accepted, 'Native replay adds no PZ/number/journal/stock/session/audit');
  assert.equal((await f.request('/returns/' + f.rma.id + '/receive', 'POST', { ...body, note: 'Changed consent' }, key)).statusCode, 409);
  assert.deepEqual(await facts169(), accepted);
});

test('strict ON139 genuine durable scans and native receipt bind actual zero/known/NULL return layers without second writer', async () => {
  const f = await fixture(true), inspection = await scanned(f); let session = inspection.session;
  const cheap = session.lines.find((i: Row) => i.line_total === 1000), expensive = session.lines.find((i: Row) => i.line_total === 3401); assert(cheap && expensive);
  const fragments = (await pool.query('SELECT id,product_id FROM public.wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,id', [f.tenant, f.order.id])).rows;
  assert.equal(fragments.length, 3);
  const stock_versions = await Promise.all(f.products.map(async p => ({ product_id: p.id, warehouse_id: f.warehouse.id,
    version: String((await pool.query('SELECT version FROM public.stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3', [f.tenant, p.id, f.warehouse.id])).rows[0].version) })));
  session = (await f.ok('/return-assistant/sessions/' + session.id + '/draft', 'PATCH', { client_key: randomUUID(), version: String(session.version), lease_token: inspection.lease,
    parts: [{ part_id: randomUUID(), item_id: cheap.item_id, quantity: 1, status: 'sale' }, { part_id: randomUUID(), item_id: expensive.item_id, quantity: 1, status: 'hold' },
      { part_id: randomUUID(), item_id: expensive.item_id, quantity: 1, status: 'reject' }], note: 'Actual strict139 inspection', shipping_refund: 0,
    wms_lots: { client_key: randomUUID(), policy_version: '1', stock_versions, picks: fragments.map(x => ({ issue_fragment_id: x.id, quantity: 1, location: 'A-01' })) },
  })).session;
  const preview = (await f.ok('/return-assistant/sessions/' + session.id + '/previews', 'POST', { client_key: randomUUID(), version: String(session.version), lease_token: inspection.lease }, 201)).preview;
  assert.equal(preview.summary.refund_minor, 2700); assert.equal(preview.summary.restocked, 1);
  const consent = { ...consent169(preview), lease_token: inspection.lease }, beforeRows = await facts169();
  const result = await f.ok('/return-assistant/previews/' + preview.id + '/receive', 'POST', consent, 201);
  assert.equal(result.session.state, 'completed'); assert.equal(result.return_case.refund_amount, 2700);
  const accepted = await facts169(), g = graph(beforeRows, accepted, f, [{ warehouse_id: f.warehouse.id, location: 'A-01', quantity: 1 }], 'assistant_v1', result.receipt.id);
  await readReceiptHeads(f, g.docs, accepted);
  const replay = await f.ok('/return-assistant/previews/' + preview.id + '/receive', 'POST', consent);
  assert.equal(replay.reused, true); assert.deepEqual(replay.receipt, result.receipt); assert.deepEqual(await facts169(), accepted);
});

test('strict ON148 real139 scans→sale/custody split emits one PZ per actual WH with typed arrival/receipt/layer maps and pure replay', async () => {
  const f = await fixture(true, true), inspection = await scanned(f);
  const source = (await f.ok('/return-destinations/returns/' + f.rma.id + '/source?session_id=' + inspection.session.id)).source;
  assert.equal(source.planner_source.wms.enabled, true);
  const cheap = source.planner_source.lines.find((i: Row) => i.line_total_minor === 1000), expensive = source.planner_source.lines.find((i: Row) => i.line_total_minor === 3401); assert(cheap && expensive);
  const parts = [{ part_id: randomUUID(), item_id: cheap.item_id, quantity: 1, effect: 'sale' },
    { part_id: randomUUID(), item_id: expensive.item_id, quantity: 1, effect: 'custody' },
    { part_id: randomUUID(), item_id: expensive.item_id, quantity: 1, effect: 'reject' }];
  const arrivals = parts.filter(p => p.effect !== 'reject').flatMap(part => f.products.map(product => ({ part, product_id: product.id, warehouse_id: f.statuses[part.effect].settings.warehouse_id })));
  const cells = [...new Map(arrivals.map(a => [a.warehouse_id + '/' + a.product_id, { warehouse_id: a.warehouse_id, product_id: a.product_id }])).values()];
  const body = { protocol: 'destinations_v1', client_key: randomUUID(), return_version: source.return_version,
    session_id: source.session.id, session_version: source.session.version, lease_token: inspection.lease, note: 'Actual strict148 split', shipping_refund: 0,
    parts: parts.map(p => ({ part_id: p.part_id, item_id: p.item_id, quantity: p.quantity, status_id: f.statuses[p.effect].id, status_version: f.statuses[p.effect].version })),
    locations: arrivals.map(a => ({ part_id: a.part.part_id, product_id: a.product_id, location: 'RETURN-' + a.part.effect, confirmed: true })),
    stock_versions: cells.map(cell => { const s = source.planner_source.stocks.find((v: Row) => v.product_id === cell.product_id && v.warehouse_id === cell.warehouse_id); assert(s); return { ...cell, version: s.version }; }),
    wms_lots: { policy_version: source.planner_source.wms.policy_version, picks: arrivals.map(a => {
      const fragment = source.planner_source.wms.issue_fragments.find((v: Row) => v.product_id === a.product_id && v.eligible_item_ids.includes(a.part.item_id)); assert(fragment);
      return { part_id: a.part.part_id, issue_fragment_id: fragment.id, quantity: 1, location: 'RETURN-' + a.part.effect };
    }) },
  };
  const preview = (await f.ok('/return-destinations/returns/' + f.rma.id + '/previews', 'POST', body, 201)).preview;
  assert.deepEqual(preview.summary, { accepted: 2, restocked_to_sale: 1, received_into_custody: 1, rejected: 1, commercial_credit_minor: 2700, shipping_refund_minor: 0 });
  const consent = { ...consent169(preview), lease_token: inspection.lease }, beforeRows = await facts169();
  const result = await f.ok('/return-destinations/previews/' + preview.id + '/receive', 'POST', consent, 201);
  assert.equal(result.return_case.refund_amount, 2700); assert.equal(result.return_case.settlement, null);
  const accepted = await facts169(), g = graph(beforeRows, accepted, f, [
    { warehouse_id: f.warehouse.id, location: 'RETURN-sale', quantity: 1 },
    { warehouse_id: f.warehouses[1].id, location: 'RETURN-custody', quantity: 1 },
  ], 'destinations_v1', result.operation.id);
  assert.equal(g.receipt.wms_operation_id, result.operation.id);
  assert.equal(own169(accepted, 'return_destination_arrivals', f.tenant).length, 6);
  await readReceiptHeads(f, g.docs, accepted);
  const replay = await f.ok('/return-destinations/previews/' + preview.id + '/receive', 'POST', consent);
  assert.equal(replay.reused, true); assert.deepEqual(replay.operation, result.operation); assert.deepEqual(await facts169(), accepted);
  assert.equal((await f.request('/return-destinations/previews/' + preview.id + '/receive', 'POST', { ...consent, scope_hash: '0'.repeat(64) })).statusCode, 409);
  assert.deepEqual(await facts169(), accepted);
});
