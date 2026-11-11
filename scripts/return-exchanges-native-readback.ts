/** Root-run QA138 GET/SQL readback only. Never creates a return, payment or shipment. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const phase = process.argv[2];
assert(
  phase === 'after-exchange' || phase === 'after-shipment',
  'Use after-exchange|after-shipment',
);
assert.notEqual(process.env.DYNA_TEST, 'true');
const root = '<workspace>/app';
const worktree = '<workspace>/worktrees/stock-file-import';
const ledgerPath = resolve(root, 'data/return-exchanges-stage138.json');
const outputTag = process.env.QA_OUTPUT_TAG;
if (outputTag) assert.match(outputTag, /^[a-z0-9-]{1,40}$/);
const reportPath = resolve(
  worktree,
  `docs/return-exchanges-native-${phase}${outputTag ? '-' + outputTag : ''}.json`,
);
const ledgerStat = await lstat(ledgerPath);
assert(ledgerStat.isFile() && !ledgerStat.isSymbolicLink());
assert.equal(ledgerStat.mode & 0o777, 0o600);
const ledgerBytes = await readFile(ledgerPath);
function parsePrivate(bytes: Buffer) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid private QA138 setup JSON; contents withheld');
  }
}
const state = parsePrivate(ledgerBytes);
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const normalize = (v: unknown) => JSON.parse(JSON.stringify(v));
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
assert.equal(state.stage, 138);
assert.equal(state.stage138, true);
assert.equal(state.setup_complete, true);
assert(state.pending === null, 'Unresolved setup mutation blocks readback');
assert.equal(state.schema_revision, '120_return_exchanges');
assert.match(state.runtime_revision ?? '', /^[a-f0-9]{40}$/);
for (const key of [
  'tenant_id',
  'user_id',
  'warehouse_id',
  'product_id',
  'order_id',
  'customer_item_id',
  'return_id',
])
  assert.match(state[key] ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
assert(state.born?.order && state.born?.return && state.born?.invoice);
assert.equal(state.born.order.id, state.order_id);
assert.equal(state.born.return.id, state.return_id);
assert.equal(state.born.order.items.length, 1);
assert.equal(state.born.order.items[0].id, state.customer_item_id);
assert.equal(state.born.product.stock[0].on_hand, 3);
assert.equal(state.born.product.stock[0].reserved, 0);
// db.ts creates a default config only when no explicit path exists. Refuse that
// path here: this readback must never create or rewrite runtime configuration.
assert.equal(
  resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''),
  resolve(root, '.local.json'),
  'Set DYNA_LOCAL_CONFIG_PATH to the existing primary .local.json',
);
const configStat = await lstat(resolve(root, '.local.json'));
assert(configStat.isFile() && !configStat.isSymbolicLink() && (configStat.mode & 0o777) === 0o600);
const { pool } = await import('../server/db').catch(() => {
  throw new Error('Cannot load existing native database configuration; details withheld');
});

async function get(path: string): Promise<any> {
  assert(path.startsWith('/') && !path.includes('..'));
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    headers: { cookie: state.cookie, 'X-Workspace-ID': state.tenant_id },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  assert.equal(response.status, 200, 'Own read-only HTTP status');
  if (path.startsWith('/reports/'))
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const text = await response.text();
  assert(Buffer.byteLength(text, 'utf8') <= 4 * 1024 * 1024, 'Readback response exceeds bound');
  return JSON.parse(text);
}
function originalFinancials(order: any) {
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
    ].map((key) => [key, order[key] ?? null]),
  );
}
const shipped = phase === 'after-shipment';
let report: Record<string, unknown>;
try {
  const health = await get('/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.mode, 'local');
  assert.equal(health.database, 'postgresql');
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, process.env.QA_EXPECTED_SCHEMA ?? '120_return_exchanges');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(health.return_exchanges_available, true);
  const me = await get('/auth/me');
  assert.equal(me.user.id, state.user_id);
  assert.equal(me.user.tenant_id, state.tenant_id);
  assert.equal(me.user.role, 'admin');
  const rma = await get('/returns/' + state.return_id);
  assert.equal(rma.id, state.return_id);
  assert.equal(rma.order_id, state.order_id);
  assert.equal(rma.state, 'closed');
  assert.equal(rma.remedy, 'exchange');
  assert.equal(rma.acceptance_kind, 'physical');
  assert(rma.received_at && rma.accepted_at);
  assert.equal(rma.refund_amount, 0);
  assert.equal(rma.refunded_shipping, 0);
  assert.equal(rma.settlement, null);
  assert.equal(rma.refunded_at, null);
  assert.equal(rma.documents.length, 0);
  assert.equal(rma.items.length, 1);
  assert.equal(rma.items[0].item_id, state.customer_item_id);
  assert.equal(rma.items[0].requested, 1);
  assert.equal(rma.items[0].accepted, 1);
  assert.equal(rma.items[0].restocked, 0);
  assert.equal(rma.items[0].refund_amount, 0);
  const exchange = rma.exchange;
  assert(exchange?.id && exchange.replacement_order_id);
  assert.equal(exchange.return_id, state.return_id);
  assert.match(exchange.scope_hash, /^[a-f0-9]{64}$/);
  const original = await get('/orders/' + state.order_id);
  const replacement = await get('/orders/' + exchange.replacement_order_id);
  assert.deepEqual(originalFinancials(original), originalFinancials(state.born.order));
  assert.deepEqual(original.items, state.born.order.items);
  assert.deepEqual(original.payment, state.born.order.payment);
  assert.deepEqual(original.documents, state.born.order.documents);
  assert.deepEqual(original.shipments, state.born.order.shipments);
  assert.equal(replacement.tenant_id, state.tenant_id);
  assert.equal(replacement.fulfillment_kind, 'replacement');
  assert.equal(replacement.replacement_return_id, state.return_id);
  assert.equal(replacement.status, shipped ? 'shipped' : 'paid');
  assert.equal(replacement.source, 'manual');
  assert.equal(replacement.payment_mode, 'prepaid');
  assert.equal(replacement.currency, 'PLN');
  assert.equal(replacement.total, 0);
  assert.equal(replacement.shipping_cost, 0);
  assert.equal(replacement.channel_id, null);
  assert.equal(replacement.external_id, null);
  assert.equal(replacement.source_snapshot, null);
  assert.equal(replacement.items.length, 1);
  const replacementItem = replacement.items[0];
  assert.equal(replacementItem.product_id, state.product_id);
  assert.equal(replacementItem.quantity, 1);
  assert.equal(replacementItem.price, 0);
  assert.equal(replacementItem.line_total, 0);
  assert.deepEqual(replacementItem.components, state.born.order.items[0].components);
  assert.equal(replacement.documents.length, 0);
  assert.equal(replacement.payment.received, 0);
  assert.equal(replacement.payment.amount_due, 0);
  assert.equal(replacement.picking_items.length, 1);
  assert.equal(replacement.picking_items[0].quantity, 1);
  assert.equal(replacement.picking_items[0].scanned, shipped ? 1 : 0);
  assert.equal(replacement.shipments.length, shipped ? 1 : 0);
  if (shipped) {
    assert.equal(replacement.shipments[0].mode, 'demo');
    assert(replacement.shipments[0].dispatched_at);
    assert.equal(replacement.shipments[0].cod_expected, 0);
  }
  assert.equal(exchange.replacement_order.id, replacement.id);
  assert.equal(exchange.replacement_order.status, replacement.status);
  const payments = await get('/orders/' + state.order_id + '/payments');
  assert.equal(payments.data.length, 1);
  assert.equal(payments.next, null);
  assert.equal(
    payments.data[0].id,
    state.completed.find((v: any) => v.step === 'synthetic-paid-declaration')?.id,
  );
  assert.equal(payments.data[0].amount, 30000);
  assert.equal(payments.data[0].kind, 'receipt');
  assert.equal(payments.data[0].method, 'other');
  const dashboard = await get('/dashboard');
  assert.equal(
    dashboard.orders.reduce((n: number, v: any) => n + v.count, 0),
    1,
  );
  assert.equal(
    dashboard.orders.reduce((n: bigint, v: any) => n + BigInt(v.total), 0n),
    30000n,
  );
  assert.equal(
    dashboard.orders.reduce((n: bigint, v: any) => n + BigInt(v.refund_total), 0n),
    0n,
  );
  assert(dashboard.recent.every((v: any) => v.id === state.order_id));
  const date = (at: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  const query = new URLSearchParams({
    from: date(state.born.order.created_at),
    to: date(new Date().toISOString()),
    currency: 'PLN',
  });
  const summary = await get('/reports/sales/summary?' + query);
  const detail = await get('/reports/sales/orders/' + state.order_id + '?' + query);
  const orders = await get('/reports/sales/orders?' + query);
  const returns = await get('/reports/sales/returns?' + query);
  assert.equal(summary.sales.length, 1);
  assert.equal(summary.sales[0].orders, 1);
  assert.equal(summary.sales[0].commercial_quantity, '3');
  assert.equal(summary.sales[0].total_gross_minor, '30000');
  assert.equal(orders.meta.total, 1);
  assert.equal(orders.data.length, 1);
  assert.equal(orders.data[0].id, state.order_id);
  assert.equal(detail.order.accepted_quantity, '0');
  assert.equal(detail.order.physically_accepted_quantity, '1');
  assert.equal(detail.order.restocked_quantity, '0');
  assert.equal(detail.order.returned_goods_gross_minor, '0');
  assert.equal(detail.order.margin_minor, null);
  assert.equal(detail.commercial_lines.length, 1);
  assert.equal(detail.commercial_lines[0].id, state.customer_item_id);
  assert.equal(detail.commercial_lines[0].accepted_quantity, '0');
  assert.equal(detail.commercial_lines[0].physically_accepted_quantity, '1');
  assert.equal(returns.meta.total, 1);
  assert.equal(returns.data[0].id, state.return_id);
  assert.equal(returns.data[0].remedy, 'exchange');
  assert.equal(returns.data[0].accepted_quantity, '1');
  assert.equal(returns.data[0].total_gross_minor, '0');

  const c = await pool.connect();
  let receiptHash = '';
  let financialHash = '';
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [state.tenant_id]);
    await c.query("SET LOCAL statement_timeout='8s'");
    const e = (
      await c.query(
        `SELECT e.id,e.tenant_id,e.return_id,e.original_order_id,e.replacement_order_id,e.actor_id,
      e.api_key_id,e.scope_hash,encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex') receipt_hash,
      r.receipt=((e.request-ARRAY['client_key','scope_hash','confirmed','warehouse_id'])||jsonb_build_object('shipping_refund',0)) exact_receipt
      FROM return_exchanges e JOIN return_cases r ON(r.tenant_id,r.id)=(e.tenant_id,e.return_id) WHERE e.return_id=$1`,
        [state.return_id],
      )
    ).rows;
    assert.equal(e.length, 1);
    assert.equal(e[0].tenant_id, state.tenant_id);
    assert.equal(e[0].id, exchange.id);
    assert.equal(e[0].original_order_id, state.order_id);
    assert.equal(e[0].replacement_order_id, replacement.id);
    assert.equal(e[0].actor_id, state.user_id);
    assert.equal(e[0].api_key_id, null);
    assert.equal(e[0].scope_hash, exchange.scope_hash);
    assert.equal(e[0].exact_receipt, true);
    receiptHash = e[0].receipt_hash;
    const links = (
      await c.query('SELECT * FROM return_exchange_items WHERE exchange_id=$1', [exchange.id])
    ).rows;
    assert.equal(links.length, 1);
    assert.equal(links[0].tenant_id, state.tenant_id);
    assert.equal(links[0].return_id, state.return_id);
    assert.equal(links[0].original_order_id, state.order_id);
    assert.equal(links[0].original_item_id, state.customer_item_id);
    assert.equal(links[0].replacement_order_id, replacement.id);
    assert.equal(links[0].replacement_item_id, replacementItem.id);
    assert.equal(links[0].product_id, state.product_id);
    assert.equal(links[0].accepted, 1);
    assert.equal(links[0].restocked, 0);
    assert.deepEqual(links[0].components, state.born.order.items[0].components);
    const allOrders = (await c.query('SELECT id,fulfillment_kind FROM orders ORDER BY id')).rows;
    assert.equal(allOrders.length, 2);
    assert.equal(allOrders.filter((v) => v.fulfillment_kind === 'replacement').length, 1);
    assert.equal((await c.query('SELECT count(*)::int n FROM return_exchanges')).rows[0].n, 1);
    assert.equal((await c.query('SELECT count(*)::int n FROM return_exchange_items')).rows[0].n, 1);
    const stock = (
      await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=$2', [
        state.warehouse_id,
        state.product_id,
      ])
    ).rows[0];
    assert.equal(stock.on_hand, shipped ? 2 : 3);
    assert.equal(stock.reserved, shipped ? 0 : 1);
    assert.equal(stock.available, 2);
    const reservation = (
      await c.query('SELECT * FROM reservations WHERE order_id=$1', [replacement.id])
    ).rows;
    assert.equal(reservation.length, 1);
    assert.equal(reservation[0].product_id, state.product_id);
    assert.equal(reservation[0].warehouse_id, state.warehouse_id);
    assert.equal(reservation[0].quantity, 1);
    assert.equal(reservation[0].state, shipped ? 'consumed' : 'active');
    const issue = (
      await c.query("SELECT * FROM stock_movements WHERE order_id=$1 AND kind='shipment'", [
        replacement.id,
      ])
    ).rows;
    assert.equal(issue.length, shipped ? 1 : 0);
    if (shipped) {
      assert.equal(issue[0].warehouse_id, state.warehouse_id);
      assert.equal(issue[0].product_id, state.product_id);
      assert.equal(issue[0].delta, -1);
    }
    const birthItems = normalize(
      (await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY sku', [state.order_id]))
        .rows,
    );
    assert.deepEqual(birthItems, state.born.order.items);
    const documents = normalize(
      (
        await c.query('SELECT * FROM documents WHERE order_id=$1 ORDER BY created_at', [
          state.order_id,
        ])
      ).rows,
    );
    assert.deepEqual(documents, state.born.order.documents);
    assert.equal(documents.length, 1);
    assert.deepEqual(documents[0], state.born.invoice);
    for (const table of ['payment_entries', 'documents', 'invoice_plans', 'odoo_invoice_exports']) {
      assert.equal(
        (
          await c.query(`SELECT count(*)::int n FROM "${table}" WHERE order_id=$1`, [
            replacement.id,
          ])
        ).rows[0].n,
        0,
      );
    }
    for (const table of ['invoice_plans', 'odoo_invoice_exports'])
      assert.equal(
        (
          await c.query(`SELECT count(*)::int n FROM "${table}" WHERE order_id=$1`, [
            state.order_id,
          ])
        ).rows[0].n,
        0,
      );
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM payment_entries WHERE return_id=$1', [
          state.return_id,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM stock_movements WHERE return_id=$1', [
          state.return_id,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal((await c.query('SELECT count(*)::int n FROM wms_policies')).rows[0].n, 0);
    const originalPayments = (
      await c.query(
        `SELECT count(*)::int n,sum(amount)::text amount,
      encode(sha256(convert_to(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text,'UTF8')),'hex') sha256
      FROM payment_entries p WHERE order_id=$1`,
        [state.order_id],
      )
    ).rows[0];
    assert.equal(originalPayments.n, 1);
    assert.equal(originalPayments.amount, '30000');
    financialHash = originalPayments.sha256;
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  if (shipped) {
    const previous = JSON.parse(
      await readFile(resolve(worktree, 'docs/return-exchanges-native-after-exchange.json'), 'utf8'),
    );
    assert.equal(previous.status, 'PASS_LOCAL_EXCHANGE_READBACK');
    assert.equal(previous.return_id, state.return_id);
    assert.equal(previous.replacement_order_id, replacement.id);
    assert.equal(previous.receipt_sha256, receiptHash);
    assert.equal(previous.original_payment_rows_sha256, financialHash);
    assert.equal(previous.private_setup_sha256, sha(ledgerBytes));
  }
  assert.equal(sha(await readFile(ledgerPath)), sha(ledgerBytes));
  report = {
    stage: 138,
    phase,
    status: shipped ? 'PASS_LOCAL_REPLACEMENT_SHIPMENT_READBACK' : 'PASS_LOCAL_EXCHANGE_READBACK',
    revision,
    setup_revision: state.runtime_revision,
    schema_revision: health.schema_revision,
    tenant_id: state.tenant_id,
    return_id: state.return_id,
    original_order_id: state.order_id,
    replacement_order_id: replacement.id,
    exchange_id: exchange.id,
    physical_received_quantity: 1,
    restocked_quantity: 0,
    refund_minor: 0,
    new_payment_minor: 0,
    stock_on_hand: shipped ? 2 : 3,
    stock_reserved: shipped ? 0 : 1,
    replacement_status: replacement.status,
    sales_orders: 1,
    sales_total_minor: 30000,
    economic_accepted_quantity: 0,
    receipt_sha256: receiptHash,
    original_payment_rows_sha256: financialHash,
    private_setup_sha256: sha(ledgerBytes),
    original_financial_fields_items_demo_invoice_and_payment_balance_match_setup: true,
    original_payment_full_rows_baseline:
      'After-exchange native SHA; setup identifies sole declared entry and exact amount/method/id, not a saved native SQL full-row baseline',
    sql_scope:
      'Own tenant, repeatable-read READ ONLY under dyna_app; no mutations or raw attack probes',
    monetary_provenance: 'Original synthetic local payment declaration only; no bank call',
    cost_margin_verified: false,
    wms_on_verified: false,
    provider_verified: false,
    chrome_verified: false,
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
      sales_orders: 1,
      exchange_receipts: 1,
      replacement_orders: 1,
      stock_on_hand: report.stock_on_hand,
      stock_reserved: report.stock_reserved,
    }),
  );
} catch {
  // Do not echo response objects, private setup fields, portal tokens or SQL diagnostics.
  process.exitCode = 1;
  console.error('QA138 readback failed; no mutation performed and no checkpoint overwritten.');
} finally {
  await pool.end();
}
