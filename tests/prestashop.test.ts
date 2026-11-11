import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, tenantTx, migrate } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { demoPrestaOrder } from '../server/prestashop-example';
import { PrestaShop, ApiClient, type Transport } from '../server/integrations';
import { normalizeOrder } from '../server/imports';
import { psCents, allocatePs } from '../server/prestashop-orders';
import { processIntegrationJob } from '../server/sync';
assert.equal(process.env.DYNA_TEST, 'true');
const settings = { store_url: 'https://shop.example', shop_id: '1', order_state_ids: '2,3' };
const creds = { api_key: 'A'.repeat(32) };
const fixture = (id = 98001) => {
  const o = structuredClone(demoPrestaOrder);
  o.id = String(id);
  o._dyna.details[0].id_order = o.id;
  o._dyna.details[0].id = String(id * 10 + 1);
  o.associations.order_rows[0].id = o._dyna.details[0].id;
  o._dyna.cart_rules[0].id_order = o.id;
  o._dyna.cart_rules[0].id = String(id * 10 + 2);
  return o;
};
let remote: any[] = [fixture()];
let brokenResource = '';
let missingResource = '';
let denied = false;
const calls: { url: URL; init: RequestInit }[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const transport: Transport = async (url, init) => {
  const u = new URL(url);
  calls.push({ url: u, init });
  assert.equal(init.method, 'GET', 'PrestaShop read path never writes provider');
  const resource = u.pathname.split('/').at(-1)!;
  if (denied) return json({ token: 'NEVER_EXPOSE' }, 401);
  if (brokenResource === resource) return json({ broken: true });
  if (missingResource === resource) return json({ [resource]: [] });
  let data: any[] = [];
  if (resource === 'orders') {
    data = remote;
    const range = u.searchParams.get('filter[id]');
    if (range) data = data.filter((v) => BigInt(v.id) >= BigInt(range.slice(1, -1).split(',')[0]));
    const [a, b] = (u.searchParams.get('limit') ?? '0,5').split(',').map(Number);
    data = b === undefined ? data.slice(0, a) : data.slice(a, a + b);
    data = data.map((v) => ({ ...v, _dyna: undefined, secure_key: 'NEVER_EXPOSE' }));
  } else if (resource === 'products')
    data = [
      {
        id: '701',
        reference: 'QA-DODATEK',
        name: [{ id: '1', value: 'Produkt' }],
        price: '10.000000',
        active: '1',
        id_default_combination: '0',
      },
    ];
  else {
    const key: Record<string, string> = {
      customers: 'customer',
      addresses: 'address',
      currencies: 'currency',
      countries: 'country',
      order_states: 'state',
      order_details: 'details',
      order_cart_rules: 'cart_rules',
    };
    data = remote.flatMap((v) =>
      Array.isArray(v._dyna[key[resource]]) ? v._dyna[key[resource]] : [v._dyna[key[resource]]],
    );
    data = [
      ...new Map(
        data.map((v) => [v.id, { ...v, passwd: 'NEVER_EXPOSE', secure_key: 'NEVER_EXPOSE' }]),
      ).values(),
    ];
    const ids = u.searchParams.get('filter[id]');
    if (ids) data = data.filter((v) => ids.slice(1, -1).split('|').includes(v.id));
    const orderIds = u.searchParams.get('filter[id_order]');
    if (orderIds) data = data.filter((v) => orderIds.slice(1, -1).split('|').includes(v.id_order));
  }
  return json({ [resource]: data });
};
let app: FastifyInstance,
  cookie: string,
  otherCookie: string,
  viewerCookie: string,
  warehouse: string;
const req = (url: string, method: any = 'GET', payload?: any, session = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: session } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
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
async function channel() {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        DEMO_TENANT,
        'prestashop',
        'QA PrestaShop',
        'sandbox',
        encrypt(creds),
        JSON.stringify(settings),
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
async function mapped(ch: string, o: any, stock = 20) {
  const sku = 'PRESTA-' + randomUUID().slice(0, 8);
  const p = await req('/api/products', 'POST', {
    sku,
    name: 'Presta QA lokalny',
    warehouse_id: warehouse,
    quantity: stock,
    price: 99999,
    vat: 23,
  });
  assert.equal(p.statusCode, 201, p.body);
  const r = await req(`/api/integrations/${ch}/mappings`, 'POST', {
    external_id: `${o._dyna.details[0].product_id}:${o._dyna.details[0].product_attribute_id}`,
    sku,
  });
  assert.equal(r.statusCode, 200, r.body);
  return p.json();
}
async function claimed(ch: string) {
  const q = await req(`/api/integrations/${ch}/sync`, 'POST');
  assert.equal(q.statusCode, 200, q.body);
  return tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          "UPDATE jobs SET state='running',lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
          [q.json().id, randomUUID()],
        )
      ).rows[0],
  );
}

test('PS pieniądze: 6 miejsc, dokładny rabat i niepodzielny grosz', () => {
  assert.equal(psCents('32.990000'), 3299);
  assert.equal(psCents('0.005000'), 1);
  assert.throws(() => psCents('0.0000001'));
  assert.throws(() => psCents(32.99));
  assert.deepEqual(allocatePs(10001, [1n, 1n, 1n]), [3334, 3334, 3333]);
  const o = normalizeOrder('prestashop', fixture(), settings);
  assert.equal(o.total, 3299);
  assert.equal(o.shipping_cost, 500);
  assert.equal(o.items[0].line_total, 2799);
  assert.equal(o.paid, true);
  assert.deepEqual(o.blockers, []);
});
test('PS respektuje wszystkie sześć trybów zaokrąglania sklepu', () => {
  assert.equal(psCents('1.001000', 0), 101);
  assert.equal(psCents('1.009000', 1), 100);
  assert.equal(psCents('1.005000', 2), 101);
  assert.equal(psCents('1.005000', 3), 100);
  assert.equal(psCents('1.005000', 4), 100);
  assert.equal(psCents('1.015000', 4), 102);
  assert.equal(psCents('1.005000', 5), 101);
  assert.equal(psCents('1.015000', 5), 101);
  assert.throws(() => psCents('1.00', 6));
});
test('PS darmowa dostawa: rabat zmniejsza dostawę, reszta trafia do produktów', () => {
  const raw = fixture();
  raw.total_discounts_tax_incl = '7.010000';
  raw.total_paid_tax_incl = raw.total_paid_real = '27.990000';
  raw._dyna.cart_rules[0].value = '7.010000';
  raw._dyna.cart_rules[0].free_shipping = '1';
  const o = normalizeOrder('prestashop', raw, settings);
  assert.equal(o.shipping_cost, 0);
  assert.equal(o.items[0].line_total, 2799);
});
test('PS warianty mają oddzielne powiązania produktu i kombinacji', () => {
  const raw = fixture();
  raw.associations.order_rows[0].product_attribute_id = raw._dyna.details[0].product_attribute_id =
    '77';
  assert.equal(normalizeOrder('prestashop', raw, settings).items[0].external_id, '701:77');
});
test('PS sprawdza sklep, właściciela adresu i kompletność pozycji', () => {
  for (const change of [
    (o: any) => (o.id_shop = '2'),
    (o: any) => (o._dyna.address.id_customer = '99'),
    (o: any) => (o._dyna.details[0].id_order = '99'),
    (o: any) => (o._dyna.details = []),
    (o: any) => o._dyna.details.push(o._dyna.details[0]),
    (o: any) => (o._dyna.currency.id = '9'),
  ]) {
    const raw = fixture();
    change(raw);
    assert.throws(() => normalizeOrder('prestashop', raw, settings));
  }
});
test('PS nie realizuje ponownie wysłanych, refundowanych ani niedopłaconych zamówień', () => {
  for (const change of [
    (o: any) => (o._dyna.state.shipped = '1'),
    (o: any) => (o._dyna.details[0].product_quantity_refunded = '1'),
    (o: any) => (o.total_paid_real = '1.000000'),
    (o: any) => (o.module = 'ps_cashondelivery'),
    (o: any) => {
      o.current_state = o._dyna.state.id = '6';
    },
  ]) {
    const raw = fixture();
    change(raw);
    assert.ok(normalizeOrder('prestashop', raw, settings).blockers.length);
  }
});
test('PS oczekiwanie na przelew nie zostaje automatycznie oznaczone jako opłacone', () => {
  const raw = fixture();
  raw._dyna.state.paid = '0';
  raw.total_paid_real = '0.000000';
  const o = normalizeOrder('prestashop', raw, settings);
  assert.equal(o.paid, false);
  assert.deepEqual(o.blockers, []);
  raw.total_paid_real = '10.000000';
  const partial = normalizeOrder('prestashop', raw, settings);
  assert.equal(partial.paid, false);
  assert.equal(partial.paid_amount, 1000);
  assert.deepEqual(partial.blockers, []);
  for (const [paidState, amount, module] of [
    ['1', '10.000000', raw.module],
    ['0', raw.total_paid_tax_incl, raw.module],
    ['0', '34.000000', raw.module],
    ['1', '34.000000', raw.module],
    ['0', '10.000000', 'ps_cashondelivery'],
  ]) {
    const contradictory = fixture();
    contradictory._dyna.state.paid = paidState;
    contradictory.total_paid_real = amount;
    contradictory.module = module;
    assert.ok(
      normalizeOrder('prestashop', contradictory, settings).blockers.length,
      'Contradictory payment declaration must remain blocked: ' +
        paidState +
        '/' +
        amount +
        '/' +
        module,
    );
  }
});
test('PS nie ukrywa niezgodności sum, brakujących rabatów i błędnych flag', () => {
  for (const change of [
    (o: any) => (o.total_products_wt = '50.000000'),
    (o: any) => (o._dyna.cart_rules = []),
    (o: any) => (o._dyna.state.paid = 'yes'),
    (o: any) => (o.total_paid_tax_incl = '33.000000'),
    (o: any) => (o._dyna.details[0].total_price_tax_incl = '20.000000'),
  ]) {
    const raw = fixture();
    change(raw);
    assert.throws(() => normalizeOrder('prestashop', raw, settings));
  }
});
test('PS HTTP: Basic w nagłówku, scope sklepu, strony i oczyszczony snapshot', async () => {
  remote = [fixture()];
  calls.length = 0;
  const c = new PrestaShop(settings, creds, transport);
  const r = await c.orders();
  assert.equal(r.data.length, 1);
  assert.equal(r.has_more, false);
  assert.equal(r.next_id, '98001');
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('output_format'), 'JSON');
    assert.equal(call.url.searchParams.get('id_shop'), '1');
    assert.equal(
      (call.init.headers as any).Authorization,
      'Basic ' + Buffer.from(creds.api_key + ':').toString('base64'),
    );
    assert.ok(!call.url.toString().includes(creds.api_key));
  }
  assert.ok(!JSON.stringify(r).includes('NEVER_EXPOSE'));
  assert.deepEqual(normalizeOrder('prestashop', r.data[0], settings).blockers, []);
  calls.length = 0;
  await c.orders(3);
  assert.equal(calls[0].url.searchParams.get('limit'), '10,5');
  const products = await c.products(2);
  assert.equal(products.prices, 'tax_exclusive');
  assert.equal(calls.at(-1)!.url.searchParams.get('limit'), '50,50');
});
test('PS nie akceptuje odpowiedzi bez relacji, spoza sklepu i poza granicami zasobów', async () => {
  remote = [fixture()];
  brokenResource = 'currencies';
  await assert.rejects(() => new PrestaShop(settings, creds, transport).orders(), /Nieprawidłowa/);
  brokenResource = '';
  remote = [{ ...fixture(), id_shop: '2' }];
  await assert.rejects(() => new PrestaShop(settings, creds, transport).orders(), /innego sklepu/);
  remote = [fixture()];
  await assert.rejects(
    () =>
      new PrestaShop(settings, creds, async () =>
        json({
          orders: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), id_shop: '1' })),
        }),
      ).orders(),
    /zbyt duża/,
  );
});
test('PS konfiguracja: klucz, zakres sklepu i jawne statusy wymagane', () => {
  assert.throws(() => new PrestaShop(settings, { api_key: 'wrong' }, transport));
  assert.throws(() => new PrestaShop({ ...settings, shop_id: '0' }, creds, transport));
  assert.throws(() => new PrestaShop({ ...settings, order_state_ids: '' }, creds, transport));
});
test('PS brak uprawnień nie ujawnia odpowiedzi dostawcy', async () => {
  denied = true;
  await assert.rejects(() => new PrestaShop(settings, creds, transport).orders(), /HTTP 401/);
  denied = false;
});
test('JSON wszystkich konektorów ma limit 5 MB', async () => {
  const c = new ApiClient(
    'https://shop.example',
    {},
    async () => new Response('"' + 'a'.repeat(5 * 1024 * 1024) + '"'),
  );
  await assert.rejects(() => c.request('/api/orders'), /Nieprawidłowa odpowiedź JSON/);
});
test('PS fetch-orders pobiera relacje i trwale odkłada import; produktowy podgląd nie zapisuje ofert', async () => {
  remote = [fixture()];
  const ch = await channel();
  const r = await req(`/api/integrations/${ch}/fetch-orders`, 'POST', { page: 1 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().data.length, 1);
  const queue = (await req(`/api/integrations/${ch}/imports`)).json();
  assert.deepEqual(queue.data[0].issues, []);
  assert.equal(queue.data[0].normalized.total, 3299);
  const preview = await req(`/api/integrations/${ch}/preview?resource=products`);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().prices, 'tax_exclusive');
  assert.equal((await req(`/api/integrations/${ch}/preview?resource=invoices`)).statusCode, 422);
});
test('PS import zachowuje kwotę źródłową, rezerwuje raz i uzgadnia zmienione źródło', async () => {
  const ch = await channel(),
    raw = fixture(98100);
  const p = await mapped(ch, raw);
  const id = await stage(ch, raw);
  const commit = () => req(`/api/imports/${id}/commit`, 'POST', { warehouse_id: warehouse });
  const first = await commit();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().source, 'prestashop');
  assert.equal(first.json().status, 'paid');
  assert.equal(first.json().total, 3299);
  assert.equal(first.json().items[0].line_total, 2799);
  const replay = await commit();
  assert.equal(replay.json().id, first.json().id);
  const stock = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [
          p.id,
          warehouse,
        ])
      ).rows[0],
  );
  assert.equal(stock.reserved, 2);
  raw.note = 'Źródło zmienione';
  await stage(ch, raw);
  assert.equal((await commit()).statusCode, 409);
});
test('PS błędy źródła i brak stanów nie tworzą zamówienia ani rezerwacji', async () => {
  const ch = await channel(),
    raw = fixture(98101);
  const p = await mapped(ch, raw, 1);
  const id = await stage(ch, raw);
  assert.equal(
    (await req(`/api/imports/${id}/commit`, 'POST', { warehouse_id: warehouse })).statusCode,
    409,
  );
  const stock = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT reserved FROM stock WHERE product_id=$1', [p.id])).rows[0],
  );
  assert.equal(stock.reserved, 0);
  raw._dyna.state.shipped = '1';
  await stage(ch, raw);
  assert.equal(
    (await req(`/api/imports/${id}/commit`, 'POST', { warehouse_id: warehouse })).statusCode,
    422,
  );
});
test('PS import i synchronizacja respektują RLS oraz rolę administratora', async () => {
  const ch = await channel();
  for (const [session, status] of [
    [otherCookie, 404],
    [viewerCookie, 403],
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
  assert.equal(
    (await req(`/api/integrations/${ch}/sync`, 'POST', {}, viewerCookie)).statusCode,
    403,
  );
});
test('PS harmonogram używa checkpointu ID; po usunięciu rekordu nie pomija następnego', async () => {
  remote = Array.from({ length: 6 }, (_, i) => fixture(99001 + i));
  const ch = await channel();
  let job = await claimed(ch);
  await processIntegrationJob(job, { transport });
  const current = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0],
  );
  assert.equal(current.state, 'pending');
  assert.equal(current.payload.prestashop_after, '99005');
  remote = remote.slice(1);
  calls.length = 0;
  job = await claimed(ch);
  await processIntegrationJob(job, { transport });
  assert.equal(calls[0].url.searchParams.get('filter[id]'), '[99006,9999999999]');
  const end = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0],
  );
  assert.equal(end.state, 'done');
  const queue = (await req(`/api/integrations/${ch}/imports`)).json();
  assert.equal(queue.data.length, 6);
  assert.equal((await req(`/api/integrations/${ch}/sync`)).json().webhook_url, null);
});
test('PS awaria relacji nie przesuwa checkpointu; ponowienie pobiera całą stronę', async () => {
  remote = [fixture(99100)];
  const ch = await channel();
  const job = await claimed(ch);
  brokenResource = 'addresses';
  await assert.rejects(() => processIntegrationJob(job, { transport }));
  brokenResource = '';
  const unchanged = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT payload FROM jobs WHERE id=$1', [job.id])).rows[0],
  );
  assert.equal(unchanged.payload.prestashop_after, undefined);
  assert.equal((await req(`/api/integrations/${ch}/imports`)).json().data.length, 0);
  await processIntegrationJob(job, { transport });
  assert.equal((await req(`/api/integrations/${ch}/imports`)).json().data.length, 1);
});
test('PS stara dzierżawa nie zapisuje strony po nowym przejęciu zadania', async () => {
  remote = [fixture(99200)];
  const ch = await channel();
  const job = await claimed(ch);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]),
  );
  await processIntegrationJob(job, { transport });
  assert.equal((await req(`/api/integrations/${ch}/imports`)).json().data.length, 0);
});
test('PS lokalny przykład jest idempotentny i nie udaje weryfikacji API', async () => {
  const a = await req('/api/integrations/prestashop-example', 'POST'),
    b = await req('/api/integrations/prestashop-example', 'POST');
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().channel_id, b.json().channel_id);
  assert.equal(a.json().data[0].id, b.json().data[0].id);
  const ch = a.json().channel_id;
  calls.length = 0;
  assert.equal((await req(`/api/integrations/${ch}/test`, 'POST')).statusCode, 422);
  assert.equal((await req(`/api/integrations/${ch}/sync`, 'POST')).statusCode, 422);
  assert.equal(calls.length, 0);
  assert.equal(
    (await req('/api/integrations/prestashop-example', 'POST', {}, viewerCookie)).statusCode,
    403,
  );
});
test('PS usunięty adres trafia do błędów importu i nie blokuje całego harmonogramu', async () => {
  remote = [fixture(99300)];
  const ch = await channel();
  const job = await claimed(ch);
  missingResource = 'addresses';
  await processIntegrationJob(job, { transport });
  missingResource = '';
  const queue = (await req(`/api/integrations/${ch}/imports`)).json();
  assert.equal(queue.data.length, 1);
  assert.equal(queue.data[0].state, 'error');
  assert.equal(queue.data[0].normalized, null);
  assert.ok(queue.data[0].issues.length);
  const state = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0],
  );
  assert.equal(state.state, 'done');
});
