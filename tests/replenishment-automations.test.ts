import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import {
  processReplenishmentAutomation,
  reapReplenishmentAutomations,
  REPLENISHMENT_AUTOMATION_JOB,
} from '../server/replenishment-automations';
import { replenishmentAutomationCreateInput } from '../server/replenishment-automations-schema';
import { tenantTx } from '../server/db';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  supplier = '',
  admin = '',
  viewer = '',
  other = '',
  user = '',
  providers = 0,
  ip = 1;
const cookies = new Map<string, string>(),
  base = '/replenishment/automations';
const request = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  cookie = admin,
  headers: Record<string, string> = {},
) => {
  assert(app);
  return app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie, ...headers },
    remoteAddress: '127.121.3.' + ip,
  });
};
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  status = 200,
  cookie = admin,
) {
  const r = await request(path, method, body, cookie);
  assert.equal(r.statusCode, status, path.startsWith('/auth') ? path : r.body);
  if (path.startsWith(base)) assert.equal(r.headers['cache-control'], 'no-store');
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providers++;
      throw Error('Replenishment cannot contact providers');
    },
    logging: process.env.REPLENISHMENT_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local', 'other@demo.local']) {
    const r = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  tenant = randomUUID();
  warehouse = randomUUID();
  providers = 0;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA121 main','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE WHEN email='viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA121 warehouse','QA121')",
    [warehouse, tenant],
  );
  for (const [email, cookie] of cookies) {
    const r = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200, r.body);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
  supplier = (await ok('/suppliers', 'POST', { name: 'QA121 Supplier', code: randomUUID() }, 201))
    .id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function product(quantity = 10) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'QA121-' + randomUUID(),
      name: 'QA121 physical',
      price: 999,
      quantity,
      warehouse_id: warehouse,
    },
    201,
  );
}
async function policy(p: Row, extra: Row = {}) {
  return (
    await ok(
      '/replenishment/policies',
      'POST',
      {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        product_id: p.id,
        definition: {
          enabled: true,
          minimum_quantity: 6,
          target_quantity: 10,
          supplier_id: supplier,
          supplier_sku: 'SUP',
          currency: 'PLN',
          minimum_order_quantity: 1,
          order_multiple: 1,
          unit_cost_minor: 317,
          cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
          confirm_cost: true,
          expected_date: null,
          ...extra,
        },
      },
      201,
    )
  ).policy;
}
const ruleBody = (ps: Row[], extra: Row = {}) => ({
  client_key: randomUUID(),
  name: 'QA121 local draft consent',
  definition: {
    warehouse_id: warehouse,
    product_ids: ps.map((p) => p.id),
    enabled: true,
    destination: 'new_drafts',
    ...extra,
  },
  confirmed_future_drafts: true,
});
async function rule(ps: Row[], extra: Row = {}) {
  const body = ruleBody(ps, extra);
  return { body, rule: (await ok(base + '/rules', 'POST', body, 201)).rule };
}
async function order(p: Row, quantity = 5) {
  return ok(
    '/orders',
    'POST',
    {
      customer_name: 'QA121 reservation',
      email: 'qa121@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: p.id, quantity }],
    },
    201,
  );
}
async function runs() {
  return (await ok(base + '/runs')).data as Row[];
}
async function claim(run: Row) {
  const lease = randomUUID();
  return (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=attempts+1 WHERE id=$1 RETURNING *",
      [
        run.job_id ??
          (
            await pool.query('SELECT job_id FROM replenishment_automation_runs WHERE id=$1', [
              run.id,
            ])
          ).rows[0].job_id,
        lease,
      ],
    )
  ).rows[0];
}
async function processRun(run: Row) {
  await processReplenishmentAutomation(await claim(run));
  return (await ok(base + '/runs/' + run.id)).run;
}
async function snapshot() {
  const out: Row = {};
  for (const table of [
    'stock',
    'stock_locations',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
    'purchase_orders',
    'purchase_order_lines',
    'replenishment_previews',
    'replenishment_executions',
    'replenishment_automation_runs',
    'jobs',
    'audit_events',
  ])
    out[table] = (
      await pool.query(`SELECT to_jsonb(t) r FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return out;
}
async function physical() {
  const out: Row = {};
  for (const table of [
    'stock',
    'stock_locations',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
    'stock_movements',
  ])
    out[table] = (
      await pool.query(`SELECT to_jsonb(t) r FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return out;
}

test('121 reservation crossing creates an atomic local PO once and keeps physical OMS state', async () => {
  const p = await product();
  await policy(p);
  const initiallyLow = await product(1);
  await policy(initiallyLow);
  const rr = await rule([p, initiallyLow]);
  const replay = await ok(base + '/rules', 'POST', rr.body, 200);
  assert.equal(replay.reused, true);
  assert.equal(replay.rule.id, rr.rule.id);
  await order(p);
  const queued = await runs();
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].crossings, [
    { product_id: p.id, before_available: 10, after_available: 5, minimum_quantity: 6 },
  ]);
  const before = await physical(),
    job = await claim(queued[0]);
  const applied = await processReplenishmentAutomation(job);
  assert.equal(applied.state, 'done');
  assert.deepEqual(await physical(), before);
  const done = (await ok(base + '/runs/' + queued[0].id)).run;
  const po = await ok('/purchase-orders/' + done.result.purchase_order_ids[0]);
  assert.equal(po.state, 'draft');
  assert.equal(po.lines[0].quantity, 5);
  assert.equal(po.lines[0].unit_cost, 317);
  assert.equal(po.lines.length, 1);
  assert.equal(po.lines[0].product_id, p.id);
  assert.equal(providers, 0);
  const effects = await snapshot();
  await processReplenishmentAutomation(job);
  assert.deepEqual(await snapshot(), effects);
  assert.equal(done.can_cancel, false);
});
test('121 initial low, equal and upward transitions do not retroactively enqueue', async () => {
  const p = await product(5);
  await policy(p);
  await rule([p]);
  assert.equal((await runs()).length, 0);
  await tenantTx(tenant, async (c) => {
    await c.query('UPDATE stock SET on_hand=6,version=version+1 WHERE product_id=$1', [p.id]);
  });
  assert.equal((await runs()).length, 0);
  await tenantTx(tenant, async (c) => {
    await c.query('UPDATE stock SET on_hand=6,version=version+1 WHERE product_id=$1', [p.id]);
  });
  assert.equal((await runs()).length, 0);
  await tenantTx(tenant, async (c) => {
    await c.query('UPDATE stock SET on_hand=5,version=version+1 WHERE product_id=$1', [p.id]);
  });
  assert.equal((await runs()).length, 1);
});
test('121 oldest matching draft appends but absence creates a new local draft', async () => {
  const p = await product();
  await policy(p, { minimum_quantity: 7 });
  const existing = await ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'PLN',
      reference: 'preserve',
      note: 'original',
      lines: [{ product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'SUP' }],
    },
    201,
  );
  await rule([p], { destination: 'append_matching_draft' });
  await order(p);
  const done = await processRun((await runs())[0]);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result.purchase_order_ids, [existing.id]);
  const after = await ok('/purchase-orders/' + existing.id);
  assert.equal(after.lines[0].quantity, 5);
  assert.equal(after.reference, 'preserve');
  assert.equal(after.note, 'original');
  assert.equal(after.version, existing.version + 1);
  const p2 = await product();
  await policy(p2, { currency: 'EUR' });
  await rule([p2], { destination: 'append_matching_draft' });
  await order(p2);
  const next = (await runs()).find((r) => r.state === 'queued')!;
  const done2 = await processRun(next);
  assert.equal(done2.state, 'done');
  assert.notEqual(done2.result.purchase_order_ids[0], existing.id);
  assert.equal(
    (await ok('/purchase-orders/' + done2.result.purchase_order_ids[0])).currency,
    'EUR',
  );
});
test('121 invalid oldest draft does not fall back or create a partial PO', async () => {
  const p = await product();
  await policy(p, { minimum_quantity: 7 });
  const po = await ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'PLN',
      lines: [{ product_id: p.id, quantity: 1, unit_cost: 999, supplier_sku: 'SUP' }],
    },
    201,
  );
  await rule([p], { destination: 'append_matching_draft' });
  await order(p);
  const done = await processRun((await runs())[0]);
  assert.equal(done.state, 'error');
  assert.equal(done.result.reason, 'plan_not_ready');
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    1,
  );
  assert.equal((await ok('/purchase-orders/' + po.id)).version, po.version);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM replenishment_executions WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
});
test('121 live incoming turns queued shortage into NOP with genuine immutable history', async () => {
  const p = await product();
  await policy(p);
  await rule([p]);
  await order(p);
  await ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'PLN',
      lines: [{ product_id: p.id, quantity: 5, unit_cost: 317, supplier_sku: 'SUP' }],
    },
    201,
  );
  const before = await physical();
  const done = await processRun((await runs())[0]);
  assert.equal(done.state, 'nop');
  assert.deepEqual(done.result.purchase_order_ids, []);
  assert.deepEqual(await physical(), before);
  const e = (await ok('/replenishment/executions/' + done.result.execution_id)).execution;
  assert.equal(e.unchanged, 1);
});
test('121 explicit cancel, policy renewal and failed lease reaping', async () => {
  const p = await product();
  const pol = await policy(p);
  const rr = await rule([p]);
  await order(p);
  let run = (await runs())[0];
  const cancel = { version: run.version, client_key: randomUUID() };
  assert.equal(
    (await ok(base + '/runs/' + run.id + '/cancel', 'POST', cancel)).run.state,
    'cancelled',
  );
  const after = await snapshot();
  assert.equal((await ok(base + '/runs/' + run.id + '/cancel', 'POST', cancel)).reused, true);
  assert.deepEqual(await snapshot(), after);
  const def = { ...rr.rule.definition, enabled: false };
  const disabled = (
    await ok(base + '/rules/' + rr.rule.id, 'PATCH', {
      version: rr.rule.version,
      name: rr.rule.name,
      definition: def,
    })
  ).rule;
  const original = (
    await pool.query('SELECT definition FROM replenishment_policies WHERE id=$1', [pol.id])
  ).rows[0].definition;
  const { cost_confirmed_at: _confirmed, ...inputDefinition } = original;
  await ok('/replenishment/policies/' + pol.id, 'PATCH', {
    version: pol.version,
    definition: {
      ...inputDefinition,
      confirm_cost: true,
      cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  const enable = {
    version: disabled.version,
    name: disabled.name,
    definition: { ...def, enabled: true },
    confirmed_future_drafts: true,
  };
  assert.equal((await request(base + '/rules/' + disabled.id, 'PATCH', enable)).statusCode, 409);
  const refreshed = (
    await ok(base + '/rules/' + disabled.id, 'PATCH', {
      version: disabled.version,
      name: disabled.name,
      definition: def,
    })
  ).rule;
  await ok(base + '/rules/' + refreshed.id, 'PATCH', { ...enable, version: refreshed.version });
  await tenantTx(tenant, async (c) => {
    await c.query('UPDATE stock SET on_hand=11,version=version+1 WHERE product_id=$1', [p.id]);
    await c.query('UPDATE stock SET on_hand=10,version=version+1 WHERE product_id=$1', [p.id]);
  });
  run = (await runs()).find((r) => r.state === 'queued')!;
  assert(run);
  const raw = (
    await pool.query('SELECT job_id FROM replenishment_automation_runs WHERE id=$1', [run.id])
  ).rows[0];
  await pool.query("UPDATE jobs SET state='failed',error='lease exhausted' WHERE id=$1", [
    raw.job_id,
  ]);
  assert.equal(await reapReplenishmentAutomations(), 1);
  assert.equal((await ok(base + '/runs/' + run.id)).run.result.reason, 'lease_exhausted');
  assert.equal(providers, 0);
});
test('121 forecast uses existing engine and optional config stays frozen', async () => {
  const p = await product();
  await policy(p);
  const forecast = { lookback_days: 30, coverage_days: 14 };
  await rule([p], { forecast });
  await order(p);
  const done = await processRun((await runs())[0]);
  assert.equal(done.state, 'done');
  const pr = (await ok('/replenishment/previews/' + done.result.preview_id)).preview;
  assert.deepEqual(pr.config.forecast, forecast);
  assert(pr.config.forecast_window);
  const row = (await ok('/replenishment/previews/' + pr.id + '/rows')).data[0];
  assert.equal(row.demand.shipped_quantity, '0');
  assert.equal(row.effective_target_quantity, '6');
  assert.equal(row.recommended_quantity, '1');
});
test(
  '121 full 500 product scope, 501 rejection and one statement one run',
  // Hang guard only: one HTTP policy per product (500 requests); 120 s cut it off locally on 13.11.2026.
  { timeout: 900000 },
  async () => {
    const ps = (
      await pool.query(
        `INSERT INTO products(id,tenant_id,sku,name,price,vat) SELECT gen_random_uuid(),$1::uuid,'QA121-range-'||n,'QA121 range '||n,999,23 FROM generate_series(1,500) n RETURNING id,version`,
        [tenant],
      )
    ).rows;
    for (const p of ps) await policy(p, { minimum_quantity: 2, target_quantity: 3 });
    await pool.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) SELECT $1::uuid,$2::uuid,id,2 FROM products WHERE tenant_id=$1',
      [tenant, warehouse],
    );
    const body = ruleBody(ps);
    assert.equal(
      replenishmentAutomationCreateInput.safeParse({
        ...body,
        definition: {
          ...body.definition,
          product_ids: [...body.definition.product_ids, randomUUID()],
        },
      }).success,
      false,
    );
    assert.equal(
      (
        await request(base + '/rules', 'POST', {
          ...body,
          definition: {
            ...body.definition,
            product_ids: [...body.definition.product_ids, randomUUID()],
          },
        })
      ).statusCode,
      422,
    );
    await ok(base + '/rules', 'POST', body, 201);
    await tenantTx(tenant, async (c) => {
      await c.query('UPDATE stock SET on_hand=1,version=version+1 WHERE tenant_id=$1', [tenant]);
    });
    const queued = await runs();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].crossings.length, 500);
    const before = await physical();
    const done = await processRun(queued[0]);
    assert.equal(done.state, 'done');
    assert.equal(done.result.purchase_order_ids.length, 3);
    assert.deepEqual(await physical(), before);
    const counts = (
      await pool.query(
        'SELECT order_id,count(*)::int n FROM purchase_order_lines WHERE tenant_id=$1 GROUP BY order_id ORDER BY n DESC',
        [tenant],
      )
    ).rows.map((r) => r.n);
    assert.deepEqual(counts, [200, 200, 100]);
  },
);
