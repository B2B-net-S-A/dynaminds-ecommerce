import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { dispatchAutomation, processAutomation } from '../server/automations';
import { processBatch } from '../server/order-operations';
import { processSchedule } from '../server/automation-schedules';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  adminId = '',
  operatorId = '',
  admin = '',
  operator = '',
  viewer = '',
  ip = 1,
  providerCalls = 0;
const cookies = new Map<string, string>();
const measured = { weight_grams: 1370, length_mm: 380, width_mm: 200, height_mm: 100 };
const packingTables = [
  'packing_stations',
  'packing_cartons',
  'packing_policies',
  'packing_sessions',
  'packing_operations',
  'packing_previews',
  'packing_receipts',
  'order_packing_profiles',
];
const businessTables = [
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'payment_entries',
  'order_local_financial_fences',
  'products',
  'product_logistics',
  'bundle_components',
  'listings',
  'offer_plans',
  'shipments',
  'shipping_plans',
  'jobs',
  'order_events',
  'audit_events',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
const transport = async () => {
  providerCalls++;
  throw Error('Packing safety must not call providers');
};
const req = (
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  lease?: string,
  target = app,
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...(lease ? { 'x-packing-lease': lease } : {}) },
    remoteAddress: '127.0.110.' + ip,
  });
async function ok(
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  lease?: string,
  target = app,
) {
  const r = await req(path, method, payload, cookie, lease, target);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: HTTP ${r.statusCode}`);
  return r.json() as any;
}
async function login(email: string, target = app) {
  const r = await req(
    '/auth/login',
    'POST',
    { email, password: 'DynaDemo!2026' },
    '',
    undefined,
    target,
  );
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.PACKING_TEST_LOG === 'true',
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
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Packing safety','enterprise')", [
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
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Packing','PACK')",
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

async function snapshot(tables = [...businessTables, ...packingTables]) {
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function configs() {
  const suffix = randomUUID().slice(0, 8);
  const station = (
    await ok('/packing/stations', 'POST', {
      client_key: randomUUID(),
      code: 'P1-' + suffix,
      label: 'Station one',
      enabled: true,
    })
  ).station;
  const station2 = (
    await ok('/packing/stations', 'POST', {
      client_key: randomUUID(),
      code: 'P2-' + suffix,
      label: 'Station two',
      enabled: true,
    })
  ).station;
  const carton = (
    await ok('/packing/cartons', 'POST', {
      client_key: randomUUID(),
      code: 'C1-' + suffix,
      label: 'Carton one',
      enabled: true,
      inner_dimensions: { length_mm: 360, width_mm: 180, height_mm: 80 },
      outer_dimensions: { length_mm: 380, width_mm: 200, height_mm: 100 },
      tare_grams: 120,
    })
  ).carton;
  const carton2 = (
    await ok('/packing/cartons', 'POST', {
      client_key: randomUUID(),
      code: 'C2-' + suffix,
      label: 'Carton two',
      enabled: true,
      inner_dimensions: { length_mm: 460, width_mm: 280, height_mm: 180 },
      outer_dimensions: { length_mm: 480, width_mm: 300, height_mm: 200 },
      tare_grams: 200,
    })
  ).carton;
  return { station, station2, carton, carton2 };
}
async function orderFixture(quantity = 1) {
  const p = await ok('/products', 'POST', {
    sku: 'PACK-' + randomUUID(),
    name: 'Packing physical item',
    price: 2500,
    warehouse_id: warehouse,
    quantity: 20,
    weight_grams: 1000,
    length_mm: 100,
    width_mm: 50,
    height_mm: 20,
  });
  const o = await ok('/orders', 'POST', {
    customer_name: 'Packing recipient',
    email: 'packing@example.test',
    warehouse_id: warehouse,
    payment_mode: 'cod',
    items: [{ product_id: p.id, quantity }],
  });
  await ok('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
  return { p, o: await ok('/orders/' + o.id) };
}
async function fixture(quantity = 1, scanned = quantity) {
  const config = await configs(),
    base = await orderFixture(quantity),
    token = randomUUID();
  let session = (
    await ok(
      '/packing/sessions',
      'POST',
      {
        client_key: randomUUID(),
        order_id: base.o.id,
        order_version: String(base.o.version),
        station_id: config.station.id,
        station_version: String(config.station.version),
        lease_token: token,
      },
      operator,
    )
  ).session;
  for (let i = 0; i < scanned; i++) {
    await ok(
      '/packing/sessions/' + session.id + '/scans',
      'POST',
      {
        client_key: randomUUID(),
        session_version: String(session.version),
        order_version: String(base.o.version),
        code: base.p.sku,
      },
      operator,
      token,
    );
    session = (await ok('/packing/sessions/' + session.id, 'GET', undefined, operator)).session;
  }
  return { ...config, ...base, token, session };
}
type F = Awaited<ReturnType<typeof fixture>>;
const previewBody = (f: F) => ({
  client_key: randomUUID(),
  kind: 'finish',
  session_id: f.session.id,
  session_version: String(f.session.version),
  order_version: String(f.o.version),
  station_version: String(f.station.version),
  packaging: { kind: 'carton', carton_id: f.carton.id, carton_version: String(f.carton.version) },
  measurements: measured,
  include_product_estimate: false,
});
const finishBody = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
  confirm_measured: true,
});
async function preview(f: F, cookie = operator, extra = {}) {
  return (await ok('/packing/previews', 'POST', { ...previewBody(f), ...extra }, cookie, f.token))
    .preview;
}
const finishPath = (p: any) => '/packing/previews/' + p.id + '/finish';
async function finish(f: F) {
  const p = await preview(f);
  assert.equal(p.ready, true);
  return (await ok(finishPath(p), 'POST', finishBody(p), operator, f.token)).receipt;
}
async function waitOn(c: PoolClient, pattern: RegExp) {
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    end = Date.now() + 3000;
  while (Date.now() < end) {
    const rows = (
      await pool.query(
        `SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`,
        [pid],
      )
    ).rows;
    if (rows.some((r) => pattern.test(r.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Actual packing request never waited on the held database row');
}
async function grant(sql: string, args: unknown[]) {
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
async function deniedWait(
  table: 'orders' | 'packing_cartons' | 'users',
  id: string,
  request: () => ReturnType<typeof req>,
  change: () => Promise<void>,
  status: number,
) {
  const before = await snapshot(),
    c = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  try {
    await c.query('BEGIN');
    await c.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    pending = request();
    await waitOn(
      c,
      table === 'users'
        ? /INSERT INTO packing_(previews|receipts|operations)/i
        : new RegExp(table, 'i'),
    );
    await change();
    await c.query('COMMIT');
    assert.equal((await pending).statusCode, status);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending;
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
}
async function claim(id: string) {
  const job = (
    await pool.query(
      `UPDATE jobs SET state='running',attempts=attempts+1,
    locked_at=now(),lease_token=$2 WHERE id=$1 AND tenant_id=$3 AND state='pending' RETURNING *`,
      [id, randomUUID(), tenant],
    )
  ).rows[0];
  assert(job);
  return job;
}

test(
  'order wait permits operator downgrade and rolls back every tentative finish consequence',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      p = await preview(f);
    await deniedWait(
      'orders',
      f.o.id,
      () => req(finishPath(p), 'POST', finishBody(p), operator, f.token),
      () =>
        grant("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          tenant,
          operatorId,
        ]),
      403,
    );
  },
);
test(
  'carton wait and actor user FK wait do not pin grants before preview persistence',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    for (const [table, id] of [
      ['packing_cartons', f.carton.id],
      ['users', operatorId],
    ] as const) {
      await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        operatorId,
      ]);
      await deniedWait(
        table,
        id,
        () => req('/packing/previews', 'POST', previewBody(f), operator, f.token),
        () =>
          grant("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
            tenant,
            operatorId,
          ]),
        403,
      );
    }
  },
);
test(
  'receipt actor FK wait permits revoke and rolls back profile packed session jobs and evidence',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      p = await preview(f);
    await deniedWait(
      'users',
      operatorId,
      () => req(finishPath(p), 'POST', finishBody(p), operator, f.token),
      () =>
        grant("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          tenant,
          operatorId,
        ]),
      403,
    );
  },
);
test(
  'public packing preview sees revoke expiry or scope loss committed during actual order wait',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    // The API actor must own its lease, not borrow the operator cookie's session.
    await ok(
      '/packing/sessions/' + f.session.id + '/cancel',
      'POST',
      {
        client_key: randomUUID(),
        session_version: String(f.session.version),
      },
      operator,
      f.token,
    );
    const adminToken = randomUUID();
    const s = (
      await ok('/packing/sessions', 'POST', {
        client_key: randomUUID(),
        order_id: f.o.id,
        order_version: String(f.o.version),
        station_id: f.station.id,
        station_version: String(f.station.version),
        lease_token: adminToken,
      })
    ).session;
    for (const mode of ['revoke', 'expiry', 'scope']) {
      const key = await ok('/developer/keys', 'POST', {
        name: 'Packing ' + mode,
        scopes: ['orders:read', 'orders:write'],
      });
      const body = previewBody({ ...f, session: s, token: adminToken });
      await deniedWait(
        'orders',
        f.o.id,
        () =>
          app.inject({
            url: '/api/v1/packing/previews',
            method: 'POST',
            payload: body,
            headers: { authorization: 'Bearer ' + key.token, 'x-packing-lease': adminToken },
            remoteAddress: '127.0.110.' + ip,
          }),
        () =>
          grant(
            mode === 'revoke'
              ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
              : mode === 'expiry'
                ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
                : "UPDATE api_keys SET scopes=ARRAY['orders:read']::text[] WHERE id=$1",
            [key.id],
          ),
        mode === 'scope' ? 403 : 401,
      );
    }
  },
);
test('scan exact retry has frozen result no extra scan or lease renewal and no order version bump', async () => {
  const f = await fixture(2, 0),
    body = {
      client_key: randomUUID(),
      session_version: String(f.session.version),
      order_version: String(f.o.version),
      code: f.p.sku,
    };
  const first = await ok(
    '/packing/sessions/' + f.session.id + '/scans',
    'POST',
    body,
    operator,
    f.token,
  );
  const before = await snapshot();
  const replay = await ok(
    '/packing/sessions/' + f.session.id + '/scans',
    'POST',
    body,
    operator,
    f.token,
  );
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.operation, first.operation);
  assert.deepEqual(await snapshot(), before);
  assert.equal(String((await ok('/orders/' + f.o.id)).version), String(f.o.version));
  assert.equal(
    (
      await req(
        '/packing/sessions/' + f.session.id + '/scans',
        'POST',
        { ...body, code: 'different' },
        operator,
        f.token,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/orders/' + f.o.id + '/scan', 'POST', { code: f.p.sku }, operator)).statusCode,
    409,
  );
});
test('preview cannot rely solely on orders.version for later scans or allocation drift', async () => {
  const f = await fixture(2, 1),
    p = await preview(f);
  assert.equal(p.ready, false);
  await ok(
    '/packing/sessions/' + f.session.id + '/scans',
    'POST',
    {
      client_key: randomUUID(),
      session_version: String(f.session.version),
      order_version: String(f.o.version),
      code: f.p.sku,
    },
    operator,
    f.token,
  );
  assert.equal(String((await ok('/orders/' + f.o.id)).version), String(f.o.version));
  const before = await snapshot();
  assert.equal(
    (await req(finishPath(p), 'POST', finishBody(p), operator, f.token)).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
  f.session = (await ok('/packing/sessions/' + f.session.id, 'GET', undefined, operator)).session;
  const ready = await preview(f);
  assert.equal(ready.ready, true);
  // Represent an actual coordinated scan reversal, preserving the existing deferred
  // allocation consistency invariant while leaving orders.version unchanged.
  await tenantTx(tenant, async (c) => {
    await c.query('UPDATE reservation_locations SET scanned=scanned-1 WHERE order_id=$1', [f.o.id]);
    await c.query('UPDATE order_pick_items SET scanned=scanned-1 WHERE order_id=$1', [f.o.id]);
  });
  assert.equal(String((await ok('/orders/' + f.o.id)).version), String(f.o.version));
  const drift = await snapshot();
  assert.equal(
    (await req(finishPath(ready), 'POST', finishBody(ready), operator, f.token)).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), drift);
});
test('renew and expired takeover fence all old previews and tokens; two fresh takeovers have one winner', async () => {
  const f = await fixture(),
    old = await preview(f),
    newToken = randomUUID();
  const renewed = (
    await ok(
      '/packing/sessions/' + f.session.id + '/renew',
      'POST',
      {
        client_key: randomUUID(),
        session_version: String(f.session.version),
        lease_token: newToken,
      },
      operator,
      f.token,
    )
  ).session;
  const before = await snapshot();
  assert(
    (await req(finishPath(old), 'POST', finishBody(old), operator, f.token)).statusCode >= 400,
  );
  assert.deepEqual(await snapshot(), before);
  // Synthetic past clock input in our guarded disposable DB; no mutation of a live lease.
  const oldOrder = (await orderFixture()).o,
    expiredId = randomUUID(),
    expiredToken = randomUUID();
  await pool.query(
    `WITH clock AS (SELECT clock_timestamp()-interval '16 minutes' created)
    INSERT INTO packing_sessions(id,tenant_id,order_id,warehouse_id,station_id,
    owner_id,state,version,lease_generation,lease_token_hash,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,'active',1,1,$7,created,created+interval '15 minutes' FROM clock`,
    [
      expiredId,
      tenant,
      oldOrder.id,
      warehouse,
      f.station.id,
      operatorId,
      createHash('sha256').update(expiredToken).digest('hex'),
    ],
  );
  const expired = (await ok('/packing/sessions/' + expiredId)).session;
  const body = {
    client_key: randomUUID(),
    session_version: String(expired.version),
    station_id: f.station2.id,
    station_version: String(f.station2.version),
    lease_token: randomUUID(),
  };
  const contenders = await Promise.all([
    req('/packing/sessions/' + expiredId + '/takeover', 'POST', body),
    req('/packing/sessions/' + expiredId + '/takeover', 'POST', {
      ...body,
      client_key: randomUUID(),
      lease_token: randomUUID(),
    }),
  ]);
  assert.equal(contenders.filter((r) => r.statusCode === 201 || r.statusCode === 200).length, 1);
  assert.equal(contenders.filter((r) => r.statusCode === 409).length, 1);
  const after = await snapshot();
  assert(
    (
      await req(
        '/packing/sessions/' + expiredId + '/renew',
        'POST',
        {
          client_key: randomUUID(),
          session_version: String(expired.version),
          lease_token: randomUUID(),
        },
        operator,
        expiredToken,
      )
    ).statusCode >= 400,
  );
  assert.deepEqual(await snapshot(), after);
});
test(
  'generic cancellation uses its reserved terminal slot without waiting for packing admission',
  { timeout: 10000 },
  async () => {
    const config = await configs(),
      f = await orderFixture(),
      sessionId = randomUUID();
    const version = '9223372036854775806',
      generation = '9223372036854775807';
    const before = (
      await pool.query(
        `WITH clock AS (SELECT clock_timestamp()-interval '16 minutes' created)
    INSERT INTO packing_sessions(id,tenant_id,order_id,warehouse_id,station_id,owner_id,state,
      version,lease_generation,lease_token_hash,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,'active',$7,$8,$9,created,created+interval '15 minutes' FROM clock
    RETURNING *`,
        [
          sessionId,
          tenant,
          f.o.id,
          warehouse,
          config.station.id,
          operatorId,
          version,
          generation,
          createHash('sha256').update(randomUUID()).digest('hex'),
        ],
      )
    ).rows[0];
    assert.equal(before.version, version);
    assert.equal(before.lease_generation, generation);
    assert(Number(before.budget_bytes) > Number(before.byte_count));
    const operations = (
      await pool.query('SELECT count(*)::int n FROM packing_operations WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n;
    const c = await pool.connect();
    let pending: ReturnType<typeof req> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'packing.admission:' + tenant,
      ]);
      pending = req('/orders/' + f.o.id + '/status', 'PATCH', { status: 'cancelled' }, operator);
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Generic cancellation waited for packing admission')),
            3000,
          );
        }),
      ]);
      assert.equal(result.statusCode, 200);
      // Verify completion while the conflicting advisory is still held, before finally releases it.
      const cancelled = (
        await pool.query('SELECT * FROM packing_sessions WHERE id=$1 AND tenant_id=$2', [
          sessionId,
          tenant,
        ])
      ).rows[0];
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(cancelled.version, '9223372036854775807');
      assert.equal(cancelled.lease_generation, generation);
      assert.equal(cancelled.budget_bytes, before.budget_bytes);
      assert(Number(cancelled.byte_count) <= Number(cancelled.budget_bytes));
      assert(cancelled.finished_at instanceof Date);
      const order = await ok('/orders/' + f.o.id);
      assert.equal(order.status, 'cancelled');
      assert.equal(BigInt(order.version), BigInt(f.o.version) + 1n);
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM packing_operations WHERE tenant_id=$1', [
            tenant,
          ])
        ).rows[0].n,
        operations,
      );
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM packing_receipts WHERE tenant_id=$1', [
            tenant,
          ])
        ).rows[0].n,
        0,
      );
    } finally {
      if (timer) clearTimeout(timer);
      await c.query('ROLLBACK');
      c.release();
      await pending;
    }
  },
);
test('nonempty frozen composition active reservations completed allocations and current payment are mandatory', async () => {
  for (const mutation of ['empty', 'quantity', 'released', 'allocation', 'payment']) {
    const f = await fixture(),
      p = await preview(f);
    if (mutation === 'empty')
      await pool.query('DELETE FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2', [
        tenant,
        f.o.id,
      ]);
    if (mutation === 'quantity')
      await pool.query(
        'UPDATE order_pick_items SET quantity=quantity+1 WHERE tenant_id=$1 AND order_id=$2',
        [tenant, f.o.id],
      );
    if (mutation === 'released')
      await tenantTx(tenant, async (c) => {
        await c.query(
          `UPDATE stock s SET reserved=s.reserved-r.quantity FROM reservations r
          WHERE (s.tenant_id,s.warehouse_id,s.product_id)=(r.tenant_id,r.warehouse_id,r.product_id)
          AND r.order_id=$1 AND r.state='active'`,
          [f.o.id],
        );
        await c.query("UPDATE reservations SET state='released' WHERE order_id=$1", [f.o.id]);
      });
    if (mutation === 'allocation')
      await tenantTx(tenant, async (c) => {
        await c.query('UPDATE reservation_locations SET scanned=0 WHERE order_id=$1', [f.o.id]);
        await c.query('UPDATE order_pick_items SET scanned=0 WHERE order_id=$1', [f.o.id]);
      });
    if (mutation === 'payment')
      await pool.query("UPDATE orders SET payment_mode='prepaid' WHERE tenant_id=$1 AND id=$2", [
        tenant,
        f.o.id,
      ]);
    const before = await snapshot();
    assert.equal(
      (await req(finishPath(p), 'POST', finishBody(p), operator, f.token)).statusCode,
      409,
    );
    assert.deepEqual(await snapshot(), before);
    const invalid = await preview({ ...f, o: await ok('/orders/' + f.o.id) });
    assert.equal(invalid.ready, false, mutation + ' must not form a ready new preview');
  }
});
test('packing and picking wave admissions have exactly one winner for the same incomplete order', async () => {
  const f = await fixture(1, 0);
  const before = await snapshot();
  assert.equal(
    (await req('/picking-waves/preview', 'POST', { warehouse_id: warehouse, order_ids: [f.o.id] }))
      .statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
  await ok(
    '/packing/sessions/' + f.session.id + '/cancel',
    'POST',
    {
      client_key: randomUUID(),
      session_version: String(f.session.version),
    },
    operator,
    f.token,
  );
  const wave = await ok('/picking-waves/preview', 'POST', {
    warehouse_id: warehouse,
    order_ids: [f.o.id],
  });
  const responses = await Promise.all([
    req('/picking-waves', 'POST', {
      client_key: randomUUID(),
      warehouse_id: warehouse,
      order_ids: [f.o.id],
      name: 'Packing race',
      preview_hash: wave.preview_hash,
    }),
    req(
      '/packing/sessions',
      'POST',
      {
        client_key: randomUUID(),
        order_id: f.o.id,
        order_version: String(f.o.version),
        station_id: f.station.id,
        station_version: String(f.station.version),
        lease_token: randomUUID(),
      },
      operator,
    ),
  ]);
  assert.equal(responses.filter((r) => r.statusCode >= 200 && r.statusCode < 300).length, 1);
  assert.equal(responses.filter((r) => r.statusCode === 409).length, 1);
  const active = (
    await pool.query(
      `SELECT
    (SELECT count(*) FROM packing_sessions WHERE tenant_id=$1 AND order_id=$2 AND state='active')+
    (SELECT count(*) FROM picking_wave_orders WHERE tenant_id=$1 AND order_id=$2 AND active) n`,
      [tenant, f.o.id],
    )
  ).rows[0];
  assert.equal(Number(active.n), 1);
});
test('frozen bundle components drive physical completion and packing never consumes their inventory', async () => {
  const config = await configs(),
    a = (await orderFixture()).p,
    b = (await orderFixture()).p;
  const kit = await ok('/products', 'POST', {
    sku: 'PACK-KIT-' + randomUUID(),
    name: 'Kit',
    kind: 'bundle',
    quantity: 0,
    price: 6000,
    warehouse_id: warehouse,
    components: [
      { product_id: a.id, quantity: 2 },
      { product_id: b.id, quantity: 3 },
    ],
  });
  const o = await ok('/orders', 'POST', {
    customer_name: 'Kit recipient',
    email: 'kit@example.test',
    payment_mode: 'cod',
    warehouse_id: warehouse,
    items: [{ product_id: kit.id, quantity: 2 }],
  });
  await ok('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
  const current = await ok('/orders/' + o.id),
    token = randomUUID();
  let session = (
    await ok(
      '/packing/sessions',
      'POST',
      {
        client_key: randomUUID(),
        order_id: o.id,
        order_version: String(current.version),
        station_id: config.station.id,
        station_version: String(config.station.version),
        lease_token: token,
      },
      operator,
    )
  ).session;
  await pool.query('UPDATE bundle_components SET quantity=1 WHERE tenant_id=$1 AND bundle_id=$2', [
    tenant,
    kit.id,
  ]);
  for (const [p, count] of [
    [a, 4],
    [b, 6],
  ] as [any, number][])
    for (let i = 0; i < count; i++) {
      await ok(
        '/packing/sessions/' + session.id + '/scans',
        'POST',
        {
          client_key: randomUUID(),
          session_version: String(session.version),
          order_version: String(current.version),
          code: p.sku,
        },
        operator,
        token,
      );
      session = (await ok('/packing/sessions/' + session.id, 'GET', undefined, operator)).session;
    }
  const physical = await ok(
    '/packing/sessions/' + session.id + '/items',
    'GET',
    undefined,
    operator,
  );
  assert.deepEqual(
    physical.data.map((r: any) => [r.product_id, Number(r.quantity)]).sort(),
    [
      [a.id, 4],
      [b.id, 6],
    ].sort(),
  );
  const names = [
    'stock',
    'stock_locations',
    'stock_movements',
    'stock_location_movements',
    'reservations',
    'reservation_locations',
  ];
  const before = await snapshot(names);
  await finish({ ...config, p: kit, o: current, token, session });
  assert.deepEqual(await snapshot(names), before);
  assert.equal((await ok('/orders/' + o.id)).status, 'packed');
  assert.equal(providerCalls, 0);
});
test('policy ON blocks generic packed workflow batch rule and scheduled actions without a genuine receipt', async () => {
  const { p, o } = await orderFixture();
  await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  const admitted = await ok('/orders/batches/preview', 'POST', {
    order_ids: [o.id],
    action: { type: 'set_status', status: 'packed' },
  });
  assert.equal(admitted.items[0].allowed, true);
  const queued = await ok('/order-batches/' + admitted.id + '/queue', 'POST', { confirmed: true });
  const beforePolicy = await ok('/packing');
  await ok('/packing/policy', 'PATCH', {
    client_key: randomUUID(),
    version: String(beforePolicy.policy.version),
    require_parcel_profile: true,
  });
  await processBatch(await claim(queued.job_id));
  assert.equal((await ok('/orders/' + o.id)).status, 'picking');
  const wf = await ok('/workflow-statuses', 'POST', { name: 'Packed local', stage: 'packed' });
  assert.equal(
    (await req('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' })).statusCode,
    409,
  );
  for (const action of [
    { type: 'set_status', status: 'packed' },
    { type: 'set_workflow', status_id: wf.id },
  ]) {
    assert.equal((await req('/orders/' + o.id + '/operations', 'POST', action)).statusCode, 409);
    const batch = await ok('/orders/batches/preview', 'POST', { order_ids: [o.id], action });
    assert.equal(batch.items[0].allowed, false);
  }
  const rule = await ok('/automations', 'POST', {
    name: 'Packing guard',
    enabled: true,
    trigger: 'order.note_added',
    priority: 50,
    delay_seconds: 0,
    match: 'all',
    conditions: [],
    actions: [{ type: 'set_status', status: 'packed' }],
  });
  await ok('/orders/' + o.id + '/operations', 'POST', {
    type: 'add_note',
    note: 'Trigger frozen guard',
  });
  const dispatcher = (
    await pool.query(
      "SELECT id FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'trigger'='order.note_added' AND payload->>'orderId'=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [tenant, o.id],
    )
  ).rows[0];
  await dispatchAutomation(await claim(dispatcher.id));
  const run = (
    await pool.query(
      'SELECT job_id FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND order_id=$3',
      [tenant, rule.id, o.id],
    )
  ).rows[0];
  assert(run);
  await processAutomation(await claim(run.job_id));
  assert.equal((await ok('/orders/' + o.id)).status, 'picking');
  const schedule = await ok('/automation-schedules', 'POST', {
    client_key: randomUUID(),
    name: 'Packing schedule',
    enabled: true,
    frequency: { kind: 'interval', seconds: 3600 },
    statuses: ['picking'],
    min_age_seconds: 0,
    actions: [{ type: 'set_status', status: 'packed' }],
  });
  const scheduled = await ok('/automation-schedules/' + schedule.id + '/run', 'POST', {
    version: schedule.version,
    client_key: randomUUID(),
    confirmed: true,
  });
  await processSchedule(await claim(scheduled.job_id));
  assert.equal((await ok('/orders/' + o.id)).status, 'picking');
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM packing_receipts WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    0,
  );
});
test('immutable receipts have genuine tenant order revision FKs and token-free projections', async () => {
  const f = await fixture(),
    r = await finish(f);
  const head = await ok('/packing/receipts/' + r.id, 'GET', undefined, operator);
  assert(!JSON.stringify(head).includes(f.token));
  assert(!/lease_token_hash/.test(JSON.stringify(head)));
  for (const table of packingTables) {
    const flags = (
      await pool.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [table],
      )
    ).rows[0];
    assert(flags.relrowsecurity && flags.relforcerowsecurity, table);
    await tenantTx(SECOND_TENANT, async (c) =>
      assert.equal(
        (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenant])).rowCount,
        0,
      ),
    );
  }
  for (const table of ['packing_operations', 'packing_previews', 'packing_receipts']) {
    await assert.rejects(
      pool.query(`UPDATE ${table} SET client_key=gen_random_uuid() WHERE tenant_id=$1`, [tenant]),
      /immutable|niezmienny/i,
    );
    await assert.rejects(
      pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]),
      /immutable|nieusuwalna/i,
    );
  }
  const otherOrder = (await orderFixture()).o,
    before = await snapshot();
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('UPDATE order_packing_profiles SET order_id=$3 WHERE tenant_id=$1 AND order_id=$2', [
        tenant,
        f.o.id,
        otherOrder.id,
      ]),
    ),
    (e: any) =>
      e.code === '23503' ||
      (e.code === '23514' && /Profil nie zachowuje następnej rewizji/.test(e.message)),
  );
  assert.deepEqual(await snapshot(), before);
});
test('remeasure repairs a stale latest pointer without order event stock or local-financial fence changes', async () => {
  const f = await fixture(),
    first = await finish(f);
  assert.notEqual(first.before_fulfillment_hash, first.after_fulfillment_hash);
  await ok('/orders/' + f.o.id + '/operations', 'POST', {
    type: 'add_note',
    note: 'Version drift after physical finish',
  });
  const order = await ok('/orders/' + f.o.id),
    latest = (await ok('/packing/orders/' + f.o.id + '/profile')).profile;
  assert.equal(latest.current, false);
  assert.equal(latest.receipt_id, first.id);
  await pool.query(
    `INSERT INTO order_local_financial_fences(tenant_id,order_id,order_version)
    VALUES($1,$2,$3) ON CONFLICT(tenant_id,order_id) DO UPDATE SET order_version=excluded.order_version`,
    [tenant, f.o.id, order.version],
  );
  const before = await snapshot(businessTables),
    p = (
      await ok(
        '/packing/previews',
        'POST',
        {
          client_key: randomUUID(),
          kind: 'remeasure',
          order_id: f.o.id,
          order_version: String(order.version),
          profile_revision: String(latest.revision),
          replaces_receipt_id: first.id,
          station_id: f.station.id,
          station_version: String(f.station.version),
          packaging: {
            kind: 'carton',
            carton_id: f.carton2.id,
            carton_version: String(f.carton2.version),
          },
          measurements: { ...measured, weight_grams: 1500 },
          include_product_estimate: false,
          reason: 'New physical measurement',
        },
        operator,
      )
    ).preview;
  assert.equal(p.ready, true);
  const r = (await ok(finishPath(p), 'POST', finishBody(p), operator)).receipt;
  assert.equal(r.before_fulfillment_hash, r.after_fulfillment_hash);
  assert.equal(String(r.before_order_version), String(order.version));
  assert.equal(String(r.after_order_version), String(order.version));
  // Only local packing audit is permitted, not an order event or new queue/outbox entry.
  const after = await snapshot(businessTables);
  delete before.audit_events;
  delete after.audit_events;
  assert.deepEqual(after, before);
  assert.equal((await ok('/packing/orders/' + f.o.id + '/profile')).profile.current, true);
  assert.equal(providerCalls, 0);
});
test('bound courier preview keeps the legacy order snapshot and old binding cannot queue after remeasurement', async () => {
  const f = await fixture(),
    receipt = await finish(f),
    order = await ok('/orders/' + f.o.id);
  const channel = await ok('/shipping/example', 'POST', {});
  const body = {
    channel_id: channel.id,
    service: 'inpost_courier_standard',
    receiver: {
      first_name: 'Packing',
      last_name: 'Recipient',
      email: 'packing@example.test',
      phone: '500600700',
      address: {
        street: 'Testowa',
        building_number: '1',
        city: 'Warszawa',
        post_code: '00-001',
        country_code: 'PL',
      },
    },
    dimensions: { length: 380, width: 200, height: 100 },
    weight: 1.37,
    cod: 2500,
    insurance: 2500,
    packing: {
      receipt_id: receipt.id,
      scope_hash: receipt.scope_hash,
      profile_revision: String(receipt.profile_revision),
    },
  };
  const plan = await ok('/orders/' + order.id + '/shipping/preview', 'POST', body);
  const stored = (
    await pool.query('SELECT * FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [tenant, plan.id])
  ).rows[0];
  assert.deepEqual(stored.order_snapshot, {
    status: order.status,
    updated_at: new Date(order.updated_at).toISOString(),
    total: order.total,
    currency: order.currency,
    warehouse_id: order.warehouse_id,
    address: order.address,
    email: order.email,
    customer_name: order.customer_name,
  });
  assert.equal(stored.input.packing_snapshot.receipt_id, receipt.id);
  assert.deepEqual(stored.input.packing_snapshot.measurements, measured);
  const unchanged = await snapshot();
  assert.equal(
    (
      await req('/orders/' + order.id + '/shipping/preview', 'POST', {
        ...body,
        packing_snapshot: { ...stored.input.packing_snapshot, receipt_id: randomUUID() },
      })
    ).statusCode,
    422,
  );
  assert.deepEqual(await snapshot(), unchanged);
  const p = (
    await ok(
      '/packing/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'remeasure',
        order_id: order.id,
        order_version: String(order.version),
        profile_revision: String(receipt.profile_revision),
        replaces_receipt_id: receipt.id,
        station_id: f.station.id,
        station_version: String(f.station.version),
        packaging: {
          kind: 'carton',
          carton_id: f.carton.id,
          carton_version: String(f.carton.version),
        },
        measurements: { ...measured, weight_grams: 1400 },
        include_product_estimate: false,
        reason: 'Reweighed before carrier approval',
      },
      operator,
    )
  ).preview;
  assert.equal(p.ready, true);
  await ok(finishPath(p), 'POST', finishBody(p), operator);
  const beforeQueue = await snapshot();
  assert.equal((await req('/shipping-plans/' + plan.id + '/queue', 'POST', {})).statusCode, 409);
  assert.deepEqual(await snapshot(), beforeQueue);
  assert.deepEqual(
    (await pool.query('SELECT input,order_snapshot FROM shipping_plans WHERE id=$1', [plan.id]))
      .rows[0],
    { input: stored.input, order_snapshot: stored.order_snapshot },
  );
  assert.equal(providerCalls, 0);
});
test('configuration quota preserves exact replay and rejects a new admission without operation evidence', async () => {
  const body = { client_key: randomUUID(), code: 'QUOTA', label: 'Quota replay', enabled: true };
  const first = (await ok('/packing/stations', 'POST', body)).station;
  // Controlled isolated capacity fixture, not fake business operations or production state.
  await pool.query(
    `INSERT INTO packing_stations SELECT (jsonb_populate_record(NULL::packing_stations,
    to_jsonb(s)||jsonb_build_object('id',gen_random_uuid(),'code','Q'||n::text))).*
    FROM packing_stations s CROSS JOIN generate_series(1,99)n WHERE s.tenant_id=$1 AND s.id=$2`,
    [tenant, first.id],
  );
  const before = await snapshot();
  assert.equal(
    (
      await ok('/packing/stations', 'POST', {
        enabled: true,
        label: body.label,
        code: body.code,
        client_key: body.client_key,
      })
    ).reused,
    true,
  );
  assert.equal(
    (await req('/packing/stations', 'POST', { ...body, client_key: randomUUID(), code: 'OVER' }))
      .statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
});
test('viewer and insufficient scopes deny writes; readonly or missing module rejects malformed JSON before parse', async () => {
  assert.equal(
    (
      await req(
        '/packing/stations',
        'POST',
        { client_key: randomUUID(), code: 'DENY', label: 'Denied', enabled: true },
        viewer,
      )
    ).statusCode,
    403,
  );
  const key = await ok('/developer/keys', 'POST', {
    name: 'Packing read only',
    scopes: ['orders:read'],
  });
  const denied = await app.inject({
    url: '/api/v1/packing/sessions',
    method: 'POST',
    payload: {},
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(denied.statusCode, 403);
  const readonly = await buildApp({ readOnly: true, previewPort: 4110 });
  try {
    const cookie = await login('admin@demo.local', readonly);
    const r = await readonly.inject({
      url: '/api/packing/previews',
      method: 'POST',
      payload: '{bad',
      headers: { cookie, 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 423);
    const meta = await ok('/packing', 'GET', undefined, cookie, undefined, readonly);
    assert.equal(meta.can_write, false);
    assert.equal(meta.can_admin, false);
  } finally {
    await readonly.close();
  }
  await pool.query('ALTER TABLE packing_receipts RENAME TO packing_receipts_missing_test');
  let missing: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    missing = await buildApp();
    const cookie = await login('admin@demo.local', missing);
    const meta = await req('/packing', 'GET', undefined, cookie, undefined, missing);
    assert.equal(meta.statusCode, 200);
    assert.equal(meta.headers['cache-control'], 'no-store');
    assert.equal(meta.json().available, false);
    const r = await missing.inject({
      url: '/api/packing/previews',
      method: 'POST',
      payload: '{bad',
      headers: { cookie, 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 503);
    assert.equal(
      (await req('/orders', 'GET', undefined, cookie, undefined, missing)).statusCode,
      200,
    );
  } finally {
    await missing?.close();
    await pool.query('ALTER TABLE packing_receipts_missing_test RENAME TO packing_receipts');
  }
});
