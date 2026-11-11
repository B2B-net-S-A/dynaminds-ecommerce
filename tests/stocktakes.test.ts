import { test, before, beforeEach, after } from 'node:test';
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

beforeEach(async () => {
  await pool.query(
    "UPDATE stocktakes SET state='cancelled',version=version+1 WHERE state IN ('counting','review')",
  );
  warehouse = (
    await ok('/warehouses', 'POST', {
      name: 'Spis QA ' + randomUUID().slice(0, 8),
      code: 'ST-' + randomUUID().slice(0, 8),
    })
  ).id;
});
const create = (extra: any = {}) =>
  ok('/stocktakes', 'POST', {
    warehouse_id: warehouse,
    name: 'Spis testowy',
    blind: false,
    client_key: randomUUID(),
    ...extra,
  });
const detail = (d: any, auth = cookie) =>
  req('/stocktakes/' + d.id, 'GET', undefined, auth).then((r) => {
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  });
const measure = (d: any, lines: any[], extra: any = {}, auth = cookie) =>
  req(
    '/stocktakes/' + d.id + '/counts',
    'POST',
    {
      client_key: randomUUID(),
      note: 'Pomiar testowy',
      lines: lines.map((l) => ({
        id: l.id,
        version: l.version,
        expected_stock_version: l.current_stock_version,
        quantity: l.quantity ?? l.current_quantity,
      })),
      ...extra,
    },
    auth,
  );
async function counted(d: any, qty?: number) {
  const rows = await detail(d);
  const r = await measure(
    d,
    rows.lines.map((l: any) => ({ ...l, quantity: qty ?? l.current_quantity })),
  );
  assert.equal(r.statusCode, 200, r.body);
  return detail(d);
}
async function phase(d: any, type: string, extra: any = {}) {
  return ok('/stocktakes/' + d.id + '/' + type, 'POST', { version: d.version, ...extra });
}
async function post(d: any) {
  return phase(await phase(d, 'review'), 'post', { confirmed: true });
}
test('spis wielolokalizacyjny: szkic, pomiar, przegląd, rozliczenie i replay bez podwójnych ruchów', async () => {
  const p = await product();
  await ok('/stock-location-moves', 'POST', await op(p));
  const d = await create(),
    v = await detail(d);
  assert.equal(v.lines.length, 2);
  assert.equal(v.summary.counted, 0);
  const input = v.lines.map((l: any) => ({ ...l, quantity: l.location === 'A-01' ? 4 : 5 }));
  assert.equal((await measure(d, input)).statusCode, 200);
  let ready = await detail(d);
  assert.equal(ready.summary.delta, -1);
  assert.equal((await bins(p))[0].warehouse_on_hand, undefined);
  assert.equal(
    (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [p.id])).rows[0].on_hand,
    10,
  );
  ready = await phase(ready, 'review');
  assert.equal((await measure(d, input)).statusCode, 409);
  const body = { version: ready.version, confirmed: true };
  const [x, y] = await Promise.all([
    req('/stocktakes/' + d.id + '/post', 'POST', body),
    req('/stocktakes/' + d.id + '/post', 'POST', body),
  ]);
  assert.equal(x.statusCode, 200, x.body);
  assert.equal(y.statusCode, 200, y.body);
  assert.deepEqual(
    (await bins(p)).map((b: any) => [b.location, b.quantity]),
    [
      ['A-01', 4],
      ['B-02', 5],
    ],
  );
  const done = await detail(d);
  assert.equal(done.state, 'posted');
  assert.equal(done.summary.conflicts, 0);
  assert.equal(
    (await pool.query('SELECT * FROM stock_location_movements WHERE stocktake_id=$1', [d.id]))
      .rowCount,
    2,
  );
  assert.equal(
    (await pool.query('SELECT delta FROM stock_movements WHERE stocktake_id=$1', [d.id])).rows[0]
      .delta,
    -1,
  );
});
test('przesunięcie w rozkładzie z zerową różnicą sumy zachowuje oba ruchy miejsc', async () => {
  const p = await product();
  await ok('/stock-location-moves', 'POST', await op(p));
  const d = await create(),
    v = await detail(d);
  assert.equal(
    (
      await measure(
        d,
        v.lines.map((l: any) => ({ ...l, quantity: l.location === 'A-01' ? 4 : 6 })),
      )
    ).statusCode,
    200,
  );
  await post(await detail(d));
  assert.equal(
    (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [p.id])).rows[0].on_hand,
    10,
  );
  assert.equal(
    (await pool.query('SELECT * FROM stock_movements WHERE stocktake_id=$1', [d.id])).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT * FROM stock_location_movements WHERE stocktake_id=$1', [d.id]))
      .rowCount,
    2,
  );
});
test('niepoliczone pozycje blokują przegląd, jawne zero jest poprawnym pomiarem', async () => {
  await product(1);
  const d = await create();
  assert.equal(
    (await req('/stocktakes/' + d.id + '/review', 'POST', { version: d.version })).statusCode,
    409,
  );
  const v = await counted(d, 0);
  await post(v);
  assert.equal((await detail(d)).summary.delta, -1);
});
test('blind ukrywa ilości oczekiwane przed rozliczeniem, operator liczy, viewer nie zapisuje', async () => {
  await product(7);
  const d = await create({ blind: true }),
    v = await detail(d, operator);
  assert.equal(v.lines[0].current_quantity, undefined);
  assert.equal(v.lines[0].basis_quantity, undefined);
  assert.equal(v.summary.delta, undefined);
  const inputs = v.lines.map((l: any) => ({ ...l, quantity: 6 }));
  assert.equal((await measure(d, inputs, {}, viewer)).statusCode, 403);
  assert.equal((await measure(d, inputs, {}, operator)).statusCode, 200);
  const ready = await detail(d);
  assert.equal(ready.summary.delta, -1);
  assert.equal(
    (await req('/stocktakes/' + d.id + '/review', 'POST', { version: ready.version }, operator))
      .statusCode,
    403,
  );
  await post(ready);
  assert.equal((await detail(d, operator)).lines[0].basis_quantity, 7);
});
test('RLS, obca firma i obca pozycja nie pozwalają liczyć ani czytać spisu', async () => {
  await product();
  const d = await create();
  assert.equal((await req('/stocktakes/' + d.id, 'GET', undefined, other)).statusCode, 404);
  const f = await req(
    '/stocktakes',
    'POST',
    { warehouse_id: warehouse, name: 'Obcy spis', client_key: randomUUID() },
    other,
  );
  assert.equal(f.statusCode, 404);
  const v = await detail(d);
  assert.equal((await measure(d, [{ ...v.lines[0], id: randomUUID() }])).statusCode, 404);
  assert.equal(
    (await tenantTx(SECOND_TENANT, (c) => c.query('SELECT * FROM stocktakes WHERE id=$1', [d.id])))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('UPDATE stocktake_lines SET tenant_id=$1 WHERE id=$2', [
          SECOND_TENANT,
          v.lines[0].id,
        ]),
      )
    ).rowCount,
    0,
  );
});
test('utworzenie i pomiar mają idempotencję z kontrolą autora oraz zakresu', async () => {
  await product();
  const key = randomUUID(),
    d = await create({ client_key: key });
  assert.equal((await create({ client_key: key })).id, d.id);
  assert.equal(
    (
      await req('/stocktakes', 'POST', {
        warehouse_id: warehouse,
        name: 'Inny zakres',
        blind: false,
        client_key: key,
      })
    ).statusCode,
    409,
  );
  const v = await detail(d),
    ck = randomUUID(),
    r = await measure(d, v.lines, { client_key: ck });
  assert.equal(r.statusCode, 200);
  assert.equal((await measure(d, v.lines, { client_key: ck })).json().reused, true);
  assert.equal(
    (await measure(d, v.lines, { client_key: ck, note: 'Inny zakres' })).statusCode,
    409,
  );
  assert.equal((await measure(d, v.lines, { client_key: ck }, operator)).statusCode, 409);
  assert.equal(
    (await pool.query('SELECT * FROM stocktake_measurements WHERE stocktake_id=$1', [d.id]))
      .rowCount,
    1,
  );
});
test('ruch po pomiarze blokuje stary przegląd, ponowny pomiar korzysta z nowej bazy', async () => {
  const p = await product();
  const d = await create();
  let v = await counted(d, 9);
  await ok('/stock-location-counts', 'POST', await op(p, 'counts', { quantity: 12 }));
  assert.equal((await detail(d)).summary.conflicts, 1);
  assert.equal(
    (await req('/stocktakes/' + d.id + '/review', 'POST', { version: v.version })).statusCode,
    409,
  );
  v = await counted(d, 11);
  await post(v);
  assert.equal((await bins(p))[0].quantity, 11);
  assert.equal((await detail(d)).summary.delta, -1);
});
test('nowa rezerwacja po przeglądzie blokuje post, poniżej rezerwacji zachowuje pomiar bez korekty', async () => {
  const p = await product();
  const d = await create();
  let v = await phase(await counted(d, 5), 'review');
  await order(p, 8);
  assert.equal(
    (await req('/stocktakes/' + d.id + '/post', 'POST', { version: v.version, confirmed: true }))
      .statusCode,
    409,
  );
  v = await phase(v, 'reopen');
  v = await counted(d, 5);
  assert.equal(v.summary.below_reserved, 1);
  assert.equal(
    (await req('/stocktakes/' + d.id + '/review', 'POST', { version: v.version })).statusCode,
    409,
  );
  assert.equal((await bins(p))[0].quantity, 10);
});
test('dwa operatory tej samej pozycji nie nadpisują wzajemnie pomiaru', async () => {
  await product();
  const d = await create(),
    v = await detail(d);
  const [a, b] = await Promise.all([
    measure(
      d,
      v.lines.map((l: any) => ({ ...l, quantity: 8 })),
    ),
    measure(
      d,
      v.lines.map((l: any) => ({ ...l, quantity: 9 })),
      {},
      operator,
    ),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal(
    (await pool.query('SELECT * FROM stocktake_measurements WHERE stocktake_id=$1', [d.id]))
      .rowCount,
    1,
  );
});
test('stan zmieniony podczas liczenia oraz ABA są odrzucane przed zapisem pomiaru', async () => {
  const p = await product(),
    d = await create(),
    v = await detail(d);
  await ok('/stock-location-counts', 'POST', await op(p, 'counts', { quantity: 11 }));
  await ok('/stock-location-counts', 'POST', await op(p, 'counts', { quantity: 10 }));
  assert.equal((await measure(d, v.lines)).statusCode, 409);
  assert.equal((await detail(d)).summary.counted, 0);
});
test('cała paczka pomiarów i całe rozliczenie są atomowe przy jednej błędnej pozycji', async () => {
  await product(10);
  await product(20);
  const d = await create(),
    v = await detail(d),
    input = v.lines.map((l: any) => ({ ...l, quantity: 1 }));
  input[1].current_stock_version = '999';
  assert.equal((await measure(d, input)).statusCode, 409);
  assert.equal((await detail(d)).summary.counted, 0);
});
test('zatwierdzona i anulowana historia jest niezmienna, pomiary nie mają UPDATE ani DELETE', async () => {
  const p = await product();
  const d = await post(await counted(await create(), 5));
  const v = await detail(d);
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE stocktakes SET state='counting',posted_by=NULL,posted_at=NULL WHERE id=$1", [
        d.id,
      ]),
    ),
    /niezmienny/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE stocktake_lines SET counted=2 WHERE id=$1', [v.lines[0].id]),
    ),
    /liczenia/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('DELETE FROM stocktake_measurements WHERE stocktake_id=$1', [d.id]),
    ),
    /permission/,
  );
  const x = await create();
  await phase(x, 'cancel');
  assert.equal((await measure(x, (await detail(x)).lines)).statusCode, 409);
  await ok('/stock-location-counts', 'POST', await op(p, 'counts', { quantity: 20 }));
  await order(p, 8);
  const historical = await detail(d);
  assert.equal(historical.lines[0].counted, 5);
  assert.equal(historical.lines[0].reserved, 8);
  assert.equal(historical.summary.below_reserved, 0);
  assert.equal(historical.summary.conflicts, 0);
});
test('zakres prefiksu, zero lokalizacji, brak towaru i walidacja są jawne', async () => {
  const p = await product();
  await ok('/stock-location-moves', 'POST', await op(p, 'moves', { quantity: 10 }));
  const d = await create({ location_prefix: 'B-' });
  assert.equal((await detail(d)).lines.length, 1);
  assert.equal(
    (
      await req('/stocktakes', 'POST', {
        warehouse_id: warehouse,
        name: 'Pusty',
        location_prefix: 'Z-',
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/stocktakes', 'POST', {
        warehouse_id: warehouse,
        name: 'X',
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  const full = await create();
  assert.equal((await detail(full)).lines.length, 2);
  assert.equal(
    (await req('/stocktakes/' + d.id + '/post', 'POST', { version: d.version, confirmed: false }))
      .statusCode,
    422,
  );
});
test('strony pozycji i pomiarów nie dublują danych, kursor z innego spisu jest odrzucony', async () => {
  for (let i = 0; i < 28; i++) await product(2);
  const d = await create(),
    a = await detail(d),
    r = await ok('/stocktakes/' + d.id + '?after=' + a.meta.cursor);
  assert.equal(a.lines.length, 25);
  assert.equal(r.lines.length, 3);
  assert.equal(new Set([...a.lines, ...r.lines].map((l) => l.id)).size, 28);
  const otherDoc = await create();
  assert.equal(
    (await req('/stocktakes/' + otherDoc.id + '?after=' + a.lines[0].id)).statusCode,
    422,
  );
  assert.equal((await measure(d, [...a.lines, ...r.lines])).statusCode, 200);
  const h = await ok('/stocktakes/' + d.id + '/measurements');
  assert.equal(h.data.length, 1);
  assert.equal(h.data[0].inputs.length, 28);
  assert.equal(h.data[0].display_inputs.length, 28);
  for (const input of h.data[0].display_inputs) {
    const line = [...a.lines, ...r.lines].find((l) => l.id === input.id)!;
    assert.equal(input.sku, line.sku);
    assert.equal(input.location, line.location);
    assert.equal(input.quantity, h.data[0].inputs.find((l: any) => l.id === input.id).quantity);
  }
});
test('publiczne API zachowuje inventory scopes i bieżącą rolę', async () => {
  const document = await ok('/developer/openapi');
  assert.deepEqual(
    document.paths['/stocktakes/{id}'].get.parameters.map((p: any) => p.name),
    ['id', 'after', 'limit', 'q'],
  );
  await product();
  const d = await create(),
    k = (await ok('/developer/keys', 'POST', { name: 'Spis read', scopes: ['inventory:read'] }))
      .token;
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/stocktakes/' + d.id,
        headers: { authorization: 'Bearer ' + k },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/stocktakes/' + d.id + '/review',
        method: 'POST',
        payload: { version: d.version },
        headers: { authorization: 'Bearer ' + k },
      })
    ).statusCode,
    403,
  );
  const writeKey = (
    await ok('/developer/keys', 'POST', {
      name: 'Spis write',
      scopes: ['inventory:read', 'inventory:write'],
    })
  ).token;
  const write = async (path: string, payload: any) => {
    const r = await app.inject({
      url: '/api/v1/stocktakes/' + d.id + path,
      method: 'POST',
      payload,
      headers: { authorization: 'Bearer ' + writeKey },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const v = await detail(d);
  let receipt = await write('/counts', {
    client_key: randomUUID(),
    note: 'Pomiar przez publiczne API',
    lines: v.lines.map((l: any) => ({
      id: l.id,
      version: l.version,
      expected_stock_version: l.current_stock_version,
      quantity: 5,
    })),
  });
  receipt = await write('/review', { version: receipt.version });
  receipt = await write('/post', { version: receipt.version, confirmed: true });
  assert.equal(receipt.state, 'posted');
  assert.equal(
    (await ok('/stocktakes/' + d.id + '/measurements')).data[0].actor_name,
    'Aleksandra Nowak',
  );
});
test('konflikt ostatniego SKU blokuje całe rozliczenie bez częściowych korekt', async () => {
  const p = await product(10),
    q = await product(20),
    d = await create();
  let v = await counted(d, 9);
  v = await phase(v, 'review');
  await ok('/stock-location-counts', 'POST', await op(q, 'counts', { quantity: 21 }));
  assert.equal(
    (await req('/stocktakes/' + d.id + '/post', 'POST', { version: v.version, confirmed: true }))
      .statusCode,
    409,
  );
  assert.equal((await bins(p))[0].quantity, 10);
  assert.equal(
    (await pool.query('SELECT * FROM stock_movements WHERE stocktake_id=$1', [d.id])).rowCount,
    0,
  );
  assert.equal((await detail(d)).state, 'review');
});
test('limit otwartych spisów jest atomowy przy współbieżnym utworzeniu', async () => {
  await product();
  for (let i = 0; i < 19; i++) await create();
  const body = () => ({
    warehouse_id: warehouse,
    name: 'Limit otwartych',
    client_key: randomUUID(),
  });
  const a = await Promise.all([
    req('/stocktakes', 'POST', body()),
    req('/stocktakes', 'POST', body()),
  ]);
  assert.deepEqual(a.map((r) => r.statusCode).sort(), [200, 422]);
});
test('przekroczenie 2000 pozycji cofa cały nowy spis, zawężony prefiks działa', async () => {
  const p = await product(2001);
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query('UPDATE stock_locations SET quantity=0 WHERE warehouse_id=$1 AND product_id=$2', [
      warehouse,
      p.id,
    ]);
    await c.query(
      "INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) SELECT $1,$2,$3,'B-'||lpad(i::text,4,'0'),1 FROM generate_series(1,2001)i",
      [DEMO_TENANT, warehouse, p.id],
    );
  });
  assert.equal(
    (
      await req('/stocktakes', 'POST', {
        warehouse_id: warehouse,
        name: 'Za duży',
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await pool.query('SELECT * FROM stocktakes WHERE warehouse_id=$1', [warehouse])).rowCount,
    0,
  );
  const d = await create({ location_prefix: 'A-' });
  assert.equal((await detail(d)).summary.total, 1);
});
test('501 miejsc: strony, pakiety100 i zbiorcze rozliczenie bez pobierania całej listy do panelu', async () => {
  const p = await product(500);
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query('UPDATE stock_locations SET quantity=0 WHERE warehouse_id=$1 AND product_id=$2', [
      warehouse,
      p.id,
    ]);
    await c.query(
      "INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) SELECT $1,$2,$3,'S-'||lpad(i::text,4,'0'),1 FROM generate_series(1,500)i",
      [DEMO_TENANT, warehouse, p.id],
    );
  });
  const start = performance.now(),
    d = await create();
  let after = '';
  let n = 0;
  do {
    const v = await ok('/stocktakes/' + d.id + '?limit=100' + (after ? '&after=' + after : ''));
    const r = await measure(
      d,
      v.lines.map((l: any) => ({ ...l, quantity: l.location === 'A-01' ? 0 : 2 })),
    );
    assert.equal(r.statusCode, 200, r.body);
    n += v.lines.length;
    after = v.meta.cursor;
  } while (after);
  assert.equal(n, 501);
  await post(await detail(d));
  assert.equal(
    (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [p.id])).rows[0].on_hand,
    1000,
  );
  assert.equal(
    (await pool.query('SELECT * FROM stock_location_movements WHERE stocktake_id=$1', [d.id]))
      .rowCount,
    500,
  );
  console.log(
    JSON.stringify({
      stocktake_lines: 501,
      create_count_review_post_ms: Math.round(performance.now() - start),
      scope: 'synthetic fixture; not target scale',
    }),
  );
});
