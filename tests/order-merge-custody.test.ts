import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { localConfig, migrate, pool, tenantTx } from '../server/db';
import { captureOrderMergeBuyerAddressActor, inheritOrderMergeBuyerAddressInTx } from '../server/buyer-address';
import { seed } from './fixtures';
import { transferOrderMergeCustodyInTx } from '../server/order-merge-custody';
import {
  effectiveOrderMergePaymentBalanceInTx,
  orderMergeOriginalCommerceInTx,
  orderMergeOriginalPaymentBalanceInTx,
  orderMergePaymentSourceIdsInTx,
  resolveOrderMergeOwnerInTx,
} from '../server/order-merge-payments';
import { recordFinancialPaymentInTx } from '../server/payments';

assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  user = '',
  cookie = '',
  calls = 0;
const actor = () => ({ tenantId: tenant, userId: user, role: 'admin' as const });
function req(path: string, method: any = 'GET', payload?: any, headers: Row = {}) {
  assert(app);
  return app.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.122.4.1',
  });
}
async function ok(path: string, method: any = 'GET', payload?: any, status = 200) {
  const r = await req(path, method, payload);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 1600)}`);
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.ORDER_MERGE_TEST_LOG === 'true',
    integrationTransport: async () => {
      ++calls;
      throw Error('Custody is local only');
    },
  });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  calls = 0;
  const logged = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(logged.statusCode, 200);
  cookie = String(logged.headers['set-cookie']).split(';')[0];
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Merge custody native fixture','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Custody warehouse','MERGE')",
    [warehouse, tenant],
  );
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
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
async function rows(table: string) {
  return (
    await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
      tenant,
    ])
  ).rows.map((r) => r.row);
}
const physicalTables = [
  'stock',
  'stock_locations',
  'wms_layer_positions',
  'stock_movements',
  'stock_location_movements',
  'wms_layer_movements',
  'wms_operations',
  'wms_issue_fragments',
  'wms_return_fragments',
  'wms_cost_layers',
  'wms_lots',
];
async function snapshot(tables: string[]) {
  const result: Row = {};
  for (const t of tables) result[t] = await rows(t);
  return result;
}
const effects = [
  ...physicalTables,
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'payment_entries',
  'order_events',
  'audit_events',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'order_merge_origins',
  'order_merge_executions',
  'order_merge_execution_rows',
  'order_merge_claims',
  'order_merge_custody_transfers',
];
async function product(quantity = 30) {
  return ok(
    '/products',
    'POST',
    {
      sku: 'CUSTODY-' + randomUUID(),
      name: 'Frozen custody product',
      price: 100,
      vat: 23,
      quantity,
      warehouse_id: warehouse,
      location: 'A-01',
    },
    201,
  );
}
async function order(p: Row, quantity: number, extra: Row = {}) {
  return ok(
    '/orders',
    'POST',
    {
      customer_name: 'One buyer',
      email: 'merge@example.test',
      warehouse_id: warehouse,
      payment_mode: 'cod',
      items: [{ product_id: p.id, quantity }],
      address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', phone: '500600700' },
      ...extra,
    },
    201,
  );
}
async function scan(o: Row, p: Row, location = 'A-01', layer_id?: string) {
  const current = await ok('/orders/' + o.id);
  if (current.status !== 'picking')
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  await ok('/orders/' + o.id + '/scan', 'POST', {
    code: p.sku,
    location,
    client_key: randomUUID(),
    ...(layer_id ? { layer_id } : {}),
  });
}
async function preview(orders: Row[], mode = 'technical_merge', sum = true) {
  const r = await ok(
    '/order-merges/previews',
    'POST',
    {
      client_key: randomUUID(),
      main_order_id: orders[0].id,
      order_ids_to_merge: orders.slice(1).map((o) => o.id),
      merge_mode: mode,
      sum_delivery_costs: sum,
    },
    201,
  );
  assert.equal(r.preview.ready, true, JSON.stringify(r.preview.conflicts));
  return r.preview;
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  preview_id: p.id,
  scope_hash: p.scope_hash,
  confirmed: true,
  confirmed_receiver_selection: true,
});
async function merge(orders: Row[], mode = 'technical_merge', sum = true) {
  const p = await preview(orders, mode, sum),
    body = consent(p);
  const result = await ok('/order-merges/execute', 'POST', body, 201);
  return { p, body, result, target: await ok('/orders/' + result.execution.target_order_id) };
}
async function enableEmpty() {
  const { preview: p } = await ok(
    '/wms-lots/opening-previews',
    'POST',
    {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Empty custody opening',
      lines: [],
    },
    201,
  );
  assert.equal(p.ready, true);
  await ok(
    '/wms-lots/opening-previews/' + p.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: p.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    201,
  );
}
async function supply(p: Row) {
  await enableEmpty();
  const stock = (
    await pool.query(
      'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, p.id],
    )
  ).rows[0];
  await ok(
    '/wms-lots/receipts',
    'POST',
    {
      client_key: randomUUID(),
      policy_version: '1',
      warehouse_id: warehouse,
      stock_versions: [
        { warehouse_id: warehouse, product_id: p.id, version: String(stock.version) },
      ],
      confirmed: true,
      note: 'Two genuine FIFO costs/bins',
      lines: [
        {
          product_id: p.id,
          location: 'A-01',
          quantity: 2,
          lot_code: 'LOW',
          unit_cost_minor: '217',
          currency: 'PLN',
        },
        {
          product_id: p.id,
          location: 'B-02',
          quantity: 5,
          lot_code: 'HIGH',
          unit_cost_minor: '317',
          currency: 'PLN',
        },
      ],
    },
    201,
  );
}
async function waitOn(holder: PoolClient, match: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    until = Date.now() + 30000; // 30 s, not 4 s: on a loaded runner the merge reaches the held row later
  while (Date.now() < until) {
    const rs = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (rs.some((r) => match.test(r.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail('The actual merge request did not wait on the held SQL row');
}
async function whileStockHeld(p: Row, action: () => Promise<any>, change: () => Promise<any>) {
  const c = await pool.connect();
  let request: Promise<any> | undefined;
  try {
    await c.query('BEGIN');
    await c.query(
      'SELECT product_id FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 FOR UPDATE',
      [tenant, warehouse, p.id],
    );
    request = action();
    await waitOn(c, /\bstock\b/);
    await change();
    await c.query('ROLLBACK');
    return await request;
  } finally {
    await c.query('ROLLBACK');
    c.release();
    if (request) await request;
  }
}

test('both merge modes transfer OFF reservations and partial bin scans while all physical stock, versions and journals remain exact', async () => {
  const p = await product();
  for (const mode of ['technical_merge', 'into_main_order']) {
    const a = await order(p, 2),
      b = await order(p, 3);
    await scan(a, p);
    await scan(b, p);
    const originalOrders = (await rows('orders')).filter((o) => [a.id, b.id].includes(o.id)),
      originalItems = (await rows('order_items')).filter((o) => [a.id, b.id].includes(o.order_id));
    const old = await snapshot(physicalTables),
      f = await merge([a, b], mode);
    assert.deepEqual(await snapshot(physicalTables), old);
    assert.equal(f.target.picking_items.length, 1);
    assert.equal(f.target.picking_items[0].quantity, 5);
    assert.equal(f.target.picking_items[0].scanned, 2);
    const allocations = (await rows('reservation_locations')).filter(
      (r) => r.order_id === f.target.id,
    );
    assert.deepEqual(
      allocations.map((r) => [r.location, r.quantity, r.scanned]),
      [['A-01', 5, 2]],
    );
    const sourceIds = [a.id, b.id].filter((id) => id !== f.target.id);
    assert(
      (await rows('reservations'))
        .filter((r) => sourceIds.includes(r.order_id))
        .every((r) => r.state === 'transferred'),
    );
    assert.deepEqual(
      (await rows('orders')).filter((o) => sourceIds.includes(o.id)),
      originalOrders.filter((o) => sourceIds.includes(o.id)),
    );
    assert.deepEqual(
      (await rows('order_items')).filter((o) => sourceIds.includes(o.order_id)),
      originalItems.filter((o) => sourceIds.includes(o.order_id)),
    );
    const frozen = await snapshot(effects);
    await ok('/order-merges/execute', 'POST', f.body);
    assert.deepEqual(await snapshot(effects), frozen);
  }
  assert.equal(calls, 0);
});

test('WMS two-bin/two-cost layer allocations are reaggregated with exact scans and immutable FIFO positions, never released and re-reserved', async () => {
  const p = await product(0);
  await supply(p);
  const a = await order(p, 2),
    b = await order(p, 3);
  const layers = await rows('wms_reservation_layers');
  assert.equal(new Set(layers.map((l) => l.layer_id)).size, 2);
  const aa = layers.find((l) => l.order_id === a.id)!,
    bb = layers.find((l) => l.order_id === b.id)!;
  await scan(a, p, aa.location, aa.layer_id);
  await scan(b, p, bb.location, bb.layer_id);
  const beforeLayers = await rows('wms_reservation_layers'),
    physical = await snapshot(physicalTables),
    f = await merge([a, b], 'into_main_order');
  assert.deepEqual(await snapshot(physicalTables), physical);
  const target = (await rows('wms_reservation_layers')).filter(
    (l) => l.order_id === f.target.id && l.state === 'active',
  );
  const normalize = (ls: Row[]) =>
    ls
      .map((l) => [l.product_id, l.location, l.layer_id, l.quantity, l.scanned])
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  assert.deepEqual(normalize(target), normalize(beforeLayers));
  assert(
    (await rows('wms_reservation_layers'))
      .filter((l) => l.order_id === b.id)
      .every((l) => l.state === 'transferred'),
  );
  assert.equal(f.target.picking_items[0].scanned, 2);
  assert.equal(calls, 0);
});

test('nested financial owner projection counts immutable entries once, retains original nominal, overpayment, reversal and late bank receipt lineage', async () => {
  const p = await product(),
    a = await order(p, 1, { payment_mode: 'prepaid', shipping_cost: 20 }),
    b = await order(p, 1, { payment_mode: 'prepaid', shipping_cost: 30 });
  async function receipt(o: Row, amount: number) {
    const current = await ok('/orders/' + o.id);
    return ok('/orders/' + o.id + '/payments', 'POST', {
      client_key: randomUUID(),
      version: Number(current.version),
      kind: 'receipt',
      amount,
      currency: 'PLN',
      reference: 'Native real local receipt',
      confirmed: true,
    });
  }
  const receiptA = await receipt(a, 200);
  await receipt(b, 100);
  const original = await rows('payment_entries'),
    first = await merge([a, b], 'technical_merge', false);
  assert.deepEqual(await rows('payment_entries'), original);
  assert.equal(first.target.payment.received, 300);
  assert.equal(first.target.payment.overpayment, 80);
  const view = await tenantTx(tenant, (c) => orderMergeOriginalCommerceInTx(c, a.id));
  assert.equal(view.header.total, 120);
  assert.equal(view.items.length, 1);
  const originalBalance = await tenantTx(tenant, (c) =>
    orderMergeOriginalPaymentBalanceInTx(c, a.id),
  );
  assert.equal(originalBalance.received, 200);
  assert.equal(originalBalance.nominal, 120);
  const entryId = receiptA.data.find((e: Row) => e.order_id === a.id && e.kind === 'receipt').id;
  await ok('/orders/' + first.target.id + '/payments/reverse', 'POST', {
    client_key: randomUUID(),
    version: Number(first.target.version),
    entry_id: entryId,
    reason: 'Reverse genuine original receipt',
    confirmed: true,
  });
  const late = await tenantTx(tenant, (c) =>
    recordFinancialPaymentInTx(
      c,
      actor(),
      a.id,
      'late-custody-bank',
      { source: 'controlled-bank-read' },
      {
        kind: 'receipt',
        amount: 25,
        currency: 'PLN',
        method: 'bank_csv',
        reference: 'Late original order bank receipt',
      },
      {
        effects: 'local_financial_only',
        provenance: { execution_id: randomUUID(), row_id: randomUUID(), preview_id: randomUUID() },
      },
    ),
  );
  const c = await order(p, 1, { payment_mode: 'prepaid' });
  await receipt(c, 50);
  const current = await ok('/orders/' + first.target.id),
    second = await merge([current, c]);
  const balance = await tenantTx(tenant, (x) => effectiveOrderMergePaymentBalanceInTx(x, a.id));
  assert.equal(balance.received, 175);
  assert.equal(balance.net, 175);
  assert.equal(balance.nominal, 320);
  assert.equal(balance.amount_due, 145);
  assert.equal(
    await tenantTx(tenant, (x) => resolveOrderMergeOwnerInTx(x, a.id)),
    second.target.id,
  );
  const ids = await tenantTx(tenant, (x) => orderMergePaymentSourceIdsInTx(x, second.target.id));
  assert.equal(new Set(ids).size, 5);
  assert.equal(ids.length, 5);
  const entries = await rows('payment_entries');
  assert.equal(entries.filter((e) => e.id === late.entry_id && e.order_id === a.id).length, 1);
  assert.equal(
    entries.filter((e) => e.kind === 'reversal' && e.reversal_of === entryId && e.order_id === a.id)
      .length,
    1,
  );
  assert.equal(entries.length, 5);
  assert.equal(calls, 0);
});

test('a real stock wait permits administrator withdrawal and the final grant rolls back all target, claim, custody, audit and financial effects', async () => {
  const p = await product(),
    a = await order(p, 2),
    b = await order(p, 3),
    planned = await preview([a, b]),
    baseline = await snapshot(effects);
  const result = await whileStockHeld(
    p,
    () => req('/order-merges/execute', 'POST', consent(planned)),
    () =>
      pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        user,
      ]),
  );
  assert.equal(result.statusCode, 403, result.body);
  assert.deepEqual(await snapshot(effects), baseline);
});

test('current API revoke, expiry and scope removal commit during actual stock waits and each denied execution rolls back custody completely', async () => {
  const p = await product(),
    a = await order(p, 2),
    b = await order(p, 3);
  for (const condition of ['revoked', 'expired', 'scope']) {
    const key = await ok(
      '/developer/keys',
      'POST',
      {
        name: 'Custody current grant ' + condition,
        scopes: ['orders:read', 'orders:write', 'inventory:read', 'inventory:write'],
      },
      201,
    );
    const headers = { authorization: 'Bearer ' + key.token };
    const made = await req(
      '/v1/order-merges/previews',
      'POST',
      {
        client_key: randomUUID(),
        main_order_id: a.id,
        order_ids_to_merge: [b.id],
        merge_mode: 'technical_merge',
        sum_delivery_costs: true,
      },
      headers,
    );
    assert.equal(made.statusCode, 201, made.body);
    const planned = made.json().preview;
    const baseline = await snapshot(effects);
    const r = await whileStockHeld(
      p,
      () => req('/v1/order-merges/execute', 'POST', consent(planned), headers),
      () =>
        pool.query(
          condition === 'revoked'
            ? 'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1'
            : condition === 'expired'
              ? "UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['orders:read','inventory:read']::text[] WHERE id=$1",
          [key.id],
        ),
    );
    assert.equal(r.statusCode, condition === 'scope' ? 403 : 401, r.body);
    assert.deepEqual(await snapshot(effects), baseline);
  }
});

test('a physical scan without an order-head CAS bump invalidates the approved custody snapshot and leaves only the genuine scan effects', async () => {
  const p = await product(),
    a = await order(p, 2),
    b = await order(p, 3);
  await scan(a, p);
  const planned = await preview([a, b]),
    before = (await ok('/orders/' + a.id)).version;
  await ok('/orders/' + a.id + '/scan', 'POST', {
    code: p.sku,
    location: 'A-01',
    client_key: randomUUID(),
  });
  assert.equal((await ok('/orders/' + a.id)).version, before);
  const baseline = await snapshot(effects),
    r = await req('/order-merges/execute', 'POST', consent(planned));
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(await snapshot(effects), baseline);
});

test('raw source-transferred or quantity edits cannot bypass the typed execution proof and committed transferred history is immutable', async () => {
  const p = await product(0);
  await supply(p);
  const a = await order(p, 2),
    b = await order(p, 3);
  const initial = await snapshot(effects);
  await assert.rejects(
    () =>
      tenantTx(tenant, (c) =>
        c.query("UPDATE reservations SET state='transferred' WHERE order_id=$1", [b.id]),
      ),
    (e: any) => e.code === '23514',
  );
  await assert.rejects(
    () =>
      tenantTx(tenant, (c) =>
        c.query('UPDATE wms_reservation_layers SET quantity=quantity+1 WHERE order_id=$1', [a.id]),
      ),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(effects), initial);
  const f = await merge([a, b]),
    after = await snapshot(effects);
  await assert.rejects(
    () =>
      tenantTx(tenant, (c) =>
        c.query("UPDATE reservations SET state='active' WHERE order_id=$1", [b.id]),
      ),
    (e: any) => e.code === '23514',
  );
  await assert.rejects(
    () =>
      tenantTx(tenant, (c) =>
        c.query('UPDATE reservation_locations SET scanned=0 WHERE order_id=$1', [a.id]),
      ),
    (e: any) => e.code === '23514',
  );
  await assert.rejects(
    () =>
      tenantTx(tenant, (c) =>
        c.query(
          'UPDATE order_merge_custody_transfers SET actor_id=actor_id WHERE execution_id=$1',
          [f.result.execution.id],
        ),
      ),
    (e: any) => e.code === '42501' || e.code === '23514',
  );
  assert.deepEqual(await snapshot(effects), after);
});

test('custody evidence is FORCE RLS, app read-only and cross-tenant execution cannot transfer a foreign allocation', async () => {
  const p = await product(),
    a = await order(p, 2),
    b = await order(p, 3),
    f = await merge([a, b]);
  const foreign = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Foreign custody','enterprise')", [
    foreign,
  ]);
  const baseline = await snapshot(effects);
  await tenantTx(foreign, async (c) => {
    assert.equal((await c.query('SELECT * FROM order_merge_custody_transfers')).rowCount, 0);
    await assert.rejects(
      () => c.query('SELECT order_merge_transfer_custody($1)', [f.result.execution.id]),
      (e: any) => e.code === '23514',
    );
  });
  const acl = (
    await pool.query(
      "SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app','order_merge_custody_transfers','INSERT') ins,has_table_privilege('dyna_app','order_merge_custody_transfers','UPDATE') upd,has_table_privilege('dyna_app','order_merge_custody_transfers','DELETE') del FROM pg_class WHERE oid='order_merge_custody_transfers'::regclass",
    )
  ).rows[0];
  assert.deepEqual(acl, {
    relrowsecurity: true,
    relforcerowsecurity: true,
    ins: false,
    upd: false,
    del: false,
  });
  assert.deepEqual(await snapshot(effects), baseline);
});

/** A real approved preview drives the raw SQL chain, not a fabricated bypass token. */
async function preparedRaw(c: PoolClient, p: Row) {
  const planned = (await c.query('SELECT * FROM order_merge_previews WHERE id=$1', [p.id])).rows[0],
    s = planned.snapshot,
    target = planned.target_order_id,
    executionId = randomUUID();
  const main = s.orders.find((o: Row) => o.id === planned.main_order_id),
    header = {
      ...main,
      id: target,
      number: 'RAW-' + randomUUID(),
      source: 'order_merge',
      external_id: null,
      channel_id: null,
      source_snapshot: null,
      portal_token: randomBytes(24).toString('hex'), // 209 receipt: a fresh 48-hex portal token
      version: '1',
      status: planned.target_status,
      total: planned.total_minor,
      shipping_cost: planned.shipping_cost,
    };
  await c.query('INSERT INTO orders SELECT * FROM jsonb_populate_record(NULL::orders,$1::jsonb)', [
    JSON.stringify(header),
  ]);
  const map = new Map<string, string>();
  for (const i of s.items) {
    const id = randomUUID();
    map.set(i.id, id);
    await c.query(
      'INSERT INTO order_items SELECT * FROM jsonb_populate_record(NULL::order_items,$1::jsonb)',
      [JSON.stringify({ ...i, id, order_id: target })],
    );
  }
  const picks = new Map<string, Row>();
  for (const i of s.picks) {
    const old = picks.get(i.product_id);
    if (old) {
      old.quantity += i.quantity;
      old.scanned += i.scanned;
    } else picks.set(i.product_id, { ...i, id: randomUUID(), order_id: target });
  }
  for (const i of picks.values())
    await c.query(
      'INSERT INTO order_pick_items SELECT * FROM jsonb_populate_record(NULL::order_pick_items,$1::jsonb)',
      [JSON.stringify(i)],
    );
  for (const o of s.orders)
    await c.query(
      'INSERT INTO order_merge_origins(tenant_id,order_id,header,items,execution_id) VALUES($1,$2,$3,$4,$5)',
      [
        tenant,
        o.id,
        o,
        JSON.stringify(s.items.filter((i: Row) => i.order_id === o.id)),
        executionId,
      ],
    );
  const execution = {
    ...planned,
    id: executionId,
    preview_id: p.id,
    client_key: randomUUID(),
    request: consent(p),
    state: 'done',
    before_snapshot: s,
    // The stored target row, as executeOrderMerge records it (the 209 receipt compares it with the order).
    after_snapshot: {
      target: (await c.query('SELECT to_jsonb(o) row FROM orders o WHERE id=$1', [target])).rows[0].row,
      items: s.items,
      picks: [...picks.values()],
    },
  };
  await c.query(
    'INSERT INTO order_merge_executions SELECT * FROM jsonb_populate_record(NULL::order_merge_executions,$1::jsonb)',
    [JSON.stringify(execution)],
  );
  // A technical merge inherits the main order's buyer delivery address (209) before the custody transfer, as
  // executeOrderMerge does; the deferred 209 receipt check refuses a merge target without it.
  if (planned.merge_mode === 'technical_merge') {
    const delivery = s.buyer_delivery_frames.find((d: Row) => d.order_id === main.id);
    const merger = captureOrderMergeBuyerAddressActor(
      {
        actor: actor(),
        currentUser: { id: user, tenant_id: tenant },
        cookies: { dyna_session: cookie.slice(cookie.indexOf('=') + 1) },
        headers: {},
      } as any,
      'dyna_session',
    );
    await inheritOrderMergeBuyerAddressInTx(
      c,
      merger,
      {
        tenant_id: tenant,
        execution_id: executionId,
        merge_preview_id: p.id,
        scope_hash: planned.scope_hash,
        source: { order: main, state: delivery.state, buyer_basis_hash: delivery.buyer_basis_hash },
        target_order_id: target,
      },
      localConfig.encryptionKey,
    );
  }
  await transferOrderMergeCustodyInTx(c, actor(), {
    execution_id: executionId,
    source_order_ids: planned.source_ids,
    target_order_id: target,
    merge_mode: planned.merge_mode,
  });
  await c.query(
    'INSERT INTO order_merge_claims(tenant_id,source_order_id,target_order_id,execution_id,merge_mode) SELECT $1,x,$2,$3,$4 FROM unnest($5::uuid[]) x',
    [tenant, target, executionId, planned.merge_mode, planned.source_ids],
  );
  const approved = (
    await c.query('SELECT * FROM order_merge_preview_rows WHERE preview_id=$1 ORDER BY index', [
      p.id,
    ])
  ).rows;
  for (const r of approved)
    await c.query(
      'INSERT INTO order_merge_execution_rows(tenant_id,execution_id,preview_id,index,row,target_item_id) VALUES($1,$2,$3,$4,$5,$6)',
      [tenant, executionId, p.id, r.index, r.row, map.get(r.row.source_item_id)],
    );
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return target;
}
test('actual typed transfer followed by constraint flush and savepoint cannot mutate stock or target scans later in the same transaction', async () => {
  const p = await product(),
    a = await order(p, 2),
    b = await order(p, 3),
    planned = await preview([a, b]),
    baseline = await snapshot(effects);
  for (const mutation of ['stock', 'scans']) {
    let proofReached = false;
    await assert.rejects(
      () =>
        tenantTx(
          tenant,
          async (c) => {
            // The savepoint follows the transfer and flush: the 209 inheritance binds the execution row of the
            // top-level transaction (xmin), so a technical merge cannot itself run inside a subtransaction.
            const target = await preparedRaw(c, planned);
            await c.query('SAVEPOINT actual_merge_subtransaction');
            proofReached = true;
            if (mutation === 'stock')
              await c.query(
                'UPDATE stock SET version=version+1 WHERE tenant_id=$1 AND product_id=$2',
                [tenant, p.id],
              );
            else
              await c.query('UPDATE order_pick_items SET scanned=scanned+1 WHERE order_id=$1', [
                target,
              ]);
          },
          { purchasingAdmission: true },
        ),
      (e: any) => e.code === '23514',
    );
    assert.equal(proofReached, true, 'The actual transfer and constraint flush must succeed before the forbidden late write');
    assert.deepEqual(await snapshot(effects), baseline);
  }
});
