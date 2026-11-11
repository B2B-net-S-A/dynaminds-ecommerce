import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processCatalogSource, failCatalogSource } from '../server/catalog-source';
import { demoShopifyCatalog, normalizeShopifyCatalog } from '../server/shopify-catalog';
import { SHOPIFY_VERSION } from '../server/shopify';
import type { IntegrationContext } from '../server/channel-access';
assert.equal(process.env.DYNA_TEST, 'true');
const location = 'gid://shopify/Location/1';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string;
let currency = 'PLN',
  included = true,
  badShop = false,
  pageHook: (() => Promise<void>) | undefined;
let responseHook: ((rows: any[], page: number) => void) | undefined;
const rows: any[] = [],
  calls: any[] = [];
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const b = JSON.parse(String(init.body)),
      name = b.query.match(/^query (\w+)/)?.[1],
      x = b.variables;
    assert.equal(
      url,
      'https://catalog-qa.myshopify.com/admin/api/' + SHOPIFY_VERSION + '/graphql.json',
    );
    assert.equal(init.method, 'POST');
    assert(
      name && ['DynaCatalog', 'DynaCatalogSettings'].includes(name),
      'Only fixed read queries',
    );
    calls.push({ name, x, query: b.query });
    const shop = {
      myshopifyDomain: badShop ? 'foreign.myshopify.com' : 'catalog-qa.myshopify.com',
      currencyCode: currency,
      taxesIncluded: included,
    };
    const data: any = { shop };
    if (name === 'DynaCatalog') {
      assert(b.query.includes('sortKey:ID') && b.query.includes('productVariants(first:25'));
      const page = x.after ? Number(x.after.split(':')[1]) : 0;
      const nodes = structuredClone(rows.slice(page * 25, (page + 1) * 25));
      const h = pageHook;
      pageHook = undefined;
      await h?.();
      responseHook?.(nodes, page);
      if (!x.stock) for (const r of nodes) delete r.inventoryItem.inventoryLevel;
      data.productVariants = {
        nodes,
        pageInfo: { hasNextPage: rows.length > (page + 1) * 25, endCursor: 'page:' + (page + 1) },
      };
    }
    return new Response(JSON.stringify({ data }), {
      headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
    });
  },
};
const req = (p: string, method: any = 'GET', b?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload: b, headers: { cookie: auth ?? '' } });
async function ok(p: string, method: any = 'GET', b?: any) {
  const r = await req(p, method, b);
  assert(r.statusCode < 300, r.body);
  if (r.headers['set-cookie']) cookie = r.headers['set-cookie']!.toString().split(';')[0];
  return r.json();
}
async function channel(simulation = false, loc: string | null = location) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'shopify','Shopify Catalog QA','sandbox',$3,$4)",
      [
        id,
        DEMO_TENANT,
        encrypt({ access_token: 'shpat_' + 'a'.repeat(32) }),
        JSON.stringify({
          store_url: 'https://catalog-qa.myshopify.com',
          simulation,
          ...(loc ? { inventory_location_id: loc } : {}),
        }),
      ],
    ),
  );
  return { id };
}
async function start(ch: any, x: any = {}) {
  return ok(`/integrations/${ch.id}/catalog-source-runs`, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    vat: 23,
    import_stock: true,
    ...x,
  });
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function step(r: any) {
  const job = await claim(r.job_id);
  try {
    await processCatalogSource(job, ctx);
  } catch (e) {
    await failCatalogSource(job, e);
  }
  return (await pool.query('SELECT * FROM catalog_source_runs WHERE id=$1', [r.id])).rows[0];
}
async function fetchAll(r: any) {
  for (let i = 0; i < 100; i++) {
    r = await step(r);
    if (r.state !== 'queued') return r;
  }
  throw Error('No completion');
}
const view = (r: any) => ok('/catalog-source-runs/' + r.id + '?limit=100');
const item = (r: any, x: any = {}) => ({
  id: r.id,
  source_hash: r.source_hash,
  expected_product_id: r.candidate_id ?? null,
  expected_version: r.candidate_version ?? null,
  ...x,
});
const apply = (r: any, entries: any[]) =>
  ok(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: entries });
const variant = (id: number, grouped = false) => {
  const r: any = structuredClone(demoShopifyCatalog(location)[grouped ? 1 : 0]);
  r.id = 'gid://shopify/ProductVariant/' + id;
  r.sku = 'CAT-' + randomUUID().slice(0, 12);
  r.inventoryItem.id = 'gid://shopify/InventoryItem/' + id;
  r.inventoryItem.inventoryLevel.item.id = r.inventoryItem.id;
  if (!grouped) r.product.id = 'gid://shopify/Product/' + id;
  return r;
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  for (const [email, set] of [
    ['viewer@demo.local', (s: string) => (viewer = s)],
    ['other@demo.local', (s: string) => (other = s)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  await app.close();
});
after(async () => {
  await pool.end();
});
afterEach(async () => {
  await app.close();
});
beforeEach(async () => {
  app = await buildApp({ integrationTransport: ctx.transport });
  await ok('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
  await ok('/workspaces/switch', 'POST', { tenant_id: DEMO_TENANT });
  warehouse = (await ok('/warehouses')).data[0].id;
  rows.length = 0;
  calls.length = 0;
  currency = 'PLN';
  included = true;
  badShop = false;
  pageHook = undefined;
  responseHook = undefined;
});

test('Shopify preview stages only; apply creates physical stock and mapping once', async () => {
  const ch = await channel(),
    v = variant(101);
  v.barcode = '5901234567890';
  v.product.media.nodes.push({
    __typename: 'MediaImage',
    image: { url: 'https://images.example/a.jpg' },
  });
  rows.push(v);
  const beforeCount = (await pool.query('SELECT count(*) FROM products')).rows[0].count,
    r = await fetchAll(await start(ch));
  assert.equal(r.state, 'ready');
  assert.equal((await pool.query('SELECT count(*) FROM products')).rows[0].count, beforeCount);
  const entry = (await view(r)).data[0];
  assert.equal(entry.source.price, 2000);
  assert.equal(entry.source.quantity, 10);
  assert.equal(entry.source.ean, v.barcode);
  assert.equal(entry.source.images.length, 1);
  const out = await apply(r, [item(entry)]),
    replay = await apply(r, [item(entry)]);
  assert.equal(out.created, 1);
  assert.equal(replay.created, 0);
  assert(replay.data[0].reused);
  const stock = (
    await pool.query('SELECT * FROM stock WHERE product_id=$1', [out.data[0].product_id])
  ).rows[0];
  assert.deepEqual([stock.on_hand, stock.reserved], [10, 0]);
  const listing = (await pool.query('SELECT * FROM listings WHERE id=$1', [out.data[0].listing_id]))
    .rows[0];
  assert.equal(listing.external_id, v.id);
  assert.equal(listing.parent_external_id, null);
});
test('large variant group spans pages without duplicating the group; local variants retain ancestry', async () => {
  const ch = await channel();
  for (let n = 0; n < 30; n++) rows.push(variant(1000 + n, true));
  const r = await fetchAll(await start(ch));
  assert.equal(r.state, 'ready');
  assert.equal(r.cursor.pages, 2);
  assert.equal(r.fetched, 31);
  const entries = (await view(r)).data;
  assert.equal(entries.filter((e: any) => e.kind === 'group').length, 1);
  const out = await apply(
    r,
    entries.map((e: any) => item(e)),
  );
  assert.equal(out.created, 31);
  const group = out.data.find((e: any) => e.kind === 'group');
  assert(
    out.data
      .filter((e: any) => e.kind === 'variant')
      .every((e: any) => e.parent_id === group.product_id),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT id FROM listings WHERE channel_id=$1 AND parent_external_id IS NOT NULL',
        [ch.id],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT * FROM stock WHERE product_id=$1', [group.product_id])).rowCount,
    0,
  );
});
test('changed group metadata on a later page fails the run and rolls back that page', async () => {
  const ch = await channel();
  for (let n = 0; n < 26; n++) rows.push(variant(2000 + n, true));
  const r = await step(await start(ch));
  assert.equal(r.fetched, 26);
  rows[25].product.updatedAt = '2026-10-04T01:00:00Z';
  const failed = await step(r);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.fetched, 26);
  assert.equal(failed.cursor.pages, 1);
  assert.equal(
    (
      await req(`/catalog-source-runs/${r.id}/apply`, 'POST', {
        items: [(await view(r)).data[0]].map(item),
      })
    ).statusCode,
    409,
  );
});
test('repeated or backwards variants cannot advance the checkpoint', async () => {
  const ch = await channel();
  for (let n = 0; n < 26; n++) rows.push(variant(3000 + n));
  const r = await step(await start(ch));
  rows[25].id = rows[0].id;
  const next = await step(r);
  assert.equal(next.cursor.pages, 1);
  assert.equal(next.fetched, 25);
  assert.match(next.error, /postępu|powtórzone/);
});
test('group must be applied before its variant, same batch is ordered atomically', async () => {
  const ch = await channel();
  rows.push(variant(4000, true));
  const r = await fetchAll(await start(ch)),
    entries = (await view(r)).data;
  const v = entries.find((e: any) => e.kind === 'variant');
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [item(v)] })).statusCode,
    422,
  );
  assert.equal(
    (
      await apply(
        r,
        entries.map((e: any) => item(e)),
      )
    ).created,
    2,
  );
});
test('tax excluded uses exact integer rounding; nontaxable variant keeps VAT zero', async () => {
  const ch = await channel();
  included = false;
  const a = variant(5000),
    b = variant(5001);
  a.price = '12.34';
  b.price = '12.34';
  b.taxable = false;
  rows.push(a, b);
  const r = await fetchAll(await start(ch)),
    entries = (await view(r)).data;
  assert.equal(entries.find((e: any) => e.external_id === a.id).source.price, 1518);
  const untaxed = entries.find((e: any) => e.external_id === b.id);
  assert.deepEqual([untaxed.source.price, untaxed.source.vat], [1234, 0]);
});
test('different currency requires explicit local price; provider price remains in provider currency', async () => {
  const ch = await channel();
  currency = 'EUR';
  rows.push(variant(6000));
  const r = await fetchAll(await start(ch)),
    entry = (await view(r)).data[0];
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [item(entry)] })).statusCode,
    422,
  );
  const out = await apply(r, [item(entry, { price_override: 8700 })]);
  assert.equal(out.data[0].local_price, 8700);
  const listing = (await pool.query('SELECT * FROM listings WHERE id=$1', [out.data[0].listing_id]))
    .rows[0];
  assert.equal(listing.price_currency, 'EUR');
  assert.equal(listing.price, 2000);
});
test('missing SKU gets a deterministic suggestion; media and selected options preserve safe values', async () => {
  const ch = await channel(),
    v = variant(7000, true);
  v.sku = '';
  v.product.description = 'X'.repeat(10001);
  v.media.nodes.push({
    __typename: 'MediaImage',
    image: { url: 'https://images.example/variant.jpg' },
  });
  v.product.media.nodes.push(
    { __typename: 'Video' },
    { __typename: 'MediaImage', image: { url: 'http://bad.example/a.jpg' } },
  );
  rows.push(v);
  const r = await fetchAll(await start(ch)),
    entry = (await view(r)).data.find((e: any) => e.kind === 'variant');
  assert(entry.source.sku.endsWith('-7000'));
  assert.equal(entry.source.description.length, 10000);
  assert.equal(entry.source.attributes.Kolor, 'Niebieski');
  assert.deepEqual(entry.source.images, ['https://images.example/variant.jpg']);
  assert(entry.issues.length >= 3);
});
test('digital, gift cards and component bundles are staged with blockers and cannot become physical products', async () => {
  const ch = await channel(),
    a = variant(8000),
    b = variant(8001),
    c = variant(8002);
  a.inventoryItem.requiresShipping = false;
  b.product.isGiftCard = true;
  c.requiresComponents = true;
  rows.push(a, b, c);
  const r = await fetchAll(await start(ch));
  for (const e of (await view(r)).data) {
    assert(e.source.unsupported);
    assert.equal(
      (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [item(e)] })).statusCode,
      422,
    );
  }
});
test('initial stock needs explicit Shopify location; no-stock import works without location', async () => {
  const ch = await channel(false, null);
  rows.push(variant(9000));
  assert.equal(
    (
      await req(`/integrations/${ch.id}/catalog-source-runs`, 'POST', {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        import_stock: true,
      })
    ).statusCode,
    422,
  );
  const r = await fetchAll(await start(ch, { import_stock: false })),
    entry = (await view(r)).data[0];
  assert.equal(entry.source.quantity, null);
  assert.equal(calls.find((c) => c.name === 'DynaCatalog').x.stock, false);
  const out = await apply(r, [item(entry)]);
  assert.equal(
    (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [out.data[0].product_id]))
      .rows[0].on_hand,
    0,
  );
});
test('unknown negative or untracked stock requires override, never silently becomes zero', async () => {
  const ch = await channel(),
    v = variant(10000);
  v.inventoryItem.inventoryLevel.quantities[0].quantity = -1;
  rows.push(v);
  const r = await fetchAll(await start(ch)),
    entry = (await view(r)).data[0];
  assert.equal(entry.source.quantity, null);
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [item(entry)] })).statusCode,
    422,
  );
  assert.equal((await apply(r, [item(entry, { quantity_override: 7 })])).created, 1);
  v.inventoryItem.tracked = false;
  const n = normalizeShopifyCatalog(v, {
    channel_id: ch.id,
    context: { currency: 'PLN', prices_include_tax: true },
    vat: 23,
    import_stock: true,
    location_id: location,
  });
  assert.equal(n.source.quantity, null);
});
test('stock for another inventory item or location is rejected before staging', async () => {
  const ch = await channel(),
    v = variant(11000);
  v.inventoryItem.inventoryLevel.location.id = 'gid://shopify/Location/2';
  rows.push(v);
  const r = await step(await start(ch));
  assert.equal(r.fetched, 0);
  assert.match(r.error, /lokalizacji/);
});
test('existing SKU preserves price and physical stock, replay uses optimistic candidate version', async () => {
  const ch = await channel(),
    v = variant(12000);
  rows.push(v);
  const p = await ok('/products', 'POST', {
    sku: v.sku,
    name: 'Local',
    price: 3300,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 4,
  });
  const r = await fetchAll(await start(ch)),
    entry = (await view(r)).data[0],
    out = await apply(r, [item(entry)]);
  assert.equal(out.linked, 1);
  assert.equal(out.data[0].product_id, p.id);
  assert.equal(out.data[0].local_price, 3300);
  assert.equal(
    (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [p.id])).rows[0].on_hand,
    4,
  );
});
test('connection credentials changed during response prevent checkpoint; retry and apply cannot use old snapshot', async () => {
  const ch = await channel();
  rows.push(variant(13000));
  const r = await start(ch);
  pageHook = async () => {
    await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
      ch.id,
      encrypt({ access_token: 'shpat_' + 'b'.repeat(32) }),
    ]);
  };
  const failed = await step(r);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.fetched, 0);
  assert.equal((await req(`/catalog-source-runs/${r.id}/retry`, 'POST', {})).statusCode, 409);
  const next = await fetchAll(await start(ch)),
    entry = (await view(next)).data[0];
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    ch.id,
    encrypt({ access_token: 'shpat_' + 'c'.repeat(32) }),
  ]);
  assert.equal(
    (await req(`/catalog-source-runs/${next.id}/apply`, 'POST', { items: [item(entry)] }))
      .statusCode,
    409,
  );
});
test('cancellation during a page keeps source empty and fenced job stopped', async () => {
  const ch = await channel();
  rows.push(variant(14000));
  const r = await start(ch);
  pageHook = async () => {
    await ok(`/catalog-source-runs/${r.id}/cancel`, 'POST', {});
  };
  const next = await step(r);
  assert.equal(next.state, 'cancelled');
  assert.equal(next.fetched, 0);
});
test('lost lease cannot commit the fetched page', async () => {
  const ch = await channel();
  rows.push(variant(15000));
  const r = await start(ch);
  pageHook = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [r.job_id, randomUUID()]);
  };
  const next = await step(r);
  assert.equal(next.fetched, 0);
  assert.equal(next.cursor.pages, 0);
});
test('revoked admin role after response prevents local writes', async () => {
  const ch = await channel();
  rows.push(variant(16000));
  const r = await start(ch),
    user = (await ok('/auth/me')).user.id;
  pageHook = async () => {
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  };
  try {
    const next = await step(r);
    assert.equal(next.state, 'failed');
    assert.equal(next.fetched, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
});
test('tenant isolation covers index, staged rows and approvals', async () => {
  const ch = await channel();
  rows.push(variant(17000));
  const r = await fetchAll(await start(ch)),
    entry = (await view(r)).data[0];
  for (const p of [`/integrations/${ch.id}/catalog-source-runs`, `/catalog-source-runs/${r.id}`]) {
    assert.equal((await req(p, 'GET', undefined, viewer)).statusCode, 403);
    assert.equal((await req(p, 'GET', undefined, other)).statusCode, 404);
  }
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [item(entry)] }, other))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT id FROM catalog_source_items WHERE run_id=$1', [r.id]),
      )
    ).rowCount,
    0,
  );
});
test('wrong shop and changing tax settings cannot produce a ready preview', async () => {
  const ch = await channel();
  rows.push(variant(18000));
  badShop = true;
  const a = await step(await start(ch));
  assert.equal(a.fetched, 0);
  badShop = false;
  pageHook = async () => {
    included = false;
  };
  const b = await step(await start(ch));
  assert.equal(b.state, 'failed');
  assert.equal(b.fetched, 0);
});
test('malformed or missing required physical metadata fails instead of inventing defaults', async () => {
  const ch = await channel();
  rows.push(variant(19000));
  responseHook = (page) => {
    delete page[0].inventoryItem.requiresShipping;
  };
  const r = await step(await start(ch));
  assert.equal(r.fetched, 0);
  assert.match(r.error, /wariant/);
});
test('local simulator creates group plus variants and immediately supports Shopify offer preview', async () => {
  const ch = await channel(true),
    r = await fetchAll(await start(ch));
  assert.equal(r.state, 'ready');
  assert.equal(r.fetched, 4);
  assert.equal(calls.length, 0);
  const out = await apply(
    r,
    (await view(r)).data.map((e: any) => item(e)),
  );
  assert.equal(out.created, 4);
  const v = out.data.find((e: any) => e.kind === 'variant');
  const preview = await ok(`/integrations/${ch.id}/offers/preview`, 'POST', {
    operation: 'sync',
    product_id: v.product_id,
    listing_id: v.listing_id,
    warehouse_id: warehouse,
    price: true,
    stock: true,
  });
  assert.equal(preview.provider, 'shopify');
  assert.equal(calls.length, 0);
});

test('failed second page retries from the durable cursor without repeating committed variants', async () => {
  const ch = await channel();
  for (let n = 0; n < 26; n++) rows.push(variant(20000 + n));
  const r = await step(await start(ch));
  assert.equal(r.fetched, 25);
  let attempts = 0;
  const failing: IntegrationContext = {
    transport: async (url, init) => {
      const b = JSON.parse(String(init.body));
      if (b.query.startsWith('query DynaCatalog(')) {
        attempts++;
        return new Response('NEVER_EXPOSE', { status: 503, headers: { 'retry-after': '0' } });
      }
      return ctx.transport!(url, init);
    },
  };
  const job = await claim(r.job_id);
  try {
    await processCatalogSource(job, failing);
    assert.fail('Expected read failure');
  } catch (e) {
    await failCatalogSource(job, e);
  }
  const failed = (await pool.query('SELECT * FROM catalog_source_runs WHERE id=$1', [r.id]))
    .rows[0];
  assert.equal(attempts, 3);
  assert.equal(failed.cursor.after, 'page:1');
  assert.equal(failed.fetched, 25);
  assert.equal(failed.state, 'queued');
  assert(!failed.error.includes('NEVER_EXPOSE'));
  const done = await fetchAll(failed);
  assert.equal(done.state, 'ready');
  assert.equal(done.fetched, 26);
  assert.equal(done.cursor.pages, 2);
});
test('token replacement during HTTP backoff prevents another request with the old token', async () => {
  const ch = await channel();
  rows.push(variant(21000));
  const r = await start(ch);
  let attempts = 0;
  const failing: IntegrationContext = {
    transport: async (url, init) => {
      const b = JSON.parse(String(init.body));
      if (b.query.startsWith('query DynaCatalog(')) {
        attempts++;
        await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
          ch.id,
          encrypt({ access_token: 'shpat_' + 'b'.repeat(32) }),
        ]);
        return new Response('', { status: 503, headers: { 'retry-after': '0' } });
      }
      return ctx.transport!(url, init);
    },
  };
  const job = await claim(r.job_id);
  try {
    await processCatalogSource(job, failing);
    assert.fail('Expected credential fence');
  } catch (e) {
    await failCatalogSource(job, e);
  }
  const failed = (await pool.query('SELECT * FROM catalog_source_runs WHERE id=$1', [r.id]))
    .rows[0];
  assert.equal(attempts, 1);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.fetched, 0);
});
test('oversized converted price needs explicit override; long barcode is omitted, never truncated into another code', async () => {
  const ch = await channel(),
    v = variant(22000);
  included = false;
  v.price = '1000000.00';
  v.barcode = '9'.repeat(40);
  rows.push(v);
  const r = await fetchAll(await start(ch)),
    entry = (await view(r)).data[0];
  assert.equal(entry.source.price, null);
  assert.equal(entry.source.ean, '');
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [item(entry)] })).statusCode,
    422,
  );
  assert.equal((await apply(r, [item(entry, { price_override: 5000 })])).created, 1);
});
test('local VAT zero does not change the recorded provider taxable flag', async () => {
  const ch = await channel(true),
    r = await fetchAll(await start(ch, { vat: 0 }));
  const entries = (await view(r)).data,
    simple = entries.find((e: any) => e.kind === 'simple');
  assert.equal(simple.source.vat, 0);
  assert.equal(simple.source.taxable, true);
  const out = await apply(r, [item(simple)]);
  assert.equal(
    (await pool.query('SELECT last_result FROM listings WHERE id=$1', [out.data[0].listing_id]))
      .rows[0].last_result.taxable,
    true,
  );
});

test('single product with more than 250 variants is fetched completely in bounded pages', async () => {
  const ch = await channel(),
    options = [
      { name: 'Numer', optionValues: Array.from({ length: 301 }, (_, n) => ({ name: String(n) })) },
    ];
  for (let n = 0; n < 301; n++) {
    const v = variant(30000 + n, true);
    v.product.options = options;
    v.selectedOptions = [{ name: 'Numer', value: String(n) }];
    v.title = String(n);
    rows.push(v);
  }
  const started = performance.now(),
    r = await fetchAll(await start(ch));
  assert.equal(r.state, 'ready');
  assert.equal(r.fetched, 302);
  assert.equal(r.cursor.pages, 13);
  assert.equal(calls.filter((c) => c.name === 'DynaCatalog').length, 13);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM catalog_source_items WHERE run_id=$1 AND kind='variant'",
        [r.id],
      )
    ).rows[0].n,
    301,
  );
  console.info(
    JSON.stringify({
      scope: 'isolated_local_contract_fixture',
      variants: 301,
      pages: 13,
      staged_entries: r.fetched,
      elapsed_ms: Math.round(performance.now() - started),
    }),
  );
});
