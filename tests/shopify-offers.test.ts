import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processOfferJob, failOffer } from '../server/offers';
import { processOfferSync, failOfferSync } from '../server/offer-sync';
import { Shopify, SHOPIFY_VERSION, demoShopifyPublication } from '../server/shopify';
import { shopifyDesiredPrice, readShopifyOffer } from '../server/shopify-offers';
import { Problem } from '../server/errors';
import type { IntegrationContext } from '../server/channel-access';
assert.equal(process.env.DYNA_TEST, 'true');
const location = 'gid://shopify/Location/1',
  settings = { store_url: 'https://offers-qa.myshopify.com' },
  credentials = { access_token: 'shpat_' + 'a'.repeat(32) };
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string;
let seq = 800000,
  lost = '',
  reject = '',
  included = true,
  currency = 'PLN',
  otherShop = false;
let afterWrite: (() => Promise<void>) | undefined, beforeWrite: (() => Promise<void>) | undefined;
const variants = new Map<string, any>(),
  calls: any[] = [];
const response = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
  });
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const b = JSON.parse(String(init.body)),
      name = b.query.match(/^(?:query|mutation) (\w+)/)[1],
      x = b.variables;
    calls.push({ name, variables: x, query: b.query });
    assert.equal(url, settings.store_url + '/admin/api/' + SHOPIFY_VERSION + '/graphql.json');
    assert.equal(new Headers(init.headers).get('X-Shopify-Access-Token'), credentials.access_token);
    const shop = {
      myshopifyDomain: otherShop ? 'other.myshopify.com' : 'offers-qa.myshopify.com',
      taxesIncluded: included,
      currencyCode: currency,
    };
    const loc = { id: location, name: 'QA online', isActive: true, fulfillsOnlineOrders: true };
    if (name === 'DynaLocations')
      return response({
        data: {
          shop,
          locations: { nodes: [loc], pageInfo: { hasNextPage: false, endCursor: 'loc:1' } },
        },
      });
    if (name === 'DynaLocation') return response({ data: { shop, location: loc } });
    if (name === 'DynaPublications')
      return response({
        data: {
          shop,
          publications: {
            nodes: [demoShopifyPublication],
            pageInfo: { hasNextPage: false, endCursor: 'pub:1' },
          },
        },
      });
    if (name === 'DynaPublicationOffer') {
      const v = structuredClone(variants.get(x.id));
      return response({
        data: {
          shop,
          publication: x.publication === demoShopifyPublication.id ? demoShopifyPublication : null,
          productVariant: v
            ? {
                id: v.id,
                sku: v.sku,
                product: {
                  ...v.product,
                  title: v.product.title ?? 'Produkt QA publikacja',
                  requiresSellingPlan: v.product.requiresSellingPlan ?? false,
                  variantsCount: v.product.variantsCount ?? {
                    count: [...variants.values()].filter((n) => n.product.id === v.product.id)
                      .length,
                    precision: 'EXACT',
                  },
                  publishedOnPublication: v.product.publishedOnPublication ?? false,
                },
              }
            : null,
        },
      });
    }
    if (name === 'DynaProductActivate' || name === 'DynaProductPublish') {
      await beforeWrite?.();
      beforeWrite = undefined;
      if (reject === name) return response({ error: 'NEVER_EXPOSE' }, 503);
      const id = name === 'DynaProductActivate' ? x.product.id : x.id;
      const siblings = [...variants.values()].filter((v) => v.product.id === id);
      assert(siblings.length);
      let result: any;
      if (name === 'DynaProductActivate') {
        assert.deepEqual(x, { product: { id, status: 'ACTIVE' } });
        siblings.forEach((v) => (v.product.status = 'ACTIVE'));
        result = { productUpdate: { product: { id, status: 'ACTIVE' }, userErrors: [] } };
      } else {
        assert.deepEqual(x, {
          id,
          publication: demoShopifyPublication.id,
          input: [{ publicationId: demoShopifyPublication.id }],
        });
        siblings.forEach((v) => (v.product.publishedOnPublication = true));
        result = {
          publishablePublish: {
            shop,
            publishable: { id, publishedOnPublication: true },
            userErrors: [],
          },
        };
      }
      const hook = afterWrite;
      afterWrite = undefined;
      await hook?.();
      if (lost === name) {
        lost = '';
        throw new Problem(502, 'Utracona odpowiedź fixture');
      }
      return response({ data: result });
    }
    if (name === 'DynaOffer') {
      const v = structuredClone(variants.get(x.id));
      if (v && !x.stock) delete v.inventoryItem;
      if (v && !x.price) {
        delete v.price;
        delete v.compareAtPrice;
        delete v.taxable;
      }
      return response({ data: { shop, productVariant: v ?? null } });
    }
    assert(['DynaOfferPrice', 'DynaOfferStock'].includes(name));
    await beforeWrite?.();
    beforeWrite = undefined;
    if (reject === name) return response({ error: 'NEVER_EXPOSE' }, 503);
    let result: any;
    if (name === 'DynaOfferPrice') {
      assert.equal(x.variants.length, 1);
      assert.deepEqual(Object.keys(x.variants[0]).sort(), ['id', 'price']);
      assert(b.query.includes('allowPartialUpdates:false'));
      const v = variants.get(x.variants[0].id);
      assert(v);
      assert.equal(x.product, v.product.id);
      v.price = x.variants[0].price;
      result = {
        productVariantsBulkUpdate: {
          product: { id: x.product },
          productVariants: [{ id: v.id, price: v.price }],
          userErrors: [],
        },
      };
    } else {
      const q = x.input.quantities[0];
      assert.equal(x.input.quantities.length, 1);
      assert.equal(x.input.ignoreCompareQuantity, false);
      assert.equal(x.input.name, 'available');
      assert(b.query.includes('@idempotent(key:$key)'));
      assert.equal(x.input.referenceDocumentUri, 'dynaminds://offer-plan/' + x.key);
      const v = [...variants.values()].find((v) => v.inventoryItem.id === q.inventoryItemId);
      assert(v);
      assert.equal(q.locationId, location);
      const current = v.inventoryItem.inventoryLevel.quantities[0];
      if (q.compareQuantity !== current.quantity)
        return response({
          data: {
            inventorySetQuantities: {
              inventoryAdjustmentGroup: null,
              userErrors: [{ message: 'NEVER_EXPOSE_CAS' }],
            },
          },
        });
      const delta = q.quantity - current.quantity;
      current.quantity = q.quantity;
      result = {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: {
            referenceDocumentUri: x.input.referenceDocumentUri,
            changes: [{ name: 'available', delta }],
          },
          userErrors: [],
        },
      };
    }
    const hook = afterWrite;
    afterWrite = undefined;
    await hook?.();
    if (lost === name) {
      lost = '';
      throw new Problem(502, 'Utracona odpowiedź fixture');
    }
    return response({ data: result });
  },
};
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie: auth, ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  for (const [email, set] of [
    ['admin@demo.local', (v: string) => (cookie = v)],
    ['viewer@demo.local', (v: string) => (viewer = v)],
    ['other@demo.local', (v: string) => (other = v)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  variants.clear();
  calls.length = 0;
  lost = reject = '';
  included = true;
  currency = 'PLN';
  otherShop = false;
  afterWrite = beforeWrite = undefined;
});
async function fixture(simulation = false, channel?: string) {
  const ch = channel ?? randomUUID();
  if (!channel)
    await tenantTx(DEMO_TENANT, (c) =>
      c.query(
        "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'shopify','Shopify oferty QA','sandbox',$3,$4)",
        [
          ch,
          DEMO_TENANT,
          encrypt(credentials),
          JSON.stringify({ ...settings, simulation, inventory_location_id: location }),
        ],
      ),
    );
  const p = await ok('/products', 'POST', {
    sku: 'SH-OFFER-' + seq++,
    name: 'Wariant Shopify QA',
    quantity: 10,
    price: 12300,
    vat: 23,
    warehouse_id: warehouse,
  });
  const id = 'gid://shopify/ProductVariant/' + seq++,
    product = 'gid://shopify/Product/' + seq++,
    item = 'gid://shopify/InventoryItem/' + seq++;
  const v: any = {
    id,
    sku: p.sku,
    price: '10.00',
    compareAtPrice: '200.00',
    taxable: true,
    requiresComponents: false,
    inventoryPolicy: 'CONTINUE',
    product: { id: product, status: 'ACTIVE' },
    inventoryItem: {
      id: item,
      tracked: true,
      requiresShipping: true,
      inventoryLevel: {
        id:
          'gid://shopify/InventoryLevel/' + seq++ + '?inventory_item_id=' + item.split('/').at(-1),
        isActive: true,
        item: { id: item },
        location: { id: location, isActive: true, fulfillsOnlineOrders: true },
        quantities: [{ name: 'available', quantity: 2 }],
      },
    },
  };
  variants.set(id, v);
  const l = await ok('/integrations/' + ch + '/mappings', 'POST', { external_id: id, sku: p.sku });
  return { ch, p, l, v, id };
}
async function preview(f: any, extra: any = {}, auth = cookie) {
  return req(
    '/integrations/' + f.ch + '/offers/preview',
    'POST',
    {
      product_id: f.p.id,
      listing_id: f.l.id,
      warehouse_id: warehouse,
      operation: 'sync',
      ...extra,
    },
    auth,
  );
}
async function plan(f: any, extra: any = {}) {
  const r = await preview(f, extra);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const getPlan = (d: any) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM offer_plans WHERE id=$1', [d.id])).rows[0],
  );
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function queue(d: any) {
  return ok('/offer-plans/' + d.id + '/queue', 'POST', { confirm_live: true });
}
async function execute(d: any) {
  const p = await getPlan(d),
    job = await claim(p.job_id);
  try {
    await processOfferJob(job, ctx);
  } catch (e) {
    await failOffer(job, e);
  }
  return getPlan(d);
}
const writes = () => calls.filter((c) => c.name.startsWith('DynaOffer') && c.name !== 'DynaOffer');
async function reserve(f: any, quantity: number) {
  return ok('/orders', 'POST', {
    customer_name: 'QA Shopify rezerwacja',
    email: 'shopify@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL' },
    items: [{ product_id: f.p.id, quantity }],
  });
}
async function configure(f: any, extra: any = {}) {
  return ok('/integrations/' + f.ch + '/offer-sync', 'PATCH', {
    version: 0,
    enabled: true,
    warehouse_id: warehouse,
    price_list_id: null,
    stock: true,
    price: true,
    interval_seconds: 30,
    verify_seconds: 60,
    confirm_external: true,
    ...extra,
  });
}
async function cycle(f: any) {
  const d = await ok('/integrations/' + f.ch + '/offer-sync', 'POST', {}),
    job = await claim(d.id);
  try {
    await processOfferSync(job, ctx);
  } catch (e) {
    await failOfferSync(job, e);
  }
  return (await pool.query('SELECT * FROM jobs WHERE id=$1', [d.id])).rows[0];
}

test('Shopify offers: minimal price plus CAS available stock, preserves compare-at and inventory policy', async () => {
  const f = await fixture();
  await reserve(f, 3);
  const d = await plan(f);
  assert.deepEqual(d.payload, { regular_price: '123.00', stock_quantity: 7 });
  await queue(d);
  const r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert.deepEqual(r.result.shopify_steps, { price: 'verified', stock: 'verified' });
  assert.equal(f.v.compareAtPrice, '200.00');
  assert.equal(f.v.inventoryPolicy, 'CONTINUE');
  assert.equal(f.v.inventoryItem.inventoryLevel.quantities[0].quantity, 7);
  assert.equal(writes()[1].variables.input.quantities[0].compareQuantity, 2);
  assert.equal(writes()[1].variables.key, d.id);
});
test('Shopify offers: tax-exclusive catalog converts gross cents precisely', async () => {
  included = false;
  const f = await fixture();
  const d = await plan(f);
  assert.equal(d.payload.regular_price, '100.00');
  assert.equal(d.price_basis, 'net');
});
test('Shopify offers: lost price response resumes with read and untouched stock only', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  lost = 'DynaOfferPrice';
  let r = await execute(d);
  assert.equal(r.state, 'queued', r.error);
  assert.equal(r.result.shopify_steps.price, 'started');
  r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert.equal(writes().filter((c) => c.name === 'DynaOfferPrice').length, 1);
  assert.equal(writes().length, 2);
});
test('Shopify offers: lost stock response reconciles using reads without repeating either mutation', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  lost = 'DynaOfferStock';
  assert.equal((await execute(d)).state, 'queued');
  const n = writes().length;
  assert.equal((await execute(d)).state, 'done');
  assert.equal(writes().length, n);
});
test('Shopify offers: rejected uncertain mutation is never automatically repeated', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  reject = 'DynaOfferPrice';
  assert.equal((await execute(d)).state, 'queued');
  assert.equal(writes().length, 1);
  const r = await execute(d);
  assert.equal(r.state, 'failed', r.error);
  assert.equal(writes().length, 1);
  assert(!r.error.includes('NEVER_EXPOSE'));
  await ok('/offer-plans/' + d.id + '/reconcile', 'POST', { accept_observed: true });
  const done = await execute(d);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, false);
  assert.equal(writes().length, 1);
});
test('Shopify offers: concurrent available change fails CAS instead of overwriting it', async () => {
  const f = await fixture(),
    d = await plan(f, { price: false });
  await queue(d);
  beforeWrite = async () => {
    f.v.inventoryItem.inventoryLevel.quantities[0].quantity = 5;
  };
  const r = await execute(d);
  assert.equal(r.state, 'queued');
  assert.equal(f.v.inventoryItem.inventoryLevel.quantities[0].quantity, 5);
  assert.equal(writes().length, 1);
  assert.equal((await execute(d)).state, 'failed');
  assert.equal(writes().length, 1);
});
test('Shopify offers: changed SKU, compare-at or inventory identity invalidates frozen preview without write', async () => {
  for (const change of [
    (v: any) => (v.sku = 'OTHER'),
    (v: any) => (v.compareAtPrice = '300.00'),
    (v: any) => (v.inventoryItem.id = 'gid://shopify/InventoryItem/999'),
  ]) {
    const f = await fixture(),
      d = await plan(f);
    await queue(d);
    change(f.v);
    const n = writes().length;
    assert.notEqual((await execute(d)).state, 'done');
    assert.equal(writes().length, n);
  }
});
test('Shopify offers: price-only needs neither location nor inventory access; preserves cached quantity', async () => {
  const f = await fixture();
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query("UPDATE channels SET settings=settings-'inventory_location_id' WHERE id=$1", [
      f.ch,
    ]);
    await c.query('UPDATE listings SET last_result=$2 WHERE id=$1', [
      f.l.id,
      { stock_quantity: 42 },
    ]);
  });
  f.v.inventoryItem = null;
  const d = await plan(f, { stock: false });
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.equal(writes().length, 1);
  const cache = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query('SELECT last_result FROM listings WHERE id=$1', [f.l.id])).rows[0].last_result,
  );
  assert.equal(cache.stock_quantity, 42);
});
test('Shopify offers: stock-only ignores foreign currency and untargeted price change', async () => {
  const f = await fixture();
  currency = 'EUR';
  const d = await plan(f, { price: false });
  await queue(d);
  f.v.price = '11.00';
  assert.equal((await execute(d)).state, 'done');
  assert.equal(writes()[0].name, 'DynaOfferStock');
  assert.equal(f.v.price, '11.00');
});
test('Shopify offers: stock requires explicit active location and tracked physical variant', async () => {
  for (const change of [
    (v: any) => (v.inventoryItem.tracked = false),
    (v: any) => (v.requiresComponents = true),
    (v: any) => (v.inventoryItem.requiresShipping = false),
    (v: any) => (v.inventoryItem.inventoryLevel.location.isActive = false),
    (v: any) => (v.inventoryItem.inventoryLevel.location.id = 'gid://shopify/Location/2'),
  ]) {
    const f = await fixture();
    change(f.v);
    assert((await preview(f)).statusCode >= 400);
  }
  const f = await fixture();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE channels SET settings=settings-'inventory_location_id' WHERE id=$1", [f.ch]),
  );
  assert.equal((await preview(f)).statusCode, 422);
  assert.equal(writes().length, 0);
});
test('Shopify offers: wrong shop, currency or SKU and inconsistent tax are rejected', async () => {
  const f = await fixture();
  otherShop = true;
  assert.equal((await preview(f)).statusCode, 502);
  otherShop = false;
  currency = 'EUR';
  assert.equal((await preview(f)).statusCode, 422);
  currency = 'PLN';
  f.v.sku = 'OTHER';
  assert.equal((await preview(f)).statusCode, 409);
  f.v.sku = f.p.sku;
  f.v.taxable = false;
  assert.equal((await preview(f)).statusCode, 422);
});
test('Shopify offers: local change between price and stock prevents stale available write', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  afterWrite = async () => {
    await reserve(f, 3);
  };
  const r = await execute(d);
  assert.equal(r.state, 'failed', r.error);
  assert.equal(writes().length, 1);
  assert.equal(f.v.inventoryItem.inventoryLevel.quantities[0].quantity, 2);
});
test('Shopify offers: lease lost after first step stops subsequent network operations', async () => {
  const f = await fixture(),
    d = await plan(f);
  const q = await queue(d);
  afterWrite = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [q.job_id, randomUUID()]);
  };
  await execute(d);
  assert.equal(writes().length, 1);
});
test('Shopify offers: rotated credential blocks dispatch before any provider write', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
      f.ch,
      encrypt({ access_token: 'b'.repeat(32) }),
    ]),
  );
  const r = await execute(d);
  assert.notEqual(r.state, 'done');
  assert.equal(writes().length, 0);
});
test('Shopify offers: provider mutations have one HTTP attempt on throttling and sanitized GraphQL errors', async () => {
  for (const type of ['http', 'graphql']) {
    let n = 0;
    const client = new Shopify(
      settings,
      credentials,
      async () => {
        n++;
        return type === 'http'
          ? response({}, 429)
          : response({ errors: [{ message: 'NEVER_EXPOSE', extensions: { code: 'THROTTLED' } }] });
      },
      async () => {
        throw new Error('Must not sleep');
      },
    );
    await assert.rejects(
      client.setVariantPrice('gid://shopify/Product/1', 'gid://shopify/ProductVariant/1', '1.00'),
      (e: any) => !e.message.includes('NEVER_EXPOSE'),
    );
    assert.equal(n, 1);
  }
});
test('Shopify offers: incomplete quantity or wrong linked inventory item cannot establish stock scope', async () => {
  const f = await fixture(),
    client = new Shopify(settings, credentials, ctx.transport!);
  f.v.inventoryItem.inventoryLevel.quantities.push({ name: 'available', quantity: 3 });
  await assert.rejects(readShopifyOffer(client, f.id, true, true, location));
  f.v.inventoryItem.inventoryLevel.quantities.pop();
  f.v.inventoryItem.inventoryLevel.item.id = 'gid://shopify/InventoryItem/1';
  await assert.rejects(readShopifyOffer(client, f.id, true, true, location));
});
test('Shopify offers: location discovery and optimistic save respect RLS, role and paused schedules', async () => {
  const f = await fixture();
  const path = '/integrations/' + f.ch;
  assert.equal((await req(path + '/shopify-locations', 'GET', undefined, viewer)).statusCode, 403);
  assert.equal((await req(path + '/shopify-locations', 'GET', undefined, other)).statusCode, 404);
  assert.equal((await ok(path + '/shopify-locations')).data[0].id, location);
  assert.equal(
    (
      await req(path + '/shopify-location', 'PATCH', {
        location_id: location,
        expected_location_id: null,
      })
    ).statusCode,
    409,
  );
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE channels SET settings=settings-'inventory_location_id' WHERE id=$1", [f.ch]),
  );
  await configure(f, { stock: false });
  assert.equal(
    (
      await req(path + '/shopify-location', 'PATCH', {
        location_id: location,
        expected_location_id: null,
      })
    ).statusCode,
    409,
  );
  await configure(f, { version: 1, enabled: false, stock: false });
  assert.equal(
    (
      await ok(path + '/shopify-location', 'PATCH', {
        location_id: location,
        expected_location_id: null,
      })
    ).scope,
    'local_configuration',
  );
});
test('Shopify offers: uncertain jobs block location changes even when schedule is disabled', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE channels SET settings=settings-'inventory_location_id' WHERE id=$1", [f.ch]),
  );
  assert.equal(
    (
      await req('/integrations/' + f.ch + '/shopify-location', 'PATCH', {
        location_id: location,
        expected_location_id: null,
      })
    ).statusCode,
    409,
  );
});
test('Shopify offers: sandbox still requires external authorization; non-admin and foreign tenant cannot preview', async () => {
  const f = await fixture(),
    d = await plan(f);
  assert.equal(
    (await req('/offer-plans/' + d.id + '/queue', 'POST', { confirm_live: false })).statusCode,
    422,
  );
  assert.equal((await preview(f, {}, viewer)).statusCode, 403);
  assert.equal((await preview(f, {}, other)).statusCode, 404);
  assert.equal((await preview(f, { operation: 'publish' })).statusCode, 422);
});
test('Shopify offers: simulation uses no HTTP, configured location and durable price/stock cache', async () => {
  const f = await fixture(true),
    d = await plan(f);
  await queue(d);
  const r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert.equal(r.result.scope, 'local_simulation');
  assert.equal(calls.length, 0);
  const next = await plan(f);
  assert.equal(next.before.regular_price, '123.00');
  assert.equal(next.before.stock_quantity, 10);
});
test('Shopify offers: automatic schedule writes then recognizes verified unchanged offer', async () => {
  const f = await fixture();
  await configure(f);
  assert.equal((await cycle(f)).state, 'done');
  let plans = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query("SELECT id FROM offer_plans WHERE channel_id=$1 AND state='queued'", [f.ch]))
        .rows,
  );
  assert.equal(plans.length, 1);
  assert.equal((await execute(plans[0])).state, 'done');
  const n = writes().length;
  assert.equal((await cycle(f)).state, 'done');
  assert.equal(writes().length, n);
  const data = await ok('/integrations/' + f.ch + '/offer-sync');
  assert.equal(data.data[0].state, 'verified');
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "UPDATE offer_sync_items SET last_checked_at=now()-interval '2 minutes' WHERE channel_id=$1",
      [f.ch],
    ),
  );
  assert.equal((await cycle(f)).state, 'done');
  assert.equal((await ok('/integrations/' + f.ch + '/offer-sync')).data[0].state, 'unchanged');
  assert.equal(writes().length, n);
});
test('Shopify offers: pause between steps stops stock mutation, then reconciles by read', async () => {
  const f = await fixture(),
    cfg = await configure(f);
  await cycle(f);
  const d = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query("SELECT id FROM offer_plans WHERE channel_id=$1 AND state='queued'", [f.ch]))
        .rows[0],
  );
  afterWrite = async () => {
    await configure(f, { version: cfg.version, enabled: false });
  };
  assert.equal((await execute(d)).state, 'failed');
  assert.equal(writes().length, 1);
  await ok('/offer-plans/' + d.id + '/reconcile', 'POST', { accept_observed: true });
  const r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert.equal(r.result.desired_applied, false);
  assert.equal(writes().length, 1);
});
test('Shopify offers: 27 listings traverse two bounded automatic batches', async () => {
  const f = await fixture();
  for (let i = 1; i < 27; i++) await fixture(false, f.ch);
  await configure(f);
  const first = await cycle(f);
  assert.equal(first.state, 'pending', first.error);
  const job = await claim(first.id);
  await processOfferSync(job, ctx);
  const count = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query('SELECT count(*)::int AS n FROM offer_sync_items WHERE channel_id=$1', [f.ch]))
        .rows[0].n,
  );
  assert.equal(count, 27);
});
test('Shopify offers: integer price rounding, zero and range validation', () => {
  assert.equal(shopifyDesiredPrice(12300, 23, false), '100.00');
  assert.equal(shopifyDesiredPrice(999, 8, false), '9.25');
  assert.equal(shopifyDesiredPrice(1, 23, false), '0.01');
  assert.equal(shopifyDesiredPrice(0, 23, false), '0.00');
  assert.equal(shopifyDesiredPrice(12300, 23, true), '123.00');
  assert.throws(() => shopifyDesiredPrice(-1, 23, true));
});

const publishing = {
  operation: 'publish',
  publication_id: demoShopifyPublication.id,
  stock: false,
  price: false,
};
const publicationWrites = () =>
  calls.filter((c) => c.name === 'DynaProductActivate' || c.name === 'DynaProductPublish');
test('Shopify publish: admin/RLS publication discovery reads without mutations', async () => {
  const f = await fixture();
  const page = await ok('/integrations/' + f.ch + '/shopify-publications');
  assert.equal(page.data[0].catalog.title, demoShopifyPublication.catalog.title);
  assert.equal(page.scope, 'external_read');
  assert.equal(
    (await req('/integrations/' + f.ch + '/shopify-publications', 'GET', undefined, viewer))
      .statusCode,
    403,
  );
  assert.equal(
    (await req('/integrations/' + f.ch + '/shopify-publications', 'GET', undefined, other))
      .statusCode,
    404,
  );
  assert.equal(publicationWrites().length, 0);
});
test('Shopify publish: explicit publication required and forbidden in sync', async () => {
  const f = await fixture();
  assert.equal(
    (await preview(f, { operation: 'publish', price: false, stock: false })).statusCode,
    422,
  );
  assert.equal((await preview(f, { publication_id: demoShopifyPublication.id })).statusCode, 422);
  assert.equal(
    (await preview(f, { ...publishing, publication_id: 'gid://shopify/Publication/2' })).statusCode,
    422,
  );
  assert.equal(publicationWrites().length, 0);
});
test('Shopify publish: draft activation and one explicit publication, no price/stock/location requirement', async () => {
  const f = await fixture();
  f.v.product.status = 'DRAFT';
  f.v.inventoryItem = null;
  currency = 'EUR';
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE channels SET settings=settings-'inventory_location_id' WHERE id=$1", [f.ch]),
  );
  const d = await plan(f, publishing);
  assert.equal(d.before.status, 'DRAFT');
  assert.equal(d.before.variants_count, 1);
  assert.deepEqual(d.payload, {
    product_status: 'ACTIVE',
    publication_id: demoShopifyPublication.id,
    published: true,
  });
  assert.equal(
    (await req('/offer-plans/' + d.id + '/queue', 'POST', { confirm_live: false })).statusCode,
    422,
  );
  await queue(d);
  const done = await execute(d);
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(
    publicationWrites().map((c) => c.name),
    ['DynaProductActivate', 'DynaProductPublish'],
  );
  assert.equal(writes().length, 0);
  assert.equal(done.result.desired_applied, true);
});
for (const step of ['DynaProductActivate', 'DynaProductPublish'])
  test(
    'Shopify publish: lost response ' + step + ' recovered by read without repeating mutation',
    async () => {
      const f = await fixture();
      f.v.product.status = 'DRAFT';
      const d = await plan(f, publishing);
      await queue(d);
      lost = step;
      const first = await execute(d);
      assert.equal(first.state, 'queued', first.error);
      const done = await execute(d);
      assert.equal(done.state, 'done', done.error);
      assert.equal(publicationWrites().filter((c) => c.name === step).length, 1);
      assert.deepEqual(done.result.shopify_steps, {
        activation: 'verified',
        publication: 'verified',
      });
    },
  );
for (const step of ['DynaProductActivate', 'DynaProductPublish'])
  test('Shopify publish: uncertain rejected ' + step + ' is observed, never repeated', async () => {
    const f = await fixture();
    f.v.product.status = 'DRAFT';
    const d = await plan(f, publishing);
    await queue(d);
    reject = step;
    assert.equal((await execute(d)).state, 'queued');
    assert.equal((await execute(d)).state, 'failed');
    const n = publicationWrites().length;
    await ok('/offer-plans/' + d.id + '/reconcile', 'POST', { accept_observed: true });
    const done = await execute(d);
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.result.desired_applied, false);
    assert.equal(publicationWrites().length, n);
    assert.equal(done.result.scope, 'external_api_observed');
  });
test('Shopify publish: already published active product requires no mutation', async () => {
  const f = await fixture();
  f.v.product.publishedOnPublication = true;
  const d = await plan(f, publishing);
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.equal(publicationWrites().length, 0);
});
test('Shopify publish: UNLISTED status preserved, publication verified separately', async () => {
  const f = await fixture();
  f.v.product.status = 'UNLISTED';
  const d = await plan(f, publishing);
  assert.equal(d.payload.product_status, 'UNLISTED');
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.deepEqual(
    publicationWrites().map((c) => c.name),
    ['DynaProductPublish'],
  );
});
test('Shopify publish: selected variant price and stock precede whole-product activation/publication', async () => {
  const f = await fixture();
  f.v.product.status = 'ARCHIVED';
  const d = await plan(f, { ...publishing, price: true, stock: true });
  await queue(d);
  const done = await execute(d);
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(
    calls.filter((c) => c.query.startsWith('mutation')).map((c) => c.name),
    ['DynaOfferPrice', 'DynaOfferStock', 'DynaProductActivate', 'DynaProductPublish'],
  );
});
test('Shopify publish: changed scope/title/count/status before execution prevents mutation', async () => {
  for (const change of [
    (v: any) => (v.product.status = 'ARCHIVED'),
    (v: any) => (v.product.title = 'Changed'),
    (v: any) => (v.product.variantsCount = { count: 7, precision: 'EXACT' }),
    (v: any) => (v.product.requiresSellingPlan = true),
  ]) {
    const f = await fixture();
    const d = await plan(f, publishing);
    await queue(d);
    change(f.v);
    const n = publicationWrites().length;
    assert.notEqual((await execute(d)).state, 'done');
    assert.equal(publicationWrites().length, n);
  }
});
test('Shopify publish: lease loss after activation stops publication and subsequent reads', async () => {
  const f = await fixture();
  f.v.product.status = 'DRAFT';
  const d = await plan(f, publishing);
  const q = await queue(d);
  afterWrite = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [q.job_id, randomUUID()]);
  };
  await execute(d);
  assert.deepEqual(
    publicationWrites().map((c) => c.name),
    ['DynaProductActivate'],
  );
});
test('Shopify publish: provider partial errors, wrong product and wrong shop cannot confirm mutation', async () => {
  for (const kind of ['errors', 'wrong-product', 'wrong-shop', 'userErrors']) {
    let n = 0;
    const c = new Shopify(settings, credentials, async () => {
      n++;
      return response({
        ...(kind === 'errors'
          ? { errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }
          : {}),
        data: {
          publishablePublish: {
            shop: {
              myshopifyDomain:
                kind === 'wrong-shop' ? 'other.myshopify.com' : 'offers-qa.myshopify.com',
            },
            publishable: {
              id: 'gid://shopify/Product/' + (kind === 'wrong-product' ? '3' : '2'),
              publishedOnPublication: true,
            },
            userErrors: kind === 'userErrors' ? [{ message: 'SECRET_ERROR' }] : [],
          },
        },
      });
    });
    await assert.rejects(() =>
      c.publishProduct('gid://shopify/Product/2', demoShopifyPublication.id),
    );
    assert.equal(n, 1);
  }
});
test('Shopify publish: list paginates 25 with bounded cursor and validates publication metadata', async () => {
  const c = new Shopify(settings, credentials, async (_u, init) => {
    const x = JSON.parse(String(init.body));
    assert.equal(x.variables.after, 'next');
    assert(x.query.includes('first:25'));
    return response({
      data: {
        shop: { myshopifyDomain: 'offers-qa.myshopify.com' },
        publications: {
          nodes: [demoShopifyPublication],
          pageInfo: { hasNextPage: true, endCursor: 'next2' },
        },
      },
    });
  });
  assert.equal((await c.publications('next')).next_cursor, 'next2');
  await assert.rejects(() => c.publications('x'.repeat(2049)));
});
test('Shopify publish: whole-product scope and simulated publication propagate to sibling mappings', async () => {
  const a = await fixture(true),
    b = await fixture(true, a.ch);
  for (const f of [a, b])
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE listings SET last_result=$2 WHERE id=$1', [
        f.l.id,
        {
          product_id: a.v.product.id,
          status: 'DRAFT',
          sku: f.p.sku,
          stock_quantity: 5,
          regular_price: '10.00',
        },
      ]),
    );
  const d = await plan(a, publishing);
  assert.equal(d.before.variants_count, 2);
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  const next = await plan(b, publishing);
  assert.equal(next.before.published, true);
  assert.equal(next.before.status, 'ACTIVE');
  assert.equal(next.before.variants_count, 2);
  assert.equal(next.before.capture_stock, false);
  assert.equal(next.before.capture_price, false);
  assert.equal(calls.length, 0);
});

test('Shopify publish: two concurrent sibling plans serialize by remote Product, stale second cannot publish', async () => {
  const a = await fixture(),
    b = await fixture(false, a.ch);
  b.v.product.id = a.v.product.id;
  a.v.product.status = b.v.product.status = 'DRAFT';
  const da = await plan(a, publishing),
    db = await plan(b, publishing);
  await queue(da);
  await queue(db);
  const results = await Promise.all([execute(da), execute(db)]);
  assert.equal(results.filter((p) => p.state === 'done').length, 1);
  assert.equal(results.filter((p) => p.state === 'conflict').length, 1);
  assert.deepEqual(
    publicationWrites().map((c) => c.name),
    ['DynaProductActivate', 'DynaProductPublish'],
  );
});
test('Shopify publish: token change after activation fences publication', async () => {
  const f = await fixture();
  f.v.product.status = 'DRAFT';
  const d = await plan(f, publishing);
  await queue(d);
  afterWrite = async () => {
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        f.ch,
        encrypt({ access_token: 'b'.repeat(32) }),
      ]),
    );
  };
  const r = await execute(d);
  assert.notEqual(r.state, 'done');
  assert.deepEqual(
    publicationWrites().map((c) => c.name),
    ['DynaProductActivate'],
  );
});

test('Shopify publish: uncertain whole-product write blocks a newly queued sibling plan', async () => {
  const a = await fixture(),
    b = await fixture(false, a.ch);
  b.v.product.id = a.v.product.id;
  a.v.product.status = b.v.product.status = 'DRAFT';
  const d = await plan(a, publishing);
  await queue(d);
  lost = 'DynaProductActivate';
  assert.equal((await execute(d)).state, 'queued');
  const sibling = await plan(b, { price: true, stock: false });
  const blocked = await req('/offer-plans/' + sibling.id + '/queue', 'POST', {
    confirm_live: true,
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert(blocked.json().detail.includes('niepewny'));
  assert.equal((await execute(d)).state, 'done');
  await queue(sibling);
  assert.equal((await execute(sibling)).state, 'done');
  assert.equal(publicationWrites().length, 2);
});
test('Shopify publish: uncertain parent fences a sibling queued before the lost response without HTTP', async () => {
  const a = await fixture(),
    b = await fixture(false, a.ch);
  b.v.product.id = a.v.product.id;
  a.v.product.status = b.v.product.status = 'DRAFT';
  const da = await plan(a, publishing),
    db = await plan(b, publishing);
  await queue(da);
  await queue(db);
  lost = 'DynaProductActivate';
  assert.equal((await execute(da)).state, 'queued');
  const n = calls.length;
  const r = await execute(db);
  assert.equal(r.state, 'conflict', r.error);
  assert.equal(calls.length, n);
  assert.equal((await execute(da)).state, 'done');
  assert.equal(publicationWrites().length, 2);
});
