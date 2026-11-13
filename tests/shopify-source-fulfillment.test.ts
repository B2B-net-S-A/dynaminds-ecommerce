import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteShipmentFixture } from './shipment-identity-fixture';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed } from './fixtures';
import { processShipping } from '../server/shipping';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';
import {
  processShopifyFulfillment,
  failShopifyFulfillment,
  shopifySourceFulfillmentLocal,
} from '../server/shopify-fulfillment';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  f = shopifyFulfillmentFixture(),
  ip = 1;
const transport = async (u: string, i: RequestInit) => {
  const mutation = String(i.body).includes('mutation DynaFulfillmentCreate'),
    n = f.state.fulfillments.length;
  try {
    const r = await f.transport(u, i);
    if (mutation && f.state.fulfillments.length > n) {
      const id = 'gid://shopify/Fulfillment/' + (88001 + n);
      f.state.fulfillments.at(-1)!.id = id;
      const b = JSON.parse(await r.text());
      if (b.data?.fulfillmentCreate?.fulfillment) b.data.fulfillmentCreate.fulfillment.id = id;
      return new Response(JSON.stringify(b), { status: r.status, headers: r.headers });
    }
    return r;
  } catch (e) {
    if (mutation && f.state.fulfillments.length > n)
      f.state.fulfillments.at(-1)!.id = 'gid://shopify/Fulfillment/' + (88001 + n);
    throw e;
  }
};
const req = (p: string, m: any = 'GET', b?: any, a = cookie) =>
  app.inject({
    url: '/api' + p,
    method: m,
    payload: b,
    headers: { cookie: a },
    remoteAddress: '127.0.21.' + ip,
  });
const ok = async (p: string, m: any = 'GET', b?: any, a = cookie) => {
  const r = await req(p, m, b, a);
  assert(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  assert.equal(process.env.DYNA_TEST, 'true');
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });

  const login = async (e: string) =>
    (await req('/auth/login', 'POST', { email: e, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  ip++;
  f = shopifyFulfillmentFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });
async function setup(
  mode: 'technical_merge' | 'into_main_order' | null = 'technical_merge',
  nested = false,
  a = cookie,
  store = 'https://partial-' + randomUUID() + '.myshopify.com',
  simulation = false,
  dispatch = true,
) {
  f.state.raw.totalPriceSet = money('40.00');
  f.state.raw.currentTotalPriceSet = money('40.00');
  f.state.raw.totalReceivedSet = money('40.00');
  f.state.raw.totalTaxSet = money('7.48');
  const line = f.state.raw.lineItems.nodes[0];
  line.originalTotalSet = money('20.00');
  line.discountAllocations = [];
  line.taxLines = [{ priceSet: money('3.74') }];
  f.state.raw.lineItems.nodes.push({
    ...structuredClone(line),
    id: 'gid://shopify/LineItem/980012',
    quantity: 1,
    currentQuantity: 1,
    unfulfilledQuantity: 1,
    originalTotalSet: money('17.00'),
    taxLines: [{ priceSet: money('3.18') }],
  });
  f.state.raw.shippingLines.nodes[0].originalPriceSet = money('3.00');
  f.state.raw.shippingLines.nodes[0].discountedPriceSet = money('3.00');
  f.state.raw.shippingLines.nodes[0].taxLines = [{ priceSet: money('0.56') }];
  const wh = (await ok('/warehouses', 'GET', undefined, a)).data[0].id,
    ch = (
      await ok(
        '/integrations',
        'POST',
        {
          provider: 'shopify',
          name: 'QA partial',
          mode: 'sandbox',
          settings: { store_url: store },
          credentials: { access_token: 'qa-not-real-shopify-token-2026' },
        },
        a,
      )
    ).id;
  if (simulation)
    await pool.query(
      'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1',
      [ch],
    );
  const product = await ok(
    '/products',
    'POST',
    {
      sku: 'PART-' + randomUUID(),
      name: 'Local mapped variant',
      price: 1800,
      vat: 23,
      quantity: 30,
      warehouse_id: wh,
    },
    a,
  );
  await ok(
    '/integrations/' + ch + '/mappings',
    'POST',
    { external_id: 'gid://shopify/ProductVariant/701', sku: product.sku },
    a,
  );
  const inbound = (
      await ok('/integrations/' + ch + '/stage-orders', 'POST', { data: [f.state.raw] }, a)
    ).data[0],
    source = await ok(
      '/imports/' + inbound.id + '/commit',
      'POST',
      { warehouse_id: wh, expected_hash: inbound.source_hash },
      a,
    );
  const original = await ok('/orders/' + source.id, 'GET', undefined, a);
  assert.equal(original.items.length, 2);
  assert.deepEqual(
    original.items
      .map((i: any) => [i.quantity, i.price, i.line_total])
      .sort((a: any, b: any) => a[0] - b[0]),
    [
      [1, 1700, 1700],
      [2, 1000, 2000],
    ],
  );
  let owner = source,
    quantity = 3;
  const manual = async () => {
    const p = await ok(
      '/orders',
      'POST',
      {
        customer_name: original.customer_name,
        email: original.email,
        address: original.address,
        warehouse_id: wh,
        items: [{ product_id: product.id, quantity: 1 }],
      },
      a,
    );
    await ok(
      '/orders/' + p.id + '/payments',
      'POST',
      {
        client_key: randomUUID(),
        version: 1,
        confirmed: true,
        kind: 'receipt',
        amount: 1800,
        currency: 'PLN',
        method: 'bank_transfer',
        reference: 'QA partial manual',
      },
      a,
    );
    return p;
  };
  if (mode) {
    const m = await manual(),
      p = (
        await ok(
          '/order-merges/previews',
          'POST',
          {
            client_key: randomUUID(),
            main_order_id: source.id,
            order_ids_to_merge: [m.id],
            merge_mode: mode,
            sum_delivery_costs: false,
          },
          a,
        )
      ).preview;
    assert.equal(p.ready, true);
    const execution = (
      await ok(
        '/order-merges/execute',
        'POST',
        { client_key: randomUUID(), preview_id: p.id, scope_hash: p.scope_hash, confirmed: true },
        a,
      )
    ).execution;
    owner = await ok('/orders/' + execution.target_order_id, 'GET', undefined, a);
    quantity++;
    if (nested) {
      const m2 = await manual(),
        q = (
          await ok(
            '/order-merges/previews',
            'POST',
            {
              client_key: randomUUID(),
              main_order_id: owner.id,
              order_ids_to_merge: [m2.id],
              merge_mode: 'technical_merge',
              sum_delivery_costs: false,
            },
            a,
          )
        ).preview;
      const nestedExecution = (
        await ok(
          '/order-merges/execute',
          'POST',
          { client_key: randomUUID(), preview_id: q.id, scope_hash: q.scope_hash, confirmed: true },
          a,
        )
      ).execution;
      owner = await ok('/orders/' + nestedExecution.target_order_id, 'GET', undefined, a);
      quantity++;
    }
  }
  await ok('/orders/' + owner.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, a), '/orders/' + owner.id + '/status', { status: 'picking' }), a);
  for (let i = 0; i < quantity; i++)
    await ok('/orders/' + owner.id + '/scan', 'POST', { code: product.sku }, a);
  await ok('/orders/' + owner.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, a), '/orders/' + owner.id + '/status', { status: 'packed' }), a);
  if (dispatch) await ok('/orders/' + owner.id + '/ship-demo', 'POST', {}, a);
  const tenant = (await ok('/auth/me', 'GET', undefined, a)).user.tenant_id;
  if (!simulation && dispatch)
    await rewriteShipmentFixture("UPDATE shipments SET mode='sandbox',tracking_number=$2 WHERE order_id=$1", [
      owner.id,
      'PARTIAL' + randomUUID().replaceAll('-', ''),
    ]);
  return { source, owner, original, product, wh, ch, store, tenant };
}
type F = Awaited<ReturnType<typeof setup>>;
const body = (lines = [{ remote_line_id: 'gid://shopify/LineItem/980011', quantity: 1 }]) => ({
  client_key: randomUUID(),
  company: 'DPD',
  notify_customer: false,
  lines,
});
const preview = async (x: F, b = body(), a = cookie) => {
  const r = await req('/orders/' + x.source.id + '/shopify-fulfillment/preview', 'POST', b, a);
  if (r.statusCode === 500)
    await tenantTx(x.tenant, (c) => shopifySourceFulfillmentLocal(c, x.source.id, b));
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const queue = (p: any, a = cookie) =>
  req('/shopify-fulfillment-plans/' + p.id + '/queue', 'POST', { confirm_external: true }, a);
const stored = async (p: any) =>
  (await pool.query('SELECT * FROM shopify_fulfillment_plans WHERE id=$1', [p.id])).rows[0];
async function run(p: any, last = false) {
  const q = await stored(p);
  if (last) await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [q.job_id]);
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [q.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processShopifyFulfillment(j, { transport });
  } catch (e) {
    await failShopifyFulfillment(j, e);
  }
  return stored(p);
}
const writes = () =>
  f.calls.filter((v) => v.query.includes('mutation DynaFulfillmentCreate')).length;
const physical = async (x: F) => ({
  stock: (
    await pool.query(
      'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 ORDER BY warehouse_id',
      [x.tenant, x.product.id],
    )
  ).rows,
  movements: (
    await pool.query('SELECT * FROM stock_movements WHERE tenant_id=$1 ORDER BY id', [x.tenant])
  ).rows,
  payments: (
    await pool.query('SELECT * FROM payment_entries WHERE tenant_id=$1 ORDER BY id', [x.tenant])
  ).rows,
  picks: (
    await pool.query('SELECT * FROM order_pick_items WHERE tenant_id=$1 ORDER BY id', [x.tenant])
  ).rows,
});
for (const mode of ['technical_merge', 'into_main_order'] as const)
  test(
    'partial source Shopify ' +
      mode +
      ': distinct remote lines, historic dispatch after return, same tracking, exact retry and no stock/payment effects',
    async () => {
      const x = await setup(mode, mode === 'technical_merge'),
        list = await ok('/orders/' + x.owner.id + '/shopify-fulfillment/sources');
      assert.equal(list.data.length, 1);
      assert.equal(list.data[0].source_order_id, x.source.id);
      const d = await ok('/orders/' + x.source.id + '/shopify-fulfillment');
      assert.equal(d.partial_available, true);
      assert.equal(d.ready, true, d.reason);
      assert.deepEqual(
        d.lines.map((l: any) => [l.remote_line_id, l.remaining_quantity]),
        [
          ['gid://shopify/LineItem/980011', 2],
          ['gid://shopify/LineItem/980012', 1],
        ],
      );
      assert.deepEqual(
        d.lines.map((l: any) => [l.unit_price, l.line_total, l.vat, l.currency]),
        [
          [1000, 2000, 23, 'PLN'],
          [1700, 1700, 23, 'PLN'],
        ],
      );
      const b = body(),
        p = await preview(x, b),
        before = await physical(x);
      assert.equal(p.order_id, x.owner.id);
      assert.deepEqual(
        p.payload.partial.bindings.map((l: any) => [l.unit_price, l.line_total, l.vat, l.currency]),
        [
          [1000, 2000, 23, 'PLN'],
          [1700, 1700, 23, 'PLN'],
        ],
      );
      assert.equal((await preview(x, b)).id, p.id);
      assert.equal(
        (
          await req('/orders/' + x.source.id + '/shopify-fulfillment/preview', 'POST', {
            ...b,
            lines: [{ remote_line_id: b.lines[0].remote_line_id, quantity: 2 }],
          })
        ).statusCode,
        409,
      );
      assert.equal((await queue(p)).statusCode, 200);
      const done = await run(p);
      assert.equal(done.state, 'done', done.error);
      assert.equal(writes(), 1);
      assert.deepEqual(await physical(x), before);
      const order = await ok('/orders/' + x.owner.id),
        cheap = order.items.find((i: any) => i.line_total === 2000),
        r = await ok('/orders/' + x.owner.id + '/returns', 'POST', {
          client_key: randomUUID(),
          reason: 'QA returned dispatched unit',
          items: [{ item_id: cheap.id, quantity: 1 }],
        });
      await ok('/returns/' + r.id + '/receive', 'POST', {
        warehouse_id: x.wh,
        version: Number(r.version),
        note: 'QA accepted return',
        items: [{ item_id: cheap.id, accepted: 1, restocked: 1 }],
      });
      const afterReturn = await physical(x),
        d2 = await ok('/orders/' + x.source.id + '/shopify-fulfillment');
      assert.equal(d2.ready, true, d2.reason);
      assert.equal(d2.lines[0].returned_quantity, 1);
      assert.equal(d2.lines[0].remaining_quantity, 1);
      const p2 = await preview(
        x,
        body([
          { remote_line_id: 'gid://shopify/LineItem/980011', quantity: 1 },
          { remote_line_id: 'gid://shopify/LineItem/980012', quantity: 1 },
        ]),
      );
      assert.equal((await queue(p2)).statusCode, 200);
      const done2 = await run(p2);
      assert.equal(done2.state, 'done', done2.error);
      assert.equal(writes(), 2);
      assert.notEqual(done.remote_id, done2.remote_id);
      assert.equal(
        p.payload.fulfillment.trackingInfo.number,
        p2.payload.fulfillment.trackingInfo.number,
      );
      assert.deepEqual(await physical(x), afterReturn);
      assert.equal((await queue(p2)).statusCode, 200);
      assert.equal(writes(), 2);
      const end = await ok('/orders/' + x.source.id + '/shopify-fulfillment');
      assert.equal(end.ready, false);
      assert(end.lines.every((l: any) => l.remaining_quantity === 0));
      assert.equal(end.data.filter((v: any) => v.state === 'done').length, 2);
    },
  );
test('partial source Shopify lost write ACK never repeats mutation; frozen readback reconciles exact line quantities', async () => {
  const x = await setup(null),
    p = await preview(x),
    before = await physical(x);
  assert.equal((await queue(p)).statusCode, 200);
  f.state.lose = true;
  f.state.hide = true;
  const uncertain = await run(p, true);
  assert.equal(uncertain.phase, 'write_started');
  assert.equal(uncertain.state, 'failed');
  assert.equal(writes(), 1);
  assert.equal(
    (await req('/shopify-fulfillment-plans/' + p.id + '/cancel', 'POST', {})).statusCode,
    409,
  );
  assert.equal(
    (
      await req(
        '/orders/' + x.source.id + '/shopify-fulfillment/preview',
        'POST',
        body([{ remote_line_id: 'gid://shopify/LineItem/980011', quantity: 2 }]),
      )
    ).statusCode,
    409,
  );
  f.state.lose = false;
  f.state.hide = false;
  const done = await ok('/shopify-fulfillment-plans/' + p.id + '/reconcile', 'POST', {});
  assert.equal(done.state, 'done');
  assert.equal(writes(), 1);
  assert.deepEqual(await physical(x), before);
});
test('partial source Shopify global principal remains exclusive after first done part across tenants and channels', async () => {
  const store = 'https://principal-' + randomUUID() + '.myshopify.com',
    x = await setup(null, false, cookie, store),
    p = await preview(x);
  assert.equal((await queue(p)).statusCode, 200);
  assert.equal((await run(p)).state, 'done');
  f = shopifyFulfillmentFixture();
  const y = await setup(null, false, other, store),
    q = await preview(y, body(), other);
  assert.equal((await queue(q, other)).statusCode, 409);
  f = shopifyFulfillmentFixture();
  const z = await setup(null, false, cookie, store),
    r = await preview(z);
  assert.equal((await queue(r)).statusCode, 409);
  assert.equal(writes(), 0);
});
test('partial source Shopify source receiver mismatch blocks, evidence trigger-only immutable, stale local scope blocks queue', async () => {
  const x = await setup(null),
    p = await preview(x),
    actor = (await ok('/auth/me')).user.id;
  await assert.rejects(
    () =>
      tenantTx(x.tenant, async (c) => {
        await c.query(
          "INSERT INTO shopify_dispatch_evidence(tenant_id,shipment_id,order_id,receiver,items,dispatched_at) SELECT tenant_id,id,order_id,'{}','[]',dispatched_at FROM shipments WHERE order_id=$1",
          [x.owner.id],
        );
      }),
    /permission denied/,
  );
  await assert.rejects(
    () =>
      pool.query("UPDATE shopify_dispatch_evidence SET receiver='{}' WHERE order_id=$1", [
        x.owner.id,
      ]),
    /immutable/,
  );
  await pool.query(
    'UPDATE orders SET address=address||\'{"city":"Different recipient"}\'::jsonb,version=version+1 WHERE id=$1',
    [x.owner.id],
  );
  assert.equal((await queue(p)).statusCode, 409);
  assert.equal(
    (await req('/orders/' + x.source.id + '/shopify-fulfillment/preview', 'POST', body()))
      .statusCode,
    409,
  );
  assert.equal(writes(), 0);
  assert.equal(
    (await req('/orders/' + x.source.id + '/shopify-fulfillment', 'GET', undefined, other))
      .statusCode,
    404,
  );
  assert.equal(
    (await req('/orders/' + x.source.id + '/shopify-fulfillment/preview', 'POST', body(), viewer))
      .statusCode,
    403,
  );
  assert(actor);
});

test('partial source Shopify captures actual overridden InPost receiver at dispatch and rejects exporting it as source receiver', async () => {
  const x = await setup(null, false, cookie, undefined, true, false),
    ch = (await ok('/shipping/example', 'POST', {})).id;
  const p = await ok('/orders/' + x.owner.id + '/shipping/preview', 'POST', {
    channel_id: ch,
    service: 'inpost_courier_standard',
    receiver: {
      first_name: 'Other',
      last_name: 'Recipient',
      email: 'other-recipient@example.test',
      phone: '500600700',
      address: {
        street: 'Different',
        building_number: '7',
        city: 'Warszawa',
        post_code: '00-001',
        country_code: 'PL',
      },
    },
    weight: 1,
    dimensions: { length: 100, width: 100, height: 100 },
  });
  const shippingJob = async (id: string) => {
    const j = (
      await pool.query(
        "UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *",
        [id, randomUUID()],
      )
    ).rows[0];
    await processShipping(j, { transport });
  };
  await shippingJob((await ok('/shipping-plans/' + p.id + '/queue', 'POST', {})).job_id);
  const quoted = (await ok('/orders/' + x.owner.id + '/shipping')).data.find(
    (v: any) => v.id === p.id,
  );
  await shippingJob(
    (
      await ok('/shipping-plans/' + p.id + '/buy', 'POST', {
        offer_id: quoted.offers[0].id,
        confirm_cost: true,
        ack_unknown_rate: true,
      })
    ).job_id,
  );
  await ok('/shipping-plans/' + p.id + '/dispatch', 'POST', {});
  const e = (
    await pool.query('SELECT receiver FROM shopify_dispatch_evidence WHERE order_id=$1', [
      x.owner.id,
    ])
  ).rows[0];
  assert.equal(e.receiver.customer_name, 'Other Recipient');
  assert.equal(e.receiver.email, 'other-recipient@example.test');
  assert.equal(e.receiver.address.street, 'Different 7');
  const before = await physical(x),
    r = await req('/orders/' + x.source.id + '/shopify-fulfillment/preview', 'POST', body());
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.json().detail, /Odbiorca/);
  assert.equal(writes(), 0);
  assert.deepEqual(await physical(x), before);
});
