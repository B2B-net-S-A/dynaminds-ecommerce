import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { CATALOG_EXPORT_TEMP_DIR } from '../server/catalog-export';
import { openSalesReportFile } from '../server/sales-reports';
import { apiKeyLineage } from './api-key-last-use';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let tenant = '',
  warehouse = '',
  user = '',
  cookie = '',
  viewer = '',
  ip = 1,
  providerCalls = 0;
const credentials = new Map<string, string>();
const cost = 1379;
const base = '/reports/sales';
const transport = async () => {
  ++providerCalls;
  throw Error('Sales report safety must never contact a provider');
};
const req = (
  path: string,
  method: any = 'GET',
  body?: any,
  auth = cookie,
  target = app,
  headers: Record<string, string> = {},
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie: auth, ...headers },
    remoteAddress: '127.0.185.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, auth = cookie, target = app) {
  const r = await req(path, method, body, auth, target);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode}`);
  return r.json() as Row;
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
    logging: process.env.SALES_REPORT_TEST_LOG === 'true',
  });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  for (const email of ['admin@demo.local', 'viewer@demo.local'])
    credentials.set(email, await login(email));
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Sales safety own firm','enterprise')",
    [tenant],
  );
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role)
    SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' ELSE 'viewer' END
    FROM users WHERE email=ANY($2::text[])`,
    [tenant, [...credentials.keys()]],
  );
  for (const [email, auth] of credentials) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, auth);
    assert.equal(r.statusCode, 200);
    credentials.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  cookie = credentials.get('admin@demo.local')!;
  viewer = credentials.get('viewer@demo.local')!;
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Sales source warehouse','SA')",
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
const dates = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  return { from: today, to: today };
};
const query = (extra: Row = {}) => new URLSearchParams({ ...dates(), ...extra }).toString();
const path = (suffix: string, extra: Row = {}) =>
  base + suffix + (suffix === '/options' ? '' : '?' + query(extra));
const actor = () => ({ tenantId: tenant, userId: user, role: 'admin' as const });
async function key(scopes = ['orders:read', 'inventory:read', 'purchasing:read']) {
  return ok('/developer/keys', 'POST', { name: 'Sales safety ' + randomUUID(), scopes });
}
async function sale(name = 'Own sales') {
  const product = await ok('/products', 'POST', {
    sku: 'SALES-' + randomUUID(),
    name,
    price: 12300,
    vat: 23,
    quantity: 7,
    warehouse_id: warehouse,
    location: 'A-01',
  });
  const version = (
    await pool.query(
      'SELECT version::text FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, product.id],
    )
  ).rows[0].version;
  const preview = (
    await ok('/wms-lots/opening-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Known genuine opening',
      lines: [
        {
          warehouse_id: warehouse,
          product_id: product.id,
          location: 'A-01',
          quantity: 7,
          stock_version: version,
          lot_code: 'SALES-LOT',
          unit_cost_minor: String(cost),
        },
      ],
    })
  ).preview;
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: false,
  });
  const order = await ok('/orders', 'POST', {
    customer_name: name,
    email: 'sales-safety@example.test',
    payment_mode: 'cod',
    warehouse_id: warehouse,
    items: [{ product_id: product.id, quantity: 2 }],
  });
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  const allocation = (
    await pool.query('SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2', [
      tenant,
      order.id,
    ])
  ).rows[0];
  assert(allocation);
  for (let n = 0; n < 2; ++n)
    await ok('/orders/' + order.id + '/scan', 'POST', {
      client_key: randomUUID(),
      code: product.sku,
      location: allocation.location,
      layer_id: allocation.layer_id,
    });
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  await ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  assert.equal(
    (
      await pool.query(
        'SELECT sum(quantity)::int quantity FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2',
        [tenant, order.id],
      )
    ).rows[0].quantity,
    2,
  );
  return { product, order };
}
async function acceptedReturn(f: Awaited<ReturnType<typeof sale>>) {
  const item = (
    await pool.query('SELECT id FROM order_items WHERE tenant_id=$1 AND order_id=$2', [
      tenant,
      f.order.id,
    ])
  ).rows[0];
  const issued = (
    await pool.query('SELECT id FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2', [
      tenant,
      f.order.id,
    ])
  ).rows[0];
  const requested = await ok('/orders/' + f.order.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'One real accepted safety return',
    items: [{ item_id: item.id, quantity: 1 }],
  });
  const version = (
    await pool.query(
      'SELECT version::text FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, f.product.id],
    )
  ).rows[0].version;
  await ok('/returns/' + requested.id + '/receive', 'POST', {
    version: Number(requested.version),
    shipping_refund: 0,
    note: 'Actual physical restock',
    items: [{ item_id: item.id, accepted: 1, restocked: 1 }],
    wms_lots: {
      client_key: randomUUID(),
      policy_version: '1',
      stock_versions: [{ warehouse_id: warehouse, product_id: f.product.id, version }],
      picks: [{ issue_fragment_id: issued.id, quantity: 1, location: 'A-01' }],
    },
  });
  return requested;
}
async function foreignSale() {
  const other = randomUUID(),
    wh = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Foreign sales fixture','enterprise')",
    [other],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    other,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Foreign protected warehouse','FOREIGN')",
    [wh, other],
  );
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: other });
  assert.equal(switched.statusCode, 200);
  let auth = String(switched.headers['set-cookie']).split(';')[0];
  try {
    const product = await ok(
      '/products',
      'POST',
      {
        sku: 'FOREIGN-' + randomUUID(),
        name: 'FOREIGN-SALES-PRIVATE-SENTINEL',
        warehouse_id: wh,
        quantity: 3,
        price: 999999,
      },
      auth,
    );
    const order = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'FOREIGN-SALES-PRIVATE-SENTINEL',
        email: 'foreign-sales@example.test',
        payment_mode: 'cod',
        warehouse_id: wh,
        items: [{ product_id: product.id, quantity: 1 }],
      },
      auth,
    );
    return { order, warehouse: { id: wh } };
  } finally {
    const restored = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, auth);
    assert.equal(restored.statusCode, 200);
    cookie = String(restored.headers['set-cookie']).split(';')[0];
    credentials.set('admin@demo.local', cookie);
  }
}
async function snapshot() {
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions','sessions') ORDER BY 1`)
  ).rows;
  const result: Record<string, string> = {};
  for (const { table_name: name } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    const rows = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
    const facts = name === 'auth237_api_key_state' ? apiKeyLineage(rows) : rows;
    result[name] = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  }
  return result;
}
function noStore(r: any) {
  assert.match(String(r.headers['cache-control']), /no-store/);
}
function noValue(value: unknown) {
  if (Array.isArray(value)) return value.forEach(noValue);
  if (!value || typeof value !== 'object') return;
  for (const [name, v] of Object.entries(value)) {
    assert(
      !name.endsWith('_minor') &&
        ![
          'cost_complete',
          'cost_reasons',
          'unknown_cost_quantity',
          'missing_issue_quantity',
          'unknown_quantity',
          'issued_unknown_quantity',
          'restocked_unknown_quantity',
          'net_unknown_quantity',
          'complete_order_count',
          'incomplete_order_count',
          'margin_percent',
        ].includes(name),
      'Restricted money or cost metadata must not escape: ' + name,
    );
    noValue(v);
  }
}
async function waitOnRead(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const waiting = (
      await pool.query(
        `SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`,
        [pid],
      )
    ).rows;
    if (waiting.some((r) => /SELECT/i.test(r.query) && /\borders\b/i.test(r.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The real sales report query never waited on the held orders table');
}
async function changeGrant(sql: string, args: unknown[]) {
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
async function heldRead(start: () => PromiseLike<any>, grant: () => Promise<void>) {
  const c = await pool.connect();
  let pending: Promise<any> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
    pending = Promise.resolve(start());
    void pending.catch(() => {});
    await waitOnRead(c);
    await grant();
    await c.query('COMMIT');
    return await pending;
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending?.catch(() => {});
  }
}

test('viewer and quantity-only public key cannot recover cost or margin from any report or CSV, without changing business data', async () => {
  const f = await sale();
  await acceptedReturn(f);
  const read = await key(['orders:read', 'inventory:read']);
  const visible = await ok(path('/orders/' + f.order.id));
  assert.equal(visible.can_read_value, true);
  assert.equal(visible.physical_costs.length, 1, 'A nonempty physical cost proof is required');
  assert.equal(visible.physical_costs[0].issued_known_minor, String(2 * cost));
  assert.equal(visible.physical_costs[0].restocked_known_minor, String(cost));
  const before = await snapshot();
  const auths: Array<{ cookie: string; prefix: string; headers: Record<string, string> }> = [
    { cookie: viewer, prefix: '', headers: {} },
    { cookie: '', prefix: '/v1', headers: { authorization: 'Bearer ' + read.token } },
  ];
  for (const auth of auths) {
    for (const suffix of ['/options', '/summary', '/orders', '/orders/' + f.order.id, '/returns']) {
      const r = await req(
        auth.prefix + path(suffix),
        'GET',
        undefined,
        auth.cookie,
        app,
        auth.headers,
      );
      assert.equal(r.statusCode, 200, suffix);
      noStore(r);
      noValue(r.json());
      assert.equal(r.json().can_read_value, false, suffix);
      assert(
        !r.body.includes('"1379"') && !r.body.includes('"2758"'),
        'Physical cost must not leak through nested detail',
      );
    }
    for (const kind of ['orders', 'returns']) {
      const r = await req(
        auth.prefix + path('/file', { kind }),
        'GET',
        undefined,
        auth.cookie,
        app,
        auth.headers,
      );
      assert.equal(r.statusCode, 200);
      noStore(r);
      assert(
        !/(?:_minor|cost_complete|cost_reasons|unknown_quantity|unknown_cost_quantity|margin_percent)/i.test(
          r.body,
        ),
        'CSV must remove restricted financial columns, not only their UI',
      );
    }
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('foreign order and warehouse identities never project other-firm details, costs or customer fields', async () => {
  const f = await sale();
  const foreign = await foreignSale();
  const foreignOrder = foreign.order,
    foreignWarehouse = foreign.warehouse;
  assert(foreignOrder && foreignWarehouse);
  const before = await snapshot();
  for (const id of [foreignOrder.id, randomUUID()]) {
    const r = await req(path('/orders/' + id));
    assert.equal(r.statusCode, 404);
    noStore(r);
    assert(!r.body.includes(f.order.id));
    assert(!r.body.includes('FOREIGN-SALES-PRIVATE-SENTINEL'));
  }
  for (const suffix of ['/summary', '/orders', '/returns', '/file']) {
    const r = await req(
      path(suffix, {
        warehouse_id: foreignWarehouse.id,
        ...(suffix === '/file' ? { kind: 'orders' } : {}),
      }),
    );
    assert.equal(r.statusCode, 404);
    noStore(r);
    assert(!r.body.includes(f.order.id));
    assert(!r.body.includes('FOREIGN-SALES-PRIVATE-SENTINEL'));
  }
  assert.deepEqual(await snapshot(), before);
});

test(
  'member withdrawal commits while an actual snapshot read is blocked and no report or file escapes',
  { timeout: 15000 },
  async () => {
    await sale();
    const before = await snapshot();
    try {
      const r = await heldRead(
        () => req(path('/file', { kind: 'orders' })),
        () =>
          changeGrant('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2', [tenant, user]),
      );
      assert.equal(r.statusCode, 403);
      noStore(r);
      assert(!r.headers['content-disposition']);
    } finally {
      await pool.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='admin'",
        [tenant, user],
      );
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  },
);

test(
  'admin downgrade after a real read wait cannot retain the old snapshot cost projection',
  { timeout: 15000 },
  async () => {
    const f = await sale();
    const before = await snapshot();
    try {
      const r = await heldRead(
        () => req(path('/orders/' + f.order.id)),
        () =>
          changeGrant("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
            tenant,
            user,
          ]),
      );
      assert.equal(r.statusCode, 200);
      noStore(r);
      assert.equal(r.json().can_read_value, false);
      noValue(r.json());
      assert(!r.body.includes('"1379"') && !r.body.includes('"2758"'));
      assert.deepEqual(await snapshot(), before);
    } finally {
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        user,
      ]);
    }
  },
);

test(
  'late public key revoke, expiry and inventory-read or purchasing-read loss reject the prepared file before bytes',
  { timeout: 25000 },
  async () => {
    await sale();
    for (const mode of ['revoke', 'expiry', 'inventory', 'cost']) {
      const k = await key();
      const before = await snapshot();
      const r = await heldRead(
        () =>
          req('/v1' + path('/file', { kind: 'orders' }), 'GET', undefined, '', app, {
            authorization: 'Bearer ' + k.token,
          }),
        async () => {
          if (mode === 'revoke')
            await changeGrant('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [k.id]);
          else if (mode === 'expiry')
            await changeGrant(
              "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1",
              [k.id],
            );
          else
            await changeGrant('UPDATE api_keys SET scopes=$2 WHERE id=$1', [
              k.id,
              mode === 'inventory'
                ? ['orders:read', 'purchasing:read']
                : ['orders:read', 'inventory:read'],
            ]);
        },
      );
      noStore(r);
      assert.equal(r.statusCode, ['inventory', 'cost'].includes(mode) ? 403 : 401);
      assert(!r.headers['content-disposition']);
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal(providerCalls, 0);
  },
);

test('strict dates, filters and signed cursor identity reject malformed or reused requests without read effects', async () => {
  const f = await sale();
  await ok('/orders', 'POST', {
    customer_name: 'Second date row',
    email: 'sales-second@example.test',
    payment_mode: 'cod',
    warehouse_id: warehouse,
    items: [{ product_id: f.product.id, quantity: 1 }],
  });
  await pool.query('UPDATE orders SET number=$3 WHERE tenant_id=$1 AND id=$2', [
    tenant,
    f.order.id,
    '=2+3',
  ]);
  const before = await snapshot();
  for (const extra of [
    { from: '2020-02-30' },
    { from: '2020-02-01', to: '2020-01-01' },
    { from: '2019-01-01', to: '2021-01-01' },
    { currency: 'ZZZ' },
    { warehouse_id: 'not-uuid' },
    { limit: '101' },
    { cursor: 'forged' },
    { customer_email: 'private@example.test' },
  ]) {
    const r = await req(path('/orders', extra));
    assert.equal(r.statusCode, 422);
    noStore(r);
  }
  const first = await ok(path('/orders', { limit: '1' }));
  assert(first.meta?.cursor, 'A genuine second row must supply an opaque signed cursor');
  for (const changed of [{ currency: 'EUR' }, { warehouse_id: warehouse }]) {
    const r = await req(path('/orders', { limit: '1', cursor: first.meta.cursor, ...changed }));
    assert.equal(r.statusCode, 409);
    noStore(r);
  }
  const wrongKind = await req(path('/returns', { limit: '1', cursor: first.meta.cursor }));
  assert.equal(wrongKind.statusCode, 409);
  const safe = await req(path('/file', { kind: 'orders' }));
  assert.equal(safe.statusCode, 200);
  assert(safe.body.includes('"\'=2+3"'), 'Default CSV must prefix a formula-bearing order number');
  const raw = await req(path('/file', { kind: 'orders', spreadsheet_safe: 'false' }));
  assert.equal(raw.statusCode, 200);
  assert(
    raw.body.includes('"=2+3"') && !raw.body.includes('"\'=2+3"'),
    'Explicit raw mode preserves source bytes',
  );
  assert.deepEqual(await snapshot(), before);
});

test('read-only copy uses its own session for GET reports and CSV while malformed writes remain blocked before parsing', async () => {
  const f = await sale();
  let ro: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    ro = await buildApp({ readOnly: true, integrationTransport: transport });
    const ownLogin = await login('admin@demo.local', ro);
    const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, ownLogin, ro);
    assert.equal(switched.statusCode, 200);
    const auth = String(switched.headers['set-cookie']).split(';')[0];
    const before = await snapshot();
    for (const suffix of [
      '/options',
      '/summary',
      '/orders',
      '/orders/' + f.order.id,
      '/returns',
      '/file',
    ]) {
      const r = await req(
        path(suffix, suffix === '/file' ? { kind: 'orders' } : {}),
        'GET',
        undefined,
        auth,
        ro,
      );
      assert.equal(r.statusCode, 200);
      noStore(r);
    }
    const denied = await req('/orders/' + f.order.id + '/payments', 'POST', '{', auth, ro, {
      'content-type': 'application/json',
    });
    assert.equal(denied.statusCode, 423);
    noStore(denied);
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  } finally {
    await ro?.close();
  }
});

test(
  'aborting a report during a genuine database read releases its spool admission without changing any business state',
  { timeout: 15000 },
  async () => {
    await sale();
    const before = await snapshot();
    const controller = new AbortController();
    const c = await pool.connect();
    let pending: ReturnType<typeof openSalesReportFile> | undefined;
    let abandoned: Awaited<ReturnType<typeof openSalesReportFile>> | undefined;
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
      pending = openSalesReportFile(
        actor(),
        { ...dates(), kind: 'orders', spreadsheet_safe: 'true' },
        controller.signal,
      );
      void pending.catch(() => {});
      await waitOnRead(c);
      controller.abort();
      await c.query('COMMIT');
      try {
        abandoned = await pending;
      } catch (error: any) {
        assert.equal(error.status, 499, 'Only explicit signal cancellation may fail this export');
      }
      assert(!abandoned, 'An aborted report must never yield a usable file');
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await abandoned?.dispose();
      await pending?.catch(() => {});
    }
    const file = await openSalesReportFile(actor(), {
      ...dates(),
      kind: 'orders',
      spreadsheet_safe: 'true',
    });
    const streamPath = file.path;
    try {
      for await (const _part of file.stream) {
        /* Drain a real subsequent report. */
      }
    } finally {
      await file.dispose();
    }
    assert(typeof streamPath === 'string');
    assert(!(await readdir(CATALOG_EXPORT_TEMP_DIR)).includes(streamPath.split('/').at(-1)!));
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  },
);
