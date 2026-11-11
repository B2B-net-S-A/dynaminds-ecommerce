import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { appendPurchaseDraft } from '../server/purchasing';

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
    remoteAddress: '127.0.180.' + ip,
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
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Append adversarial','enterprise')",
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

async function draft(lines: Row[], extra: Row = {}) {
  return ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'PLN',
      note: 'Keep private draft note',
      reference: 'Original reference',
      expected_date: '2027-01-12',
      lines: lines.map((p) => ({
        product_id: p.id,
        quantity: 3,
        unit_cost: 317,
        supplier_sku: 'LOCAL-317',
      })),
      ...extra,
    },
    admin,
    201,
  );
}
const target = (po: Row, extra: Row = {}) => ({
  supplier_id: po.supplier_id,
  currency: po.currency,
  purchase_order_id: po.id,
  version: po.version,
  ...extra,
});
async function appendFixture() {
  const f = await fixture(),
    unrelated = await product(),
    po = await draft([f.p, unrelated]);
  return { ...f, unrelated, po, body: { ...f.body, draft_targets: [target(po)] } };
}
async function rawPO(id: string) {
  return {
    head: (await pool.query('SELECT to_jsonb(t) row FROM purchase_orders t WHERE id=$1', [id]))
      .rows[0].row,
    lines: (
      await pool.query(
        'SELECT to_jsonb(t) row FROM purchase_order_lines t WHERE order_id=$1 ORDER BY product_id',
        [id],
      )
    ).rows.map((r) => r.row),
  };
}
async function assertRefused(p: Row, before: Row) {
  const r = await execute(p);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(await snapshot(), before);
}

test('strict draft targets reject duplicate document/pair, extra client snapshot and invalid version without effects', async () => {
  const f = await appendFixture(),
    before = await snapshot();
  for (const targets of [
    [target(f.po), target(f.po)],
    [target(f.po), target(f.po, { purchase_order_id: randomUUID() })],
    [target(f.po, { version: 0 })],
    [target(f.po, { version: 1.5 })],
    [target(f.po, { before_snapshot: { head: f.po } })],
    [target(f.po, { currency: 'INVALID' })],
  ]) {
    const r = await request(prefix + '/previews', 'POST', { ...f.body, draft_targets: targets });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(await snapshot(), before);
});

test('raw unrelated-line/head mutation and restored-value ABA invalidate whole approved append without silently creating a new PO', async () => {
  const f = await appendFixture();
  for (const change of ['head', 'line', 'headABA', 'lineABA']) {
    const current = await ok('/purchase-orders/' + f.po.id),
      p = await preview({ ...f.body, client_key: randomUUID(), draft_targets: [target(current)] });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (change.startsWith('head')) {
        const note = current.note;
        await c.query('UPDATE purchase_orders SET note=$2 WHERE id=$1', [
          f.po.id,
          note + ' changed',
        ]);
        if (change === 'headABA')
          await c.query('UPDATE purchase_orders SET note=$2 WHERE id=$1', [f.po.id, note]);
      } else {
        await c.query(
          'UPDATE purchase_order_lines SET quantity=quantity+1 WHERE order_id=$1 AND product_id=$2',
          [f.po.id, f.unrelated.id],
        );
        if (change === 'lineABA')
          await c.query(
            'UPDATE purchase_order_lines SET quantity=quantity-1 WHERE order_id=$1 AND product_id=$2',
            [f.po.id, f.unrelated.id],
          );
      }
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await assertRefused(p, await snapshot());
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
        .rows[0].n,
      1,
    );
  }
  assert.equal(providerCalls, 0);
});

test('placed draft or version change after consent blocks append and mixed groups all roll back', async () => {
  const f = await appendFixture(),
    secondSupplier = await ok(
      '/suppliers',
      'POST',
      { name: 'Other own supplier', code: 'APP-' + randomUUID() },
      admin,
      201,
    ),
    second = await product();
  const secondPolicy = await policy(second, { supplier_id: secondSupplier.id });
  const body = {
      ...selection([f.p, second], [f.pol, secondPolicy]),
      draft_targets: [target(f.po)],
    },
    p = await preview(body);
  await ok('/purchase-orders/' + f.po.id + '/place', 'POST', { version: f.po.version });
  const before = await snapshot();
  await assertRefused(p, before);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM replenishment_executions WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
});

test('append replay is frozen after a later ordinary draft edit and preserves unrelated lines and metadata at commit', async () => {
  const f = await appendFixture(),
    original = await rawPO(f.po.id),
    p = await preview(f.body),
    body = consent(p),
    r = await execute(p, body);
  assert.equal(r.statusCode, 201, r.body);
  const after = await rawPO(f.po.id);
  for (const field of Object.keys(original.head))
    if (!['version', 'updated_at'].includes(field))
      assert.deepEqual(after.head[field], original.head[field], field);
  assert.equal(after.head.version, original.head.version + 1);
  assert.deepEqual(
    after.lines.find((l: Row) => l.product_id === f.unrelated.id),
    original.lines.find((l: Row) => l.product_id === f.unrelated.id),
  );
  const oldLine = original.lines.find((l: Row) => l.product_id === f.p.id),
    newLine = after.lines.find((l: Row) => l.product_id === f.p.id);
  assert(newLine.quantity > oldLine.quantity);
  for (const field of Object.keys(oldLine))
    if (field !== 'quantity') assert.deepEqual(newLine[field], oldLine[field], field);
  const edited = await ok('/purchase-orders/' + f.po.id, 'PATCH', {
    version: after.head.version,
    supplier_id: supplier,
    warehouse_id: warehouse,
    currency: 'PLN',
    note: 'Later explicit edit',
    reference: 'Later reference',
    expected_date: '2027-02-02',
    lines: after.lines.map((l: Row) => ({
      product_id: l.product_id,
      quantity: l.quantity + 1,
      unit_cost: l.unit_cost,
      supplier_sku: l.supplier_sku,
    })),
  });
  assert.equal(edited.version, after.head.version + 1);
  const before = await snapshot(),
    retry = await execute(p, body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().reused, true);
  assert.equal(retry.json().execution.id, r.json().execution.id);
  assert.equal((await execute(p, { ...body, scope_hash: '0'.repeat(64) })).statusCode, 409);
  assert.equal((await execute(p, body, other)).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test(
  'preview waiting on actual target draft permits current admin withdrawal and rolls back all preview/audit evidence',
  { timeout: 20000 },
  async () => {
    const f = await appendFixture(),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [f.po.id]);
      pending = request(prefix + '/previews', 'POST', f.body);
      await waitOn(holder, /purchase_orders[\s\S]*FOR SHARE/i);
      await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      const r = await pending;
      assert.equal(r.statusCode, 403, r.body);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'append execution rechecks revoke, expiry and purchasing/inventory scopes after actual draft wait',
  { timeout: 30000 },
  async () => {
    for (const change of ['revoke', 'expiry', 'read', 'write']) {
      const f = await appendFixture(),
        credential = await key(writeScopes),
        r = await publicRequest(credential.token, prefix + '/previews', 'POST', f.body);
      assert.equal(r.statusCode, 201, r.body);
      const p = r.json().preview,
        before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof request> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [f.po.id]);
        pending = publicRequest(
          credential.token,
          prefix + '/previews/' + p.id + '/execute',
          'POST',
          consent(p),
        );
        await waitOn(holder, /purchase_orders[\s\S]*FOR (SHARE|UPDATE)/i);
        await grantChange(
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
        );
        await holder.query('COMMIT');
        const denied = await pending;
        assert.equal(
          denied.statusCode,
          ['revoke', 'expiry'].includes(change) ? 401 : 403,
          denied.body,
        );
        assert.deepEqual(await snapshot(), before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
      }
    }
  },
);

test('draft picker and full target preview redact costs deeply for viewers; public read keys cannot append', async () => {
  const f = await appendFixture(),
    p = await preview(f.body),
    read = await key(readScopes),
    before = await snapshot();
  for (const path of [
    prefix + '/drafts?warehouse_id=' + warehouse + '&supplier_id=' + supplier + '&currency=PLN',
    prefix + '/previews/' + p.id,
    prefix + '/previews/' + p.id + '/rows',
  ]) {
    const r = await request(path, 'GET', undefined, viewer);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.json().can_read_value, false);
    for (const field of [
      'unit_cost',
      'unit_cost_minor',
      'line_total_minor',
      'total_minor',
      'total_before_minor',
      'total_after_minor',
      'total_value',
      'received_value',
      'cost_confirmed_at',
      'cost_valid_until',
    ])
      assert(!r.body.includes('"' + field + '"'), field + ' leaked in ' + path);
    const publicRead = await publicRequest(read.token, path);
    assert.equal(publicRead.statusCode, 200, publicRead.body);
  }
  assert.equal(
    (await request(prefix + '/previews', 'POST', { ...f.body, client_key: randomUUID() }, viewer))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await publicRequest(read.token, prefix + '/previews', 'POST', {
        ...f.body,
        client_key: randomUUID(),
      })
    ).statusCode,
    403,
  );
  assert.deepEqual(await snapshot(), before);
});

test('foreign draft, wrong supplier/currency and stale target version fail without any fallback or leaked foreign data', async () => {
  const f = await appendFixture(),
    foreignTenant = randomUUID(),
    foreignWarehouse = randomUUID(),
    foreignSupplier = randomUUID(),
    foreignPO = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Synthetic foreign append','enterprise')",
    [foreignTenant],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Foreign','FOREIGN-APPEND')",
    [foreignWarehouse, foreignTenant],
  );
  await pool.query(
    "INSERT INTO suppliers(id,tenant_id,name,code) VALUES($1,$2,'Foreign confidential supplier','FOREIGN-APPEND')",
    [foreignSupplier, foreignTenant],
  );
  await pool.query(
    `INSERT INTO purchase_orders(id,tenant_id,number,supplier_id,warehouse_id,currency,supplier_snapshot,created_by,note)
    VALUES($1,$2,'FOREIGN-SECRET-PO',$3,$4,'PLN','{}',$5,'Foreign confidential note')`,
    [foreignPO, foreignTenant, foreignSupplier, foreignWarehouse, adminId],
  );
  const before = await snapshot();
  for (const [entry, status] of [
    [target(f.po, { purchase_order_id: foreignPO }), 422],
    [target(f.po, { currency: 'EUR' }), 422],
    [target(f.po, { supplier_id: randomUUID() }), 422],
    [target(f.po, { version: f.po.version + 1 }), 409],
  ] as [Row, number][]) {
    const r = await request(prefix + '/previews', 'POST', {
      ...f.body,
      client_key: randomUUID(),
      draft_targets: [entry],
    });
    assert.equal(r.statusCode, status, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
    for (const hidden of [
      'FOREIGN-SECRET-PO',
      'Foreign confidential note',
      'Foreign confidential supplier',
    ])
      assert(!r.body.includes(hidden));
    assert.deepEqual(await snapshot(), before);
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM purchase_orders WHERE id=$1', [foreignPO]))
        .rows[0].n,
      0,
    );
    await assert.rejects(
      c.query('SELECT * FROM replenishment_append_preparations WHERE tenant_id=$1', [
        foreignTenant,
      ]),
      { code: '42501' },
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('original generated-PO link remains immutable when a later plan appends to that draft', async () => {
  const f = await fixture(),
    initial = await preview(f.body),
    r = await execute(initial);
  assert.equal(r.statusCode, 201, r.body);
  const generated = (
    await pool.query('SELECT id FROM purchase_orders WHERE replenishment_execution_id=$1', [
      r.json().execution.id,
    ])
  ).rows[0].id;
  const original = await rawPO(generated);
  // A second physical product needs additional stock; target is the existing
  // generated draft, whose first origin must never become the second plan.
  const second = await product(),
    secondPolicy = await policy(second);
  const body = { ...selection([second], [secondPolicy]), draft_targets: [target(original.head)] },
    p = await preview(body),
    done = await execute(p);
  assert.equal(done.statusCode, 201, done.body);
  const after = await rawPO(generated);
  assert.equal(after.head.replenishment_execution_id, original.head.replenishment_execution_id);
  assert.equal(after.head.replenishment_group_index, original.head.replenishment_group_index);
  assert.equal(after.head.version, original.head.version + 1);
  assert.deepEqual(
    after.lines.find((l: Row) => l.product_id === f.p.id),
    original.lines[0],
  );
  assert.equal(after.lines.length, 2);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    1,
  );
  assert.equal(providerCalls, 0);
});

test('SQL cannot inject an append receipt without current-xid private preparation and cannot access the collector as application', async () => {
  const f = await appendFixture(),
    p = await preview(f.body),
    before = await snapshot(),
    c = await pool.connect();
  const h = (await pool.query('SELECT * FROM replenishment_previews WHERE id=$1', [p.id])).rows[0];
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await assert.rejects(c.query('SELECT * FROM replenishment_append_preparations'), {
      code: '42501',
    });
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await assert.rejects(
      c.query(
        `INSERT INTO replenishment_append_preparations(transaction_id,tenant_id,execution_id,preview_id,group_index,purchase_order_id,before_snapshot)
      VALUES(pg_current_xact_id(),$1,$2,$3,0,$4,'{}')`,
        [tenant, randomUUID(), p.id, f.po.id],
      ),
      { code: '42501' },
    );
    await c.query('ROLLBACK');
    // Genuine own ready preview, actor, frozen summary and scope. The missing
    // private preparation is the rejected boundary, rather than a foreign FK.
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await assert.rejects(
      async () => {
        await c.query(
          `INSERT INTO replenishment_executions(id,tenant_id,preview_id,actor_id,source,client_key,request_hash,warehouse_id,scope_hash,before_source_version,after_source_version,summary,groups)
        VALUES($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9,$9,$10,$11)`,
          [
            randomUUID(),
            tenant,
            p.id,
            adminId,
            randomUUID(),
            'a'.repeat(64),
            warehouse,
            p.scope_hash,
            h.source_version,
            JSON.stringify(h.summary),
            JSON.stringify(
              h.groups.map((g: Row) => ({
                ...g,
                purchase_order_id: f.po.id,
                number: f.po.number,
                version: f.po.version + 1,
              })),
            ),
          ],
        );
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      },
      { code: '23514' },
    );
    await c.query('ROLLBACK');
    const empty = (
      await pool.query('SELECT count(*)::int n FROM replenishment_append_preparations')
    ).rows[0].n;
    assert.equal(empty, 0);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('missing append capability preserves old preview literal hashes and manual execution; read-only blocks malformed writes before parse', async () => {
  const f = await appendFixture(),
    legacy = await preview({ ...selection([f.p], [f.pol]), client_key: randomUUID() }),
    p = await preview(f.body);
  const legacyRow = (
    await pool.query('SELECT to_jsonb(t) row FROM replenishment_previews t WHERE id=$1', [
      legacy.id,
    ])
  ).rows[0].row;
  assert.equal(Object.hasOwn(legacyRow.config, 'draft_targets'), false);
  const readonly = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    const cookie = await login('admin@demo.local', readonly),
      switcher = await request(
        '/workspaces/switch',
        'POST',
        { tenant_id: tenant },
        cookie,
        readonly,
      );
    assert.equal(switcher.statusCode, 200, switcher.body);
    const own = String(switcher.headers['set-cookie']).split(';')[0],
      before = await snapshot();
    for (const path of [prefix + '/previews', prefix + '/previews/' + p.id + '/execute']) {
      const r = await request(path, 'POST', '{', own, readonly, {
        'content-type': 'application/json',
      });
      assert.equal(r.statusCode, 423, r.body);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    const read = await request(prefix + '/previews/' + p.id, 'GET', undefined, own, readonly);
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().read_only, true);
    assert.equal(read.json().can_execute, false);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await readonly.close();
  }
  await pool.query(
    'ALTER FUNCTION replenishment_append_prepare(uuid,uuid,integer) RENAME TO append_prepare_unavailable',
  );
  let older: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    older = await buildApp({ integrationTransport: transport });
    const options = await request(prefix + '/options', 'GET', undefined, admin, older);
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().available, true);
    assert.equal(options.json().append_available, false);
    const before = await snapshot(),
      unavailable = await request(
        prefix + '/previews',
        'POST',
        { ...f.body, client_key: randomUUID() },
        admin,
        older,
      );
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.deepEqual(await snapshot(), before);
    const done = await request(
      prefix + '/previews/' + legacy.id + '/execute',
      'POST',
      consent(legacy),
      admin,
      older,
    );
    assert.equal(done.statusCode, 201, done.body);
    assert.deepEqual(
      (
        await pool.query('SELECT to_jsonb(t) row FROM replenishment_previews t WHERE id=$1', [
          legacy.id,
        ])
      ).rows[0].row,
      legacyRow,
    );
  } finally {
    await older?.close();
    await pool.query(
      'ALTER FUNCTION append_prepare_unavailable(uuid,uuid,integer) RENAME TO replenishment_append_prepare',
    );
  }
});

test(
  'valid append made in a savepoint remains sealed after immediate proof flush; later same-transaction source writes roll back the complete chain',
  { timeout: 20000 },
  async () => {
    const f = await appendFixture(),
      p = await preview(f.body),
      before = await snapshot();
    const h = (await pool.query('SELECT * FROM replenishment_previews WHERE id=$1', [p.id]))
      .rows[0];
    const rows = (
      await pool.query('SELECT * FROM replenishment_rows WHERE preview_id=$1 ORDER BY index', [
        p.id,
      ])
    ).rows;
    const executionId = randomUUID(),
      g = h.groups[0];
    let completeProofValidated = false;
    assert.equal(g.destination.kind, 'existing_draft');
    await assert.rejects(
      tenantTx(
        tenant,
        async (c) => {
          // INSERT execution under a genuine subtransaction exposes an xmin-only
          // seal bypass. The private seal must instead use the current top xid8.
          await c.query('SAVEPOINT actual_append');
          const po = await appendPurchaseDraft(
            c,
            { tenantId: tenant, userId: adminId, role: 'admin' },
            {
              id: f.po.id,
              version: f.po.version,
              preview_id: p.id,
              execution_id: executionId,
              group_index: g.index,
              lines: rows
                .filter((r) => r.status === 'purchase')
                .map((r) => ({
                  product_id: r.product_id,
                  quantity: Number(r.result.recommended_quantity),
                  unit_cost: r.result.unit_cost_minor,
                  supplier_sku: r.snapshot.policy.supplier_sku,
                })),
            },
          );
          const afterEpoch = (await c.query('SELECT purchasing_source_version()::text n')).rows[0]
            .n;
          await c.query(
            `INSERT INTO replenishment_executions(id,tenant_id,preview_id,actor_id,source,client_key,request_hash,warehouse_id,scope_hash,before_source_version,after_source_version,summary,groups)
          VALUES($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              executionId,
              tenant,
              p.id,
              adminId,
              randomUUID(),
              'b'.repeat(64),
              warehouse,
              p.scope_hash,
              h.source_version,
              afterEpoch,
              JSON.stringify(h.summary),
              JSON.stringify([
                { ...g, purchase_order_id: po.id, number: po.number, version: po.version },
              ]),
            ],
          );
          for (const row of rows) {
            await c.query(
              `INSERT INTO replenishment_execution_rows
            SELECT (jsonb_populate_record(NULL::replenishment_execution_rows,$1::jsonb)).*`,
              [
                JSON.stringify({
                  ...row,
                  id: randomUUID(),
                  execution_id: executionId,
                  preview_row_id: row.id,
                  purchase_order_id: row.status === 'purchase' ? po.id : null,
                }),
              ],
            );
          }
          // Genuine full-after validation must succeed before testing the seal.
          await c.query('SET CONSTRAINTS ALL IMMEDIATE');
          completeProofValidated = true;
          await c.query('RELEASE SAVEPOINT actual_append');
          await c.query(
            'UPDATE purchase_order_lines SET quantity=quantity+1 WHERE order_id=$1 AND product_id=$2',
            [f.po.id, f.unrelated.id],
          );
        },
        { purchasingAdmission: true, wmsAdmission: 'read' },
      ),
      { code: '23514' },
    );
    assert.equal(
      completeProofValidated,
      true,
      'the genuine full append must validate before the deliberately forbidden late write',
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM replenishment_append_preparations WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(providerCalls, 0);
  },
);

test('restored historic private seal with reused xid8 and an older transaction clock never blocks a new transaction', async () => {
  const f = await appendFixture(),
    p = await preview(f.body),
    r = await execute(p);
  assert.equal(r.statusCode, 201, r.body);
  const before = await snapshot(),
    c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    // Explicit owner-only restore simulation in guarded disposable DB. Change
    // only this genuine seal, re-enable immutability before testing the live
    // source trigger, and roll back both fixture and writes at the end.
    await c.query('ALTER TABLE replenishment_append_seals DISABLE TRIGGER immutable');
    const changed = await c.query(
      `UPDATE replenishment_append_seals SET transaction_id=pg_current_xact_id(),
      transaction_started_at=transaction_timestamp()-interval '1 day'
      WHERE tenant_id=$1 AND execution_id=$2`,
      [tenant, r.json().execution.id],
    );
    assert.equal(changed.rowCount, 1);
    await c.query('ALTER TABLE replenishment_append_seals ENABLE TRIGGER immutable');
    await c.query('SET LOCAL ROLE dyna_app');
    const write = await c.query('UPDATE purchase_orders SET note=note WHERE id=$1', [f.po.id]);
    assert.equal(write.rowCount, 1);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('ROLLBACK');
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await pool.query(
          `SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.replenishment_append_seals'::regclass AND tgname='immutable'`,
        )
      ).rows[0].tgenabled,
      'O',
    );
  } finally {
    // ALTER TABLE changes are transactional, including a failure before ENABLE.
    await c.query('ROLLBACK');
    c.release();
  }
});
