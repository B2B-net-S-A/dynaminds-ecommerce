import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  warehouse = '';
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie } });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert(r.statusCode < 300, `${path}: ${r.body}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app?.close();
  await pool.end();
});
async function sources() {
  const product = await ok('/products', 'POST', {
    sku: 'MERGE-INT-' + randomUUID().slice(0, 8),
    name: 'Różne historyczne ceny',
    price: 1000,
    warehouse_id: warehouse,
    quantity: 20,
  });
  const body = {
    customer_name: 'Kupujący QA122',
    email: 'qa122@example.test',
    warehouse_id: warehouse,
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', phone: '500600700' },
  };
  const first = await ok('/orders', 'POST', {
    ...body,
    shipping_cost: 100,
    items: [{ product_id: product.id, quantity: 2 }],
  });
  // An isolated fixture changes catalogue price, never either existing order.
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE products SET price=1700 WHERE id=$1', [product.id]),
  );
  const second = await ok('/orders', 'POST', {
    ...body,
    shipping_cost: 200,
    items: [{ product_id: product.id, quantity: 1 }],
  });
  return { product, first, second };
}
async function receipt(id: string, amount: number) {
  const o = await ok('/orders/' + id);
  return ok('/orders/' + id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(o.version),
    kind: 'receipt',
    amount,
    currency: 'PLN',
    reference: 'QA122 potwierdzenie',
    confirmed: true,
  });
}
async function merge(first: any, second: any, mode: string, sum = true) {
  const p = (
    await ok('/order-merges/previews', 'POST', {
      client_key: randomUUID(),
      main_order_id: first.id,
      order_ids_to_merge: [second.id],
      merge_mode: mode,
      sum_delivery_costs: sum,
    })
  ).preview;
  assert.equal(p.ready, true);
  const e = (
    await ok('/order-merges/execute', 'POST', {
      client_key: randomUUID(),
      preview_id: p.id,
      scope_hash: p.scope_hash,
      confirmed: true,
    })
  ).execution;
  return { p, e, target: await ok('/orders/' + e.target_order_id) };
}
test('merge HTTP head clocks serialize pg Date exactly through create, detail, replay and history', async () => {
  const { first, second } = await sources();
  const body = {
    client_key: randomUUID(),
    main_order_id: first.id,
    order_ids_to_merge: [second.id],
    merge_mode: 'technical_merge',
    sum_delivery_costs: true,
  };
  const created = await ok('/order-merges/previews', 'POST', body);
  assert.equal(created.reused, false);
  const p = created.preview;
  const sqlPreview = (
    await pool.query(
      'SELECT created_at,expires_at FROM order_merge_previews WHERE tenant_id=$1 AND id=$2',
      [DEMO_TENANT, p.id],
    )
  ).rows[0];
  assert(sqlPreview.created_at instanceof Date && sqlPreview.expires_at instanceof Date);
  const iso = (value: unknown, expected: Date) => {
    assert.equal(typeof value, 'string');
    assert.match(value as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(value, expected.toISOString());
  };
  for (const response of [
    created,
    await ok('/order-merges/previews/' + p.id),
    await ok('/order-merges/previews', 'POST', body),
  ]) {
    iso(response.preview.created_at, sqlPreview.created_at);
    iso(response.preview.expires_at, sqlPreview.expires_at);
  }
  assert(sqlPreview.expires_at > sqlPreview.created_at);
  const consent = {
    client_key: randomUUID(),
    preview_id: p.id,
    scope_hash: p.scope_hash,
    confirmed: true,
  };
  const executed = await ok('/order-merges/execute', 'POST', consent);
  assert.equal(executed.reused, false);
  const e = executed.execution;
  const sqlExecution = (
    await pool.query('SELECT created_at FROM order_merge_executions WHERE tenant_id=$1 AND id=$2', [
      DEMO_TENANT,
      e.id,
    ])
  ).rows[0];
  assert(sqlExecution.created_at instanceof Date);
  for (const response of [
    executed,
    await ok('/order-merges/executions/' + e.id),
    await ok('/order-merges/execute', 'POST', consent),
  ])
    iso(response.execution.created_at, sqlExecution.created_at);
  // History reads JSONB, whose timestamp strings retain SQL microseconds.
  // Check their instants without requiring or changing the existing precision.
  const history = (await ok('/order-merges/history')).data;
  for (const [id, expected] of [
    [p.id, sqlPreview.created_at],
    [e.id, sqlExecution.created_at],
  ]) {
    const head = history.find((row: any) => row.id === id);
    assert(head && typeof head.created_at === 'string');
    assert.equal(new Date(head.created_at).toISOString(), expected.toISOString());
  }
  // Current lineage exposes an allowlisted origin header, with no Date fields
  // or raw provider header. Preserve that boundary while serializing heads.
  const lineage = await ok('/order-merges/orders/' + second.id + '/lineage');
  assert.equal(lineage.origin.header.created_at, undefined);
  assert.equal(lineage.origin.header.portal_token, undefined);
  assert.equal(lineage.origin.header.source_snapshot, undefined);
});
test('technical lineage retains immutable private-safe birth after a later merge and isolates foreign orders', async () => {
  const { product, first, second } = await sources();
  const sentinel = 'QA122-BIRTH-PRIVATE-' + randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE orders SET source_snapshot=$2::jsonb WHERE id=$1', [
      first.id,
      JSON.stringify({ provider_private: { token: sentinel, email: first.email } }),
    ]),
  );
  const ordinary = await ok('/order-merges/orders/' + first.id + '/lineage');
  assert.equal(ordinary.created_by, null);
  assert.equal(ordinary.closed_source, false);
  const { e, target } = await merge(first, second, 'technical_merge');
  const lineage = await ok('/order-merges/orders/' + target.id + '/lineage');
  assert.equal(lineage.closed_source, false);
  assert.deepEqual(lineage.claims, []);
  assert.equal(lineage.owner_order_id, target.id);
  assert.equal(lineage.origin, null);
  const sql = (
    await pool.query('SELECT created_at FROM order_merge_executions WHERE id=$1', [e.id])
  ).rows[0];
  assert.deepEqual(lineage.created_by, {
    id: e.id,
    merge_mode: 'technical_merge',
    created_at: sql.created_at.toISOString(),
    main_order_id: first.id,
    sources: [first, second]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((o) => ({ id: o.id, number: o.number })),
  });
  assert.equal(Object.keys(lineage.created_by).length, 5);
  for (const source of lineage.created_by.sources)
    assert.deepEqual(Object.keys(source).sort(), ['id', 'number']);
  const secretFree = (birth: any) => {
    const text = JSON.stringify(birth);
    for (const secret of [sentinel, first.email, first.portal_token, second.portal_token])
      assert(!text.includes(secret));
    assert(!text.includes('source_snapshot') && !text.includes('portal_token'));
  };
  secretFree(lineage.created_by);
  const third = await ok('/orders', 'POST', {
    customer_name: first.customer_name,
    email: first.email,
    address: first.address,
    warehouse_id: warehouse,
    shipping_cost: 100,
    items: [{ product_id: product.id, quantity: 1 }],
  });
  const again = await merge(third, target, 'into_main_order');
  const closed = await ok('/order-merges/orders/' + target.id + '/lineage');
  assert.equal(closed.closed_source, true);
  assert.equal(closed.owner_order_id, third.id);
  assert.equal(closed.claims.length, 1);
  assert.equal(closed.claims[0].execution_id, again.e.id);
  assert.deepEqual(closed.created_by, lineage.created_by);
  secretFree(closed.created_by);
  assert(!JSON.stringify(closed).includes(sentinel));
  assert.equal((await ok('/order-merges/orders/' + third.id + '/lineage')).created_by, null);
  const foreignTenant = randomUUID(),
    foreignWarehouse = randomUUID(),
    foreignOrder = randomUUID();
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'QA122 isolated foreign birth')", [
    foreignTenant,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA122 foreign','FOREIGN')",
    [foreignWarehouse, foreignTenant],
  );
  await pool.query(
    `INSERT INTO orders(id,tenant_id,number,customer_name,email,total,warehouse_id,portal_token)
    VALUES($1,$2,'QA122-FOREIGN','QA122 Other','foreign@example.test',0,$3,$4)`,
    [foreignOrder, foreignTenant, foreignWarehouse, randomUUID()],
  );
  assert.equal((await req('/order-merges/orders/' + foreignOrder + '/lineage')).statusCode, 404);
});
for (const mode of ['technical_merge', 'into_main_order'])
  test(
    mode +
      ': preserve separate prices, partial scans, money and continue through shipment/partial return',
    async () => {
      const { product, first, second } = await sources();
      await receipt(first.id, 2100);
      await receipt(second.id, 1900);
      await ok('/orders/' + first.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + first.id + '/status', { status: 'picking' }));
      await ok('/orders/' + first.id + '/scan', 'POST', { code: product.sku });
      const stock = () =>
        tenantTx(
          DEMO_TENANT,
          async (c) =>
            (
              await c.query(
                'SELECT on_hand,reserved,available FROM stock WHERE product_id=$1 AND warehouse_id=$2',
                [product.id, warehouse],
              )
            ).rows[0],
        );
      const before = await stock();
      const { target } = await merge(first, second, mode);
      assert.deepEqual(await stock(), before);
      assert.equal(target.status, 'picking');
      assert.equal(target.total, 4000);
      assert.deepEqual(
        target.items.map((i: any) => i.price).sort((a: number, b: number) => a - b),
        [1000, 1700],
      );
      assert.equal(target.payment.received, 4000);
      assert.equal(target.payment.amount_due, 0);
      assert.equal(target.picking_items[0].quantity, 3);
      assert.equal(target.picking_items[0].scanned, 1);
      assert.equal(
        (await req('/orders/' + second.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + second.id + '/status', { status: 'cancelled' })))
          .statusCode,
        409,
      );
      await ok('/orders/' + target.id + '/scan', 'POST', { code: product.sku });
      const scanned = await ok('/orders/' + target.id + '/scan', 'POST', { code: product.sku });
      assert(scanned.items.every((i: any) => i.scanned === i.quantity));
      await ok('/orders/' + target.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + target.id + '/status', { status: 'packed' }));
      await ok('/orders/' + target.id + '/ship-demo', 'POST');
      const expensive = scanned.items.find((i: any) => i.price === 1700);
      const r = await ok('/orders/' + target.id + '/returns', 'POST', {
        client_key: randomUUID(),
        reason: 'Zwrot droższej pozycji QA122',
        items: [{ item_id: expensive.id, quantity: 1 }],
      });
      const received = await ok('/returns/' + r.id + '/receive', 'POST', {
        version: Number(r.version),
        shipping_refund: 0,
        note: 'Przyjęcie QA122',
        items: [{ item_id: expensive.id, accepted: 1, restocked: 1 }],
      });
      assert.equal(received.refund_amount, 1700);
      assert.equal((await stock()).on_hand, 18);
    },
  );
test('late original receipt and reversal project once; historical portal never reveals aggregate purchase', async () => {
  const { first, second } = await sources();
  const privateMarker = 'QA122_PRIVATE_ORIGIN_' + randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE orders SET note=$2,source_snapshot=$3 WHERE id=$1', [
      first.id,
      privateMarker,
      JSON.stringify({ private_marker: privateMarker }),
    ]),
  );
  const portal = await ok('/orders/' + first.id + '/portal', 'POST', {
    action: 'rotate',
    days: 30,
  });
  await receipt(first.id, 1000);
  const { target } = await merge(first, second, 'into_main_order', false);
  assert.equal(target.total, 3800);
  assert.equal(target.payment.amount_due, 2800);
  const paid = await receipt(second.id, 1900);
  let owner = await ok('/orders/' + target.id);
  assert.equal(owner.payment.received, 2900);
  assert.equal(owner.payment.amount_due, 900);
  const ledger = await ok('/orders/' + owner.id + '/payments');
  const entry = ledger.data.find((p: any) => p.order_id === second.id);
  assert(entry);
  const reverse = await ok('/orders/' + owner.id + '/payments/reverse', 'POST', {
    client_key: randomUUID(),
    version: Number(owner.version),
    entry_id: entry.id,
    reason: 'Korekta oryginalnej wpłaty QA122',
    confirmed: true,
  });
  assert.equal(reverse.balance.received, 1000);
  owner = await ok('/orders/' + owner.id);
  assert.equal(owner.payment.amount_due, 2800);
  const source = await ok('/orders/' + second.id);
  assert.equal(source.payment.received, 0);
  const token = portal.portal_token ?? portal.url?.split('/').at(-1);
  assert(token, 'Portal must return a usable original token');
  const publicView = await app.inject({ url: '/api/public/orders/' + token + '/data' });
  assert.equal(publicView.statusCode, 200, publicView.body);
  const view = publicView.json();
  assert(!publicView.body.includes(privateMarker));
  assert(!Object.hasOwn(view, 'portal_token'));
  assert(!Object.hasOwn(view, 'source_snapshot'));
  assert.equal(view.read_only, true);
  assert.equal(view.total, 2100);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].quantity, 2);
  assert.deepEqual(view.documents, []);
  assert(paid);
});
test('database operational admission rejects closed sources without changing stock', async () => {
  const { first, second } = await sources();
  await merge(first, second, 'technical_merge');
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE orders SET status='cancelled' WHERE id=$1", [first.id]),
    ),
    /przeniesiona/,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE order_pick_items SET scanned=scanned+1 WHERE order_id=$1', [second.id]),
    ),
    /przeniesiona/,
  );
  const orders = await ok('/orders?search=Kupujący%20QA122');
  assert(!orders.data.some((o: any) => o.id === first.id || o.id === second.id));
});

test('original main buyer token never exposes later aggregate owner receipts or return credits', async () => {
  const { product, first, second } = await sources();
  const portal = await ok('/orders/' + first.id + '/portal', 'POST', {
    action: 'rotate',
    days: 30,
  });
  await receipt(first.id, 1000);
  const { target } = await merge(first, second, 'into_main_order', false);
  await receipt(target.id, 2800);
  const token = portal.portal_token ?? portal.url?.split('/').at(-1);
  const view = async () => {
    const r = await app.inject({ url: '/api/public/orders/' + token + '/data' });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.payment_as_of_merge, true);
    assert.equal(b.payment.received, 1000);
    assert.equal(b.payment.amount_due, 1100);
    assert.equal(b.payment.credit, 0);
    assert.equal(b.payment.refunded, 0);
    assert.equal(b.total, 2100);
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].quantity, 2);
    assert.deepEqual(b.documents, []);
    assert.deepEqual(b.shipments, []);
    assert.deepEqual(b.cases, []);
  };
  await view();
  await ok('/orders/' + target.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + target.id + '/status', { status: 'picking' }));
  for (let n = 0; n < 3; n++)
    await ok('/orders/' + target.id + '/scan', 'POST', { code: product.sku });
  await ok('/orders/' + target.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + target.id + '/status', { status: 'packed' }));
  await ok('/orders/' + target.id + '/ship-demo', 'POST');
  const shipped = await ok('/orders/' + target.id);
  const expensive = shipped.items.find((i: any) => i.price === 1700);
  const r = await ok('/orders/' + target.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'Zwrot zakupu drugiego kupującego',
    items: [{ item_id: expensive.id, quantity: 1 }],
  });
  await ok('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    shipping_refund: 0,
    note: 'Prywatny zwrot droższej pozycji',
    items: [{ item_id: expensive.id, accepted: 1, restocked: 1 }],
  });
  assert.equal((await ok('/orders/' + target.id)).payment.credit, 1700);
  await view();
  const html = await app.inject({ url: '/api/public/orders/' + token });
  assert.equal(html.statusCode, 200, html.body);
  assert(html.body.includes('Saldo z chwili połączenia'));
});

test('late source receipt and owner reversal contend on one owner without opposite source locks', async () => {
  const { first, second } = await sources();
  await receipt(first.id, 1000);
  const { target } = await merge(first, second, 'technical_merge');
  const ledger = await ok('/orders/' + target.id + '/payments');
  const original = ledger.data.find((p: any) => p.order_id === first.id);
  assert(original);
  const owner = await ok('/orders/' + target.id);
  const source = await ok('/orders/' + second.id);
  const reversal = {
    client_key: randomUUID(),
    version: Number(owner.version),
    entry_id: original.id,
    reason: 'QA122 współbieżna korekta',
    confirmed: true,
  };
  const payment = {
    client_key: randomUUID(),
    version: Number(source.version),
    kind: 'receipt',
    amount: 1900,
    currency: 'PLN',
    reference: 'QA122 późna wpłata',
    confirmed: true,
  };
  const blocker = await pool.connect();
  let pending: ReturnType<typeof req>[] = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [target.id]);
    pending = [
      req('/orders/' + second.id + '/payments', 'POST', payment),
      req('/orders/' + target.id + '/payments/reverse', 'POST', reversal),
    ];
    const deadline = Date.now() + 3000;
    let waiting = 0;
    while (Date.now() < deadline) {
      waiting = Number(
        (
          await pool.query(
            "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM orders WHERE id=$1 FOR UPDATE%'",
          )
        ).rows[0].n,
      );
      if (waiting >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(waiting, 2, 'Both real payment requests must wait on the same owner');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  const [paid, reversed] = await Promise.all(pending);
  assert.equal(paid.statusCode, 200, paid.body);
  assert([200, 409].includes(reversed.statusCode), reversed.body);
  if (reversed.statusCode === 409) {
    const fresh = await ok('/orders/' + target.id);
    await ok('/orders/' + target.id + '/payments/reverse', 'POST', {
      ...reversal,
      client_key: randomUUID(),
      version: Number(fresh.version),
    });
  }
  assert.equal((await ok('/orders/' + target.id)).payment.received, 1900);
});
