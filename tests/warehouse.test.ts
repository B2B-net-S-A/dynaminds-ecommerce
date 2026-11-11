import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  w: string,
  t: string,
  foreignWarehouse: string;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
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
  operator = await login('operator@demo.local');
  [w, t] = (await req('/api/warehouses')).json().data.map((d: any) => d.id);
  foreignWarehouse = (await req('/api/warehouses', 'GET', undefined, other)).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(quantity = 10, kind = 'simple') {
  const r = await req('/api/products', 'POST', {
    sku: 'WMS-' + randomUUID().slice(0, 8),
    name: 'Produkt WMS',
    price: 1000,
    warehouse_id: w,
    quantity,
    kind,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function stocks(p: any) {
  return (await req('/api/inventory?product_id=' + p.id))
    .json()
    .data.filter((s: any) => s.product_id === p.id);
}
async function state(p: any, warehouse = w) {
  return (await stocks(p)).find((s: any) => s.warehouse_id === warehouse);
}
async function create(kind: string, lines: any[], extra: any = {}) {
  return req('/api/warehouse-documents', 'POST', {
    kind,
    warehouse_id: w,
    ...(kind === 'transfer' ? { destination_id: t } : {}),
    lines,
    ...extra,
  });
}
async function draft(kind: string, p: any, quantity: number, extra: any = {}) {
  const s = await state(p, extra.warehouse_id ?? w);
  const r = await create(
    kind,
    [{ product_id: p.id, quantity, ...(kind === 'count' ? { expected_version: s?.version } : {}) }],
    extra,
  );
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function post(d: any, auth = cookie) {
  return req('/api/warehouse-documents/' + d.id + '/post', 'POST', { version: d.version }, auth);
}
async function movements(d: any) {
  return tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query('SELECT * FROM stock_movements WHERE warehouse_document_id=$1', [d.id])).rows,
  );
}
const line = (p: any, quantity: number) => ({ product_id: p.id, quantity });
test('WZ issue posts once across concurrent retries and preserves reserved quantities and locations', async () => {
  const p = await product(10),
    sale = await req('/api/orders', 'POST', {
      customer_name: 'Rezerwacja do ochrony',
      email: 'wz@example.test',
      warehouse_id: w,
      items: [{ product_id: p.id, quantity: 3 }],
    });
  assert.equal(sale.statusCode, 201, sale.body);
  const d = await draft('issue', p, 7);
  assert(d.number.startsWith('WZ/'));
  const posted = await Promise.all([post(d), post(d)]);
  assert(posted.every((r) => r.statusCode === 200));
  assert.equal((await state(p)).on_hand, 3);
  assert.equal((await state(p)).reserved, 3);
  assert.equal((await movements(d)).length, 1);
  assert.equal((await movements(d))[0].kind, 'issue');
  const blocked = await draft('issue', p, 1);
  assert.equal((await post(blocked)).statusCode, 409);
  assert.equal((await movements(blocked)).length, 0);
  const bins = (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT sum(quantity)::int n FROM stock_locations WHERE product_id=$1', [p.id]),
    )
  ).rows[0].n;
  assert.equal(bins, 3);
});
test('WZ multi-product failure rolls back earlier depletion and movements', async () => {
  const p = await product(5),
    q = await product(0),
    created = await create('issue', [line(p, 2), line(q, 1)]);
  assert.equal(created.statusCode, 201, created.body);
  const d = created.json();
  assert.equal((await post(d)).statusCode, 409);
  assert.equal((await state(p)).on_hand, 5);
  assert.equal((await movements(d)).length, 0);
  assert.equal((await req('/api/warehouse-documents?kind=issue')).statusCode, 200);
});

test('przyjęcie jest szkicem bez zmiany stanu; równoległe zatwierdzanie przyjmuje tylko raz', async () => {
  const p = await product(0),
    d = await draft('receipt', p, 7);
  assert.equal((await state(p)).on_hand, 0);
  assert.equal((await movements(d)).length, 0);
  const result = await Promise.all(Array.from({ length: 8 }, () => post(d)));
  assert.ok(
    result.every((r) => r.statusCode === 200),
    result.map((r) => r.body).join('\n'),
  );
  assert.equal((await state(p)).on_hand, 7);
  const m = await movements(d);
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'receipt');
  assert.equal(m[0].delta, 7);
});
test('przyjęcie do nowego magazynu tworzy stan i lokalizację; istniejącej lokalizacji nie nadpisuje', async () => {
  const p = await product(),
    r = await create('receipt', [{ ...line(p, 4), location: 'P-02' }], { warehouse_id: t });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal((await post(r.json())).statusCode, 200);
  assert.equal((await state(p, t)).location, 'P-02');
  const d = await draft('receipt', p, 1, { warehouse_id: t });
  await post(d);
  assert.equal((await state(p, t)).on_hand, 5);
  assert.equal((await state(p, t)).location, 'P-02');
});
test('przesunięcie zachowuje sumę towaru i tworzy dwa powiązane ruchy', async () => {
  const p = await product(),
    d = await draft('transfer', p, 4);
  assert.equal((await post(d)).statusCode, 200);
  assert.equal((await state(p)).on_hand, 6);
  assert.equal((await state(p, t)).on_hand, 4);
  const m = await movements(d);
  assert.equal(m.length, 2);
  assert.equal(
    m.reduce((s, l) => s + l.delta, 0),
    0,
  );
  assert.deepEqual(m.map((l) => l.kind).sort(), ['transfer_in', 'transfer_out']);
});
test('przesunięcie chroni rezerwacje i błędna druga pozycja cofa wszystkie stany i ruchy', async () => {
  const p = await product(),
    q = await product(1);
  const order = await req('/api/orders', 'POST', {
    customer_name: 'WMS Klient',
    email: 'wms@example.test',
    warehouse_id: w,
    items: [line(p, 8)],
  });
  assert.equal(order.statusCode, 201, order.body);
  const blocked = await draft('transfer', p, 3);
  assert.equal((await post(blocked)).statusCode, 409);
  assert.equal((await state(p)).reserved, 8);
  assert.equal(await state(p, t), undefined);
  const r = await create('transfer', [line(p, 2), line(q, 2)]);
  assert.equal(r.statusCode, 201, r.body);
  assert.equal((await post(r.json())).statusCode, 409);
  assert.equal((await state(p)).on_hand, 10);
  assert.equal((await state(q)).on_hand, 1);
  assert.equal((await movements(r.json())).length, 0);
  const good = await draft('transfer', p, 2);
  assert.equal((await post(good)).statusCode, 200);
  assert.equal((await state(p)).on_hand, 8);
  assert.equal((await state(p)).reserved, 8);
});
test('przeciwne równoległe przesunięcia wielu SKU kończą się bez zakleszczenia i utraty towaru', async () => {
  const p = await product(100),
    q = await product(100);
  await post(await draft('receipt', p, 100, { warehouse_id: t }));
  await post(await draft('receipt', q, 100, { warehouse_id: t }));
  const docs = [];
  for (let i = 0; i < 12; i++) {
    const r = await create(
      'transfer',
      i % 2 ? [line(q, 2), line(p, 1)] : [line(p, 1), line(q, 2)],
      i % 2 ? { warehouse_id: t, destination_id: w } : {},
    );
    assert.equal(r.statusCode, 201, r.body);
    docs.push(r.json());
  }
  const result = await Promise.all(docs.map((d) => post(d)));
  assert.ok(
    result.every((r) => r.statusCode === 200),
    result.map((r) => r.body).join('\n'),
  );
  assert.equal((await state(p)).on_hand, 100);
  assert.equal((await state(p, t)).on_hand, 100);
  assert.equal((await state(q)).on_hand, 100);
  assert.equal((await state(q, t)).on_hand, 100);
});
test('pomiar zmniejsza i zwiększa stan, zero jest poprawne; nie może naruszyć rezerwacji', async () => {
  const p = await product();
  assert.equal((await post(await draft('count', p, 0))).statusCode, 200);
  assert.equal((await state(p)).on_hand, 0);
  assert.equal((await post(await draft('count', p, 20))).statusCode, 200);
  assert.equal((await state(p)).on_hand, 20);
  await req('/api/orders', 'POST', {
    customer_name: 'WMS Klient',
    email: 'wms@example.test',
    warehouse_id: w,
    items: [line(p, 15)],
  });
  const d = await draft('count', p, 14);
  assert.equal((await post(d)).statusCode, 409);
  assert.equal((await state(p)).on_hand, 20);
  assert.equal((await movements(d)).length, 0);
});
test('pomiar bez różnicy zatwierdza dokument bez ruchu zerowego', async () => {
  const p = await product(),
    d = await draft('count', p, 10);
  assert.equal((await post(d)).statusCode, 200);
  assert.equal((await movements(d)).length, 0);
});
test('wersja stanu wykrywa zmianę i cofnięcie zmiany między pomiarem a zatwierdzeniem', async () => {
  const p = await product(),
    d = await draft('count', p, 9);
  await req('/api/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: w,
    delta: 1,
    note: 'WMS ABA plus',
  });
  await req('/api/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: w,
    delta: -1,
    note: 'WMS ABA minus',
  });
  const r = await post(d);
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.json().detail, /zmienił/);
  assert.equal((await state(p)).on_hand, 10);
  const fresh = await state(p);
  const edited = await req('/api/warehouse-documents/' + d.id, 'PATCH', {
    ...d,
    lines: [{ ...line(p, 8), expected_version: fresh.version }],
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await post(edited.json())).statusCode, 200);
  assert.equal((await state(p)).on_hand, 8);
});
test('nowa rezerwacja i jej anulowanie także unieważniają pomiar', async () => {
  const p = await product(),
    d = await draft('count', p, 9);
  const r = await req('/api/orders', 'POST', {
    customer_name: 'WMS Klient',
    email: 'wms@example.test',
    warehouse_id: w,
    items: [line(p, 1)],
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(
    (await req('/api/orders/' + r.json().id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/api/orders/' + r.json().id + '/status', { status: 'cancelled' })))
      .statusCode,
    200,
  );
  assert.equal((await state(p)).reserved, 0);
  assert.equal((await post(d)).statusCode, 409);
  assert.equal((await state(p)).on_hand, 10);
});
test('zmiana stanu w trakcie wprowadzania pomiaru blokuje zapis szkicu i ponowny zapis', async () => {
  const p = await product(),
    s = await state(p);
  await post(await draft('receipt', p, 2));
  const r = await create('count', [{ ...line(p, 9), expected_version: s.version }]);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await create('count', [line(p, 9)])).statusCode, 409);
  const d = await draft('count', p, 11);
  await post(await draft('receipt', p, 1));
  const e = await req('/api/warehouse-documents/' + d.id, 'PATCH', d);
  assert.equal(e.statusCode, 409, e.body);
});
test('anulowanie szkicu nie zmienia stanu, a zatwierdzone dokumenty są nieedytowalne', async () => {
  const p = await product(),
    d = await draft('receipt', p, 5);
  assert.equal(
    (await req('/api/warehouse-documents/' + d.id + '/cancel', 'POST', { version: d.version }))
      .statusCode,
    200,
  );
  assert.equal((await post(d)).statusCode, 409);
  assert.equal((await state(p)).on_hand, 10);
  const ready = await draft('receipt', p, 5);
  await post(ready);
  assert.equal((await req('/api/warehouse-documents/' + ready.id, 'PATCH', ready)).statusCode, 409);
  assert.equal(
    (await req('/api/warehouse-documents/' + ready.id + '/cancel', 'POST', { version: 2 }))
      .statusCode,
    409,
  );
});
test('wersja szkicu chroni przed nadpisaniem i zatwierdzeniem starszego formularza', async () => {
  const p = await product(),
    d = await draft('receipt', p, 5);
  const e = await req('/api/warehouse-documents/' + d.id, 'PATCH', { ...d, lines: [line(p, 7)] });
  assert.equal(e.statusCode, 200, e.body);
  assert.equal(e.json().version, 2);
  assert.equal((await req('/api/warehouse-documents/' + d.id, 'PATCH', d)).statusCode, 409);
  assert.equal((await post(d)).statusCode, 409);
  assert.equal((await post(e.json())).statusCode, 200);
  assert.equal((await state(p)).on_hand, 17);
});
test('walidacja odrzuca wirtualne produkty, duplikaty, złe magazyny i brak stanu do pomiaru', async () => {
  const p = await product(),
    g = await product(0, 'group');
  assert.equal((await create('receipt', [line(g, 1)])).statusCode, 422);
  assert.equal((await create('receipt', [line(p, 1), line(p, 2)])).statusCode, 422);
  assert.equal((await create('receipt', [line(p, 0)])).statusCode, 422);
  assert.equal((await create('transfer', [line(p, 1)], { destination_id: w })).statusCode, 422);
  assert.equal((await create('transfer', [line(p, 1)], { destination_id: null })).statusCode, 422);
  assert.equal((await create('receipt', [line(p, 1)], { destination_id: t })).statusCode, 422);
  assert.equal(
    (await create('receipt', [line(p, 1)], { warehouse_id: foreignWarehouse })).statusCode,
    404,
  );
  assert.equal(
    (await create('count', [{ ...line(p, 0), expected_version: '0' }], { warehouse_id: t }))
      .statusCode,
    422,
  );
});
test('izolacja firm i uprawnienia obejmują odczyt oraz każdą mutację dokumentu', async () => {
  const p = await product(),
    d = await draft('receipt', p, 1);
  assert.equal(
    (await req('/api/warehouse-documents/' + d.id, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal((await post(d, other)).statusCode, 404);
  assert.equal(
    (await req('/api/warehouse-documents', 'GET', undefined, other))
      .json()
      .data.some((x: any) => x.id === d.id),
    false,
  );
  for (const auth of [viewer, operator]) {
    assert.equal(
      (await req('/api/warehouse-documents/' + d.id, 'GET', undefined, auth)).statusCode,
      200,
    );
    assert.equal((await post(d, auth)).statusCode, 403);
    assert.equal(
      (await req('/api/warehouse-documents', 'POST', { ...d, lines: [line(p, 1)] }, auth))
        .statusCode,
      403,
    );
    assert.equal((await req('/api/warehouse-documents/' + d.id, 'PATCH', d, auth)).statusCode, 403);
    assert.equal(
      (await req('/api/warehouse-documents/' + d.id + '/cancel', 'POST', { version: 1 }, auth))
        .statusCode,
      403,
    );
  }
  const foreignProduct = (await req('/api/products', 'GET', undefined, other)).json().data[0];
  assert.equal((await create('receipt', [line(foreignProduct, 1)])).statusCode, 404);
});
test('lista filtruje rodzaj i status, a kolejne strony nie powtarzają dokumentów', async () => {
  const p = await product();
  for (let i = 0; i < 5; i++) await draft('receipt', p, 1);
  const first = (await req('/api/warehouse-documents?limit=3&kind=receipt&status=draft')).json();
  assert.equal(first.data.length, 3);
  assert.ok(first.meta.cursor);
  const next = (
    await req(
      '/api/warehouse-documents?limit=3&kind=receipt&status=draft&after=' + first.meta.cursor,
    )
  ).json();
  assert.ok(
    next.data.every(
      (x: any) =>
        x.kind === 'receipt' && x.status === 'draft' && !first.data.some((y: any) => y.id === x.id),
    ),
  );
});

test('błąd ostatniej pozycji przesunięcia cofa wcześniej zapisane ruchy i utworzone stany', async () => {
  const products = [await product(), await product()].sort((a, b) => a.id.localeCompare(b.id));
  const [a, b] = products;
  await req('/api/inventory/adjust', 'POST', {
    product_id: b.id,
    warehouse_id: w,
    delta: -9,
    note: 'Test rollback ostatniej pozycji',
  });
  const d = (await create('transfer', [line(b, 2), line(a, 2)])).json();
  assert.equal((await post(d)).statusCode, 409);
  assert.equal((await state(a)).on_hand, 10);
  assert.equal((await state(b)).on_hand, 1);
  assert.equal(await state(a, t), undefined);
  assert.equal(await state(b, t), undefined);
  assert.equal((await movements(d)).length, 0);
});
test('nieaktualna ostatnia pozycja pomiaru cofa wcześniejsze rozliczenie różnicy', async () => {
  const [a, b] = [await product(), await product()].sort((a, b) => a.id.localeCompare(b.id));
  const d = (
    await create('count', [
      { ...line(a, 9), expected_version: (await state(a)).version },
      { ...line(b, 9), expected_version: (await state(b)).version },
    ])
  ).json();
  await post(await draft('receipt', b, 1));
  assert.equal((await post(d)).statusCode, 409);
  assert.equal((await state(a)).on_hand, 10);
  assert.equal((await state(b)).on_hand, 11);
  assert.equal((await movements(d)).length, 0);
});
test('równoległy pomiar i zamówienie nie pozostawiają rezerwacji ponad stanem', async () => {
  const p = await product(),
    d = await draft('count', p, 0);
  const result = await Promise.all([
    post(d),
    req('/api/orders', 'POST', {
      customer_name: 'WMS Klient',
      email: 'wms@example.test',
      warehouse_id: w,
      items: [line(p, 1)],
    }),
  ]);
  assert.deepEqual(
    result.map((r) => r.statusCode).sort(),
    result[0].statusCode === 200 ? [200, 409] : [201, 409],
  );
  const s = await state(p);
  assert.ok(s.reserved <= s.on_hand);
  assert.ok((s.on_hand === 0 && s.reserved === 0) || (s.on_hand === 10 && s.reserved === 1));
});
