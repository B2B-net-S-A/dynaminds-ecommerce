import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { allocatedRefund, receiveReturn } from '../server/returns';
import { receiveReturnDestinationCoreInTx } from '../server/return-destinations-core';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth, ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await req('/warehouses')).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function ok(url: string, method: any = 'GET', body?: any) {
  const r = await req(url, method, body);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
async function product(quantity = 10, extra: any = {}) {
  return ok('/products', 'POST', {
    name: 'QA returns',
    sku: 'RET-' + randomUUID().slice(0, 8),
    price: 12300,
    warehouse_id: warehouse,
    quantity,
    ...extra,
  });
}
async function shipped(items: any[], shipping = 1499) {
  const o = await ok('/orders', 'POST', {
    customer_name: 'QA zwrot',
    email: 'return@example.test',
    warehouse_id: warehouse,
    items,
    shipping_cost: shipping,
  });
  for (const s of ['paid', 'picking'])
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: s }));
  const picks = (await ok('/orders/' + o.id)).picking_items;
  for (const p of picks)
    for (let n = 0; n < p.quantity; n++)
      await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  await ok('/orders/' + o.id + '/ship-demo', 'POST');
  return ok('/orders/' + o.id);
}
const body = (o: any, qty = 1, extra: any = {}) => ({
  client_key: randomUUID(),
  reason: 'QA częściowy zwrot',
  items: [{ item_id: o.items[0].id, quantity: qty }],
  ...extra,
});
const receive = (r: any, restocked = r.items[0].requested) => ({
  version: Number(r.version),
  shipping_refund: r.requested_shipping,
  note: 'QA przyjęcie',
  items: r.items.map((i: any) => ({ item_id: i.item_id, accepted: i.requested, restocked })),
});
const inventory = async (p: string, w = warehouse) =>
  Number(
    (
      await pool.query(
        'SELECT on_hand FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [DEMO_TENANT, p, w],
      )
    ).rows[0]?.on_hand ?? 0,
  );

test('typed destination callbacks require a genuine current SQL148 admission for receive and reject', async () => {
  const p = await product(), o = await shipped([{ product_id: p.id, quantity: 1 }], 0);
  const r = await ok('/orders/' + o.id + '/returns', 'POST', body(o));
  const me = await ok('/auth/me'), actor = { tenantId: DEMO_TENANT, userId: me.user.id, role: 'admin' as const };
  const snapshot = async () => ({ return_case: await ok('/returns/' + r.id), product: await ok('/products/' + p.id),
    movements: (await pool.query('SELECT * FROM stock_movements WHERE tenant_id=$1 AND product_id=$2 ORDER BY id', [DEMO_TENANT, p.id])).rows });
  const before = await snapshot(); let physical = 0, finish = 0;
  const installed = Boolean((await pool.query("SELECT to_regprocedure('public.return_destination_installed()') marker")).rows[0].marker);
  for (const action of ['receive', 'reject'] as const) {
    const input = action === 'receive' ? receive(r) : { version: Number(r.version), decision: 'reject' as const, note: 'QA typed refusal' };
    await assert.rejects(() => tenantTx(DEMO_TENANT, c => receiveReturnDestinationCoreInTx(c, actor, r.id, input,
      { action, destinationAdmissionId: randomUUID(), applyDestinationPhysical: async () => { physical++; }, beforeFinish: async () => { finish++; } })),
      (e: any) => installed ? e.code === '23514' : e.status === 503,
      'An absent module or nonexistent current private admission means no callback or stock write');
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal(physical, 0); assert.equal(finish, 0);
});

test('a physical callback with no destination certificate stops before ordinary RMA mutation', async () => {
  const p = await product(), o = await shipped([{ product_id: p.id, quantity: 1 }], 0);
  const r = await ok('/orders/' + o.id + '/returns', 'POST', body(o));
  const me = await ok('/auth/me'), actor = { tenantId: DEMO_TENANT, userId: me.user.id, role: 'admin' as const };
  const before = await ok('/returns/' + r.id), stock = await inventory(p.id); let called = false;
  await assert.rejects(() => tenantTx(DEMO_TENANT, c => receiveReturn(c, actor, r.id, receive(r), false,
    { applyDestinationPhysical: async () => { called = true; } })), (e: any) => e.status === 409);
  assert.equal(called, false); assert.deepEqual(await ok('/returns/' + r.id), before); assert.equal(await inventory(p.id), stock);
});
test('grosze rozdzielają się dokładnie także przy dużych iloczynach', () => {
  assert.equal(allocatedRefund(22001, 2, 0, 1), 11000);
  assert.equal(allocatedRefund(22001, 2, 1, 1), 11001);
  let total = 0;
  for (let n = 0; n < 7; n++) total += allocatedRefund(2147483647, 7, n, 1);
  assert.equal(total, 2147483647);
});
test('częściowe przyjęcie zachowuje status sprzedaży, rozchód i dokładną kwotę z rabatem', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 2 }]);
  await pool.query('UPDATE order_items SET line_total=22001 WHERE order_id=$1', [o.id]);
  await pool.query('UPDATE orders SET total=23500 WHERE id=$1', [o.id]);
  const r = await ok('/orders/' + o.id + '/returns', 'POST', body(o));
  assert.equal(await inventory(p.id), 8);
  const got = await ok('/returns/' + r.id + '/receive', 'POST', receive(r));
  assert.equal(got.refund_amount, 11000);
  assert.equal(await inventory(p.id), 9);
  const updated = await ok('/orders/' + o.id);
  assert.equal(updated.status, 'shipped');
  assert.equal(updated.returns.items[0].available, 1);
  assert.equal(updated.total, 23500);
  const movements = (
    await pool.query('SELECT delta FROM stock_movements WHERE return_id=$1', [r.id])
  ).rows;
  assert.deepEqual(movements, [{ delta: 1 }]);
});
test('równoczesne zgłoszenia nie przekraczają ilości, a replay client_key nie tworzy drugiej sprawy', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 2 }]),
    b = body(o, 2);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => req('/orders/' + o.id + '/returns', 'POST', b)),
  );
  assert(results.every((r) => r.statusCode === 201));
  const id = results[0].json().id;
  assert(results.every((r) => r.json().id === id));
  assert.equal(
    (await pool.query('SELECT count(*) FROM return_cases WHERE order_id=$1', [o.id])).rows[0].count,
    '1',
  );
  assert.equal((await req('/orders/' + o.id + '/returns', 'POST', body(o))).statusCode, 409);
  assert.equal(
    (await req('/orders/' + o.id + '/returns', 'POST', { ...b, reason: 'Inny powód' })).statusCode,
    409,
  );
});
test('replay przyjęcia i rozliczenia jest atomowy, zmieniony replay nie dodaje stanu ani wypłaty', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 1 }], 0),
    r = await ok('/orders/' + o.id + '/returns', 'POST', body(o)),
    b = receive(r);
  const accepted = await Promise.all(
    Array.from({ length: 8 }, () => req('/returns/' + r.id + '/receive', 'POST', b)),
  );
  assert(accepted.every((r) => r.statusCode === 200));
  assert.equal(await inventory(p.id), 10);
  assert.equal(
    (await req('/returns/' + r.id + '/receive', 'POST', { ...b, note: 'Inna decyzja' })).statusCode,
    409,
  );
  const current = accepted[0].json(),
    refund = {
      version: Number(current.version),
      amount: 12300,
      reference: 'QA local confirmation',
      confirmed: true,
    };
  assert.equal(
    (await req('/returns/' + r.id + '/refund', 'POST', { ...refund, amount: 12301 })).statusCode,
    422,
  );
  const closed = await Promise.all(
    Array.from({ length: 8 }, () => req('/returns/' + r.id + '/refund', 'POST', refund)),
  );
  assert(closed.every((r) => r.statusCode === 200));
  assert.equal(
    (await req('/returns/' + r.id + '/refund', 'POST', { ...refund, reference: 'Inna referencja' }))
      .statusCode,
    409,
  );
  const done = await ok('/orders/' + o.id);
  assert.equal(done.status, 'return_completed');
  assert.equal(done.returns.settled_total, 12300);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM audit_events WHERE entity_id=$1 AND action='return.refund_recorded'",
        [r.id],
      )
    ).rows[0].count,
    '1',
  );
});
test('reklamacja uszkodzonej sztuki nie zwiększa dostępności, dokument koryguje wyłącznie przyjętą ilość', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 2 }], 0);
  await ok('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
  const r = await ok('/orders/' + o.id + '/returns', 'POST', body(o, 1, { kind: 'complaint' }));
  const got = await ok('/returns/' + r.id + '/receive', 'POST', receive(r, 0));
  assert.equal(await inventory(p.id), 8);
  assert.equal(got.items[0].accepted - got.items[0].restocked, 1);
  const docs = await Promise.all(
    Array.from({ length: 4 }, () => req('/returns/' + r.id + '/document', 'POST', {})),
  );
  assert(docs.every((r) => r.statusCode === 200));
  const d = docs[0].json();
  assert(docs.every((r) => r.json().id === d.id));
  assert.equal(d.data.total, -12300);
  assert.equal(d.data.items[0].quantity, 1);
  assert.equal(d.data.shipping_cost, 0);
  assert.equal(
    (await req('/orders/' + o.id + '/documents', 'POST', { kind: 'correction' })).statusCode,
    409,
  );
});
test('odrzucenie i anulowanie uwalnia limit ilości/dostawy, ale wymaga aktualnej wersji i uzasadnienia', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 1 }], 100);
  const r = await ok('/orders/' + o.id + '/returns', 'POST', body(o, 1, { shipping_refund: 100 }));
  assert.equal(
    (
      await req('/returns/' + r.id + '/decision', 'POST', {
        version: 2,
        decision: 'reject',
        note: 'QA decyzja',
      })
    ).statusCode,
    409,
  );
  await ok('/returns/' + r.id + '/decision', 'POST', {
    version: 1,
    decision: 'reject',
    note: 'QA odrzucenie reklamacji',
  });
  const next = await ok(
    '/orders/' + o.id + '/returns',
    'POST',
    body(o, 1, { shipping_refund: 100 }),
  );
  await ok('/returns/' + next.id + '/decision', 'POST', {
    version: 1,
    decision: 'cancel',
    note: 'QA wycofane zgłoszenie',
  });
  const overview = (await ok('/orders/' + o.id)).returns;
  assert.equal(overview.items[0].available, 1);
  assert.equal(overview.shipping_available, 100);
  assert.equal(await inventory(p.id), 9);
});
test('błąd ostatniej pozycji cofa przyjęcia i ruchy wszystkich poprzednich pozycji', async () => {
  const p = await product(),
    q = await product(),
    o = await shipped(
      [
        { product_id: p.id, quantity: 1 },
        { product_id: q.id, quantity: 1 },
      ],
      0,
    );
  const r = await ok('/orders/' + o.id + '/returns', 'POST', {
    ...body(o),
    items: o.items.map((i: any) => ({ item_id: i.id, quantity: 1 })),
  });
  const b = receive(r);
  b.items[1].restocked = 2;
  assert.equal((await req('/returns/' + r.id + '/receive', 'POST', b)).statusCode, 422);
  assert.equal(await inventory(p.id), 9);
  assert.equal(await inventory(q.id), 9);
  const fresh = await ok('/returns/' + r.id);
  assert.equal(fresh.state, 'requested');
  assert(fresh.items.every((i: any) => i.accepted === 0));
  assert.equal(
    (await pool.query('SELECT count(*) FROM stock_movements WHERE return_id=$1', [r.id])).rows[0]
      .count,
    '0',
  );
});
test('zestaw zwraca skład zapisany w chwili zakupu, współdzielony składnik sumuje się i trafia do wybranego magazynu', async () => {
  const p = await product(),
    q = await product(20),
    bundle = await product(0, {
      kind: 'bundle',
      components: [
        { product_id: p.id, quantity: 1 },
        { product_id: q.id, quantity: 2 },
      ],
    }),
    o = await shipped(
      [
        { product_id: bundle.id, quantity: 2 },
        { product_id: q.id, quantity: 1 },
      ],
      0,
    );
  await pool.query(
    'UPDATE bundle_components SET quantity=4 WHERE tenant_id=$1 AND bundle_id=$2 AND product_id=$3',
    [DEMO_TENANT, bundle.id, q.id],
  );
  const w = await ok('/warehouses', 'POST', {
    name: 'QA zwroty',
    code: 'RET-' + randomUUID().slice(0, 6),
  });
  const r = await ok('/orders/' + o.id + '/returns', 'POST', {
    ...body(o),
    warehouse_id: w.id,
    items: o.items.map((i: any) => ({ item_id: i.id, quantity: 1 })),
  });
  await ok('/returns/' + r.id + '/receive', 'POST', receive(r, 1));
  assert.equal(await inventory(p.id, w.id), 1);
  assert.equal(await inventory(q.id, w.id), 3);
  assert.equal(await inventory(q.id), 15);
});
test('brak wysyłki, obca pozycja, podwójna pozycja i nadmiar dostawy są odrzucane', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 1 }], 100);
  const bad = body(o);
  assert.equal(
    (
      await req('/orders/' + o.id + '/returns', 'POST', {
        ...bad,
        items: [{ item_id: randomUUID(), quantity: 1 }],
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/orders/' + o.id + '/returns', 'POST', {
        ...bad,
        items: [...bad.items, ...bad.items],
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await req('/orders/' + o.id + '/returns', 'POST', { ...bad, shipping_refund: 101 }))
      .statusCode,
    409,
  );
  const unpaid = await ok('/orders', 'POST', {
    customer_name: 'QA',
    email: 'qa@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: p.id, quantity: 1 }],
  });
  assert.equal(
    (await req('/orders/' + unpaid.id + '/returns', 'POST', body(unpaid))).statusCode,
    409,
  );
});
test('RLS i role chronią rejestr; obca firma nie odczytuje ani nie przyjmuje sprawy', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 1 }], 0),
    r = await ok('/orders/' + o.id + '/returns', 'POST', body(o));
  assert.equal((await req('/returns/' + r.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (await req('/returns/' + r.id + '/receive', 'POST', receive(r), other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/returns/' + r.id + '/receive', 'POST', receive(r), viewer)).statusCode,
    403,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal((await c.query('SELECT * FROM return_cases WHERE id=$1', [r.id])).rowCount, 0);
    assert.equal(
      (await c.query('SELECT * FROM return_items WHERE return_id=$1', [r.id])).rowCount,
      0,
    );
  });
});
test('częściowe sprawy blokują stary pełny zwrot oraz nadmiar przyjęcia; nie można ich cofnąć po przyjęciu', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 2 }], 0),
    r = await ok('/orders/' + o.id + '/returns', 'POST', body(o));
  assert.equal(
    (await req('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'return_initiated' }))).statusCode,
    409,
  );
  assert.equal(
    (
      await req('/returns/' + r.id + '/receive', 'POST', {
        ...receive(r),
        items: [{ item_id: r.items[0].item_id, accepted: 2, restocked: 2 }],
      })
    ).statusCode,
    422,
  );
  const got = await ok('/returns/' + r.id + '/receive', 'POST', receive(r));
  assert.equal(
    (
      await req('/returns/' + r.id + '/decision', 'POST', {
        version: Number(got.version),
        decision: 'cancel',
        note: 'QA cofnięcie',
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req('/returns/' + r.id + '/refund', 'POST', {
        version: Number(got.version),
        amount: 12300,
        reference: 'QA przelew',
        confirmed: false,
      })
    ).statusCode,
    422,
  );
});
test('częściowe przyjęcie zgłoszenia zwalnia odmówione sztuki; kolejne zwroty i dostawa sumują się do całości', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 2 }], 101);
  await pool.query('UPDATE order_items SET line_total=22001 WHERE order_id=$1', [o.id]);
  await pool.query('UPDATE orders SET total=22102 WHERE id=$1', [o.id]);
  const first = await ok(
    '/orders/' + o.id + '/returns',
    'POST',
    body(o, 2, { shipping_refund: 100 }),
  );
  const a = await ok('/returns/' + first.id + '/receive', 'POST', {
    ...receive(first),
    items: [{ item_id: o.items[0].id, accepted: 1, restocked: 1 }],
    shipping_refund: 40,
  });
  assert.equal(a.refund_amount, 11040);
  assert.equal((await ok('/orders/' + o.id)).returns.shipping_available, 61);
  const next = await ok(
      '/orders/' + o.id + '/returns',
      'POST',
      body(o, 1, { shipping_refund: 61 }),
    ),
    b = await ok('/returns/' + next.id + '/receive', 'POST', receive(next));
  assert.equal(b.refund_amount, 11062);
  assert.equal((await ok('/orders/' + o.id)).returns.refund_total, 22102);
  assert.equal(await inventory(p.id), 10);
});

test('dashboard odejmuje przyjęte zwroty, zachowując niezwróconą dostawę i oryginalną sprzedaż', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 2 }], 1499);
  const net = async () =>
    (await ok('/dashboard')).orders
      .filter((r: any) => !['new', 'cancelled'].includes(r.status))
      .reduce((n: number, r: any) => n + Number(r.total) - Number(r.refund_total), 0);
  const before = await net();
  const r = await ok('/orders/' + o.id + '/returns', 'POST', body(o, 2));
  await ok('/returns/' + r.id + '/receive', 'POST', receive(r));
  assert.equal(await net(), before - 24600);
  const updated = await ok('/orders/' + o.id);
  assert.equal(updated.total, 26099);
  assert.equal(updated.returns.refund_total, 24600);
  assert.equal(updated.returns.settled_total, 0);
  assert.equal(updated.returns.shipping_available, 1499);
});
test('publiczne API zwrotów stosuje zakresy klucza i te same atomowe reguły', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 1 }], 0);
  const read = await ok('/developer/keys', 'POST', {
    name: 'Returns read QA',
    scopes: ['orders:read'],
  });
  const write = await ok('/developer/keys', 'POST', {
    name: 'Returns write QA',
    scopes: ['orders:read', 'orders:write'],
  });
  const api = (token: string, url: string, method: any = 'GET', payload?: any) =>
    app.inject({
      url: '/api/v1' + url,
      method,
      payload,
      headers: { authorization: 'Bearer ' + token },
    });
  assert.equal(
    (await api(read.token, '/orders/' + o.id + '/returns', 'POST', body(o))).statusCode,
    403,
  );
  const created = await api(write.token, '/orders/' + o.id + '/returns', 'POST', body(o));
  assert.equal(created.statusCode, 201, created.body);
  const r = created.json();
  assert.equal((await api(read.token, '/returns/' + r.id)).statusCode, 200);
  const accepted = await api(write.token, '/returns/' + r.id + '/receive', 'POST', receive(r));
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().refund_amount, 12300);
  assert.equal(
    (await api(write.token, '/returns/' + r.id + '/document', 'POST', {})).statusCode,
    403,
  );
  for (const key of [read, write]) await ok('/developer/keys/' + key.id, 'DELETE');
});

test('pełny proces nie przyjmuje częściowych ilości przez API spraw ani dwóch pełnych korekt', async () => {
  const p = await product(),
    o = await shipped([{ product_id: p.id, quantity: 2 }], 0);
  await ok('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'return_initiated' }));
  const r = (await ok('/orders/' + o.id)).returns.cases[0];
  assert(r.legacy);
  assert.equal((await req('/returns/' + r.id + '/receive', 'POST', receive(r, 1))).statusCode, 409);
  assert.equal(await inventory(p.id), 8);
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'return_received' }));
  assert.equal((await req('/returns/' + r.id + '/document', 'POST', {})).statusCode, 409);
  const correction = await ok('/orders/' + o.id + '/documents', 'POST', { kind: 'correction' });
  const replay = await ok('/orders/' + o.id + '/documents', 'POST', { kind: 'correction' });
  assert.equal(correction.id, replay.id);
  assert.equal(await inventory(p.id), 10);
});
