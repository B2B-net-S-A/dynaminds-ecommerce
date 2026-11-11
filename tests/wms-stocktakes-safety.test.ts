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
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
const prefix = '/wms-lots/stocktakes';
const evidence = [
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_scope_layers',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'wms_stocktake_reviews',
  'wms_stocktake_review_rows',
  'wms_stocktake_postings',
];
const physical = [
  'products',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'wms_operations',
  'warehouse_documents',
  'warehouse_document_lines',
  'payment_entries',
  'order_events',
  'audit_events',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  adminId = '',
  ip = 1,
  calls = 0;
const cookies = new Map<string, string>();
const transport = async () => {
  ++calls;
  throw Error('Stocktake tests must never call providers');
};
const req = (
  path: string,
  method: any = 'GET',
  body?: any,
  auth = cookies.get('admin@demo.local')!,
  target = app,
  headers: Record<string, string> = {},
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie: auth, ...headers },
    remoteAddress: '127.0.121.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, auth?: string, target = app) {
  const r = await req(path, method, body, auth, target);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode}`);
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
});
beforeEach(async () => {
  ++ip;
  calls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Stocktake safety','enterprise')", [
    tenant,
  ]);
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role)
    SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END
    FROM users WHERE email=ANY($2::text[])`,
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Counted warehouse','COUNT')",
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
async function snapshot(names = [...physical, ...evidence]) {
  const out: Record<string, unknown> = {};
  for (const name of names)
    out[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return out;
}
async function setup(quantity = 11, cost: string | null = '317') {
  const p = await ok('/products', 'POST', {
    sku: 'COUNT-' + randomUUID(),
    name: 'Counted physical product',
    price: 1000,
    warehouse_id: warehouse,
    quantity,
    location: 'A-01',
  });
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
    note: 'Known controlled opening',
    lines: [
      {
        warehouse_id: warehouse,
        product_id: p.id,
        location: 'A-01',
        quantity,
        stock_version: version,
        lot_code: 'COUNTED-LOT',
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
  const create = {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    name: 'Blind physical stocktake',
    policy_version: '1',
    blind: true,
  };
  const { stocktake } = await ok(prefix, 'POST', create);
  const lines = (await ok(prefix + '/' + stocktake.id + '/lines')).data;
  assert.equal(lines.length, 1);
  return { p, stocktake, line: lines[0], create };
}
const countBody = (line: any, quantity: number) => ({
  client_key: randomUUID(),
  note: 'Physical operator measurement',
  lines: [{ id: line.id, version: line.version, basis_token: line.basis_token, quantity }],
});
async function ready(f: Awaited<ReturnType<typeof setup>>, quantity = 10) {
  const count = countBody(f.line, quantity);
  await ok(prefix + '/' + f.stocktake.id + '/counts', 'POST', count);
  const head = (await ok(prefix + '/' + f.stocktake.id)).stocktake;
  const body = {
    client_key: randomUUID(),
    version: head.version,
    note: 'Approve exact counted shortage',
    surplus: [],
  };
  const { review } = await ok(prefix + '/' + head.id + '/reviews', 'POST', body);
  assert.equal(review.ready, true);
  const current = (await ok(prefix + '/' + head.id)).stocktake;
  const post = {
    client_key: randomUUID(),
    version: current.version,
    review_id: review.id,
    scope_hash: review.scope_hash,
    confirmed: true,
  };
  return { ...f, count, review, reviewBody: body, post };
}
// The request first spends its schema preflight (10-18 s on a loaded PG04 without the startup
// gate) before it reaches the held row; wait for that exact row-lock edge, not a fixed 3 s.
async function waitOn(c: PoolClient, pattern: RegExp, pending: ReturnType<typeof req>) {
  await waitForLockEdge(pool, { blocker: await backendPid(c), query: pattern }, [pending]);
}
async function withdraw(sql: string, args: unknown[]) {
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
async function blocked(
  lockSql: string,
  args: unknown[],
  request: () => ReturnType<typeof req>,
  change: string,
  changeArgs: unknown[],
  status: number,
) {
  const old = await snapshot(),
    c = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  try {
    await c.query('BEGIN');
    await c.query(lockSql, args);
    pending = request();
    await waitOn(c, /\bstock\b|wms_stocktakes|\busers\b/i, pending);
    await withdraw(change, changeArgs);
    await c.query('COMMIT');
    assert.equal((await pending).statusCode, status);
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending;
  }
  assert.deepEqual(await snapshot(), old);
  assert.equal(calls, 0);
}
function hidden(value: any) {
  if (Array.isArray(value)) {
    for (const row of value) hidden(row);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(
      !/^(original_quantity|basis_quantity|expected_quantity|current_quantity|warehouse_on_hand|reserved|difference|delta|changed|unit_cost_minor|known_minor|unknown_quantity|layer_id|layer_ids|layers|basis|snapshot)$/.test(
        key,
      ),
      'Blind/read-only projection leaked ' + key,
    );
    hidden(child);
  }
}

test('blind lines and measurement replay/history hide physical bases and costs from operator/viewer', async () => {
  const f = await setup(),
    operator = cookies.get('operator@demo.local')!,
    viewer = cookies.get('viewer@demo.local')!;
  for (const auth of [operator, viewer])
    hidden(await ok(prefix + '/' + f.stocktake.id + '/lines', 'GET', undefined, auth));
  const operatorLine = (
    await ok(prefix + '/' + f.stocktake.id + '/lines', 'GET', undefined, operator)
  ).data[0];
  const before = await snapshot(physical),
    body = countBody(operatorLine, 7);
  const first = await ok(prefix + '/' + f.stocktake.id + '/counts', 'POST', body, operator);
  hidden(first);
  const measured = await snapshot();
  const replay = await ok(prefix + '/' + f.stocktake.id + '/counts', 'POST', body, operator);
  assert.equal(replay.reused, true);
  hidden(replay);
  assert.deepEqual(await snapshot(), measured);
  for (const auth of [operator, viewer])
    hidden(await ok(prefix + '/' + f.stocktake.id + '/measurements', 'GET', undefined, auth));
  // Counting is observational: only local audit, never physical mutations.
  const afterPhysical = await snapshot(physical.filter((name) => name !== 'audit_events'));
  const { audit_events: _, ...oldPhysical } = before;
  assert.deepEqual(afterPhysical, oldPhysical);
});
test('post waits on actual stock, allows membership withdrawal to commit, and rolls back all tentative corrections', async () => {
  const f = await ready(await setup());
  await blocked(
    'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
    [tenant, f.p.id],
    () => req(prefix + '/' + f.stocktake.id + '/post', 'POST', f.post),
    "UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2",
    [tenant, adminId],
    403,
  );
});
test('blind counting rechecks operator after a real physical basis wait and saves no denied measurement', async () => {
  const f = await setup(),
    actor = (await pool.query("SELECT id FROM users WHERE email='operator@demo.local'")).rows[0].id;
  const operatorLine = (
    await ok(
      prefix + '/' + f.stocktake.id + '/lines',
      'GET',
      undefined,
      cookies.get('operator@demo.local'),
    )
  ).data[0];
  await blocked(
    'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
    [tenant, f.p.id],
    () =>
      req(
        prefix + '/' + f.stocktake.id + '/counts',
        'POST',
        countBody(operatorLine, 8),
        cookies.get('operator@demo.local'),
      ),
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
    [tenant, actor],
    403,
  );
});
test('create cannot pin membership before actor FK wait and denied scope consumes no evidence/quota/audit', async () => {
  const f = await setup();
  await ok(prefix + '/' + f.stocktake.id + '/cancel', 'POST', {
    client_key: randomUUID(),
    version: f.stocktake.version,
    note: 'End initial controlled count',
  });
  await blocked(
    'SELECT * FROM users WHERE id=$1 FOR UPDATE',
    [adminId],
    () => req(prefix, 'POST', { ...f.create, client_key: randomUUID() }),
    "UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2",
    [tenant, adminId],
    403,
  );
});
test(
  'public post rechecks revocation expiry and cost scopes after actual stock wait',
  { timeout: 600000 },
  async () => {
    const f = await ready(await setup());
    for (const mode of ['revoked', 'expired', 'scope']) {
      const key = await ok('/developer/keys', 'POST', {
        name: 'Stocktake ' + mode,
        scopes: ['inventory:read', 'inventory:write', 'purchasing:read', 'purchasing:write'],
      });
      const change =
        mode === 'revoked'
          ? 'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1'
          : mode === 'expired'
            ? "UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1"
            : "UPDATE api_keys SET scopes=ARRAY['inventory:read','inventory:write','purchasing:read']::text[] WHERE id=$1";
      await blocked(
        'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
        [tenant, f.p.id],
        () =>
          req('/v1' + prefix + '/' + f.stocktake.id + '/post', 'POST', f.post, '', app, {
            authorization: 'Bearer ' + key.token,
          }),
        change,
        [key.id],
        mode === 'scope' ? 403 : 401,
      );
    }
  },
);
test('frozen admin review replay cannot disclose value after current role changes', async () => {
  const f = await ready(await setup(), 11);
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    adminId,
  ]);
  const before = await snapshot();
  const retry = await req(prefix + '/' + f.stocktake.id + '/reviews', 'POST', f.reviewBody);
  assert.equal(retry.statusCode, 403);
  hidden(retry.json());
  const detail = await req(prefix + '/' + f.stocktake.id + '/reviews/' + f.review.id);
  assert([200, 403].includes(detail.statusCode));
  hidden(detail.json());
  assert.deepEqual(await snapshot(), before);
});
test('read-only public key is revalidated after actual stock read wait', async () => {
  const f = await setup(),
    key = await ok('/developer/keys', 'POST', {
      name: 'Current inventory read grant',
      scopes: ['inventory:read', 'purchasing:read'],
    });
  const r = await req('/v1' + prefix + '/' + f.stocktake.id + '/lines', 'GET', undefined, '', app, {
    authorization: 'Bearer ' + key.token,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  await blocked(
    'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
    [tenant, f.p.id],
    () =>
      req('/v1' + prefix + '/' + f.stocktake.id + '/lines', 'GET', undefined, '', app, {
        authorization: 'Bearer ' + key.token,
      }),
    "UPDATE api_keys SET scopes=ARRAY['purchasing:read']::text[] WHERE id=$1",
    [key.id],
    403,
  );
});
test('ABA physical bin moves invalidate post despite restored quantities; an entire approval is rolled back', async () => {
  const f = await ready(await setup());
  for (const [location, destination_location] of [
    ['A-01', 'B-01'],
    ['B-01', 'A-01'],
  ]) {
    const version = String(
      (
        await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
          tenant,
          f.p.id,
        ])
      ).rows[0].version,
    );
    const { preview } = await ok('/wms-lots/movement-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '1',
      kind: 'bin_move',
      product_id: f.p.id,
      warehouse_id: warehouse,
      location,
      destination_location,
      quantity: 1,
      stock_versions: [{ warehouse_id: warehouse, product_id: f.p.id, version }],
      note: 'Actual ABA physical movement',
    });
    await ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', {
      client_key: randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true,
    });
  }
  const before = await snapshot();
  assert.equal(
    (await req(prefix + '/' + f.stocktake.id + '/post', 'POST', f.post)).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
});
test('one stale product in a two-product review rolls back every correction and immutable posting', async () => {
  const f = await setup(),
    q = await ok('/products', 'POST', {
      sku: 'LAST-' + randomUUID(),
      name: 'Last stale product',
      price: 999,
      warehouse_id: warehouse,
      quantity: 0,
      location: 'A-01',
    });
  const version = String(
    (
      await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        q.id,
      ])
    ).rows[0].version,
  );
  await ok('/wms-lots/receipts', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    warehouse_id: warehouse,
    stock_versions: [{ warehouse_id: warehouse, product_id: q.id, version }],
    confirmed: true,
    note: 'Second scoped physical product',
    lines: [
      {
        product_id: q.id,
        location: 'A-01',
        quantity: 2,
        lot_code: 'LAST-LOT',
        unit_cost_minor: '17',
        currency: 'PLN',
      },
    ],
  });
  await ok(prefix + '/' + f.stocktake.id + '/cancel', 'POST', {
    client_key: randomUUID(),
    version: f.stocktake.version,
    note: 'Replace with complete two-product scope',
  });
  const { stocktake } = await ok(prefix, 'POST', { ...f.create, client_key: randomUUID() });
  const lines = (await ok(prefix + '/' + stocktake.id + '/lines')).data;
  assert.equal(lines.length, 2);
  await ok(prefix + '/' + stocktake.id + '/counts', 'POST', {
    client_key: randomUUID(),
    note: 'Count both physical products',
    lines: lines.map((line: any) => ({
      id: line.id,
      version: line.version,
      basis_token: line.basis_token,
      quantity: line.product_id === f.p.id ? 10 : 1,
    })),
  });
  const head = (await ok(prefix + '/' + stocktake.id)).stocktake;
  const { review } = await ok(prefix + '/' + stocktake.id + '/reviews', 'POST', {
    client_key: randomUUID(),
    version: head.version,
    note: 'Approve both shortages',
    surplus: [],
  });
  assert.equal(review.ready, true);
  const current = (await ok(prefix + '/' + head.id)).stocktake;
  const currentVersion = String(
    (
      await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        q.id,
      ])
    ).rows[0].version,
  );
  const { preview } = await ok('/wms-lots/movement-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    kind: 'bin_move',
    product_id: q.id,
    warehouse_id: warehouse,
    location: 'A-01',
    destination_location: 'B-01',
    quantity: 1,
    stock_versions: [{ warehouse_id: warehouse, product_id: q.id, version: currentVersion }],
    note: 'Invalidate only last reviewed product',
  });
  await ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
  });
  const before = await snapshot();
  assert.equal(
    (
      await req(prefix + '/' + head.id + '/post', 'POST', {
        client_key: randomUUID(),
        version: current.version,
        review_id: review.id,
        scope_hash: review.scope_hash,
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
});
test('post replay is canonical and immutable: changed body or actor cannot add journal/value/order effects', async () => {
  const f = await ready(await setup()),
    first = await ok(prefix + '/' + f.stocktake.id + '/post', 'POST', f.post),
    before = await snapshot();
  const retry = await ok(prefix + '/' + f.stocktake.id + '/post', 'POST', {
    confirmed: true,
    scope_hash: f.post.scope_hash,
    review_id: f.post.review_id,
    version: f.post.version,
    client_key: f.post.client_key,
  });
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.posting, first.posting);
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (
      await req(prefix + '/' + f.stocktake.id + '/post', 'POST', {
        ...f.post,
        scope_hash: 'a'.repeat(64),
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
  const reviewRows = await ok(prefix + '/' + f.stocktake.id + '/reviews/' + f.review.id + '/rows');
  assert(reviewRows.data.length > 0);
  for (const name of evidence) {
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
    await assert.rejects(
      pool.query(`DELETE FROM ${name} WHERE tenant_id=$1`, [tenant]),
      (e: any) => e.code === '23514',
      name,
    );
  }
  for (const name of [
    'wms_stocktake_measurements',
    'wms_stocktake_measurement_layers',
    'wms_stocktake_reviews',
    'wms_stocktake_review_rows',
    'wms_stocktake_postings',
  ])
    await assert.rejects(
      pool.query(`UPDATE ${name} SET tenant_id=tenant_id WHERE tenant_id=$1`, [tenant]),
      (e: any) => e.code === '23514',
      name,
    );
  assert.deepEqual(await snapshot(), before);
});
test('scope layers cannot be appended from another real lot of the same product after scope freeze', async () => {
  const f = await setup(),
    version = String(
      (
        await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
          tenant,
          f.p.id,
        ])
      ).rows[0].version,
    );
  await ok('/wms-lots/receipts', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    warehouse_id: warehouse,
    stock_versions: [{ warehouse_id: warehouse, product_id: f.p.id, version }],
    confirmed: true,
    note: 'Later distinct real physical lot',
    lines: [
      {
        product_id: f.p.id,
        location: 'A-01',
        quantity: 2,
        lot_code: 'NOT-IN-ORIGINAL-SCOPE',
        unit_cost_minor: '9',
        currency: 'PLN',
      },
    ],
  });
  const layer = (
    await pool.query(
      'SELECT * FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2 ORDER BY fifo_sequence DESC LIMIT 1',
      [tenant, f.p.id],
    )
  ).rows[0];
  const original = (
    await pool.query('SELECT * FROM wms_stocktake_scope_layers WHERE tenant_id=$1 AND line_id=$2', [
      tenant,
      f.line.id,
    ])
  ).rows[0];
  assert.notEqual(layer.id, original.layer_id);
  const before = await snapshot();
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query(
        `INSERT INTO wms_stocktake_scope_layers(tenant_id,stocktake_id,line_id,product_id,layer_id,original)
    VALUES($1,$2,$3,$4,$5,$6)`,
        [tenant, f.stocktake.id, f.line.id, f.p.id, layer.id, JSON.stringify(original.original)],
      ),
    ),
    (error: any) => error.code === '23514',
  );
  assert.deepEqual(await snapshot(), before);
});
test('line identity and measurement scope reject foreign product or unrelated line without partial count', async () => {
  const f = await setup(),
    before = await snapshot();
  const foreign = (
    await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
  ).rows[0].id;
  await assert.rejects(
    pool.query('UPDATE wms_stocktake_lines SET product_id=$1,version=version+1 WHERE id=$2', [
      foreign,
      f.line.id,
    ]),
    (error: any) => error.code === '23514',
  );
  const body = countBody(f.line, 7);
  body.lines.push({ ...body.lines[0], id: randomUUID() });
  const response = await req(prefix + '/' + f.stocktake.id + '/counts', 'POST', body);
  assert([404, 409, 422].includes(response.statusCode));
  assert.deepEqual(await snapshot(), before);
});
test('real open-stocktake quota rejects new scope but exact original replay remains effect-free', async () => {
  const f = await setup(),
    lot = (
      await pool.query('SELECT lot_id FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        f.p.id,
      ])
    ).rows[0].lot_id;
  let lastWarehouse = '';
  for (let i = 0; i < 20; i++) {
    lastWarehouse = randomUUID();
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
      lastWarehouse,
      tenant,
      'Explicit discovered scope ' + i,
      'QUOTA-' + i,
    ]);
    if (i < 19)
      await ok(prefix, 'POST', {
        client_key: randomUUID(),
        warehouse_id: lastWarehouse,
        name: 'Explicit discovery quota ' + i,
        policy_version: '1',
        blind: true,
        discoveries: [
          { product_id: f.p.id, location: 'A-01', lot: { kind: 'existing', lot_id: lot } },
        ],
      });
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM wms_stocktakes WHERE tenant_id=$1 AND state IN('counting','review')",
        [tenant],
      )
    ).rows[0].n,
    20,
  );
  const before = await snapshot(),
    replay = await ok(prefix, 'POST', f.create);
  assert.equal(replay.reused, true);
  assert.equal(replay.stocktake.id, f.stocktake.id);
  assert.deepEqual(await snapshot(), before);
  const overflow = await req(prefix, 'POST', {
    client_key: randomUUID(),
    warehouse_id: lastWarehouse,
    name: 'Twenty first explicit discovery',
    policy_version: '1',
    blind: true,
    discoveries: [{ product_id: f.p.id, location: 'A-01', lot: { kind: 'existing', lot_id: lot } }],
  });
  assert.equal(overflow.statusCode, 429);
  assert.deepEqual(await snapshot(), before);
  assert.equal(calls, 0);
});
test('actor-bound opaque basis and UTF8 request byte cap reject without storing hidden input or partial measurements', async () => {
  const f = await setup(),
    before = await snapshot();
  assert.equal(
    (
      await req(
        prefix + '/' + f.stocktake.id + '/counts',
        'POST',
        countBody(f.line, 7),
        cookies.get('operator@demo.local'),
      )
    ).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
  const oversized = { ...countBody(f.line, 7), note: '😀'.repeat(524288) };
  const response = await req(prefix + '/' + f.stocktake.id + '/counts', 'POST', oversized);
  assert.equal(response.statusCode, 413);
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (
      await req(prefix + '/' + f.stocktake.id + '/counts', 'POST', {
        ...countBody(f.line, 7),
        expected_quantity: 11,
      })
    ).statusCode,
    422,
  );
  assert.deepEqual(await snapshot(), before);
});
test('read-only and historical absence precede parsing; installed149 dependency damage fails closed while legacy product reads survive', async () => {
  let readonly: Awaited<ReturnType<typeof buildApp>> | undefined,
    older: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    readonly = await buildApp({
      readOnly: true,
      previewPort: 4112,
      integrationTransport: transport,
    });
    const auth = await login('admin@demo.local', readonly),
      meta = await ok(prefix + '/metadata', 'GET', undefined, auth, readonly);
    assert.equal(meta.read_only, true);
    for (const key of ['can_create', 'can_count', 'can_review', 'can_post'])
      assert.equal(meta[key], false, key);
    const r = await readonly.inject({
      url: '/api' + prefix,
      method: 'POST',
      headers: { cookie: auth, 'content-type': 'application/json' },
      payload: '{bad',
    });
    assert.equal(r.statusCode, 423);
    assert.match(String(r.headers['cache-control']), /no-store/);
    const installed149 = (await pool.query("SELECT to_regprocedure('public.stocktake_adjustment_installed()') present")).rows[0].present !== null;
    const before = await snapshot();
    const adjustmentTables = ['series','series_commands','counters','previews','preview_rows','admissions','receipts','documents','document_rows'];
    const adjustmentSnapshot = async () => Object.fromEntries(await Promise.all(adjustmentTables.map(async name => [name,
      (await pool.query(`SELECT to_jsonb(x) row FROM public.stocktake_adjustment_${name} x WHERE tenant_id=$1 ORDER BY 1`, [tenant])).rows,
    ])));
    const oldAdjustments = installed149 ? await adjustmentSnapshot() : null;
    await pool.query('ALTER TABLE wms_stocktakes RENAME TO wms_stocktakes_safety_missing');
    if (installed149) {
      // Renaming a typed149 dependency tears its sealed FK/trigger manifest.
      // It cannot represent a historical installation without the module.
      await assert.rejects(buildApp({ integrationTransport: transport }), (e: any) => e.status === 503);
      assert.equal((await req(prefix + '/metadata')).statusCode, 503);
      assert.equal((await req('/products')).statusCode, 200);
      for (const path of ['/stocktake-adjustments/previews','/v1/stocktake-adjustments/previews']) {
        const write = await req(path, 'POST', '{bad', undefined, app, { 'content-type':'application/json' });
        assert.equal(write.statusCode, 503, 'Fresh149 probe rejects dependency damage before malformed body parsing with a valid session');
        assert.match(String(write.headers['cache-control']), /no-store/);
      }
      await pool.query('ALTER TABLE wms_stocktakes_safety_missing RENAME TO wms_stocktakes');
      assert.equal((await pool.query('SELECT public.stocktake_adjustment_guards() ok')).rows[0].ok, true);
      assert.equal((await ok(prefix + '/metadata')).available, true);
      assert.deepEqual(await snapshot(), before, 'Rejected torn operations preserve all own legacy business rows');
      assert.deepEqual(await adjustmentSnapshot(), oldAdjustments, 'No149 receipt, number or document from damaged dependency');
    } else {
      older = await buildApp({ integrationTransport: transport });
      const oldAuth = await login('admin@demo.local', older);
      const oldMeta = await ok(prefix + '/metadata', 'GET', undefined, oldAuth, older);
      assert.equal(oldMeta.available, false);
      const write = await older.inject({
        url: '/api' + prefix,
        method: 'POST',
        headers: { cookie: oldAuth, 'content-type': 'application/json' },
        payload: '{bad',
      });
      assert.equal(write.statusCode, 503);
      assert.equal((await req('/products', 'GET', undefined, oldAuth, older)).statusCode, 200);
    }
  } finally {
    await older?.close();
    await readonly?.close();
    if (
      (await pool.query("SELECT to_regclass('public.wms_stocktakes_safety_missing') present"))
        .rows[0].present
    )
      await pool.query('ALTER TABLE wms_stocktakes_safety_missing RENAME TO wms_stocktakes');
  }
});
