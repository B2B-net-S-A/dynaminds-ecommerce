import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_(?:test_\d+|(?:stk29|p277|m26[123])_202610(?:29|30)_\d{2})$/);
const prefix = '/wms-lots/stocktakes';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  ip = 1,
  calls = 0;
type Json = Record<string, any>;
const req = (path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: Json) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.0.123.' + ip,
  });
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: Json,
): Promise<Json> {
  const r = await req(path, method, body);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: HTTP ${r.statusCode}`);
  return r.json() as Json;
}
async function patchStatus(orderId: string, status: string) {
  // PATCH /orders/:id/status requires expected_version (order CAS); read the own order's current version.
  const path = '/orders/' + orderId + '/status';
  return ok(path, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath), path, { status }));
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.WMS_TEST_LOG === 'true',
    integrationTransport: async () => {
      ++calls;
      throw Error('Stocktake flows must remain local');
    },
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  calls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Physical stocktake flow','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Counted warehouse','ST-FLOW')",
    [warehouse, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function ownRows(table: string) {
  return (
    await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
      tenant,
    ])
  ).rows;
}
async function snapshot(tables: string[]) {
  const out: Record<string, unknown> = {};
  for (const table of tables) out[table] = await ownRows(table);
  return out;
}
const evidence = [
  'stock',
  'stock_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'wms_operations',
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_scope_layers',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'wms_stocktake_reviews',
  'wms_stocktake_review_rows',
  'wms_stocktake_postings',
  'audit_events',
  'order_events',
  'outbound_events',
  'outbound_deliveries',
];
async function setup(quantity = 10) {
  const p = await ok('/products', 'POST', {
    name: 'Counted physical product',
    sku: 'ST-' + randomUUID(),
    price: 2500,
    warehouse_id: warehouse,
    quantity,
    location: 'A-01',
  });
  const stock = (
    await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      p.id,
    ])
  ).rows[0];
  const opening = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Explicit known physical opening',
    lines: quantity
      ? [
          {
            product_id: p.id,
            warehouse_id: warehouse,
            location: 'A-01',
            quantity,
            stock_version: String(stock.version),
            lot_code: 'COUNTED-LOT',
            unit_cost_minor: '100',
          },
        ]
      : [],
  });
  assert.equal(opening.preview.ready, true);
  await ok('/wms-lots/opening-previews/' + opening.preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: opening.preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: false,
  });
  return p;
}
async function create(extra: Json = {}) {
  return (
    await ok(prefix, 'POST', {
      client_key: randomUUID(),
      warehouse_id: warehouse,
      name: 'Physical count flow',
      policy_version: '1',
      blind: true,
      ...extra,
    })
  ).stocktake as Json;
}
async function count(h: Json, quantity: number) {
  const page = await ok(prefix + '/' + h.id + '/lines');
  assert.equal(page.data.length, 1);
  const line = page.data[0];
  const body = {
    client_key: randomUUID(),
    note: 'Measured physical units',
    lines: [{ id: line.id, version: line.version, basis_token: line.basis_token, quantity }],
  };
  await ok(prefix + '/' + h.id + '/counts', 'POST', body);
  return { line, body, head: (await ok(prefix + '/' + h.id)).stocktake as Json };
}
async function review(h: Json, surplus: Json[] = []) {
  return (
    await ok(prefix + '/' + h.id + '/reviews', 'POST', {
      client_key: randomUUID(),
      version: h.version,
      note: 'Approve exact physical differences',
      surplus,
    })
  ).review as Json;
}
async function post(h: Json, r: Json) {
  const body = {
    client_key: randomUUID(),
    version: r.stocktake_version,
    review_id: r.id,
    scope_hash: r.scope_hash,
    confirmed: true,
  };
  const result = await ok(prefix + '/' + h.id + '/post', 'POST', body);
  assert.equal(result.posting.state, 'posted');
  return { body, result };
}

test('shortage respects reserved lot units, preserves OMS/catalogue and leaves the original reservation scannable', async () => {
  const p = await setup();
  const order = await ok('/orders', 'POST', {
    customer_name: 'Counted order',
    email: 'count@example.test',
    phone: '500600700',
    payment_mode: 'cod',
    warehouse_id: warehouse,
    address: {
      street: 'Testowa',
      building_number: '1',
      city: 'Warszawa',
      post_code: '00-001',
      country: 'PL',
    },
    items: [{ product_id: p.id, quantity: 5 }],
  });
  const protectedBefore = await snapshot([
    'products',
    'orders',
    'order_items',
    'reservations',
    'reservation_locations',
    'wms_reservation_layers',
    'wms_issue_fragments',
    'order_events',
    'outbound_events',
    'outbound_deliveries',
  ]);
  const h = await create(),
    measured = await count(h, 8),
    r = await review(measured.head);
  assert.equal(r.summary.shortage_quantity, 2);
  assert.equal(r.summary.known_loss_minor, '200');
  const posted = await post(h, r);
  assert.equal(posted.result.posting.changed, true);
  assert.deepEqual(await snapshot(Object.keys(protectedBefore)), protectedBefore);
  const stock = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      p.id,
    ])
  ).rows[0];
  assert.deepEqual(stock, { on_hand: 8, reserved: 5 });
  const v = (await ok('/wms-lots/valuation')).valuation;
  assert.equal(v.known_minor, '800');
  const receiptSnapshot = await snapshot(evidence);
  const retry = await ok(prefix + '/' + h.id + '/post', 'POST', posted.body);
  assert.equal(retry.reused, true);
  assert.equal(retry.posting.id, posted.result.posting.id);
  assert.deepEqual(await snapshot(evidence), receiptSnapshot);
  const terminal = (await ok(prefix + '/' + h.id)).stocktake;
  assert.equal(terminal.needs_recount_count, 0);
  assert(
    (await ok(prefix + '/' + h.id + '/lines')).data.every((l: Json) => l.needs_recount === false),
  );
  await patchStatus(order.id, 'picking');
  const allocation = (
    await pool.query(
      'SELECT layer_id,location FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2',
      [tenant, order.id],
    )
  ).rows[0];
  for (let n = 0; n < 5; n++)
    await ok('/orders/' + order.id + '/scan', 'POST', {
      client_key: randomUUID(),
      code: p.sku,
      location: allocation.location,
      layer_id: allocation.layer_id,
    });
  assert.equal(
    (
      await pool.query(
        'SELECT scanned FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2',
        [tenant, order.id],
      )
    ).rows[0].scanned,
    5,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM wms_issue_fragments WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(calls, 0);
});

test('declared discovery is inert until approved posting, then creates a genuine known-cost lot layer and exact source-linked journal once', async () => {
  const p = await setup(0),
    before = await snapshot([
      'stock',
      'stock_locations',
      'wms_lots',
      'wms_cost_layers',
      'wms_layer_positions',
      'wms_layer_movements',
    ]);
  const h = await create({
    discoveries: [
      {
        product_id: p.id,
        location: 'FOUND-01',
        lot: { kind: 'new', lot_code: 'FOUND-LOT', expiry_date: '2027-01-01' },
      },
    ],
  });
  const measured = await count(h, 3);
  const r = await review(measured.head, [
    { line_id: measured.line.id, unit_cost_minor: '123', currency: 'PLN' },
  ]);
  assert.deepEqual(await snapshot(Object.keys(before)), before);
  await post(h, r);
  const layer = (
    await pool.query(
      'SELECT quantity_received,unit_cost_minor,stocktake_line_id FROM wms_cost_layers WHERE tenant_id=$1',
      [tenant],
    )
  ).rows[0];
  assert.deepEqual(layer, {
    quantity_received: 3,
    unit_cost_minor: '123',
    stocktake_line_id: measured.line.id,
  });
  const journal = (
    await pool.query('SELECT delta,value_delta FROM wms_layer_movements WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows;
  assert.deepEqual(journal, [{ delta: 3, value_delta: '369' }]);
  const value = (await ok('/wms-lots/valuation')).valuation;
  assert.equal(value.known_minor, '369');
  assert.equal(value.unknown_quantity, '0');
  assert.equal(calls, 0);
});

test('reopen preserves immutable earlier review, recount creates a new consent, cancellation and count retries remain effect-free', async () => {
  await setup(4);
  const h = await create(),
    m = await count(h, 4),
    r = await review(m.head);
  const reopened = await ok(prefix + '/' + h.id + '/reopen', 'POST', {
    client_key: randomUUID(),
    version: r.stocktake_version,
    note: 'Count again before final approval',
  });
  assert.equal(reopened.stocktake.state, 'counting');
  const m2 = await count(reopened.stocktake, 3),
    r2 = await review(m2.head);
  assert.notEqual(r2.id, r.id);
  const reviews = await ok(prefix + '/' + h.id + '/reviews');
  assert.equal(reviews.data.length, 2);
  assert.equal(
    (await ok(prefix + '/' + h.id + '/reviews/' + r.id)).review.scope_hash,
    r.scope_hash,
  );
  const cancelBody = {
    client_key: randomUUID(),
    version: r2.stocktake_version,
    note: 'Cancelled before ledger changes',
  };
  await ok(prefix + '/' + h.id + '/cancel', 'POST', cancelBody);
  const after = await snapshot(evidence);
  assert.equal((await ok(prefix + '/' + h.id + '/cancel', 'POST', cancelBody)).reused, true);
  assert.equal((await ok(prefix + '/' + h.id + '/counts', 'POST', m2.body)).reused, true);
  assert.deepEqual(await snapshot(evidence), after);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM wms_stocktake_postings WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT on_hand FROM stock WHERE tenant_id=$1', [tenant])).rows[0].on_hand,
    4,
  );
  assert.equal((await ok(prefix + '/' + h.id)).stocktake.needs_recount_count, 0);
  assert.equal(calls, 0);
});
