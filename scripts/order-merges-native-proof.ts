/** Own host-native QA122. Authoring this file does not run it.
 * setup creates four ordinary orders; Chrome alone performs both merges.
 * freeze_setup/readback/restart/fulfilment perform GET and SQL READ ONLY only.
 * A pending write is never retried automatically: inspect its private request
 * and real own readback before any further manually authorized recovery.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { pool } from '../server/db';

type Json = Record<string, any>;
type Fingerprint = Record<string, { count: number; sha256: string }>;
const phase = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION ?? 'f6319b8';
const schema = '105_order_merge_guards';
const statePath = 'data/order-merges-stage122.json';
const physicalTables = [
  'stock',
  'stock_locations',
  'products',
  'stock_movements',
  'stock_location_movements',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
];
const setupSteps = [
  'signup',
  'product',
  'main_first',
  'main_partial_receipt',
  'price_1700_first',
  'main_second',
  'price_1000_second',
  'technical_first',
  'technical_first_receipt',
  'technical_picking',
  'technical_scan',
  'price_1700_final',
  'technical_second',
  'technical_second_receipt',
];
assert(['setup', 'freeze_setup', 'readback', 'restart', 'fulfilment'].includes(phase));
assert(/^[a-f0-9]{7,40}$/.test(revision));
if (phase === 'restart')
  assert(
    process.env.QA_EXPECTED_REVISION,
    'Restart requires an explicitly selected current product revision',
  );
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function save(s: Json, fresh = false) {
  if (!fresh) {
    const stat = await lstat(statePath);
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o077, 0);
  }
  await writeFile(statePath, JSON.stringify(s, null, 2), {
    mode: 0o600,
    ...(fresh ? { flag: 'wx' } : {}),
  });
}
async function call(
  s: Json,
  path: string,
  method = 'GET',
  body?: Json,
  status = 200,
  extra: Record<string, string> = {},
) {
  assert(phase === 'setup' || method === 'GET', 'Readback must not mutate');
  assert(method === 'GET' || !path.startsWith('/order-merges'), 'Chrome alone merges');
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(
    response.status,
    status,
    `${method} ${path}: HTTP${response.status}; do not repeat an uncertain mutation`,
  );
  return { data: (await response.json()) as Json, response };
}
async function mutate(
  s: Json,
  key: string,
  path: string,
  method: string,
  body: Json,
  status: number,
) {
  assert.equal(phase, 'setup');
  assert(!s.setup_complete && !s.pending && !(key in s));
  const headers: Record<string, string> =
    path === '/orders' ? { 'Idempotency-Key': randomUUID() } : {};
  s.pending = { key, path, method, body, status, headers };
  await save(s);
  const r = await call(s, path, method, body, status, headers);
  s[key] = r.data;
  if (path === '/auth/signup') {
    const cookie = r.response.headers.get('set-cookie');
    assert(cookie && r.data.user?.id && r.data.user?.tenant_id);
    s.cookie = cookie.split(';')[0];
    s.user = r.data.user.id;
    s.tenant = r.data.user.tenant_id;
  }
  s.completed_steps.push(key);
  s.pending = null;
  // The identity/result and clearing pending are persisted together.
  await save(s);
  return r.data;
}
async function ownRead<T>(s: Json, fn: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const identity = (
      await c.query(
        `SELECT u.id,m.tenant_id,m.role FROM users u
      JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.tenant_id=$2`,
        [s.user, s.tenant],
      )
    ).rows[0];
    assert(identity && identity.role === 'admin' && identity.tenant_id === s.tenant);
    assert.equal(
      (await c.query('SELECT name FROM tenants WHERE id=$1', [s.tenant])).rows[0].name,
      s.organization_name,
    );
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function tableRows(c: PoolClient, s: Json, name: string) {
  assert(/^[a-z_][a-z0-9_]*$/.test(name));
  return (
    await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
      s.tenant,
    ])
  ).rows.map((r) => r.row) as Json[];
}
async function orderHeaderClocksUtc(c: PoolClient, header: Json): Promise<Json> {
  // Origin JSON retains the API connection's time-zone representation. Parse
  // only real orders timestamp columns through their SQL types in our UTC TX:
  // PostgreSQL preserves microseconds. Keep every other original JSON key/value
  // (including unexpected keys) so this cannot conceal header-data drift.
  const clocks = (
    await c.query(
      `SELECT coalesce(jsonb_object_agg(j.key,j.value),'{}'::jsonb) clocks
    FROM jsonb_each(to_jsonb(jsonb_populate_record(NULL::orders,$1::jsonb))) j
    JOIN pg_attribute a ON a.attrelid='orders'::regclass AND a.attname=j.key
      AND a.attnum>0 AND NOT a.attisdropped
      AND a.atttypid IN ('timestamp'::regtype,'timestamptz'::regtype)
    WHERE $1::jsonb ? j.key`,
      [JSON.stringify(header)],
    )
  ).rows[0].clocks;
  return { ...header, ...clocks };
}
async function checkpoint(c: PoolClient, s: Json): Promise<Fingerprint> {
  const names: string[] = (
    await c.query(`SELECT t.table_name FROM information_schema.tables t
    JOIN information_schema.columns k USING(table_schema,table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
    AND t.table_name<>'sessions' ORDER BY t.table_name`)
  ).rows.map((r) => r.table_name);
  const out: Fingerprint = {};
  for (const name of names) {
    const rows = await tableRows(c, s, name);
    out[name] = { count: rows.length, sha256: sha(rows) };
  }
  for (const name of ['tenants', 'users']) {
    const rows = (
      await c.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE id=$1 ORDER BY 1`, [
        name === 'users' ? s.user : s.tenant,
      ])
    ).rows;
    out[name] = { count: rows.length, sha256: sha(rows) };
  }
  assert(out.order_merge_claims && out.order_merge_custody_transfers && out.payment_entries);
  return out;
}
async function exactPhysical(c: PoolClient, s: Json) {
  const out: Fingerprint = {};
  for (const name of physicalTables) {
    const rows = await tableRows(c, s, name);
    out[name] = { count: rows.length, sha256: sha(rows) };
  }
  return out;
}
async function ownAuth(s: Json) {
  const me = (await call(s, '/auth/me')).data.user;
  assert(me && me.id === s.user && me.tenant_id === s.tenant && me.role === 'admin');
}
async function pages(s: Json, path: string) {
  const rows: Json[] = [];
  let cursor: string | null = null,
    total: number | undefined;
  const seen = new Set<string>();
  do {
    const r = await call(
      s,
      path + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(r.response.headers.get('cache-control'), 'no-store');
    assert(Array.isArray(r.data.data) && r.data.data.length <= 100);
    assert(Number.isInteger(r.data.meta.total) && r.data.meta.total <= 10000);
    total ??= r.data.meta.total;
    assert.equal(r.data.meta.total, total);
    rows.push(...r.data.data);
    cursor = r.data.meta.cursor;
    if (cursor) {
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  assert.equal(rows.length, total);
  return rows;
}
async function report(s: Json, status: string, evidence: Json) {
  const publicReport = {
    stage: 122,
    phase,
    status,
    source_revision: phase === 'restart' ? revision : s.runtime_revision,
    original_setup_revision: s.runtime_revision,
    schema_revision: s.schema_revision,
    tenant_id: s.tenant,
    product_id: s.product.id,
    warehouse_id: s.warehouse.id,
    helpers_performed_merges: false,
    chrome_attestation: 'Root separately verifies actual Chrome interactions',
    ...evidence,
  };
  await writeFile('docs/order-merges-native-qa.json', JSON.stringify(publicReport, null, 2));
  console.log(
    JSON.stringify({
      stage: 122,
      phase,
      status,
      tenant_id: s.tenant,
      source_revision: phase === 'restart' ? revision : s.runtime_revision,
      original_setup_revision: s.runtime_revision,
    }),
  );
}
async function assertNoProviders(c: PoolClient, s: Json, allowDemo = false) {
  for (const name of [
    'channels',
    // InPost and DPD both persist in shipping_plans; no dpd_shipping_plans table.
    'shipping_plans',
    'invoice_plans',
    'order_status_plans',
    'odoo_invoice_exports',
    'amazon_fulfillment_plans',
    'ebay_fulfillment_plans',
    'shopify_fulfillment_plans',
  ])
    assert.equal((await tableRows(c, s, name)).length, 0, `No ${name} provider setup`);
  const shipments = await tableRows(c, s, 'shipments');
  assert(
    allowDemo
      ? shipments.every(
          (r) =>
            r.mode === 'demo' &&
            r.carrier === 'Symulator lokalny' &&
            /^DEMO-/.test(r.tracking_number),
        )
      : shipments.length === 0,
  );
  const docs = await tableRows(c, s, 'documents');
  assert(allowDemo ? docs.every((r) => r.mode === 'demo') : docs.length === 0);
  if (!allowDemo) assert.equal((await tableRows(c, s, 'return_cases')).length, 0);
}
async function setup(s: Json) {
  await mutate(
    s,
    'signup',
    '/auth/signup',
    'POST',
    {
      email: s.email,
      password: s.password,
      name: 'QA122 Scalanie lokalne',
      organization: { name: s.organization_name, currency: 'PLN', locale: 'pl-PL' },
    },
    201,
  );
  await ownAuth(s);
  const options = (await call(s, '/order-merges/options')).data;
  assert(options.available && options.can_preview && options.can_execute);
  const warehouses = (await call(s, '/warehouses')).data.data;
  assert.equal(warehouses.length, 1);
  s.warehouse = warehouses[0];
  await save(s);
  await mutate(
    s,
    'product',
    '/products',
    'POST',
    {
      sku: 'QA122-' + s.suffix,
      name: 'QA122 Jeden SKU, różne ceny historyczne',
      ean: '001220000001',
      price: 1000,
      quantity: 40,
      warehouse_id: s.warehouse.id,
      location: 'QA122-A',
    },
    201,
  );
  const createOrder = async (key: string, qty: number, shipping: number, receiver: string) => {
    const o = await mutate(
      s,
      key,
      '/orders',
      'POST',
      {
        customer_name: receiver,
        email:
          receiver === 'QA122 Drugi odbiorca'
            ? 'qa122-other@example.test'
            : 'qa122-main@example.test',
        address: { city: 'QA122', street: receiver },
        currency: 'PLN',
        warehouse_id: s.warehouse.id,
        shipping_cost: shipping,
        note: 'QA122 synthetic native; no providers',
        items: [{ product_id: s.product.id, quantity: qty }],
      },
      201,
    );
    assert(o.id && o.tenant_id === s.tenant);
    return o;
  };
  const receipt = async (key: string, o: Json, amount: number) => {
    const current = (await call(s, '/orders/' + o.id)).data;
    await mutate(
      s,
      key,
      '/orders/' + o.id + '/payments',
      'POST',
      {
        client_key: randomUUID(),
        version: Number(current.version),
        kind: 'receipt',
        amount,
        currency: 'PLN',
        method: 'bank_transfer',
        reference: 'QA122 own declaration ' + key,
        note: 'QA122 synthetic local ledger; no charge',
        confirmed: true,
      },
      200,
    );
  };
  const price = async (key: string, amount: number) => {
    const current = (await call(s, '/products/' + s.product.id)).data;
    await mutate(s, key, '/products/' + s.product.id, 'PATCH', { ...current, price: amount }, 200);
  };
  const main1 = await createOrder('main_first', 2, 100, 'QA122 Pierwszy odbiorca');
  await receipt('main_partial_receipt', main1, 1000);
  await price('price_1700_first', 1700);
  await createOrder('main_second', 1, 200, 'QA122 Drugi odbiorca');
  await price('price_1000_second', 1000);
  const tech1 = await createOrder('technical_first', 1, 100, 'QA122 Pierwszy odbiorca');
  await receipt('technical_first_receipt', tech1, 1100);
  await mutate(
    s,
    'technical_picking',
    '/orders/' + tech1.id + '/status',
    'PATCH',
    { status: 'picking' },
    200,
  );
  await mutate(
    s,
    'technical_scan',
    '/orders/' + tech1.id + '/scan',
    'POST',
    { code: s.product.sku, location: 'QA122-A' },
    200,
  );
  await price('price_1700_final', 1700);
  const tech2 = await createOrder('technical_second', 1, 200, 'QA122 Pierwszy odbiorca');
  await receipt('technical_second_receipt', tech2, 1900);
  await freezeSetup(s);
}
async function freezeSetup(s: Json) {
  assert.equal(s.stage, 122);
  assert.equal(s.setup_complete, false);
  assert.equal(s.pending, null);
  assert(
    !s.setup_checkpoint && !s.setup_physical && !s.accepted_checkpoint && !s.readback_verified,
  );
  assert.deepEqual(s.completed_steps, setupSteps, 'Only the exact fourteen completed setup writes');
  for (const key of setupSteps)
    assert(s[key] && typeof s[key] === 'object', 'Missing completed setup result ' + key);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  for (const id of [
    s.user,
    s.tenant,
    s.warehouse?.id,
    s.product?.id,
    s.main_first?.id,
    s.main_second?.id,
    s.technical_first?.id,
    s.technical_second?.id,
  ])
    assert(typeof id === 'string' && uuid.test(id), 'All own setup identities must exist');
  assert.equal(
    new Set([s.main_first.id, s.main_second.id, s.technical_first.id, s.technical_second.id]).size,
    4,
  );
  await ownAuth(s);
  const options = (await call(s, '/order-merges/options')).data;
  assert(
    options.available &&
      options.can_preview &&
      options.can_execute &&
      options.current_role === 'admin',
  );
  const frozen = await ownRead(s, async (c) => {
    await assertNoProviders(c, s);
    assert.equal((await tableRows(c, s, 'order_merge_previews')).length, 0);
    assert.equal((await tableRows(c, s, 'order_merge_executions')).length, 0);
    const stocks = await tableRows(c, s, 'stock');
    assert.equal(stocks.length, 1);
    assert.deepEqual([stocks[0].on_hand, stocks[0].reserved, stocks[0].available], [40, 5, 35]);
    const orders = await tableRows(c, s, 'orders'),
      items = await tableRows(c, s, 'order_items');
    assert.equal(orders.length, 4);
    assert.equal(items.length, 4);
    for (const [id, qty, cost, shipping] of [
      [s.main_first.id, 2, 1000, 100],
      [s.main_second.id, 1, 1700, 200],
      [s.technical_first.id, 1, 1000, 100],
      [s.technical_second.id, 1, 1700, 200],
    ] as const) {
      const o = orders.find((x) => x.id === id),
        line = items.find((x) => x.order_id === id);
      assert(o && line);
      assert.deepEqual([line.quantity, line.price, o.shipping_cost], [qty, cost, shipping]);
    }
    const entries = await tableRows(c, s, 'payment_entries');
    assert.equal(entries.length, 3);
    assert.equal(
      entries.reduce((n, e) => n + e.amount, 0),
      4000,
    );
    const picks = await tableRows(c, s, 'order_pick_items');
    assert.equal(
      picks.reduce((n, p) => n + p.scanned, 0),
      1,
    );
    return {
      setup_checkpoint: await checkpoint(c, s),
      setup_physical: await exactPhysical(c, s),
      original_orders: orders,
      original_items: items,
      original_payment_entries: entries,
      original_reservations: await tableRows(c, s, 'reservations'),
      original_reservation_locations: await tableRows(c, s, 'reservation_locations'),
      original_picks: picks,
    };
  });
  Object.assign(s, frozen, { setup_complete: true, own_snapshot_timezone: 'UTC' });
  await save(s);
  await report(s, 'SETUP_PASS_UI_PENDING', {
    orders: 4,
    original_payment_entries: 3,
    on_hand: 40,
    reserved: 5,
    scanned: 1,
    setup_checkpoint_sha256: sha(s.setup_checkpoint),
    ui_cases: [
      {
        mode: 'into_main_order',
        main_order_id: s.main_first.id,
        other_order_id: s.main_second.id,
        receiver_ack_required: true,
        sum_delivery_costs: false,
        expected_shipping_cost_minor: 100,
        expected_total_minor: 3800,
        expected_received_minor: 1000,
        expected_due_minor: 2800,
      },
      {
        mode: 'technical_merge',
        main_order_id: s.technical_first.id,
        other_order_id: s.technical_second.id,
        receiver_ack_required: false,
        sum_delivery_costs: true,
        expected_shipping_cost_minor: 300,
        expected_total_minor: 3000,
        expected_received_minor: 3000,
        expected_scanned: 1,
      },
    ],
    shipping_cost_consent: 'MAIN: retain main shipping100; TECH: sum shipping100+200',
    optional_fulfilment:
      'TECH only: finish scan, pack, DEMO dispatch2, return expensive1700 fragment1. MAIN stays partially paid and reserved3.',
  });
}
async function mergeEvidence(c: PoolClient, s: Json, later = false) {
  const executions = await tableRows(c, s, 'order_merge_executions');
  assert.equal(executions.length, 2);
  const main = executions.find((e) => e.merge_mode === 'into_main_order');
  const tech = executions.find((e) => e.merge_mode === 'technical_merge');
  assert(main && tech);
  for (const [e, first, second, qty, total, received, scanned, sumShipping, shipping] of [
    [main, s.main_first.id, s.main_second.id, 3, 3800, 1000, 0, false, 100],
    [tech, s.technical_first.id, s.technical_second.id, 2, 3000, 3000, 1, true, 300],
  ] as const) {
    assert.equal(e.main_order_id, first);
    assert.deepEqual([...e.source_ids].sort(), [first, second].sort());
    assert.equal(e.actor_id, s.user);
    assert.equal(e.source, 'manual');
    assert.equal(e.receiver_conflict, e.merge_mode === 'into_main_order');
    if (e.receiver_conflict) assert.equal(e.request.confirmed_receiver_selection, true);
    assert.equal(e.sum_delivery_costs, sumShipping);
    assert.equal(e.total, 2);
    assert.equal(e.total_minor, total);
    assert.equal(e.shipping_cost, shipping);
    assert.equal(e.payment_balance.received, received);
    assert.equal(Number(e.physical_quantity), qty);
    assert.equal(Number(e.physical_scanned), scanned);
    assert.equal(e.target_status, scanned ? 'picking' : 'new');
    const rows = (await tableRows(c, s, 'order_merge_execution_rows')).filter(
      (r) => r.execution_id === e.id,
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.row.price).sort((a, b) => a - b),
      [1000, 1700],
    );
    for (const row of rows) {
      assert.equal(row.row.root_source_order_id, row.row.source_order_id);
      assert.equal(row.row.root_source_item_id, row.row.source_item_id);
      const original = s.original_items.find((i: Json) => i.id === row.row.source_item_id);
      assert(original && original.product_id === s.product.id);
      for (const k of [
        'product_id',
        'sku',
        'name',
        'quantity',
        'price',
        'vat',
        'line_total',
        'components',
      ])
        assert.deepEqual(row.row[k], original[k]);
    }
    const custody = (await tableRows(c, s, 'order_merge_custody_transfers')).find(
      (p) => p.execution_id === e.id,
    );
    assert(custody && custody.target_order_id === e.target_order_id);
    assert.deepEqual(custody.before_snapshot, e.before_snapshot.custody);
    // The immutable transfer records planned custody only; physical stock is
    // deliberately absent from after_snapshot. Read actual post-merge custody
    // and physical rows instead, before the separate fulfilment phase.
    if (!later) {
      const current = (
        await c.query('SELECT order_merge_custody_snapshot($1::uuid[]) AS snapshot', [
          [...new Set([...e.source_ids, e.target_order_id])],
        ])
      ).rows[0].snapshot;
      for (const k of ['stock', 'bins', 'positions'])
        assert.deepEqual(current[k], custody.before_snapshot[k]);
      for (const k of ['reservations', 'locations', 'layers'])
        assert.deepEqual(current[k], custody.after_snapshot[k]);
    }
    const sourceIds = e.source_ids as string[];
    const origins = (await tableRows(c, s, 'order_merge_origins')).filter((o) =>
      sourceIds.includes(o.order_id),
    );
    assert.equal(origins.length, 2);
    for (const origin of origins) {
      const original = s.original_orders.find((o: Json) => o.id === origin.order_id);
      assert.deepEqual(
        await orderHeaderClocksUtc(c, origin.header),
        await orderHeaderClocksUtc(c, { ...original, version: String(original.version) }),
      );
      assert.deepEqual(
        origin.items,
        s.original_items.filter((i: Json) => i.order_id === origin.order_id),
      );
    }
    const api = (await call(s, '/order-merges/executions/' + e.id)).data;
    assert.equal(api.execution.target_order_id, e.target_order_id);
    assert.equal(api.execution.scope_hash, e.scope_hash);
    assert.equal(api.execution.total_minor, total);
    const preview = (await call(s, '/order-merges/previews/' + e.preview_id)).data.preview;
    assert(preview.ready && preview.scope_hash === e.scope_hash);
    assert.equal(preview.target_order_id, e.target_order_id);
    assert.equal(preview.total_minor, total);
    const previewRows = await pages(s, '/order-merges/previews/' + e.preview_id + '/rows');
    assert.equal(previewRows.length, 2);
    for (const row of rows)
      assert.deepEqual(
        previewRows.find((r) => r.index === row.index),
        row.row,
      );
    assert.equal((await pages(s, '/order-merges/previews/' + e.preview_id + '/sources')).length, 2);
    const apiRows = await pages(s, '/order-merges/executions/' + e.id + '/rows');
    assert.equal(apiRows.length, 2);
    for (const row of rows)
      assert.deepEqual(
        apiRows.find((r) => r.index === row.index),
        { ...row.row, target_item_id: row.target_item_id },
      );
    assert.equal((await pages(s, '/order-merges/executions/' + e.id + '/sources')).length, 2);
    const physical = await pages(s, '/order-merges/executions/' + e.id + '/physical');
    assert.deepEqual(
      await pages(s, '/order-merges/previews/' + e.preview_id + '/physical'),
      physical,
    );
    assert.equal(
      physical.reduce((n, p) => n + p.quantity, 0),
      qty,
    );
    assert.equal(
      physical.reduce((n, p) => n + p.scanned, 0),
      scanned,
    );
    const target = (await call(s, '/orders/' + e.target_order_id)).data;
    assert.equal(target.total, total);
    assert.equal(target.items.length, 2);
    if (!later || e.merge_mode === 'into_main_order') {
      assert.equal(target.status, e.target_status);
      assert.equal(target.payment.received, received);
      assert.equal(target.payment.amount_due, total - received);
    }
  }
  assert.equal(main.target_order_id, s.main_first.id);
  assert(![s.technical_first.id, s.technical_second.id].includes(tech.target_order_id));
  const claims = await tableRows(c, s, 'order_merge_claims');
  assert.equal(claims.length, 3);
  for (const [source, target] of [
    [s.main_second.id, main.target_order_id],
    [s.technical_first.id, tech.target_order_id],
    [s.technical_second.id, tech.target_order_id],
  ]) {
    assert(claims.some((x) => x.source_order_id === source && x.target_order_id === target));
    const lineage = (await call(s, '/order-merges/orders/' + source + '/lineage')).data;
    assert.equal(lineage.owner_order_id, target);
    assert.equal(lineage.closed_source, true);
    assert.equal(lineage.origin.header.source_snapshot, undefined);
    assert.equal(lineage.origin.header.portal_token, undefined);
  }
  const orders = await tableRows(c, s, 'orders');
  for (const id of [s.main_second.id, s.technical_first.id, s.technical_second.id])
    assert.deepEqual(
      orders.find((o) => o.id === id),
      s.original_orders.find((o: Json) => o.id === id),
    );
  assert.equal(orders.length, 5);
  return {
    main_execution_id: main.id,
    technical_execution_id: tech.id,
    main_target_order_id: main.target_order_id,
    technical_target_order_id: tech.target_order_id,
    claims: 3,
    origins: 4,
    custody_proofs: 2,
    commercial_fragments: 4,
  };
}
async function readback(s: Json) {
  assert(!s.accepted_checkpoint, 'Accepted merge checkpoint is immutable; use restart');
  const result = await ownRead(s, async (c) => {
    const before = await checkpoint(c, s);
    const evidence = await mergeEvidence(c, s);
    await assertNoProviders(c, s);
    assert.deepEqual(await exactPhysical(c, s), s.setup_physical);
    assert.deepEqual(await tableRows(c, s, 'payment_entries'), s.original_payment_entries);
    const reservations = (await tableRows(c, s, 'reservations')).filter(
      (r) => r.state === 'active',
    );
    assert.equal(
      reservations.reduce((n, r) => n + r.quantity, 0),
      5,
    );
    const locations = (await tableRows(c, s, 'reservation_locations')).filter((r) =>
      reservations.some((x) => x.order_id === r.order_id && x.product_id === r.product_id),
    );
    assert.equal(
      locations.reduce((n, r) => n + r.quantity, 0),
      5,
    );
    assert.equal(
      locations.reduce((n, r) => n + r.scanned, 0),
      1,
    );
    assert.deepEqual(await checkpoint(c, s), before, 'GET readback has no own SQL effects');
    const targetIds = [evidence.main_target_order_id, evidence.technical_target_order_id];
    return {
      evidence,
      accepted_checkpoint: before,
      merge_target_headers: (await tableRows(c, s, 'orders')).filter((o) =>
        targetIds.includes(o.id),
      ),
    };
  });
  // Use a fresh snapshot: an RR snapshot alone cannot observe a GET's separately
  // committed side effects or a concurrent background mutation.
  await ownRead(s, async (c) =>
    assert.deepEqual(await checkpoint(c, s), result.accepted_checkpoint),
  );
  Object.assign(s, result, {
    accepted_evidence_sha256: sha(result.evidence),
    readback_verified: true,
    restart_verified: false,
  });
  await save(s);
  await report(s, 'MERGE_READBACK_PASS', {
    ...result.evidence,
    physical_unchanged: true,
    ledger_unchanged: true,
    on_hand: 40,
    reserved: 5,
    scanned: 1,
    accepted_checkpoint_tables: Object.keys(result.accepted_checkpoint).length,
    accepted_checkpoint_sha256: sha(result.accepted_checkpoint),
  });
}
async function restart(s: Json) {
  assert(s.accepted_checkpoint && s.readback_verified);
  const expected = s.fulfilment_verified ? s.fulfilment_checkpoint : s.accepted_checkpoint;
  const expectedEvidence = s.fulfilment_verified ? s.fulfilment_evidence : s.evidence;
  await ownRead(s, async (c) => {
    assert.deepEqual(await checkpoint(c, s), expected);
    const merge = await mergeEvidence(c, s, s.fulfilment_verified === true);
    for (const [key, value] of Object.entries(merge))
      assert.deepEqual(expectedEvidence[key], value);
    assert.deepEqual(await checkpoint(c, s), expected);
  });
  await ownRead(s, async (c) => assert.deepEqual(await checkpoint(c, s), expected));
  s.restart_verified = true;
  s.restart_revision = revision;
  await save(s);
  await report(s, 'RESTART_EXACT_PASS', {
    ...expectedEvidence,
    accepted_checkpoint_sha256: sha(s.accepted_checkpoint),
    restarted_checkpoint_sha256: sha(expected),
    restart_verified: true,
    restart_revision: revision,
  });
}
async function fulfilment(s: Json) {
  assert(s.readback_verified && s.accepted_checkpoint && !s.fulfilment_checkpoint);
  const result = await ownRead(s, async (c) => {
    const before = await checkpoint(c, s),
      evidence = await mergeEvidence(c, s, true);
    for (const name of [
      'order_merge_previews',
      'order_merge_preview_rows',
      'order_merge_executions',
      'order_merge_execution_rows',
      'order_merge_origins',
      'order_merge_claims',
      'order_merge_custody_transfers',
    ])
      assert.deepEqual(
        before[name],
        s.accepted_checkpoint[name],
        'Frozen merge history survives fulfilment',
      );
    await assertNoProviders(c, s, true);
    const shipments = await tableRows(c, s, 'shipments');
    const targetIds = [evidence.technical_target_order_id];
    assert.equal(shipments.length, 1);
    assert.equal(shipments[0].order_id, evidence.technical_target_order_id);
    assert.deepEqual(
      (await tableRows(c, s, 'orders')).find((o) => o.id === evidence.main_target_order_id),
      s.merge_target_headers.find((o: Json) => o.id === evidence.main_target_order_id),
      'MAIN remains untouched and partially paid',
    );
    const movements = await tableRows(c, s, 'stock_movements');
    const dispatched = movements
      .filter((x) => x.kind === 'shipment')
      .reduce((n, r) => n - r.delta, 0);
    const restocked = movements.filter((x) => x.kind === 'return').reduce((n, r) => n + r.delta, 0);
    assert.equal(dispatched, 2);
    assert.equal(restocked, 1);
    assert(
      movements
        .filter((x) => ['shipment', 'return'].includes(x.kind))
        .every(
          (x) =>
            targetIds.includes(x.order_id) &&
            x.product_id === s.product.id &&
            x.warehouse_id === s.warehouse.id,
        ),
    );
    const cases = await tableRows(c, s, 'return_cases');
    assert.equal(cases.length, 1);
    assert(cases.every((x) => targetIds.includes(x.order_id) && x.received_at));
    const returnItems = await tableRows(c, s, 'return_items');
    assert.equal(returnItems.length, 1);
    assert.equal(
      returnItems.reduce((n, r) => n + r.restocked, 0),
      restocked,
    );
    const commerce = await tableRows(c, s, 'order_items');
    for (const ri of returnItems) {
      const item = commerce.find((x) => x.id === ri.item_id && x.order_id === ri.order_id);
      assert(item && ri.sku === item.sku && ri.name === item.name);
      assert.equal(item.price, 1700);
      assert.equal(ri.accepted, 1);
      assert.equal(ri.restocked, 1);
      assert.deepEqual(ri.components, item.components);
      assert.equal(ri.refund_amount, ri.accepted * item.price);
    }
    assert.deepEqual(await tableRows(c, s, 'payment_entries'), s.original_payment_entries);
    const stock = await tableRows(c, s, 'stock');
    assert.equal(stock.length, 1);
    assert.deepEqual([stock[0].on_hand, stock[0].reserved], [39, 3]);
    const active = (await tableRows(c, s, 'reservations')).filter((r) => r.state === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].order_id, evidence.main_target_order_id);
    assert.equal(active[0].quantity, 3);
    const mainPicks = (await tableRows(c, s, 'order_pick_items')).filter(
      (p) => p.order_id === evidence.main_target_order_id,
    );
    assert.equal(mainPicks.length, 1);
    assert.deepEqual([mainPicks[0].quantity, mainPicks[0].scanned], [3, 0]);
    assert.deepEqual(await checkpoint(c, s), before);
    return {
      evidence: {
        ...evidence,
        dispatched,
        restocked,
        on_hand: stock[0].on_hand,
        reserved: 3,
        original_ledger_retained: true,
        main_unchanged: true,
      },
      fulfilment_checkpoint: before,
    };
  });
  await ownRead(s, async (c) =>
    assert.deepEqual(await checkpoint(c, s), result.fulfilment_checkpoint),
  );
  Object.assign(s, {
    fulfilment_checkpoint: result.fulfilment_checkpoint,
    fulfilment_evidence: result.evidence,
    fulfilment_verified: true,
    restart_verified: false,
  });
  await save(s);
  await report(s, 'FULFILMENT_RETURN_READBACK_PASS', {
    ...result.evidence,
    fulfilment_checkpoint_sha256: sha(result.fulfilment_checkpoint),
  });
}
try {
  const health = (await call({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, schema);
  assert.equal(health.restore_preview, false);
  assert.equal(health.order_merges_available, true);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8);
    const s: Json = {
      stage: 122,
      suffix,
      runtime_revision: revision,
      schema_revision: schema,
      organization_name: 'QA122 Native scalanie ' + suffix,
      email: 'qa122-merge-' + suffix + '@demo.local',
      password: 'DynaQa122!' + randomUUID(),
      setup_complete: false,
      pending: null,
      completed_steps: [],
      readback_verified: false,
      restart_verified: false,
    };
    await save(s, true);
    await setup(s);
  } else {
    const stat = await lstat(statePath);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
    const s: Json = JSON.parse(await readFile(statePath, 'utf8'));
    assert(s.stage === 122 && !s.pending);
    // A frontend-only product revision may change before restart acceptance.
    // Keep the original setup/proof revision and all raw checkpoints untouched.
    if (phase === 'restart')
      assert(typeof s.runtime_revision === 'string' && /^[a-f0-9]{7,40}$/.test(s.runtime_revision));
    else assert.equal(s.runtime_revision, revision);
    assert.equal(s.schema_revision, schema);
    await ownAuth(s);
    if (phase === 'freeze_setup') await freezeSetup(s);
    else {
      assert.equal(s.setup_complete, true);
      if (phase === 'readback') await readback(s);
      else if (phase === 'restart') await restart(s);
      else await fulfilment(s);
    }
  }
} catch (e) {
  let diagnosticSaved = false;
  const diagnosticPath = `data/order-merges-native-failure-${phase}-${randomUUID()}.txt`;
  try {
    await writeFile(diagnosticPath, e instanceof Error ? (e.stack ?? String(e)) : String(e), {
      mode: 0o600,
      flag: 'wx',
    });
    diagnosticSaved = true;
  } catch {
    // Do not overwrite an earlier diagnostic or mask the original failure.
  }
  console.error(
    JSON.stringify({
      stage: 122,
      phase,
      status: 'FAILED_MANUAL_READBACK_REQUIRED',
      state_path: statePath,
      credentials_printed: false,
      diagnostic_saved: diagnosticSaved,
      ...(diagnosticSaved ? { diagnostic_path: diagnosticPath } : {}),
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
