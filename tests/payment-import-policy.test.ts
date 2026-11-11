import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { recordFinancialPaymentInTx } from '../server/payments';
import { isLocalFinancialVersion } from '../server/local-financial-policy';
import { processStatusScan, previewStatus, scheduleStatusesDue } from '../server/order-status';
import { scheduleCandidates, processSchedule } from '../server/automation-schedules';
import { processAutomation, dispatchAutomation } from '../server/automations';
import { demoWooOrder } from '../server/import-routes';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\w+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  user: string,
  warehouse: string,
  product: any;
let transportCalls = 0;
const actor = () => ({ tenantId: DEMO_TENANT, userId: user, role: 'admin' as const });
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie } });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      transportCalls++;
      throw Error('No provider call permitted');
    },
  });
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await ok('/auth/me')).user.id;
  warehouse = (await ok('/warehouses')).data[0].id;
  product = await ok('/products', 'POST', {
    sku: 'FIN-POLICY-' + randomUUID(),
    name: 'Financial policy',
    price: 10000,
    quantity: 100,
    warehouse_id: warehouse,
  });
});
beforeEach(async () => {
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1');
  await pool.query('UPDATE automation_schedules SET enabled=false');
  await pool.query('UPDATE order_status_configs SET enabled=false');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
  transportCalls = 0;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function make() {
  return ok('/orders', 'POST', {
    customer_name: 'Local finances',
    email: 'finance@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product.id, quantity: 1 }],
    address: { country: 'PL' },
  });
}
async function localPay(o: any) {
  return tenantTx(DEMO_TENANT, (c) =>
    recordFinancialPaymentInTx(
      c,
      actor(),
      o.id,
      randomUUID(),
      { qa: true },
      {
        kind: 'receipt',
        amount: o.total,
        fee: 0,
        currency: o.currency,
        method: 'bank_csv',
        reference: 'Synthetic policy evidence',
      },
      {
        effects: 'local_financial_only',
        provenance: { execution_id: randomUUID(), row_id: randomUUID(), preview_id: randomUUID() },
      },
    ),
  );
}
async function claim(id: string) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
  assert(j);
  return j;
}

test('scheduled selection excludes only the locally changed revision; explicit later action restores normal eligibility', async () => {
  const o = await make();
  await localPay(o);
  const fresh = await ok('/orders/' + o.id);
  assert.equal(fresh.status, 'paid');
  assert(await tenantTx(DEMO_TENANT, (c) => isLocalFinancialVersion(c, o.id)));
  const s = await ok('/automation-schedules', 'POST', {
    client_key: randomUUID(),
    name: 'Paid periodic',
    enabled: true,
    frequency: { kind: 'interval', seconds: 3600 },
    statuses: ['paid'],
    min_age_seconds: 0,
    actions: [{ type: 'add_tag', tag: 'periodic' }],
  });
  const run = {
    definition: s.definition,
    as_of: new Date(Date.now() + 1000).toISOString(),
    schedule_id: s.id,
    definition_version: s.definition_version,
  };
  const before = await tenantTx(DEMO_TENANT, (c) => scheduleCandidates(c, run, 100));
  assert(!before.some((x: any) => x.id === o.id));
  await ok('/orders/' + o.id + '/operations', 'POST', { type: 'add_tag', tag: 'operator-action' });
  assert.equal(await tenantTx(DEMO_TENANT, (c) => isLocalFinancialVersion(c, o.id)), false);
  const after = await tenantTx(DEMO_TENANT, (c) => scheduleCandidates(c, run, 100));
  assert(after.some((x: any) => x.id === o.id));
});

test('previously queued periodic run cannot act on locally paid order', async () => {
  const o = await make();
  const s = await ok('/automation-schedules', 'POST', {
    client_key: randomUUID(),
    name: 'Prequeued periodic',
    enabled: true,
    frequency: { kind: 'interval', seconds: 3600 },
    statuses: ['new', 'paid'],
    min_age_seconds: 0,
    actions: [{ type: 'add_tag', tag: 'forbidden-auto' }],
  });
  const r = await ok('/automation-schedules/' + s.id + '/run', 'POST', {
    client_key: randomUUID(),
    version: s.version,
    confirmed: true,
  });
  await localPay(o);
  await processSchedule(await claim(r.job_id));
  assert(!(await ok('/orders/' + o.id)).tags.includes('forbidden-auto'));
  assert.equal(transportCalls, 0);
});

test('delayed pre-import event rule skips current local-financial revision', async () => {
  const rule = await ok('/automations', 'POST', {
    name: 'Delayed creation',
    trigger: 'order.created',
    enabled: true,
    actions: [{ type: 'add_tag', tag: 'forbidden-rule' }],
  });
  const o = await make();
  const eventJob = (
    await pool.query(
      "SELECT * FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'orderId'=$2 ORDER BY created_at DESC LIMIT 1",
      [DEMO_TENANT, o.id],
    )
  ).rows[0];
  assert(eventJob);
  await dispatchAutomation(await claim(eventJob.id));
  const run = (
    await pool.query('SELECT * FROM automation_runs WHERE order_id=$1 AND rule_id=$2', [
      o.id,
      rule.id,
    ])
  ).rows[0];
  assert(run);
  await localPay(o);
  await processAutomation(await claim(run.job_id));
  const done = (await pool.query('SELECT * FROM automation_runs WHERE id=$1', [run.id])).rows[0];
  assert.equal(done.state, 'skipped');
  assert.match(done.result.reason, /lokalnego rozliczenia/);
  assert(!(await ok('/orders/' + o.id)).tags.includes('forbidden-rule'));
});

test('periodic source status scan omits imported paid revision with zero provider reads or write plans', async () => {
  const ch = randomUUID(),
    raw: any = structuredClone(demoWooOrder);
  raw.id = 888123;
  raw.status = 'on-hold';
  raw.date_paid = null;
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials) VALUES($1,$2,'woocommerce','Policy source','sandbox',$3,$4)",
      [
        ch,
        DEMO_TENANT,
        JSON.stringify({ store_url: 'https://example.test', simulation: true }),
        encrypt({ consumer_key: 'test', consumer_secret: 'test' }),
      ],
    ),
  );
  const staged = (await ok('/integrations/' + ch + '/stage-orders', 'POST', { data: [raw] }))
    .data[0];
  await ok('/integrations/' + ch + '/mappings', 'POST', { external_id: '701', sku: product.sku });
  const imported = await ok('/imports/' + staged.id + '/commit', 'POST', {
    warehouse_id: warehouse,
  });
  const o = imported.order ?? imported;
  const cfg = await ok('/integrations/' + ch + '/order-status', 'PATCH', {
    version: 0,
    enabled: true,
    confirm_external: true,
  });
  await localPay(o);
  await scheduleStatusesDue();
  const j = (
    await pool.query(
      "SELECT * FROM jobs WHERE kind='order.status.scan' AND payload->>'channel_id'=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1",
      [ch],
    )
  ).rows[0];
  assert(j);
  await processStatusScan(await claim(j.id), {
    transport: async () => {
      transportCalls++;
      throw Error('No remote call permitted');
    },
  });
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM order_status_plans WHERE order_id=$1', [o.id]))
      .rows[0].n,
    0,
  );
  assert.equal(transportCalls, 0);
  await assert.rejects(
    previewStatus(
      actor(),
      o.id,
      {
        transport: async () => {
          transportCalls++;
          throw Error('Forbidden');
        },
      },
      { job: j, version: cfg.version },
    ),
    /Lokalne rozliczenie/,
  );
  assert.equal(transportCalls, 0);
});

test('older snapshot has graceful absent fence and foreign tenant cannot read own fence', async () => {
  const o = await make();
  await localPay(o);
  const second = (
    await pool.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [DEMO_TENANT])
  ).rows[0].id;
  assert.equal(await tenantTx(second, (c) => isLocalFinancialVersion(c, o.id)), false);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE order_local_financial_fences RENAME TO owned_qa_old_fences');
    assert.equal(await isLocalFinancialVersion(c, o.id), false);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
});
