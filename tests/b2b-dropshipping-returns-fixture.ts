import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../server/db';
import { dispatchAutomation } from '../server/automations';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';
import {
  freshSourceIntentFixture,
  makeProviderHarness,
} from './source-order-intents-provider-fixture';

export type Row = Record<string, any>;
export const returnBase = '/b2b/dropshipping-returns';
export const returnTransport = shopifyFulfillmentFixture();
export async function createReturnHarness() {
  const h = await makeProviderHarness({ transport: returnTransport.transport });
  if (process.env.DYNA_TEST_DIAGNOSTICS === 'true')
    h.app.addHook('onError', (_request, _reply, error, done) => {
      // Disposable test DB only: expose the failing constraint, never request credentials/body.
      console.error('Own128 diagnostic', {
        code: error.code,
        message: error.message,
        where: (error as typeof error & { where?: string }).where,
      });
      done();
    });
  return h;
}
export type Harness = Awaited<ReturnType<typeof createReturnHarness>>;
const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });

async function enableLots(
  f: Awaited<ReturnType<typeof freshSourceIntentFixture>>,
  supplier: boolean,
) {
  const actor = supplier ? f.supplier : f.buyer;
  // Finish only genuine empty-rule jobs in these newly created disposable firms.
  const jobs = (
    await pool.query("SELECT * FROM jobs WHERE tenant_id=$1 AND state='pending' ORDER BY id", [
      actor.tenant,
    ])
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
  const { preview } = await f.ok(
    '/wms-lots/opening-previews',
    'POST',
    {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Own128 original FIFO cost317',
      lines: bins.map((b) => ({ ...b, lot_code: 'OWN128-' + b.location, unit_cost_minor: '317' })),
    },
    actor.cookie,
  );
  assert.equal(preview.ready, true, JSON.stringify(preview));
  await f.ok(
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

export async function freshReturnFixture(
  h: Harness,
  on = false,
  cheapLineTotalMinor = 2000,
  splitOriginalLots = false,
) {
  const raw: Row = structuredClone(returnTransport.state.raw),
    first = raw.lineItems.nodes[0];
  raw.lineItems.nodes = [
    {
      ...structuredClone(first),
      quantity: 2,
      currentQuantity: 2,
      unfulfilledQuantity: 2,
      originalTotalSet: money((cheapLineTotalMinor / 100).toFixed(2)),
      discountAllocations: [],
      taxLines: [],
    },
    {
      ...structuredClone(first),
      id: 'gid://shopify/LineItem/980013',
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 1,
      originalTotalSet: money('17.00'),
      discountAllocations: [],
      taxLines: [],
    },
  ];
  raw.shippingLines.nodes[0].taxLines = [];
  raw.totalPriceSet = money(((cheapLineTotalMinor + 2200) / 100).toFixed(2));
  raw.currentTotalPriceSet = structuredClone(raw.totalPriceSet);
  raw.totalReceivedSet = money('10.00');
  raw.totalTaxSet = money('0.00');
  raw.displayFinancialStatus = 'PARTIALLY_PAID';
  returnTransport.state.raw = raw;
  const f = await freshSourceIntentFixture(h, {
    provider: 'shopify',
    raw,
    settings: { store_url: 'https://own128-' + randomUUID() + '.myshopify.com' },
    credentials: { access_token: 'own-disposable-test-token' },
    external_product_id: 'gid://shopify/ProductVariant/701',
    remote_line_ids: raw.lineItems.nodes.map((i: Row) => i.id),
  });
  if (splitOriginalLots) {
    assert(on, 'Original fragment split requires genuine lot opening and dispatch');
    const bins = (
      await f.ok(
        '/stock-locations?warehouse_id=' + f.supplier.warehouse + '&product_id=' + f.source.id,
        'GET',
        undefined,
        f.supplier.cookie,
      )
    ).data;
    const original = bins.find((b: Row) => b.quantity === 20);
    assert(original);
    const moved = await f.ok(
      '/stock-location-moves',
      'POST',
      {
        warehouse_id: f.supplier.warehouse,
        product_id: f.source.id,
        location: original.location,
        destination: 'ZZ-OWN128-SPLIT',
        expected_version: original.version,
        client_key: randomUUID(),
        quantity: 18,
        note: 'Own128 genuine original two-bin opening for fragment capacity',
      },
      f.supplier.cookie,
    );
    assert.deepEqual(
      moved.data.map((b: Row) => b.quantity).sort((a: number, b: number) => a - b),
      [2, 18],
    );
  }
  if (on) {
    await enableLots(f, false);
    await enableLots(f, true);
  }
  const accountId = (await pool.query('SELECT account_id FROM b2b_links WHERE id=$1', [f.link.id]))
    .rows[0].account_id;
  const settings = (
    await f.ok(returnBase + '/settings/' + accountId, 'GET', undefined, f.supplier.cookie)
  ).settings;
  await f.ok(
    returnBase + '/settings/' + accountId,
    'PATCH',
    {
      client_key: randomUUID(),
      version: settings?.version ?? 0,
      enabled: true,
      warehouse_id: f.supplier.warehouse,
      return_address: {
        name: 'Own128 supplier returns',
        street: 'Returns 128',
        city: 'Poznań',
        postal_code: '60-001',
        country: 'PL',
      },
      confirmed: true,
    },
    f.supplier.cookie,
  );
  const sourcePreview = await f.preview(),
    imported = await f.execute(sourcePreview);
  assert.equal(imported.statusCode, 201, imported.body);
  const { order, intent } = imported.json();
  assert.deepEqual(
    order.items.map((i: Row) => i.line_total).sort((a: number, b: number) => a - b),
    [1700, cheapLineTotalMinor],
  );
  assert.equal(new Set(order.items.map((i: Row) => i.id)).size, 2);
  const cheap = order.items.find((i: Row) => i.quantity === 2),
    expensive = order.items.find((i: Row) => i.quantity === 1);
  assert(cheap && expensive);
  const buyerPhysical = await f.snapshot({ physicalOnly: true });
  const dropPath = '/b2b/network/links/' + f.link.id + '/dropshipping';
  const catalogItem = (await f.ok('/b2b/network/links/' + f.link.id + '/catalog')).data.find(
    (i: Row) => i.source_product_id === f.source.id,
  );
  assert(catalogItem);
  const quote = (
    await f.ok(dropPath + '/quotes', 'POST', {
      client_key: randomUUID(),
      customer_order_id: order.id,
      fulfillment_basis: 'external_intent',
      intent_version: intent.version,
      items: order.items.map((i: Row) => ({
        customer_item_id: i.id,
        quantity: i.quantity,
        mappings: [{ product_id: f.product.id, catalog_item_id: catalogItem.id }],
      })),
    })
  ).quote;
  const forwarded = (
    await f.ok(dropPath + '/quotes/' + quote.id + '/checkout', 'POST', {
      client_key: randomUUID(),
      scope_hash: quote.scope_hash,
      confirmed: true,
      confirmed_receiver: true,
    })
  ).order;
  async function pay(id: string, auth: string) {
    const o = await f.ok('/orders/' + id, 'GET', undefined, auth),
      ledger = await f.ok('/orders/' + id + '/payments', 'GET', undefined, auth);
    assert(ledger.balance.amount_due > 0);
    await f.ok(
      '/orders/' + id + '/payments',
      'POST',
      {
        client_key: randomUUID(),
        version: Number(o.version),
        kind: 'receipt',
        amount: ledger.balance.amount_due,
        currency: o.currency,
        method: 'bank_transfer',
        reference: 'Own128 actual declared receipt',
        confirmed: true,
      },
      auth,
    );
  }
  await pay(forwarded.supplier_order_id, f.supplier.cookie);
  await f.ok(
    '/orders/' + forwarded.supplier_order_id + '/status',
    'PATCH',
    await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined, f.supplier.cookie), '/orders/' + forwarded.supplier_order_id + '/status', { status: 'picking' }),
    f.supplier.cookie,
  );
  const picks = (
    await pool.query(
      'SELECT * FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
      [f.supplier.tenant, forwarded.supplier_order_id],
    )
  ).rows;
  assert.equal(
    picks.reduce((sum, p) => sum + p.quantity, 0),
    3,
  );
  for (const p of picks) {
    const layers = (
      await pool.query(
        "SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 AND state='active' ORDER BY layer_id,location",
        [f.supplier.tenant, forwarded.supplier_order_id, p.product_id],
      )
    ).rows;
    if (on) {
      assert(layers.length);
      for (const layer of layers)
        for (let n = layer.scanned; n < layer.quantity; n++)
          await f.ok(
            '/orders/' + forwarded.supplier_order_id + '/scan',
            'POST',
            {
              code: p.sku,
              location: layer.location,
              layer_id: layer.layer_id,
              client_key: randomUUID(),
            },
            f.supplier.cookie,
          );
    } else
      for (let n = p.scanned; n < p.quantity; n++)
        await f.ok(
          '/orders/' + forwarded.supplier_order_id + '/scan',
          'POST',
          { code: p.sku, client_key: randomUUID() },
          f.supplier.cookie,
        );
  }
  await f.ok(
    '/orders/' + forwarded.supplier_order_id + '/status',
    'PATCH',
    await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined, f.supplier.cookie), '/orders/' + forwarded.supplier_order_id + '/status', { status: 'packed' }),
    f.supplier.cookie,
  );
  await f.ok(
    '/orders/' + forwarded.supplier_order_id + '/ship-demo',
    'POST',
    {},
    f.supplier.cookie,
  );
  await pay(order.id, f.buyer.cookie);
  const current = (await f.ok(dropPath + '/orders/' + forwarded.id)).order;
  await f.ok(dropPath + '/orders/' + forwarded.id + '/reconcile', 'POST', {
    client_key: randomUUID(),
    version: current.version,
    confirmed: true,
  });
  assert.equal((await f.ok('/orders/' + order.id)).status, 'shipped');
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), buyerPhysical);
  const stock = async () =>
    (
      await pool.query(
        'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [f.supplier.tenant, f.source.id, f.supplier.warehouse],
      )
    ).rows[0];
  assert.deepEqual(await stock(), { on_hand: 17, reserved: 0, available: 17 });
  return {
    ...f,
    on,
    order,
    intent,
    cheap,
    expensive,
    forwarded,
    dropPath,
    accountId,
    buyerPhysical,
    stock,
  };
}
export type ReturnFixture = Awaited<ReturnType<typeof freshReturnFixture>>;

export async function requestRetail(f: ReturnFixture, item = f.cheap, quantity = 1) {
  return f.ok('/orders/' + f.order.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'Own128 direct supplier return',
    items: [{ item_id: item.id, quantity }],
  });
}
export async function sourcePreview(f: ReturnFixture, retail: Row, item = f.cheap, quantity = 1) {
  const page = await f.ok(returnBase + '/returns/' + retail.id + '/sources?limit=100');
  const source = page.data.find(
    (s: Row) => s.customer_item_id === item.id && s.dropship_order_id === f.forwarded.id,
  );
  assert(source, 'A genuine dispatched commercial source must be available');
  const body = {
    client_key: randomUUID(),
    version: Number(retail.version),
    confirmed: true,
    items: [
      {
        customer_item_id: item.id,
        dropship_order_id: f.forwarded.id,
        quantity,
        physical_sources: source.physical_sources.map((p: Row) => ({
          supplier_item_id: p.supplier_item_id,
          shipment_id: p.shipment_id,
          quantity: quantity * p.quantity_per_unit,
          ...(p.issue_fragment_id ? { issue_fragment_id: p.issue_fragment_id } : {}),
        })),
      },
    ],
  };
  const response = await f.ok(returnBase + '/returns/' + retail.id + '/previews', 'POST', body);
  return { preview: response.preview as Row, body, source };
}
export const submitBody = (preview: Row) => ({
  client_key: randomUUID(),
  version: 1,
  scope_hash: preview.scope_hash,
  confirmed: true,
});
export async function submitReturn(f: ReturnFixture, preview: Row, body = submitBody(preview)) {
  return f.ok(returnBase + '/previews/' + preview.id + '/submit', 'POST', body);
}
export async function supplierCase(f: ReturnFixture, id: string) {
  return (await f.ok(returnBase + '/cases/' + id, 'GET', undefined, f.supplier.cookie)).case as Row;
}
export async function receiveBody(f: ReturnFixture, c: Row, restocked = 1): Promise<Row> {
  const body: Row = {
    client_key: randomUUID(),
    version: c.version,
    supplier_return_version: c.supplier_return_version,
    note: 'Own128 genuine physical supplier receipt',
    items: c.supplier_items.map((i: Row) => ({
      supplier_item_id: i.supplier_item_id,
      accepted: i.requested,
      restocked,
    })),
    confirmed: true,
  };
  if (f.on && restocked) {
    const issued = (
      await pool.query(
        'SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 ORDER BY id',
        [f.supplier.tenant, f.forwarded.supplier_order_id, f.source.id],
      )
    ).rows;
    assert.equal(
      issued.reduce((sum, i) => sum + Number(i.quantity), 0),
      3,
    );
    assert.equal(
      issued.reduce((sum, i) => sum + BigInt(i.value_minor), 0n),
      951n,
    );
    const stock = (
      await pool.query(
        'SELECT version::text FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
        [f.supplier.tenant, f.source.id, f.supplier.warehouse],
      )
    ).rows[0];
    body.wms_lots = {
      client_key: randomUUID(),
      policy_version: '1',
      stock_versions: [
        { warehouse_id: f.supplier.warehouse, product_id: f.source.id, version: stock.version },
      ],
      picks: [{ issue_fragment_id: issued[0].id, quantity: restocked, location: 'OWN128-RETURN' }],
    };
  }
  return body;
}
export async function reconcileBody(
  f: ReturnFixture,
  retail: Row,
  c: Row,
  accepted = 1,
): Promise<Row> {
  const current = await f.ok('/returns/' + retail.id);
  return {
    client_key: randomUUID(),
    version: Number(current.version),
    case_versions: [{ id: c.id, version: c.version }],
    items: [{ customer_item_id: current.items[0].item_id, accepted }],
    note: 'Own128 explicit partner acceptance',
    confirmed: true,
  };
}
export async function waitForLock(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waits = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (waits.some((row: Row) => pattern.test(row.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The actual coordinated-return request did not wait on the held database lock');
}
