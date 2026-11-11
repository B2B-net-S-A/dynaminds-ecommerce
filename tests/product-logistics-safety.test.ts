import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { catalogBulkEditHash } from '../server/catalog-bulk-edit';
import { seed, SECOND_TENANT } from './fixtures';

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
  throw new Error('Product logistics safety must never call a provider');
};
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin, target = app) =>
  target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.105.' + address,
  });
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const r = await req(path, method, payload, cookie);
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
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Logistics safety','enterprise')", [
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
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Logistics','LOG')",
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
      sku: 'LOG-' + randomUUID(),
      name: 'Physical product',
      price: 1234,
      quantity: 20,
      warehouse_id: warehouse,
      ...extra,
    },
    admin,
    201,
  );
}
const baseFields = [
  'name',
  'ean',
  'price',
  'vat',
  'category',
  'description',
  'active',
  'attributes',
  'images',
];
const logisticsFields = ['weight_grams', 'length_mm', 'width_mm', 'height_mm', 'manufacturer'];
const pick = (p: any, fields: string[]) => Object.fromEntries(fields.map((k) => [k, p[k]]));
async function detail(id: string) {
  return ok('/products/' + id);
}
async function editBody(id: string, extra: any = {}) {
  const p = await detail(id);
  return {
    ...pick(p, baseFields),
    version: p.version,
    components: p.components.map((c: any) => ({ product_id: c.product_id, quantity: c.quantity })),
    ...extra,
  };
}
async function preview(products: any[], changes: any) {
  return (
    await ok(
      '/catalog-bulk-edit/previews',
      'POST',
      {
        client_key: randomUUID(),
        rows: products.map((p) => ({ product_id: p.id, version: p.version, changes })),
      },
      admin,
      201,
    )
  ).preview;
}
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const businessTables = [
  'products',
  'product_logistics',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'reservations',
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
  'catalog_bulk_edit_previews',
  'catalog_bulk_edit_rows',
  'catalog_bulk_edit_executions',
  'catalog_bulk_edit_execution_rows',
];
async function snapshot(tables = [...businessTables, ...evidenceTables]) {
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function waitOn(holder: PoolClient, kind: 'catalog' | 'product') {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
      [pid],
    );
    if (
      result.rows.some((r) =>
        kind === 'catalog'
          ? r.query.includes('pg_advisory_xact_lock')
          : r.query.includes('products') && /FOR\s+UPDATE/i.test(r.query),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The real operation never waited on the held ' + kind + ' lock');
}
async function downgrade() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      adminId,
    ]);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

test(
  'ordinary explicit logistics PATCH authorizes after the actual product wait and rolls back the base edit on withdrawal',
  { timeout: 20000 },
  async () => {
    const p = await product({ weight_grams: 100, manufacturer: 'Original maker' });
    const body = await editBody(p.id, { name: 'Must roll back', weight_grams: 200 });
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
      pending = req('/products/' + p.id, 'PATCH', body);
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
  'explicit logistics create rechecks the actor after a real catalogue wait without creating stock or evidence',
  { timeout: 20000 },
  async () => {
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'catalog:' + tenant,
      ]);
      pending = req('/products', 'POST', {
        sku: 'LOG-' + randomUUID(),
        name: 'No stale creation',
        price: 10,
        quantity: 2,
        warehouse_id: warehouse,
        weight_grams: 100,
      });
      await waitOn(holder, 'catalog');
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
  'a fourteen-field execution cannot use a withdrawn role after waiting for its product row',
  { timeout: 20000 },
  async () => {
    const p = await product({ weight_grams: 100 });
    const plan = await preview([p], {
      weight_grams: 200,
      length_mm: 50,
      manufacturer: 'New maker',
    });
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
      pending = req('/catalog-bulk-edit/previews/' + plan.id + '/execute', 'POST', consent(plan));
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
  'an actual immutable nine-field receipt executes without upgrading its hash or resetting an existing profile',
  { timeout: 20000 },
  async () => {
    const p = await product({
      weight_grams: 701,
      length_mm: 220,
      width_mm: 130,
      height_mm: 90,
      manufacturer: 'Frozen maker',
    });
    const full = await detail(p.id),
      before = pick(full, baseFields),
      changes = { name: 'Approved old format', ean: '105-legacy', price: 5678 };
    const row = {
      index: 0,
      product_id: p.id,
      resolved_product_id: p.id,
      sku: p.sku,
      expected_version: full.version,
      current_version: full.version,
      status: 'changed',
      changes,
      before,
      after: { ...before, ...changes },
      changed_fields: ['name', 'ean', 'price'],
      errors: [],
    };
    const request = {
      client_key: randomUUID(),
      rows: [{ product_id: p.id, version: full.version, changes }],
    };
    const plan = {
      id: randomUUID(),
      scope_hash: catalogBulkEditHash({ actor_id: adminId, rows: [row], rules_snapshot: [] }),
    };
    await tenantTx(tenant, async (c) => {
      await c.query(
        "INSERT INTO catalog_bulk_edit_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,source,rules_snapshot,total,changed,unchanged,invalid,conflicts,ready) VALUES($1,$2,$3,$4,$5,$6,'manual','[]',1,1,0,0,0,true)",
        [
          plan.id,
          tenant,
          adminId,
          request.client_key,
          catalogBulkEditHash({ source: 'manual', request }),
          plan.scope_hash,
        ],
      );
      await c.query(
        "INSERT INTO catalog_bulk_edit_rows(tenant_id,preview_id,index,product_id,resolved_product_id,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors) VALUES($1,$2,0,$3,$3,$4,$5,$5,'changed',$6,$7,$8,$9,'[]')",
        [
          tenant,
          plan.id,
          p.id,
          p.sku,
          full.version,
          JSON.stringify(changes),
          JSON.stringify(before),
          JSON.stringify(row.after),
          JSON.stringify(row.changed_fields),
        ],
      );
    });
    const frozen = await snapshot(['catalog_bulk_edit_previews', 'catalog_bulk_edit_rows']);
    const body = consent(plan);
    assert.equal(
      (await req('/catalog-bulk-edit/previews/' + plan.id + '/execute', 'POST', body)).statusCode,
      201,
    );
    const changed = await detail(p.id);
    assert.equal(changed.name, changes.name);
    assert.equal(changed.ean, changes.ean);
    assert.equal(changed.price, changes.price);
    assert.equal(changed.version, full.version + 1);
    assert.deepEqual(pick(changed, logisticsFields), pick(full, logisticsFields));
    assert.deepEqual(
      await snapshot(['catalog_bulk_edit_previews', 'catalog_bulk_edit_rows']),
      frozen,
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT changed_fields FROM catalog_bulk_edit_execution_rows WHERE preview_id=$1',
          [plan.id],
        )
      ).rows[0].changed_fields,
      ['name', 'ean', 'price'],
    );
    const done = await snapshot();
    assert.equal(
      (await req('/catalog-bulk-edit/previews/' + plan.id + '/execute', 'POST', body)).statusCode,
      200,
    );
    assert.deepEqual(await snapshot(), done);
  },
);

test(
  'frozen order composition uses current component weights and never estimates packed dimensions or changes an order',
  { timeout: 20000 },
  async () => {
    const a = await product({ weight_grams: 100, length_mm: 20, width_mm: 30, height_mm: 40 });
    const b = await product({ weight_grams: null });
    const replacement = await product({ weight_grams: 500 });
    const kit = await product({
      kind: 'bundle',
      quantity: 0,
      weight_grams: 999,
      components: [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 1 },
      ],
    });
    const order = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Frozen composition',
        email: 'logistics@example.test',
        warehouse_id: warehouse,
        items: [
          { product_id: kit.id, quantity: 2 },
          { product_id: a.id, quantity: 1 },
        ],
      },
      admin,
      201,
    );
    await ok(
      '/products/' + kit.id,
      'PATCH',
      await editBody(kit.id, { components: [{ product_id: replacement.id, quantity: 1 }] }),
    );
    const preserved = [
      'orders',
      'order_items',
      'stock',
      'stock_movements',
      'reservations',
      'jobs',
      'audit_events',
      'outbound_events',
      'outbound_deliveries',
    ];
    const before = await snapshot(preserved);
    const r = await req('/orders/' + order.id + '/product-logistics', 'GET', undefined, viewer);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const estimate = r.json();
    assert.equal(estimate.available, true);
    assert.equal(estimate.basis, 'current_catalog');
    assert.equal(estimate.total_known_weight_grams, 500);
    assert.equal(estimate.weight_overflow, false);
    assert.equal(estimate.complete, false);
    assert.deepEqual(estimate.missing_weight_product_ids, [b.id]);
    assert.deepEqual(
      estimate.items.map((i: any) => [i.product_id, i.quantity]).sort(),
      [
        [a.id, 5],
        [b.id, 2],
      ].sort(),
    );
    assert.equal(estimate.items.find((i: any) => i.product_id === a.id).known_weight_grams, 500);
    assert(!Object.hasOwn(estimate, 'length_mm') && !Object.hasOwn(estimate, 'packed_dimensions'));
    assert.deepEqual(await snapshot(preserved), before);
    await ok('/products/' + b.id, 'PATCH', await editBody(b.id, { weight_grams: 50 }));
    const afterWeight = await snapshot(preserved);
    const complete = await ok('/orders/' + order.id + '/product-logistics');
    assert.equal(complete.total_known_weight_grams, 600);
    assert.equal(complete.complete, true);
    assert.deepEqual(complete.missing_weight_product_ids, []);
    assert.equal(
      complete.items.find((i: any) => i.product_id === b.id).version,
      (await detail(b.id)).version,
    );
    assert.deepEqual(await snapshot(preserved), afterWeight);
  },
);

test(
  'own logistics reads require both public scopes and retain tenant isolation and viewer write protection',
  { timeout: 20000 },
  async () => {
    const p = await product({ weight_grams: 120 });
    const order = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Compound scopes',
        email: 'scopes@example.test',
        warehouse_id: warehouse,
        items: [{ product_id: p.id, quantity: 1 }],
      },
      admin,
      201,
    );
    const tokens: string[] = [];
    for (const scopes of [['orders:read'], ['products:read'], ['orders:read', 'products:read']])
      tokens.push(
        (await ok('/developer/keys', 'POST', { name: 'Logistics scoped read', scopes }, admin, 201))
          .token,
      );
    const before = await snapshot();
    for (let i = 0; i < tokens.length; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/orders/' + order.id + '/product-logistics',
        headers: { authorization: 'Bearer ' + tokens[i] },
        remoteAddress: '127.0.105.' + address,
      });
      assert.equal(r.statusCode, i === 2 ? 200 : 403);
      if (i === 2) assert.equal(r.json().total_known_weight_grams, 120);
      else assert(!r.body.includes(p.sku));
    }
    assert.equal(
      (await req('/products/' + p.id, 'PATCH', await editBody(p.id, { weight_grams: 150 }), viewer))
        .statusCode,
      403,
    );
    const foreign = (
      await pool.query('SELECT id FROM orders WHERE tenant_id<>$1 LIMIT 1', [tenant])
    ).rows[0];
    assert(foreign, 'Fixture must contain a foreign order');
    const denied = await req('/orders/' + foreign.id + '/product-logistics');
    assert.equal(denied.statusCode, 404);
    assert(!denied.body.includes(p.sku));
    assert.deepEqual(await snapshot(), before);
  },
);

test(
  'product logistics composite FK and FORCE RLS reject cross-firm profiles and malformed direct units',
  { timeout: 20000 },
  async () => {
    const p = await product({ weight_grams: 100 });
    const flags = (
      await pool.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='product_logistics'::regclass",
      )
    ).rows[0];
    assert(flags.relrowsecurity && flags.relforcerowsecurity);
    assert.equal(
      (
        await tenantTx(SECOND_TENANT, (c) =>
          c.query('SELECT count(*)::int n FROM product_logistics WHERE tenant_id=$1', [tenant]),
        )
      ).rows[0].n,
      0,
    );
    const foreign = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
    ).rows[0];
    const c = await pool.connect();
    try {
      for (const [query, params, code] of [
        [
          'INSERT INTO product_logistics(tenant_id,product_id,weight_grams) VALUES($1,$2,100)',
          [tenant, foreign.id],
          '23503',
        ],
        [
          'UPDATE product_logistics SET weight_grams=0 WHERE tenant_id=$1 AND product_id=$2',
          [tenant, p.id],
          '23514',
        ],
        [
          'UPDATE product_logistics SET length_mm=100001 WHERE tenant_id=$1 AND product_id=$2',
          [tenant, p.id],
          '23514',
        ],
      ] as const) {
        await c.query('BEGIN');
        await assert.rejects(c.query(query, [...params]), (error: any) => error.code === code);
        await c.query('ROLLBACK');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await assert.rejects(
      tenantTx(SECOND_TENANT, (c) =>
        c.query(
          'INSERT INTO product_logistics(tenant_id,product_id,weight_grams) VALUES($1,$2,100)',
          [tenant, randomUUID()],
        ),
      ),
      (error: any) => error.code === '42501',
    );
  },
);

test(
  'ordinary explicit profile writes recheck revoked or scope-reduced API keys after a real product wait',
  { timeout: 30000 },
  async () => {
    for (const change of ['revoke', 'scope']) {
      const p = await product({ weight_grams: 100 });
      const body = await editBody(p.id, { weight_grams: 200 });
      const key = await ok(
        '/developer/keys',
        'POST',
        { name: 'Late logistics ' + change, scopes: ['products:read', 'products:write'] },
        admin,
        201,
      );
      const before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof req> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
        pending = app.inject({
          method: 'PATCH',
          url: '/api/v1/products/' + p.id,
          payload: body,
          headers: { authorization: 'Bearer ' + key.token },
          remoteAddress: '127.0.105.' + address,
        });
        await waitOn(holder, 'product');
        const grant = await pool.connect();
        try {
          await grant.query('BEGIN');
          await grant.query("SET LOCAL statement_timeout='1500ms'");
          await grant.query(
            change === 'revoke'
              ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
              : "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
            [key.id],
          );
          await grant.query('COMMIT');
        } finally {
          await grant.query('ROLLBACK');
          grant.release();
        }
        await holder.query('COMMIT');
        assert.equal((await pending).statusCode, change === 'revoke' ? 401 : 403);
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
  'older copies allow omitted legacy edits and return incomplete defaults while explicit logistics writes fail closed',
  { timeout: 20000 },
  async () => {
    const p = await product({ weight_grams: 100 });
    const order = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Older copy',
        email: 'older@example.test',
        warehouse_id: warehouse,
        items: [{ product_id: p.id, quantity: 1 }],
      },
      admin,
      201,
    );
    const legacy = await editBody(p.id, { description: 'Ordinary legacy edit' });
    let older: Awaited<ReturnType<typeof buildApp>> | undefined;
    await pool.query('ALTER TABLE product_logistics RENAME TO product_logistics_hidden_qa105');
    try {
      older = await buildApp({ integrationTransport: transport });
      let auth = await login('admin@demo.local', older);
      const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, auth, older);
      assert.equal(switched.statusCode, 200);
      auth = String(switched.headers['set-cookie']).split(';')[0];
      const read = await req('/products/' + p.id, 'GET', undefined, auth, older);
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().product_logistics_available, false);
      for (const field of logisticsFields) assert.equal(read.json()[field], null);
      const estimate = await req(
        '/orders/' + order.id + '/product-logistics',
        'GET',
        undefined,
        auth,
        older,
      );
      assert.equal(estimate.statusCode, 200);
      assert.equal(estimate.json().available, false);
      assert.equal(estimate.json().complete, false);
      assert.deepEqual(estimate.json().missing_weight_product_ids, [p.id]);
      const before = await snapshot(businessTables.filter((t) => t !== 'product_logistics'));
      assert.equal(
        (await req('/products/' + p.id, 'PATCH', { ...legacy, weight_grams: 200 }, auth, older))
          .statusCode,
        503,
      );
      assert.deepEqual(
        await snapshot(businessTables.filter((t) => t !== 'product_logistics')),
        before,
      );
      assert.equal((await req('/products/' + p.id, 'PATCH', legacy, auth, older)).statusCode, 200);
    } finally {
      if (older) await older.close();
      await pool.query('ALTER TABLE product_logistics_hidden_qa105 RENAME TO product_logistics');
    }
    assert.equal((await detail(p.id)).weight_grams, 100);
  },
);
