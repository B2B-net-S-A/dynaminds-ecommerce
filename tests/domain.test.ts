import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { tick } from '../server/worker';
import type { FastifyInstance } from 'fastify';
assert.equal(process.env.DYNA_TEST, 'true', 'Uruchom testy przez npm test — wymagają osobnej bazy');
let app: FastifyInstance,
  adminCookie: string,
  otherCookie: string,
  viewerCookie: string,
  operatorCookie: string,
  warehouse: string;
const auth = (cookie: string) => ({ cookie });
const request = (
  url: string,
  method: any = 'GET',
  payload?: any,
  cookie = adminCookie,
  extra: Record<string, string> = {},
) => app.inject({ url, method, payload, headers: { ...auth(cookie), ...extra } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  async function login(email: string) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  adminCookie = await login('admin@demo.local');
  otherCookie = await login('other@demo.local');
  viewerCookie = await login('viewer@demo.local');
  operatorCookie = await login('operator@demo.local');
  warehouse = (await request('/api/warehouses')).json().data[0].id;
  await pool.query("UPDATE jobs SET state='done'");
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(stock = 10) {
  const sku = 'TEST-' + randomUUID().slice(0, 8);
  const r = await request('/api/products', 'POST', {
    name: 'Produkt testowy ' + sku,
    sku,
    price: 12300,
    warehouse_id: warehouse,
    quantity: stock,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
const orderBody = (p: string, quantity = 1) => ({
  customer_name: 'Klient testowy',
  email: 'test@example.test',
  warehouse_id: warehouse,
  items: [{ product_id: p, quantity }],
  shipping_cost: 1500,
  address: { city: 'Warszawa', street: 'Testowa 1', postal_code: '00-001' },
});
async function newOrder(p: string, qty = 1) {
  const r = await request('/api/orders', 'POST', orderBody(p, qty));
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function status(id: string, s: string) {
  const r = await request(`/api/orders/${id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => request(orderPath, 'GET', undefined), `/api/orders/${id}/status`, { status: s }));
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function stock(p: string) {
  return (await request('/api/inventory?product_id=' + p))
    .json()
    .data.find((s: any) => s.product_id === p && s.warehouse_id === warehouse);
}
test('brak sesji, niepoprawne hasło i niedozwolony Origin są odrzucane', async () => {
  assert.equal((await app.inject({ url: '/api/orders' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email: 'admin@demo.local', password: 'wrong' },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await request('/api/orders', 'POST', {}, adminCookie, { origin: 'https://evil.example' }))
      .statusCode,
    403,
  );
});
test('RLS izoluje organizacje nawet przy zapytaniach bez filtra tenant_id', async () => {
  const p = await product();
  const o = await newOrder(p.id);
  assert.equal(
    (await request(`/api/orders/${o.id}`, 'GET', undefined, otherCookie)).statusCode,
    404,
  );
  assert.equal(
    (await request('/api/products', 'GET', undefined, otherCookie))
      .json()
      .data.some((v: any) => v.id === p.id),
    false,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal((await c.query('SELECT current_user')).rows[0].current_user, 'dyna_app');
    assert.equal((await c.query('SELECT * FROM products WHERE id=$1', [p.id])).rowCount, 0);
    await assert.rejects(
      () =>
        c.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          DEMO_TENANT,
          'Nieuprawniony',
          'LEAK',
        ]),
      /row-level security/,
    );
  });
  const c = await pool.connect();
  try {
    await c.query('SET ROLE dyna_app');
    assert.equal((await c.query('SELECT * FROM orders')).rowCount, 0);
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
});
test('viewer nie zapisuje danych, operator nie zmienia katalogu ani integracji', async () => {
  assert.equal((await request('/api/orders', 'POST', {}, viewerCookie)).statusCode, 403);
  assert.equal((await request('/api/products', 'POST', {}, operatorCookie)).statusCode, 403);
  assert.equal((await request('/api/integrations', 'POST', {}, operatorCookie)).statusCode, 403);
  assert.equal((await request('/api/audit', 'GET', undefined, viewerCookie)).statusCode, 403);
});
test('równoczesne zamówienia nie sprzedają tego samego towaru dwa razy', async () => {
  const p = await product(3);
  const results = await Promise.all([
    request('/api/orders', 'POST', orderBody(p.id, 2)),
    request('/api/orders', 'POST', orderBody(p.id, 2)),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const s = await stock(p.id);
  assert.equal(s.on_hand, 3);
  assert.equal(s.reserved, 2);
  assert.equal(s.available, 1);
});
test('idempotencja przy równoczesnym ponowieniu tworzy jedno zamówienie i jedną rezerwację', async () => {
  const p = await product(10),
    key = randomUUID(),
    body = orderBody(p.id, 2);
  const results = await Promise.all([
    request('/api/orders', 'POST', body, adminCookie, { 'idempotency-key': key }),
    request('/api/orders', 'POST', body, adminCookie, { 'idempotency-key': key }),
  ]);
  assert.ok(
    results.every((r) => r.statusCode === 200 || r.statusCode === 201),
    results.map((r) => r.body).join(),
  );
  assert.equal(results[0].json().id, results[1].json().id);
  assert.equal((await stock(p.id)).reserved, 2);
  assert.equal(
    (
      await request('/api/orders', 'POST', orderBody(p.id, 3), adminCookie, {
        'idempotency-key': key,
      })
    ).statusCode,
    409,
  );
});
test('nieprawidłowy skan, nadmiarowy skan i przedwczesne pakowanie są blokowane', async () => {
  const p = await product(),
    o = await newOrder(p.id, 2);
  assert.equal((await request('/api/orders/' + randomUUID())).statusCode, 404);
  assert.equal(
    (await request(`/api/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => request(orderPath, 'GET', undefined), `/api/orders/${o.id}/status`, { status: 'packed' }))).statusCode,
    409,
  );
  await status(o.id, 'paid');
  await status(o.id, 'picking');
  assert.equal(
    (await request(`/api/orders/${o.id}/scan`, 'POST', { code: 'WRONG' })).statusCode,
    422,
  );
  assert.equal(
    (await request(`/api/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => request(orderPath, 'GET', undefined), `/api/orders/${o.id}/status`, { status: 'packed' }))).statusCode,
    409,
  );
  for (let n = 0; n < 2; n++)
    assert.equal(
      (await request(`/api/orders/${o.id}/scan`, 'POST', { code: p.sku })).statusCode,
      200,
    );
  assert.equal(
    (await request(`/api/orders/${o.id}/scan`, 'POST', { code: p.sku })).statusCode,
    409,
  );
  await status(o.id, 'packed');
});
test('niejednoznaczny EAN nie potwierdza losowego produktu', async () => {
  const a = await product(),
    b = await product();
  await pool.query('UPDATE products SET ean=$1 WHERE id=ANY($2::uuid[])', [
    'SAME-EAN',
    [a.id, b.id],
  ]);
  const r = await request('/api/orders', 'POST', {
    ...orderBody(a.id),
    items: [
      { product_id: a.id, quantity: 1 },
      { product_id: b.id, quantity: 1 },
    ],
  });
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  await status(o.id, 'paid');
  await status(o.id, 'picking');
  assert.equal(
    (await request(`/api/orders/${o.id}/scan`, 'POST', { code: 'SAME-EAN' })).statusCode,
    422,
  );
  const detail = (await request(`/api/orders/${o.id}`)).json();
  assert.ok(detail.items.every((i: any) => i.scanned === 0));
  assert.equal(
    (await request(`/api/orders/${o.id}/scan`, 'POST', { code: a.sku })).statusCode,
    200,
  );
});
test('pełny proces: rezerwacja, kompletacja, wysyłka, dokument, zwrot i korekta', async () => {
  const p = await product(5),
    o = await newOrder(p.id, 2);
  assert.equal(o.total, 26100);
  assert.equal((await stock(p.id)).reserved, 2);
  await status(o.id, 'paid');
  await status(o.id, 'picking');
  for (let n = 0; n < 2; n++) await request(`/api/orders/${o.id}/scan`, 'POST', { code: p.sku });
  await status(o.id, 'packed');
  const shipped = await request(`/api/orders/${o.id}/ship-demo`, 'POST');
  assert.equal(shipped.statusCode, 200, shipped.body);
  assert.equal(shipped.json().shipments[0].mode, 'demo');
  assert.equal((await stock(p.id)).on_hand, 3);
  assert.equal((await stock(p.id)).reserved, 0);
  assert.equal((await request(`/api/orders/${o.id}/ship-demo`, 'POST')).statusCode, 409);
  const doc = (await request(`/api/orders/${o.id}/documents`, 'POST', { kind: 'invoice' })).json();
  assert.equal(doc.data.total, 26100);
  assert.equal(
    (await request(`/api/orders/${o.id}/documents`, 'POST', { kind: 'invoice' })).json().id,
    doc.id,
  );
  const print = await request(`/api/documents/${doc.id}/print`);
  assert.equal(print.statusCode, 200);
  assert.match(print.body, /DEMO/);
  await status(o.id, 'delivered');
  await status(o.id, 'completed');
  await status(o.id, 'return_initiated');
  await status(o.id, 'return_received');
  assert.equal((await stock(p.id)).on_hand, 5);
  assert.equal(
    (await request(`/api/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => request(orderPath, 'GET', undefined), `/api/orders/${o.id}/status`, { status: 'return_received' })))
      .statusCode,
    409,
  );
  const correction = await request(`/api/orders/${o.id}/documents`, 'POST', { kind: 'correction' });
  assert.equal(correction.statusCode, 200, correction.body);
  assert.equal(correction.json().data.total, -26100);
  await status(o.id, 'return_completed');
  const movements = (await request('/api/inventory/movements'))
    .json()
    .data.filter((m: any) => m.order_id === o.id);
  assert.deepEqual(
    movements.map((m: any) => m.delta).sort((a: number, b: number) => a - b),
    [-2, 2],
  );
});
test('anulowanie zwalnia rezerwacje raz, korekta nie narusza rezerwacji', async () => {
  const p = await product(5),
    o = await newOrder(p.id, 3);
  assert.equal(
    (
      await request('/api/inventory/adjust', 'POST', {
        warehouse_id: warehouse,
        product_id: p.id,
        delta: -3,
        note: 'Test',
      })
    ).statusCode,
    409,
  );
  await status(o.id, 'cancelled');
  assert.equal((await stock(p.id)).reserved, 0);
  assert.equal((await stock(p.id)).on_hand, 5);
  assert.equal(
    (await request(`/api/orders/${o.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => request(orderPath, 'GET', undefined), `/api/orders/${o.id}/status`, { status: 'cancelled' }))).statusCode,
    409,
  );
});
test('obce magazyny i manipulacja walutą są odrzucane', async () => {
  const p = await product();
  const otherWarehouse = (await request('/api/warehouses', 'GET', undefined, otherCookie)).json()
    .data[0].id;
  assert.equal(
    (
      await request('/api/orders', 'POST', {
        ...orderBody(p.id),
        warehouse_id: otherWarehouse,
        tenant_id: SECOND_TENANT,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await request('/api/orders', 'POST', { ...orderBody(p.id), currency: 'EUR' })).statusCode,
    422,
  );
});
test('kursor zamówień nie pomija ani nie dubluje rekordów', async () => {
  const first = (await request('/api/orders?limit=3')).json();
  assert.equal(first.data.length, 3);
  assert.ok(first.meta.has_more);
  const second = (
    await request('/api/orders?limit=3&after=' + encodeURIComponent(first.meta.cursor))
  ).json();
  assert.ok(second.data.every((o: any) => !first.data.some((p: any) => p.id === o.id)));
  assert.equal((await request('/api/orders?after=garbage')).statusCode, 422);
});
test('sekrety integracji są zaszyfrowane i nie trafiają do odpowiedzi', async () => {
  const secret = 'SECRET-FIXTURE-' + randomUUID();
  const r = await request('/api/integrations', 'POST', {
    provider: 'inpost',
    name: 'Test InPost',
    mode: 'sandbox',
    credentials: { access_token: secret },
    settings: { organization_id: '1' },
  });
  assert.equal(r.statusCode, 200, r.body);
  const stored = (await pool.query('SELECT credentials FROM channels WHERE id=$1', [r.json().id]))
    .rows[0];
  assert.ok(!stored.credentials.includes(secret));
  const list = await request('/api/integrations');
  assert.ok(!list.body.includes(secret));
  assert.ok(!list.body.includes(stored.credentials));
  assert.equal(
    (await request('/api/integrations', 'GET', undefined, otherCookie))
      .json()
      .channels.some((ch: any) => ch.id === r.json().id),
    false,
  );
});
test('trwała automatyzacja wykonuje akcję raz i zapisuje dowód', async () => {
  await pool.query("UPDATE jobs SET state='done'");
  const r = await request('/api/automations', 'POST', {
    name: 'Test notatki',
    trigger: 'order.paid',
    note: 'AUTOMATION-FIXTURE',
  });
  assert.equal(r.statusCode, 200, r.body);
  const p = await product(),
    o = await newOrder(p.id);
  await status(o.id, 'paid');
  for (let n = 0; n < 20; n++) if (!(await tick())) break;
  assert.equal((await request(`/api/orders/${o.id}`)).json().note, 'AUTOMATION-FIXTURE');
  await tick();
  assert.equal((await request(`/api/orders/${o.id}`)).json().note, 'AUTOMATION-FIXTURE');
  const events = await pool.query(
    "SELECT * FROM audit_events WHERE action='automation.executed' AND entity_id=$1",
    [r.json().id],
  );
  assert.equal(events.rowCount, 1);
});
test('nieobsługiwane zadanie ma retry i backoff zamiast utraty', async () => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,run_at) VALUES($1,$2,'invalid','{}',$3,now()-interval '1 day')",
    [id, DEMO_TENANT, id],
  );
  await tick();
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 1);
  assert.ok(job.run_at.getTime() > Date.now());
  assert.match(job.error, /Nieobsługiwane/);
});
test('portal kupującego ujawnia tylko zakres zamówienia i escapuje HTML', async () => {
  const p = await product();
  await pool.query('UPDATE products SET name=$1 WHERE id=$2', [
    '<img src=x onerror=alert(1)>',
    p.id,
  ]);
  const o = await newOrder(p.id);
  const pub = await app.inject({ url: `/api/public/orders/${o.portal_token}` });
  assert.equal(pub.statusCode, 200);
  assert.ok(pub.body.includes(o.number));
  assert.ok(!pub.body.includes(o.email));
  assert.ok(!pub.body.includes(adminCookie));
  assert.ok(pub.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!pub.body.includes('<img src=x'));
  assert.equal((await app.inject({ url: '/api/public/orders/' + '0'.repeat(48) })).statusCode, 404);
});
