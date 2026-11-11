/** Root-only readback of the owned QA142 fixture. No login, execution, retry or DB writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const phase = process.argv[2];
assert(
  [
    'before',
    'after-collection-first',
    'after-collection',
    'after-remittance-first',
    'after-final',
    'after-restart',
  ].includes(phase),
);
const revision = process.env.QA_EXPECTED_REVISION ?? '';
assert.match(revision, /^[a-f0-9]{40}$/);
const schema = '126_payment_import_allocation_cod_balances';
const privatePath = resolve(root, 'data/payment-import-allocations-cod-stage142.json');
const stat = await lstat(privatePath);
assert(stat.isFile() && !stat.isSymbolicLink());
assert.equal(stat.mode & 0o777, 0o600);
const bytes = await readFile(privatePath);
const state = JSON.parse(bytes.toString());
assert.equal(state.stage, 142);
assert.equal(state.complete, true);
assert.equal(state.pending, null);
const checkpoint = resolve(root, 'data/payment-import-allocations-cod-stage142-before.json');
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const byteHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const beforeBytes = phase === 'before' ? null : await readFile(checkpoint);
const before = beforeBytes ? JSON.parse(beforeBytes.toString()) : null;
if (before) assert.equal(before.setup_sha256, byteHash(bytes));
async function get(path: string, auth = true) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: auth ? { cookie: state.cookie, 'X-Workspace-ID': state.tenant_id } : {},
  });
  assert.equal(r.status, 200, 'Own GET ' + path);
  return r.json() as Promise<any>;
}
const health = await get('/health', false);
assert.equal(health.revision, revision);
assert.equal(health.schema_revision, schema);
assert.equal(health.payment_import_allocations_available, true);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const { pool } = await import('../server/db');
try {
  async function snapshot() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const db = (
        await c.query(
          "SELECT current_database() db,current_user actor,host(inet_server_addr()) address,inet_server_port() port,current_setting('transaction_read_only') ro",
        )
      ).rows[0];
      assert.equal(db.db, 'dynaminds');
      assert.equal(db.actor, 'postgres');
      assert(['127.0.0.1', '::1'].includes(db.address));
      assert.equal(db.port, 55432);
      assert.equal(db.ro, 'on');
      const tables = (
        await c.query(
          `SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name`,
        )
      ).rows;
      const rows: Record<string, any[]> = {};
      for (const { table_name: name } of tables) {
        assert(/^[a-z_][a-z0-9_]*$/.test(name));
        rows[name] = (
          await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [
            state.tenant_id,
          ])
        ).rows.map((r) => r.row);
      }
      await c.query('COMMIT');
      return rows;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  const native = await snapshot();
  const orders = await Promise.all(state.orders.map((o: any) => get('/orders/' + o.id)));
  const product = await get('/products/' + state.product.id);

  const sources: Record<string, any> = {};
  for (const [mode, value] of Object.entries(state.sources) as [string, any][])
    sources[mode] = (
      await get(
        '/payment-import-allocations/options?source_preview_id=' +
          value.preview.id +
          '&source_row_id=' +
          value.detail.data[0].row_id,
      )
    ).source;
  const history = await get('/payment-import-allocations/history');
  const executions = await Promise.all(
    history.data.map((e: any) => get('/payment-import-allocations/executions/' + e.id)),
  );
  assert.deepEqual(await snapshot(), native, 'GET changed owned business rows');
  assert.deepEqual(product.stock, state.born.stock);
  for (let i = 0; i < orders.length; i++) {
    assert.equal(orders[i].status, 'shipped');
    for (const key of [
      'items',
      'picking_items',
      'shipments',
      'documents',
      'total',
      'shipping_cost',
      'currency',
    ])
      assert.deepEqual(orders[i][key], state.born.orders[i][key], 'Fulfillment changed: ' + key);
  }
  const stageIndex = [
    'before',
    'after-collection-first',
    'after-collection',
    'after-remittance-first',
    'after-final',
    'after-restart',
  ].indexOf(phase!);
  const collected =
    stageIndex === 0 ? [0, 0, 0] : stageIndex === 1 ? [10000, 20000, 0] : [10000, 20000, 5000];
  const remitted =
    stageIndex < 3 ? [0, 0, 0] : stageIndex === 3 ? [9600, 19400, 4500] : [9600, 19400, 5000];
  const fees = stageIndex < 3 ? [0, 0, 0] : stageIndex === 3 ? [400, 500, 0] : [400, 600, 0];
  const count = Math.min(stageIndex, 4);
  const entries = native.payment_entries;
  for (let i = 0; i < 3; i++) {
    const own = entries.filter((e) => e.order_id === orders[i].id);
    assert(
      own.every(
        (e) =>
          e.shipment_id === state.orders[i].shipments[0].id &&
          e.currency === 'PLN' &&
          !e.reversal_of,
      ),
    );
    for (const [key, amount] of Object.entries({
      received: collected[i],
      collected: collected[i],
      remitted: remitted[i],
      fees: fees[i],
      courier_due: collected[i] - remitted[i] - fees[i],
      amount_due: orders[i].total - collected[i],
    }))
      assert.equal(orders[i].payment[key], amount, 'Order ' + i + ' ' + key);
    for (const [kind, amount, fee] of [
      ['courier_collection', collected[i], 0],
      ['courier_remittance', remitted[i], fees[i]],
    ] as [string, number, number][]) {
      const payments = own.filter((e) => e.kind === kind);
      assert.equal(
        payments.reduce((n, e) => n + e.amount, 0),
        amount,
      );
      assert.equal(
        payments.reduce((n, e) => n + e.fee, 0),
        fee,
      );
    }
  }
  assert.equal(entries.length, [0, 2, 3, 6, 8, 8][stageIndex]);
  if (stageIndex >= 4)
    assert(
      entries.some(
        (e) =>
          e.order_id === orders[1].id &&
          e.kind === 'courier_remittance' &&
          e.amount === 0 &&
          e.fee === 100,
      ),
      'No fee-only posting',
    );
  assert.equal(native.payment_import_allocation_executions.length, count);
  assert.equal(native.payment_import_allocation_rows.length, entries.length);
  assert.equal(history.data.length, count);
  assert.equal(history.next_cursor, null);
  assert.equal(native.payment_import_claims.length, stageIndex === 0 ? 0 : stageIndex < 3 ? 1 : 2);
  for (const [mode, version, remaining, remainingFee] of [
    [
      'cod_collection',
      Math.min(stageIndex, 2),
      stageIndex === 0 ? '35000' : stageIndex === 1 ? '5000' : '0',
      '0',
    ],
    [
      'cod_remittance',
      stageIndex < 3 ? 0 : stageIndex === 3 ? 1 : 2,
      stageIndex < 3 ? '34000' : stageIndex === 3 ? '500' : '0',
      stageIndex < 3 ? '1000' : stageIndex === 3 ? '100' : '0',
    ],
  ] as [string, number, string, string][]) {
    assert.equal(sources[mode].source_version, version);
    assert.equal(sources[mode].remaining_amount_minor, remaining);
    assert.equal(sources[mode].remaining_fee_minor, remainingFee);
    assert.equal(sources[mode].can_allocate, version < 2);
  }
  for (const execution of executions) {
    assert.equal(execution.execution.summary.currency, 'PLN');
    for (const row of execution.allocations) {
      const payment = entries.find((e) => e.id === row.entry_id);
      assert(payment);
      assert.equal(payment.order_id, row.order_id);
      assert.equal(payment.shipment_id, row.shipment_id);
      assert.equal(payment.amount, row.amount_minor);
      assert.equal(payment.fee, row.fee_minor);
      assert.deepEqual(row.after.balance, row.after_balance, 'Predicted owner vs actual');
      assert.deepEqual(
        row.after.shipment_sums,
        row.after_shipment_sums,
        'Predicted parcel vs actual',
      );
      const at = entries.filter(
        (e) =>
          e.order_id === row.order_id &&
          Date.parse(e.created_at) <= Date.parse(execution.execution.created_at),
      );
      const coll = at
        .filter((e) => e.kind === 'courier_collection')
        .reduce((n, e) => n + e.amount, 0);
      const remit = at
        .filter((e) => e.kind === 'courier_remittance')
        .reduce((n, e) => n + e.amount, 0);
      const fee = at.filter((e) => e.kind === 'courier_remittance').reduce((n, e) => n + e.fee, 0);
      for (const [key, val] of Object.entries({
        collected: coll,
        remitted: remit,
        fees: fee,
        courier_due: coll - remit - fee,
      })) {
        assert.equal(row.after_balance[key], String(val));
        assert.equal(row.after_shipment_sums[key], String(val));
      }
      assert.equal(row.after_balance.received, String(coll));
      assert.equal(row.after_shipment_sums.settled, String(remit + fee));
    }
  }
  for (const claim of native.payment_import_claims) {
    assert.equal(claim.state, 'applied');
    assert.equal(claim.execution_id, null);
    assert.equal(claim.row_id, null);
    assert(
      native.payment_import_allocation_sources.some((s) => s.id === claim.allocation_source_id),
    );
  }
  if (before) {
    const allowed = new Set([
      'orders',
      'payment_entries',
      'order_events',
      'audit_events',
      'order_local_financial_fences',
      'payment_import_claims',
      ...Object.keys(native).filter((n) => n.startsWith('payment_import_allocation_')),
    ]);
    for (const name of Object.keys(native))
      if (!allowed.has(name))
        assert.deepEqual(native[name], before.native[name], 'Unrelated table ' + name);
    assert.equal(byteHash(await readFile(checkpoint)), byteHash(beforeBytes!));
  } else
    await writeFile(
      checkpoint,
      JSON.stringify({ stage: 142, setup_sha256: byteHash(bytes), native }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  const previousNames = [
    'before',
    'after-collection-first',
    'after-collection',
    'after-remittance-first',
    'after-final',
  ];
  for (const previous of previousNames.slice(0, Math.min(stageIndex, 5))) {
    const previousPath = resolve(
      root,
      'data/payment-import-allocations-cod-stage142-' + previous + '.json',
    );
    const prior = JSON.parse(await readFile(previousPath, 'utf8'));
    assert.equal(prior.setup_sha256, byteHash(bytes));
    for (const name of [
      'payment_entries',
      'order_events',
      'audit_events',
      'payment_import_allocation_previews',
      'payment_import_allocation_executions',
      'payment_import_allocation_rows',
      'payment_import_claims',
    ])
      for (const old of prior.native[name])
        assert(
          native[name].some((row) => hash(row) === hash(old)),
          'Earlier receipt changed: ' + name,
        );
    if (phase === 'after-restart' && previous === 'after-final')
      assert.deepEqual(native, prior.native, 'Restart changed business data');
  }
  if (phase !== 'before')
    await writeFile(
      resolve(root, 'data/payment-import-allocations-cod-stage142-' + phase + '.json'),
      JSON.stringify({ stage: 142, setup_sha256: byteHash(bytes), native }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  assert.equal(byteHash(await readFile(privatePath)), byteHash(bytes));
  const report = {
    stage: 142,
    phase,
    status: 'OWN_COD_NATIVE_READBACK_PASS',
    revision,
    schema_revision: health.schema_revision,
    tenant_id: state.tenant_id,
    own_tenant_tables: Object.keys(native).length,
    setup_sha256: byteHash(bytes),
    snapshot_sha256: hash(native),
    execution_count: count,
    ledger_entry_count: entries.length,
    shared_claim_count: native.payment_import_claims.length,
    collected_minor: collected,
    remitted_minor: remitted,
    fee_minor: fees,
    courier_due_minor: collected.map((v, i) => v - remitted[i] - fees[i]),
    source_balances: sources,
    sale_fulfillment_stock_preserved: true,
    get_reads_effect_free: true,
    sessions_excluded: true,
    carrier_verified: false,
    restart_verified: phase === 'after-restart',
    restore_verified: false,
    full_goal_complete: false,
  };
  await writeFile(
    'docs/payment-import-allocations-cod-native-' + phase + '.json',
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      phase,
      status: report.status,
      executions: count,
      entries: entries.length,
      courier_due_minor: report.courier_due_minor,
    }),
  );
} finally {
  await pool.end();
}
