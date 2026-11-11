import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate, pool } from '../server/db';
import { buildApp } from '../server/app';
import { seed } from './fixtures';
import { normalizeOrder } from '../server/imports';
import { demoWooOrder } from '../server/import-routes';
import { statusConnection } from '../server/order-status';
import {
  processSourceRead,
  failSourceRead,
  scheduleSourcePaymentsDue,
} from '../server/source-payments';
import { encrypt } from '../server/security';
import { Problem } from '../server/errors';
import type { IntegrationContext } from '../server/channel-access';

assert.equal(process.env.DYNA_TEST, 'true');
const testUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(testUrl.hostname));
assert.match(testUrl.pathname, /^\/dynaminds_test_\d+$/);
let user: string, app: Awaited<ReturnType<typeof buildApp>>;
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
    order = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Source lock QA','enterprise')", [
    tenant,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Source lock','SRCLOCK')",
    [warehouse, tenant],
  );
  const channel = (
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Source lock','sandbox',$3,$4) RETURNING *",
      [
        randomUUID(),
        tenant,
        encrypt({ consumer_key: 'isolated-source-lock', consumer_secret: 'isolated-source-lock' }),
        JSON.stringify({ store_url: 'https://shop.example' }),
      ],
    )
  ).rows[0];
  const raw = structuredClone(demoWooOrder);
  raw.id = 99101;
  raw.date_paid = null as any;
  raw.status = 'on-hold';
  const n = normalizeOrder('woocommerce', raw, channel.settings);
  await pool.query(
    "INSERT INTO orders(id,tenant_id,number,source,external_id,channel_id,customer_name,email,address,currency,total,shipping_cost,warehouse_id,portal_token,source_snapshot) VALUES($1,$2,$3,'woocommerce',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    [
      order,
      tenant,
      'LOCK-' + order,
      n.external_id,
      channel.id,
      n.customer_name,
      n.email,
      JSON.stringify(n.address),
      n.currency,
      n.total,
      n.shipping_cost,
      warehouse,
      randomUUID(),
      JSON.stringify({ items: n.items }),
    ],
  );
  const product = randomUUID();
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,'Source lock product',3167)",
    [product, tenant, 'SRC-' + product],
  );
  await pool.query(
    'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,20)',
    [tenant, warehouse, product],
  );
  await pool.query(
    'INSERT INTO order_items(id,tenant_id,order_id,product_id,sku,name,quantity,price,vat,line_total) VALUES($1,$2,$3,$4,$5,$6,3,3167,23,9501)',
    [randomUUID(), tenant, order, product, 'SRC-' + product, 'Source lock product'],
  );
  const connection = statusConnection(channel);
  await pool.query(
    'INSERT INTO source_payment_configs(tenant_id,channel_id,actor_id,enabled,interval_seconds,connection_hash,external_authorized) VALUES($1,$2,$3,true,60,$4,true)',
    [tenant, channel.id, user, connection],
  );
  const job = (
    await pool.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,state,lease_token,locked_at,attempts) VALUES($1,$2,'payment.source.read',$3,$4,'running',$5,now(),1) RETURNING *",
      [
        randomUUID(),
        tenant,
        JSON.stringify({
          order_id: order,
          channel_id: channel.id,
          actor_id: user,
          automatic: true,
          config_version: 1,
          connection_hash: connection,
        }),
        randomUUID(),
        randomUUID(),
      ],
    )
  ).rows[0];
  raw.date_paid = '2026-10-04T12:00:00';
  raw.status = 'processing';
  const calls: string[] = [];
  const ctx: IntegrationContext = {
    transport: async (url, init) => {
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(new URL(url).pathname, '/wp-json/wc/v3/orders/' + raw.id);
      calls.push(String(url));
      return new Response(JSON.stringify(raw), { status: 200 });
    },
  };
  return { tenant, order, channel, job, ctx, calls, total: n.total };
}

async function evidence(tenant: string) {
  const result: Record<string, unknown> = {};
  for (const table of [
    'orders',
    'order_items',
    'stock',
    'payment_entries',
    'source_payment_checks',
    'order_events',
    'audit_events',
    'order_local_financial_fences',
  ])
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
        [tenant],
      )
    ).rows;
  return result;
}

async function orderWait(holderPid: number, scheduler = false) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const rows = (
      await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (($2 AND query LIKE 'SELECT id FROM orders WHERE channel_id=%FOR UPDATE') OR (NOT $2 AND query='SELECT * FROM orders WHERE id=$1 FOR UPDATE')) AND $1=ANY(pg_blocking_pids(pid))",
        [holderPid, scheduler],
      )
    ).rows;
    if (rows.length) return rows[0].pid as number;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Provider-read finalization did not actually wait on the held order');
}

test('real provider-read automatic positive control still appends one receipt and advances paid', async () => {
  const f = await fixture();
  await processSourceRead(f.job, f.ctx);
  assert.equal(f.calls.length, 1);
  const entries = (
    await pool.query('SELECT kind,amount,method FROM payment_entries WHERE order_id=$1', [f.order])
  ).rows;
  assert.deepEqual(entries, [{ kind: 'receipt', amount: f.total, method: 'source_sync' }]);
  assert.equal(
    (await pool.query('SELECT status FROM orders WHERE id=$1', [f.order])).rows[0].status,
    'paid',
  );
  assert.equal(
    (await pool.query('SELECT state FROM source_payment_checks WHERE order_id=$1', [f.order]))
      .rows[0].state,
    'applied',
  );
  assert.equal(
    (await pool.query('SELECT state,lease_token FROM jobs WHERE id=$1', [f.job.id])).rows[0].state,
    'done',
  );
});

test(
  'role withdrawal commits during real provider-read order wait; final grant rejects all financial evidence writes',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      before = await evidence(f.tenant);
    const holder = await pool.connect(),
      revoke = await pool.connect();
    let outcome: Promise<{ error?: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.order]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      outcome = processSourceRead(f.job, f.ctx).then(
        () => ({}),
        (error) => ({ error }),
      );
      const waiter = await orderWait(pid);
      assert.equal(
        f.calls.length,
        1,
        'Controlled provider GET completed before actual order lock wait',
      );
      await revoke.query('BEGIN');
      await revoke.query("SET LOCAL statement_timeout='1500ms'");
      await revoke.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        f.tenant,
        user,
      ]);
      await revoke.query('COMMIT');
      assert.equal(
        (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked', [pid, waiter])).rows[0]
          .blocked,
        true,
        'Grant withdrawal commits while order stays locked',
      );
      await holder.query('COMMIT');
      const result = await outcome;
      assert.ok(result.error instanceof Problem);
      assert.equal(result.error.status, 403);
      assert.deepEqual(
        await evidence(f.tenant),
        before,
        'No source check, receipt, status, audit or event survives rejected final authorization',
      );
      const running = (
        await pool.query('SELECT state,lease_token FROM jobs WHERE id=$1', [f.job.id])
      ).rows[0];
      assert.equal(running.state, 'running');
      assert.equal(running.lease_token, f.job.lease_token);
      await failSourceRead(f.job, result.error);
      const failed = (
        await pool.query('SELECT state,lease_token,locked_at,error FROM jobs WHERE id=$1', [
          f.job.id,
        ])
      ).rows[0];
      assert.equal(failed.state, 'failed');
      assert.equal(failed.lease_token, null);
      assert.equal(failed.locked_at, null);
      assert.match(failed.error, /uprawnienia/);
      assert.deepEqual(
        await evidence(f.tenant),
        before,
        'Established failure wrapper only settles the job lease',
      );
    } finally {
      await revoke.query('ROLLBACK');
      revoke.release();
      await holder.query('ROLLBACK');
      holder.release();
      if (outcome) await outcome;
    }
  },
);

test(
  'periodic scheduler queues a real eligible source read and rechecks withdrawn admin after candidate order wait',
  { timeout: 15000 },
  async () => {
    // Each scheduler call sees only its intended channel; no existing completed fixture contributes jobs.
    await pool.query('UPDATE source_payment_configs SET enabled=false');
    const control = await fixture();
    await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
      control.job.id,
    ]);
    await scheduleSourcePaymentsDue();
    const scheduled = (
      await pool.query(
        "SELECT * FROM jobs WHERE tenant_id=$1 AND kind='payment.source.read' AND state='pending'",
        [control.tenant],
      )
    ).rows;
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].payload.order_id, control.order);
    assert.equal(scheduled[0].payload.automatic, true);
    assert.equal(control.calls.length, 0, 'Scheduler does not itself call a provider');
    assert.equal(
      (
        await pool.query('SELECT enabled FROM source_payment_configs WHERE channel_id=$1', [
          control.channel.id,
        ])
      ).rows[0].enabled,
      true,
    );
    await pool.query('UPDATE source_payment_configs SET enabled=false');
    const f = await fixture();
    await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
      f.job.id,
    ]);
    const before = await evidence(f.tenant),
      jobsBefore = (
        await pool.query('SELECT * FROM jobs WHERE tenant_id=$1 ORDER BY id', [f.tenant])
      ).rows;
    const holder = await pool.connect(),
      revoke = await pool.connect();
    let outcome: Promise<{ error?: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.order]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      outcome = scheduleSourcePaymentsDue().then(
        () => ({}),
        (error) => ({ error }),
      );
      const waiter = await orderWait(pid, true);
      await revoke.query('BEGIN');
      await revoke.query("SET LOCAL statement_timeout='1500ms'");
      await revoke.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        f.tenant,
        user,
      ]);
      await revoke.query('COMMIT');
      assert.equal(
        (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked', [pid, waiter])).rows[0]
          .blocked,
        true,
      );
      await holder.query('COMMIT');
      assert.equal((await outcome).error, undefined);
      assert.deepEqual(
        (await pool.query('SELECT * FROM jobs WHERE tenant_id=$1 ORDER BY id', [f.tenant])).rows,
        jobsBefore,
        'Withdrawn scheduler must not create a job',
      );
      assert.deepEqual(await evidence(f.tenant), before);
      const cfg = (
        await pool.query('SELECT enabled,error FROM source_payment_configs WHERE channel_id=$1', [
          f.channel.id,
        ])
      ).rows[0];
      assert.equal(cfg.enabled, false);
      assert.match(cfg.error, /uprawnienia/);
      assert.equal(f.calls.length, 0);
    } finally {
      await revoke.query('ROLLBACK');
      revoke.release();
      await holder.query('ROLLBACK');
      holder.release();
      if (outcome) await outcome;
    }
  },
);

test(
  'real configuration cancellation holds cfg before invalidating job; provider finalization waits cfg before taking lease',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      before = await evidence(f.tenant);
    const login = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const switched = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: f.tenant },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] },
    });
    assert.equal(switched.statusCode, 200, switched.body);
    const holder = await pool.connect();
    let configured: Promise<{ statusCode: number; body: string }> | undefined,
      processed: Promise<{ error?: unknown }> | undefined;
    async function blockedBy(pid: number, query: string) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = (
          await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $2 AND $1=ANY(pg_blocking_pids(pid))",
            [pid, query],
          )
        ).rows;
        if (rows.length) return rows[0].pid as number;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('Expected actual lock wait: ' + query);
    }
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [f.job.id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      configured = app.inject({
        url: '/api/integrations/' + f.channel.id + '/payment-sync',
        method: 'PATCH',
        payload: { version: 1, enabled: false, interval_seconds: 60, confirm_external: false },
        headers: { cookie: String(switched.headers['set-cookie']).split(';')[0] },
      });
      const configPid = await blockedBy(
        pid,
        "UPDATE jobs SET state='failed'%Harmonogram płatności wyłączono lub zmieniono%",
      );
      processed = processSourceRead(f.job, f.ctx).then(
        () => ({}),
        (error) => ({ error }),
      );
      await blockedBy(
        configPid,
        'SELECT * FROM source_payment_configs WHERE channel_id=% FOR SHARE',
      );
      assert.equal(f.calls.length, 1);
      assert.equal(
        (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked', [pid, configPid])).rows[0]
          .blocked,
        true,
      );
      await holder.query('COMMIT');
      const response = await configured;
      assert.equal(response.statusCode, 200, response.body);
      const result = await processed;
      assert.ok(result.error instanceof Problem);
      assert.equal(result.error.status, 409);
      const after = await evidence(f.tenant);
      const audits = (after.audit_events as { row: any }[]).filter(
        (x) => x.row.action === 'payment.source.configure',
      );
      assert.equal(audits.length, 1);
      after.audit_events = (after.audit_events as { row: any }[]).filter(
        (x) => x.row.action !== 'payment.source.configure',
      );
      assert.deepEqual(
        after,
        before,
        'Only explicit configuration audit survives; no source payment effects',
      );
      assert.equal(
        (await pool.query('SELECT state,lease_token FROM jobs WHERE id=$1', [f.job.id])).rows[0]
          .state,
        'failed',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT enabled,version FROM source_payment_configs WHERE channel_id=$1',
            [f.channel.id],
          )
        ).rows[0].version,
        2,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (configured) await configured;
      if (processed) await processed;
    }
  },
);
