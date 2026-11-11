import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { processRepricing, failRepricing } from '../server/repricing-schedules';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  address = 1;
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.1.108.' + address,
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode < 300, method + ' ' + path + ' HTTP ' + r.statusCode);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw new Error('Price flow must never call a provider');
    },
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
beforeEach(async () => {
  address++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Price flow','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'admin' FROM users WHERE email='admin@demo.local'",
    [tenant],
  );
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Price flow warehouse','PRF')",
    [warehouse, tenant],
  );
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(extra: any = {}) {
  return ok('/products', 'POST', {
    sku: 'PF-' + randomUUID(),
    name: 'Price flow product',
    price: 10001,
    quantity: 30,
    warehouse_id: warehouse,
    weight_grams: 123,
    manufacturer: 'Fixed manufacturer',
    ...extra,
  });
}
async function list(extra: any = {}) {
  return ok('/price-lists', 'POST', {
    name: 'Price flow ' + randomUUID().slice(0, 8),
    currency: 'PLN',
    fallback: true,
    ...extra,
  });
}
const quote = (p: any, l: any) =>
  ok('/pricing/quote', 'POST', { product_ids: [p.id], price_list_id: l.id });
const protectedTables = [
  'products',
  'product_logistics',
  'product_sku_aliases',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'stock_location_operations',
  'orders',
  'order_items',
  'order_events',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'bundle_components',
  'listings',
  'offer_plans',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
  'product_rule_runs',
  'product_rule_items',
  'product_rule_causes',
];
async function snapshot(tables = protectedTables) {
  const out: Record<string, unknown> = {};
  for (const t of tables)
    out[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [tenant])
    ).rows;
  return out;
}

async function preview(l: any, rows: any[]) {
  const made = await ok('/price-bulk-edit/previews', 'POST', {
    client_key: randomUUID(),
    price_list_id: l.id,
    list_version: l.version,
    rows,
  });
  assert.equal(made.preview.ready, true);
  return made.preview;
}
const set = (p: any, amount: number, basis: 'gross' | 'net' = 'gross') => ({
  product_id: p.id,
  product_version: p.version,
  operation: 'set',
  basis,
  amount_minor: amount,
});
const consent = (plan: any, extra: any = {}) => ({
  client_key: randomUUID(),
  scope_hash: plan.scope_hash,
  confirmed: true,
  ...extra,
});
const execute = (plan: any, body = consent(plan)) =>
  ok('/price-bulk-edit/previews/' + plan.id + '/execute', 'POST', body);
async function currentList(id: string) {
  return (await ok('/price-lists/' + id + '/items')).list;
}
async function oldOrderSnapshot(id: string) {
  return tenantTx(tenant, async (c) => ({
    order: (await c.query('SELECT to_jsonb(o) row FROM orders o WHERE id=$1', [id])).rows,
    items: (
      await c.query('SELECT to_jsonb(i) row FROM order_items i WHERE order_id=$1 ORDER BY 1', [id])
    ).rows,
    allocations: (
      await c.query(
        'SELECT to_jsonb(r) row FROM reservation_locations r WHERE order_id=$1 ORDER BY 1',
        [id],
      )
    ).rows,
  }));
}
async function order(p: any, l: any, extra: any = {}) {
  return ok('/orders', 'POST', {
    customer_name: 'Price snapshot QA',
    email: 'prices@example.test',
    warehouse_id: warehouse,
    price_list_id: l.id,
    currency: l.currency,
    payment_mode: 'cod',
    items: [{ product_id: p.id, quantity: 2 }],
    ...extra,
  });
}

test(
  'a local net-price sheet changes new quotes and orders while old sales, PIM, stock and outbox remain exact',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list({ adjustment_bps: 500, adjustment_amount: 19 });
    const old = await order(p, l),
      oldFrozen = await oldOrderSnapshot(old.id);
    assert.equal(old.items[0].price, 10520);
    assert.equal(old.items[0].line_total, 21040);
    const before = await snapshot(),
      plan = await preview(l, [set(p, 10000, 'net')]);
    const rows = await ok('/price-bulk-edit/previews/' + plan.id + '/rows');
    assert.equal(rows.data[0].before.effective_price, 10520);
    assert.equal(rows.data[0].after.override_price, 12300);
    assert.equal(rows.data[0].after.effective_price, 12300);
    assert.deepEqual(await snapshot(), before);
    const body = consent(plan),
      done = await execute(plan, body);
    assert.equal(done.execution.before_list_version, l.version);
    assert.equal(done.execution.after_list_version, l.version + 1);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await oldOrderSnapshot(old.id), oldFrozen);
    assert.equal((await quote(p, l)).items[0].price, 12300);
    const saved = await snapshot();
    assert.equal((await execute(plan, body)).reused, true);
    assert.deepEqual(await snapshot(), saved);
    const next = await order(p, l, { items: [{ product_id: p.id, quantity: 1 }] });
    assert.equal(next.items[0].price, 12300);
    assert.equal(next.items[0].line_total, 12300);
    assert.equal(next.pricing_snapshot.list.version, l.version + 1);
    assert.deepEqual(await oldOrderSnapshot(old.id), oldFrozen);
    assert.equal((await ok('/products/' + p.id)).version, p.version);
    assert.equal((await ok('/products/' + p.id)).price, p.price);
  },
);

test(
  'foreign-currency removal requires explicit missing-price consent and preserves the earlier EUR sale',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list({ currency: 'EUR', fallback: false }),
      setPlan = await preview(l, [set(p, 999)]);
    await execute(setPlan);
    const current = await currentList(l.id),
      old = await order(p, current),
      oldFrozen = await oldOrderSnapshot(old.id);
    const plan = await preview(current, [
      { product_id: p.id, product_version: p.version, operation: 'remove' },
    ]);
    assert.equal(plan.missing_after_count, 1);
    const rows = await ok('/price-bulk-edit/previews/' + plan.id + '/rows');
    assert.equal(rows.data[0].after.effective_price, null);
    assert.equal(rows.data[0].after.source, 'missing');
    assert.equal(rows.data[0].after.issue, 'missing_override');
    const protectedBefore = await snapshot(),
      priceBefore = await snapshot([
        'price_lists',
        'price_list_items',
        'price_bulk_edit_executions',
        'price_bulk_edit_execution_rows',
        'audit_events',
      ]);
    const approve = consent(plan);
    const denied = await req('/price-bulk-edit/previews/' + plan.id + '/execute', 'POST', approve);
    assert.equal(denied.statusCode, 422, 'Missing-price consent must be rejected');
    assert.deepEqual(await snapshot(), protectedBefore);
    assert.deepEqual(
      await snapshot([
        'price_lists',
        'price_list_items',
        'price_bulk_edit_executions',
        'price_bulk_edit_execution_rows',
        'audit_events',
      ]),
      priceBefore,
    );
    const done = await execute(plan, { ...approve, ack_missing_prices: true });
    assert.equal(done.execution.ack_missing_prices, true);
    assert.equal(done.execution.missing_after_count, 1);
    assert.deepEqual(await snapshot(), protectedBefore);
    assert.deepEqual(await oldOrderSnapshot(old.id), oldFrozen);
    assert.equal(
      (await req('/pricing/quote', 'POST', { product_ids: [p.id], price_list_id: l.id }))
        .statusCode,
      422,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM price_list_items WHERE price_list_id=$1 AND product_id=$2',
          [l.id, p.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await ok('/products/' + p.id)).price, p.price);
  },
);

async function repricing(p: any, l: any) {
  let rule = await ok('/price-lists/' + l.id + '/repricing', 'PUT', { version: 0, config: {} });
  rule = await ok('/price-lists/' + l.id + '/repricing/inputs', 'PUT', {
    version: rule.version,
    items: [{ product_id: p.id, net_cost: 5000, source: 'Explicit controlled local net cost' }],
  });
  return rule;
}

test(
  'a queued automatic repricing run survives the sheet as configuration and then stops at shared list CAS',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list(),
      rule = await repricing(p, l),
      root = '/price-lists/' + l.id + '/repricing';
    const cfg = (
      await ok(root + '/schedule', 'PUT', {
        version: 0,
        enabled: true,
        rule_config_version: rule.config_version,
        interval_minutes: 5,
        batch_size: 2,
        confirmed: true,
      })
    ).schedule;
    const run = await ok(root + '/schedule/run', 'POST', {
      version: cfg.version,
      client_key: randomUUID(),
    });
    const frozenAutomation = await snapshot([
      'repricing_rules',
      'repricing_inputs',
      'repricing_schedules',
      'repricing_runs',
      'jobs',
    ]);
    const plan = await preview(l, [set(p, 4321)]);
    assert(plan.warnings.length > 0);
    assert.equal(plan.repricing_snapshot.queued_run.id, run.id);
    const protectedBefore = await snapshot();
    await execute(plan);
    assert.deepEqual(await snapshot(), protectedBefore);
    assert.deepEqual(
      await snapshot([
        'repricing_rules',
        'repricing_inputs',
        'repricing_schedules',
        'repricing_runs',
        'jobs',
      ]),
      frozenAutomation,
    );
    const priceBefore = await snapshot(['price_lists', 'price_list_items']),
      lease = randomUUID();
    const job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 AND state='pending' RETURNING *",
        [run.job_id, lease],
      )
    ).rows[0];
    assert(job);
    let failure: unknown;
    try {
      await processRepricing(job);
    } catch (error) {
      failure = error;
    }
    assert.equal(
      (failure as any)?.status,
      409,
      'The real worker must reject the list version changed by the sheet',
    );
    await failRepricing(job, failure);
    assert.deepEqual(await snapshot(['price_lists', 'price_list_items']), priceBefore);
    const final = (await ok('/repricing-runs/' + run.id)).run;
    assert.equal(final.state, 'failed');
    assert.equal(final.changed, 0);
    assert.equal(final.scanned, 0);
    assert.equal((await ok(root + '/schedule')).schedule.enabled, true);
    assert.equal((await quote(p, l)).items[0].price, 4321);
  },
);

test(
  'manual repricing and frozen sheet approvals cannot both consume the same list version',
  { timeout: 20000 },
  async () => {
    for (const first of ['sheet', 'repricing']) {
      const p = await product(),
        l = await list();
      await repricing(p, l);
      const reprice = await ok('/price-lists/' + l.id + '/repricing/previews', 'POST', {
          client_key: randomUUID(),
          product_ids: [p.id],
        }),
        plan = await preview(l, [set(p, 7777)]),
        before = await snapshot();
      if (first === 'sheet') {
        await execute(plan);
        const saved = await snapshot([
          'price_lists',
          'price_list_items',
          'audit_events',
          'repricing_previews',
        ]);
        assert.equal(
          (await req('/repricing-previews/' + reprice.id + '/apply', 'POST', { confirmed: true }))
            .statusCode,
          409,
        );
        assert.deepEqual(
          await snapshot(['price_lists', 'price_list_items', 'audit_events', 'repricing_previews']),
          saved,
        );
        assert.equal((await quote(p, l)).items[0].price, 7777);
      } else {
        const applied = await ok('/repricing-previews/' + reprice.id + '/apply', 'POST', {
          confirmed: true,
        });
        assert.equal(applied.state, 'applied');
        const saved = await snapshot([
          'price_lists',
          'price_list_items',
          'audit_events',
          'repricing_previews',
          'price_bulk_edit_executions',
          'price_bulk_edit_execution_rows',
        ]);
        assert.equal(
          (await req('/price-bulk-edit/previews/' + plan.id + '/execute', 'POST', consent(plan)))
            .statusCode,
          409,
        );
        assert.deepEqual(
          await snapshot([
            'price_lists',
            'price_list_items',
            'audit_events',
            'repricing_previews',
            'price_bulk_edit_executions',
            'price_bulk_edit_execution_rows',
          ]),
          saved,
        );
        assert.equal((await quote(p, l)).items[0].price, reprice.result[0].proposed_price);
      }
      assert.deepEqual(await snapshot(), before);
    }
  },
);
