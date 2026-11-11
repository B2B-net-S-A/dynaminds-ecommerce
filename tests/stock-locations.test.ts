import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  operator: string,
  viewer: string,
  other: string,
  warehouse: string;
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method: m, payload: b, headers: { cookie: auth } });
async function ok(p: string, m: any = 'GET', b?: any) {
  const r = await req(p, m, b);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  async function login(email: string) {
    return (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  }
  cookie = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(qty = 10) {
  return ok('/products', 'POST', {
    sku: 'BIN-' + randomUUID().slice(0, 8),
    name: 'Test lokalizacji',
    warehouse_id: warehouse,
    quantity: qty,
    price: 1000,
    location: 'A-01',
  });
}
async function bins(p: any) {
  return (await ok('/stock-locations?warehouse_id=' + warehouse + '&product_id=' + p.id)).data;
}
async function op(p: any, kind = 'moves', b: any = {}) {
  const rows = await bins(p);
  return {
    warehouse_id: warehouse,
    product_id: p.id,
    location: 'A-01',
    expected_version: rows[0].version,
    client_key: randomUUID(),
    quantity: 4,
    note: 'QA przesunięcie',
    ...(kind === 'moves' ? { destination: 'B-02' } : {}),
    ...b,
  };
}
async function order(p: any, q = 8) {
  return ok('/orders', 'POST', {
    warehouse_id: warehouse,
    customer_name: 'QA lokalizacje',
    email: 'qa@example.test',
    address: { street: 'Testowa 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
    items: [{ product_id: p.id, quantity: q }],
  });
}
async function get(o: any) {
  return ok('/orders/' + o.id);
}
test('podział lokalizacji zachowuje sumę i replay, zmiana klucza jest odrzucana', async () => {
  const p = await product(),
    b = await op(p);
  const a = await ok('/stock-location-moves', 'POST', b);
  assert.equal(
    a.data.reduce((s: number, x: any) => s + x.quantity, 0),
    10,
  );
  assert.deepEqual(
    a.data.map((x: any) => [x.location, x.quantity]),
    [
      ['A-01', 6],
      ['B-02', 4],
    ],
  );
  assert.equal((await ok('/stock-location-moves', 'POST', b)).reused, true);
  assert.equal((await req('/stock-location-moves', 'POST', { ...b, quantity: 1 })).statusCode, 409);
});
test('rezerwacje dzielą SKU na miejsca, skan wymaga lokalizacji, wysyłka zużywa właściwe miejsca', async () => {
  const p = await product();
  await ok('/stock-location-moves', 'POST', await op(p));
  let o = await order(p);
  assert.deepEqual(
    o.picking_items[0].locations.map((b: any) => [b.location, b.quantity]),
    [
      ['A-01', 6],
      ['B-02', 2],
    ],
  );
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'paid' }));
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  assert.equal((await req('/orders/' + o.id + '/scan', 'POST', { code: p.sku })).statusCode, 422);
  assert.equal(
    (await req('/orders/' + o.id + '/scan', 'POST', { code: p.sku, location: 'C-03' })).statusCode,
    422,
  );
  for (const loc of ['A-01', 'B-02'])
    for (let n = 0; n < (loc === 'A-01' ? 6 : 2); n++)
      await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku, location: loc });
  assert.equal(
    (await req('/orders/' + o.id + '/scan', 'POST', { code: p.sku, location: 'A-01' })).statusCode,
    409,
  );
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  await ok('/orders/' + o.id + '/ship-demo', 'POST', {});
  assert.deepEqual(
    (await bins(p)).map((b: any) => [b.quantity, b.reserved]),
    [
      [0, 0],
      [2, 0],
    ],
  );
  assert.equal((await get(o)).status, 'shipped');
});
test('lokalizacja rezerwacji nie może zostać przesunięta ani pomierzona poniżej zajętej ilości; anulowanie uwalnia', async () => {
  const p = await product(),
    o = await order(p, 8);
  assert.equal((await req('/stock-location-moves', 'POST', await op(p))).statusCode, 409);
  assert.equal(
    (await req('/stock-location-counts', 'POST', await op(p, 'counts', { quantity: 7 })))
      .statusCode,
    409,
  );
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'cancelled' }));
  await ok('/stock-location-moves', 'POST', await op(p));
  assert.equal((await bins(p))[1].quantity, 4);
});
test('pomiar pojedynczego miejsca zmienia sumę, a stara baza i ABA nie nadpisują', async () => {
  const p = await product(),
    count = await op(p, 'counts', { quantity: 7 });
  await ok('/stock-location-counts', 'POST', count);
  assert.equal((await bins(p))[0].quantity, 7);
  assert.equal(
    (await req('/stock-location-counts', 'POST', { ...count, client_key: randomUUID() }))
      .statusCode,
    409,
  );
  const old = await op(p, 'counts', { quantity: 3 });
  await ok('/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta: 1,
    note: 'QA ABA plus',
  });
  await ok('/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta: -1,
    note: 'QA ABA minus',
  });
  assert.equal((await req('/stock-location-counts', 'POST', old)).statusCode, 409);
});
test('PZ umieszcza w nowej lokalizacji, korekta zachowuje zajęte miejsca', async () => {
  const p = await product();
  const d = await ok('/warehouse-documents', 'POST', {
    kind: 'receipt',
    warehouse_id: warehouse,
    lines: [{ product_id: p.id, quantity: 5, location: 'PZ-01' }],
  });
  await ok('/warehouse-documents/' + d.id + '/post', 'POST', { version: d.version });
  assert.deepEqual(
    (await bins(p)).map((b: any) => [b.location, b.quantity]),
    [
      ['A-01', 10],
      ['PZ-01', 5],
    ],
  );
  const o = await order(p, 10);
  await ok('/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta: -3,
    note: 'QA zdejmij dostępne',
  });
  assert.deepEqual(
    (await bins(p)).map((b: any) => [b.quantity, b.reserved]),
    [
      [10, 10],
      [2, 0],
    ],
  );
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'cancelled' }));
});
test('współbieżne przesunięcia i rezerwacja nie przekraczają fizycznego stanu', async () => {
  const p = await product(),
    b = await op(p),
    r = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        req('/stock-location-moves', 'POST', {
          ...b,
          client_key: randomUUID(),
          quantity: 2,
          destination: 'R-' + i,
        }),
      ),
    );
  assert.equal(r.filter((x) => x.statusCode === 200).length, 1);
  assert(r.every((x) => [200, 409].includes(x.statusCode)));
  const orders = await Promise.all([
    req('/orders', 'POST', {
      warehouse_id: warehouse,
      customer_name: 'QA',
      email: 'qa@example.test',
      address: { street: 'T', postcode: '00-001', city: 'W', country: 'PL' },
      items: [{ product_id: p.id, quantity: 7 }],
    }),
    req('/orders', 'POST', {
      warehouse_id: warehouse,
      customer_name: 'QA',
      email: 'qa@example.test',
      address: { street: 'T', postcode: '00-001', city: 'W', country: 'PL' },
      items: [{ product_id: p.id, quantity: 7 }],
    }),
  ]);
  assert.equal(orders.filter((x) => x.statusCode === 201).length, 1);
  assert.equal(
    (await bins(p)).reduce((s: number, x: any) => s + x.reserved, 0),
    7,
  );
});
test('role, obce rekordy, RLS i niezmienna historia są chronione', async () => {
  const p = await product(),
    b = await op(p);
  assert.equal((await req('/stock-location-moves', 'POST', b, viewer)).statusCode, 403);
  assert.equal(
    (await req('/stock-location-counts', 'POST', await op(p, 'counts'), operator)).statusCode,
    403,
  );
  assert.equal((await req('/stock-location-moves', 'POST', b, other)).statusCode, 404);
  assert.equal((await req('/stock-location-moves', 'POST', b, operator)).statusCode, 200);
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM stock_locations WHERE product_id=$1', [p.id]),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('DELETE FROM stock_location_movements WHERE product_id=$1', [p.id]),
    ),
    (e: any) => e.code === '42501',
  );
});
test('baza odrzuca rozjechaną sumę i rezerwację bez alokacji', async () => {
  const p = await product();
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE stock_locations SET quantity=quantity+1 WHERE product_id=$1', [p.id]),
    ),
    (e: any) => e.code === '23514',
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE stock SET reserved=1 WHERE product_id=$1', [p.id]),
    ),
    (e: any) => e.code === '23514',
  );
  assert.equal((await bins(p))[0].quantity, 10);
});
test('paginacja lokalizacji i filtr SKU nie pomijają miejsc', async () => {
  const p = await product(35);
  for (let n = 0; n < 28; n++)
    await ok(
      '/stock-location-moves',
      'POST',
      await op(p, 'moves', { quantity: 1, destination: 'L-' + String(n).padStart(2, '0') }),
    );
  const a = await ok(
    '/stock-locations?warehouse_id=' + warehouse + '&product_id=' + p.id + '&limit=10',
  );
  assert.equal(a.data.length, 10);
  let seen = new Set(a.data.map((b: any) => b.location)),
    cursor = a.meta.cursor;
  while (cursor) {
    const page = await ok(
      '/stock-locations?warehouse_id=' +
        warehouse +
        '&product_id=' +
        p.id +
        '&limit=10&after=' +
        cursor,
    );
    for (const b of page.data) {
      assert(!seen.has(b.location));
      seen.add(b.location);
    }
    cursor = page.meta.cursor;
  }
  assert.equal(seen.size, 29);
  const filter = await ok(
    '/stock-locations?warehouse_id=' + warehouse + '&q=' + p.sku + '&limit=100',
  );
  assert.equal(filter.data.length, 29);
  assert.equal(
    (await req('/stock-locations?warehouse_id=' + warehouse + '&after=invalid')).statusCode,
    422,
  );
});
test('publiczne API lokalizacji zachowuje zakresy tokenów i wspólną logikę', async () => {
  const p = await product(),
    key = await ok('/developer/keys', 'POST', {
      name: 'QA location read',
      scopes: ['inventory:read'],
    });
  const call = (path: string, m: any = 'GET', b?: any) =>
    app.inject({
      url: '/api/v1' + path,
      method: m,
      payload: b,
      headers: { authorization: 'Bearer ' + key.token },
    });
  assert.equal(
    (await call('/stock-locations?warehouse_id=' + warehouse + '&product_id=' + p.id)).statusCode,
    200,
  );
  assert.equal((await call('/stock-location-moves', 'POST', await op(p))).statusCode, 403);
  await ok('/developer/keys/' + key.id, 'DELETE');
  assert.equal((await call('/stock-locations?warehouse_id=' + warehouse)).statusCode, 401);
  const write = await ok('/developer/keys', 'POST', {
    name: 'QA location write',
    scopes: ['inventory:write'],
  });
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/stock-location-moves',
        method: 'POST',
        payload: await op(p),
        headers: { authorization: 'Bearer ' + write.token },
      })
    ).statusCode,
    200,
  );
  assert.equal((await bins(p))[1].quantity, 4);
  await ok('/developer/keys/' + write.id, 'DELETE');
});
