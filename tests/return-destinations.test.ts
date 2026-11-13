import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantFixture } from './return-assistant-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';
import { receiveReturnDestinations, returnDestinationsAvailable } from '../server/return-destinations';
import { receiveReturnDestinationCoreInTx } from '../server/return-destinations-core';
import { applyReturnDestinationPhysicalInTx } from '../server/return-destinations-stock';

// Authored for root's disposable native harness. The actual buildApp registry,
// SQL148 and genuine receiveReturn adapter must exist; no successful test stub.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_[a-zA-Z0-9_]+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate(); await seed();
  if (!(await pool.query("SELECT to_regprocedure('public.return_destination_installed()') marker")).rows[0].marker) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(await readFile(resolve('server/148_return_destinations.sql'), 'utf8'));
      await c.query("INSERT INTO migrations(name) VALUES('148_return_destinations')"); await c.query('COMMIT');
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  }
  assert.equal(await returnDestinationsAvailable(), true);
  app = await buildApp({ integrationTransport: async () => { throw Error('Return intake cannot call a provider'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
type Fixture = Awaited<ReturnType<typeof returnAssistantFixture>>;
type Row = Record<string, any>;
const base = '/return-destinations';
const consent = (p: Row, lease: string) => ({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true, lease_token: lease });
function noPrivate(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!['unit_cost_minor', 'value_minor', 'value_delta', 'known_minor', 'private_fragment_effects',
      'planner_source_private', 'private_scope_nonce', 'lease_token', 'lease_token_hash', 'content_encrypted',
      'tenant_id', 'actor_id', 'api_key_id', 'request_hash', 'transaction_id', 'backend_pid'].includes(key), key);
    noPrivate(child);
  }
}
async function startAndScan(f: Fixture, scan = true) {
  const lease = randomUUID();
  let session = (await f.ok('/return-assistant/sessions', 'POST', { client_key: randomUUID(),
    return_number: f.rma.number, station_id: f.station.id, station_version: String(f.station.version), lease_token: lease }, 201)).session;
  if (scan) for (const line of session.lines) for (let n = 0; n < line.requested; n++)
    session = (await f.ok('/return-assistant/sessions/' + session.id + '/scans', 'POST', {
      client_key: randomUUID(), version: String(session.version), lease_token: lease, code: f.product.sku, item_id: line.item_id,
    })).session;
  return { session, lease };
}
async function targetAndStatuses(f: Fixture) {
  const warehouse = await f.ok('/warehouses', 'POST', { name: 'Own genuine return custody', code: 'RD-' + randomUUID().slice(0, 8) });
  // Warehouse birth does not assign a noninitial warehouse to an existing
  // catalog. Configure the actual commercial pool before any physical intake.
  const product = await f.ok('/products/' + f.product.id);
  const catalog = (await f.ok('/product-catalogs/' + product.catalog_id)).catalog;
  assert(catalog.warehouse_ids.includes(f.warehouse));
  const catalogPreview = (await f.ok('/product-catalogs/previews', 'POST', {
    client_key: randomUUID(), kind: 'update', catalog_id: catalog.id, version: String(catalog.version), settings: {
      name: catalog.name, active: catalog.active, languages: catalog.languages, default_language: catalog.default_language,
      warehouse_ids: [...new Set([...catalog.warehouse_ids, warehouse.id])].sort(), price_list_ids: catalog.price_list_ids,
    },
  }, 201)).preview;
  assert.equal(catalogPreview.ready, true);
  const assigned = await f.ok('/product-catalogs/previews/' + catalogPreview.id + '/commit', 'POST', {
    client_key: randomUUID(), scope_hash: catalogPreview.scope_hash, confirmed: true,
  }, 201);
  assert(assigned.catalog.warehouse_ids.includes(warehouse.id));
  const policyPreview = (await f.ok('/warehouse-inventory-policies/warehouses/' + warehouse.id + '/previews', 'POST', {
    client_key: randomUUID(), version: '0', usage: 'custody', enabled: true,
  }, 201)).preview;
  const policy = (await f.ok('/warehouse-inventory-policies/previews/' + policyPreview.id + '/commit', 'POST', {
    client_key: randomUUID(), scope_hash: policyPreview.scope_hash, confirmed: true,
  }, 201)).operation.after;
  const statuses: Record<'sale' | 'custody' | 'reject', Row> = {} as Record<'sale' | 'custody' | 'reject', Row>;
  for (const effect of ['sale', 'custody', 'reject'] as const) {
    const rejecting = effect === 'reject';
    const p = (await f.ok('/return-assistant/statuses/previews', 'POST', { client_key: randomUUID(), kind: 'create', settings: {
      name: 'Own intake ' + effect, color: '#aabbcc', active: true, decision: rejecting ? 'reject' : 'accept',
      inventory_effect: rejecting ? 'none' : effect, warehouse_id: rejecting ? null : effect === 'sale' ? f.warehouse : warehouse.id,
      warehouse_policy_version: rejecting ? null : effect === 'sale' ? '0' : policy.version, default_location: rejecting ? null : 'RD-' + effect,
    } }, 201)).preview;
    statuses[effect] = (await f.ok('/return-assistant/statuses/previews/' + p.id + '/commit', 'POST', {
      client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true,
    }, 201)).status;
  }
  return { warehouse, statuses };
}
async function source(f: Fixture, session: Row) {
  const result = await f.ok(base + '/returns/' + f.rma.id + '/source?session_id=' + session.id);
  assert.equal(result.available, true); assert.equal(result.intake_available, true); noPrivate(result);
  assert.equal(result.source.session.id, session.id); assert.equal(result.source.return_version, String(f.rma.version));
  assert.equal(result.source.session.version, String(session.version)); return result.source;
}
function draft(f: Fixture, s: Row, lease: string, statuses: Record<string, Row>, parts: Row[]) {
  const accepted = parts.filter(p => statuses[p.effect].settings.decision === 'accept');
  const arrivals = accepted.flatMap(p => s.planner_source.lines.find((l: Row) => l.item_id === p.item_id).components
    .map((c: Row) => ({ part: p, product_id: c.product_id, quantity: p.quantity * c.quantity })));
  const cells = [...new Map(arrivals.map(a => {
    const warehouse_id = statuses[a.part.effect].settings.warehouse_id;
    return [warehouse_id + '/' + a.product_id, { warehouse_id, product_id: a.product_id }];
  })).values()];
  const picks = s.planner_source.wms.enabled ? arrivals.map(a => {
    const fragment = s.planner_source.wms.issue_fragments.find((i: Row) => i.product_id === a.product_id && i.eligible_item_ids.includes(a.part.item_id));
    assert(fragment, 'A pick must come from an actual eligible original issue');
    return { part_id: a.part.part_id, issue_fragment_id: fragment.id, quantity: a.quantity, location: 'RD-' + a.part.effect };
  }) : [];
  return { protocol: 'destinations_v1', client_key: randomUUID(), return_version: s.return_version,
    session_id: s.session.id, session_version: s.session.version, lease_token: lease, note: 'Own actual destination inspection', shipping_refund: 0,
    parts: parts.map(p => ({ part_id: p.part_id, item_id: p.item_id, quantity: p.quantity,
      status_id: statuses[p.effect].id, status_version: statuses[p.effect].version })),
    locations: arrivals.map(a => ({ part_id: a.part.part_id, product_id: a.product_id, location: 'RD-' + a.part.effect, confirmed: true })),
    stock_versions: cells.map(cell => { const old = s.planner_source.stocks.find((v: Row) => v.warehouse_id === cell.warehouse_id && v.product_id === cell.product_id);
      assert(old, 'Source must supply every real target cell'); return { ...cell, version: old.version }; }),
    ...(s.planner_source.wms.enabled ? { wms_lots: { policy_version: s.planner_source.wms.policy_version, picks } } : {}),
  };
}
function splitParts(s: Row) {
  const cheap = s.planner_source.lines.find((l: Row) => l.line_total_minor === 1000);
  const expensive = s.planner_source.lines.find((l: Row) => l.line_total_minor === 3401);
  assert(cheap && expensive);
  return [{ part_id: randomUUID(), item_id: cheap.item_id, quantity: 1, effect: 'sale' },
    { part_id: randomUUID(), item_id: expensive.item_id, quantity: 1, effect: 'custody' },
    { part_id: randomUUID(), item_id: expensive.item_id, quantity: 1, effect: 'reject' }];
}
async function fixture(on: boolean, unknown = false): Promise<Fixture> {
  if (!unknown) return returnAssistantFixture(app, on, true);
  // Opening must precede commerce: a fulfilled OFF fixture leaves genuine
  // pending automation jobs, which correctly make its whole-tenant opening
  // unready. Create only isolated tenant metadata, then use public APIs for the
  // complete opening and all ON commerce. Never overwrite those jobs to pass.
  const tenant = randomUUID(), warehouse = randomUUID();
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id as string;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own unknown-cost destination fixture','enterprise')", [tenant]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, user]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Own unknown-cost opening','RDNULL')", [warehouse, tenant]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress: '127.148.1.1' });
  assert.equal(login.statusCode, 200);
  const switched = await app.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: tenant },
    headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress: '127.148.1.1' });
  assert.equal(switched.statusCode, 200);
  const cookie = String(switched.headers['set-cookie']).split(';')[0];
  const request: Fixture['request'] = (path, method = 'GET', body, cookieOverride) => app.inject({
    url: path.startsWith('/api/') ? path : '/api' + path, method, payload: body,
    headers: { cookie: cookieOverride ?? cookie, ...(path === '/orders' && method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) },
    remoteAddress: '127.148.1.1',
  });
  const ok: Fixture['ok'] = async (path, method = 'GET', body, status = 200) => {
    const response = await request(path, method, body);
    const diagnostic = response.statusCode === status ? '' : String(response.json()?.detail ?? '').slice(0, 200);
    assert.equal(response.statusCode, status, `${method} ${path}: ${diagnostic}`);
    return response.json();
  };
  const originalProduct = await ok('/products', 'POST', { name: 'Own known0 opening component', sku: 'RD-ZERO-' + randomUUID(),
    kind: 'simple', price: 1000, vat: 23, warehouse_id: warehouse, quantity: 10, location: 'RET-01' }, 201);
  const f = { tenant, user, cookie, warehouse, product: originalProduct, request, req: request, ok,
    actor: { tenantId: tenant, userId: user, role: 'admin' as const, source: 'manual' as const } };
  const unknownProduct = await f.ok('/products', 'POST', { name: 'Own unknown opening component', sku: 'RD-NULL-' + randomUUID(),
    kind: 'simple', price: 1000, vat: 23, warehouse_id: f.warehouse, quantity: 20, location: 'RET-01' }, 201);
  const components = [{ ...f.product, recipe: 1, cost: '0' }, { ...unknownProduct, recipe: 2, cost: null }];
  const product = await f.ok('/products', 'POST', { name: 'Own known0 and unknown bundle', sku: 'RD-X-' + randomUUID(),
    kind: 'bundle', price: 1000, vat: 23, warehouse_id: f.warehouse, quantity: 0,
    components: components.map(c => ({ product_id: c.id, quantity: c.recipe })) }, 201);
  const openingScope = await f.ok('/wms-lots/opening-scope');
  assert.equal(openingScope.meta.cursor, null, 'The actual complete own opening fits one bounded page');
  assert.deepEqual(openingScope.active_blockers, [], 'Do not bypass reservations, packing or pending job blockers');
  assert.equal(openingScope.data.length, 2);
  const openingLines = openingScope.data.map((bin: Row) => {
    const component = components.find(c => c.id === bin.product_id); assert(component);
    assert.equal(bin.warehouse_id, f.warehouse); assert.equal(bin.location, 'RET-01');
    return { warehouse_id: bin.warehouse_id, product_id: bin.product_id, location: bin.location, quantity: bin.quantity,
      stock_version: String(bin.stock_version), lot_code: 'RD-' + component.id, unit_cost_minor: component.cost };
  });
  const opening = (await f.ok('/wms-lots/opening-previews', 'POST', { client_key: randomUUID(), policy_version: '0', currency: 'PLN',
    note: 'Genuine known0 and unknown original layer fixture', lines: openingLines }, 201)).preview;
  assert(opening.ready);
  await f.ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', {
    client_key: randomUUID(), scope_hash: opening.scope_hash, confirmed: true, ack_unknown_costs: true,
  }, 201);
  let order = await f.ok('/orders', 'POST', { source: 'manual', customer_name: 'Own unknown-cost return buyer', email: 'rd@example.test',
    address: { street: 'Own 148', city: 'Warszawa', postal_code: '00-148', country: 'PL', phone: '500000148' },
    warehouse_id: f.warehouse, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: product.id, quantity: 3 }], manual_lines: [{ product_id: product.id, quantity: 1, line_total: 1000 }, { product_id: product.id, quantity: 2, line_total: 3401 }] }, 201);
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt',
    amount: 4401, currency: 'PLN', method: 'other', reference: 'Own local test declaration', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations'); assert.equal(allocations.meta.cursor, null);
  for (const allocation of allocations.data) {
    const component = components.find(c => c.id === allocation.product_id); assert(component);
    for (let n = 0; n < allocation.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
      client_key: randomUUID(), code: component.sku, location: allocation.location, layer_id: allocation.layer_id,
    });
  }
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' })); await f.ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  order = await f.ok('/orders/' + order.id);
  let rma = await f.ok('/orders/' + order.id + '/returns', 'POST', { client_key: randomUUID(), reason: 'Own real unknown layer return',
    items: order.items.map((line: Row) => ({ item_id: line.id, quantity: line.quantity })), shipping_refund: 0 }, 201);
  rma = await f.ok('/returns/' + rma.id);
  const station = (await f.ok('/packing/stations', 'POST', { client_key: randomUUID(), code: 'RD-' + randomUUID().slice(0, 8),
    label: 'Own unknown-cost return desk', enabled: true }, 201)).station;
  const receiveBody = { version: Number(rma.version), note: 'Own original unknown-cost goods', shipping_refund: 0,
    items: rma.items.map((line: Row) => ({ item_id: line.item_id, accepted: line.requested, restocked: line.requested })) };
  return { ...f, on: true, components, product, order, rma, station, receiveBody };
}

for (const mode of ['OFF', 'ON-known', 'ON-null'] as const) test(`${mode}: durable scan, two true destinations, original layers and cumulative pennies`, async () => {
  const f = await fixture(mode !== 'OFF', mode === 'ON-null'), target = await targetAndStatuses(f);
  const inspection = await startAndScan(f), s = await source(f, inspection.session), input = draft(f, s, inspection.lease, target.statuses, splitParts(s));
  const beforeRows = await productCatalogFacts(f.tenant);
  const p = (await f.ok(base + '/returns/' + f.rma.id + '/previews', 'POST', input, 201)).preview; noPrivate(p);
  assert.deepEqual(p.summary, { accepted: 2, restocked_to_sale: 1, received_into_custody: 1, rejected: 1, commercial_credit_minor: 2700, shipping_refund_minor: 0 });
  assert.deepEqual(p.summary, p.snapshot.plan.summary); assert.equal(p.snapshot.session.version, String(inspection.session.version));
  const previewRows = await productCatalogFacts(f.tenant);
  for (const name of ['orders', 'order_items', 'return_cases', 'return_items', 'stock', 'stock_locations', 'wms_operations', 'payment_entries'])
    assert.deepEqual(previewRows[name], beforeRows[name], 'Preview changes no business facts: ' + name);
  const b = consent(p, inspection.lease), saved = await f.ok(base + '/previews/' + p.id + '/receive', 'POST', b, 201); noPrivate(saved.operation);
  assert.equal(saved.operation.result.id, f.rma.id); assert.equal(saved.operation.result.number, f.rma.number);
  assert.equal(saved.return_case.state, 'refund_pending'); assert.equal(saved.return_case.refund_amount, 2700);
  assert.equal(saved.operation.summary.received_into_custody, 1);
  const accepted = await productCatalogFacts(f.tenant);
  for (const name of ['order_items', 'payment_entries', 'documents', 'reservations', 'reservation_locations'])
    assert.deepEqual(accepted[name], beforeRows[name], 'Intake must not change original/cash/reserved facts: ' + name);
  assert.equal(accepted.return_destination_parts.length, 3); assert.equal(accepted.return_assistant_receipts.length, 1);
  for (const component of f.components) {
    const saleBefore = beforeRows.stock.find(x => x.row.product_id === component.id && x.row.warehouse_id === f.warehouse).row;
    const sale = accepted.stock.find(x => x.row.product_id === component.id && x.row.warehouse_id === f.warehouse).row;
    const custody = accepted.stock.find(x => x.row.product_id === component.id && x.row.warehouse_id === target.warehouse.id).row;
    assert.equal(sale.on_hand - saleBefore.on_hand, component.recipe ?? 1); assert.equal(custody.on_hand, component.recipe ?? 1);
    assert.equal(sale.reserved, saleBefore.reserved); assert.equal(custody.reserved, 0);
  }
  if (mode !== 'OFF') {
    const operations = accepted.wms_operations.filter(x => x.row.return_id === f.rma.id); assert.equal(operations.length, 1);
    assert.equal(operations[0].row.id, saved.operation.id);
    assert.equal(accepted.wms_return_fragments.filter(x => x.row.return_id === f.rma.id).length, 4);
    assert.equal(accepted.return_destination_fragments.length, 4);
    for (const name of ['wms_cost_layers', 'wms_lots', 'wms_issue_fragments'])
      assert.deepEqual(accepted[name], beforeRows[name], 'Return reuses immutable original provenance: ' + name);
    for (const { row: returned } of accepted.wms_return_fragments.filter(x => x.row.return_id === f.rma.id)) {
      const original = beforeRows.wms_issue_fragments.find(x => x.row.id === returned.issue_fragment_id)?.row;
      assert(original);
      assert.equal(returned.tenant_id, original.tenant_id); assert.equal(returned.order_id, original.order_id);
      assert.equal(returned.product_id, original.product_id); assert.equal(returned.layer_id, original.layer_id);
      assert.equal(returned.value_minor, original.unit_cost_minor === null ? null : Number(original.unit_cost_minor) * returned.quantity);
      const position = accepted.wms_layer_positions.find(x => x.row.warehouse_id === returned.warehouse_id &&
        x.row.product_id === returned.product_id && x.row.layer_id === returned.layer_id && x.row.location === returned.location)?.row;
      assert(position); assert.equal(position.quantity, returned.quantity); assert.equal(position.reserved, 0);
    }
    if (mode === 'ON-null') {
      const zero = accepted.wms_return_fragments.filter(x => x.row.return_id === f.rma.id && x.row.product_id === f.components[0].id);
      const unknown = accepted.wms_return_fragments.filter(x => x.row.return_id === f.rma.id && x.row.product_id === f.components[1].id);
      assert.equal(zero.length, 2); assert.equal(unknown.length, 2);
      assert(zero.every(x => x.row.value_minor === 0)); assert(unknown.every(x => x.row.value_minor === null));
    }
  } else assert.equal(accepted.wms_return_fragments.length, beforeRows.wms_return_fragments.length);
  const repeat = await f.ok(base + '/previews/' + p.id + '/receive', 'POST', b);
  assert.equal(repeat.reused, true); assert.deepEqual(repeat.operation, saved.operation); assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  for (const changed of [{ ...b, scope_hash: '0'.repeat(64) }, { ...b, lease_token: randomUUID() }]) {
    assert.equal((await f.request(base + '/previews/' + p.id + '/receive', 'POST', changed)).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(f.tenant), accepted, 'Exact committed proof must reject a different body');
  }
  const detail = await f.ok(base + '/operations/' + saved.operation.id); assert.deepEqual(detail.operation, saved.operation); noPrivate(detail.operation);
  const legacyPreview = await f.request('/return-assistant/previews/' + p.id);
  assert.equal(legacyPreview.statusCode, 409, 'Old139 directs typed148 preview to the proper protocol before projecting costs');
  noPrivate(legacyPreview.json());
  const legacyReceipt = await f.request('/return-assistant/receipts/' + saved.operation.id);
  assert.equal(legacyReceipt.statusCode, 409); noPrivate(legacyReceipt.json());
  const completed = await f.ok('/return-assistant/sessions/' + inspection.session.id);
  assert.equal(completed.session.state, 'completed'); assert.equal(completed.session.receipt_id, saved.operation.id);
  assert.equal((await f.request('/return-assistant/previews/' + p.id + '/receive', 'POST', b)).statusCode, 409, 'Old139 cannot execute typed148 preview');
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  // The rejected expensive unit may be requested again. Actual prior accepted
  // floor1700 leaves1701; SALE and CUSTODY consume the same original WMS cap.
  const expensive = f.order.items.find((line: Row) => line.line_total === 3401);
  let next = await f.ok('/orders/' + f.order.id + '/returns', 'POST', { client_key: randomUUID(), reason: 'Own remaining original unit',
    shipping_refund: 0, items: [{ item_id: expensive.id, quantity: 1 }] }, 201);
  next = await f.ok('/returns/' + next.id);
  const second = { ...f, rma: next }, scan2 = await startAndScan(second), s2 = await source(second, scan2.session);
  const d2 = draft(second, s2, scan2.lease, target.statuses, [{ part_id: randomUUID(), item_id: expensive.id, quantity: 1, effect: 'custody' }]);
  const p2 = (await second.ok(base + '/returns/' + next.id + '/previews', 'POST', d2, 201)).preview;
  assert.equal(p2.summary.commercial_credit_minor, 1701);
  await second.ok(base + '/previews/' + p2.id + '/receive', 'POST', consent(p2, scan2.lease), 201);
  assert.equal((await second.ok('/orders/' + f.order.id + '/returns')).cases.filter((r: Row) => r.state === 'refund_pending').reduce((sum: number, r: Row) => sum + r.refund_amount, 0), 4401);
  if (mode !== 'OFF') for (const issue of (await pool.query('SELECT id,quantity FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2', [f.tenant, f.order.id])).rows) {
    const used = (await pool.query('SELECT sum(quantity)::int quantity FROM wms_return_fragments WHERE tenant_id=$1 AND issue_fragment_id=$2', [f.tenant, issue.id])).rows[0].quantity;
    assert.equal(used, issue.quantity, 'Every original physical fragment is returned exactly once across SALE/CUSTODY and cases');
  }
});

test('stale stock union, foreign session/status and excessive shared fragment roll back the complete graph', async () => {
  const f = await fixture(true), other = await fixture(false), t = await targetAndStatuses(f), scan = await startAndScan(f);
  const s = await source(f, scan.session), b = draft(f, s, scan.lease, t.statuses, splitParts(s));
  const own = await productCatalogFacts(f.tenant);
  for (const invalid of [{ ...b, session_id: randomUUID() },
    { ...b, parts: b.parts.map((part, i) => i ? part : { ...part, status_id: randomUUID() }) },
    { ...b, stock_versions: b.stock_versions.map((v, i) => i ? v : { ...v, version: String(BigInt(v.version) + 1n) }) },
    { ...b, wms_lots: { ...b.wms_lots!, picks: b.wms_lots!.picks.map((pick, i) => i ? pick : { ...pick, quantity: 100000 }) } },
  ]) {
    const r = await f.request(base + '/returns/' + f.rma.id + '/previews', 'POST', invalid);
    assert([404, 409, 422].includes(r.statusCode), 'Invalid scope must be refused'); assert.deepEqual(await productCatalogFacts(f.tenant), own);
  }
  const foreign = await other.request(base + '/returns/' + f.rma.id + '/source?session_id=' + scan.session.id); assert.equal(foreign.statusCode, 404);
  const p = (await f.ok(base + '/returns/' + f.rma.id + '/previews', 'POST', b, 201)).preview;
  // Real independent PZ changes the same target stock version after preview.
  const c = f.components[0], stock = (await f.ok('/products/' + c.id)).stock.find((r: Row) => r.warehouse_id === f.warehouse);
  await f.ok('/wms-lots/receipts', 'POST', { client_key: randomUUID(), policy_version: s.planner_source.wms.policy_version,
    warehouse_id: f.warehouse, stock_versions: [{ product_id: c.id, warehouse_id: f.warehouse, version: String(stock.version) }], confirmed: true,
    note: 'Own independent receipt after frozen preview', lines: [{ product_id: c.id, quantity: 1, location: 'RET-01', lot_code: 'RD-STALE', unit_cost_minor: '0', currency: 'PLN' }] }, 201);
  const changed = await productCatalogFacts(f.tenant);
  assert.equal((await f.request(base + '/previews/' + p.id + '/receive', 'POST', consent(p, scan.lease))).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), changed); assert.equal(changed.return_assistant_receipts.length, 0);
});

test('v1 actor/key exact lost-ACK replay requires current scopes and current membership', async () => {
  const f = await fixture(false), t = await targetAndStatuses(f), scopes = ['orders:read', 'orders:write', 'inventory:read', 'inventory:write'];
  const key = await f.ok('/developer/keys', 'POST', { name: 'Own148 intake key', scopes }, 201);
  const otherKey = await f.ok('/developer/keys', 'POST', { name: 'Own148 other valid key', scopes }, 201);
  const request = (path: string, method: 'GET' | 'POST', payload?: Record<string, unknown>) => app.inject({ url: '/api/v1' + path, method, payload,
    headers: { authorization: 'Bearer ' + key.token }, remoteAddress: '127.148.0.1' });
  const lease = randomUUID();
  let r = await request('/return-assistant/sessions', 'POST', { client_key: randomUUID(), return_number: f.rma.number,
    station_id: f.station.id, station_version: String(f.station.version), lease_token: lease }); assert.equal(r.statusCode, 201);
  let session = r.json().session;
  for (const line of session.lines) for (let n = 0; n < line.requested; n++) {
    r = await request('/return-assistant/sessions/' + session.id + '/scans', 'POST', { client_key: randomUUID(), version: String(session.version),
      lease_token: lease, code: f.product.sku, item_id: line.item_id }); assert.equal(r.statusCode, 200); session = r.json().session;
  }
  r = await request(base + '/returns/' + f.rma.id + '/source?session_id=' + session.id, 'GET'); assert.equal(r.statusCode, 200);
  const s = r.json().source, input = draft(f, s, lease, t.statuses, splitParts(s));
  r = await request(base + '/returns/' + f.rma.id + '/previews', 'POST', input); assert.equal(r.statusCode, 201); const p = r.json().preview, body = consent(p, lease);
  r = await request(base + '/previews/' + p.id + '/receive', 'POST', body); assert.equal(r.statusCode, 201); const saved = r.json().operation;
  const accepted = await productCatalogFacts(f.tenant);
  // The first response is deliberately treated as lost. Only identical retained
  // body/key can settle it, with no second core, stock, audit or receipt write.
  r = await request(base + '/previews/' + p.id + '/receive', 'POST', body); assert.equal(r.statusCode, 200);
  assert.equal(r.json().reused, true); assert.deepEqual(r.json().operation, saved); assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  const wrongKey = await app.inject({ url: '/api/v1' + base + '/previews/' + p.id + '/receive', method: 'POST', payload: body,
    headers: { authorization: 'Bearer ' + otherKey.token }, remoteAddress: '127.148.0.1' });
  assert.equal(wrongKey.statusCode, 409); assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
  const revoked = await productCatalogFacts(f.tenant);
  assert.equal((await request(base + '/previews/' + p.id + '/receive', 'POST', body)).statusCode, 401);
  assert.deepEqual(await productCatalogFacts(f.tenant), revoked);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  try {
    const viewer = await productCatalogFacts(f.tenant);
    assert.equal((await f.request(base + '/previews/' + p.id + '/receive', 'POST', body)).statusCode, 403);
    assert.deepEqual(await productCatalogFacts(f.tenant), viewer);
  } finally { await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
});

test('all rejected parts need no invented scan, arrival, WMS or cash; exact rejection remains durable', async () => {
  const f = await fixture(true), t = await targetAndStatuses(f), scan = await startAndScan(f, false), s = await source(f, scan.session);
  const b = draft(f, s, scan.lease, t.statuses, s.planner_source.lines.map((l: Row) => ({ part_id: randomUUID(), item_id: l.item_id, quantity: l.requested, effect: 'reject' })));
  const p = (await f.ok(base + '/returns/' + f.rma.id + '/previews', 'POST', b, 201)).preview; assert.equal(p.action, 'reject');
  const beforeRows = await productCatalogFacts(f.tenant), body = consent(p, scan.lease);
  const saved = await f.ok(base + '/previews/' + p.id + '/receive', 'POST', body, 201);
  assert.equal(saved.return_case.state, 'rejected'); assert.equal(saved.return_case.refund_amount, 0);
  const afterRows = await productCatalogFacts(f.tenant);
  for (const name of ['stock', 'stock_locations', 'stock_movements', 'stock_location_movements', 'wms_operations', 'wms_return_fragments', 'payment_entries'])
    assert.deepEqual(afterRows[name], beforeRows[name], name);
  assert.equal(afterRows.return_destination_arrivals.length, 0); assert.equal(afterRows.return_destination_fragments.length, 0);
  const repeat = await f.ok(base + '/previews/' + p.id + '/receive', 'POST', body); assert.deepEqual(repeat.operation, saved.operation);
  assert.deepEqual(await productCatalogFacts(f.tenant), afterRows);
});

for (const on of [false, true]) for (const rejectAll of [false, true]) test(`commercial parcel ${on ? 'ON shared bundle fragments' : 'OFF'}: ${rejectAll ? 'reject-all releases the actual138 caps without goods or credit' : 'SALE/CUSTODY preserves origins before the second dispatch'}`, async () => {
  const f = await fixture(on), target = await targetAndStatuses(f);
  let order = await f.ok('/orders', 'POST', { source: 'manual', customer_name: 'Own early parcel return buyer', email: 'rd-parcel@example.test',
    address: { street: 'Own 148', city: 'Warszawa', postal_code: '00-148', country: 'PL', phone: '500000148' },
    warehouse_id: f.warehouse, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: f.product.id, quantity: 3 }],
    manual_lines: [{ product_id: f.product.id, quantity: 1, line_total: 1000 }, { product_id: f.product.id, quantity: 2, line_total: 3401 }] }, 201);
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt',
    amount: 4401, currency: 'PLN', method: 'other', reference: 'Own local parcel ledger', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  if (on) {
    const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations'); assert.equal(allocations.meta?.cursor ?? null, null);
    for (const allocation of allocations.data) {
      const component = f.components.find(c => c.id === allocation.product_id); assert(component);
      for (let n = 0; n < allocation.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: component.sku, location: allocation.location, layer_id: allocation.layer_id });
    }
  } else for (let n = 0; n < 3; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: f.product.sku, location: 'RET-01' });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' })); order = await f.ok('/orders/' + order.id);
  const expensive = order.items.find((line: Row) => line.line_total === 3401); assert(expensive);
  const pp = (await f.ok('/order-parcels/orders/' + order.id + '/previews', 'POST', {
    client_key: randomUUID(), order_version: String(order.version), protocol: 'commercial_v1', parcels: [
      { source_kind: 'demo', cod_minor: 0, items: order.items.map((line: Row) => ({ item_id: line.id, quantity: 1 })) },
      { source_kind: 'demo', cod_minor: 0, items: [{ item_id: expensive.id, quantity: 1 }] },
    ],
  }, 201)).preview;
  const plan = (await f.ok('/order-parcels/previews/' + pp.id + '/apply', 'POST', { client_key: randomUUID(), scope_hash: pp.scope_hash, confirmed: true }, 201)).plan;
  await f.ok('/order-parcels/plans/' + plan.id + '/parcels/0/dispatch', 'POST', { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true });
  order = await f.ok('/orders/' + order.id); const origins: Row[] = order.returns.parcel_origins;
  assert.equal(origins.length, 2); assert(origins.every(origin => origin.quantity === 1));
  let rma = await f.ok('/orders/' + order.id + '/returns', 'POST', { client_key: randomUUID(), reason: 'Own issued first parcel inspection', shipping_refund: 0,
    items: origins.map(origin => ({ item_id: origin.item_id, quantity: 1 })),
    parcel_origins: origins.map(origin => ({ item_id: origin.item_id, dispatch_id: origin.dispatch_id, quantity: 1 })) }, 201);
  rma = await f.ok('/returns/' + rma.id);
  const first = { ...f, order, rma }, scan = await startAndScan(first), s = await source(first, scan.session);
  assert.equal(s.origins.length, 2);
  assert.deepEqual(s.origins.map((origin: Row) => [origin.origin_id, origin.item_id, origin.dispatch_id, origin.quantity]).sort(),
    origins.map(origin => [origin.origin_id, origin.item_id, origin.dispatch_id, 1]).sort());
  if (on) assert(s.origins.every((origin: Row) => origin.fragments.length === 2));
  else assert(s.origins.every((origin: Row) => origin.fragments.length === 0));
  const b = draft(first, s, scan.lease, target.statuses, s.planner_source.lines.map((line: Row) => ({
    part_id: randomUUID(), item_id: line.item_id, quantity: 1, effect: rejectAll ? 'reject' : line.line_total_minor === 1000 ? 'sale' : 'custody',
  })));
  const p = (await first.ok(base + '/returns/' + rma.id + '/previews', 'POST', b, 201)).preview;
  assert.equal(p.summary.commercial_credit_minor, rejectAll ? 0 : 2700); assert.equal(p.summary.received_into_custody, rejectAll ? 0 : 1);
  assert.deepEqual(p.snapshot.origins, s.origins);
  const beforeRows = await productCatalogFacts(f.tenant), body = consent(p, scan.lease);
  const saved = await first.ok(base + '/previews/' + p.id + '/receive', 'POST', body, 201);
  const accepted = await productCatalogFacts(f.tenant);
  for (const name of ['order_items', 'payment_entries', 'documents', 'reservations', 'reservation_locations', 'wms_reservation_layers',
    'order_parcel_origin_issues', 'order_parcel_origin_fragments', 'order_parcel_dispatches']) assert.deepEqual(accepted[name], beforeRows[name], name);
  const claims = accepted.order_parcel_return_claims.filter(x => x.row.return_id === rma.id); assert.equal(claims.length, 2);
  assert.deepEqual(claims.map(x => [x.row.origin_id, x.row.item_id, x.row.quantity]).sort(), origins.map(origin => [origin.origin_id, origin.item_id, 1]).sort());
  assert.equal((await first.ok(base + '/previews/' + p.id + '/receive', 'POST', body)).operation.id, saved.operation.id);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  if (rejectAll) {
    assert.equal(p.action, 'reject'); assert.equal(saved.return_case.state, 'rejected');
    assert.deepEqual(p.summary, { accepted: 0, restocked_to_sale: 0, received_into_custody: 0, rejected: 2,
      commercial_credit_minor: 0, shipping_refund_minor: 0 });
    assert.equal(saved.operation.result.refund_amount, 0); assert.equal(saved.operation.result.refunded_shipping, 0);
    assert.equal(saved.return_case.receipt, null); assert.equal(saved.return_case.received_at, null);
    for (const name of ['stock', 'stock_locations', 'stock_movements', 'stock_location_movements', 'wms_layer_positions',
      'wms_layer_movements', 'wms_return_fragments', 'wms_cost_layers', 'wms_lots', 'wms_operations',
      'order_parcel_return_receipts', 'return_destination_arrivals', 'return_destination_fragments'])
      assert.deepEqual(accepted[name], beforeRows[name], 'Reject-all cannot invent a physical receive: ' + name);
    const caseItems = accepted.return_items.filter(x => x.row.return_id === rma.id);
    assert.equal(caseItems.length, 2); assert(caseItems.every(x => x.row.accepted === 0 && x.row.restocked === 0 && x.row.refund_amount === 0));
    const decisionProof = accepted.order_parcel_return_admissions.filter(x => x.row.return_id === rma.id && x.row.kind === 'decision');
    assert.equal(decisionProof.length, 1, 'Actual138 decision owns rejection; no substitute local-only receipt');
    const refreshed = await f.ok('/orders/' + order.id);
    const released: Row[] = refreshed.returns.parcel_origins;
    assert.deepEqual(released.map(origin => [origin.origin_id, origin.quantity, origin.available]).sort(),
      origins.map(origin => [origin.origin_id, origin.quantity, origin.quantity]).sort());
    for (const origin of released) {
      const original = origins.find(before => before.origin_id === origin.origin_id); assert(original);
      assert.deepEqual(origin.fragments, original.fragments, 'Reject-all retains exact fragment capacities');
    }
    // These GETs and exact receive replay never make a second decision/admission.
    assert.deepEqual(await productCatalogFacts(f.tenant), accepted); return;
  }
  // Remaining commercial reservation can still dispatch. It gets a distinct
  // original origin/fragment namespace; the first parcel cannot satisfy it.
  await f.ok('/order-parcels/plans/' + plan.id + '/parcels/1/dispatch', 'POST', { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true });
  order = await f.ok('/orders/' + order.id);
  const secondOrigin = order.returns.parcel_origins.find((origin: Row) => origin.item_id === expensive.id && !origins.some(old => old.origin_id === origin.origin_id)); assert(secondOrigin);
  let next = await f.ok('/orders/' + order.id + '/returns', 'POST', { client_key: randomUUID(), reason: 'Own second issued original parcel', shipping_refund: 0,
    items: [{ item_id: expensive.id, quantity: 1 }], parcel_origins: [{ item_id: expensive.id, dispatch_id: secondOrigin.dispatch_id, quantity: 1 }] }, 201);
  next = await f.ok('/returns/' + next.id); const second = { ...f, order, rma: next }, scan2 = await startAndScan(second), s2 = await source(second, scan2.session);
  assert.equal(s2.origins.length, 1); assert.equal(s2.origins[0].origin_id, secondOrigin.origin_id);
  const b2 = draft(second, s2, scan2.lease, target.statuses, [{ part_id: randomUUID(), item_id: expensive.id, quantity: 1, effect: 'custody' }]);
  if (on) assert(b2.wms_lots!.picks.every(pick => secondOrigin.fragments.some((fragment: Row) => fragment.fragment_id === pick.issue_fragment_id)));
  const p2 = (await second.ok(base + '/returns/' + next.id + '/previews', 'POST', b2, 201)).preview; assert.equal(p2.summary.commercial_credit_minor, 1701);
  await second.ok(base + '/previews/' + p2.id + '/receive', 'POST', consent(p2, scan2.lease), 201);
  const final = await productCatalogFacts(f.tenant);
  assert.equal(final.order_parcel_return_claims.filter(x => x.row.order_id === order.id).length, 3);
  assert.deepEqual(final.order_items, beforeRows.order_items); assert.deepEqual(final.payment_entries, beforeRows.payment_entries);
  for (const issue of final.wms_issue_fragments.filter(x => x.row.order_id === order.id))
    assert.equal(final.wms_return_fragments.filter(x => x.row.issue_fragment_id === issue.row.id).reduce((n, x) => n + x.row.quantity, 0), issue.row.quantity);
});

test('torn148 refuses even malformed writes before parsing and never silently enters139 fallback', async () => {
  const f = await fixture(false), original = await productCatalogFacts(f.tenant);
  const marker = (await pool.query("SELECT pg_get_functiondef('return_destination_guards()'::regprocedure) def")).rows[0].def;
  try {
    await pool.query('ALTER FUNCTION return_destination_guards() RENAME TO hidden148_guards');
    assert.equal((await f.request(base + '/options')).statusCode, 503);
    const r = await app.inject({ url: '/api' + base + '/returns/' + f.rma.id + '/previews', method: 'POST', payload: '{broken',
      headers: { cookie: f.cookie, 'content-type': 'application/json' } }); assert.equal(r.statusCode, 503);
    assert.deepEqual(await productCatalogFacts(f.tenant), original);
  } finally { await pool.query('ALTER FUNCTION hidden148_guards() RENAME TO return_destination_guards'); }
  assert.equal((await pool.query("SELECT pg_get_functiondef('return_destination_guards()'::regprocedure) def")).rows[0].def, marker);
  assert.equal((await f.request(base + '/options')).statusCode, 200); assert.deepEqual(await productCatalogFacts(f.tenant), original);
});

test('fully hidden148 namespace and ledger advertises neutral options; malformed writes cannot fall back', async () => {
  // An availability contract probe, not proof that amended090/139 functions can
  // receive a legacy return without148. Historical147 commerce needs its own DB.
  const f = await fixture(false), original = await productCatalogFacts(f.tenant);
  const tables = ['return_destination_parts', 'return_destination_arrivals', 'return_destination_fragments', 'return_destination_admissions'];
  const c = await pool.connect(); let hidden = false;
  const functions = (await c.query(`SELECT oid,proname,pg_get_functiondef(oid) definition,proowner,proacl
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_destination_%'
    AND proname NOT LIKE 'return_destination_status_%' ORDER BY oid`)).rows;
  assert(functions.length > 0);
  const marker = (await c.query("SELECT name,applied_at::text applied_at FROM migrations WHERE name='148_return_destinations'")).rows[0]; assert(marker);
  try {
    await c.query('BEGIN');
    for (const fn of functions) {
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO qa148_hidden_${fn.oid}`);
    }
    for (const table of tables) await c.query(`ALTER TABLE public.${table} RENAME TO qa148_hidden_${table}`);
    await c.query("DELETE FROM migrations WHERE name='148_return_destinations'"); await c.query('COMMIT'); hidden = true;
    for (const prefix of ['/api', '/api/v1']) {
      const headers = { cookie: f.cookie, 'content-type': 'application/json' };
      const options = await app.inject({ url: prefix + base + '/options', headers }); assert.equal(options.statusCode, 200);
      const dto = options.json(); assert.equal(dto.available, false); assert.equal(dto.intake_available, false); assert.equal(dto.can_write, false);
      const head = await app.inject({ method: 'HEAD', url: prefix + base + '/options', headers });
      assert.equal(head.statusCode, 200); assert.equal(head.body, '');
      for (const path of ['/returns/' + f.rma.id + '/previews', '/previews/' + randomUUID() + '/receive']) {
        const denied = await app.inject({ method: 'POST', url: prefix + base + path, payload: '{', headers }); assert.equal(denied.statusCode, 503);
      }
    }
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    try {
      if (hidden) {
        await c.query('BEGIN');
        for (const table of tables) await c.query(`ALTER TABLE public.qa148_hidden_${table} RENAME TO ${table}`);
        for (const fn of functions) {
          const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
          await c.query(`ALTER FUNCTION ${signature} RENAME TO ${fn.proname}`);
        }
        await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2)', [marker.name, marker.applied_at]); await c.query('COMMIT');
      }
    } finally { c.release(); }
  }
  assert.deepEqual((await pool.query(`SELECT oid,proname,pg_get_functiondef(oid) definition,proowner,proacl FROM pg_proc
    WHERE oid=ANY($1::oid[]) ORDER BY oid`, [functions.map(fn => fn.oid)])).rows, functions);
  assert.deepEqual(await productCatalogFacts(f.tenant), original);
});

test('isolated restore login reads safe148 proofs and denies malformed mutations before normal/v1 parsing', async () => {
  const f = await fixture(false), t = await targetAndStatuses(f), scan = await startAndScan(f), s = await source(f, scan.session);
  const input = draft(f, s, scan.lease, t.statuses, splitParts(s));
  const p = (await f.ok(base + '/returns/' + f.rma.id + '/previews', 'POST', input, 201)).preview;
  const readonly = await buildApp({ readOnly: true, previewPort: 4198,
    integrationTransport: async () => { throw Error('Readonly intake cannot call a provider'); } });
  try {
    const login = await readonly.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress: '127.148.8.1' }); assert.equal(login.statusCode, 200);
    const switched = await readonly.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: f.tenant },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress: '127.148.8.1' }); assert.equal(switched.statusCode, 200);
    const cookie = String(switched.headers['set-cookie']).split(';')[0], rows = await productCatalogFacts(f.tenant);
    for (const prefix of ['/api', '/api/v1']) {
      for (const path of ['/returns/' + f.rma.id + '/previews', '/previews/' + p.id + '/receive']) {
        const denied = await readonly.inject({ method: 'POST', url: prefix + base + path, payload: '{',
          headers: { cookie, 'content-type': 'application/json' }, remoteAddress: '127.148.8.1' }); assert.equal(denied.statusCode, 423);
      }
      for (const path of ['/options', '/returns/' + f.rma.id + '/source?session_id=' + scan.session.id, '/previews/' + p.id]) {
        const read = await readonly.inject({ url: prefix + base + path, headers: { cookie }, remoteAddress: '127.148.8.1' });
        assert.equal(read.statusCode, 200); const dto = read.json(); noPrivate(dto); assert.equal(dto.read_only, true); assert.equal(dto.can_write, false);
        if (dto.source) { assert.equal(dto.source.can_preview, false); assert.equal(dto.source.session.can_control, false); }
        if (dto.preview) assert.equal(dto.preview.can_receive, false);
      }
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), rows);
  } finally { await readonly.close(); }
});

test('actual093 enqueue and deferred flush ignore a consistent pg_temp graph and reject the inconsistent real issue proof', async () => {
  const f = await fixture(true), beforeRows = await productCatalogFacts(f.tenant);
  const issue = beforeRows.wms_issue_fragments.find(x => x.row.product_id === f.components[0].id)?.row;
  assert(issue); assert.equal(Number(issue.unit_cost_minor), 0);
  const installed = (await pool.query("SELECT prosecdef FROM pg_proc WHERE oid='public.wms_validate_operation_scope(uuid,uuid)'::regprocedure")).rows[0];
  assert.equal(installed.prosecdef, true, 'Exercise the actual148 SD upgrade');
  // A new physical backend has never cached the active093 validator's relation
  // plans. No direct call to the orphaned090 trigger function counts as proof.
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const operationId = randomUUID();
  try {
    // Since 262 dyna_app cannot create temporary tables at all (42501). The
    // validator must still ignore a shadow graph, so the shadow is built under a
    // grant that exists only inside this rolled-back transaction.
    await assert.rejects(c.query("BEGIN; SET LOCAL ROLE dyna_app; CREATE TEMP TABLE qa262_shadow_probe(x int)"),
      (error: unknown) => (error as { code?: string }).code === '42501');
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query("DO $$BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO dyna_app', current_database()); END$$");
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    for (const name of ['wms_operations', 'wms_layer_movements', 'wms_issue_fragments', 'wms_return_fragments',
      'wms_cost_layers', 'wms_lots', 'wms_layer_positions', 'return_cases', 'return_items']) {
      assert.match(name, /^[a-z_]+$/);
      await c.query(`CREATE TEMP TABLE ${name} AS SELECT * FROM public.${name} WITH NO DATA`);
    }
    for (const name of ['wms_cost_layers', 'wms_lots', 'wms_layer_positions', 'return_cases', 'return_items'])
      await c.query(`INSERT INTO pg_temp.${name} SELECT * FROM public.${name} WHERE tenant_id=$1`, [f.tenant]);
    const policyVersion = (await c.query('SELECT version FROM public.wms_policies WHERE tenant_id=$1', [f.tenant])).rows[0].version;
    await c.query(`INSERT INTO public.wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,request,result)
      VALUES($1,$2,$3,$4,$5,'issue','manual',$6,'{}','{}')`,
      [operationId, f.tenant, f.user, randomUUID(), 'a'.repeat(64), policyVersion]);
    await c.query('INSERT INTO pg_temp.wms_operations SELECT * FROM public.wms_operations WHERE tenant_id=$1 AND id=$2', [f.tenant, operationId]);
    await c.query("UPDATE pg_temp.wms_operations SET kind='bin_move' WHERE id=$1", [operationId]);
    // The real issue has a negative journal and no issue fragment. Its balancing
    // positive entry preserves all quantity scopes, so the active operation
    // validator must reject the missing issue evidence. The shadow operation is
    // a consistent balanced bin move; an unqualified SD lookup would pass.
    await c.query(`INSERT INTO public.wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind)
      VALUES($1,$2,$3,$4,$5,$6,$7,-1,0,'issue'),($8,$2,$3,$4,$5,$6,$7,1,0,'issue')`,
      [randomUUID(), f.tenant, operationId, issue.warehouse_id, issue.product_id, issue.location, issue.layer_id, randomUUID()]);
    await c.query('INSERT INTO pg_temp.wms_layer_movements SELECT * FROM public.wms_layer_movements WHERE tenant_id=$1 AND operation_id=$2', [f.tenant, operationId]);
    assert.equal((await c.query('SELECT sum(delta)::int n FROM pg_temp.wms_layer_movements WHERE operation_id=$1', [operationId])).rows[0].n, 0);
    await c.query('RESET ROLE');
    const queued = (await c.query(`SELECT kind,scope_id,operation_id FROM public.wms_validation_scopes
      WHERE transaction_id=pg_current_xact_id() AND tenant_id=$1 ORDER BY kind,scope_id`, [f.tenant])).rows;
    assert.equal(queued.filter(row => row.kind === 'operation' && row.operation_id === operationId && row.scope_id === operationId).length, 1,
      'The genuine AFTER STATEMENT trigger must enqueue this exact operation');
    assert.equal(queued.filter(row => row.kind === 'quantity').length, 1, 'Also exercise the unchanged real quantity scope');
    await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(c.query('SET CONSTRAINTS wms_validation_flush IMMEDIATE'),
      (error: unknown) => (error as { code?: string; message?: string }).code === '23514' &&
        (error as { message?: string }).message === 'Fragmenty wydania nie odpowiadają dokładnemu rozchodowi warstw');
  } finally { await c.query('ROLLBACK').catch(() => undefined); await c.end(); }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('real certified physical callback cannot append an issue fragment beneath the return operation', async () => {
  const f = await fixture(true), targets = await targetAndStatuses(f), scanned = await startAndScan(f);
  const s = await source(f, scanned.session);
  const input = draft(f, s, scanned.lease, targets.statuses, splitParts(s));
  const preview = (await f.ok(base + '/returns/' + f.rma.id + '/previews', 'POST', input, 201)).preview;
  const beforeRows = await productCatalogFacts(f.tenant);
  let physicalCalls = 0, insertedIssue = false, observedSqlDenial = false;
  await assert.rejects(receiveReturnDestinations(f.actor, preview.id, consent(preview, scanned.lease), {
    receiveCore: async (...args) => {
      try { return await receiveReturnDestinationCoreInTx(...args); }
      catch (error) {
        const e = error as { code?: string; message?: string };
        observedSqlDenial = e.code === '23514' && e.message === 'Przyjęcie do celów nie może tworzyć fragmentu wydania';
        throw error;
      }
    },
    applyPhysical: async (c, actor, eid, rid) => {
      ++physicalCalls;
      await applyReturnDestinationPhysicalInTx(c, actor, eid, rid);
      const op = (await c.query("SELECT id,kind,return_id FROM public.wms_operations WHERE tenant_id=$1 AND id=$2", [f.tenant, eid])).rows[0];
      assert.equal(op.kind, 'return'); assert.equal(op.return_id, f.rma.id);
      const fragment = (await c.query(`SELECT r.*,l.unit_cost_minor,l.currency FROM public.wms_return_fragments r
        JOIN public.wms_cost_layers l ON(l.tenant_id,l.id,l.product_id)=(r.tenant_id,r.layer_id,r.product_id)
        WHERE r.tenant_id=$1 AND r.operation_id=$2 AND r.warehouse_id=$3 ORDER BY r.id LIMIT 1`, [f.tenant, eid, f.warehouse])).rows[0];
      assert(fragment, 'The original physical adapter must create actual return fragments before the negative insertion');
      assert.equal((await c.query('SELECT count(*)::int n FROM public.stock_movements WHERE tenant_id=$1 AND return_id=$2 AND delta>0',
        [f.tenant, f.rma.id])).rows[0].n > 0, true);
      await c.query(`INSERT INTO public.wms_issue_fragments(id,tenant_id,operation_id,order_id,warehouse_document_id,
        warehouse_id,product_id,location,layer_id,quantity,unit_cost_minor,value_minor,currency)
        VALUES($1,$2,$3,NULL,NULL,$4,$5,$6,$7,1,$8,$8,$9)`,
      [randomUUID(), f.tenant, eid, fragment.warehouse_id, fragment.product_id, fragment.location, fragment.layer_id,
        fragment.unit_cost_minor, fragment.currency]);
      insertedIssue = true;
    },
  }), (error: unknown) => (error as { status?: number; message?: string }).status === 409 &&
    (error as { message?: string }).message === 'Przyjęcie do celów nie może tworzyć fragmentu wydania');
  assert.equal(physicalCalls, 1); assert.equal(insertedIssue, true); assert.equal(observedSqlDenial, true);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows,
    'Rejected parent/child graph rolls back every core, stock, WMS, admission and receipt effect');
});
