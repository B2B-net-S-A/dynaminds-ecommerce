import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { calculateReplenishment } from '../server/replenishment-plans';
import {
  replenishmentPreviewInput,
  replenishmentPolicyDefinitionInput,
} from '../server/replenishment-plans-schema';
import { processB2bCatalog } from '../server/b2b-network';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  supplier = '',
  admin = '',
  viewer = '',
  other = '',
  user = '',
  providers = 0,
  ip = 1;
const cookies = new Map<string, string>(),
  base = '/replenishment';
const request = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  cookie = admin,
  headers: Record<string, string> = {},
) => {
  assert(app);
  return app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie, ...headers },
    remoteAddress: '127.118.3.' + ip,
  });
};
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  status = 200,
  cookie = admin,
) {
  const r = await request(path, method, body, cookie);
  assert.equal(r.statusCode, status, path.startsWith('/auth') ? path : r.body);
  if (path.startsWith(base)) assert.equal(r.headers['cache-control'], 'no-store');
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providers++;
      throw Error('Replenishment cannot contact providers');
    },
    logging: process.env.REPLENISHMENT_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local', 'other@demo.local']) {
    const r = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  tenant = randomUUID();
  warehouse = randomUUID();
  providers = 0;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA118 main','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE WHEN email='viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA118 warehouse','QA118')",
    [warehouse, tenant],
  );
  for (const [email, cookie] of cookies) {
    const r = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200, r.body);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
  supplier = (await ok('/suppliers', 'POST', { name: 'QA118 Supplier', code: randomUUID() }, 201))
    .id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const definition = (extra: Row = {}) => ({
  enabled: true,
  minimum_quantity: 8,
  target_quantity: 20,
  supplier_id: supplier,
  supplier_sku: 'SUP-001',
  currency: 'PLN',
  minimum_order_quantity: 4,
  order_multiple: 6,
  unit_cost_minor: 317,
  cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
  confirm_cost: true,
  expected_date: null,
  ...extra,
});
const product = (extra: Row = {}) =>
  ok(
    '/products',
    'POST',
    {
      sku: 'QA118-' + randomUUID(),
      name: 'QA118 product',
      price: 999,
      quantity: 5,
      warehouse_id: warehouse,
      ...extra,
    },
    201,
  );
async function policy(p: Row, extra: Row = {}) {
  return (
    await ok(
      base + '/policies',
      'POST',
      {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        product_id: p.id,
        definition: definition(extra),
      },
      201,
    )
  ).policy as Row;
}
const body = (ps: Row[], pols: Row[]) => ({
  client_key: randomUUID(),
  warehouse_id: warehouse,
  items: ps.map((p, i) => ({
    product_id: p.id,
    product_version: p.version,
    policy_version: pols[i].version,
  })),
});
async function preview(b: Row) {
  return (await ok(base + '/previews', 'POST', b, 201)).preview as Row;
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const execute = (p: Row, b: Row = consent(p), status = 201) =>
  ok(base + '/previews/' + p.id + '/execute', 'POST', b, status);
async function rows(path: string, expected: number) {
  const result: Row[] = [];
  let cursor: string | null = null;
  do {
    const r = await ok(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(r.meta.total, expected);
    result.push(...r.data);
    cursor = r.meta.cursor;
  } while (cursor);
  assert.equal(result.length, expected);
  assert.equal(new Set(result.map((r) => r.id)).size, expected);
  return result;
}
async function physical() {
  const result: Row = {};
  for (const table of [
    'products',
    'stock',
    'stock_locations',
    'stock_movements',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
    'order_pick_items',
    'outbound_events',
    'email_messages',
    'sms_messages',
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function evidence() {
  const result: Row = {};
  for (const table of [
    'purchase_orders',
    'purchase_order_lines',
    'replenishment_executions',
    'replenishment_execution_rows',
    'audit_events',
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}

test('BigInt threshold, MOQ and multiple remain exact, including zero and schema bounds', () => {
  const b = {
    available: 5,
    incoming_draft_quantity: '0',
    incoming_ordered_quantity: '0',
    minimum_quantity: 8,
    target_quantity: 20,
    minimum_order_quantity: 4,
    order_multiple: 6,
  };
  assert.deepEqual(calculateReplenishment(b), {
    available: '5',
    incoming_draft_quantity: '0',
    incoming_ordered_quantity: '0',
    projected_available: '5',
    deficit: '15',
    recommended_quantity: '18',
    rounding_surplus: '3',
  });
  assert.equal(calculateReplenishment({ ...b, available: 8 }).recommended_quantity, '0');
  assert.equal(
    calculateReplenishment({ ...b, incoming_ordered_quantity: '9007199254740993' })
      .projected_available,
    '9007199254740998',
  );
  assert.equal(
    calculateReplenishment({ ...b, available: 0, minimum_quantity: 0 }).recommended_quantity,
    '0',
  );
  assert(replenishmentPolicyDefinitionInput.safeParse(definition({ unit_cost_minor: 0 })).success);
  assert(
    replenishmentPolicyDefinitionInput.safeParse(
      definition({ unit_cost_minor: null, cost_valid_until: null }),
    ).success,
  );
  for (const patch of [
    { target_quantity: 1 },
    { minimum_order_quantity: 0 },
    { order_multiple: 1000001 },
    { unit_cost_minor: 1000000001 },
  ])
    assert(!replenishmentPolicyDefinitionInput.safeParse(definition(patch)).success);
  const items = Array.from({ length: 501 }, () => ({
    product_id: randomUUID(),
    product_version: 1,
    policy_version: 1,
  }));
  assert(
    !replenishmentPreviewInput.safeParse({
      client_key: randomUUID(),
      warehouse_id: randomUUID(),
      items,
    }).success,
  );
});

test('explicit cost confirmation, expiry and current-policy create replay preserve original request identity', async () => {
  const p = await product(),
    b = {
      client_key: randomUUID(),
      warehouse_id: warehouse,
      product_id: p.id,
      definition: definition(),
    };
  assert.equal(
    (
      await request(base + '/policies', 'POST', {
        ...b,
        definition: { ...b.definition, confirm_cost: false },
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await request(base + '/policies', 'POST', {
        ...b,
        definition: {
          ...b.definition,
          cost_valid_until: new Date(Date.now() + 31 * 86400000).toISOString(),
        },
      })
    ).statusCode,
    422,
  );
  const created = (await ok(base + '/policies', 'POST', b, 201)).policy;
  const patched = (
    await ok(base + '/policies/' + created.id, 'PATCH', {
      version: created.version,
      definition: { ...b.definition, confirm_cost: false, minimum_quantity: 9 },
    })
  ).policy;
  assert.equal(patched.version, 2);
  assert.equal(patched.cost_confirmed_at, created.cost_confirmed_at);
  const replay = await ok(base + '/policies', 'POST', b);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.policy, patched);
  assert.deepEqual((await ok(base + '/policies/' + created.id)).policy, patched);
  assert.equal(
    (
      await request(base + '/policies', 'POST', {
        ...b,
        definition: { ...b.definition, target_quantity: 30 },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request(base + '/policies/' + created.id, 'PATCH', {
        version: 1,
        definition: b.definition,
      })
    ).statusCode,
    409,
  );
});

test('draft and ordered incoming, partial PZ and closing remaining quantities affect the next full plan once', async () => {
  const p = await product(),
    pol = await policy(p),
    input = body([p], [pol]);
  const draft = await ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'EUR',
      lines: [{ product_id: p.id, quantity: 3, unit_cost: 0 }],
    },
    201,
  );
  const ordered = await ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'PLN',
      lines: [{ product_id: p.id, quantity: 4, unit_cost: 317 }],
    },
    201,
  );
  const placed = await ok('/purchase-orders/' + ordered.id + '/place', 'POST', {
    version: ordered.version,
  });
  const initial = await preview(input),
    r = (await rows(base + '/previews/' + initial.id + '/rows', 1))[0];
  assert.equal(r.incoming_draft_quantity, '3');
  assert.equal(r.incoming_ordered_quantity, '4');
  assert.equal(r.projected_available, '12');
  assert.equal(r.status, 'unchanged');
  const received = await ok('/purchase-orders/' + ordered.id + '/receive', 'POST', {
    version: placed.version,
    client_key: randomUUID(),
    lines: [{ product_id: p.id, quantity: 2, location: 'A-01' }],
  });
  assert.equal(received.order.state, 'partial');
  const after = await preview({ ...input, client_key: randomUUID() }),
    rr = (await rows(base + '/previews/' + after.id + '/rows', 1))[0];
  assert.equal(rr.available, '7');
  assert.equal(rr.incoming_ordered_quantity, '2');
  assert.equal(rr.projected_available, '12');
  await ok('/purchase-orders/' + draft.id + '/cancel', 'POST', {
    version: draft.version,
    reason: 'QA118 cancel draft',
  });
  const current = await ok('/purchase-orders/' + ordered.id);
  await ok('/purchase-orders/' + ordered.id + '/close', 'POST', {
    version: current.version,
    reason: 'QA118 close remaining',
  });
  const next = await preview({ ...input, client_key: randomUUID() }),
    nr = (await rows(base + '/previews/' + next.id + '/rows', 1))[0];
  assert.equal(nr.available, '7');
  assert.equal(nr.incoming_draft_quantity, '0');
  assert.equal(nr.incoming_ordered_quantity, '0');
  assert.equal(nr.recommended_quantity, '18');
  assert.equal(providers, 0);
});

test('literal WMS OFF draft18 receives6, preserves reserved7, then NOP and closes remaining12 with exact retries', async () => {
  const p = await product({ quantity: 12 }),
    reservation = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'QA118 OFF reservation',
        email: 'qa118-off@example.test',
        warehouse_id: warehouse,
        items: [{ product_id: p.id, quantity: 7 }],
      },
      201,
    ),
    pol = await policy(p, { minimum_quantity: 13 }),
    input = body([p], [pol]);
  assert(reservation.id);
  assert.equal(
    Number(
      (await pool.query('SELECT count(*) FROM wms_policies WHERE tenant_id=$1', [tenant])).rows[0]
        .count,
    ),
    0,
  );
  const before = await physical();
  const initialStock = (
    await pool.query(
      'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, p.id],
    )
  ).rows[0];
  assert.deepEqual(initialStock, { on_hand: 12, reserved: 7, available: 5 });
  const pr = await preview(input),
    approved = (await rows(base + '/previews/' + pr.id + '/rows', 1))[0];
  assert.equal(approved.available, '5');
  assert.equal(approved.deficit, '15');
  assert.equal(approved.recommended_quantity, '18');
  assert.equal(approved.rounding_surplus, '3');
  assert.equal(approved.unit_cost_minor, 317);
  assert.equal(approved.line_total_minor, '5706');
  const approval = consent(pr),
    e = (await execute(pr, approval)).execution;
  assert.equal(e.groups.length, 1);
  const poId = e.groups[0].purchase_order_id;
  const draft = await ok('/purchase-orders/' + poId);
  assert.equal(draft.state, 'draft');
  assert.equal(draft.lines.length, 1);
  assert.deepEqual(
    [
      draft.lines[0].quantity,
      draft.lines[0].unit_cost,
      draft.lines[0].received_quantity,
      draft.lines[0].closed_quantity,
    ],
    [18, 317, 0, 0],
  );
  assert.deepEqual(await physical(), before);

  async function frozen() {
    return {
      preview: (
        await pool.query(
          'SELECT to_jsonb(t) row FROM replenishment_previews t WHERE tenant_id=$1 AND id=$2',
          [tenant, pr.id],
        )
      ).rows,
      rows: (
        await pool.query(
          'SELECT to_jsonb(t) row FROM replenishment_rows t WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
          [tenant, pr.id],
        )
      ).rows,
      execution: (
        await pool.query(
          'SELECT to_jsonb(t) row FROM replenishment_executions t WHERE tenant_id=$1 AND id=$2',
          [tenant, e.id],
        )
      ).rows,
      execution_rows: (
        await pool.query(
          'SELECT to_jsonb(t) row FROM replenishment_execution_rows t WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index',
          [tenant, e.id],
        )
      ).rows,
    };
  }
  const originalProof = await frozen();
  async function effects() {
    const result: Row = { physical: await physical(), evidence: await evidence() };
    for (const table of [
      'purchase_receipts',
      'purchase_receipt_lines',
      'warehouse_documents',
      'warehouse_document_lines',
      'stock_location_movements',
      'purchasing_source_versions',
      'purchasing_stock_changes',
    ])
      result[table] = (
        await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
          tenant,
        ])
      ).rows;
    return result;
  }
  const beforeExecutionRetry = await effects();
  assert.deepEqual((await execute(pr, approval, 200)).execution, e);
  assert.deepEqual(await effects(), beforeExecutionRetry);
  const placed = await ok('/purchase-orders/' + poId + '/place', 'POST', {
    version: draft.version,
  });
  assert.equal(placed.state, 'ordered');
  const receiptBody = {
    version: placed.version,
    client_key: randomUUID(),
    lines: [{ product_id: p.id, quantity: 6, location: 'A-01' }],
  };
  const received = await ok('/purchase-orders/' + poId + '/receive', 'POST', receiptBody);
  assert.equal(received.replayed, false);
  assert.equal(received.order.state, 'partial');
  const partial = await ok('/purchase-orders/' + poId);
  assert.deepEqual(
    [
      partial.lines[0].quantity,
      partial.lines[0].received_quantity,
      partial.lines[0].closed_quantity,
      partial.lines[0].unit_cost,
    ],
    [18, 6, 0, 317],
  );
  const afterReceipt = await physical();
  for (const table of [
    'products',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
    'order_pick_items',
  ])
    assert.deepEqual(afterReceipt[table], before[table], table + ' must survive receipt unchanged');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [tenant, warehouse, p.id],
      )
    ).rows[0],
    { on_hand: 18, reserved: 7, available: 11 },
  );
  const receiptRows = (
    await pool.query('SELECT product_id,quantity FROM purchase_receipt_lines WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows;
  assert.deepEqual(receiptRows, [{ product_id: p.id, quantity: 6 }]);
  assert.equal(
    Number(
      (await pool.query('SELECT count(*) FROM purchase_receipts WHERE tenant_id=$1', [tenant]))
        .rows[0].count,
    ),
    1,
  );
  assert.equal(
    Number(
      (await pool.query('SELECT count(*) FROM wms_cost_layers WHERE tenant_id=$1', [tenant]))
        .rows[0].count,
    ),
    0,
  );
  const beforeReceiptRetry = await effects();
  const receiptRetry = await ok('/purchase-orders/' + poId + '/receive', 'POST', receiptBody);
  assert.equal(receiptRetry.replayed, true);
  assert.equal(receiptRetry.receipt_id, received.receipt_id);
  assert.deepEqual(await effects(), beforeReceiptRetry);

  const next = await preview({ ...input, client_key: randomUUID() }),
    nextRow = (await rows(base + '/previews/' + next.id + '/rows', 1))[0];
  assert.equal(nextRow.available, '11');
  assert.equal(nextRow.incoming_ordered_quantity, '12');
  assert.equal(nextRow.projected_available, '23');
  assert.equal(nextRow.status, 'unchanged');
  assert.equal(nextRow.recommended_quantity, '0');
  const contributors = await ok(
    base + '/previews/' + next.id + '/rows/' + nextRow.id + '/contributors',
  );
  assert.equal(contributors.meta.total, 1);
  assert.deepEqual(
    [
      contributors.data[0].source_id,
      contributors.data[0].quantity,
      contributors.data[0].received_quantity,
      contributors.data[0].closed_quantity,
      contributors.data[0].remaining_quantity,
    ],
    [poId, 18, 6, 0, '12'],
  );
  const nopBody = consent(next),
    nop = (await execute(next, nopBody)).execution;
  assert.deepEqual(nop.groups, []);
  assert.equal(nop.before_source_version, nop.after_source_version);
  assert.deepEqual(await physical(), afterReceipt);
  const closed = await ok('/purchase-orders/' + poId + '/close', 'POST', {
    version: partial.version,
    reason: 'QA118 literal close remaining12',
  });
  assert.equal(closed.state, 'closed');
  assert.deepEqual(
    [
      closed.lines[0].quantity,
      closed.lines[0].received_quantity,
      closed.lines[0].closed_quantity,
      closed.lines[0].unit_cost,
    ],
    [18, 6, 12, 317],
  );
  assert.deepEqual(await physical(), afterReceipt);
  const closedPlan = await preview({ ...input, client_key: randomUUID() }),
    closedRow = (await rows(base + '/previews/' + closedPlan.id + '/rows', 1))[0];
  assert.equal(closedRow.incoming_ordered_quantity, '0');
  assert.equal(closedRow.projected_available, '11');
  assert.equal(closedRow.recommended_quantity, '12');
  const beforeTerminalRetries = await effects();
  assert.equal(
    (await ok('/purchase-orders/' + poId + '/receive', 'POST', receiptBody)).replayed,
    true,
  );
  assert.deepEqual((await execute(pr, approval, 200)).execution, e);
  assert.deepEqual((await execute(next, nopBody, 200)).execution, nop);
  assert.deepEqual(await effects(), beforeTerminalRetries);
  assert.deepEqual(await frozen(), originalProof);
  assert.deepEqual(
    (await rows(base + '/executions/' + e.id + '/rows', 1))[0].stock_snapshot,
    approved.stock_snapshot,
  );
  assert.equal(
    Number(
      (await pool.query('SELECT count(*) FROM purchase_orders WHERE tenant_id=$1', [tenant]))
        .rows[0].count,
    ),
    1,
  );
  assert.equal(providers, 0);
});

test('multiple currencies generate only drafts, exact execute replay adds no effects and the next NOP has no PO', async () => {
  const ps = [await product(), await product()],
    pols = [
      await policy(ps[0], { unit_cost_minor: 0 }),
      await policy(ps[1], { currency: 'EUR', unit_cost_minor: 1001 }),
    ],
    input = body(ps, pols),
    p = await preview(input),
    approved = await rows(base + '/previews/' + p.id + '/rows', 2),
    before = await physical(),
    b = consent(p);
  const e = (await execute(p, b)).execution;
  assert.equal(e.groups.length, 2);
  assert.deepEqual(new Set(e.groups.map((g: Row) => g.currency)), new Set(['PLN', 'EUR']));
  for (const g of e.groups) {
    const po = await ok('/purchase-orders/' + g.purchase_order_id);
    assert.equal(po.state, 'draft');
    assert.equal(po.version, 1);
    assert.equal(po.lines[0].quantity, 18);
    assert.equal(po.replenishment_execution_id, e.id);
  }
  assert.deepEqual(await physical(), before);
  const saved = await evidence(),
    retry = await execute(p, b, 200);
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.execution, e);
  assert.deepEqual(await evidence(), saved);
  const er = await rows(base + '/executions/' + e.id + '/rows', 2);
  assert.deepEqual(
    er.map((r) => r.preview_row_id),
    approved.map((r) => r.id),
  );
  const next = await preview({ ...input, client_key: randomUUID() });
  assert.equal(next.purchase, 0);
  assert.equal(next.unchanged, 2);
  const beforeNop = (await evidence()).purchase_orders;
  const nop = (await execute(next)).execution;
  assert.equal(nop.groups.length, 0);
  assert.equal(nop.before_source_version, nop.after_source_version);
  assert.deepEqual((await evidence()).purchase_orders, beforeNop);
  assert.deepEqual(await physical(), before);
});

test('one conflict blocks all draft effects; unknown cost blocks purchase but allows a true NOP', async () => {
  const ps = [await product(), await product()],
    pols = [await policy(ps[0]), await policy(ps[1])],
    p = await preview(body(ps, pols));
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [ps[1].id]);
  const before = await evidence();
  assert.equal(
    (await request(base + '/previews/' + p.id + '/execute', 'POST', consent(p))).statusCode,
    409,
  );
  assert.deepEqual(await evidence(), before);
  const unknown = await product({ quantity: 0 }),
    pol = await policy(unknown, {
      unit_cost_minor: null,
      cost_valid_until: null,
      confirm_cost: false,
    }),
    invalid = await preview(body([unknown], [pol]));
  assert.equal(invalid.ready, false);
  assert.equal(invalid.invalid, 1);
  assert.equal(
    (await rows(base + '/previews/' + invalid.id + '/rows', 1))[0].unit_cost_minor,
    null,
  );
  const noBuy = await product({ quantity: 20 }),
    noCost = await policy(noBuy, {
      unit_cost_minor: null,
      cost_valid_until: null,
      confirm_cost: false,
    }),
    nop = await preview(body([noBuy], [noCost]));
  assert.equal(nop.ready, true);
  assert.equal(nop.unchanged, 1);
  await execute(nop);
});

test(
  'actual 500 rows are complete across pages and split deterministically into 200/200/100 draft lines',
  { timeout: 120000 },
  async () => {
    const ids = Array.from({ length: 500 }, () => randomUUID()).sort();
    await pool.query(
      `INSERT INTO products(id,tenant_id,sku,name,price,active,version) SELECT u.id,$1::uuid,'B118-'||u.id::text,'Boundary 118',0,true,1 FROM unnest($2::uuid[]) u(id)`,
      [tenant, ids],
    );
    // Genuine HTTP policies exercise the immutable initial request, canonical
    // hash and explicit cost confirmation; no fabricated policy receipts.
    const items: { product_id: string; product_version: number; policy_version: number }[] = [];
    for (const id of ids) {
      const pol = await policy(
        { id },
        {
          unit_cost_minor: 0,
          minimum_quantity: 1,
          target_quantity: 1,
          minimum_order_quantity: 1,
          order_multiple: 1,
        },
      );
      assert.equal(pol.version, 1);
      items.push({ product_id: id, product_version: 1, policy_version: pol.version });
    }
    const input = {
      client_key: randomUUID(),
      warehouse_id: warehouse,
      items,
    };
    const p = await preview(input);
    assert.equal(p.ready, true);
    assert.equal(p.total, 500);
    assert.deepEqual(
      p.groups.map((g: Row) => g.line_count),
      [200, 200, 100],
    );
    const all = await rows(base + '/previews/' + p.id + '/rows', 500);
    assert.deepEqual(
      all.map((r) => r.product_id),
      ids,
    );
    assert(
      all.every((r) => r.stock_snapshot.presence === false && r.stock_snapshot.version === null),
    );
    const e = (await execute(p)).execution;
    assert.deepEqual(
      e.groups.map((g: Row) => g.line_count),
      [200, 200, 100],
    );
    const receipt = await rows(base + '/executions/' + e.id + '/rows', 500);
    assert.deepEqual(
      receipt.map((r) => r.product_id),
      ids,
    );
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) FROM purchase_order_lines WHERE tenant_id=$1', [tenant]))
          .rows[0].count,
      ),
      500,
    );
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) FROM stock WHERE tenant_id=$1', [tenant])).rows[0].count,
      ),
      0,
    );
    assert.equal(
      (
        await request(base + '/previews', 'POST', {
          ...input,
          client_key: randomUUID(),
          items: [
            ...input.items,
            { product_id: randomUUID(), product_version: 1, policy_version: 1 },
          ],
        })
      ).statusCode,
      422,
    );
  },
);

test(
  'actual 201 rows split into 200+1 with complete receipts, exact replay and stock-free NOP',
  { timeout: 120000 },
  async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID()).sort();
    await pool.query(
      `INSERT INTO products(id,tenant_id,sku,name,price,active,version)
       SELECT u.id,$1::uuid,'B118-201-'||u.id::text,'Boundary 201',0,true,1
       FROM unnest($2::uuid[]) u(id)`,
      [tenant, ids],
    );
    const items: { product_id: string; product_version: number; policy_version: number }[] = [];
    for (const id of ids) {
      const pol = await policy(
        { id },
        {
          unit_cost_minor: 317,
          minimum_quantity: 1,
          target_quantity: 1,
          minimum_order_quantity: 1,
          order_multiple: 1,
        },
      );
      items.push({ product_id: id, product_version: 1, policy_version: pol.version });
    }
    const physicalBefore = await physical();
    const locationsBefore = (
      await pool.query(
        'SELECT to_jsonb(t) row FROM stock_location_movements t WHERE tenant_id=$1 ORDER BY 1',
        [tenant],
      )
    ).rows;
    const input = { client_key: randomUUID(), warehouse_id: warehouse, items };
    const p = await preview(input);
    assert.equal(p.ready, true);
    assert.equal(p.total, 201);
    assert.equal(p.purchase, 201);
    assert.deepEqual(
      p.groups.map((g: Row) => g.line_count),
      [200, 1],
    );
    assert.deepEqual(
      p.groups.map((g: Row) => g.total_minor),
      ['63400', '317'],
    );

    async function completePages(path: string, scopeHash: string) {
      const result: Row[] = [],
        sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const page = await ok(
          path + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        );
        assert.equal(page.meta.total, 201);
        assert.equal(page.scope_hash, scopeHash);
        sizes.push(page.data.length);
        result.push(...page.data);
        cursor = page.meta.cursor;
      } while (cursor);
      assert.deepEqual(sizes, [100, 100, 1]);
      assert.equal(new Set(result.map((r) => r.id)).size, 201);
      assert.deepEqual(
        result.map((r) => r.product_id),
        ids,
      );
      return result;
    }
    const approved = await completePages(base + '/previews/' + p.id + '/rows', p.scope_hash);
    assert(
      approved.every(
        (r) =>
          r.status === 'purchase' &&
          r.recommended_quantity === '1' &&
          r.stock_snapshot.presence === false &&
          r.stock_snapshot.version === null,
      ),
    );
    const consentBody = consent(p),
      executed = await execute(p, consentBody),
      e = executed.execution;
    assert.equal(executed.reused, false);
    assert.deepEqual(
      e.groups.map((g: Row) => g.line_count),
      [200, 1],
    );
    assert.equal(new Set(e.groups.map((g: Row) => g.purchase_order_id)).size, 2);
    for (const [index, g] of e.groups.entries()) {
      const po = await ok('/purchase-orders/' + g.purchase_order_id);
      assert.equal(po.state, 'draft');
      assert.equal(po.version, 1);
      assert.equal(po.replenishment_execution_id, e.id);
      assert.equal(po.replenishment_group_index, index);
      assert.equal(po.lines.length, index === 0 ? 200 : 1);
      assert.deepEqual(
        po.lines.map((r: Row) => r.product_id).sort(),
        ids.slice(index * 200, (index + 1) * 200),
      );
      assert(
        po.lines.every(
          (r: Row) =>
            r.quantity === 1 &&
            r.unit_cost === 317 &&
            r.received_quantity === 0 &&
            r.closed_quantity === 0,
        ),
      );
    }
    const receipts = await completePages(base + '/executions/' + e.id + '/rows', p.scope_hash);
    assert.deepEqual(
      receipts.map((r) => r.preview_row_id),
      approved.map((r) => r.id),
    );
    for (let i = 0; i < receipts.length; i++) {
      for (const key of [
        'recommended_quantity',
        'line_total_minor',
        'group_index',
        'stock_snapshot',
        'policy_snapshot',
      ])
        assert.deepEqual(receipts[i][key], approved[i][key]);
      assert.equal(
        receipts[i].purchase_order_id,
        e.groups[approved[i].group_index].purchase_order_id,
      );
    }
    const afterExecute = await evidence();
    const retry = await execute(p, consentBody, 200);
    assert.equal(retry.reused, true);
    assert.deepEqual(retry.execution, e);
    assert.deepEqual(await evidence(), afterExecute);
    assert.deepEqual(await physical(), physicalBefore);

    const next = await preview({ ...input, client_key: randomUUID() });
    assert.equal(next.total, 201);
    assert.equal(next.purchase, 0);
    assert.equal(next.unchanged, 201);
    assert.deepEqual(next.groups, []);
    const nopRows = await completePages(base + '/previews/' + next.id + '/rows', next.scope_hash);
    assert(
      nopRows.every(
        (r) =>
          r.status === 'unchanged' &&
          r.recommended_quantity === '0' &&
          r.incoming_draft_quantity === '1' &&
          r.projected_available === '1',
      ),
    );
    const beforeNop = await evidence(),
      nopBody = consent(next),
      nop = (await execute(next, nopBody)).execution;
    assert.equal(nop.before_source_version, nop.after_source_version);
    assert.deepEqual(nop.groups, []);
    assert.deepEqual((await evidence()).purchase_orders, beforeNop.purchase_orders);
    assert.deepEqual((await evidence()).purchase_order_lines, beforeNop.purchase_order_lines);
    await completePages(base + '/executions/' + nop.id + '/rows', next.scope_hash);
    const afterNop = await evidence();
    assert.deepEqual((await execute(next, nopBody, 200)).execution, nop);
    assert.deepEqual(await evidence(), afterNop);
    assert.deepEqual(await physical(), physicalBefore);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT to_jsonb(t) row FROM stock_location_movements t WHERE tenant_id=$1 ORDER BY 1',
          [tenant],
        )
      ).rows,
      locationsBefore,
    );
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) FROM stock WHERE tenant_id=$1', [tenant])).rows[0].count,
      ),
      0,
    );
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) FROM purchase_orders WHERE tenant_id=$1', [tenant]))
          .rows[0].count,
      ),
      2,
    );
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) FROM purchase_order_lines WHERE tenant_id=$1', [tenant]))
          .rows[0].count,
      ),
      201,
    );
    assert.equal(providers, 0);
  },
);

test('public API compound scopes and viewer deep projection never expose frozen costs', async () => {
  const p = await product(),
    pol = await policy(p),
    input = body([p], [pol]);
  const incoming = await ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'PLN',
      lines: [{ product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'PUB-118' }],
    },
    201,
  );
  const pr = await preview(input);
  const scopes = ['products:read', 'inventory:read', 'purchasing:read', 'purchasing:write'];
  const key = await ok('/developer/keys', 'POST', { name: 'QA118 full', scopes }, 201);
  const publicCall = (token: string, path: string, method: 'GET' | 'POST' = 'GET', payload?: Row) =>
    request('/v1' + base + path, method, payload, '', { authorization: 'Bearer ' + token });
  assert.equal((await publicCall(key.token, '/options')).statusCode, 200);
  const publicRows = await publicCall(key.token, '/previews/' + pr.id + '/rows');
  assert.equal(publicRows.statusCode, 200, publicRows.body);
  const row = publicRows.json().data[0] as Row;
  assert.equal(row.contributor_count, 1);
  const nested = '/previews/' + pr.id + '/rows/' + row.id + '/contributors';
  const contributors = await publicCall(key.token, nested);
  assert.equal(contributors.statusCode, 200, contributors.body);
  assert.equal(contributors.headers['cache-control'], 'no-store');
  assert.equal(contributors.json().meta.total, 1);
  assert.equal(contributors.json().meta.cursor, null);
  assert.equal(contributors.json().data.length, 1);
  assert.equal(contributors.json().data[0].source_id, incoming.id);
  assert.equal(contributors.json().data[0].remaining_quantity, '1');
  assert.equal(
    (await publicCall(key.token, '/previews/' + pr.id + '/rows/not-a-uuid/contributors'))
      .statusCode,
    422,
  );
  // This is a genuine row belonging to another preview, rather than a guessed
  // UUID: the parent binding must remain authoritative in the public mirror.
  const another = await preview({ ...input, client_key: randomUUID() });
  const foreignRow = (await rows(base + '/previews/' + another.id + '/rows', 1))[0];
  assert.equal(
    (await publicCall(key.token, '/previews/' + pr.id + '/rows/' + foreignRow.id + '/contributors'))
      .statusCode,
    404,
  );
  for (const removed of scopes) {
    const partial = await ok(
      '/developer/keys',
      'POST',
      { name: 'QA118 minus ' + removed, scopes: scopes.filter((s) => s !== removed) },
      201,
    );
    assert.equal(
      (await publicCall(partial.token, '/previews', 'POST', { ...input, client_key: randomUUID() }))
        .statusCode,
      403,
    );
    if (removed !== 'purchasing:write') {
      assert.equal((await publicCall(partial.token, '/options')).statusCode, 403);
      assert.equal((await publicCall(partial.token, nested)).statusCode, 403);
    } else assert.equal((await publicCall(partial.token, '/options')).json().can_manage, false);
  }
  for (const path of [
    '/policies?warehouse_id=' + warehouse,
    '/previews/' + pr.id,
    '/previews/' + pr.id + '/rows',
  ]) {
    const r = await request(base + path, 'GET', undefined, viewer);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().can_read_value, false);
    for (const hidden of [
      'unit_cost_minor',
      'line_total_minor',
      'cost_valid_until',
      'cost_confirmed_at',
      'total_minor',
    ])
      assert(!r.body.includes('"' + hidden + '"'));
  }
  const fresh = await publicCall(key.token, '/previews', 'POST', {
    ...input,
    client_key: randomUUID(),
  });
  assert.equal(fresh.statusCode, 201, fresh.body);
  assert.equal(
    (
      await publicCall(
        key.token,
        '/previews/' + fresh.json().preview.id + '/execute',
        'POST',
        consent(fresh.json().preview),
      )
    ).statusCode,
    201,
  );
});

test(
  'B2B buyer orders remain confirmed incoming after genuine partial PZ without reading supplier stock',
  { timeout: 120000 },
  async () => {
    // Genuine supplier/account/link/catalog/checkout records, not disconnected raw
    // purchase rows. Transport must remain unused throughout this local network.
    const supplierTenant = tenant,
      supplierWh = warehouse,
      supplierCookie = admin;
    const sp = await product({ quantity: 12 }),
      list = await ok(
        '/price-lists',
        'POST',
        { name: 'Network 118 ' + randomUUID(), currency: 'PLN' },
        201,
      );
    await ok('/price-lists/' + list.id + '/items', 'PUT', {
      version: list.version,
      items: [{ product_id: sp.id, price: 12345 }],
    });
    const accountBody = {
      name: 'Buyer118',
      email: randomUUID() + '@example.test',
      warehouse_id: warehouse,
      price_list_id: list.id,
      address: { street: 'Own 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
      min_total: 0,
      min_quantity: 1,
      quantity_step: 1,
      shipping_cost: 0,
      payment_mode: 'prepaid',
    };
    const account = await ok('/b2b/accounts', 'POST', accountBody, 201),
      active = await ok('/b2b/accounts/' + account.id, 'PATCH', {
        ...accountBody,
        version: 1,
        active: true,
        confirmed: true,
      });
    const invitation = await ok('/b2b/accounts/' + account.id + '/network-invite', 'POST', {
      version: active.version,
      recipient_email: 'other@demo.local',
      confirmed: true,
    });
    const buyerTenant = randomUUID(),
      buyerWh = randomUUID();
    await pool.query(
      "INSERT INTO tenants(id,name,plan) VALUES($1,'QA118 network buyer','enterprise')",
      [buyerTenant],
    );
    await pool.query(
      "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'admin' FROM users WHERE email='other@demo.local'",
      [buyerTenant],
    );
    await pool.query(
      "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Buyer warehouse','BUYER118')",
      [buyerWh, buyerTenant],
    );
    const switched = await request('/workspaces/switch', 'POST', { tenant_id: buyerTenant }, other);
    assert.equal(switched.statusCode, 200, switched.body);
    const buyer = String(switched.headers['set-cookie']).split(';')[0];
    const network = await ok(
        '/b2b/network/accept',
        'POST',
        { token: invitation.token, confirmed: true },
        200,
        buyer,
      ),
      networkBase = '/b2b/network/links/' + network.id;
    const run = await ok(
      networkBase + '/refresh',
      'POST',
      { client_key: randomUUID(), confirmed: true },
      200,
      buyer,
    );
    for (let n = 0; n < 20; n++) {
      const current = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id]))
        .rows[0];
      if (current.state === 'done') break;
      const job = (
        await pool.query(
          "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
          [current.job_id, randomUUID()],
        )
      ).rows[0];
      await processB2bCatalog(job);
    }
    assert.equal(
      (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0].state,
      'done',
    );
    const item = (await ok(networkBase + '/catalog', 'GET', undefined, 200, buyer)).data.find(
      (x: Row) => x.source_product_id === sp.id,
    );
    assert(item);
    const imported = await ok(
      networkBase + '/catalog/' + item.id + '/product',
      'POST',
      {
        version: item.version,
        sku: 'BUYER-' + randomUUID(),
        sale_price: 1000,
        warehouse_id: buyerWh,
        confirmed: true,
      },
      200,
      buyer,
    );
    const bp = await ok('/products/' + imported.product_id, 'GET', undefined, 200, buyer),
      localSupplier = await ok(
        '/suppliers',
        'POST',
        { name: 'Reorder Supplier118', code: randomUUID() },
        201,
        buyer,
      ),
      pol = (
        await ok(
          base + '/policies',
          'POST',
          {
            client_key: randomUUID(),
            warehouse_id: buyerWh,
            product_id: bp.id,
            definition: definition({
              supplier_id: localSupplier.id,
              minimum_quantity: 2,
              target_quantity: 5,
            }),
          },
          201,
          buyer,
        )
      ).policy;
    const quote = await ok(
        networkBase + '/quotes',
        'POST',
        {
          client_key: randomUUID(),
          warehouse_id: buyerWh,
          items: [{ item_id: item.id, quantity: 3 }],
        },
        200,
        buyer,
      ),
      order = await ok(
        networkBase + '/quotes/' + quote.id + '/checkout',
        'POST',
        { confirmed: true },
        200,
        buyer,
      );
    const input = {
      client_key: randomUUID(),
      warehouse_id: buyerWh,
      items: [{ product_id: bp.id, product_version: bp.version, policy_version: pol.version }],
    };
    const before = (await ok(base + '/previews', 'POST', input, 201, buyer)).preview,
      r = (await ok(base + '/previews/' + before.id + '/rows', 'GET', undefined, 200, buyer))
        .data[0];
    assert.equal(r.available, '0');
    assert.equal(r.incoming_ordered_quantity, '3');
    assert.equal(r.status, 'unchanged');
    const con = await ok(
      base + '/previews/' + before.id + '/rows/' + r.id + '/contributors',
      'GET',
      undefined,
      200,
      buyer,
    );
    assert.equal(con.data[0].source_kind, 'b2b_network_order');
    assert.equal(con.data[0].source_id, order.id);
    await ok(
      '/orders/' + order.source_order_id + '/status',
      'PATCH',
      await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, 200, supplierCookie), '/orders/' + order.source_order_id + '/status', { status: 'paid' }),
      200,
      supplierCookie,
    );
    await ok(
      '/orders/' + order.source_order_id + '/status',
      'PATCH',
      await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, 200, supplierCookie), '/orders/' + order.source_order_id + '/status', { status: 'picking' }),
      200,
      supplierCookie,
    );
    for (let i = 0; i < 3; i++)
      await ok(
        '/orders/' + order.source_order_id + '/scan',
        'POST',
        { code: sp.sku },
        200,
        supplierCookie,
      );
    await ok(
      '/orders/' + order.source_order_id + '/status',
      'PATCH',
      await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, 200, supplierCookie), '/orders/' + order.source_order_id + '/status', { status: 'packed' }),
      200,
      supplierCookie,
    );
    await ok('/orders/' + order.source_order_id + '/ship-demo', 'POST', {}, 200, supplierCookie);
    await ok(
      '/b2b/network/orders/' + order.id + '/receipts',
      'POST',
      {
        client_key: randomUUID(),
        version: order.version,
        confirmed: true,
        lines: [{ product_id: bp.id, quantity: 1, location: 'B2B-01' }],
      },
      200,
      buyer,
    );
    const after = (
        await ok(base + '/previews', 'POST', { ...input, client_key: randomUUID() }, 201, buyer)
      ).preview,
      rr = (await ok(base + '/previews/' + after.id + '/rows', 'GET', undefined, 200, buyer))
        .data[0];
    assert.equal(rr.available, '1');
    assert.equal(rr.incoming_ordered_quantity, '2');
    assert.equal(rr.projected_available, '3');
    assert.equal(rr.status, 'unchanged');
    assert.equal(
      (
        await pool.query(
          'SELECT on_hand FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
          [supplierTenant, supplierWh, sp.id],
        )
      ).rows[0].on_hand,
      9,
    );
    assert.equal(providers, 0);
  },
);
