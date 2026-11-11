import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_\w*test_\w+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  warehouse = '';
const req = (path: string, method: any = 'GET', payload?: any, token?: string) =>
  app.inject({
    url: (token ? '/api/v1' : '/api') + path,
    method,
    payload,
    headers: token ? { authorization: 'Bearer ' + token } : { cookie },
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw new Error('Unexpected provider HTTP');
    },
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200, r.body);
  cookie = r.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function product(quantity = 20) {
  return ok('/products', 'POST', {
    sku: 'IB107-' + randomUUID().slice(0, 8),
    name: 'QA inventory sheet',
    price: 1234,
    warehouse_id: warehouse,
    quantity,
    location: 'A2',
  });
}
async function selection(ids: string[], w = warehouse) {
  return (await ok('/inventory-bulk-edit/selection?warehouse_id=' + w + '&ids=' + ids.join(',')))
    .data;
}
function input(rows: any[], extra: any = {}) {
  return {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    note: 'QA zmierzony stan i przeniesienie',
    rows: rows.map((r) => ({
      product_id: r.product_id,
      product_version: r.product_version,
      location: r.location,
      stock_version: r.stock_version,
      ...r.change,
    })),
    ...extra,
  };
}
async function execute(preview: any) {
  const body = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
  const result = await ok('/inventory-bulk-edit/previews/' + preview.id + '/execute', 'POST', body);
  const replay = await ok('/inventory-bulk-edit/previews/' + preview.id + '/execute', 'POST', body);
  assert.equal(replay.reused, true);
  assert.equal(replay.execution.id, result.execution.id);
  return result.execution;
}
async function allocation(orderId: string) {
  return tenantTx(
    DEMO_TENANT,
    async (c) =>
      (
        await c.query(
          'SELECT to_jsonb(r) row FROM reservation_locations r WHERE tenant_id=$1 AND order_id=$2 ORDER BY 1',
          [DEMO_TENANT, orderId],
        )
      ).rows,
  );
}
test('count and free-unit move preserve frozen sale/allocation snapshots through picking, shipment and a physical return', async () => {
  const p = await product(100),
    q = await product(50);
  const order = await ok('/orders', 'POST', {
    customer_name: 'QA107',
    email: 'qa107@example.test',
    warehouse_id: warehouse,
    payment_mode: 'cod',
    items: [
      { product_id: p.id, quantity: 3 },
      { product_id: q.id, quantity: 2 },
    ],
  });
  const frozen = order.items,
    reserved = await allocation(order.id);
  const beforeP = await ok('/products/' + p.id),
    beforeQ = await ok('/products/' + q.id);
  const rows = await selection([p.id, q.id]);
  const bad = input(
    rows.map((r: any) => ({
      ...r,
      change:
        r.product_id === p.id
          ? { operation: 'count', quantity: 1 }
          : { operation: 'move', quantity: 7, destination: 'B1' },
    })),
  );
  const rejected = (await ok('/inventory-bulk-edit/previews', 'POST', bad)).preview;
  assert.equal(rejected.ready, false);
  assert.equal(
    (
      await req('/inventory-bulk-edit/previews/' + rejected.id + '/execute', 'POST', {
        client_key: randomUUID(),
        scope_hash: rejected.scope_hash,
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await selection([p.id, q.id]), rows);
  const preview = (
    await ok(
      '/inventory-bulk-edit/previews',
      'POST',
      input(
        rows.map((r: any) => ({
          ...r,
          change:
            r.product_id === p.id
              ? { operation: 'count', quantity: 120 }
              : { operation: 'move', quantity: 7, destination: 'B1' },
        })),
      ),
    )
  ).preview;
  assert.equal(preview.ready, true);
  await execute(preview);
  assert.deepEqual(await allocation(order.id), reserved);
  const afterP = await ok('/products/' + p.id),
    afterQ = await ok('/products/' + q.id);
  for (const [a, b] of [
    [afterP, beforeP],
    [afterQ, beforeQ],
  ]) {
    assert.equal(a.version, b.version);
    assert.equal(a.price, b.price);
    assert.equal(a.sku, b.sku);
  }
  assert.deepEqual((await ok('/orders/' + order.id)).items, frozen);
  const bins = await selection([p.id, q.id]);
  assert.deepEqual(
    bins
      .filter((r: any) => r.product_id === q.id)
      .map((r: any) => [r.location, r.quantity, r.reserved]),
    [
      ['A2', 43, 2],
      ['B1', 7, 0],
    ],
  );
  await ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  for (const [prod, count] of [
    [p, 3],
    [q, 2],
  ] as const)
    for (let n = 0; n < count; n++)
      await ok('/orders/' + order.id + '/scan', 'POST', { code: prod.sku, location: 'A2' });
  await ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  await ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  assert.equal((await selection([p.id]))[0].warehouse_on_hand, 117);
  assert.equal((await selection([q.id]))[0].warehouse_on_hand, 48);
  const returned = await ok('/orders/' + order.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'QA107 fizyczny zwrot',
    items: [{ item_id: frozen.find((i: any) => i.product_id === p.id).id, quantity: 1 }],
  });
  await ok('/returns/' + returned.id + '/receive', 'POST', {
    version: Number(returned.version),
    shipping_refund: 0,
    note: 'QA107 przyjęcie',
    items: [{ item_id: returned.items[0].item_id, accepted: 1, restocked: 1 }],
  });
  assert.equal((await selection([p.id]))[0].warehouse_on_hand, 118);
  assert.equal((await ok('/orders/' + order.id)).status, 'shipped');
});
test('a second warehouse creates only explicitly counted absent stock and leaves product identity and original warehouse exact', async () => {
  const p = await product(10),
    before = await selection([p.id]);
  const w = await ok('/warehouses', 'POST', {
    name: 'QA107 drugi magazyn',
    code: 'W' + randomUUID().slice(0, 8),
  });
  const rows = await selection([p.id], w.id);
  assert.equal(rows[0].stock_version, null);
  assert.equal(rows[0].exists, false);
  const preview = (
    await ok(
      '/inventory-bulk-edit/previews',
      'POST',
      input(
        rows.map((r: any) => ({ ...r, change: { operation: 'count', quantity: 5 } })),
        { warehouse_id: w.id },
      ),
    )
  ).preview;
  assert.equal(preview.ready, true);
  await execute(preview);
  assert.deepEqual(await selection([p.id]), before);
  const after = await selection([p.id], w.id);
  assert.equal(after[0].quantity, 5);
  assert.equal(after[0].exists, true);
  assert.equal((await ok('/products/' + p.id)).version, p.version);
});
test('public API requires both read scopes and inventory write, while an inventory-only write does not require products:write', async () => {
  const p = await product(),
    rows = await selection([p.id]);
  const keys = [];
  for (const scopes of [
    ['inventory:read'],
    ['products:read', 'inventory:read'],
    ['products:read', 'inventory:read', 'inventory:write'],
  ])
    keys.push(await ok('/developer/keys', 'POST', { name: 'QA107 scopes', scopes }));
  const path = '/inventory-bulk-edit/selection?warehouse_id=' + warehouse + '&ids=' + p.id;
  assert.equal((await req(path, 'GET', undefined, keys[0].token)).statusCode, 403);
  const read = await req(path, 'GET', undefined, keys[1].token);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.headers['cache-control'], 'no-store');
  const body = input(
    rows.map((r: any) => ({ ...r, change: { operation: 'count', quantity: 25 } })),
  );
  assert.equal(
    (await req('/inventory-bulk-edit/previews', 'POST', body, keys[1].token)).statusCode,
    403,
  );
  const previewResponse = await req('/inventory-bulk-edit/previews', 'POST', body, keys[2].token);
  assert.equal(previewResponse.statusCode, 201, previewResponse.body);
  const preview = previewResponse.json().preview;
  const execution = await req(
    '/inventory-bulk-edit/previews/' + preview.id + '/execute',
    'POST',
    { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true },
    keys[2].token,
  );
  assert.equal(execution.statusCode, 201, execution.body);
  assert.equal((await selection([p.id]))[0].quantity, 25);
});
