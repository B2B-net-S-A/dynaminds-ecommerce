/** Lane L: channel data from real imports and manual orders — rule context, rule test, order card, list filters, catalog. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { loadOrderContexts } from '../server/automation-v2-context';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, warehouse: string, channel: string;
const token = randomUUID().slice(0, 8);
const sku = 'LANEL-' + token;
const o: Record<string, { id: string; number: string }> = {};
const req = (url: string, method: any = 'GET', payload?: any) => app.inject({ url, method, payload, headers: { cookie: admin } });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
const allegroRaw = (id: string, patch: Record<string, any>) => ({
  id,
  status: 'READY_FOR_PROCESSING',
  fulfillment: { status: 'NEW' },
  buyer: { email: `${id}@example.test`, login: 'smakosz_' + id },
  payment: { type: 'ONLINE', paidAmount: { amount: '35.00', currency: 'PLN' } },
  delivery: {
    address: { firstName: 'Jan', lastName: 'Próbny', street: 'Testowa 1', city: 'Łódź', zipCode: '90-001', countryCode: 'PL' },
    cost: { amount: '5.00', currency: 'PLN' },
    ...patch.delivery,
  },
  summary: { totalToPay: { amount: '35.00', currency: 'PLN' } },
  lineItems: [{ offer: { id: 'lanel-offer-' + token, name: 'Kawa próbna', external: { id: sku } }, quantity: 3, price: { amount: '10.00', currency: 'PLN' } }],
  ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'delivery')),
});
async function importAllegro(raw: any) {
  const staged = (await ok(`/api/integrations/${channel}/stage-orders`, 'POST', { data: [raw] })).data[0];
  const r = await ok(`/api/imports/${staged.id}/commit`, 'POST', { warehouse_id: warehouse });
  const order = r.order ?? r;
  return { id: order.id as string, number: order.number as string };
}
const list = async (params: Record<string, string>) => {
  const rows = (await ok('/api/orders?' + new URLSearchParams({ search: token, limit: '200', ...params }))).data;
  const names = Object.fromEntries(Object.entries(o).map(([k, v]) => [v.id, k]));
  return rows.map((r: any) => names[r.id]).filter(Boolean).sort().join('');
};

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  admin = (await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } })).headers['set-cookie']!
    .toString()
    .split(';')[0];
  warehouse = (await ok('/api/warehouses')).data[0].id;
  // 30 × 25 × 9 cm, 300 g: one unit is gabaryt B (9 cm > 8 cm), three stacked (30 × 27 × 25 cm) are C.
  const product = await ok('/api/products', 'POST', {
    name: 'Kawa próbna', sku, price: 1000, vat: 23, warehouse_id: warehouse, quantity: 100,
    weight_grams: 300, length_mm: 300, width_mm: 250, height_mm: 90,
  });
  assert.ok(product.id);
  channel = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)', [
      channel, DEMO_TENANT, 'allegro', 'Allegro lane L', 'sandbox', encrypt({}), JSON.stringify({ simulation: true }),
    ]),
  );
  await ok(`/api/integrations/${channel}/mappings`, 'POST', { external_id: 'lanel-offer-' + token, sku });
  // a: Smart, allegro.cz, company buyer, cash on delivery to a parcel locker, comment and ship-by.
  o.a = await importAllegro(
    allegroRaw('lanel-a-' + token, {
      messageToSeller: 'Proszę o fakturę ' + token,
      marketplace: { id: 'allegro-cz' },
      buyer: { email: `lanel-a-${token}@example.test`, login: 'firma_a', companyName: 'Smakosz s.r.o.' },
      invoice: { required: true, address: { company: { name: 'Smakosz s.r.o.', taxId: 'CZ12345678' } } },
      payment: { type: 'CASH_ON_DELIVERY' },
      delivery: {
        smart: true,
        method: { id: 'inpost-cod', name: 'Allegro Paczkomaty InPost pobranie' },
        pickupPoint: { id: 'LOD01M' },
        time: { dispatch: { to: '2026-11-12T15:00:00Z' } },
      },
    }),
  );
  // b: PayU online, courier, allegro.pl, no comment.
  o.b = await importAllegro(
    allegroRaw('lanel-b-' + token, {
      payment: { type: 'ONLINE', provider: 'PAYU', paidAmount: { amount: '35.00', currency: 'PLN' } },
      delivery: { method: { id: 'dpd', name: 'Allegro Kurier DPD' } },
    }),
  );
  // c: manual, note as the comment, BLIK payment, parcel locker in the address, one unit.
  const c = await ok('/api/orders', 'POST', {
    customer_name: 'Klient ręczny ' + token, email: `lanel-c-${token}@example.test`, warehouse_id: warehouse, note: 'Zadzwonić przed dostawą',
    address: { street: 'Piotrkowska 1', city: 'Łódź', postal_code: '90-001', country: 'PL', phone: '500600700', locker_code: 'LOD03M' },
    items: [{ product_id: product.id, quantity: 1 }],
  });
  o.c = { id: c.id, number: c.number };
  await ok(`/api/orders/${c.id}/payments`, 'POST', {
    client_key: randomUUID(), version: Number(c.version), kind: 'receipt', amount: c.total, currency: 'PLN', method: 'other', reference: 'BLIK 777', confirmed: true,
  });
  // d: manual cash on delivery, delivery method set in the card section to a courier, no note.
  const d = await ok('/api/orders', 'POST', {
    customer_name: 'Klient pobranie ' + token, email: `lanel-d-${token}@example.test`, warehouse_id: warehouse, payment_mode: 'cod',
    address: { street: 'Piotrkowska 2', city: 'Łódź', postal_code: '90-001', country: 'PL', phone: '500600701' },
    items: [{ product_id: product.id, quantity: 3 }],
  });
  o.d = { id: d.id, number: d.number };
  const fresh = await ok('/api/orders/' + d.id);
  await ok(`/api/orders/${d.id}/sections/delivery_method`, 'PATCH', { expected_version: String(fresh.version), values: { method: 'courier', carrier: 'DPD' } });
});
after(async () => {
  await app.close();
  await pool.end();
});

test('rule context reads the projection for Allegro and manual orders', async () => {
  const ctx = await tenantTx(DEMO_TENANT, (c) => loadOrderContexts(c, Object.values(o).map((x) => x.id)));
  const v = (k: string) => ctx.get(o[k].id)!.values;
  assert.equal(v('a')['order.customer_comment'], 'Proszę o fakturę ' + token);
  assert.equal(v('a')['source.site'], 'allegro.cz');
  assert.deepEqual(v('a')['source.flags'], ['smart', 'business', 'invoice']);
  assert.equal(v('a')['source.ship_by'], '2026-11-12T15:00:00.000Z');
  assert.equal(v('a')['payment.operator'], 'cod');
  assert.deepEqual(v('a')['shipping.method'], ['parcel_locker', 'parcel_locker_cod', 'allegro:allegro-paczkomaty-inpost-pobranie']);
  assert.equal(v('a')['shipping.parcel_size'], 'C', 'three units of 9 cm stacked');

  assert.equal(v('b')['order.customer_comment'], '');
  assert.equal(v('b')['source.site'], 'allegro.pl');
  assert.deepEqual(v('b')['source.flags'], []);
  assert.equal(v('b')['payment.operator'], 'payu');
  assert.deepEqual(v('b')['shipping.method'], ['courier', 'allegro:allegro-kurier-dpd']);

  assert.equal(v('c')['order.customer_comment'], 'Zadzwonić przed dostawą');
  assert.equal(v('c')['source.site'], '');
  assert.equal(v('c')['source.ship_by'], null);
  assert.equal(v('c')['payment.operator'], 'blik');
  assert.deepEqual(v('c')['shipping.method'], ['parcel_locker']);
  assert.equal(v('c')['shipping.parcel_size'], 'B');

  assert.equal(v('d')['order.customer_comment'], '');
  assert.equal(v('d')['payment.operator'], 'cod');
  assert.deepEqual(v('d')['shipping.method'], ['courier', 'courier_cod']);
  assert.equal(v('d')['shipping.parcel_size'], 'C');
});

test('a v2 rule test evaluates conditions on the channel fields', async () => {
  const rule = await ok('/api/automations/v2/rules', 'POST', {
    name: 'Lane L ' + token,
    trigger: 'order.matches',
    enabled: false,
    config: {
      version: 2, group: 'Testy', scope: 'orders', run: { ...DEFAULT_RUN }, stop_further: false,
      conditions: {
        match: 'all',
        items: [
          { field: 'source.flags', op: 'in', value: ['smart'] },
          { field: 'source.site', op: 'in', value: ['allegro.cz'] },
          { field: 'shipping.method', op: 'in', value: ['allegro:allegro-paczkomaty-inpost-pobranie'] },
          { field: 'payment.operator', op: 'in', value: ['cod', 'payu'] },
          { field: 'order.customer_comment', op: 'contains', value: 'faktur' },
          { field: 'shipping.parcel_size', op: 'in', value: ['C'] },
          { field: 'source.ship_by', op: 'newer_than', value: '2026-11-01T00:00:00Z' },
        ],
      },
      effects: [{ type: 'add_tag', params: { tag: 'Smart CZ' } }],
    },
  });
  const a = await ok(`/api/automations/v2/rules/${rule.id}/test`, 'POST', { order_id: o.a.id });
  assert.equal(a.matched, true, JSON.stringify(a.conditions));
  const b = await ok(`/api/automations/v2/rules/${rule.id}/test`, 'POST', { order_id: o.b.id });
  assert.equal(b.matched, false);
  assert.deepEqual(b.conditions.map((x: any) => x.ok), [false, false, false, true, false, true, false]);
});

test('order card: channel data with sources', async () => {
  const a = await ok(`/api/orders/${o.a.id}/channel-data`);
  const f = Object.fromEntries(a.fields.map((x: any) => [x.key, x]));
  assert.equal(f['source.site'].value, 'allegro.cz');
  assert.equal(f['source.flags'].value, 'Allegro Smart, Zamówienie firmowe, Kupujący chce fakturę');
  assert.equal(f['payment.operator'].value, 'Pobranie u przewoźnika');
  assert.equal(f['shipping.method'].value, 'Allegro Paczkomaty InPost pobranie');
  assert.match(f['shipping.parcel_size'].value, /^Gabaryt C/);
  assert.match(f['source.ship_by'].value, /2026/);
  const c = await ok(`/api/orders/${o.c.id}/channel-data`);
  const g = Object.fromEntries(c.fields.map((x: any) => [x.key, x]));
  assert.equal(g['order.customer_comment'].value, 'Zadzwonić przed dostawą');
  assert.match(g['order.customer_comment'].source, /Notatka zamówienia/);
  assert.equal(g['payment.operator'].value, 'BLIK');
  assert.match(g['payment.operator'].source, /Zarejestrowana wpłata/);
  assert.equal((await req(`/api/orders/${randomUUID()}/channel-data`)).statusCode, 404);
});

test('order list: delivery filter takes channel methods and cash on delivery variants; comment includes manual notes', async () => {
  assert.equal(await list({ delivery: 'allegro:allegro-paczkomaty-inpost-pobranie' }), 'a');
  assert.equal(await list({ delivery: 'parcel_locker' }), 'ac');
  assert.equal(await list({ delivery: 'parcel_locker_cod' }), 'a');
  assert.equal(await list({ delivery: 'courier_cod' }), 'd');
  assert.equal(await list({ delivery: 'courier' }), 'bd');
  assert.equal(await list({ delivery: 'allegro:allegro-kurier-dpd,courier_cod' }), 'bd');
  assert.equal(await list({ has_comment: 'yes' }), 'ac');
  assert.equal(await list({ has_comment: 'no' }), 'bd');
  for (const bad of ['allegro:Zła Nazwa', 'unknown_cod', 'drone']) {
    const r = await req('/api/orders?' + new URLSearchParams({ delivery: bad }));
    assert.equal(r.statusCode, 422, bad);
  }
  const options = await ok('/api/orders/filter-options');
  const values = options.delivery_options.map((x: any) => x.value);
  for (const v of ['parcel_locker_cod', 'allegro:allegro-paczkomaty-inpost-pobranie', 'allegro:allegro-one-box', 'allegro:allegro-kurier-dpd-pobranie'])
    assert.ok(values.includes(v), v);
  assert.ok(options.delivery_methods.includes('allegro:allegro-kurier-dpd'));
});

test('catalog lists sites, flags, operators, combined methods and parcel sizes', async () => {
  const cat = await ok('/api/automations/v2/catalog');
  const field = (k: string) => cat.fields.find((f: any) => f.key === k);
  const values = (k: string) => field(k).options.map((x: any) => x.value);
  for (const k of ['source.site', 'source.flags', 'payment.operator', 'shipping.method', 'shipping.parcel_size']) assert.equal(field(k).type, 'list', k);
  for (const v of ['allegro.pl', 'allegro.cz', 'amazon.de']) assert.ok(values('source.site').includes(v), v);
  for (const v of ['smart', 'express', 'business']) assert.ok(values('source.flags').includes(v), v);
  for (const v of ['payu', 'przelewy24', 'allegro_finance', 'stripe', 'paypal']) assert.ok(values('payment.operator').includes(v), v);
  for (const v of ['parcel_locker', 'parcel_locker_cod', 'allegro:allegro-paczkomaty-inpost', 'allegro:allegro-paczkomaty-inpost-pobranie', 'allegro:allegro-one-box'])
    assert.ok(values('shipping.method').includes(v), v);
  assert.deepEqual(values('shipping.parcel_size'), ['A', 'B', 'C', 'over']);
  for (const k of ['order.customer_comment', 'source.site', 'payment.operator', 'shipping.method', 'shipping.parcel_size'])
    assert.doesNotMatch(field(k).hint ?? '', /jeśli kanał/, k);
});
