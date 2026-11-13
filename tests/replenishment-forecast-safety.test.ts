import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  supplier = '',
  adminId = '',
  admin = '',
  viewer = '',
  other = '',
  ip = 1;
let providerCalls = 0;
const prefix = '/replenishment';
const evidence = [
  'replenishment_previews',
  'replenishment_rows',
  'replenishment_executions',
  'replenishment_execution_rows',
];
const cookies = new Map<string, string>();
const transport = async () => {
  ++providerCalls;
  throw Error('Local replenishment cannot contact providers');
};
function request(
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  target = app,
  headers: Record<string, string> = {},
) {
  assert(target);
  return target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.0.179.' + ip,
  });
}
async function ok(path: string, method: any = 'GET', body?: any, cookie = admin, status = 200) {
  const r = await request(path, method, body, cookie);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 900)}`);
  if (path.startsWith(prefix)) assert.equal(r.headers['cache-control'], 'no-store', path);
  return r.json() as Row;
}
async function login(email: string, target = app) {
  const r = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.REPLENISHMENT_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local', 'other@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Forecast adversarial','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Replenishment warehouse','RP')",
    [warehouse, tenant],
  );
  for (const [email, cookie] of cookies) {
    const r = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
  const r = await request('/suppliers', 'POST', {
    name: 'Local supplier',
    code: 'S-' + randomUUID(),
  });
  assert.equal(r.statusCode, 201, r.body);
  supplier = r.json().id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function product(extra: Row = {}) {
  const r = await request('/products', 'POST', {
    sku: 'RP-' + randomUUID(),
    name: 'Physical replenishment product',
    price: 9999,
    quantity: 10,
    warehouse_id: warehouse,
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as Row;
}
const definition = (extra: Row = {}) => ({
  enabled: true,
  minimum_quantity: 20,
  target_quantity: 40,
  supplier_id: supplier,
  supplier_sku: 'LOCAL-317',
  currency: 'PLN',
  minimum_order_quantity: 1,
  order_multiple: 1,
  unit_cost_minor: 317,
  cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
  confirm_cost: true,
  expected_date: null,
  ...extra,
});
async function policy(p: Row, extra: Row = {}) {
  return (
    await ok(
      prefix + '/policies',
      'POST',
      {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        product_id: p.id,
        definition: definition(extra),
      },
      admin,
      201,
    )
  ).policy as Row;
}
const selection = (products: Row[], policies: Row[]) => ({
  client_key: randomUUID(),
  warehouse_id: warehouse,
  items: products.map((p, i) => ({
    product_id: p.id,
    product_version: Number(p.version),
    policy_version: Number(policies[i].version),
  })),
});
async function fixture(extra: Row = {}) {
  const p = await product(),
    pol = await policy(p, extra);
  return {
    p,
    pol,
    body: { ...selection([p], [pol]), forecast: { lookback_days: 7, coverage_days: 14 } },
  };
}
async function preview(body: Row, cookie = admin) {
  return (await ok(prefix + '/previews', 'POST', body, cookie, 201)).preview as Row;
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const execute = (p: Row, body: Row = consent(p), cookie = admin) =>
  request(prefix + '/previews/' + p.id + '/execute', 'POST', body, cookie);
async function key(scopes: string[]) {
  const r = await request('/developer/keys', 'POST', { name: 'Replenishment safety', scopes });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as Row;
}
const readScopes = ['products:read', 'inventory:read', 'purchasing:read'];
const writeScopes = [...readScopes, 'purchasing:write'];
const publicRequest = (token: string, path: string, method: any = 'GET', body?: any) =>
  request('/v1' + path, method, body, '', app, { authorization: 'Bearer ' + token });
async function snapshot() {
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','auth237_api_key_state','outbound_subscriptions','sessions') ORDER BY 1`)
  ).rows;
  const result: Row = {};
  for (const { table_name: name } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  }
  return result;
}
async function waitOn(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (rows.some((r) => pattern.test(r.query))) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('The actual replenishment request never waited on the independent SQL blocker');
}
async function grantChange(sql: string, values: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, values);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function epoch() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const n = (await c.query('SELECT purchasing_source_version()::text n')).rows[0].n;
    await c.query('ROLLBACK');
    return BigInt(n);
  } finally {
    c.release();
  }
}

// Synthetic trusted-journal history in the disposable test database. These
// records exercise forecasting/fences, not proof of an authentic dispatch.
async function journalOrder(p: Row) {
  return await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Synthetic journal customer',
      email: 'forecast@example.test',
      warehouse_id: warehouse,
      payment_mode: 'cod',
      items: [{ product_id: p.id, quantity: 1 }],
    },
    admin,
    201,
  );
}
async function movement(
  p: Row,
  order: Row,
  delta = -3,
  kind = 'shipment',
  c: Pool | PoolClient = pool,
) {
  const id = randomUUID(),
    sql = `INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,order_id,delta,kind)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    values = [id, tenant, p.id, warehouse, order.id, delta, kind];
  // A native journal birth is accepted only inside its own tenant scope (152_catalog_stock_control).
  if (c === pool) await tenantScopedOwnerQuery(tenant, sql, values);
  else await c.query(sql, values);
  return id;
}
async function rawApp(fn: (c: PoolClient) => Promise<void>, scope = tenant) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [scope]);
    await fn(c);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function rawDemand(id: string) {
  return (
    await pool.query(
      "SELECT snapshot->'demand' AS demand FROM replenishment_rows WHERE preview_id=$1",
      [id],
    )
  ).rows[0].demand as Row;
}
async function blockedDenial(
  holder: PoolClient,
  action: () => ReturnType<typeof request>,
  wait: RegExp,
  mutate: () => Promise<void>,
  expected: number,
  before: Row,
) {
  let pending: ReturnType<typeof request> | undefined;
  try {
    pending = action();
    await waitOn(holder, wait);
    await mutate();
    await holder.query('COMMIT');
    const r = await pending;
    assert.equal(r.statusCode, expected, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending;
  }
}

test('clients cannot supply frozen time, history, fractional days or an unsupported lookback, and denials persist nothing', async () => {
  const f = await fixture(),
    before = await snapshot();
  for (const patch of [
    { forecast: { lookback_days: 8, coverage_days: 14 } },
    { forecast: { lookback_days: 7, coverage_days: 0 } },
    { forecast: { lookback_days: 7, coverage_days: 366 } },
    { forecast: { lookback_days: 7, coverage_days: 1.5 } },
    { forecast: { lookback_days: '7', coverage_days: 14 } },
    { forecast: { lookback_days: 7, coverage_days: 14, shipped_quantity: '1000' } },
    { forecast_window: { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' } },
  ]) {
    const r = await request(prefix + '/previews', 'POST', { ...f.body, ...patch });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('raw INSERT from an empty journal, UPDATE correction, DELETE and restored-value ABA invalidate frozen forecasts without stock effects', async () => {
  const f = await fixture(),
    o = await journalOrder(f.p),
    stock = (await snapshot()).stock;
  const empty = await preview(f.body),
    initialEpoch = await epoch();
  const id = await movement(f.p, o);
  assert((await epoch()) > initialEpoch);
  let before = await snapshot();
  assert.equal((await execute(empty)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  for (const change of ['update', 'aba', 'delete']) {
    const p = await preview({ ...f.body, client_key: randomUUID() }),
      oldEpoch = await epoch();
    await rawApp(async (c) => {
      if (change === 'delete') await c.query('DELETE FROM stock_movements WHERE id=$1', [id]);
      else {
        await c.query('UPDATE stock_movements SET delta=-4 WHERE id=$1', [id]);
        if (change === 'aba')
          await c.query('UPDATE stock_movements SET delta=-3 WHERE id=$1', [id]);
      }
    });
    assert((await epoch()) > oldEpoch);
    before = await snapshot();
    assert.equal((await execute(p)).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  }
  // A same-ID remove/reinsert restores every journal value but not its marker.
  const old = await movement(f.p, o),
    row = (await pool.query('SELECT to_jsonb(t) AS row FROM stock_movements t WHERE id=$1', [old]))
      .rows[0].row;
  const p = await preview({ ...f.body, client_key: randomUUID() });
  await rawApp(async (c) => {
    await c.query('DELETE FROM stock_movements WHERE id=$1', [old]);
    await c.query(
      'INSERT INTO stock_movements SELECT (jsonb_populate_record(NULL::stock_movements,$1::jsonb)).*',
      [JSON.stringify(row)],
    );
  });
  before = await snapshot();
  assert.equal((await execute(p)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(before.stock, stock);
  assert.equal(providerCalls, 0);
});

test(
  'owner journal writes in their own tenant scope hold the source gate before planning; completed history appears only after commit',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      o = await journalOrder(f.p),
      old = await epoch(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      // A journal birth without tenant scope is rejected since 152_catalog_stock_control
      // ("Obcy tenant native birth"); the owner write declares its own tenant.
      await holder.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      await movement(f.p, o, -11, 'shipment', holder);
      pending = request(prefix + '/previews', 'POST', f.body);
      await waitOn(holder, /purchasing_source_admit/);
      await holder.query('COMMIT');
      const r = await pending;
      assert.equal(r.statusCode, 201, r.body);
      assert((await epoch()) > old);
      const demand = await rawDemand(r.json().preview.id);
      assert.equal(demand.shipped_quantity, '11');
      assert.equal(demand.restocked_return_quantity, '0');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test('journal gate rejects missing application scope, declared foreign scope, truncation and private-marker writes; empty statements do not invalidate', async () => {
  const f = await fixture(),
    o = await journalOrder(f.p),
    id = await movement(f.p, o),
    old = await epoch(),
    before = await snapshot();
  for (const [sql, values, scope, owner, code] of [
    ['UPDATE stock_movements SET delta=delta WHERE id=$1', [id], '', false, '42501'],
    ['UPDATE stock_movements SET delta=delta WHERE id=$1', [id], randomUUID(), true, '42501'],
    // Native receipts reference the journal by foreign key, so PostgreSQL refuses the
    // truncation (0A000) before the purchasing TRUNCATE trigger would.
    ['TRUNCATE stock_movements', [], tenant, true, '0A000'],
    [
      'INSERT INTO purchasing_stock_changes(tenant_id) VALUES($1)',
      [tenant],
      tenant,
      false,
      '42501',
    ],
    ['DELETE FROM purchasing_stock_changes WHERE tenant_id=$1', [tenant], tenant, false, '42501'],
  ] as const) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (!owner) await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [scope]);
      await assert.rejects(c.query(sql, [...values]), { code });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  await rawApp(async (c) => {
    await c.query('UPDATE stock_movements SET delta=delta WHERE id=$1', [randomUUID()]);
  });
  assert.equal(await epoch(), old);
  assert.deepEqual(await snapshot(), before);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [randomUUID()]);
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM stock_movements WHERE tenant_id=$1', [tenant]))
        .rows[0].n,
      0,
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test(
  'independent scoped journal writers append markers without a shared epoch-row lock cycle',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      b = await product(),
      o = await journalOrder(f.p),
      stock = (await snapshot()).stock;
    const one = await pool.connect(),
      two = await pool.connect(),
      old = await epoch();
    try {
      for (const c of [one, two]) {
        await c.query('BEGIN');
        await c.query("SET LOCAL statement_timeout='1500ms'");
        await c.query('SET LOCAL ROLE dyna_app');
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      }
      await movement(f.p, o, -2, 'shipment', one);
      // The first transaction remains uncommitted. This statement must still
      // finish; a mutable shared tenant epoch would block this second writer.
      await movement(b, o, -5, 'shipment', two);
      await two.query('COMMIT');
      await one.query('COMMIT');
      assert((await epoch()) > old);
      assert.deepEqual((await snapshot()).stock, stock);
    } finally {
      for (const c of [one, two]) {
        await c.query('ROLLBACK');
        c.release();
      }
    }
  },
);

test(
  'actual forecast source wait allows admin withdrawal and rolls back preview, rows, audit and bytes',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      before = await snapshot(),
      holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'purchasing.source:' + tenant,
    ]);
    await blockedDenial(
      holder,
      () => request(prefix + '/previews', 'POST', f.body),
      /purchasing_source_admit/,
      () =>
        grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          tenant,
          adminId,
        ]),
      403,
      before,
    );
  },
);

test(
  'forecast public requests need existing compound scopes but never orders:read; live key revoke, expiry and scope removal deny after a product wait',
  { timeout: 30000 },
  async () => {
    for (const change of ['revoke', 'expiry', 'read', 'write']) {
      const f = await fixture(),
        credential = await key(writeScopes);
      assert(!writeScopes.includes('orders:read'));
      const r = await publicRequest(credential.token, prefix + '/previews', 'POST', f.body);
      assert.equal(r.statusCode, 201, r.body);
      const p = r.json().preview,
        before = await snapshot(),
        holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [f.p.id]);
      await blockedDenial(
        holder,
        () =>
          publicRequest(
            credential.token,
            prefix + '/previews/' + p.id + '/execute',
            'POST',
            consent(p),
          ),
        /products[\s\S]*FOR SHARE/i,
        () =>
          grantChange(
            change === 'revoke'
              ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
              : change === 'expiry'
                ? "UPDATE api_keys SET expires_at=now()-interval '1 minute' WHERE id=$1"
                : 'UPDATE api_keys SET scopes=$2::text[] WHERE id=$1',
            change === 'read'
              ? [credential.id, writeScopes.filter((x) => x !== 'inventory:read')]
              : change === 'write'
                ? [credential.id, readScopes]
                : [credential.id],
          ),
        ['revoke', 'expiry'].includes(change) ? 401 : 403,
        before,
      );
    }
  },
);

test('completed forecast replay returns frozen evidence after new/backdated history; actor/body collisions cannot create another PO or stock effect', async () => {
  const f = await fixture(),
    o = await journalOrder(f.p);
  await movement(f.p, o);
  const p = await preview(f.body),
    body = consent(p),
    r = await execute(p, body);
  assert.equal(r.statusCode, 201, r.body);
  const demand = await rawDemand(p.id);
  await movement(f.p, o, -9);
  await movement(f.p, o, 2, 'return');
  const before = await snapshot();
  const retry = await execute(p, body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().reused, true);
  assert.equal(retry.json().execution.id, r.json().execution.id);
  assert.deepEqual(await rawDemand(p.id), demand);
  assert.equal((await execute(p, { ...body, scope_hash: '0'.repeat(64) })).statusCode, 409);
  assert.equal((await execute(p, body, other)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('viewer sees demand quantities without costs or order/customer identities, and read-only compound key cannot create a forecast', async () => {
  const f = await fixture(),
    o = await journalOrder(f.p);
  await movement(f.p, o);
  const p = await preview(f.body),
    credential = await key(readScopes),
    before = await snapshot();
  const r = await request(prefix + '/previews/' + p.id + '/rows', 'GET', undefined, viewer);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().can_read_value, false);
  for (const secret of [
    o.id,
    'forecast@example.test',
    'Synthetic journal customer',
    'unit_cost_minor',
    'line_total_minor',
    'cost_confirmed_at',
  ])
    assert(!r.body.includes(secret), secret + ' leaked');
  const read = await publicRequest(credential.token, prefix + '/previews/' + p.id + '/rows');
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(
    (
      await publicRequest(credential.token, prefix + '/previews', 'POST', {
        ...f.body,
        client_key: randomUUID(),
      })
    ).statusCode,
    403,
  );
  assert.deepEqual(await snapshot(), before);
});

test('legacy manual preview config/hash/evidence survive absent forecast capability; only the new forecast path is unavailable', async () => {
  const f = await fixture(),
    manual: Row = { ...f.body };
  delete manual.forecast;
  const p = await preview(manual),
    body = consent(p);
  const original = (
    await pool.query('SELECT to_jsonb(t) row FROM replenishment_previews t WHERE id=$1', [p.id])
  ).rows[0].row;
  assert.deepEqual(original.config, manual);
  assert.equal(await rawDemand(p.id), null);
  await pool.query(
    'ALTER FUNCTION replenishment_forecast_totals(uuid,uuid[],timestamptz,timestamptz) RENAME TO forecast_totals_unavailable',
  );
  let older: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    older = await buildApp({ integrationTransport: transport });
    const options = await request(prefix + '/options', 'GET', undefined, admin, older);
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().available, true);
    assert.equal(options.json().forecast_available, false);
    const before = await snapshot();
    const unavailable = await request(
      prefix + '/previews',
      'POST',
      { ...f.body, client_key: randomUUID() },
      admin,
      older,
    );
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(unavailable.headers['cache-control'], 'no-store');
    assert.deepEqual(await snapshot(), before);
    const completed = await request(
      prefix + '/previews/' + p.id + '/execute',
      'POST',
      body,
      admin,
      older,
    );
    assert.equal(completed.statusCode, 201, completed.body);
    assert.deepEqual(
      (await pool.query('SELECT to_jsonb(t) row FROM replenishment_previews t WHERE id=$1', [p.id]))
        .rows[0].row,
      original,
    );
    const after = await snapshot();
    const repeated = await request(
      prefix + '/previews/' + p.id + '/execute',
      'POST',
      body,
      admin,
      older,
    );
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().reused, true);
    assert.deepEqual(await snapshot(), after);
  } finally {
    await older?.close();
    await pool.query(
      'ALTER FUNCTION forecast_totals_unavailable(uuid,uuid[],timestamptz,timestamptz) RENAME TO replenishment_forecast_totals',
    );
  }
});

test('frozen demand proof is immutable, execution copies match the approved row, and foreign tenants cannot read source or evidence', async () => {
  const f = await fixture(),
    o = await journalOrder(f.p);
  await movement(f.p, o);
  const p = await preview(f.body),
    done = await execute(p);
  assert.equal(done.statusCode, 201, done.body);
  const e = done.json().execution,
    before = await snapshot(),
    c = await pool.connect();
  try {
    for (const table of evidence) {
      await c.query('BEGIN');
      await assert.rejects(
        c.query(`UPDATE "${table}" SET byte_count=byte_count WHERE tenant_id=$1`, [tenant]),
        { code: '23514' },
      );
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await assert.rejects(c.query(`DELETE FROM "${table}" WHERE tenant_id=$1`, [tenant]), {
        code: '23514',
      });
      await c.query('ROLLBACK');
    }
    await c.query('BEGIN');
    await assert.rejects(
      c.query(
        `INSERT INTO replenishment_execution_rows
      SELECT (jsonb_populate_record(NULL::replenishment_execution_rows,to_jsonb(t)||jsonb_build_object('id',$2::uuid,
      'snapshot',snapshot||jsonb_build_object('demand',(snapshot->'demand')||jsonb_build_object('shipped_quantity','999999'))))).*
      FROM replenishment_execution_rows t WHERE execution_id=$1`,
        [e.id, randomUUID()],
      ),
      { code: '23514' },
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [randomUUID()]);
    for (const table of ['stock_movements', ...evidence])
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [tenant]))
          .rows[0].n,
        0,
      );
    await c.query('ROLLBACK');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('restore preview keeps forecasts readable and rejects malformed forecast/policy/execute mutations before parsing', async () => {
  const f = await fixture(),
    p = await preview(f.body),
    readonly = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    const cookie = await login('admin@demo.local', readonly);
    const switched = await request(
      '/workspaces/switch',
      'POST',
      { tenant_id: tenant },
      cookie,
      readonly,
    );
    assert.equal(switched.statusCode, 200, switched.body);
    const ownCookie = String(switched.headers['set-cookie']).split(';')[0],
      before = await snapshot();
    for (const [method, path] of [
      ['POST', prefix + '/previews'],
      ['POST', prefix + '/previews/' + p.id + '/execute'],
      ['POST', prefix + '/policies'],
      ['PATCH', prefix + '/policies/' + f.pol.id],
    ]) {
      const r = await request(path, method, '{', ownCookie, readonly, {
        'content-type': 'application/json',
      });
      assert.equal(r.statusCode, 423, r.body);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    const read = await request(
      prefix + '/previews/' + p.id + '/rows',
      'GET',
      undefined,
      ownCookie,
      readonly,
    );
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().read_only, true);
    assert.equal(read.json().can_execute, false);
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  } finally {
    await readonly.close();
  }
});
