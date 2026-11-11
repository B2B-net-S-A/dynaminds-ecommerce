import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink, readFile, writeFile } from 'node:fs/promises';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { odooFixture, odooSettings, odooCredentials } from './odoo-fixtures';
import { demoOdooImage } from '../server/odoo-image-demo';
import { Odoo } from '../server/odoo';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string,
  f = odooFixture();
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
async function ok(p: string, method: any = 'GET', payload?: any) {
  const r = await req(p, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: (u, i) => f.transport(u, i) });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  for (const r of (await pool.query('SELECT image_id FROM odoo_image_imports')).rows)
    await unlink('data/product-images/' + r.image_id).catch(() => {});
  await app.close();
  await pool.end();
});
beforeEach(() => {
  f = odooFixture();
  (f.rows[0] as any).image_1920 = demoOdooImage().toString('base64');
});
async function fixture(simulation = false) {
  const p = await ok('/products', 'POST', {
    name: 'QA Odoo photo',
    sku: 'PHOTO-' + randomUUID(),
    price: 12345,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 12,
    images: ['https://example.test/original.png'],
  });
  const ch = randomUUID(),
    listing = randomUUID();
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'odoo','QA images','live',$3,$4)",
      [
        ch,
        DEMO_TENANT,
        encrypt(odooCredentials),
        JSON.stringify({ ...odooSettings, ...(simulation ? { simulation: 'true' } : {}) }),
      ],
    );
    await c.query(
      "INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,parent_external_id,price,status) VALUES($1,$2,$3,$4,'101','template:10',12345,'linked')",
      [listing, DEMO_TENANT, ch, p.id],
    );
  });
  return { p, ch, listing, b: { channel_id: ch, version: p.version, client_key: randomUUID() } };
}
const preview = (x: any) => ok(`/products/${x.p.id}/odoo-images/preview`, 'POST', x.b);
const apply = (p: any) => req(`/odoo-image-imports/${p.id}/apply`, 'POST', { confirm: true });
test('provider main image read uses bounded binary JSON-2, fallback field and stable reread', async () => {
  const c = new Odoo(odooSettings, odooCredentials, f.transport);
  let fences = 0;
  const result = await c.primaryImage(101, async () => {
    fences++;
  });
  assert.deepEqual(result.bytes, demoOdooImage());
  assert.equal(result.mime, 'image/png');
  assert.equal(result.template_id, 10);
  assert.equal(fences, 3);
  assert(
    f.calls.every(
      (c) =>
        c.model === 'product.product' && c.method === 'read' && c.args.context.bin_size === false,
    ),
  );
});
test('preview, confirm and replay preserve gallery, price and physical stock', async () => {
  const x = await fixture(),
    before = await ok('/products/' + x.p.id);
  const p = await preview(x);
  assert.equal(p.state, 'preview');
  assert.deepEqual((await ok('/products/' + x.p.id)).images, before.images);
  const bytes = await req('/product-images/' + p.image_id);
  assert.deepEqual(bytes.rawPayload, demoOdooImage());
  const calls = f.calls.length;
  const replay = await preview(x);
  assert.equal(replay.id, p.id);
  assert.equal(f.calls.length, calls);
  let r = await apply(p);
  assert.equal(r.statusCode, 200, r.body);
  r = await apply(p);
  assert.equal(r.json().reused, true);
  const after = await ok('/products/' + x.p.id);
  assert.deepEqual(after.images, [...before.images, p.url]);
  assert.equal(after.price, before.price);
  assert.deepEqual(after.stock, before.stock);
  assert.equal(after.version, before.version + 1);
  const next = await preview({
    ...x,
    b: { ...x.b, version: after.version, client_key: randomUUID() },
  });
  const duplicate = await apply(next);
  assert.equal(duplicate.json().duplicate, true);
  assert.equal((await ok('/products/' + x.p.id)).images.length, 2);
});
test('RLS, current administrator and strict confirmation are enforced for preview and apply', async () => {
  const x = await fixture();
  for (const auth of [viewer, operator])
    assert.equal(
      (await req(`/products/${x.p.id}/odoo-images/preview`, 'POST', x.b, auth)).statusCode,
      403,
    );
  assert.equal(
    (await req(`/products/${x.p.id}/odoo-images`, 'GET', undefined, other)).statusCode,
    404,
  );
  const p = await preview(x);
  assert.equal(
    (await req(`/odoo-image-imports/${p.id}/apply`, 'POST', { confirm: true }, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/odoo-image-imports/${p.id}/apply`, 'POST', { confirm: false })).statusCode,
    422,
  );
  assert.equal(
    (await req('/product-images/' + p.image_id, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/product-images/' + p.image_id, 'GET', undefined, viewer)).statusCode,
    200,
  );
});
test('missing, foreign, invalid and oversized provider images do not create preview files', async () => {
  for (const defect of ['missing', 'foreign', 'svg', 'oversized', 'base64', 'inactive']) {
    const x = await fixture();
    const row: any = f.rows[0];
    const original = { ...row };
    if (defect === 'missing') row.image_1920 = false;
    if (defect === 'foreign') row.company_id = [2, 'Other'];
    if (defect === 'svg') row.image_1920 = Buffer.from('<svg></svg>').toString('base64');
    if (defect === 'oversized') row.image_1920 = Buffer.alloc(524289).toString('base64');
    if (defect === 'base64') row.image_1920 += '\n';
    if (defect === 'inactive') row.active = false;
    const r = await req(`/products/${x.p.id}/odoo-images/preview`, 'POST', x.b);
    assert(r.statusCode >= 400, r.body);
    assert.equal((await ok(`/products/${x.p.id}/odoo-images`)).history.length, 0);
    Object.assign(row, original);
  }
});
test('provider image changing between reads is rejected; shared company and metadata are stable', async () => {
  const x = await fixture();
  f.state.edit = (model, method, rows, args) => {
    if (args.fields.includes('image_1920') && f.calls.length === 2) rows[0].write_date = 'changed';
  };
  assert.equal((await req(`/products/${x.p.id}/odoo-images/preview`, 'POST', x.b)).statusCode, 409);
  assert.equal((await ok(`/products/${x.p.id}/odoo-images`)).history.length, 0);
});
test('changes to product, key, mapping and current role during RPC fence the local capture', async () => {
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  for (const defect of ['product', 'key', 'mapping', 'parent', 'role']) {
    const x = await fixture();
    f.state.hook = async () => {
      if (defect === 'product')
        await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [x.p.id]);
      if (defect === 'key')
        await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
          x.ch,
          encrypt({ ...odooCredentials, api_key: 'another_valid_key_123456' }),
        ]);
      if (defect === 'mapping')
        await pool.query("UPDATE listings SET external_id='102' WHERE id=$1", [x.listing]);
      if (defect === 'parent')
        await pool.query("UPDATE listings SET parent_external_id='template:20' WHERE id=$1", [
          x.listing,
        ]);
      if (defect === 'role')
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          DEMO_TENANT,
          user,
        ]);
    };
    try {
      assert((await req(`/products/${x.p.id}/odoo-images/preview`, 'POST', x.b)).statusCode >= 400);
      assert.equal(
        (await pool.query('SELECT 1 FROM odoo_image_imports WHERE product_id=$1', [x.p.id]))
          .rowCount,
        0,
      );
    } finally {
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
    }
  }
});
test('expired preview, changed gallery, configuration and corrupted local bytes reject apply', async () => {
  for (const defect of ['expired', 'product', 'config', 'file']) {
    const x = await fixture(),
      p = await preview(x);
    if (defect === 'expired')
      await pool.query(
        "UPDATE odoo_image_imports SET expires_at=now()-interval '1 second' WHERE id=$1",
        [p.id],
      );
    if (defect === 'product')
      await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [x.p.id]);
    if (defect === 'config')
      await pool.query(
        'UPDATE channels SET settings=settings||\'{"company_id":"2"}\'::jsonb WHERE id=$1',
        [x.ch],
      );
    if (defect === 'file')
      await writeFile('data/product-images/' + p.image_id, Buffer.from('corrupt'));
    assert((await apply(p)).statusCode >= 400);
    assert.deepEqual((await ok('/products/' + x.p.id)).images, x.p.images);
    if (defect === 'file') await writeFile('data/product-images/' + p.image_id, demoOdooImage());
  }
});
test('concurrent confirmation appends once; full gallery is preserved', async () => {
  const x = await fixture(),
    p = await preview(x);
  const results = await Promise.all([apply(p), apply(p)]);
  results.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal((await ok('/products/' + x.p.id)).images.length, 2);
  const y = await fixture();
  await pool.query('UPDATE products SET images=$2 WHERE id=$1', [
    y.p.id,
    JSON.stringify(Array.from({ length: 10 }, (_, i) => 'https://example.test/' + i + '.png')),
  ]);
  const q = await preview(y);
  assert.equal((await apply(q)).statusCode, 409);
  assert.equal((await ok('/products/' + y.p.id)).images.length, 10);
});
test('simulation makes zero provider calls and public API uses product scopes', async () => {
  const x = await fixture(true),
    p = await preview(x);
  assert.equal(p.mode, 'simulation');
  assert.equal(f.calls.length, 0);
  const key = await ok('/developer/keys', 'POST', {
      name: 'Photos',
      scopes: ['products:read', 'products:write'],
    }),
    headers = { authorization: 'Bearer ' + key.token };
  const r = await app.inject({
    url: '/api/v1/odoo-image-imports/' + p.id + '/apply',
    method: 'POST',
    headers,
    payload: { confirm: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  const image = await app.inject({ url: '/api/v1/product-images/' + p.image_id, headers });
  assert.equal(image.statusCode, 200, image.body);
  assert.deepEqual(image.rawPayload, demoOdooImage());
  const denied = await ok('/developer/keys', 'POST', {
    name: 'No photos',
    scopes: ['orders:read'],
  });
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/product-images/' + p.image_id,
        headers: { authorization: 'Bearer ' + denied.token },
      })
    ).statusCode,
    403,
  );
});

test('preview capacity blocks additional provider reads and shared ERP images remain supported', async () => {
  (f.rows[0] as any).company_id = false;
  const x = await fixture();
  for (let i = 0; i < 10; i++) await preview({ ...x, b: { ...x.b, client_key: randomUUID() } });
  const before = f.calls.length;
  const r = await req(`/products/${x.p.id}/odoo-images/preview`, 'POST', {
    ...x.b,
    client_key: randomUUID(),
  });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(f.calls.length, before);
});
