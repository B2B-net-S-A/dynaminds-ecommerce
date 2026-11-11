import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  providerCalls = 0;
const prefix = '/replenishment';
async function request(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: Row) {
  assert(app);
  return app.inject({
    method,
    url: '/api' + path,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.118.4.1',
  });
}
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: Row,
  status = 200,
) {
  const r = await request(path, method, body);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 1200)}`);
  if (path.startsWith(prefix)) assert.equal(r.headers['cache-control'], 'no-store');
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.REPLENISHMENT_TEST_LOG === 'true',
    integrationTransport: async () => {
      providerCalls++;
      throw Error('Local WMS must not contact providers');
    },
  });
  const r = await request('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA118 FIFO replenishment','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA118 FIFO warehouse','RP-FIFO')",
    [warehouse, tenant],
  );
  const switched = await request('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const protectedTables = [
  'products',
  'stock',
  'stock_locations',
  'stock_movements',
  'reservations',
  'reservation_locations',
  'orders',
  'order_items',
  'order_pick_items',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'warehouse_documents',
  'warehouse_document_lines',
  'wms_policies',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'wms_operations',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
] as const;
async function snapshot(tables: readonly string[] = protectedTables) {
  const s: Row = {};
  for (const table of tables)
    s[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return s;
}
async function stock(productId: string) {
  return (
    await pool.query(
      'SELECT * FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, productId],
    )
  ).rows[0] as Row;
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});

test('WMS ON generated draft becomes a partial typed PZ with exact FIFO cost/bin, then next approved NOP and all retries add no stock or layers', async () => {
  const p = await ok(
    '/products',
    'POST',
    {
      sku: 'RP-WMS-' + randomUUID(),
      name: 'Replenishment FIFO physical product',
      price: 9999,
      quantity: 0,
      warehouse_id: warehouse,
      location: 'A-01',
    },
    201,
  );
  const opening = (
    await ok(
      '/wms-lots/opening-previews',
      'POST',
      {
        client_key: randomUUID(),
        policy_version: '0',
        currency: 'PLN',
        note: 'Empty FIFO opening',
        lines: [],
      },
      201,
    )
  ).preview;
  assert.equal(opening.ready, true);
  await ok(
    '/wms-lots/opening-previews/' + opening.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: opening.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    201,
  );
  const supplier = await ok(
    '/suppliers',
    'POST',
    { name: 'Known FIFO cost supplier', code: randomUUID() },
    201,
  );
  const policy = (
    await ok(
      prefix + '/policies',
      'POST',
      {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        product_id: p.id,
        definition: {
          enabled: true,
          minimum_quantity: 5,
          target_quantity: 10,
          supplier_id: supplier.id,
          supplier_sku: 'SUP-FIFO-317',
          currency: 'PLN',
          minimum_order_quantity: 1,
          order_multiple: 1,
          unit_cost_minor: 317,
          cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
          confirm_cost: true,
          expected_date: null,
        },
      },
      201,
    )
  ).policy;
  const previewBody = () => ({
    client_key: randomUUID(),
    warehouse_id: warehouse,
    items: [{ product_id: p.id, product_version: p.version, policy_version: policy.version }],
  });
  const initial = (await ok(prefix + '/previews', 'POST', previewBody(), 201)).preview;
  assert.equal(initial.ready, true);
  const initialRows = await ok(prefix + '/previews/' + initial.id + '/rows');
  assert.equal(initialRows.data.length, 1);
  assert.equal(initialRows.data[0].recommended_quantity, '10');
  assert.equal(initialRows.data[0].line_total_minor, '3170');
  const physicalBeforeExecute = await snapshot();
  const approved = consent(initial);
  const execution = (
    await ok(prefix + '/previews/' + initial.id + '/execute', 'POST', approved, 201)
  ).execution;
  assert.equal(execution.groups.length, 1);
  // Approval creates a draft, never receives stock or constructs a FIFO layer.
  const afterDraft = await snapshot();
  for (const table of [
    'stock',
    'stock_locations',
    'stock_movements',
    'wms_lots',
    'wms_cost_layers',
    'wms_layer_positions',
    'wms_layer_movements',
  ])
    assert.deepEqual(afterDraft[table], physicalBeforeExecute[table], table);
  const po = await ok('/purchase-orders/' + execution.groups[0].purchase_order_id);
  assert.equal(po.state, 'draft');
  assert.equal(po.replenishment_execution_id, execution.id);
  assert.equal(po.lines.length, 1);
  assert.equal(po.lines[0].quantity, 10);
  assert.equal(po.lines[0].unit_cost, 317);
  assert.equal(po.lines[0].supplier_sku, 'SUP-FIFO-317');
  const placed = await ok('/purchase-orders/' + po.id + '/place', 'POST', { version: po.version });
  const beforeReceive = await snapshot();
  const oldStock = await stock(p.id);
  const receiptBody = {
    client_key: randomUUID(),
    version: placed.version,
    lines: [{ product_id: p.id, quantity: 4, location: 'FIFO-IN-01' }],
    wms_lots: {
      policy_version: '1',
      stock_versions: [
        { warehouse_id: warehouse, product_id: p.id, version: String(oldStock.version) },
      ],
      lines: [
        {
          product_id: p.id,
          quantity: 4,
          location: 'FIFO-IN-01',
          lot_code: 'RP118-PARTIAL',
          unit_cost_minor: '317',
          currency: 'PLN',
        },
      ],
    },
  };
  const invalid = {
    ...receiptBody,
    wms_lots: {
      ...receiptBody.wms_lots,
      lines: [{ ...receiptBody.wms_lots.lines[0], unit_cost_minor: '318' }],
    },
  };
  assert.equal(
    (await request('/purchase-orders/' + po.id + '/receive', 'POST', invalid)).statusCode,
    422,
  );
  assert.deepEqual(
    await snapshot(),
    beforeReceive,
    'Client cannot replace approved purchase source cost',
  );
  const received = await ok('/purchase-orders/' + po.id + '/receive', 'POST', receiptBody);
  assert.equal(received.replayed, false);
  assert.equal(received.order.state, 'partial');
  assert.equal(received.order.lines[0].received_quantity, 4);
  const receipt = (
    await pool.query('SELECT * FROM purchase_receipts WHERE tenant_id=$1 AND id=$2', [
      tenant,
      received.receipt_id,
    ])
  ).rows[0];
  const currentStock = await stock(p.id);
  assert.equal(currentStock.on_hand, 4);
  assert.equal(currentStock.reserved, 0);
  assert.equal(
    BigInt(currentStock.version),
    BigInt(oldStock.version) + 1n,
    'One physical receipt changes stock once',
  );
  const movement = (
    await pool.query(
      'SELECT delta,kind FROM stock_movements WHERE tenant_id=$1 AND warehouse_document_id=$2',
      [tenant, receipt.document_id],
    )
  ).rows;
  assert.deepEqual(
    movement,
    [{ delta: 4, kind: 'receipt' }],
    'Typed FIFO accounting cannot duplicate the physical PZ',
  );
  const bins = (
    await pool.query(
      'SELECT location,quantity FROM stock_locations WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND quantity>0 ORDER BY location',
      [tenant, warehouse, p.id],
    )
  ).rows;
  assert.deepEqual(bins, [{ location: 'FIFO-IN-01', quantity: 4 }]);
  const layers = (
    await pool.query(
      'SELECT * FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2 ORDER BY fifo_sequence',
      [tenant, p.id],
    )
  ).rows;
  assert.equal(layers.length, 1);
  const layer = layers[0];
  assert.equal(layer.quantity_received, 4);
  assert.equal(layer.unit_cost_minor, '317');
  assert.equal(layer.currency, 'PLN');
  assert(BigInt(layer.fifo_sequence) > 0n);
  assert.equal(layer.purchase_receipt_id, receipt.id);
  assert.equal(layer.warehouse_document_id, receipt.document_id);
  const op = (
    await pool.query('SELECT * FROM wms_operations WHERE tenant_id=$1 AND id=$2', [
      tenant,
      layer.operation_id,
    ])
  ).rows[0];
  assert.equal(op.kind, 'receipt');
  assert.equal(op.purchase_receipt_id, receipt.id);
  assert.equal(op.warehouse_document_id, receipt.document_id);
  const positions = (
    await pool.query(
      'SELECT layer_id,location,quantity,reserved FROM wms_layer_positions WHERE tenant_id=$1 AND product_id=$2',
      [tenant, p.id],
    )
  ).rows;
  assert.deepEqual(positions, [
    { layer_id: layer.id, location: 'FIFO-IN-01', quantity: 4, reserved: 0 },
  ]);
  const journal = (
    await pool.query(
      'SELECT layer_id,location,delta,value_delta FROM wms_layer_movements WHERE tenant_id=$1 AND operation_id=$2',
      [tenant, op.id],
    )
  ).rows;
  assert.deepEqual(journal, [
    { layer_id: layer.id, location: 'FIFO-IN-01', delta: 4, value_delta: '1268' },
  ]);
  const valuation = (await ok('/wms-lots/valuation')).valuation;
  assert.equal(valuation.known_minor, '1268');
  assert.equal(valuation.unknown_quantity, '0');
  const afterReceive = await snapshot();
  assert.equal(
    (await ok('/purchase-orders/' + po.id + '/receive', 'POST', receiptBody)).replayed,
    true,
  );
  assert.deepEqual(
    await snapshot(),
    afterReceive,
    'Exact PZ retry cannot create a second layer, ledger or stock write',
  );
  const retry = await ok(prefix + '/previews/' + initial.id + '/execute', 'POST', approved);
  assert.equal(retry.reused, true);
  assert.deepEqual(
    retry.execution,
    execution,
    'Original execution stays frozen after partial receipt',
  );
  assert.deepEqual(await snapshot(), afterReceive);
  // Available four plus genuine remaining ordered six satisfies minimum five.
  const next = (await ok(prefix + '/previews', 'POST', previewBody(), 201)).preview;
  const nextRows = (await ok(prefix + '/previews/' + next.id + '/rows')).data;
  assert.equal(nextRows.length, 1);
  const row = nextRows[0];
  assert.equal(row.status, 'unchanged');
  assert.equal(row.available, '4');
  assert.equal(row.incoming_draft_quantity, '0');
  assert.equal(row.incoming_ordered_quantity, '6');
  assert.equal(row.projected_available, '10');
  assert.equal(row.recommended_quantity, '0');
  assert.deepEqual(next.groups, []);
  const contributors = await ok(
    prefix + '/previews/' + next.id + '/rows/' + row.id + '/contributors',
  );
  assert.equal(contributors.data.length, 1);
  assert.equal(contributors.data[0].source_id, po.id);
  assert.equal(contributors.data[0].received_quantity, 4);
  assert.equal(contributors.data[0].remaining_quantity, '6');
  const beforeNop = await snapshot();
  const nopBody = consent(next);
  const nop = (await ok(prefix + '/previews/' + next.id + '/execute', 'POST', nopBody, 201))
    .execution;
  assert.deepEqual(nop.groups, []);
  assert.equal(nop.purchase, 0);
  assert.equal(nop.unchanged, 1);
  assert.deepEqual(
    await snapshot(),
    beforeNop,
    'NOP creates only evidence; no PO, bin, layer, stock or provider effects',
  );
  const evidenceAfterNop = await snapshot([
    ...protectedTables,
    'replenishment_executions',
    'replenishment_execution_rows',
    'audit_events',
  ]);
  assert.equal(
    (await ok(prefix + '/previews/' + next.id + '/execute', 'POST', nopBody)).reused,
    true,
  );
  assert.deepEqual(
    await snapshot([
      ...protectedTables,
      'replenishment_executions',
      'replenishment_execution_rows',
      'audit_events',
    ]),
    evidenceAfterNop,
  );
  assert.equal(providerCalls, 0);
});

test('WMS ON literal 18→6→12→NOP then close remaining preserves six received units, FIFO cost/source and active scanned reservations', async () => {
  const p = await ok(
    '/products',
    'POST',
    {
      sku: 'RP-WMS-18-' + randomUUID(),
      name: 'Literal eighteen FIFO purchase',
      price: 9999,
      quantity: 0,
      warehouse_id: warehouse,
      location: 'A-01',
    },
    201,
  );
  const opening = (
    await ok(
      '/wms-lots/opening-previews',
      'POST',
      {
        client_key: randomUUID(),
        policy_version: '0',
        currency: 'PLN',
        note: 'Empty literal 18/6 opening',
        lines: [],
      },
      201,
    )
  ).preview;
  assert.equal(opening.ready, true);
  await ok(
    '/wms-lots/opening-previews/' + opening.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: opening.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    201,
  );
  const supplier = await ok(
    '/suppliers',
    'POST',
    { name: 'Literal known FIFO supplier', code: randomUUID() },
    201,
  );
  const policy = (
    await ok(
      prefix + '/policies',
      'POST',
      {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        product_id: p.id,
        definition: {
          enabled: true,
          minimum_quantity: 10,
          target_quantity: 18,
          supplier_id: supplier.id,
          supplier_sku: 'SUP-18-6',
          currency: 'PLN',
          minimum_order_quantity: 1,
          order_multiple: 1,
          unit_cost_minor: 317,
          cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
          confirm_cost: true,
          expected_date: null,
        },
      },
      201,
    )
  ).policy;
  const previewBody = () => ({
    client_key: randomUUID(),
    warehouse_id: warehouse,
    items: [{ product_id: p.id, product_version: p.version, policy_version: policy.version }],
  });
  const initial = (await ok(prefix + '/previews', 'POST', previewBody(), 201)).preview;
  const initialRow = (await ok(prefix + '/previews/' + initial.id + '/rows')).data[0];
  assert.equal(initialRow.recommended_quantity, '18');
  assert.equal(initialRow.line_total_minor, '5706');
  const executeBody = consent(initial);
  const execution = (
    await ok(prefix + '/previews/' + initial.id + '/execute', 'POST', executeBody, 201)
  ).execution;
  assert.equal(execution.groups.length, 1);
  const po = await ok('/purchase-orders/' + execution.groups[0].purchase_order_id);
  assert.equal(po.state, 'draft');
  assert.equal(po.lines[0].quantity, 18);
  assert.equal(po.lines[0].unit_cost, 317);
  const placed = await ok('/purchase-orders/' + po.id + '/place', 'POST', { version: po.version });
  const oldStock = await stock(p.id);
  const receiptBody = {
    client_key: randomUUID(),
    version: placed.version,
    lines: [{ product_id: p.id, quantity: 6, location: 'FIFO-18-6' }],
    wms_lots: {
      policy_version: '1',
      stock_versions: [
        { warehouse_id: warehouse, product_id: p.id, version: String(oldStock.version) },
      ],
      lines: [
        {
          product_id: p.id,
          quantity: 6,
          location: 'FIFO-18-6',
          lot_code: 'LITERAL-18-6',
          unit_cost_minor: '317',
          currency: 'PLN',
        },
      ],
    },
  };
  const received = await ok('/purchase-orders/' + po.id + '/receive', 'POST', receiptBody);
  assert.equal(received.order.state, 'partial');
  assert.equal(received.order.lines[0].quantity, 18);
  assert.equal(received.order.lines[0].received_quantity, 6);
  assert.equal(received.order.lines[0].remaining_quantity, 12);
  assert.equal(received.order.lines[0].closed_quantity, 0);
  const s = await stock(p.id);
  assert.equal(s.on_hand, 6);
  assert.equal(s.reserved, 0);
  assert.equal(BigInt(s.version), BigInt(oldStock.version) + 1n);
  const receipt = (
    await pool.query('SELECT * FROM purchase_receipts WHERE tenant_id=$1 AND id=$2', [
      tenant,
      received.receipt_id,
    ])
  ).rows[0];
  const layers = (
    await pool.query(
      'SELECT * FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2 ORDER BY fifo_sequence',
      [tenant, p.id],
    )
  ).rows;
  assert.equal(layers.length, 1);
  const layer = layers[0];
  assert.equal(layer.quantity_received, 6);
  assert.equal(layer.unit_cost_minor, '317');
  assert.equal(layer.currency, 'PLN');
  assert(BigInt(layer.fifo_sequence) > 0n);
  assert.equal(layer.purchase_receipt_id, received.receipt_id);
  assert.equal(layer.warehouse_document_id, receipt.document_id);
  const operation = (
    await pool.query('SELECT * FROM wms_operations WHERE tenant_id=$1 AND id=$2', [
      tenant,
      layer.operation_id,
    ])
  ).rows[0];
  assert.equal(operation.kind, 'receipt');
  assert.equal(operation.purchase_receipt_id, receipt.id);
  assert.equal(operation.warehouse_document_id, receipt.document_id);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT delta,kind FROM stock_movements WHERE tenant_id=$1 AND warehouse_document_id=$2',
        [tenant, receipt.document_id],
      )
    ).rows,
    [{ delta: 6, kind: 'receipt' }],
    'One physical PZ, not a second write for FIFO accounting',
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT delta,value_delta,location,layer_id FROM wms_layer_movements WHERE tenant_id=$1 AND operation_id=$2',
        [tenant, operation.id],
      )
    ).rows,
    [{ delta: 6, value_delta: '1902', location: 'FIFO-18-6', layer_id: layer.id }],
  );
  const value = (await ok('/wms-lots/valuation')).valuation;
  assert.equal(value.known_minor, '1902');
  assert.equal(value.unknown_quantity, '0');
  const afterReceipt = await snapshot();
  assert.equal(
    (await ok('/purchase-orders/' + po.id + '/receive', 'POST', receiptBody)).replayed,
    true,
  );
  assert.deepEqual(await snapshot(), afterReceipt);
  const next = (await ok(prefix + '/previews', 'POST', previewBody(), 201)).preview;
  const nextRow = (await ok(prefix + '/previews/' + next.id + '/rows')).data[0];
  assert.equal(nextRow.available, '6');
  assert.equal(nextRow.incoming_ordered_quantity, '12');
  assert.equal(nextRow.incoming_draft_quantity, '0');
  assert.equal(nextRow.projected_available, '18');
  assert.equal(nextRow.recommended_quantity, '0');
  assert.equal(nextRow.status, 'unchanged');
  const contributors = (
    await ok(prefix + '/previews/' + next.id + '/rows/' + nextRow.id + '/contributors')
  ).data;
  assert.equal(contributors.length, 1);
  assert.equal(contributors[0].source_id, po.id);
  assert.equal(contributors[0].received_quantity, 6);
  assert.equal(contributors[0].remaining_quantity, '12');
  const beforeNop = await snapshot();
  const nop = (await ok(prefix + '/previews/' + next.id + '/execute', 'POST', consent(next), 201))
    .execution;
  assert.equal(nop.purchase, 0);
  assert.equal(nop.unchanged, 1);
  assert.deepEqual(nop.groups, []);
  assert.deepEqual(await snapshot(), beforeNop);

  // An actual live reservation with an actual scan must survive closing unreceived purchasing quantities.
  const sale = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Literal FIFO reservation',
      email: 'rp18@example.test',
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
      items: [{ product_id: p.id, quantity: 2 }],
    },
    201,
  );
  await ok('/orders/' + sale.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + sale.id + '/status', { status: 'picking' }));
  await ok('/orders/' + sale.id + '/scan', 'POST', {
    client_key: randomUUID(),
    code: p.sku,
    location: 'FIFO-18-6',
    layer_id: layer.id,
  });
  const allocations = (
    await pool.query(
      'SELECT layer_id,location,quantity,scanned,state FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2',
      [tenant, sale.id],
    )
  ).rows;
  assert.deepEqual(allocations, [
    { layer_id: layer.id, location: 'FIFO-18-6', quantity: 2, scanned: 1, state: 'active' },
  ]);
  assert.equal((await stock(p.id)).reserved, 2);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT layer_id,location,quantity,reserved FROM wms_layer_positions WHERE tenant_id=$1 AND product_id=$2',
        [tenant, p.id],
      )
    ).rows,
    [{ layer_id: layer.id, location: 'FIFO-18-6', quantity: 6, reserved: 2 }],
  );
  const unchangedTables = [
    ...protectedTables.filter((t) => !['purchase_orders', 'purchase_order_lines'].includes(t)),
    'order_events',
  ];
  const beforeClose = await snapshot(unchangedTables);
  const closeBody = {
    version: received.order.version,
    reason: 'Close only the twelve unreceived units',
  };
  const closed = await ok('/purchase-orders/' + po.id + '/close', 'POST', closeBody);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.lines[0].quantity, 18);
  assert.equal(closed.lines[0].received_quantity, 6);
  assert.equal(closed.lines[0].closed_quantity, 12);
  assert.equal(closed.lines[0].remaining_quantity, 0);
  assert.equal(closed.lines[0].unit_cost, 317);
  assert.deepEqual(
    await snapshot(unchangedTables),
    beforeClose,
    'Closing remaining PO quantity cannot consume, release or recost received stock/reservations',
  );
  const afterCloseValue = (await ok('/wms-lots/valuation')).valuation;
  assert.equal(afterCloseValue.known_minor, '1902');
  assert.equal(afterCloseValue.unknown_quantity, '0');
  const afterClosed = (await ok(prefix + '/previews', 'POST', previewBody(), 201)).preview;
  const closedRow = (await ok(prefix + '/previews/' + afterClosed.id + '/rows')).data[0];
  assert.equal(closedRow.available, '4');
  assert.equal(closedRow.incoming_ordered_quantity, '0');
  assert.equal(closedRow.projected_available, '4');
  assert.equal(closedRow.recommended_quantity, '14');
  const afterFinalPreview = await snapshot(unchangedTables);
  const originalRetry = await ok(
    prefix + '/previews/' + initial.id + '/execute',
    'POST',
    executeBody,
  );
  assert.equal(originalRetry.reused, true);
  assert.deepEqual(originalRetry.execution, execution);
  assert.equal(
    (await ok('/purchase-orders/' + po.id + '/receive', 'POST', receiptBody)).replayed,
    true,
  );
  assert.deepEqual(await snapshot(unchangedTables), afterFinalPreview);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM wms_issue_fragments WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(providerCalls, 0);
});
