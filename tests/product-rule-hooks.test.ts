import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  tenant: string,
  warehouse: string,
  user: string;
const req = (url: string, method: any = 'GET', payload?: any) =>
  app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  // Demo OMS fixtures enqueue unrelated automation events; this suite isolates catalogue jobs.
  await pool.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE state IN ('pending','running')",
  );
  app = await buildApp();
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Hooks QA','enterprise')", [
    tenant,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Hooks','HOOK')", [
    warehouse,
    tenant,
  ]);
  const switched = await req('/api/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200, switched.body);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  await pool.end();
});
const product = (sku: string) =>
  ok('/api/products', 'POST', {
    sku,
    name: 'Produkt reguł ' + sku,
    price: 1234,
    quantity: 7,
    warehouse_id: warehouse,
  });
const rule = (event: string, category: string) =>
  ok('/api/product-rules', 'POST', {
    client_key: randomUUID(),
    confirm_future_changes: true,
    definition: {
      name: 'Reguła ' + event,
      event,
      enabled: true,
      conditions: [{ field: 'sku', op: 'prefix', value: 'HOOK-' }],
      actions: [{ type: 'set_category', category }],
    },
  });
async function runs() {
  return (
    await pool.query('SELECT * FROM product_rule_runs WHERE tenant_id=$1 ORDER BY created_at,id', [
      tenant,
    ])
  ).rows;
}
async function drain(expected: number) {
  let observed = 0;
  for (let n = 0; n < expected + 10; n++) {
    if (
      !(await tick({
        transport: async () => {
          throw new Error('Hooks tests never contact providers');
        },
      }))
    )
      break;
    observed++;
  }
  assert.equal(observed, expected);
}
test('real catalogue routes enqueue created/updated, shared worker applies locally once without recursive events', async () => {
  await rule('product.created', 'Utworzone');
  await rule('product.updated', 'Edytowane');
  const p = await product('HOOK-ONE');
  assert.equal(p.category, 'Pozostałe');
  assert.equal((await runs()).length, 1);
  await drain(1);
  const afterCreate = await ok('/api/products/' + p.id);
  assert.equal(afterCreate.category, 'Utworzone');
  assert.equal(afterCreate.version, p.version + 1);
  assert.equal(afterCreate.price, 1234);
  assert.equal(afterCreate.stock[0].on_hand, 7);
  await ok('/api/products/' + p.id, 'PATCH', { ...afterCreate, name: 'Nowa nazwa' });
  assert.equal((await runs()).length, 2);
  await drain(1);
  const afterEdit = await ok('/api/products/' + p.id);
  assert.equal(afterEdit.category, 'Edytowane');
  assert.equal(afterEdit.price, 1234);
  assert.equal(afterEdit.stock[0].on_hand, 7);
  assert.equal((await runs()).length, 2);
  assert.equal(
    (await runs()).every((r) => r.state === 'done'),
    true,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [tenant])).rows[0].n,
    2,
  );
});
test('500-row CSV retains its public limit and creates five frozen rule jobs, replay creates none', async () => {
  await rule('product.created', 'Importowane');
  const csv =
    'sku;name;price\n' +
    Array.from(
      { length: 500 },
      (_, i) => `HOOK-${i.toString().padStart(3, '0')};Produkt ${i};12,34`,
    ).join('\n');
  const preview = await ok('/api/catalog/imports/preview', 'POST', {
    warehouse_id: warehouse,
    csv,
  });
  const applied = await ok('/api/catalog/imports/' + preview.id + '/apply', 'POST');
  assert.equal(applied.created, 500);
  const queued = await runs();
  assert.equal(queued.length, 5);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT count(*)::int n FROM product_rule_items WHERE tenant_id=$1 GROUP BY run_id',
        [tenant],
      )
    ).rows.map((r) => r.n),
    [100, 100, 100, 100, 100],
  );
  const replay = await ok('/api/catalog/imports/' + preview.id + '/apply', 'POST');
  assert.equal(replay.reused, true);
  assert.equal((await runs()).length, 5);
  await drain(5);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM products WHERE tenant_id=$1 AND category='Importowane' AND price=1234 AND version=2",
        [tenant],
      )
    ).rows[0].n,
    500,
  );
  assert.equal(
    (await runs()).every((r) => r.state === 'done'),
    true,
  );
});
test('queue-capacity rejection rolls back all 500 source writes and all partial admissions; preview remains reusable', async () => {
  const p = await product('HOOK-BUDGET');
  const r = await rule('product.created', 'Import');
  for (let i = 0; i < 96; i++) {
    const preview = await ok('/api/product-rule-runs/preview', 'POST', {
      client_key: randomUUID(),
      event: 'product.created',
      rule_ids: [r.id],
      items: [{ product_id: p.id, version: p.version }],
    });
    await ok('/api/product-rule-runs/' + preview.id + '/queue', 'POST', {
      confirmed: true,
      scope_hash: preview.scope_hash,
    });
  }
  assert.equal((await runs()).length, 96);
  const csv =
    'sku;name;price\n' +
    Array.from({ length: 500 }, (_, i) => `HOOK-ROLLBACK-${i};Nowy ${i};1,00`).join('\n');
  const preview = await ok('/api/catalog/imports/preview', 'POST', {
    warehouse_id: warehouse,
    csv,
  });
  const rejected = await req('/api/catalog/imports/' + preview.id + '/apply', 'POST');
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal((await runs()).length, 96);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM products WHERE tenant_id=$1 AND sku LIKE 'HOOK-ROLLBACK-%'",
        [tenant],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT status FROM catalog_imports WHERE id=$1', [preview.id])).rows[0]
      .status,
    'preview',
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [tenant])).rows[0].n,
    96,
  );
});
