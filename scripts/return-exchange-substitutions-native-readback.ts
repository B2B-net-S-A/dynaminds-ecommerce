/** Root-run QA140. Only GET and owner RR READ ONLY; never creates an exchange or logs in. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

type Row = Record<string, any>;
type Snapshot = Record<string, { count: number; sha256: string }>;
type Native = { rows: Record<string, Row[]>; snapshot: Snapshot };
const root = '<workspace>/app';
const wt = '<workspace>/worktrees/stock-file-import';
const setupPath = resolve(root, 'data/return-exchange-substitutions-stage140.json');
const beforePath = resolve(
  root,
  'data/return-exchange-substitutions-stage140-before-exchange-checkpoint.json',
);
const exchangePath = resolve(
  root,
  'data/return-exchange-substitutions-stage140-after-exchange-checkpoint.json',
);
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => sha(JSON.stringify(v));
const uuid = (v: unknown) =>
  assert.match(String(v ?? ''), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const phase = process.argv[2];
const refused = phase === 'after-refused-preview';
const initial = phase === 'before-exchange' || refused,
  shipped = phase === 'after-shipment';
let step = 'preflight',
  pool: Pool | undefined;
const one = (rows: Row[]) => {
  assert.equal(rows.length, 1);
  return rows[0]!;
};
const sum = (rows: Row[], k: string) => rows.reduce((n, r) => n + BigInt(r[k]), 0n);
const recipe = (v: Row[]) =>
  v
    .map((r) => ({ product_id: r.product_id, quantity: r.quantity }))
    .sort((a, b) => (a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0));
const sorted = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).sort();
const omit = (row: Row, fields: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !fields.includes(k)));
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
function nativeRows(n: Native, table: string): Row[] {
  assert(Array.isArray(n.rows[table]), 'Required native table absent');
  return n.rows[table]!;
}
function retained(before: Row[], after: Row[]) {
  const counts = new Map<string, number>();
  for (const r of after) {
    const h = hash(r);
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  for (const r of before) {
    const h = hash(r),
      count = counts.get(h) ?? 0;
    assert(count > 0);
    counts.set(h, count - 1);
  }
}

try {
  assert(initial || phase === 'after-exchange' || shipped);
  assert.notEqual(process.env.DYNA_TEST, 'true');
  if (refused) assert.equal(process.env.QA140_REFUSAL_VERIFIED, 'true');
  if (!initial) assert.equal(process.env.QA140_CHROME_VERIFIED, 'true');
  const revision = process.env.QA_EXPECTED_REVISION;
  assert.match(revision ?? '', /^[a-f0-9]{40}$/);
  const schema = process.env.QA_EXPECTED_SCHEMA ?? '123_return_exchange_substitutions';
  assert.equal(schema, '123_return_exchange_substitutions');
  const tag = process.env.QA_OUTPUT_TAG;
  if (tag) assert.match(tag, /^[a-z0-9-]{1,40}$/);
  const reportPath = resolve(
    wt,
    `docs/return-exchange-substitutions-native-${phase}${tag ? '-' + tag : ''}.json`,
  );
  await absent(reportPath);
  if (phase === 'before-exchange') await absent(beforePath);
  else if (!initial && !shipped) await absent(exchangePath);
  const setupBytes = await privateBytes(setupPath),
    state: Row = JSON.parse(setupBytes.toString('utf8'));
  assert.equal(state.stage, 140);
  assert.equal(state.stage140, true);
  assert.equal(state.setup_complete, true);
  assert.equal(state.pending, null);
  assert.equal(state.schema_revision, schema);
  assert.match(state.runtime_revision ?? '', /^[a-f0-9]{40}$/);
  for (const k of [
    'tenant_id',
    'user_id',
    'main_warehouse_id',
    'replacement_warehouse_id',
    'bundle_id',
    'replacement_bundle_id',
    'order_id',
    'customer_item_id',
    'return_id',
  ])
    uuid(state[k]);
  assert.notEqual(state.main_warehouse_id, state.replacement_warehouse_id);
  assert.notEqual(state.bundle_id, state.replacement_bundle_id);
  const components: Row[] = state.components,
    targets: Row[] = state.target_components;
  assert.equal(components.length, 2);
  assert.equal(targets.length, 2);
  for (const list of [components, targets]) for (const c of list) uuid(c.id);
  assert.equal(new Set([...components, ...targets].map((c) => c.id)).size, 4);
  assert.equal(one(components.filter((c) => c.recipe_quantity === 1)).unit_cost_minor, 0);
  assert.equal(one(components.filter((c) => c.recipe_quantity === 2)).unit_cost_minor, 1000);
  assert.equal(one(targets.filter((c) => c.recipe_quantity === 1)).unit_cost_minor, 2500);
  assert.equal(one(targets.filter((c) => c.recipe_quantity === 2)).unit_cost_minor, 5000);
  const oldRecipe = recipe(
    components.map((c) => ({ product_id: c.id, quantity: c.recipe_quantity })),
  );
  const newRecipe = recipe(targets.map((c) => ({ product_id: c.id, quantity: c.recipe_quantity })));
  const born = state.source_born;
  assert.equal(born.order.id, state.order_id);
  assert.equal(born.return.id, state.return_id);
  const sourceItem = one(born.order.items);
  assert.equal(sourceItem.id, state.customer_item_id);
  assert.equal(sourceItem.product_id, state.bundle_id);
  assert.equal(sourceItem.quantity, 2);
  assert.equal(sourceItem.vat, 23);
  assert.equal(sourceItem.line_total, 20000);
  assert.deepEqual(recipe(sourceItem.components), oldRecipe);
  assert.equal(born.order.total, 20000);
  assert.equal(born.order.currency, 'PLN');
  assert.equal(born.policy.enabled, true);
  assert.equal(born.replacement_bundle.id, state.replacement_bundle_id);
  assert.equal(born.replacement_bundle.price, 25000);
  assert.equal(born.replacement_bundle.vat, 8);
  assert.deepEqual(recipe(born.replacement_bundle.components), newRecipe);
  assert.equal(born.valuation.valuation.known_minor, '25000');
  assert.equal(born.valuation.valuation.unknown_quantity, '0');
  assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
  await privateBytes(resolve(root, '.local.json'));
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
    assert.equal(u.pathname, '/dynaminds');
    assert.equal(u.port, '55432');
  }
  ({ pool } = await import('../server/db'));
  async function get(path: string): Promise<Row> {
    assert(path.startsWith('/') && !path.includes('..'));
    const r = await fetch('http://127.0.0.1:4100/api' + path, {
      headers: { cookie: state.cookie, 'X-Workspace-ID': state.tenant_id },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 200, 'Own GET refused');
    if (path.startsWith('/reports/'))
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    const text = await r.text();
    assert(Buffer.byteLength(text) <= 4 * 1024 * 1024);
    return JSON.parse(text);
  }
  async function capture(): Promise<Native> {
    const c: PoolClient = await pool!.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      await c.query("SET LOCAL statement_timeout='8s'");
      const db = one(
        (
          await c.query(`SELECT current_database() db,current_user actor,host(inet_server_addr()) address,
        inet_server_port() port,current_setting('transaction_read_only') ro`)
        ).rows,
      );
      assert.equal(db.db, 'dynaminds');
      assert.equal(db.actor, 'postgres');
      assert.equal(db.port, 55432);
      assert(['127.0.0.1', '::1'].includes(db.address));
      assert.equal(db.ro, 'on');
      const tables = (
        await c.query(`SELECT c.table_name FROM information_schema.columns c JOIN pg_tables t
        ON(t.schemaname,t.tablename)=(c.table_schema,c.table_name) WHERE c.table_schema='public'
        AND c.column_name='tenant_id' AND c.table_name NOT IN('sessions','users') ORDER BY c.table_name`)
      ).rows;
      const rows: Record<string, Row[]> = {},
        snapshot: Snapshot = {};
      for (const t of tables) {
        assert.match(t.table_name, /^[a-z][a-z0-9_]*$/);
        rows[t.table_name] = (
          await c.query(
            `SELECT to_jsonb(t) row FROM public."${t.table_name}" t WHERE tenant_id=$1 ORDER BY 1`,
            [state.tenant_id],
          )
        ).rows.map((r) => r.row);
      }
      for (const [table, id] of [
        ['users', state.user_id],
        ['tenants', state.tenant_id],
      ])
        rows[table!] = (
          await c.query(`SELECT to_jsonb(t) row FROM public."${table}" t WHERE id=$1 ORDER BY 1`, [
            id,
          ])
        ).rows.map((r) => r.row);
      for (const [table, rr] of Object.entries(rows))
        snapshot[table] = { count: rr.length, sha256: hash(rr) };
      assert.equal(Object.keys(snapshot).length, 348);
      // Preserve native microseconds. Only API invoice comparison uses its documented ms precision.
      const stamp = one(
        (
          await c.query(
            `SELECT date_trunc('milliseconds',created_at)=$3::timestamptz exact_api_time
        FROM documents WHERE tenant_id=$1 AND id=$2`,
            [state.tenant_id, born.invoice.id, born.invoice.created_at],
          )
        ).rows,
      );
      assert.equal(stamp.exact_api_time, true);
      if (!initial) {
        const proof = one(
          (
            await c.query(
              `SELECT a.after_snapshot=e.snapshot->'after' exact_after,
          a.before_snapshot=e.snapshot->'before' exact_before,a.frame=e.snapshot->'frame' exact_frame,
          a.request=e.request exact_request,r.receipt=return_exchange_receive_request(e.request) exact_receipt
          FROM return_exchanges e JOIN return_exchange_admissions a ON(a.tenant_id,a.id)=(e.tenant_id,e.id)
          JOIN return_cases r ON(r.tenant_id,r.id)=(e.tenant_id,e.return_id) WHERE e.tenant_id=$1 AND e.return_id=$2`,
              [state.tenant_id, state.return_id],
            )
          ).rows,
        );
        for (const v of Object.values(proof)) assert.equal(v, true);
      }
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
  assert.equal(health.return_exchange_substitutions_available, true);
  assert.equal(health.wms_lots_available, true);
  const me = await get('/auth/me');
  assert.equal(me.user.id, state.user_id);
  assert.equal(me.user.tenant_id, state.tenant_id);
  assert.equal(me.user.role, 'admin');
  step = 'native_before';
  const native = await capture();
  const rows = (table: string) => nativeRows(native, table);
  step = 'api_original';
  const original = await get('/orders/' + state.order_id),
    rma = await get('/returns/' + state.return_id);
  // The frozen baseline predates one additive list capability field. Permit only
  // absent -> true under the full current capability checked above; keep the
  // original setup/checkpoint bytes and every other API field unchanged.
  function originalAtBaselineProjection(current: Row, baseline: Row): Row {
    assert(Array.isArray(current.returns?.cases) && Array.isArray(baseline.returns?.cases));
    assert.equal(current.returns.cases.length, baseline.returns.cases.length);
    return {
      ...current,
      returns: {
        ...current.returns,
        cases: current.returns.cases.map((row: Row, index: number) => {
          const previous = baseline.returns.cases[index];
          assert.equal(row.id, previous.id);
          if (Object.hasOwn(previous, 'substitution_available')) return row;
          assert.equal(row.substitution_available, true);
          return omit(row, ['substitution_available']);
        }),
      },
    };
  }
  if (initial) {
    assert.deepEqual(originalAtBaselineProjection(original, born.order), born.order);
    assert.deepEqual(rma, born.return);
  }
  for (const key of ['items', 'picking_items', 'payment', 'documents', 'shipments'])
    assert.deepEqual(original[key], born.order[key]);
  assert.equal(original.total, 20000);
  assert.equal(original.fulfillment_kind, 'sale');
  assert.equal(original.payment.received, 20000);
  assert.equal(original.payment.amount_due, 0);
  const payments = await get('/orders/' + state.order_id + '/payments');
  assert.equal(payments.next, null);
  const payment = one(payments.data);
  assert.equal(payment.amount, 20000);
  assert.equal(payment.kind, 'receipt');
  assert.equal(payment.method, 'other');
  const api: Row = { original, rma, payments };
  let exchangeId: string | null = null,
    replacementId: string | null = null;
  if (initial) {
    assert.equal(rma.state, 'requested');
    assert.equal(rma.remedy, 'refund');
    assert.equal(rma.exchange, null);
    assert.equal(rows('orders').length, 1);
    for (const t of [
      'return_exchanges',
      'return_exchange_items',
      'return_exchange_admissions',
      'return_exchange_replacements',
      'wms_return_fragments',
    ])
      assert.equal(rows(t).length, 0);
  } else {
    step = 'api_replacement';
    assert.equal(rma.state, 'closed');
    assert.equal(rma.remedy, 'exchange');
    assert.equal(rma.acceptance_kind, 'physical');
    assert(rma.received_at && rma.accepted_at);
    assert.equal(rma.refund_amount, 0);
    assert.equal(rma.refunded_shipping, 0);
    assert.equal(rma.refunded_at, null);
    assert.equal(rma.settlement, null);
    assert.deepEqual(rma.documents, []);
    const ri = one(rma.items);
    assert.equal(ri.item_id, state.customer_item_id);
    assert.equal(ri.accepted, 1);
    assert.equal(ri.restocked, 1);
    assert.equal(ri.refund_amount, 0);
    const e = rma.exchange;
    uuid(e.id);
    uuid(e.replacement_order_id);
    exchangeId = e.id;
    replacementId = e.replacement_order_id;
    const replacement = await get('/orders/' + replacementId);
    api.replacement = replacement;
    assert.equal(replacement.fulfillment_kind, 'replacement');
    assert.equal(replacement.replacement_return_id, state.return_id);
    assert.equal(replacement.warehouse_id, state.replacement_warehouse_id);
    assert.equal(replacement.status, shipped ? 'shipped' : 'paid');
    assert.equal(replacement.source, 'manual');
    assert.equal(replacement.currency, 'PLN');
    assert.equal(replacement.payment_mode, 'prepaid');
    assert.equal(replacement.total, 0);
    assert.equal(replacement.shipping_cost, 0);
    for (const k of [
      'channel_id',
      'external_id',
      'source_snapshot',
      'price_list_id',
      'pricing_snapshot',
    ])
      assert.equal(replacement[k], null);
    assert.equal(replacement.payment.received, 0);
    assert.equal(replacement.payment.amount_due, 0);
    assert.deepEqual(replacement.documents, []);
    const item = one(replacement.items);
    assert.equal(item.product_id, state.replacement_bundle_id);
    assert.equal(item.quantity, 1);
    assert.equal(item.price, 0);
    assert.equal(item.line_total, 0);
    assert.equal(item.vat, 8);
    assert.equal(item.sku, born.replacement_bundle.sku);
    assert.equal(item.name, born.replacement_bundle.name);
    assert.deepEqual(recipe(item.components), newRecipe);
    assert.equal(replacement.picking_items.length, 2);
    for (const t of targets) {
      const pick = one(replacement.picking_items.filter((p: Row) => p.product_id === t.id));
      assert.equal(pick.quantity, t.recipe_quantity);
      assert.equal(pick.scanned, shipped ? t.recipe_quantity : 0);
    }
    assert.equal(replacement.shipments.length, shipped ? 1 : 0);
    if (shipped) {
      const s = one(replacement.shipments);
      assert.equal(s.mode, 'demo');
      assert(s.dispatched_at);
      assert.equal(s.cod_expected, 0);
    }
    assert.equal(rows('orders').length, 2);
    const receipt = one(rows('return_exchanges')),
      admission = one(rows('return_exchange_admissions'));
    assert.equal(receipt.id, e.id);
    assert.equal(receipt.original_order_id, state.order_id);
    assert.equal(receipt.replacement_order_id, replacementId);
    assert.equal(receipt.actor_id, state.user_id);
    assert.equal(receipt.api_key_id, null);
    assert.equal(receipt.scope_hash, e.scope_hash);
    assert.equal(admission.id, receipt.id);
    assert.equal(String(admission.frame.proof_version), '2');
    assert(admission.after_snapshot);
    assert.equal(receipt.request.items[0].replacement_product_id, state.replacement_bundle_id);
    const physical = {
      ...omit(receipt.request, ['client_key', 'scope_hash', 'confirmed', 'warehouse_id']),
      shipping_refund: 0,
      items: receipt.request.items.map((r: Row) => omit(r, ['replacement_product_id'])),
    };
    assert.deepEqual(rma.receipt, physical);
    const legacyLink = one(rows('return_exchange_items'));
    assert.equal(legacyLink.original_item_id, state.customer_item_id);
    assert.equal(legacyLink.product_id, state.bundle_id);
    assert.deepEqual(recipe(legacyLink.components), oldRecipe);
    assert.equal(legacyLink.accepted, 1);
    assert.equal(legacyLink.restocked, 1);
    const sidecar = one(rows('return_exchange_replacements'));
    assert.equal(sidecar.exchange_id, receipt.id);
    assert.equal(sidecar.original_item_id, state.customer_item_id);
    assert.equal(sidecar.replacement_order_id, replacementId);
    assert.equal(sidecar.replacement_item_id, item.id);
    assert.equal(sidecar.replacement_product_id, state.replacement_bundle_id);
    assert.equal(sidecar.quantity, 1);
    assert.deepEqual(recipe(sidecar.components), newRecipe);
    assert.equal(sidecar.product_snapshot.id, state.replacement_bundle_id);
    assert.equal(sidecar.product_snapshot.version, String(born.replacement_bundle.version));
    assert.equal(sidecar.product_snapshot.sku, item.sku);
    assert.equal(sidecar.product_snapshot.name, item.name);
    assert.equal(sidecar.product_snapshot.vat, 8);
    assert.equal(sidecar.product_snapshot.kind, 'bundle');
    assert.deepEqual(recipe(sidecar.product_snapshot.components), newRecipe);
    assert.equal(e.proof_version, 2);
    assert.deepEqual(
      one(e.replacements),
      omit(sidecar, ['tenant_id', 'exchange_id', 'replacement_order_id']),
    );
  }

  step = 'native_cost_custody';
  const issues = rows('wms_issue_fragments').filter((r) => r.order_id === state.order_id),
    restocks = rows('wms_return_fragments');
  const targetIssues = rows('wms_issue_fragments').filter((r) => r.order_id === replacementId);
  assert.equal(issues.length, 2);
  assert.equal(sum(issues, 'value_minor'), 4000n);
  assert.equal(restocks.length, initial ? 0 : 2);
  assert.equal(sum(restocks, 'value_minor'), initial ? 0n : 2000n);
  assert.equal(targetIssues.length, shipped ? 2 : 0);
  assert.equal(sum(targetIssues, 'value_minor'), shipped ? 12500n : 0n);
  const layers = rows('wms_cost_layers');
  assert.equal(layers.length, 4);
  const positions = rows('wms_layer_positions');
  let value = 0n;
  for (const p of positions) {
    const layer = one(layers.filter((l) => l.id === p.layer_id));
    assert.notEqual(layer.unit_cost_minor, null);
    assert.equal(layer.currency, 'PLN');
    value += BigInt(p.quantity) * BigInt(layer.unit_cost_minor);
  }
  assert.equal(value, initial ? 25000n : shipped ? 14500n : 27000n);
  for (const component of [...components, ...targets]) {
    const source = components.some((c) => c.id === component.id),
      wh = source ? state.main_warehouse_id : state.replacement_warehouse_id;
    const expected = source
      ? initial
        ? 0
        : component.recipe_quantity
      : component.recipe_quantity * (shipped ? 1 : 2);
    const reserve = !source && !initial && !shipped ? component.recipe_quantity : 0;
    const st = one(
      rows('stock').filter((r) => r.product_id === component.id && r.warehouse_id === wh),
    );
    assert.equal(st.on_hand, expected);
    assert.equal(st.reserved, reserve);
    assert.equal(st.available, expected - reserve);
    const pp = positions.filter((p) => p.product_id === component.id && p.warehouse_id === wh);
    assert.equal(sum(pp, 'quantity'), BigInt(expected));
    assert.equal(sum(pp, 'reserved'), BigInt(reserve));
    assert.equal(
      sum(
        rows('stock_locations').filter(
          (r) => r.product_id === component.id && r.warehouse_id === wh,
        ),
        'quantity',
      ),
      BigInt(expected),
    );
    assert(
      rows('stock')
        .filter((r) => r.product_id === component.id && r.warehouse_id !== wh)
        .every((r) => r.on_hand === 0 && r.reserved === 0),
    );
    const layer = one(layers.filter((l) => l.product_id === component.id));
    assert.equal(String(layer.unit_cost_minor), String(component.unit_cost_minor));
    assert.equal(layer.quantity_received, component.recipe_quantity * 2);
    const purchase = one(state.purchases.filter((p: Row) => p.warehouse_id === wh));
    assert.equal(layer.purchase_receipt_id, purchase.receipt_id);
    const pl = one(
      rows('purchase_order_lines').filter(
        (r) => r.order_id === purchase.id && r.product_id === component.id,
      ),
    );
    assert.equal(pl.unit_cost, component.unit_cost_minor);
    assert.equal(pl.received_quantity, component.recipe_quantity * 2);
    if (source) {
      const issued = one(issues.filter((r) => r.product_id === component.id));
      assert.equal(issued.layer_id, layer.id);
      assert.equal(issued.quantity, component.recipe_quantity * 2);
      assert.equal(issued.warehouse_id, wh);
      assert.equal(String(issued.unit_cost_minor), String(component.unit_cost_minor));
      assert.equal(
        issued.id,
        one(born.return_fragments.filter((r: Row) => r.product_id === component.id)).id,
      );
      if (!initial) {
        const f = one(restocks.filter((r) => r.product_id === component.id));
        assert.equal(f.issue_fragment_id, issued.id);
        assert.equal(f.layer_id, issued.layer_id);
        assert.equal(f.order_id, state.order_id);
        assert.equal(f.return_id, state.return_id);
        assert.equal(f.quantity, component.recipe_quantity);
        assert.equal(f.warehouse_id, wh);
        assert.equal(f.location, 'MAIN-RETURN');
        assert.equal(
          String(f.value_minor),
          String(component.recipe_quantity * component.unit_cost_minor),
        );
      }
    } else if (!initial) {
      const reservation = one(
        rows('reservations').filter(
          (r) => r.order_id === replacementId && r.product_id === component.id,
        ),
      );
      assert.equal(reservation.quantity, component.recipe_quantity);
      assert.equal(reservation.warehouse_id, wh);
      assert.equal(reservation.state, shipped ? 'consumed' : 'active');
      const rl = one(
        rows('wms_reservation_layers').filter(
          (r) => r.order_id === replacementId && r.product_id === component.id,
        ),
      );
      assert.equal(rl.layer_id, layer.id);
      assert.equal(rl.quantity, component.recipe_quantity);
      assert.equal(rl.state, shipped ? 'consumed' : 'active');
      if (shipped) {
        const f = one(targetIssues.filter((r) => r.product_id === component.id));
        assert.equal(f.layer_id, layer.id);
        assert.equal(f.warehouse_id, wh);
        assert.equal(f.quantity, component.recipe_quantity);
        assert.equal(String(f.unit_cost_minor), String(component.unit_cost_minor));
      }
    }
  }
  for (const table of ['payment_entries', 'documents', 'invoice_plans', 'odoo_invoice_exports'])
    assert.equal(
      rows(table).filter((r) => r.order_id === replacementId || r.return_id === state.return_id)
        .length,
      0,
    );
  assert.equal(rows('payment_entries').length, 1);
  assert.equal(rows('payment_entries')[0]!.id, payment.id);
  assert.equal(rows('payment_entries')[0]!.amount, 20000);
  assert.equal(rows('documents').length, 1);
  assert.deepEqual(omit(rows('documents')[0]!, ['created_at']), omit(born.invoice, ['created_at']));

  step = 'api_reports';
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
  const detail = await get('/reports/sales/orders/' + state.order_id + '?' + q),
    summary = await get('/reports/sales/summary?' + q);
  const cogs = initial ? '4000' : shipped ? '14500' : '2000',
    margin = initial ? '12260' : shipped ? '1760' : '14260';
  assert.equal(detail.can_read_value, true);
  assert.equal(detail.order.commercial_quantity, '2');
  assert.equal(detail.order.accepted_quantity, '0');
  assert.equal(detail.order.physically_accepted_quantity, initial ? '0' : '1');
  assert.equal(detail.order.restocked_quantity, initial ? '0' : '1');
  assert.equal(detail.order.returned_goods_gross_minor, '0');
  assert.equal(detail.order.warranty_known_cost_minor, shipped ? '12500' : '0');
  assert.equal(detail.order.issued_known_cost_minor, shipped ? '16500' : '4000');
  assert.equal(detail.order.restocked_known_cost_minor, initial ? '0' : '2000');
  assert.equal(detail.order.current_goods_net_minor, '16260');
  assert.equal(detail.order.net_known_cost_minor, cogs);
  assert.equal(detail.order.margin_minor, margin);
  assert.equal(detail.order.cost_complete, true);
  assert.deepEqual(detail.order.cost_reasons, []);
  const sale = one(summary.sales);
  assert.equal(sale.orders, 1);
  assert.equal(sale.commercial_quantity, '2');
  assert.equal(sale.total_gross_minor, '20000');
  const cohort = one(summary.cohort_current);
  assert.equal(cohort.net_known_cost_minor, cogs);
  assert.equal(cohort.margin_minor, margin);
  const cost = one(summary.costs);
  assert.equal(cost.currency, 'PLN');
  assert.equal(cost.issued_quantity, shipped ? '9' : '6');
  assert.equal(cost.restocked_quantity, initial ? '0' : '3');
  assert.equal(cost.issued_known_minor, shipped ? '16500' : '4000');
  assert.equal(cost.restocked_known_minor, initial ? '0' : '2000');
  for (const k of ['issued_unknown_quantity', 'restocked_unknown_quantity', 'net_unknown_quantity'])
    assert.equal(cost[k], '0');
  const valuation = await get('/wms-lots/valuation');
  assert.equal(valuation.valuation.known_minor, value.toString());
  assert.equal(valuation.valuation.unknown_quantity, '0');
  const orderPage = await get('/reports/sales/orders?' + q),
    returnPage = await get('/reports/sales/returns?' + q),
    dashboard = await get('/dashboard');
  assert.equal(orderPage.meta.total, 1);
  assert.equal(one(orderPage.data).id, state.order_id);
  assert.equal(returnPage.meta.total, initial ? 0 : 1);
  if (!initial) {
    const r = one(returnPage.data);
    assert.equal(r.id, state.return_id);
    assert.equal(r.remedy, 'exchange');
    assert.equal(r.accepted_quantity, '1');
    assert.equal(r.restocked_quantity, '1');
    assert.equal(r.total_gross_minor, '0');
  }
  assert.equal(
    dashboard.orders.reduce((n: number, r: Row) => n + r.count, 0),
    1,
  );
  assert.equal(sum(dashboard.orders, 'total'), 20000n);
  assert.equal(sum(dashboard.orders, 'refund_total'), 0n);
  Object.assign(api, { detail, summary, valuation, orderPage, returnPage, dashboard });

  step = 'baseline_preservation';
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
    ].map((t) => [t, rows(t)]),
  );
  Object.assign(immutable, {
    source_items: rows('order_items').filter((r) => r.order_id === state.order_id),
    source_picks: rows('order_pick_items').filter((r) => r.order_id === state.order_id),
    source_issues: issues,
    source_shipments: rows('shipments').filter((r) => r.order_id === state.order_id),
    source_reservations: rows('reservations').filter((r) => r.order_id === state.order_id),
    source_reservation_locations: rows('reservation_locations').filter(
      (r) => r.order_id === state.order_id,
    ),
    source_reservation_layers: rows('wms_reservation_layers').filter(
      (r) => r.order_id === state.order_id,
    ),
  });
  const setup = { path: setupPath, bytes: setupBytes.length, sha256: sha(setupBytes) };
  let beforeCheckpointHash: string | null = null,
    exchangeCheckpointHash: string | null = null;
  if (refused) {
    const baselineBytes = await privateBytes(beforePath),
      previous = JSON.parse(baselineBytes.toString('utf8'));
    beforeCheckpointHash = sha(baselineBytes);
    assert.equal(previous.phase, 'before-exchange');
    assert.equal(previous.stage, 140);
    assert.deepEqual(previous.setup, setup);
    assert.equal(hash(previous.native.snapshot), previous.snapshot_sha256);
    assert.deepEqual(native.snapshot, previous.native.snapshot);
    assert.deepEqual(immutable, previous.immutable);
    assert.deepEqual(
      originalAtBaselineProjection(original, previous.api.original),
      previous.api.original,
    );
    assert.deepEqual(rma, previous.api.rma);
    assert.deepEqual(payments, previous.api.payments);
    assert.equal(sha(await privateBytes(beforePath)), beforeCheckpointHash);
  }
  if (!initial) {
    const baselineBytes = await privateBytes(beforePath),
      previous = JSON.parse(baselineBytes.toString('utf8'));
    beforeCheckpointHash = sha(baselineBytes);
    assert.equal(previous.phase, 'before-exchange');
    assert.equal(previous.stage, 140);
    assert.deepEqual(previous.setup, setup);
    assert.equal(hash(previous.native.snapshot), previous.snapshot_sha256);
    assert.deepEqual(previous.immutable, immutable);
    const oldHeader = one(
      nativeRows(previous.native, 'orders').filter((r) => r.id === state.order_id),
    );
    const header = one(rows('orders').filter((r) => r.id === state.order_id));
    assert.deepEqual(
      omit(header, ['updated_at', 'version']),
      omit(oldHeader, ['updated_at', 'version']),
    );
    assert.equal(BigInt(header.version), BigInt(oldHeader.version) + 1n);
    assert.notEqual(header.updated_at, oldHeader.updated_at);
    const allowed = new Set([
      'orders',
      'order_items',
      'order_pick_items',
      'reservations',
      'reservation_locations',
      'wms_reservation_layers',
      'stock',
      'stock_locations',
      'wms_layer_positions',
      'return_cases',
      'return_items',
      'return_exchanges',
      'return_exchange_items',
      'return_exchange_replacements',
      'return_exchange_admissions',
      'wms_return_fragments',
      'wms_operations',
      'wms_layer_movements',
      'stock_movements',
      'wms_issue_fragments',
      'order_events',
      'jobs',
      'audit_events',
      'shipments',
      'purchasing_stock_changes',
      'stock_location_movements',
      'workspace_usage',
      'shopify_dispatch_evidence',
    ]);
    assert.deepEqual(
      Object.keys(previous.native.snapshot).sort(),
      Object.keys(native.snapshot).sort(),
    );
    for (const t of Object.keys(native.snapshot)) {
      if (!allowed.has(t)) {
        step = 'unchanged_table:' + t;
        assert.deepEqual(native.snapshot[t], previous.native.snapshot[t]);
      }
    }
    step = 'baseline_preservation';
    const agreedPhysicalPair = (row: Row) =>
      (row.warehouse_id === state.main_warehouse_id &&
        components.some((item) => item.id === row.product_id)) ||
      (row.warehouse_id === state.replacement_warehouse_id &&
        targets.some((item) => item.id === row.product_id));
    for (const table of ['stock', 'stock_locations', 'wms_layer_positions'])
      assert.deepEqual(
        sorted(rows(table).filter((row) => !agreedPhysicalPair(row))),
        sorted(nativeRows(previous.native, table).filter((row) => !agreedPhysicalPair(row))),
      );
    for (const t of [
      'order_events',
      'jobs',
      'audit_events',
      'wms_issue_fragments',
      'stock_movements',
      'wms_operations',
      'wms_layer_movements',
      'shipments',
      'purchasing_stock_changes',
      'stock_location_movements',
      'shopify_dispatch_evidence',
    ])
      retained(nativeRows(previous.native, t), rows(t));
    // The existing dispatch trigger also stores local DEMO shipment evidence;
    // this is a frozen local witness, not a Shopify API call or fulfillment.
    const oldDispatches = nativeRows(previous.native, 'shopify_dispatch_evidence');
    const dispatches = rows('shopify_dispatch_evidence');
    assert.equal(dispatches.length, oldDispatches.length + (shipped ? 1 : 0));
    if (shipped) {
      const dispatch = one(dispatches.filter((row) => row.order_id === replacementId));
      const shipment = one(rows('shipments').filter((row) => row.order_id === replacementId));
      const childHeader = one(rows('orders').filter((row) => row.id === replacementId));
      assert.equal(dispatch.tenant_id, state.tenant_id);
      assert.equal(dispatch.shipment_id, shipment.id);
      assert.equal(dispatch.dispatched_at, shipment.dispatched_at);
      assert.deepEqual(dispatch.receiver, {
        customer_name: childHeader.customer_name,
        email: childHeader.email,
        address: childHeader.address,
      });
      assert.deepEqual(
        dispatch.items,
        rows('order_items')
          .filter((row) => row.order_id === replacementId)
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    }
    const oldLocationIds = new Set(
      nativeRows(previous.native, 'stock_location_movements').map((row) => row.id),
    );
    const addedLocations = rows('stock_location_movements').filter(
      (row) => !oldLocationIds.has(row.id),
    );
    assert.equal(addedLocations.length, shipped ? 4 : 2);
    for (const component of components) {
      const movement = one(addedLocations.filter((row) => row.product_id === component.id));
      assert.equal(movement.warehouse_id, state.main_warehouse_id);
      assert.equal(movement.location, 'MAIN-RETURN');
      assert.equal(movement.delta, component.recipe_quantity);
      assert.equal(movement.kind, 'stock_in');
      assert.equal(movement.order_id, null);
    }
    if (shipped)
      for (const target of targets) {
        const movement = one(addedLocations.filter((row) => row.product_id === target.id));
        assert.equal(movement.warehouse_id, state.replacement_warehouse_id);
        assert.equal(movement.location, 'SECOND-01');
        assert.equal(movement.delta, -target.recipe_quantity);
        assert.equal(movement.kind, 'shipment');
        assert.equal(movement.order_id, replacementId);
      }
    for (const movement of addedLocations) {
      assert.equal(movement.tenant_id, state.tenant_id);
      assert.equal(movement.operation_id, null);
      assert.equal(movement.stocktake_id, null);
      assert.equal(movement.note, '');
      uuid(movement.id);
    }
    const oldUsage = nativeRows(previous.native, 'workspace_usage');
    assert.equal(rows('workspace_usage').length, oldUsage.length);
    const orderPeriod = born.order.created_at.slice(0, 7) + '-01';
    let orderCounters = 0;
    for (const old of oldUsage) {
      const current = one(
        rows('workspace_usage').filter(
          (row) => row.resource === old.resource && row.period === old.period,
        ),
      );
      if (old.resource === 'orders' && old.period === orderPeriod) {
        orderCounters++;
        assert.equal(BigInt(current.used), BigInt(old.used) + 1n);
        assert.deepEqual(omit(current, ['used']), omit(old, ['used']));
      } else assert.deepEqual(current, old);
    }
    assert.equal(orderCounters, 1);
    // Existing stock and forecast triggers append one immutable source marker
    // per physical stock/movement statement. A/B receipt and C/D reservation
    // append six; the later C/D dispatch appends four more. Preserve every old
    // marker and permit exactly these new own-tenant markers, never a rewrite.
    const oldMarkers = nativeRows(previous.native, 'purchasing_stock_changes');
    const markers = rows('purchasing_stock_changes');
    assert.equal(markers.length, oldMarkers.length + (shipped ? 10 : 6));
    const oldIds = new Set(oldMarkers.map((row) => String(row.id)));
    const lastOldId = oldMarkers.reduce(
      (last, row) => (BigInt(row.id) > last ? BigInt(row.id) : last),
      0n,
    );
    for (const marker of markers.filter((row) => !oldIds.has(String(row.id)))) {
      assert.deepEqual(Object.keys(marker).sort(), ['id', 'tenant_id']);
      assert.equal(marker.tenant_id, state.tenant_id);
      assert(BigInt(marker.id) > lastOldId);
    }
    assert.equal(sha(await privateBytes(beforePath)), beforeCheckpointHash);
    if (shipped) {
      const exchangeBytes = await privateBytes(exchangePath),
        accepted = JSON.parse(exchangeBytes.toString('utf8'));
      exchangeCheckpointHash = sha(exchangeBytes);
      assert.equal(accepted.phase, 'after-exchange');
      assert.equal(accepted.stage, 140);
      assert.deepEqual(accepted.setup, setup);
      assert.equal(accepted.before_checkpoint_sha256, beforeCheckpointHash);
      assert.equal(hash(accepted.native.snapshot), accepted.snapshot_sha256);
      assert.deepEqual(accepted.immutable, immutable);
      assert.equal(accepted.exchange_id, exchangeId);
      assert.equal(accepted.replacement_order_id, replacementId);
      for (const table of [
        'order_events',
        'jobs',
        'audit_events',
        'wms_issue_fragments',
        'stock_movements',
        'wms_operations',
        'wms_layer_movements',
        'shipments',
        'purchasing_stock_changes',
        'stock_location_movements',
        'shopify_dispatch_evidence',
      ])
        retained(nativeRows(accepted.native, table), rows(table));
      assert.deepEqual(rows('workspace_usage'), nativeRows(accepted.native, 'workspace_usage'));
      for (const t of [
        'return_cases',
        'return_items',
        'return_exchanges',
        'return_exchange_items',
        'return_exchange_replacements',
        'return_exchange_admissions',
        'wms_return_fragments',
      ])
        assert.deepEqual(rows(t), nativeRows(accepted.native, t));
      assert.deepEqual(
        header,
        one(nativeRows(accepted.native, 'orders').filter((r) => r.id === state.order_id)),
      );
      assert.equal(sha(await privateBytes(exchangePath)), exchangeCheckpointHash);
    }
  }
  step = 'read_effects';
  const post = await capture();
  assert.deepEqual(post.snapshot, native.snapshot);
  assert.equal(sha(await privateBytes(setupPath)), setup.sha256);
  const checkpoint = {
    stage: 140,
    phase,
    revision,
    schema_revision: schema,
    setup,
    snapshot_sha256: hash(native.snapshot),
    native,
    immutable,
    api,
    exchange_id: exchangeId,
    replacement_order_id: replacementId,
    before_checkpoint_sha256: beforeCheckpointHash,
  };
  if (!shipped && !refused) {
    const bytes = Buffer.from(JSON.stringify(checkpoint, null, 2) + '\n');
    assert(bytes.length <= 32 * 1024 * 1024);
    await writeFile(initial ? beforePath : exchangePath, bytes, { flag: 'wx', mode: 0o600 });
    if (initial) beforeCheckpointHash = sha(bytes);
    else exchangeCheckpointHash = sha(bytes);
  }
  step = 'report';
  const report = {
    stage: 140,
    phase,
    status: 'PASS_SUBSTITUTION_NATIVE_READBACK',
    revision,
    schema_revision: schema,
    setup_revision: state.runtime_revision,
    setup_sha256: setup.sha256,
    before_checkpoint_sha256: beforeCheckpointHash,
    exchange_checkpoint_sha256: exchangeCheckpointHash,
    snapshot_sha256: hash(native.snapshot),
    own_tables: Object.keys(native.snapshot).length,
    original_issue_cost_minor: '4000',
    restock_cost_minor: initial ? '0' : '2000',
    replacement_issue_cost_minor: shipped ? '12500' : '0',
    incurred_net_cogs_minor: cogs,
    current_as_of_margin_minor: margin,
    goods_net_minor: '16260',
    valuation_known_minor: value.toString(),
    original_vat: 23,
    replacement_vat: initial ? null : 8,
    original_sale_gross_minor: 20000,
    replacement_total_minor: initial ? null : 0,
    source_and_target_recipes_disjoint: true,
    source_known_zero_cost: true,
    new_payment_minor: 0,
    refund_minor: 0,
    native_full_before_exchange_baseline: true,
    source_native_immutable_rows_preserved: !initial,
    original_api_additive_capability_projection:
      'Only previously absent returns.cases[*].substitution_available may be current true under full schema123 health; all remaining fields exact.',
    exchange_native_immutable_rows_preserved_after_shipment: shipped,
    native_reads_effect_free: true,
    sessions_excluded: true,
    source_header_only_updated_at_and_exact_one_revision_after_exchange: !initial,
    pending_replacement_cost_not_a_final_forecast: !initial && !shipped,
    chrome_verified_by_root_attestation: !initial,
    refused_preview_verified_by_root_attestation: refused,
    refused_preview_exact_whole_snapshot_unchanged: refused,
    sql_scope:
      'Own tenant, owner RR READ ONLY UTC full rows; no mutation probes. Native timestamps retain microseconds.',
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
      own_tables: report.own_tables,
      net_cogs_minor: cogs,
      valuation_minor: value.toString(),
    }),
  );
} catch (error) {
  const e = error as { code?: string; stack?: string };
  const code = /^(?:[0-9A-Z]{5}|ERR_ASSERTION|ENOENT|EEXIST)$/.test(e.code ?? '')
    ? e.code
    : 'READBACK_FAILED';
  const frames = [
    ...(e.stack ?? '').matchAll(/return-exchange-substitutions-native-readback\.ts:(\d+):\d+/g),
  ].map((m) => Number(m[1]));
  console.error(
    JSON.stringify({
      status: 'FAIL_SUBSTITUTION_NATIVE_READBACK',
      step,
      code,
      source_frames: [...new Set(frames)],
    }),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
