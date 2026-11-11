import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string;
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({
    url: '/api' + p,
    method: m,
    payload: b,
    headers: { cookie: auth, ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
async function ok(p: string, m: any = 'GET', b?: any) {
  const r = await req(p, m, b);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  for (const [email, set] of [
    ['admin@demo.local', (c: string) => (cookie = c)],
    ['viewer@demo.local', (c: string) => (viewer = c)],
    ['other@demo.local', (c: string) => (other = c)],
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
async function product(price = 10001) {
  return ok('/products', 'POST', {
    name: 'Pricing QA',
    sku: 'PR-' + randomUUID().slice(0, 10),
    price,
    warehouse_id: warehouse,
    quantity: 20,
  });
}
async function list(extra: any = {}) {
  return ok('/price-lists', 'POST', {
    name: 'Cennik QA ' + randomUUID().slice(0, 6),
    currency: 'PLN',
    ...extra,
  });
}
const quote = (p: any, l: any) =>
  ok('/pricing/quote', 'POST', { product_ids: [p.id], price_list_id: l.id });
const edit = (l: any, x: any = {}) => ({
  name: l.name,
  active: l.active,
  fallback: l.fallback,
  adjustment_bps: l.adjustment_bps,
  adjustment_amount: l.adjustment_amount,
  version: l.version,
  ...x,
});
test('reguła procentowa i kwotowa liczy grosze dokładnie, wpis SKU ma pierwszeństwo', async () => {
  const p = await product(),
    l = await list({ fallback: true, adjustment_bps: 500, adjustment_amount: 19 });
  assert.equal((await quote(p, l)).items[0].price, 10520);
  const next = await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: l.version,
    items: [{ product_id: p.id, price: 1 }],
  });
  assert.equal((await quote(p, l)).items[0].price, 1);
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: next.version,
    items: [{ product_id: p.id, price: null }],
  });
  assert.equal((await quote(p, l)).items[0].price, 10520);
});
test('brak wpisu, obca waluta fallback i wynik ujemny nie tworzą fikcyjnej ceny', async () => {
  const p = await product(),
    l = await list();
  assert.equal(
    (await req('/pricing/quote', 'POST', { price_list_id: l.id, product_ids: [p.id] })).statusCode,
    422,
  );
  assert.equal(
    (await req('/price-lists', 'POST', { name: 'EUR fallback', currency: 'EUR', fallback: true }))
      .statusCode,
    422,
  );
  const negative = await list({ fallback: true, adjustment_amount: -10002 });
  assert.equal(
    (await req('/pricing/quote', 'POST', { price_list_id: negative.id, product_ids: [p.id] }))
      .statusCode,
    422,
  );
});
test('cena zero jest jawna i pozostaje ceną zero', async () => {
  const p = await product(),
    l = await list();
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: 1,
    items: [{ product_id: p.id, price: 0 }],
  });
  const q = await quote(p, l);
  assert.equal(q.items[0].price, 0);
  assert.equal(q.items[0].source, 'override');
});
test('cennik EUR tworzy atomowe zamówienie w EUR i zachowuje historyczny snapshot', async () => {
  const p = await product(),
    l = await list({ currency: 'EUR' });
  let changed = await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: 1,
    items: [{ product_id: p.id, price: 999 }],
  });
  const b = {
    customer_name: 'Pricing QA',
    email: 'pricing@example.test',
    warehouse_id: warehouse,
    currency: 'EUR',
    price_list_id: l.id,
    items: [{ product_id: p.id, quantity: 2 }],
    shipping_cost: 101,
  };
  const o = await ok('/orders', 'POST', b);
  assert.equal(o.total, 2099);
  assert.equal(o.currency, 'EUR');
  assert.equal(o.items[0].price, 999);
  assert.equal(o.pricing_snapshot.list.version, 2);
  changed = await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: changed.version,
    items: [{ product_id: p.id, price: 1999 }],
  });
  await ok('/price-lists/' + l.id, 'PATCH', edit(changed, { active: false }));
  const after = await ok('/orders/' + o.id);
  assert.deepEqual(after.pricing_snapshot, o.pricing_snapshot);
  assert.equal(after.total, 2099);
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'cancelled' }));
  assert.equal((await req('/orders', 'POST', b)).statusCode, 409);
});
test('waluta zamówienia musi zgadzać się z cennikiem; odmowa nie rezerwuje towaru', async () => {
  const p = await product(),
    l = await list({ currency: 'EUR' });
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: 1,
    items: [{ product_id: p.id, price: 999 }],
  });
  assert.equal(
    (
      await req('/orders', 'POST', {
        customer_name: 'Currency QA',
        email: 'currency@example.test',
        warehouse_id: warehouse,
        price_list_id: l.id,
        items: [{ product_id: p.id, quantity: 1 }],
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [p.id])).rows[0].reserved,
    0,
  );
});
test('równoczesna edycja wersji wygrywa raz i nie gubi wpisów', async () => {
  const p = await product(),
    l = await list();
  const r = await Promise.all([
    req('/price-lists/' + l.id + '/items', 'PUT', {
      version: 1,
      items: [{ product_id: p.id, price: 100 }],
    }),
    req('/price-lists/' + l.id + '/items', 'PUT', {
      version: 1,
      items: [{ product_id: p.id, price: 200 }],
    }),
  ]);
  assert.deepEqual(r.map((r) => r.statusCode).sort(), [200, 409]);
  const data = await ok('/price-lists/' + l.id + '/items');
  assert.equal(data.list.version, 2);
  assert.equal(data.data.length, 1);
  assert([100, 200].includes(data.data[0].price));
});
test('cały batch wycofuje obcy lub nieistniejący produkt i odrzuca powtórzenia', async () => {
  const p = await product(),
    l = await list();
  const b = {
    version: 1,
    items: [
      { product_id: p.id, price: 100 },
      { product_id: randomUUID(), price: 200 },
    ],
  };
  assert.equal((await req('/price-lists/' + l.id + '/items', 'PUT', b)).statusCode, 404);
  const data = await ok('/price-lists/' + l.id + '/items');
  assert.equal(data.data.length, 0);
  assert.equal(data.list.version, 1);
  assert.equal(
    (
      await req('/price-lists/' + l.id + '/items', 'PUT', {
        version: 1,
        items: [b.items[0], b.items[0]],
      })
    ).statusCode,
    422,
  );
});
test('RLS, role i klucz API izolują cenniki i ceny', async () => {
  const p = await product(),
    l = await list();
  assert.equal(
    (await req('/price-lists/' + l.id + '/items', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal((await req('/price-lists', 'GET', undefined, other)).json().data.length, 0);
  assert.equal(
    (await req('/price-lists', 'POST', { name: 'Viewer pricing', currency: 'PLN' }, viewer))
      .statusCode,
    403,
  );
  assert.equal(
    (await tenantTx(SECOND_TENANT, (c) => c.query('SELECT * FROM price_lists WHERE id=$1', [l.id])))
      .rowCount,
    0,
  );
  const key = await ok('/developer/keys', 'POST', {
    name: 'Pricing read QA',
    scopes: ['products:read'],
  });
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/price-lists',
        headers: { authorization: 'Bearer ' + key.token },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/pricing/quote',
        method: 'POST',
        payload: { product_ids: [p.id] },
        headers: { authorization: 'Bearer ' + key.token },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/price-lists',
        method: 'POST',
        payload: { name: 'Key pricing', currency: 'PLN' },
        headers: { authorization: 'Bearer ' + key.token },
      })
    ).statusCode,
    403,
  );
  await ok('/developer/keys/' + key.id, 'DELETE');
});
test('paginacja wpisów ponad 100 i filtr nie pomijają produktów', async () => {
  const l = await list();
  const ids = Array.from({ length: 121 }, () => randomUUID());
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) SELECT id,$1,'BATCH-'||id,'Pricing batch',123 FROM unnest($2::uuid[]) id",
    [DEMO_TENANT, ids],
  );
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: 1,
    items: ids.map((id) => ({ product_id: id, price: 123 })),
  });
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const d = await ok(
      '/price-lists/' +
        l.id +
        '/items?limit=19&search=Pricing%20batch' +
        (cursor ? '&after=' + cursor : ''),
    );
    seen.push(...d.data.map((r: any) => r.product_id));
    cursor = d.meta.cursor;
  } while (cursor);
  assert.equal(seen.length, 121);
  assert.equal(new Set(seen).size, 121);
});

test('raporty rozdzielają PLN i EUR przy wspólnym statusie i źródle zamówień', async () => {
  const p = await product(),
    l = await list({ currency: 'EUR' });
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: 1,
    items: [{ product_id: p.id, price: 999 }],
  });
  const before = await ok('/dashboard');
  const created = [];
  for (const currency of ['PLN', 'EUR']) {
    const o = await ok('/orders', 'POST', {
      customer_name: 'Raport walutowy',
      email: 'pricing@example.test',
      warehouse_id: warehouse,
      currency,
      ...(currency === 'EUR' ? { price_list_id: l.id } : {}),
      items: [{ product_id: p.id, quantity: 2 }],
    });
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'paid' }));
    created.push(o);
  }
  const after = await ok('/dashboard');
  for (const o of created) {
    const old = before.orders.find((v: any) => v.status === 'paid' && v.currency === o.currency);
    const current = after.orders.find((v: any) => v.status === 'paid' && v.currency === o.currency);
    assert.equal(Number(current.total) - Number(old?.total ?? 0), o.total);
    assert.equal(current.count - (old?.count ?? 0), 1);
    const oldSource = before.sources.find(
      (v: any) => v.source === 'manual' && v.currency === o.currency,
    );
    const newSource = after.sources.find(
      (v: any) => v.source === 'manual' && v.currency === o.currency,
    );
    assert.equal(Number(newSource.total) - Number(oldSource?.total ?? 0), o.total);
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'cancelled' }));
  }
});
