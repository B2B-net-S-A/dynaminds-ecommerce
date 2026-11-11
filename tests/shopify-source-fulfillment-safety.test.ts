import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';
import { processShopifyFulfillment } from '../server/shopify-fulfillment';

type Row = Record<string, any>;
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL!);
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '',
  tenant = '',
  user = '',
  warehouse = '',
  ip = 10;
let fixture = shopifyFulfillmentFixture();
const ctx = { transport: (url: string, input: RequestInit) => fixture.transport(url, input) };
const request = (path: string, method: any = 'GET', payload?: any, token?: string) =>
  app.inject({
    url: '/api' + (token ? '/v1' : '') + path,
    method,
    payload,
    headers: token ? { authorization: 'Bearer ' + token, 'X-Workspace-ID': tenant } : { cookie },
    remoteAddress: '127.0.219.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, token?: string) {
  const r = await request(path, method, body, token);
  assert(r.statusCode < 300, `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 500)}`);
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: ctx.transport,
    logging: process.env.SHOPIFY_SOURCE_TEST_LOG === 'true',
  });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  fixture = shopifyFulfillmentFixture();
  const login = await request('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Source fulfillment authorization','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Source warehouse','SS')",
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
async function shipped() {
  const channel = await ok('/integrations', 'POST', {
    provider: 'shopify',
    name: 'Own synthetic source',
    mode: 'sandbox',
    settings: { store_url: 'https://qa-' + randomUUID() + '.myshopify.com' },
    credentials: { access_token: 'qa-not-a-real-token-2026' },
  });
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1',
    [channel.id],
  );
  const product = await ok('/products', 'POST', {
    sku: 'AUTH-' + randomUUID(),
    name: 'Own source item',
    price: 1500,
    vat: 23,
    quantity: 10,
    warehouse_id: warehouse,
  });
  await ok('/integrations/' + channel.id + '/mappings', 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: product.sku,
  });
  const inbound = (
    await ok('/integrations/' + channel.id + '/stage-orders', 'POST', { data: [fixture.state.raw] })
  ).data[0];
  const order = await ok('/imports/' + inbound.id + '/commit', 'POST', {
    warehouse_id: warehouse,
    expected_hash: inbound.source_hash,
  });
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  for (let i = 0; i < 2; i++)
    await ok('/orders/' + order.id + '/scan', 'POST', { code: product.sku });
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  await ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  const shipment = (
    await pool.query('SELECT id FROM shipments WHERE tenant_id=$1 AND order_id=$2', [
      tenant,
      order.id,
    ])
  ).rows[0].id;
  const body = {
    client_key: randomUUID(),
    company: 'DPD',
    notify_customer: false,
    shipment_id: shipment,
    lines: [{ remote_line_id: fixture.state.raw.lineItems.nodes[0].id, quantity: 1 }],
  };
  return { order, body };
}
async function preview(x: Awaited<ReturnType<typeof shipped>>, token?: string) {
  return ok('/orders/' + x.order.id + '/shopify-fulfillment/preview', 'POST', x.body, token);
}
async function key() {
  return ok('/developer/keys', 'POST', {
    name: 'Own source authorization',
    scopes: ['orders:read', 'orders:write'],
  });
}
async function snapshot() {
  const tables = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','sessions','outbound_subscriptions') ORDER BY 1`)
  ).rows;
  const out: Row = {};
  for (const { table_name: n } of tables) {
    assert(/^[a-z][a-z0-9_]*$/.test(n));
    const rows = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${n}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
    out[n] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return out;
}
async function waitOn(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const waits = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (waits.some((r) => pattern.test(r.query))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('Actual source fulfillment did not wait on the independent database lock');
}
async function grantChange(sql: string, params: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, params);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const writes = () =>
  fixture.calls.filter((r) => r.query.includes('mutation DynaFulfillmentCreate')).length;

test('partial preview withdraws current admin during actual actor FK wait and rolls back all proof/audit/stock effects', async () => {
  const x = await shipped(),
    holder = await pool.connect();
  let response: ReturnType<typeof request> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
    response = request('/orders/' + x.order.id + '/shopify-fulfillment/preview', 'POST', x.body);
    await waitOn(holder, /INSERT INTO shopify_fulfillment_plans/i);
    await grantChange("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      user,
    ]);
    const before = await snapshot();
    await holder.query('ROLLBACK');
    const r = await response;
    assert.equal(r.statusCode, 403, r.body);
    assert.deepEqual(await snapshot(), before);
    assert.equal(writes(), 0);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    if (response) await response;
  }
});

test('partial queue withdraws current admin during actual plan lock wait without creating job, capacity or audit evidence', async () => {
  const x = await shipped(),
    p = await preview(x),
    holder = await pool.connect();
  let response: ReturnType<typeof request> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM shopify_fulfillment_plans WHERE id=$1 FOR UPDATE', [p.id]);
    response = request('/shopify-fulfillment-plans/' + p.id + '/queue', 'POST', {
      confirm_external: true,
    });
    await waitOn(holder, /shopify_fulfillment_plans/i);
    await grantChange("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      user,
    ]);
    const before = await snapshot();
    await holder.query('ROLLBACK');
    const r = await response;
    assert.equal(r.statusCode, 403, r.body);
    assert.deepEqual(await snapshot(), before);
    assert.equal(writes(), 0);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    if (response) await response;
  }
});

test('partial API queue rechecks revoked, expired and reduced key grants after a real plan wait with complete rollback', async () => {
  for (const mode of ['revoked', 'expired', 'scopes']) {
    const x = await shipped(),
      credential = await key(),
      p = await preview(x, credential.token),
      holder = await pool.connect();
    let response: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM shopify_fulfillment_plans WHERE id=$1 FOR UPDATE', [p.id]);
      response = request(
        '/shopify-fulfillment-plans/' + p.id + '/queue',
        'POST',
        { confirm_external: true },
        credential.token,
      );
      await waitOn(holder, /shopify_fulfillment_plans/i);
      await grantChange(
        mode === 'revoked'
          ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
          : mode === 'expired'
            ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
            : "UPDATE api_keys SET scopes=ARRAY['orders:read']::text[] WHERE id=$1",
        [credential.id],
      );
      const before = await snapshot();
      await holder.query('ROLLBACK');
      const r = await response;
      assert.equal(r.statusCode, 403, `${mode}: ${r.body}`);
      assert.deepEqual(await snapshot(), before);
      assert.equal(writes(), 0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (response) await response;
    }
  }
});

test('queued partial worker rechecks its original API key after actual owner order wait before any provider or simulation effect', async () => {
  const x = await shipped(),
    credential = await key(),
    p = await preview(x, credential.token);
  await ok(
    '/shopify-fulfillment-plans/' + p.id + '/queue',
    'POST',
    { confirm_external: true },
    credential.token,
  );
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=(SELECT job_id FROM shopify_fulfillment_plans WHERE id=$1) RETURNING *",
      [p.id, randomUUID()],
    )
  ).rows[0];
  assert(job);
  const holder = await pool.connect();
  let outcome: Promise<{ error: any }> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      tenant,
      x.order.id,
    ]);
    outcome = processShopifyFulfillment(job, ctx).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await waitOn(holder, /orders/i);
    await grantChange('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [credential.id]);
    const before = await snapshot();
    await holder.query('ROLLBACK');
    assert.equal((await outcome).error?.status, 403);
    assert.deepEqual(await snapshot(), before);
    assert.equal(writes(), 0);
    assert.equal(
      fixture.calls.length,
      0,
      'The first worker fence must reject before provider reads',
    );
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    if (outcome) await outcome;
  }
});
