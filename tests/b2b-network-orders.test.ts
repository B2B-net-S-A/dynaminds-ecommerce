import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { processB2bCatalog, failB2bCatalog } from '../server/b2b-network';
assert.equal(process.env.DYNA_TEST, 'true');
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
  app.addHook('onError', async (request: { method: string; url: string }, _reply: unknown, error: unknown) => {
    const pathname = request.url.split('?')[0];
    if (request.method !== 'POST' || pathname !== '/api/order-merges/execute') return;
    const cause = error && typeof error === 'object'
      ? error as { name?: unknown; code?: unknown; message?: unknown }
      : {};
    const bounded = (value: unknown) => typeof value === 'string'
      ? value.replace(/[\r\n\t]/g, ' ').slice(0, 100)
      : null;
    console.error(JSON.stringify({
      method: request.method,
      pathname,
      error: { name: bounded(cause.name), code: bounded(cause.code), message: bounded(cause.message) },
    }));
  });
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
    name: extra.name ?? 'Produkt sieci B2B',
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
test('quote preserves current supplier gross prices, currency, address and replay without reservation', async () => {
  const f = await imported({ currency: 'EUR' }),
    key = randomUUID(),
    q = await quote(f, 3, { client_key: key });
  assert.equal(q.summary.currency, 'EUR');
  assert.equal(q.summary.total_gross, 37035);
  assert.equal(q.summary.items[0].unit_gross, 12345);
  assert.deepEqual(q.summary.address, { ...f.body.address, phone: '' });
  assert.equal((await stock(f.product.id)).reserved, 0);
  assert.equal((await quote(f, 3, { client_key: key })).id, q.id);
  assert.equal(
    (
      await req(
        f.base + '/quotes',
        'POST',
        {
          client_key: key,
          warehouse_id: buyerWarehouse,
          items: [{ item_id: f.item.id, quantity: 4 }],
        },
        buyer,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM b2b_quotes WHERE account_id=$1', [f.account.id]))
      .rows[0].n,
    1,
  );
});
test('concurrent checkout creates one supplier OMS order and one buyer purchase, reserving only supplier stock', async () => {
  const f = await imported(),
    q = await quote(f),
    rows = await Promise.all([checkout(f, q), checkout(f, q)]),
    o = rows[0];
  assert.equal(rows[1].id, o.id);
  assert.equal(o.total_gross, 37035);
  assert.equal(o.state, 'ordered');
  assert.equal(o.lines[0].quantity, 3);
  assert.deepEqual(await stock(f.product.id), { on_hand: 12, reserved: 3 });
  assert.deepEqual(await stock(o.lines[0].product_id), { on_hand: 0, reserved: 0 });
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM orders WHERE b2b_account_id=$1', [f.account.id]))
      .rows[0].n,
    1,
  );
  assert.equal((await req(purchase(o), 'GET', undefined, admin)).statusCode, 404);
  const detail = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(detail.fulfillment.status, 'new');
  assert(!JSON.stringify(detail).includes('portal_token'));
  assert.equal((await req(purchase(o) + '/receipts', 'POST', receipt(o), buyer)).statusCode, 409);
});
test('insufficient stock and stale prices roll back both sides; new quote retries cleanly', async () => {
  const f = await imported(),
    q = await quote(f, 13);
  assert.equal(
    (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, buyer))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM b2b_network_orders WHERE link_id=$1', [
        f.link.id,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM orders WHERE b2b_account_id=$1', [f.account.id]))
      .rows[0].n,
    0,
  );
  const fresh = await quote(f);
  await api('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: f.list.version,
    items: [{ product_id: f.product.id, price: 14000 }],
  });
  assert.equal(
    (await req(f.base + '/quotes/' + fresh.id + '/checkout', 'POST', { confirmed: true }, buyer))
      .statusCode,
    409,
  );
  assert.equal((await stock(f.product.id)).reserved, 0);
  assert.equal((await checkout(f, await quote(f))).total_gross, 42000);
});
test('fulfillment shows tracking and own documents, partial receipts post PZ exactly once', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  await shipped(f, o);
  const invoice = await api('/orders/' + o.source_order_id + '/documents', 'POST', {
    kind: 'invoice',
  });
  let d = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(d.fulfillment.status, 'shipped');
  assert(d.fulfillment.shipments[0].dispatched_at);
  assert(d.fulfillment.documents.some((x: any) => x.id === invoice.id));
  const print = await req(
    purchase(o) + '/documents/' + invoice.id + '/print',
    'GET',
    undefined,
    buyer,
  );
  assert.equal(print.statusCode, 200);
  assert(print.body.includes(invoice.number));
  assert.equal(
    (await req(purchase(o) + '/documents/' + randomUUID() + '/print', 'GET', undefined, buyer))
      .statusCode,
    404,
  );
  const body = receipt(d),
    rs = await Promise.all([
      api(purchase(o) + '/receipts', 'POST', body, buyer),
      api(purchase(o) + '/receipts', 'POST', body, buyer),
    ]);
  assert.equal(rs[0].id, rs[1].id);
  d = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(d.state, 'partial');
  assert.equal(d.lines[0].received, 1);
  assert.equal(d.receipts.length, 1);
  assert.deepEqual(await stock(d.lines[0].product_id), { on_hand: 1, reserved: 0 });
  assert.deepEqual(await stock(f.product.id), { on_hand: 9, reserved: 0 });
  assert.equal(
    (
      await req(
        purchase(o) + '/receipts',
        'POST',
        { ...body, lines: [{ ...body.lines[0], quantity: 2 }] },
        buyer,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await req(purchase(o) + '/receipts', 'POST', receipt(d, 3), buyer)).statusCode,
    409,
  );
  await api(purchase(o) + '/receipts', 'POST', receipt(d, 2), buyer);
  d = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(d.state, 'received');
  assert.equal(d.lines[0].received, 3);
  assert.equal(d.receipts.length, 2);
  assert.deepEqual(await stock(d.lines[0].product_id), { on_hand: 3, reserved: 0 });
  assert.equal(
    (await pool.query('SELECT price FROM products WHERE id=$1', [d.lines[0].product_id])).rows[0]
      .price,
    25000,
  );
});
test('pause and revoked source account block new purchases but preserve existing history and checkout replay', async () => {
  const f = await imported(),
    q = await quote(f),
    o = await checkout(f, q),
    unused = await quote(f);
  await config(f, { paused: true });
  assert.equal((await checkout(f, q)).id, o.id);
  assert.equal(
    (await req(f.base + '/quotes/' + unused.id + '/checkout', 'POST', { confirmed: true }, buyer))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await req(
        f.base + '/quotes',
        'POST',
        {
          client_key: randomUUID(),
          warehouse_id: buyerWarehouse,
          items: [{ item_id: f.item.id, quantity: 1 }],
        },
        buyer,
      )
    ).statusCode,
    409,
  );
  assert.equal((await api(purchase(o), 'GET', undefined, buyer)).id, o.id);
  const g = await imported(),
    gq = await quote(g);
  await api('/b2b/accounts/' + g.account.id, 'PATCH', {
    ...g.body,
    version: 2,
    active: false,
    confirmed: true,
  });
  assert.equal(
    (await req(g.base + '/quotes/' + gq.id + '/checkout', 'POST', { confirmed: true }, buyer))
      .statusCode,
    409,
  );
});
test('foreign catalog items, warehouse, products, missing confirmation and non-admin mutations are rejected', async () => {
  const f = await imported();
  assert.equal(
    (
      await req(
        f.base + '/quotes',
        'POST',
        {
          client_key: randomUUID(),
          warehouse_id: warehouse,
          items: [{ item_id: f.item.id, quantity: 1 }],
        },
        buyer,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        f.base + '/quotes',
        'POST',
        {
          client_key: randomUUID(),
          warehouse_id: buyerWarehouse,
          items: [{ item_id: randomUUID(), quantity: 1 }],
        },
        buyer,
      )
    ).statusCode,
    409,
  );
  const q = await quote(f);
  assert.equal(
    (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', {}, buyer)).statusCode,
    422,
  );
  const uid = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0].id;
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    SECOND_TENANT,
    uid,
  ]);
  try {
    assert.equal(
      (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, buyer))
        .statusCode,
      403,
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      SECOND_TENANT,
      uid,
    ]);
  }
});
test('cancelled supplier order releases reservation and cannot be received', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  await api('/orders/' + o.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.source_order_id + '/status', { status: 'cancelled' }));
  assert.equal((await api(purchase(o), 'GET', undefined, buyer)).fulfillment.status, 'cancelled');
  assert.equal((await req(purchase(o) + '/receipts', 'POST', receipt(o), buyer)).statusCode, 409);
  assert.equal((await stock(f.product.id)).reserved, 0);
});
test('forced RLS covers all purchase tables; restored preview reads both sides and rejects mutations', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  for (const tbl of [
    'b2b_network_quotes',
    'b2b_network_orders',
    'b2b_network_order_lines',
    'b2b_network_receipts',
    'b2b_network_receipt_lines',
  ]) {
    const flags = (
      await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1', [
        tbl,
      ])
    ).rows[0];
    assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
    assert.equal(
      (
        await tenantTx(DEMO_TENANT, (c) =>
          c.query('SELECT count(*)::int n FROM ' + tbl + ' WHERE tenant_id=$1', [SECOND_TENANT]),
        )
      ).rows[0].n,
      0,
    );
  }
  const preview = await buildApp({ readOnly: true, previewPort: 4199 });
  try {
    const login = await preview.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email: 'other@demo.local', password: 'DynaDemo!2026' },
      }),
      cookie = login.headers['set-cookie']!.toString().split(';')[0];
    assert.equal(
      (await preview.inject({ url: '/api' + purchase(o), headers: { cookie } })).statusCode,
      200,
    );
    assert.equal(
      (
        await preview.inject({
          url: '/api' + purchase(o) + '/receipts',
          method: 'POST',
          headers: { cookie },
          payload: receipt(o),
        })
      ).statusCode,
      423,
    );
  } finally {
    await preview.close();
  }
});
test('buyer record failure rolls back source checkout, and receipt record failure rolls back PZ and stock', async () => {
  const f = await imported(),
    q = await quote(f);
  await pool.query(
    `CREATE FUNCTION qa_network_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA injected failure'; END $$`,
  );
  try {
    await pool.query(
      'CREATE TRIGGER qa_network_fail BEFORE INSERT ON b2b_network_orders FOR EACH ROW EXECUTE FUNCTION qa_network_fail()',
    );
    assert.equal(
      (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, buyer))
        .statusCode,
      409,
    );
    assert.equal((await stock(f.product.id)).reserved, 0);
    assert.equal(
      (await pool.query('SELECT order_id FROM b2b_quotes WHERE id=$1', [q.source_quote_id])).rows[0]
        .order_id,
      null,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM orders WHERE b2b_account_id=$1', [
          f.account.id,
        ])
      ).rows[0].n,
      0,
    );
    await pool.query('DROP TRIGGER qa_network_fail ON b2b_network_orders');
    const o = await checkout(f, q);
    await shipped(f, o);
    const before = (
      await pool.query('SELECT count(*)::int n FROM warehouse_documents WHERE tenant_id=$1', [
        SECOND_TENANT,
      ])
    ).rows[0].n;
    await pool.query(
      'CREATE TRIGGER qa_network_fail BEFORE INSERT ON b2b_network_receipts FOR EACH ROW EXECUTE FUNCTION qa_network_fail()',
    );
    assert.equal((await req(purchase(o) + '/receipts', 'POST', receipt(o), buyer)).statusCode, 409);
    assert.equal((await stock(o.lines[0].product_id)).on_hand, 0);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM warehouse_documents WHERE tenant_id=$1', [
          SECOND_TENANT,
        ])
      ).rows[0].n,
      before,
    );
    assert.equal((await api(purchase(o), 'GET', undefined, buyer)).version, 1);
    await pool.query('DROP TRIGGER qa_network_fail ON b2b_network_receipts');
    await api(purchase(o) + '/receipts', 'POST', receipt(o), buyer);
  } finally {
    await pool.query('DROP FUNCTION qa_network_fail() CASCADE');
  }
});
test('source partial return reduces remaining receipt ceiling even when source status remains shipped', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f));
  await shipped(f, o);
  const source = await api('/orders/' + o.source_order_id),
    item = source.items[0];
  const r = await api('/orders/' + o.source_order_id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'Jedna sztuka uszkodzona',
    items: [{ item_id: item.id, quantity: 1 }],
  });
  await api('/returns/' + r.id + '/receive', 'POST', {
    version: r.version,
    note: 'Przyjęta uszkodzona sztuka',
    items: [{ item_id: item.id, accepted: 1, restocked: 0 }],
  });
  const d = await api(purchase(o), 'GET', undefined, buyer);
  assert.equal(d.fulfillment.status, 'shipped');
  assert.equal(d.fulfillment.returned[0].quantity, 1);
  assert.equal(
    (await req(purchase(o) + '/receipts', 'POST', receipt(d, 3), buyer)).statusCode,
    409,
  );
  await api(purchase(o) + '/receipts', 'POST', receipt(d, 2), buyer);
  assert.equal((await stock(d.lines[0].product_id)).on_hand, 2);
});
test('expired quotes and locally deactivated products cannot create a supplier reservation', async () => {
  const f = await imported(),
    q = await quote(f);
  await pool.query("UPDATE b2b_quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [
    q.source_quote_id,
  ]);
  assert.equal(
    (await req(f.base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true }, buyer))
      .statusCode,
    409,
  );
  const next = await quote(f);
  await pool.query('UPDATE products SET active=false WHERE id=$1', [
    next.summary.items[0].product_id,
  ]);
  assert.equal(
    (await req(f.base + '/quotes/' + next.id + '/checkout', 'POST', { confirmed: true }, buyer))
      .statusCode,
    409,
  );
  assert.equal((await stock(f.product.id)).reserved, 0);
});
test('supplier bundle reserves physical components, buyer receives purchased units as own simple product', async () => {
  const f = await fixture(),
    component = f.product;
  const bundle = await api('/products', 'POST', {
    sku: 'NET-BUNDLE-' + randomUUID(),
    name: 'Zestaw hurtowy',
    price: 30000,
    kind: 'bundle',
    warehouse_id: warehouse,
    components: [{ product_id: component.id, quantity: 2 }],
  });
  await api('/price-lists/' + f.list.id + '/items', 'PUT', {
    version: f.list.version,
    items: [
      { product_id: component.id, price: null },
      { product_id: bundle.id, price: 15000 },
    ],
  });
  await finish(await refresh(f));
  f.item = (await catalog(f)).data.find((i: any) => i.source_product_id === bundle.id);
  const p = await api(
    f.base + '/catalog/' + f.item.id + '/product',
    'POST',
    {
      version: f.item.version,
      sku: 'OWN-BUNDLE-' + randomUUID(),
      sale_price: 45000,
      warehouse_id: buyerWarehouse,
      confirmed: true,
    },
    buyer,
  );
  assert.equal((await api('/products/' + p.product_id, 'GET', undefined, buyer)).kind, 'simple');
  const o = await checkout(f, await quote(f, 2));
  assert.equal((await stock(component.id)).reserved, 4);
  assert.equal(o.lines[0].quantity, 2);
  await api('/orders/' + o.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.source_order_id + '/status', { status: 'paid' }));
  await api('/orders/' + o.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.source_order_id + '/status', { status: 'picking' }));
  for (let n = 0; n < 4; n++)
    await api('/orders/' + o.source_order_id + '/scan', 'POST', { code: component.sku });
  await api('/orders/' + o.source_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + o.source_order_id + '/status', { status: 'packed' }));
  await api('/orders/' + o.source_order_id + '/ship-demo', 'POST', {});
  await api(purchase(o) + '/receipts', 'POST', receipt(o, 2), buyer);
  assert.deepEqual(await stock(component.id), { on_hand: 8, reserved: 0 });
  assert.deepEqual(await stock(p.product_id), { on_hand: 2, reserved: 0 });
});
test('receipt history pages without duplicates after twenty-six genuine partial PZ documents', async () => {
  const f = await imported({ quantity: 30 }),
    o = await checkout(f, await quote(f, 27));
  await shipped(f, o);
  let current = o;
  for (let n = 0; n < 26; n++) {
    await api(purchase(o) + '/receipts', 'POST', receipt(current), buyer);
    current = await api(purchase(o), 'GET', undefined, buyer);
  }
  assert.equal(current.receipts.length, 25);
  assert(current.receipts_next);
  const next = await api(
    purchase(o) + '/receipts?after=' + current.receipts_next,
    'GET',
    undefined,
    buyer,
  );
  assert.equal(next.data.length, 1);
  assert.equal(next.next, null);
  assert.equal(new Set([...current.receipts, ...next.data].map((r) => r.id)).size, 26);
  assert.equal((await stock(current.lines[0].product_id)).on_hand, 26);
});

async function sourceReceipt(id: string, amount: number) {
  const current = await api('/orders/' + id);
  return api('/orders/' + id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(current.version),
    kind: 'receipt',
    amount,
    currency: 'PLN',
    method: 'bank_transfer',
    reference: 'QA network original balance',
    note: 'QA merge privacy',
    confirmed: true,
  });
}
for (const mode of ['into_main_order', 'technical_merge'])
  test(
    'network ' +
      mode +
      ' exposes only original buyer commerce and protects historical print/PZ after foreign aggregate return',
    async () => {
      const sentinel = 'FOREIGN-MERGE-' + randomUUID();
      const a = await imported({ name: 'Own network source ' + randomUUID() }),
        b = await imported({ name: sentinel }),
        oa = await checkout(a, await quote(a, 1)),
        ob = await checkout(b, await quote(b, 1));
      const foreign = await api('/products', 'POST', {
        sku: sentinel + '-B2C',
        name: sentinel + '-B2C',
        price: 77777,
        warehouse_id: warehouse,
        quantity: 10,
      });
      const oc = await api('/orders', 'POST', {
        customer_name: sentinel,
        email: 'foreign-merge@example.test',
        address: { street: sentinel, city: 'Krakow', postal_code: '30-001', country: 'PL' },
        warehouse_id: warehouse,
        items: [{ product_id: foreign.id, quantity: 1 }],
      });
      await sourceReceipt(oa.source_order_id, 1000);
      await sourceReceipt(ob.source_order_id, 2000);
      const beforeA = await api(purchase(oa), 'GET', undefined, buyer),
        beforeB = await api(purchase(ob), 'GET', undefined, buyer);
      const previewResponse = await req('/order-merges/previews', 'POST', {
        client_key: randomUUID(),
        main_order_id: oa.source_order_id,
        order_ids_to_merge: [ob.source_order_id, oc.id],
        merge_mode: mode,
        sum_delivery_costs: true,
      });
      assert.equal(previewResponse.statusCode, 201, previewResponse.body);
      const pv = previewResponse.json().preview;
      assert.equal(pv.ready, true);
      const executeResponse = await req('/order-merges/execute', 'POST', {
        client_key: randomUUID(),
        preview_id: pv.id,
        scope_hash: pv.scope_hash,
        confirmed: true,
        confirmed_receiver_selection: true,
      });
      assert.equal(executeResponse.statusCode, 201, executeResponse.body);
      const target = executeResponse.json().execution.target_order_id;
      async function historical() {
        const da = await api(purchase(oa), 'GET', undefined, buyer),
          db = await api(purchase(ob), 'GET', undefined, buyer);
        for (const [d, own, before] of [
          [da, oa, beforeA],
          [db, ob, beforeB],
        ]) {
          assert.equal(d.source_order_id, own.source_order_id);
          assert.equal(d.total_gross, own.total_gross);
          assert.deepEqual(d.lines, before.lines);
          assert.equal(d.historical, true);
          assert.equal(d.read_only, true);
          assert.equal(d.fulfillment.read_only, true);
          assert.equal(d.fulfillment.historical, true);
          assert.deepEqual(d.fulfillment.payments, before.fulfillment.payments);
          for (const key of ['shipments', 'documents', 'returned'])
            assert.deepEqual(d.fulfillment[key], []);
          assert(!JSON.stringify(d).includes('portal_token'));
          assert(!JSON.stringify(d).includes('source_snapshot'));
        }
        assert.equal(da.fulfillment.payment_as_of_merge, mode === 'into_main_order');
        assert.equal(db.fulfillment.payment_as_of_merge, false);
        for (const privateValue of [sentinel, b.product.sku, foreign.id, foreign.sku])
          assert(!JSON.stringify(da).includes(privateValue), privateValue);
        assert(!JSON.stringify(db).includes(a.product.sku));
        return da;
      }
      await historical();
      // Source account authorization must survive a different current aggregate recipient/account.
      await pool.query(
        'UPDATE orders SET b2b_account_id=$2,customer_name=$3,email=$4,address=$5 WHERE id=$1',
        [
          target,
          b.account.id,
          sentinel,
          'foreign-merge@example.test',
          JSON.stringify({ street: sentinel, city: 'Krakow', country: 'PL' }),
        ],
      );
      await sourceReceipt(target, 110000);
      await api('/orders/' + target + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + target + '/status', { status: 'picking' }));
      for (const p of [a.product, b.product, foreign])
        await api('/orders/' + target + '/scan', 'POST', { code: p.sku });
      await api('/orders/' + target + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => api(orderPath, 'GET', undefined), '/orders/' + target + '/status', { status: 'packed' }));
      await api('/orders/' + target + '/ship-demo', 'POST', {});
      const doc = await api('/orders/' + target + '/documents', 'POST', { kind: 'invoice' });
      const shipped = await api('/orders/' + target),
        item = shipped.items.find((i: any) => i.product_id === b.product.id);
      assert(item);
      const r = await api('/orders/' + target + '/returns', 'POST', {
        client_key: randomUUID(),
        reason: sentinel,
        items: [{ item_id: item.id, quantity: 1 }],
      });
      await api('/returns/' + r.id + '/receive', 'POST', {
        version: Number(r.version),
        shipping_refund: 0,
        note: sentinel,
        items: [{ item_id: item.id, accepted: 1, restocked: 1 }],
      });
      const received = await api('/returns/' + r.id);
      await api('/returns/' + r.id + '/refund', 'POST', {
        version: Number(received.version),
        amount: 12345,
        reference: sentinel,
        confirmed: true,
      });
      const actual = await api('/orders/' + target);
      assert(actual.documents.some((d: any) => d.id === doc.id));
      assert(actual.shipments.length);
      assert(actual.payment.refunded >= 12345);
      const da = await historical();
      assert.equal(da.fulfillment.payments.received, 1000);
      for (const own of [oa, ob]) {
        const print = await req(
          purchase(own) + '/documents/' + doc.id + '/print',
          'GET',
          undefined,
          buyer,
        );
        assert.equal(print.statusCode, 409, print.body);
        assert(!print.body.includes(sentinel));
        const denied = await req(purchase(own) + '/receipts', 'POST', receipt(own), buyer);
        assert.equal(denied.statusCode, 409, denied.body);
      }
      assert.equal((await req(purchase(oa), 'GET', undefined, admin)).statusCode, 404);
      if (mode === 'technical_merge') {
        // Controlled adversarial binding tests admission independently of ordinary opaque buyer IDs.
        const corrupt = await pool.query(
          'UPDATE b2b_network_orders SET source_order_id=$2 WHERE id=$1 RETURNING source_order_id',
          [oa.id, target],
        );
        assert.equal(corrupt.rows[0].source_order_id, target);
        try {
          assert.equal((await req(purchase(oa), 'GET', undefined, buyer)).statusCode, 404);
          assert.equal(
            (await req(purchase(oa) + '/documents/' + doc.id + '/print', 'GET', undefined, buyer))
              .statusCode,
            404,
          );
        } finally {
          await pool.query('UPDATE b2b_network_orders SET source_order_id=$2 WHERE id=$1', [
            oa.id,
            oa.source_order_id,
          ]);
        }
      }
    },
  );
// Every tenant-owned business row (sessions and the API-key last-use stamp are request bookkeeping).
async function businessFacts() {
  const names = (
    await pool.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
      USING(table_schema,table_name) WHERE c.table_schema='public' AND c.column_name='tenant_id'
      AND t.table_type='BASE TABLE' AND c.table_name NOT IN('sessions','auth237_api_key_state') ORDER BY 1`)
  ).rows.map((r) => r.table_name as string);
  const facts: Record<string, string> = {};
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/);
    facts[name] = (
      await pool.query(`SELECT md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) h FROM "${name}" t`)
    ).rows[0].h;
  }
  return facts;
}
// Merge history (104) without the merge-delivery module that validates it (209) cannot exist on a migrated
// database: the catalogue guard cannot run (55000 in guard_verdict), so the read is refused as an incomplete
// module (503) and nothing is written.
test('network supplier read with hidden merge history tables is refused as an incomplete module without effects', async () => {
  const f = await imported(),
    o = await checkout(f, await quote(f, 1));
  await pool.query('ALTER TABLE order_merge_origins RENAME TO order_merge_origins_network_hidden');
  await pool.query(
    'ALTER TABLE order_merge_executions RENAME TO order_merge_executions_network_hidden',
  );
  try {
    const before = await businessFacts();
    const r = await req(purchase(o), 'GET', undefined, buyer);
    assert.equal(r.statusCode, 503, r.body);
    assert.match(r.json().detail, /Niekompletny moduł/);
    assert.deepEqual(await businessFacts(), before);
  } finally {
    await pool.query(
      'ALTER TABLE order_merge_executions_network_hidden RENAME TO order_merge_executions',
    );
    await pool.query(
      'ALTER TABLE order_merge_origins_network_hidden RENAME TO order_merge_origins',
    );
  }
  assert.equal((await api(purchase(o), 'GET', undefined, buyer)).total_gross, 12345);
});
