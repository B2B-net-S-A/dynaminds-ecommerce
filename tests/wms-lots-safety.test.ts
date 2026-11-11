import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { backendPid, waitForLockEdge } from './lock-edge-helper';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_(?:test_\d+|wmsopen_20261029_\d{2}|fix29b_20261029_\d{2}|int29b_20261029_\d{2})$/);

let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  destination = '',
  adminId = '',
  operatorId = '',
  admin = '',
  operator = '',
  viewer = '',
  ip = 1,
  providerCalls = 0;
const cookies = new Map<string, string>();
const transport = async () => {
  providerCalls++;
  throw Error('WMS safety must never use a real provider transport');
};
const req = (
  path: string,
  method: any = 'GET',
  body?: any,
  auth = admin,
  target = app,
  headers: Record<string, string> = {},
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie: auth, ...headers },
    remoteAddress: '127.0.111.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, auth = admin, target = app) {
  const r = await req(path, method, body, auth, target);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: HTTP ${r.statusCode}`);
  return r.json() as any;
}
async function login(email: string, target = app) {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.WMS_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  operatorId = (await pool.query("SELECT id FROM users WHERE email='operator@demo.local'")).rows[0]
    .id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  destination = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'WMS safety','enterprise')", [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role)
    SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local'
      THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])`,
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  operator = cookies.get('operator@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  await pool.query(
    `INSERT INTO warehouses(id,tenant_id,name,code)
    VALUES($1,$3,'FIFO source','FIFO-S'),($2,$3,'FIFO destination','FIFO-D')`,
    [warehouse, destination, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

async function product(quantity = 0, extra: any = {}) {
  return ok('/products', 'POST', {
    sku: 'FIFO-' + randomUUID(),
    name: 'FIFO safety product',
    price: 2500,
    warehouse_id: warehouse,
    quantity,
    location: 'A-01',
    ...extra,
  });
}
async function stock(productId: string, warehouseId = warehouse) {
  return (
    await pool.query(
      'SELECT * FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouseId, productId],
    )
  ).rows[0];
}
// Each request first spends its schema preflight (10-18 s on a loaded PG04 without the startup
// gate) before it reaches the held lock; wait for that exact edge, not a fixed 3 s. The edge is
// the holder's row lock (its xid) unless an advisory key is given.
async function waitOn(
  client: PoolClient,
  queryPattern: RegExp,
  pending: Array<ReturnType<typeof req>>,
  advisoryKey?: string,
) {
  await waitForLockEdge(
    pool,
    { blocker: await backendPid(client), query: queryPattern, advisoryKey },
    pending,
  );
}
async function commitGrant(sql: string, args: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, args);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const wmsTables = [
  'wms_policies',
  'wms_operations',
  'wms_previews',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
];
const businessTables = [
  'products',
  'product_sku_aliases',
  'product_logistics',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'stock_location_operations',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'warehouse_documents',
  'warehouse_document_lines',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'return_cases',
  'return_items',
  'payment_entries',
  'order_local_financial_fences',
  'shipping_plans',
  'shipments',
  'order_events',
  'audit_events',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const name of [...businessTables, ...wmsTables])
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) AS row FROM ${name} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function opening(lines: any[] = []) {
  return (
    await ok('/wms-lots/opening-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Explicit FIFO opening',
      lines,
    })
  ).preview;
}
const activateBody = (p: any, extra: any = {}) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
  ack_unknown_costs: true,
  ...extra,
});
async function enable(lines: any[] = []) {
  const p = await opening(lines);
  assert.equal(p.ready, true);
  await ok('/wms-lots/opening-previews/' + p.id + '/activate', 'POST', activateBody(p));
  const meta = await ok('/wms-lots');
  assert.equal(meta.policy.enabled, true);
  assert.equal(meta.policy.version, '1');
  return meta;
}
async function versions(ids: string[], wh = warehouse) {
  return Promise.all(
    ids.map(async (product_id) => ({
      product_id,
      warehouse_id: wh,
      version: String((await stock(product_id, wh))?.version ?? '0'),
    })),
  );
}
async function receiptBody(p: any, quantities = [2, 3], costs = ['101', '203']) {
  return {
    client_key: randomUUID(),
    policy_version: '1',
    warehouse_id: warehouse,
    stock_versions: await versions([p.id]),
    confirmed: true,
    note: 'FIFO controlled receipt',
    lines: quantities.map((quantity, i) => ({
      product_id: p.id,
      location: 'A-01',
      quantity,
      lot_code: 'LOT-' + i + '-' + randomUUID(),
      unit_cost_minor: costs[i],
      currency: 'PLN',
    })),
  };
}
async function supply(quantities = [2, 3], costs = ['101', '203']) {
  const p = await product();
  await enable();
  const body = await receiptBody(p, quantities, costs);
  const r = await ok('/wms-lots/receipts', 'POST', body);
  const layers = (
    await pool.query(
      'SELECT * FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2 ORDER BY fifo_sequence',
      [tenant, p.id],
    )
  ).rows;
  assert.equal(layers.length, quantities.length);
  return { p, body, r, layers };
}
async function sale(p: any, quantity = 3, auth = admin) {
  return req(
    '/orders',
    'POST',
    {
      customer_name: 'FIFO customer',
      email: 'fifo@example.test',
      payment_mode: 'cod',
      warehouse_id: warehouse,
      items: [{ product_id: p.id, quantity }],
    },
    auth,
  );
}
async function allocations(orderId: string) {
  return (
    await pool.query(
      `SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2
    ORDER BY layer_id,location`,
      [tenant, orderId],
    )
  ).rows;
}
async function blockedWithdrawal(
  lockSql: string,
  lockArgs: unknown[],
  request: () => ReturnType<typeof req>,
  changeSql: string,
  changeArgs: unknown[],
  expected: number,
) {
  const c = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  const before = await snapshot();
  try {
    await c.query('BEGIN');
    await c.query(lockSql, lockArgs);
    pending = request();
    await waitOn(c, /\bstock\b|wms_layer_positions|\busers\b/i, [pending]);
    await commitGrant(changeSql, changeArgs);
    await c.query('COMMIT');
    assert.equal((await pending).statusCode, expected);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending;
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
}

test('unknown opening is explicitly acknowledged and does not become a zero cost layer', async () => {
  const p = await product(3),
    s = await stock(p.id);
  const preview = await opening([
    {
      warehouse_id: warehouse,
      product_id: p.id,
      location: 'A-01',
      quantity: 3,
      stock_version: s.version,
      lot_code: 'UNKNOWN-OPENING',
      unit_cost_minor: null,
    },
  ]);
  assert.equal(preview.ready, true);
  const before = await snapshot();
  assert.equal(
    (
      await req(
        '/wms-lots/opening-previews/' + preview.id + '/activate',
        'POST',
        activateBody(preview, { ack_unknown_costs: false }),
      )
    ).statusCode,
    422,
  );
  assert.deepEqual(await snapshot(), before);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', activateBody(preview));
  const { valuation: value } = await ok('/wms-lots/valuation?product_id=' + p.id);
  assert.equal(value.unknown_quantity, '3');
  assert.equal(value.known_quantity, '0');
  assert.equal(value.known_minor, '0');
  const layers = (
    await pool.query(
      'SELECT unit_cost_minor FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2',
      [tenant, p.id],
    )
  ).rows;
  assert.equal(layers.length, 1);
  assert.equal(layers[0].unit_cost_minor, null);
});
test('opening refuses existing active reservations and stale whole-stock scope without partial activation', async () => {
  const p = await product(4),
    s = await stock(p.id);
  const head = await opening([
    {
      warehouse_id: warehouse,
      product_id: p.id,
      location: 'A-01',
      quantity: 4,
      stock_version: s.version,
      lot_code: 'OLD-OPENING',
      unit_cost_minor: '19',
    },
  ]);
  assert.equal(head.ready, true);
  const created = await sale(p, 1);
  assert.equal(created.statusCode, 201);
  const before = await snapshot();
  assert.equal(
    (await req('/wms-lots/opening-previews/' + head.id + '/activate', 'POST', activateBody(head)))
      .statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
  const current = await opening([
    {
      warehouse_id: warehouse,
      product_id: p.id,
      location: 'A-01',
      quantity: 4,
      stock_version: (await stock(p.id)).version,
      lot_code: 'NEW-OPENING',
      unit_cost_minor: '19',
    },
  ]);
  assert.equal(current.ready, false);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM wms_policies WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    0,
  );
});
test('activation blocked on real stock permits admin downgrade and rolls back every opening effect', async () => {
  const p = await product(2),
    s = await stock(p.id),
    head = await opening([
      {
        warehouse_id: warehouse,
        product_id: p.id,
        location: 'A-01',
        quantity: 2,
        stock_version: s.version,
        lot_code: 'WAIT-OPENING',
        unit_cost_minor: '77',
      },
    ]);
  await blockedWithdrawal(
    'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
    [tenant, p.id],
    () => req('/wms-lots/opening-previews/' + head.id + '/activate', 'POST', activateBody(head)),
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
    [tenant, adminId],
    403,
  );
});
test('receipt and its genuine PZ rollback when role is withdrawn during a stock wait', async () => {
  const p = await product();
  await enable();
  const body = await receiptBody(p);
  await blockedWithdrawal(
    'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
    [tenant, p.id],
    () => req('/wms-lots/receipts', 'POST', body),
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
    [tenant, adminId],
    403,
  );
});
test(
  'public receipt rechecks revoked expired and reduced key grants after an actual stock wait',
  { timeout: 600000 },
  async () => {
    const p = await product();
    await enable();
    for (const mode of ['revoked', 'expired', 'scope']) {
      const key = await ok('/developer/keys', 'POST', {
        name: 'FIFO key ' + mode,
        scopes: ['inventory:read', 'inventory:write', 'purchasing:read', 'purchasing:write'],
      });
      const body = await receiptBody(p);
      const mutation =
        mode === 'revoked'
          ? 'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1'
          : mode === 'expired'
            ? "UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1"
            : "UPDATE api_keys SET scopes=ARRAY['inventory:read','inventory:write','purchasing:read']::text[] WHERE id=$1";
      await blockedWithdrawal(
        'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
        [tenant, p.id],
        () =>
          req('/v1/wms-lots/receipts', 'POST', body, '', app, {
            authorization: 'Bearer ' + key.token,
          }),
        mutation,
        [key.id],
        mode === 'scope' ? 403 : 401,
      );
    }
  },
);
test('competing real order reservations wait and allocate oldest layers without overselling or skipping FIFO', async () => {
  const f = await supply(),
    c = await pool.connect();
  let requests: Promise<any> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE', [
      tenant,
      f.p.id,
    ]);
    const sales = [sale(f.p, 3), sale(f.p, 3)];
    requests = Promise.all(sales);
    await waitOn(c, /\bstock\b/i, sales);
    await c.query('COMMIT');
    const results = await requests;
    assert.equal(results.filter((r: any) => r.statusCode === 201).length, 1);
    assert.equal(results.filter((r: any) => r.statusCode === 409).length, 1);
    const order = results.find((r: any) => r.statusCode === 201).json();
    const rows = await allocations(order.id),
      byLayer = new Map(rows.map((r) => [r.layer_id, r.quantity]));
    assert.equal(byLayer.get(f.layers[0].id), 2);
    assert.equal(byLayer.get(f.layers[1].id), 1);
    assert.equal((await stock(f.p.id)).reserved, 3);
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])).rows[0]
        .n,
      1,
    );
    const journal = (
      await pool.query('SELECT * FROM wms_issue_fragments WHERE tenant_id=$1', [tenant])
    ).rows;
    assert.equal(journal.length, 0);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await requests;
  }
});
test('receipt exact retry is canonical and cannot reuse a PZ or key with changed costs or another actor', async () => {
  const f = await supply();
  const before = await snapshot();
  const canonical = {
    lines: f.body.lines.map((l) => ({
      currency: l.currency,
      unit_cost_minor: l.unit_cost_minor,
      lot_code: l.lot_code,
      quantity: l.quantity,
      location: l.location,
      product_id: l.product_id,
    })),
    confirmed: true,
    note: f.body.note,
    warehouse_id: f.body.warehouse_id,
    stock_versions: f.body.stock_versions,
    policy_version: f.body.policy_version,
    client_key: f.body.client_key,
  };
  const replay = await ok('/wms-lots/receipts', 'POST', canonical);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.operation, f.r.operation);
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (
      await req('/wms-lots/receipts', 'POST', {
        ...f.body,
        lines: f.body.lines.map((l) => ({ ...l, unit_cost_minor: '999' })),
      })
    ).statusCode,
    409,
  );
  const other = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0];
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    other.id,
  ]);
  const loginCookie = await login('other@demo.local');
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, loginCookie);
  assert.equal(switched.statusCode, 200);
  const otherCookie = String(switched.headers['set-cookie']).split(';')[0];
  assert.equal((await req('/wms-lots/receipts', 'POST', f.body, otherCookie)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
});
test('a last stale product version rejects the whole receipt including earlier PZ layers and audit', async () => {
  const p = await product(),
    q = await product();
  await enable();
  const body = await receiptBody(p, [1], ['101']);
  body.stock_versions = await versions([p.id, q.id]);
  body.lines.push({
    ...body.lines[0],
    product_id: q.id,
    lot_code: 'LAST-STALE',
    unit_cost_minor: '203',
  });
  await pool.query('UPDATE stock SET on_hand=on_hand WHERE tenant_id=$1 AND product_id=$2', [
    tenant,
    q.id,
  ]);
  const before = await snapshot();
  assert.equal((await req('/wms-lots/receipts', 'POST', body)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
});
test('enabled WMS denies untyped legacy stock writers and raw balanced-bin bypass atomically', async () => {
  const p = await product();
  const legacy = await ok('/warehouse-documents', 'POST', {
    kind: 'receipt',
    warehouse_id: warehouse,
    lines: [{ product_id: p.id, quantity: 1, location: 'A-01' }],
  });
  await enable();
  await ok('/wms-lots/receipts', 'POST', await receiptBody(p));
  const f = { p };
  const attempts = [
    () =>
      req('/products', 'POST', {
        sku: 'FORBIDDEN-' + randomUUID(),
        name: 'Untyped opening',
        price: 1,
        warehouse_id: warehouse,
        quantity: 1,
      }),
    async () =>
      req('/stock-location-counts', 'POST', {
        warehouse_id: warehouse,
        product_id: f.p.id,
        location: 'A-01',
        quantity: 6,
        expected_version: (await stock(f.p.id)).version,
        client_key: randomUUID(),
        note: 'No lot allocation',
      }),
    () => req('/warehouse-documents/' + legacy.id + '/post', 'POST', { version: legacy.version }),
  ];
  for (const attempt of attempts) {
    const before = await snapshot();
    assert.equal((await attempt()).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  }
  const before = await snapshot();
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      await c.query('UPDATE stock_locations SET quantity=quantity+1 WHERE product_id=$1', [f.p.id]);
      await c.query('UPDATE stock SET on_hand=on_hand+1 WHERE product_id=$1', [f.p.id]);
    }),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(), before);
});
test('all WMS tables enforce tenant RLS and immutable origins reject update delete or foreign product links', async () => {
  const f = await supply();
  for (const name of wmsTables) {
    const flags = (
      await pool.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [name],
      )
    ).rows[0];
    assert(flags.relrowsecurity && flags.relforcerowsecurity, name);
    await tenantTx(SECOND_TENANT, async (c) =>
      assert.equal(
        (await c.query(`SELECT * FROM ${name} WHERE tenant_id=$1`, [tenant])).rowCount,
        0,
      ),
    );
  }
  const before = await snapshot();
  for (const name of [
    'wms_operations',
    'wms_previews',
    'wms_lots',
    'wms_cost_layers',
    'wms_layer_movements',
  ]) {
    await assert.rejects(
      pool.query(`UPDATE ${name} SET created_at=clock_timestamp() WHERE tenant_id=$1`, [tenant]),
      (e: any) => e.code === '23514',
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${name} WHERE tenant_id=$1`, [tenant]),
      (e: any) => e.code === '23514',
    );
  }
  const foreign = (
    await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
  ).rows[0].id;
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query(
        `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity,reserved)
    VALUES($1,$2,$3,'A-01',$4,0,0)`,
        [tenant, warehouse, foreign, f.layers[0].id],
      ),
    ),
    (e: any) => e.code === '23503' || e.code === '23514',
  );
  await assert.rejects(
    tenantTx(SECOND_TENANT, (c) =>
      c.query(
        `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity,reserved)
    VALUES($1,$2,$3,'FOREIGN',$4,0,0)`,
        [tenant, warehouse, f.p.id, f.layers[0].id],
      ),
    ),
    (e: any) => e.code === '42501',
  );
  assert.deepEqual(await snapshot(), before);
});

test('actual legacy order reservation rechecks the operator after a stock wait and leaves no order or layer allocation', async () => {
  const f = await supply();
  await blockedWithdrawal(
    'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
    [tenant, f.p.id],
    () => sale(f.p, 3, operator),
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
    [tenant, operatorId],
    403,
  );
});

test('a genuine posted PZ cannot be used to append more cost layers than its physical source quantity', async () => {
  const f = await supply(),
    before = await snapshot();
  // The source is the real HTTP receipt (2+3 units), not an invented disconnected ledger.
  // A sixth unit with the same lot/source/cost would otherwise satisfy every existence FK.
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query(
        `INSERT INTO wms_cost_layers(id,tenant_id,
    lot_id,product_id,operation_id,quantity_received,unit_cost_minor,currency,exponent,
    purchase_receipt_id,warehouse_document_id)
    SELECT $2,tenant_id,lot_id,product_id,operation_id,1,unit_cost_minor,currency,exponent,
      purchase_receipt_id,warehouse_document_id FROM wms_cost_layers WHERE id=$1`,
        [f.layers[0].id, randomUUID()],
      ),
    ),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(), before);
});

test('existing typed PO receive cannot commit quantity or purchase counters after admin withdrawal at its stock wait', async () => {
  const p = await product(),
    supplier = await ok('/suppliers', 'POST', {
      name: 'Late grant supplier',
      code: 'WAIT-' + randomUUID(),
    });
  const draft = await ok('/purchase-orders', 'POST', {
    supplier_id: supplier.id,
    warehouse_id: warehouse,
    currency: 'PLN',
    lines: [{ product_id: p.id, quantity: 2, unit_cost: 101 }],
  });
  const placed = await ok('/purchase-orders/' + draft.id + '/place', 'POST', {
    version: draft.version,
  });
  await enable();
  const body = {
    version: placed.version,
    client_key: randomUUID(),
    lines: [{ product_id: p.id, quantity: 2, location: 'A-01' }],
    wms_lots: {
      policy_version: '1',
      stock_versions: await versions([p.id]),
      lines: [{ product_id: p.id, quantity: 2, location: 'A-01', lot_code: 'WAIT-PO' }],
    },
  };
  await blockedWithdrawal(
    'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
    [tenant, p.id],
    () => req('/purchase-orders/' + draft.id + '/receive', 'POST', body),
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
    [tenant, adminId],
    403,
  );
});

test('preview admission rejects quota and oversize input while exact existing replay remains readable', async () => {
  const body = {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Own bounded opening quota fixture',
    lines: [],
  };
  // The 2000-preview lifetime cap is the business/starter one; enterprise is sized like its operations.
  await pool.query("UPDATE tenants SET plan='business' WHERE id=$1", [tenant]);
  const first = await ok('/wms-lots/opening-previews', 'POST', body);
  // These immutable synthetic previews fill only this disposable tenant's real quota.
  // The HTTP-created preview remains the exact replay target, rather than inventing a receipt.
  await pool.query(
    `INSERT INTO wms_previews(id,tenant_id,actor_id,client_key,request_hash,kind,
    policy_version,scope_hash,request,snapshot,ready,issues,created_at,expires_at)
    SELECT gen_random_uuid(),tenant_id,actor_id,gen_random_uuid(),request_hash,kind,policy_version,
      scope_hash,request,snapshot,ready,issues,created_at,expires_at FROM wms_previews
    CROSS JOIN generate_series(1,1999) WHERE id=$1`,
    [first.preview.id],
  );
  const before = await snapshot();
  assert.equal(
    (await req('/wms-lots/opening-previews', 'POST', { ...body, client_key: randomUUID() }))
      .statusCode,
    429,
  );
  const replay = await ok('/wms-lots/opening-previews', 'POST', body);
  assert.equal(replay.reused, true);
  assert.equal(replay.preview.id, first.preview.id);
  const tooLarge = await app.inject({
    url: '/api/wms-lots/opening-previews',
    method: 'POST',
    headers: { cookie: admin, 'content-type': 'application/json' },
    remoteAddress: '127.0.111.' + ip,
    payload: JSON.stringify({ ...body, note: 'ą'.repeat(1024 * 1024 + 10) }),
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.deepEqual(await snapshot(), before);
  // The same 2000 previews do not stop the enterprise plan.
  await pool.query("UPDATE tenants SET plan='enterprise' WHERE id=$1", [tenant]);
  assert.equal((await ok('/wms-lots/opening-previews', 'POST', { ...body, client_key: randomUUID() })).reused, false);
});

test('valuation GET waiting on activation rechecks a read-only financial key after revocation', async () => {
  const f = await supply();
  const key = await ok('/developer/keys', 'POST', {
    name: 'Read-only valuation grant',
    scopes: ['inventory:read', 'purchasing:read'],
  });
  const c = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  const before = await snapshot();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['wms.policy:' + tenant]);
    pending = req('/v1/wms-lots/valuation?product_id=' + f.p.id, 'GET', undefined, '', app, {
      authorization: 'Bearer ' + key.token,
    });
    await waitOn(c, /pg_advisory_xact_lock_shared/i, [pending], 'wms.policy:' + tenant);
    await commitGrant('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1', [key.id]);
    await c.query('COMMIT');
    assert.equal((await pending).statusCode, 401);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending;
  }
  assert.deepEqual(await snapshot(), before);
});

test('order allocations and return fragments recheck orders read scope after real order waits', async () => {
  const f = await supply(),
    response = await sale(f.p, 1);
  assert.equal(response.statusCode, 201);
  const order = response.json();
  const paths = ['allocations', 'return-fragments'];
  for (const path of paths) {
    const key = await ok('/developer/keys', 'POST', {
      name: 'Current order read ' + path,
      scopes: ['inventory:read', 'orders:read'],
    });
    const headers = { authorization: 'Bearer ' + key.token };
    const positive = await req(
      '/v1/wms-lots/orders/' + order.id + '/' + path,
      'GET',
      undefined,
      '',
      app,
      headers,
    );
    assert.equal(positive.statusCode, 200);
    assert.equal(positive.json().can_write, false);
    assert.equal(positive.json().can_read_value, false);
    if (path === 'allocations') {
      assert.equal(positive.json().order.id, order.id);
      assert.equal(positive.json().data.length, 1);
    }
    const before = await snapshot(),
      c = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        tenant,
        order.id,
      ]);
      pending = req(
        '/v1/wms-lots/orders/' + order.id + '/' + path,
        'GET',
        undefined,
        '',
        app,
        headers,
      );
      await waitOn(c, /FROM orders.*FOR SHARE/i, [pending]);
      await commitGrant("UPDATE api_keys SET scopes=ARRAY['inventory:read']::text[] WHERE id=$1", [
        key.id,
      ]);
      await c.query('COMMIT');
      const denied = await pending;
      assert.equal(denied.statusCode, 403);
      assert(!denied.body.includes(order.id), 'Denied response cannot project private order scope');
      assert(
        !denied.body.includes(order.number),
        'Denied response cannot project the order number',
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await pending;
    }
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal(providerCalls, 0);
});

test('an extra issue fragment with genuine own source and layer FKs is rejected at COMMIT', async () => {
  const f = await supply();
  const { preview } = await ok('/wms-lots/movement-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    kind: 'issue',
    product_id: f.p.id,
    warehouse_id: warehouse,
    location: 'A-01',
    quantity: 1,
    stock_versions: await versions([f.p.id]),
    note: 'Actual one-unit issue for immutable proof',
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
  });
  const issue = (await pool.query('SELECT * FROM wms_issue_fragments WHERE tenant_id=$1', [tenant]))
    .rows;
  assert.equal(issue.length, 1);
  assert.equal(issue[0].quantity, 1);
  assert(issue[0].warehouse_document_id);
  const before = await snapshot();
  // The clone has valid tenant/source/bin/layer FKs and unchanged exact cost. Only
  // a deferred aggregate invariant can distinguish it from a real second issue.
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      const added = await c.query(
        `INSERT INTO wms_issue_fragments(id,tenant_id,operation_id,order_id,
      warehouse_document_id,warehouse_id,product_id,location,layer_id,quantity,unit_cost_minor,value_minor,currency)
      SELECT $1,tenant_id,operation_id,order_id,warehouse_document_id,warehouse_id,product_id,location,
        layer_id,quantity,unit_cost_minor,value_minor,currency FROM wms_issue_fragments WHERE id=$2
      RETURNING id`,
        [randomUUID(), issue[0].id],
      );
      assert.equal(added.rowCount, 1, 'The valid-FK clone must reach the transaction commit gate');
    }),
    (error: any) => error.code === '23514',
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('operator transfer preview and its exact replay keep the same redacted cost projection', async () => {
  const f = await supply();
  const body = {
    client_key: randomUUID(),
    policy_version: '1',
    kind: 'transfer',
    product_id: f.p.id,
    warehouse_id: warehouse,
    location: 'A-01',
    quantity: 1,
    destination_warehouse_id: destination,
    destination_location: 'OPERATOR-MM',
    stock_versions: [...(await versions([f.p.id])), ...(await versions([f.p.id], destination))],
    note: 'Operator quantity transfer without financial projection',
  };
  const first = await ok('/wms-lots/movement-previews', 'POST', body, operator);
  assert.equal(first.preview.known_minor, null);
  const before = await snapshot();
  const replay = await ok('/wms-lots/movement-previews', 'POST', body, operator);
  assert.equal(replay.reused, true);
  assert.equal(replay.preview.known_minor, null);
  assert.deepEqual(replay.preview, first.preview);
  const detail = await ok(
    '/wms-lots/movement-previews/' + first.preview.id,
    'GET',
    undefined,
    operator,
  );
  assert.equal(detail.preview.known_minor, null);
  assert.equal(detail.snapshot_summary.valuation.known_minor, null);
  assert.deepEqual(await snapshot(), before);
});

test('viewer and limited public keys cannot write or read private valuation and read-only rejects before malformed JSON', async () => {
  const f = await supply();
  const readKey = await ok('/developer/keys', 'POST', {
    name: 'Inventory without purchasing access',
    scopes: ['inventory:read'],
  });
  const before = await snapshot();
  assert.equal(
    (await req('/wms-lots/receipts', 'POST', await receiptBody(f.p), viewer)).statusCode,
    403,
  );
  const operatorPositions = await ok(
    '/wms-lots/positions?product_id=' + f.p.id,
    'GET',
    undefined,
    operator,
  );
  assert(operatorPositions.data.length);
  for (const p of operatorPositions.data) {
    assert.equal(p.unit_cost_minor, null);
    assert(!JSON.stringify(p).includes('"unit_cost_minor":"101"'));
  }
  assert.equal(
    (
      await req('/v1/wms-lots/valuation', 'GET', undefined, '', app, {
        authorization: 'Bearer ' + readKey.token,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req('/v1/wms-lots/receipts', 'POST', await receiptBody(f.p), '', app, {
        authorization: 'Bearer ' + readKey.token,
      })
    ).statusCode,
    403,
  );
  const readonly = await buildApp({
    readOnly: true,
    previewPort: 4111,
    integrationTransport: transport,
  });
  try {
    const auth = await login('admin@demo.local', readonly);
    const meta = await ok('/wms-lots', 'GET', undefined, auth, readonly);
    assert.equal(meta.read_only, true);
    assert.equal(meta.can_write, false);
    assert.equal(meta.can_admin, false);
    const r = await readonly.inject({
      url: '/api/wms-lots/receipts',
      method: 'POST',
      headers: { cookie: auth, 'content-type': 'application/json' },
      payload: '{bad json',
    });
    assert.equal(r.statusCode, 423);
    assert.match(String(r.headers['cache-control']), /no-store/);
  } finally {
    await readonly.close();
  }
  assert.deepEqual(await snapshot(), before);
});

test('legacy PO receipt replay still requires current admin after a real purchase order wait in enabled WMS', async () => {
  const p = await product();
  const supplier = await ok('/suppliers', 'POST', {
    name: 'Legacy PO replay supplier',
    code: 'REPLAY-' + randomUUID(),
  });
  const draft = await ok('/purchase-orders', 'POST', {
    supplier_id: supplier.id,
    warehouse_id: warehouse,
    currency: 'PLN',
    lines: [{ product_id: p.id, quantity: 2, unit_cost: 731 }],
  });
  const placed = await ok('/purchase-orders/' + draft.id + '/place', 'POST', {
    version: draft.version,
  });
  const body = {
    client_key: randomUUID(),
    version: placed.version,
    lines: [{ product_id: p.id, quantity: 2, location: 'A-01' }],
  };
  await ok('/purchase-orders/' + draft.id + '/receive', 'POST', body);
  await enable([
    {
      warehouse_id: warehouse,
      product_id: p.id,
      location: 'A-01',
      quantity: 2,
      stock_version: (await stock(p.id)).version,
      lot_code: 'HISTORICAL-PO',
      unit_cost_minor: null,
    },
  ]);
  const before = await snapshot(),
    c = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM purchase_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      tenant,
      draft.id,
    ]);
    pending = req('/purchase-orders/' + draft.id + '/receive', 'POST', body);
    await waitOn(c, /FROM purchase_orders.*FOR UPDATE/i, [pending]);
    await commitGrant("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      adminId,
    ]);
    await c.query('COMMIT');
    const denied = await pending;
    assert.equal(denied.statusCode, 403);
    assert(!denied.body.includes('unit_cost'), 'Denied replay cannot expose purchase costs');
    assert(!denied.body.includes(draft.id), 'Denied replay cannot expose the purchase detail');
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending;
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('torn WMS policy blocks startup and new writes while an existing app still reads the legacy catalog', async () => {
  const p = await product();
  const body = await receiptBody(p, [1], ['101']);
  const before = await snapshot();
  await pool.query('ALTER TABLE wms_policies RENAME TO wms_policies_safety_missing');
  try {
    // Renaming one dependency does not simulate a wholly absent old module:
    // installed139/148 must fail closed when their WMS policy is torn.
    await assert.rejects(
      () => buildApp({ integrationTransport: transport }),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 503,
    );
    assert.equal((await req('/wms-lots', 'GET')).statusCode, 503);
    assert.equal((await req('/wms-lots/receipts', 'POST', body)).statusCode, 503);
    // The already running139 route rechecks its dependencies before JSON parsing.
    const malformed = await app.inject({
      url: '/api/return-assistant/sessions',
      method: 'POST',
      headers: { cookie: admin, 'content-type': 'application/json' },
      payload: '{bad json',
    });
    assert.equal(malformed.statusCode, 503);
    const products = await req('/products', 'GET');
    assert.equal(products.statusCode, 200);
    assert(products.body.includes(p.id), 'The existing app retains its genuine legacy product read');
  } finally {
    await pool.query('ALTER TABLE wms_policies_safety_missing RENAME TO wms_policies');
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});
