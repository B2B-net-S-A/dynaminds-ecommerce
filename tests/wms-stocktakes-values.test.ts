/** Real count/review/post valuation, not a second implementation of FIFO math. */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
const prefix = '/wms-lots/stocktakes';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  ip = 1,
  calls = 0;
const req = (path: string, method: any = 'GET', body?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.0.122.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode}`);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.WMS_TEST_LOG === 'true',
    integrationTransport: async () => {
      ++calls;
      throw Error('Local stocktake valuation never calls providers');
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
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Actual counted value','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Counted value warehouse','VALUE')",
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
async function setup(quantity: number, cost: string | null) {
  const p = await ok('/products', 'POST', {
    sku: 'VALUE-' + randomUUID(),
    name: 'Physical count value',
    price: 2500,
    warehouse_id: warehouse,
    quantity: quantity > 1000000 ? 0 : quantity,
    location: 'A-01',
  });
  if (quantity > 1000000) {
    // Explicit synthetic OFF opening stock, before any WMS policy exists. This
    // isolates the int32 stocktake boundary from legacy catalogue input limits.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      await c.query('UPDATE stock SET on_hand=$3 WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
        quantity,
      ]);
      await c.query(
        `INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity)
        VALUES($1,$2,$3,'A-01',$4) ON CONFLICT(tenant_id,warehouse_id,product_id,location)
        DO UPDATE SET quantity=excluded.quantity`,
        [tenant, warehouse, p.id, quantity],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  const version = String(
    (
      await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
      ])
    ).rows[0].version,
  );
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Explicit exact known or unknown opening',
    lines: [
      {
        product_id: p.id,
        warehouse_id: warehouse,
        location: 'A-01',
        quantity,
        stock_version: version,
        lot_code: 'VALUED-LOT',
        unit_cost_minor: cost,
      },
    ],
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: cost === null,
  });
  const layer = (await pool.query('SELECT * FROM wms_cost_layers WHERE tenant_id=$1', [tenant]))
    .rows[0];
  const { stocktake } = await ok(prefix, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    name: 'Count exact physical units',
    policy_version: '1',
    blind: true,
  });
  const line = (await ok(prefix + '/' + stocktake.id + '/lines')).data[0];
  return { p, stocktake, line, layer };
}
async function count(f: Awaited<ReturnType<typeof setup>>, quantity: number) {
  await ok(prefix + '/' + f.stocktake.id + '/counts', 'POST', {
    client_key: randomUUID(),
    note: 'Actual physical measurement',
    lines: [{ id: f.line.id, version: f.line.version, basis_token: f.line.basis_token, quantity }],
  });
  return (await ok(prefix + '/' + f.stocktake.id)).stocktake;
}
async function review(f: Awaited<ReturnType<typeof setup>>, quantity: number, surplus: any[] = []) {
  const h = await count(f, quantity);
  return (
    await ok(prefix + '/' + h.id + '/reviews', 'POST', {
      client_key: randomUUID(),
      version: h.version,
      note: 'Approve physical difference and cost',
      surplus,
    })
  ).review;
}
async function post(f: Awaited<ReturnType<typeof setup>>, r: any) {
  assert.equal(r.ready, true);
  const head = (await ok(prefix + '/' + f.stocktake.id)).stocktake;
  const result = await ok(prefix + '/' + head.id + '/post', 'POST', {
    client_key: randomUUID(),
    version: head.version,
    review_id: r.id,
    scope_hash: r.scope_hash,
    confirmed: true,
  });
  assert.equal(result.posting.state, 'posted');
  assert.equal(calls, 0);
  return result.posting;
}
async function value() {
  return (await ok('/wms-lots/valuation')).valuation;
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    'stock',
    'stock_locations',
    'wms_lots',
    'wms_cost_layers',
    'wms_layer_positions',
    'wms_layer_movements',
    'wms_reservation_layers',
    'wms_issue_fragments',
    'wms_operations',
    'wms_stocktakes',
    'wms_stocktake_lines',
    'wms_stocktake_measurements',
    'wms_stocktake_measurement_layers',
    'wms_stocktake_reviews',
    'wms_stocktake_review_rows',
    'wms_stocktake_postings',
    'orders',
    'reservations',
    'reservation_locations',
    'audit_events',
    'jobs',
    'outbound_events',
    'outbound_deliveries',
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}

test('unknown-cost shortage preserves NULL journal value, known zero is not substituted, and no sales COGS is invented', async () => {
  const f = await setup(5, null),
    r = await review(f, 3);
  await post(f, r);
  const v = await value();
  assert.equal(v.known_minor, '0');
  assert.equal(v.unknown_quantity, '3');
  assert.equal(v.known_quantity, '0');
  const journal = (
    await pool.query(
      'SELECT delta,value_delta FROM wms_layer_movements WHERE tenant_id=$1 AND delta<0',
      [tenant],
    )
  ).rows;
  assert.deepEqual(journal, [{ delta: -2, value_delta: null }]);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM wms_issue_fragments WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  const layer = (await pool.query('SELECT * FROM wms_cost_layers WHERE id=$1', [f.layer.id]))
    .rows[0];
  assert.equal(layer.quantity_received, 5);
  assert.equal(layer.unit_cost_minor, null);
});
test('surplus at cost beyond Number precision creates a new same-lot layer and preserves every minor unit', async () => {
  const cost = '9007199254740993',
    f = await setup(1, cost),
    r = await review(f, 2, [{ line_id: f.line.id, unit_cost_minor: cost, currency: 'PLN' }]);
  const before = (
    await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      f.p.id,
    ])
  ).rows[0].version;
  await post(f, r);
  const v = await value();
  assert.equal(v.known_minor, '18014398509481986');
  assert.equal(v.unknown_quantity, '0');
  const layers = (
    await pool.query('SELECT * FROM wms_cost_layers WHERE tenant_id=$1 ORDER BY fifo_sequence', [
      tenant,
    ])
  ).rows;
  assert.equal(layers.length, 2);
  assert.equal(layers[0].id, f.layer.id);
  assert.equal(layers[0].quantity_received, 1);
  assert.equal(layers[1].lot_id, f.layer.lot_id);
  assert.equal(layers[1].unit_cost_minor, cost);
  assert.equal(layers[1].quantity_received, 1);
  const after = (
    await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      f.p.id,
    ])
  ).rows[0].version;
  assert.equal(BigInt(after) - BigInt(before), 1n);
});
test('unknown existing stock requires explicit surplus cost; intentional zero affects only the new layer', async () => {
  const f = await setup(5, null),
    h = await count(f, 6),
    before = await snapshot();
  const invalid = await req(prefix + '/' + h.id + '/reviews', 'POST', {
    client_key: randomUUID(),
    version: h.version,
    note: 'Missing known surplus cost',
    surplus: [],
  });
  assert.equal(invalid.statusCode, 422);
  assert.deepEqual(await snapshot(), before);
  const { review: r } = await ok(prefix + '/' + h.id + '/reviews', 'POST', {
    client_key: randomUUID(),
    version: h.version,
    note: 'Explicit known zero surplus',
    surplus: [{ line_id: f.line.id, unit_cost_minor: '0', currency: 'PLN' }],
  });
  await post(f, r);
  const v = await value();
  assert.equal(v.known_minor, '0');
  assert.equal(v.unknown_quantity, '5');
  assert.equal(v.known_quantity, '1');
  const layers = (
    await pool.query(
      'SELECT unit_cost_minor FROM wms_cost_layers WHERE tenant_id=$1 ORDER BY fifo_sequence',
      [tenant],
    )
  ).rows;
  assert.deepEqual(layers, [{ unit_cost_minor: null }, { unit_cost_minor: '0' }]);
});
test('aggregate int64 overflow and mixed currency surplus fail before any review or correction commits', async () => {
  const f = await setup(1, '9223372036854775807'),
    h = await count(f, 2),
    before = await snapshot();
  for (const input of [
    { unit_cost_minor: '1', currency: 'PLN' },
    { unit_cost_minor: '0', currency: 'EUR' },
  ]) {
    const r = await req(prefix + '/' + h.id + '/reviews', 'POST', {
      client_key: randomUUID(),
      version: h.version,
      note: 'Reject unsafe surplus total',
      surplus: [{ line_id: f.line.id, ...input }],
    });
    assert.equal(r.statusCode, 422);
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal((await value()).known_minor, '9223372036854775807');
});
test('physical quantities above one million remain exact without reintroducing legacy stocktake limits', async () => {
  const f = await setup(2000001, null),
    r = await review(f, 2000000);
  await post(f, r);
  assert.equal((await value()).unknown_quantity, '2000000');
  const stock = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      f.p.id,
    ])
  ).rows[0];
  assert.deepEqual(stock, { on_hand: 2000000, reserved: 0 });
});
test('below-reserved count is observational but admin review rejects the whole correction without releasing reservations', async () => {
  const f = await setup(5, null);
  const order = await ok('/orders', 'POST', {
    customer_name: 'Reserved physical count',
    email: 'count@example.test',
    payment_mode: 'cod',
    warehouse_id: warehouse,
    items: [{ product_id: f.p.id, quantity: 4 }],
  });
  assert(order.id);
  f.line = (await ok(prefix + '/' + f.stocktake.id + '/lines')).data[0];
  const h = await count(f, 3),
    before = await snapshot();
  const r = await req(prefix + '/' + h.id + '/reviews', 'POST', {
    client_key: randomUUID(),
    version: h.version,
    note: 'Cannot erase active reserved units',
    surplus: [],
  });
  assert.equal(r.statusCode, 409);
  assert.match(JSON.stringify(r.json()), /rezerw|count_below_reserved/i);
  assert.deepEqual(await snapshot(), before);
  const stock = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      f.p.id,
    ])
  ).rows[0];
  assert.deepEqual(stock, { on_hand: 5, reserved: 4 });
  const allocations = (
    await pool.query(
      'SELECT quantity,scanned,state FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2',
      [tenant, order.id],
    )
  ).rows;
  assert.deepEqual(allocations, [{ quantity: 4, scanned: 0, state: 'active' }]);
});
test('measurement NOP retains unknown stock versions and movements but records exactly one immutable posting', async () => {
  const f = await setup(5, null),
    r = await review(f, 5);
  const before = (
    await pool.query('SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1', [tenant])
  ).rows;
  const bins = (
    await pool.query('SELECT to_jsonb(t) row FROM stock_locations t WHERE tenant_id=$1', [tenant])
  ).rows;
  const positions = (
    await pool.query('SELECT to_jsonb(t) row FROM wms_layer_positions t WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows;
  const movements = (
    await pool.query(
      'SELECT to_jsonb(t) row FROM wms_layer_movements t WHERE tenant_id=$1 ORDER BY 1',
      [tenant],
    )
  ).rows;
  await post(f, r);
  for (const [table, expected] of [
    ['stock', before],
    ['stock_locations', bins],
    ['wms_layer_positions', positions],
    ['wms_layer_movements', movements],
  ] as const)
    assert.deepEqual(
      (
        await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
          tenant,
        ])
      ).rows,
      expected,
    );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM wms_stocktake_postings WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal((await value()).unknown_quantity, '5');
});
