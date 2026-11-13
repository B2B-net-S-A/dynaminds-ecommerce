/** The documented stocktake bound, using an explicitly synthetic physical layout. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { wmsLotsHash } from '../server/wms-lots';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL ?? '').pathname, /^\/dynaminds_test_\d+$/);
const prefix = '/wms-lots/stocktakes';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  ip = 1;
const request = (path: string, method: any = 'GET', body?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.0.123.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await request(path, method, body);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode} ${r.body}`);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.WMS_TEST_LOG === 'true',
    integrationTransport: async () => {
      throw Error('No provider calls in stocktake boundary fixture');
    },
  });
  const login = await request('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Synthetic stocktake 10000 boundary','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Bounded physical layout','BOUND')",
    [warehouse, tenant],
  );
  const switched = await request('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

test('10000 physical lot-bin lines paginate without omission; 10001 scope and 101 count fail atomically', async () => {
  const product = await ok('/products', 'POST', {
    sku: 'BOUND-' + randomUUID(),
    name: 'Synthetic physical count fixture',
    price: 100,
    warehouse_id: warehouse,
    quantity: 10001,
    location: 'A-01',
  });
  const stockVersion = (
    await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      product.id,
    ])
  ).rows[0].version;
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Synthetic boundary opening with unknown cost',
    lines: [
      {
        warehouse_id: warehouse,
        product_id: product.id,
        location: 'A-01',
        quantity: 10001,
        stock_version: stockVersion,
        lot_code: 'BOUND-LOT',
        unit_cost_minor: null,
      },
    ],
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: true,
  });
  const layer = (await pool.query('SELECT id FROM wms_cost_layers WHERE tenant_id=$1', [tenant]))
    .rows[0].id;
  // Direct fixture construction redistributes one existing layer and preserves exact quantity/journal.
  // This is a synthetic test setup, not proof of an API bin-move batch or SaaS capacity.
  await tenantTx(tenant, async (c) => {
    // Fixture only: 10000 rows per statement pass per-row warehouse policy guards (~5-13 ms per row,
    // 13.11.2026) and exceeded the ordinary 8 s statement_timeout on CI. The code under test keeps 8 s.
    await c.query("SET LOCAL statement_timeout='120s'");
    const operation = randomUUID();
    await c.query(
      `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,request,result)
      VALUES($1,$2,$3,$4,$5,'bin_move','manual',1,$6,'{}')`,
      [
        operation,
        tenant,
        user,
        randomUUID(),
        wmsLotsHash({ synthetic: '10000-bin-layout' }),
        { synthetic: '10000-bin-layout' },
      ],
    );
    await c.query(
      "UPDATE stock_locations SET quantity=1 WHERE warehouse_id=$1 AND product_id=$2 AND location='A-01'",
      [warehouse, product.id],
    );
    await c.query(
      "UPDATE wms_layer_positions SET quantity=1,version=version+1 WHERE warehouse_id=$1 AND product_id=$2 AND location='A-01'",
      [warehouse, product.id],
    );
    await c.query(
      `INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity)
      SELECT $1,$2,$3,'B'||lpad(n::text,5,'0'),1 FROM generate_series(0,9999) n`,
      [tenant, warehouse, product.id],
    );
    await c.query(
      `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity)
      SELECT $1,$2,$3,'B'||lpad(n::text,5,'0'),$4,1 FROM generate_series(0,9999) n`,
      [tenant, warehouse, product.id, layer],
    );
    await c.query(
      `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,'A-01',$5,-10000,NULL,'bin_move')`,
      [tenant, operation, warehouse, product.id, layer],
    );
    await c.query(
      `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind)
      SELECT gen_random_uuid(),$1,$2,$3,$4,'B'||lpad(n::text,5,'0'),$5,1,NULL,'bin_move' FROM generate_series(0,9999) n`,
      [tenant, operation, warehouse, product.id, layer],
    );
  });
  const oversized = await request(prefix, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    name: 'Reject 10001 source positions',
    policy_version: '1',
    blind: true,
  });
  assert.equal(oversized.statusCode, 422);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM wms_stocktakes WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    0,
  );
  const { stocktake } = await ok(prefix, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    name: 'Count 10000 source positions',
    policy_version: '1',
    blind: true,
    location_prefix: 'B',
  });
  assert.equal(stocktake.line_count, 10000);
  const ids = new Set<string>();
  let cursor: string | null = null,
    pages = 0,
    first: any[] = [];
  do {
    ++ip;
    const page = await ok(
      prefix +
        '/' +
        stocktake.id +
        '/lines?' +
        new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
    );
    assert.equal(page.data.length, 100);
    if (!pages) first = page.data;
    for (const line of page.data) {
      assert(!ids.has(line.id));
      ids.add(line.id);
      assert.equal(line.current_quantity, 1);
    }
    ++pages;
    cursor = page.meta.cursor;
  } while (cursor);
  assert.equal(pages, 100);
  assert.equal(ids.size, 10000);
  ++ip;
  const invalid = await request(prefix + '/' + stocktake.id + '/counts', 'POST', {
    client_key: randomUUID(),
    note: 'Reject oversized measurement batch',
    lines: [...first, first[0]].map((line) => ({
      id: line.id,
      version: line.version,
      basis_token: line.basis_token,
      quantity: 1,
    })),
  });
  assert.equal(invalid.statusCode, 422);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM wms_stocktake_measurements WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0].n,
    0,
  );
  const body = {
    client_key: randomUUID(),
    note: 'Exact 100 physical counts',
    lines: first.map((line) => ({
      id: line.id,
      version: line.version,
      basis_token: line.basis_token,
      quantity: 1,
    })),
  };
  await ok(prefix + '/' + stocktake.id + '/counts', 'POST', body);
  const replay = await ok(prefix + '/' + stocktake.id + '/counts', 'POST', body);
  assert.equal(replay.reused, true);
  const head = (await ok(prefix + '/' + stocktake.id)).stocktake;
  assert.equal(head.counted_count, 100);
  const notReady = await request(prefix + '/' + stocktake.id + '/reviews', 'POST', {
    client_key: randomUUID(),
    version: head.version,
    note: 'Incomplete scope cannot be approved',
    surplus: [],
  });
  assert.equal(notReady.statusCode, 409);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM wms_stocktake_reviews WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  assert.deepEqual(
    (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        product.id,
      ])
    ).rows[0],
    { on_hand: 10001, reserved: 0 },
  );
});
