import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { cents, normalizeOrder } from '../server/imports';
import { demoWooOrder } from '../server/import-routes';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance,
  cookie: string,
  otherCookie: string,
  viewerCookie: string,
  warehouse: string;
let apiCalls: URL[] = [];
const raw = (id = 97001) => ({ ...structuredClone(demoWooOrder), id });
const allegroRaw = () => ({
  id: 'allegro-qa',
  status: 'READY_FOR_PROCESSING',
  buyer: { email: 'allegro@example.test' },
  payment: { type: 'ONLINE', paidAmount: { amount: '35.00', currency: 'PLN' } },
  delivery: {
    address: {
      firstName: 'Jan',
      lastName: 'Test',
      street: 'Testowa 1',
      city: 'Warszawa',
      zipCode: '00-001',
      countryCode: 'PL',
    },
    cost: { amount: '5.00', currency: 'PLN' },
  },
  summary: { totalToPay: { amount: '35.00', currency: 'PLN' } },
  lineItems: [
    {
      offer: { id: 'offer-1', name: 'Oferta', external: { id: 'SKU' } },
      quantity: 3,
      price: { amount: '10.00', currency: 'PLN' },
    },
  ],
});
const req = (url: string, method: any = 'GET', payload?: any, session = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: session } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async (url) => {
      const u = new URL(url);
      apiCalls.push(u);
      if (u.pathname === '/order/checkout-forms')
        return new Response(JSON.stringify({ checkoutForms: [allegroRaw()], totalCount: 1 }), {
          status: 200,
        });
      const data =
        Number(u.searchParams.get('page')) === 1
          ? Array.from({ length: 50 }, (_, i) => raw(80000 + i))
          : [raw(80050)];
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  otherCookie = await login('other@demo.local');
  viewerCookie = await login('viewer@demo.local');
  warehouse = (await req('/api/warehouses')).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function channel(provider = 'woocommerce') {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        DEMO_TENANT,
        provider,
        'Test importu',
        'sandbox',
        encrypt({ consumer_key: 'test', consumer_secret: 'test', access_token: 'test' }),
        JSON.stringify({ store_url: 'https://example.com' }),
      ],
    ),
  );
  return id;
}
async function product(quantity = 20) {
  const sku = `IMPORT-${randomUUID().slice(0, 8)}`;
  const r = await req('/api/products', 'POST', {
    name: 'Produkt lokalny importu',
    sku,
    warehouse_id: warehouse,
    quantity,
    price: 29999,
    vat: 23,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function stage(ch: string, orders: any[]): Promise<{ id: string; state: string }[]> {
  const r = await req(`/api/integrations/${ch}/stage-orders`, 'POST', { data: orders });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data;
}
async function link(ch: string, sku: string, external = '701') {
  const r = await req(`/api/integrations/${ch}/mappings`, 'POST', { external_id: external, sku });
  assert.equal(r.statusCode, 200, r.body);
}
const commit = (id: string) =>
  req(`/api/imports/${id}/commit`, 'POST', { warehouse_id: warehouse });
async function stock(id: string) {
  return (await req('/api/inventory?product_id=' + id))
    .json()
    .data.find((s: any) => s.product_id === id && s.warehouse_id === warehouse);
}
test('grosze są dokładne; brak cichego zaokrąglania i błędnych sum', () => {
  assert.equal(cents('100.01'), 10001);
  assert.equal(cents('0.1'), 10);
  for (const value of ['1.001', '1e2', '-1.00', 'NaN', 1.23]) assert.throws(() => cents(value));
  const o = normalizeOrder('woocommerce', raw());
  assert.equal(o.items[0].line_total, 9501);
  assert.throws(() => normalizeOrder('woocommerce', { ...raw(), total: '99.00' }), /Suma pozycji/);
  assert.throws(() => normalizeOrder('woocommerce', { ...raw(), billing: { email: 'bad' } }));
});
test('Allegro wymaga ukończonego formularza; pobranie nie jest oznaczane jako zapłacone', () => {
  const a = {
    id: 'allegro-order',
    status: 'READY_FOR_PROCESSING',
    buyer: { email: 'allegro@example.test' },
    payment: { type: 'CASH_ON_DELIVERY', paidAmount: null },
    delivery: {
      address: {
        firstName: 'Jan',
        lastName: 'Test',
        street: 'Testowa 1',
        city: 'Warszawa',
        zipCode: '00-001',
        countryCode: 'PL',
      },
      cost: { amount: '5.00', currency: 'PLN' },
    },
    summary: { totalToPay: { amount: '35.00', currency: 'PLN' } },
    lineItems: [
      {
        offer: { id: 'offer-1', name: 'Oferta', external: { id: 'SKU' } },
        quantity: 3,
        price: { amount: '10.00', currency: 'PLN' },
      },
    ],
  };
  const o = normalizeOrder('allegro', a);
  assert.equal(o.paid, false);
  assert.equal(o.payment_mode, 'cod');
  assert.equal(o.paid_amount, 0);
  assert.equal(o.blockers.length, 0);
  const paid = normalizeOrder('allegro', {
    ...a,
    payment: { type: 'ONLINE', paidAmount: { amount: '35.00', currency: 'PLN' } },
  });
  assert.equal(paid.paid, true);
  assert.equal(paid.blockers.length, 0);
  assert.match(
    normalizeOrder('allegro', { ...a, status: 'FILLED_IN' }).blockers.join(' '),
    /formularz/,
  );
});
test('brak mapowania zatrzymuje import; konkurencyjne ponowienia rezerwują dokładnie raz', async () => {
  const ch = await channel(),
    p = await product();
  const [s] = await stage(ch, [raw()]);
  let r = await commit(s.id);
  assert.equal(r.statusCode, 422, r.body);
  assert.match(r.json().detail, /Brak powiązania/);
  assert.equal((await stock(p.id)).reserved, 0);
  await link(ch, p.sku);
  const results = await Promise.all([commit(s.id), commit(s.id), commit(s.id)]);
  results.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal(new Set(results.map((r) => r.json().id)).size, 1);
  const order = results[0].json();
  assert.equal(order.source, 'woocommerce');
  assert.equal(order.external_id, '97001');
  assert.equal(order.status, 'paid');
  assert.equal(order.total, 10001);
  assert.equal(order.items[0].line_total, 9501);
  assert.equal(order.items[0].price, 3167);
  assert.equal((await stock(p.id)).reserved, 3);
  assert.equal((await stock(p.id)).on_hand, 20);
  r = await req(`/api/orders/${order.id}/documents`, 'POST', { kind: 'invoice' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().data.total, 10001);
  assert.equal(r.json().data.items[0].gross, 9501);
  assert.equal(r.json().data.vat_source, 'local_catalog');
  const again = await stage(ch, [raw()]);
  assert.equal(again[0].id, s.id);
  assert.equal((await commit(s.id)).json().id, order.id);
});
test('rabat z resztą groszową pozostaje w wartości całej pozycji', async () => {
  const ch = await channel(),
    p = await product();
  await link(ch, p.sku);
  const o = raw();
  o.line_items[0].total = '77.23';
  o.total = '100.00';
  const [s] = await stage(ch, [o]);
  const r = await commit(s.id);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().items[0].line_total, 9500);
  assert.equal(r.json().items[0].price * 3, 9498);
  assert.equal(r.json().total, 10000);
  const doc = await req(`/api/orders/${r.json().id}/documents`, 'POST', { kind: 'invoice' });
  assert.equal(doc.json().data.items[0].gross, 9500);
});
test('zmiana źródła po imporcie jest widoczna i nie nadpisuje realizowanego zamówienia', async () => {
  const ch = await channel(),
    p = await product();
  await link(ch, p.sku);
  const [s] = await stage(ch, [raw()]);
  const r = await commit(s.id);
  assert.equal(r.statusCode, 200, r.body);
  const changed = raw();
  changed.customer_note = 'Zmieniono';
  await stage(ch, [changed]);
  const repeat = await commit(s.id);
  assert.equal(repeat.statusCode, 409, repeat.body);
  const queue = (await req(`/api/integrations/${ch}/imports`)).json();
  assert.equal(queue.data[0].source_changed, true);
  assert.equal(queue.data[0].order_id, r.json().id);
  assert.equal((await stock(p.id)).reserved, 3);
  assert.equal((await req(`/api/orders/${r.json().id}`)).json().note, demoWooOrder.customer_note);
});
test('konkurujące zamówienia nie rezerwują brakującego towaru; drugi import można ponowić po dostawie', async () => {
  const ch = await channel(),
    p = await product(3);
  await link(ch, p.sku);
  const staged = await stage(ch, [raw(1001), raw(1002)]);
  const results = await Promise.all(staged.map((s) => commit(s.id)));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await stock(p.id)).reserved, 3);
  const failed = staged[results.findIndex((r) => r.statusCode === 409)];
  const adjust = await req('/api/inventory/adjust', 'POST', {
    warehouse_id: warehouse,
    product_id: p.id,
    delta: 3,
    note: 'Dostawa po braku stanu',
  });
  assert.equal(adjust.statusCode, 200, adjust.body);
  assert.equal((await commit(failed.id)).statusCode, 200);
  assert.equal((await stock(p.id)).reserved, 6);
});
test('niekompletne dane pozostają w kolejce błędów bez rezerwacji', async () => {
  const ch = await channel();
  const [s] = await stage(ch, [{ ...raw(), total: '1.00' }]);
  assert.equal(s.state, 'error');
  const r = await commit(s.id);
  assert.equal(r.statusCode, 422, r.body);
  const queue = (await req(`/api/integrations/${ch}/imports`)).json();
  assert.equal(queue.data[0].normalized, null);
  assert.match(queue.data[0].issues.join(' '), /Suma pozycji/);
});
test('kanały, mapowania i importy są izolowane między firmami i chronione rolą', async () => {
  const ch = await channel(),
    p = await product();
  const [s] = await stage(ch, [raw()]);
  assert.equal(
    (await req(`/api/integrations/${ch}/imports`, 'GET', undefined, otherCookie)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/api/imports/${s.id}/commit`, 'POST', { warehouse_id: warehouse }, otherCookie))
      .statusCode,
    404,
  );
  assert.equal(
    (await req(`/api/integrations/${ch}/imports`, 'GET', undefined, viewerCookie)).statusCode,
    403,
  );
  assert.equal(
    (
      await req(`/api/integrations/${ch}/mappings`, 'POST', {
        external_id: '701',
        sku: 'PRIVATE-001',
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await tenantTx(SECOND_TENANT, (c) => c.query('SELECT * FROM inbound_orders'))).rowCount,
    0,
  );
  await link(ch, p.sku);
});
test('pobieranie stron używa konektora, zapisuje deduplikowane rekordy i przebiegi', async () => {
  apiCalls = [];
  const ch = await channel();
  const a = await req(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 1 });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().data.length, 50);
  assert.equal(a.json().has_more, true);
  const b = await req(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 2 });
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.json().has_more, false);
  assert.equal(apiCalls[1].pathname, '/wp-json/wc/v3/orders');
  assert.equal(apiCalls[1].searchParams.get('page'), '2');
  await req(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 1 });
  const count = await tenantTx(DEMO_TENANT, (c) =>
    c.query('SELECT count(*)::int AS count FROM inbound_orders WHERE channel_id=$1', [ch]),
  );
  assert.equal(count.rows[0].count, 51);
});
test('lokalny przykład jest jednoznacznie oznaczony i nie może połączyć się z zewnętrznym API', async () => {
  const [a, b] = await Promise.all([
    req('/api/integrations/demo-import', 'POST'),
    req('/api/integrations/demo-import', 'POST'),
  ]);
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().channel_id, b.json().channel_id);
  const ch = a.json().channel_id;
  assert.equal(a.json().scope, 'local_simulation');
  for (const [path, method] of [
    ['test', 'POST'],
    ['preview', 'GET'],
    ['fetch-orders', 'POST'],
  ])
    assert.equal((await req(`/api/integrations/${ch}/${path}`, method)).statusCode, 422);
  assert.equal((await req(`/api/integrations/${ch}/imports`)).json().channel.simulation, true);
});
test('Allegro sandbox: pobranie formularza, mapowanie i import z ceną oferty', async () => {
  const ch = await channel('allegro'),
    p = await product();
  await link(ch, p.sku, 'offer-1');
  const r = await req(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 1 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(apiCalls.at(-1)!.hostname, 'api.allegro.pl.allegrosandbox.pl');
  const imported = await commit(r.json().data[0].id);
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().source, 'allegro');
  assert.equal(imported.json().total, 3500);
  assert.equal(imported.json().items[0].line_total, 3000);
  assert.equal((await stock(p.id)).reserved, 3);
});
test('import w innej walucie lub obcym magazynie nie tworzy zamówienia ani rezerwacji', async () => {
  const ch = await channel(),
    p = await product();
  await link(ch, p.sku);
  const [s] = await stage(ch, [{ ...raw(), currency: 'EUR' }]);
  assert.equal((await commit(s.id)).statusCode, 422);
  assert.equal((await stock(p.id)).reserved, 0);
  const [valid] = await stage(ch, [raw(88888)]);
  const foreign = (await req('/api/warehouses', 'GET', undefined, otherCookie)).json().data[0].id;
  assert.equal(
    (await req(`/api/imports/${valid.id}/commit`, 'POST', { warehouse_id: foreign })).statusCode,
    404,
  );
  assert.equal((await stock(p.id)).reserved, 0);
});
test('wiele ofert powiązanych z jednym SKU daje jedną pozycję i dokładną sumę rezerwacji', async () => {
  const ch = await channel(),
    p = await product();
  await link(ch, p.sku);
  await link(ch, p.sku, '702');
  const o = raw();
  o.line_items.push({
    ...o.line_items[0],
    product_id: 702,
    quantity: 2,
    total: '10.00',
    total_tax: '2.30',
  });
  o.total = '112.31';
  const [s] = await stage(ch, [o]);
  const r = await commit(s.id);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().items.length, 1);
  assert.equal(r.json().items[0].quantity, 5);
  assert.equal(r.json().items[0].line_total, 10731);
  assert.equal((await stock(p.id)).reserved, 5);
});
test('264: import ustala opłacenie z API — przelew bez wpłaty → new (Nieopłacone), pobranie → paid (Nowe)', async () => {
  const ch = await channel(),
    p = await product();
  await link(ch, p.sku);
  const unpaid = { ...raw(97264), status: 'on-hold', date_paid: null };
  const cod = { ...raw(97265), date_paid: null, payment_method: 'cod' };
  const [a, b] = await stage(ch, [unpaid, cod]);
  const ra = await commit(a.id),
    rb = await commit(b.id);
  assert.equal(ra.statusCode, 200, ra.body);
  assert.equal(rb.statusCode, 200, rb.body);
  assert.equal(ra.json().status, 'new');
  assert.equal(rb.json().status, 'paid');
  assert.equal(rb.json().payment_mode, 'cod');
  for (const o of [ra.json(), rb.json()])
    assert.equal((await req(`/api/orders/${o.id}/payments`)).json().balance.received, 0, 'bez deklaracji wpłaty ze źródła');
  const pick = await req(`/api/orders/${ra.json().id}/status`, 'PATCH', { status: 'picking', expected_version: String(ra.json().version) });
  assert.equal(pick.statusCode, 409, pick.body);
});
