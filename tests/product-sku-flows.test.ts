import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processCatalogSource } from '../server/catalog-source';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_\w*test_\w+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  warehouse = '';
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie } });
async function ok(path: string, method: any = 'GET', body?: unknown) {
  const r = await req(path, method, body);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw new Error('Unexpected provider HTTP from a local API operation');
    },
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200, r.body);
  cookie = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
const code = () => 'SKU106-' + randomUUID().slice(0, 8);
async function product(extra: any = {}) {
  return ok('/products', 'POST', {
    sku: code(),
    name: 'Produkt SKU106',
    price: 1000,
    quantity: 20,
    warehouse_id: warehouse,
    location: 'A2',
    ...extra,
  });
}
async function rename(p: any, sku: string) {
  const current = await ok('/products/' + p.id);
  return ok('/products/' + p.id, 'PATCH', { ...current, sku });
}
async function csv(text: string) {
  return ok('/catalog/imports/preview', 'POST', { warehouse_id: warehouse, csv: text });
}
async function order(items: any[]) {
  return ok('/orders', 'POST', {
    customer_name: 'QA SKU106',
    email: 'sku106@example.test',
    warehouse_id: warehouse,
    payment_mode: 'cod',
    items,
  });
}
async function business(p: any) {
  return tenantTx(DEMO_TENANT, async (c) => ({
    stock: (await c.query('SELECT * FROM stock WHERE product_id=$1 ORDER BY warehouse_id', [p.id]))
      .rows,
    movements: (
      await c.query('SELECT * FROM stock_movements WHERE product_id=$1 ORDER BY id', [p.id])
    ).rows,
    listings: (await c.query('SELECT * FROM listings WHERE product_id=$1 ORDER BY id', [p.id]))
      .rows,
  }));
}

test('CSV historic SKU resolves the original UUID, preserves the current code and all stock instead of creating a duplicate', async () => {
  const p = await product(),
    current = await rename(p, code()),
    before = await business(p);
  const productCount = (
    await pool.query('SELECT count(*)::int n FROM products WHERE tenant_id=$1', [DEMO_TENANT])
  ).rows[0].n;
  const preview = await csv(`sku;name;price\n${p.sku};Nazwa z wcześniejszego pliku;12.34`);
  assert.equal(preview.valid, true);
  assert.equal(preview.rows[0].operation, 'update');
  assert.equal(preview.rows[0].current_sku, current.sku);
  assert.equal(preview.rows[0].matched_historical_sku, true);
  const out = await ok('/catalog/imports/' + preview.id + '/apply', 'POST', {});
  assert.equal(out.created, 0);
  assert.equal(out.updated, 1);
  const saved = await ok('/products/' + p.id);
  assert.equal(saved.sku, current.sku);
  assert.equal(saved.name, 'Nazwa z wcześniejszego pliku');
  assert.equal(saved.price, 1234);
  assert.equal(saved.version, current.version + 1);
  assert.deepEqual(await business(p), before);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM products WHERE tenant_id=$1', [DEMO_TENANT]))
      .rows[0].n,
    productCount,
  );
  const replay = await ok('/catalog/imports/' + preview.id + '/apply', 'POST', {});
  assert.equal(replay.reused, true);
  assert.equal((await ok('/products/' + p.id)).version, saved.version);
});

test('CSV refuses two current/historic aliases for one UUID and refuses repeated physical bundle components through aliases', async () => {
  const p = await product(),
    current = await rename(p, code());
  const duplicate = await csv(
    `sku;name;price\n${p.sku};Pierwszy wiersz;10.00\n${current.sku};Drugi wiersz;20.00`,
  );
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.id, null);
  assert(duplicate.errors.some((e: any) => e.message.includes('ten sam produkt')));
  const recipe = JSON.stringify([
    { sku: p.sku, quantity: 1 },
    { sku: current.sku, quantity: 2 },
  ]);
  const escaped = '"' + recipe.replaceAll('"', '""') + '"';
  const bundle = await csv(
    `sku;name;price;kind;components\n${code()};Powtórzony skład;25.00;bundle;${escaped}`,
  );
  assert.equal(bundle.valid, false);
  assert(bundle.errors.some((e: any) => e.message.includes('składnik')));
});

test('CSV updates a persisted legacy long SKU without revalidating or rewriting its identity', async () => {
  const id = randomUUID(),
    sku = '😀'.repeat(41);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,$4,1000)', [
      id,
      DEMO_TENANT,
      sku,
      'Legacy import',
    ]),
  );
  const preview = await csv(`sku;name;price\n${sku};Legacy po imporcie;12.34`);
  assert.equal(preview.valid, true, JSON.stringify(preview.errors));
  const applied = await ok('/catalog/imports/' + preview.id + '/apply', 'POST', {});
  assert.equal(applied.created, 0);
  assert.equal(applied.updated, 1);
  const saved = await ok('/products/' + id);
  assert.equal(saved.sku, sku);
  assert.equal(saved.price, 1234);
  assert.equal(saved.name, 'Legacy po imporcie');
  assert.equal(saved.version, 2);
});

test('a CSV preview frozen before rename cannot apply after the product version changed through its retained alias', async () => {
  const p = await product(),
    preview = await csv(`sku;name;price\n${p.sku};Przed zmianą kodu;11.00`);
  assert.equal(preview.valid, true);
  const renamed = await rename(p, code()),
    before = await business(p);
  const r = await req('/catalog/imports/' + preview.id + '/apply', 'POST', {});
  assert.equal(r.statusCode, 409, r.body);
  const current = await ok('/products/' + p.id);
  assert.equal(current.sku, renamed.sku);
  assert.equal(current.version, renamed.version);
  assert.equal(current.name, p.name);
  assert.deepEqual(await business(p), before);
});

test('CSV resolves renamed parent and physical component codes to stable IDs without renaming them back', async () => {
  const group = await product({ kind: 'group', quantity: 0 }),
    variant = await product({ kind: 'variant', parent_id: group.id }),
    physical = await product();
  const currentGroup = await rename(group, code()),
    currentPhysical = await rename(physical, code());
  const updated = await csv(
    `sku;name;price;kind;parent_sku\n${variant.sku};Wariant po zmianie rodzica;12.00;variant;${group.sku}`,
  );
  assert.equal(updated.valid, true, JSON.stringify(updated.errors));
  await ok('/catalog/imports/' + updated.id + '/apply', 'POST', {});
  assert.equal((await ok('/products/' + variant.id)).parent_id, group.id);
  const recipe = JSON.stringify([{ sku: physical.sku, quantity: 2 }]);
  const escaped = '"' + recipe.replaceAll('"', '""') + '"';
  const bundleSku = code();
  const kit = await csv(
    `sku;name;price;kind;components\n${bundleSku};Zestaw ze starym kodem;25.00;bundle;${escaped}`,
  );
  assert.equal(kit.valid, true, JSON.stringify(kit.errors));
  await ok('/catalog/imports/' + kit.id + '/apply', 'POST', {});
  const saved = (await ok('/products?search=' + bundleSku)).data.find(
    (p: any) => p.sku === bundleSku,
  );
  const detail = await ok('/products/' + saved.id);
  assert.deepEqual(
    detail.components.map((p: any) => [p.product_id, p.quantity]),
    [[physical.id, 2]],
  );
  assert.equal((await ok('/products/' + group.id)).sku, currentGroup.sku);
  assert.equal((await ok('/products/' + physical.id)).sku, currentPhysical.sku);
});

test('ordinary picking accepts frozen, intermediate and current SKU after rename, preserves sale snapshots and completes local fulfillment', async () => {
  const p = await product(),
    o = await order([{ product_id: p.id, quantity: 3 }]);
  const beforeItems = o.items,
    middle = await rename(p, code()),
    current = await rename(p, code());
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  for (const sku of [p.sku, middle.sku, current.sku])
    await ok('/orders/' + o.id + '/scan', 'POST', { code: sku, location: 'A2' });
  const picked = await ok('/orders/' + o.id);
  assert.equal(picked.picking_items[0].sku, p.sku);
  assert.equal(picked.picking_items[0].scanned, 3);
  assert.deepEqual(
    picked.items.map((x: any) => [x.id, x.sku, x.quantity, x.price, x.components]),
    beforeItems.map((x: any) => [x.id, x.sku, x.quantity, x.price, x.components]),
  );
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  const shipped = await ok('/orders/' + o.id + '/ship-demo', 'POST', {});
  assert.equal(shipped.status, 'shipped');
  assert.equal((await ok('/products/' + p.id)).stock[0].on_hand, 17);
});

test('wave scans accept an intermediate retained SKU and current SKU against the same frozen product ID', async () => {
  const p = await product(),
    a = await order([{ product_id: p.id, quantity: 1 }]),
    b = await order([{ product_id: p.id, quantity: 1 }]);
  const input = { warehouse_id: warehouse, order_ids: [a.id, b.id] },
    preview = await ok('/picking-waves/preview', 'POST', input);
  let w = await ok('/picking-waves', 'POST', {
    ...input,
    name: 'SKU106 partia',
    client_key: randomUUID(),
    preview_hash: preview.preview_hash,
  });
  const middle = await rename(p, code()),
    current = await rename(p, code());
  for (const sku of [middle.sku, current.sku])
    w = await ok('/picking-waves/' + w.wave.id + '/scans', 'POST', {
      version: w.wave.version,
      client_key: randomUUID(),
      code: sku,
      location: 'A2',
    });
  assert.equal(w.progress.scanned, 2);
  assert.equal((await ok('/orders/' + a.id)).picking_items[0].sku, p.sku);
  assert.equal((await ok('/orders/' + b.id)).picking_items[0].sku, p.sku);
});

test('a SKU/EAN collision between physical products is rejected without counting a scan in both ordinary and wave modes', async () => {
  const p = await product(),
    collision = code(),
    other = await product({ ean: collision });
  const o = await order([
    { product_id: p.id, quantity: 1 },
    { product_id: other.id, quantity: 1 },
  ]);
  await rename(p, collision);
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  assert.equal(
    (await req('/orders/' + o.id + '/scan', 'POST', { code: collision, location: 'A2' }))
      .statusCode,
    422,
  );
  assert((await ok('/orders/' + o.id)).picking_items.every((x: any) => x.scanned === 0));
  const input = { warehouse_id: warehouse, order_ids: [o.id] },
    preview = await ok('/picking-waves/preview', 'POST', input);
  const w = await ok('/picking-waves', 'POST', {
    ...input,
    name: 'SKU106 kolizja',
    client_key: randomUUID(),
    preview_hash: preview.preview_hash,
  });
  assert.equal(
    (
      await req('/picking-waves/' + w.wave.id + '/scans', 'POST', {
        version: w.wave.version,
        client_key: randomUUID(),
        code: collision,
        location: 'A2',
      })
    ).statusCode,
    422,
  );
  assert.equal((await ok('/picking-waves/' + w.wave.id)).progress.scanned, 0);
});

test('an unambiguous current SKU works in a wave when its frozen old SKU collides with another item EAN', async () => {
  const p = await product(),
    other = await product({ ean: p.sku });
  const o = await order([
    { product_id: p.id, quantity: 1 },
    { product_id: other.id, quantity: 1 },
  ]);
  const current = await rename(p, code());
  const input = { warehouse_id: warehouse, order_ids: [o.id] };
  const preview = await ok('/picking-waves/preview', 'POST', input);
  const w = await ok('/picking-waves', 'POST', {
    ...input,
    name: 'SKU106 aktualny kod',
    client_key: randomUUID(),
    preview_hash: preview.preview_hash,
  });
  const result = await ok('/picking-waves/' + w.wave.id + '/scans', 'POST', {
    version: w.wave.version,
    client_key: randomUUID(),
    code: current.sku,
    location: 'A2',
  });
  assert.equal(result.scan.product_id, p.id);
  const items = (await ok('/orders/' + o.id)).picking_items;
  assert.equal(items.find((i: any) => i.product_id === p.id).scanned, 1);
  assert.equal(items.find((i: any) => i.product_id === other.id).scanned, 0);
  assert.equal(items.find((i: any) => i.product_id === p.id).sku, p.sku);
});

test('marketplace candidate lookup, staged linking and manual mappings resolve a retained local SKU without changing remote identity or sending writes', async () => {
  const p = await product(),
    current = await rename(p, code()),
    before = await business(p),
    ch = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','SKU106 controlled transport','sandbox',$3,$4)",
      [
        ch,
        DEMO_TENANT,
        encrypt({ consumer_key: 'fixture', consumer_secret: 'fixture' }),
        JSON.stringify({ store_url: 'https://shop.example', simulation: false }),
      ],
    ),
  );
  const run = await ok('/integrations/' + ch + '/catalog-source-runs', 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    vat: 23,
    import_stock: false,
  });
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [run.job_id, randomUUID()],
    )
  ).rows[0];
  const calls: string[] = [];
  await processCatalogSource(job, {
    transport: async (url, init) => {
      const u = new URL(url);
      assert.equal(init.method ?? 'GET', 'GET');
      calls.push(u.pathname);
      const body = u.pathname.includes('/settings/general/')
        ? { value: 'PLN' }
        : u.pathname.includes('/settings/tax/')
          ? { value: 'yes' }
          : [
              {
                id: 991,
                name: 'SKU106 feed',
                type: 'simple',
                sku: p.sku,
                regular_price: '10.00',
                price: '10.00',
                stock_quantity: 20,
                manage_stock: true,
                status: 'publish',
                description: '',
                attributes: [],
                images: [],
              },
            ];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  const staged = await ok('/catalog-source-runs/' + run.id),
    row = staged.data[0];
  assert.equal(staged.run.state, 'ready');
  assert.equal(row.candidate_id, p.id);
  assert.equal(row.candidate_sku, current.sku);
  const candidate = await ok(
    '/catalog-source-runs/' + run.id + '/candidate?sku=' + encodeURIComponent(p.sku),
  );
  assert.equal(candidate.product.id, p.id);
  assert.equal(candidate.product.sku, current.sku);
  const applied = await ok('/catalog-source-runs/' + run.id + '/apply', 'POST', {
    items: [
      {
        id: row.id,
        source_hash: row.source_hash,
        expected_product_id: p.id,
        expected_version: current.version,
      },
    ],
  });
  assert.equal(applied.linked, 1);
  assert.equal(applied.created, 0);
  assert(calls.length > 0);
  assert.equal((await ok('/products/' + p.id)).sku, current.sku);
  assert.equal((await ok('/products/' + p.id)).version, current.version);
  const after = await business(p);
  assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.movements, before.movements);
  assert.equal(after.listings[0].external_id, '991');
  assert.equal(after.listings[0].product_id, p.id);
  const mapped = await ok('/integrations/' + ch + '/mappings', 'POST', {
    external_id: '992',
    sku: p.sku,
  });
  assert.equal(mapped.mapping?.product_id ?? mapped.product_id, p.id);
});
