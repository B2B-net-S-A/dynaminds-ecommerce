import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  adminId = '',
  address = 1;
let admin = '',
  viewer = '',
  other = '';
const cookies = new Map<string, string>();
const prefix = '/product-translation-bulk-edit';
const providerCalls: unknown[] = [];
const transport = async (url: string) => {
  providerCalls.push(url);
  throw Error('Manual translation safety must not call providers');
};
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin, target = app) =>
  target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.109.' + address,
  });
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const r = await req(path, method, payload, cookie);
  assert.equal(r.statusCode, status, method + ' ' + path);
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
  ++address;
  providerCalls.length = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Translation safety','enterprise')",
    [tenant],
  );
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
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Translation warehouse','TR')",
    [warehouse, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function product(extra: any = {}) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'TR-' + randomUUID(),
      name: 'Source product',
      description: 'Frozen source description',
      price: 1234,
      quantity: 20,
      warehouse_id: warehouse,
      ...extra,
    },
    admin,
    201,
  );
}
const evidenceTables = [
  'product_translation_bulk_edit_previews',
  'product_translation_bulk_edit_rows',
  'product_translation_bulk_edit_executions',
  'product_translation_bulk_edit_execution_rows',
];
const businessTables = [
  'products',
  'product_translations',
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
  'reservations',
  'reservation_locations',
  'bundle_components',
  'listings',
  'offer_plans',
  'jobs',
  'audit_events',
  'product_rules',
  'product_rule_revisions',
  'product_rule_runs',
  'product_rule_items',
  'product_rule_causes',
  'ai_catalog_drafts',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_translation_plans',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
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
async function current(id: string) {
  return ok('/products/' + id);
}
async function matrix(
  products: any[],
  locales = ['de', 'en'],
  operation: any = {
    operation: 'set',
    patch: { name: 'Manual name', description: 'Manual description' },
  },
) {
  const ts = (
    await pool.query(
      'SELECT product_id,locale,version FROM product_translations WHERE tenant_id=$1 AND product_id=ANY($2::uuid[])',
      [tenant, products.map((p) => p.id)],
    )
  ).rows;
  return {
    client_key: randomUUID(),
    locales,
    rows: products.flatMap((p) =>
      locales.map((locale) => ({
        product_id: p.id,
        product_version: p.version,
        locale,
        translation_version:
          ts.find((t) => t.product_id === p.id && t.locale === locale.toLowerCase())?.version ??
          null,
        ...operation,
      })),
    ),
  };
}
async function preview(products: any[], locales = ['de', 'en'], operation?: any) {
  const body = await matrix(products, locales, operation),
    result = await ok(prefix + '/previews', 'POST', body, admin, 201);
  assert.equal(result.preview.ready, true);
  return { plan: result.preview, body };
}
const consent = (p: any, extra: any = {}) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
  ack_missing_translations: false,
  ...extra,
});
const executePath = (p: any) => prefix + '/previews/' + p.id + '/execute';
async function apply(products: any[], locales = ['de', 'en'], operation?: any) {
  const { plan } = await preview(products, locales, operation);
  await ok(
    executePath(plan),
    'POST',
    consent(plan, { ack_missing_translations: plan.missing_after_count > 0 }),
    admin,
    201,
  );
  return Promise.all(products.map((p) => current(p.id)));
}
async function waitOn(holder: PoolClient, table: 'products' | 'product_translations') {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    until = Date.now() + 2500;
  while (Date.now() < until) {
    const rows = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (rows.some((r) => r.query.includes(table) && /FOR\s+(UPDATE|SHARE)/i.test(r.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Actual manual translation request never waited on held ' + table + ' lock');
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
async function held(
  table: 'products' | 'product_translations',
  productId: string,
  run: (holder: PoolClient) => Promise<void>,
) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      table === 'products'
        ? 'SELECT id FROM products WHERE id=$1 FOR UPDATE'
        : "SELECT product_id FROM product_translations WHERE tenant_id=$1 AND product_id=$2 AND locale='de' FOR UPDATE",
      table === 'products' ? [productId] : [tenant, productId],
    );
    await run(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

test(
  'execution waiting on a real product row sees a committed role withdrawal and rolls back the entire matrix',
  { timeout: 20000 },
  async () => {
    const a = await product(),
      b = await product(),
      { plan } = await preview([a, b]),
      before = await snapshot();
    let pending: ReturnType<typeof req> | undefined;
    await held('products', b.id, async (c) => {
      try {
        pending = req(executePath(plan), 'POST', consent(plan));
        await waitOn(c, 'products');
        await downgrade();
        await c.query('COMMIT');
        assert.equal((await pending).statusCode, 403);
      } finally {
        await c.query('ROLLBACK');
        await pending;
      }
    });
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls.length, 0);
  },
);
test(
  'existing translation row wait never pins membership before the wait and denied tentative changes leave no receipt',
  { timeout: 20000 },
  async () => {
    let p = await product();
    [p] = await apply([p]);
    const { plan } = await preview([p], ['de', 'en'], {
        operation: 'set',
        patch: { description: 'New reviewed description' },
      }),
      before = await snapshot();
    let pending: ReturnType<typeof req> | undefined;
    await held('product_translations', p.id, async (c) => {
      try {
        pending = req(executePath(plan), 'POST', consent(plan));
        await waitOn(c, 'product_translations');
        await downgrade();
        await c.query('COMMIT');
        assert.equal((await pending).statusCode, 403);
      } finally {
        await c.query('ROLLBACK');
        await pending;
      }
    });
    assert.deepEqual(await snapshot(), before);
  },
);
test(
  'preview also checks current administrator after a product wait instead of saving private evidence after withdrawal',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      body = await matrix([p]),
      before = await snapshot();
    let pending: ReturnType<typeof req> | undefined;
    await held('products', p.id, async (c) => {
      try {
        pending = req(prefix + '/previews', 'POST', body);
        await waitOn(c, 'products');
        await downgrade();
        await c.query('COMMIT');
        assert.equal((await pending).statusCode, 403);
      } finally {
        await c.query('ROLLBACK');
        await pending;
      }
    });
    assert.deepEqual(await snapshot(), before);
  },
);
test(
  'public execution rechecks key revocation, expiry and scopes after a real product wait',
  { timeout: 30000 },
  async () => {
    for (const mode of ['revoke', 'expire', 'scope']) {
      const p = await product(),
        key = await ok(
          '/developer/keys',
          'POST',
          { name: 'Translation wait ' + mode, scopes: ['products:read', 'products:write'] },
          admin,
          201,
        ),
        body = await matrix([p]);
      const headers = { authorization: 'Bearer ' + key.token };
      const r = await app.inject({
        url: '/api/v1' + prefix + '/previews',
        method: 'POST',
        headers,
        payload: body,
      });
      assert.equal(r.statusCode, 201);
      const plan = r.json().preview,
        before = await snapshot();
      let pending: ReturnType<typeof req> | undefined;
      await held('products', p.id, async (c) => {
        try {
          pending = app.inject({
            url: '/api/v1' + executePath(plan),
            method: 'POST',
            headers,
            payload: consent(plan),
          });
          await waitOn(c, 'products');
          await changeGrant(
            mode === 'revoke'
              ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
              : mode === 'expire'
                ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
                : "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
            [key.id],
          );
          await c.query('COMMIT');
          assert.equal((await pending).statusCode, mode === 'scope' ? 403 : 401);
        } finally {
          await c.query('ROLLBACK');
          await pending;
        }
      });
      assert.deepEqual(await snapshot(), before);
    }
  },
);

test(
  'preview and execution actor FK waits occur before any membership pin and denial rolls back evidence bytes',
  { timeout: 30000 },
  async () => {
    for (const phase of ['preview', 'execution']) {
      await changeGrant("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      const p = await product(),
        body = await matrix([p]);
      const plan =
        phase === 'execution'
          ? (await ok(prefix + '/previews', 'POST', body, admin, 201)).preview
          : undefined;
      const before = await snapshot(),
        c = await pool.connect();
      let pending: ReturnType<typeof req> | undefined;
      try {
        await c.query('BEGIN');
        await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [adminId]);
        const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        pending = req(
          phase === 'preview' ? prefix + '/previews' : executePath(plan),
          'POST',
          phase === 'preview' ? body : consent(plan),
        );
        const deadline = Date.now() + 2500;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked =
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2",
                [
                  pid,
                  '%INSERT INTO product_translation_bulk_edit_' +
                    (phase === 'preview' ? 'previews' : 'executions') +
                    '%',
                ],
              )
            ).rowCount! > 0;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(blocked, 'Actual request must wait on its actor user FK');
        await downgrade();
        await c.query('COMMIT');
        assert.equal((await pending).statusCode, 403);
      } finally {
        await c.query('ROLLBACK');
        c.release();
        await pending;
      }
      assert.deepEqual(await snapshot(), before);
    }
  },
);
test(
  'CAS covers absence, delete/recreate ABA and base product changes including VAT that is not a translation field',
  { timeout: 20000 },
  async () => {
    let p = await product();
    const absent = await preview([p]);
    [p] = await apply([p]);
    let before = await snapshot();
    assert.equal(
      (await req(executePath(absent.plan), 'POST', consent(absent.plan))).statusCode,
      409,
    );
    assert.deepEqual(await snapshot(), before);
    const stale = await preview([p], ['de', 'en'], {
      operation: 'set',
      patch: { description: 'Changed approved description' },
    });
    [p] = await apply([p], ['de', 'en'], { operation: 'remove' });
    [p] = await apply([p]);
    assert.equal(
      (
        await pool.query(
          "SELECT version FROM product_translations WHERE tenant_id=$1 AND product_id=$2 AND locale='de'",
          [tenant, p.id],
        )
      ).rows[0].version,
      1,
    );
    before = await snapshot();
    assert.equal((await req(executePath(stale.plan), 'POST', consent(stale.plan))).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
    const fresh = await preview([p]);
    p = await ok('/products/' + p.id, 'PATCH', { ...p, vat: 8 });
    before = await snapshot();
    assert.equal((await req(executePath(fresh.plan), 'POST', consent(fresh.plan))).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  },
);
test(
  'strict complete matrix rejects omissions, normalized duplicate pairs and inconsistent product versions without evidence',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      valid = await matrix([p], ['de', 'en-us']),
      before = await snapshot();
    const bad = [
      { ...valid, rows: valid.rows.slice(0, 1) },
      { ...valid, locales: ['DE', 'de'] },
      { ...valid, rows: [valid.rows[0], { ...valid.rows[0], locale: 'DE' }] },
      { ...valid, rows: [valid.rows[0], { ...valid.rows[1], product_version: p.version + 1 }] },
    ];
    for (const body of bad)
      assert.equal(
        (await req(prefix + '/previews', 'POST', { ...body, client_key: randomUUID() })).statusCode,
        422,
      );
    assert.deepEqual(await snapshot(), before);
    const foreign = (
      await pool.query('SELECT id,version FROM products WHERE tenant_id=$1 LIMIT 1', [
        SECOND_TENANT,
      ])
    ).rows[0];
    const foreignBody = await matrix([{ ...foreign }]);
    assert.equal((await req(prefix + '/previews', 'POST', foreignBody)).statusCode, 422);
    assert.deepEqual(await snapshot(), before);
  },
);
test(
  'receipt replay is canonical, actor-bound and allowed before preview count quota, but still checks current role',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      { plan, body } = await preview([p]),
      approved = consent(plan);
    await ok(executePath(plan), 'POST', approved, admin, 201);
    await pool.query(
      "INSERT INTO product_translation_bulk_edit_previews SELECT(jsonb_populate_record(NULL::product_translation_bulk_edit_previews,to_jsonb(p)||jsonb_build_object('id',gen_random_uuid(),'client_key',gen_random_uuid()))).* FROM product_translation_bulk_edit_previews p CROSS JOIN generate_series(1,1999) g WHERE p.id=$1",
      [plan.id],
    );
    const saved = await snapshot();
    const reversed = {
      rows: body.rows.map((r) => Object.fromEntries(Object.entries(r).reverse())),
      locales: body.locales,
      client_key: body.client_key,
    };
    assert.equal((await ok(prefix + '/previews', 'POST', reversed)).reused, true);
    assert.equal((await ok(executePath(plan), 'POST', approved)).reused, true);
    assert.deepEqual(await snapshot(), saved);
    assert.equal(
      (await req(prefix + '/previews', 'POST', { ...body, client_key: randomUUID() })).statusCode,
      409,
    );
    assert.equal((await req(executePath(plan), 'POST', approved, other)).statusCode, 409);
    assert.equal(
      (await req(executePath(plan), 'POST', { ...approved, ack_missing_translations: true }))
        .statusCode,
      409,
    );
    assert.deepEqual(await snapshot(), saved);
    await downgrade();
    assert.equal((await req(executePath(plan), 'POST', approved)).statusCode, 403);
    assert.deepEqual(await snapshot(), saved);
  },
);
test(
  'two MiB UTF-8 is enforced before writes for an otherwise legal Unicode matrix',
  { timeout: 20000 },
  async () => {
    const products = (
      await pool.query(
        "INSERT INTO products(id,tenant_id,sku,name,description,price) SELECT gen_random_uuid(),$1,'BYTE-'||gen_random_uuid()::text,'Byte product','Source',1234 FROM generate_series(1,25) RETURNING *",
        [tenant],
      )
    ).rows;
    const body = await matrix(products, ['de', 'en', 'fr', 'es', 'cs', 'it'], {
      operation: 'set',
      patch: { name: 'Valid name', description: '🧋'.repeat(4000) },
    });
    assert(Buffer.byteLength(JSON.stringify(body), 'utf8') > 2097152);
    const before = await snapshot();
    assert.equal((await req(prefix + '/previews', 'POST', body)).statusCode, 413);
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls.length, 0);
  },
);
test(
  'an exhausted product version still permits an exact NOP without overflowing receipt constraints',
  { timeout: 20000 },
  async () => {
    let p = await product();
    [p] = await apply([p]);
    await pool.query('UPDATE products SET version=2147483647 WHERE tenant_id=$1 AND id=$2', [
      tenant,
      p.id,
    ]);
    p = await current(p.id);
    const translations = (
        await pool.query(
          'SELECT * FROM product_translations WHERE tenant_id=$1 AND product_id=$2 ORDER BY locale',
          [tenant, p.id],
        )
      ).rows,
      before = await snapshot(businessTables),
      { plan } = await preview([p], ['de', 'en'], { operation: 'none' });
    assert.equal(plan.changed_products, 0);
    await ok(executePath(plan), 'POST', consent(plan), admin, 201);
    assert.equal((await current(p.id)).version, 2147483647);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT * FROM product_translations WHERE tenant_id=$1 AND product_id=$2 ORDER BY locale',
          [tenant, p.id],
        )
      ).rows,
      translations,
    );
    const after = await snapshot(businessTables);
    delete before.audit_events;
    delete after.audit_events;
    assert.deepEqual(after, before);
  },
);
test(
  'manual receipts and execution rows are immutable, own-scope bound and a removal receipt cannot supply current text',
  { timeout: 20000 },
  async () => {
    let p = await product();
    const { plan } = await preview([p]);
    await ok(executePath(plan), 'POST', consent(plan), admin, 201);
    p = await current(p.id);
    const original = (
      await pool.query(
        "SELECT * FROM product_translations WHERE tenant_id=$1 AND product_id=$2 AND locale='de'",
        [tenant, p.id],
      )
    ).rows[0];
    assert(original.manual_receipt_id);
    assert.equal(original.ai_draft_id, null);
    assert.equal(original.deepl_draft_id, null);
    const result = (
      await pool.query('SELECT * FROM product_translation_bulk_edit_execution_rows WHERE id=$1', [
        original.manual_receipt_id,
      ])
    ).rows[0];
    assert(result);
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
    await assert.rejects(
      pool.query(
        "UPDATE product_translations SET description='Not approved receipt text' WHERE tenant_id=$1 AND product_id=$2 AND locale='de'",
        [tenant, p.id],
      ),
      (e: any) => e.code === 'P0001' || e.code === '23514',
    );
    await assert.rejects(
      pool.query(
        "UPDATE product_translations SET manual_receipt_id=$3 WHERE tenant_id=$1 AND product_id=$2 AND locale='en'",
        [tenant, p.id, original.manual_receipt_id],
      ),
      (e: any) => e.code === '23503' || e.code === 'P0001',
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await tenantTx(SECOND_TENANT, (c) =>
          c.query('SELECT count(*)::int n FROM product_translations WHERE tenant_id=$1', [tenant]),
        )
      ).rows[0].n,
      0,
    );
    const c = await pool.connect(),
      freshPreview = randomUUID(),
      freshExecution = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO product_translation_bulk_edit_previews SELECT(jsonb_populate_record(NULL::product_translation_bulk_edit_previews,to_jsonb(p)||jsonb_build_object('id',$1::uuid,'client_key',gen_random_uuid()))).* FROM product_translation_bulk_edit_previews p WHERE id=$2",
        [freshPreview, plan.id],
      );
      await c.query(
        "INSERT INTO product_translation_bulk_edit_rows SELECT(jsonb_populate_record(NULL::product_translation_bulk_edit_rows,to_jsonb(r)||jsonb_build_object('preview_id',$1::uuid,'receipt_id',x.id,'after',jsonb_set(r.after,'{provenance,id}',to_jsonb(x.id::text))))).* FROM product_translation_bulk_edit_rows r CROSS JOIN LATERAL(SELECT gen_random_uuid() id WHERE r.index IS NOT NULL)x WHERE r.preview_id=$2",
        [freshPreview, plan.id],
      );
      await c.query(
        "INSERT INTO product_translation_bulk_edit_executions SELECT(jsonb_populate_record(NULL::product_translation_bulk_edit_executions,to_jsonb(e)||jsonb_build_object('id',$1::uuid,'preview_id',$2::uuid,'client_key',gen_random_uuid()))).* FROM product_translation_bulk_edit_executions e WHERE preview_id=$3",
        [freshExecution, freshPreview, plan.id],
      );
      const insert = (change: Record<string, unknown>) =>
        c.query(
          "INSERT INTO product_translation_bulk_edit_execution_rows SELECT(jsonb_populate_record(NULL::product_translation_bulk_edit_execution_rows,to_jsonb(e)||jsonb_build_object('id',r.receipt_id,'execution_id',$1::uuid,'preview_id',$2::uuid,'after',r.after)||$3::jsonb)).* FROM product_translation_bulk_edit_execution_rows e JOIN product_translation_bulk_edit_rows r ON r.preview_id=$2 AND r.index=e.index WHERE e.preview_id=$4 AND e.index=0",
          [freshExecution, freshPreview, JSON.stringify(change), plan.id],
        );
      await c.query('SAVEPOINT evidence');
      await insert({});
      await c.query('ROLLBACK TO SAVEPOINT evidence');
      const frozenAfter = (
        await c.query(
          'SELECT after FROM product_translation_bulk_edit_rows WHERE preview_id=$1 AND index=0',
          [freshPreview],
        )
      ).rows[0].after;
      for (const change of [
        { sku: 'Unapproved SKU' },
        { product_name: 'Unapproved source name' },
        { input: { ...result.input, patch: { name: 'Forged input' } } },
        { before: { ...result.before, name: 'Forged before' } },
        { after: { ...frozenAfter, description: 'Forged result' } },
        { operation: 'remove' },
        { after_product_version: result.after_product_version + 1 },
      ]) {
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
    const removed = await preview([p], ['de', 'en'], { operation: 'remove' });
    await ok(
      executePath(removed.plan),
      'POST',
      consent(removed.plan, { ack_missing_translations: true }),
      admin,
      201,
    );
    const tombstone = (
      await pool.query(
        "SELECT * FROM product_translation_bulk_edit_execution_rows WHERE preview_id=$1 AND locale='de'",
        [removed.plan.id],
      )
    ).rows[0];
    assert(tombstone);
    const removedState = await snapshot();
    await assert.rejects(
      pool.query(
        "INSERT INTO product_translations SELECT(jsonb_populate_record(NULL::product_translations,$1::jsonb||jsonb_build_object('manual_receipt_id',$2::uuid))).*",
        [JSON.stringify(original), tombstone.id],
      ),
      (e: any) => e.code === 'P0001' || e.code === '23514',
    );
    assert.deepEqual(await snapshot(), removedState);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM product_translation_bulk_edit_execution_rows WHERE id=$1',
          [original.manual_receipt_id],
        )
      ).rows[0].n,
      1,
    );
  },
);

async function rule(cookie = admin) {
  return ok(
    '/product-rules',
    'POST',
    {
      client_key: randomUUID(),
      confirm_future_changes: true,
      definition: {
        name: 'Observe translation change',
        event: 'product.updated',
        enabled: true,
        conditions: [],
        actions: [{ type: 'set_category', category: 'Future local classification' }],
      },
    },
    cookie,
    200,
  );
}
test(
  'local rules receive one cause per changed product and backpressure rolls back every locale and receipt',
  { timeout: 20000 },
  async () => {
    let p = await product();
    await rule();
    [p] = await apply([p], ['de', 'en', 'fr']);
    const causes = (
      await pool.query('SELECT * FROM product_rule_causes WHERE tenant_id=$1', [tenant])
    ).rows;
    assert.equal(causes.length, 1);
    assert.equal(causes[0].product_id, p.id);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM product_rule_items WHERE tenant_id=$1', [
          tenant,
        ])
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='product.rules'",
          [tenant],
        )
      ).rows[0].n,
      1,
    );
    const { plan } = await preview([p], ['de', 'en', 'fr'], {
      operation: 'set',
      patch: { description: 'Second reviewed text' },
    });
    await pool.query(
      "INSERT INTO product_rule_runs SELECT(jsonb_populate_record(NULL::product_rule_runs,to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'client_key',gen_random_uuid(),'origin','manual','cause_id',NULL))).* FROM product_rule_runs r CROSS JOIN generate_series(1,99) g WHERE r.tenant_id=$1 AND r.state='queued' LIMIT 99",
      [tenant],
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM product_rule_runs WHERE tenant_id=$1 AND state='queued'",
          [tenant],
        )
      ).rows[0].n,
      100,
    );
    const before = await snapshot();
    assert.equal((await req(executePath(plan), 'POST', consent(plan))).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  },
);
test(
  'a changed active rule or its approving administrator prevents all approved translations',
  { timeout: 20000 },
  async () => {
    const p = await product(),
      r = await rule(other),
      { plan } = await preview([p]);
    const otherId = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'"))
      .rows[0].id;
    await changeGrant("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      otherId,
    ]);
    const before = await snapshot();
    assert.equal((await req(executePath(plan), 'POST', consent(plan))).statusCode, 403);
    assert.deepEqual(await snapshot(), before);
    await changeGrant("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      otherId,
    ]);
    await ok(
      '/product-rules/' + r.id,
      'PUT',
      {
        version: r.version,
        confirm_future_changes: true,
        definition: { ...r.definition, enabled: false },
      },
      admin,
    );
    const after = await snapshot();
    assert.equal((await req(executePath(plan), 'POST', consent(plan))).statusCode, 409);
    assert.deepEqual(await snapshot(), after);
  },
);
test(
  'viewer and incomplete scopes cannot approve; read-only and missing copies reject before JSON parse',
  // Builds read-only and missing-copy apps; renamed tables change pg_catalog, so every schema guard
  // runs uncached: 34 s locally on 13.11.2026 (20 s cut it off on CI). Hang guard only.
  { timeout: 120000 },
  async () => {
    const p = await product(),
      body = await matrix([p]),
      keys = [];
    for (const scopes of [['products:read'], ['products:write']])
      keys.push(
        await ok(
          '/developer/keys',
          'POST',
          { name: 'Translation incomplete scope', scopes },
          admin,
          201,
        ),
      );
    const before = await snapshot();
    assert.equal((await ok(prefix, 'GET', undefined, viewer)).can_write, false);
    assert.equal((await req(prefix + '/previews', 'POST', body, viewer)).statusCode, 403);
    for (const key of keys)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1' + prefix + '/previews',
            headers: { authorization: 'Bearer ' + key.token },
            payload: body,
          })
        ).statusCode,
        403,
      );
    assert.deepEqual(await snapshot(), before);
    const authFor = async (target: Awaited<ReturnType<typeof buildApp>>) => {
      const c = await login('admin@demo.local', target),
        r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, c, target);
      assert.equal(r.statusCode, 200);
      return String(r.headers['set-cookie']).split(';')[0];
    };
    let ro: Awaited<ReturnType<typeof buildApp>> | undefined,
      older: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      ro = await buildApp({ readOnly: true, integrationTransport: transport });
      const c = await authFor(ro),
        meta = await req(prefix, 'GET', undefined, c, ro);
      assert.equal(meta.statusCode, 200);
      assert.equal(meta.headers['cache-control'], 'no-store');
      assert.equal(meta.json().can_write, false);
      const blocked = await ro.inject({
        method: 'POST',
        url: '/api' + prefix + '/previews',
        headers: { cookie: c, 'content-type': 'application/json' },
        payload: '{bad JSON',
      });
      assert.equal(blocked.statusCode, 423);
      await ro.close();
      ro = undefined;
      await pool.query(
        'ALTER TABLE product_translation_bulk_edit_previews RENAME TO product_translation_bulk_edit_previews_hidden',
      );
      older = await buildApp({ integrationTransport: transport });
      const oc = await authFor(older),
        m = await req(prefix, 'GET', undefined, oc, older);
      assert.equal(m.statusCode, 200);
      assert.equal(m.json().available, false);
      assert.equal(m.json().can_write, false);
      assert.equal(m.headers['cache-control'], 'no-store');
      assert.equal(
        (
          await older.inject({
            method: 'POST',
            url: '/api' + prefix + '/previews',
            headers: { cookie: oc, 'content-type': 'application/json' },
            payload: '{bad JSON',
          })
        ).statusCode,
        503,
      );
      assert.equal((await req('/products/' + p.id, 'GET', undefined, oc, older)).statusCode, 200);
    } finally {
      if (ro) await ro.close();
      if (older) await older.close();
      if (
        (
          await pool.query(
            "SELECT to_regclass('public.product_translation_bulk_edit_previews_hidden') p",
          )
        ).rows[0].p
      )
        await pool.query(
          'ALTER TABLE product_translation_bulk_edit_previews_hidden RENAME TO product_translation_bulk_edit_previews',
        );
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls.length, 0);
  },
);
