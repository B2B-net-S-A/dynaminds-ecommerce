/** QA111 local native acceptance. Root invokes; no credentials enter public evidence. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { verifyWmsLotsPreservation as preservation } from './wms-lots-preservation-gate';

const statePath = 'data/wms-lots-stage111.json';
const phase = process.argv[2];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, statuses = [200]) {
  const requestBody =
    body === undefined && !['GET', 'HEAD'].includes(method.toUpperCase()) ? {} : body;
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  assert(statuses.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
  const next = response.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  return response.json() as Promise<any>;
}
const save = (state: any) => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
const writeReport = (name: string, report: unknown) =>
  writeFile('docs/' + name, JSON.stringify(report, null, 2) + '\n');
const identifier = (name: string) => {
  assert(/^[a-z][a-z0-9_]*$/.test(name));
  return '"' + name + '"';
};
// Exact retries must preserve business state and immutable evidence. Worker leases,
// queue progress and login sessions are intentionally outside this comparison.
const retryProtectedTables = [
  'products',
  'product_sku_aliases',
  'product_logistics',
  'bundle_components',
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
  'outbound_events',
  'wms_policies',
  'wms_previews',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
];

async function snapshot(state: any, chosen?: string[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const names: string[] =
      chosen ??
      (
        await c.query(`SELECT DISTINCT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns col USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND col.column_name='tenant_id'
      UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
      ).rows.map((r) => r.table_name);
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM ${identifier(name)} t WHERE
        ${name === 'tenants' || name === 'users' ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [name === 'users' ? state.user : state.tenant],
        )
      ).rows;
      result[name] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT');
    return { names, result };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function ownRows(state: any, table: string, extra = '', params: unknown[] = []) {
  return (
    await pool.query(`SELECT * FROM ${identifier(table)} WHERE tenant_id=$1 ${extra}`, [
      state.tenant,
      ...params,
    ])
  ).rows;
}
async function stockVersions(state: any, ids: string[], warehouse = state.warehouse) {
  const rows = await ownRows(state, 'stock', 'AND warehouse_id=$2 AND product_id=ANY($3::uuid[])', [
    warehouse,
    ids,
  ]);
  return ids.map((product_id) => ({
    warehouse_id: warehouse,
    product_id,
    version: String(rows.find((r) => r.product_id === product_id)?.version ?? '0'),
  }));
}
async function value(expected: string) {
  const result = (await api('/wms-lots/valuation')).valuation;
  assert.equal(result.currency, 'PLN');
  assert.equal(result.known_minor, expected);
  assert.equal(result.unknown_quantity, '0');
  return result;
}
async function waitFor(
  path: string,
  predicate: (result: any) => boolean,
  failure: (result: any) => boolean,
) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const result = await api(path);
    assert(!failure(result), `Local worker failed at ${path}`);
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`Local worker did not finish ${path}; resume through explicit readback`);
}
async function movement(state: any, name: string, request: Record<string, unknown>) {
  const body = { client_key: randomUUID(), policy_version: '1', note: 'QA111 ' + name, ...request };
  state[name + '_request'] = body;
  await save(state);
  const before = await snapshot(state, [
    'stock',
    'stock_locations',
    'wms_layer_positions',
    'wms_layer_movements',
    'wms_operations',
  ]);
  const { preview } = await api('/wms-lots/movement-previews', 'POST', body, [201]);
  assert(preview.ready);
  state[name + '_preview_id'] = preview.id;
  await save(state);
  assert.deepEqual(
    (await snapshot(state, before.names)).result,
    before.result,
    'Movement preview changed physical data',
  );
  const execute = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
  state[name + '_execute'] = execute;
  await save(state);
  const result = await api(
    '/wms-lots/movement-previews/' + preview.id + '/execute',
    'POST',
    execute,
    [201],
  );
  const after = await snapshot(state, before.names);
  const replay = await api(
    '/wms-lots/movement-previews/' + preview.id + '/execute',
    'POST',
    execute,
  );
  assert(replay.reused);
  assert.deepEqual(replay.operation, result.operation);
  assert.deepEqual((await snapshot(state, before.names)).result, after.result);
  state[name + '_operation_id'] = result.operation.id;
  await save(state);
  return result;
}

try {
  const health = await api('/health');
  const existing = phase === 'setup' ? null : JSON.parse(await readFile(statePath, 'utf8'));
  const expected = process.env.QA_EXPECTED_REVISION ?? existing?.runtime_revision ?? '6842519';
  assert.equal(
    health.revision,
    expected,
    'Actual runtime must equal the explicitly accepted revision',
  );
  assert.equal(health.schema_revision, '091_wms_lot_packing');
  assert.equal(health.restore_preview, false);
  assert(health.wms_lots_available);
  const preserved = await preservation(existing?.preservation.originalsha256);
  if (phase === 'setup') {
    const state: any = {
      stage: 111,
      created_at: new Date().toISOString(),
      runtime_revision: health.revision,
      schema: health.schema_revision,
      email: 'qa-wms111-' + randomUUID().slice(0, 10) + '@demo.local',
      password: 'DynaWms111!-' + randomUUID(),
      preservation: preserved,
      own_snapshot_timezone: 'UTC',
      ui_verified: false,
      restart_verified: false,
      api_acceptance: null,
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    const signup = await api(
      '/auth/signup',
      'POST',
      {
        email: state.email,
        password: state.password,
        name: 'QA111 magazyn partii',
        organization: { name: 'QA111 — lokalny odbiór FIFO' },
      },
      [201],
    );
    state.tenant = signup.user.tenant_id;
    state.user = signup.user.id;
    state.cookie = cookie;
    await save(state);
    await api('/workspaces/plan', 'PATCH', { plan: 'business' });
    state.warehouse = (await api('/warehouses')).data[0].id;
    state.second_warehouse = (
      await api(
        '/warehouses',
        'POST',
        { name: 'QA111 magazyn docelowy', code: 'QA111-D' },
        [200, 201],
      )
    ).id;
    state.products = [];
    for (const [sku, name] of [
      ['QA111-A', 'QA111 składnik A'],
      ['QA111-B', 'QA111 składnik B'],
    ]) {
      state.products.push(
        await api(
          '/products',
          'POST',
          {
            sku,
            name,
            price: 2500,
            vat: 23,
            warehouse_id: state.warehouse,
            quantity: 0,
            location: 'A-01',
          },
          [201],
        ),
      );
      await save(state);
    }
    state.bundle = await api(
      '/products',
      'POST',
      {
        sku: 'QA111-KIT',
        name: 'QA111 zestaw 2A+3B',
        kind: 'bundle',
        price: 12000,
        vat: 23,
        components: [
          { product_id: state.products[0].id, quantity: 2 },
          { product_id: state.products[1].id, quantity: 3 },
        ],
        warehouse_id: state.warehouse,
        quantity: 0,
        location: 'A-01',
      },
      [201],
    );
    await save(state);
    state.supplier = await api(
      '/suppliers',
      'POST',
      { name: 'QA111 lokalny dostawca', code: 'QA111-S' },
      [200, 201],
    );
    const po = await api(
      '/purchase-orders',
      'POST',
      {
        supplier_id: state.supplier.id,
        warehouse_id: state.warehouse,
        currency: 'PLN',
        reference: 'QA111-PO',
        lines: [
          { product_id: state.products[0].id, quantity: 6, unit_cost: 101 },
          { product_id: state.products[1].id, quantity: 9, unit_cost: 203 },
        ],
      },
      [200, 201],
    );
    state.placed_purchase = await api('/purchase-orders/' + po.id + '/place', 'POST', {
      version: po.version,
    });
    assert.equal((await api('/wms-lots')).policy.enabled, false);
    state.cookie = cookie;
    state.setup_complete = true;
    await save(state);
    await writeReport('wms-lots-native-setup-qa.json', {
      stage: 111,
      status: 'SETUP_PASS; UI_ACTIVATION_PENDING',
      runtime_revision: health.revision,
      schema: health.schema_revision,
      tenant: state.tenant,
      physical_products: state.products.length,
      kit_components: [2, 3],
      policy_enabled: false,
      placed_purchase: po.id,
      expected_received_value_minor: '2433',
      preservation: preserved,
      provider_verified: false,
      goal_complete: false,
    });
    console.log({
      phase,
      status: 'SETUP_PASS; UI_ACTIVATION_PENDING',
      tenant: state.tenant,
      purchase: po.id,
    });
  } else if (['api', 'api-resume-after-packed', 'api-resume-after-channel'].includes(phase ?? '')) {
    const state = existing;
    cookie = state.cookie;
    const resumeAfterChannel = phase === 'api-resume-after-channel';
    const resumeAfterPacked = phase === 'api-resume-after-packed' || resumeAfterChannel;
    if (resumeAfterPacked) {
      assert(state.setup_complete && state.api_started && !state.api_acceptance);
      if (resumeAfterChannel) {
        assert(state.api_resume_after_packed_started);
        assert(!state.api_resume_after_channel_started, 'A partial continuation requires new readback');
        const channels = (await api('/shipping/channels')).data;
        assert.equal(channels.length, 1);
        const channel = channels[0];
        assert.equal(channel.provider, 'inpost');
        assert.equal(channel.mode, 'sandbox');
        assert.equal(channel.status, 'local_simulation');
        assert.equal(channel.settings.simulation, true);
        state.verified_existing_shipping_channel_id = channel.id;
      } else assert(!state.api_resume_after_packed_started, 'A partial continuation requires new readback');
      assert.equal(state.products.length, 2);
      assert(state.order?.id && state.purchase_receipt_id && state.manual_receipt_operation_id);
      assert(state.manual_receipt_document_id && state.manual_receipt_request);
      assert(!state.shipping_plan_id && !state.return);
    } else {
      assert(
        state.setup_complete && !state.api_started,
        'API phase must not replay unknown partially completed writes',
      );
    }
    const meta = await api('/wms-lots');
    assert(meta.policy.enabled);
    assert.equal(meta.policy.version, '1');
    state.ui_activation_operation_id = (
      await ownRows(state, 'wms_policies')
    )[0].opening_operation_id;
    const [a, b] = state.products;
    if (resumeAfterPacked) {
      const currentOrder = await api('/orders/' + state.order.id);
      assert.equal(currentOrder.id, state.order.id);
      assert.equal(currentOrder.status, 'packed');
      assert.equal(currentOrder.warehouse_id, state.warehouse);
      const stocks = await ownRows(state, 'stock', 'AND warehouse_id=$2 AND product_id=ANY($3::uuid[])', [
        state.warehouse, [a.id, b.id],
      ]);
      assert.equal(stocks.length, 2);
      for (const [product, onHand, reserved] of [[a, 8, 4], [b, 9, 6]] as const) {
        const stock = stocks.find((r) => r.product_id === product.id);
        assert(stock);
        assert.equal(stock.on_hand, onHand);
        assert.equal(stock.reserved, reserved);
      }
      const picked = await ownRows(state, 'order_pick_items', 'AND order_id=$2', [state.order.id]);
      const allocations = await ownRows(state, 'wms_reservation_layers', 'AND order_id=$2', [state.order.id]);
      assert.equal(picked.length, 2);
      assert.equal(allocations.length, 2);
      for (const [product, quantity] of [[a, 4], [b, 6]] as const) {
        const pick = picked.find((r) => r.product_id === product.id);
        const allocation = allocations.find((r) => r.product_id === product.id);
        assert(pick && allocation);
        assert.equal(pick.quantity, quantity);
        assert.equal(pick.scanned, quantity);
        assert.equal(allocation.quantity, quantity);
        assert.equal(allocation.scanned, quantity);
        assert.equal(allocation.state, 'active');
        assert.equal(allocation.location, 'A-01');
      }
      for (const table of ['wms_issue_fragments', 'return_cases', 'shipping_plans']) {
        assert.equal((await ownRows(state, table)).length, 0, 'Unexpected effects before continuation: ' + table);
      }
      const scans = await ownRows(state, 'wms_operations', "AND kind='scan'");
      assert.equal(scans.length, 10);
      assert(scans.every((r) => r.order_id === state.order.id && r.request.order_id === state.order.id));
      const purchase = await api('/purchase-orders/' + state.placed_purchase.id);
      assert.equal(purchase.state, 'received');
      const purchaseReceipts = await ownRows(state, 'purchase_receipts', 'AND order_id=$2', [purchase.id]);
      assert.equal(purchaseReceipts.length, 1);
      assert.equal(purchaseReceipts[0].id, state.purchase_receipt_id);
      const manual = await ownRows(state, 'wms_operations', 'AND id=$2', [state.manual_receipt_operation_id]);
      assert.equal(manual.length, 1);
      assert.equal(manual[0].kind, 'receipt');
      assert.equal(manual[0].warehouse_document_id, state.manual_receipt_document_id);
      assert.equal(manual[0].client_key, state.manual_receipt_request.client_key);
      assert.equal((await ownRows(state, 'wms_lots')).length, 3);
      const layers = await ownRows(state, 'wms_cost_layers');
      assert.equal(layers.length, 3);
      const expectedLayers = [
        { product_id: a.id, quantity: 6, cost: '101', purchase: state.purchase_receipt_id },
        { product_id: b.id, quantity: 9, cost: '203', purchase: state.purchase_receipt_id },
        { product_id: a.id, quantity: 2, cost: '151', purchase: null },
      ];
      for (const expectedLayer of expectedLayers) {
        const layer = layers.find((r) => r.product_id === expectedLayer.product_id && r.unit_cost_minor === expectedLayer.cost);
        assert(layer);
        assert.equal(layer.quantity_received, expectedLayer.quantity);
        assert.equal(layer.currency, 'PLN');
        assert.equal(layer.purchase_receipt_id, expectedLayer.purchase);
        if (expectedLayer.purchase === null) {
          assert.equal(layer.operation_id, state.manual_receipt_operation_id);
          assert.equal(layer.warehouse_document_id, state.manual_receipt_document_id);
        } else {
          const allocation = allocations.find((r) => r.product_id === expectedLayer.product_id);
          assert.equal(allocation.layer_id, layer.id);
        }
      }
      const manualDocument = await ownRows(state, 'warehouse_documents', 'AND id=$2', [state.manual_receipt_document_id]);
      assert.equal(manualDocument.length, 1);
      assert.equal(manualDocument[0].status, 'posted');
      await value('2735');
      if (resumeAfterChannel) state.api_resume_after_channel_started = new Date().toISOString();
      else state.api_resume_after_packed_started = new Date().toISOString();
      await save(state);
      await writeReport('wms-lots-native-attempt-recovery-qa.json', {
        stage: 111, status: 'PACKED_READBACK_VERIFIED; CONTINUATION_PENDING',
        phase, runtime_revision: health.revision, tenant: state.tenant, order: state.order.id,
        original_failure: resumeAfterChannel
          ? 'GET /channels returned HTTP 404 after creating one local simulated channel; correct route is /shipping/channels'
          : 'POST /shipping/example returned HTTP 400 for an empty JSON request body',
        verified_scan_operations: 10, picked_physical_quantity: 10,
        stock: [{ sku: a.sku, on_hand: 8, reserved: 4 }, { sku: b.sku, on_hand: 9, reserved: 6 }],
        lot_count: 3, valuation_minor: '2735', prior_shipping_plan_count: 0,
        earlier_writes_replayed: false, final_acceptance: false,
      });
    } else {
      state.api_started = new Date().toISOString();
      await save(state);
      let purchase = await api('/purchase-orders/' + state.placed_purchase.id);
      if (purchase.state !== 'received') {
        assert.equal(purchase.state, 'ordered');
        const receive = {
          client_key: randomUUID(),
          version: purchase.version,
          lines: [
            { product_id: a.id, quantity: 6, location: 'A-01' },
            { product_id: b.id, quantity: 9, location: 'A-01' },
          ],
          wms_lots: {
            policy_version: '1',
            stock_versions: await stockVersions(state, [a.id, b.id]),
            lines: [
              { product_id: a.id, quantity: 6, location: 'A-01', lot_code: 'QA111-PO-A' },
              { product_id: b.id, quantity: 9, location: 'A-01', lot_code: 'QA111-PO-B' },
            ],
          },
        };
        state.purchase_receive_request = receive;
        await save(state);
        const received = await api('/purchase-orders/' + purchase.id + '/receive', 'POST', receive);
        state.purchase_receipt_id = received.receipt_id;
        await save(state);
        const replay = await api('/purchase-orders/' + purchase.id + '/receive', 'POST', receive);
        assert(replay.replayed);
        assert.equal(replay.receipt_id, received.receipt_id);
      } else {
        const receipts = await ownRows(state, 'purchase_receipts', 'AND order_id=$2', [purchase.id]);
        assert.equal(receipts.length, 1);
        state.purchase_receipt_id = receipts[0].id;
      }
      await value('2433');
      const receipt = {
        client_key: randomUUID(),
        policy_version: '1',
        warehouse_id: state.warehouse,
        stock_versions: await stockVersions(state, [a.id]),
        confirmed: true,
        note: 'QA111 druga dostawa z innym kosztem',
        lines: [
          {
            product_id: a.id,
            quantity: 2,
            location: 'A-02',
            lot_code: 'QA111-PZ-A',
            unit_cost_minor: '151',
            currency: 'PLN',
          },
        ],
      };
      state.manual_receipt_request = receipt;
      await save(state);
      const received = await api('/wms-lots/receipts', 'POST', receipt, [201]);
      state.manual_receipt_operation = received.operation;
      state.manual_receipt_operation_id = received.operation.id;
      state.manual_receipt_document_id = received.result.warehouse_document_id;
      await save(state);
      const receiptReplay = await api('/wms-lots/receipts', 'POST', receipt);
      assert(receiptReplay.reused);
      assert.deepEqual(receiptReplay.operation, received.operation);
      await value('2735');
      state.order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'QA111 Odbiorca Testowy',
          email: 'qa111@example.test',
          phone: '500600700',
          payment_mode: 'cod',
          warehouse_id: state.warehouse,
          address: {
            street: 'Testowa',
            building_number: '1',
            city: 'Warszawa',
            post_code: '00-001',
            country: 'PL',
          },
          items: [{ product_id: state.bundle.id, quantity: 2 }],
        },
        [201],
      );
      await save(state);
      const allocations = await ownRows(
        state,
        'wms_reservation_layers',
        'AND order_id=$2 ORDER BY product_id,layer_id,location',
        [state.order.id],
      );
      assert.equal(allocations.length, 2);
      assert.equal(
        allocations.reduce((n, r) => n + r.quantity, 0),
        10,
      );
      const layerRows = await ownRows(
        state,
        'wms_cost_layers',
        'AND product_id=ANY($2::uuid[]) ORDER BY fifo_sequence,id',
        [[a.id, b.id]],
      );
      for (const allocation of allocations) {
        const oldest = layerRows.find((r) => r.product_id === allocation.product_id)!;
        assert.equal(
          allocation.layer_id,
          oldest.id,
          'Reservation must use the immutable oldest FIFO layer',
        );
        assert.equal(oldest.unit_cost_minor, allocation.product_id === a.id ? '101' : '203');
      }
      await api('/orders/' + state.order.id + '/status', 'PATCH', { status: 'picking' });
      for (const allocation of allocations)
        for (let i = 0; i < allocation.quantity; i++) {
          const scan = {
            client_key: randomUUID(),
            code: allocation.product_id === a.id ? a.sku : b.sku,
            location: allocation.location,
            layer_id: allocation.layer_id,
          };
          await api('/orders/' + state.order.id + '/scan', 'POST', scan);
          const beforeRetry = await snapshot(state, retryProtectedTables);
          const replay = await api('/orders/' + state.order.id + '/scan', 'POST', scan);
          assert.equal(replay.id, state.order.id);
          assert.deepEqual(
            (await snapshot(state, retryProtectedTables)).result,
            beforeRetry.result,
            'Exact ordinary scan retry changed OMS/WMS state or immutable evidence',
          );
        }
      assert.equal(
        (await ownRows(state, 'wms_issue_fragments', 'AND order_id=$2', [state.order.id])).length,
        0,
      );
      await api('/orders/' + state.order.id + '/status', 'PATCH', { status: 'packed' });
      await value('2735');
    }
    const channel = resumeAfterChannel
      ? { id: state.verified_existing_shipping_channel_id }
      : await api('/shipping/example', 'POST');
    const channels = (await api('/shipping/channels')).data;
    const ownedChannel = channels.find((c: any) => c.id === channel.id);
    assert.equal(
      ownedChannel.settings.simulation,
      true,
      'Only local simulated shipping is authorized',
    );
    const packed = await api('/orders/' + state.order.id);
    const plan = await api(
      '/orders/' + state.order.id + '/shipping/preview',
      'POST',
      {
        channel_id: channel.id,
        service: 'inpost_courier_standard',
        receiver: {
          first_name: 'QA111',
          last_name: 'Test',
          email: 'qa111@example.test',
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
        weight: 2,
        cod: packed.total,
        insurance: packed.total,
      },
      [200, 201],
    );
    state.shipping_plan_id = plan.id;
    await save(state);
    await api('/shipping-plans/' + plan.id + '/queue', 'POST', {});
    let quoted = await waitFor(
      '/orders/' + state.order.id + '/shipping',
      (r) => r.data.some((p: any) => p.id === plan.id && p.state === 'quoted'),
      (r) => r.data.some((p: any) => p.id === plan.id && p.state === 'failed'),
    );
    quoted = quoted.data.find((p: any) => p.id === plan.id);
    assert(quoted.offers.length > 0);
    await api('/shipping-plans/' + plan.id + '/buy', 'POST', {
      offer_id: quoted.offers[0].id,
      confirm_cost: true,
      ack_unknown_rate: true,
    });
    await waitFor(
      '/orders/' + state.order.id + '/shipping',
      (r) => r.data.some((p: any) => p.id === plan.id && p.state === 'ready'),
      (r) => r.data.some((p: any) => p.id === plan.id && p.state === 'failed'),
    );
    await value('2735');
    await api('/shipping-plans/' + plan.id + '/dispatch', 'POST', {});
    await value('1113');
    const issues = await ownRows(
      state,
      'wms_issue_fragments',
      'AND order_id=$2 ORDER BY product_id',
      [state.order.id],
    );
    assert.equal(issues.length, 2);
    assert.equal(
      issues.reduce((n, r) => n + BigInt(r.value_minor), 0n),
      1622n,
    );
    const dispatched = await api('/orders/' + state.order.id);
    assert.equal(dispatched.status, 'shipped');
    state.return = await api(
      '/orders/' + state.order.id + '/returns',
      'POST',
      {
        client_key: randomUUID(),
        reason: 'QA111 częściowy zwrot pierwotnego zestawu',
        items: [{ item_id: dispatched.items[0].id, quantity: 1 }],
      },
      [200, 201],
    );
    state.return_id = state.return.id;
    const restock = {
      version: Number(state.return.version),
      shipping_refund: 0,
      note: 'QA111 pierwotne partie i koszt',
      items: [{ item_id: state.return.items[0].item_id, accepted: 1, restocked: 1 }],
      wms_lots: {
        client_key: randomUUID(),
        policy_version: '1',
        stock_versions: await stockVersions(state, [a.id, b.id]),
        picks: issues.map((r) => ({
          issue_fragment_id: r.id,
          quantity: r.product_id === a.id ? 2 : 3,
          location: 'ZWROT',
        })),
      },
    };
    state.return_receive_request = restock;
    await save(state);
    await api('/returns/' + state.return.id + '/receive', 'POST', restock);
    const beforeReturnRetry = await snapshot(state, retryProtectedTables);
    await api('/returns/' + state.return.id + '/receive', 'POST', restock);
    assert.deepEqual(
      (await snapshot(state, retryProtectedTables)).result,
      beforeReturnRetry.result,
      'Exact return receive retry changed OMS/WMS state or immutable evidence',
    );
    await value('1924');
    const returned = await ownRows(state, 'wms_return_fragments', 'AND return_id=$2', [
      state.return.id,
    ]);
    assert.equal(
      returned.reduce((n, r) => n + BigInt(r.value_minor), 0n),
      811n,
    );
    const aIssue = issues.find((r) => r.product_id === a.id)!;
    await movement(state, 'transfer', {
      kind: 'transfer',
      product_id: a.id,
      warehouse_id: state.warehouse,
      location: 'ZWROT',
      quantity: 1,
      destination_warehouse_id: state.second_warehouse,
      destination_location: 'MM-01',
      layer_ids: [aIssue.layer_id],
      stock_versions: [
        ...(await stockVersions(state, [a.id])),
        ...(await stockVersions(state, [a.id], state.second_warehouse)),
      ],
    });
    await movement(state, 'bin_move', {
      kind: 'bin_move',
      product_id: a.id,
      warehouse_id: state.second_warehouse,
      location: 'MM-01',
      quantity: 1,
      destination_location: 'MM-02',
      layer_ids: [aIssue.layer_id],
      stock_versions: await stockVersions(state, [a.id], state.second_warehouse),
    });
    state.final_valuation = await value('1924');
    const neutral = await pool.query(
      `SELECT sum(delta)::text quantity,sum(value_delta)::text value FROM wms_layer_movements
      WHERE tenant_id=$1 AND operation_id=ANY($2::uuid[]) GROUP BY operation_id`,
      [state.tenant, [state.transfer_operation_id, state.bin_move_operation_id]],
    );
    assert.equal(neutral.rows.length, 2);
    assert(neutral.rows.every((r) => r.quantity === '0' && r.value === '0'));
    // Wait for the real local worker to finish the event-free automation dispatch jobs.
    const until = Date.now() + 60000;
    let active = 1;
    while (Date.now() < until && active) {
      active = (
        await pool.query(
          "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
          [state.tenant],
        )
      ).rows[0].n;
      if (active) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(active, 0, 'Local QA worker jobs must be terminal before checkpoint');
    const failedJobs = (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND (state='failed' OR error IS NOT NULL)",
        [state.tenant],
      )
    ).rows[0].n;
    assert.equal(failedJobs, 0, 'Local QA worker jobs must have no failed state or error');
    assert.equal(
      (await ownRows(state, 'automation_runs')).length,
      0,
      'No external automation is configured',
    );
    assert.equal((await ownRows(state, 'email_messages')).length, 0);
    assert.equal((await ownRows(state, 'sms_messages')).length, 0);
    state.api_acceptance = {
      status: 'PASS',
      scanned_quantity: 10,
      dispatch_value_minor: '1622',
      return_value_minor: '811',
      ending_value_minor: '1924',
      fifo_verified: true,
      scan_exact_retry: true,
      scan_retry_protected_snapshot_exact: true,
      receipt_exact_retry: true,
      return_exact_retry: true,
      return_retry_protected_snapshot_exact: true,
      movement_exact_retry: true,
      failed_or_error_jobs: failedJobs,
      label_scope: 'local_simulation',
      external_provider_verified: false,
    };
    const own = await snapshot(state);
    state.own_names = own.names;
    state.own_snapshot = own.result;
    state.cookie = cookie;
    state.api_checkpoint_file = 'data/wms-lots-stage111-api-checkpoint.json';
    await writeFile(
      state.api_checkpoint_file,
      JSON.stringify(
        {
          runtime_revision: state.runtime_revision,
          tenant: state.tenant,
          time_zone: 'UTC',
          names: own.names,
          snapshot: own.result,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    await save(state);
    await writeReport('wms-lots-native-qa.json', {
      stage: 111,
      status: 'API_PASS; UI_RESTART_RECOVERY_PENDING',
      runtime_revision: health.revision,
      schema: health.schema_revision,
      tenant: state.tenant,
      order: state.order.id,
      purchase_receipt: state.purchase_receipt_id,
      return_id: state.return.id,
      checkpoint_tables: own.names.length,
      ...state.api_acceptance,
      preservation: preserved,
      ui_verified: false,
      restart_verified: false,
      recovery_verified: false,
      goal_complete: false,
    });
    if (resumeAfterPacked) {
      await writeReport('wms-lots-native-attempt-recovery-qa.json', {
        ...state.api_acceptance,
        stage: 111, status: 'API_CONTINUATION_PASS; UI_RESTART_RECOVERY_PENDING',
        phase, runtime_revision: health.revision, tenant: state.tenant, order: state.order.id,
        original_failure: 'POST /shipping/example returned HTTP 400 for an empty JSON request body',
        resume_from: 'verified_packed_state', earlier_writes_replayed: false,
        final_acceptance: false,
        ui_verified: false, restart_verified: false, recovery_verified: false,
      });
    }
    console.log({
      phase,
      status: 'API_PASS; UI_RESTART_RECOVERY_PENDING',
      tenant: state.tenant,
      order: state.order.id,
      ending_value_minor: '1924',
    });
  } else if (phase === 'checkpoint') {
    const state = existing;
    cookie = state.cookie;
    assert.equal(state.api_acceptance?.status, 'PASS');
    assert.equal(state.ui_verified, true, 'Root must first record the actual UI verification');
    await value('1924');
    const own = await snapshot(state);
    state.own_names = own.names;
    state.own_snapshot = own.result;
    state.preservation = preserved;
    state.ui_checkpoint_file = 'data/wms-lots-stage111-ui-checkpoint.json';
    await writeFile(
      state.ui_checkpoint_file,
      JSON.stringify(
        {
          runtime_revision: state.runtime_revision,
          tenant: state.tenant,
          time_zone: 'UTC',
          names: own.names,
          snapshot: own.result,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    await save(state);
    console.log({
      phase,
      status: 'CHECKPOINT_SAVED',
      tables: own.names.length,
      ui_verified: state.ui_verified,
    });
  } else if (phase === 'restart') {
    const state = existing;
    cookie = state.cookie;
    assert.equal(state.api_acceptance?.status, 'PASS');
    assert.deepEqual(
      (await snapshot(state, state.own_names)).result,
      state.own_snapshot,
      'Own immutable checkpoint changed across restart',
    );
    assert.deepEqual((await api('/wms-lots/valuation')).valuation, state.final_valuation);
    assert.equal((await api('/orders/' + state.order.id)).status, 'shipped');
    for (const id of [
      state.manual_receipt_operation_id,
      state.transfer_operation_id,
      state.bin_move_operation_id,
    ])
      assert.equal((await api('/wms-lots/operations/' + id)).operation.id, id);
    state.restart_verified = true;
    const apiRuntimeRevision = state.api_runtime_revision ?? state.runtime_revision;
    state.api_runtime_revision = apiRuntimeRevision;
    state.runtime_revision = health.revision;
    state.preservation = preserved;
    await save(state);
    await writeReport('wms-lots-restart-qa.json', {
      stage: 111,
      status: 'PASS',
      runtime_revision: health.revision,
      api_runtime_revision: apiRuntimeRevision,
      schema: health.schema_revision,
      checkpoint_tables: state.own_names.length,
      checkpoint_exact: true,
      read_only_phase: true,
      preservation: preserved,
      provider_verified: false,
      goal_complete: false,
    });
    console.log({
      phase,
      status: 'PASS',
      tables: state.own_names.length,
      preservation_status: preserved.status,
    });
  } else
    assert.fail(
      'Use setup, api, api-resume-after-packed, checkpoint, or restart. Never rerun unknown partial writes.',
    );
} finally {
  await pool.end();
}
