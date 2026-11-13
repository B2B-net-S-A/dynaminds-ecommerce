import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { assertPimIncomplete, tenantDataDigest } from './torn-module-fixture';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>,
  admin = '',
  tenant = '',
  warehouse = '',
  ip = 1;
const req = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  cookie = admin,
) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.122.8.' + ip,
  });
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  status = 200,
  cookie = admin,
): Promise<Row> {
  const r = await req(path, method, body, cookie);
  assert.equal(r.statusCode, status, path.startsWith('/auth') ? path : r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: false,
    integrationTransport: async () => {
      throw Error('No external writes in B2B merge tests');
    },
  });
  const r = await req(
    '/auth/login',
    'POST',
    { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    '',
  );
  assert.equal(r.statusCode, 200);
  admin = String(r.headers['set-cookie']).split(';')[0];
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA122 buyer privacy','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'admin' FROM users WHERE email='admin@demo.local'",
    [tenant],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA122 buyer warehouse','QA122')",
    [warehouse, tenant],
  );
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  admin = String(r.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function buyer(label: string, price: number, shipping: number) {
  const sentinel = label + '-' + randomUUID();
  const product = await ok(
    '/products',
    'POST',
    {
      sku: sentinel,
      name: sentinel,
      price,
      vat: 23,
      quantity: 100,
      warehouse_id: warehouse,
      location: 'A-01',
    },
    201,
  );
  const list = await ok('/price-lists', 'POST', { name: sentinel, currency: 'PLN' }, 201);
  await ok('/price-lists/' + list.id + '/items', 'PUT', {
    version: list.version,
    items: [{ product_id: product.id, price }],
  });
  const body = {
    name: sentinel,
    email: randomUUID() + '@example.test',
    warehouse_id: warehouse,
    price_list_id: list.id,
    address: {
      street: sentinel,
      city: 'Warszawa',
      postal_code: '00-001',
      country: 'PL',
      phone: '500600700',
    },
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
    shipping_cost: shipping,
    payment_mode: 'prepaid',
  };
  const account = await ok('/b2b/accounts', 'POST', body, 201);
  const approved = await ok('/b2b/accounts/' + account.id, 'PATCH', {
    ...body,
    version: account.version,
    active: true,
    confirmed: true,
  });
  const invite = await ok('/b2b/accounts/' + account.id + '/invite', 'POST', {
    version: approved.version,
    confirmed: true,
  });
  const base = '/public/b2b/' + account.id;
  await ok(
    base + '/activate',
    'POST',
    { token: invite.invitation.split('#invite=')[1], password: 'BuyerDemo!2026' },
    200,
    '',
  );
  const login = await req(
    base + '/login',
    'POST',
    { email: body.email, password: 'BuyerDemo!2026' },
    '',
  );
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const quote = await ok(
    base + '/quotes',
    'POST',
    { client_key: randomUUID(), items: [{ product_id: product.id, quantity: 1 }] },
    200,
    cookie,
  );
  const order = await ok(
    base + '/quotes/' + quote.id + '/checkout',
    'POST',
    { confirmed: true },
    200,
    cookie,
  );
  return { sentinel, product, account, base, cookie, quote, order };
}
async function payment(id: string, amount: number) {
  const o = await ok('/orders/' + id);
  await ok('/orders/' + id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(o.version),
    kind: 'receipt',
    amount,
    currency: 'PLN',
    method: 'bank_transfer',
    reference: 'QA122 buyer balance',
    note: 'QA122',
    confirmed: true,
  });
}
async function fixture() {
  const a = await buyer('A-PRIVATE', 1011, 100),
    b = await buyer('B-PRIVATE', 2222, 200);
  const product = await ok(
    '/products',
    'POST',
    {
      sku: 'C-PRIVATE-' + randomUUID(),
      name: 'C-PRIVATE-' + randomUUID(),
      price: 3333,
      quantity: 100,
      warehouse_id: warehouse,
      location: 'A-01',
    },
    201,
  );
  const c = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'C-PRIVATE-B2C',
      email: 'c-private@example.test',
      warehouse_id: warehouse,
      currency: 'PLN',
      shipping_cost: 300,
      address: {
        street: 'C-PRIVATE-ADDRESS',
        city: 'Poznan',
        postal_code: '60-001',
        country: 'PL',
      },
      items: [{ product_id: product.id, quantity: 1 }],
    },
    201,
  );
  await payment(a.order.id, 600);
  await payment(b.order.id, 1200);
  await payment(c.id, 1800);
  return { a, b, c, product };
}
async function merge(f: Awaited<ReturnType<typeof fixture>>, mode: string) {
  const p = await ok(
    '/order-merges/previews',
    'POST',
    {
      client_key: randomUUID(),
      main_order_id: f.a.order.id,
      order_ids_to_merge: [f.b.order.id, f.c.id],
      merge_mode: mode,
      sum_delivery_costs: true,
    },
    201,
  );
  assert.equal(p.preview.ready, true);
  assert.equal(p.preview.receiver_conflict, true);
  return (
    await ok(
      '/order-merges/execute',
      'POST',
      {
        client_key: randomUUID(),
        preview_id: p.preview.id,
        scope_hash: p.preview.scope_hash,
        confirmed: true,
        confirmed_receiver_selection: true,
      },
      201,
    )
  ).execution;
}
async function ownSource(b: Awaited<ReturnType<typeof buyer>>, frozen: boolean) {
  const d = await ok(b.base + '/orders/' + b.order.id, 'GET', undefined, 200, b.cookie);
  assert.equal(d.total, b.order.total);
  assert.equal(d.historical, true);
  assert.equal(d.read_only, true);
  assert.equal(d.payment_as_of_merge, frozen);
  assert.deepEqual(
    d.items.map((i: Row) => [i.name, i.quantity, i.line_total]),
    [[b.product.name, 1, b.order.total - (b.order.total === 1111 ? 100 : 200)]],
  );
  assert.deepEqual(d.documents, []);
  assert.deepEqual(d.shipments, []);
  assert.deepEqual(d.cases, []);
  const page = await ok(b.base + '/orders', 'GET', undefined, 200, b.cookie);
  assert.deepEqual(
    page.data.map((o: Row) => o.id),
    [b.order.id],
  );
  assert.equal(page.data[0].total, b.order.total);
  const replay = await ok(
    b.base + '/quotes/' + b.quote.id + '/checkout',
    'POST',
    { confirmed: true },
    200,
    b.cookie,
  );
  assert.equal(replay.id, b.order.id);
  assert.equal(replay.total, b.order.total);
  assert.equal(replay.read_only, true);
  return d;
}
for (const mode of ['into_main_order', 'technical_merge'])
  test(
    mode + ' preserves original B2B ownership/items/checkout and denies aggregate access',
    async () => {
      const f = await fixture();
      const e = await merge(f, mode);
      const a = await ownSource(f.a, mode === 'into_main_order'),
        b = await ownSource(f.b, false);
      assert.deepEqual(a.payment, { amount_due: 511, received: 600, refunded: 0 });
      assert.deepEqual(b.payment, { amount_due: 1222, received: 1200, refunded: 0 });
      for (const [buyer, foreign] of [
        [f.a, f.b.order.id],
        [f.b, f.a.order.id],
        [f.a, f.c.id],
        [f.b, f.c.id],
      ] as const)
        assert.equal(
          (await req(buyer.base + '/orders/' + foreign, 'GET', undefined, buyer.cookie)).statusCode,
          404,
        );
      for (const buyer of [f.a, f.b]) {
        const all = JSON.stringify(
          await ok(buyer.base + '/orders/' + buyer.order.id, 'GET', undefined, 200, buyer.cookie),
        );
        for (const sentinel of [
          buyer === f.a ? f.b.sentinel : f.a.sentinel,
          'C-PRIVATE',
          'source_snapshot',
          'portal_token',
          'supplier_snapshot',
        ])
          assert(!all.includes(sentinel), sentinel);
        assert.equal(
          (
            await req(
              buyer.base + '/orders/' + buyer.order.id + '/returns',
              'POST',
              {},
              buyer.cookie,
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await req(
              buyer.base + '/orders/' + buyer.order.id + '/documents/' + randomUUID() + '/print',
              'GET',
              undefined,
              buyer.cookie,
            )
          ).statusCode,
          409,
        );
      }
      if (mode === 'technical_merge') {
        for (const buyer of [f.a, f.b])
          assert.equal(
            (await req(buyer.base + '/orders/' + e.target_order_id, 'GET', undefined, buyer.cookie))
              .statusCode,
            404,
          );
      } else {
        // Genuine aggregate payment and accepted/refunded foreign fragment must not appear as the original buyer's own balance.
        await payment(e.target_order_id, 5000);
        assert.deepEqual((await ownSource(f.a, true)).payment, a.payment);
        await ok('/orders/' + e.target_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + e.target_order_id + '/status', { status: 'picking' }));
        for (const p of [f.a.product, f.b.product, f.product])
          await ok('/orders/' + e.target_order_id + '/scan', 'POST', {
            code: p.sku,
            location: 'A-01',
          });
        await ok('/orders/' + e.target_order_id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + e.target_order_id + '/status', { status: 'packed' }));
        await ok('/orders/' + e.target_order_id + '/ship-demo', 'POST');
        const doc = await ok('/orders/' + e.target_order_id + '/documents', 'POST', {
          kind: 'invoice',
        });
        assert.equal(
          (
            await req(
              f.a.base + '/orders/' + f.a.order.id + '/documents/' + doc.id + '/print',
              'GET',
              undefined,
              f.a.cookie,
            )
          ).statusCode,
          409,
        );
        const target = await ok('/orders/' + e.target_order_id),
          foreignItem = target.items.find((i: Row) => i.product_id === f.b.product.id);
        assert(foreignItem);
        const r = await ok(
          '/orders/' + target.id + '/returns',
          'POST',
          {
            client_key: randomUUID(),
            reason: 'Foreign source fragment',
            items: [{ item_id: foreignItem.id, quantity: 1 }],
          },
          201,
        );
        await ok('/returns/' + r.id + '/receive', 'POST', {
          version: Number(r.version),
          shipping_refund: 0,
          note: 'Actual received foreign fragment',
          items: [{ item_id: foreignItem.id, accepted: 1, restocked: 1 }],
        });
        const received = await ok('/returns/' + r.id);
        await ok('/returns/' + r.id + '/refund', 'POST', {
          version: Number(received.version),
          amount: 2222,
          reference: 'QA122 actual aggregate refund',
          confirmed: true,
        });
        const after = await ownSource(f.a, true);
        assert.deepEqual(after.payment, a.payment);
        assert.equal(after.payment_as_of_merge, true);
        assert(!JSON.stringify(after).includes(f.b.sentinel));
      }
    },
  );
test('B2B order cursor preserves PostgreSQL microseconds and checks original account', async () => {
  const b = await buyer('MICRO', 1011, 100);
  // Controlled pagination headers are inserted once; immutable created_at and quota triggers stay enabled.
  // The ordinary HTTP buyer order remains in the last page as a legacy control.
  const ids: string[] = [];
  const timestamp = (
    await pool.query(
      "SELECT (date_trunc('month',now())+interval '1 month'-interval '1 microsecond')::text AS at",
    )
  ).rows[0].at;
  for (let i = 0; i < 26; i++) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,
      to_jsonb(o)||jsonb_build_object('id',$2::text,'number',$3::text,'portal_token',$4::text,
      'created_at',$5::text))).* FROM orders o WHERE o.id=$1`,
      [b.order.id, id, 'QA-MICRO-' + i, randomUUID(), timestamp],
    );
  }
  const ordered = [...ids].sort().reverse().concat(b.order.id);
  const p = await ok(b.base + '/orders', 'GET', undefined, 200, b.cookie);
  assert.equal(p.data.length, 25);
  assert(p.next);
  const next = await ok(b.base + '/orders?after=' + p.next, 'GET', undefined, 200, b.cookie);
  assert.deepEqual(
    [...p.data, ...next.data].map((o: Row) => o.id),
    ordered,
  );
  assert.equal(next.data.length, 2);
  const foreign = await buyer('FOREIGN-CURSOR', 2222, 200);
  const foreignPage = await ok(
    b.base + '/orders?after=' + foreign.order.id,
    'GET',
    undefined,
    200,
    b.cookie,
  );
  assert.deepEqual(foreignPage, { data: [], next: null });
});
test('B2B reads and checkout fail closed with 503 and change nothing while merge history tables are torn', async () => {
  const b = await buyer('LEGACY', 1011, 100);
  await pool.query('ALTER TABLE order_merge_origins RENAME TO order_merge_origins_b2b_hidden');
  await pool.query(
    'ALTER TABLE order_merge_executions RENAME TO order_merge_executions_b2b_hidden',
  );
  try {
    const before = await tenantDataDigest();
    assertPimIncomplete(await req(b.base + '/orders/' + b.order.id, 'GET', undefined, b.cookie));
    assertPimIncomplete(
      await req(b.base + '/quotes/' + b.quote.id + '/checkout', 'POST', { confirmed: true }, b.cookie),
    );
    assert.deepEqual(await tenantDataDigest(), before);
  } finally {
    await pool.query(
      'ALTER TABLE order_merge_executions_b2b_hidden RENAME TO order_merge_executions',
    );
    await pool.query('ALTER TABLE order_merge_origins_b2b_hidden RENAME TO order_merge_origins');
  }
  const d = await ok(b.base + '/orders/' + b.order.id, 'GET', undefined, 200, b.cookie);
  assert.equal(d.total, 1111);
  const q = await ok(
    b.base + '/quotes/' + b.quote.id + '/checkout',
    'POST',
    { confirmed: true },
    200,
    b.cookie,
  );
  assert.equal(q.total, 1111);
});
