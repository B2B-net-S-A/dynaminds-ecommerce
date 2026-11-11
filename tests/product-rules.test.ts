import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { registerProductRuleRoutes } from '../server/product-rule-routes';
import {
  PRODUCT_RULE_JOB,
  productRuleDefinition,
  productRuleHash,
  processProductRuleJob,
  reapProductRuleJobs,
  scheduleProductRulesInTx,
  scheduleProductRuleBatchInTx,
  previewProductRules,
  queueProductRules,
  createProductRule,
} from '../server/product-rules';
import type { Actor } from '../server/domain';
assert.equal(process.env.DYNA_TEST, 'true', 'Product rule tests require an isolated ephemeral DB');
assert.match(
  new URL(process.env.DATABASE_URL!).pathname,
  /^\/dynaminds_(?:product_rules_)?test_\w+$/,
);
let app: FastifyInstance,
  admin: string,
  operator: string,
  viewer: string,
  other: string,
  adminId: string,
  tenant: string,
  warehouse: string,
  p1: string,
  p2: string;
const request = (url: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({
    url,
    method,
    payload,
    headers: { cookie, 'x-workspace-id': cookie === other ? SECOND_TENANT : tenant },
  });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await request(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
async function login(target: FastifyInstance, email = 'admin@demo.local') {
  const r = await target.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email, password: 'DynaDemo!2026' },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0];
}
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.product_rules') p")).rows[0].p)
    await pool.query(
      readFileSync(new URL('../server/076_product_rules.sql', import.meta.url), 'utf8'),
    );
  await seed();
  app = await buildApp();
  if (!app.hasRoute({ method: 'GET', url: '/api/product-rules' }))
    registerProductRuleRoutes(app, { available: true, readOnly: false });
  admin = await login(app);
  operator = await login(app, 'operator@demo.local');
  viewer = await login(app, 'viewer@demo.local');
  other = await login(app, 'other@demo.local');
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA product rules','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']],
  );
  for (const role of ['admin', 'operator', 'viewer']) {
    const cookie = role === 'admin' ? admin : role === 'operator' ? operator : viewer;
    const r = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    const changed = r.headers['set-cookie']!.toString().split(';')[0];
    if (role === 'admin') admin = changed;
    else if (role === 'operator') operator = changed;
    else viewer = changed;
  }
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA','RULES')", [
    warehouse,
    tenant,
  ]);
  p1 = (
    await ok('/api/products', 'POST', {
      sku: 'RULES-1',
      name: 'Produkt pierwszy',
      price: 1234,
      warehouse_id: warehouse,
      quantity: 7,
      attributes: { Kolor: 'czarny' },
    })
  ).id;
  p2 = (
    await ok('/api/products', 'POST', {
      sku: 'RULES-2',
      name: 'Produkt drugi',
      price: 5678,
      warehouse_id: warehouse,
      quantity: 11,
      attributes: { Kolor: 'biały' },
    })
  ).id;
});
after(async () => {
  await app.close();
  await pool.end();
});
const definition = (extra: any = {}) => ({
  name: 'Klasyfikacja QA',
  event: 'product.updated',
  enabled: true,
  priority: 50,
  conditions: [],
  actions: [
    { type: 'set_category', category: 'Automatycznie' },
    { type: 'set_attribute', key: 'Audyt', value: 'tak' },
  ],
  ...extra,
});
const rule = (extra: any = {}) =>
  ok('/api/product-rules', 'POST', {
    client_key: randomUUID(),
    definition: definition(extra),
    confirm_future_changes: true,
  });
async function preview(rules: any[], products = [p1], extra: any = {}) {
  const rows = (
    await pool.query('SELECT id,version FROM products WHERE id=ANY($1::uuid[])', [products])
  ).rows;
  return ok('/api/product-rule-runs/preview', 'POST', {
    client_key: randomUUID(),
    event: 'product.updated',
    rule_ids: rules.map((r) => r.id),
    items: products.map((id) => ({
      product_id: id,
      version: rows.find((r) => r.id === id).version,
    })),
    ...extra,
  });
}
const queue = (r: any, extra: any = {}) =>
  ok('/api/product-rule-runs/' + r.id + '/queue', 'POST', {
    confirmed: true,
    scope_hash: r.scope_hash,
    ...extra,
  });
const detail = (r: any) => ok('/api/product-rule-runs/' + r.id);
async function claim(r: any) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 AND state='pending' RETURNING *",
      [r.job_id, randomUUID()],
    )
  ).rows[0];
  assert.ok(j);
  return j;
}
const actor = (): Actor => ({ tenantId: tenant, userId: adminId, role: 'admin' });
const product = (id: string) => ok('/api/products/' + id);

test('typed conditions/actions reject eval, SQL, external actions, unsafe keys and unbounded inputs', async () => {
  for (const d of [
    definition({ actions: [{ type: 'set_price', price: 1 }] }),
    definition({ actions: [{ type: 'set_attribute', key: '__proto__', value: 'x' }] }),
    definition({ conditions: [{ field: 'sql', op: 'eq', value: 'true' }] }),
    definition({ conditions: [{ field: 'sku', op: 'regex', value: '.*' }] }),
    definition({
      actions: Array.from({ length: 6 }, () => ({ type: 'remove_attribute', key: 'K' })),
    }),
    definition({
      conditions: Array.from({ length: 11 }, () => ({ field: 'active', op: 'eq', value: true })),
    }),
    definition({ actions: [{ type: 'set_category', category: 'x'.repeat(81) }] }),
  ])
    assert.equal(productRuleDefinition.safeParse(d).success, false);
  const noConsent = await request('/api/product-rules', 'POST', {
    client_key: randomUUID(),
    definition: definition(),
  });
  assert.equal(noConsent.statusCode, 422);
  const r = await rule({
    actions: [{ type: 'set_attribute', key: 'SQL', value: "'; DROP TABLE products; --" }],
  });
  const run = await queue(await preview([r]));
  await processProductRuleJob(await claim(run));
  assert.equal((await product(p1)).attributes.SQL, "'; DROP TABLE products; --");
});
test('current admin, tenant isolation, FORCE RLS and read-only route guards', async () => {
  const r = await rule(),
    run = await preview([r]);
  for (const cookie of [operator, viewer]) {
    assert.equal((await request('/api/product-rules', 'GET', undefined, cookie)).statusCode, 403);
    assert.equal(
      (
        await request(
          '/api/product-rule-runs/' + run.id + '/queue',
          'POST',
          { confirmed: true, scope_hash: run.scope_hash },
          cookie,
        )
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (await request('/api/product-rule-runs/' + run.id, 'GET', undefined, other)).statusCode,
    404,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    for (const table of [
      'product_rules',
      'product_rule_revisions',
      'product_rule_runs',
      'product_rule_items',
      'product_rule_causes',
    ])
      assert.equal(
        (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenant])).rowCount,
        0,
      );
    await assert.rejects(
      c.query(
        'INSERT INTO product_rule_revisions(tenant_id,rule_id,version,actor_id,definition) VALUES($1,$2,99,$3,$4)',
        [tenant, r.id, adminId, '{}'],
      ),
      /row-level security/,
    );
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM pg_class WHERE relname=ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity',
        [
          [
            'product_rules',
            'product_rule_revisions',
            'product_rule_runs',
            'product_rule_items',
            'product_rule_causes',
          ],
        ],
      )
    ).rows[0].n,
    5,
  );
  const readonly = await buildApp({ readOnly: true });
  if (!readonly.hasRoute({ method: 'GET', url: '/api/product-rules' }))
    registerProductRuleRoutes(readonly, { available: true, readOnly: true });
  const cookie = await login(readonly);
  const response = await readonly.inject({
    url: '/api/product-rules',
    method: 'POST',
    payload: { client_key: randomUUID(), definition: definition(), confirm_future_changes: true },
    headers: { cookie },
  });
  assert.equal(response.statusCode, 423, response.body);
  await readonly.close();
});
test('rule CAS, create dedup, explicit future consent and soft delete preserve immutable revisions', async () => {
  const b = { client_key: randomUUID(), definition: definition(), confirm_future_changes: true };
  const r = await ok('/api/product-rules', 'POST', b);
  assert.equal((await ok('/api/product-rules', 'POST', b)).id, r.id);
  assert.equal(
    (
      await request('/api/product-rules', 'POST', {
        ...b,
        definition: definition({ name: 'Inna' }),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request('/api/product-rules/' + r.id, 'PUT', {
        version: 1,
        definition: definition({ name: 'Nowa' }),
      })
    ).statusCode,
    422,
  );
  const updated = await ok('/api/product-rules/' + r.id, 'PUT', {
    version: 1,
    definition: definition({ enabled: false }),
    confirm_future_changes: false,
  });
  assert.equal(updated.version, 2);
  assert.equal(
    (
      await request('/api/product-rules/' + r.id, 'PUT', {
        version: 1,
        definition: definition(),
        confirm_future_changes: true,
      })
    ).statusCode,
    409,
  );
  const disabled = await ok('/api/product-rules/' + r.id, 'DELETE', { version: 2 });
  assert.equal(disabled.enabled, false);
  assert.ok(disabled.deleted_at);
  assert.equal((await ok('/api/product-rules/' + r.id, 'DELETE', { version: 2 })).version, 3);
  assert.equal((await ok('/api/product-rules')).data.length, 0);
  assert.equal(
    (await pool.query('SELECT * FROM product_rule_revisions WHERE rule_id=$1', [r.id])).rowCount,
    3,
  );
  await tenantTx(tenant, async (c) => {
    await assert.rejects(
      c.query("UPDATE product_rule_revisions SET definition='{}' WHERE rule_id=$1", [r.id]),
      /permission denied|immutable/,
    );
  });
});
test('preview is frozen/no mutation and approval is exact, reusable and CAS fenced', async () => {
  const r = await rule(),
    b = {
      client_key: randomUUID(),
      event: 'product.updated',
      rule_ids: [r.id],
      items: [{ product_id: p1, version: 1 }],
    };
  const p = await ok('/api/product-rule-runs/preview', 'POST', b);
  assert.equal(p.state, 'preview');
  assert.equal((await product(p1)).category, 'Pozostałe');
  assert.equal(p.items[0].projected.category, 'Automatycznie');
  assert.equal((await ok('/api/product-rule-runs/preview', 'POST', b)).id, p.id);
  assert.equal(
    (
      await request('/api/product-rule-runs/preview', 'POST', {
        ...b,
        items: [{ product_id: p2, version: 1 }],
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request('/api/product-rule-runs/' + p.id + '/queue', 'POST', {
        confirmed: false,
        scope_hash: p.scope_hash,
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await request('/api/product-rule-runs/' + p.id + '/queue', 'POST', {
        confirmed: true,
        scope_hash: '0'.repeat(64),
      })
    ).statusCode,
    409,
  );
  const queued = await queue(p),
    again = await queue(p);
  assert.equal(again.job_id, queued.job_id);
  assert.equal(again.reused, true);
  assert.equal(
    (await pool.query('SELECT * FROM jobs WHERE dedup_key=$1', ['product.rules:' + p.id])).rowCount,
    1,
  );
});
test('one local transaction applies ordered rules once; prices/stock/kind/catalog source fields preserved', async () => {
  const first = await rule({
      priority: 10,
      conditions: [{ field: 'attribute', key: 'Kolor', op: 'eq', value: 'czarny' }],
      actions: [
        { type: 'set_category', category: 'Pierwsza' },
        { type: 'remove_attribute', key: 'Kolor' },
      ],
    }),
    second = await rule({
      priority: 20,
      conditions: [{ field: 'category', op: 'eq', value: 'Pozostałe' }],
      actions: [{ type: 'set_category', category: 'Druga' }],
    });
  const before = await product(p1),
    run = await queue(await preview([second, first], [p1, p2])),
    job = await claim(run);
  assert.deepEqual(await processProductRuleJob({ ...job, lease_token: randomUUID() }), {
    processed: false,
  });
  const result = await processProductRuleJob(job);
  assert.equal(result.state, 'done');
  assert.equal(result.changed, 2);
  assert.deepEqual(await processProductRuleJob(job), { processed: false });
  const saved = await product(p1);
  assert.equal(saved.category, 'Druga');
  assert.equal(saved.attributes.Kolor, undefined);
  assert.equal(saved.version, before.version + 1);
  for (const field of ['price', 'sku', 'kind', 'description', 'images', 'active'])
    assert.deepEqual(saved[field], before[field]);
  assert.deepEqual(saved.stock, before.stock);
  const receipt = await detail(run);
  assert.equal(receipt.items.length, 2);
  assert.equal(receipt.items[0].state, 'changed');
  assert.deepEqual(receipt.items[0].matched_rules, [first.id, second.id]);
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM audit_events WHERE action='product.rules.apply' AND detail->>'run_id'=$1",
        [run.id],
      )
    ).rowCount,
    2,
  );
  await tenantTx(tenant, async (c) => {
    await assert.rejects(
      c.query("UPDATE product_rule_items SET projected='{}' WHERE run_id=$1", [run.id]),
      /immutable/,
    );
  });
  await tenantTx(tenant, async (c) => {
    await assert.rejects(
      c.query("UPDATE product_rule_runs SET state='queued' WHERE id=$1", [run.id]),
      /immutable/,
    );
  });
});
test('unmatched and no-op products are audited as skipped without version increments', async () => {
  const r = await rule({ conditions: [{ field: 'sku', op: 'prefix', value: 'OTHER-' }] }),
    run = await queue(await preview([r]));
  await processProductRuleJob(await claim(run));
  const d = await detail(run);
  assert.equal(d.items[0].state, 'skipped');
  assert.equal((await product(p1)).version, 1);
  const same = await rule({ actions: [{ type: 'set_category', category: 'Pozostałe' }] }),
    again = await queue(await preview([same]));
  await processProductRuleJob(await claim(again));
  assert.equal((await detail(again)).items[0].state, 'skipped');
  assert.equal((await product(p1)).version, 1);
});
test('changed product blocks the whole queue and changed rules block every product', async () => {
  const r = await rule(),
    p = await preview([r], [p1, p2]);
  await pool.query("UPDATE products SET name='Zmieniono',version=version+1 WHERE id=$1", [p2]);
  assert.equal(
    (
      await request('/api/product-rule-runs/' + p.id + '/queue', 'POST', {
        confirmed: true,
        scope_hash: p.scope_hash,
      })
    ).statusCode,
    409,
  );
  assert.equal((await detail(p)).state, 'preview');
  assert.equal(
    (await pool.query('SELECT * FROM jobs WHERE dedup_key=$1', ['product.rules:' + p.id])).rowCount,
    0,
  );
  const fresh = await preview([r], [p1, p2]);
  await ok('/api/product-rules/' + r.id, 'PUT', {
    version: r.version,
    definition: definition({ name: 'Nowa' }),
    confirm_future_changes: true,
  });
  assert.equal(
    (
      await request('/api/product-rule-runs/' + fresh.id + '/queue', 'POST', {
        confirmed: true,
        scope_hash: fresh.scope_hash,
      })
    ).statusCode,
    409,
  );
});
test('rule disabled after queue or approving admin revoked prevents all worker changes', async () => {
  const r = await rule(),
    run = await queue(await preview([r], [p1, p2]));
  await ok('/api/product-rules/' + r.id, 'PUT', {
    version: r.version,
    definition: definition({ enabled: false }),
  });
  assert.equal((await processProductRuleJob(await claim(run))).state, 'failed');
  for (const id of [p1, p2]) assert.equal((await product(id)).version, 1);
  assert.equal((await detail(run)).result.rolled_back, true);
  const r2 = await rule(),
    run2 = await queue(await preview([r2]));
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    adminId,
  ]);
  assert.equal((await processProductRuleJob(await claim(run2))).state, 'failed');
  assert.equal(
    (await pool.query('SELECT version FROM products WHERE id=$1', [p1])).rows[0].version,
    1,
  );
});
test('invalid resulting attribute count rolls back preview with zero durable partial rows', async () => {
  const attrs = Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['A' + i, 'v']));
  await pool.query('UPDATE products SET attributes=$2 WHERE id=$1', [p2, JSON.stringify(attrs)]);
  const r = await rule();
  const response = await request('/api/product-rule-runs/preview', 'POST', {
    client_key: randomUUID(),
    event: 'product.updated',
    rule_ids: [r.id],
    items: [
      { product_id: p1, version: 1 },
      { product_id: p2, version: 1 },
    ],
  });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(
    (await pool.query('SELECT * FROM product_rule_runs WHERE tenant_id=$1', [tenant])).rowCount,
    0,
  );
  assert.equal((await product(p1)).version, 1);
});
test('invalid source after queue fails atomically with immutable failed receipts', async () => {
  const r = await rule(),
    run = await queue(await preview([r], [p1, p2]));
  await pool.query('UPDATE products SET attributes=$2 WHERE id=$1', [
    p2,
    JSON.stringify(Object.fromEntries(Array.from({ length: 51 }, (_, i) => ['A' + i, 'v']))),
  ]);
  assert.equal((await processProductRuleJob(await claim(run))).state, 'failed');
  assert.equal((await product(p1)).version, 1);
  const d = await detail(run);
  assert.ok(d.items.every((i: any) => i.state === 'failed'));
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM audit_events WHERE action='product.rules.apply' AND detail->>'run_id'=$1",
        [run.id],
      )
    ).rowCount,
    0,
  );
});
test('unexpected DB failure after first update rolls back all effects; same durable job can recover', async () => {
  const r = await rule(),
    run = await queue(await preview([r], [p1, p2])),
    job = await claim(run);
  await pool.query(
    `CREATE FUNCTION product_rules_qa_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${p2}'::uuid THEN RAISE EXCEPTION 'QA transaction failure';END IF;RETURN NEW;END $$;CREATE TRIGGER product_rules_qa_fail BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION product_rules_qa_fail()`,
  );
  try {
    await assert.rejects(processProductRuleJob(job), /QA transaction failure/);
    assert.equal((await product(p1)).version, 1);
    assert.ok((await detail(run)).items.every((i: any) => i.state === 'pending'));
  } finally {
    await pool.query(
      'DROP TRIGGER product_rules_qa_fail ON products;DROP FUNCTION product_rules_qa_fail()',
    );
  }
  assert.equal((await processProductRuleJob(job)).state, 'done');
  assert.equal((await product(p1)).version, 2);
});
test('hook uses approved future configuration, suppresses its own origin and deduplicates cause', async () => {
  const r = await rule(),
    cause = { origin: 'catalog' as const, cause_id: randomUUID() };
  const run = await tenantTx(tenant, (c) =>
    scheduleProductRulesInTx(c, actor(), p1, 'product.updated', cause),
  );
  assert.equal((run as any).state, 'queued');
  const same = await tenantTx(tenant, (c) =>
    scheduleProductRulesInTx(c, actor(), p1, 'product.updated', cause),
  );
  assert.equal((same as any).id, (run as any).id);
  assert.equal((same as any).reused, true);
  assert.deepEqual(
    await tenantTx(tenant, (c) =>
      scheduleProductRulesInTx(c, actor(), p1, 'product.updated', {
        origin: 'product.rules',
        cause_id: randomUUID(),
      }),
    ),
    { suppressed: true },
  );
  const job = await claim(run);
  assert.equal((await processProductRuleJob(job)).state, 'done');
  assert.equal((await product(p1)).version, 2);
  assert.equal((await detail(run)).origin, 'catalog');
  assert.equal((await detail(run)).queued_actor, null);
  assert.equal(
    (
      await request('/api/product-rule-runs/' + (run as any).id + '/queue', 'POST', {
        confirmed: true,
        scope_hash: (await detail(run)).scope_hash,
      })
    ).statusCode,
    409,
  );
  assert.ok(r.id);
});
test('hook never schedules disabled rules and rejects withdrawn approval even for operator event actor', async () => {
  const r = await rule({ enabled: false });
  assert.deepEqual(
    await tenantTx(tenant, (c) =>
      scheduleProductRulesInTx(c, actor(), p1, 'product.updated', {
        origin: 'catalog',
        cause_id: randomUUID(),
      }),
    ),
    { scheduled: false },
  );
  await ok('/api/product-rules/' + r.id, 'PUT', {
    version: r.version,
    definition: definition(),
    confirm_future_changes: true,
  });
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    adminId,
  ]);
  await assert.rejects(
    tenantTx(tenant, (c) =>
      scheduleProductRulesInTx(c, { ...actor(), role: 'operator' }, p1, 'product.updated', {
        origin: 'catalog',
        cause_id: randomUUID(),
      }),
    ),
    /utracił uprawnienia/,
  );
  assert.equal(
    (await pool.query('SELECT * FROM product_rule_runs WHERE tenant_id=$1', [tenant])).rowCount,
    0,
  );
});
test('100-product bound, duplicate IDs and foreign product scopes rejected before partial writes', async () => {
  const r = await rule();
  for (const products of [
    Array.from({ length: 101 }, () => ({ product_id: randomUUID(), version: 1 })),
    [
      { product_id: p1, version: 1 },
      { product_id: p1, version: 1 },
    ],
  ])
    assert.equal(
      (
        await request('/api/product-rule-runs/preview', 'POST', {
          client_key: randomUUID(),
          event: 'product.updated',
          rule_ids: [r.id],
          items: products,
        })
      ).statusCode,
      422,
    );
  assert.equal(
    (
      await request('/api/product-rule-runs/preview', 'POST', {
        client_key: randomUUID(),
        event: 'product.updated',
        rule_ids: [r.id],
        items: [
          { product_id: p1, version: 1 },
          { product_id: randomUUID(), version: 1 },
        ],
      })
    ).statusCode,
    404,
  );
  const ids = Array.from({ length: 100 }, () => randomUUID());
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) SELECT i,$2,'QA-'||i,'QA bound',1 FROM unnest($1::uuid[]) i",
    [ids, tenant],
  );
  const run = await queue(await preview([r], ids));
  assert.equal((await processProductRuleJob(await claim(run))).changed, 100);
  assert.equal((await detail(run)).items.length, 100);
});
test('active rule admission is serialized at 100 and list pagination has no silent truncation', async () => {
  for (let i = 0; i < 99; i++) await rule({ name: 'Reguła ' + i });
  const results = await Promise.all([
    request('/api/product-rules', 'POST', {
      client_key: randomUUID(),
      definition: definition({ name: 'A' }),
      confirm_future_changes: true,
    }),
    request('/api/product-rules', 'POST', {
      client_key: randomUUID(),
      definition: definition({ name: 'B' }),
      confirm_future_changes: true,
    }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  let cursor: string | undefined;
  const ids = new Set<string>();
  do {
    const page = await ok('/api/product-rules' + (cursor ? '?after=' + cursor : ''));
    for (const r of page.data) {
      assert.ok(!ids.has(r.id));
      ids.add(r.id);
    }
    cursor = page.meta.cursor;
  } while (cursor);
  assert.equal(ids.size, 100);
});
test('run history preserves microsecond ordering with database cursor and exposes bounded heads', async () => {
  const r = await rule(),
    runs = [];
  for (let i = 0; i < 51; i++) runs.push(await preview([r]));
  const first = await ok('/api/product-rule-runs');
  assert.equal(first.data.length, 50);
  assert.ok(first.meta.cursor);
  assert.equal(first.data[0].rules, undefined);
  assert.equal(first.data[0].items, undefined);
  const second = await ok('/api/product-rule-runs?after=' + first.meta.cursor);
  assert.equal(second.data.length, 1);
  const ids = [...first.data, ...second.data].map((r) => r.id);
  assert.deepEqual(
    ids,
    (
      await pool.query(
        'SELECT id FROM product_rule_runs WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC',
        [tenant],
      )
    ).rows.map((r) => r.id),
  );
  assert.equal(new Set(ids).size, 51);
  assert.equal(second.meta.cursor, null);
  assert.equal((await request('/api/product-rule-runs?after=' + randomUUID())).statusCode, 404);
  assert.ok(productRuleHash({ b: 1, a: 2 }) === productRuleHash({ a: 2, b: 1 }));
  assert.equal(
    productRuleHash({ é: 'a', 'e\u0301': 'b' }),
    productRuleHash({ 'e\u0301': 'b', é: 'a' }),
  );
});
test('source version changed after approval blocks all worker effects and exhausted jobs close without replay', async () => {
  const r = await rule(),
    run = await queue(await preview([r], [p1, p2]));
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [p2]);
  assert.equal((await processProductRuleJob(await claim(run))).state, 'failed');
  assert.equal((await product(p1)).version, 1);
  assert.equal((await product(p1)).category, 'Pozostałe');
  const retry = await queue(await preview([r]));
  await pool.query(
    "UPDATE jobs SET state='failed',attempts=max_attempts,error='PRIVATE_PROVIDER_RESPONSE',lease_token=NULL WHERE id=$1",
    [retry.job_id],
  );
  assert.equal((await reapProductRuleJobs()).failed, 1);
  assert.equal((await reapProductRuleJobs()).failed, 0);
  const d = await detail(retry);
  assert.equal(d.state, 'failed');
  assert.equal(d.result.job_failed, true);
  assert.ok(!d.error.includes('PRIVATE_PROVIDER_RESPONSE'));
  assert.equal((await product(p1)).version, 1);
});
test('queue admission is serialized at 100 and failed jobs release capacity only after settling', async () => {
  const r = await rule(),
    queued = [];
  for (let i = 0; i < 99; i++) queued.push(await queue(await preview([r])));
  const a = await preview([r]),
    b = await preview([r]);
  const results = await Promise.all([
    request('/api/product-rule-runs/' + a.id + '/queue', 'POST', {
      confirmed: true,
      scope_hash: a.scope_hash,
    }),
    request('/api/product-rule-runs/' + b.id + '/queue', 'POST', {
      confirmed: true,
      scope_hash: b.scope_hash,
    }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM product_rule_runs WHERE tenant_id=$1 AND state='queued'",
        [tenant],
      )
    ).rows[0].n,
    100,
  );
  const blocked = results[0].statusCode === 409 ? a : b;
  await pool.query("UPDATE jobs SET state='failed',attempts=max_attempts WHERE id=$1", [
    queued[0].job_id,
  ]);
  assert.equal(
    (
      await request('/api/product-rule-runs/' + blocked.id + '/queue', 'POST', {
        confirmed: true,
        scope_hash: blocked.scope_hash,
      })
    ).statusCode,
    409,
  );
  assert.equal((await reapProductRuleJobs()).failed, 1);
  assert.equal((await queue(blocked)).state, 'queued');
  assert.equal(
    (await pool.query('SELECT kind FROM jobs WHERE id=$1', [queued[0].job_id])).rows[0].kind,
    PRODUCT_RULE_JOB,
  );
});
test('automatic condition misses do not consume queue capacity or save phantom executions', async () => {
  await rule({ conditions: [{ field: 'sku', op: 'eq', value: 'ONLY-OTHER-SKU' }] });
  const cause = { origin: 'catalog' as const, cause_id: randomUUID() };
  assert.deepEqual(
    await tenantTx(tenant, (c) =>
      scheduleProductRulesInTx(c, actor(), p1, 'product.updated', cause),
    ),
    { scheduled: false },
  );
  assert.equal(
    (await pool.query('SELECT * FROM product_rule_runs WHERE tenant_id=$1', [tenant])).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query('SELECT * FROM jobs WHERE tenant_id=$1 AND kind=$2', [
        tenant,
        PRODUCT_RULE_JOB,
      ])
    ).rowCount,
    0,
  );
  assert.equal((await product(p1)).version, 1);
});

async function rawProducts(count: number, prefix = 'BATCH', c: any = pool) {
  const ids = Array.from({ length: count }, () => randomUUID());
  await c.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) SELECT i,$2,$3||'-'||i,'Produkt grupowy',1234 FROM unnest($1::uuid[]) i",
    [ids, tenant, prefix],
  );
  return ids;
}
const sourceEvents = (
  ids: string[],
  event: 'product.created' | 'product.updated' = 'product.updated',
) => ids.map((product_id) => ({ product_id, event, cause_id: randomUUID() }));
test('500 matching source products queue five frozen groups atomically and each product applies once', async () => {
  await rule();
  const ids = await rawProducts(500),
    events = sourceEvents(ids);
  const batch = await tenantTx(tenant, (c) => scheduleProductRuleBatchInTx(c, actor(), events));
  assert.equal(batch.scheduled, 500);
  assert.equal(batch.runs.length, 5);
  for (const r of batch.runs) {
    const d = await detail(r);
    assert.equal(d.items.length, 100);
    assert.equal(d.consent.source_events.length, 100);
    assert.equal(d.origin, 'catalog');
    assert.equal(d.queued_actor, null);
    assert.equal((await processProductRuleJob(await claim(r))).changed, 100);
  }
  const rows = (
    await pool.query('SELECT version,category FROM products WHERE id=ANY($1::uuid[])', [ids])
  ).rows;
  assert(rows.every((p) => p.version === 2 && p.category === 'Automatycznie'));
  const replay = await tenantTx(tenant, (c) =>
    scheduleProductRuleBatchInTx(c, actor(), [...events].reverse()),
  );
  assert.equal(replay.scheduled, 0);
  assert.equal(replay.reused, 500);
  assert.equal(replay.runs.length, 5);
  assert(replay.runs.every((r) => r.state === 'done' && r.reused));
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM product_rule_causes WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    500,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM product_rule_runs WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    5,
  );
  const subset = await tenantTx(tenant, (c) =>
    scheduleProductRulesInTx(c, actor(), events[0].product_id, events[0].event, {
      origin: 'catalog',
      cause_id: events[0].cause_id,
    }),
  );
  assert.equal((subset as any).reused, true);
  assert(batch.runs.some((r) => r.id === (subset as any).id));
});
test('grouped emitters separate created/updated, suppress own origin and omit unmatched events without truncating', async () => {
  await rule({
    event: 'product.created',
    conditions: [{ field: 'sku', op: 'prefix', value: 'CREATED-' }],
  });
  await rule({ conditions: [{ field: 'sku', op: 'prefix', value: 'UPDATED-' }] });
  const created = sourceEvents(await rawProducts(101, 'CREATED'), 'product.created');
  const updated = sourceEvents(await rawProducts(99, 'UPDATED'));
  const missed = sourceEvents([p1]);
  const b = await tenantTx(tenant, (c) =>
    scheduleProductRuleBatchInTx(c, actor(), [...created, ...updated, ...missed]),
  );
  assert.equal(b.scheduled, 200);
  assert.equal(b.unmatched, 1);
  assert.equal(b.runs.length, 3);
  const details = await Promise.all(b.runs.map(detail));
  assert.deepEqual(
    details
      .filter((r) => r.event === 'product.created')
      .map((r) => r.items.length)
      .sort((a, b) => a - b),
    [1, 100],
  );
  assert.equal(details.find((r) => r.event === 'product.updated').items.length, 99);
  assert(
    details.every((r) =>
      r.items.every((i: any) =>
        r.consent.source_events.some(
          (e: any) => e.product_id === i.product_id && e.event === r.event,
        ),
      ),
    ),
  );
  const suppressed = await tenantTx(tenant, (c) =>
    scheduleProductRuleBatchInTx(c, actor(), [...created, ...updated], { origin: 'product.rules' }),
  );
  assert.equal(suppressed.suppressed, 200);
  assert.equal(suppressed.runs.length, 0);
  await assert.rejects(
    tenantTx(tenant, (c) =>
      scheduleProductRuleBatchInTx(
        c,
        actor(),
        sourceEvents(Array.from({ length: 501 }, () => randomUUID())),
      ),
    ),
    /too_big|Too big|500/i,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM product_rule_runs WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    3,
  );
});
test('per-product causes deduplicate subsets/input repeats/legacy singleton history and reject changed identity', async () => {
  await rule();
  const events = sourceEvents([p1, p2]);
  const b = await tenantTx(tenant, (c) =>
    scheduleProductRuleBatchInTx(c, actor(), [...events, events[0]]),
  );
  assert.equal(b.scheduled, 2);
  assert.equal(b.runs.length, 1);
  const one = await tenantTx(tenant, (c) =>
    scheduleProductRuleBatchInTx(c, actor(), [events[1], events[1]]),
  );
  assert.equal(one.reused, 1);
  assert.equal(one.runs[0].id, b.runs[0].id);
  for (const changed of [
    { ...events[0], product_id: p2 },
    { ...events[0], event: 'product.created' as const },
  ])
    await assert.rejects(
      tenantTx(tenant, (c) => scheduleProductRuleBatchInTx(c, actor(), [changed])),
      (e: any) => e.status === 409,
    );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      scheduleProductRuleBatchInTx(c, actor(), [events[0], { ...events[0], product_id: p2 }]),
    ),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    tenantTx(tenant, (c) => scheduleProductRuleBatchInTx(c, actor(), sourceEvents([p1, p1]))),
    (e: any) => e.status === 422,
  );
  const oldCause = randomUUID(),
    oldId = randomUUID(),
    oldJob = randomUUID();
  const original = (await tenantTx(tenant, (c) =>
    scheduleProductRulesInTx(c, actor(), p1, 'product.updated', {
      origin: 'catalog',
      cause_id: randomUUID(),
    }),
  )) as any;
  // Isolated owner fixture faithfully represents pre-group consent without
  // source_events; no trigger disabling or edits to an immutable run.
  await pool.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    oldJob,
    tenant,
    PRODUCT_RULE_JOB,
    JSON.stringify({ run_id: oldId }),
    'product.rules:' + oldId,
  ]);
  await pool.query(
    "INSERT INTO product_rule_runs SELECT (jsonb_populate_record(NULL::product_rule_runs,to_jsonb(r)||jsonb_build_object('id',$2::uuid,'job_id',$3::uuid,'cause_id',$4::uuid,'client_key',gen_random_uuid(),'consent',r.consent-'source_events'))).* FROM product_rule_runs r WHERE r.id=$1",
    [original.id, oldId, oldJob, oldCause],
  );
  await pool.query(
    "INSERT INTO product_rule_items SELECT (jsonb_populate_record(NULL::product_rule_items,to_jsonb(i)||jsonb_build_object('run_id',$2::uuid))).* FROM product_rule_items i WHERE run_id=$1",
    [original.id, oldId],
  );
  const old = (await tenantTx(tenant, (c) =>
    scheduleProductRulesInTx(c, actor(), p1, 'product.updated', {
      origin: 'catalog',
      cause_id: oldCause,
    }),
  )) as any;
  assert.equal(old.id, oldId);
  assert.equal(old.reused, true);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM product_rule_runs WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    3,
  );
});
test('all grouped jobs reserve capacity together and a conflict rolls back the entire 300-product source transaction', async () => {
  const r = await rule();
  for (let i = 0; i < 98; i++) {
    // Internal service calls keep this admission test separate from HTTP rate
    // limits shared across the complete isolated test file.
    const p = await previewProductRules(actor(), {
      client_key: randomUUID(),
      event: 'product.updated',
      rule_ids: [r.id],
      items: [{ product_id: p1, version: 1 }],
    });
    await queueProductRules(actor(), p.id, { confirmed: true, scope_hash: p.scope_hash });
  }
  const before = (await pool.query('SELECT to_jsonb(p) p FROM products p WHERE id=$1', [p1]))
    .rows[0].p;
  let ids: string[] = [];
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      ids = await rawProducts(300, 'CAPACITY', c);
      await c.query("UPDATE products SET name='Source change',version=version+1 WHERE id=$1", [p1]);
      await c.query(
        "INSERT INTO audit_events(id,tenant_id,user_id,action,entity_id,detail) VALUES($1,$2,$3,'qa.source.group',$4,'{}')",
        [randomUUID(), tenant, adminId, p1],
      );
      await scheduleProductRuleBatchInTx(c, actor(), sourceEvents(ids));
    }),
    (e: any) => e.status === 409,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM products WHERE id=ANY($1::uuid[])', [ids]))
      .rows[0].n,
    0,
  );
  assert.deepEqual(
    (await pool.query('SELECT to_jsonb(p) p FROM products p WHERE id=$1', [p1])).rows[0].p,
    before,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND action='qa.source.group'",
        [tenant],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM product_rule_runs WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    98,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind=$2', [
        tenant,
        PRODUCT_RULE_JOB,
      ])
    ).rows[0].n,
    98,
  );
});
test('indexed automatic causes preserve exact frozen scope, tenant isolation and append-only privileges', async () => {
  await createProductRule(actor(), {
    client_key: randomUUID(),
    definition: definition(),
    confirm_future_changes: true,
  });
  const events = sourceEvents([p1, p2]);
  const batch = await tenantTx(tenant, (c) => scheduleProductRuleBatchInTx(c, actor(), events));
  const run = batch.runs[0];
  const rows = (
    await pool.query(
      'SELECT cause_id,product_id,event,run_id FROM product_rule_causes WHERE tenant_id=$1 ORDER BY product_id',
      [tenant],
    )
  ).rows;
  assert.deepEqual(
    rows,
    events
      .map((e) => ({ ...e, run_id: run.id }))
      .sort((a, b) => a.product_id.localeCompare(b.product_id)),
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM product_rule_causes WHERE tenant_id=$1', [tenant])).rowCount,
      0,
    );
  });
  for (const sql of [
    'UPDATE product_rule_causes SET event=event WHERE cause_id=$1',
    'DELETE FROM product_rule_causes WHERE cause_id=$1',
  ]) {
    await assert.rejects(
      tenantTx(tenant, (c) => c.query(sql, [events[0].cause_id])),
      /permission denied/,
    );
    await assert.rejects(pool.query(sql, [events[0].cause_id]), /immutable/);
  }
  const insert =
    'INSERT INTO product_rule_causes(tenant_id,cause_id,run_id,product_id,event) VALUES($1,$2,$3,$4,$5)';
  await assert.rejects(
    tenantTx(SECOND_TENANT, (c) =>
      c.query(insert, [tenant, randomUUID(), run.id, p1, 'product.updated']),
    ),
    /row-level security|frozen automatic consent/,
  );
  await assert.rejects(
    tenantTx(tenant, (c) => c.query(insert, [tenant, randomUUID(), run.id, p1, 'product.updated'])),
    /frozen automatic consent/,
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query(insert, [tenant, events[0].cause_id, run.id, p1, 'product.created']),
    ),
    /frozen automatic consent/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM pg_constraint WHERE conrelid='product_rule_causes'::regclass AND contype='f' AND confrelid='product_rule_items'::regclass AND array_length(conkey,1)=3",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM product_rule_causes WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    2,
  );
});
