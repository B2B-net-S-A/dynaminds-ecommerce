import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import { dispatchAutomation } from '../server/automations';
import { demoShopifyOrder } from '../server/shopify-example';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';
import {
  freshSourceIntentFixture,
  makeProviderHarness,
} from './source-order-intents-provider-fixture';

export type Row = Record<string, any>;
export const prefix = '/b2b/dropshipping-returns';
const transport = shopifyFulfillmentFixture();
export const createMixedHarness = () => makeProviderHarness({ transport: transport.transport });
export type Harness = Awaited<ReturnType<typeof createMixedHarness>>;
export type MixedFixture = Awaited<ReturnType<typeof freshSourceIntentFixture>> & {
  on: boolean;
  order: Row;
  intent: Row;
  forwarded: Row;
  accountId: string;
  drop: string;
  customerItem: Row;
  localShipment: string;
};
const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });

export async function freshMixedFixture(h: Harness, on = false): Promise<MixedFixture> {
  // The host-native factory enforces DYNA_TEST and the disposable dynaminds_test_* database.
  const raw: Row = structuredClone(demoShopifyOrder),
    first = raw.lineItems.nodes[0];
  raw.id = 'gid://shopify/Order/' + String(Date.now()) + String(Math.floor(Math.random() * 100000));
  raw.lineItems.nodes = [
    {
      ...first,
      quantity: 3,
      currentQuantity: 3,
      unfulfilledQuantity: 3,
      originalTotalSet: money('75.00'),
      discountAllocations: [],
      taxLines: [],
    },
  ];
  raw.shippingLines.nodes = [];
  raw.totalPriceSet = money('75.00');
  raw.currentTotalPriceSet = structuredClone(raw.totalPriceSet);
  raw.totalReceivedSet = money('0.00');
  raw.totalTaxSet = money('0.00');
  raw.displayFinancialStatus = 'PENDING';
  transport.state.raw = raw;
  const f = await freshSourceIntentFixture(h, {
    provider: 'shopify',
    raw,
    settings: { store_url: 'https://own-local-origin-' + randomUUID() + '.myshopify.com' },
    credentials: { access_token: 'own-disposable-test-token' },
    external_product_id: 'gid://shopify/ProductVariant/701',
    remote_line_ids: [first.id],
    quantities: [3],
    async prepareChannel(base) {
      const doc = await base.ok('/warehouse-documents', 'POST', {
        kind: 'receipt',
        warehouse_id: base.buyer.warehouse,
        reference: 'Own mixed original local stock5',
        note: '',
        lines: [{ product_id: base.product.id, quantity: 5, location: 'OWN-LOCAL-ORIGINAL' }],
      });
      await base.ok('/warehouse-documents/' + doc.id + '/post', 'POST', { version: doc.version });
      if (on)
        for (const side of ['buyer', 'supplier'] as const) {
          const actor = base[side];
          const jobs = (
            await pool.query(
              "SELECT * FROM jobs WHERE tenant_id=$1 AND state='pending' ORDER BY id",
              [actor.tenant],
            )
          ).rows;
          for (const job of jobs) {
            assert.equal(job.kind, 'automation');
            assert.deepEqual(job.payload.rules, []);
            const lease = randomUUID();
            const claimed = (
              await pool.query(
                "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 AND state='pending' RETURNING *",
                [job.id, lease],
              )
            ).rows[0];
            assert(claimed);
            await dispatchAutomation(claimed);
            await pool.query(
              "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",
              [job.id, lease],
            );
          }
          const bins = (
            await pool.query(
              'SELECT b.warehouse_id,b.product_id,b.location,b.quantity,s.version::text stock_version FROM stock_locations b JOIN stock s USING(tenant_id,warehouse_id,product_id) WHERE b.tenant_id=$1 AND b.quantity>0 ORDER BY b.product_id,b.location',
              [actor.tenant],
            )
          ).rows;
          const { preview } = await base.ok(
            '/wms-lots/opening-previews',
            'POST',
            {
              client_key: randomUUID(),
              policy_version: '0',
              currency: 'PLN',
              note: 'Own mixed original FIFO cost317',
              lines: bins.map((b) => ({
                ...b,
                lot_code: 'OWN-LOCAL-' + b.location,
                unit_cost_minor: '317',
              })),
            },
            actor.cookie,
          );
          assert.equal(preview.ready, true);
          await base.ok(
            '/wms-lots/opening-previews/' + preview.id + '/activate',
            'POST',
            {
              client_key: randomUUID(),
              scope_hash: preview.scope_hash,
              confirmed: true,
              ack_unknown_costs: false,
            },
            actor.cookie,
          );
        }
    },
  });
  f.previewBody.allocations[0].local_quantity = 1;
  f.previewBody.allocations[0].external_quantity = 2;
  const preview = await f.preview(),
    executed = await f.execute(preview);
  assert.equal(executed.statusCode, 201, executed.body);
  const { order, intent } = executed.json();
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].quantity, 3);
  assert.equal(order.items[0].line_total, 7500);
  assert.equal(order.items[0].price, 2500);
  const accountId = (await pool.query('SELECT account_id FROM b2b_links WHERE id=$1', [f.link.id]))
    .rows[0].account_id;
  const settings = (
    await f.ok(prefix + '/settings/' + accountId, 'GET', undefined, f.supplier.cookie)
  ).settings;
  await f.ok(
    prefix + '/settings/' + accountId,
    'PATCH',
    {
      client_key: randomUUID(),
      version: settings?.version ?? 0,
      enabled: true,
      warehouse_id: f.supplier.warehouse,
      return_address: {
        name: 'Own mixed supplier',
        street: 'Returns 1',
        city: 'Poznań',
        postal_code: '60-001',
        country: 'PL',
      },
      confirmed: true,
    },
    f.supplier.cookie,
  );
  const drop = '/b2b/network/links/' + f.link.id + '/dropshipping';
  const catalogItem = (await f.ok('/b2b/network/links/' + f.link.id + '/catalog')).data.find(
    (i: Row) => i.source_product_id === f.source.id,
  );
  assert(catalogItem);
  const q = (
    await f.ok(drop + '/quotes', 'POST', {
      client_key: randomUUID(),
      customer_order_id: order.id,
      fulfillment_basis: 'external_intent',
      intent_version: intent.version,
      items: [
        {
          customer_item_id: order.items[0].id,
          quantity: 2,
          mappings: [{ product_id: f.product.id, catalog_item_id: catalogItem.id }],
        },
      ],
    })
  ).quote;
  const forwarded = (
    await f.ok(drop + '/quotes/' + q.id + '/checkout', 'POST', {
      client_key: randomUUID(),
      scope_hash: q.scope_hash,
      confirmed: true,
      confirmed_receiver: true,
    })
  ).order;
  for (const [side, oid] of [
    ['supplier', forwarded.supplier_order_id],
    ['buyer', order.id],
  ] as const) {
    const actor = f[side],
      o = await f.ok('/orders/' + oid, 'GET', undefined, actor.cookie);
    const balance = (await f.ok('/orders/' + oid + '/payments', 'GET', undefined, actor.cookie))
      .balance;
    assert.equal(balance.received, 0);
    assert.equal(balance.amount_due, o.total);
    await f.ok(
      '/orders/' + oid + '/payments',
      'POST',
      {
        client_key: randomUUID(),
        version: Number(o.version),
        kind: 'receipt',
        amount: balance.amount_due,
        currency: 'PLN',
        method: 'bank_transfer',
        reference: 'Own mixed explicit synthetic payment',
        confirmed: true,
      },
      actor.cookie,
    );
    assert.equal((await f.ok('/orders/' + oid, 'GET', undefined, actor.cookie)).status, 'paid');
    await f.ok('/orders/' + oid + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined, actor.cookie), '/orders/' + oid + '/status', { status: 'picking' }), actor.cookie);
    const picks = (
      await pool.query(
        'SELECT * FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
        [actor.tenant, oid],
      )
    ).rows;
    assert.equal(picks.length, 1);
    assert.equal(picks[0].quantity, side === 'buyer' ? 1 : 2);
    for (const pick of picks) {
      if (on) {
        const layers = (
          await pool.query(
            "SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 AND state='active' ORDER BY layer_id,location",
            [actor.tenant, oid, pick.product_id],
          )
        ).rows;
        assert(layers.length);
        for (const layer of layers)
          for (let n = layer.scanned; n < layer.quantity; ++n)
            await f.ok(
              '/orders/' + oid + '/scan',
              'POST',
              {
                code: pick.sku,
                location: layer.location,
                layer_id: layer.layer_id,
                client_key: randomUUID(),
              },
              actor.cookie,
            );
      } else
        for (let n = pick.scanned; n < pick.quantity; ++n)
          await f.ok(
            '/orders/' + oid + '/scan',
            'POST',
            { code: pick.sku, client_key: randomUUID() },
            actor.cookie,
          );
    }
    await f.ok('/orders/' + oid + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined, actor.cookie), '/orders/' + oid + '/status', { status: 'packed' }), actor.cookie);
    await f.ok('/orders/' + oid + '/ship-demo', 'POST', {}, actor.cookie);
    assert.equal((await f.ok('/orders/' + oid, 'GET', undefined, actor.cookie)).status, 'shipped');
  }
  const current = (await f.ok(drop + '/orders/' + forwarded.id)).order;
  await f.ok(drop + '/orders/' + forwarded.id + '/reconcile', 'POST', {
    client_key: randomUUID(),
    version: current.version,
    confirmed: true,
  });
  const manifest = (
    await pool.query('SELECT * FROM shopify_dispatch_evidence WHERE tenant_id=$1 AND order_id=$2', [
      f.buyer.tenant,
      order.id,
    ])
  ).rows;
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].items.length, 1);
  assert.equal(manifest[0].items[0].id, order.items[0].id);
  assert.equal(manifest[0].items[0].quantity, 1);
  assert.equal(manifest[0].items[0].original_quantity, 3);
  const mixed = Object.assign(f, {
    on,
    order,
    intent,
    forwarded,
    accountId,
    drop,
    customerItem: order.items[0],
    localShipment: manifest[0].shipment_id,
  });
  assert.deepEqual(await mixedStock(mixed, false), { on_hand: 4, reserved: 0, available: 4 });
  assert.deepEqual(await mixedStock(mixed, true), { on_hand: 18, reserved: 0, available: 18 });
  return mixed;
}
export async function mixedStock(f: MixedFixture, supplier = false) {
  return (
    await pool.query(
      'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [
        f[supplier ? 'supplier' : 'buyer'].tenant,
        f[supplier ? 'supplier' : 'buyer'].warehouse,
        supplier ? f.source.id : f.product.id,
      ],
    )
  ).rows[0];
}
export async function cash(f: MixedFixture) {
  return (
    await pool.query(
      'SELECT to_jsonb(p) row FROM payment_entries p WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [[f.buyer.tenant, f.supplier.tenant]],
    )
  ).rows;
}
export function requestMixedReturn(f: MixedFixture, quantity = 1) {
  return f.ok('/orders/' + f.order.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'Own explicit mixed return source',
    items: [{ item_id: f.customerItem.id, quantity }],
  });
}
export async function localBody(f: MixedFixture, r: Row) {
  const { context } = await f.ok(prefix + '/returns/' + r.id + '/context');
  const source = context.local_sources.find((s: Row) => s.customer_item_id === f.customerItem.id);
  assert(source);
  assert.equal(source.shipment_id, f.localShipment);
  return {
    client_key: randomUUID(),
    version: Number(r.version),
    scope_hash: context.local_scope_hash,
    confirmed: true,
    items: [
      {
        customer_item_id: f.customerItem.id,
        shipment_id: source.shipment_id,
        quantity: r.items[0].requested,
      },
    ],
  };
}
export async function lotsBody(f: MixedFixture, supplier: boolean, quantity = 1) {
  const actor = f[supplier ? 'supplier' : 'buyer'],
    product = supplier ? f.source : f.product;
  const oid = supplier ? f.forwarded.supplier_order_id : f.order.id;
  const issues = (
    await pool.query(
      'SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 ORDER BY id',
      [actor.tenant, oid, product.id],
    )
  ).rows;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].quantity, supplier ? 2 : 1);
  assert.equal(issues[0].unit_cost_minor, '317');
  const stock = (
    await pool.query(
      'SELECT version::text FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [actor.tenant, actor.warehouse, product.id],
    )
  ).rows[0];
  const policy = (
    await pool.query('SELECT version::text FROM wms_policies WHERE tenant_id=$1', [actor.tenant])
  ).rows[0];
  return {
    client_key: randomUUID(),
    policy_version: policy.version,
    stock_versions: [
      { warehouse_id: actor.warehouse, product_id: product.id, version: stock.version },
    ],
    picks: [
      {
        issue_fragment_id: issues[0].id,
        quantity,
        location: supplier ? 'OWN-SUPPLIER-RETURN' : 'OWN-BUYER-RETURN',
      },
    ],
  };
}
export async function localReceive(f: MixedFixture, r: Row, origin: Row, restocked = 1) {
  return {
    version: Number(r.version),
    origin_id: origin.id,
    note: 'Own genuine local physical receipt',
    shipping_refund: 0,
    items: [{ item_id: f.customerItem.id, accepted: 1, restocked }],
    ...(f.on && restocked ? { wms_lots: await lotsBody(f, false) } : {}),
  };
}
