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
  foreignW: string,
  s: any;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: auth } });
function ok(r: any, code = 200) {
  assert.equal(r.statusCode, code, r.body);
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
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  w = ok(await req('/warehouses')).data[0].id;
  foreignW = ok(await req('/warehouses', 'GET', undefined, other)).data[0].id;
  s = ok(await req('/suppliers', 'POST', { name: 'Dostawca QA', code: 'QA-' + randomUUID() }), 201);
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(quantity = 0, kind = 'simple') {
  return ok(
    await req('/products', 'POST', {
      sku: 'PO-' + randomUUID().slice(0, 8),
      name: 'Produkt zakupowy',
      price: 12900,
      vat: 23,
      warehouse_id: w,
      quantity,
      kind,
    }),
    201,
  );
}
const line = (p: any, quantity = 5, unit_cost = 4000) => ({
  product_id: p.id,
  quantity,
  unit_cost,
});
async function draft(lines: any[], extra: any = {}) {
  return ok(
    await req('/purchase-orders', 'POST', { supplier_id: s.id, warehouse_id: w, lines, ...extra }),
    201,
  );
}
async function place(d: any) {
  return ok(await req('/purchase-orders/' + d.id + '/place', 'POST', { version: d.version }));
}
function receive(d: any, lines: any[], extra: any = {}) {
  return req('/purchase-orders/' + d.id + '/receive', 'POST', {
    version: d.version,
    client_key: randomUUID(),
    lines,
    ...extra,
  });
}
async function stock(p: any) {
  return (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT * FROM stock WHERE product_id=$1 AND warehouse_id=$2', [p.id, w]),
    )
  ).rows[0];
}
async function counts(id: string) {
  return tenantTx(DEMO_TENANT, async (c) => ({
    receipts: Number(
      (await c.query('SELECT count(*) FROM purchase_receipts WHERE order_id=$1', [id])).rows[0]
        .count,
    ),
    documents: Number((await c.query('SELECT count(*) FROM warehouse_documents')).rows[0].count),
    moves: Number((await c.query('SELECT count(*) FROM stock_movements')).rows[0].count),
  }));
}
test('draft/place do not change stock; split PZ completes order, freezes costs and preserves sales price', async () => {
  const p = await product(),
    q = await product(),
    initial = await stock(p);
  let d = await draft([line(p), line(q, 3, 2500)], { expected_date: '2026-10-12' });
  assert.equal(d.total_net, 27500);
  assert.deepEqual(await stock(p), initial);
  assert.equal((await receive(d, [{ product_id: p.id, quantity: 1 }])).statusCode, 409);
  d = await place(d);
  assert.deepEqual(await stock(p), initial);
  let r = ok(
    await receive(d, [
      { product_id: p.id, quantity: 2 },
      { product_id: q.id, quantity: 1 },
    ]),
  );
  d = r.order;
  assert.equal(d.state, 'partial');
  assert.equal(d.received_net, 10500);
  assert.equal(d.receipts[0].document_status, 'posted');
  assert.equal((await stock(p)).on_hand, 2);
  assert.equal(
    (await req('/purchase-orders/' + d.id, 'PATCH', { ...d, version: d.version })).statusCode,
    409,
  );
  r = ok(
    await receive(d, [
      { product_id: p.id, quantity: 3 },
      { product_id: q.id, quantity: 2 },
    ]),
  );
  d = r.order;
  assert.equal(d.state, 'received');
  assert.equal(d.receipts.length, 2);
  assert.equal(d.received_net, d.total_net);
  assert.equal((await stock(p)).on_hand, 5);
  assert.equal(ok(await req('/products/' + p.id)).price, 12900);
  assert.equal((await receive(d, [{ product_id: p.id, quantity: 1 }])).statusCode, 409);
});
test('draft editing replaces lines with optimistic concurrency; old snapshots stay immutable', async () => {
  const p = await product(),
    q = await product();
  let d = await draft([line(p)]);
  const edited = ok(
    await req('/purchase-orders/' + d.id, 'PATCH', {
      supplier_id: s.id,
      warehouse_id: w,
      lines: [line(q, 2)],
      version: d.version,
      currency: 'EUR',
    }),
  );
  assert.equal(edited.lines.length, 1);
  assert.equal(edited.lines[0].product_id, q.id);
  assert.equal(edited.currency, 'EUR');
  assert.equal(
    (
      await req('/purchase-orders/' + d.id, 'PATCH', {
        supplier_id: s.id,
        warehouse_id: w,
        lines: [line(p)],
        version: d.version,
      })
    ).statusCode,
    409,
  );
  d = await place(edited);
  assert.equal(
    (await req('/purchase-orders/' + d.id + '/place', 'POST', { version: d.version })).statusCode,
    409,
  );
});
test('same delivery replays after lost response and order close; changed payload with same key rejected', async () => {
  const p = await product();
  let d = await place(await draft([line(p)]));
  const key = randomUUID(),
    b = { client_key: key };
  const r = ok(await receive(d, [{ product_id: p.id, quantity: 2 }], b));
  const replay = ok(await receive(d, [{ product_id: p.id, quantity: 2 }], b));
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt_id, r.receipt_id);
  assert.equal((await stock(p)).on_hand, 2);
  assert.equal((await receive(d, [{ product_id: p.id, quantity: 1 }], b)).statusCode, 409);
  d = ok(
    await req('/purchase-orders/' + d.id + '/close', 'POST', {
      version: r.order.version,
      reason: 'Brak towaru u dostawcy',
    }),
  );
  assert.equal(d.lines[0].closed_quantity, 3);
  assert.equal(ok(await receive(d, [{ product_id: p.id, quantity: 2 }], b)).replayed, true);
  assert.equal((await stock(p)).on_hand, 2);
});
test('concurrent identical delivery is posted once; different deliveries with same version cannot overreceive', async () => {
  const p = await product(),
    d = await place(await draft([line(p)])),
    key = randomUUID();
  const responses = await Promise.all([
    receive(d, [{ product_id: p.id, quantity: 2 }], { client_key: key }),
    receive(d, [{ product_id: p.id, quantity: 2 }], { client_key: key }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 200],
  );
  assert.equal(responses.filter((r) => r.json().replayed).length, 1);
  assert.equal((await stock(p)).on_hand, 2);
  const current = responses[0].json().order;
  const distinct = await Promise.all([
    receive(current, [{ product_id: p.id, quantity: 2 }]),
    receive(current, [{ product_id: p.id, quantity: 2 }]),
  ]);
  assert.deepEqual(distinct.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await stock(p)).on_hand, 4);
});
test('overreceipt/duplicates/unknown SKU reject every line without document, movement or partial update', async () => {
  const p = await product(),
    q = await product(),
    d = await place(await draft([line(p), line(q, 2)])),
    before = await counts(d.id);
  for (const lines of [
    [
      { product_id: p.id, quantity: 1 },
      { product_id: q.id, quantity: 3 },
    ],
    [
      { product_id: p.id, quantity: 1 },
      { product_id: p.id, quantity: 1 },
    ],
    [
      { product_id: p.id, quantity: 1 },
      { product_id: randomUUID(), quantity: 1 },
    ],
  ])
    assert.equal((await receive(d, lines)).statusCode, 422);
  assert.deepEqual(await counts(d.id), before);
  assert.equal((await stock(p)).on_hand, 0);
  assert.equal(ok(await req('/purchase-orders/' + d.id)).version, d.version);
});
test('stock overflow on later SKU rolls back both PZ and purchase counters', async () => {
  const p = await product(),
    q = await product();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE stock SET on_hand=2147483647 WHERE product_id=$1', [q.id]),
  );
  const d = await place(await draft([line(p), line(q)])),
    before = await counts(d.id);
  assert.equal(
    (
      await receive(d, [
        { product_id: p.id, quantity: 1 },
        { product_id: q.id, quantity: 1 },
      ])
    ).statusCode,
    409,
  );
  assert.deepEqual(await counts(d.id), before);
  assert.equal((await stock(p)).on_hand, 0);
  assert.equal(
    ok(await req('/purchase-orders/' + d.id)).lines.every((l: any) => l.received_quantity === 0),
    true,
  );
  const dashboard = ok(await req('/dashboard'));
  assert(BigInt(dashboard.stock.on_hand) > 2147483647n);
});
test('receipt preserves an existing reservation; newly received goods can be sold and reserved', async () => {
  const p = await product(2),
    d = await place(await draft([line(p)]));
  const order = ok(
    await req('/orders', 'POST', {
      customer_name: 'Kupujący QA',
      email: 'qa@example.invalid',
      warehouse_id: w,
      items: [{ product_id: p.id, quantity: 2 }],
    }),
    201,
  );
  ok(await req('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'paid' })));
  const before = await stock(p);
  assert.equal(before.reserved, 2);
  ok(await receive(d, [{ product_id: p.id, quantity: 3 }]));
  assert.equal((await stock(p)).reserved, 2);
  assert.equal((await stock(p)).on_hand, 5);
  const next = ok(
    await req('/orders', 'POST', {
      customer_name: 'Kupujący nową dostawę',
      email: 'qa@example.invalid',
      warehouse_id: w,
      items: [{ product_id: p.id, quantity: 3 }],
    }),
    201,
  );
  ok(await req('/orders/' + next.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + next.id + '/status', { status: 'paid' })));
  assert.equal((await stock(p)).reserved, 5);
});
test('cancel and close gates preserve received goods and require a reason', async () => {
  const p = await product();
  let d = await place(await draft([line(p)]));
  assert.equal(
    (await req('/purchase-orders/' + d.id + '/cancel', 'POST', { version: d.version })).statusCode,
    422,
  );
  d = ok(await receive(d, [{ product_id: p.id, quantity: 1 }])).order;
  assert.equal(
    (
      await req('/purchase-orders/' + d.id + '/cancel', 'POST', {
        version: d.version,
        reason: 'Test',
      })
    ).statusCode,
    409,
  );
  d = ok(
    await req('/purchase-orders/' + d.id + '/close', 'POST', {
      version: d.version,
      reason: 'Reszta niedostępna',
    }),
  );
  assert.equal(d.state, 'closed');
  assert.equal(d.lines[0].remaining_quantity, 0);
  assert.equal((await stock(p)).on_hand, 1);
  assert.equal((await receive(d, [{ product_id: p.id, quantity: 1 }])).statusCode, 409);
  const cancelled = await draft([line(p)]);
  assert.equal(
    ok(
      await req('/purchase-orders/' + cancelled.id + '/cancel', 'POST', {
        version: cancelled.version,
        reason: 'Niepotrzebne',
      }),
    ).state,
    'cancelled',
  );
});
test('supplier code is unique ignoring case, archive/version control and approved receipt snapshot', async () => {
  const local = ok(
    await req('/suppliers', 'POST', {
      name: 'Hurtownia historyczna',
      code: 'Hist-' + randomUUID(),
    }),
    201,
  );
  assert.equal(
    (await req('/suppliers', 'POST', { name: 'Duplikat', code: local.code.toLowerCase() }))
      .statusCode,
    409,
  );
  const p = await product(),
    d = await place(await draft([line(p)], { supplier_id: local.id }));
  const updated = ok(
    await req('/suppliers/' + local.id, 'PATCH', { ...local, name: 'Nowa nazwa', active: false }),
  );
  assert.equal(updated.version, 2);
  assert.equal((await req('/suppliers/' + local.id, 'PATCH', { ...local })).statusCode, 409);
  assert.equal(
    (
      await req('/purchase-orders', 'POST', {
        supplier_id: local.id,
        warehouse_id: w,
        lines: [line(p)],
      })
    ).statusCode,
    422,
  );
  const r = ok(await receive(d, [{ product_id: p.id, quantity: 1 }]));
  assert.equal(r.order.supplier_snapshot.name, 'Hurtownia historyczna');
});
test('reject foreign warehouse/supplier/product, nonphysical SKU and unsafe financial aggregates', async () => {
  const p = await product(),
    group = await product(0, 'group');
  for (const extra of [
    { warehouse_id: foreignW },
    { supplier_id: randomUUID() },
    { lines: [line(group)] },
    { lines: [{ product_id: randomUUID(), quantity: 1, unit_cost: 1 }] },
  ])
    assert.equal(
      (
        await req('/purchase-orders', 'POST', {
          supplier_id: s.id,
          warehouse_id: w,
          lines: [line(p)],
          ...extra,
        })
      ).statusCode,
      422,
    );
  // 10 distinct entries each 1e15 => exceeds safe integer; rejects before catalog lookup.
  assert.equal(
    (
      await req('/purchase-orders', 'POST', {
        supplier_id: s.id,
        warehouse_id: w,
        lines: Array.from({ length: 10 }, () => ({
          product_id: randomUUID(),
          quantity: 1000000,
          unit_cost: 1000000000,
        })),
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/purchase-orders', 'POST', {
        supplier_id: s.id,
        warehouse_id: w,
        lines: [line(p)],
        expected_date: '2026-02-30',
      })
    ).statusCode,
    422,
  );
});
test('tenant isolation, role permissions and direct RLS with existing cross-tenant rows', async () => {
  const p = await product(),
    d = await place(await draft([line(p)]));
  const r = ok(await receive(d, [{ product_id: p.id, quantity: 1 }]));
  assert.equal((await req('/purchase-orders/' + d.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (
      await req(
        '/purchase-orders/' + d.id + '/close',
        'POST',
        { version: r.order.version, reason: 'Obca' },
        other,
      )
    ).statusCode,
    404,
  );
  const tables = [
    'suppliers',
    'purchase_orders',
    'purchase_order_lines',
    'purchase_receipts',
    'purchase_receipt_lines',
  ];
  for (const table of tables) {
    assert(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE tenant_id=$1`, [DEMO_TENANT])).rows[0]
        .count > 0,
    );
    const foreignTenant = (
      await pool.query('SELECT tenant_id FROM warehouses WHERE id=$1', [foreignW])
    ).rows[0].tenant_id;
    assert.equal(
      (
        await tenantTx(foreignTenant, (c) =>
          c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [DEMO_TENANT]),
        )
      ).rowCount,
      0,
    );
  }
  for (const auth of [viewer, operator]) {
    assert.equal((await req('/purchase-orders/' + d.id, 'GET', undefined, auth)).statusCode, 200);
    assert.equal(
      (await req('/suppliers', 'POST', { name: 'Denied', code: randomUUID() }, auth)).statusCode,
      403,
    );
    assert.equal(
      (
        await req(
          '/purchase-orders/' + d.id + '/receive',
          'POST',
          {
            version: r.order.version,
            client_key: randomUUID(),
            lines: [{ product_id: p.id, quantity: 1 }],
          },
          auth,
        )
      ).statusCode,
      403,
    );
  }
});
test('bounded pagination visits every purchase/supplier once; search filters persisted records', async () => {
  const first = ok(await req('/purchase-orders?limit=2'));
  assert.equal(first.data.length, 2);
  let cursor = first.meta.cursor,
    ids = first.data.map((d: any) => d.id);
  while (cursor) {
    const r = ok(await req('/purchase-orders?limit=2&after=' + cursor));
    ids.push(...r.data.map((d: any) => d.id));
    cursor = r.meta.cursor;
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    ids.length,
    Number(
      (await tenantTx(DEMO_TENANT, (c) => c.query('SELECT count(*) FROM purchase_orders'))).rows[0]
        .count,
    ),
  );
  assert.equal(ok(await req('/suppliers?search=' + encodeURIComponent(s.code))).data.length, 1);
  assert.equal((await req('/purchase-orders?limit=101')).statusCode, 422);
});
test('public API uses purchasing scope and shared transactional receipt handlers', async () => {
  const p = await product(),
    d = await place(await draft([line(p)]));
  const read = ok(
      await req('/developer/keys', 'POST', { name: 'Zakupy read', scopes: ['purchasing:read'] }),
      201,
    ),
    write = ok(
      await req('/developer/keys', 'POST', {
        name: 'Zakupy write',
        scopes: ['purchasing:read', 'purchasing:write'],
      }),
      201,
    );
  const call = (key: any, path: string, method: any = 'GET', payload?: any) =>
    app.inject({
      url: '/api/v1' + path,
      method,
      payload,
      headers: { authorization: 'Bearer ' + key.token },
    });
  assert.equal((await call(read, '/purchase-orders/' + d.id)).statusCode, 200);
  const b = {
    version: d.version,
    client_key: randomUUID(),
    lines: [{ product_id: p.id, quantity: 2 }],
  };
  assert.equal(
    (await call(read, '/purchase-orders/' + d.id + '/receive', 'POST', b)).statusCode,
    403,
  );
  const r = ok(await call(write, '/purchase-orders/' + d.id + '/receive', 'POST', b));
  assert.equal(r.order.state, 'partial');
  assert.equal((await stock(p)).on_hand, 2);
  assert.equal(
    ok(await call(write, '/purchase-orders/' + d.id + '/receive', 'POST', b)).replayed,
    true,
  );
  const openapi = ok(await req('/v1/openapi'));
  assert(openapi.paths['/purchase-orders/{id}/receive']);
  assert.equal(
    openapi.paths['/suppliers'].post.responses['201'].description,
    'Sukces; odpowiedź zgodna z kontraktem operacji',
  );
  assert.equal(
    openapi.paths['/purchase-orders'].get.parameters.find((p: any) => p.name === 'limit').schema
      .maximum,
    100,
  );
});
test('maximum 200 SKU receipt is atomic and creates stock at the selected warehouse', async () => {
  const ids = Array.from({ length: 200 }, () => randomUUID()),
    prefix = 'BULK-' + randomUUID().slice(0, 8);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      `INSERT INTO products(id,tenant_id,sku,name,price) SELECT id,$1,$2||'-'||ordinality,'Produkt partii zakupowej',12900 FROM unnest($3::uuid[]) WITH ORDINALITY AS t(id,ordinality)`,
      [DEMO_TENANT, prefix, ids],
    ),
  );
  const d = await place(await draft(ids.map((id) => line({ id }, 1, 100))));
  const r = ok(
    await receive(
      d,
      ids.map((id) => ({ product_id: id, quantity: 1, location: 'B-02' })),
    ),
  );
  assert.equal(r.order.state, 'received');
  assert.equal(r.order.receipts[0].lines.length, 200);
  assert.equal(r.order.received_net, 20000);
  const inventory = await tenantTx(DEMO_TENANT, (c) =>
    c.query('SELECT * FROM stock WHERE product_id=ANY($1::uuid[])', [ids]),
  );
  assert.equal(inventory.rowCount, 200);
  assert(inventory.rows.every((s) => s.on_hand === 1 && s.reserved === 0 && s.location === 'B-02'));
});
test('cross-tenant supplier FK and direct RLS writes cannot bypass API isolation', async () => {
  const foreign = ok(
      await req(
        '/suppliers',
        'POST',
        { name: 'Obcy dostawca', code: 'FOREIGN-' + randomUUID() },
        other,
      ),
      201,
    ),
    p = await product(),
    d = await draft([line(p)]);
  assert.equal(
    (
      await req('/purchase-orders', 'POST', {
        supplier_id: foreign.id,
        warehouse_id: w,
        lines: [line(p)],
      })
    ).statusCode,
    422,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE purchase_orders SET supplier_id=$2 WHERE id=$1', [d.id, foreign.id]),
    ),
    (e: any) => e.code === '23503',
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('INSERT INTO suppliers(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
        randomUUID(),
        foreign.tenant_id,
        'Niedozwolony',
        randomUUID(),
      ]),
    ),
    (e: any) => e.code === '42501',
  );
  assert.equal(ok(await req('/purchase-orders/' + d.id)).supplier_id, s.id);
});
