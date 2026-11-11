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
  throw new Error('SKU safety must never call a provider');
};
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin, target = app) =>
  target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.106.' + address,
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
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'SKU safety','enterprise')", [
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
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'SKU','SKU')", [
    warehouse,
    tenant,
  ]);
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
      sku: 'SKU-' + randomUUID(),
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
  'product_sku_aliases',
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
async function waitOn(holder: PoolClient, kind: 'catalog' | 'product' | 'alias') {
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
          : kind === 'alias'
            ? r.query.includes('product_sku_reserve')
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
  'SKU PATCH authorizes after the actual product wait and leaves no alias or catalogue effects after role withdrawal',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      body = await editBody(p.id, { sku: 'NEW-' + randomUUID() });
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
  'whole SKU sheet execution uses the current role after waiting and creates neither partial aliases nor evidence',
  { timeout: 20000 },
  async () => {
    const products = [await product(), await product()];
    // Use a valid two-product plan with distinct approved identifiers, not an invalid duplicate preview.
    const made = await ok(
      '/catalog-bulk-edit/previews',
      'POST',
      {
        client_key: randomUUID(),
        rows: products.map((p) => ({
          product_id: p.id,
          version: p.version,
          changes: { sku: 'NEW-' + p.id },
        })),
      },
      admin,
      201,
    );
    assert.equal(made.preview.ready, true);
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [products[1].id]);
      pending = req(
        '/catalog-bulk-edit/previews/' + made.preview.id + '/execute',
        'POST',
        consent(made.preview),
      );
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
  'ordinary and bulk SKU writes pin the current key only after the actual product wait',
  { timeout: 30000 },
  async () => {
    for (const path of ['ordinary', 'bulk'])
      for (const change of ['revoke', 'scope']) {
        const p = await product(),
          changes = { sku: 'NEW-' + randomUUID() };
        const plan = path === 'bulk' ? await preview([p], changes) : undefined;
        const key = await ok(
          '/developer/keys',
          'POST',
          { name: 'Late SKU ' + path + change, scopes: ['products:read', 'products:write'] },
          admin,
          201,
        );
        const body = plan ? consent(plan) : await editBody(p.id, changes);
        const url = plan
          ? '/catalog-bulk-edit/previews/' + plan.id + '/execute'
          : '/products/' + p.id;
        const before = await snapshot(),
          holder = await pool.connect();
        let pending: ReturnType<typeof req> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
          pending = app.inject({
            method: plan ? 'POST' : 'PATCH',
            url: '/api/v1' + url,
            payload: body,
            headers: { authorization: 'Bearer ' + key.token },
            remoteAddress: '127.0.106.' + address,
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
  'bulk alias preclaim waits before membership pinning and withdrawal rolls back every tentative claim',
  { timeout: 20000 },
  async () => {
    const selected = await product(),
      blockerProduct = await product(),
      target = 'ALIAS-WAIT-' + randomUUID();
    const plan = await preview([selected], { sku: target });
    assert.equal(plan.ready, true);
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      // A different product holds the pending unique alias. Its FK lock cannot block the selected product row.
      await holder.query(
        'INSERT INTO product_sku_aliases(tenant_id,sku,product_id) VALUES($1,$2,$3)',
        [tenant, target, blockerProduct.id],
      );
      pending = req('/catalog-bulk-edit/previews/' + plan.id + '/execute', 'POST', consent(plan));
      await waitOn(holder, 'alias');
      await downgrade();
      await holder.query('ROLLBACK');
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
  'actual old nine and fourteen-field receipts preserve their immutable hash, ordering and current SKU aliases',
  { timeout: 20000 },
  async () => {
    for (const fields of [baseFields, [...baseFields, ...logisticsFields]]) {
      const p = await product({
        weight_grams: 701,
        length_mm: 220,
        width_mm: 130,
        height_mm: 90,
        manufacturer: 'Historical maker',
      });
      const renamed = await ok(
        '/products/' + p.id,
        'PATCH',
        await editBody(p.id, { sku: 'CURRENT-' + p.id }),
      );
      const before = pick(renamed, fields);
      const changes = {
        name: 'Approved historical format',
        ean: '106-legacy',
        price: 5678,
        ...(fields.length === 14 ? { weight_grams: 702, manufacturer: 'Approved maker' } : {}),
      };
      const changedFields = [
        'name',
        'ean',
        'price',
        ...(fields.length === 14 ? ['weight_grams', 'manufacturer'] : []),
      ];
      const row = {
        index: 0,
        product_id: p.id,
        resolved_product_id: p.id,
        sku: renamed.sku,
        expected_version: renamed.version,
        current_version: renamed.version,
        status: 'changed',
        changes,
        before,
        after: { ...before, ...changes },
        changed_fields: changedFields,
        errors: [],
      };
      const request = {
        client_key: randomUUID(),
        rows: [{ product_id: p.id, version: renamed.version, changes }],
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
            renamed.sku,
            renamed.version,
            JSON.stringify(changes),
            JSON.stringify(before),
            JSON.stringify(row.after),
            JSON.stringify(changedFields),
          ],
        );
      });
      const frozen = await snapshot([
        'catalog_bulk_edit_previews',
        'catalog_bulk_edit_rows',
        'product_sku_aliases',
      ]);
      const body = consent(plan);
      assert.equal(
        (await req('/catalog-bulk-edit/previews/' + plan.id + '/execute', 'POST', body)).statusCode,
        201,
      );
      const saved = await detail(p.id);
      assert.equal(saved.sku, renamed.sku);
      assert.equal(saved.version, renamed.version + 1);
      for (const [k, v] of Object.entries(changes)) assert.deepEqual(saved[k], v);
      if (fields.length === 9)
        assert.deepEqual(pick(saved, logisticsFields), pick(renamed, logisticsFields));
      assert.deepEqual(
        await snapshot([
          'catalog_bulk_edit_previews',
          'catalog_bulk_edit_rows',
          'product_sku_aliases',
        ]),
        frozen,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT changed_fields FROM catalog_bulk_edit_execution_rows WHERE preview_id=$1',
            [plan.id],
          )
        ).rows[0].changed_fields,
        changedFields,
      );
      const done = await snapshot();
      assert.equal(
        (await req('/catalog-bulk-edit/previews/' + plan.id + '/execute', 'POST', body)).statusCode,
        200,
      );
      assert.deepEqual(await snapshot(), done);
    }
  },
);

test(
  'SKU-only mutation preserves stock, reservations, UUID links and the historical order and picking labels',
  { timeout: 20000 },
  async () => {
    const component = await product({ weight_grams: 100 }),
      group = await product({ kind: 'group', quantity: 0 });
    const variant = await product({ kind: 'variant', parent_id: group.id });
    const kit = await product({
      kind: 'bundle',
      quantity: 0,
      components: [
        { product_id: component.id, quantity: 2 },
        { product_id: variant.id, quantity: 1 },
      ],
    });
    const order = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Stable UUIDs',
        email: 'sku@example.test',
        warehouse_id: warehouse,
        items: [{ product_id: kit.id, quantity: 1 }],
      },
      admin,
      201,
    );
    const channel = randomUUID();
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'woocommerce','SKU preservation','sandbox','','{}','simulation')",
      [channel, tenant],
    );
    await pool.query(
      "INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,price) VALUES($1,$2,$3,$4,'external-sku-kept',1234)",
      [randomUUID(), tenant, channel, component.id],
    );
    const protectedTables = [
      'product_logistics',
      'stock',
      'stock_movements',
      'orders',
      'order_items',
      'order_pick_items',
      'reservations',
      'bundle_components',
      'listings',
      'outbound_events',
      'outbound_deliveries',
      'email_messages',
      'sms_messages',
    ];
    const before = await snapshot(protectedTables);
    const renamed = await ok(
      '/products/' + component.id,
      'PATCH',
      await editBody(component.id, { sku: 'RENAMED-' + component.id }),
    );
    assert.equal(renamed.id, component.id);
    assert.equal(renamed.version, component.version + 1);
    assert.deepEqual(await snapshot(protectedTables), before);
    const picks = (
      await pool.query('SELECT product_id,sku FROM order_pick_items WHERE order_id=$1', [order.id])
    ).rows;
    assert.equal(picks.find((p) => p.product_id === component.id).sku, component.sku);
    assert.equal((await detail(variant.id)).parent_id, group.id);
  },
);

test(
  'duplicate targets, swaps and reuse of another product historic SKU cannot partially rename a sheet',
  { timeout: 20000 },
  async () => {
    const a = await product(),
      b = await product();
    const renamed = await ok(
      '/products/' + a.id,
      'PATCH',
      await editBody(a.id, { sku: 'CURRENT-' + a.id }),
    );
    const cases = [
      [
        { product_id: a.id, version: renamed.version, changes: { sku: 'DUPLICATE-' + a.id } },
        { product_id: b.id, version: b.version, changes: { sku: 'DUPLICATE-' + a.id } },
      ],
      [
        { product_id: a.id, version: renamed.version, changes: { sku: b.sku } },
        { product_id: b.id, version: b.version, changes: { sku: renamed.sku } },
      ],
      [
        { product_id: a.id, version: renamed.version, changes: { name: 'Must roll back' } },
        { product_id: b.id, version: b.version, changes: { sku: a.sku } },
      ],
    ];
    for (const rows of cases) {
      const before = await snapshot(businessTables);
      const made = await ok(
        '/catalog-bulk-edit/previews',
        'POST',
        { client_key: randomUUID(), rows },
        admin,
        201,
      );
      assert.equal(made.preview.ready, false);
      const frozen = await snapshot();
      assert.equal(
        (
          await req(
            '/catalog-bulk-edit/previews/' + made.preview.id + '/execute',
            'POST',
            consent(made.preview),
          )
        ).statusCode,
        409,
      );
      assert.deepEqual(await snapshot(), frozen);
      assert.deepEqual(await snapshot(businessTables), before);
    }
  },
);

test(
  'immutable aliases enforce tenant FK and RLS and the product trigger rejects historic reuse by another UUID',
  { timeout: 20000 },
  async () => {
    const a = await product(),
      b = await product();
    await ok('/products/' + a.id, 'PATCH', await editBody(a.id, { sku: 'NEW-' + a.id }));
    const flags = (
      await pool.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='product_sku_aliases'::regclass",
      )
    ).rows[0];
    assert(flags.relrowsecurity && flags.relforcerowsecurity);
    assert.equal(
      (
        await tenantTx(SECOND_TENANT, (c) =>
          c.query('SELECT count(*)::int n FROM product_sku_aliases WHERE tenant_id=$1', [tenant]),
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      tenantTx(tenant, (c) =>
        c.query('INSERT INTO product_sku_aliases(tenant_id,sku,product_id) VALUES($1,$2,$3)', [
          tenant,
          'UNAUTHORIZED-' + randomUUID(),
          b.id,
        ]),
      ),
      (error: any) => error.code === '42501',
    );
    const foreign = (
      await pool.query('SELECT id,sku FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
    ).rows[0];
    const independent = await product({ sku: foreign.sku });
    assert.notEqual(independent.id, foreign.id);
    assert.equal(independent.sku, foreign.sku);
    const c = await pool.connect(),
      before = await snapshot();
    try {
      for (const [sql, params, check] of [
        [
          'UPDATE product_sku_aliases SET sku=sku WHERE tenant_id=$1',
          [tenant],
          (error: any) => /immutable/i.test(error.message),
        ],
        [
          'DELETE FROM product_sku_aliases WHERE tenant_id=$1',
          [tenant],
          (error: any) => /immutable/i.test(error.message),
        ],
        [
          'INSERT INTO product_sku_aliases(tenant_id,sku,product_id) VALUES($1,$2,$3)',
          [tenant, 'FOREIGN-' + randomUUID(), foreign.id],
          (error: any) => error.code === '23503',
        ],
        [
          'UPDATE products SET sku=$1,version=version+1 WHERE id=$2',
          [a.sku, b.id],
          (error: any) => error.code === '23505',
        ],
      ] as const) {
        await c.query('BEGIN');
        await assert.rejects(c.query(sql, [...params]), check);
        await c.query('ROLLBACK');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    assert.deepEqual(await snapshot(), before);
  },
);

test(
  'older copy exposes SKU capability false, rejects explicit SKU changes and preserves legacy omitted updates',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      legacy = await editBody(p.id, { description: 'Omitted SKU remains usable' });
    let older: Awaited<ReturnType<typeof buildApp>> | undefined;
    await pool.query('ALTER TABLE product_sku_aliases RENAME TO product_sku_aliases_hidden_qa106');
    try {
      older = await buildApp({ integrationTransport: transport });
      let auth = await login('admin@demo.local', older);
      const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, auth, older);
      assert.equal(switched.statusCode, 200);
      auth = String(switched.headers['set-cookie']).split(';')[0];
      const read = await req('/products/' + p.id, 'GET', undefined, auth, older);
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().product_sku_edit_available, false);
      assert.equal(read.json().sku, p.sku);
      const before = await snapshot(businessTables.filter((t) => t !== 'product_sku_aliases'));
      assert.equal(
        (await req('/products/' + p.id, 'PATCH', { ...legacy, sku: 'MUST-NOT-SAVE' }, auth, older))
          .statusCode,
        503,
      );
      assert.deepEqual(
        await snapshot(businessTables.filter((t) => t !== 'product_sku_aliases')),
        before,
      );
      assert.equal((await req('/products/' + p.id, 'PATCH', legacy, auth, older)).statusCode, 200);
    } finally {
      if (older) await older.close();
      await pool.query(
        'ALTER TABLE product_sku_aliases_hidden_qa106 RENAME TO product_sku_aliases',
      );
    }
    assert.equal((await detail(p.id)).sku, p.sku);
  },
);
