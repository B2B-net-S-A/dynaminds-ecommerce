import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Shopify, SHOPIFY_VERSION, shopifyFilter, shopifyStore } from '../server/shopify';
import { demoShopifyOrder } from '../server/shopify-example';
import { normalizeOrder } from '../server/imports';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processIntegrationJob } from '../server/sync';
import type { Transport } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
const settings = { store_url: 'https://dyna-qa.myshopify.com' },
  credentials = { access_token: 'shpat_' + 'a'.repeat(32) };
const money = (amount: string, currencyCode = 'PLN') => ({
  presentmentMoney: { amount, currencyCode },
});
function fixture(id = 98001): any {
  const o: any = structuredClone(demoShopifyOrder);
  o.id = 'gid://shopify/Order/' + id;
  o.lineItems.nodes[0].id = 'gid://shopify/LineItem/' + id + '1';
  o.shippingLines.nodes[0].id = 'gid://shopify/ShippingLine/' + id + '2';
  return o;
}
let remote: any[] = [fixture()],
  fail = '',
  hook: ((name: string) => Promise<void>) | undefined;
const calls: { url: string; init: RequestInit; body: any }[] = [];
const json = (data: any, status = 200, version = SHOPIFY_VERSION) =>
  new Response(JSON.stringify(data), { status, headers: { 'X-Shopify-API-Version': version } });
function page(rows: any[], size: number, after: string | null, prefix: string) {
  const start = after ? Number(after.split(':').at(-1)) : 0;
  return {
    nodes: structuredClone(rows.slice(start, start + size)),
    pageInfo: {
      hasNextPage: start + size < rows.length,
      endCursor: rows.length ? prefix + ':' + Math.min(start + size, rows.length) : null,
    },
  };
}
const transport: Transport = async (url, init) => {
  const b = JSON.parse(String(init.body));
  calls.push({ url, init, body: b });
  assert.equal(url, settings.store_url + '/admin/api/' + SHOPIFY_VERSION + '/graphql.json');
  assert.equal(init.method, 'POST');
  assert.match(b.query, /^query Dyna/);
  assert.ok(!b.query.includes('mutation'));
  const name = b.query.match(/^query (\w+)/)[1];
  await hook?.(name);
  if (fail === name)
    return json({
      errors: [{ message: 'NEVER_EXPOSE', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
      data: { orders: { nodes: remote } },
    });
  if (name === 'DynaShop')
    return json({
      data: {
        shop: {
          id: 'gid://shopify/Shop/10',
          name: 'QA',
          myshopifyDomain: 'dyna-qa.myshopify.com',
          currencyCode: 'PLN',
        },
        currentAppInstallation: {
          accessScopes: [{ handle: 'read_orders' }, { handle: 'read_products' }],
        },
      },
    });
  if (name === 'DynaVariants')
    return json({
      data: {
        shop: { currencyCode: 'PLN' },
        productVariants: page(
          [{ id: 'gid://shopify/ProductVariant/701', sku: 'QA-SHOPIFY', price: '15.00' }],
          25,
          b.variables.after,
          'variants',
        ),
      },
    });
  if (name === 'DynaOrders') {
    const p = page(remote, 5, b.variables.after, 'orders');
    for (const o of p.nodes) {
      o.lineItems = page(o.lineItems.nodes, 10, null, 'lines');
      o.shippingLines = page(o.shippingLines.nodes, 5, null, 'shipping');
    }
    return json({ data: { orders: p } });
  }
  const o = remote.find((o) => o.id === b.variables.id);
  if (name === 'DynaOrder') {
    const row = o ? structuredClone(o) : null;
    if (row) {
      row.lineItems = page(row.lineItems.nodes, 10, null, 'lines');
      row.shippingLines = page(row.shippingLines.nodes, 5, null, 'shipping');
    }
    return json({
      data: {
        shop: { id: 'gid://shopify/Shop/10', myshopifyDomain: 'dyna-qa.myshopify.com' },
        order: row,
      },
    });
  }
  const field = name === 'DynaLines' ? 'lineItems' : 'shippingLines';
  return json({
    data: {
      order: o
        ? {
            id: o.id,
            updatedAt: o.updatedAt,
            [field]: page(
              o[field].nodes,
              20,
              b.variables.after,
              field === 'lineItems' ? 'lines' : 'shipping',
            ),
          }
        : null,
    },
  });
};
let app: FastifyInstance, cookie: string, other: string, viewer: string, warehouse: string;
const req = (url: string, method: any = 'GET', payload?: any, session = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: session } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
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
  warehouse = (await req('/api/warehouses')).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function channel(enabled = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,sync_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        DEMO_TENANT,
        'shopify',
        'QA Shopify',
        'sandbox',
        encrypt(credentials),
        JSON.stringify(settings),
        enabled,
      ],
    ),
  );
  return id;
}
async function stage(ch: string, o: any) {
  const r = await req(`/api/integrations/${ch}/stage-orders`, 'POST', { data: [o] });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data[0].id;
}
async function mapped(ch: string, stock = 20) {
  const sku = 'SHOPIFY-' + randomUUID().slice(0, 8);
  const p = await req('/api/products', 'POST', {
    sku,
    name: 'Shopify QA',
    price: 99999,
    vat: 23,
    warehouse_id: warehouse,
    quantity: stock,
  });
  assert.equal(p.statusCode, 201, p.body);
  const r = await req(`/api/integrations/${ch}/mappings`, 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku,
  });
  assert.equal(r.statusCode, 200, r.body);
  return p.json();
}
async function claim(ch: string) {
  const r = await req(`/api/integrations/${ch}/sync`, 'POST');
  assert.equal(r.statusCode, 200, r.body);
  return tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          "UPDATE jobs SET state='running',lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
          [r.json().id, randomUUID()],
        )
      ).rows[0],
  );
}
const jobState = (id: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0],
  );
const count = async (ch: string) =>
  (await req(`/api/integrations/${ch}/imports`)).json().data.length;

test('Shopify poprawnie uwzględnia rabat pozycji/kodu i dostawy bez utraty grosza', () => {
  const o = normalizeOrder('shopify', fixture());
  assert.equal(o.total, 3299);
  assert.equal(o.items[0].line_total, 2799);
  assert.equal(o.shipping_cost, 500);
  assert.equal(o.paid_amount, 3299);
  assert.deepEqual(o.blockers, []);
});
test('Shopify dodaje podatki tylko gdy ceny nie zawierają podatków', () => {
  const o = fixture();
  o.taxesIncluded = false;
  Object.assign(o.lineItems.nodes[0], {
    originalTotalSet: money('100.00'),
    discountAllocations: [{ allocatedAmountSet: money('20.00') }],
    taxLines: [{ priceSet: money('18.40') }],
  });
  Object.assign(o.shippingLines.nodes[0], {
    originalPriceSet: money('10.00'),
    discountedPriceSet: money('10.00'),
    taxLines: [{ priceSet: money('2.30') }],
  });
  o.totalTaxSet = money('20.70');
  o.totalPriceSet = o.currentTotalPriceSet = o.totalReceivedSet = money('110.70');
  const n = normalizeOrder('shopify', o);
  assert.equal(n.items[0].line_total, 9840);
  assert.equal(n.shipping_cost, 1230);
});
test('Shopify Markets używa presentmentMoney zamiast kwot waluty sklepu', () => {
  const o = fixture();
  const visit = (v: any) => {
    if (v && typeof v === 'object') {
      if (v.presentmentMoney) {
        v.presentmentMoney.currencyCode = 'EUR';
        v.shopMoney = { amount: '999.99', currencyCode: 'PLN' };
      }
      Object.values(v).forEach(visit);
    }
  };
  visit(o);
  o.presentmentCurrencyCode = 'EUR';
  const n = normalizeOrder('shopify', o);
  assert.equal(n.total, 3299);
  assert.equal(n.currency, 'EUR');
  o.lineItems.nodes[0].taxLines[0].priceSet.presentmentMoney.currencyCode = 'PLN';
  assert.throws(() => normalizeOrder('shopify', o), /waluta/);
});
test('Shopify częściowa płatność nie oznacza zamówienia jako opłacone; autoryzacja nie jest wpłatą', () => {
  const o = fixture();
  o.displayFinancialStatus = 'PARTIALLY_PAID';
  o.totalReceivedSet = money('10.00');
  const n = normalizeOrder('shopify', o);
  assert.equal(n.paid, false);
  assert.equal(n.paid_amount, 1000);
  assert.deepEqual(n.blockers, []);
  o.displayFinancialStatus = 'AUTHORIZED';
  assert.ok(normalizeOrder('shopify', o).blockers.length);
  o.totalReceivedSet = money('0.00');
  assert.deepEqual(normalizeOrder('shopify', o).blockers, []);
});
test('Shopify nie ukrywa nadpłat ani niezgodnych statusów płatności', () => {
  for (const [status, paid] of [
    ['PAID', '10.00'],
    ['PARTIALLY_PAID', '32.99'],
    ['PENDING', '10.00'],
    ['PAID', '40.00'],
    ['REFUNDED', '32.99'],
  ]) {
    const o = fixture();
    o.displayFinancialStatus = status;
    o.totalReceivedSet = money(paid);
    assert.ok(normalizeOrder('shopify', o).blockers.length);
  }
});
test('Shopify dane edytowane, wysłane, refundowane i personalizowane wymagają uzgodnienia', () => {
  for (const change of [
    (o: any) => (o.edited = true),
    (o: any) => (o.cancelledAt = '2026-10-04T10:00:00Z'),
    (o: any) => (o.displayFulfillmentStatus = 'PARTIALLY_FULFILLED'),
    (o: any) => (o.refunds = [{ id: 'gid://shopify/Refund/1' }]),
    (o: any) => (o.lineItems.nodes[0].currentQuantity = 1),
    (o: any) => (o.lineItems.nodes[0].sellingPlan = { name: 'Monthly' }),
    (o: any) => (o.lineItems.nodes[0].customAttributes = [{ key: 'text', value: 'QA' }]),
    (o: any) => (o.lineItems.nodes[0].requiresShipping = false),
    (o: any) => (o.totalCashRoundingAdjustment.paymentSet = money('-0.01')),
  ]) {
    const o = fixture();
    change(o);
    assert.ok(normalizeOrder('shopify', o).blockers.length);
  }
});
test('Shopify odrzuca niepełne strony, obce ID, duplikaty i usunięty wariant', () => {
  for (const change of [
    (o: any) => (o.lineItems.pageInfo = { hasNextPage: true, endCursor: 'next' }),
    (o: any) => (o.shippingLines.pageInfo = { hasNextPage: true, endCursor: 'next' }),
    (o: any) => o.lineItems.nodes.push(o.lineItems.nodes[0]),
    (o: any) => (o.lineItems.nodes[0].variant.id = 'gid://shopify/Product/701'),
    (o: any) => (o.lineItems.nodes[0].variant = null),
  ]) {
    const o = fixture();
    change(o);
    assert.throws(() => normalizeOrder('shopify', o));
  }
});
test('Shopify odrzuca niezgodne sumy i podatki oraz subcentowe kwoty', () => {
  for (const change of [
    (o: any) => (o.totalTaxSet = money('6.18')),
    (o: any) => (o.totalPriceSet = money('33.00')),
    (o: any) => (o.lineItems.nodes[0].discountAllocations[0].allocatedAmountSet = money('30.01')),
    (o: any) => (o.totalReceivedSet = money('32.999')),
    (o: any) => (o.shippingLines.nodes[0].discountedPriceSet = money('999999999.00')),
  ]) {
    const o = fixture();
    change(o);
    assert.throws(() => normalizeOrder('shopify', o));
  }
});
test('Shopify nie generuje fikcyjnego emaila ani adresu przy braku zgody na dane klienta', () => {
  const o = fixture();
  o.email = null;
  assert.throws(() => normalizeOrder('shopify', o));
  o.email = 'qa@example.test';
  o.shippingAddress = null;
  assert.throws(() => normalizeOrder('shopify', o));
});
test('Shopify konfiguruje tylko HTTPS myshopify.com bez ścieżek i tokenów w URL', () => {
  for (const value of [
    'http://qa.myshopify.com',
    'https://qa.myshopify.com.evil.test',
    'https://myshopify.com',
    'https://qa.myshopify.com/admin',
    'https://user:password@qa.myshopify.com',
    'https://qa.myshopify.com?token=secret',
    'https://127.0.0.1',
  ])
    assert.throws(() => shopifyStore(value));
  assert.throws(() => new Shopify(settings, { access_token: 'bad\ntoken' }, transport));
});
test('Shopify okno synchronizacji akceptuje wyłącznie daty ISO i kolejność granic', () => {
  assert.equal(
    shopifyFilter({ from: null, to: '2026-10-04T10:00:00.000Z' }),
    "updated_at:<='2026-10-04T10:00:00.000Z'",
  );
  assert.throws(() => shopifyFilter({ from: null, to: 'bad' }));
  assert.throws(() =>
    shopifyFilter({ from: '2026-10-05T10:00:00.000Z', to: '2026-10-04T10:00:00.000Z' }),
  );
});
test('Shopify query-only POST przesyła token wyłącznie w nagłówku', async () => {
  remote = [fixture()];
  calls.length = 0;
  const c = new Shopify(settings, credentials, transport);
  assert.equal((await c.orders()).data.length, 1);
  const d = await c.test();
  assert.equal(d.historical_orders, false);
  assert.equal((await c.products()).data[0].id, 'gid://shopify/ProductVariant/701');
  for (const call of calls) {
    assert.equal((call.init.headers as any)['X-Shopify-Access-Token'], credentials.access_token);
    assert.ok(!call.url.includes(credentials.access_token));
    assert.ok(!String(call.init.body).includes(credentials.access_token));
  }
});
test('Shopify uzupełnia niezależne strony pozycji i dostaw oraz sprawdza wersję zamówienia', async () => {
  const o = fixture();
  o.lineItems.nodes = Array.from({ length: 31 }, (_, i) => ({
    ...structuredClone(o.lineItems.nodes[0]),
    id: 'gid://shopify/LineItem/' + (100 + i),
  }));
  o.shippingLines.nodes = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(o.shippingLines.nodes[0]),
    id: 'gid://shopify/ShippingLine/' + (100 + i),
  }));
  remote = [o];
  calls.length = 0;
  const r = await new Shopify(settings, credentials, transport).orders();
  assert.equal(r.data[0].lineItems.nodes.length, 31);
  assert.equal(r.data[0].shippingLines.nodes.length, 6);
  assert.equal(calls.length, 4);
  assert.equal(r.data[0].lineItems.pageInfo.hasNextPage, false);
});
test('Shopify przerwany odczyt relacji odrzuca stronę zamiast importować część zamówienia', async () => {
  const o = fixture();
  o.lineItems.nodes = Array.from({ length: 11 }, (_, i) => ({
    ...structuredClone(o.lineItems.nodes[0]),
    id: 'gid://shopify/LineItem/' + (100 + i),
  }));
  remote = [o];
  fail = 'DynaLines';
  await assert.rejects(
    () => new Shopify(settings, credentials, transport).orders(),
    /odrzucił zapytanie/,
  );
  fail = '';
  hook = async (n) => {
    if (n === 'DynaLines') o.updatedAt = '2026-10-04T10:01:00.000Z';
  };
  try {
    await assert.rejects(
      () => new Shopify(settings, credentials, transport).orders(),
      /zmieniło się/,
    );
  } finally {
    hook = undefined;
  }
});
test('Shopify nie pozwala na nieskończony cursor ani obce zamówienie w relacji', async () => {
  const bad: Transport = async () =>
    json({
      data: { orders: { nodes: [fixture()], pageInfo: { hasNextPage: true, endCursor: 'same' } } },
    });
  await assert.rejects(() => new Shopify(settings, credentials, bad).orders('same'), /postępu/);
  const o = fixture();
  o.lineItems.nodes = Array.from({ length: 11 }, (_, i) => ({
    ...structuredClone(o.lineItems.nodes[0]),
    id: 'gid://shopify/LineItem/' + (100 + i),
  }));
  remote = [o];
  const wrong: Transport = async (u, i) =>
    String(i.body).includes('DynaLines')
      ? json({ data: { order: { id: 'gid://shopify/Order/1', updatedAt: o.updatedAt } } })
      : transport(u, i);
  await assert.rejects(() => new Shopify(settings, credentials, wrong).orders(), /zmieniło się/);
});
test('Shopify ponawia HTTP 429/503 oraz GraphQL THROTTLED z ograniczonym oczekiwaniem', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const t: Transport = async (u, i) => {
    n++;
    if (n === 1) return json({}, 429);
    if (n === 2)
      return json({
        errors: [{ extensions: { code: 'THROTTLED' } }],
        extensions: {
          cost: {
            requestedQueryCost: 500,
            throttleStatus: { currentlyAvailable: 0, restoreRate: 1 },
          },
        },
      });
    return transport(u, i);
  };
  remote = [fixture()];
  const r = await new Shopify(settings, credentials, t, async (ms) => {
    sleeps.push(ms);
  }).orders();
  assert.equal(r.data.length, 1);
  assert.deepEqual(sleeps, [1000, 5000]);
  n = 0;
  const s: Transport = async (u, i) => (++n === 1 ? json({}, 503) : transport(u, i));
  await new Shopify(settings, credentials, s, async () => {}).test();
  assert.equal(n, 2);
});
test('Shopify brak uprawnień i częściowy GraphQL nie ujawniają danych odpowiedzi', async () => {
  for (const t of [
    async () => json({ secret: 'NEVER_EXPOSE' }, 401),
    async () =>
      json({
        data: { shop: {} },
        errors: [{ message: 'NEVER_EXPOSE', extensions: { code: 'ACCESS_DENIED' } }],
      }),
  ] as Transport[]) {
    await assert.rejects(
      () => new Shopify(settings, credentials, t).test(),
      (e) => !String(e).includes('NEVER_EXPOSE'),
    );
  }
});
test('Shopify odrzuca brak/zmianę wersji API oraz odpowiedzi większe niż 5 MB', async () => {
  await assert.rejects(
    () => new Shopify(settings, credentials, async () => json({ data: {} }, 200, '2026-07')).test(),
    /wersję/,
  );
  await assert.rejects(
    () =>
      new Shopify(
        settings,
        credentials,
        async () =>
          new Response('x'.repeat(5 * 1024 * 1024 + 1), {
            headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
          }),
      ).test(),
    /5 MB/,
  );
});
test('Shopify test połączenia weryfikuje sklep i zakresy aplikacji', async () => {
  const missing: Transport = async () =>
    json({
      data: {
        shop: { myshopifyDomain: 'dyna-qa.myshopify.com' },
        currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }] },
      },
    });
  await assert.rejects(() => new Shopify(settings, credentials, missing).test(), /read_products/);
  const wrong: Transport = async () =>
    json({ data: { shop: { myshopifyDomain: 'other.myshopify.com' } } });
  await assert.rejects(() => new Shopify(settings, credentials, wrong).test(), /inny sklep/);
});
test('Shopify fetch-orders trwale odkłada stronę i zwraca cursor zamiast offsetu', async () => {
  remote = Array.from({ length: 6 }, (_, i) => fixture(99000 + i));
  const ch = await channel();
  const first = await req(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 1 });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().next_cursor, 'orders:5');
  assert.equal(first.json().data.length, 5);
  assert.equal(
    (await req(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 2 })).statusCode,
    422,
  );
  const last = await req(`/api/integrations/${ch}/fetch-orders`, 'POST', {
    page: 2,
    cursor: first.json().next_cursor,
  });
  assert.equal(last.statusCode, 200, last.body);
  assert.equal(last.json().has_more, false);
  assert.equal(await count(ch), 6);
  assert.equal((await req(`/api/integrations/${ch}/preview?resource=products`)).statusCode, 200);
  assert.equal((await req(`/api/integrations/${ch}/preview?resource=invoices`)).statusCode, 422);
});
test('Shopify import zachowuje kwotę źródłową i rezerwuje tylko raz mimo ponowień', async () => {
  const ch = await channel(),
    p = await mapped(ch),
    id = await stage(ch, fixture(99100));
  remote = [fixture(99100)];
  const source = (await req(`/api/integrations/${ch}/imports`)).json().data[0];
  const commit = () =>
    req(`/api/imports/${id}/commit`, 'POST', {
      warehouse_id: warehouse,
      expected_hash: source.source_hash,
    });
  const first = await commit();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().source, 'shopify');
  assert.equal(first.json().total, 3299);
  assert.equal(first.json().status, 'paid');
  assert.equal((await commit()).json().id, first.json().id);
  assert.equal(
    (
      await tenantTx(
        DEMO_TENANT,
        async (c) =>
          (await c.query('SELECT reserved FROM stock WHERE product_id=$1', [p.id])).rows[0],
      )
    ).reserved,
    2,
  );
  const changed = fixture(99100);
  changed.note = 'Zmienione źródło';
  changed.updatedAt = '2026-10-04T10:01:00.000Z';
  await stage(ch, changed);
  assert.equal((await commit()).statusCode, 409);
});
test('Shopify błąd jednej pozycji trafia do przeglądu; brak stanu nie rezerwuje częściowo', async () => {
  const ch = await channel();
  const p = await mapped(ch, 1),
    id = await stage(ch, fixture(99101));
  remote = [fixture(99101)];
  const source = (await req(`/api/integrations/${ch}/imports`)).json().data[0];
  assert.equal(
    (
      await req(`/api/imports/${id}/commit`, 'POST', {
        warehouse_id: warehouse,
        expected_hash: source.source_hash,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await tenantTx(
        DEMO_TENANT,
        async (c) =>
          (await c.query('SELECT reserved FROM stock WHERE product_id=$1', [p.id])).rows[0],
      )
    ).reserved,
    0,
  );
  const bad = fixture(99102);
  bad.email = null;
  await stage(ch, bad);
  const row = (await req(`/api/integrations/${ch}/imports`))
    .json()
    .data.find((r: any) => r.external_id === bad.id);
  assert.equal(row.state, 'error');
  assert.equal(row.normalized, null);
  assert.ok(row.issues.length);
});
test('Shopify mapowanie wymaga ID wariantu i respektuje role oraz RLS', async () => {
  const ch = await channel();
  assert.equal(
    (await req(`/api/integrations/${ch}/mappings`, 'POST', { external_id: '701', sku: 'QA' }))
      .statusCode,
    422,
  );
  for (const [session, status] of [
    [other, 404],
    [viewer, 403],
  ] as const) {
    assert.equal(
      (await req(`/api/integrations/${ch}/imports`, 'GET', undefined, session)).statusCode,
      status,
    );
    assert.equal(
      (await req(`/api/integrations/${ch}/fetch-orders`, 'POST', {}, session)).statusCode,
      status,
    );
  }
  assert.equal((await req(`/api/integrations/${ch}/sync`, 'POST', {}, viewer)).statusCode, 403);
});
test('Shopify harmonogram utrwala cursor dopiero po stronie i watermark po ostatniej', async () => {
  remote = Array.from({ length: 6 }, (_, i) => fixture(99200 + i));
  const ch = await channel();
  let job = await claim(ch);
  const window = job.payload.shopify_window;
  await processIntegrationJob(job, { transport });
  let j = await jobState(job.id);
  assert.equal(j.state, 'pending');
  assert.equal(j.payload.shopify_window.after, 'orders:5');
  let c = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM channels WHERE id=$1', [ch])).rows[0],
  );
  assert.equal(c.event_cursor, null);
  job = await claim(ch);
  await processIntegrationJob(job, { transport });
  j = await jobState(job.id);
  assert.equal(j.state, 'done');
  c = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM channels WHERE id=$1', [ch])).rows[0],
  );
  assert.equal(c.event_cursor, window.to);
  assert.equal(c.bootstrap_done, true);
  assert.equal(await count(ch), 6);
  const next = await claim(ch);
  assert.equal(
    next.payload.shopify_window.from,
    new Date(Date.parse(window.to) - 600000).toISOString(),
  );
  calls.length = 0;
  remote = [];
  await processIntegrationJob(next, { transport });
  assert.match(calls[0].body.variables.filter, /updated_at:>=/);
});
test('Shopify awaria GraphQL nie przesuwa checkpointu ani nie odkłada częściowej strony', async () => {
  remote = [fixture(99300)];
  const ch = await channel(),
    job = await claim(ch);
  fail = 'DynaOrders';
  await assert.rejects(() => processIntegrationJob(job, { transport }));
  fail = '';
  assert.equal((await jobState(job.id)).payload.shopify_window.after, null);
  assert.equal(await count(ch), 0);
  await processIntegrationJob(job, { transport });
  assert.equal(await count(ch), 1);
});
test('Shopify utrata dzierżawy przed HTTP zatrzymuje odczyt; po HTTP nie zapisuje strony', async () => {
  remote = [fixture(99301)];
  const ch = await channel(),
    job = await claim(ch);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]),
  );
  calls.length = 0;
  await processIntegrationJob(job, { transport });
  assert.equal(calls.length, 0);
  const ch2 = await channel(),
    job2 = await claim(ch2);
  hook = async (n) => {
    if (n === 'DynaOrders')
      await tenantTx(DEMO_TENANT, (c) =>
        c.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job2.id, randomUUID()]),
      );
  };
  try {
    await processIntegrationJob(job2, { transport });
    assert.equal(await count(ch2), 0);
  } finally {
    hook = undefined;
  }
});
test('Shopify pauza harmonogramu przed odczytem i podczas odpowiedzi nie przesuwa watermarku', async () => {
  remote = [fixture(99302)];
  for (const race of [false, true]) {
    const ch = await channel(true),
      job = await claim(ch);
    const pause = () =>
      tenantTx(DEMO_TENANT, (c) =>
        c.query('UPDATE channels SET sync_enabled=false WHERE id=$1', [ch]),
      );
    if (race)
      hook = async (n) => {
        if (n === 'DynaOrders') await pause();
      };
    else await pause();
    try {
      calls.length = 0;
      await processIntegrationJob(job, { transport });
      assert.equal(await count(ch), 0);
      assert.equal((await jobState(job.id)).state, 'done');
      if (!race) assert.equal(calls.length, 0);
      assert.equal(
        (
          await tenantTx(
            DEMO_TENANT,
            async (c) =>
              (await c.query('SELECT event_cursor FROM channels WHERE id=$1', [ch])).rows[0],
          )
        ).event_cursor,
        null,
      );
    } finally {
      hook = undefined;
    }
  }
});
test('Shopify zmiana konfiguracji/tokenu w trakcie odpowiedzi nie zatwierdza starych danych', async () => {
  remote = [fixture(99303)];
  const ch = await channel(),
    job = await claim(ch);
  hook = async (n) => {
    if (n === 'DynaOrders')
      await tenantTx(DEMO_TENANT, (c) =>
        c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
          ch,
          encrypt({ access_token: 'shpat_' + 'b'.repeat(32) }),
        ]),
      );
  };
  try {
    await processIntegrationJob(job, { transport });
    assert.equal(await count(ch), 0);
    assert.match((await jobState(job.id)).error, /konfiguracji/);
  } finally {
    hook = undefined;
  }
});
test('Shopify cofnięcie roli w czasie odczytu zatrzymuje lokalny zapis', async () => {
  remote = [fixture(99304)];
  const ch = await channel(),
    job = await claim(ch);
  hook = async (n) => {
    if (n === 'DynaOrders')
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        job.payload.actor_id,
      ]);
  };
  try {
    await processIntegrationJob(job, { transport });
    assert.equal((await jobState(job.id)).state, 'done');
  } finally {
    hook = undefined;
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      job.payload.actor_id,
    ]);
  }
  assert.equal(await count(ch), 0);
});
test('Shopify duplikat zlecenia korzysta z tego samego zadania', async () => {
  const ch = await channel();
  const a = await req(`/api/integrations/${ch}/sync`, 'POST'),
    b = await req(`/api/integrations/${ch}/sync`, 'POST');
  assert.equal(a.json().id, b.json().id);
  assert.equal(b.json().reused, true);
});
test('Shopify przykład lokalny ma jawny zakres symulacji i nie kontaktuje API', async () => {
  calls.length = 0;
  const a = await req('/api/integrations/shopify-example', 'POST'),
    b = await req('/api/integrations/shopify-example', 'POST');
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().scope, 'local_simulation');
  assert.equal(a.json().data[0].id, b.json().data[0].id);
  assert.equal(calls.length, 0);
  const ch = a.json().channel_id;
  assert.equal((await req(`/api/integrations/${ch}/test`, 'POST')).statusCode, 422);
  assert.equal((await req(`/api/integrations/${ch}/sync`, 'POST')).statusCode, 422);
  assert.equal(
    (await req('/api/integrations/shopify-example', 'POST', {}, viewer)).statusCode,
    403,
  );
});
