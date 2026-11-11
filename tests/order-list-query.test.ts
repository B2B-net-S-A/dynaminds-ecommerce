import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');

// Every request is scoped by `search=<run token>` (customer name), so seeded demo orders never match.
const token = 'QAL' + randomUUID().slice(0, 8);
let app: FastifyInstance, admin: string, warehouse: string, product: string, channel: string;
const o: Record<'a' | 'b' | 'c' | 'd' | 'e', { id: string; number: string }> = {} as never;

const req = (url: string) => app.inject({ url, method: 'GET', headers: { cookie: admin } });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await app.inject({ url, method, payload, headers: { cookie: admin } });
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
/** Keys (a..e) of the run's orders returned for the filters, in list order. */
async function list(params: Record<string, string>) {
  const r = await req('/api/orders?' + new URLSearchParams({ search: token, limit: '200', ...params }));
  assert.equal(r.statusCode, 200, r.body);
  const byId = new Map(Object.entries(o).map(([k, v]) => [v.id, k]));
  return (r.json().data as any[]).map((row) => byId.get(row.id)).filter(Boolean).sort().join('');
}
/** Fixture rows only: created_at is sealed by the workspace quota trigger, so triggers are off for the update. */
async function set(id: string, sql: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role='replica'");
    assert.equal((await c.query(`UPDATE orders SET ${sql} WHERE id=$1`, [id])).rowCount, 1);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
const event = (id: string, kind: string, at: string) =>
  pool.query('INSERT INTO order_events(id,tenant_id,order_id,kind,created_at) VALUES($1,$2,$3,$4,$5)', [
    randomUUID(),
    DEMO_TENANT,
    id,
    kind,
    at,
  ]);
const pay = (id: string, amount: number, currency = 'PLN') =>
  pool.query(
    "INSERT INTO payment_entries(id,tenant_id,order_id,client_key,request,kind,amount,currency,method,reference) VALUES($1,$2,$3,$4,'{}','receipt',$5,$6,'transfer','QA')",
    [randomUUID(), DEMO_TENANT, id, randomUUID(), amount, currency],
  );
const raw = (id: string, payload: unknown) =>
  pool.query(
    "INSERT INTO inbound_orders(id,tenant_id,channel_id,external_id,raw,source_hash,state,order_id) VALUES($1,$2,$3,$4,$5,'qa','imported',$6)",
    [randomUUID(), DEMO_TENANT, channel, randomUUID(), JSON.stringify(payload), id],
  );

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  assert.equal(login.statusCode, 200, login.body);
  admin = login.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/api/warehouses')).data[0].id;
  const ean = '590' + String(Date.now()).slice(-10);
  product = (
    await ok('/api/products', 'POST', {
      name: 'Filtr listy',
      sku: 'FLT-' + token,
      ean,
      price: 1000,
      warehouse_id: warehouse,
      quantity: 1000,
    })
  ).id;
  const other = (
    await ok('/api/products', 'POST', { name: 'Inny', sku: 'OTH-' + token, price: 500, warehouse_id: warehouse, quantity: 1000 })
  ).id;
  channel = randomUUID();
  await pool.query(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials) VALUES($1,$2,'allegro','QA Allegro','sandbox','x')",
    [channel, DEMO_TENANT],
  );
  const make = async (name: string, address: Record<string, string>, item = product) => {
    const r = await ok('/api/orders', 'POST', {
      customer_name: name + ' ' + token,
      email: name.toLowerCase().replace(/\W/g, '') + '@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: item, quantity: 1 }],
      address: { country: 'PL', ...address },
    });
    return { id: r.id as string, number: r.number as string };
  };
  o.a = await make('Jan Kowalski', { city: 'Kraków', postal_code: '30-001', phone: '+48 600-100-200' });
  o.b = await make('Anna Nowak', { city: 'Warszawa', postal_code: '00-950', phone: '511222333' });
  o.c = await make('Piotr Zieliński', { city: 'Gdańsk', postal_code: '80-001', country: 'DE' }, other);
  o.d = await make('Ewa 100%_Pewna', { city: 'Kraków', postal_code: '31-100' }, other);
  o.e = await make('Firma Bez Nazwiska', { city: 'Poznań', postal_code: '60-001' });

  await set(o.a.id, "source='allegro',external_id='EXT-10_A',address=address||'{\"company\":\"ACME Sp. z o.o.\",\"nip\":\"5250001009\"}',total=10000,shipping_cost=1500,note='pilne',status='delivered',created_at='2026-10-01T10:00:00+02'");
  await set(o.b.id, "source='woocommerce',external_id='EXT-1000',total=25000,shipping_cost=0,currency='EUR',status='packed',created_at='2026-10-10T23:30:00+02'");
  await set(o.c.id, "source='manual',total=5000,shipping_cost=2000,payment_mode='cod',status='paid',created_at='2026-10-20T08:00:00+02'");
  await set(o.d.id, "source='manual',total=7000,shipping_cost=1000,status='new',created_at='2026-10-21T08:00:00+02'");
  await set(o.e.id, "source='allegro',total=3000,shipping_cost=1200,status='cancelled',created_at='2026-10-22T08:00:00+02'");

  await event(o.a.id, 'order.paid', '2026-10-02T10:00:00+02');
  await event(o.a.id, 'order.delivered', '2026-10-05T12:00:00+02');
  await event(o.b.id, 'order.packed', '2026-10-11T09:00:00+02');
  await raw(o.a.id, { buyer: { login: 'kupiec_jan' }, messageToSeller: 'Proszę o szybką wysyłkę' });
  await raw(o.e.id, { buyer: { login: 'kupiec%x' }, messageToSeller: '  ' });
  await pool.query(
    "INSERT INTO documents(id,tenant_id,order_id,number,kind,mode,data) VALUES($1,$2,$3,$4,'invoice','demo','{}')",
    [randomUUID(), DEMO_TENANT, o.a.id, 'FV-QA-' + token],
  );
  await pool.query(
    "INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,reason) VALUES($1,$2,$3,$4,$5,'return','QA')",
    [randomUUID(), DEMO_TENANT, o.a.id, warehouse, 'ZW-QA-' + token],
  );
  await pool.query(
    "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status) VALUES($1,$2,$3,'DPD','QA1','demo','label_ready')",
    [randomUUID(), DEMO_TENANT, o.b.id],
  );
  await pool.query(
    "INSERT INTO order_sales_dimensions(tenant_id,order_id,delivery_method,delivery_label,payment_method,payment_label,provider,origin) VALUES($1,$2,'parcel_locker','Paczkomat','online','PayU','allegro','import'),($1,$3,'courier','Kurier','transfer','Przelew','woocommerce','import')",
    [DEMO_TENANT, o.a.id, o.b.id],
  );
  await pay(o.a.id, 10000); // paid
  await pay(o.b.id, 1000, 'EUR'); // partial
  await pay(o.d.id, 9000); // overpaid; c is cod, e cancelled
});
after(async () => {
  await app.close();
  await pool.end();
});

test('no filter returns every order of the run, newest first', async () => {
  const r = (await ok('/api/orders?' + new URLSearchParams({ search: token }))).data;
  assert.deepEqual(r.map((x: any) => x.id), [o.e, o.d, o.c, o.b, o.a].map((x) => x.id));
  assert.equal(await list({ number: '', city: ' ', has_note: '' }), 'abcde', 'blank values are no filter');
});

test('rows carry fulfilment stage, payment state and invoice documents', async () => {
  const rows = new Map(
    (await ok('/api/orders?' + new URLSearchParams({ search: token }))).data.map((x: any) => [x.id, x]),
  );
  const row = (k: keyof typeof o) => rows.get(o[k].id) as any;
  assert.equal(row('b').fulfilment_stage, 'ready_to_ship');
  assert.equal(row('b').status, 'packed');
  assert.equal(row('a').fulfilment_stage, 'delivered');
  assert.deepEqual(
    ['a', 'b', 'c', 'd', 'e'].map((k) => row(k as never).payment_state),
    ['paid', 'partial', 'cod', 'overpaid', 'paid'],
  );
  assert.equal(row('a').invoice_documents.length, 1);
  assert.deepEqual(row('b').invoice_documents, []);
  assert.equal(row('a').payment_summary, undefined);
});

test('text filters match fragments case-insensitively with literal wildcards', async () => {
  assert.equal(await list({ number: o.c.number.slice(-4) }), 'c');
  assert.equal(await list({ external_id: 'ext-10' }), 'ab');
  assert.equal(await list({ external_id: '10_' }), 'a', '_ is literal');
  assert.equal(await list({ customer: '100%_' }), 'd', '% and _ are literal');
  assert.equal(await list({ customer: '100%' }), 'd');
  assert.equal(await list({ customer: 'acme' }), 'a', 'company in the address');
  assert.equal(await list({ customer: '52500010' }), 'a', 'NIP in the address');
  assert.equal(await list({ email: 'ANNANOWAK@' }), 'b');
  assert.equal(await list({ city: 'krak' }), 'ad');
  assert.equal(await list({ postal_code: '30-0' }), 'a');
  assert.equal(await list({ country: 'de' }), 'c');
  assert.equal(await list({ customer: 'nikt-taki' }), '');
});

test('phone matches the typed fragment and the digits', async () => {
  assert.equal(await list({ phone: '600 100' }), 'a');
  assert.equal(await list({ phone: '600-100' }), 'a');
  assert.equal(await list({ phone: '511 222' }), 'b');
  assert.equal(await list({ phone: '+48' }), 'a');
});

test('channel, Allegro login and buyer comment come from the source data', async () => {
  assert.equal(await list({ channel: 'allegro' }), 'ae');
  assert.equal(await list({ channel: 'manual,woocommerce' }), 'bcd');
  assert.equal(await list({ allegro_login: 'KUPIEC_' }), 'a');
  assert.equal(await list({ allegro_login: 'c%' }), 'e');
  assert.equal(await list({ has_comment: 'yes' }), 'a', 'a blank message is no comment');
  assert.equal(await list({ has_comment: 'no' }), 'bcde');
  assert.equal(await list({ has_note: 'yes' }), 'a');
  assert.equal(await list({ has_note: 'no' }), 'bcde');
});

test('date ranges are inclusive calendar days in Polish time', async () => {
  assert.equal(await list({ created_from: '2026-10-10', created_to: '2026-10-10' }), 'b', '23:30 Warsaw is still the 10th');
  assert.equal(await list({ created_from: '2026-10-20' }), 'cde');
  assert.equal(await list({ created_to: '2026-10-09' }), 'a');
  assert.equal(await list({ delivered_from: '2026-10-05', delivered_to: '2026-10-05' }), 'a');
  assert.equal(await list({ delivered_from: '2026-10-06' }), '');
  assert.equal(await list({ status_changed_from: '2026-10-11', status_changed_to: '2026-10-11' }), 'b');
  assert.equal(await list({ status_changed_from: '2026-10-05', status_changed_to: '2026-10-05' }), 'a', 'latest event wins');
  assert.equal(await list({ status_changed_from: '2026-10-20', status_changed_to: '2026-10-20' }), 'c', 'no event: creation time');
});

test('amount ranges and currency', async () => {
  assert.equal(await list({ total_from: '5000', total_to: '10000' }), 'acd');
  assert.equal(await list({ total_from: '25000' }), 'b');
  assert.equal(await list({ shipping_from: '1200', shipping_to: '1500' }), 'ae');
  assert.equal(await list({ shipping_to: '0' }), 'b');
  assert.equal(await list({ currency: 'EUR' }), 'b');
});

test('product, delivery, payment, document and return filters', async () => {
  assert.equal(await list({ sku: 'flt-' }), 'abe');
  assert.equal(await list({ sku: 'OTH-' + token }), 'cd');
  const ean = (await pool.query('SELECT ean FROM products WHERE id=$1', [product])).rows[0].ean as string;
  assert.equal(await list({ ean: ean.slice(3, 9) }), 'abe');
  assert.equal(await list({ delivery: 'parcel_locker' }), 'a');
  assert.equal(await list({ delivery: 'courier,parcel_locker' }), 'ab');
  assert.equal(await list({ payment: 'paid' }), 'ae');
  assert.equal(await list({ payment: 'partial,overpaid' }), 'bd');
  assert.equal(await list({ payment: 'cod' }), 'c');
  assert.equal(await list({ payment: 'unpaid' }), '');
  assert.equal(await list({ sale_document: 'invoice' }), 'a');
  assert.equal(await list({ sale_document: 'none' }), 'bcde');
  assert.equal(await list({ sale_document: 'receipt' }), '');
  assert.equal(await list({ has_return: 'yes' }), 'a');
  assert.equal(await list({ has_return: 'no' }), 'bcde');
});

test('status uses the derived fulfilment stage and combines with other filters', async () => {
  assert.equal(await list({ status: 'ready_to_ship' }), 'b');
  assert.equal(await list({ status: 'packed' }), '', 'a packed order with a label is ready to ship');
  assert.equal(await list({ status: 'paid,new,ready_to_ship' }), 'bcd');
  assert.equal(await list({ status: 'paid,new,ready_to_ship', city: 'krak' }), 'd');
  assert.equal(await list({ status: 'delivered', channel: 'allegro', has_return: 'yes', total_from: '10000' }), 'a');
  assert.equal(await list({ status: 'delivered', channel: 'woocommerce' }), '');
});

test('keyset pagination keeps working with filters', async () => {
  const filter = { search: token, status: 'cancelled,paid,ready_to_ship', limit: '2' };
  const first = await ok('/api/orders?' + new URLSearchParams(filter));
  assert.deepEqual(first.data.map((x: any) => x.id), [o.e.id, o.c.id]);
  assert.equal(first.meta.has_more, true);
  const next = await ok(
    '/api/orders?' + new URLSearchParams({ ...filter, after: first.meta.cursor }),
  );
  assert.deepEqual(next.data.map((x: any) => x.id), [o.b.id]);
  assert.equal(next.meta.has_more, false);
});

test('invalid filters are rejected with 422', async () => {
  for (const params of <Record<string, string>[]>[
    { status: 'ready' },
    { payment: 'free' },
    { delivery: 'drone' },
    { channel: 'Allegro!' },
    { created_from: '2026-13-01' },
    { created_from: '2026-10-10', created_to: '2026-10-01' },
    { total_from: '100', total_to: '50' },
    { total_from: '-1' },
    { shipping_to: '1.5' },
    { has_note: 'maybe' },
    { sale_document: 'proforma' },
    { currency: 'zł' },
    { number: 'x'.repeat(61) },
  ]) {
    const r = await req('/api/orders?' + new URLSearchParams(params));
    assert.equal(r.statusCode, 422, JSON.stringify(params) + ' ' + r.body);
  }
});

test('filter options come from the data', async () => {
  const options = await ok('/api/orders/filter-options');
  for (const s of ['allegro', 'woocommerce', 'manual']) assert.ok(options.channels.includes(s), s);
  assert.ok(options.currencies.includes('EUR'));
  assert.deepEqual(options.delivery_methods.filter((m: string) => ['courier', 'parcel_locker'].includes(m)), ['courier', 'parcel_locker']);
  assert.equal(options.delivery_available, true);
});
