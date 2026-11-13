import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { inventoryBulkEditOperationKey } from '../server/inventory-bulk-edit';
import { seed, SECOND_TENANT } from './fixtures';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';
import { pimIncomplete, tenantDataDigest } from './torn-module-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '',
  viewer = '',
  tenant = '',
  warehouse = '',
  adminId = '',
  address = 1;
const cookies = new Map<string, string>();
const transport = async () => {
  throw new Error('Inventory safety must never call a provider');
};
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin, target = app) =>
  target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.107.' + address,
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
  for (const email of ['admin@demo.local', 'viewer@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  address++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Inventory safety','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Inventory','INV')",
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
      sku: 'INV-' + randomUUID(),
      name: 'Physical inventory product',
      price: 1234,
      quantity: 20,
      location: 'A-01',
      warehouse_id: warehouse,
      ...extra,
    },
    admin,
    201,
  );
}
async function selected(p: any, location = 'A-01') {
  const s = await ok('/inventory-bulk-edit/selection?warehouse_id=' + warehouse + '&ids=' + p.id);
  const row = s.data.find((r: any) => r.location === location);
  assert(row, 'The real selection must include the requested location');
  return row;
}
async function input(
  p: any,
  operation: any = { operation: 'count', quantity: 17 },
  location = 'A-01',
) {
  const s = await selected(p, location);
  return {
    product_id: p.id,
    product_version: s.product_version,
    location,
    stock_version: s.stock_version,
    ...operation,
  };
}
async function preview(rows: any[], source = 'manual') {
  const body = {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    note: 'Explicit inventory safety approval',
    rows,
  };
  if (source !== 'manual') throw new Error('Use actual public API when creating an API preview');
  const made = await ok('/inventory-bulk-edit/previews', 'POST', body, admin, 201);
  assert.equal(made.preview.ready, true);
  return { plan: made.preview, body };
}
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const path = (p: any) => '/inventory-bulk-edit/previews/' + p.id + '/execute';
const businessTables = [
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
  'picking_waves',
  'picking_wave_orders',
  'picking_wave_scans',
  'bundle_components',
  'listings',
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
  'inventory_bulk_edit_previews',
  'inventory_bulk_edit_rows',
  'inventory_bulk_edit_executions',
  'inventory_bulk_edit_execution_rows',
];
async function snapshot(tables = [...businessTables, ...evidenceTables]) {
  const out: Record<string, unknown> = {};
  for (const table of tables)
    out[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return out;
}
async function waitOn(holder: PoolClient, kind: 'stock' | 'bin' | 'operation') {
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
        kind === 'operation'
          ? r.query.includes('pg_advisory_xact_lock')
          : kind === 'bin'
            ? r.query.includes('stock_locations') && /FOR\s+UPDATE/i.test(r.query)
            : /FROM stock\s/i.test(r.query) && /FOR\s+UPDATE/i.test(r.query),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The real inventory operation never waited on the held ' + kind + ' lock');
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
async function moveFixture(p: any) {
  const s = await selected(p);
  await ok('/stock-location-moves', 'POST', {
    warehouse_id: warehouse,
    product_id: p.id,
    location: 'A-01',
    destination: 'B-02',
    quantity: 4,
    expected_version: s.stock_version,
    client_key: randomUUID(),
    note: 'Prepare existing destination bin',
  });
}

test(
  'stock row wait permits role withdrawal and rolls back every stock, ledger and execution effect',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      { plan } = await preview([await input(p)]),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE',
        [warehouse, p.id],
      );
      pending = req(path(plan), 'POST', consent(plan));
      await waitOn(holder, 'stock');
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
  'a pre-existing destination bin wait does not pin membership and withdrawal also prevents new warehouse stock',
  { timeout: 20000 },
  async () => {
    const mover = await product();
    await moveFixture(mover);
    const otherWarehouse = randomUUID();
    await pool.query(
      "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Other warehouse','OTHER')",
      [otherWarehouse, tenant],
    );
    const missing = await product({ warehouse_id: otherWarehouse });
    const { plan } = await preview([
      await input(missing, { operation: 'count', quantity: 5 }),
      await input(mover, { operation: 'move', quantity: 2, destination: 'B-02' }),
    ]);
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      // Existing bin SELECT holds no new FK lock on stock: this proves the destination/bin path itself.
      await holder.query(
        "SELECT location FROM stock_locations WHERE warehouse_id=$1 AND product_id=$2 AND location='B-02' FOR UPDATE",
        [warehouse, mover.id],
      );
      pending = req(path(plan), 'POST', consent(plan));
      await waitOn(holder, 'bin');
      await downgrade();
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM stock WHERE warehouse_id=$1 AND product_id=$2',
            [warehouse, missing.id],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'operation advisory wait occurs before any stock lock and current role denial leaves no operation receipt',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      { plan } = await preview([await input(p)]),
      body = consent(plan),
      key = inventoryBulkEditOperationKey(plan.id, body.client_key, 0);
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `stock-location:${tenant}:${key}`,
      ]);
      pending = req(path(plan), 'POST', body);
      await waitOn(holder, 'operation');
      // A conflicting legacy operation can acquire its stock without a bulk stock→operation cycle.
      await holder.query(
        'SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE NOWAIT',
        [warehouse, p.id],
      );
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
  'public inventory execution rechecks revoked and reduced-scope keys after the real stock wait',
  { timeout: 30000 },
  async () => {
    for (const change of ['revoke', 'scope', 'expiry']) {
      const p = await product(),
        row = await input(p),
        key = await ok(
          '/developer/keys',
          'POST',
          {
            name: 'Inventory late ' + change,
            scopes: ['products:read', 'inventory:read', 'inventory:write'],
          },
          admin,
          201,
        );
      const headers = { authorization: 'Bearer ' + key.token };
      const made = await app.inject({
        method: 'POST',
        url: '/api/v1/inventory-bulk-edit/previews',
        headers,
        payload: {
          client_key: randomUUID(),
          warehouse_id: warehouse,
          note: 'Public inventory consent',
          rows: [row],
        },
      });
      assert.equal(made.statusCode, 201);
      const plan = made.json().preview,
        before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof req> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE',
          [warehouse, p.id],
        );
        pending = app.inject({
          method: 'POST',
          url: '/api/v1' + path(plan),
          headers,
          payload: consent(plan),
        });
        await waitOn(holder, 'stock');
        await changeGrant(
          change === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : change === 'expiry'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['products:read','inventory:read']::text[] WHERE id=$1",
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
  'a valid count and move preserve UUID catalogue, order snapshots and exact reserved-bin allocations',
  { timeout: 20000 },
  async () => {
    const p = await product({ weight_grams: 701, manufacturer: 'Stable maker' });
    await moveFixture(p);
    const order = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Inventory preservation',
        email: 'inventory@example.test',
        warehouse_id: warehouse,
        items: [{ product_id: p.id, quantity: 3 }],
      },
      admin,
      201,
    );
    const protectedTables = businessTables.filter(
      (t) =>
        ![
          'stock',
          'stock_locations',
          'stock_movements',
          'stock_location_movements',
          'stock_location_operations',
          'audit_events',
        ].includes(t),
    );
    const before = await snapshot(protectedTables),
      s = await selected(p);
    assert.equal(s.reserved, 3);
    const { plan } = await preview([
      await input(p, { operation: 'count', quantity: 15 }),
      await input(p, { operation: 'none' }, 'B-02'),
    ]);
    await ok(path(plan), 'POST', consent(plan), admin, 201);
    assert.deepEqual(await snapshot(protectedTables), before);
    const bins = await ok('/stock-locations?warehouse_id=' + warehouse + '&product_id=' + p.id);
    assert.equal(bins.data.find((b: any) => b.location === 'A-01').quantity, 15);
    assert.equal(bins.data.find((b: any) => b.location === 'A-01').reserved, 3);
    assert.equal((await ok('/orders/' + order.id)).items[0].sku, p.sku);
    const { plan: movePlan } = await preview([
      await input(p, { operation: 'move', quantity: 2, destination: 'B-02' }),
    ]);
    await ok(path(movePlan), 'POST', consent(movePlan), admin, 201);
    assert.deepEqual(await snapshot(protectedTables), before);
    assert.equal((await ok('/products/' + p.id)).version, p.version);
  },
);

test(
  'one stale stock row rejects the entire approved sheet without partial operations',
  { timeout: 20000 },
  async () => {
    const a = await product(),
      b = await product(),
      { plan } = await preview([await input(a), await input(b)]);
    const s = await selected(b);
    await ok('/stock-location-counts', 'POST', {
      warehouse_id: warehouse,
      product_id: b.id,
      location: 'A-01',
      quantity: 19,
      expected_version: s.stock_version,
      client_key: randomUUID(),
      note: 'Independent count after approval',
    });
    const before = await snapshot();
    assert.equal((await req(path(plan), 'POST', consent(plan))).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  },
);

test(
  'missing-stock zero count is a genuine NOP and canonical retry creates no extra evidence or effects',
  { timeout: 20000 },
  async () => {
    const other = randomUUID();
    await pool.query(
      "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'NOP origin','NOP')",
      [other, tenant],
    );
    const p = await product({ warehouse_id: other }),
      row = await input(p, { operation: 'count', quantity: 0 }),
      { plan, body } = await preview([row]);
    assert.equal(plan.changed, 0);
    assert.equal(plan.unchanged, 1);
    const protectedTables = businessTables.filter((t) => t !== 'audit_events'),
      before = await snapshot(protectedTables),
      approve = consent(plan);
    const done = await ok(path(plan), 'POST', approve, admin, 201);
    assert.equal(done.execution.changed, 0);
    assert.deepEqual(await snapshot(protectedTables), before);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM stock WHERE warehouse_id=$1 AND product_id=$2',
          [warehouse, p.id],
        )
      ).rows[0].n,
      0,
    );
    const saved = await snapshot();
    const reversed = {
      rows: body.rows.map((r) => Object.fromEntries(Object.entries(r).reverse())),
      note: body.note,
      warehouse_id: body.warehouse_id,
      client_key: body.client_key,
    };
    assert.equal((await ok('/inventory-bulk-edit/previews', 'POST', reversed)).reused, true);
    assert.equal(
      (
        await ok(path(plan), 'POST', {
          confirmed: true,
          scope_hash: approve.scope_hash,
          client_key: approve.client_key,
        })
      ).reused,
      true,
    );
    assert.deepEqual(await snapshot(), saved);
    assert.equal(
      (await req(path(plan), 'POST', { ...approve, scope_hash: '0'.repeat(64) })).statusCode,
      409,
    );
    assert.deepEqual(await snapshot(), saved);
    // Fill only this disposable tenant's append-only evidence quotas. Exact receipts still work,
    // while another approval cannot bypass the quota or produce any financial/inventory effect.
    await pool.query(
      'INSERT INTO inventory_bulk_edit_previews SELECT gen_random_uuid(),tenant_id,actor_id,warehouse_id,gen_random_uuid(),request_hash,scope_hash,source,note,total,changed,unchanged,invalid,conflicts,ready,created_at FROM inventory_bulk_edit_previews CROSS JOIN generate_series(1,1999) WHERE id=$1',
      [plan.id],
    );
    await tenantScopedOwnerQuery(
      tenant,
      'INSERT INTO inventory_bulk_edit_executions SELECT gen_random_uuid(),p.tenant_id,p.id,p.actor_id,gen_random_uuid(),e.request_hash,p.scope_hash,e.state,p.total,p.changed,p.unchanged,e.created_at FROM inventory_bulk_edit_previews p CROSS JOIN inventory_bulk_edit_executions e WHERE e.id=$1 AND p.tenant_id=$2 AND p.id<>$3',
      [done.execution.id, tenant, plan.id],
    );
    const count = async () => ({
      previews: (
        await pool.query(
          'SELECT count(*)::int n FROM inventory_bulk_edit_previews WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
      executions: (
        await pool.query(
          'SELECT count(*)::int n FROM inventory_bulk_edit_executions WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
    });
    assert.deepEqual(await count(), { previews: 2000, executions: 2000 });
    const quotaBusiness = await snapshot(businessTables);
    assert.equal((await ok('/inventory-bulk-edit/previews', 'POST', reversed)).reused, true);
    assert.equal((await ok(path(plan), 'POST', approve)).reused, true);
    assert.equal(
      (await req('/inventory-bulk-edit/previews', 'POST', { ...body, client_key: randomUUID() }))
        .statusCode,
      409,
    );
    assert.deepEqual(await count(), { previews: 2000, executions: 2000 });
    assert.deepEqual(await snapshot(businessTables), quotaBusiness);
  },
);

test(
  'inventory evidence enforces immutable history, tenant RLS and composite warehouse/product foreign keys',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      { plan } = await preview([await input(p)]);
    await ok(path(plan), 'POST', consent(plan), admin, 201);
    const before = await snapshot();
    for (const table of evidenceTables) {
      const flag = (
        await pool.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(flag.relrowsecurity && flag.relforcerowsecurity);
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
    const foreignWarehouse = (
      await pool.query('SELECT id FROM warehouses WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
    ).rows[0].id;
    await assert.rejects(
      pool.query(
        'INSERT INTO inventory_bulk_edit_previews SELECT $1,tenant_id,actor_id,$2,$3,request_hash,scope_hash,source,note,total,changed,unchanged,invalid,conflicts,ready,created_at FROM inventory_bulk_edit_previews WHERE id=$4',
        [randomUUID(), foreignWarehouse, randomUUID(), plan.id],
      ),
      (e: any) => e.code === '23503',
    );
    const foreignProduct = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
    ).rows[0].id;
    const fresh = randomUUID();
    await pool.query(
      'INSERT INTO inventory_bulk_edit_previews SELECT $1,tenant_id,actor_id,warehouse_id,$2,request_hash,scope_hash,source,note,total,changed,unchanged,invalid,conflicts,ready,created_at FROM inventory_bulk_edit_previews WHERE id=$3',
      [fresh, randomUUID(), plan.id],
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await assert.rejects(
        c.query(
          'INSERT INTO inventory_bulk_edit_rows SELECT tenant_id,$1,index,$2,location,sku,input,status,before,after,errors FROM inventory_bulk_edit_rows WHERE preview_id=$3',
          [fresh, foreignProduct, plan.id],
        ),
        (e: any) => e.code === '23503',
      );
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    // The one intentionally inserted header is the only permitted change in this direct-SQL fixture.
    const afterSnapshot = await snapshot();
    const oldHeads = before.inventory_bulk_edit_previews as any[];
    assert.deepEqual(
      (afterSnapshot.inventory_bulk_edit_previews as any[]).filter((r) => r.row.id !== fresh),
      oldHeads,
    );
    delete afterSnapshot.inventory_bulk_edit_previews;
    delete before.inventory_bulk_edit_previews;
    assert.deepEqual(afterSnapshot, before);
  },
);

test(
  'viewer and incomplete public scopes cannot approve inventory writes or expose a foreign scope',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      row = await input(p);
    const keys = [];
    for (const scopes of [
      ['inventory:write'],
      ['products:read'],
      ['products:read', 'inventory:read'],
    ])
      keys.push(
        await ok(
          '/developer/keys',
          'POST',
          { name: 'Compound inventory scope', scopes },
          admin,
          201,
        ),
      );
    const before = await snapshot();
    assert.equal((await ok('/inventory-bulk-edit', 'GET', undefined, viewer)).can_write, false);
    assert.equal(
      (
        await req(
          '/inventory-bulk-edit/previews',
          'POST',
          {
            client_key: randomUUID(),
            warehouse_id: warehouse,
            note: 'Viewer must not write',
            rows: [row],
          },
          viewer,
        )
      ).statusCode,
      403,
    );
    for (const key of keys) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/inventory-bulk-edit/previews',
        headers: { authorization: 'Bearer ' + key.token },
        payload: {
          client_key: randomUUID(),
          warehouse_id: warehouse,
          note: 'Insufficient compound scopes',
          rows: [row],
        },
      });
      assert.equal(r.statusCode, 403);
    }
    const foreign = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
    ).rows[0].id;
    assert.equal(
      (
        await req(
          '/inventory-bulk-edit/selection?warehouse_id=' +
            warehouse +
            '&ids=' +
            p.id +
            ',' +
            foreign,
        )
      ).statusCode,
      422,
    );
    assert.deepEqual(await snapshot(), before);
  },
);

test(
  'readonly gate precedes JSON parsing; a torn inventory module fails closed with 503 and no effects',
  { timeout: 60000 },
  async () => {
    const p = await product();
    let readonly: Awaited<ReturnType<typeof buildApp>> | undefined;
    const authFor = async (target: Awaited<ReturnType<typeof buildApp>>) => {
      const cookie = await login('admin@demo.local', target),
        r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie, target);
      assert.equal(r.statusCode, 200);
      return String(r.headers['set-cookie']).split(';')[0];
    };
    try {
      readonly = await buildApp({ readOnly: true, integrationTransport: transport });
      const auth = await authFor(readonly);
      const meta = await req('/inventory-bulk-edit', 'GET', undefined, auth, readonly);
      assert.equal(meta.statusCode, 200);
      assert.equal(meta.json().can_write, false);
      assert.match(String(meta.headers['cache-control']), /no-store/);
      const write = await readonly.inject({
        method: 'POST',
        url: '/api/inventory-bulk-edit/previews',
        headers: { cookie: auth, 'content-type': 'application/json' },
        payload: '{',
      });
      assert.equal(write.statusCode, 423);
    } finally {
      if (readonly) await readonly.close();
    }
    await pool.query(
      'ALTER TABLE inventory_bulk_edit_previews RENAME TO inventory_bulk_edit_previews_hidden_qa107',
    );
    // Hidden in the full schema this is a torn install, not an older copy: the
    // application refuses to start on it (PIM integrity), with no write.
    try {
      const digest = await tenantDataDigest();
      await assert.rejects(buildApp({ integrationTransport: transport }), pimIncomplete);
      assert.deepEqual(await tenantDataDigest(), digest);
    } finally {
      await pool.query(
        'ALTER TABLE inventory_bulk_edit_previews_hidden_qa107 RENAME TO inventory_bulk_edit_previews',
      );
    }
    assert.equal(
      (
        await req(
          '/stock-locations?warehouse_id=' + warehouse + '&product_id=' + p.id,
          'GET',
          undefined,
          admin,
        )
      ).statusCode,
      200,
    );
  },
);
