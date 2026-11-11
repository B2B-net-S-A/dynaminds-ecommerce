import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { encrypt } from '../server/security';
import { odooFixture, odooSettings, odooCredentials } from './odoo-fixtures';
import { demoOdooImage } from '../server/odoo-image-demo';
import { processOdooCatalogSync } from '../server/odoo-catalog-sync';
import { processCatalogSource } from '../server/catalog-source';
import { processProductRuleJob } from '../server/product-rules';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(
  new URL(process.env.DATABASE_URL!).pathname,
  /^\/dynaminds_(?:product_rules_)?test_\w+$/,
);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  user: string,
  tenant: string,
  warehouse: string;
let erp = odooFixture(1);
const ownedTenants: string[] = [];
const woo = [
  {
    id: 301,
    type: 'simple',
    sku: 'SOURCE-WOO',
    name: 'Produkt źródłowy',
    status: 'publish',
    regular_price: '12.34',
    tax_status: 'taxable',
    tax_class: '',
    manage_stock: true,
    stock_quantity: 12,
    attributes: [],
    images: [],
  },
];
const transport: typeof erp.transport = async (url, init) => {
  const u = new URL(url);
  if (u.hostname === 'erp.odoo.com') return erp.transport(url, init);
  assert.equal(u.hostname, 'shop.example', 'Only controlled fixtures may be contacted');
  assert.equal(init.method ?? 'GET', 'GET', 'Catalogue fixture permits reads only');
  if (u.pathname.includes('/settings/general/'))
    return new Response(JSON.stringify({ value: 'PLN' }));
  if (u.pathname.includes('/settings/tax/')) return new Response(JSON.stringify({ value: 'yes' }));
  assert(u.pathname.endsWith('/products'));
  const page = Number(u.searchParams.get('page') ?? 1);
  return new Response(JSON.stringify(page === 1 ? woo : []));
};
const req = (url: string, method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  tenant = randomUUID();
  warehouse = randomUUID();
  ownedTenants.push(tenant);
  erp = odooFixture(1);
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Product rule sources QA','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Source QA','SOURCE')",
    [warehouse, tenant],
  );
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200, switched.body);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
});
after(async () => {
  for (const r of (
    await pool.query('SELECT image_id FROM odoo_image_imports WHERE tenant_id=ANY($1::uuid[])', [
      ownedTenants,
    ])
  ).rows)
    await unlink('data/product-images/' + r.image_id).catch(() => {});
  await app.close();
  await pool.end();
});
const create = (sku = 'SOURCE-ODOO') =>
  ok('/products', 'POST', {
    sku,
    name: 'Produkt źródłowy',
    price: 9999,
    vat: 23,
    quantity: 12,
    warehouse_id: warehouse,
    images: ['https://example.test/original.png'],
  });
const rule = (event = 'product.updated') =>
  ok('/product-rules', 'POST', {
    client_key: randomUUID(),
    confirm_future_changes: true,
    definition: {
      name: 'Źródła',
      event,
      enabled: true,
      conditions: [{ field: 'sku', op: 'prefix', value: 'SOURCE-' }],
      actions: [{ type: 'set_category', category: 'Automatycznie' }],
    },
  });
async function channel(provider: 'odoo' | 'woocommerce', product?: any) {
  const id = randomUUID();
  await tenantTx(tenant, async (c) => {
    await c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,'Source QA','sandbox',$4,$5)",
      [
        id,
        tenant,
        provider,
        encrypt(
          provider === 'odoo'
            ? odooCredentials
            : { consumer_key: 'fixture', consumer_secret: 'fixture' },
        ),
        JSON.stringify(
          provider === 'odoo'
            ? odooSettings
            : { store_url: 'https://shop.example', simulation: false },
        ),
      ],
    );
    if (product)
      await c.query(
        "INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,parent_external_id,price,status) VALUES($1,$2,$3,$4,'101','template:10',9999,'linked')",
        [randomUUID(), tenant, id, product.id],
      );
  });
  return id;
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function runs() {
  return (
    await pool.query('SELECT * FROM product_rule_runs WHERE tenant_id=$1 ORDER BY created_at,id', [
      tenant,
    ])
  ).rows;
}
async function applyRuleExactlyOnce() {
  const records = await runs();
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'queued');
  const job = await claim(records[0].job_id);
  const result = await processProductRuleJob(job);
  assert.equal(result.changed, 1);
  assert.deepEqual(await processProductRuleJob(job), { processed: false });
  assert.equal((await runs()).length, 1);
  assert.equal((await runs())[0].state, 'done');
}
async function sync(ch: string, key = randomUUID()) {
  const run = await ok(`/integrations/${ch}/odoo-catalog-sync`, 'POST', {
    version: 1,
    client_key: key,
  });
  const job = await claim(run.job_id);
  await processOdooCatalogSync(job, { transport });
  const stored = (await pool.query('SELECT * FROM odoo_catalog_sync_runs WHERE id=$1', [run.id]))
    .rows[0];
  assert.equal(stored.state, 'success');
  return { run, job };
}
test('Odoo price delta emits once; replay, identical price and availability/physical stock changes emit nothing', async () => {
  const p = await create(),
    ch = await channel('odoo', p);
  await rule();
  const before = await ok('/products/' + p.id);
  await ok(`/integrations/${ch}/odoo-catalog-sync`, 'PUT', {
    version: 0,
    enabled: true,
    prices: true,
    interval_minutes: 60,
    confirmed: true,
  });
  const key = randomUUID(),
    first = await sync(ch, key);
  const changed = await ok('/products/' + p.id);
  assert.equal(changed.price, 4305);
  assert.equal(changed.version, before.version + 1);
  assert.deepEqual(changed.stock, before.stock);
  assert.equal((await runs()).length, 1);
  const frozen = (
    await pool.query('SELECT source_version,source FROM product_rule_items WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows[0];
  assert.equal(frozen.source_version, changed.version);
  assert.equal(frozen.source.sku, changed.sku);
  const replay = await ok(`/integrations/${ch}/odoo-catalog-sync`, 'POST', {
    version: 1,
    client_key: key,
  });
  assert.equal(replay.id, first.run.id);
  assert.equal(replay.replayed, true);
  await processOdooCatalogSync(first.job, { transport });
  assert.equal((await runs()).length, 1);
  await applyRuleExactlyOnce();
  const applied = await ok('/products/' + p.id);
  assert.equal(applied.category, 'Automatycznie');
  assert.equal(applied.price, 4305);
  assert.deepEqual(applied.stock, before.stock);
  await sync(ch);
  assert.equal((await runs()).length, 1);
  assert.equal((await ok('/products/' + p.id)).version, applied.version);
  await ok(`/integrations/${ch}/odoo-catalog-sync`, 'PUT', {
    version: 1,
    enabled: true,
    prices: false,
    interval_minutes: 60,
    confirmed: false,
  });
  erp.rows[0].free_qty = 41;
  const availability = await ok(`/integrations/${ch}/odoo-catalog-sync`, 'POST', {
    version: 2,
    client_key: randomUUID(),
  });
  await processOdooCatalogSync(await claim(availability.job_id), { transport });
  assert.equal(
    (await pool.query('SELECT last_result FROM listings WHERE channel_id=$1', [ch])).rows[0]
      .last_result.odoo_catalog_sync.availability,
    41,
  );
  assert.equal((await runs()).length, 1);
  const observed = await ok('/products/' + p.id);
  assert.equal(observed.version, applied.version);
  assert.deepEqual(observed.stock, before.stock);
  await ok('/inventory/adjust', 'POST', {
    warehouse_id: warehouse,
    product_id: p.id,
    delta: 2,
    note: 'Controlled stock-only source',
  });
  const stockOnly = await ok('/products/' + p.id);
  assert.equal(stockOnly.stock[0].on_hand, 14);
  assert.equal(stockOnly.version, applied.version);
  assert.equal((await runs()).length, 1);
  assert(erp.calls.every((c) => c.method === 'read'));
});
test('Odoo gallery append emits once and both applied-preview replay and a fresh duplicate image emit nothing', async () => {
  const p = await create(),
    ch = await channel('odoo', p);
  await rule();
  (erp.rows[0] as any).image_1920 = demoOdooImage().toString('base64');
  const before = await ok('/products/' + p.id),
    body = { channel_id: ch, version: p.version, client_key: randomUUID() };
  const preview = await ok(`/products/${p.id}/odoo-images/preview`, 'POST', body);
  assert.equal((await runs()).length, 0);
  await ok(`/odoo-image-imports/${preview.id}/apply`, 'POST', { confirm: true });
  const appended = await ok('/products/' + p.id);
  assert.deepEqual(appended.images, [...before.images, preview.url]);
  assert.equal(appended.version, before.version + 1);
  assert.equal((await runs()).length, 1);
  assert.equal(
    (await ok(`/odoo-image-imports/${preview.id}/apply`, 'POST', { confirm: true })).reused,
    true,
  );
  assert.equal((await runs()).length, 1);
  await applyRuleExactlyOnce();
  const applied = await ok('/products/' + p.id);
  assert.equal(applied.category, 'Automatycznie');
  assert.equal(applied.price, before.price);
  assert.deepEqual(applied.stock, before.stock);
  const duplicate = await ok(`/products/${p.id}/odoo-images/preview`, 'POST', {
    ...body,
    version: applied.version,
    client_key: randomUUID(),
  });
  assert.equal(
    (await ok(`/odoo-image-imports/${duplicate.id}/apply`, 'POST', { confirm: true })).duplicate,
    true,
  );
  assert.deepEqual(await ok('/products/' + p.id), applied);
  assert.equal((await runs()).length, 1);
});
test('catalogue-source explicit create freezes final imported product and replay/link-existing do not emit again', async () => {
  await rule('product.created');
  const ch = await channel('woocommerce');
  async function capture() {
    let run = await ok(`/integrations/${ch}/catalog-source-runs`, 'POST', {
      client_key: randomUUID(),
      warehouse_id: warehouse,
      vat: 23,
      import_stock: true,
    });
    for (let i = 0; i < 5 && run.state === 'queued'; i++) {
      await processCatalogSource(await claim(run.job_id), { transport });
      run = (await pool.query('SELECT * FROM catalog_source_runs WHERE id=$1', [run.id])).rows[0];
    }
    assert.equal(run.state, 'ready');
    const row = (await ok('/catalog-source-runs/' + run.id)).data[0];
    return {
      run,
      body: {
        items: [
          {
            id: row.id,
            source_hash: row.source_hash,
            expected_product_id: row.candidate_id ?? null,
            expected_version: row.candidate_version ?? null,
          },
        ],
      },
    };
  }
  const captured = await capture();
  assert.equal((await runs()).length, 0);
  const out = await ok(`/catalog-source-runs/${captured.run.id}/apply`, 'POST', captured.body);
  assert.equal(out.created, 1);
  const imported = await ok('/products/' + out.data[0].product_id);
  assert.equal(imported.price, 1234);
  assert.equal(imported.stock[0].on_hand, 12);
  assert.equal(imported.version, 1);
  const frozen = (
    await pool.query('SELECT source_version,source FROM product_rule_items WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows[0];
  assert.equal(frozen.source_version, imported.version);
  assert.equal(frozen.source.sku, imported.sku);
  assert.equal(frozen.source.name, imported.name);
  const replay = await ok(`/catalog-source-runs/${captured.run.id}/apply`, 'POST', captured.body);
  assert.equal(replay.created, 0);
  assert.equal(replay.data[0].reused, true);
  assert.equal((await runs()).length, 1);
  await applyRuleExactlyOnce();
  const applied = await ok('/products/' + imported.id);
  assert.equal(applied.version, 2);
  assert.equal(applied.category, 'Automatycznie');
  assert.equal(applied.price, imported.price);
  assert.deepEqual(applied.stock, imported.stock);
  const second = await capture();
  const linked = await ok(`/catalog-source-runs/${second.run.id}/apply`, 'POST', second.body);
  assert.equal(linked.created, 0);
  assert.equal(linked.data[0].product_id, imported.id);
  assert.equal((await runs()).length, 1);
  assert.deepEqual(await ok('/products/' + imported.id), applied);
});
