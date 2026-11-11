/** Root-run QA139: GET and native RR READ ONLY proof. No login or business writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

type Row = Record<string, any>;
type Snapshot = Record<string, { count: number; sha256: string }>;
const primary = '<workspace>/app';
const wt = '<workspace>/worktrees/stock-file-import';
const setupPath = resolve(primary, 'data/return-exchanges-wms-stage139.json');
const checkpointPath = resolve(
  primary,
  'data/return-exchanges-wms-stage139-after-exchange-checkpoint.json',
);
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => sha(JSON.stringify(v));
const uuid = (v: unknown) =>
  assert.match(String(v ?? ''), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const phase = process.argv[2];
const shipped = phase === 'after-shipment';
let step = 'preflight';
let pool: Pool | undefined;

async function privateBytes(path: string) {
  const s = await lstat(path);
  assert(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o777) === 0o600);
  assert(s.size <= 32 * 1024 * 1024);
  return readFile(path);
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return;
    throw e;
  }
  throw new Error('Owned output already exists');
}
function one(rows: Row[]) {
  assert.equal(rows.length, 1);
  return rows[0]!;
}
const sum = (rows: Row[], key: string) => rows.reduce((n, r) => n + BigInt(r[key]), 0n);
function originalFields(o: Row) {
  return Object.fromEntries(
    [
      'id',
      'tenant_id',
      'source',
      'external_id',
      'channel_id',
      'customer_name',
      'email',
      'address',
      'currency',
      'total',
      'shipping_cost',
      'warehouse_id',
      'payment_mode',
      'price_list_id',
      'pricing_snapshot',
      'source_snapshot',
      'fulfillment_kind',
      'replacement_return_id',
    ].map((k) => [k, o[k] ?? null]),
  );
}

try {
  assert(phase === 'after-exchange' || phase === 'after-shipment');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(
    process.env.QA139_CHROME_VERIFIED,
    'true',
    'Explicit root Chrome attestation required',
  );
  const tag = process.env.QA_OUTPUT_TAG;
  if (tag) assert.match(tag, /^[a-z0-9-]{1,40}$/);
  const reportPath = resolve(
    wt,
    `docs/return-exchanges-wms-native-${phase}${tag ? '-' + tag : ''}.json`,
  );
  await absent(reportPath);
  if (!shipped) await absent(checkpointPath);
  const revision = process.env.QA_EXPECTED_REVISION;
  assert.match(revision ?? '', /^[a-f0-9]{40}$/);
  const schema = process.env.QA_EXPECTED_SCHEMA ?? '122_return_exchange_hashes';
  assert.match(schema, /^12[2-9]_[a-z0-9_]+$/);
  const setupBytes = await privateBytes(setupPath),
    state: Row = JSON.parse(setupBytes.toString('utf8'));
  assert.equal(state.stage, 139);
  assert.equal(state.stage139, true);
  assert.equal(state.setup_complete, true);
  assert.equal(state.pending, null);
  assert.match(state.runtime_revision ?? '', /^[a-f0-9]{40}$/);
  for (const k of [
    'tenant_id',
    'user_id',
    'main_warehouse_id',
    'replacement_warehouse_id',
    'bundle_id',
    'order_id',
    'customer_item_id',
    'return_id',
  ])
    uuid(state[k]);
  assert.notEqual(state.main_warehouse_id, state.replacement_warehouse_id);
  assert.equal(state.components.length, 2);
  const a = one(state.components.filter((c: Row) => c.recipe_quantity === 1));
  const b = one(state.components.filter((c: Row) => c.recipe_quantity === 2));
  uuid(a.id);
  uuid(b.id);
  assert.notEqual(a.id, b.id);
  assert.equal(a.unit_cost_minor, 0);
  assert.equal(b.unit_cost_minor, 1000);
  const born = state.source_born;
  assert.equal(born.order.id, state.order_id);
  assert.equal(born.return.id, state.return_id);
  assert.equal(born.order.total, 20000);
  assert.equal(born.order.currency, 'PLN');
  assert.equal(born.order.items.length, 1);
  assert.equal(born.order.items[0].id, state.customer_item_id);
  assert.equal(born.order.items[0].product_id, state.bundle_id);
  assert.equal(born.order.items[0].quantity, 2);
  assert.equal(born.order.items[0].vat, 23);
  assert.equal(born.order.items[0].line_total, 20000);
  assert.equal(born.return_fragments.length, 2);
  assert.equal(born.policy.enabled, true);
  assert.equal(born.purchased_valuation.valuation.known_minor, '8000');
  assert.equal(born.valuation.valuation.known_minor, '4000');
  assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(primary, '.local.json'));
  await privateBytes(resolve(primary, '.local.json'));
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
    assert.equal(u.pathname, '/dynaminds');
    assert.equal(u.port, '55432');
  }
  ({ pool } = await import('../server/db'));
  async function get(path: string): Promise<Row> {
    assert(path.startsWith('/') && !path.includes('..'));
    const response = await fetch('http://127.0.0.1:4100/api' + path, {
      headers: { cookie: state.cookie, 'X-Workspace-ID': state.tenant_id },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, 'Own read-only GET refused');
    if (path.startsWith('/reports/'))
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    const text = await response.text();
    assert(Buffer.byteLength(text) <= 4 * 1024 * 1024);
    return JSON.parse(text);
  }
  async function capture() {
    const c: PoolClient = await pool!.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      await c.query("SET LOCAL statement_timeout='8s'");
      const db = one(
        (
          await c.query(`SELECT current_database() db,current_user actor,
        host(inet_server_addr()) address,inet_server_port() port,current_setting('transaction_read_only') ro`)
        ).rows,
      );
      assert.equal(db.db, 'dynaminds');
      assert.equal(db.actor, 'postgres');
      assert.equal(db.ro, 'on');
      assert(['127.0.0.1', '::1'].includes(db.address));
      assert.equal(db.port, 55432);
      const tables = (
        await c.query(`SELECT c.table_name FROM information_schema.columns c
        JOIN pg_tables t ON(t.schemaname,t.tablename)=(c.table_schema,c.table_name)
        WHERE c.table_schema='public' AND c.column_name='tenant_id'
        AND c.table_name NOT IN('sessions','users') ORDER BY c.table_name`)
      ).rows;
      const rows: Record<string, Row[]> = {},
        snapshot: Snapshot = {};
      for (const t of tables) {
        assert.match(t.table_name, /^[a-z][a-z0-9_]*$/);
        rows[t.table_name] = (
          await c.query(
            `SELECT to_jsonb(t) row FROM public."${t.table_name}" t
          WHERE tenant_id=$1 ORDER BY 1`,
            [state.tenant_id],
          )
        ).rows;
      }
      for (const [table, id] of [
        ['users', state.user_id],
        ['tenants', state.tenant_id],
      ])
        rows[table!] = (
          await c.query(`SELECT to_jsonb(t) row FROM public."${table}" t WHERE id=$1 ORDER BY 1`, [
            id,
          ])
        ).rows;
      for (const [table, data] of Object.entries(rows))
        snapshot[table] = { count: data.length, sha256: hash(data) };
      const applied = one(
        (
          await c.query(
            `SELECT
        a.after_snapshot IS NOT NULL AND a.after_snapshot=e.snapshot->'after' exact_after,
        a.before_snapshot=e.snapshot->'before' exact_before,a.frame=e.snapshot->'frame' exact_frame,
        a.request=e.request exact_request,
        r.receipt=((e.request-ARRAY['client_key','scope_hash','confirmed','warehouse_id'])||jsonb_build_object('shipping_refund',0)) exact_receipt
        FROM return_exchanges e JOIN return_exchange_admissions a
          ON(a.tenant_id,a.return_id)=(e.tenant_id,e.return_id)
        JOIN return_cases r ON(r.tenant_id,r.id)=(e.tenant_id,e.return_id)
        WHERE e.tenant_id=$1 AND e.return_id=$2`,
            [state.tenant_id, state.return_id],
          )
        ).rows,
      );
      for (const v of Object.values(applied)) assert.equal(v, true);
      // API dates have millisecond precision. Prove that boundary in PostgreSQL;
      // preserve the full UTC native row (including microseconds) in the checkpoint.
      const invoiceDate = one(
        (
          await c.query(
            `SELECT date_trunc('milliseconds',created_at)=$3::timestamptz same_api_instant
        FROM documents WHERE tenant_id=$1 AND id=$2`,
            [state.tenant_id, born.invoice.id, born.invoice.created_at],
          )
        ).rows,
      );
      assert.equal(invoiceDate.same_api_instant, true);
      await c.query('COMMIT');
      return { rows, snapshot };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  step = 'health';
  const health = await get('/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.mode, 'local');
  assert.equal(health.database, 'postgresql');
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, schema);
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(health.return_exchanges_available, true);
  const me = await get('/auth/me');
  assert.equal(me.user.id, state.user_id);
  assert.equal(me.user.tenant_id, state.tenant_id);
  assert.equal(me.user.role, 'admin');
  step = 'native_before';
  const before = await capture();
  step = 'api_orders_returns';
  const rma = await get('/returns/' + state.return_id),
    e = rma.exchange;
  assert.equal(rma.remedy, 'exchange');
  assert.equal(rma.state, 'closed');
  assert.equal(rma.acceptance_kind, 'physical');
  assert(rma.received_at && rma.accepted_at);
  assert.equal(rma.refund_amount, 0);
  assert.equal(rma.refunded_shipping, 0);
  assert.equal(rma.settlement, null);
  assert.equal(rma.refunded_at, null);
  assert.deepEqual(rma.documents, []);
  const rmaItem = one(rma.items);
  assert.equal(rmaItem.item_id, state.customer_item_id);
  assert.equal(rmaItem.requested, 1);
  assert.equal(rmaItem.accepted, 1);
  assert.equal(rmaItem.restocked, 1);
  assert.equal(rmaItem.refund_amount, 0);
  uuid(e.id);
  uuid(e.replacement_order_id);
  assert.equal(e.return_id, state.return_id);
  const original = await get('/orders/' + state.order_id),
    replacement = await get('/orders/' + e.replacement_order_id);
  assert.deepEqual(originalFields(original), originalFields(born.order));
  for (const key of ['items', 'payment', 'documents', 'shipments'])
    assert.deepEqual(original[key], born.order[key]);
  assert.equal(replacement.fulfillment_kind, 'replacement');
  assert.equal(replacement.replacement_return_id, state.return_id);
  assert.equal(replacement.warehouse_id, state.replacement_warehouse_id);
  assert.equal(replacement.status, shipped ? 'shipped' : 'paid');
  assert.equal(replacement.total, 0);
  assert.equal(replacement.shipping_cost, 0);
  assert.equal(replacement.currency, 'PLN');
  assert.equal(replacement.source, 'manual');
  assert.equal(replacement.payment_mode, 'prepaid');
  for (const key of [
    'channel_id',
    'external_id',
    'source_snapshot',
    'price_list_id',
    'pricing_snapshot',
  ])
    assert.equal(replacement[key], null);
  assert.equal(replacement.payment.received, 0);
  assert.equal(replacement.payment.amount_due, 0);
  assert.deepEqual(replacement.documents, []);
  const item = one(replacement.items);
  assert.equal(item.product_id, state.bundle_id);
  assert.equal(item.quantity, 1);
  assert.equal(item.price, 0);
  assert.equal(item.line_total, 0);
  assert.deepEqual(item.components, born.order.items[0].components);
  assert.equal(replacement.picking_items.length, 2);
  for (const component of state.components) {
    const pick = one(replacement.picking_items.filter((r: Row) => r.product_id === component.id));
    assert.equal(pick.quantity, component.recipe_quantity);
    assert.equal(pick.scanned, shipped ? component.recipe_quantity : 0);
  }
  assert.equal(replacement.shipments.length, shipped ? 1 : 0);
  if (shipped) {
    const s = one(replacement.shipments);
    assert.equal(s.mode, 'demo');
    assert(s.dispatched_at);
    assert.equal(s.cod_expected, 0);
  }
  const payments = await get('/orders/' + state.order_id + '/payments');
  assert.equal(payments.data.length, 1);
  assert.equal(payments.next, null);
  assert.equal(payments.data[0].amount, 20000);
  assert.equal(payments.data[0].kind, 'receipt');
  assert.equal(payments.data[0].method, 'other');

  step = 'api_wms_reports';
  const valuation = await get('/wms-lots/valuation');
  assert.equal(valuation.can_read_value, true);
  assert.equal(valuation.valuation.currency, 'PLN');
  assert.equal(valuation.valuation.unknown_quantity, '0');
  assert.equal(valuation.valuation.known_minor, shipped ? '4000' : '6000');
  const date = (at: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  const q = new URLSearchParams({
    from: date(born.order.created_at),
    to: date(new Date().toISOString()),
    currency: 'PLN',
  });
  const summary = await get('/reports/sales/summary?' + q);
  const sales = one(summary.sales);
  assert.equal(sales.orders, 1);
  assert.equal(sales.commercial_quantity, '2');
  assert.equal(sales.total_gross_minor, '20000');
  const cohort = one(summary.cohort_current);
  assert.equal(cohort.net_known_cost_minor, shipped ? '4000' : '2000');
  assert.equal(cohort.margin_minor, shipped ? '12260' : '14260');
  const periodCost = one(summary.costs);
  assert.equal(periodCost.currency, 'PLN');
  assert.equal(periodCost.issued_quantity, shipped ? '9' : '6');
  assert.equal(periodCost.restocked_quantity, '3');
  assert.equal(periodCost.issued_known_minor, shipped ? '6000' : '4000');
  assert.equal(periodCost.restocked_known_minor, '2000');
  for (const key of [
    'issued_unknown_quantity',
    'restocked_unknown_quantity',
    'net_unknown_quantity',
  ])
    assert.equal(periodCost[key], '0');
  const periodReturns = one(summary.returns);
  assert.equal(periodReturns.cases, 1);
  assert.equal(periodReturns.accepted_quantity, '1');
  assert.equal(periodReturns.restocked_quantity, '1');
  assert.equal(periodReturns.total_gross_minor, '0');
  const detail = await get('/reports/sales/orders/' + state.order_id + '?' + q);
  assert.equal(detail.can_read_value, true);
  assert.equal(detail.order.commercial_quantity, '2');
  assert.equal(detail.order.accepted_quantity, '0');
  assert.equal(detail.order.physically_accepted_quantity, '1');
  assert.equal(detail.order.restocked_quantity, '1');
  assert.equal(detail.order.returned_goods_gross_minor, '0');
  assert.equal(detail.order.warranty_known_cost_minor, shipped ? '2000' : '0');
  assert.equal(detail.order.issued_known_cost_minor, shipped ? '6000' : '4000');
  assert.equal(detail.order.restocked_known_cost_minor, '2000');
  assert.equal(detail.order.net_known_cost_minor, shipped ? '4000' : '2000');
  assert.equal(detail.order.current_goods_net_minor, '16260');
  assert.equal(detail.order.cost_complete, true);
  assert.deepEqual(detail.order.cost_reasons, []);
  assert.equal(detail.order.margin_minor, shipped ? '12260' : '14260');
  assert.equal(detail.physical_costs.length, 2);
  for (const component of state.components) {
    const cost = one(detail.physical_costs.filter((r: Row) => r.product_id === component.id));
    assert.equal(cost.currency, 'PLN');
    assert.equal(cost.unknown_quantity, '0');
    assert.equal(cost.issued_quantity, String(component.recipe_quantity * 2));
    assert.equal(cost.restocked_quantity, String(component.recipe_quantity));
    assert.equal(
      cost.issued_known_minor,
      String(component.recipe_quantity * 2 * component.unit_cost_minor),
    );
    assert.equal(
      cost.restocked_known_minor,
      String(component.recipe_quantity * component.unit_cost_minor),
    );
  }
  const orders = await get('/reports/sales/orders?' + q),
    returns = await get('/reports/sales/returns?' + q),
    dashboard = await get('/dashboard');
  assert.equal(orders.meta.total, 1);
  assert.equal(one(orders.data).id, state.order_id);
  assert.equal(returns.meta.total, 1);
  const returned = one(returns.data);
  assert.equal(returned.id, state.return_id);
  assert.equal(returned.remedy, 'exchange');
  assert.equal(returned.accepted_quantity, '1');
  assert.equal(returned.restocked_quantity, '1');
  assert.equal(returned.total_gross_minor, '0');
  assert.equal(
    dashboard.orders.reduce((n: number, r: Row) => n + r.count, 0),
    1,
  );
  assert.equal(sum(dashboard.orders, 'total'), 20000n);
  assert.equal(sum(dashboard.orders, 'refund_total'), 0n);
  assert(dashboard.recent.every((r: Row) => r.id === state.order_id));

  step = 'native_fragments_custody';
  const native = before.rows;
  const rows = (table: string) => {
    assert(Array.isArray(native[table]));
    return native[table]!.map((r) => r.row);
  };
  assert.equal(rows('orders').length, 2);
  assert.equal(rows('return_exchanges').length, 1);
  assert.equal(rows('return_exchange_admissions').length, 1);
  const receipt = one(rows('return_exchanges'));
  assert.equal(receipt.id, e.id);
  assert.equal(receipt.return_id, state.return_id);
  assert.equal(receipt.original_order_id, state.order_id);
  assert.equal(receipt.replacement_order_id, replacement.id);
  assert.equal(receipt.actor_id, state.user_id);
  assert.equal(receipt.api_key_id, null);
  assert.equal(receipt.scope_hash, e.scope_hash);
  const link = one(rows('return_exchange_items'));
  assert.equal(link.original_item_id, state.customer_item_id);
  assert.equal(link.replacement_item_id, item.id);
  assert.equal(link.product_id, state.bundle_id);
  assert.equal(link.accepted, 1);
  assert.equal(link.restocked, 1);
  assert.deepEqual(link.components, born.order.items[0].components);
  const issues = rows('wms_issue_fragments').filter((r) => r.order_id === state.order_id);
  const restocks = rows('wms_return_fragments');
  const replacementIssues = rows('wms_issue_fragments').filter(
    (r) => r.order_id === replacement.id,
  );
  assert.equal(issues.length, 2);
  assert.equal(restocks.length, 2);
  assert.equal(replacementIssues.length, shipped ? 2 : 0);
  assert.equal(sum(issues, 'value_minor'), 4000n);
  assert.equal(sum(restocks, 'value_minor'), 2000n);
  assert.equal(sum(replacementIssues, 'value_minor'), shipped ? 2000n : 0n);
  const layers = rows('wms_cost_layers');
  assert.equal(layers.length, 4);
  assert.equal(rows('purchase_orders').length, 2);
  assert.equal(rows('purchase_receipts').length, 2);
  for (const layer of layers) {
    const component = one(state.components.filter((r: Row) => r.id === layer.product_id));
    assert.equal(String(layer.unit_cost_minor), String(component.unit_cost_minor));
    assert.equal(layer.currency, 'PLN');
    assert.equal(layer.quantity_received, component.recipe_quantity * 2);
    const purchase = one(
      state.purchases.filter((r: Row) => r.receipt_id === layer.purchase_receipt_id),
    );
    const received = one(
      rows('purchase_receipt_lines').filter(
        (r) => r.receipt_id === purchase.receipt_id && r.product_id === component.id,
      ),
    );
    assert.equal(received.order_id, purchase.id);
    assert.equal(received.quantity, component.recipe_quantity * 2);
    const purchaseLine = one(
      rows('purchase_order_lines').filter(
        (r) => r.order_id === purchase.id && r.product_id === component.id,
      ),
    );
    assert.equal(purchaseLine.unit_cost, component.unit_cost_minor);
    assert.equal(purchaseLine.received_quantity, component.recipe_quantity * 2);
  }
  const positions = rows('wms_layer_positions');
  let value = 0n;
  for (const p of positions) {
    const layer = one(layers.filter((l) => l.id === p.layer_id));
    assert.equal(layer.currency, 'PLN');
    assert.notEqual(layer.unit_cost_minor, null);
    value += BigInt(p.quantity) * BigInt(layer.unit_cost_minor);
  }
  assert.equal(value, shipped ? 4000n : 6000n);
  for (const component of state.components) {
    const source = one(issues.filter((r) => r.product_id === component.id));
    assert.equal(source.warehouse_id, state.main_warehouse_id);
    assert.equal(source.quantity, component.recipe_quantity * 2);
    assert.equal(String(source.unit_cost_minor), String(component.unit_cost_minor));
    assert.equal(String(source.value_minor), String(component.unit_cost_minor * source.quantity));
    const bornFragment = one(
      born.return_fragments.filter((r: Row) => r.product_id === component.id),
    );
    assert.equal(source.id, bornFragment.id);
    assert.equal(source.layer_id, bornFragment.layer_id);
    const restored = one(restocks.filter((r) => r.product_id === component.id));
    assert.equal(restored.issue_fragment_id, source.id);
    assert.equal(restored.layer_id, source.layer_id);
    assert.equal(restored.order_id, state.order_id);
    assert.equal(restored.return_id, state.return_id);
    assert.equal(restored.warehouse_id, state.main_warehouse_id);
    assert.equal(restored.quantity, component.recipe_quantity);
    assert.equal(
      String(restored.value_minor),
      String(component.recipe_quantity * component.unit_cost_minor),
    );
    assert.equal(restored.location, 'MAIN-RETURN');
    for (const wh of [state.main_warehouse_id, state.replacement_warehouse_id]) {
      const stock = one(
        rows('stock').filter((r) => r.warehouse_id === wh && r.product_id === component.id),
      );
      const expected =
        wh === state.main_warehouse_id || shipped
          ? component.recipe_quantity
          : component.recipe_quantity * 2;
      assert.equal(stock.on_hand, expected);
      assert.equal(
        stock.reserved,
        wh === state.main_warehouse_id || shipped ? 0 : component.recipe_quantity,
      );
      const pp = positions.filter((r) => r.warehouse_id === wh && r.product_id === component.id);
      assert.equal(sum(pp, 'quantity'), BigInt(expected));
      assert.equal(sum(pp, 'reserved'), BigInt(stock.reserved));
      assert.equal(
        sum(
          rows('stock_locations').filter(
            (r) => r.warehouse_id === wh && r.product_id === component.id,
          ),
          'quantity',
        ),
        BigInt(expected),
      );
    }
    const reservation = one(
      rows('reservations').filter(
        (r) => r.order_id === replacement.id && r.product_id === component.id,
      ),
    );
    assert.equal(reservation.quantity, component.recipe_quantity);
    assert.equal(reservation.warehouse_id, state.replacement_warehouse_id);
    assert.equal(reservation.state, shipped ? 'consumed' : 'active');
    const rr = rows('wms_reservation_layers').filter(
      (r) => r.order_id === replacement.id && r.product_id === component.id,
    );
    assert.equal(rr.length, 1);
    assert.equal(rr[0]!.quantity, component.recipe_quantity);
    assert.equal(rr[0]!.state, shipped ? 'consumed' : 'active');
    if (shipped) {
      const issued = one(replacementIssues.filter((r) => r.product_id === component.id));
      assert.equal(issued.warehouse_id, state.replacement_warehouse_id);
      assert.equal(issued.quantity, component.recipe_quantity);
      assert.equal(issued.layer_id, rr[0]!.layer_id);
      assert.notEqual(issued.layer_id, source.layer_id);
      assert.equal(String(issued.unit_cost_minor), String(component.unit_cost_minor));
      assert.equal(
        String(issued.value_minor),
        String(component.recipe_quantity * component.unit_cost_minor),
      );
    }
  }
  for (const table of ['payment_entries', 'documents', 'invoice_plans', 'odoo_invoice_exports']) {
    assert.equal(
      rows(table).filter((r) => r.order_id === replacement.id || r.return_id === state.return_id)
        .length,
      0,
    );
  }
  const cash = rows('payment_entries');
  assert.equal(cash.length, 1);
  assert.equal(cash[0]!.id, payments.data[0].id);
  assert.equal(cash[0]!.amount, 20000);
  assert.equal(rows('documents').length, 1);
  const withoutDate = ({ created_at: _date, ...other }: Row) => other;
  assert.deepEqual(withoutDate(rows('documents')[0]!), withoutDate(born.invoice));
  const immutable = Object.fromEntries(
    [
      'products',
      'bundle_components',
      'wms_cost_layers',
      'wms_lots',
      'purchase_orders',
      'purchase_order_lines',
      'purchase_receipts',
      'purchase_receipt_lines',
      'payment_entries',
      'documents',
      'return_cases',
      'return_items',
      'return_exchanges',
      'return_exchange_items',
      'return_exchange_admissions',
    ]
      .filter((t) => native[t])
      .map((t) => [t, native[t]]),
  );
  Object.assign(immutable, {
    original_header: rows('orders').filter((r) => r.id === state.order_id),
    original_items: rows('order_items').filter((r) => r.order_id === state.order_id),
    original_picks: rows('order_pick_items').filter((r) => r.order_id === state.order_id),
    original_shipments: rows('shipments').filter((r) => r.order_id === state.order_id),
    original_issues: issues,
    restocks,
    original_movements: rows('stock_movements').filter((r) => r.order_id === state.order_id),
    original_reservations: rows('reservations').filter((r) => r.order_id === state.order_id),
    original_layers: rows('wms_reservation_layers').filter((r) => r.order_id === state.order_id),
  });
  step = 'native_read_effects';
  const after = await capture();
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(sha(await privateBytes(setupPath)), sha(setupBytes));
  let checkpointBytes: Buffer;
  if (shipped) {
    checkpointBytes = await privateBytes(checkpointPath);
    const previous = JSON.parse(checkpointBytes.toString('utf8'));
    assert.equal(previous.stage, 139);
    assert.equal(previous.phase, 'after-exchange');
    assert.equal(previous.setup.sha256, sha(setupBytes));
    assert.equal(previous.setup.path, setupPath);
    assert.equal(previous.exchange_id, e.id);
    assert.equal(previous.replacement_order_id, replacement.id);
    assert.deepEqual(previous.immutable, immutable);
    assert.equal(hash(previous.snapshot), previous.snapshot_sha256);
    assert.equal(sha(await privateBytes(checkpointPath)), sha(checkpointBytes));
  } else {
    checkpointBytes = Buffer.from(
      JSON.stringify(
        {
          stage: 139,
          phase,
          revision,
          schema_revision: schema,
          setup: { path: setupPath, bytes: setupBytes.length, sha256: sha(setupBytes) },
          exchange_id: e.id,
          replacement_order_id: replacement.id,
          snapshot: before.snapshot,
          snapshot_sha256: hash(before.snapshot),
          immutable,
          api: { rma, original, replacement, payments, valuation, detail, summary },
        },
        null,
        2,
      ) + '\n',
    );
    await writeFile(checkpointPath, checkpointBytes, { flag: 'wx', mode: 0o600 });
  }
  step = 'public_report';
  const report = {
    stage: 139,
    phase,
    status: 'PASS_WMS_EXCHANGE_READBACK',
    revision,
    schema_revision: schema,
    setup_revision: state.runtime_revision,
    setup_sha256: sha(setupBytes),
    checkpoint_sha256: sha(checkpointBytes),
    snapshot_sha256: hash(before.snapshot),
    own_tables: Object.keys(before.snapshot).length,
    sessions_excluded: true,
    original_issue_cost_minor: '4000',
    restock_cost_minor: '2000',
    replacement_issue_cost_minor: shipped ? '2000' : '0',
    incurred_net_cogs_minor: shipped ? '4000' : '2000',
    goods_net_minor: '16260',
    current_as_of_margin_minor: shipped ? '12260' : '14260',
    replacement_dispatched: shipped,
    pending_replacement_cost_not_a_final_forecast: !shipped,
    valuation_known_minor: shipped ? '4000' : '6000',
    valuation_unknown_quantity: '0',
    known_zero_component_verified: true,
    physical_received: 1,
    restocked: 1,
    refund_minor: 0,
    new_payment_minor: 0,
    original_api_financials_items_documents_shipments_unchanged: true,
    original_and_exchange_native_rows_unchanged_between_phases: shipped,
    native_baseline_origin:
      'First SQL checkpoint after exchange; setup baseline is API-only. No pre-exchange SQL preservation claim.',
    timestamp_precision:
      'API invoice instant checked at its millisecond precision in PostgreSQL; native full UTC rows retain microseconds between phases.',
    native_reads_effect_free: true,
    sql_scope: 'Own tenant, owner RR READ ONLY UTC; full tenant table hashes, no mutation probes',
    chrome_verified_by_root_attestation: true,
    wms_on_verified: true,
    provider_verified: false,
    retry_verified: false,
    restart_verified: false,
    restore_verified: false,
    full_goal_complete: false,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      status: report.status,
      phase,
      net_cogs_minor: report.incurred_net_cogs_minor,
      valuation_minor: report.valuation_known_minor,
      own_tables: report.own_tables,
    }),
  );
} catch (error) {
  const e = error as { code?: string; stack?: string };
  const code = /^(?:[0-9A-Z]{5}|ERR_ASSERTION|ENOENT|EEXIST)$/.test(e.code ?? '')
    ? e.code
    : 'READBACK_FAILED';
  const frames = [
    ...(e.stack ?? '').matchAll(/return-exchanges-wms-native-readback\.ts:(\d+):\d+/g),
  ].map((m) => Number(m[1]));
  console.error(
    JSON.stringify({
      status: 'FAIL_WMS_EXCHANGE_READBACK',
      step,
      code,
      source_frames: [...new Set(frames)],
    }),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
