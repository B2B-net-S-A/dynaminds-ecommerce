import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { processOrderFieldBatchJob } from '../server/order-field-batches';
import { parseOrderFieldBatchCsv } from '../server/order-field-batches-csv';

assert.equal(process.env.DYNA_TEST, 'true');
const testUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(testUrl.hostname));
assert.match(testUrl.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  user: string,
  ip = 100;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});

async function fixture() {
  const tenant = randomUUID(),
    warehouse = randomUUID(),
    address = '127.0.41.' + ++ip;
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Field batches safety QA','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Batch safety','BSAFETY')",
    [warehouse, tenant],
  );
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    remoteAddress: address,
  });
  assert.equal(login.statusCode, 200, login.body);
  let cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await app.inject({
    url: '/api/workspaces/switch',
    method: 'POST',
    payload: { tenant_id: tenant },
    headers: { cookie },
    remoteAddress: address,
  });
  assert.equal(switched.statusCode, 200, switched.body);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  const req = (
    path: string,
    method: any = 'GET',
    payload?: any,
    target = app,
    headers: Record<string, string> = { cookie },
  ) =>
    target.inject({
      url: '/api' + path,
      method,
      payload,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      remoteAddress: address,
    });
  const ok = async (path: string, method: any = 'GET', payload?: any, status = 200) => {
    const r = await req(path, method, payload);
    assert.equal(r.statusCode, status, r.body);
    return r.json() as any;
  };
  const product = await ok(
    '/products',
    'POST',
    {
      sku: 'BSAFE-' + randomUUID(),
      name: 'Batch safety product',
      price: 1000,
      quantity: 500,
      warehouse_id: warehouse,
    },
    201,
  );
  const first = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Batch safety',
      email: 'batch-safety@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: product.id, quantity: 1 }],
    },
    201,
  );
  const orders = async (count: number) => {
    if (count > 1)
      await pool.query(
        "INSERT INTO orders(id,tenant_id,number,source,customer_name,email,address,currency,total,shipping_cost,warehouse_id,portal_token) SELECT gen_random_uuid(),tenant_id,number||'-'||i,'manual',customer_name,email,address,currency,total,shipping_cost,warehouse_id,gen_random_uuid() FROM orders CROSS JOIN generate_series(1,$2::int) i WHERE id=$1",
        [first.id, count - 1],
      );
    return (
      await pool.query(
        'SELECT id,version::float8 version FROM orders WHERE tenant_id=$1 ORDER BY id',
        [tenant],
      )
    ).rows;
  };
  const field = (extra: any = {}) =>
    ok(
      '/order-fields',
      'POST',
      {
        client_key: randomUUID(),
        key: 'b_' + randomUUID().replaceAll('-', ''),
        label: 'Batch safety field',
        type: 'text',
        ...extra,
      },
      201,
    );
  const preview = async (d: any, selected: any[], value = 'batch local', policy = 'fill_unset') =>
    ok(
      '/order-field-batches/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'bulk',
        policy,
        orders: selected.map((o) => ({ order_id: o.id, order_version: Number(o.version) })),
        changes: [{ field_id: d.id, definition_version: d.version, type: d.type, value }],
      },
      201,
    );
  const rows = async (p: any) => {
    const result = [...p.data];
    let cursor = p.meta.cursor;
    while (cursor) {
      const page = await ok(
        '/order-field-batches/previews/' + p.id + '?cursor=' + encodeURIComponent(cursor),
      );
      result.push(...page.data);
      cursor = page.meta.cursor;
    }
    return result;
  };
  const queueBody = (p: any, selected: any[]) => ({
    client_key: randomUUID(),
    selected_rows: selected.map((r) => r.row_id),
    consent: {
      scope_hash: p.scope_hash,
      selected_count: selected.length,
      policy: p.policy,
      local_only: true,
    },
  });
  const queue = async (p: any) =>
    (
      await ok(
        '/order-field-batches/previews/' + p.id + '/queue',
        'POST',
        queueBody(p, await rows(p)),
        201,
      )
    ).execution;
  const key = async (scopes: string[]) =>
    (await ok('/developer/keys', 'POST', { name: 'Batch scope QA', scopes }, 201)).token as string;
  const api = (path: string, token: string, method: any = 'GET', payload?: any, target = app) =>
    target.inject({
      url: '/api/v1/order-field-batches' + path,
      method,
      payload,
      headers: { authorization: 'Bearer ' + token },
      remoteAddress: address,
    });
  return {
    tenant,
    warehouse,
    product,
    first,
    orders,
    field,
    req,
    ok,
    preview,
    rows,
    queueBody,
    queue,
    key,
    api,
    cookie,
  };
}

const coreTables = [
  'orders',
  'order_items',
  'stock',
  'payment_entries',
  'order_events',
  'order_local_financial_fences',
  'order_field_values',
  'order_field_value_events',
];
async function snapshot(tenant: string, admission = false) {
  const result: Record<string, unknown> = {};
  const tables = admission
    ? [
        ...coreTables,
        'jobs',
        'audit_events',
        'order_field_batch_previews',
        'order_field_batch_rows',
        'order_field_batch_executions',
        'order_field_batch_execution_rows',
      ]
    : coreTables;
  for (const table of tables)
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
        [tenant],
      )
    ).rows;
  if (!admission)
    result.otherJobs = (
      await pool.query(
        "SELECT to_jsonb(j) row FROM jobs j WHERE tenant_id=$1 AND kind<>'order.fields.batch' ORDER BY id",
        [tenant],
      )
    ).rows;
  return result;
}
async function waitOn(holder: number, count = 1) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const rows = (
      await pool.query(
        "SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [holder],
      )
    ).rows;
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('No actual database lock wait was observed');
}
async function withdraw(tenant: string, role = 'viewer') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
      tenant,
      user,
      role,
    ]);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function claim(execution: string) {
  const r = await pool.query(
    "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=attempts+1 WHERE id=(SELECT job_id FROM order_field_batch_executions WHERE id=$1) RETURNING *",
    [execution, randomUUID()],
  );
  assert.equal(r.rowCount, 1);
  return r.rows[0];
}

test(
  'queue waits on the last of 100 orders without locking membership; role withdrawal rolls back admission',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      d = await f.field(),
      selected = await f.orders(100),
      p = await f.preview(d, selected),
      body = f.queueBody(p, await f.rows(p)),
      before = await snapshot(f.tenant, true),
      holder = await pool.connect();
    let pending: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [selected.at(-1)!.id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = f.req('/order-field-batches/previews/' + p.id + '/queue', 'POST', body);
      assert.match((await waitOn(pid))[0].query, /orders.*FOR UPDATE/);
      await withdraw(f.tenant);
      await waitOn(pid);
      await holder.query('COMMIT');
      const r = await pending;
      assert.equal(r.statusCode, 403, r.body);
      assert.deepEqual(await snapshot(f.tenant, true), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'worker waits on the last of 100 orders before final grant; withdrawn actor changes no field/order/financial/provider evidence',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      d = await f.field(),
      selected = await f.orders(100),
      p = await f.preview(d, selected),
      e = await f.queue(p),
      job = await claim(e.id),
      before = await snapshot(f.tenant),
      holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [selected.at(-1)!.id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = processOrderFieldBatchJob(job);
      assert.match((await waitOn(pid))[0].query, /orders.*FOR UPDATE/);
      await withdraw(f.tenant);
      await waitOn(pid);
      await holder.query('COMMIT');
      await pending;
      const state = (
        await pool.query('SELECT state FROM order_field_batch_executions WHERE id=$1', [e.id])
      ).rows[0].state;
      assert(['conflict', 'failed'].includes(state), state);
      assert.deepEqual(await snapshot(f.tenant), before);
      assert.equal(
        (await pool.query('SELECT lease_token FROM jobs WHERE id=$1', [job.id])).rows[0]
          .lease_token,
        null,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'stale last order after queue rolls back all 100; valid worker commit is local and duplicate/stale lease adds nothing',
  { timeout: 20000 },
  async () => {
    const f = await fixture(),
      d = await f.field(),
      selected = await f.orders(100),
      p = await f.preview(d, selected),
      e = await f.queue(p);
    await pool.query('UPDATE orders SET updated_at=now() WHERE id=$1', [selected.at(-1)!.id]);
    const before = await snapshot(f.tenant),
      job = await claim(e.id);
    await processOrderFieldBatchJob(job);
    assert.equal(
      (await pool.query('SELECT state FROM order_field_batch_executions WHERE id=$1', [e.id]))
        .rows[0].state,
      'conflict',
    );
    assert.deepEqual(await snapshot(f.tenant), before);
    const control = await fixture(),
      field = await control.field(),
      orders = await control.orders(2),
      preview = await control.preview(field, orders),
      execution = await control.queue(preview),
      claimed = await claim(execution.id);
    await processOrderFieldBatchJob(claimed);
    assert.equal(
      (
        await pool.query('SELECT state FROM order_field_batch_executions WHERE id=$1', [
          execution.id,
        ])
      ).rows[0].state,
      'done',
    );
    const values = (
      await pool.query(
        'SELECT source,payload FROM order_field_values WHERE tenant_id=$1 ORDER BY order_id',
        [control.tenant],
      )
    ).rows;
    assert.equal(values.length, 2);
    assert(values.every((v) => v.source === 'manual' && v.payload.value === 'batch local'));
    const committed = await snapshot(control.tenant, true);
    await processOrderFieldBatchJob(claimed);
    await processOrderFieldBatchJob({ ...claimed, lease_token: randomUUID() });
    assert.deepEqual(await snapshot(control.tenant, true), committed);
  },
);

test(
  'history/detail and export wait before current grant; changed field ACL blocks all frozen private before/after',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      d = await f.field({ read_role: 'admin', write_role: 'admin' }),
      orders = await f.orders(1),
      p = await f.preview(d, orders, 'PRIVATE-BATCH-SENTINEL'),
      e = await f.queue(p),
      holder = await pool.connect();
    const before = await snapshot(f.tenant, true);
    let detail: ReturnType<typeof f.req> | undefined,
      history: ReturnType<typeof f.req> | undefined,
      exported: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'order-fields:' + f.tenant,
      ]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      detail = f.req('/order-field-batches/previews/' + p.id);
      history = f.req('/order-field-batches/executions/' + e.id);
      exported = f.req(
        '/order-field-batches/export?mode=csv_exact&field_ids=' +
          encodeURIComponent(JSON.stringify([d.id])) +
          '&order_ids=' +
          encodeURIComponent(JSON.stringify([orders[0].id])),
      );
      assert((await waitOn(pid, 3)).every((r) => /pg_advisory_xact_lock_shared/.test(r.query)));
      await withdraw(f.tenant, 'operator');
      await waitOn(pid, 3);
      await holder.query('COMMIT');
      for (const pending of [detail, history, exported]) {
        const r = await pending;
        assert.equal(r.statusCode, 403, r.body);
        assert(!r.body.includes('PRIVATE-BATCH-SENTINEL'));
      }
      assert.deepEqual(await snapshot(f.tenant, true), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await Promise.all([detail, history, exported]);
    }
  },
);

test(
  'exact export observes matching values/version committed during its actual order wait and refreshes the role',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      d = await f.field(),
      order = f.first;
    await f.ok('/orders/' + order.id + '/fields', 'PATCH', {
      client_key: randomUUID(),
      order_version: Number(order.version),
      changes: [
        { field_id: d.id, definition_version: d.version, type: 'text', value: 'before wait' },
      ],
    });
    const holder = await pool.connect();
    let pending: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      const changed = (
        await holder.query(
          'UPDATE orders SET updated_at=now() WHERE id=$1 RETURNING version::float8 version',
          [order.id],
        )
      ).rows[0];
      await holder.query(
        "UPDATE order_field_values SET payload=jsonb_set(payload,'{value}',$3::jsonb),text_value=$4 WHERE order_id=$1 AND field_id=$2",
        [order.id, d.id, JSON.stringify('after wait'), 'after wait'],
      );
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = f.req(
        '/order-field-batches/export?mode=json&field_ids=' +
          encodeURIComponent(JSON.stringify([d.id])) +
          '&order_ids=' +
          encodeURIComponent(JSON.stringify([order.id])),
      );
      assert.match((await waitOn(pid))[0].query, /orders.*FOR SHARE/);
      await withdraw(f.tenant, 'operator');
      await waitOn(pid);
      await holder.query('COMMIT');
      const baseline = await snapshot(f.tenant, true),
        response = await pending;
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().current_role, 'operator');
      const exported = JSON.parse(Buffer.from(response.json().content_base64, 'base64').toString());
      assert.equal(exported.data[0].order_version, changed.version);
      assert.equal(exported.data[0].fields[0].value.value, 'after wait');
      assert.deepEqual(await snapshot(f.tenant, true), baseline);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test('historical field visibility is recomputed after a team definition becomes admin-only', async () => {
  const f = await fixture(),
    d = await f.field(),
    orders = await f.orders(1),
    p = await f.preview(d, orders, 'PRIVATE-REVISED-FROZEN'),
    e = await f.queue(p);
  await f.ok('/order-fields/' + d.id, 'PATCH', {
    version: d.version,
    label: d.label,
    enabled: d.enabled,
    display: d.display,
    position: d.position,
    read_role: 'admin',
    write_role: 'admin',
    required_on: d.required_on,
    config: d.config,
    options: d.options,
  });
  await withdraw(f.tenant, 'operator');
  for (const path of ['/previews/' + p.id, '/executions/' + e.id]) {
    const r = await f.req('/order-field-batches' + path);
    assert.equal(r.statusCode, 403, r.body);
    assert(!r.body.includes('PRIVATE-REVISED-FROZEN'));
  }
});

test('raw SQL preserves preview selection FKs, immutable terminal evidence and non-null CSV/order-version invariants', async () => {
  const f = await fixture(),
    d = await f.field(),
    orders = await f.orders(1),
    p = await f.preview(d, orders),
    e = await f.queue(p),
    second = await f.preview(d, orders),
    foreignRow = (await f.rows(second))[0];
  await assert.rejects(
    tenantTx(f.tenant, (c) =>
      c.query(
        'INSERT INTO order_field_batch_execution_rows(tenant_id,execution_id,preview_id,row_id) VALUES($1,$2,$3,$4)',
        [f.tenant, e.id, second.id, foreignRow.row_id],
      ),
    ),
    /foreign key constraint/,
  );
  await assert.rejects(
    pool.query('UPDATE order_field_batch_rows SET snapshot=snapshot WHERE preview_id=$1', [p.id]),
    /append-only/,
  );
  await assert.rejects(
    pool.query('UPDATE order_field_batch_previews SET summary=summary WHERE id=$1', [p.id]),
    /append-only/,
  );
  await assert.rejects(
    tenantTx(f.tenant, (c) =>
      c.query(
        "INSERT INTO order_field_batch_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,kind,policy,source,definitions_snapshot,config,filename,encrypted_bytes,summary,expires_at) SELECT $2,tenant_id,actor_id,$3,request_hash,scope_hash,'csv',policy,'csv_import',definitions_snapshot,'{}','null-metadata.csv','encrypted-placeholder',summary,expires_at FROM order_field_batch_previews WHERE id=$1",
        [p.id, randomUUID(), randomUUID()],
      ),
    ),
    /check constraint/,
  );
  await assert.rejects(
    tenantTx(f.tenant, (c) =>
      c.query(
        "INSERT INTO order_field_batch_rows(id,tenant_id,preview_id,position,order_id,status,snapshot) VALUES($1,$2,$3,4999,$4,'ready','{}')",
        [randomUUID(), f.tenant, p.id, orders[0].id],
      ),
    ),
    /check constraint/,
  );
  await f.ok('/order-field-batches/executions/' + e.id + '/cancel', 'POST', {});
  await assert.rejects(
    tenantTx(f.tenant, (c) =>
      c.query("UPDATE order_field_batch_executions SET state='done',result='{}' WHERE id=$1", [
        e.id,
      ]),
    ),
    /terminal result are immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE order_field_batch_executions SET consent='{}' WHERE id=$1", [e.id]),
    /scope and terminal result are immutable/,
  );
  const other = randomUUID();
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Foreign batches safety')", [other]);
  await tenantTx(other, async (c) => {
    for (const table of [
      'order_field_batch_previews',
      'order_field_batch_rows',
      'order_field_batch_executions',
      'order_field_batch_execution_rows',
    ])
      assert.equal(
        (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [f.tenant])).rowCount,
        0,
        table,
      );
  });
});

test('CSV accepts legal surrogate-escaped full text and malformed encoding returns a client error', async () => {
  const f = await fixture(),
    d = await f.field(),
    config = {
      encoding: 'utf-8' as const,
      delimiter: ',' as const,
      header: true as const,
      identity: { kind: 'order_id' as const, column: 0 },
      order_version_column: 1,
      fields: [{ column: 2, field_id: d.id, definition_version: 1 }],
    };
  const cell = '{"operation":"set","value":"' + '\\ud83d\\ude00'.repeat(4000) + '"}',
    quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  const bytes = Buffer.from('order_id,order_version,field\n' + f.first.id + ',1,' + quote(cell));
  const parsed = parseOrderFieldBatchCsv(bytes, config);
  assert.equal([...JSON.parse(parsed.rows[0][2]).value].length, 4000);
  const good = await f.ok(
    '/order-field-batches/previews',
    'POST',
    {
      client_key: randomUUID(),
      kind: 'csv',
      policy: 'fill_unset',
      filename: 'escaped.csv',
      content_base64: bytes.toString('base64'),
      config,
    },
    201,
  );
  assert.equal(good.summary.ready, 1);
  const bad = await f.req('/order-field-batches/previews', 'POST', {
    client_key: randomUUID(),
    kind: 'csv',
    policy: 'fill_unset',
    filename: 'bad-utf8.csv',
    content_base64: Buffer.from([0xc3, 0x28]).toString('base64'),
    config,
  });
  assert.equal(bad.statusCode, 422, bad.body);
});

test('worker rejects an own selection row appended after exact one-row consent', async () => {
  const f = await fixture(),
    d = await f.field(),
    orders = await f.orders(2),
    p = await f.preview(d, orders),
    rows = await f.rows(p);
  const queued = await f.ok(
    '/order-field-batches/previews/' + p.id + '/queue',
    'POST',
    f.queueBody(p, [rows[0]]),
    201,
  );
  const e = queued.execution;
  await tenantTx(f.tenant, (c) =>
    c.query(
      'INSERT INTO order_field_batch_execution_rows(tenant_id,execution_id,preview_id,row_id) VALUES($1,$2,$3,$4)',
      [f.tenant, e.id, p.id, rows[1].row_id],
    ),
  );
  const before = await snapshot(f.tenant);
  await processOrderFieldBatchJob(await claim(e.id));
  assert.equal(
    (await pool.query('SELECT state FROM order_field_batch_executions WHERE id=$1', [e.id])).rows[0]
      .state,
    'conflict',
  );
  assert.deepEqual(await snapshot(f.tenant), before);
});

test('public mutation needs read and write scopes, export stays read-only and unavailable/readonly guards precede parsing', async () => {
  const f = await fixture(),
    d = await f.field(),
    orders = await f.orders(1),
    p = await f.preview(d, orders),
    rows = await f.rows(p),
    body = f.queueBody(p, rows),
    read = await f.key(['order-fields:read']),
    write = await f.key(['order-fields:write']),
    both = await f.key(['order-fields:read', 'order-fields:write']);
  for (const token of [read, write]) {
    const r = await f.api('/previews/' + p.id + '/queue', token, 'POST', body);
    assert.equal(r.statusCode, 403, r.body);
  }
  assert.equal((await f.api('/previews/' + p.id, write)).statusCode, 403);
  const queued = await f.api('/previews/' + p.id + '/queue', both, 'POST', body);
  assert.equal(queued.statusCode, 201, queued.body);
  const query =
    '/export?mode=csv_exact&field_ids=' +
    encodeURIComponent(JSON.stringify([d.id])) +
    '&order_ids=' +
    encodeURIComponent(JSON.stringify([orders[0].id]));
  const before = await snapshot(f.tenant, true),
    exported = await f.api(query, read);
  assert.equal(exported.statusCode, 200, exported.body);
  assert.deepEqual(await snapshot(f.tenant, true), before, 'GET export has no stored effects');
  const readonly = await buildApp({ readOnly: true, previewPort: 4103 });
  try {
    assert.equal((await f.api(query, read, 'GET', undefined, readonly)).statusCode, 200);
    for (const path of [
      '/previews',
      '/previews/' + p.id + '/queue',
      '/executions/' + queued.json().execution.id + '/cancel',
    ]) {
      const r = await f.api(path, both, 'POST', { malformed: true }, readonly);
      assert.equal(r.statusCode, 423, r.body);
    }
  } finally {
    await readonly.close();
  }
  // Terminal test only: rename the new module in this guarded disposable database, never a runtime database.
  for (const table of [
    'order_field_batch_previews',
    'order_field_batch_rows',
    'order_field_batch_executions',
    'order_field_batch_execution_rows',
  ])
    await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_safety_old`);
  const old = await buildApp();
  try {
    const r = await f.api('/previews', read, 'GET', undefined, old);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().available, false);
    assert.equal(r.json().can_write, false);
    assert.equal((await f.api(query, read, 'GET', undefined, old)).statusCode, 503);
    assert.equal(
      (await f.api('/previews', both, 'POST', { malformed: true }, old)).statusCode,
      503,
    );
  } finally {
    await old.close();
  }
});
