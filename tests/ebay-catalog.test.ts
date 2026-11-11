import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt, decrypt } from '../server/security';
import { processCatalogSource, failCatalogSource } from '../server/catalog-source';
import { Ebay, ebayConnectionHash, EBAY_READ_SCOPE, EBAY_INVENTORY_SCOPE } from '../server/ebay';
import { readEbayCatalogPage, normalizeEbayCatalog } from '../server/ebay-inventory';
import { ebayInventoryFixture } from './ebay-inventory-fixture';
import { ebaySecrets } from './ebay-fixture';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  user: string,
  f = ebayInventoryFixture();
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
const ok = async (p: string, method: any = 'GET', payload?: any) => {
  const r = await req(p, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: (u, i) => f.transport(u, i) });
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query('DELETE FROM ebay_api_leases; DELETE FROM ebay_api_buckets');
  f = ebayInventoryFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
async function channel(
  settings: any = {
    inventory_access: 'orders_inventory',
    marketplace_id: 'EBAY_DE',
    price_mode: 'gross',
  },
) {
  return (
    await ok('/integrations', 'POST', {
      provider: 'ebay',
      name: 'Inventory QA',
      mode: 'sandbox',
      credentials: ebaySecrets,
      settings,
    })
  ).id;
}
async function start(ch: string, extra: any = {}) {
  return ok(`/integrations/${ch}/catalog-source-runs`, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    vat: 23,
    ...extra,
  });
}
async function step(r: any, expected?: RegExp) {
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [r.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processCatalogSource(job, { transport: f.transport });
    assert(!expected, 'Expected failure');
  } catch (e) {
    if (!expected) throw e;
    assert.match((e as Error).message, expected);
    await failCatalogSource(job, e);
  }
  return (await pool.query('SELECT * FROM catalog_source_runs WHERE id=$1', [r.id])).rows[0];
}
const view = (r: any) => ok(`/catalog-source-runs/${r.id}?limit=100`);
const inputs = (rows: any[]) =>
  rows.map((r) => ({
    id: r.id,
    source_hash: r.source_hash,
    expected_product_id: r.candidate_id ?? null,
    expected_version: r.candidate_version ?? null,
  }));
const apply = (r: any, rows: any[], map = (x: any) => x) =>
  req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: inputs(rows).map(map) });
function client() {
  f.state.token = 1;
  return new Ebay('sandbox', { access_token: 'INVENTORY-DEMO-1' }, f.transport);
}
const context = {
  channel_id: randomUUID(),
  vat: 23,
  context: { currency: null, prices_include_tax: true },
};
test('Inventory pagination follows page index next, rejects origin/filter/duplicates and incomplete metadata', async () => {
  f = ebayInventoryFixture(26);
  const c = client();
  const p = await readEbayCatalogPage(c, 0, 'EBAY_DE', async () => {});
  assert.equal(p.rows.length, 25);
  assert.equal(p.next, 1);
  assert.equal((await readEbayCatalogPage(c, 1, 'EBAY_DE', async () => {})).rows.length, 1);
  for (const bad of [
    'https://evil.test/sell/inventory/v1/inventory_item?limit=25&offset=1',
    'https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item?limit=25&offset=0',
    'https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item?limit=25&offset=1&sku=other',
  ]) {
    f.state.edit = (u, v) => {
      if (u.pathname.endsWith('/inventory_item')) v.next = bad;
    };
    await assert.rejects(readEbayCatalogPage(c, 0, 'EBAY_DE', async () => {}));
  }
  f.state.edit = (u, v) => {
    if (u.pathname.endsWith('/inventory_item')) v.inventoryItems[1] = v.inventoryItems[0];
  };
  await assert.rejects(
    readEbayCatalogPage(c, 0, 'EBAY_DE', async () => {}),
    /Powtórzone/,
  );
});
test('Normalizer keeps exact SKU, metadata, remote quantity and source offers; net rounding and uncertain pricing', () => {
  const raw = f.rows[0],
    n = normalizeEbayCatalog(raw, context);
  assert.equal(n.source.price, 10000);
  assert.equal(n.source.quantity, 12);
  assert.equal(n.source.ebay.selected_offer_id, 'DEMO-OFFER-0');
  assert.equal(
    normalizeEbayCatalog(raw, { ...context, context: { prices_include_tax: false } }).source.price,
    12300,
  );
  const auction = structuredClone(raw);
  auction.offers[0].format = 'AUCTION';
  assert.equal(normalizeEbayCatalog(auction, context).source.price, null);
  const lot = structuredClone(raw);
  (lot.offers[0] as any).lotSize = 4;
  assert.equal(normalizeEbayCatalog(lot, context).source.unsupported, true);
  const multi = structuredClone(raw);
  multi.item.inventoryItemGroupKeys = ['a', 'b'];
  assert.equal(normalizeEbayCatalog(multi, context).kind, 'unsupported');
});
test('Inventory bulk apply creates groups and variants, encrypted scopes refresh, zero physical stock and SKU mappings', async () => {
  const ch = await channel(),
    r = await step(await start(ch));
  assert.equal(r.state, 'ready');
  assert.equal(r.fetched, 4);
  const data = (await view(r)).data;
  const first = await apply(r, data);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().created, 4);
  const repeat = await apply(r, data);
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert(repeat.json().data.every((v: any) => v.reused));
  const products = first.json().data.map((v: any) => v.product_id);
  assert.equal(
    (
      await pool.query(
        'SELECT sum(on_hand)::int AS n,sum(reserved)::int AS r FROM stock WHERE product_id=ANY($1::uuid[])',
        [products],
      )
    ).rows[0].n,
    0,
  );
  const linked = (
    await pool.query(
      'SELECT external_id,parent_external_id,last_result FROM listings WHERE channel_id=$1',
      [ch],
    )
  ).rows;
  assert.equal(linked.length, 3);
  assert(
    linked.every(
      (v) => v.parent_external_id === null && v.last_result.stock_scope === 'external_availability',
    ),
  );
  const c = (await pool.query('SELECT * FROM channels WHERE id=$1', [ch])).rows[0];
  assert.equal(c.oauth_scopes, EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_SCOPE);
  assert.equal(f.state.token, 1);
  assert.equal(decrypt(c.credentials).refresh_token, 'DEMO-refresh');
  assert(!(await req('/integrations')).body.includes('INVENTORY-DEMO'));
});
test('Existing SKU keeps price, metadata, physical stock and reservations; source availability remains external', async () => {
  const uniqueSku = 'PRESERVE-' + randomUUID().slice(0, 8);
  f.rows[0].item.sku = uniqueSku;
  f.rows[0].offers[0].sku = uniqueSku;
  const ch = await channel(),
    p = await ok('/products', 'POST', {
      name: 'Local preserved',
      sku: uniqueSku,
      price: 9999,
      vat: 23,
      quantity: 12,
      warehouse_id: warehouse,
    });
  const r = await step(await start(ch)),
    row = (await view(r)).data.find((v: any) => v.external_id === uniqueSku);
  const res = await apply(r, [row]);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().linked, 1);
  assert.equal((await ok('/products/' + p.id)).name, 'Local preserved');
  assert.equal((await ok('/products/' + p.id)).price, 9999);
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [p.id])).rows,
    [{ on_hand: 12, reserved: 0 }],
  );
});
test('Different offer currency requires explicit local price; no implicit FX and draft/no offers price remains unknown', async () => {
  const ch = await channel();
  f.rows[0].offers[0].pricingSummary.price.currency = 'EUR';
  const r = await step(await start(ch)),
    row = (await view(r)).data.find((v: any) => v.external_id === 'EBAY-DEMO-SKU');
  const denied = await apply(r, [row], (x) => ({
    ...x,
    local_sku: 'FX-' + randomUUID().slice(0, 8),
    expected_product_id: null,
    expected_version: null,
  }));
  assert.equal(denied.statusCode, 422, denied.body);
  const accepted = await apply(r, [row], (x) => ({
    ...x,
    local_sku: 'FX-' + randomUUID().slice(0, 8),
    expected_product_id: null,
    expected_version: null,
    price_override: 4900,
  }));
  assert.equal(accepted.statusCode, 200, accepted.body);
  f.state.notFound = true;
  const raw = await readEbayCatalogPage(client(), 0, 'EBAY_DE', async () => {});
  assert(raw.rows.every((r) => r.offers_unavailable));
  assert.equal(normalizeEbayCatalog(raw.rows[0], context).source.price, null);
});
test('Durable checkpoint resumes at provider next, stable groups and catalog restart preserves previous pages', async () => {
  f = ebayInventoryFixture(26);
  const ch = await channel(),
    initial = await start(ch),
    first = await step(initial);
  assert.equal(first.state, 'queued');
  assert.equal(first.cursor.after, 1);
  assert.equal(first.cursor.seen, 25);
  assert.equal(f.state.token, 1);
  const second = await step(first);
  assert.equal(second.state, 'ready');
  assert.equal(second.cursor.seen, 26);
  assert.equal(second.fetched, 27);
  assert.equal(f.state.token, 1);
  assert(f.calls.some((c) => new URL(c.url).searchParams.get('offset') === '1'));
});
test('Explicit inventory scope and external-stock rules reject before enqueue; tenant and viewer isolation', async () => {
  const ch = await channel({});
  f.state.scope = EBAY_READ_SCOPE;
  const body = { client_key: randomUUID(), warehouse_id: warehouse };
  assert.equal(
    (await req(`/integrations/${ch}/catalog-source-runs`, 'POST', body)).statusCode,
    422,
  );
  const full = await channel();
  assert.equal(
    (
      await req(`/integrations/${full}/catalog-source-runs`, 'POST', {
        ...body,
        import_stock: true,
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await req(`/integrations/${full}/catalog-source-runs`, 'POST', body, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/integrations/${full}/catalog-source-runs`, 'GET', undefined, other)).statusCode,
    404,
  );
});
test('Cancellation during remote read prevents staging; retry after failure advances no stale cursor', async () => {
  const ch = await channel(),
    r = await start(ch);
  f.state.hook = async (u) => {
    if (u.pathname.endsWith('/inventory_item'))
      await ok(`/catalog-source-runs/${r.id}/cancel`, 'POST', {});
  };
  await step(r, /Import zatrzymano/);
  assert.equal((await view(r)).data.length, 0);
  f.state.hook = undefined;
  const next = await start(ch);
  await pool.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [next.job_id]);
  f.state.edit = (u, v) => {
    if (u.pathname.endsWith('/inventory_item')) v.limit = 30;
  };
  await step(next, /metadane/);
  assert.equal((await view(next)).data.length, 0);
  f.state.edit = undefined;
  const retry = await ok(`/catalog-source-runs/${next.id}/retry`, 'POST', {});
  assert.equal((await step(retry)).state, 'ready');
});
test('Role revoked during OAuth prevents encrypted cache mutation and catalog staging', async () => {
  const ch = await channel(),
    r = await start(ch);
  f.state.hook = async (u) => {
    if (u.pathname.endsWith('/token'))
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
  };
  await step(r, /Administrator/);
  assert.equal(
    decrypt(
      (await pool.query('SELECT credentials FROM channels WHERE id=$1', [ch])).rows[0].credentials,
    ).access_token,
    undefined,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM catalog_source_items WHERE run_id=$1', [r.id]))
      .rows[0].n,
    0,
  );
});
test('Credential change invalidates import while access-token refresh leaves fingerprint stable', async () => {
  const ch = await channel(),
    r = await step(await start(ch)),
    c = (await pool.query('SELECT * FROM channels WHERE id=$1', [ch])).rows[0];
  const hash = ebayConnectionHash(c);
  assert.equal(
    ebayConnectionHash({
      ...c,
      credentials: encrypt({ ...decrypt(c.credentials), access_token: 'changed' }),
    }),
    hash,
  );
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    ch,
    encrypt({ ...ebaySecrets, refresh_token: 'another-refresh' }),
  ]);
  assert.equal((await apply(r, (await view(r)).data)).statusCode, 409);
});

test('Group ID alias resolves through authoritative group response; invalid membership and SKU scope fail', async () => {
  const row: any = f.rows[1];
  row.item.groupIds = row.item.inventoryItemGroupKeys;
  delete row.item.inventoryItemGroupKeys;
  const page = await readEbayCatalogPage(client(), 0, 'EBAY_DE', async () => {});
  assert.equal(normalizeEbayCatalog(page.rows[1], context).kind, 'variant');
  f.state.edit = (u, v) => {
    if (u.pathname.includes('/inventory_item_group/')) v.variantSKUs = ['WRONG'];
  };
  await assert.rejects(
    readEbayCatalogPage(client(), 0, 'EBAY_DE', async () => {}),
    /SKU nie należy/,
  );
  f.state.edit = (u, v) => {
    if (u.pathname.endsWith('/offer')) v.offers[0].sku = 'FOREIGN';
  };
  await assert.rejects(
    readEbayCatalogPage(client(), 0, 'EBAY_DE', async () => {}),
    /obca oferta/,
  );
});
test('Cached order-only access is refreshed for explicitly enabled Inventory scope, concurrent reads refresh once', async () => {
  const ch = await channel();
  await pool.query(
    "UPDATE channels SET credentials=$2,token_expires_at=now()+interval '1 hour',oauth_scopes=$3 WHERE id=$1",
    [ch, encrypt({ ...ebaySecrets, access_token: 'order-only-token' }), EBAY_READ_SCOPE],
  );
  const a = await start(ch),
    b = await start(ch);
  const result = await Promise.all([step(a), step(b)]);
  assert(result.every((r) => r.state === 'ready'));
  assert.equal(f.state.token, 1);
});

test('OAuth response with a narrower explicit scope cannot authorize Inventory or mutate the cache', async () => {
  const ch = await channel(),
    r = await start(ch);
  f.state.edit = (u, v) => {
    if (u.pathname.endsWith('/token')) v.scope = EBAY_READ_SCOPE;
  };
  await step(r, /zakresów/);
  assert.equal(
    decrypt(
      (await pool.query('SELECT credentials FROM channels WHERE id=$1', [ch])).rows[0].credentials,
    ).access_token,
    undefined,
  );
});
