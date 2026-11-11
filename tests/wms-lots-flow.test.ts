import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { processShipping } from '../server/shipping';
import { dispatchAutomation } from '../server/automations';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_(?:test_\d+|wmsopen_20261029_\d{2})$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  destination = '',
  cookie = '',
  userId = '',
  ip = 1,
  providerCalls = 0;
const transport = async () => {
  providerCalls++;
  throw Error('Only local simulated shipping is permitted');
};
const req = (path: string, method: any = 'GET', body?: any, lease?: string) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    remoteAddress: '127.0.112.' + ip,
    headers: { cookie, ...(lease ? { 'x-packing-lease': lease } : {}) },
  });
async function ok(path: string, method: any = 'GET', body?: any, lease?: string) {
  const r = await req(path, method, body, lease);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: HTTP ${r.statusCode}`);
  return r.json() as any;
}
async function patchStatus(orderId: string, status: string) {
  // PATCH /orders/:id/status requires expected_version (order CAS); read the own order's current version.
  const path = '/orders/' + orderId + '/status';
  return ok(path, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath), path, { status }));
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.WMS_TEST_LOG === 'true',
  });
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  userId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  destination = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'WMS integrated flow','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    userId,
  ]);
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  await pool.query(
    `INSERT INTO warehouses(id,tenant_id,name,code)
    VALUES($1,$3,'FIFO origin','FLOW-S'),($2,$3,'FIFO destination','FLOW-D')`,
    [warehouse, destination, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

async function product(extra: any = {}) {
  return ok('/products', 'POST', {
    name: 'Integrated FIFO product',
    sku: 'FLOW-' + randomUUID(),
    price: 2500,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 0,
    location: 'A-01',
    ...extra,
  });
}
async function enable() {
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Empty initial FIFO opening',
    lines: [],
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: false,
  });
}
async function stockVersions(ids: string[], wh = warehouse) {
  return Promise.all(
    ids.map(async (product_id) => ({
      warehouse_id: wh,
      product_id,
      version: String(
        (
          await pool.query(
            'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
            [tenant, wh, product_id],
          )
        ).rows[0]?.version ?? '0',
      ),
    })),
  );
}
async function rows(table: string) {
  return (
    await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
      tenant,
    ])
  ).rows;
}
async function physicalSnapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    'stock',
    'stock_locations',
    'wms_layer_positions',
    'wms_reservation_layers',
    'wms_layer_movements',
    'wms_issue_fragments',
    'wms_return_fragments',
    'wms_operations',
  ])
    result[table] = await rows(table);
  return result;
}
async function value(expected: string) {
  const { valuation: v } = await ok('/wms-lots/valuation');
  assert.equal(v.known_minor, expected);
  assert.equal(v.unknown_quantity, '0');
  return v;
}
async function layers(productId: string) {
  return (
    await pool.query(
      'SELECT * FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2 ORDER BY fifo_sequence',
      [tenant, productId],
    )
  ).rows;
}
async function allocations(orderId: string) {
  return (
    await pool.query(
      `SELECT r.*,p.sku FROM wms_reservation_layers r JOIN products p
    ON (p.tenant_id,p.id)=(r.tenant_id,r.product_id) WHERE r.tenant_id=$1 AND r.order_id=$2
    ORDER BY r.product_id,r.layer_id,r.location`,
      [tenant, orderId],
    )
  ).rows;
}
async function receivePurchase(
  supplier: any,
  input: Array<{ product_id: string; quantity: number; unit_cost: number }>,
) {
  const draft = await ok('/purchase-orders', 'POST', {
    supplier_id: supplier.id,
    warehouse_id: warehouse,
    currency: 'PLN',
    lines: input,
  });
  const placed = await ok('/purchase-orders/' + draft.id + '/place', 'POST', {
    version: draft.version,
  });
  const body = {
    client_key: randomUUID(),
    version: placed.version,
    lines: input.map((l) => ({ product_id: l.product_id, quantity: l.quantity, location: 'A-01' })),
    wms_lots: {
      policy_version: '1',
      stock_versions: await stockVersions(input.map((l) => l.product_id)),
      lines: input.map((l) => ({
        product_id: l.product_id,
        quantity: l.quantity,
        location: 'A-01',
        lot_code: 'PO-LOT-' + randomUUID(),
      })),
    },
  };
  const before = await physicalSnapshot(),
    purchaseBefore = await ok('/purchase-orders/' + draft.id);
  const invalid = {
    ...body,
    wms_lots: {
      ...body.wms_lots,
      lines: body.wms_lots.lines.map((l, i) => ({
        ...l,
        unit_cost_minor: String(input[i].unit_cost + 1),
      })),
    },
  };
  assert.equal(
    (await req('/purchase-orders/' + draft.id + '/receive', 'POST', invalid)).statusCode,
    422,
  );
  assert.deepEqual(await physicalSnapshot(), before);
  assert.deepEqual(await ok('/purchase-orders/' + draft.id), purchaseBefore);
  const result = await ok('/purchase-orders/' + draft.id + '/receive', 'POST', body);
  assert.equal(result.order.state, 'received');
  const snapshot = await physicalSnapshot();
  assert.equal(
    (await ok('/purchase-orders/' + draft.id + '/receive', 'POST', body)).replayed,
    true,
  );
  assert.deepEqual(await physicalSnapshot(), snapshot);
  return result;
}
async function sale(p: any, quantity: number) {
  return ok('/orders', 'POST', {
    customer_name: 'FIFO cycle customer',
    email: 'fifo-cycle@example.test',
    phone: '500600700',
    payment_mode: 'cod',
    warehouse_id: warehouse,
    address: {
      street: 'Testowa',
      building_number: '1',
      city: 'Warszawa',
      post_code: '00-001',
      country: 'PL',
    },
    items: [{ product_id: p.id, quantity }],
  });
}
async function ordinaryScans(orderId: string) {
  await patchStatus(orderId, 'picking');
  for (const allocation of await allocations(orderId)) {
    for (let n = 0; n < allocation.quantity; n++) {
      const body = {
        client_key: randomUUID(),
        code: allocation.sku,
        location: allocation.location,
        layer_id: allocation.layer_id,
      };
      await ok('/orders/' + orderId + '/scan', 'POST', body);
      const snapshot = await physicalSnapshot();
      await ok('/orders/' + orderId + '/scan', 'POST', body);
      assert.deepEqual(
        await physicalSnapshot(),
        snapshot,
        'Exact scan replay cannot reserve or scan twice',
      );
    }
  }
}
async function runShipping(jobId: string) {
  const job = await tenantTx(
    tenant,
    async (c) =>
      (
        await c.query(
          `UPDATE jobs SET state='running',
    lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *`,
          [jobId, randomUUID()],
        )
      ).rows[0],
  );
  assert(job);
  await processShipping(job, { transport });
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [jobId])).rows[0].state,
    'done',
  );
}
async function finishOwnEmptyEventJobs() {
  const pending = (
    await pool.query(
      `SELECT * FROM jobs WHERE tenant_id=$1
    AND state IN ('pending','running') ORDER BY created_at,id`,
      [tenant],
    )
  ).rows;
  assert(pending.length <= 25, 'The small legacy flow has a bounded set of event dispatch jobs');
  for (const original of pending) {
    assert.equal(original.kind, 'automation');
    assert.equal(original.state, 'pending');
    assert.deepEqual(
      original.payload.rules,
      [],
      'No automation effects are authorized in this fixture',
    );
    const claimed = await tenantTx(
      tenant,
      async (c) =>
        (
          await c.query(
            `UPDATE jobs
      SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2
      WHERE id=$1 AND state='pending' RETURNING *`,
            [original.id, randomUUID()],
          )
        ).rows[0],
    );
    assert(claimed);
    await dispatchAutomation(claimed);
    assert.equal(
      (await pool.query('SELECT state FROM jobs WHERE id=$1', [original.id])).rows[0].state,
      'done',
    );
  }
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM automation_runs WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    0,
  );
}
async function simulatedLabel(order: any) {
  const channel = await ok('/shipping/example', 'POST');
  const plan = await ok('/orders/' + order.id + '/shipping/preview', 'POST', {
    channel_id: channel.id,
    service: 'inpost_courier_standard',
    receiver: {
      first_name: 'FIFO',
      last_name: 'Customer',
      email: 'fifo-cycle@example.test',
      phone: '500600700',
      address: {
        street: 'Testowa',
        building_number: '1',
        city: 'Warszawa',
        post_code: '00-001',
        country_code: 'PL',
      },
    },
    dimensions: { length: 380, width: 200, height: 100 },
    weight: 1.37,
    cod: order.total,
    insurance: order.total,
  });
  await runShipping((await ok('/shipping-plans/' + plan.id + '/queue', 'POST', {})).job_id);
  const quoted = (
    await pool.query('SELECT * FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [tenant, plan.id])
  ).rows[0];
  assert.equal(quoted.state, 'quoted');
  assert(quoted.offers.length);
  const buy = await ok('/shipping-plans/' + plan.id + '/buy', 'POST', {
    offer_id: quoted.offers[0].id,
    confirm_cost: true,
    ack_unknown_rate: true,
  });
  await runShipping(buy.job_id);
  assert.equal(
    (
      await pool.query('SELECT state FROM shipping_plans WHERE tenant_id=$1 AND id=$2', [
        tenant,
        plan.id,
      ])
    ).rows[0].state,
    'ready',
  );
  assert.equal(providerCalls, 0);
  return plan;
}
async function movement(input: any) {
  const { preview } = await ok('/wms-lots/movement-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    note: 'Exact original cost movement',
    ...input,
  });
  assert.equal(preview.ready, true);
  const body = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
  const result = await ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', body);
  const snapshot = await physicalSnapshot();
  assert.equal(
    (await ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', body)).reused,
    true,
  );
  assert.deepEqual(await physicalSnapshot(), snapshot);
  return result;
}

test('actual PO receipts, kit FIFO dispatch, partial kit return, MM and bin move retain exact original integer costs', async () => {
  const a = await product(),
    b = await product(),
    kit = await product({
      kind: 'bundle',
      components: [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 3 },
      ],
    });
  const supplier = await ok('/suppliers', 'POST', {
    name: 'FIFO source supplier',
    code: 'SUP-' + randomUUID(),
  });
  await enable();
  await receivePurchase(supplier, [
    { product_id: a.id, quantity: 4, unit_cost: 101 },
    { product_id: b.id, quantity: 6, unit_cost: 203 },
  ]);
  await receivePurchase(supplier, [{ product_id: a.id, quantity: 4, unit_cost: 107 }]);
  await value('2050');
  const aLayers = await layers(a.id),
    bLayers = await layers(b.id);
  assert.equal(aLayers[0].unit_cost_minor, '101');
  assert.equal(aLayers[1].unit_cost_minor, '107');
  assert.equal(bLayers[0].unit_cost_minor, '203');
  assert(aLayers.every((l) => l.purchase_receipt_id && l.warehouse_document_id));
  const order = await sale(kit, 2),
    reserved = await allocations(order.id);
  assert.equal(reserved.length, 2);
  assert.equal(reserved.find((r) => r.product_id === a.id).layer_id, aLayers[0].id);
  assert.equal(reserved.find((r) => r.product_id === a.id).quantity, 4);
  assert.equal(reserved.find((r) => r.product_id === b.id).quantity, 6);
  await value('2050');
  assert.equal((await rows('wms_issue_fragments')).length, 0);
  await ordinaryScans(order.id);
  await patchStatus(order.id, 'packed');
  const packed = await ok('/orders/' + order.id),
    beforeLabel = await physicalSnapshot();
  const plan = await simulatedLabel(packed);
  assert.deepEqual(
    await physicalSnapshot(),
    beforeLabel,
    'Creating a paid shipping label is not inventory dispatch',
  );
  const results = await Promise.all([
    req('/shipping-plans/' + plan.id + '/dispatch', 'POST', {}),
    req('/shipping-plans/' + plan.id + '/dispatch', 'POST', {}),
  ]);
  assert(results.every((r) => r.statusCode === 200));
  await value('428');
  const issued = (
    await pool.query(
      'SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
      [tenant, order.id],
    )
  ).rows;
  assert.equal(issued.length, 2);
  assert.equal(
    issued.reduce((sum, i) => sum + BigInt(i.value_minor), 0n),
    1622n,
  );
  assert.equal(issued.find((i) => i.product_id === a.id).layer_id, aLayers[0].id);
  const dispatched = await ok('/orders/' + order.id);
  assert.equal(dispatched.status, 'shipped');
  const historicalItems = await rows('order_items');
  const currentKit = await ok('/products/' + kit.id);
  await ok('/products/' + kit.id, 'PATCH', {
    ...currentKit,
    components: [
      { product_id: a.id, quantity: 1 },
      { product_id: b.id, quantity: 1 },
    ],
  });
  assert.deepEqual(
    await rows('order_items'),
    historicalItems,
    'Editing the current recipe cannot change the sold kit or its original physical return quantities',
  );
  const requested = await ok('/orders/' + order.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'One physical kit returned',
    items: [{ item_id: dispatched.items[0].id, quantity: 1 }],
  });
  const receive = {
    version: Number(requested.version),
    shipping_refund: 0,
    note: 'Restock original kit fragments',
    items: [{ item_id: requested.items[0].item_id, accepted: 1, restocked: 1 }],
    wms_lots: {
      client_key: randomUUID(),
      policy_version: '1',
      stock_versions: await stockVersions([a.id, b.id]),
      picks: issued.map((i) => ({
        issue_fragment_id: i.id,
        quantity: i.product_id === a.id ? 2 : 3,
        location: 'ZWROT',
      })),
    },
  };
  const beforeReturn = await physicalSnapshot(),
    caseBefore = await ok('/returns/' + requested.id);
  const extraFragment = {
    ...receive,
    wms_lots: {
      ...receive.wms_lots,
      picks: receive.wms_lots.picks.map((p, i) => ({
        ...p,
        quantity: p.quantity + (i === 0 ? 1 : 0),
      })),
    },
  };
  const invalidReturn = await req('/returns/' + requested.id + '/receive', 'POST', extraFragment);
  assert.equal(invalidReturn.statusCode, 422);
  assert.deepEqual(await physicalSnapshot(), beforeReturn);
  assert.deepEqual(await ok('/returns/' + requested.id), caseBefore);
  await ok('/returns/' + requested.id + '/receive', 'POST', receive);
  await value('1239');
  const returned = (
    await pool.query('SELECT * FROM wms_return_fragments WHERE tenant_id=$1 AND return_id=$2', [
      tenant,
      requested.id,
    ])
  ).rows;
  assert.equal(returned.length, 2);
  assert.equal(
    returned.reduce((sum, r) => sum + BigInt(r.value_minor), 0n),
    811n,
  );
  assert(
    returned.every((r) =>
      issued.some((i) => i.id === r.issue_fragment_id && i.layer_id === r.layer_id),
    ),
  );
  const afterReturn = await physicalSnapshot(),
    payment = await rows('payment_entries');
  await ok('/returns/' + requested.id + '/receive', 'POST', receive);
  assert.deepEqual(await physicalSnapshot(), afterReturn);
  assert.deepEqual(await rows('payment_entries'), payment);
  await movement({
    kind: 'transfer',
    product_id: a.id,
    warehouse_id: warehouse,
    location: 'ZWROT',
    quantity: 1,
    destination_warehouse_id: destination,
    destination_location: 'MM-01',
    layer_ids: [aLayers[0].id],
    stock_versions: [
      ...(await stockVersions([a.id])),
      ...(await stockVersions([a.id], destination)),
    ],
  });
  await value('1239');
  await movement({
    kind: 'bin_move',
    product_id: a.id,
    warehouse_id: destination,
    location: 'MM-01',
    quantity: 1,
    destination_location: 'MM-02',
    layer_ids: [aLayers[0].id],
    stock_versions: await stockVersions([a.id], destination),
  });
  await value('1239');
  const original = (await layers(a.id)).find((l) => l.id === aLayers[0].id);
  assert.equal(original.fifo_sequence, aLayers[0].fifo_sequence);
  assert.equal(original.unit_cost_minor, '101');
  const atDestination = (
    await pool.query(
      `SELECT * FROM wms_layer_positions WHERE tenant_id=$1
    AND warehouse_id=$2 AND product_id=$3 AND location='MM-02' AND layer_id=$4`,
      [tenant, destination, a.id, original.id],
    )
  ).rows[0];
  assert.equal(atDestination.quantity, 1);
  assert.equal(atDestination.reserved, 0);
  const neutral = (
    await pool.query(
      `SELECT operation_id,sum(delta)::text quantity,sum(value_delta)::text value
    FROM wms_layer_movements WHERE tenant_id=$1 AND kind IN ('transfer','bin_move') GROUP BY operation_id`,
      [tenant],
    )
  ).rows;
  assert.equal(neutral.length, 2);
  assert(neutral.every((r) => r.quantity === '0' && r.value === '0'));
  const issuesBeforeManual = await rows('wms_issue_fragments');
  const manual = await movement({
    kind: 'issue',
    product_id: a.id,
    warehouse_id: destination,
    location: 'MM-02',
    quantity: 1,
    layer_ids: [aLayers[0].id],
    stock_versions: await stockVersions([a.id], destination),
  });
  await value('1138');
  const manualFragment = (
    await pool.query(
      `SELECT * FROM wms_issue_fragments WHERE tenant_id=$1
    AND operation_id=$2`,
      [tenant, manual.operation.id],
    )
  ).rows;
  assert.equal(manualFragment.length, 1);
  assert.equal(manualFragment[0].layer_id, aLayers[0].id);
  assert.equal(manualFragment[0].value_minor, '101');
  assert(manualFragment[0].warehouse_document_id);
  assert.equal((await rows('wms_issue_fragments')).length, issuesBeforeManual.length + 1);
  assert.equal(providerCalls, 0);
});

async function twoLayers(p: any) {
  await ok('/wms-lots/receipts', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    warehouse_id: warehouse,
    stock_versions: await stockVersions([p.id]),
    note: 'Two lots in one bin',
    confirmed: true,
    lines: [101, 203].map((cost) => ({
      product_id: p.id,
      location: 'A-01',
      quantity: 1,
      lot_code: 'SCAN-' + randomUUID(),
      unit_cost_minor: String(cost),
      currency: 'PLN',
    })),
  });
}
test('ordinary, wave and packing scans require an explicit layer for an ambiguous bin and replay exactly once', async () => {
  const products = [await product(), await product(), await product()];
  await enable();
  for (const p of products) await twoLayers(p);
  const station = (
    await ok('/packing/stations', 'POST', {
      client_key: randomUUID(),
      code: 'FIFO-STATION',
      label: 'Physical lot packing',
      enabled: true,
    })
  ).station;
  for (let mode = 0; mode < 3; mode++) {
    const p = products[mode];
    let order = await sale(p, 2);
    let wave: any,
      session: any,
      token = randomUUID();
    if (mode === 0) await patchStatus(order.id, 'picking');
    if (mode === 1) {
      const preview = await ok('/picking-waves/preview', 'POST', {
        warehouse_id: warehouse,
        order_ids: [order.id],
      });
      wave = (
        await ok('/picking-waves', 'POST', {
          client_key: randomUUID(),
          warehouse_id: warehouse,
          order_ids: [order.id],
          name: 'FIFO physical wave',
          preview_hash: preview.preview_hash,
        })
      ).wave;
    }
    if (mode === 2) {
      await patchStatus(order.id, 'picking');
      order = await ok('/orders/' + order.id);
      session = (
        await ok('/packing/sessions', 'POST', {
          client_key: randomUUID(),
          order_id: order.id,
          order_version: String(order.version),
          station_id: station.id,
          station_version: String(station.version),
          lease_token: token,
        })
      ).session;
    }
    const path =
      mode === 0
        ? '/orders/' + order.id + '/scan'
        : mode === 1
          ? '/picking-waves/' + wave.id + '/scans'
          : '/packing/sessions/' + session.id + '/scans';
    const body = (layer_id?: string) => ({
      client_key: randomUUID(),
      code: p.sku,
      location: 'A-01',
      ...(layer_id ? { layer_id } : {}),
      ...(mode === 1 ? { version: String(wave.version) } : {}),
      ...(mode === 2
        ? { session_version: String(session.version), order_version: String(order.version) }
        : {}),
    });
    const before = await physicalSnapshot();
    assert.equal((await req(path, 'POST', body(), mode === 2 ? token : undefined)).statusCode, 422);
    assert.deepEqual(await physicalSnapshot(), before);
    for (const allocation of await allocations(order.id)) {
      const scan = body(allocation.layer_id);
      await ok(path, 'POST', scan, mode === 2 ? token : undefined);
      const afterScan = await physicalSnapshot();
      await ok(path, 'POST', scan, mode === 2 ? token : undefined);
      assert.deepEqual(await physicalSnapshot(), afterScan);
      if (mode === 1) wave = (await ok('/picking-waves/' + wave.id)).wave;
      if (mode === 2) session = (await ok('/packing/sessions/' + session.id)).session;
    }
    if (mode === 1)
      await ok('/picking-waves/' + wave.id + '/complete', 'POST', {
        version: String(wave.version),
      });
    if (mode === 2) {
      const current = await ok('/orders/' + order.id);
      const { preview } = await ok(
        '/packing/previews',
        'POST',
        {
          client_key: randomUUID(),
          kind: 'finish',
          session_id: session.id,
          session_version: String(session.version),
          order_version: String(current.version),
          station_version: String(station.version),
          packaging: {
            kind: 'custom',
            label: 'Lot scanned parcel',
            reason: 'Measured physical box',
          },
          measurements: { weight_grams: 1370, length_mm: 380, width_mm: 200, height_mm: 100 },
          include_product_estimate: false,
        },
        token,
      );
      await ok(
        '/packing/previews/' + preview.id + '/finish',
        'POST',
        {
          client_key: randomUUID(),
          scope_hash: preview.scope_hash,
          confirmed: true,
          confirm_measured: true,
        },
        token,
      );
      assert.equal((await ok('/orders/' + order.id)).status, 'packed');
    }
    assert((await allocations(order.id)).every((r) => r.scanned === r.quantity));
    assert.equal(
      (await rows('wms_issue_fragments')).length,
      0,
      'Physical picking and packing are not cost dispatch',
    );
  }
  await value('912');
  assert.equal(providerCalls, 0);
});

test('cancelling a picked but unissued order releases exact FIFO reservations without a cost movement or stock decrement', async () => {
  const p = await product();
  await enable();
  await twoLayers(p);
  const order = await sale(p, 2),
    before = (
      await pool.query(
        `SELECT layer_id,quantity FROM wms_layer_positions
    WHERE tenant_id=$1 ORDER BY layer_id`,
        [tenant],
      )
    ).rows;
  await ordinaryScans(order.id);
  const journals = await rows('wms_layer_movements');
  await patchStatus(order.id, 'cancelled');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT layer_id,quantity FROM wms_layer_positions WHERE tenant_id=$1 ORDER BY layer_id',
        [tenant],
      )
    ).rows,
    before,
  );
  assert((await allocations(order.id)).every((r) => r.state === 'released'));
  assert.equal(
    (
      await pool.query('SELECT sum(reserved)::text n FROM wms_layer_positions WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    '0',
  );
  assert.equal((await rows('wms_issue_fragments')).length, 0);
  assert.deepEqual(await rows('wms_layer_movements'), journals);
  await value('304');
  assert.equal(providerCalls, 0);
});

test('exact posted legacy PZ, PO receipt and return replays survive later FIFO activation without adding layers or effects', async () => {
  const p = await product();
  const supplier = await ok('/suppliers', 'POST', {
    name: 'Legacy receiving supplier',
    code: 'PRE-' + randomUUID(),
  });
  const purchase = await ok('/purchase-orders', 'POST', {
    supplier_id: supplier.id,
    warehouse_id: warehouse,
    currency: 'PLN',
    lines: [{ product_id: p.id, quantity: 3, unit_cost: 101 }],
  });
  const placed = await ok('/purchase-orders/' + purchase.id + '/place', 'POST', {
    version: purchase.version,
  });
  const purchaseBody = {
    client_key: randomUUID(),
    version: placed.version,
    lines: [{ product_id: p.id, quantity: 3, location: 'A-01' }],
  };
  const received = await ok('/purchase-orders/' + purchase.id + '/receive', 'POST', purchaseBody);
  const document = await ok('/warehouse-documents', 'POST', {
    kind: 'receipt',
    warehouse_id: warehouse,
    reference: 'Committed pre-FIFO PZ',
    lines: [{ product_id: p.id, quantity: 2, location: 'A-01' }],
  });
  const posting = { version: document.version };
  assert.equal(
    (await ok('/warehouse-documents/' + document.id + '/post', 'POST', posting)).status,
    'posted',
  );
  const order = await sale(p, 1);
  await patchStatus(order.id, 'picking');
  await ok('/orders/' + order.id + '/scan', 'POST', { code: p.sku, location: 'A-01' });
  await patchStatus(order.id, 'packed');
  const plan = await simulatedLabel(await ok('/orders/' + order.id));
  await ok('/shipping-plans/' + plan.id + '/dispatch', 'POST', {});
  const shipped = await ok('/orders/' + order.id);
  const requested = await ok('/orders/' + order.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'Committed pre-FIFO return',
    items: [{ item_id: shipped.items[0].id, quantity: 1 }],
  });
  const returnBody = {
    version: Number(requested.version),
    shipping_refund: 0,
    note: 'Original untyped restock consent',
    items: [{ item_id: requested.items[0].item_id, accepted: 1, restocked: 1 }],
  };
  await ok('/returns/' + requested.id + '/receive', 'POST', returnBody);
  assert.equal((await rows('wms_operations')).length, 0);
  // events.ts durably queues even an empty rule set. Actual dispatch must finish
  // those jobs before the conservative opening guard accepts the workspace.
  await finishOwnEmptyEventJobs();
  const bins = (
    await pool.query(
      `SELECT b.warehouse_id,b.product_id,b.location,b.quantity,s.version stock_version
    FROM stock_locations b JOIN stock s USING(tenant_id,warehouse_id,product_id)
    WHERE b.tenant_id=$1 AND b.quantity>0 ORDER BY b.warehouse_id,b.product_id,b.location`,
      [tenant],
    )
  ).rows;
  assert.equal(
    bins.reduce((sum, bin) => sum + bin.quantity, 0),
    5,
  );
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Whole historical opening after completed receipts and return',
    lines: bins.map((bin) => ({
      ...bin,
      lot_code: 'LEGACY-' + bin.location,
      unit_cost_minor: null,
    })),
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: true,
  });
  const immutableTables = [
    'products',
    'product_sku_aliases',
    'product_logistics',
    'stock',
    'stock_locations',
    'stock_movements',
    'stock_location_movements',
    'stock_location_operations',
    'orders',
    'order_items',
    'order_pick_items',
    'reservations',
    'reservation_locations',
    'warehouse_documents',
    'warehouse_document_lines',
    'purchase_orders',
    'purchase_order_lines',
    'purchase_receipts',
    'purchase_receipt_lines',
    'return_cases',
    'return_items',
    'payment_entries',
    'order_local_financial_fences',
    'order_events',
    'audit_events',
    'jobs',
    'outbound_events',
    'outbound_deliveries',
    'email_messages',
    'sms_messages',
    'wms_policies',
    'wms_operations',
    'wms_previews',
    'wms_lots',
    'wms_cost_layers',
    'wms_layer_positions',
    'wms_reservation_layers',
    'wms_layer_movements',
    'wms_issue_fragments',
    'wms_return_fragments',
  ];
  const before: Record<string, unknown> = {};
  for (const table of immutableTables) before[table] = await rows(table);
  assert.equal(
    (await ok('/warehouse-documents/' + document.id + '/post', 'POST', posting)).status,
    'posted',
  );
  const replayPurchase = await ok(
    '/purchase-orders/' + purchase.id + '/receive',
    'POST',
    purchaseBody,
  );
  assert.equal(replayPurchase.replayed, true);
  assert.equal(replayPurchase.receipt_id, received.receipt_id);
  await ok('/returns/' + requested.id + '/receive', 'POST', returnBody);
  // Guards still protect genuinely new quantity changes; old receipt consent is
  // neither rewritten with wms_lots nor converted into a new cost receipt.
  assert.equal(
    (
      await req('/purchase-orders/' + purchase.id + '/receive', 'POST', {
        ...purchaseBody,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req('/returns/' + requested.id + '/receive', 'POST', {
        ...returnBody,
        note: 'Changed historical consent',
      })
    ).statusCode,
    409,
  );
  for (const table of immutableTables) assert.deepEqual(await rows(table), before[table], table);
  const { valuation } = await ok('/wms-lots/valuation');
  assert.equal(valuation.unknown_quantity, '5');
  assert.equal(valuation.known_minor, '0');
  assert.equal(providerCalls, 0);
});
