import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { processReplenishmentAutomation } from '../server/replenishment-automations';

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
    remoteAddress: '127.0.188.' + ip,
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
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Automatic drafts adversarial','enterprise')",
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
    body: selection([p], [pol]),
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
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions','sessions') ORDER BY 1`)
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

const automation = prefix + '/automations';
const tableRules = 'replenishment_automation_rules';
const tableRuns = 'replenishment_automation_runs';
function ruleBody(ids: string[], extra: Row = {}) {
  return {
    client_key: randomUUID(),
    name: 'Explicit future local drafts',
    definition: {
      warehouse_id: warehouse,
      product_ids: ids,
      enabled: true,
      destination: 'new_drafts',
      ...extra,
    },
    confirmed_future_drafts: true,
  };
}
async function rule(products: Row[], extra: Row = {}, token?: string) {
  const body = ruleBody(
    products.map((p) => p.id),
    extra,
  );
  const r = token
    ? await publicRequest(token, automation + '/rules', 'POST', body)
    : await request(automation + '/rules', 'POST', body);
  assert.equal(r.statusCode, 201, r.body);
  return r.json().rule as Row;
}
async function adjust(p: Row, delta: number) {
  return request('/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta,
    note: 'Explicit isolated physical correction',
  });
}
async function crossingFixture(extra: Row = {}, token?: string) {
  const p = await product({ quantity: 30 }),
    pol = await policy(p),
    r = await rule([p], extra, token);
  const change = await adjust(p, -11);
  assert.equal(change.statusCode, 200, change.body);
  const run = (
    await pool.query(
      'SELECT * FROM replenishment_automation_runs WHERE tenant_id=$1 AND rule_id=$2 ORDER BY created_at DESC',
      [tenant, r.id],
    )
  ).rows[0];
  assert(run);
  return { p, pol, rule: r, run };
}
async function claim(run: Row) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE tenant_id=$1 AND id=$3 AND state='pending' RETURNING *",
      [tenant, randomUUID(), run.job_id],
    )
  ).rows[0];
  assert(j);
  return j as Row;
}
async function processOutcome(job: Row): Promise<{ ok: boolean; result?: unknown; error?: any }> {
  try {
    return {
      ok: true,
      result: await processReplenishmentAutomation(
        job as Parameters<typeof processReplenishmentAutomation>[0],
      ),
    };
  } catch (error) {
    return { ok: false, error: error as any };
  }
}
async function assertNoPurchases() {
  for (const table of [
    'purchase_orders',
    'purchase_order_lines',
    'replenishment_previews',
    'replenishment_executions',
  ])
    assert.equal(
      Number(
        (await pool.query(`SELECT count(*) n FROM ${table} WHERE tenant_id=$1`, [tenant])).rows[0]
          .n,
      ),
      0,
      table,
    );
  assert.equal(providerCalls, 0);
}
async function appSql(sql: string, values: unknown[] = []) {
  return tenantTx(tenant, (c) => c.query(sql, values));
}
async function rawRun(id: string) {
  return (
    await pool.query('SELECT * FROM replenishment_automation_runs WHERE tenant_id=$1 AND id=$2', [
      tenant,
      id,
    ])
  ).rows[0] as Row;
}

// These are actual capture/worker integration tests. No fabricated source run is used for success.
test('crossing source is durable and source rollback removes both run and job, including reservation-only crossing', async () => {
  const p = await product({ quantity: 30 });
  await policy(p);
  const r = await rule([p]);
  const before = await snapshot();
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      await c.query(
        'UPDATE stock SET on_hand=19 WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [tenant, warehouse, p.id],
      );
      assert.equal(
        Number(
          (
            await c.query('SELECT count(*) n FROM replenishment_automation_runs WHERE rule_id=$1', [
              r.id,
            ])
          ).rows[0].n,
        ),
        1,
      );
      throw Error('Rollback own source and outbox');
    }),
    /Rollback own source/,
  );
  assert.deepEqual(await snapshot(), before);
  const sale = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Own source reservation',
      email: 'automation@example.test',
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
      items: [{ product_id: p.id, quantity: 11 }],
    },
    admin,
    201,
  );
  const s = (
    await pool.query(
      'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
      [tenant, p.id, warehouse],
    )
  ).rows[0];
  assert.deepEqual(s, { on_hand: 30, reserved: 11, available: 19 });
  const runs = (
    await pool.query('SELECT * FROM replenishment_automation_runs WHERE rule_id=$1', [r.id])
  ).rows;
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].crossings, [
    { product_id: p.id, before_available: 30, after_available: 19, minimum_quantity: 20 },
  ]);
  const j = (await pool.query('SELECT * FROM jobs WHERE id=$1', [runs[0].job_id])).rows[0];
  assert.equal(j.kind, 'replenishment.automation');
  assert.deepEqual(j.payload, { run_id: runs[0].id });
  assert.ok(sale.id);
  await assertNoPurchases();
});

test('rule enable, equal stock update, upward change and continued low stock never retroactively enqueue', async () => {
  const p = await product({ quantity: 10 });
  await policy(p);
  const r = await rule([p]);
  await appSql('UPDATE stock SET on_hand=on_hand WHERE tenant_id=$1 AND product_id=$2', [
    tenant,
    p.id,
  ]);
  assert.equal((await adjust(p, 1)).statusCode, 200);
  assert.equal((await adjust(p, -1)).statusCode, 200);
  assert.equal(
    Number(
      (
        await pool.query('SELECT count(*) n FROM replenishment_automation_runs WHERE rule_id=$1', [
          r.id,
        ])
      ).rows[0].n,
    ),
    0,
  );
  assert.equal((await adjust(p, 10)).statusCode, 200); // exact equality at minimum
  assert.equal((await adjust(p, -1)).statusCode, 200);
  assert.equal((await adjust(p, -1)).statusCode, 200); // low to lower is not another crossing
  assert.equal(
    Number(
      (
        await pool.query('SELECT count(*) n FROM replenishment_automation_runs WHERE rule_id=$1', [
          r.id,
        ])
      ).rows[0].n,
    ),
    1,
  );
  await assertNoPurchases();
});

test('worker waits on actual stock before checking approving membership and rolls back all local effects on withdrawal', async () => {
  const f = await crossingFixture(),
    job = await claim(f.run),
    before = await snapshot(),
    holder = await pool.connect();
  let pending: ReturnType<typeof processOutcome> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query(
      'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3 FOR UPDATE',
      [tenant, f.p.id, warehouse],
    );
    pending = processOutcome(job);
    await waitOn(holder, /stock/i);
    await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      adminId,
    ]);
    await holder.query('COMMIT');
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error?.status, 403);
    assert.deepEqual(await snapshot(), before);
    await assertNoPurchases();
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    if (pending) await pending;
  }
});

test('worker late FK wait lets approving administrator withdraw and invalidates every tentative proof and draft', async () => {
  const f = await crossingFixture(),
    job = await claim(f.run),
    before = await snapshot(),
    holder = await pool.connect();
  let pending: ReturnType<typeof processOutcome> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [adminId]);
    pending = processOutcome(job);
    await waitOn(
      holder,
      /INSERT INTO (?:public\.)?(?:replenishment_|purchase_orders|audit_events)/i,
    );
    await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      adminId,
    ]);
    await holder.query('COMMIT');
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error?.status, 403);
    assert.deepEqual(await snapshot(), before);
    await assertNoPurchases();
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    if (pending) await pending;
  }
});

test('approving API key revoke, expiry and loss of purchasing write during real stock wait deny automatic writes', async () => {
  for (const kind of ['revoke', 'expiry', 'scope']) {
    const credential = await key(writeScopes),
      f = await crossingFixture({}, credential.token),
      job = await claim(f.run),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof processOutcome> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3 FOR UPDATE',
        [tenant, f.p.id, warehouse],
      );
      pending = processOutcome(job);
      await waitOn(holder, /stock/i);
      await grantChange(
        kind === 'revoke'
          ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
          : kind === 'expiry'
            ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
            : "UPDATE api_keys SET scopes=array_remove(scopes,'purchasing:write') WHERE id=$1",
        [credential.id],
      );
      await holder.query('COMMIT');
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error?.status, kind === 'scope' ? 403 : 401);
      assert.deepEqual(await snapshot(), before);
      await assertNoPurchases();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending;
    }
    // Remove future capture of this rule; this is legitimate configuration before next case.
    await ok(automation + '/rules/' + f.rule.id, 'PATCH', {
      version: f.rule.version,
      name: f.rule.name,
      definition: { ...f.rule.definition, enabled: false },
    });
  }
});

test('wrong lease, job kind, tenant or payload cannot spend consent; exact successful duplicate lease replay has no effects', async () => {
  const f = await crossingFixture(),
    job = await claim(f.run),
    before = await snapshot();
  for (const bad of [
    { ...job, lease_token: randomUUID() },
    { ...job, tenant_id: randomUUID() },
    { ...job, payload: { run_id: randomUUID() } },
  ]) {
    await processOutcome(bad);
    assert.deepEqual(await snapshot(), before);
  }
  await pool.query("UPDATE jobs SET kind='order.operation' WHERE id=$1", [job.id]);
  const wrongKind = await snapshot();
  await processOutcome(job);
  assert.deepEqual(await snapshot(), wrongKind);
  await pool.query("UPDATE jobs SET kind='replenishment.automation' WHERE id=$1", [job.id]);
  const winners = await Promise.all([processOutcome(job), processOutcome(job)]);
  assert(
    winners.every((r) => r.ok),
    winners.map((r) => String(r.error)).join(','),
  );
  assert.equal(winners.filter((r) => (r.result as Row)?.state === 'done').length, 1);
  const done = await rawRun(f.run.id);
  assert.equal(done.state, 'done');
  assert.equal(
    Number(
      (await pool.query('SELECT count(*) n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
        .rows[0].n,
    ),
    1,
  );
  const after = await snapshot();
  await processOutcome(job);
  assert.deepEqual(await snapshot(), after);
  assert.equal(providerCalls, 0);
});

test('source pending quota backpressure rolls stock, movement, audit and outbox back instead of dropping crossing', async () => {
  const p = await product({ quantity: 20 });
  await policy(p);
  const r = await rule([p]);
  // Actual trigger admission 200 times, without fabricated run/job rows or a reduced production quota.
  await tenantTx(tenant, async (c) => {
    for (let i = 0; i < 200; i++) {
      await c.query(
        'UPDATE stock SET on_hand=19 WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [tenant, p.id, warehouse],
      );
      await c.query(
        'UPDATE stock SET on_hand=20 WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [tenant, p.id, warehouse],
      );
    }
  });
  const n = Number(
    (
      await pool.query(
        "SELECT count(*) n FROM replenishment_automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND state='queued'",
        [tenant, r.id],
      )
    ).rows[0].n,
  );
  assert.equal(n, 200);
  const before = await snapshot(),
    response = await adjust(p, -1);
  assert.equal(response.statusCode, 429, response.body);
  assert.deepEqual(await snapshot(), before);
  await assertNoPurchases();
});

test('late source admission wait rechecks actual actor for create, patch and cancel instead of using HTTP role snapshot', async () => {
  const f = await crossingFixture();
  for (const kind of ['create', 'patch', 'cancel']) {
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'purchasing.source:' + tenant,
      ]);
      pending =
        kind === 'create'
          ? request(automation + '/rules', 'POST', ruleBody([f.p.id]))
          : kind === 'patch'
            ? request(automation + '/rules/' + f.rule.id, 'PATCH', {
                version: f.rule.version,
                name: 'New revision',
                definition: f.rule.definition,
                confirmed_future_drafts: true,
              })
            : request(automation + '/runs/' + f.run.id + '/cancel', 'POST', {
                version: f.run.version,
                client_key: randomUUID(),
              });
      await waitOn(holder, /purchasing_source_admit/i);
      await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      const response = await pending;
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending;
      await grantChange("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
    }
  }
});

test('disabled rule, revised rule and revised policy never spend a stale queued future consent', async () => {
  for (const kind of ['disabled', 'rule_revision', 'policy_revision']) {
    const f = await crossingFixture();
    if (kind === 'policy_revision')
      await ok(prefix + '/policies/' + f.pol.id, 'PATCH', {
        version: f.pol.version,
        definition: definition({ target_quantity: 45 }),
      });
    else
      await ok(automation + '/rules/' + f.rule.id, 'PATCH', {
        version: f.rule.version,
        name: 'Changed approval',
        definition: { ...f.rule.definition, enabled: kind !== 'disabled' },
        ...(kind === 'disabled' ? {} : { confirmed_future_drafts: true }),
      });
    const job = await claim(f.run);
    const outcome = await processOutcome(job);
    assert.equal(outcome.ok, true, String(outcome.error));
    const run = await rawRun(f.run.id);
    assert.equal(run.state, 'skipped');
    await assertNoPurchases();
  }
});

test('run history is immutable, fake app source INSERT is denied, own RLS hides foreign runs and rule-items need genuine matching policy', async () => {
  const f = await crossingFixture(),
    before = await snapshot();
  await assert.rejects(
    appSql(
      'INSERT INTO replenishment_automation_runs SELECT * FROM replenishment_automation_runs WHERE id=$1',
      [f.run.id],
    ),
    (e: any) => e.code === '42501',
  );
  await assert.rejects(
    appSql('DELETE FROM replenishment_automation_rule_items WHERE rule_id=$1', [f.rule.id]),
    (e: any) => e.code === '23514',
  );
  const foreign = randomUUID();
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Other synthetic tenant')", [foreign]);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
    for (const table of [tableRules, 'replenishment_automation_rule_items', tableRuns])
      assert.equal(
        (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenant])).rowCount,
        0,
      );
    await c.query('ROLLBACK');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  assert.deepEqual(await snapshot(), before);
  const job = await claim(f.run);
  assert.equal((await processOutcome(job)).ok, true);
  const terminal = await snapshot();
  for (const sql of [
    "UPDATE replenishment_automation_runs SET result='{}' WHERE id=$1",
    'DELETE FROM replenishment_automation_runs WHERE id=$1',
  ]) {
    await assert.rejects(pool.query(sql, [f.run.id]), (e: any) => e.code === '23514');
    assert.deepEqual(await snapshot(), terminal);
  }
  const rls = (
    await pool.query(
      'SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
      [[tableRules, 'replenishment_automation_rule_items', tableRuns]],
    )
  ).rows;
  assert.equal(rls.length, 3);
  assert(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  const unrelated = await product({ quantity: 30 }),
    unrelatedPolicy = await policy(unrelated),
    beforeForgery = await snapshot();
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      await c.query('DELETE FROM replenishment_automation_rule_items WHERE rule_id=$1', [
        f.rule.id,
      ]);
      await c.query(
        'INSERT INTO replenishment_automation_rule_items(tenant_id,rule_id,product_id,policy_id,policy_version,product_version) VALUES($1,$2,$3,$4,$5,$6)',
        [tenant, f.rule.id, f.p.id, unrelatedPolicy.id, unrelatedPolicy.version, f.p.version],
      );
    }),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(), beforeForgery);
});

const privateCostKeys = new Set([
  'unit_cost_minor',
  'line_total_minor',
  'total_minor',
  'total_before_minor',
  'total_after_minor',
  'unit_cost',
  'unit_cost_decimal',
  'cost_valid_until',
  'cost_confirmed_at',
]);
function assertCostsHidden(v: any) {
  if (!v || typeof v !== 'object') return;
  for (const [k, value] of Object.entries(v)) {
    if (privateCostKeys.has(k)) assert.equal(value, null, `private ${k}`);
    else assertCostsHidden(value);
  }
}
test('viewer and public read scopes have deeply redacted results; write-only or incomplete keys cannot configure future drafts', async () => {
  const f = await crossingFixture(),
    job = await claim(f.run);
  assert.equal((await processOutcome(job)).ok, true);
  const read = await key(readScopes),
    writeOnly = await key(['purchasing:write']),
    partial = await key(['products:read', 'purchasing:read', 'purchasing:write']);
  const ownRun = await ok(automation + '/runs/' + f.run.id);
  assert.equal(ownRun.can_read_value, true);
  const privatePreview = await ok(prefix + '/previews/' + ownRun.run.result.preview_id);
  assertCostsHidden(
    await ok(prefix + '/previews/' + ownRun.run.result.preview_id, 'GET', undefined, viewer),
  );
  assert.equal(privatePreview.can_read_value, true);
  assert.equal(
    Number(
      (await pool.query('SELECT count(*) n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
        .rows[0].n,
    ),
    1,
  );
  const before = await snapshot();
  for (const path of [automation + '/runs', automation + '/runs/' + f.run.id]) {
    const v = await ok(path, 'GET', undefined, viewer);
    assert.equal(v.can_read_value, false);
    assert.equal(v.can_manage, false);
    assertCostsHidden(v);
    const readable = await publicRequest(read.token, path);
    assert.equal(readable.statusCode, 200, readable.body);
    assert.equal(readable.json().can_manage, false);
    const wrong = await publicRequest(writeOnly.token, path);
    assert.equal(wrong.statusCode, 403, wrong.body);
  }
  for (const token of [read.token, writeOnly.token, partial.token]) {
    const denied = await publicRequest(token, automation + '/rules', 'POST', ruleBody([f.p.id]));
    assert.equal(denied.statusCode, 403, denied.body);
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('read-only rejects every malformed write before parse and absent capture capability leaves manual replenishment usable', async () => {
  const f = await crossingFixture(),
    readonly = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    const cookie = await login('admin@demo.local', readonly),
      sw = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie, readonly);
    assert.equal(sw.statusCode, 200, sw.body);
    const own = String(sw.headers['set-cookie']).split(';')[0],
      before = await snapshot();
    for (const [path, method] of [
      [automation + '/rules', 'POST'],
      [automation + '/rules/' + f.rule.id, 'PATCH'],
      [automation + '/runs/' + f.run.id + '/cancel', 'POST'],
    ]) {
      const r = await request(path, method, '{', own, readonly, {
        'content-type': 'application/json',
      });
      assert.equal(r.statusCode, 423, r.body);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    const read = await request(automation + '/runs/' + f.run.id, 'GET', undefined, own, readonly);
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().read_only, true);
    assert.equal(read.json().can_manage, false);
    assert.equal(read.json().run.can_cancel, false);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await readonly.close();
  }
  // Renaming a function preserves its trigger's OID. This only simulates capability detection, not executing a broken old schema.
  await pool.query(
    'ALTER FUNCTION replenishment_automation_capture() RENAME TO automation_capture_unavailable',
  );
  let older: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    older = await buildApp({ integrationTransport: transport });
    const options = await request(automation + '/options', 'GET', undefined, admin, older);
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().available, false);
    assert.equal(options.json().can_manage, false);
    const before = await snapshot(),
      denied = await request(automation + '/rules', 'POST', ruleBody([f.p.id]), admin, older);
    assert.equal(denied.statusCode, 503, denied.body);
    assert.deepEqual(await snapshot(), before);
    const legacy = await request(prefix + '/options', 'GET', undefined, admin, older);
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.equal(legacy.json().available, true);
  } finally {
    await older?.close();
    await pool.query(
      'ALTER FUNCTION automation_capture_unavailable() RENAME TO replenishment_automation_capture',
    );
  }
});

test('a two-product rule purchases only the actual crossing and never catches up an already-low unrelated product', async () => {
  const a = await product({ quantity: 30 }),
    b = await product({ quantity: 10 });
  await policy(a);
  await policy(b);
  const r = await rule([a, b]);
  assert.equal(
    Number(
      (
        await pool.query('SELECT count(*) n FROM replenishment_automation_runs WHERE rule_id=$1', [
          r.id,
        ])
      ).rows[0].n,
    ),
    0,
  );
  const response = await adjust(a, -11);
  assert.equal(response.statusCode, 200, response.body);
  const run = (
    await pool.query('SELECT * FROM replenishment_automation_runs WHERE rule_id=$1', [r.id])
  ).rows[0];
  assert.deepEqual(
    run.crossings.map((c: Row) => c.product_id),
    [a.id],
  );
  assert.equal((await processOutcome(await claim(run))).ok, true);
  const done = await rawRun(run.id);
  assert.equal(done.state, 'done');
  const p = (
    await pool.query('SELECT * FROM replenishment_previews WHERE id=$1', [done.result.preview_id])
  ).rows[0];
  assert.deepEqual(
    p.config.items.map((i: Row) => i.product_id),
    [a.id],
  );
  const lines = (
    await pool.query(
      'SELECT product_id,quantity FROM purchase_order_lines WHERE tenant_id=$1 ORDER BY product_id',
      [tenant],
    )
  ).rows;
  assert.deepEqual(lines, [{ product_id: a.id, quantity: 21 }]);
  const stock = (
    await pool.query(
      'SELECT product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY product_id',
      [tenant, warehouse],
    )
  ).rows;
  assert.deepEqual(
    stock,
    [
      { product_id: a.id, on_hand: 19, reserved: 0 },
      { product_id: b.id, on_hand: 10, reserved: 0 },
    ].sort((x, y) => x.product_id.localeCompare(y.product_id)),
  );
  assert.equal(providerCalls, 0);
});

test('an authentic manual execution of an unrelated product cannot be forged into a captured automatic run receipt', async () => {
  const f = await crossingFixture(),
    p = await product({ quantity: 10 }),
    pol = await policy(p),
    planned = await preview(selection([p], [pol])),
    response = await execute(planned);
  assert.equal(response.statusCode, 201, response.body);
  const executed = response.json().execution,
    before = await snapshot();
  assert.equal((await rawRun(f.run.id)).state, 'queued');
  await assert.rejects(
    appSql(
      "UPDATE replenishment_automation_runs SET version=version+1,state='done',result=$2,finished_at=clock_timestamp() WHERE id=$1",
      [
        f.run.id,
        JSON.stringify({
          preview_id: planned.id,
          execution_id: executed.id,
          purchase_order_ids: executed.groups.map((g: Row) => g.purchase_order_id),
        }),
      ],
    ),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(), before);
});
