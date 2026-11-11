import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { processB2bCatalog, failB2bCatalog } from '../server/b2b-network';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname));
let app: any,
  admin: string,
  buyer: string,
  viewer: string,
  operator: string,
  warehouse: string,
  buyerWarehouse: string;
const req = (path: string, method: any = 'GET', body?: any, cookie = admin) =>
  app.inject({ url: '/api' + path, method, payload: body, headers: { cookie } });
async function api(path: string, method: any = 'GET', body?: any, cookie = admin) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ logging: process.env.DYNA_TEST_LOG === 'true' });
  for (const [email, set] of [
    ['admin@demo.local', (s: string) => (admin = s)],
    ['other@demo.local', (s: string) => (buyer = s)],
    ['viewer@demo.local', (s: string) => (viewer = s)],
    ['operator@demo.local', (s: string) => (operator = s)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie'].toString().split(';')[0]);
  }
  warehouse = (await api('/warehouses')).data[0].id;
  buyerWarehouse = (await api('/warehouses', 'GET', undefined, buyer)).data[0].id;
});
after(async () => {
  await app?.close();
  await pool.end();
});
async function fixture(extra: any = {}) {
  const p = await api('/products', 'POST', {
    sku: 'NET-' + randomUUID(),
    name: 'Produkt sieci B2B',
    description: 'Opis producenta',
    attributes: extra.attributes ?? { Materiał: 'Papier' },
    price: 20000,
    quantity: extra.quantity ?? 12,
    warehouse_id: warehouse,
  });
  const list = await api('/price-lists', 'POST', {
    name: 'Cennik sieci ' + randomUUID().slice(0, 8),
    currency: extra.currency ?? 'PLN',
  });
  const updated = await api('/price-lists/' + list.id + '/items', 'PUT', {
    version: list.version,
    items: [{ product_id: p.id, price: 12345 }],
  });
  const body = {
    name: 'Kontrahent sieci ' + randomUUID().slice(0, 8),
    email: randomUUID() + '@example.test',
    warehouse_id: warehouse,
    price_list_id: list.id,
    address: { street: 'Sieciowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
    shipping_cost: 0,
    payment_mode: 'prepaid',
  };
  const a = await api('/b2b/accounts', 'POST', body);
  const approved = await api('/b2b/accounts/' + a.id, 'PATCH', {
    ...body,
    version: 1,
    active: true,
    confirmed: true,
  });
  const invite = await api('/b2b/accounts/' + a.id + '/network-invite', 'POST', {
    version: approved.version,
    recipient_email: 'other@demo.local',
    confirmed: true,
  });
  const f: any = {
    product: p,
    list: { ...list, version: updated.version },
    body,
    account: approved,
    token: invite.token,
  };
  if (!extra.unaccepted) {
    f.link = await api(
      '/b2b/network/accept',
      'POST',
      { token: invite.token, confirmed: true },
      buyer,
    );
    f.base = '/b2b/network/links/' + f.link.id;
  }
  return f;
}
const refresh = (f: any, key = randomUUID()) =>
  api(f.base + '/refresh', 'POST', { client_key: key, confirmed: true }, buyer);
async function step(run: any) {
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [run.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processB2bCatalog(job);
  } catch (e) {
    await failB2bCatalog(job, e);
    throw e;
  }
  return job;
}
async function finish(run: any) {
  for (let n = 0; n < 600; n++) {
    const r = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0];
    if (r.state === 'done') return r;
    assert.equal(r.state, 'queued', r.error);
    await step(r);
  }
  throw Error('Run did not finish');
}
const catalog = (f: any) => api(f.base + '/catalog', 'GET', undefined, buyer);
const config = (f: any, b: any = {}) =>
  api(
    f.base,
    'PATCH',
    { version: f.link.version, paused: false, schedule_minutes: 0, confirmed: true, ...b },
    buyer,
  );
async function imported(extra: any = {}) {
  const f = await fixture(extra);
  await finish(await refresh(f));
  f.item = (await catalog(f)).data[0];
  f.local = await api(
    f.base + '/catalog/' + f.item.id + '/product',
    'POST',
    {
      version: f.item.version,
      sku: 'LOCAL-' + randomUUID(),
      sale_price: 25000,
      warehouse_id: buyerWarehouse,
      confirmed: true,
    },
    buyer,
  );
  return f;
}
const quote = (f: any, qty = 3, extra: any = {}) =>
  api(
    f.base + '/quotes',
    'POST',
    {
      client_key: randomUUID(),
      warehouse_id: buyerWarehouse,
      items: [{ item_id: f.item.id, quantity: qty }],
      ...extra,
    },
    buyer,
  );
const checkout = (f: any, q: any) =>
  api(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, buyer);
const purchase = (o: any) => '/b2b/network/orders/' + o.id;
const stock = (id: string) =>
  pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [id]).then((r) => r.rows[0]);
async function shipped(f: any, o: any) {
  await api('/orders/' + o.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.source_order_id + '/status', { status: 'paid' }));
  await api('/orders/' + o.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.source_order_id + '/status', { status: 'picking' }));
  for (let n = 0; n < o.lines[0].quantity; n++)
    await api('/orders/' + o.source_order_id + '/scan', 'POST', { code: f.product.sku });
  await api('/orders/' + o.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.source_order_id + '/status', { status: 'packed' }));
  await api('/orders/' + o.source_order_id + '/ship-demo', 'POST', {});
}
const receipt = (o: any, qty = 1, extra: any = {}) => ({
  client_key: randomUUID(),
  version: o.version,
  confirmed: true,
  lines: [{ product_id: o.lines[0].product_id, quantity: qty, location: 'B2B-01' }],
  ...extra,
});
const returnPath = (o: any, r: any) => purchase(o) + '/returns/' + r.id;
async function received() {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  await shipped(f, o);
  await api(purchase(o) + '/receipts', 'POST', receipt(o, 3), buyer);
  return { f, o: await api(purchase(o), 'GET', undefined, buyer) };
}
async function request(o: any, qty = 1, extra: any = {}) {
  return api(
    purchase(o) + '/returns',
    'POST',
    {
      version: o.version,
      client_key: randomUUID(),
      kind: 'return',
      reason: 'Towar wymaga zwrotu',
      shipping_refund: 0,
      confirmed: true,
      lines: [{ product_id: o.lines[0].product_id, quantity: qty }],
      ...extra,
    },
    buyer,
  );
}
const dispatch = (o: any, r: any) =>
  api(returnPath(o, r) + '/dispatch', 'POST', { version: r.version, confirmed: true }, buyer);
const recover = (o: any, r: any, qty = 1, extra: any = {}) =>
  api(
    returnPath(o, r) + '/recoveries',
    'POST',
    {
      version: r.version,
      client_key: randomUUID(),
      confirmed: true,
      lines: [{ product_id: o.lines[0].product_id, quantity: qty, location: 'B2B-RETURN' }],
      ...extra,
    },
    buyer,
  );
test('concurrent buyer cancellation releases supplier reservations once and persists both sides with null supplier audit actor', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f)),
    body = {
      version: o.version,
      client_key: randomUUID(),
      reason: 'Rezygnacja z zakupu',
      confirmed: true,
    };
  const out = await Promise.all([
    api(purchase(o) + '/cancel', 'POST', body, buyer),
    api(purchase(o) + '/cancel', 'POST', body, buyer),
  ]);
  assert.equal(out[0].id, out[1].id);
  assert.equal(out[0].state, 'cancelled');
  assert.equal(out[0].version, 2);
  assert.equal(out[0].fulfillment.status, 'cancelled');
  assert.equal((await stock(f.product.id)).reserved, 0);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.cancelled'",
        [o.source_order_id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT user_id FROM audit_events WHERE entity_id=$1 AND action='b2b.network.buyer_cancel'",
        [o.source_order_id],
      )
    ).rows[0].user_id,
    null,
  );
  assert.equal(
    (
      await req(
        purchase(o) + '/cancel',
        'POST',
        { ...body, reason: 'Inny powód anulowania' },
        buyer,
      )
    ).statusCode,
    409,
  );
  assert.equal((await req(purchase(o) + '/receipts', 'POST', receipt(o), buyer)).statusCode, 409);
});
test('buyer cannot cancel shipped or received purchase; supplier-side cancellation may be acknowledged', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  await shipped(f, o);
  assert.equal(
    (
      await req(
        purchase(o) + '/cancel',
        'POST',
        {
          version: o.version,
          client_key: randomUUID(),
          reason: 'Niepotrzebny zakup',
          confirmed: true,
        },
        buyer,
      )
    ).statusCode,
    409,
  );
  const g = await imported(),
    p = await checkout(g, await quote(g));
  await api('/orders/' + p.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + p.source_order_id + '/status', { status: 'cancelled' }));
  const d = await api(
    purchase(p) + '/cancel',
    'POST',
    {
      version: p.version,
      client_key: randomUUID(),
      reason: 'Potwierdzam anulowanie dostawcy',
      confirmed: true,
    },
    buyer,
  );
  assert.equal(d.state, 'cancelled');
  assert.equal(d.fulfillment.status, 'cancelled');
});
test('return request is atomic, idempotent and does not move inventory; withdrawal releases committed quantity', async () => {
  const { f, o } = await received(),
    key = randomUUID(),
    r = await request(o, 2, { client_key: key });
  assert.equal(r.state, 'requested');
  assert.equal(r.supplier.state, 'requested');
  assert.equal(r.supplier.items[0].requested, 2);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 3);
  assert.equal((await stock(f.product.id)).on_hand, 9);
  assert.equal((await request(o, 2, { client_key: key })).id, r.id);
  assert.equal((await api(purchase(o), 'GET', undefined, buyer)).lines[0].return_committed, 2);
  const input = {
      version: r.version,
      reason: 'Wycofuję zgłoszenie przed wysłaniem',
      confirmed: true,
    },
    cancelled = await api(returnPath(o, r) + '/cancel', 'POST', input, buyer);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.supplier.state, 'cancelled');
  assert.equal((await api(returnPath(o, r) + '/cancel', 'POST', input, buyer)).id, r.id);
  const fresh = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(fresh.lines[0].return_committed, 0);
  await request(fresh, 3);
});
test('return dispatch posts one WZ, supplier rejection does not recreate stock, confirmed recovery posts one PZ', async () => {
  const { f, o } = await received(),
    r = await request(o),
    input = { version: r.version, confirmed: true },
    out = await Promise.all([
      api(returnPath(o, r) + '/dispatch', 'POST', input, buyer),
      api(returnPath(o, r) + '/dispatch', 'POST', input, buyer),
    ]),
    sent = out[0];
  assert.equal(sent.dispatch_document_id, out[1].dispatch_document_id);
  assert(sent.dispatch_document.number.startsWith('WZ/'));
  assert.equal(sent.supplier.state, 'requested');
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 2);
  assert.equal((await stock(f.product.id)).on_hand, 9);
  assert.equal(
    (
      await req(
        returnPath(o, sent) + '/cancel',
        'POST',
        { version: sent.version, reason: 'Zatrzymaj wysłany zwrot', confirmed: true },
        buyer,
      )
    ).statusCode,
    409,
  );
  let d = await api('/returns/' + sent.source_return_id);
  await api('/returns/' + d.id + '/decision', 'POST', {
    version: d.version,
    decision: 'reject',
    note: 'Dostawca odsyła nieprzyjęty towar',
  });
  d = await api(returnPath(o, sent), 'GET', undefined, buyer);
  assert.equal(d.supplier.state, 'rejected');
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 2);
  const key = randomUUID(),
    rec = await recover(o, d, 1, { client_key: key });
  assert.equal((await recover(o, d, 1, { client_key: key })).id, rec.id);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 3);
  assert.equal((await stock(f.product.id)).on_hand, 9);
  const after = await api(returnPath(o, d), 'GET', undefined, buyer);
  assert.equal(after.lines[0].recovered, 1);
  assert.equal(after.recoveries.length, 1);
  assert(after.recoveries[0].number.startsWith('PZ/'));
  assert.equal(
    (
      await req(
        returnPath(o, d) + '/recoveries',
        'POST',
        {
          version: after.version,
          client_key: randomUUID(),
          confirmed: true,
          lines: [{ product_id: o.lines[0].product_id, quantity: 1, location: 'B2B-RETURN' }],
        },
        buyer,
      )
    ).statusCode,
    409,
  );
});
test('partial supplier acceptance returns only nonaccepted units; reported refund is distinct from recorded settlement', async () => {
  const { f, o } = await received(),
    r = await dispatch(o, await request(o, 2)),
    source = await api('/returns/' + r.source_return_id);
  await api('/returns/' + source.id + '/receive', 'POST', {
    version: source.version,
    note: 'Jedna sztuka przyjęta, druga odesłana',
    items: [{ item_id: source.items[0].item_id, accepted: 1, restocked: 1 }],
  });
  let d = await api(returnPath(o, r), 'GET', undefined, buyer);
  assert.equal(d.supplier.state, 'refund_pending');
  assert.equal(d.supplier.refund_amount, 12345);
  assert.equal(d.supplier.settled_amount, 0);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 1);
  assert.equal((await stock(f.product.id)).on_hand, 10);
  assert.equal(
    (
      await req(
        returnPath(o, r) + '/recoveries',
        'POST',
        {
          version: d.version,
          client_key: randomUUID(),
          confirmed: true,
          lines: [{ product_id: o.lines[0].product_id, quantity: 2, location: 'B2B-RETURN' }],
        },
        buyer,
      )
    ).statusCode,
    409,
  );
  await recover(o, d);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 2);
  const accepted = await api('/returns/' + source.id);
  await api('/returns/' + accepted.id + '/refund', 'POST', {
    version: accepted.version,
    amount: accepted.settlement_amount,
    reference: 'Lokalne potwierdzenie zwrotu',
    confirmed: true,
  });
  d = await api(returnPath(o, r), 'GET', undefined, buyer);
  assert.equal(d.supplier.state, 'closed');
  assert.equal(d.supplier.settled_amount, 12345);
  assert(d.supplier.refunded_at);
});
test('WZ protects buyer active stock reservations and failure leaves request and both stocks intact', async () => {
  const { f, o } = await received(),
    r = await request(o);
  const sale = await api(
    '/orders',
    'POST',
    {
      customer_name: 'Sprzedaż własnego towaru',
      email: 'buyer-sale@example.test',
      warehouse_id: buyerWarehouse,
      items: [{ product_id: o.lines[0].product_id, quantity: 3 }],
    },
    buyer,
  );
  assert.equal(
    (
      await req(
        returnPath(o, r) + '/dispatch',
        'POST',
        { version: r.version, confirmed: true },
        buyer,
      )
    ).statusCode,
    409,
  );
  const d = await api(returnPath(o, r), 'GET', undefined, buyer);
  assert.equal(d.state, 'requested');
  assert.equal(d.dispatch_document_id, null);
  assert.deepEqual(await stock(o.lines[0].product_id), { on_hand: 3, reserved: 3 });
  assert.equal((await stock(f.product.id)).on_hand, 9);
  await api('/orders/' + sale.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined, buyer), '/orders/' + sale.id + '/status', { status: 'cancelled' }), buyer);
  await dispatch(o, r);
  assert.deepEqual(await stock(o.lines[0].product_id), { on_hand: 2, reserved: 0 });
});
test('foreign IDs, absent confirmation, over-requested quantities and viewer mutation cannot cross organization boundaries', async () => {
  const { o } = await received();
  assert.equal((await req(purchase(o) + '/returns', 'GET')).statusCode, 404);
  const payload = {
    version: o.version,
    client_key: randomUUID(),
    kind: 'return',
    reason: 'Powód zwrotu',
    shipping_refund: 0,
    confirmed: true,
    lines: [{ product_id: randomUUID(), quantity: 1 }],
  };
  assert.equal((await req(purchase(o) + '/returns', 'POST', payload, buyer)).statusCode, 422);
  assert.equal(
    (
      await req(
        purchase(o) + '/returns',
        'POST',
        { ...payload, lines: [{ product_id: o.lines[0].product_id, quantity: 4 }] },
        buyer,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await req(purchase(o) + '/returns', 'POST', { ...payload, confirmed: false }, buyer))
      .statusCode,
    422,
  );
  const r = await request(o);
  assert.equal((await req(returnPath(o, r), 'GET')).statusCode, 404);
  assert.equal(
    (await req(purchase(o) + '/returns/' + randomUUID(), 'GET', undefined, buyer)).statusCode,
    404,
  );
  const uid = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0].id;
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    SECOND_TENANT,
    uid,
  ]);
  try {
    assert.equal(
      (
        await req(
          returnPath(o, r) + '/dispatch',
          'POST',
          { version: r.version, confirmed: true },
          buyer,
        )
      ).statusCode,
      403,
    );
    assert.equal((await req(returnPath(o, r), 'GET', undefined, buyer)).statusCode, 200);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      SECOND_TENANT,
      uid,
    ]);
  }
});
test('restored read-only application shows supplier decisions and WZ while blocking all return mutations', async () => {
  const { o } = await received(),
    r = await dispatch(o, await request(o));
  for (const table of [
    'b2b_network_returns',
    'b2b_network_return_lines',
    'b2b_network_return_recoveries',
    'b2b_network_return_recovery_lines',
  ]) {
    assert.equal(
      (
        await tenantTx(DEMO_TENANT, (c) =>
          c.query('SELECT count(*)::int n FROM ' + table + ' WHERE tenant_id=$1', [SECOND_TENANT]),
        )
      ).rows[0].n,
      0,
    );
    const flags = (
      await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1', [
        table,
      ])
    ).rows[0];
    assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
  }
  const preview = await buildApp({ readOnly: true, previewPort: 4198 });
  try {
    const login = await preview.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email: 'other@demo.local', password: 'DynaDemo!2026' },
      }),
      cookie = login.headers['set-cookie']!.toString().split(';')[0];
    const d = await preview.inject({ url: '/api' + returnPath(o, r), headers: { cookie } });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().state, 'dispatched');
    for (const path of [
      purchase(o) + '/cancel',
      purchase(o) + '/returns',
      returnPath(o, r) + '/dispatch',
      returnPath(o, r) + '/cancel',
      returnPath(o, r) + '/recoveries',
    ])
      assert.equal(
        (
          await preview.inject({
            url: '/api' + path,
            method: 'POST',
            headers: { cookie },
            payload: {},
          })
        ).statusCode,
        423,
      );
  } finally {
    await preview.close();
  }
});
test('supplier acceptance requires buyer WZ and the dispatch predicate is scoped to supplier tenant', async () => {
  const { f, o } = await received(),
    r = await request(o),
    source = await api('/returns/' + r.source_return_id),
    input = {
      version: source.version,
      note: 'Przyjęcie rzeczywiście wysłanej sztuki',
      items: [{ item_id: source.items[0].item_id, accepted: 1, restocked: 1 }],
    };
  assert.equal((await req('/returns/' + source.id + '/receive', 'POST', input)).statusCode, 409);
  assert.equal((await stock(f.product.id)).on_hand, 9);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 3);
  assert.equal(
    (
      await tenantTx(DEMO_TENANT, (c) =>
        c.query('SELECT b2b_network_return_dispatched($1) value', [source.id]),
      )
    ).rows[0].value,
    false,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT b2b_network_return_dispatched($1) value', [source.id]),
      )
    ).rows[0].value,
    null,
  );
  await dispatch(o, r);
  await api('/returns/' + source.id + '/receive', 'POST', input);
  assert.equal((await stock(f.product.id)).on_hand, 10);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 2);
});

async function injectedFailure(table: string, operation: string, run: () => Promise<void>) {
  assert(/^[a-z_0-9]+$/.test(table) && ['INSERT', 'UPDATE'].includes(operation));
  await pool.query(
    `CREATE FUNCTION qa_network_return_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA return transaction failure'; END $$`,
  );
  try {
    await pool.query(
      `CREATE TRIGGER qa_network_return_fail BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION qa_network_return_fail()`,
    );
    await run();
  } finally {
    await pool.query('DROP FUNCTION qa_network_return_fail() CASCADE');
  }
}
const count = async (table: string, tenant = SECOND_TENANT) => {
  assert(/^[a-z_0-9]+$/.test(table));
  return (
    await pool.query('SELECT count(*)::int n FROM ' + table + ' WHERE tenant_id=$1', [tenant])
  ).rows[0].n;
};
test('failed buyer cancellation write rolls back supplier status and reservation release', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  await injectedFailure('b2b_network_orders', 'UPDATE', async () => {
    const response = await req(
      purchase(o) + '/cancel',
      'POST',
      {
        version: o.version,
        client_key: randomUUID(),
        reason: 'Kontrola atomowego anulowania',
        confirmed: true,
      },
      buyer,
    );
    assert.equal(response.statusCode, 409);
    assert.deepEqual(await stock(f.product.id), { on_hand: 12, reserved: 3 });
    assert.equal((await api('/orders/' + o.source_order_id)).status, 'new');
    assert.equal((await api(purchase(o), 'GET', undefined, buyer)).state, 'ordered');
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.cancelled'",
          [o.source_order_id],
        )
      ).rows[0].n,
      0,
    );
  });
});
test('failed buyer return line rolls back supplier RMA, own request and both audits', async () => {
  const { o } = await received(),
    before = {
      source: await count('return_cases', DEMO_TENANT),
      own: await count('b2b_network_returns'),
      supplierAudit: await count('audit_events', DEMO_TENANT),
      buyerAudit: await count('audit_events'),
    };
  await injectedFailure('b2b_network_return_lines', 'INSERT', async () => {
    await assert.rejects(request(o), /QA return transaction failure/);
    assert.equal(await count('return_cases', DEMO_TENANT), before.source);
    assert.equal(await count('b2b_network_returns'), before.own);
    assert.equal(await count('audit_events', DEMO_TENANT), before.supplierAudit);
    assert.equal(await count('audit_events'), before.buyerAudit);
    assert.equal((await api(purchase(o), 'GET', undefined, buyer)).version, o.version);
    assert.equal((await stock(o.lines[0].product_id)).on_hand, 3);
  });
});
test('failed dispatch record rolls back posted WZ, bin consumption and movement', async () => {
  const { o } = await received(),
    r = await request(o, 2),
    docs = await count('warehouse_documents'),
    movements = await count('stock_movements');
  await injectedFailure('b2b_network_returns', 'UPDATE', async () => {
    await assert.rejects(dispatch(o, r), /QA return transaction failure/);
    assert.equal(await count('warehouse_documents'), docs);
    assert.equal(await count('stock_movements'), movements);
    assert.equal((await stock(o.lines[0].product_id)).on_hand, 3);
    assert.equal(
      (
        await pool.query('SELECT sum(quantity)::int n FROM stock_locations WHERE product_id=$1', [
          o.lines[0].product_id,
        ])
      ).rows[0].n,
      3,
    );
    const current = await api(returnPath(o, r), 'GET', undefined, buyer);
    assert.equal(current.version, r.version);
    assert.equal(current.dispatch_document_id, null);
    assert.equal(current.supplier.state, 'requested');
  });
});
test('failed recovery line rolls back PZ, recovered quantity and audit', async () => {
  const { o } = await received(),
    r = await dispatch(o, await request(o, 2)),
    source = await api('/returns/' + r.source_return_id);
  await api('/returns/' + source.id + '/decision', 'POST', {
    version: source.version,
    decision: 'reject',
    note: 'Odesłanie obu sztuk',
  });
  const docs = await count('warehouse_documents'),
    movements = await count('stock_movements'),
    audits = await count('audit_events');
  await injectedFailure('b2b_network_return_recovery_lines', 'INSERT', async () => {
    await assert.rejects(recover(o, r, 2), /QA return transaction failure/);
    assert.equal(await count('warehouse_documents'), docs);
    assert.equal(await count('stock_movements'), movements);
    assert.equal(await count('audit_events'), audits);
    assert.equal((await stock(o.lines[0].product_id)).on_hand, 1);
    const current = await api(returnPath(o, r), 'GET', undefined, buyer);
    assert.equal(current.lines[0].recovered, 0);
    assert.equal(current.version, r.version);
    assert.equal(current.recoveries.length, 0);
  });
});
test('recovery history paginates 26 genuine partial PZ without duplicates and denies foreign readers', async () => {
  const f = await imported({ quantity: 30 }),
    o = await checkout(f, await quote(f, 27));
  await shipped(f, o);
  await api(purchase(o) + '/receipts', 'POST', receipt(o, 27), buyer);
  const current = await api(purchase(o), 'GET', undefined, buyer),
    r = await dispatch(o, await request(current, 27)),
    source = await api('/returns/' + r.source_return_id);
  await api('/returns/' + source.id + '/decision', 'POST', {
    version: source.version,
    decision: 'reject',
    note: 'Zwrot wszystkich sztuk',
  });
  let d = r;
  for (let n = 0; n < 26; n++) {
    await recover(o, d);
    d = await api(returnPath(o, r), 'GET', undefined, buyer);
  }
  assert.equal(d.recoveries.length, 25);
  assert(d.recoveries_next);
  const path = returnPath(o, r) + '/recoveries';
  const first = await api(path, 'GET', undefined, buyer),
    second = await api(path + '?after=' + first.next, 'GET', undefined, buyer);
  assert.equal(first.data.length, 25);
  assert.equal(second.data.length, 1);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.data, ...second.data].map((x) => x.id)).size, 26);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 26);
  assert.equal((await req(path, 'GET')).statusCode, 404);
});
test('cancelled prepaid purchase exposes overpayment until supplier records refund, without exposing ledger references', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f)),
    source = await api('/orders/' + o.source_order_id);
  await api('/orders/' + source.id + '/payments', 'POST', {
    version: source.version,
    client_key: randomUUID(),
    kind: 'receipt',
    amount: source.total,
    currency: source.currency,
    reference: 'Prywatna referencja dostawcy',
    confirmed: true,
  });
  let current = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(current.fulfillment.payments.amount_due, 0);
  current = await api(
    purchase(o) + '/cancel',
    'POST',
    {
      version: current.version,
      client_key: randomUUID(),
      reason: 'Zwrot opłaconego zakupu',
      confirmed: true,
    },
    buyer,
  );
  assert.equal(current.fulfillment.payments.overpayment, source.total);
  assert.equal(current.fulfillment.payments.refunded, 0);
  assert(!JSON.stringify(current.fulfillment).includes('Prywatna referencja'));
  const cancelled = await api('/orders/' + source.id);
  await api('/orders/' + source.id + '/payments', 'POST', {
    version: cancelled.version,
    client_key: randomUUID(),
    kind: 'refund',
    amount: source.total,
    currency: source.currency,
    reference: 'Potwierdzenie lokalnej refundacji',
    confirmed: true,
  });
  current = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(current.fulfillment.payments.overpayment, 0);
  assert.equal(current.fulfillment.payments.refunded, source.total);
});
test('historical returns remain actionable after link pause, supplier account revocation and local product deactivation', async () => {
  const { f, o } = await received();
  await config(f, { paused: true });
  await api('/b2b/accounts/' + f.account.id, 'PATCH', {
    ...f.body,
    version: f.account.version,
    active: false,
    confirmed: true,
  });
  await pool.query('UPDATE products SET active=false WHERE id=$1', [o.lines[0].product_id]);
  const r = await dispatch(o, await request(o));
  const source = await api('/returns/' + r.source_return_id);
  await api('/returns/' + source.id + '/decision', 'POST', {
    version: source.version,
    decision: 'reject',
    note: 'Odesłanie historycznego zakupu',
  });
  await recover(o, r);
  assert.equal((await stock(o.lines[0].product_id)).on_hand, 3);
  assert.equal((await api(returnPath(o, r), 'GET', undefined, buyer)).lines[0].recovered, 1);
  assert.equal((await req(f.base + '/catalog', 'GET', undefined, buyer)).statusCode, 409);
});

// Full own synthetic business rows guard both sides against denied historical
// requests. Session access bookkeeping is deliberately outside business data.
async function privacyCheckpoint() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const names: string[] = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' ORDER BY t.table_name`)
    ).rows.map((r) => r.table_name);
    const out: Record<string, string> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t
        WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [[DEMO_TENANT, SECOND_TENANT]],
        )
      ).rows;
      out[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function mergedPurchase(mode: 'technical_merge' | 'into_main_order') {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  const other = await api('/orders', 'POST', {
    customer_name: 'Inny klient połączenia',
    email: 'private-other-buyer@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: f.product.id, quantity: 1 }],
  });
  const p = await api('/order-merges/previews', 'POST', {
    client_key: randomUUID(),
    main_order_id: o.source_order_id,
    order_ids_to_merge: [other.id],
    merge_mode: mode,
    sum_delivery_costs: true,
  });
  assert.equal(p.preview.ready, true);
  const e = await api('/order-merges/execute', 'POST', {
    client_key: randomUUID(),
    preview_id: p.preview.id,
    scope_hash: p.preview.scope_hash,
    confirmed: true,
    confirmed_receiver_selection: true,
  });
  return { f, o, target: e.execution.target_order_id };
}
async function deniedHistoricalRoutes(o: any, r: any, status: number) {
  const before = await privacyCheckpoint();
  const paths: [string, any, any?][] = [
    [purchase(o) + '/returns', 'GET'],
    [returnPath(o, r), 'GET'],
    [returnPath(o, r) + '/recoveries', 'GET'],
    [
      purchase(o) + '/cancel',
      'POST',
      {
        version: o.version,
        client_key: randomUUID(),
        reason: 'Historyczny zakup',
        confirmed: true,
      },
    ],
    [
      purchase(o) + '/returns',
      'POST',
      {
        version: o.version,
        client_key: randomUUID(),
        kind: 'return',
        reason: 'Historyczny zwrot',
        shipping_refund: 0,
        confirmed: true,
        lines: [{ product_id: o.lines[0].product_id, quantity: 1 }],
      },
    ],
    [returnPath(o, r) + '/dispatch', 'POST', { version: 1, confirmed: true }],
    [
      returnPath(o, r) + '/cancel',
      'POST',
      { version: 1, reason: 'Wycofanie historyczne', confirmed: true },
    ],
    [
      returnPath(o, r) + '/recoveries',
      'POST',
      {
        version: 1,
        client_key: randomUUID(),
        confirmed: true,
        lines: [{ product_id: o.lines[0].product_id, quantity: 1, location: 'NO-CHANGE' }],
      },
    ],
  ];
  for (const [path, method, body] of paths) {
    const response = await req(path, method, body, buyer);
    assert.equal(response.statusCode, status, `${method} ${path}: ${response.body}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert(!response.body.includes('PRIVATE-AGGREGATE-RMA'));
    assert(!response.body.includes('private-other-buyer@example.test'));
    assert(!response.body.includes(r.id));
  }
  assert.deepEqual(await privacyCheckpoint(), before, 'Denied requests leave both firms unchanged');
}
test('merged main network returns reject every history path before genuine aggregate RMA projection or mutations', async () => {
  const { f, o, target } = await mergedPurchase('into_main_order');
  assert.equal(target, o.source_order_id);
  await api('/orders/' + target + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + target + '/status', { status: 'paid' }));
  await api('/orders/' + target + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + target + '/status', { status: 'picking' }));
  for (let i = 0; i < 4; i++)
    await api('/orders/' + target + '/scan', 'POST', { code: f.product.sku });
  await api('/orders/' + target + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + target + '/status', { status: 'packed' }));
  await api('/orders/' + target + '/ship-demo', 'POST', {});
  const item = (await api('/orders/' + target)).items.find(
    (i: any) => i.order_id === target && i.quantity === 1,
  );
  assert(item, 'Other commercial item must exist on aggregate target');
  const source = await api('/orders/' + target + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'PRIVATE-AGGREGATE-RMA',
    items: [{ item_id: item.id, quantity: 1 }],
  });
  // Explicit adversarial owner fixture: all FKs are genuine. An old network
  // reference to a newer aggregate buyer case must still never project it.
  const r = { id: randomUUID() };
  const actor = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0]
    .id;
  await pool.query('UPDATE return_cases SET submitted_by=$2 WHERE id=$1', [source.id, 'buyer']);
  await pool.query(
    `INSERT INTO b2b_network_returns(id,tenant_id,order_id,supplier_tenant_id,
    source_return_id,client_key,fingerprint,input,source_number,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9)`,
    [
      r.id,
      SECOND_TENANT,
      o.id,
      DEMO_TENANT,
      source.id,
      randomUUID(),
      'own-synthetic',
      source.number,
      actor,
    ],
  );
  await deniedHistoricalRoutes(o, r, 409);
  const otherAccount = (await fixture({ unaccepted: true })).account;
  await pool.query('UPDATE b2b_network_orders SET account_id=$2 WHERE id=$1', [
    o.id,
    otherAccount.id,
  ]);
  await deniedHistoricalRoutes(o, r, 404);
});
test('technical source returns are closed and forged network reference to technical aggregate remains undiscoverable', async () => {
  const { o, target } = await mergedPurchase('technical_merge');
  assert.notEqual(target, o.source_order_id);
  const r = { id: randomUUID() };
  await deniedHistoricalRoutes(o, r, 409);
  // This trusted isolated fixture simulates a forged reference with valid
  // source-order FK. Account identity cannot authorize an aggregate target.
  await pool.query('UPDATE b2b_network_orders SET source_order_id=$2 WHERE id=$1', [o.id, target]);
  await deniedHistoricalRoutes(o, r, 404);
});
