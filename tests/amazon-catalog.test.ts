import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processCatalogSource, failCatalogSource } from '../server/catalog-source';
import { Amazon } from '../server/amazon';
import {
  parseAmazonCatalogSkus,
  normalizeAmazonCatalog,
  amazonDocumentUrl,
  readAmazonCatalogBatch,
  downloadAmazonCatalog,
} from '../server/amazon-catalog';
import { amazonCatalogFixture, amazonCatalogConfig } from './amazon-catalog-fixture';
import { amazonSecrets } from './amazon-fixture';
import { amazonApiTransport, AmazonApiWait } from '../server/amazon-api-limits';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  user: string,
  f = amazonCatalogFixture();
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
  f = amazonCatalogFixture();
  await pool.query('DELETE FROM amazon_api_buckets');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
const channel = async (settings: any = amazonCatalogConfig) =>
  (
    await ok('/integrations', 'POST', {
      provider: 'amazon',
      name: 'Catalog QA',
      mode: 'sandbox',
      credentials: amazonSecrets,
      settings,
    })
  ).id;
const start = (ch: string, extra: any = {}) =>
  ok(`/integrations/${ch}/catalog-source-runs`, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    vat: 23,
    ...extra,
  });
async function step(r: any, expected?: RegExp) {
  await pool.query(
    "UPDATE amazon_api_buckets SET updated_at=clock_timestamp()-interval '60 seconds'",
  );
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
async function ready(ch: string) {
  let r = await start(ch);
  for (let n = 0; r.state === 'queued' && n < 20; n++) {
    // Advance only the disposable test DB clock accounting; no vendor-rate throughput claim.
    await pool.query(
      "UPDATE amazon_api_buckets SET updated_at=clock_timestamp()-interval '60 seconds'",
    );
    r = await step(r);
  }
  assert.equal(r.state, 'ready');
  return r;
}
const view = (r: any) => ok(`/catalog-source-runs/${r.id}?limit=100`);
const inputs = (rows: any[]) =>
  rows.map((r) => ({
    id: r.id,
    source_hash: r.source_hash,
    expected_product_id: r.candidate_id ?? null,
    expected_version: r.candidate_version ?? null,
  }));
const local = {
  vat: 23,
  context: {
    marketplace_id: amazonCatalogConfig.marketplace_id,
    selling_partner_id: amazonCatalogConfig.selling_partner_id,
  },
};
const client = () => new Amazon('sandbox', amazonCatalogConfig, amazonSecrets, f.transport);

test('TSV parser preserves exact SKU, quoted fields, BOM and duplicates; large manifest exceeds search cap', () => {
  assert.deepEqual(
    parseAmazonCatalogSkus(
      '\uFEFFitem-name\tseller-sku\tDeprecated column\tDeprecated column\r\n"a\tb\nc"\t" SKU \"\"x\"\" "\t\t',
    ),
    [' SKU "x" '],
  );
  assert.equal(
    parseAmazonCatalogSkus(
      'seller-sku\n' + Array.from({ length: 120001 }, (_, i) => 'SKU-' + i).join('\n'),
    ).length,
    120001,
  );
  for (const text of ['sku\nX', 'seller-sku\nX\nX', 'seller-sku\tprice\nX', 'seller-sku\n"X'])
    assert.throws(() => parseAmazonCatalogSkus(text));
});
test('document download rejects private origins, redirects, wrong document IDs and unsupported compression; token never sent to CDN', async () => {
  for (const url of [
    'http://s3.amazonaws.com/x',
    'https://127.0.0.1/x',
    'https://s3.amazonaws.com.evil.test/x',
    'https://user@s3.amazonaws.com/x',
    'https://s3.amazonaws.com:444/x',
    'https://evil.test/x',
  ])
    assert.throws(() => amazonDocumentUrl(url));
  assert.equal((await downloadAmazonCatalog(client(), 'DOC074', async () => {})).length, 4);
  for (const edit of [
    (p: string, v: any) => {
      if (p.includes('/documents/')) v.reportDocumentId = 'OTHER';
    },
    (p: string, v: any) => {
      if (p.includes('/documents/')) v.compressionAlgorithm = 'ZIP';
    },
  ]) {
    f.state.edit = edit;
    await assert.rejects(() => downloadAmazonCatalog(client(), 'DOC074', async () => {}));
  }
});
test('current B2C price and DEFAULT availability ignore submitted attributes, B2B, other markets and FBA', () => {
  const raw: any = structuredClone(f.items[1]);
  raw.attributes.purchasable_offer = [
    { currency: 'PLN', our_price: [{ schedule: [{ value_with_tax: 999 }] }] },
  ];
  raw.attributes.fulfillment_availability = [{ quantity: 9000 }];
  raw.offers.push({
    marketplaceId: amazonCatalogConfig.marketplace_id,
    offerType: 'B2B',
    price: { currencyCode: 'PLN', amount: '9.99' },
  });
  raw.fulfillmentAvailability.push({ fulfillmentChannelCode: 'AMAZON_EU', quantity: 99 });
  const n = normalizeAmazonCatalog(raw, local);
  assert.equal(n.source.price, 12345);
  assert.equal(n.source.quantity, 8);
  assert.equal(n.source.amazon.attributes.fulfillment_availability[0].quantity, 9000);
  assert.equal(n.kind, 'variant');
  for (const value of ['1.001', '1.', '-1', '1e3', 123.45]) {
    const r = structuredClone(f.items[1]);
    (r.offers[0].price as any).amount = value;
    assert.equal(normalizeAmazonCatalog(r, local).source.price, null);
  }
  raw.fulfillmentAvailability = [{ fulfillmentChannelCode: 'AMAZON_EU', quantity: 99 }];
  assert.equal(normalizeAmazonCatalog(raw, local).source.quantity, null);
  raw.relationships[0].relationships.push({ type: 'PACKAGE_HIERARCHY', parentSkus: ['P'] });
  assert.equal(normalizeAmazonCatalog(raw, local).source.unsupported, true);
});
test('batch rejects foreign, duplicate, missing and paginated results; comma/slash SKU uses encoded single-item path', async () => {
  for (const mutate of [
    (v: any) => v.items.pop(),
    (v: any) => (v.items[0].sku = 'FOREIGN'),
    (v: any) => v.items.push(v.items[0]),
    (v: any) => (v.pagination = { nextToken: 'secret' }),
  ]) {
    f.state.edit = (p, v) => {
      if (p.includes('/listings/')) mutate(v);
    };
    await assert.rejects(() => readAmazonCatalogBatch(client(), [f.items[1].sku], async () => {}));
  }
  f.state.edit = undefined;
  f.items[1].sku = 'A/B,C';
  assert.equal((await readAmazonCatalogBatch(client(), ['A/B,C'], async () => {}))[0].sku, 'A/B,C');
  assert(f.calls.some((c) => c.path.endsWith('/A%2FB%2CC')));
});
test('report generation polls durable status, stages manifest, fetches missing parent and imports variants with physical zero', async () => {
  f.state.skus = f.state.skus.filter((s) => s !== 'AMAZON-DEMO-PARENT');
  const ch = await channel();
  let r = await start(ch);
  r = await step(r);
  assert.equal(r.cursor.phase, 'amazon.report');
  f.state.status = 'IN_PROGRESS';
  r = await step(r);
  assert.equal(r.cursor.phase, 'amazon.report');
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [r.job_id])).rows[0].state,
    'pending',
  );
  f.state.status = 'DONE';
  r = await step(r);
  r = await step(r);
  assert.equal(r.fetched, 3);
  r = await step(r);
  assert.equal(r.fetched, 4);
  r = await step(r);
  r = await step(r);
  assert.equal(r.state, 'ready');
  const rows = (await view(r)).data;
  assert.equal(rows.length, 4);
  const result = await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: inputs(rows) });
  assert.equal(result.statusCode, 200, result.body);
  for (const row of rows) {
    const p = (await ok('/products?search=' + row.source.sku)).data.find(
      (p: any) => p.sku === row.source.sku,
    );
    assert(p);
    assert.equal(p.on_hand, 0);
    assert.equal(p.reserved, 0);
    if (row.kind === 'variant') {
      assert(p.parent_id);
      assert.equal(p.price, 12345);
    }
  }
  const again = await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: inputs(rows) });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().created, 0);
  const listings = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM listings WHERE channel_id=$1', [ch])).rows,
  );
  assert.equal(listings.length, 3);
  assert(
    listings.every(
      (l) => l.parent_external_id === null && l.last_result.stock_scope === 'external_availability',
    ),
  );
  assert.equal(JSON.stringify(r).includes('PRIVATE-DEMO'), false);
  assert.equal(JSON.stringify(rows).includes('999.99'), false);
});
test('large 1001-SKU catalog resumes durable batches after 429 with no lost entries or exhausted attempts', async () => {
  f = amazonCatalogFixture(1001);
  const ch = await channel();
  let r = await start(ch);
  for (let i = 0; i < 3; i++) r = await step(r);
  assert.equal(r.fetched, 1001);
  assert.equal(r.cursor.manifest_total, 1001);
  f.state.fail429 = true;
  r = await step(r, /limit API/);
  assert.equal(r.state, 'queued');
  const waiting = (await pool.query('SELECT * FROM jobs WHERE id=$1', [r.job_id])).rows[0];
  assert.equal(waiting.attempts, 0);
  assert.match(waiting.provider_wait_reason, /amazon.listings_search.cooldown/);
  f.state.fail429 = false;
  await pool.query("UPDATE amazon_api_buckets SET cooldown_until='-infinity'");
  for (let i = 0; r.state === 'queued' && i < 60; i++) {
    await pool.query(
      "UPDATE amazon_api_buckets SET updated_at=clock_timestamp()-interval '60 seconds'",
    );
    r = await step(r);
  }
  assert.equal(r.state, 'ready');
  assert.equal(r.fetched, 1001);
  assert.equal(r.cursor.batches, 51);
  const q = await pool.query(
    "SELECT count(*)::int n FROM catalog_source_items WHERE run_id=$1 AND source->>'amazon_pending'='true'",
    [r.id],
  );
  assert.equal(q.rows[0].n, 0);
  assert.equal(
    f.calls.filter((c) => c.path === '/reports/2021-06-30/reports' && c.method === 'POST').length,
    1,
  );
});
test('tenant/role/configuration fences prevent import and stale grant cannot resume or apply', async () => {
  const ch = await channel();
  assert.equal(
    (await req(`/integrations/${ch}/catalog-source-runs`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        `/integrations/${ch}/catalog-source-runs`,
        'POST',
        { client_key: randomUUID(), warehouse_id: warehouse },
        viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req(`/integrations/${ch}/catalog-source-runs`, 'POST', {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        import_stock: true,
      })
    ).statusCode,
    422,
  );
  let r = await start(ch);
  r = await step(r);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    ch,
    encrypt({ ...amazonSecrets, refresh_token: 'ROTATED' }),
  ]);
  r = await step(r, /Połączenie Amazon zmieniono/);
  assert.equal(r.state, 'failed');
  const missing = await channel({ ...amazonCatalogConfig, selling_partner_id: '' });
  assert.equal(
    (
      await req(`/integrations/${missing}/catalog-source-runs`, 'POST', {
        client_key: randomUUID(),
        warehouse_id: warehouse,
      })
    ).statusCode,
    422,
  );
});
test('Listings shared budget is enforced across connector instances and tenant grants without admitting writes', async () => {
  const transport = amazonApiTransport('sandbox', 'eu', amazonSecrets.client_id, f.transport);
  const a = new Amazon('sandbox', amazonCatalogConfig, amazonSecrets, transport, f.transport);
  for (let i = 0; i < 5; i++) await readAmazonCatalogBatch(a, [f.items[1].sku], async () => {});
  const sibling = new Amazon('sandbox', amazonCatalogConfig, amazonSecrets, transport, f.transport);
  await assert.rejects(
    () => readAmazonCatalogBatch(sibling, [f.items[1].sku], async () => {}),
    (e) => e instanceof AmazonApiWait && e.family === 'listings_search',
  );
  const count = f.calls.length;
  await assert.rejects(() =>
    transport(
      'https://sandbox.sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/ADEMO074',
      { method: 'POST' },
    ),
  );
  assert.equal(f.calls.length, count);
  const privilege = await pool.query(
    "SELECT has_table_privilege('dyna_app','amazon_api_buckets','SELECT') ok",
  );
  assert.equal(privilege.rows[0].ok, false);
});
test('role loss and cancellation during HTTP discard batch before storage', async () => {
  const ch = await channel();
  let r = await start(ch);
  for (let i = 0; i < 3; i++) r = await step(r);
  f.state.hook = async (u) => {
    if (u.pathname.includes('/listings/'))
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
  };
  r = await step(r, /utracił prawo/);
  assert.equal(r.state, 'failed');
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM catalog_source_items WHERE run_id=$1 AND source->>'amazon_pending'='true'",
        [r.id],
      )
    ).rows[0].n,
    4,
  );
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  f.state.hook = undefined;
  r = await start(ch);
  for (let i = 0; i < 3; i++) {
    await pool.query(
      "UPDATE amazon_api_buckets SET updated_at=clock_timestamp()-interval '60 seconds'",
    );
    r = await step(r);
  }
  f.state.hook = async (u) => {
    if (u.pathname.includes('/listings/'))
      await ok(`/catalog-source-runs/${r.id}/cancel`, 'POST', {});
  };
  r = await step(r, /Import zatrzymano/);
  assert.equal(r.state, 'cancelled');
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM catalog_source_items WHERE run_id=$1 AND source->>'amazon_pending'='true'",
        [r.id],
      )
    ).rows[0].n,
    4,
  );
});
test('inconsistent variant family, wrong report binding and changed source hash block unsafe application', async () => {
  const ch = await channel();
  let r = await start(ch);
  r = await step(r);
  f.state.edit = (p, v) => {
    if (p.includes('/reports/REPORT')) v.marketplaceIds = ['ATVPDKIKX0DER'];
  };
  r = await step(r, /innego rynku/);
  assert.equal(r.state, 'failed');
  f.state.edit = undefined;
  const run = await ready(ch);
  const rows = (await view(run)).data;
  const b = inputs(rows);
  b[0].source_hash = '0'.repeat(64);
  assert.equal(
    (await req(`/catalog-source-runs/${run.id}/apply`, 'POST', { items: b })).statusCode,
    409,
  );
  f.items[0].relationships[0].relationships[0].childSkus = ['MISSING'];
  f.items[1].relationships[0].relationships = [];
  f.items[2].relationships[0].relationships = [];
  r = await start(ch);
  for (let i = 0; i < 4; i++) {
    await pool.query(
      "UPDATE amazon_api_buckets SET updated_at=clock_timestamp()-interval '60 seconds'",
    );
    r = await step(r);
  }
  r = await step(r, /Niepełna partia SKU/);
  assert.equal(r.state, 'failed');
});
