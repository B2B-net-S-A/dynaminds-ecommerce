import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { replenishmentAppendAvailable } from '../server/replenishment-plans';
import {
  replenishmentPreviewInput,
  replenishmentPolicyDefinitionInput,
} from '../server/replenishment-plans-schema';

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
    remoteAddress: '127.120.3.' + ip,
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
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA120 main','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE WHEN email='viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA120 warehouse','QA120')",
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
  supplier = (await ok('/suppliers', 'POST', { name: 'QA120 Supplier', code: randomUUID() }, 201))
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
      sku: 'QA120-' + randomUUID(),
      name: 'QA120 product',
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

const target = (po: Row) => ({
  supplier_id: po.supplier_id,
  currency: po.currency,
  purchase_order_id: po.id,
  version: po.version,
});
const draft = (lines: Row[], extra: Row = {}) =>
  ok(
    '/purchase-orders',
    'POST',
    {
      supplier_id: supplier,
      warehouse_id: warehouse,
      currency: 'PLN',
      reference: 'QA120 preserve reference',
      note: 'QA120 preserve note',
      expected_date: '2030-01-07',
      lines,
      ...extra,
    },
    201,
  );
async function frozenPO(id: string) {
  return {
    head: (
      await pool.query(
        'SELECT to_jsonb(p) head FROM purchase_orders p WHERE tenant_id=$1 AND id=$2',
        [tenant, id],
      )
    ).rows[0].head,
    lines: (
      await pool.query(
        'SELECT to_jsonb(l) line FROM purchase_order_lines l WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
        [tenant, id],
      )
    ).rows.map((r) => r.line),
  };
}
function keptHead(h: Row) {
  const { version, updated_at, ...kept } = h;
  return kept;
}
async function collectorEmpty() {
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM replenishment_append_preparations')).rows[0].n,
    0,
  );
}

test('strict canonical draft target identities reject duplicates and capability advertises explicit append', async () => {
  const p = await product(),
    pol = await policy(p),
    po = await draft([{ product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'SUP-001' }]),
    b = { ...body([p], [pol]), draft_targets: [target(po)] };
  assert.equal(await replenishmentAppendAvailable(pool), true);
  assert.equal((await ok(base + '/options')).append_available, true);
  assert(replenishmentPreviewInput.safeParse(b).success);
  for (const ts of [
    [target(po), target(po)],
    [{ ...target(po), version: 0 }],
    [{ ...target(po), unexpected: true }],
    [],
  ])
    assert(!replenishmentPreviewInput.safeParse({ ...b, draft_targets: ts }).success);
  const pr = await preview({
    ...b,
    draft_targets: [
      {
        ...target(po),
        purchase_order_id: po.id.toUpperCase(),
        supplier_id: po.supplier_id.toUpperCase(),
      },
    ],
  });
  assert.equal((await ok(base + '/previews', 'POST', b)).reused, true);
  assert.equal(pr.groups[0].destination.purchase_order_id, po.id);
  const choices = await ok(
    base +
      '/drafts?warehouse_id=' +
      warehouse +
      '&supplier_id=' +
      supplier +
      '&currency=PLN&limit=1',
  );
  assert.equal(choices.meta.total, 1);
  assert.deepEqual(
    [choices.data[0].id, choices.data[0].line_count, choices.data[0].total_minor],
    [po.id, 1, '317'],
  );
  const unrelated = await draft(
    [{ product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'SUP-001' }],
    { currency: 'EUR' },
  );
  const beforeReject = {
    physical: await physical(),
    evidence: await evidence(),
    previews: (
      await pool.query(
        'SELECT to_jsonb(h) row FROM replenishment_previews h WHERE tenant_id=$1 ORDER BY id',
        [tenant],
      )
    ).rows,
    previewRows: (
      await pool.query(
        'SELECT to_jsonb(r) row FROM replenishment_rows r WHERE tenant_id=$1 ORDER BY id',
        [tenant],
      )
    ).rows,
  };
  const rejected = await request(base + '/previews', 'POST', {
    ...body([p], [pol]),
    draft_targets: [target(unrelated)],
  });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.deepEqual(
    {
      physical: await physical(),
      evidence: await evidence(),
      previews: (
        await pool.query(
          'SELECT to_jsonb(h) row FROM replenishment_previews h WHERE tenant_id=$1 ORDER BY id',
          [tenant],
        )
      ).rows,
      previewRows: (
        await pool.query(
          'SELECT to_jsonb(r) row FROM replenishment_rows r WHERE tenant_id=$1 ORDER BY id',
          [tenant],
        )
      ).rows,
    },
    beforeReject,
  );
  // A restored immutable seal may share this database's new xid counter value,
  // but an older transaction clock cannot seal the current transaction.
  const legacy = await preview(body([p], [pol]));
  const execution = (await execute(legacy)).execution;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await c.query(
      "INSERT INTO replenishment_append_seals(tenant_id,execution_id,transaction_id,transaction_started_at) VALUES($1,$2,pg_current_xact_id(),transaction_timestamp()-interval '1 day')",
      [tenant, execution.id],
    );
    await c.query(
      'UPDATE purchase_order_lines SET quantity=quantity+1 WHERE tenant_id=$1 AND order_id=$2',
      [tenant, po.id],
    );
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('manual append preserves unrelated full metadata and line identities, adds only delta and exact receipt replays current history', async () => {
  const p = await product({ quantity: 5 }),
    fresh = await product({ quantity: 0 }),
    untouched = await product({ quantity: 2 }),
    pols = [await policy(p), await policy(fresh)],
    po = await draft([
      { product_id: p.id, quantity: 2, unit_cost: 317, supplier_sku: 'SUP-001' },
      { product_id: untouched.id, quantity: 3, unit_cost: 999, supplier_sku: 'KEEP-001' },
    ]),
    before = await frozenPO(po.id),
    physicalBefore = await physical(),
    pr = await preview({ ...body([p, fresh], pols), draft_targets: [target(po)] });
  assert.equal(pr.ready, true);
  assert.equal(pr.groups.length, 1);
  const g = pr.groups[0],
    d = g.destination;
  assert.deepEqual(d.snapshot, before);
  assert.deepEqual([d.line_count_before, d.line_count_after, d.total_before_minor], [2, 3, '3631']);
  const rs = await rows(base + '/previews/' + pr.id + '/rows', 2),
    byID = new Map(rs.map((r) => [r.product_id, r]));
  assert.deepEqual(
    [
      byID.get(p.id)!.incoming_draft_quantity,
      byID.get(p.id)!.projected_available,
      byID.get(p.id)!.recommended_quantity,
    ],
    ['2', '7', '18'],
  );
  assert.equal(byID.get(fresh.id)!.recommended_quantity, '24');
  assert.equal(d.total_after_minor, (3631n + 42n * 317n).toString());
  const approval = consent(pr),
    e = (await execute(pr, approval)).execution,
    after = await frozenPO(po.id);
  assert.equal(e.groups[0].purchase_order_id, po.id);
  assert.equal(e.groups[0].version, po.version + 1);
  assert.deepEqual(keptHead(after.head), keptHead(before.head));
  assert.equal(after.head.version, before.head.version + 1);
  assert.deepEqual(
    after.lines.find((l) => l.product_id === untouched.id),
    before.lines.find((l) => l.product_id === untouched.id),
  );
  assert.deepEqual(
    after.lines.find((l) => l.product_id === p.id),
    { ...before.lines.find((l) => l.product_id === p.id), quantity: 20 },
  );
  assert.deepEqual(
    [
      after.lines.find((l) => l.product_id === fresh.id)!.quantity,
      after.lines.find((l) => l.product_id === fresh.id)!.sku,
    ],
    [24, fresh.sku],
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    1,
  );
  assert.deepEqual(await physical(), physicalBefore);
  await collectorEmpty();
  const evidenceBefore = await evidence();
  assert.deepEqual((await execute(pr, approval, 200)).execution, e);
  assert.deepEqual(await evidence(), evidenceBefore);
  assert.deepEqual((await ok(base + '/executions/' + e.id)).execution.groups, e.groups);
  assert.deepEqual((await ok(base + '/executions')).data[0].groups, e.groups);
  const next = await preview({
    ...body([p, fresh], pols),
    draft_targets: [target({ ...po, version: after.head.version })],
  });
  assert.equal(next.unchanged, 2);
  const poBeforeNOP = await frozenPO(po.id);
  assert.equal((await execute(next)).execution.groups.length, 0);
  assert.deepEqual(await frozenPO(po.id), poBeforeNOP);
  assert.equal(providers, 0);
});

test('existing replenishment identity remains attached to its initial receipt when a later plan appends', async () => {
  const p = await product({ quantity: 0 }),
    pol = await policy(p, {
      minimum_quantity: 1,
      target_quantity: 5,
      minimum_order_quantity: 1,
      order_multiple: 1,
    }),
    original = await preview(body([p], [pol])),
    initial = (await execute(original)).execution,
    po = await ok('/purchase-orders/' + initial.groups[0].purchase_order_id),
    before = await frozenPO(po.id),
    patched = (
      await ok(base + '/policies/' + pol.id, 'PATCH', {
        version: pol.version,
        definition: definition({
          minimum_quantity: 8,
          target_quantity: 10,
          minimum_order_quantity: 1,
          order_multiple: 1,
          cost_valid_until: pol.cost_valid_until,
          confirm_cost: false,
        }),
      })
    ).policy,
    pr = await preview({ ...body([p], [patched]), draft_targets: [target(po)] }),
    e = (await execute(pr)).execution,
    after = await frozenPO(po.id);
  assert.equal(after.lines[0].quantity, 10);
  assert.equal(after.head.replenishment_execution_id, initial.id);
  assert.equal(after.head.replenishment_group_index, 0);
  assert.deepEqual(keptHead(after.head), keptHead(before.head));
  assert.notEqual(e.id, initial.id);
  assert.deepEqual((await ok(base + '/executions/' + initial.id)).execution, initial);
  await collectorEmpty();
});

test('forecast append counts target incoming once, freezes forecast and permits a subsequent ordinary partial receipt', async () => {
  const p = await product({ quantity: 5 }),
    pol = await policy(p, { minimum_quantity: 0, target_quantity: 999 }),
    order = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'QA120 local DEMO',
        email: 'qa120@example.test',
        payment_mode: 'cod',
        warehouse_id: warehouse,
        items: [{ product_id: p.id, quantity: 3 }],
      },
      201,
    );
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  for (let n = 0; n < 3; n++)
    await ok('/orders/' + order.id + '/scan', 'POST', { code: p.sku, location: 'A-01' });
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  await ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  const po = await draft([
      { product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'SUP-001' },
    ]),
    b = {
      ...body([p], [pol]),
      forecast: { lookback_days: 7, coverage_days: 14 },
      draft_targets: [target(po)],
    },
    pr = await preview(b),
    r = (await rows(base + '/previews/' + pr.id + '/rows', 1))[0];
  assert.deepEqual(
    [
      r.demand.shipped_quantity,
      r.available,
      r.incoming_draft_quantity,
      r.projected_available,
      r.effective_target_quantity,
      r.recommended_quantity,
    ],
    ['3', '2', '1', '3', '6', '6'],
  );
  const e = (await execute(pr)).execution;
  assert.deepEqual(e.config, pr.config);
  assert.equal(e.groups[0].purchase_order_id, po.id);
  const current = await ok('/purchase-orders/' + po.id);
  assert.equal(current.lines[0].quantity, 7);
  const placed = await ok('/purchase-orders/' + po.id + '/place', 'POST', {
      version: current.version,
    }),
    receipt = {
      client_key: randomUUID(),
      version: placed.version,
      lines: [{ product_id: p.id, quantity: 2, location: 'A-01' }],
    },
    received = await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt);
  assert.equal(received.order.state, 'partial');
  assert.equal(
    (await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt)).replayed,
    true,
  );
  const next = await preview({ ...body([p], [pol]), forecast: b.forecast });
  assert.equal(next.unchanged, 1);
  const nr = (await rows(base + '/previews/' + next.id + '/rows', 1))[0];
  assert.deepEqual(
    [nr.available, nr.incoming_ordered_quantity, nr.projected_available],
    ['4', '5', '9'],
  );
  assert.deepEqual((await ok(base + '/executions/' + e.id)).execution.groups, e.groups);
  await collectorEmpty();
  assert.equal(providers, 0);
});

test('cost or supplier-SKU mismatch and line quantity overflow make the whole preview invalid without fallback drafts', async () => {
  const p = await product({ quantity: 0 }),
    pol = await policy(p),
    before = await physical();
  for (const mismatch of [
    { quantity: 1, unit_cost: 318, supplier_sku: 'SUP-001' },
    { quantity: 1, unit_cost: 317, supplier_sku: 'OTHER' },
  ]) {
    const po = await draft([{ product_id: p.id, ...mismatch }]),
      pr = await preview({ ...body([p], [pol]), draft_targets: [target(po)] });
    assert.equal(pr.ready, false);
    assert.equal(pr.invalid, 1);
    assert.equal(pr.groups.length, 0);
    assert.equal(
      (await request(base + '/previews/' + pr.id + '/execute', 'POST', consent(pr))).statusCode,
      409,
    );
  }
  const large = await draft([
      { product_id: p.id, quantity: 999999, unit_cost: 317, supplier_sku: 'SUP-001' },
    ]),
    high = (
      await ok(base + '/policies/' + pol.id, 'PATCH', {
        version: pol.version,
        definition: definition({
          minimum_quantity: 1000003,
          target_quantity: 1000004,
          cost_valid_until: pol.cost_valid_until,
          confirm_cost: false,
        }),
      })
    ).policy,
    pr = await preview({ ...body([p], [high]), draft_targets: [target(large)] });
  assert.equal(pr.ready, false);
  assert.equal(pr.invalid, 1);
  assert(
    (await rows(base + '/previews/' + pr.id + '/rows', 1))[0].errors.some((v: string) =>
      v.includes('1000000'),
    ),
  );
  assert.deepEqual(await physical(), before);
  await collectorEmpty();
});

test('target 200 final lines is valid while the complete 201-product supplier bucket is never split', async () => {
  const ps = (
      await pool.query(
        "INSERT INTO products(id,tenant_id,sku,name,price) SELECT gen_random_uuid(),$1::uuid,'QA120-cap-'||i,'QA120 cap '||i,100 FROM generate_series(1,201) i RETURNING id,version",
        [tenant],
      )
    ).rows,
    po = await draft(
      ps
        .slice(0, 200)
        .map((p) => ({ product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'SUP-001' })),
    ),
    pol = await policy(ps[0]),
    pr = await preview({ ...body([ps[0]], [pol]), draft_targets: [target(po)] });
  assert.equal(pr.ready, true);
  assert.equal(pr.groups.length, 1);
  assert.equal(pr.groups[0].destination.line_count_after, 200);
  const e = (await execute(pr)).execution;
  assert.equal(e.groups[0].purchase_order_id, po.id);
  const current = await ok('/purchase-orders/' + po.id),
    newPol = await policy(ps[200]),
    before = await frozenPO(po.id),
    physicalBefore = await physical(),
    overflow = await preview({ ...body([ps[200]], [newPol]), draft_targets: [target(current)] });
  assert.equal(overflow.ready, false);
  assert.equal(overflow.invalid, 1);
  assert.equal(overflow.groups.length, 0);
  assert(
    (await rows(base + '/previews/' + overflow.id + '/rows', 1))[0].errors.some((v: string) =>
      v.includes('200'),
    ),
  );
  assert.equal(
    (await request(base + '/previews/' + overflow.id + '/execute', 'POST', consent(overflow)))
      .statusCode,
    409,
  );
  assert.deepEqual(await frozenPO(po.id), before);
  assert.deepEqual(await physical(), physicalBefore);
  await collectorEmpty();
});

test('full unrelated-line snapshot and current target version prevent stale append while fresh preview remains possible', async () => {
  const p = await product({ quantity: 0 }),
    otherP = await product(),
    pol = await policy(p),
    po = await draft([
      { product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'SUP-001' },
      { product_id: otherP.id, quantity: 2, unit_cost: 999, supplier_sku: 'KEEP' },
    ]),
    pr = await preview({ ...body([p], [pol]), draft_targets: [target(po)] });
  await pool.query(
    "UPDATE purchase_order_lines SET name='QA120 changed unrelated physical snapshot' WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3",
    [tenant, po.id, otherP.id],
  );
  const before = await frozenPO(po.id),
    evidenceBefore = await evidence();
  assert.equal(
    (await request(base + '/previews/' + pr.id + '/execute', 'POST', consent(pr))).statusCode,
    409,
  );
  assert.deepEqual(await frozenPO(po.id), before);
  assert.deepEqual(await evidence(), evidenceBefore);
  await collectorEmpty();
  const fresh = await preview({ ...body([p], [pol]), draft_targets: [target(po)] });
  assert.equal(fresh.ready, true);
  assert.equal((await execute(fresh)).execution.groups[0].version, po.version + 1);
});

test('old100 capability permits unchanged manual and forecast planning while explicit targets fail503', async () => {
  const p = await product({ quantity: 5 }),
    pol = await policy(p, { minimum_quantity: 5, target_quantity: 5 }),
    po = await draft([{ product_id: p.id, quantity: 1, unit_cost: 317, supplier_sku: 'SUP-001' }]);
  await pool.query(
    'ALTER FUNCTION replenishment_append_prepare(uuid,uuid,integer) RENAME TO qa120_hidden_prepare',
  );
  try {
    assert.equal((await ok(base + '/options')).append_available, false);
    for (const extra of [{}, { forecast: { lookback_days: 7, coverage_days: 14 } }]) {
      const b = { ...body([p], [pol]), ...extra },
        pr = await preview(b);
      assert.equal(pr.ready, true);
      assert.equal((await execute(pr)).execution.groups.length, 0);
    }
    assert.equal(
      (
        await request(base + '/previews', 'POST', {
          ...body([p], [pol]),
          draft_targets: [target(po)],
        })
      ).statusCode,
      503,
    );
  } finally {
    await pool.query(
      'ALTER FUNCTION qa120_hidden_prepare(uuid,uuid,integer) RENAME TO replenishment_append_prepare',
    );
  }
});
