import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import Fastify from 'fastify';
import { registerPickingWaveRoutes } from '../server/picking-wave-routes';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  operator: string,
  viewer: string,
  other: string,
  warehouse: string;
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method: m, payload: b, headers: { cookie: auth } });
async function ok(p: string, m: any = 'GET', b?: any, auth = cookie) {
  const r = await req(p, m, b, auth);
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
async function statusPayload(o: any, payload: Record<string, any>) {
  return legacySerialOrderStatusPayload((orderPath) => ok(orderPath), '/orders/' + o.id + '/status', payload);
}
async function product(quantity = 20, extra: any = {}) {
  return ok('/products', 'POST', {
    sku: 'WAVE-' + randomUUID().slice(0, 8),
    name: 'Towar zbiorczy',
    price: 1000,
    warehouse_id: warehouse,
    quantity,
    location: 'A2',
    ...extra,
  });
}
async function order(p: any, quantity = 2, extra: any = {}) {
  return ok('/orders', 'POST', {
    warehouse_id: warehouse,
    customer_name: 'QA kompletacji',
    email: 'qa@example.test',
    address: { street: 'Testowa 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
    payment_mode: 'cod',
    items: [{ product_id: p.id, quantity }],
    ...extra,
  });
}
async function preview(orders: any[], warehouse_id = warehouse) {
  return ok('/picking-waves/preview', 'POST', { warehouse_id, order_ids: orders.map((o) => o.id) });
}
async function create(orders: any[], extra: any = {}) {
  const p = await preview(orders);
  return ok('/picking-waves', 'POST', {
    warehouse_id: warehouse,
    order_ids: orders.map((o) => o.id),
    name: 'Partia QA',
    preview_hash: p.preview_hash,
    client_key: randomUUID(),
    ...extra,
  });
}
async function scan(w: any, p: any, extra: any = {}) {
  return ok('/picking-waves/' + w.wave.id + '/scans', 'POST', {
    version: w.wave.version,
    code: p.sku,
    location: 'A2',
    client_key: randomUUID(),
    ...extra,
  });
}
async function detail(w: any) {
  return ok('/picking-waves/' + w.wave.id);
}
async function bins(p: any) {
  return (await ok('/stock-locations?warehouse_id=' + warehouse + '&product_id=' + p.id)).data;
}
async function move(p: any, quantity: number, destination: string) {
  const b = (await bins(p))[0];
  return ok('/stock-location-moves', 'POST', {
    warehouse_id: warehouse,
    product_id: p.id,
    location: b.location,
    destination,
    quantity,
    expected_version: b.version,
    client_key: randomUUID(),
    note: 'QA zbiorczej kompletacji',
  });
}
test('podgląd grupuje fizyczne składniki zestawów i lokalizacje w naturalnej kolejności', async () => {
  const p = await product(10);
  await move(p, 6, 'A10');
  const kit = await product(0, { kind: 'bundle', components: [{ product_id: p.id, quantity: 2 }] });
  const a = await order(kit, 2),
    b = await order(p, 4),
    v = await preview([b, a]);
  assert.deepEqual(
    v.groups.map((g: any) => [g.location, g.quantity]),
    [
      ['A2', 2],
      ['A10', 6],
    ],
  );
  assert(v.groups.every((g: any) => g.product_id === p.id));
  assert.equal(v.orders[0].id, a.id);
  assert.equal(v.orders[1].slot, 2);
  const w = await create([b, a]);
  assert.equal(w.progress.quantity, 8);
  assert.equal((await ok('/orders/' + a.id)).status, 'picking');
  assert.equal(
    (await bins(p)).reduce((n: number, x: any) => n + x.reserved, 0),
    8,
  );
});
test('nieopłacona przedpłata i obce zamówienie lub magazyn nie tworzą partii', async () => {
  const p = await product(),
    o = await order(p, 1, { payment_mode: 'prepaid' });
  assert.equal(
    (await req('/picking-waves/preview', 'POST', { warehouse_id: warehouse, order_ids: [o.id] }))
      .statusCode,
    409,
  );
  const eligible = await order(p, 1);
  assert.equal(
    (
      await req('/picking-waves/preview', 'POST', {
        warehouse_id: randomUUID(),
        order_ids: [eligible.id],
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req(
        '/picking-waves/preview',
        'POST',
        { warehouse_id: warehouse, order_ids: [eligible.id] },
        other,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await req('/picking-waves/preview', 'POST', {
        warehouse_id: warehouse,
        order_ids: [eligible.id, eligible.id],
      })
    ).statusCode,
    422,
  );
  assert.equal((await ok('/orders/' + eligible.id)).status, 'paid', 'pobranie jest gotowe do realizacji (paid = Nowe)');
});
test('zmiana kodu lub skanu po podglądzie odrzuca zatwierdzenie atomowo', async () => {
  const p = await product(),
    o = await order(p),
    v = await preview([o]),
    key = randomUUID();
  await pool.query('UPDATE products SET name=$2 WHERE id=$1', [
    p.id,
    'Nazwa zmieniona po podglądzie',
  ]);
  const r = await req('/picking-waves', 'POST', {
    warehouse_id: warehouse,
    order_ids: [o.id],
    name: 'Stary podgląd',
    preview_hash: v.preview_hash,
    client_key: key,
  });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await ok('/orders/' + o.id)).status, 'paid');
  assert.equal(
    (await pool.query('SELECT 1 FROM picking_waves WHERE client_key=$1', [key])).rowCount,
    0,
  );
  const fresh = await create([o]);
  assert.equal(fresh.groups[0].name, 'Nazwa zmieniona po podglądzie');
});
test('dwa równoległe utworzenia z tym samym kluczem zwracają jedną partię', async () => {
  const p = await product(),
    a = await order(p),
    b = await order(p),
    v = await preview([a, b]);
  const input = {
    warehouse_id: warehouse,
    order_ids: [a.id, b.id],
    name: 'Powtórzona partia',
    preview_hash: v.preview_hash,
    client_key: randomUUID(),
  };
  const rs = await Promise.all([
    req('/picking-waves', 'POST', input),
    req('/picking-waves', 'POST', input),
  ]);
  assert.deepEqual(
    rs.map((r) => r.statusCode).sort(),
    [200, 201],
    rs.map((r) => r.body).join('\n'),
  );
  assert.equal(rs[0].json().wave.id, rs[1].json().wave.id);
  assert.equal(
    (await req('/picking-waves', 'POST', { ...input, name: 'Inna treść' })).statusCode,
    409,
  );
});
test('konkurujące partie z nakładającymi się zamówieniami nie podwajają przypisania', async () => {
  const p = await product(),
    a = await order(p),
    b = await order(p),
    v = await preview([a, b]);
  const rs = await Promise.all(
    [0, 1].map(() =>
      req('/picking-waves', 'POST', {
        warehouse_id: warehouse,
        order_ids: [b.id, a.id],
        name: 'Wspólne zamówienia',
        preview_hash: v.preview_hash,
        client_key: randomUUID(),
      }),
    ),
  );
  assert.deepEqual(
    rs.map((r) => r.statusCode).sort(),
    [201, 409],
    rs.map((r) => r.body).join('\n'),
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) n FROM picking_wave_orders WHERE order_id=$1 AND active', [
        a.id,
      ])
    ).rows[0].n,
    '1',
  );
});
test('skan kieruje sztuki do koszyków, replay pozostaje bezpieczny po kolejnych skanach', async () => {
  const p = await product(),
    a = await order(p, 2),
    b = await order(p, 1);
  let w = await create([b, a]);
  const input = { version: w.wave.version, code: p.sku, location: 'A2', client_key: randomUUID() };
  w = await ok('/picking-waves/' + w.wave.id + '/scans', 'POST', input);
  assert.equal(w.scan.slot, 1);
  assert.equal(w.scan.order_id, a.id);
  w = await scan(w, p);
  assert.equal(w.scan.slot, 1);
  w = await scan(w, p);
  assert.equal(w.scan.slot, 2);
  const replay = await ok('/picking-waves/' + w.wave.id + '/scans', 'POST', input);
  assert.equal(replay.reused, true);
  assert.equal(replay.scan.slot, 1);
  assert.equal(replay.progress.scanned, 3);
  assert.equal(
    (await req('/picking-waves/' + w.wave.id + '/scans', 'POST', { ...input, location: 'A10' }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await req('/picking-waves/' + w.wave.id + '/scans', 'POST', {
        ...input,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/picking-waves/' + w.wave.id + '/complete', 'POST', { version: w.wave.version }))
      .statusCode,
    200,
  );
  assert.equal((await ok('/orders/' + a.id)).status, 'picking');
  assert.equal((await bins(p))[0].quantity, 20);
  assert.equal((await bins(p))[0].reserved, 3);
});
test('wyścig skanów z jedną wersją nie nadpisuje postępu, zły kod i miejsce są odrzucane', async () => {
  const p = await product(),
    o = await order(p, 3),
    w = await create([o]);
  for (const body of [
    { code: 'UNKNOWN', location: 'A2' },
    { code: p.sku, location: 'A10' },
  ])
    assert.equal(
      (
        await req('/picking-waves/' + w.wave.id + '/scans', 'POST', {
          version: w.wave.version,
          client_key: randomUUID(),
          ...body,
        })
      ).statusCode,
      422,
    );
  const rs = await Promise.all(
    [0, 1].map(() =>
      req('/picking-waves/' + w.wave.id + '/scans', 'POST', {
        version: w.wave.version,
        code: p.sku,
        location: 'A2',
        client_key: randomUUID(),
      }),
    ),
  );
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await detail(w)).progress.scanned, 1);
  assert.equal(
    (
      await req('/picking-waves/' + w.wave.id + '/complete', 'POST', {
        version: (await detail(w)).wave.version,
      })
    ).statusCode,
    409,
  );
});
test('skan indywidualny współdzieli licznik z partią; aktualny i zapisany SKU działają', async () => {
  const p = await product(),
    o = await order(p, 3);
  let w = await create([o]);
  await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku, location: 'A2' });
  const old = p.sku;
  p.sku = 'RENAMED-' + randomUUID().slice(0, 8);
  await pool.query('UPDATE products SET sku=$2 WHERE id=$1', [p.id, p.sku]);
  w = await scan(w, p);
  assert.equal(w.progress.scanned, 2);
  w = await scan(w, p, { code: old });
  assert.equal(w.progress.scanned, 3);
  assert.equal(
    (
      await req('/picking-waves/' + w.wave.id + '/scans', 'POST', {
        version: w.wave.version,
        code: p.sku,
        location: 'A2',
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
});
test('niejednoznaczny EAN wymaga SKU produktu', async () => {
  const ean = '1234567890123',
    a = await product(10, { ean }),
    b = await product(10, { ean }),
    o = await order(a, 1, {
      items: [
        { product_id: a.id, quantity: 1 },
        { product_id: b.id, quantity: 1 },
      ],
    });
  let w = await create([o]);
  assert.equal(
    (
      await req('/picking-waves/' + w.wave.id + '/scans', 'POST', {
        version: w.wave.version,
        code: ean,
        location: 'A2',
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  w = await scan(w, a);
  w = await scan(w, b);
  assert.equal(w.progress.scanned, 2);
});
test('anulowanie zamówienia pomija jego sztuki i zwalnia rezerwację', async () => {
  const p = await product(),
    a = await order(p, 2),
    b = await order(p, 1);
  let w = await create([a, b]);
  w = await scan(w, p);
  await ok('/orders/' + a.id + '/status', 'PATCH', await statusPayload(a, { status: 'cancelled' }));
  w = await scan(w, p);
  assert.equal(w.scan.order_id, b.id);
  assert.equal(w.progress.quantity, 1);
  assert.equal(w.progress.cancelled_orders, 1);
  await ok('/picking-waves/' + w.wave.id + '/complete', 'POST', { version: w.wave.version });
  assert.equal((await bins(p))[0].reserved, 1);
});
test('anulowanie partii zachowuje skany i rezerwacje; ponowne przypisanie zbiera tylko brakujące', async () => {
  const p = await product(),
    o = await order(p, 2);
  let w = await create([o]);
  w = await scan(w, p);
  const closed = await ok('/picking-waves/' + w.wave.id + '/cancel', 'POST', {
    version: w.wave.version,
  });
  assert.equal(closed.wave.state, 'cancelled');
  assert.equal((await ok('/orders/' + o.id)).status, 'picking');
  assert.equal((await bins(p))[0].reserved, 2);
  assert.equal(
    (await ok('/picking-waves/' + w.wave.id + '/cancel', 'POST', { version: w.wave.version }))
      .reused,
    true,
  );
  assert.equal(
    (
      await req('/picking-waves/' + w.wave.id + '/complete', 'POST', {
        version: closed.wave.version,
      })
    ).statusCode,
    409,
  );
  let next = await create([o]);
  assert.equal(next.progress.scanned, 1);
  next = await scan(next, p);
  assert.equal(next.progress.scanned, 2);
});
test('po anulowaniu wszystkich zamówień trzeba anulować partię, nie kończyć kompletacji', async () => {
  const p = await product(),
    o = await order(p, 1),
    w = await create([o]);
  await ok('/orders/' + o.id + '/status', 'PATCH', await statusPayload(o, { status: 'cancelled' }));
  assert.equal(
    (await req('/picking-waves/' + w.wave.id + '/complete', 'POST', { version: w.wave.version }))
      .statusCode,
    409,
  );
  assert.equal(
    (await ok('/picking-waves/' + w.wave.id + '/cancel', 'POST', { version: w.wave.version })).wave
      .state,
    'cancelled',
  );
});
test('rola operatora kompletuje, viewer tylko czyta; RLS i FK odrzucają dane obcej firmy', async () => {
  const p = await product(),
    o = await order(p, 1),
    w = await create([o]);
  assert.equal((await req('/picking-waves/' + w.wave.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (await req('/picking-waves/' + w.wave.id, 'GET', undefined, viewer)).statusCode,
    200,
  );
  const input = { version: w.wave.version, code: p.sku, location: 'A2', client_key: randomUUID() };
  assert.equal(
    (await req('/picking-waves/' + w.wave.id + '/scans', 'POST', input, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req('/picking-waves/' + w.wave.id + '/scans', 'POST', input, operator)).statusCode,
    200,
  );
  assert.equal(
    await tenantTx(
      SECOND_TENANT,
      async (c) => (await c.query('SELECT 1 FROM picking_waves WHERE id=$1', [w.wave.id])).rowCount,
    ),
    0,
  );
  await assert.rejects(
    tenantTx(SECOND_TENANT, (c) =>
      c.query(
        'INSERT INTO picking_wave_orders(tenant_id,wave_id,order_id,slot) VALUES($1,$2,$3,1)',
        [SECOND_TENANT, w.wave.id, o.id],
      ),
    ),
    /foreign key/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE picking_wave_scans SET result=result WHERE wave_id=$1', [w.wave.id]),
    ),
    /permission denied/,
  );
});
test('publiczne API egzekwuje zakresy i dokumentuje skany oraz paginację', async () => {
  const read = await ok('/developer/keys', 'POST', {
      name: 'QA partie read',
      scopes: ['orders:read'],
    }),
    p = await product(),
    o = await order(p, 1),
    w = await create([o]);
  const r = await app.inject({
    url: '/api/v1/picking-waves/' + w.wave.id,
    headers: { authorization: 'Bearer ' + read.token },
  });
  assert.equal(r.statusCode, 200, r.body);
  const denied = await app.inject({
    url: '/api/v1/picking-waves/' + w.wave.id + '/scans',
    method: 'POST',
    payload: { version: w.wave.version, code: p.sku, location: 'A2', client_key: randomUUID() },
    headers: { authorization: 'Bearer ' + read.token },
  });
  assert.equal(denied.statusCode, 403);
  const doc = await ok('/developer/openapi');
  assert(doc.paths['/picking-waves/{id}/scans'].post);
  assert(
    doc.paths['/picking-waves/candidates'].get.parameters.find(
      (x: any) => x.name === 'warehouse_id',
    ).required,
  );
});
test('kursor kandydatów zachowuje mikrosekundy i odrzuca inny magazyn lub firmę', async () => {
  const h = await ok('/warehouses', 'POST', {
      name: 'QA paginacji ' + randomUUID().slice(0, 8),
      code: 'W-' + randomUUID().slice(0, 8),
    }),
    p = await product(10, { warehouse_id: h.id }),
    orders = [];
  for (let i = 0; i < 3; i++) orders.push(await order(p, 1, { warehouse_id: h.id }));
  // Only in this isolated test DB: timestamps are normally immutable through the quota trigger.
  // The replica role skips row triggers for this transaction only, so the fixture needs no DDL on
  // orders (ALTER TABLE would hit the deferred status triggers and the schema seals).
  const fixture = await pool.connect();
  try {
    await fixture.query('BEGIN');
    await fixture.query("SET LOCAL session_replication_role = 'replica'");
    for (let i = 0; i < 3; i++)
      await fixture.query(
        "UPDATE orders SET created_at=date_trunc('day',clock_timestamp())+interval '10 hours 123450 microseconds'+$2::int*interval '1 microsecond' WHERE id=$1",
        [orders[i].id, i],
      );
    await fixture.query('COMMIT');
  } catch (error) {
    await fixture.query('ROLLBACK');
    throw error;
  } finally {
    fixture.release();
  }
  const a = await ok('/picking-waves/candidates?warehouse_id=' + h.id + '&limit=1'),
    b = await ok(
      '/picking-waves/candidates?warehouse_id=' +
        h.id +
        '&limit=1&after=' +
        encodeURIComponent(a.next),
    ),
    c = await ok(
      '/picking-waves/candidates?warehouse_id=' +
        h.id +
        '&limit=1&after=' +
        encodeURIComponent(b.next),
    );
  assert.deepEqual(
    [a.data[0].id, b.data[0].id, c.data[0].id],
    orders.map((o) => o.id),
  );
  assert.equal(c.next, null);
  assert.equal(
    (
      await req(
        '/picking-waves/candidates?warehouse_id=' +
          warehouse +
          '&after=' +
          encodeURIComponent(a.next),
      )
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        '/picking-waves/candidates?warehouse_id=' + h.id + '&after=' + encodeURIComponent(a.next),
        'GET',
        undefined,
        other,
      )
    ).statusCode,
    422,
  );
});
test('podgląd odtworzonej kopii czyta partie i blokuje każdą mutację, stare schema zwraca 404', async () => {
  const p = await product(),
    o = await order(p, 1),
    w = await create([o]),
    previewApp = await buildApp({ readOnly: true, previewPort: 4199 });
  try {
    const login = await previewApp.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
      }),
      auth = login.headers['set-cookie']!.toString().split(';')[0];
    assert.equal(
      (
        await previewApp.inject({
          url: '/api/picking-waves/' + w.wave.id,
          headers: { cookie: auth },
        })
      ).statusCode,
      200,
    );
    for (const path of [
      '/picking-waves/preview',
      '/picking-waves/' + w.wave.id + '/scans',
      '/picking-waves/' + w.wave.id + '/complete',
    ])
      assert.equal(
        (
          await previewApp.inject({
            url: '/api' + path,
            method: 'POST',
            payload: {},
            headers: { cookie: auth },
          })
        ).statusCode,
        423,
      );
    assert.equal(
      (await req('/picking-waves/' + w.wave.id, 'GET', undefined, auth)).statusCode,
      401,
    );
  } finally {
    await previewApp.close();
  }
  // Migration 058 creates picking_waves before the sealed guards (PIM 170, delivery, WZ, labels)
  // fingerprint it, so a renamed table is no longer a reachable old backup: it only breaks those
  // seals. The old-backup gate (to_regclass false) is therefore checked on the routes directly.
  assert.equal((await req('/health')).json().picking_waves_available, true);
  const legacy = Fastify();
  legacy.addHook('preHandler', async (r) => {
    (r as any).actor = { tenantId: DEMO_TENANT, userId: randomUUID(), role: 'admin' };
  });
  legacy.setErrorHandler((err: any, _r, reply) => reply.code(err.status ?? 500).send({ error: err.message }));
  registerPickingWaveRoutes(legacy, false);
  try {
    for (const url of [
      '/api/picking-waves',
      '/api/picking-waves/candidates?warehouse_id=' + warehouse,
      '/api/picking-waves/' + w.wave.id,
    ])
      assert.equal((await legacy.inject({ url })).statusCode, 404, url);
  } finally {
    await legacy.close();
  }
});
test('partia 100 zamówień mieści się w limicie i nie zmienia fizycznego stanu', async () => {
  const p = await product(120),
    orders = [];
  for (let i = 0; i < 100; i++) orders.push(await order(p, 1));
  const started = performance.now();
  let w = await create(orders);
  assert.equal(w.orders.length, 100);
  assert.equal(w.groups.length, 1);
  assert.equal(w.progress.quantity, 100);
  w = await scan(w, p);
  assert.equal(w.scan.slot, 1);
  assert.equal(w.progress.scanned, 1);
  assert.equal((await bins(p))[0].quantity, 120);
  assert.equal((await bins(p))[0].reserved, 100);
  console.log('wave100 preview/create/scan ms:', Math.round(performance.now() - started));
  assert.equal(
    (
      await req('/picking-waves/preview', 'POST', {
        warehouse_id: warehouse,
        order_ids: [...orders.map((o) => o.id), randomUUID()],
      })
    ).statusCode,
    422,
  );
});
test('wynik starego skanu jest dostępny po więcej niż 20 późniejszych skanach i po zamknięciu', async () => {
  const p = await product(40),
    o = await order(p, 23);
  let w = await create([o]);
  const input = { version: w.wave.version, code: p.sku, location: 'A2', client_key: randomUUID() };
  const repeats = await Promise.all([
    req('/picking-waves/' + w.wave.id + '/scans', 'POST', input),
    req('/picking-waves/' + w.wave.id + '/scans', 'POST', input),
  ]);
  assert(repeats.every((r) => r.statusCode === 200));
  w = repeats[0].json();
  assert.equal(w.progress.scanned, 1);
  for (let i = 0; i < 22; i++) w = await scan(w, p);
  assert(!w.scans.some((s: any) => s.client_key === input.client_key));
  await ok('/picking-waves/' + w.wave.id + '/complete', 'POST', { version: w.wave.version });
  const receipt = await ok(
    '/picking-waves/' + w.wave.id + '/scan-result?client_key=' + input.client_key,
  );
  assert.equal(receipt.scan.order_id, o.id);
  assert.equal(receipt.scan.version, '2');
  assert.equal(receipt.state, 'completed');
  assert.equal(
    (
      await req(
        '/picking-waves/' + w.wave.id + '/scan-result?client_key=' + input.client_key,
        'GET',
        undefined,
        other,
      )
    ).statusCode,
    404,
  );
});
test('pakowanie, przesyłka demo, dokument i zwrot po zbiorczej kompletacji zmieniają tylko właściwe ilości', async () => {
  const p = await product(10),
    a = await order(p, 2),
    b = await order(p, 1);
  let w = await create([a, b]);
  assert.equal(
    (await req('/orders/' + a.id + '/status', 'PATCH', await statusPayload(a, { status: 'packed' }))).statusCode,
    409,
  );
  for (let i = 0; i < 3; i++) w = await scan(w, p);
  await ok('/picking-waves/' + w.wave.id + '/complete', 'POST', { version: w.wave.version });
  await ok('/orders/' + a.id + '/status', 'PATCH', await statusPayload(a, { status: 'packed' }));
  await ok('/orders/' + a.id + '/ship-demo', 'POST', {});
  assert.deepEqual([(await bins(p))[0].quantity, (await bins(p))[0].reserved], [8, 1]);
  assert.equal((await ok('/orders/' + b.id)).status, 'picking');
  await ok('/orders/' + a.id + '/documents', 'POST', { kind: 'invoice' });
  const full = await ok('/orders/' + a.id);
  const r = await ok('/orders/' + a.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'QA zwrot kompletacji',
    items: [{ item_id: full.items[0].id, quantity: 1 }],
  });
  await ok('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    shipping_refund: 0,
    note: 'QA przyjęcie',
    items: [{ item_id: full.items[0].id, accepted: 1, restocked: 1 }],
  });
  assert.equal(
    (await ok('/inventory/snapshot?warehouse_id=' + warehouse + '&product_ids=' + p.id)).data[0]
      .on_hand,
    9,
  );
  assert.equal((await ok('/orders/' + b.id)).status, 'picking');
});
test('odczyt wyniku czeka na zatwierdzenie skanu i używa świeżego snapshotu', async () => {
  const p = await product(),
    o = await order(p, 2),
    w = await create([o]),
    key = randomUUID();
  let ready!: () => void, release!: () => void;
  const prepared = new Promise<void>((r) => (ready = r)),
    held = new Promise<void>((r) => (release = r));
  const user = (await ok('/auth/me')).user;
  const tx = tenantTx(DEMO_TENANT, async (c) => {
    await c.query('SELECT id FROM picking_waves WHERE id=$1 FOR UPDATE', [w.wave.id]);
    const { scanWave } = await import('../server/picking-waves');
    await scanWave(c, { tenantId: DEMO_TENANT, userId: user.id, role: 'admin' }, w.wave.id, {
      version: w.wave.version,
      code: p.sku,
      location: 'A2',
      client_key: key,
    });
    ready();
    await held;
  });
  await Promise.race([prepared, tx]);
  const lookup = req('/picking-waves/' + w.wave.id + '/scan-result?client_key=' + key);
  // Release an actual in-flight transaction; the lookup must return its committed receipt.
  const timer = setTimeout(release, 40);
  try {
    const result = await lookup;
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().scan.order_id, o.id);
    assert.equal(result.json().version, '2');
    await tx;
  } finally {
    clearTimeout(timer);
    release();
    await tx;
  }
});
