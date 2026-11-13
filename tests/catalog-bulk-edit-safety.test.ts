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
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '',
  operator = '',
  viewer = '',
  otherAdmin = '',
  tenant = '',
  warehouse = '',
  adminId = '';
let sourceAddress = 10,
  providerCalls = 0;
const cookies = new Map<string, string>();
const transport = async () => {
  providerCalls++;
  throw new Error('No provider calls in bulk PIM safety tests');
};
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin, target = app) =>
  target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.104.' + sourceAddress,
  });
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const response = await req(path, method, payload, cookie);
  assert.equal(response.statusCode, status, `${method} ${path}: expected ${status}`);
  return response.json() as any;
}
async function login(email: string, target = app) {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return r.headers['set-cookie']!.toString().split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  for (const email of [
    'admin@demo.local',
    'operator@demo.local',
    'viewer@demo.local',
    'other@demo.local',
  ])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  sourceAddress++;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Isolated bulk PIM safety','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'operator@demo.local' THEN 'operator' WHEN 'viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, r.headers['set-cookie']!.toString().split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  operator = cookies.get('operator@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  otherAdmin = cookies.get('other@demo.local')!;
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Bulk PIM','BULK')",
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
      sku: 'BULK-' + randomUUID(),
      name: 'Original product',
      price: 1234,
      quantity: 9,
      warehouse_id: warehouse,
      attributes: { Material: 'steel', Colour: 'black' },
      ...extra,
    },
    admin,
    201,
  );
}
const input = (products: any[], changes: any = { category: 'Reviewed category' }) => ({
  client_key: randomUUID(),
  rows: products.map((p) => ({ product_id: p.id, version: p.version, changes })),
});
async function preview(body: any) {
  return (await ok('/catalog-bulk-edit/previews', 'POST', body, admin, 201)).preview;
}
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const execute = (p: any, body = consent(p), cookie = admin) =>
  req('/catalog-bulk-edit/previews/' + p.id + '/execute', 'POST', body, cookie);
const businessTables = [
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'reservations',
  'listings',
  'offer_plans',
  'bundle_components',
  'jobs',
  'audit_events',
  'product_rules',
  'product_rule_revisions',
  'product_rule_runs',
  'product_rule_items',
  'product_rule_causes',
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
  const holderId = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // Deadline to reach the wait, not part of it: on an ungated test database the request runs schema
  // validators first, and 2.5 s missed the wait once in three local runs on 13.11.2026.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const r = await pool.query(
      "SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
      [holderId],
    );
    if (
      r.rows.some((row) =>
        kind === 'catalog'
          ? row.query.includes('pg_advisory_xact_lock')
          : row.query.includes('products') && /FOR\s+UPDATE/i.test(row.query),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Bulk operation did not actually wait for the held ' + kind + ' lock');
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
async function rule() {
  return ok(
    '/product-rules',
    'POST',
    {
      client_key: randomUUID(),
      confirm_future_changes: true,
      definition: {
        name: 'Bulk PIM future rule',
        event: 'product.updated',
        enabled: true,
        conditions: [],
        actions: [{ type: 'set_category', category: 'Rule result' }],
      },
    },
    admin,
    200,
  );
}

// Hang guards only: under local load (13.11.2026) a lock-wait test here took longer than 20 s and,
// cancelled half-way, left the admin downgraded for the next test; 120 s matches the other db files.
test(
  'preview waits on the real catalog lock; administrator downgrade commits first and creates no evidence',
  { timeout: 120000 },
  async () => {
    const p = await product(),
      body = input([p]),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'catalog:' + tenant,
      ]);
      pending = req('/catalog-bulk-edit/previews', 'POST', body);
      await waitOn(holder, 'catalog');
      await downgrade();
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      const after = await snapshot();
      // The membership change is the only authorized fixture mutation.
      assert.deepEqual(after, before);
      assert.equal((await req('/catalog-bulk-edit/previews', 'POST', body)).statusCode, 403);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'execute waits on the actual product row before current-role authorization and leaves no partial writes',
  { timeout: 120000 },
  async () => {
    const products = [await product(), await product()],
      p = await preview(input(products)),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [
        products
          .map((p) => p.id)
          .sort()
          .at(-1),
      ]);
      pending = execute(p);
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
  'canonical JSON retries survive jsonb key order; actor and payload mismatches cannot reuse consent',
  { timeout: 120000 },
  async () => {
    const p = await product(),
      body = input([p], { attributes: { Zebra: 'last', Alpha: 'first' }, category: 'Canonical' });
    const plan = await preview(body),
      before = await snapshot();
    const reordered = {
      rows: [
        {
          changes: { category: 'Canonical', attributes: { Alpha: 'first', Zebra: 'last' } },
          version: p.version,
          product_id: p.id,
        },
      ],
      client_key: body.client_key,
    };
    const retry = await ok('/catalog-bulk-edit/previews', 'POST', reordered);
    assert.equal(retry.preview.id, plan.id);
    assert.equal(retry.reused, true);
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await req('/catalog-bulk-edit/previews', 'POST', {
          ...body,
          rows: [{ ...body.rows[0], changes: { category: 'Other' } }],
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await req('/catalog-bulk-edit/previews', 'POST', body, otherAdmin)).statusCode,
      409,
    );
    assert.equal((await execute(plan, consent(plan), otherAdmin)).statusCode, 403);
    const accepted = consent(plan),
      done = await execute(plan, accepted);
    assert.equal(done.statusCode, 201);
    const settled = await snapshot();
    const second = await execute(plan, {
      confirmed: true,
      scope_hash: accepted.scope_hash,
      client_key: accepted.client_key,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().reused, true);
    assert.equal(second.json().execution.id, done.json().execution.id);
    assert.deepEqual(await snapshot(), settled);
    assert.equal((await execute(plan, accepted, otherAdmin)).statusCode, 409);
    assert.equal(
      (await execute(plan, { ...accepted, scope_hash: '0'.repeat(64) })).statusCode,
      409,
    );
    assert.deepEqual(await snapshot(), settled);
    assert.equal(providerCalls, 0);
  },
);

test(
  'one stale row rejects an otherwise writable batch atomically including audit and rule jobs',
  { timeout: 120000 },
  async () => {
    const products = [await product(), await product(), await product()];
    await rule();
    const p = await preview(input(products));
    await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [products.at(-1)!.id]);
    const before = await snapshot();
    assert.equal((await execute(p)).statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  },
);

test(
  'changed future-rule configuration and full rule queue reject the complete batch without effects',
  { timeout: 120000 },
  async () => {
    const products = [await product(), await product()],
      r = await rule(),
      p = await preview(input(products));
    await ok('/product-rules/' + r.id, 'PUT', {
      version: r.version,
      confirm_future_changes: true,
      definition: { ...r.definition, name: 'Changed future rule' },
    });
    const beforeChange = await snapshot();
    assert.equal((await execute(p)).statusCode, 409);
    assert.deepEqual(await snapshot(), beforeChange);
    const fresh = await preview(input(products));
    // Valid durable queued rows fill the existing capacity; no worker or fake grant is used.
    const capacity = Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      job_id: randomUUID(),
      key: randomUUID(),
    }));
    const storedRule = (await pool.query('SELECT * FROM product_rules WHERE id=$1', [r.id]))
      .rows[0];
    await pool.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) SELECT job_id,$1,'product.rules',jsonb_build_object('run_id',id),'bulk-capacity:'||id FROM jsonb_to_recordset($2::jsonb) x(id uuid,job_id uuid,key uuid)",
      [tenant, JSON.stringify(capacity)],
    );
    await pool.query(
      "INSERT INTO product_rule_runs(id,tenant_id,actor_id,event,origin,client_key,request_hash,scope_hash,rules,state,consent,queued_actor,job_id,queued_at) SELECT id,$1,$2,'product.updated','manual',key,$3,$3,$4,'queued','{}',$2,job_id,now() FROM jsonb_to_recordset($5::jsonb) x(id uuid,job_id uuid,key uuid)",
      [tenant, adminId, 'a'.repeat(64), JSON.stringify([storedRule]), JSON.stringify(capacity)],
    );
    const full = await snapshot();
    assert.equal((await execute(fresh)).statusCode, 409);
    assert.deepEqual(await snapshot(), full);
  },
);

test(
  'unchanged replacement fields keep versions, audit and jobs unchanged even with an enabled future rule',
  { timeout: 120000 },
  async () => {
    const p = await product();
    await rule();
    const plan = await preview(
      input([p], {
        attributes: { Colour: 'black', Material: 'steel' },
        price: p.price,
        name: p.name,
      }),
    );
    assert.equal(plan.changed, 0);
    assert.equal(plan.unchanged, 1);
    const before = await snapshot(businessTables),
      done = await execute(plan);
    assert.equal(done.statusCode, 201);
    assert.equal(done.json().execution.changed, 0);
    assert.deepEqual(await snapshot(businessTables), before);
  },
);

test(
  'descriptive edits preserve stock, reserved orders, listings, variants and inactive historical bundle components',
  { timeout: 120000 },
  async () => {
    const component = await product(),
      group = await product({ kind: 'group', quantity: 0 }),
      variant = await product({ kind: 'variant', parent_id: group.id }),
      kit = await product({
        kind: 'bundle',
        quantity: 0,
        components: [
          { product_id: component.id, quantity: 2 },
          { product_id: variant.id, quantity: 1 },
        ],
      });
    await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Bulk safety buyer',
        email: 'bulk@example.test',
        warehouse_id: warehouse,
        items: [{ product_id: kit.id, quantity: 1 }],
      },
      admin,
      201,
    );
    const channel = randomUUID();
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'woocommerce','Isolated listing','sandbox','','{}','simulation')",
      [channel, tenant],
    );
    await pool.query(
      "INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,price) VALUES($1,$2,$3,$4,'own-listing',1234)",
      [randomUUID(), tenant, channel, kit.id],
    );
    await pool.query('UPDATE products SET active=false,version=version+1 WHERE id=$1', [
      component.id,
    ]);
    const preserved = [
      'stock',
      'stock_movements',
      'orders',
      'order_items',
      'reservations',
      'listings',
      'offer_plans',
      'bundle_components',
    ];
    const before = await snapshot(preserved),
      plan = await preview(input([kit, variant], { description: 'Approved bulk description' }));
    assert.equal(plan.ready, true);
    assert.equal((await execute(plan)).statusCode, 201);
    assert.deepEqual(await snapshot(preserved), before);
    const rows = (
      await pool.query(
        'SELECT id,parent_id,kind,description FROM products WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[kit.id, variant.id]],
      )
    ).rows;
    assert.equal(rows.find((row) => row.id === variant.id).parent_id, group.id);
    assert(rows.every((row) => row.description === 'Approved bulk description'));
    assert.equal(providerCalls, 0);
  },
);

test(
  'SQL evidence rejects terminal tampering and foreign product bindings and hides every table through RLS',
  { timeout: 120000 },
  async () => {
    const p = await product(),
      plan = await preview(input([p]));
    assert.equal((await execute(plan)).statusCode, 201);
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
      for (const mutation of [
        `DELETE FROM ${table} WHERE tenant_id=$1`,
        `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`,
      ]) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await assert.rejects(c.query(mutation, [tenant]), /immutable/i);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      }
    }
    const foreign = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
    ).rows[0];
    const c = await pool.connect(),
      newPlan = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query(
        'INSERT INTO catalog_bulk_edit_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,source,rules_snapshot,total,changed,unchanged,invalid,conflicts,ready) SELECT $2,tenant_id,actor_id,$3,request_hash,scope_hash,source,rules_snapshot,total,changed,unchanged,invalid,conflicts,ready FROM catalog_bulk_edit_previews WHERE id=$1',
        [plan.id, newPlan, randomUUID()],
      );
      await assert.rejects(
        c.query(
          'INSERT INTO catalog_bulk_edit_rows(tenant_id,preview_id,index,product_id,resolved_product_id,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors) SELECT tenant_id,$2,index,$3,$3,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors FROM catalog_bulk_edit_rows WHERE preview_id=$1',
          [plan.id, newPlan, foreign.id],
        ),
        (e: any) => e.code === '23503',
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  },
);

test(
  'selection refuses a mixed foreign scope; viewer cannot mutate and public keys need read plus write',
  { timeout: 120000 },
  async () => {
    const p = await product(),
      foreign = (
        await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
      ).rows[0];
    const rejected = await req('/catalog-bulk-edit/selection?ids=' + p.id + ',' + foreign.id);
    assert.equal(rejected.statusCode, 404);
    assert(!rejected.body.includes(p.sku));
    assert(!rejected.body.includes(foreign.id));
    const body = input([p]),
      before = await snapshot();
    for (const auth of [viewer, operator]) {
      assert.equal((await req('/catalog-bulk-edit/previews', 'POST', body, auth)).statusCode, 403);
      const read = await req('/catalog-bulk-edit', 'GET', undefined, auth);
      assert.equal(read.statusCode, 200);
      assert.equal(read.headers['cache-control'], 'no-store');
      assert.equal(read.json().can_read, true);
      assert.equal(read.json().can_write, false);
    }
    assert.deepEqual(await snapshot(), before);
    const key = async (scopes: string[]) =>
      ok('/developer/keys', 'POST', { name: 'Bulk PIM scopes', scopes }, admin, 201);
    const writeOnly = await key(['products:write']),
      readOnly = await key(['products:read']),
      both = await key(['products:read', 'products:write']);
    const publicReq = (token: string, path: string, method: any = 'GET', payload?: any) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        payload,
        headers: { authorization: 'Bearer ' + token },
        remoteAddress: '127.0.104.' + sourceAddress,
      });
    const keySnapshot = await snapshot();
    assert.equal(
      (await publicReq(writeOnly.token, '/catalog-bulk-edit/previews', 'POST', body)).statusCode,
      403,
    );
    assert.equal(
      (await publicReq(readOnly.token, '/catalog-bulk-edit/previews', 'POST', body)).statusCode,
      403,
    );
    const read = await publicReq(readOnly.token, '/catalog-bulk-edit');
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().can_write, false);
    assert.deepEqual(await snapshot(), keySnapshot);
    const made = await publicReq(both.token, '/catalog-bulk-edit/previews', 'POST', body);
    assert.equal(made.statusCode, 201);
    assert.equal(
      (
        await publicReq(
          both.token,
          '/catalog-bulk-edit/previews/' + made.json().preview.id + '/execute',
          'POST',
          consent(made.json().preview),
        )
      ).statusCode,
      201,
    );
  },
);

test(
  'revoked, expired or scope-reduced API keys fail after the real product wait with no evidence or catalogue effects',
  { timeout: 120000 },
  async () => {
    for (const change of ['revoke', 'scope', 'expire']) {
      const p = await product(),
        plan = await preview(input([p])),
        key = await ok(
          '/developer/keys',
          'POST',
          { name: 'Late key ' + change, scopes: ['products:read', 'products:write'] },
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
          method: 'POST',
          url: '/api/v1/catalog-bulk-edit/previews/' + plan.id + '/execute',
          payload: consent(plan),
          headers: { authorization: 'Bearer ' + key.token },
          remoteAddress: '127.0.104.' + sourceAddress,
        });
        await waitOn(holder, 'product');
        const grant = await pool.connect();
        try {
          await grant.query('BEGIN');
          await grant.query("SET LOCAL statement_timeout='1500ms'");
          await grant.query(
            change === 'revoke'
              ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
              : change === 'scope'
                ? "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1"
                : "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1",
            [key.id],
          );
          await grant.query('COMMIT');
        } finally {
          await grant.query('ROLLBACK');
          grant.release();
        }
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
  'bounded Unicode request returns 413 before preview creation and readonly or missing082 gates precede parsing',
  // Two extra buildApp calls, the second after table renames that change pg_catalog, so every schema
  // guard runs uncached: 33 s locally on 13.11.2026 (30 s cut it off on CI). Hang guard only.
  { timeout: 120000 },
  async () => {
    const p = await product(),
      body = input([p], { description: '🧵'.repeat(200000) }),
      before = await snapshot();
    assert(Buffer.byteLength(JSON.stringify(body), 'utf8') > 786432);
    assert.equal((await req('/catalog-bulk-edit/previews', 'POST', body)).statusCode, 413);
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await req('/catalog-bulk-edit/previews', 'POST', {
          client_key: randomUUID(),
          rows: [{ product_id: p.id, version: 2147483648, changes: { category: 'Overflow' } }],
        })
      ).statusCode,
      422,
      'Versions outside the stored integer domain must be rejected before SQL',
    );
    assert.deepEqual(await snapshot(), before);
    const readonly = await buildApp({ readOnly: true, integrationTransport: transport });
    try {
      let auth = await login('admin@demo.local', readonly);
      const switched = await req(
        '/workspaces/switch',
        'POST',
        { tenant_id: tenant },
        auth,
        readonly,
      );
      assert.equal(switched.statusCode, 200);
      auth = switched.headers['set-cookie']!.toString().split(';')[0];
      const read = await req('/catalog-bulk-edit', 'GET', undefined, auth, readonly);
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().read_only, true);
      assert.equal(read.json().can_write, false);
      assert.equal(read.headers['cache-control'], 'no-store');
      assert.equal(
        (await req('/catalog-bulk-edit/previews', 'POST', { invalid: true }, auth, readonly))
          .statusCode,
        423,
      );
      assert.equal(
        (
          await req(
            '/catalog-bulk-edit/previews/' + randomUUID() + '/execute',
            'POST',
            { invalid: true },
            auth,
            readonly,
          )
        ).statusCode,
        423,
      );
    } finally {
      await readonly.close();
    }
    let old: Awaited<ReturnType<typeof buildApp>> | undefined;
    const renamed: string[] = [];
    try {
      for (const table of evidenceTables) {
        await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_safety_hidden`);
        renamed.push(table);
      }
      old = await buildApp({ integrationTransport: transport });
      const missing = await req('/catalog-bulk-edit', 'GET', undefined, admin, old);
      assert.equal(missing.statusCode, 200);
      assert.equal(missing.json().available, false);
      assert.equal(missing.json().can_write, false);
      assert.equal(missing.headers['cache-control'], 'no-store');
      assert.equal(
        (await req('/catalog-bulk-edit/previews', 'POST', { invalid: true }, admin, old))
          .statusCode,
        503,
      );
      assert.equal((await req('/products/' + p.id, 'GET', undefined, admin, old)).statusCode, 200);
    } finally {
      await old?.close();
      for (const table of renamed.reverse())
        await pool.query(`ALTER TABLE ${table}_safety_hidden RENAME TO ${table}`);
    }
    assert.equal(providerCalls, 0);
  },
);
