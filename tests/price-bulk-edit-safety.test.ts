import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { pimIncomplete, tenantDataDigest } from './torn-module-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '',
  viewer = '',
  other = '',
  tenant = '',
  warehouse = '',
  adminId = '',
  address = 1;
const cookies = new Map<string, string>();
const transport = async () => {
  throw new Error('Price safety must never call a provider');
};
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin, target = app) =>
  target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.108.' + address,
  });
async function ok(path: string, method: any = 'GET', body?: any, cookie = admin, status = 200) {
  const r = await req(path, method, body, cookie);
  assert.equal(r.statusCode, status, method + ' ' + path + ' HTTP status');
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
  app = await buildApp({ integrationTransport: transport });
  for (const email of ['admin@demo.local', 'viewer@demo.local', 'other@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  address++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Price safety','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Price warehouse','PR')",
    [warehouse, tenant],
  );
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(extra: any = {}) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'PRICE-' + randomUUID(),
      name: 'Price safety product',
      price: 1234,
      quantity: 20,
      warehouse_id: warehouse,
      ...extra,
    },
    admin,
    201,
  );
}
async function list(extra: any = {}) {
  return ok(
    '/price-lists',
    'POST',
    { name: 'Price safety ' + randomUUID().slice(0, 8), currency: 'PLN', fallback: true, ...extra },
    admin,
    201,
  );
}
const businessTables = [
  'products',
  'product_logistics',
  'product_sku_aliases',
  'price_lists',
  'price_list_items',
  'repricing_rules',
  'repricing_inputs',
  'repricing_schedules',
  'repricing_runs',
  'repricing_previews',
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
  'audit_events',
  'product_rule_runs',
  'product_rule_items',
  'product_rule_causes',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
const evidenceTables = [
  'price_bulk_edit_previews',
  'price_bulk_edit_rows',
  'price_bulk_edit_executions',
  'price_bulk_edit_execution_rows',
];
async function snapshot(tables = [...businessTables, ...evidenceTables]) {
  const out: Record<string, unknown> = {};
  for (const t of tables)
    out[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [tenant])
    ).rows;
  return out;
}
async function waitOn(holder: PoolClient, kind: 'list' | 'product' | 'entry' | 'repricing') {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (
      rows.some((r) =>
        kind === 'list'
          ? r.query.includes('price_lists') && /FOR\s+(UPDATE|SHARE)/i.test(r.query)
          : kind === 'product'
            ? r.query.includes('products') && /FOR\s+SHARE/i.test(r.query)
            : kind === 'repricing'
              ? r.query.includes('INSERT INTO repricing_')
              : r.query.includes('price_list_items'),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The actual price operation never waited on the held ' + kind + ' lock');
}
async function changeGrant(sql: string, args: unknown[]) {
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
const downgrade = () =>
  changeGrant("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    adminId,
  ]);

async function preview(
  l: any,
  products: any[],
  operations: any = { operation: 'set', basis: 'gross', amount_minor: 4321 },
) {
  const body = {
    client_key: randomUUID(),
    price_list_id: l.id,
    list_version: l.version,
    rows: products.map((p: any) => ({
      product_id: p.id,
      product_version: p.version,
      ...operations,
    })),
  };
  const made = await ok('/price-bulk-edit/previews', 'POST', body, admin, 201);
  assert.equal(made.preview.ready, true);
  return { plan: made.preview, body };
}
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const executePath = (p: any) => '/price-bulk-edit/previews/' + p.id + '/execute';
async function rule(l: any) {
  return ok('/price-lists/' + l.id + '/repricing', 'PUT', { version: 0, config: {} });
}
async function schedule(l: any, r: any) {
  return (
    await ok('/price-lists/' + l.id + '/repricing/schedule', 'PUT', {
      version: 0,
      enabled: true,
      rule_config_version: r.config_version,
      interval_minutes: 5,
      batch_size: 2,
      confirmed: true,
    })
  ).schedule;
}

test(
  'price-list wait permits role withdrawal before the new frozen execution can write',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list(),
      { plan } = await preview(l, [p]),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM price_lists WHERE id=$1 FOR UPDATE', [l.id]);
      pending = req(executePath(plan), 'POST', consent(plan));
      await waitOn(holder, 'list');
      await downgrade();
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'product SHARE wait authorizes after the actual wait, preserving the whole list and receipts',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list(),
      { plan } = await preview(l, [p]),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
      pending = req(executePath(plan), 'POST', consent(plan));
      await waitOn(holder, 'product');
      await downgrade();
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'existing override wait leaves grants free and denial rolls back a mixed insert/update batch',
  { timeout: 20000 },
  async () => {
    const a = await product(),
      b = await product();
    let l = await list();
    l = await ok('/price-lists/' + l.id + '/items', 'PUT', {
      version: l.version,
      items: [{ product_id: a.id, price: 2000 }],
    });
    const { plan } = await preview(l, [a, b]),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT product_id FROM price_list_items WHERE price_list_id=$1 AND product_id=$2 FOR UPDATE',
        [l.id, a.id],
      );
      pending = req(executePath(plan), 'POST', consent(plan));
      await waitOn(holder, 'entry');
      await downgrade();
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'public price writes check actual revoke, expiry and scope after a held product row',
  { timeout: 30000 },
  async () => {
    for (const change of ['revoke', 'expiry', 'scope']) {
      const p = await product(),
        l = await list(),
        key = await ok(
          '/developer/keys',
          'POST',
          { name: 'Late price ' + change, scopes: ['products:read', 'products:write'] },
          admin,
          201,
        ),
        headers = { authorization: 'Bearer ' + key.token };
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/price-bulk-edit/previews',
        headers,
        payload: {
          client_key: randomUUID(),
          price_list_id: l.id,
          list_version: l.version,
          rows: [
            {
              product_id: p.id,
              product_version: p.version,
              operation: 'set',
              basis: 'net',
              amount_minor: 2345,
            },
          ],
        },
      });
      assert.equal(r.statusCode, 201);
      const plan = r.json().preview,
        before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof req> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
        pending = app.inject({
          method: 'POST',
          url: '/api/v1' + executePath(plan),
          headers,
          payload: consent(plan),
        });
        await waitOn(holder, 'product');
        await changeGrant(
          change === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : change === 'expiry'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
          [key.id],
        );
        await holder.query('COMMIT');
        assert.equal((await pending).statusCode, change === 'scope' ? 403 : 401);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
      }
    }
  },
);

test(
  'actual preview locks list and existing repricing parents against new rule, schedule and run inserts',
  { timeout: 30000 },
  async () => {
    for (const kind of ['rule', 'schedule', 'run']) {
      const p = await product(),
        l = await list();
      let configured: any;
      if (kind !== 'rule') {
        const r = await rule(l);
        if (kind === 'run') configured = await schedule(l, r);
      }
      const job = randomUUID();
      if (kind === 'run')
        await pool.query(
          "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'pricing.reprice','{}',$3)",
          [job, tenant, 'raw-fence:' + job],
        );
      const holder = await pool.connect(),
        inserter = await pool.connect();
      let pending: Promise<any> | undefined, previewRequest: ReturnType<typeof req> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
        previewRequest = req('/price-bulk-edit/previews', 'POST', {
          client_key: randomUUID(),
          price_list_id: l.id,
          list_version: l.version,
          rows: [
            {
              product_id: p.id,
              product_version: p.version,
              operation: 'set',
              basis: 'gross',
              amount_minor: 4321,
            },
          ],
        });
        await waitOn(holder, 'product');
        const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const writerPid = (
          await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM products%' AND query ILIKE '%FOR SHARE%'",
            [holderPid],
          )
        ).rows[0]?.pid;
        assert(writerPid, 'Real preview must wait after acquiring the repricing frame');
        await inserter.query('BEGIN');
        await inserter.query('SET LOCAL ROLE dyna_app');
        await inserter.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
        pending =
          kind === 'rule'
            ? inserter.query(
                "INSERT INTO repricing_rules(tenant_id,price_list_id,config) VALUES($1,$2,'{}')",
                [tenant, l.id],
              )
            : kind === 'schedule'
              ? inserter.query(
                  'INSERT INTO repricing_schedules(tenant_id,price_list_id,actor_id,enabled,rule_config_version,interval_minutes,batch_size) VALUES($1,$2,$3,false,1,5,2)',
                  [tenant, l.id, adminId],
                )
              : inserter.query(
                  'INSERT INTO repricing_runs(id,tenant_id,price_list_id,actor_id,client_key,job_id,schedule_version,rule_version,initial_list_version,expected_list_version,batch_size,total) VALUES($1,$2,$3,$4,$5,$6,$7,1,1,1,2,0)',
                  [randomUUID(), tenant, l.id, adminId, randomUUID(), job, configured.version],
                );
        const deadline = Date.now() + 2500;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked =
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%INSERT INTO repricing_%'",
                [writerPid],
              )
            ).rowCount! > 0;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        assert(blocked, 'Raw INSERT must wait on the real preview parent lock');
        await holder.query('COMMIT');
        assert.equal((await previewRequest).statusCode, 201);
        await pending;
      } finally {
        await holder.query('ROLLBACK');
        await inserter.query('ROLLBACK');
        holder.release();
        inserter.release();
        await pending;
        await previewRequest;
      }
    }
  },
);

test(
  'new repricing configuration or queued run conflicts even when price-list version is unchanged',
  { timeout: 20000 },
  async () => {
    for (const change of ['rule', 'schedule', 'run']) {
      const p = await product(),
        l = await list();
      let r: any, cfg: any;
      if (change !== 'rule') r = await rule(l);
      if (change === 'run') cfg = await schedule(l, r);
      const { plan } = await preview(l, [p]);
      if (change === 'rule') await rule(l);
      else if (change === 'schedule') await schedule(l, r);
      else
        await ok('/price-lists/' + l.id + '/repricing/schedule/run', 'POST', {
          version: cfg.version,
          client_key: randomUUID(),
        });
      assert.equal(
        (await pool.query('SELECT version FROM price_lists WHERE id=$1', [l.id])).rows[0].version,
        l.version,
      );
      const before = await snapshot();
      assert.equal((await req(executePath(plan), 'POST', consent(plan))).statusCode, 409);
      assert.deepEqual(await snapshot(), before);
    }
  },
);

test(
  'canonical frozen receipt replays once, remains actor-bound and still requires the current role',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list(),
      { plan, body } = await preview(l, [p]),
      approve = consent(plan);
    await ok(executePath(plan), 'POST', approve, admin, 201);
    const saved = await snapshot();
    const reordered = {
      rows: body.rows.map((r) => Object.fromEntries(Object.entries(r).reverse())),
      list_version: body.list_version,
      price_list_id: body.price_list_id,
      client_key: body.client_key,
    };
    assert.equal((await ok('/price-bulk-edit/previews', 'POST', reordered)).reused, true);
    assert.equal(
      (
        await ok(executePath(plan), 'POST', {
          confirmed: true,
          scope_hash: approve.scope_hash,
          client_key: approve.client_key,
          ack_missing_prices: false,
        })
      ).reused,
      true,
    );
    assert.deepEqual(await snapshot(), saved);
    assert.equal((await req(executePath(plan), 'POST', approve, other)).statusCode, 409);
    assert.equal(
      (
        await req('/price-bulk-edit/previews', 'POST', {
          ...body,
          rows: body.rows.map((r) => ({ ...r, amount_minor: 4322 })),
        })
      ).statusCode,
      409,
    );
    assert.deepEqual(await snapshot(), saved);
    await downgrade();
    assert.equal((await req(executePath(plan), 'POST', approve)).statusCode, 403);
    assert.deepEqual(await snapshot(), saved);
  },
);

test(
  'override ABA and a changed VAT on one selected product reject every approved row',
  { timeout: 20000 },
  async () => {
    const a = await product(),
      b = await product();
    let l = await list();
    l = await ok('/price-lists/' + l.id + '/items', 'PUT', {
      version: l.version,
      items: [{ product_id: a.id, price: 2222 }],
    });
    const { plan } = await preview(l, [a, b]);
    l = await ok('/price-lists/' + l.id + '/items', 'PUT', {
      version: l.version,
      items: [{ product_id: a.id, price: 3333 }],
    });
    l = await ok('/price-lists/' + l.id + '/items', 'PUT', {
      version: l.version,
      items: [{ product_id: a.id, price: 2222 }],
    });
    const before = await snapshot();
    assert.equal((await req(executePath(plan), 'POST', consent(plan))).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
    const { plan: vatPlan } = await preview(l, [a, b], {
      operation: 'set',
      basis: 'net',
      amount_minor: 1235,
    });
    const detail = await ok('/products/' + b.id);
    await ok('/products/' + b.id, 'PATCH', { ...detail, vat: 8 });
    const after = await snapshot();
    assert.equal((await req(executePath(vatPlan), 'POST', consent(vatPlan))).statusCode, 409);
    assert.deepEqual(await snapshot(), after);
  },
);

test(
  'price evidence is immutable and tenant-bound, including foreign list/product SQL attempts',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list(),
      { plan } = await preview(l, [p]);
    await ok(executePath(plan), 'POST', consent(plan), admin, 201);
    const before = await snapshot();
    for (const table of evidenceTables) {
      const flags = (
        await pool.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(flags.relrowsecurity && flags.relforcerowsecurity);
      assert.equal(
        (
          await tenantTx(SECOND_TENANT, (c) =>
            c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [tenant]),
          )
        ).rows[0].n,
        0,
      );
      for (const sql of [
        `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`,
        `DELETE FROM ${table} WHERE tenant_id=$1`,
      ])
        await assert.rejects(pool.query(sql, [tenant]), (e: any) => /immutable/i.test(e.message));
    }
    const foreignList = randomUUID();
    await pool.query(
      "INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,'Foreign price','PLN')",
      [foreignList, SECOND_TENANT],
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO price_bulk_edit_previews SELECT(jsonb_populate_record(NULL::price_bulk_edit_previews,to_jsonb(p)||jsonb_build_object('id',$1::uuid,'client_key',$2::uuid,'price_list_id',$3::uuid))).* FROM price_bulk_edit_previews p WHERE id=$4",
        [randomUUID(), randomUUID(), foreignList, plan.id],
      ),
      (e: any) => e.code === '23503',
    );
    const foreign = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
    ).rows[0].id;
    const c = await pool.connect(),
      fresh = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO price_bulk_edit_previews SELECT(jsonb_populate_record(NULL::price_bulk_edit_previews,to_jsonb(p)||jsonb_build_object('id',$1::uuid,'client_key',$2::uuid))).* FROM price_bulk_edit_previews p WHERE id=$3",
        [fresh, randomUUID(), plan.id],
      );
      await assert.rejects(
        c.query(
          "INSERT INTO price_bulk_edit_rows SELECT(jsonb_populate_record(NULL::price_bulk_edit_rows,to_jsonb(r)||jsonb_build_object('preview_id',$1::uuid,'product_id',$2::uuid,'input',r.input||jsonb_build_object('product_id',$2::uuid)))).* FROM price_bulk_edit_rows r WHERE preview_id=$3",
          [fresh, foreign, plan.id],
        ),
        (e: any) => e.code === '23503',
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    assert.deepEqual(await snapshot(), before);
  },
);

test(
  'execution-row evidence accepts the exact approved result and rejects altered values or shared versions',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      l = await list(),
      { plan } = await preview(l, [p]);
    await ok(executePath(plan), 'POST', consent(plan), admin, 201);
    const before = await snapshot();
    const original = (
      await pool.query('SELECT * FROM price_bulk_edit_execution_rows WHERE preview_id=$1', [
        plan.id,
      ])
    ).rows[0];
    const freshPreview = randomUUID(),
      freshExecution = randomUUID(),
      c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO price_bulk_edit_previews SELECT(jsonb_populate_record(NULL::price_bulk_edit_previews,to_jsonb(p)||jsonb_build_object('id',$1::uuid,'client_key',$2::uuid))).* FROM price_bulk_edit_previews p WHERE id=$3",
        [freshPreview, randomUUID(), plan.id],
      );
      await c.query(
        "INSERT INTO price_bulk_edit_rows SELECT(jsonb_populate_record(NULL::price_bulk_edit_rows,to_jsonb(r)||jsonb_build_object('preview_id',$1::uuid))).* FROM price_bulk_edit_rows r WHERE preview_id=$2",
        [freshPreview, plan.id],
      );
      await c.query(
        "INSERT INTO price_bulk_edit_executions SELECT(jsonb_populate_record(NULL::price_bulk_edit_executions,to_jsonb(e)||jsonb_build_object('id',$1::uuid,'preview_id',$2::uuid,'client_key',$3::uuid))).* FROM price_bulk_edit_executions e WHERE preview_id=$4",
        [freshExecution, freshPreview, randomUUID(), plan.id],
      );
      const insert = (change: Record<string, unknown>) =>
        c.query(
          'INSERT INTO price_bulk_edit_execution_rows SELECT(jsonb_populate_record(NULL::price_bulk_edit_execution_rows,to_jsonb(r)||$1::jsonb)).* FROM price_bulk_edit_execution_rows r WHERE preview_id=$2',
          [
            JSON.stringify({ execution_id: freshExecution, preview_id: freshPreview, ...change }),
            plan.id,
          ],
        );
      await c.query('SAVEPOINT evidence');
      await insert({});
      assert.equal(
        (
          await c.query(
            'SELECT count(*)::int n FROM price_bulk_edit_execution_rows WHERE execution_id=$1',
            [freshExecution],
          )
        ).rows[0].n,
        1,
      );
      await c.query('ROLLBACK TO SAVEPOINT evidence');
      const changes = [
        { sku: original.sku + '-forged' },
        { name: 'Unapproved execution name' },
        { input: { ...original.input, amount_minor: original.input.amount_minor + 1 } },
        { operation: 'remove' },
        { status: 'unchanged' },
        { before: { ...original.before, catalog_price: original.before.catalog_price + 1 } },
        { after: { ...original.after, override_price: original.after.override_price + 1 } },
        { before_list_version: original.before_list_version + 1 },
        { after_list_version: original.after_list_version + 1 },
      ];
      for (const change of changes) {
        await assert.rejects(
          insert(change),
          (e: any) => e.code === 'P0001' && /differs from approved row/i.test(e.message),
        );
        await c.query('ROLLBACK TO SAVEPOINT evidence');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    assert.deepEqual(await snapshot(), before);
  },
);

test(
  'readonly gates writes before parsing, a torn price module fails closed, and viewer/read-only keys cannot approve prices',
  { timeout: 60000 },
  async () => {
    const p = await product(),
      l = await list(),
      keys = [];
    for (const scopes of [['products:read'], ['products:write']])
      keys.push(
        await ok('/developer/keys', 'POST', { name: 'Price incomplete scope', scopes }, admin, 201),
      );
    const { body } = await preview(l, [p]),
      before = await snapshot();
    assert.equal((await ok('/price-bulk-edit', 'GET', undefined, viewer)).can_write, false);
    assert.equal(
      (
        await req(
          '/price-bulk-edit/previews',
          'POST',
          { ...body, client_key: randomUUID() },
          viewer,
        )
      ).statusCode,
      403,
    );
    for (const key of keys)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/price-bulk-edit/previews',
            headers: { authorization: 'Bearer ' + key.token },
            payload: { ...body, client_key: randomUUID() },
          })
        ).statusCode,
        403,
      );
    assert.deepEqual(await snapshot(), before);
    const authFor = async (target: Awaited<ReturnType<typeof buildApp>>) => {
      const cookie = await login('admin@demo.local', target),
        r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie, target);
      assert.equal(r.statusCode, 200);
      return String(r.headers['set-cookie']).split(';')[0];
    };
    let ro: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      ro = await buildApp({ readOnly: true, integrationTransport: transport });
      const auth = await authFor(ro),
        meta = await req('/price-bulk-edit', 'GET', undefined, auth, ro);
      assert.equal(meta.statusCode, 200);
      assert.equal(meta.json().can_write, false);
      assert.match(String(meta.headers['cache-control']), /no-store/);
      assert.equal(
        (
          await ro.inject({
            method: 'POST',
            url: '/api/price-bulk-edit/previews',
            headers: { cookie: auth, 'content-type': 'application/json' },
            payload: '{',
          })
        ).statusCode,
        423,
      );
    } finally {
      if (ro) await ro.close();
    }
    await pool.query(
      'ALTER TABLE price_bulk_edit_previews RENAME TO price_bulk_edit_previews_hidden_qa108',
    );
    // Hidden in the full schema this is a torn install, not an older copy: the
    // application refuses to start on it (PIM integrity), with no write.
    try {
      const digest = await tenantDataDigest();
      await assert.rejects(buildApp({ integrationTransport: transport }), pimIncomplete);
      assert.deepEqual(await tenantDataDigest(), digest);
    } finally {
      await pool.query(
        'ALTER TABLE price_bulk_edit_previews_hidden_qa108 RENAME TO price_bulk_edit_previews',
      );
    }
    assert.equal((await req('/products/' + p.id, 'GET', undefined, admin)).statusCode, 200);
  },
);
