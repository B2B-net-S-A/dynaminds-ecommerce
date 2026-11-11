import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { normalizeOrder } from '../server/imports';
import { demoPrestaOrder } from '../server/prestashop-example';
import { shippingInput } from '../server/shipping';
import type { FastifyInstance } from 'fastify';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance,
  cookie: string,
  viewer: string,
  operator: string,
  other: string,
  warehouse: string;
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie: auth } });
async function ok(path: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(path, method, payload, auth);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
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
    assert.equal(r.statusCode, 200);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  cookie = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function make(mode = 'prepaid', quantity = 1) {
  const sku = 'PAY-' + randomUUID().slice(0, 8),
    p = await ok('/products', 'POST', {
      sku,
      name: 'Płatności QA',
      price: 10000,
      warehouse_id: warehouse,
      quantity: 20,
    });
  return ok('/orders', 'POST', {
    customer_name: 'Płatności QA',
    email: 'payment@example.test',
    warehouse_id: warehouse,
    payment_mode: mode,
    items: [{ product_id: p.id, quantity }],
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', phone: '500600700' },
  });
}
async function entry(o: any, amount: number, kind = 'receipt', extra: any = {}) {
  o = await ok('/orders/' + o.id);
  const body = {
    client_key: randomUUID(),
    version: Number(o.version),
    kind,
    amount,
    currency: o.currency,
    reference: 'QA rozliczenie',
    confirmed: true,
    ...extra,
  };
  return { body, result: await ok('/orders/' + o.id + '/payments', 'POST', body) };
}
async function fulfill(o: any) {
  if (o.payment_mode !== 'cod')
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'paid' }));
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  for (const i of o.picking_items)
    for (let n = 0; n < i.quantity; n++)
      await ok('/orders/' + o.id + '/scan', 'POST', { code: i.sku });
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  return ok('/orders/' + o.id + '/ship-demo', 'POST');
}
async function reverse(o: any, id: string, auth = cookie) {
  o = await ok('/orders/' + o.id);
  return req(
    '/orders/' + o.id + '/payments/reverse',
    'POST',
    {
      client_key: randomUUID(),
      version: Number(o.version),
      entry_id: id,
      reason: 'Korekta błędnego potwierdzenia',
      confirmed: true,
    },
    auth,
  );
}
async function returned(o: any, qty = 1) {
  const r = await ok('/orders/' + o.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'Zwrot QA',
    items: [{ item_id: o.items[0].id, quantity: qty }],
  });
  return ok('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    shipping_refund: 0,
    note: 'Przyjęcie QA',
    items: [{ item_id: o.items[0].id, accepted: qty, restocked: qty }],
  });
}
test('partial receipts preserve physical reservation and only full payment advances new order', async () => {
  const o = await make();
  assert.equal(o.payment.amount_due, 10000);
  await entry(o, 3000);
  let x = await ok('/orders/' + o.id);
  assert.equal(x.status, 'new');
  assert.equal(x.payment.amount_due, 7000);
  assert.equal(
    (await req('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }))).statusCode,
    409,
  );
  await entry(o, 7000);
  x = await ok('/orders/' + o.id);
  assert.equal(x.status, 'paid');
  assert.equal(x.payment.received, 10000);
  assert.equal(x.payment.amount_due, 0);
  const s = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          'SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2',
          [o.items[0].product_id, warehouse],
        )
      ).rows[0],
  );
  assert.deepEqual(s, { on_hand: 20, reserved: 1 });
});
test('concurrent duplicate payment confirms exactly once and modified replay is rejected', async () => {
  const o = await make(),
    body = {
      client_key: randomUUID(),
      version: Number(o.version),
      kind: 'receipt',
      amount: 2000,
      currency: 'PLN',
      reference: 'Replay QA',
      confirmed: true,
    };
  const rs = await Promise.all(
    Array.from({ length: 6 }, () => req('/orders/' + o.id + '/payments', 'POST', body)),
  );
  assert(rs.every((r) => r.statusCode === 200));
  const h = await ok('/orders/' + o.id + '/payments');
  assert.equal(h.data.length, 1);
  assert.equal(h.balance.received, 2000);
  assert.equal(
    (await req('/orders/' + o.id + '/payments', 'POST', { ...body, amount: 3000 })).statusCode,
    409,
  );
});
test('concurrent distinct confirmations fence stale versions and do not silently double charge', async () => {
  const o = await make(),
    b = {
      version: Number(o.version),
      kind: 'receipt',
      amount: 7000,
      currency: 'PLN',
      reference: 'Race QA',
      confirmed: true,
    };
  const rs = await Promise.all([
    req('/orders/' + o.id + '/payments', 'POST', { ...b, client_key: randomUUID() }),
    req('/orders/' + o.id + '/payments', 'POST', { ...b, client_key: randomUUID() }),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await ok('/orders/' + o.id)).payment.received, 7000);
});
test('role, tenant, currency, positivity and explicit confirmation are enforced', async () => {
  const o = await make(),
    b = {
      client_key: randomUUID(),
      version: Number(o.version),
      kind: 'receipt',
      amount: 100,
      currency: 'PLN',
      reference: 'QA contrôle',
      confirmed: true,
    };
  assert.equal((await req('/orders/' + o.id + '/payments', 'POST', b, viewer)).statusCode, 403);
  assert.equal(
    (await req('/orders/' + o.id + '/payments', 'GET', undefined, other)).statusCode,
    404,
  );
  for (const extra of [
    { currency: 'EUR' },
    { amount: 0 },
    { amount: 0.5 },
    { fee: 1 },
    { confirmed: false },
  ])
    assert.equal(
      (await req('/orders/' + o.id + '/payments', 'POST', { ...b, ...extra })).statusCode,
      422,
    );
  await ok('/orders/' + o.id + '/payments', 'POST', b, operator);
});
test('append-only ledger RLS and SQL grants prevent editing or deletion', async () => {
  const o = await make();
  await entry(o, 100);
  await tenantTx(SECOND_TENANT, async (c) =>
    assert.equal(
      (await c.query('SELECT * FROM payment_entries WHERE order_id=$1', [o.id])).rowCount,
      0,
    ),
  );
  for (const sql of [
    'UPDATE payment_entries SET amount=1 WHERE order_id=$1',
    'DELETE FROM payment_entries WHERE order_id=$1',
  ])
    await assert.rejects(
      () => tenantTx(DEMO_TENANT, (c) => c.query(sql, [o.id])),
      /permission denied/,
    );
});
test('overpayment can be refunded locally exactly up to available cash and corrections remain visible', async () => {
  const o = await make();
  await entry(o, 12000);
  assert.equal((await ok('/orders/' + o.id)).payment.overpayment, 2000);
  const x = await entry(o, 2000, 'refund');
  assert.equal(x.result.balance.refunded, 2000);
  const current = await ok('/orders/' + o.id);
  assert.equal(
    (
      await req('/orders/' + o.id + '/payments', 'POST', {
        ...x.body,
        version: Number(current.version),
        client_key: randomUUID(),
        amount: 1,
      })
    ).statusCode,
    422,
  );
  const r = await reverse(o, x.result.data[0].id);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().balance.overpayment, 2000);
  assert(r.json().data.some((e: any) => e.kind === 'reversal' && e.amount === -2000));
});
test('admin correction restores debt, preserves physical stage and blocks unfunded packing', async () => {
  const o = await make(),
    e = await entry(o, 10000);
  const id = e.result.data[0].id;
  assert.equal((await reverse(o, id, operator)).statusCode, 403);
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  assert.equal((await reverse(o, id)).statusCode, 200);
  const x = await ok('/orders/' + o.id);
  assert.equal(x.status, 'picking');
  assert.equal(x.payment.amount_due, 10000);
  assert.equal(
    (await req('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }))).statusCode,
    409,
  );
  assert.equal((await reverse(o, id)).statusCode, 409);
});
test('COD ships unpaid, collection and remittance with fee are separate and bounded', async () => {
  let o = await make('cod');
  await entry(o, 2000);
  o = await fulfill(o);
  assert.equal(o.status, 'shipped');
  assert.equal(o.payment.received, 2000);
  const s = o.shipments[0];
  assert.equal(s.cod_expected, 8000);
  assert.equal(
    (await entry(o, 8000, 'courier_collection', { shipment_id: s.id })).result.balance.courier_due,
    8000,
  );
  const r = await entry(o, 7800, 'courier_remittance', { shipment_id: s.id, fee: 200 });
  assert.equal(r.result.balance.courier_due, 0);
  assert.equal(r.result.balance.received, 10000);
  assert.equal(r.result.balance.remitted, 7800);
  assert.equal((await ok('/orders/' + o.id)).status, 'shipped');
  const collection = r.result.data.find((e: any) => e.kind === 'courier_collection');
  assert.equal((await reverse(o, collection.id)).statusCode, 409);
  assert.equal(
    (await reverse(o, r.result.data.find((e: any) => e.kind === 'courier_remittance').id))
      .statusCode,
    200,
  );
  assert.equal((await reverse(o, collection.id)).statusCode, 200);
  assert.equal((await ok('/orders/' + o.id)).payment.amount_due, 8000);
});
test('delivery does not create a payment and collection is not allowed before dispatch', async () => {
  let o = await make('cod');
  const b = {
    client_key: randomUUID(),
    version: Number(o.version),
    kind: 'courier_collection',
    amount: 10000,
    currency: 'PLN',
    shipment_id: randomUUID(),
    reference: 'QA collection',
    confirmed: true,
  };
  assert.equal((await req('/orders/' + o.id + '/payments', 'POST', b)).statusCode, 409);
  o = await fulfill(o);
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'delivered' }));
  const x = await ok('/orders/' + o.id);
  assert.equal(x.payment.received, 0);
  assert.equal(x.payment.amount_due, 10000);
});
test('unpaid COD full return closes with zero payout, credit removes debt without inventing cash', async () => {
  let o = await fulfill(await make('cod'));
  const r = await returned(o);
  assert.equal(r.settlement_amount, 0);
  assert.equal(r.refund_amount, 10000);
  const result = await ok('/returns/' + r.id + '/refund', 'POST', {
    version: Number(r.version),
    amount: 0,
    reference: 'Brak wpłaty — rozliczenie należności',
    confirmed: true,
  });
  assert.equal(result.state, 'closed');
  o = await ok('/orders/' + o.id);
  assert.equal(o.payment.amount_due, 0);
  assert.equal(o.payment.received, 0);
  assert.equal(o.payment.refunded, 0);
  assert.equal((await ok('/orders/' + o.id + '/payments')).data.length, 0);
  const portal = await ok('/public/orders/' + o.portal_token + '/data');
  assert.equal(portal.cases[0].settlement_amount, 0);
  const html = await req('/public/orders/' + o.portal_token);
  assert.equal(html.statusCode, 200);
  assert(html.body.includes('Rozliczono należność bez wypłaty środków.'));
  assert(!JSON.stringify(portal).includes('Brak wpłaty — rozliczenie należności'));
});
test('partly prepaid COD return pays back only actual received funds', async () => {
  let o = await make('cod');
  await entry(o, 2000);
  o = await fulfill(o);
  const r = await returned(o);
  assert.equal(r.settlement_amount, 2000);
  assert.equal(
    (
      await req('/returns/' + r.id + '/refund', 'POST', {
        version: Number(r.version),
        amount: 10000,
        reference: 'Błędna pełna wypłata',
        confirmed: true,
      })
    ).statusCode,
    422,
  );
  await ok('/returns/' + r.id + '/refund', 'POST', {
    version: Number(r.version),
    amount: 2000,
    reference: 'Zwrócono zaliczkę QA',
    confirmed: true,
  });
  const b = (await ok('/orders/' + o.id)).payment;
  assert.equal(b.refunded, 2000);
  assert.equal(b.amount_due, 0);
  assert.equal(b.overpayment, 0);
});
test('late COD collection after zero-payout return is visible as cash available for refund', async () => {
  let o = await fulfill(await make('cod'));
  const r = await returned(o);
  await ok('/returns/' + r.id + '/refund', 'POST', {
    version: Number(r.version),
    amount: 0,
    reference: 'Nie pobrano środków QA',
    confirmed: true,
  });
  const collection = await entry(o, 10000, 'courier_collection', {
    shipment_id: o.shipments[0].id,
  });
  assert.equal(collection.result.balance.overpayment, 10000);
  const refund = await entry(o, 10000, 'refund');
  assert.equal(refund.result.balance.refunded, 10000);
  assert.equal(refund.result.balance.amount_due, 0);
});
test('cancelled prepaid order exposes all received funds for refund without releasing stock twice', async () => {
  const o = await make();
  await entry(o, 2000);
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'cancelled' }));
  const x = await ok('/orders/' + o.id);
  assert.equal(x.payment.overpayment, 2000);
  await entry(o, 2000, 'refund');
  assert.equal((await ok('/orders/' + o.id)).payment.net, 0);
});
const woo = () => ({
  id: 99001,
  status: 'processing',
  payment_method: 'cod',
  date_paid: '2026-10-04T10:00:00',
  currency: 'PLN',
  total: '100.00',
  shipping_total: '0.00',
  shipping_tax: '0.00',
  billing: {
    email: 'cod@example.test',
    first_name: 'Jan',
    last_name: 'COD',
    address_1: 'Testowa 1',
    city: 'Warszawa',
    postcode: '00-001',
    country: 'PL',
    phone: '500600700',
  },
  line_items: [
    {
      product_id: 77,
      name: 'COD QA',
      sku: 'COD-IMPORT',
      quantity: 1,
      total: '100.00',
      total_tax: '0.00',
    },
  ],
});
const allegro = () => ({
  id: 'cod-' + randomUUID(),
  status: 'READY_FOR_PROCESSING',
  fulfillment: { status: 'NEW', provider: { id: 'SELLER' } },
  revision: '1',
  buyer: { email: 'cod@example.test' },
  payment: { type: 'CASH_ON_DELIVERY', paidAmount: null, finishedAt: '2026-10-04T10:00:00Z' },
  summary: { totalToPay: { amount: '100.00', currency: 'PLN' } },
  delivery: {
    address: {
      firstName: 'Jan',
      lastName: 'COD',
      street: 'Testowa 1',
      city: 'Warszawa',
      zipCode: '00-001',
      countryCode: 'PL',
      phoneNumber: '500600700',
    },
    cost: { amount: '0.00', currency: 'PLN' },
  },
  lineItems: [
    {
      offer: { id: '77', name: 'COD QA', external: { id: 'COD-IMPORT' } },
      quantity: 1,
      price: { amount: '100.00', currency: 'PLN' },
    },
  ],
});
for (const provider of ['woocommerce', 'allegro', 'prestashop'])
  test(
    provider + ' COD import fulfills without fake payment and replay preserves one reservation',
    async () => {
      const settings =
        provider === 'prestashop'
          ? { shop_id: '1', order_state_ids: '2', simulation: true }
          : { simulation: true };
      const raw: any =
        provider === 'woocommerce'
          ? woo()
          : provider === 'allegro'
            ? allegro()
            : structuredClone(demoPrestaOrder);
      if (provider === 'prestashop') {
        raw.module = 'ps_cashondelivery';
        raw.total_paid_real = '0.000000';
        raw._dyna.state.paid = '0';
      }
      const normalized = normalizeOrder(provider, raw, settings);
      assert.equal(normalized.payment_mode, 'cod');
      assert.equal(normalized.paid, false);
      assert.equal(normalized.paid_amount, 0);
      assert.deepEqual(normalized.blockers, []);
      const ch = randomUUID();
      await tenantTx(DEMO_TENANT, (c) =>
        c.query(
          'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [ch, DEMO_TENANT, provider, 'COD QA', 'sandbox', encrypt({}), JSON.stringify(settings)],
        ),
      );
      const p = await ok('/products', 'POST', {
        sku: 'IMPORT-' + randomUUID().slice(0, 8),
        name: 'COD imported QA',
        price: 999,
        quantity: 20,
        warehouse_id: warehouse,
      });
      await ok('/integrations/' + ch + '/mappings', 'POST', {
        external_id: normalized.items[0].external_id,
        sku: p.sku,
      });
      const inbound = (await ok('/integrations/' + ch + '/stage-orders', 'POST', { data: [raw] }))
        .data[0];
      const imported = await ok('/imports/' + inbound.id + '/commit', 'POST', {
        warehouse_id: warehouse,
      });
      assert.equal(imported.payment.received, 0);
      assert.equal(imported.payment.amount_due, normalized.total);
      const replay = await ok('/imports/' + inbound.id + '/commit', 'POST', {
        warehouse_id: warehouse,
      });
      assert.equal(replay.id, imported.id);
      const shipped = await fulfill(imported);
      assert.equal(shipped.payment.received, 0);
      assert.equal(shipped.shipments[0].cod_expected, normalized.total);
    },
  );
test('Allegro partial ONLINE amount is recorded without claiming full payment; foreign and ambiguous methods remain blocked', () => {
  const raw = allegro();
  raw.payment = { type: 'ONLINE', paidAmount: { amount: '20.00', currency: 'PLN' } } as any;
  const n = normalizeOrder('allegro', raw);
  assert.equal(n.paid, false);
  assert.equal(n.paid_amount, 2000);
  assert.deepEqual(n.blockers, []);
  raw.payment.type = 'EXTENDED_TERM';
  assert(normalizeOrder('allegro', raw).blockers.length);
  raw.payment.type = 'CASH_ON_DELIVERY';
  assert(normalizeOrder('allegro', raw).blockers.length);
});
test('all InPost services require insurance covering COD; prepaid shipments cannot collect twice', async () => {
  const base = {
    channel_id: randomUUID(),
    service: 'inpost_locker_standard',
    target_point: 'WAW01M',
    receiver: {
      first_name: 'Jan',
      last_name: 'Test',
      email: 'qa@example.test',
      phone: '500600700',
    },
    cod: 10000,
    insurance: 9999,
  };
  assert.equal(shippingInput.safeParse(base).success, false);
  const channel = await ok('/shipping/example', 'POST');
  const o = await fulfill(await make());
  // A fresh packed order is needed, because the already dispatched one must stay unchanged.
  const x = await make();
  await ok('/orders/' + x.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + x.id + '/status', { status: 'paid' }));
  await ok('/orders/' + x.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + x.id + '/status', { status: 'picking' }));
  await ok('/orders/' + x.id + '/scan', 'POST', { code: x.items[0].sku });
  await ok('/orders/' + x.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + x.id + '/status', { status: 'packed' }));
  assert.equal(
    (
      await req('/orders/' + x.id + '/shipping/preview', 'POST', {
        ...base,
        channel_id: channel.id,
        insurance: 10000,
      })
    ).statusCode,
    409,
  );
  assert.equal(o.payment.amount_due, 0);
});
test('public API uses real ledger handlers and scopes; buyer portal exposes balances without private references', async () => {
  const o = await make('cod'),
    k = await ok('/developer/keys', 'POST', {
      name: 'QA payments API',
      scopes: ['orders:read', 'orders:write'],
    });
  const token = k.token ?? k.key;
  assert(token);
  const headers = { authorization: 'Bearer ' + token };
  const body = {
    client_key: randomUUID(),
    version: Number(o.version),
    kind: 'receipt',
    amount: 1000,
    currency: 'PLN',
    reference: 'PRIVATE-BANK-REFERENCE',
    note: 'PRIVATE-INTERNAL-NOTE',
    confirmed: true,
  };
  const r = await app.inject({
    url: '/api/v1/orders/' + o.id + '/payments',
    method: 'POST',
    headers,
    payload: body,
  });
  assert.equal(r.statusCode, 200, r.body);
  const portal = await app.inject({ url: '/api/public/orders/' + o.portal_token + '/data' });
  assert.equal(portal.statusCode, 200, portal.body);
  assert.equal(portal.json().payment.received, 1000);
  assert(!portal.body.includes(body.reference));
  assert(!portal.body.includes(body.note));
  await ok('/developer/keys/' + k.id, 'DELETE');
});

test('payment changes invalidate InPost preview and uncertain provider writes block ledger mutations', async () => {
  const o = await make('cod');
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  await ok('/orders/' + o.id + '/scan', 'POST', { code: o.items[0].sku });
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  const ch = await ok('/shipping/example', 'POST');
  const plan = await ok('/orders/' + o.id + '/shipping/preview', 'POST', {
    channel_id: ch.id,
    service: 'inpost_locker_standard',
    target_point: 'WAW01M',
    receiver: { first_name: 'Jan', last_name: 'Test', email: o.email, phone: '500600700' },
    cod: 10000,
    insurance: 10000,
  });
  await entry(o, 1000);
  assert.equal((await req('/shipping-plans/' + plan.id + '/queue', 'POST', {})).statusCode, 409);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE shipping_plans SET state='failed',phase='buy_started' WHERE id=$1", [plan.id]),
  );
  const current = await ok('/orders/' + o.id);
  assert.equal(
    (
      await req('/orders/' + o.id + '/payments', 'POST', {
        client_key: randomUUID(),
        version: Number(current.version),
        kind: 'receipt',
        amount: 1000,
        currency: 'PLN',
        reference: 'QA późna wpłata',
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await ok('/orders/' + o.id)).payment.received, 1000);
});
test('ledger pagination preserves newest entries and never crosses orders', async () => {
  const o = await make('cod');
  for (let n = 0; n < 52; n++) await entry(o, 1);
  const first = await ok('/orders/' + o.id + '/payments');
  assert.equal(first.data.length, 50);
  assert(first.next);
  const second = await ok('/orders/' + o.id + '/payments?before=' + first.next);
  assert.equal(second.data.length, 2);
  assert.equal(new Set([...first.data, ...second.data].map((x: any) => x.id)).size, 52);
  const otherOrder = await make();
  assert.equal(
    (await ok('/orders/' + otherOrder.id + '/payments?before=' + first.next)).data.length,
    0,
  );
});

test('partial return offsets unpaid COD debt before paying cash back', async () => {
  let o = await make('cod', 2);
  await entry(o, 2000);
  o = await fulfill(o);
  const r = await returned(o, 1);
  assert.equal(r.refund_amount, 10000);
  assert.equal(r.settlement_amount, 0);
  await ok('/returns/' + r.id + '/refund', 'POST', {
    version: Number(r.version),
    amount: 0,
    reference: 'Kredyt kompensuje należność QA',
    confirmed: true,
  });
  const b = (await ok('/orders/' + o.id)).payment;
  assert.equal(b.credit, 10000);
  assert.equal(b.nominal, 10000);
  assert.equal(b.net, 2000);
  assert.equal(b.amount_due, 8000);
  assert.equal(b.refunded, 0);
});
