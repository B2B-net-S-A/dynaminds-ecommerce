import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { registerCatalogBulkEditRoutes } from '../server/catalog-bulk-edit-routes';
import { catalogBulkEditHash } from '../server/catalog-bulk-edit';
import type { Actor } from '../server/domain';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_\w*test_\w+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  operator = '',
  viewer = '',
  tenant = '',
  user = '',
  warehouse = '',
  ip = 1;
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api/catalog-bulk-edit' + path,
    method,
    payload,
    headers: { cookie: auth, 'x-workspace-id': tenant },
    remoteAddress: '127.0.104.' + ip,
  });
async function ok(path: string, method: any = 'GET', payload?: any, auth = cookie, status = 200) {
  const r = await req(path, method, payload, auth);
  assert.equal(r.statusCode, status, path + ' HTTP ' + r.statusCode);
  return r.json() as any;
}
const actor = (): Actor => ({ tenantId: tenant, userId: user, role: 'admin' });
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.catalog_bulk_edit_previews') p")).rows[0].p)
    await pool.query(
      readFileSync(new URL('../server/082_catalog_bulk_edit.sql', import.meta.url), 'utf8'),
    );
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw new Error('No provider calls in local PIM sheet');
    },
  });
  if (!app.hasRoute({ method: 'GET', url: '/api/catalog-bulk-edit' }))
    registerCatalogBulkEditRoutes(app, { available: true, readOnly: false });
  for (const email of ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200, 'Login HTTP status');
    const c = String(r.headers['set-cookie']).split(';')[0];
    if (email.startsWith('admin')) cookie = c;
    else if (email.startsWith('operator')) operator = c;
    else viewer = c;
  }
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA104 catalog sheet','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']],
  );
  for (const which of ['admin', 'operator', 'viewer']) {
    const c = which === 'admin' ? cookie : which === 'operator' ? operator : viewer;
    const r = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie: c },
    });
    assert.equal(r.statusCode, 200, 'Switch HTTP status');
    const changed = String(r.headers['set-cookie']).split(';')[0];
    if (which === 'admin') cookie = changed;
    else if (which === 'operator') operator = changed;
    else viewer = changed;
  }
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA104','SHEET')", [
    warehouse,
    tenant,
  ]);
});
after(async () => {
  await app.close();
  await pool.end();
});
async function products(count = 1, extra: any = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    sku: 'SHEET-' + randomUUID(),
    name: 'Produkt arkusza ' + i,
    price: 1234,
    vat: 23,
    category: 'Dawna',
    description: 'Dawny opis',
    attributes: { keep: 'old' },
    images: ['https://example.test/old.jpg'],
    active: true,
    ...extra,
  }));
  await tenantTx(tenant, async (c) => {
    await c.query(
      `INSERT INTO products(id,tenant_id,sku,name,price,vat,category,description,attributes,images,active)
      SELECT id,$1,sku,name,price,vat,category,description,attributes,images,active FROM jsonb_to_recordset($2::jsonb) x(id uuid,sku text,name text,price integer,vat integer,category text,description text,attributes jsonb,images jsonb,active boolean)`,
      [tenant, JSON.stringify(rows)],
    );
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) SELECT $1,$2,id,10 FROM products WHERE id=ANY($3::uuid[])',
      [tenant, warehouse, rows.map((r) => r.id)],
    );
  });
  return rows.map((r) => ({ ...r, version: 1 }));
}
const body = (rows: any[]) => ({
  client_key: randomUUID(),
  rows: rows.map((p) => ({ product_id: p.id, version: p.version, changes: p.changes ?? {} })),
});
async function preview(rows: any[]) {
  return (await ok('/previews', 'POST', body(rows), cookie, 201)).preview;
}
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
async function execute(p: any, b = consent(p)) {
  return ok('/previews/' + p.id + '/execute', 'POST', b, cookie, 201);
}
async function state(ids: string[]) {
  return tenantTx(tenant, async (c) => ({
    products: (await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id', [ids]))
      .rows,
    stock: (
      await c.query('SELECT * FROM stock WHERE product_id=ANY($1::uuid[]) ORDER BY product_id', [
        ids,
      ])
    ).rows,
    audit: (await c.query('SELECT * FROM audit_events ORDER BY id')).rows,
    jobs: (await c.query('SELECT * FROM jobs ORDER BY id')).rows,
  }));
}
test('exact own selection pages expose nine fields with technical identity and reject truncation/duplicates', async () => {
  const p = await products(51);
  const m = await ok('');
  assert.equal(m.limits.products, 500);
  assert.equal(m.limits.page, 50);
  assert.equal(m.can_write, true);
  const first = await ok(
    '/selection?ids=' +
      p
        .slice(0, 50)
        .map((x) => x.id)
        .join(','),
    'GET',
    undefined,
    viewer,
  );
  assert.equal(first.data.length, 50);
  assert.equal(first.current_role, 'viewer');
  assert.equal(first.can_write, false);
  assert.deepEqual(
    new Set(first.data.map((x: any) => x.id)),
    new Set(p.slice(0, 50).map((x) => x.id)),
  );
  assert.equal(first.data[0].price, 1234);
  assert.equal(first.data[0].version, 1);
  assert.equal((await req('/selection?ids=' + p.map((x) => x.id).join(','))).statusCode, 422);
  assert.equal((await req('/selection?ids=' + p[0].id + ',' + p[0].id)).statusCode, 422);
  assert.equal((await req('/selection?ids=' + p[0].id + ',' + randomUUID())).statusCode, 404);
});
test('invalid, stale and missing rows remain frozen and block the whole preview without catalogue/job effects', async () => {
  const p = await products(4),
    before = await state(p.map((x) => x.id));
  const v = await preview([
    { ...p[0], changes: { price: -1 } },
    { ...p[1], version: 2, changes: { name: 'Nowa' } },
    { id: randomUUID(), version: 1, changes: { active: false } },
    { ...p[3], changes: { name: 'Poprawna' } },
  ]);
  assert.deepEqual([v.ready, v.total, v.invalid, v.conflicts, v.changed], [false, 4, 1, 2, 1]);
  const rows = (await ok('/previews/' + v.id + '/rows')).data;
  assert.deepEqual(
    rows.map((x: any) => x.status),
    ['invalid', 'conflict', 'missing', 'changed'],
  );
  assert.equal(rows[0].after, null);
  assert.equal(rows[2].before, null);
  assert.equal(rows[2].sku, null);
  assert.ok(rows.slice(0, 3).every((x: any) => x.errors.length));
  assert.equal((await req('/previews/' + v.id + '/execute', 'POST', consent(v))).statusCode, 409);
  assert.deepEqual(await state(p.map((x) => x.id)), before);
  assert.equal(
    (
      await req('/previews', 'POST', {
        client_key: randomUUID(),
        rows: [{ product_id: p[0].id, version: 1, changes: { product_id: 'forbidden' } }],
      })
    ).statusCode,
    422,
  );
});
test('all nine partial fields and explicit clears preserve absent values and ordinary commerce snapshots', async () => {
  const [p, q] = await products(2),
    before = await state([p.id, q.id]);
  const full = {
    name: 'Zmieniona nazwa',
    ean: '',
    price: 2500,
    vat: 8,
    category: '',
    description: '',
    active: false,
    attributes: {},
    images: [],
  };
  const v = await preview([
    { ...p, changes: full },
    { ...q, changes: { description: 'Tylko opis' } },
  ]);
  assert.equal(v.ready, true);
  const rows = (await ok('/previews/' + v.id + '/rows')).data;
  assert.deepEqual(rows[0].after, {
    ...full,
    sku: p.sku,
    weight_grams: null,
    length_mm: null,
    width_mm: null,
    height_mm: null,
    manufacturer: null,
  });
  assert.equal(rows[0].changed_fields.length, 9);
  const e = await execute(v);
  assert.equal(e.execution.changed, 2);
  const after = await state([p.id, q.id]);
  const pp = after.products.find((x) => x.id === p.id),
    qq = after.products.find((x) => x.id === q.id);
  for (const [k, value] of Object.entries(full)) assert.deepEqual(pp[k], value);
  assert.equal(qq.description, 'Tylko opis');
  assert.equal(qq.price, 1234);
  assert.deepEqual(qq.attributes, { keep: 'old' });
  assert.deepEqual(qq.images, ['https://example.test/old.jpg']);
  assert.deepEqual(after.stock, before.stock);
  assert.equal(after.jobs.length, 0);
  assert.equal(pp.version, 2);
  assert.equal(qq.version, 2);
  const result = (await ok('/executions/' + e.execution.id + '/rows')).data;
  assert.deepEqual(
    result.map((x: any) => [x.before_version, x.after_version]),
    [
      [1, 2],
      [1, 2],
    ],
  );
});
test('own image references validate in preview; omitted nullable legacy EAN remains unchanged', async () => {
  const [p] = await products();
  await tenantTx(tenant, (c) => c.query('UPDATE products SET ean=NULL WHERE id=$1', [p.id]));
  const missingImage = await preview([
    { ...p, changes: { images: ['/api/product-images/' + randomUUID()] } },
  ]);
  assert.equal(missingImage.ready, false);
  assert.equal(missingImage.invalid, 1);
  const r = (await ok('/previews/' + missingImage.id + '/rows')).data[0];
  assert.match(r.errors.join(' '), /Zdjęcie/);
  const valid = await preview([{ ...p, changes: { name: 'Nazwa bez EAN' } }]);
  await execute(valid);
  const saved = (await state([p.id])).products[0];
  assert.equal(saved.ean, null);
  assert.equal(saved.name, 'Nazwa bez EAN');
});
test('500 explicit products paginate exactly and one atomic emitter schedules five durable rule groups', async () => {
  const prefix = 'FULL500-' + randomUUID();
  const p = await products(500, { attributes: { batch: prefix } });
  const rule = await app.inject({
    url: '/api/product-rules',
    method: 'POST',
    headers: { cookie, 'x-workspace-id': tenant },
    payload: {
      client_key: randomUUID(),
      confirm_future_changes: true,
      definition: {
        name: 'Arkusz500',
        event: 'product.updated',
        enabled: true,
        conditions: [{ field: 'attribute', key: 'batch', op: 'eq', value: prefix }],
        actions: [{ type: 'set_attribute', key: 'queued', value: 'true' }],
      },
    },
  });
  assert.equal(rule.statusCode, 200, 'Product rule HTTP status');
  const v = await preview(p.map((x) => ({ ...x, changes: { category: 'Arkusz500' } })));
  assert.equal(v.active_product_rules, 1);
  assert.equal(v.changed, 500);
  let cursor: string | null = null,
    seen: any[] = [];
  do {
    const page = await ok('/previews/' + v.id + '/rows' + (cursor ? '?cursor=' + cursor : ''));
    assert.ok(page.data.length <= 50);
    seen.push(...page.data);
    cursor = page.meta.cursor;
  } while (cursor);
  assert.equal(seen.length, 500);
  assert.equal(new Set(seen.map((x) => x.product_id)).size, 500);
  assert.deepEqual(
    seen.map((x) => x.index),
    Array.from({ length: 500 }, (_, i) => i),
  );
  const e = await execute(v);
  assert.equal(e.execution.total, 500);
  assert.equal(e.execution.changed, 500);
  cursor = null;
  seen = [];
  do {
    const page = await ok(
      '/executions/' + e.execution.id + '/rows' + (cursor ? '?cursor=' + cursor : ''),
    );
    seen.push(...page.data);
    cursor = page.meta.cursor;
  } while (cursor);
  assert.equal(seen.length, 500);
  assert.ok(seen.every((x) => x.after_version === 2));
  await tenantTx(tenant, async (c) => {
    const runs = (
      await c.query("SELECT * FROM product_rule_runs WHERE origin='catalog' ORDER BY id")
    ).rows;
    assert.equal(runs.length, 5);
    assert.ok(runs.every((x) => x.state === 'queued'));
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM jobs WHERE kind='product.rules' AND state='pending'",
        )
      ).rows[0].n,
      5,
    );
    assert.equal((await c.query('SELECT count(*)::int n FROM product_rule_causes')).rows[0].n, 500);
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM product_rule_items WHERE source->>'category'='Arkusz500'",
        )
      ).rows[0].n,
      500,
    );
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM products WHERE version=2 AND category='Arkusz500'",
        )
      ).rows[0].n,
      500,
    );
  });
});
test('canonical key reorder retries stored receipts before changed versions; array changes conflict', async () => {
  const [p] = await products();
  const input = {
    client_key: randomUUID(),
    rows: [
      {
        product_id: p.id,
        version: 1,
        changes: {
          attributes: { b: '2', a: '1' },
          images: ['https://example.test/a', 'https://example.test/b'],
        },
      },
    ],
  };
  const v = (await ok('/previews', 'POST', input, cookie, 201)).preview;
  const reordered = {
    rows: [
      {
        changes: { images: input.rows[0].changes.images, attributes: { a: '1', b: '2' } },
        version: 1,
        product_id: p.id,
      },
    ],
    client_key: input.client_key,
  };
  assert.equal((await ok('/previews', 'POST', reordered)).reused, true);
  assert.equal(
    (
      await req('/previews', 'POST', {
        ...input,
        rows: [
          {
            ...input.rows[0],
            changes: {
              ...input.rows[0].changes,
              images: [...input.rows[0].changes.images].reverse(),
            },
          },
        ],
      })
    ).statusCode,
    409,
  );
  const b = consent(v),
    e = await execute(v, b),
    after = await state([p.id]);
  const replay = await ok('/previews/' + v.id + '/execute', 'POST', {
    confirmed: true,
    scope_hash: b.scope_hash,
    client_key: b.client_key,
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.execution.id, e.execution.id);
  assert.deepEqual(await state([p.id]), after);
  assert.equal(
    (await req('/previews/' + v.id + '/execute', 'POST', { ...b, scope_hash: '0'.repeat(64) }))
      .statusCode,
    409,
  );
});
test('microsecond history keyset returns every own immutable head exactly once across timestamp ties', async () => {
  const [p] = await products();
  const v = await preview([p]),
    e = (await execute(v)).execution;
  await tenantTx(tenant, async (c) => {
    for (let i = 0; i < 22; i++) {
      const pid = randomUUID(),
        eid = randomUUID();
      await c.query(
        `INSERT INTO catalog_bulk_edit_previews SELECT $1,tenant_id,actor_id,$2,request_hash,scope_hash,source,rules_snapshot,total,changed,unchanged,invalid,conflicts,ready,'2026-10-05T04:05:06.123456Z'::timestamptz FROM catalog_bulk_edit_previews WHERE id=$3`,
        [pid, randomUUID(), v.id],
      );
      await c.query(
        'INSERT INTO catalog_bulk_edit_rows SELECT tenant_id,$1,index,product_id,resolved_product_id,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors FROM catalog_bulk_edit_rows WHERE preview_id=$2',
        [pid, v.id],
      );
      await c.query(
        `INSERT INTO catalog_bulk_edit_executions SELECT $1,tenant_id,$2,actor_id,$3,request_hash,scope_hash,state,total,changed,unchanged,'2026-10-05T04:05:06.123456Z'::timestamptz FROM catalog_bulk_edit_executions WHERE id=$4`,
        [eid, pid, randomUUID(), e.id],
      );
      await c.query(
        'INSERT INTO catalog_bulk_edit_execution_rows SELECT tenant_id,$1,$2,index,product_id,sku,status,before_version,after_version,changed_fields FROM catalog_bulk_edit_execution_rows WHERE execution_id=$3',
        [eid, pid, e.id],
      );
    }
  });
  const expected = await tenantTx(tenant, async (c) =>
    (
      await c.query('SELECT id FROM catalog_bulk_edit_executions ORDER BY created_at DESC,id DESC')
    ).rows.map((x) => x.id),
  );
  let cursor: string | null = null,
    ids: string[] = [];
  do {
    const page = await ok('/executions' + (cursor ? '?cursor=' + cursor : ''));
    assert.ok(page.data.length <= 20);
    ids.push(...page.data.map((x: any) => x.id));
    cursor = page.meta.cursor;
  } while (cursor);
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, 23);
  assert.equal((await req('/executions?cursor=bad')).statusCode, 422);
});
test('hard immutable quotas block new proofs/effects but preserve exact preview and execution replay', async () => {
  const [p] = await products();
  const input = body([p]),
    v = (await ok('/previews', 'POST', input, cookie, 201)).preview;
  const b = consent(v),
    e = (await execute(v, b)).execution;
  const fresh = await preview([p]);
  await tenantTx(tenant, async (c) => {
    const ids = Array.from({ length: 1998 }, () => ({
      preview: randomUUID(),
      execution: randomUUID(),
      preview_key: randomUUID(),
      execution_key: randomUUID(),
    }));
    await c.query(
      `INSERT INTO catalog_bulk_edit_previews SELECT x.preview,p.tenant_id,p.actor_id,x.preview_key,p.request_hash,p.scope_hash,p.source,p.rules_snapshot,p.total,p.changed,p.unchanged,p.invalid,p.conflicts,p.ready,p.created_at FROM catalog_bulk_edit_previews p CROSS JOIN jsonb_to_recordset($2::jsonb) x(preview uuid,execution uuid,preview_key uuid,execution_key uuid) WHERE p.id=$1`,
      [v.id, JSON.stringify(ids)],
    );
    await c.query(
      `INSERT INTO catalog_bulk_edit_executions SELECT x.execution,e.tenant_id,x.preview,e.actor_id,x.execution_key,e.request_hash,e.scope_hash,e.state,e.total,e.changed,e.unchanged,e.created_at FROM catalog_bulk_edit_executions e CROSS JOIN jsonb_to_recordset($2::jsonb) x(preview uuid,execution uuid,preview_key uuid,execution_key uuid) WHERE e.id=$1`,
      [e.id, JSON.stringify(ids)],
    );
    // One further immutable execution uses the existing unused preview; no catalogue effect.
    await c.query(
      `INSERT INTO catalog_bulk_edit_executions SELECT $1,tenant_id,$2,actor_id,$3,request_hash,scope_hash,state,total,changed,unchanged,created_at FROM catalog_bulk_edit_executions WHERE id=$4`,
      [randomUUID(), fresh.id, randomUUID(), e.id],
    );
  });
  assert.equal((await req('/previews', 'POST', body([p]))).statusCode, 409);
  assert.equal((await ok('/previews', 'POST', input)).reused, true);
  assert.equal((await ok('/previews/' + v.id + '/execute', 'POST', b)).reused, true);
  const before = await state([p.id]);
  // Capacity is tested using a distinct unexecuted proof inserted as fixture.
  const pid = randomUUID();
  await tenantTx(tenant, (c) =>
    c.query(
      'INSERT INTO catalog_bulk_edit_previews SELECT $1,tenant_id,actor_id,$2,request_hash,scope_hash,source,rules_snapshot,total,changed,unchanged,invalid,conflicts,ready,created_at FROM catalog_bulk_edit_previews WHERE id=$3',
      [pid, randomUUID(), v.id],
    ),
  );
  const rejected = await req('/previews/' + pid + '/execute', 'POST', consent({ ...v, id: pid }));
  assert.equal(rejected.statusCode, 409);
  assert.match(rejected.body, /Limit 2000 wykonań/);
  assert.deepEqual(await state([p.id]), before);
});
