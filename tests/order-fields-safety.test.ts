import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const testUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(testUrl.hostname));
assert.match(testUrl.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  user: string,
  ip = 60;
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
    address = '127.0.40.' + ++ip;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Fields safety QA','enterprise')", [
    tenant,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Fields safety','FSAFETY')",
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
  const req = (path: string, method: any = 'GET', payload?: any) =>
    app.inject({
      url: '/api' + path,
      method,
      payload,
      headers: { cookie, 'idempotency-key': randomUUID() },
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
      sku: 'SAFE-' + randomUUID(),
      name: 'Fields safety product',
      price: 1000,
      quantity: 200,
      warehouse_id: warehouse,
    },
    201,
  );
  const orderBody = (initial_fields?: any[]) => ({
    customer_name: 'Fields safety',
    email: 'safety@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product.id, quantity: 1 }],
    ...(initial_fields ? { initial_fields } : {}),
  });
  const field = (type = 'text', extra: any = {}) =>
    ok(
      '/order-fields',
      'POST',
      {
        client_key: randomUUID(),
        key: 's_' + randomUUID().replaceAll('-', ''),
        label: 'Safety field',
        type,
        ...extra,
      },
      201,
    );
  const order = () => ok('/orders', 'POST', orderBody(), 201);
  return { tenant, warehouse, product, req, ok, field, order, orderBody, cookie, address };
}
const change = (d: any, value: any) => ({
  field_id: d.id,
  definition_version: d.version,
  type: d.type,
  value,
});
const patch = (o: any, changes: any[]) => ({
  client_key: randomUUID(),
  order_version: Number(o.version),
  changes,
});

async function evidence(tenant: string) {
  const result: Record<string, unknown> = {};
  for (const table of [
    'orders',
    'order_items',
    'stock',
    'jobs',
    'order_events',
    'audit_events',
    'order_field_definitions',
    'order_field_definition_revisions',
    'order_field_options',
    'order_field_files',
    'order_field_values',
    'order_field_value_events',
    'order_field_requests',
  ]) {
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
        [tenant],
      )
    ).rows;
  }
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
  assert.fail('Requests did not actually wait on the held database lock');
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

test(
  'actual field PATCH order wait permits role withdrawal and rejects every write after the wait',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      d = await f.field(),
      o = await f.order();
    const positive = await f.ok(
      '/orders/' + o.id + '/fields',
      'PATCH',
      patch(o, [change(d, 'control')]),
    );
    assert.equal(positive.order_version, Number(o.version) + 1);
    const before = await evidence(f.tenant),
      holder = await pool.connect();
    let pending: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [o.id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = f.req(
        '/orders/' + o.id + '/fields',
        'PATCH',
        patch({ version: positive.order_version }, [change(d, 'must not commit')]),
      );
      const waiting = await waitOn(pid);
      assert.match(waiting[0].query, /SELECT id,version.* FROM orders.*FOR UPDATE/);
      await withdraw(f.tenant);
      assert.equal(
        (await waitOn(pid)).length,
        1,
        'Membership commit completed while the request still waits',
      );
      await holder.query('COMMIT');
      const result = await pending;
      assert.equal(result.statusCode, 403, result.body);
      assert.deepEqual(await evidence(f.tenant), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'actual manual create with and without initial fields permits role withdrawal during catalogue wait and rolls back order and stock',
  { timeout: 15000 },
  async () => {
    for (const hasInitialFields of [true, false]) {
      const f = await fixture(),
        d = hasInitialFields ? await f.field() : undefined,
        before = await evidence(f.tenant),
        holder = await pool.connect();
      let pending: ReturnType<typeof f.req> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'catalog:' + f.tenant,
        ]);
        const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        pending = f.req(
          '/orders',
          'POST',
          f.orderBody(d ? [change(d, 'must not create')] : undefined),
        );
        assert.match((await waitOn(pid))[0].query, /pg_advisory_xact_lock_shared/);
        await withdraw(f.tenant);
        await waitOn(pid);
        await holder.query('COMMIT');
        const result = await pending;
        assert.equal(result.statusCode, 403, result.body);
        assert.deepEqual(await evidence(f.tenant), before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
      }
    }
  },
);

test(
  'blocked field detail and private file download use the role committed during their actual order wait',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      team = await f.field(),
      secret = await f.field('text', { read_role: 'admin', write_role: 'admin' }),
      file = await f.field('file', { read_role: 'admin', write_role: 'admin' }),
      o = await f.order();
    await f.ok(
      '/orders/' + o.id + '/fields',
      'PATCH',
      patch(o, [change(team, 'visible'), change(secret, 'PRIVATE-SAFETY-VALUE')]),
    );
    const upload = await f.ok(
      '/order-field-files',
      'POST',
      {
        client_key: randomUUID(),
        order_id: o.id,
        field_id: file.id,
        definition_version: 1,
        filename: 'private.pdf',
        content_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
      },
      201,
    );
    const before = await evidence(f.tenant),
      holder = await pool.connect();
    let detail: ReturnType<typeof f.req> | undefined,
      download: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [o.id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      detail = f.req('/orders/' + o.id + '/fields');
      download = f.req('/order-field-files/' + upload.id + '/download');
      const waiting = await waitOn(pid, 2);
      assert(waiting.every((r) => /SELECT id,version.* FROM orders.*FOR SHARE/.test(r.query)));
      await withdraw(f.tenant);
      await waitOn(pid, 2);
      await holder.query('COMMIT');
      const r = await detail,
        bytes = await download;
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().current_role, 'viewer');
      assert.deepEqual(
        r.json().data.map((row: any) => row.definition.id),
        [team.id],
      );
      assert(!r.body.includes('PRIVATE-SAFETY-VALUE'));
      assert.equal(bytes.statusCode, 403, bytes.body);
      assert.deepEqual(await evidence(f.tenant), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await Promise.all([detail, download]);
    }
  },
);

test('dyna_app cannot bypass own option identities, immutable value scope or file definition type', async () => {
  const f = await fixture(),
    option = randomUUID(),
    otherOption = randomUUID(),
    d = await f.field('multi_select', { options: [{ id: option, label: 'Own' }] }),
    other = await f.field('multi_select', { options: [{ id: otherOption, label: 'Other field' }] }),
    text = await f.field(),
    file = await f.field('file'),
    o = await f.order();
  await f.ok('/orders/' + o.id + '/fields', 'PATCH', patch(o, [change(d, [option])]));
  const before = await evidence(f.tenant);
  for (const ids of [[otherOption], [option, option], [null], Array(51).fill(option)]) {
    await assert.rejects(
      tenantTx(f.tenant, (c) =>
        c.query(
          'UPDATE order_field_values SET option_values=$3::uuid[] WHERE order_id=$1 AND field_id=$2',
          [o.id, d.id, ids],
        ),
      ),
      /Options must belong/,
    );
  }
  await assert.rejects(
    tenantTx(f.tenant, (c) =>
      c.query('UPDATE order_field_values SET field_id=$3 WHERE order_id=$1 AND field_id=$2', [
        o.id,
        d.id,
        other.id,
      ]),
    ),
    /value scope is immutable/,
  );
  const upload = await f.ok(
    '/order-field-files',
    'POST',
    {
      client_key: randomUUID(),
      order_id: o.id,
      field_id: file.id,
      definition_version: 1,
      filename: 'private.pdf',
      content_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    },
    201,
  );
  await assert.rejects(
    tenantTx(f.tenant, (c) =>
      c.query(
        'INSERT INTO order_field_files(id,tenant_id,order_id,field_id,definition_version,actor_id,client_key,request_hash,filename,mime_type,byte_count,file_hash,encrypted_bytes) SELECT $2,tenant_id,order_id,$3,1,actor_id,$4,request_hash,filename,mime_type,byte_count,file_hash,encrypted_bytes FROM order_field_files WHERE id=$1',
        [upload.id, randomUUID(), text.id, randomUUID()],
      ),
    ),
    /Attachment must belong to a file field/,
  );
  const after = await evidence(f.tenant);
  for (const table of Object.keys(before).filter(
    (t) => !['order_field_files', 'audit_events'].includes(t),
  ))
    assert.deepEqual(after[table], before[table], table);
  const foreign = randomUUID();
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Foreign field safety')", [foreign]);
  await tenantTx(foreign, async (c) => {
    for (const table of [
      'order_field_definitions',
      'order_field_values',
      'order_field_value_events',
      'order_field_files',
      'order_field_requests',
    ])
      assert.equal(
        (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [f.tenant])).rows.length,
        0,
        table,
      );
    await assert.rejects(
      c.query(
        "INSERT INTO order_field_options(tenant_id,field_id,id,label,enabled) VALUES($1,$2,$3,'foreign',true)",
        [foreign, d.id, randomUUID()],
      ),
      /foreign key constraint/,
    );
  });
});

test('order field columns preserve the existing 200-row page contract and require independent developer scopes', async () => {
  const f = await fixture(),
    d = await f.field(),
    o = await f.order();
  await f.ok('/orders/' + o.id + '/fields', 'PATCH', patch(o, [change(d, 'scoped projection')]));
  await pool.query(
    "INSERT INTO orders(id,tenant_id,number,source,customer_name,email,address,currency,total,shipping_cost,warehouse_id,portal_token) SELECT gen_random_uuid(),tenant_id,number||'-'||i,'manual',customer_name,email,address,currency,total,shipping_cost,warehouse_id,gen_random_uuid() FROM orders CROSS JOIN generate_series(1,100) i WHERE id=$1",
    [o.id],
  );
  const query = '/orders?limit=200&field_columns=' + encodeURIComponent(JSON.stringify([d.id]));
  const page = await f.ok(query);
  assert.equal(page.data.length, 101);
  assert(page.data.every((row: any) => row.extra_fields.length === 1));
  const plainKey = await f.ok(
    '/developer/keys',
    'POST',
    { name: 'Orders scope only', scopes: ['orders:read'] },
    201,
  );
  const api = (path: string, token: string) =>
    app.inject({
      url: '/api/v1' + path,
      headers: { authorization: 'Bearer ' + token },
      remoteAddress: f.address,
    });
  const plain = await api('/orders', plainKey.token);
  assert.equal(plain.statusCode, 200, plain.body);
  assert(!plain.body.includes('scoped projection'));
  assert.equal((await api(query, plainKey.token)).statusCode, 403);
  assert.equal((await api('/orders/' + o.id + '/fields', plainKey.token)).statusCode, 403);
  const scopedKey = await f.ok(
    '/developer/keys',
    'POST',
    { name: 'Field scope', scopes: ['orders:read', 'order-fields:read'] },
    201,
  );
  const projected = await api(query, scopedKey.token);
  assert.equal(projected.statusCode, 200, projected.body);
  assert.equal(projected.json().data.length, 101);
  assert(projected.body.includes('scoped projection'));
});
